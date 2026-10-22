# Copyright (c) 2026 Memlia. All rights reserved.
"""Inactive source-time Windows input policy; no authority or consent granted."""
from __future__ import annotations

import ctypes
from dataclasses import dataclass, field
import hashlib
from importlib import import_module, metadata
import math
import os
import re
import sys
import threading
import time
from types import SimpleNamespace

from .capture_controls import _CaptureControls, _DIGEST, _Point
from .session import SessionObservation, _function, observe_session

_VERSION = '1.3.0+memlia.1'
_SOURCE_FILES = {'openadapt_capture/recorder.py': (177885, 'c112f1246357f6e0a00a12502dab4386ec946f40f6b407896d1ada42d529eafc'), 'openadapt_capture/input_observer/windows.py': (36237, '751bfa7b332bc6aeed5d4356573323a9980712ee26b03fa4c8018c366665cfd4')}
_SID = re.compile(r'S-1-\d+(?:-\d+){1,15}\Z')


class InputFilterUnavailable(RuntimeError):
    """Fixed refusal; never includes input/window/process metadata or causes."""
    def __init__(self):
        self.code = 'capture_input_filter_unavailable'
        super().__init__(self.code)


@dataclass(frozen=True)
class CaptureInputFactory:
    """Trusted INTERNAL snapshot, pickled by module reference and scalars only.

    Not a capability/permission. Only the future owned host may construct it;
    never bind model/network fields to these arguments. No engine import here.
    """
    ui_pid: int = field(repr=False)
    ui_birth: int = field(repr=False)
    ui_hwnd: int = field(repr=False)
    ui_thread: int = field(repr=False)
    windows_sid: str = field(repr=False)
    session_id: int = field(repr=False)
    operation_digest: str = field(repr=False)
    deadline_monotonic: float = field(repr=False)

    def __post_init__(self):
        self._validate_values()

    def _validate_values(self):
        failed = False
        try:
            for name, maximum in (('ui_pid', 2**32 - 1), ('ui_birth', 2**64 - 1),
                                  ('ui_hwnd', 2**64 - 1), ('ui_thread', 2**32 - 1),
                                  ('session_id', 2**32 - 2)):
                value = getattr(self, name)
                if type(value) is not int or not 1 <= value <= maximum:
                    failed = True
            if (type(self.windows_sid) is not str or len(self.windows_sid) > 184
                    or not _SID.fullmatch(self.windows_sid)
                    or type(self.operation_digest) is not str
                    or not _DIGEST.fullmatch(self.operation_digest)
                    or type(self.deadline_monotonic) not in (int, float)
                    or not math.isfinite(self.deadline_monotonic)
                    or not 0 < self.deadline_monotonic - time.monotonic() <= 1800):
                failed = True
        except Exception:
            failed = True
        if failed:
            raise InputFilterUnavailable()

    @classmethod
    def from_controls(cls, controls, *, operation_digest):
        """Only real owned controls/checkpoints; no synthetic approval argument."""
        failed = False
        try:
            if cls is not CaptureInputFactory or type(controls) is not _CaptureControls:
                raise InputFilterUnavailable()
            controls.checkpoint(operation_digest=operation_digest)
            with controls._lock:
                hwnd, observed = controls._hwnd, controls._observed
                pid, tid = controls._pid, controls._ui_id
            api = _Windows()
            birth, session, alive = api.process_info(pid)
            if not alive or session != observed.session_id:
                raise InputFilterUnavailable()
            result = cls(pid, birth, hwnd, tid, observed.windows_sid, observed.session_id,
                         operation_digest, controls._signal._deadline)
            _InputPolicy(result, api)._validate()
            controls.checkpoint(operation_digest=operation_digest)
            with controls._lock:
                if controls._hwnd != hwnd or controls._observed != observed or controls._ui_id != tid:
                    raise InputFilterUnavailable()
        except Exception:
            failed = True
        if failed:
            raise InputFilterUnavailable()
        return result

    def __call__(self, callback, *, observe_keyboard, observe_mouse, capture_mouse_moves):
        failed = False
        try:
            if type(self) is not CaptureInputFactory:
                raise InputFilterUnavailable()
            self._validate_values()  # Recheck after unpickle, never trust __post_init__ alone.
            if not callable(callback) or any(value is not True for value in
                    (observe_keyboard, observe_mouse, capture_mouse_moves)):
                raise InputFilterUnavailable()
            policy = _InputPolicy(self, _Windows())
            policy._validate()
            base = _observer_runtime()  # Version AND two source hashes, no vanilla fallback.
            # Only this factory is serialized. Observer construction occurs in the
            # worker; module-level method functions close over no profile or lock.
            observer_type = type('_MemliaWindowsInputObserver', (base,), {
                '_retain_keyboard': _retain_keyboard, '_retain_mouse': _retain_mouse,
                '__module__': __name__})
            result = observer_type(callback, observe_keyboard=True, observe_mouse=True,
                                   capture_mouse_moves=True)
            result._memlia_policy = policy
            policy._validate()
        except Exception:
            failed = True
        if failed:
            raise InputFilterUnavailable()
        return result


