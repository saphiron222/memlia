# Copyright (c) 2026 Memlia. All rights reserved.
"""Handle-owned Capture composition; never command authority or replay approval."""
from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
from importlib import metadata
import json
import math
import os
from pathlib import Path
import sys
import tempfile
import threading
import time

from .capture_controls import CaptureUnavailable, _CaptureControls, _DIGEST
from .capture_input_filter import CaptureInputFactory, _SOURCE_FILES, _VERSION
from .openadapt_capture_worker import inventory, read_small, recording_files, request_bytes, write_once
from .openadapt_compile import _digest
from .owned_job import JobError, JobIO, OwnedJob
from .resources import reserve_desktop
from .stop import LocalStop, StopRequested


@dataclass(frozen=True)
class CapturedRecording:
    """Private opaque bytes, not a qualified procedure or authorization."""
    files: tuple[tuple[str, bytes], ...] = field(repr=False)
    raw_files: tuple[tuple[str, bytes], ...] = field(repr=False)
    operation_digest: str
    source_sha256: str
    private_output: object = field(repr=False)
    status: str = 'to_test'


def _runtime_ready():
    failed = False
    try:
        distribution = metadata.distribution('openadapt-capture')
        if (distribution.version != _VERSION or metadata.version('openadapt-flow') != '2.2.0'
                or metadata.version('memlia-windows-agent') != '0.0.0'):
            raise ValueError()
        for path, (size, digest) in _SOURCE_FILES.items():
            with distribution.locate_file(path).open('rb') as handle:
                data = handle.read(size + 1)
            if len(data) != size or hashlib.sha256(data).hexdigest() != digest:
                raise ValueError()
    except Exception:
        failed = True
    if failed:
        raise CaptureError('capture_source_filter_unavailable')


def _environment(root):
    # No inherited proxy/token/Python config or mutable user-supplied PATH.
    values = {key: os.environ[key] for key in
              ('SYSTEMROOT', 'WINDIR', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'HOME')
              if key in os.environ}
    if 'SYSTEMROOT' not in values:
        raise CaptureError('capture_runtime_unavailable')
    values.update(TEMP=str(root), TMP=str(root),
                  PATH=str(Path(sys.executable).parent) + ';' + values['SYSTEMROOT'] + '\\System32',
                  ORT_DISABLE_TELEMETRY='1', OPENADAPT_FLOW_OCR='rapidocr')
    return values


class CaptureError(RuntimeError):
    """Fixed failure. capture_hold keeps the owner and its resources registered."""

    def __init__(self, code):
        self.code = code
        self.private_output = None
        super().__init__(code)


_registry_lock = threading.Lock()
_active = None  # Strong ownership, including after an exception/unknown cleanup.


class _CaptureRun:
    def __init__(self, *, operation_digest, deadline_monotonic, max_bytes, revalidate,
                 on_local_consent=None):
        self.digest, self.deadline, self.max_bytes = operation_digest, deadline_monotonic, max_bytes
        self.revalidate = revalidate
        self.on_local_consent = on_local_consent
        self.owner, self.pid, self.tid = threading.current_thread(), os.getpid(), threading.get_native_id()
        self.reservation = self.signal = self.controls = self.job = None
        self.temporary = None
        self.work_prepared = False
        self.phase = 'pending'
        self.output = None
        self._output_pending = False

    def _require_owner(self):
        if (self.owner is not threading.current_thread() or not self.owner.is_alive()
                or self.pid != os.getpid() or self.tid != threading.get_native_id()):
            raise CaptureError('capture_owner_mismatch')

    def _authority(self):
        self._require_owner()
        failed = False
        try:
            failed = self.revalidate() is not None
        except Exception:
            failed = True
        if failed:
            raise CaptureError('capture_authority_unavailable')
        if time.monotonic() >= self.deadline:
            raise CaptureError('capture_deadline_expired')

    def run(self):
        self._authority()
        _runtime_ready()  # No UI, hooks or engine import on an unavailable runtime.
        self._authority()
        self.reservation = reserve_desktop()
        self.signal = LocalStop(self.reservation, self.deadline)
        self.signal._start()
        self._authority()
        self.controls = _CaptureControls(self.reservation, self.signal, self.digest)
        self.controls._start()  # Actual local consent; no network boolean substitutes it.
        if self.on_local_consent is not None:
            observation = self.controls.consent_observation(operation_digest=self.digest)
            if self.on_local_consent(observation) is not None:
                raise CaptureError('capture_authority_unavailable')
        self._authority()
        factory = CaptureInputFactory.from_controls(self.controls, operation_digest=self.digest)
        self.temporary = tempfile.TemporaryDirectory(prefix='memlia-capture-')
        root = Path(self.temporary.name)
        os.chmod(root, 0o700)
        maximum = min(self.max_bytes, 32 * 1024 * 1024)
        self.job = OwnedJob(executable=sys.executable,
                            arguments=('-I', '-m', 'memlia_agent.openadapt_capture_worker'),
                            cwd=str(root), environment=_environment(root),
                            deadline_monotonic=self.deadline,
                            io=JobIO(request_bytes(factory, maximum), 8192, 65536))
        try:
            self.controls.recording_preparing(operation_digest=self.digest)
        except BaseException:
            # The final checkpoint can refuse after pending work was recorded.
            with self.controls._lock:
                self.work_prepared = self.controls._work_pending
            raise
        self.work_prepared = True
        self._authority()
        self.controls.checkpoint(operation_digest=self.digest)
        self._output_pending = True
        self.job.start()
        started = finishing = False
        while True:
            self._authority()
            self.controls.checkpoint(operation_digest=self.digest)
            inventory(root, maximum)
            state = self.job.poll()
            if state.forced:
                raise CaptureError('capture_worker_refused')
            if not started and (root / 'ready').exists():
                if read_small(root / 'ready', 72) != (self.digest + '\n').encode('ascii'):
                    raise CaptureError('capture_worker_refused')
                self.controls.recording_started(operation_digest=self.digest)
                started = True
            if started and not finishing and self.controls.finish_requested(operation_digest=self.digest):
                self._authority()
                self.controls.checkpoint(operation_digest=self.digest)
                write_once(root / 'finish', (self.digest + '\n').encode('ascii'))
                finishing = True
            if state.active_processes == 0 and state.root_finished and state.io_complete is True:
                break
            time.sleep(.05)
        self.output = self.job.take_output()  # Keep bounded native streams before parsing.
        self._output_pending = False
        valid = False
        try:
            result = json.loads(self.output.stdout)
            valid = (type(result) is dict and set(result) == {'status', 'operationDigest'}
                     and result == {'status': 'recorded', 'operationDigest': self.digest}
                     and state.root_exit_code == 0 and finishing
                     and self.output.stdin_complete is True and self.output.stdout_eof is True
                     and self.output.stderr_eof is True)
        except Exception:
            pass
        if not valid:
            raise CaptureError('capture_worker_refused')
        self._authority()
        self.controls.checkpoint(operation_digest=self.digest)
        files = recording_files(root / 'recording', maximum)
        raw = tuple((name, read_small(root / 'capture' / name, 8 * 1024 * 1024))
                    for name, _ in inventory(root / 'capture', maximum))
        return CapturedRecording(files, raw, self.digest,
                                 _digest(files, b'memlia.raw-recording-v1\0'), self.output)

    def cleanup(self):
        self._require_owner()
        if self.phase == 'closed':
            return True
        try:
            if self.signal is not None:
                self.signal.request_stop()
            if self.job is not None:
                if not self.job.cleanup():
                    self.phase = 'hold'
                    return False
                if self._output_pending:
                    try:
                        # Refus/timeout may precede normal EOF. Keep the collected
                        # partial streams before dropping the closed Job owner.
                        self.output = self.job.take_output()
                    except JobError as error:
                        if error.code != 'job_state_refused':
                            raise
                        # start() may fail before IO exists; no bytes are claimed.
                    self._output_pending = False
                self.job = None
            if self.temporary is not None:
                self.temporary.cleanup()
                self.temporary = None
            if self.controls is not None:
                if self.work_prepared:
                    self.controls.recording_stopped(operation_digest=self.digest)
                    self.work_prepared = False
                self.controls.close()
                self.controls = None
            if self.signal is not None:
                self.signal.close()
                self.signal = None
            if self.reservation is not None:
                self.reservation.close()
                self.reservation = None
        except Exception:
            self.phase = 'hold'
            return False
        self.phase = 'closed'
        return True


