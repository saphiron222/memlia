# Copyright (c) 2026 Memlia. All rights reserved.
"""Internal handle-owned Windows Job port; optional finite IO, no permission."""
from __future__ import annotations

import ctypes
from dataclasses import dataclass, field
import math
import os
from pathlib import PureWindowsPath
import shutil
import subprocess
import sys
import threading
import time
import uuid

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


class _StartupEx(ctypes.Structure):
    _fields_ = [('StartupInfo', _Startup), ('lpAttributeList', _PTR)]


class _Overlapped(ctypes.Structure):
    _fields_ = [('Internal', ctypes.c_size_t), ('InternalHigh', ctypes.c_size_t),
                ('Offset', _U32), ('OffsetHigh', _U32), ('hEvent', _PTR)]


class _OutputLimit(_NativeRefused):
    pass


@dataclass(frozen=True)
class JobIO:
    """Finite private input and cumulative byte caps, not command authorization."""
    stdin: bytes = field(default=b'', repr=False)
    stdout_limit: int = 1048576
    stderr_limit: int = 65536

    def __post_init__(self):
        if (type(self.stdin) is not bytes or len(self.stdin) > 262144
                or any(type(n) is not int or not 1 <= n <= 1048576
                       for n in (self.stdout_limit, self.stderr_limit))):
            raise JobError('invalid_job_io')


@dataclass(frozen=True)
class JobOutput:
    stdout: bytes = field(repr=False)
    stderr: bytes = field(repr=False)
    stdin_complete: bool
    stdout_eof: bool
    stderr_eof: bool


