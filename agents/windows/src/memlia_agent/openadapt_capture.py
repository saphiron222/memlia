# Copyright (c) 2026 Memlia. All rights reserved.
"""Inactive owned Capture composition; neither command authority nor consent."""
from __future__ import annotations

import math
import os
import sys
import threading
import time

from .capture_controls import _DIGEST


class CaptureError(RuntimeError):
    """Fixed failure. capture_hold keeps the owner and its resources registered."""

    def __init__(self, code):
        self.code = code
        super().__init__(code)


_registry_lock = threading.Lock()
_active = None  # Strong ownership, including after an exception/unknown cleanup.


class _CaptureRun:
    def __init__(self, *, operation_digest, deadline_monotonic, max_bytes, revalidate):
        self.digest, self.deadline, self.max_bytes = operation_digest, deadline_monotonic, max_bytes
        self.revalidate = revalidate
        self.owner, self.pid, self.tid = threading.current_thread(), os.getpid(), threading.get_native_id()
        self.reservation = self.signal = self.controls = self.job = None
        self.temporary = None
        self.work_prepared = False
        self.phase = 'pending'

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
        # Capture 1.3.0 has no source-time Memlia window/key exclusion port.
        # A live_event_tap is too late: input is already persisted. Never create
        # Recorder, a desktop reservation or a consent dialog through this gate.
        raise CaptureError('capture_source_filter_unavailable')

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


def record_capture(*, operation_digest, deadline_monotonic, max_bytes, revalidate):
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
            or not 1 <= max_bytes <= 2147483648 or not callable(revalidate)):
        raise CaptureError('invalid_capture_request')
    with _registry_lock:
        if _active is not None:
            raise CaptureError('capture_hold')
        if sys.platform != 'win32':
            raise CaptureError('capture_runtime_unavailable')
        owner = _CaptureRun(operation_digest=operation_digest, deadline_monotonic=deadline_monotonic,
                            max_bytes=max_bytes, revalidate=revalidate)
        _active = owner
    failure = 'capture_failed'  # This preparation has no successful result path.
    try:
        owner.run()
    except CaptureError as error:
        failure = error.code
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
    raise CaptureError(failure)


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
