# Copyright (c) 2026 Memlia. All rights reserved.
"""Owned fresh compiler process for a captured recording; no replay qualification."""
from dataclasses import dataclass, field
import hashlib
from importlib import metadata
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time

from .openadapt_capture import CapturedRecording, _environment
from .openadapt_capture_worker import write_once
from .openadapt_compile import (BundleFile, CompiledRecording, _VERSIONS, _digest,
                               _output, _snapshot)
from .openadapt_compile_worker import checked_request
from .owned_job import JobError, JobIO, OwnedJob
from .resources import reserve_desktop
from .stop import LocalStop, StopRequested


class CompileProcessError(RuntimeError):
    def __init__(self, code):
        self.code = code
        self.private_output = None
        super().__init__(code)


@dataclass(frozen=True)
class CompiledCapture:
    compiled: CompiledRecording
    operation_digest: str
    private_output: object = field(repr=False)


_registry_lock = threading.Lock()
_active = None


def _compiler_ready():
    available = False
    try:
        available = (metadata.version('memlia-windows-agent') == '0.0.0'
                     and all(metadata.version(key) == value for key, value in _VERSIONS.items()))
    except Exception:
        pass
    if not available:
        raise CompileProcessError('compile_runtime_unavailable')


class _CompileRun:
    def __init__(self, files, operation_digest, request, revalidate):
        self.files, self.operation_digest = files, operation_digest
        self.request, self.revalidate = request, revalidate
        self.owner, self.pid, self.tid = threading.current_thread(), os.getpid(), threading.get_native_id()
        self.reservation = self.signal = self.job = self.temporary = self.output = None
        self.output_pending = False
        self.closed = False

    def require_owner(self):
        if (self.owner is not threading.current_thread() or not self.owner.is_alive()
                or self.pid != os.getpid() or self.tid != threading.get_native_id()):
            raise CompileProcessError('compile_owner_mismatch')

    def authority(self):
        self.require_owner()
        valid = False
        try:
            valid = self.revalidate() is None
        except Exception:
            pass
        if not valid:
            raise CompileProcessError('compile_authority_unavailable')
        if time.monotonic() >= self.request['deadline']:
            raise CompileProcessError('compile_timeout')

    def checkpoint(self):
        self.authority()
        if self.signal is not None:
            self.signal.checkpoint()

    def run(self):
        self.authority()
        _compiler_ready()
        self.authority()
        self.reservation = reserve_desktop()
        self.signal = LocalStop(self.reservation, self.request['deadline'])
        self.signal._start()
        self.checkpoint()
        self.temporary = tempfile.TemporaryDirectory(prefix='memlia-compile-job-')
        root = Path(self.temporary.name)
        os.chmod(root, 0o700)
        recording = root / 'recording'
        recording.mkdir(mode=0o700)
        for name, data in self.files:
            self.checkpoint()
            path = recording / name
            path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            write_once(path, data)
        self.checkpoint()
        request = json.dumps(self.request, separators=(',', ':'), allow_nan=False).encode('ascii')
        self.job = OwnedJob(executable=sys.executable,
            arguments=('-I', '-m', 'memlia_agent.openadapt_compile_worker'),
            cwd=str(root), environment=_environment(root), deadline_monotonic=self.request['deadline'],
            io=JobIO(request, 8192, 65536))
        self.output_pending = True
        self.job.start()
        while True:
            self.checkpoint()
            state = self.job.poll()
            if state.forced:
                raise CompileProcessError('compile_worker_refused')
            if state.active_processes == 0 and state.root_finished and state.io_complete is True:
                break
            time.sleep(.05)
        self.output = self.job.take_output()
        self.output_pending = False
        self.checkpoint()
        if (state.root_exit_code != 0 or self.output.stdin_complete is not True
                or self.output.stdout_eof is not True or self.output.stderr_eof is not True):
            raise CompileProcessError('compile_worker_refused')
        def pairs(items):
            value = {}
            for key, item in items:
                if key in value:
                    raise CompileProcessError('compile_worker_refused')
                value[key] = item
            return value
        try:
            result = json.loads(self.output.stdout, object_pairs_hook=pairs)
            valid = (type(result) is dict
                     and set(result) == {'status', 'sourceSha256', 'bundleSha256', 'stepCount', 'versions'}
                     and result['status'] == 'to_test' and result['sourceSha256'] == self.request['sourceSha256']
                     and type(result['stepCount']) is int and 0 <= result['stepCount'] <= 50
                     and result['versions'] == [list(item) for item in sorted(_VERSIONS.items())])
            if not valid:
                raise ValueError()
            files = _output(root / 'bundle')
            if _digest(files, b'memlia.openadapt-bundle/v1\0') != result['bundleSha256']:
                raise ValueError()
        except Exception:
            raise CompileProcessError('compile_worker_refused') from None
        self.checkpoint()
        native = CompiledRecording(tuple(BundleFile(name, data, hashlib.sha256(data).hexdigest())
                                         for name, data in files), result['sourceSha256'],
                                   result['bundleSha256'], result['stepCount'], tuple(sorted(_VERSIONS.items())))
        return CompiledCapture(native, self.operation_digest, self.output)

    def cleanup(self):
        self.require_owner()
        if self.closed:
            return True
        try:
            if self.signal is not None:
                self.signal.request_stop()
            if self.job is not None:
                if not self.job.cleanup():
                    return False
                if self.output_pending:
                    try:
                        self.output = self.job.take_output()
                    except JobError as error:
                        if error.code != 'job_state_refused':
                            raise
                    self.output_pending = False
                self.job = None
            if self.temporary is not None:
                self.temporary.cleanup()
                self.temporary = None
            if self.signal is not None:
                self.signal.close()
                self.signal = None
            if self.reservation is not None:
                self.reservation.close()
                self.reservation = None
        except Exception:
            return False
        self.closed = True
        return True