class _PipeIO:
    """Three local byte pipes. Owner retains pending buffers until completion.

    Parent ends are overlapped/non-inheritable; only synchronous child ends enter
    the explicit startup handle list. No blocking read/write worker thread.
    """
    def __init__(self, spec):
        self.spec = spec
        self.channels = {name: dict(parent=None, child=None, event=None,
            pending=False, buffer=None, overlap=None, eof=False)
            for name in ('stdin', 'stdout', 'stderr')}
        self.counts = {'stdout': 0, 'stderr': 0}
        self.buffers = {'stdout': bytearray(), 'stderr': bytearray()}
        self.sent = 0
        self.attributes = None
        self.attributes_ready = False
        self.handle_list = None
        self.stopping = False
        self.api = None

    def open(self):
        # Lazy bindings: legacy no-IO mode retains its original ABI and behavior.
        self.api = ctypes.WinDLL('kernel32', use_last_error=True, winmode=0x800)
        b, p, u = ctypes.c_int32, _PTR, _U32
        signatures = {
            'CreateNamedPipeW': (p, [ctypes.c_wchar_p,u,u,u,u,u,u,p]),
            'CreateFileW': (p, [ctypes.c_wchar_p,u,u,p,u,u,p]),
            'ConnectNamedPipe': (b, [p, ctypes.POINTER(_Overlapped)]),
            'GetNamedPipeClientProcessId': (b, [p, ctypes.POINTER(u)]),
            'CreateEventW': (p, [p,b,b,ctypes.c_wchar_p]),
            'SetHandleInformation': (b, [p,u,u]),
            'InitializeProcThreadAttributeList': (b, [p,u,u,ctypes.POINTER(ctypes.c_size_t)]),
            'UpdateProcThreadAttribute': (b, [p,u,ctypes.c_size_t,p,ctypes.c_size_t,p,p]),
            'DeleteProcThreadAttributeList': (None, [p]),
            'ReadFile': (b, [p,p,u,ctypes.POINTER(u),ctypes.POINTER(_Overlapped)]),
            'WriteFile': (b, [p,p,u,ctypes.POINTER(u),ctypes.POINTER(_Overlapped)]),
            'GetOverlappedResult': (b, [p,ctypes.POINTER(_Overlapped),ctypes.POINTER(u),b]),
            'CancelIoEx': (b, [p,ctypes.POINTER(_Overlapped)]),
            'CloseHandle': (b, [p]),
        }
        for name, (result, args) in signatures.items():
            setattr(self, name, _function(self.api, name, result, args))
        for name, ch in self.channels.items():
            pipe = '\\\\.\\pipe\\MemliaJobIO-' + uuid.uuid4().hex
            # FIRST_PIPE_INSTANCE + OVERLAPPED; local-only, one instance, byte mode.
            ch['parent'] = self._handle(self.CreateNamedPipeW(pipe,
                0x40080000 | (2 if name == 'stdin' else 1), 8, 1, 16384, 16384, 0, None))
            ch['event'] = self._handle(self.CreateEventW(None, True, False, None))
            ch['overlap'] = _Overlapped(hEvent=ch['event'])
            ch['child'] = self._handle(self.CreateFileW(pipe,
                0x80000000 if name == 'stdin' else 0x40000000, 0, None, 3, 0, None))
            # Client is already connected. Retain OVERLAPPED if any unexpected pending call.
            ch['pending'] = True
            ok = self.ConnectNamedPipe(ch['parent'], ctypes.byref(ch['overlap']))
            error = 0 if ok else ctypes.get_last_error()
            if ok or error == 535:  # ERROR_PIPE_CONNECTED, normal pre-connected client.
                ch['pending'] = False
            else:
                if error != 997:
                    ch['pending'] = False
                raise _NativeRefused()
            pid = _U32()
            self._require(self.GetNamedPipeClientProcessId(ch['parent'], ctypes.byref(pid)))
            self._require(pid.value == os.getpid())

    @staticmethod
    def _require(value):
        if not value:
            raise _NativeRefused()

    @staticmethod
    def _handle(value):
        if value in (None, 0, ctypes.c_void_p(-1).value):
            raise _NativeRefused()
        return int(value)

    def startup(self):
        size = ctypes.c_size_t()
        ok = self.InitializeProcThreadAttributeList(None, 1, 0, ctypes.byref(size))
        self._require(not ok and ctypes.get_last_error() == 122 and 0 < size.value <= 65536)
        self.attributes = ctypes.create_string_buffer(size.value)
        self._require(self.InitializeProcThreadAttributeList(self.attributes, 1, 0, ctypes.byref(size)))
        self.attributes_ready = True
        handles = [ch['child'] for ch in self.channels.values()]
        self.handle_list = (_PTR * 3)(*handles)
        for handle in handles:
            self._require(self.SetHandleInformation(handle, 1, 1))
        self._require(self.UpdateProcThreadAttribute(self.attributes, 0, 0x20002,
            self.handle_list, ctypes.sizeof(self.handle_list), None, None))
        startup = _StartupEx()
        startup.StartupInfo.cb = ctypes.sizeof(startup)
        startup.StartupInfo.dwFlags = 0x100  # STARTF_USESTDHANDLES.
        startup.StartupInfo.hStdInput, startup.StartupInfo.hStdOutput, startup.StartupInfo.hStdError = handles
        startup.lpAttributeList = ctypes.addressof(self.attributes)
        return startup

    def _close(self, ch, name):
        if ch[name] is not None:
            self._require(self.CloseHandle(ch[name]))
            ch[name] = None

    def transferred(self):
        # Close parent copies before resume, so EOF is tied to actual child handles.
        for ch in self.channels.values():
            if ch['child'] is not None:
                self._require(self.SetHandleInformation(ch['child'], 1, 0))
                self._close(ch, 'child')
        if self.attributes_ready:
            self.DeleteProcThreadAttributeList(self.attributes)
            self.attributes_ready = False
        self.attributes = self.handle_list = None

    def _accept(self, name, data):
        if self.counts[name] + len(data) > getattr(self.spec, name + '_limit'):
            raise _OutputLimit()
        self.counts[name] += len(data)
        self.buffers[name].extend(data)

    def _complete(self, name, ch, count, error):
        ch['pending'] = False  # Native completion observed; buffer can now be reused.
        if self.stopping:
            ch['buffer'] = None
            return
        if error:
            if name != 'stdin' and error == 109:  # ERROR_BROKEN_PIPE = reader EOF.
                ch['eof'] = True
                ch['buffer'] = None
                return
            raise _NativeRefused()
        self._require(ch['buffer'] is not None and 0 <= count <= len(ch['buffer']))
        if name == 'stdin':
            self._require(count > 0)
            self.sent += count
        else:
            # A successful zero-byte read is not a broken pipe/EOF certificate.
            if count:
                self._accept(name, ch['buffer'].raw[:count])
        ch['buffer'] = None

    def _observe(self, name, ch):
        count = _U32()
        ok = self.GetOverlappedResult(ch['parent'], ctypes.byref(ch['overlap']), ctypes.byref(count), False)
        error = 0 if ok else ctypes.get_last_error()
        if error == 996:  # ERROR_IO_INCOMPLETE; retain all buffers/OVERLAPPED.
            return False
        # A failed query (e.g. invalid handle) is NOT proof that IO completed.
        self._require(error in (0, 109, 995))
        self._complete(name, ch, count.value, error)
        return True

    def pump(self):
        self._require(not self.stopping)
        for name, ch in self.channels.items():
            if ch['pending']:
                self._observe(name, ch)
                continue  # At most one completion/submission per stream per checkpoint.
            if ch['eof']:
                continue
            if name == 'stdin' and self.sent == len(self.spec.stdin):
                self._close(ch, 'parent')  # EOF, never FlushFileBuffers (could block).
                ch['eof'] = True
                continue
            size = min(16384, len(self.spec.stdin) - self.sent) if name == 'stdin' else min(
                16384, getattr(self.spec, name + '_limit') - self.counts[name] + 1)
            ch['buffer'] = (ctypes.create_string_buffer(self.spec.stdin[self.sent:self.sent + size], size)
                            if name == 'stdin' else ctypes.create_string_buffer(size))
            ch['overlap'] = _Overlapped(hEvent=ch['event'])
            ch['pending'] = True  # Preserve storage even if a Python interruption crosses the call.
            fn = self.WriteFile if name == 'stdin' else self.ReadFile
            ok = fn(ch['parent'], ch['buffer'], size, None, ctypes.byref(ch['overlap']))
            error = 0 if ok else ctypes.get_last_error()
            if ok:
                self._observe(name, ch)  # Async counts come only from GetOverlappedResult.
            elif error != 997:  # ERROR_IO_PENDING.
                self._complete(name, ch, 0, error)

    @property
    def done(self):
        return not self.stopping and all(ch['eof'] for ch in self.channels.values())

    def take(self):
        result = JobOutput(bytes(self.buffers['stdout']), bytes(self.buffers['stderr']),
            self.channels['stdin']['eof'], self.channels['stdout']['eof'], self.channels['stderr']['eof'])
        self.buffers['stdout'].clear()
        self.buffers['stderr'].clear()
        return result

    def close(self, until):
        self.stopping = True
        # No storage/handle freed until every in-flight call is known completed.
        for ch in self.channels.values():
            if ch['pending']:
                ok = self.CancelIoEx(ch['parent'], ctypes.byref(ch['overlap']))
                self._require(ok or ctypes.get_last_error() == 1168)  # Already completed is a race, not proof.
        while any(ch['pending'] for ch in self.channels.values()):
            for name, ch in self.channels.items():
                if ch['pending']:
                    self._observe(name, ch)
            if not any(ch['pending'] for ch in self.channels.values()):
                break
            if time.monotonic() >= until:
                return False
            time.sleep(.01)
        if self.attributes_ready:
            self.DeleteProcThreadAttributeList(self.attributes)
            self.attributes_ready = False
        self.attributes = self.handle_list = None
        for ch in self.channels.values():
            for name in ('child', 'parent', 'event'):
                self._close(ch, name)
        return True


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

    def create_process_io(self, executable, command, cwd, environment, startup):
        info = _ProcessInfo()
        mutable, block = ctypes.create_unicode_buffer(command), ctypes.create_unicode_buffer(environment)
        # Extended startup is the ONLY opt-in inheritance path, with exactly 3 handles.
        if not self._create(executable, mutable, None, None, True, 0x08080404,
                block, cwd, ctypes.cast(ctypes.byref(startup), ctypes.POINTER(_Startup)), ctypes.byref(info)):
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
    io_complete: bool | None = None


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
    def __init__(self, *, executable, arguments, cwd, environment, deadline_monotonic, io=None):
        failed = False
        try:
            if io is not None and type(io) is not JobIO:
                raise ValueError()
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
        self._io_spec, self._io = io, None
        self._io_failed = False

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
            startup = None
            if self._io_spec is not None:
                self._io = _PipeIO(self._io_spec)  # Attach BEFORE acquiring any handles.
                self._io.open()
                startup = self._io.startup()
                self._checkpoint()
            self._creating = True
            try:
                args = (self._executable, self._command, self._cwd, self._environment)
                self._process, self._thread, pid = (self._api.create_process(*args) if startup is None
                    else self._api.create_process_io(*args, startup))
            except _CreateRefused:
                self._creating = False  # Native FALSE proves no returned process.
                raise
            self._creating, self._created = False, True
            if any(type(value) is not int or value <= 0 for value in (self._process, self._thread, pid)):
                raise _NativeRefused()
            if self._io is not None:
                self._io.transferred()
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
            if self._io is not None:
                self._io.pump()
            active = self._active()
            finished = self._finished()
            if active == 0 and not finished:
                raise _NativeRefused()
            code = self._api.exit_code(self._process) if finished else None
            if code is not None and (type(code) is not int or not 0 <= code < 2**32):
                raise _NativeRefused()
            expired = time.monotonic() >= self._deadline
        except _OutputLimit:
            self._io_failed = True
            self.cleanup()
            failed = 'job_output_limit'
        except Exception:
            failed = 'job_observation_refused'
            if self._io is not None:
                self._io_failed = True
                self.cleanup()
        except BaseException:
            if self._io is not None:
                self._io_failed = True
                self.cleanup()
            raise
        if failed:
            if self._phase != 'closed':
                self._phase = 'hold'
            raise JobError(failed)
        if expired:
            self.cleanup()
            raise JobError('job_deadline_expired')
        io_complete = None if self._io is None else (self._io.done and not self._io_failed)
        if active == 0 and io_complete is not False:
            self._phase = 'finished'
        return JobState(active, finished, code, self._forced, io_complete)

    def take_output(self):
        self._require_owner()
        if self._io is None:
            raise JobError('job_state_refused')
        return self._io.take()

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
            if self._io is not None:
                if not self._io.done:
                    self._io_failed = True
                if self._io.close(until) is not True:
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