def _observer_runtime():
    failed = False
    try:
        distribution = metadata.distribution('openadapt-capture')
        if distribution.version != _VERSION or len(_SOURCE_FILES) != 2:
            raise InputFilterUnavailable()
        for relative, (size, checksum) in _SOURCE_FILES.items():
            with distribution.locate_file(relative).open('rb') as handle:
                data = handle.read(size + 1)
            if len(data) != size or hashlib.sha256(data).hexdigest() != checksum:
                raise InputFilterUnavailable()
        base = import_module('openadapt_capture.input_observer.windows').WindowsInputObserver
        if not all(callable(getattr(base, name, None)) for name in ('_retain_keyboard', '_retain_mouse')):
            raise InputFilterUnavailable()
    except Exception:
        failed = True
    if failed:
        raise InputFilterUnavailable()
    return base


def _retain_keyboard(observer, *, pressed, vk_code, scan_code, flags):
    # Reuse Capture's physical identity mapping (generic left/right modifiers).
    # The native transition/normalization itself is not changed or duplicated.
    physical = observer._physical_vk(SimpleNamespace(vk_code=vk_code, scan_code=scan_code, flags=flags))
    return observer._memlia_policy.keyboard(pressed=pressed, vk_code=physical,
                                           scan_code=scan_code, flags=flags)


def _retain_mouse(observer, **transition):
    return observer._memlia_policy.mouse(**transition)


class _InputPolicy:
    def __init__(self, binding, native):
        self.binding, self.native = binding, native
        self._keys, self._buttons = {}, {}
        self._thread = None
        self._pid = os.getpid()
        self._tid = None

    def _owner(self):
        current = threading.current_thread()
        if self._thread is None:
            self._thread, self._tid = current, threading.get_native_id()
        if (not self._thread.is_alive() or self._thread is not current
                or self._pid != os.getpid() or self._tid != threading.get_native_id()):
            raise InputFilterUnavailable()

    @staticmethod
    def _window(value):
        if type(value) is not tuple or len(value) != 3 or any(type(x) is not int or x <= 0 for x in value):
            raise InputFilterUnavailable()
        return value

    def _validate(self):
        self.binding._validate_values()
        current = self.native.current_session()
        if (type(current) is not SessionObservation or
                (current.windows_sid, current.session_id) !=
                (self.binding.windows_sid, self.binding.session_id)):
            raise InputFilterUnavailable()
        birth, session, alive = self.native.process_info(self.binding.ui_pid)
        window = self._window(self.native.window_info(self.binding.ui_hwnd))
        if (type(birth) is not int or birth != self.binding.ui_birth
                or type(session) is not int or session != self.binding.session_id or alive is not True
                or window != (self.binding.ui_hwnd, self.binding.ui_pid, self.binding.ui_thread)):
            raise InputFilterUnavailable()
        self.binding._validate_values()  # Native calls are synchronous; refuse late delivery.

    def _target(self, hwnd):
        if type(hwnd) is not int or hwnd <= 0:
            raise InputFilterUnavailable()
        before = self._window(self.native.window_info(hwnd))
        self._validate()
        if self._window(self.native.window_info(hwnd)) != before:
            raise InputFilterUnavailable()
        return before[0] == self.binding.ui_hwnd or before[1] == self.binding.ui_pid

    def keyboard(self, *, pressed, vk_code, scan_code, flags):
        failed, retained = False, None
        try:
            self._owner()
            if (type(pressed) is not bool or type(vk_code) is not int or not 1 <= vk_code <= 255
                    or type(scan_code) is not int or not 0 <= scan_code < 2**32
                    or type(flags) is not int or not 0 <= flags < 2**32):
                raise InputFilterUnavailable()
            self._validate()
            own = self._target(self.native.foreground())
            if pressed and vk_code == 0x7A:
                emergency = self.native.emergency_down()
                if type(emergency) is not bool or emergency:
                    raise InputFilterUnavailable()  # Never deliver a truncated emergency recording.
            previous = self._keys.get(vk_code)
            if previous is True and own:
                raise InputFilterUnavailable()  # Do not keep a half gesture across the UI boundary.
            if not pressed and previous is None and not own:
                raise InputFilterUnavailable()
            retained = not own if previous is None else previous
            if pressed:
                self._keys[vk_code] = retained
            else:
                self._keys.pop(vk_code, None)
            self.binding._validate_values()  # Include the last window/command query.
        except Exception:
            failed = True
        if failed:
            raise InputFilterUnavailable()
        return retained

    def mouse(self, *, message, x, y, mouse_data, flags):
        failed, retained = False, None
        try:
            self._owner()
            if (type(message) is not int or type(x) is not int or not -(2**31) <= x < 2**31
                    or type(y) is not int or not -(2**31) <= y < 2**31
                    or type(mouse_data) is not int or not 0 <= mouse_data < 2**32
                    or type(flags) is not int or not 0 <= flags < 2**32):
                raise InputFilterUnavailable()
            self._validate()
            own = self._target(self.native.window_at(x, y))
            buttons = {0x201: ('left', True), 0x202: ('left', False),
                       0x204: ('right', True), 0x205: ('right', False),
                       0x207: ('middle', True), 0x208: ('middle', False)}
            if message in (0x20B, 0x20C):
                button = mouse_data >> 16
                if button not in (1, 2):
                    raise InputFilterUnavailable()
                pair = ('x' + str(button), message == 0x20B)
            else:
                pair = buttons.get(message)
            retained = not own
            if pair is not None:
                button, pressed = pair
                previous = self._buttons.get(button)
                if previous is True and own or not pressed and previous is None and not own:
                    raise InputFilterUnavailable()
                retained = not own if previous is None else previous
                if pressed:
                    self._buttons[button] = retained
                else:
                    self._buttons.pop(button, None)
            elif message not in (0x200, 0x20A, 0x20E):
                raise InputFilterUnavailable()
            elif any(value is False for value in self._buttons.values()):
                retained = False
            self.binding._validate_values()
        except Exception:
            failed = True
        if failed:
            raise InputFilterUnavailable()
        return retained


