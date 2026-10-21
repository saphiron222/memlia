# Copyright (c) 2026 Memlia. All rights reserved.
"""Internal handle-owned Windows Job port; no permission, supervisor or capture."""
from __future__ import annotations

import ctypes
from dataclasses import dataclass
import math
import os
from pathlib import PureWindowsPath
import shutil
import subprocess
import sys
import threading
import time

from .session import _function

_U32, _U64, _I64, _PTR = ctypes.c_uint32, ctypes.c_uint64, ctypes.c_int64, ctypes.c_void_p
_KILL_ON_CLOSE = 0x2000
_DISK = 40 * 1024**3


class JobError(RuntimeError):
    """Fixed codes only; never a native message, command or environment."""
    def __init__(self, code):
        self.code = code
        super().__init__(code)


class _NativeRefused(RuntimeError):
    pass


class _CreateRefused(_NativeRefused):
    """CreateProcessW returned FALSE, rather than an unknown interrupted call."""


class _BasicLimits(ctypes.Structure):
    _fields_ = [('PerProcessUserTimeLimit', _I64), ('PerJobUserTimeLimit', _I64),
                ('LimitFlags', _U32), ('MinimumWorkingSetSize', ctypes.c_size_t),
                ('MaximumWorkingSetSize', ctypes.c_size_t), ('ActiveProcessLimit', _U32),
                ('Affinity', ctypes.c_size_t), ('PriorityClass', _U32), ('SchedulingClass', _U32)]


class _IoCounters(ctypes.Structure):
    _fields_ = [(name, _U64) for name in ('ReadOperationCount', 'WriteOperationCount',
        'OtherOperationCount', 'ReadTransferCount', 'WriteTransferCount', 'OtherTransferCount')]


class _ExtendedLimits(ctypes.Structure):
    _fields_ = [('BasicLimitInformation', _BasicLimits), ('IoInfo', _IoCounters),
                ('ProcessMemoryLimit', ctypes.c_size_t), ('JobMemoryLimit', ctypes.c_size_t),
                ('PeakProcessMemoryUsed', ctypes.c_size_t), ('PeakJobMemoryUsed', ctypes.c_size_t)]


class _Accounting(ctypes.Structure):
    _fields_ = [(name, _I64) for name in ('TotalUserTime', 'TotalKernelTime',
        'ThisPeriodTotalUserTime', 'ThisPeriodTotalKernelTime')] + [(name, _U32) for name in
        ('TotalPageFaultCount', 'TotalProcesses', 'ActiveProcesses', 'TotalTerminatedProcesses')]


class _Startup(ctypes.Structure):
    _fields_ = [('cb', _U32), ('lpReserved', ctypes.c_wchar_p), ('lpDesktop', ctypes.c_wchar_p),
                ('lpTitle', ctypes.c_wchar_p), ('dwX', _U32), ('dwY', _U32), ('dwXSize', _U32),
                ('dwYSize', _U32), ('dwXCountChars', _U32), ('dwYCountChars', _U32),
                ('dwFillAttribute', _U32), ('dwFlags', _U32), ('wShowWindow', ctypes.c_uint16),
                ('cbReserved2', ctypes.c_uint16), ('lpReserved2', _PTR), ('hStdInput', _PTR),
                ('hStdOutput', _PTR), ('hStdError', _PTR)]


class _ProcessInfo(ctypes.Structure):
    _fields_ = [('hProcess', _PTR), ('hThread', _PTR), ('dwProcessId', _U32), ('dwThreadId', _U32)]


class _FileTime(ctypes.Structure):
    _fields_ = [('low', _U32), ('high', _U32)]


