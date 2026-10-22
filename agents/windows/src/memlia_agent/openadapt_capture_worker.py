# Copyright (c) 2026 Memlia. All rights reserved.
"""Owned-process Recorder entry; not a command, authority, consent or replay port."""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import asdict
import importlib
from importlib import metadata
import json
import os
from pathlib import Path
import stat
import sys
import time
import traceback

from .capture_input_filter import CaptureInputFactory, _observer_runtime
from .openadapt_compile import _identity, _names, _path, _regular, _snapshot

_TOTAL = 32 * 1024 * 1024
_FILES = 128


class WorkerError(RuntimeError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def checkpoint(deadline):
    if time.monotonic() >= deadline:
        raise WorkerError('capture_deadline_expired')


def write_once(path, data):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL
                         | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_BINARY', 0), 0o600)
    with os.fdopen(descriptor, 'wb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())


def read_small(path, limit):
    info = path.lstat()
    if not _regular(info) or not 0 <= info.st_size <= limit:
        raise WorkerError('capture_file_invalid')
    descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
                         | getattr(os, 'O_BINARY', 0))
    with os.fdopen(descriptor, 'rb') as stream:
        before = os.fstat(stream.fileno())
        if not _regular(before) or _identity(info, cross_view=True) != _identity(before, cross_view=True):
            raise WorkerError('capture_file_invalid')
        data = stream.read(limit + 1)
        after = os.fstat(stream.fileno())
        final = path.lstat()
        if (len(data) != before.st_size or len(data) > limit or not _regular(after)
                or not _regular(final) or _identity(before) != _identity(after)
                or _identity(info) != _identity(final)
                or _identity(after, cross_view=True) != _identity(final, cross_view=True)):
            raise WorkerError('capture_file_invalid')
    return data


def inventory(root, maximum):
    """Bound active bytes, names and entries. Not an atomic filesystem quota."""
    pending, result, entries, total = [root], [], 0, 0
    while pending:
        directory = pending.pop()
        info = directory.lstat()
        if (not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode)
                or getattr(info, 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT):
            raise WorkerError('capture_file_invalid')
        with os.scandir(directory) as children:
            for child in children:
                entries += 1
                if entries > _FILES * 2:
                    raise WorkerError('capture_storage_limit')
                name = _path(Path(child.path).relative_to(root).as_posix())
                info = os.stat(child.path, follow_symlinks=False)
                if (stat.S_ISLNK(info.st_mode) or
                        getattr(info, 'st_file_attributes', 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT):
                    raise WorkerError('capture_file_invalid')
                if stat.S_ISDIR(info.st_mode):
                    pending.append(Path(child.path))
                elif _regular(info):
                    total += info.st_size
                    result.append((name, info.st_size))
                    if len(result) > _FILES or total > maximum:
                        raise WorkerError('capture_storage_limit')
                else:
                    raise WorkerError('capture_file_invalid')
    _names(name for name, _ in result)
    return tuple(sorted(result))


def recording_files(root, maximum):
    items = inventory(root, maximum)
    return _snapshot({name: read_small(root / name, min(size, 8 * 1024 * 1024))
                      for name, size in items})


def _runtime():
    _observer_runtime()  # Exact patched distribution + two source hashes, no fallback.
    if metadata.version('openadapt-flow') != '2.2.0':
        raise WorkerError('capture_runtime_unavailable')
    return (importlib.import_module('openadapt_capture.recorder').Recorder,
            importlib.import_module('openadapt_capture.capture').CaptureSession,
            importlib.import_module('openadapt_flow.adapters.capture').convert_capture)


def capture(root, *, factory, operation_digest, deadline_monotonic, max_bytes):
    """Internal worker only. Caller retains its owned Job until native exit/EOF."""
    failure = None
    try:
        if (type(factory) is not CaptureInputFactory or factory.operation_digest != operation_digest
                or factory.deadline_monotonic != deadline_monotonic
                or type(max_bytes) is not int or not 1 <= max_bytes <= 2**31):
            raise WorkerError('invalid_capture_request')
        factory._validate_values()
        maximum = min(max_bytes, _TOTAL)
        checkpoint(deadline_monotonic)
        Recorder, CaptureSession, convert = _runtime()
        checkpoint(deadline_monotonic)
        with Recorder(str(root / 'capture'), task_description='',
                      capture_audio=False, capture_video=False, capture_full_video=False,
                      capture_images=True, capture_window_data=True,
                      capture_browser_events=False, capture_structural_observations=False,
                      stop_sequences=[], log_memory=False, plot_performance=False,
                      send_profile=False, control_enabled=False, screen_capture_fps=2,
                      input_observer_factory=factory) as recorder:
            while not recorder.wait_for_ready(timeout=.1):
                checkpoint(deadline_monotonic)
                inventory(root, maximum)
            checkpoint(deadline_monotonic)
            write_once(root / 'ready', (operation_digest + '\n').encode('ascii'))
            while True:
                checkpoint(deadline_monotonic)
                recorder.check_health()
                inventory(root, maximum)
                if (root / 'finish').exists():
                    if read_small(root / 'finish', 72) != (operation_digest + '\n').encode('ascii'):
                        raise WorkerError('capture_finish_invalid')
                    checkpoint(deadline_monotonic)
                    break
                if recorder.is_recording is not True:
                    raise WorkerError('capture_ended_without_finish')
                time.sleep(.05)
        # Recorder.__exit__ surfaces native errors and reaps its owned children.
        checkpoint(deadline_monotonic)
        inventory(root, maximum)
        verified = CaptureSession.load_verified(root / 'capture')
        try:
            checkpoint(deadline_monotonic)
            # Convert the immutable native verified snapshot, not the live source.
            convert(verified.capture_dir, root / 'recording', include_structural=False)
            checkpoint(deadline_monotonic)
            inventory(root, maximum)
            recording_files(root / 'recording', maximum)
        finally:
            verified.close()
        checkpoint(deadline_monotonic)
    except WorkerError as error:
        failure = error.code
    except Exception:
        # Private finite Job pipe, before the fixed public projection; no locals.
        try:
            traceback.print_exc(limit=12, chain=False, file=sys.stderr)
        except Exception:
            pass  # Unavailable diagnostics never turn a native refusal into success.
        failure = 'capture_worker_failed'
    if failure is not None:
        raise WorkerError(failure)
    return {'status': 'recorded', 'operationDigest': operation_digest}


def request_bytes(factory, maximum):
    """Captured scalar factory values only; no callable pickles or user paths."""
    return json.dumps({'version': 1, 'factory': asdict(factory), 'maxBytes': maximum},
                      allow_nan=False, separators=(',', ':')).encode('ascii')


@contextmanager
def _engine_stdout():
    """Reserve stdout for the receipt; native diagnostics use the finite private stderr pipe."""
    sys.stdout.flush()
    descriptor = sys.stdout.fileno()
    saved = os.dup(descriptor)
    try:
        os.set_inheritable(saved, False)
        os.dup2(sys.stderr.fileno(), descriptor)
        try:
            yield
        finally:
            try:
                sys.stdout.flush()
            finally:
                os.dup2(saved, descriptor)
    finally:
        os.close(saved)


def main():
    result = {'status': 'refused', 'errorCode': 'capture_worker_failed'}
    try:
        if sys.platform != 'win32':
            raise WorkerError('capture_runtime_unavailable')
        raw = sys.stdin.buffer.read(4097)
        if len(raw) > 4096:
            raise WorkerError('invalid_capture_request')
        def pairs(values):
            captured = {}
            for key, value in values:
                if key in captured:
                    raise WorkerError('invalid_capture_request')
                captured[key] = value
            return captured
        request = json.loads(raw, object_pairs_hook=pairs)
        if (type(request) is not dict or set(request) != {'version', 'factory', 'maxBytes'}
                or type(request['version']) is not int or request['version'] != 1
                or type(request['factory']) is not dict):
            raise WorkerError('invalid_capture_request')
        root = Path.cwd()
        if list(root.iterdir()):
            raise WorkerError('capture_destination_not_fresh')
        factory = CaptureInputFactory(**request['factory'])
        with _engine_stdout():
            result = capture(root, factory=factory, operation_digest=factory.operation_digest,
                             deadline_monotonic=factory.deadline_monotonic,
                             max_bytes=request['maxBytes'])
    except WorkerError as error:
        result['errorCode'] = error.code
    except Exception:
        pass  # Fixed refusal; never emit native frames, input or window metadata.
    # Native engine diagnostics are captured privately by the parent's finite pipes.
    sys.stdout.write(json.dumps(result, separators=(',', ':')) + '\n')
    return 0 if result['status'] == 'recorded' else 1


if __name__ == '__main__':
    raise SystemExit(main())
