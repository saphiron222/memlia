# Copyright (c) 2026 Memlia. All rights reserved.
"""One fresh native compiler invocation; not approval, execution or server authority."""
import hashlib
import json
import math
from pathlib import Path
import sys
import time

from .openadapt_capture_worker import _engine_stdout, recording_files, write_once
from .openadapt_compile import (BundleFile, CompiledRecording, CompileError, _VERSIONS,
                               _digest, _names, _output, _private_traceback,
                               compile_raw_recording)


def checked_request(value):
    if (type(value) is not dict or set(value) != {'version', 'name', 'sourceSha256', 'deadline'}
            or type(value['version']) is not int or value['version'] != 1
            or type(value['name']) is not str or not 1 <= len(value['name']) <= 120
            or any(ord(c) < 32 or ord(c) == 127 or 0xD800 <= ord(c) <= 0xDFFF for c in value['name'])
            or type(value['sourceSha256']) is not str or len(value['sourceSha256']) != 64
            or any(c not in '0123456789abcdef' for c in value['sourceSha256'])
            or type(value['deadline']) not in (int, float)):
        raise CompileError('invalid_request')
    try:
        valid = math.isfinite(value['deadline']) and 0 < value['deadline'] - time.monotonic() <= 1800
    except OverflowError:
        valid = False
    if not valid:
        raise CompileError('invalid_request')
    return dict(value)


def compile_directory(root, request):
    request = checked_request(request)
    if {p.name for p in root.iterdir()} != {'recording'}:
        raise CompileError('compile_destination_not_fresh')
    files = recording_files(root / 'recording', 32 * 1024 * 1024)
    if _digest(files, b'memlia.raw-recording-v1\0') != request['sourceSha256']:
        raise CompileError('compile_source_changed')
    # No Flow/ONNX import precedes this native port; it owns _claim_worker().
    result = compile_raw_recording(dict(files), name=request['name'],
                                   deadline_monotonic=request['deadline'], target_surface='windows')
    if (type(result) is not CompiledRecording or result.status != 'to_test'
            or result.profile != 'raw-recording-v1' or type(result.files) is not tuple
            or not 3 <= len(result.files) <= 128 or type(result.step_count) is not int
            or not 0 <= result.step_count <= 50
            or result.source_sha256 != request['sourceSha256']
            or result.versions != tuple(sorted(_VERSIONS.items()))):
        raise CompileError('invalid_output')
    items = []
    for file in result.files:
        if (type(file) is not BundleFile or type(file.content) is not bytes
                or len(file.content) > 8 * 1024 * 1024
                or file.sha256 != hashlib.sha256(file.content).hexdigest()):
            raise CompileError('invalid_output')
        items.append((file.path, file.content))
    _names(name for name, _ in items)
    if len({name for name, _ in items}) != len(items) or sum(len(data) for _, data in items) > 32*1024*1024:
        raise CompileError('output_limit')
    items = tuple(sorted(items))
    if _digest(items, b'memlia.openadapt-bundle/v1\0') != result.bundle_sha256:
        raise CompileError('invalid_output')
    if time.monotonic() >= request['deadline']:
        raise CompileError('compile_timeout')
    bundle = root / 'bundle'
    bundle.mkdir(mode=0o700)
    for name, data in items:
        if time.monotonic() >= request['deadline']:
            raise CompileError('compile_timeout')
        target = bundle / name
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        write_once(target, data)
    if _output(bundle) != items or time.monotonic() >= request['deadline']:
        raise CompileError('invalid_output')
    return dict(status='to_test', sourceSha256=result.source_sha256,
                bundleSha256=result.bundle_sha256, stepCount=result.step_count,
                versions=sorted(_VERSIONS.items()))


def main():
    result = {'status': 'refused', 'errorCode': 'compile_worker_failed'}
    try:
        if sys.platform != 'win32':
            raise CompileError('compile_runtime_unavailable')
        raw = sys.stdin.buffer.read(4097)
        if len(raw) > 4096:
            raise CompileError('invalid_request')
        def pairs(items):
            value = {}
            for key, entry in items:
                if key in value:
                    raise CompileError('invalid_request')
                value[key] = entry
            return value
        request = checked_request(json.loads(raw, object_pairs_hook=pairs))
        with _engine_stdout():
            result = compile_directory(Path.cwd(), request)
    except CompileError as error:
        result['privateDiagnosticComplete'] = error.private_diagnostic_complete
        if error.private_diagnostic is not None:
            sys.stderr.buffer.write(error.private_diagnostic)
            sys.stderr.buffer.flush()
        result['errorCode'] = error.code
    except Exception as error:
        private, complete = _private_traceback(error)
        result['privateDiagnosticComplete'] = complete
        sys.stderr.buffer.write(private)
        sys.stderr.buffer.flush()
    sys.stdout.write(json.dumps(result, separators=(',', ':')) + '\n')
    return 0 if result['status'] == 'to_test' else 1


if __name__ == '__main__':
    raise SystemExit(main())
