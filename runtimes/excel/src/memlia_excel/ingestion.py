# Copyright (c) 2026 Memlia. All rights reserved.
"""Inbox POSIX configurée au serveur ; copie bornée en mémoire, aucun dispatch."""
from contextlib import contextmanager
from dataclasses import dataclass
import errno
import fcntl
from hashlib import sha256
import os
from pathlib import Path, PosixPath
import re
import stat
import time

from .process import MAX_CONTENT


class IngestionRefused(ValueError):
    """Code fixe, sans chemin ni contenu de fichier dans le diagnostic."""


@dataclass(frozen=True, slots=True)
class FileObservation:
    name: str
    root_identity: tuple[int, int]
    identity: tuple[int, int, int, int, int, int]
    observed_ns: int


@dataclass(frozen=True, slots=True)
class RejectedEntry:
    name: str
    code: str


@dataclass(frozen=True, slots=True)
class Discovery:
    candidates: tuple[FileObservation, ...]
    rejected: tuple[RejectedEntry, ...]


@dataclass(frozen=True, slots=True)
class InboxSnapshot:
    name: str
    content: bytes
    sha256: str


def _require(condition, code):
    if not condition:
        raise IngestionRefused(code)


def _limits(max_entries=32, max_bytes=MAX_CONTENT):
    _require(type(max_entries) is int and 1 <= max_entries <= 32
             and type(max_bytes) is int and 1 <= max_bytes <= MAX_CONTENT, 'invalid_limits')


def _name(name):
    _require(type(name) is str, 'invalid_name')
    try:
        encoded = name.encode('utf-8')
    except UnicodeError:
        raise IngestionRefused('invalid_name') from None
    _require(0 < len(encoded) <= 255
             and not re.search(r'[/\\\x00-\x1f\x7f:]', name)
             and name not in ('.', '..') and not name.endswith((' ', '.'))
             and not re.fullmatch(r'(?i)(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?', name),
             'invalid_name')


@contextmanager
def _root_fd(root):
    _require(os.name == 'posix' and os.open in os.supports_dir_fd
             and os.stat in os.supports_dir_fd and os.scandir in os.supports_fd,
             'unsupported_filesystem')
    _require(type(root) in (str, PosixPath), 'invalid_root')
    path = Path(root)
    text = str(path)
    try:
        text.encode('utf-8')
    except UnicodeError:
        raise IngestionRefused('invalid_root') from None
    _require(path.is_absolute() and '..' not in path.parts and '\x00' not in text, 'invalid_root')
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    fd = None
    try:
        fd = os.open('/', flags)
        for part in path.parts[1:]:
            child = os.open(part, flags, dir_fd=fd)
            previous, fd = fd, child
            os.close(previous)
        _require(os.fstat(fd).st_nlink > 0, 'inbox_unavailable')
        yield fd
    except OSError:
        raise IngestionRefused('inbox_unavailable') from None
    finally:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                raise IngestionRefused('inbox_unavailable') from None


def _root_identity(fd):
    row = os.fstat(fd)
    return row.st_dev, row.st_ino


def _recheck_root(root, fd):
    with _root_fd(root) as current:
        _require(_root_identity(current) == _root_identity(fd), 'source_changed')


def _identity(row):
    return (row.st_dev, row.st_ino, row.st_nlink, row.st_size, row.st_mtime_ns, row.st_ctime_ns)


def _entry_code(name, row, max_bytes):
    try:
        _name(name)
    except IngestionRefused:
        return 'invalid_name'
    if not stat.S_ISREG(row.st_mode):
        return 'not_regular'
    if row.st_nlink != 1:
        return 'unsafe_link_count'
    if name.lower().endswith(('.partial', '.tmp')) or name.startswith('~$'):
        return 'producer_not_ready'
    if not name.lower().endswith('.xlsx'):
        return 'unsupported_extension'
    if not 0 < row.st_size <= max_bytes:
        return 'input_limit'
    return None


def observe_inbox(root, *, max_entries=32, max_bytes=MAX_CONTENT) -> Discovery:
    """Un passage borné, sans récursion, polling, contenu ou effet d'exécution."""
    _limits(max_entries, max_bytes)
    candidates, rejected = [], []
    with _root_fd(root) as directory:
        root_id = _root_identity(directory)
        with os.scandir(directory) as entries:
            for index, entry in enumerate(entries):
                _require(index < max_entries, 'entry_limit')
                row = entry.stat(follow_symlinks=False)
                code = _entry_code(entry.name, row, max_bytes)
                if code is not None:
                    rejected.append(RejectedEntry(entry.name, code))
                else:
                    candidates.append(FileObservation(entry.name, root_id, _identity(row), time.monotonic_ns()))
        _recheck_root(root, directory)
    return Discovery(tuple(sorted(candidates, key=lambda item: item.name)),
                     tuple(sorted(rejected, key=lambda item: item.name)))


def _verify_file(directory, fd, observation, max_bytes):
    row = os.fstat(fd)
    current = os.stat(observation.name, dir_fd=directory, follow_symlinks=False)
    _require(_entry_code(observation.name, row, max_bytes) is None
             and _entry_code(observation.name, current, max_bytes) is None
             and _identity(row) == observation.identity == _identity(current), 'source_changed')


def take_snapshot(root, first, second, *, handoff_digest, minimum_stable_ns,
                  max_bytes=MAX_CONTENT) -> InboxSnapshot:
    """Copies exactes remises par un producteur ; hash et observations ne sont pas une autorité.

    L'adaptateur serveur résout l'inbox, les droits et le digest de remise hors LLM.
    Deux observations identiques seules n'attestent jamais une fin d'écriture.
    """
    _limits(max_bytes=max_bytes)
    _require(type(first) is FileObservation and type(second) is FileObservation, 'invalid_observation')
    _name(first.name)
    _name(second.name)
    _require(type(handoff_digest) is str
             and re.fullmatch(r'sha256:[0-9a-f]{64}', handoff_digest) is not None, 'invalid_handoff')
    _require(type(minimum_stable_ns) is int and minimum_stable_ns > 0, 'invalid_limits')
    _require(first.name == second.name and first.root_identity == second.root_identity
             and first.identity == second.identity
             and second.observed_ns - first.observed_ns >= minimum_stable_ns
             and time.monotonic_ns() >= second.observed_ns, 'source_not_stable')
    with _root_fd(root) as directory:
        _require(_root_identity(directory) == second.root_identity, 'source_changed')
        fd = None
        try:
            fd = os.open(second.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
                         dir_fd=directory)
            try:
                fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
            except OSError as error:
                code = 'source_locked' if error.errno in (errno.EACCES, errno.EAGAIN) else 'source_unavailable'
                raise IngestionRefused(code) from None
            _verify_file(directory, fd, second, max_bytes)
            chunks, count = [], 0
            while True:
                chunk = os.read(fd, min(65536, max_bytes + 1 - count))
                if not chunk:
                    break
                count += len(chunk)
                _require(count <= max_bytes, 'input_limit')
                chunks.append(chunk)
            content = b''.join(chunks)
            _verify_file(directory, fd, second, max_bytes)
            _recheck_root(root, directory)
            digest = 'sha256:' + sha256(content).hexdigest()
            _require(digest == handoff_digest, 'handoff_mismatch')
            return InboxSnapshot(second.name, content, digest)
        except OSError:
            raise IngestionRefused('source_unavailable') from None
        finally:
            if fd is not None:
                os.close(fd)
