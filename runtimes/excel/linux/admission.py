# Copyright (c) 2026 Memlia. All rights reserved.
"""Operator-only local image admission; never part of a worker request."""
from collections import namedtuple
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import stat

CASES = ('worker', 'boundary', 'cpu', 'pids', 'memory', 'disk', 'timeout', 'cancel')
IDENTITIES = ('imageId', 'sourceCommit', 'lockSha256', 'contextSha256', 'supervisorSha256')
_SEAL = object()


def refuse():
    raise ValueError('excel_admission_refused')


def _require(ok):
    if not ok:
        refuse()


def _view(info):
    return (info.st_dev, info.st_ino, info.st_uid, info.st_gid, info.st_mode,
            info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _parents(path, owner):
    result = []
    for parent in path.parents:
        info = parent.lstat()
        _require(stat.S_ISDIR(info.st_mode) and info.st_uid in (0, owner)
                 and not info.st_mode & 0o022)
        result.append((parent, _view(info)))
    return result


def _read(path, owner):
    parents = _parents(path, owner)
    before = path.lstat()
    _require(stat.S_ISREG(before.st_mode) and before.st_uid == owner
             and before.st_nlink == 1 and stat.S_IMODE(before.st_mode) == 0o400
             and 0 < before.st_size <= 16384)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    with os.fdopen(fd, 'rb') as source:
        opened = os.fstat(source.fileno())
        _require(_view(opened) == _view(before))
        raw = source.read(16385)
        _require(len(raw) == before.st_size and _view(os.fstat(source.fileno())) == _view(opened))
    _require(_view(path.lstat()) == _view(before))
    _require(all(_view(parent.lstat()) == identity for parent, identity in parents))
    return raw


def _json(raw):
    def pairs(items):
        value = {}
        for key, item in items:
            _require(key not in value)
            value[key] = item
        return value
    def invalid(_): refuse()
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=invalid)


def validate_proof(value):
    _require(type(value) is dict and set(value) ==
             {'schemaVersion', *IDENTITIES, 'imageHeld', 'cases'})
    _require(value['schemaVersion'] == 'memlia.excel-isolation-proof/v1'
             and value['imageHeld'] is True)
    for key in IDENTITIES:
        pattern = r'sha256:[a-f0-9]{64}' if key == 'imageId' else r'[a-f0-9]{40}' if key == 'sourceCommit' else r'[a-f0-9]{64}'
        _require(type(value[key]) is str and re.fullmatch(pattern, value[key]) is not None)
    _require(type(value['cases']) is dict and set(value['cases']) == set(CASES))
    for result in value['cases'].values():
        _require(type(result) is dict and set(result) == {'passed', 'cleanupComplete'}
                 and result['passed'] is True and result['cleanupComplete'] is True)
    return value


def describe(proof_bytes):
    """Data only: the operator must explicitly install these bytes with private ownership."""
    proof = validate_proof(_json(proof_bytes))
    return {'schemaVersion': 'memlia.excel-local-admission/v1', 'purpose': 'local-host',
            **{key: proof[key] for key in IDENTITIES},
            'proofSha256': sha256(proof_bytes).hexdigest()}


_Captured = namedtuple('_Captured', ('image', 'supervisor', 'seal'))


def capture(path, image, supervisor_sha256):
    """Capture operator configuration before serving; the payload never supplies this path."""
    try:
        _require(type(image) is str and re.fullmatch(r'sha256:[a-f0-9]{64}', image)
                 and type(supervisor_sha256) is str
                 and re.fullmatch(r'[a-f0-9]{64}', supervisor_sha256))
        _require(type(path) is str and len(os.fsencode(path)) <= 4096)
        file = Path(path)
        _require(file.is_absolute() and str(file) == path == os.path.normpath(path))
        record = _json(_read(file, os.getuid()))
        _require(type(record) is dict and set(record) ==
                 {'schemaVersion', 'purpose', *IDENTITIES, 'proofSha256'})
        _require(record['schemaVersion'] == 'memlia.excel-local-admission/v1'
                 and record['purpose'] == 'local-host')
        proof_bytes = _read(file.with_name('proof.json'), os.getuid())
        proof = validate_proof(_json(proof_bytes))
        _require(type(record['proofSha256']) is str
                 and sha256(proof_bytes).hexdigest() == record['proofSha256'])
        _require(all(record[key] == proof[key] for key in IDENTITIES))
        _require(record['imageId'] == image and record['supervisorSha256'] == supervisor_sha256)
        return _Captured(image, supervisor_sha256, _SEAL)
    except (OSError, ValueError, TypeError, KeyError, UnicodeError, RecursionError):
        raise ValueError('excel_admission_refused') from None


def permits(value, image, supervisor_sha256):
    return (type(value) is _Captured and value.seal is _SEAL
            and value.image == image and value.supervisor == supervisor_sha256)