class _Kernel:
    """System DLL ABI only; no process lookup by PID or implicit handle inheritance."""
    def __init__(self):
        if sys.platform != 'win32' or ctypes.sizeof(_PTR) != 8:
            raise _NativeRefused()
        api = ctypes.WinDLL('kernel32', use_last_error=True, winmode=0x800)
        boolean = ctypes.c_int32
        self._create_job = _function(api, 'CreateJobObjectW', _PTR, [_PTR, ctypes.c_wchar_p])
        self._set = _function(api, 'SetInformationJobObject', boolean, [_PTR, ctypes.c_int32, _PTR, _U32])
        self._query = _function(api, 'QueryInformationJobObject', boolean,
                                [_PTR, ctypes.c_int32, _PTR, _U32, ctypes.POINTER(_U32)])
        self._create = _function(api, 'CreateProcessW', boolean,
            [ctypes.c_wchar_p, _PTR, _PTR, _PTR, boolean, _U32, _PTR, ctypes.c_wchar_p,
             ctypes.POINTER(_Startup), ctypes.POINTER(_ProcessInfo)])
        self._assign = _function(api, 'AssignProcessToJobObject', boolean, [_PTR, _PTR])
        self._contains = _function(api, 'IsProcessInJob', boolean, [_PTR, _PTR, ctypes.POINTER(boolean)])
        self._resume = _function(api, 'ResumeThread', _U32, [_PTR])
        self._terminate_job = _function(api, 'TerminateJobObject', boolean, [_PTR, _U32])
        self._terminate_process = _function(api, 'TerminateProcess', boolean, [_PTR, _U32])
        self._wait = _function(api, 'WaitForSingleObject', _U32, [_PTR, _U32])
        self._exit = _function(api, 'GetExitCodeProcess', boolean, [_PTR, ctypes.POINTER(_U32)])
        self._times = _function(api, 'GetProcessTimes', boolean,
                                [_PTR] + [ctypes.POINTER(_FileTime)] * 4)
        self._close = _function(api, 'CloseHandle', boolean, [_PTR])

    @staticmethod
    def _require(value):
        if not value:
            raise _NativeRefused()

    @staticmethod
    def free_bytes(cwd):
        return shutil.disk_usage(cwd).free

    def create_job(self):
        handle = self._create_job(None, None)  # Anonymous, non-inheritable.
        self._require(handle)
        return int(handle)

    def set_limits(self, job):
        info = _ExtendedLimits()
        info.BasicLimitInformation.LimitFlags = _KILL_ON_CLOSE
        self._require(self._set(job, 9, ctypes.byref(info), ctypes.sizeof(info)))

    def _information(self, job, kind, structure):
        value, length = structure(), _U32()
        self._require(self._query(job, kind, ctypes.byref(value), ctypes.sizeof(value), ctypes.byref(length)))
        self._require(length.value == ctypes.sizeof(value))
        return value

    def limits(self, job):
        return self._information(job, 9, _ExtendedLimits).BasicLimitInformation.LimitFlags

    def create_process(self, executable, command, cwd, environment):
        startup, info = _Startup(), _ProcessInfo()
        startup.cb = ctypes.sizeof(startup)
        mutable = ctypes.create_unicode_buffer(command)
        block = ctypes.create_unicode_buffer(environment)
        # CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT.
        if not self._create(executable, mutable, None, None, False, 0x08000404,
                            block, cwd, ctypes.byref(startup), ctypes.byref(info)):
            raise _CreateRefused()
        return int(info.hProcess or 0), int(info.hThread or 0), int(info.dwProcessId)

    def assign(self, job, process):
        self._require(self._assign(job, process))

    def contains(self, process, job):
        value = ctypes.c_int32()
        self._require(self._contains(process, job, ctypes.byref(value)))
        return value.value != 0

    def creation_time(self, process):
        values = [_FileTime() for _ in range(4)]
        self._require(self._times(process, *[ctypes.byref(value) for value in values]))
        return values[0].high << 32 | values[0].low

    def resume(self, thread):
        return int(self._resume(thread))

    def active_processes(self, job):
        return self._information(job, 1, _Accounting).ActiveProcesses

    def wait(self, process, milliseconds):
        value = int(self._wait(process, milliseconds))
        self._require(value in (0, 258))
        return value

    def exit_code(self, process):
        value = _U32()
        self._require(self._exit(process, ctypes.byref(value)))
        return value.value

    def terminate_job(self, job):
        self._require(self._terminate_job(job, 124))

    def terminate_process(self, process):
        self._require(self._terminate_process(process, 125))

    def close(self, handle):
        self._require(self._close(handle))


