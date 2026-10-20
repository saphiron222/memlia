# Copyright (c) 2026 Memlia. All rights reserved.
"""Worker-only adaptation of OpenAdapt's native compiler; never a dispatcher."""

from contextlib import redirect_stderr, redirect_stdout
from dataclasses import dataclass, field
import hashlib
import importlib
from importlib import metadata
import io
import logging
import math
import os
from pathlib import Path
import stat
import sys
import tempfile
import threading
import time

_FILES = 128
_TOTAL = 32 * 1024 * 1024
_FILE = 8 * 1024 * 1024
_JSON = 256 * 1024
_EVENTS = 1024 * 1024
_LINES = 50
_LINE = 64 * 1024
_PIXELS = 4_000_000
_VERSIONS = {'openadapt-flow': '2.2.0', 'openadapt-types': '0.24.0',
             'rapidocr-onnxruntime': '1.4.4', 'onnxruntime': '1.31.0'}
_claimed = False


class CompileError(RuntimeError):
    """Fixed refusal code only; never serialize exception frames or native causes."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


@dataclass(frozen=True)
class BundleFile:
    path: str = field(repr=False)
    content: bytes = field(repr=False)
    sha256: str


@dataclass(frozen=True)
class CompiledRecording:
    files: tuple[BundleFile, ...] = field(repr=False)
    source_sha256: str
    bundle_sha256: str
    step_count: int
    versions: tuple[tuple[str, str], ...]
    profile: str = 'raw-recording-v1'
    status: str = 'to_test'


def _path(value: str) -> str:
    if (type(value) is not str or not 1 <= len(value) <= 240
            or any(ord(c) <= 32 or ord(c) >= 127 or c in '<>:"\\|?*~' for c in value)):
        raise CompileError('invalid_path')
    parts = value.split('/')
    if len(parts) > 8:
        raise CompileError('invalid_path')
    reserved = {'CON', 'PRN', 'AUX', 'NUL', 'CONIN$', 'CONOUT$'}
    reserved.update(f'{prefix}{i}' for prefix in ('COM', 'LPT') for i in range(1, 10))
    for part in parts:
        if (not part or part in ('.', '..') or part.endswith((' ', '.'))
                or len(part) > 128 or part.split('.')[0].upper() in reserved):
            raise CompileError('invalid_path')
    return value


def _names(paths) -> None:
    # Also reject case-colliding directories and file/directory prefix aliases.
    nodes = {}
    for path in paths:
        _path(path)
        parts = path.split('/')
        for i in range(1, len(parts) + 1):
            name = '/'.join(parts[:i])
            item = (name, i == len(parts))
            previous = nodes.setdefault(name.casefold(), item)
            if previous != item:
                raise CompileError('invalid_path')


def _snapshot(files) -> tuple[tuple[str, bytes], ...]:
    if type(files) is not dict or not 2 <= len(files) <= _FILES:
        raise CompileError('invalid_recording')
    items = tuple(files.items())
    for name, content in items:
        if type(name) is not str or type(content) is not bytes:
            raise CompileError('invalid_recording')
        leaf = name.rsplit('/', 1)[-1].casefold()
        if leaf in ('.openadapt-approval.json', '.openadapt-sanitization.json') or leaf.endswith('.approved.zip'):
            raise CompileError('approved_recording_unsupported')
    _names(name for name, _ in items)
    snapshot = dict(items)
    if 'meta.json' not in snapshot or 'events.jsonl' not in snapshot:
        raise CompileError('invalid_recording')
    if (any(len(content) > _FILE for _, content in items)
            or sum(len(content) for _, content in items) > _TOTAL
            or len(snapshot['meta.json']) > _JSON
            or len(snapshot.get('check.json', b'')) > _JSON
            or len(snapshot['events.jsonl']) > _EVENTS):
        raise CompileError('recording_limit')
    # These are normalized Flow events.jsonl records, never raw Capture hooks.
    lines = snapshot['events.jsonl'].splitlines()
    if sum(bool(line.strip()) for line in lines) > _LINES or any(len(line) > _LINE for line in lines):
        raise CompileError('recording_limit')
    return tuple(sorted(items))


def _digest(items, domain: bytes) -> str:
    digest = hashlib.sha256(domain)
    for path, content in items:
        name = path.encode('ascii')
        digest.update(len(name).to_bytes(4, 'big'))
        digest.update(name)
        digest.update(len(content).to_bytes(8, 'big'))
        digest.update(content)
    return digest.hexdigest()


def _claim_worker() -> None:
    global _claimed
    if (_claimed or threading.current_thread() is not threading.main_thread()
            or threading.active_count() != 1
            or os.environ.get('ORT_DISABLE_TELEMETRY') != '1'
            or os.environ.get('OPENADAPT_FLOW_OCR') != 'rapidocr'
            or any(name.split('.')[0] in ('onnxruntime', 'rapidocr_onnxruntime', 'openadapt_flow')
                   for name in sys.modules)):
        raise CompileError('fresh_worker_required')
    _claimed = True


def _runtime():
    available = False
    try:
        available = all(metadata.version(package) == version for package, version in _VERSIONS.items())
    except metadata.PackageNotFoundError:
        pass
    if not available:
        raise CompileError('runtime_unavailable')
    # The supervised NEW process must have set the environment before startup.
    # This public API is additional protection, not proof of OS egress denial.
    ort = importlib.import_module('onnxruntime')
    ort.disable_telemetry_events()
    compiler = importlib.import_module('openadapt_flow.compiler.compile')
    workflow = importlib.import_module('openadapt_flow.ir').Workflow
    return compiler.compile_recording, workflow


def _images(items) -> None:
    for name, content in items:
        if name.casefold().endswith('.png'):
            image = importlib.import_module('PIL.Image')
            with image.open(io.BytesIO(content)) as png:
                width, height = png.size
                if png.format != 'PNG' or not 0 < width * height <= _PIXELS:
                    raise CompileError('invalid_image')
                png.verify()


def _checkpoint(deadline, cancel) -> None:
    if cancel is not None and cancel.is_set():
        raise CompileError('compile_cancelled')
    if time.monotonic() >= deadline:
        raise CompileError('compile_timeout')


def _regular(info) -> bool:
    return (stat.S_ISREG(info.st_mode) and info.st_nlink == 1
            and not getattr(info, 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT)


def _identity(info, *, cross_view=False):
    value = (info.st_dev, info.st_ino, info.st_nlink, info.st_size, info.st_mtime_ns)
    if os.name == 'nt':
        birth = getattr(info, 'st_birthtime_ns', None)
        if type(birth) is not int or birth <= 0:
            raise CompileError('invalid_output')
        value += (birth,)
        # Windows path stat and fstat can assign different meanings to ctime.
        # Only cross-view comparisons omit it; same-view mutation checks retain it.
        if cross_view:
            return value
    return value + (info.st_ctime_ns,)


def _output(bundle: Path) -> tuple[tuple[str, bytes], ...]:
    root_info = bundle.lstat()
    if (not stat.S_ISDIR(root_info.st_mode) or
            getattr(root_info, 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT):
        raise CompileError('invalid_output')
    result = []
    pending = [bundle]
    entries = 0
    size = 0
    while pending:
        directory = pending.pop()
        with os.scandir(directory) as children:
            for child in children:
                entries += 1
                if entries > _FILES * 2:
                    raise CompileError('output_limit')
                relative = _path(Path(child.path).relative_to(bundle).as_posix())
                # DirEntry.stat has zero dev/ino/nlink on Windows, not file identity.
                info = os.stat(child.path, follow_symlinks=False)
                if (stat.S_ISLNK(info.st_mode) or
                        getattr(info, 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT):
                    raise CompileError('invalid_output')
                if stat.S_ISDIR(info.st_mode):
                    os.chmod(child.path, 0o700)
                    pending.append(Path(child.path))
                    continue
                if not _regular(info):
                    raise CompileError('invalid_output')
                if len(result) >= _FILES or info.st_size > _FILE or info.st_size > _TOTAL - size:
                    raise CompileError('output_limit')
                descriptor = os.open(child.path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
                                     | getattr(os, 'O_BINARY', 0))
                with os.fdopen(descriptor, 'rb') as handle:
                    before = os.fstat(handle.fileno())
                    if (not _regular(before)
                            or _identity(before, cross_view=True) != _identity(info, cross_view=True)):
                        raise CompileError('invalid_output')
                    content = handle.read(_FILE + 1)
                    after = os.fstat(handle.fileno())
                    if (not _regular(after) or _identity(before) != _identity(after)
                            or len(content) != before.st_size):
                        raise CompileError('invalid_output')
                    path_after = os.stat(child.path, follow_symlinks=False)
                    if (not _regular(path_after) or _identity(info) != _identity(path_after)
                            or _identity(after, cross_view=True) != _identity(path_after, cross_view=True)):
                        raise CompileError('invalid_output')
                os.chmod(child.path, 0o600)
                size += len(content)
                result.append((relative, content))
    _names(path for path, _ in result)
    names = {path for path, _ in result}
    if not {'workflow.json', 'manifest.json', 'workflow.py'} <= names or 'annotations.json' in names:
        raise CompileError('invalid_output')
    return tuple(sorted(result))


def compile_raw_recording(files: dict[str, bytes], *, name: str,
                          deadline_monotonic: float,
                          cancel: threading.Event | None = None) -> CompiledRecording:
    """Run once in a fresh supervised worker. No authority, hard timeout or sandbox.

    The future launcher must supply a filtered environment and owned process
    deadline/cleanup; checkpoints refuse late delivery but cannot preempt native OCR.
    Never call this inside the long-lived Agent or a web process.
    """
    failure = None
    temporary = None
    old_mask = None
    old_logging = logging.root.manager.disable
    quiet_handler = None
    try:
        captured = _snapshot(files)  # Exact dict/str/immutable bytes, before any IO.
        valid_deadline = False
        if type(deadline_monotonic) in (int, float):
            try:
                valid_deadline = math.isfinite(deadline_monotonic)
            except OverflowError:
                pass
        if (type(name) is not str or not 1 <= len(name) <= 120
                or any(ord(c) < 32 or ord(c) == 127 or 0xD800 <= ord(c) <= 0xDFFF for c in name)
                or not valid_deadline
                or cancel is not None and type(cancel) is not threading.Event):
            raise CompileError('invalid_request')
        _checkpoint(deadline_monotonic, cancel)
        _claim_worker()
        old_mask = os.umask(0o077)  # Process-owned worker only; restored even on refusal.
        logging.disable(logging.CRITICAL)
        # Module-level logging calls can invoke basicConfig even while disabled.
        # Keep them from retaining a StreamHandler on the temporary quiet stream.
        quiet_handler = logging.NullHandler()
        logging.root.addHandler(quiet_handler)
        with open(os.devnull, 'w', encoding='utf-8') as quiet, redirect_stdout(quiet), redirect_stderr(quiet):
            _images(captured)
            compile_recording, workflow_type = _runtime()
            _checkpoint(deadline_monotonic, cancel)
            temporary = tempfile.TemporaryDirectory(prefix='memlia-flow-compile-')
            root = Path(temporary.name)
            os.chmod(root, 0o700)
            recording, bundle = root / 'recording', root / 'bundle'
            recording.mkdir(mode=0o700)
            bundle.mkdir(mode=0o700)
            for path, content in captured:
                _checkpoint(deadline_monotonic, cancel)
                target = recording / path
                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL
                                     | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_BINARY', 0), 0o600)
                with os.fdopen(descriptor, 'wb') as handle:
                    handle.write(content)
            _checkpoint(deadline_monotonic, cancel)
            workflow = compile_recording(recording, bundle, name=name, annotate=False,
                                         mine_effects=False, admit_api_bindings=False)
            _checkpoint(deadline_monotonic, cancel)
            output = _output(bundle)
            names = {path for path, _ in output}
            # Refuse external/missing asset references before native integrity IO.
            if workflow.manifest is None:
                raise CompileError('invalid_output')
            for path in workflow.manifest.file_hashes:
                if _path(path) not in names:
                    raise CompileError('invalid_output')
            loaded = workflow_type.load(bundle, validate=True, verify_integrity=True)
            if _output(bundle) != output:
                raise CompileError('invalid_output')
            if len(loaded.steps) > _LINES:
                raise CompileError('output_limit')
            result = CompiledRecording(
                tuple(BundleFile(path, content, hashlib.sha256(content).hexdigest()) for path, content in output),
                _digest(captured, b'memlia.raw-recording-v1\0'),
                _digest(output, b'memlia.openadapt-bundle/v1\0'),
                len(loaded.steps), tuple(sorted(_VERSIONS.items())))
    except CompileError as error:
        failure = error.code
    except Exception:
        failure = 'compile_failed'
    finally:
        if temporary is not None:
            try:
                temporary.cleanup()
            except Exception:
                failure = 'compile_cleanup_failed'
        if old_mask is not None:
            os.umask(old_mask)
        if quiet_handler is not None:
            logging.root.removeHandler(quiet_handler)
            quiet_handler.close()
        logging.disable(old_logging)
    # Delivery only after all cleanup. Interruptions remain BaseExceptions.
    if failure is None:
        try:
            _checkpoint(deadline_monotonic, cancel)
        except CompileError as error:
            failure = error.code
        except Exception:
            failure = 'compile_failed'
    if failure is not None:
        raise CompileError(failure)
    return result