def record_capture(*, operation_digest, deadline_monotonic, max_bytes, revalidate,
                   on_local_consent=None):
    """Internal trusted caller only. No public command, route or server authority.

    revalidate is the required native authority/lease port, not a network boolean.
    A caller must never reset or substitute a LocalStop to finish this operation.
    """
    global _active
    deadline_valid = False
    if type(deadline_monotonic) in (int, float):
        try:
            deadline_valid = (math.isfinite(deadline_monotonic)
                              and 0 < deadline_monotonic - time.monotonic() <= 1800)
        except OverflowError:
            pass
    if (type(operation_digest) is not str or not _DIGEST.fullmatch(operation_digest)
            or not deadline_valid or type(max_bytes) is not int
            or not 1 <= max_bytes <= 2147483648 or not callable(revalidate)
            or on_local_consent is not None and not callable(on_local_consent)):
        raise CaptureError('invalid_capture_request')
    with _registry_lock:
        if _active is not None:
            raise CaptureError('capture_hold')
        if sys.platform != 'win32':
            raise CaptureError('capture_runtime_unavailable')
        owner = _CaptureRun(operation_digest=operation_digest, deadline_monotonic=deadline_monotonic,
                            max_bytes=max_bytes, revalidate=revalidate, on_local_consent=on_local_consent)
        _active = owner
    failure = 'capture_failed'
    result = None
    try:
        candidate = owner.run()
        if type(candidate) is CapturedRecording and candidate.operation_digest == operation_digest:
            result = candidate
            failure = None
    except CaptureError as error:
        failure = error.code
    except CaptureUnavailable as error:
        failure = ('capture_consent_unavailable' if error.code == 'local_consent_unavailable'
                   else 'capture_controls_unavailable')
    except StopRequested as error:
        failure = ('capture_deadline_expired' if error.code == 'deadline_expired'
                   else 'capture_cancelled')
    except Exception:
        failure = 'capture_failed'
    finally:
        clean = False
        try:
            clean = owner.cleanup()
        except Exception:
            pass  # Unknown cleanup must keep the strong owner; never release it.
        if clean:
            with _registry_lock:
                if _active is owner:
                    _active = None
        else:
            failure = 'capture_hold'
    if failure is None:
        try:
            owner._authority()  # Cleanup may take time or authority may have expired meanwhile.
        except CaptureError as error:
            failure = error.code
        except Exception:
            failure = 'capture_failed'
    if failure is not None:
        error = CaptureError(failure)
        error.private_output = owner.output
        raise error
    return result


def reconcile_capture():
    """Retry only exact owned cleanup, never another capture or a success receipt."""
    global _active
    with _registry_lock:
        owner = _active
    if owner is None:
        return
    if not owner.cleanup():
        raise CaptureError('capture_hold')
    with _registry_lock:
        if _active is owner:
            _active = None