@dataclass(frozen=True)
class JobState:
    active_processes: int
    root_finished: bool
    root_exit_code: int | None
    forced: bool


def _text(value, maximum):
    if (type(value) is not str or len(value) > maximum or '\0' in value
            or len(value.encode('utf-16-le')) // 2 > maximum):
        raise ValueError()
    return value


def _absolute(value):
    _text(value, 4096)
    path = PureWindowsPath(value)
    if (not path.is_absolute() or len(path.drive) != 2 or path.drive[1] != ':'
            or not path.drive[0].isascii() or not path.drive[0].isalpha()
            or '..' in path.parts or ':' in value[2:]):
        raise ValueError()
    return value


class OwnedJob:
    """Keep this owner BEFORE start. No context manager/destructor or ambient env.

    Methods are cooperative kernel checkpoints, not a hard syscall timeout.
    Caller owns authority/lease/consent and must keep polling/hold this owner.
    """
    def __init__(self, *, executable, arguments, cwd, environment, deadline_monotonic):
        failed = False
        try:
            _absolute(executable)
            _absolute(cwd)
            if (type(arguments) is not tuple or len(arguments) > 64 or type(environment) is not dict
                    or not 1 <= len(environment) <= 32
                    or type(deadline_monotonic) not in (int, float)
                    or not math.isfinite(deadline_monotonic)
                    or not 0 < deadline_monotonic - time.monotonic() <= 1800):
                raise ValueError()
            for value in arguments:
                _text(value, 4096)
            captured = []
            for key, value in environment.items():
                _text(key, 64)
                _text(value, 4096)
                if not key or '=' in key:
                    raise ValueError()
                captured.append((key, value))
            names = [key.casefold() for key, _ in captured]
            if len(set(names)) != len(names) or 'systemroot' not in names:
                raise ValueError()
            command = subprocess.list2cmdline((executable, *arguments))
            block = '\0'.join(key + '=' + value for key, value in
                              sorted(captured, key=lambda item: item[0].casefold())) + '\0\0'
            _text(command, 32766)
            if len(block.encode('utf-16-le')) > 16384:
                raise ValueError()
        except Exception:
            failed = True
        if failed:
            raise JobError('invalid_job_request')
        self._executable, self._command, self._cwd, self._environment = executable, command, cwd, block
        self._deadline = deadline_monotonic
        self._owner, self._pid, self._tid = threading.current_thread(), os.getpid(), threading.get_native_id()
        self._api = self._job = self._process = self._thread = None
        self._created = self._creating = self._assigned = self._called = self._forced = False
        self._identity = None
        self._phase = 'new'

    def _require_owner(self):
        if (self._owner is not threading.current_thread() or not self._owner.is_alive()
                or self._pid != os.getpid() or self._tid != threading.get_native_id()):
            raise JobError('job_owner_mismatch')

    def _checkpoint(self):
        if time.monotonic() >= self._deadline:
            raise JobError('job_deadline_expired')

    def _disk(self):
        free = self._api.free_bytes(self._cwd)
        if type(free) is not int or free < _DISK:
            raise _NativeRefused()

    def _active(self):
        active = self._api.active_processes(self._job)
        if type(active) is not int or not 0 <= active < 2**32:
            raise _NativeRefused()
        return active

    def _finished(self):
        result = self._api.wait(self._process, 0)
        if type(result) is not int or result not in (0, 258):
            raise _NativeRefused()
        return result == 0

    @property
    def root_identity(self):
        self._require_owner()
        return self._identity

    def start(self):
        self._require_owner()
        if self._called or self._phase != 'new':
            raise JobError('job_state_refused')
        self._called = True
        failed = False
        try:
            self._checkpoint()
            self._api = _Kernel()
            self._disk()
            self._checkpoint()
            self._job = self._api.create_job()
            self._api.set_limits(self._job)
            if self._api.limits(self._job) != _KILL_ON_CLOSE:
                raise _NativeRefused()
            self._checkpoint()
            self._creating = True
            try:
                self._process, self._thread, pid = self._api.create_process(
                    self._executable, self._command, self._cwd, self._environment)
            except _CreateRefused:
                self._creating = False  # Native FALSE proves no returned process.
                raise
            self._creating, self._created = False, True
            if any(type(value) is not int or value <= 0 for value in (self._process, self._thread, pid)):
                raise _NativeRefused()
            self._checkpoint()
            self._api.assign(self._job, self._process)
            if self._api.contains(self._process, self._job) is not True:
                raise _NativeRefused()
            self._assigned = True
            birth = self._api.creation_time(self._process)
            if type(birth) is not int or not 0 < birth < 2**64:
                raise _NativeRefused()
            self._identity = pid, birth
            self._checkpoint()
            previous = self._api.resume(self._thread)
            if type(previous) is not int or previous != 1:
                raise _NativeRefused()
            self._checkpoint()
            self._phase = 'running'
        except Exception:
            failed = True
        except BaseException:
            self.cleanup()
            raise  # Preserve control-flow interruption after exact owned cleanup.
        if failed:
            self.cleanup()  # Unknown proof retains handles; not a blind finally.
            raise JobError('job_start_refused')

    def poll(self):
        self._require_owner()
        if self._phase not in ('running', 'finished'):
            raise JobError('job_state_refused')
        expired = time.monotonic() >= self._deadline
        if expired:
            self.cleanup()
            raise JobError('job_deadline_expired')
        failed = False
        try:
            self._disk()
            active = self._active()
            finished = self._finished()
            if active == 0 and not finished:
                raise _NativeRefused()
            code = self._api.exit_code(self._process) if finished else None
            if code is not None and (type(code) is not int or not 0 <= code < 2**32):
                raise _NativeRefused()
            expired = time.monotonic() >= self._deadline
        except Exception:
            failed = True
        if failed:
            self._phase = 'hold'
            raise JobError('job_observation_refused')
        if expired:
            self.cleanup()
            raise JobError('job_deadline_expired')
        if active == 0:
            self._phase = 'finished'
        return JobState(active, finished, code, self._forced)

    def cleanup(self):
        self._require_owner()
        if self._phase == 'closed':
            return True
        try:
            if self._creating or self._created and not self._process:
                raise _NativeRefused()  # Never guess an unreturned process handle.
            until = time.monotonic() + 5
            if self._process is not None and not self._assigned:
                if not self._finished():
                    self._forced = True
                    self._api.terminate_process(self._process)
                while not self._finished():
                    if time.monotonic() >= until:
                        raise _NativeRefused()
                    time.sleep(.05)
            if self._job is not None:
                active = self._active()
                if active:
                    if not self._created:
                        raise _NativeRefused()
                    self._forced = True
                    self._api.terminate_job(self._job)
                while active:
                    if time.monotonic() >= until:
                        raise _NativeRefused()
                    time.sleep(.05)
                    active = self._active()
                if self._process is not None and not self._finished():
                    raise _NativeRefused()
            for name in ('_thread', '_process', '_job'):
                handle = getattr(self, name)
                if handle is not None:
                    self._api.close(handle)
                    setattr(self, name, None)
        except BaseException:
            self._phase = 'hold'
            return False
        self._phase = 'closed'
        return True