def compile_captured_recording(*, recording, name, deadline_monotonic, revalidate):
    """Trusted caller/lease required; no input, qualification or replay authority."""
    global _active
    try:
        if (type(recording) is not CapturedRecording or recording.status != 'to_test'
                or type(recording.files) is not tuple or not callable(revalidate)
                or type(recording.operation_digest) is not str
                or len(recording.operation_digest) != 71 or not recording.operation_digest.startswith('sha256:')
                or any(c not in '0123456789abcdef' for c in recording.operation_digest[7:])):
            raise ValueError()
        files = _snapshot(dict(recording.files))
        if files != recording.files or _digest(files, b'memlia.raw-recording-v1\0') != recording.source_sha256:
            raise ValueError()
        operation_digest = recording.operation_digest
        request = checked_request(dict(version=1, name=name, sourceSha256=recording.source_sha256,
                                       deadline=deadline_monotonic))
    except Exception:
        raise CompileProcessError('invalid_compile_request') from None
    with _registry_lock:
        if _active is not None:
            raise CompileProcessError('compile_hold')
        if sys.platform != 'win32':
            raise CompileProcessError('compile_runtime_unavailable')
        owner = _CompileRun(files, operation_digest, request, revalidate)
        _active = owner
    failure, result = 'compile_process_failed', None
    try:
        result = owner.run()
        failure = None
    except CompileProcessError as error:
        failure = error.code
    except StopRequested as error:
        failure = 'compile_timeout' if error.code == 'deadline_expired' else 'compile_cancelled'
    except Exception:
        pass
    finally:
        clean = owner.cleanup()
        if clean:
            with _registry_lock:
                if _active is owner:
                    _active = None
        else:
            failure = 'compile_hold'
    if failure is None:
        try:
            owner.authority()
        except CompileProcessError as error:
            failure = error.code
    if failure is not None:
        error = CompileProcessError(failure)
        error.private_output = owner.output
        raise error
    return result


def reconcile_compile():
    """Cleanup only by the same owner, never another compiler invocation."""
    global _active
    with _registry_lock:
        owner = _active
    if owner is None:
        return True
    if not owner.cleanup():
        return False
    with _registry_lock:
        if _active is owner:
            _active = None
    return True