class _FileTime(ctypes.Structure):
    _fields_ = [('low', ctypes.c_uint32), ('high', ctypes.c_uint32)]


class _Windows:
    """Read-only system APIs; no hooks, process termination or global settings."""
    def __init__(self):
        if sys.platform != 'win32' or ctypes.sizeof(ctypes.c_void_p) != 8:
            raise InputFilterUnavailable()
        kernel = ctypes.WinDLL('kernel32', use_last_error=True, winmode=0x800)
        user = ctypes.WinDLL('user32', use_last_error=True, winmode=0x800)
        pointer, u32, boolean = ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int
        self._open = _function(kernel, 'OpenProcess', pointer, [u32, boolean, u32])
        self._close = _function(kernel, 'CloseHandle', boolean, [pointer])
        self._wait = _function(kernel, 'WaitForSingleObject', u32, [pointer, u32])
        self._times = _function(kernel, 'GetProcessTimes', boolean,
                                [pointer] + [ctypes.POINTER(_FileTime)] * 4)
        self._session = _function(kernel, 'ProcessIdToSessionId', boolean, [u32, ctypes.POINTER(u32)])
        self._is_window = _function(user, 'IsWindow', boolean, [pointer])
        self._root = _function(user, 'GetAncestor', pointer, [pointer, u32])
        self._thread = _function(user, 'GetWindowThreadProcessId', u32, [pointer, ctypes.POINTER(u32)])
        self._point = _function(user, 'WindowFromPoint', pointer, [_Point])
        self._foreground = _function(user, 'GetForegroundWindow', pointer, [])
        self._key = _function(user, 'GetAsyncKeyState', ctypes.c_int16, [ctypes.c_int])

    def current_session(self):
        return observe_session()

    def process_info(self, pid):
        handle = self._open(0x101000, False, pid)  # QUERY_LIMITED_INFORMATION | SYNCHRONIZE
        if not handle:
            raise InputFilterUnavailable()
        try:
            creation, end, kernel, user = (_FileTime() for _ in range(4))
            session = ctypes.c_uint32()
            if (not self._times(handle, ctypes.byref(creation), ctypes.byref(end),
                                ctypes.byref(kernel), ctypes.byref(user))
                    or not self._session(pid, ctypes.byref(session))):
                raise InputFilterUnavailable()
            wait = self._wait(handle, 0)
            if wait not in (0, 258):
                raise InputFilterUnavailable()
            return (creation.high << 32) | creation.low, session.value, wait == 258
        finally:
            if not self._close(handle):
                raise InputFilterUnavailable()

    def window_info(self, hwnd):
        pid = ctypes.c_uint32()
        if not self._is_window(hwnd):
            raise InputFilterUnavailable()
        root = self._root(hwnd, 2)  # GA_ROOT, not a title/owner heuristic.
        tid = self._thread(hwnd, ctypes.byref(pid))
        if not root or not tid or not pid.value or not self._is_window(hwnd):
            raise InputFilterUnavailable()
        return int(root), pid.value, int(tid)

    def window_at(self, x, y):
        return self._point(_Point(x, y)) or 0

    def foreground(self):
        return self._foreground() or 0

    def emergency_down(self):
        return all(self._key(key) & 0x8000 for key in (0x10, 0x11, 0x12))
