# Copyright (c) 2026 Memlia. All rights reserved.
"""Portable lifecycle/ABI tests with a named fake kernel, never Windows jobs."""
import ctypes
import importlib.util
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch


class _FakeKernel:
    """Only handles/counts are fictional; no processes or consent are created."""
    def __init__(self):
        self.calls = []
        self.failures = set()
        self.flags = 0x2000
        self.active = 1
        self.root_done = False
        self.assigned = False
        self.resume_count = 1
        self.free = 64 * 1024**3
        self.exit = 0
        self.environment = None

    def call(self, name, *values):
        self.calls.append((name, *values))
        if name in self.failures:
            raise OSError('PRIVATE_NATIVE_CANARY')

    def free_bytes(self, cwd):
        self.call('disk', cwd)
        return self.free

    def create_job(self):
        self.call('create_job')
        self.active = 0
        return 11

    def set_limits(self, job):
        self.call('set_limits', job)

    def limits(self, job):
        self.call('limits', job)
        return self.flags

    def create_process(self, executable, command, cwd, environment):
        self.call('create_process', executable, command, cwd)
        self.environment = environment
        return 12, 13, 77

    def assign(self, job, process):
        self.call('assign', job, process)
        self.assigned, self.active = True, 1

    def contains(self, process, job):
        self.call('contains', process, job)
        return self.assigned

    def creation_time(self, process):
        self.call('creation_time', process)
        return 123456

    def resume(self, thread):
        self.call('resume', thread)
        return self.resume_count

    def active_processes(self, job):
        self.call('active', job)
        return self.active

    def wait(self, process, milliseconds):
        self.call('wait', process, milliseconds)
        return 0 if self.root_done else 258

    def exit_code(self, process):
        self.call('exit_code', process)
        return self.exit

    def terminate_process(self, process):
        self.call('terminate_process', process)
        self.root_done = True

    def terminate_job(self, job):
        self.call('terminate_job', job)
        self.active, self.root_done = 0, True

    def close(self, handle):
        self.call('close_' + str(handle), handle)


class OwnedJobTests(unittest.TestCase):
    def module(self):
        self.assertIsNotNone(importlib.util.find_spec('memlia_agent.owned_job'),
                             'the owned Job port is missing')
        return __import__('memlia_agent.owned_job', fromlist=['OwnedJob'])

    def request(self, **replace):
        values = dict(executable=r'C:\Memlia\python.exe', arguments=('-I', '-B', 'worker.py'),
                      cwd=r'C:\Memlia\owned-run', environment={'SystemRoot': r'C:\Windows'},
                      deadline_monotonic=time.monotonic() + 30)
        values.update(replace)
        return values

    def make(self):
        module, native = self.module(), _FakeKernel()
        job = module.OwnedJob(**self.request())
        return module, native, job

    def fixed(self, module, operation, code):
        with self.assertRaises(module.JobError) as caught:
            operation()
        self.assertEqual(caught.exception.code, code)
        self.assertEqual(str(caught.exception), code)
        self.assertIsNone(caught.exception.__cause__)
        self.assertIsNone(caught.exception.__context__)

    def test_constructor_captures_input_without_kernel_io_and_rejects_invalid_values(self):
        module = self.module()
        invalid = [dict(executable='python.exe'), dict(executable=r'\\server\share\python.exe'),
                   dict(arguments=['worker.py']), dict(arguments=('bad\0argument',)),
                   dict(environment={'SystemRoot': r'C:\Windows', 'SYSTEMROOT': r'C:\Other'}),
                   dict(environment={'SystemRoot': r'C:\Windows', 'A=B': 'bad'}),
                   dict(environment={}), dict(deadline_monotonic=True),
                   dict(deadline_monotonic=float('inf')), dict(deadline_monotonic=time.monotonic()-1)]
        with patch.object(module, '_Kernel') as kernel:
            for value in invalid:
                self.fixed(module, lambda: module.OwnedJob(**self.request(**value)), 'invalid_job_request')
            job = module.OwnedJob(**self.request())
            self.assertIsNotNone(job)
            kernel.assert_not_called()

    def test_environment_is_owned_before_native_preparation_without_ambient_fallback(self):
        module, native = self.module(), _FakeKernel()
        environment = {'SystemRoot': r'C:\Windows', 'ORT_DISABLE_TELEMETRY': '1'}
        job = module.OwnedJob(**self.request(environment=environment))
        environment.clear()
        with patch.object(module, '_Kernel', return_value=native):
            job.start()
            self.assertIn('SystemRoot=C:\\Windows\0', native.environment)
            self.assertIn('ORT_DISABLE_TELEMETRY=1\0', native.environment)
            self.assertTrue(native.environment.endswith('\0\0'))
            self.assertTrue(job.cleanup())

    def test_suspend_assign_membership_and_identity_precede_the_only_resume(self):
        module, native, job = self.make()
        with patch.object(module, '_Kernel', return_value=native):
            job.start()
            names = [entry[0] for entry in native.calls]
            self.assertLess(names.index('create_process'), names.index('assign'))
            self.assertLess(names.index('assign'), names.index('contains'))
            self.assertLess(names.index('creation_time'), names.index('resume'))
            self.assertEqual(names.count('resume'), 1)
            self.assertEqual(job.root_identity, (77, 123456))
            self.assertTrue(job.cleanup())

    def test_assignment_failure_terminates_and_waits_only_the_owned_suspended_handle(self):
        module, native, job = self.make()
        native.failures.add('assign')
        with patch.object(module, '_Kernel', return_value=native):
            self.fixed(module, job.start, 'job_start_refused')
        names = [entry[0] for entry in native.calls]
        self.assertNotIn('resume', names)
        self.assertIn(('terminate_process', 12), native.calls)
        self.assertIn(('wait', 12, 0), native.calls)
        self.assertTrue(job.cleanup())

    def test_resume_zero_failed_or_still_suspended_refuses_and_cleans_job(self):
        for count in (0, 2, 0xFFFFFFFF):
            module, native, job = self.make()
            native.resume_count = count
            with patch.object(module, '_Kernel', return_value=native):
                self.fixed(module, job.start, 'job_start_refused')
            self.assertIn(('terminate_job', 11), native.calls)
            self.assertTrue(job.cleanup())

    def test_root_exit_is_not_job_completion_while_a_child_remains(self):
        module, native, job = self.make()
        with patch.object(module, '_Kernel', return_value=native):
            job.start()
            native.root_done = True
            state = job.poll()
            self.assertTrue(state.root_finished)
            self.assertEqual(state.active_processes, 1)
            self.assertEqual(state.root_exit_code, 0)
            self.assertFalse(state.forced)
            self.assertTrue(job.cleanup())

    def test_normal_terminal_result_and_close_are_exact_and_idempotent(self):
        module, native, job = self.make()
        with patch.object(module, '_Kernel', return_value=native):
            job.start()
            native.active, native.root_done = 0, True
            state = job.poll()
            self.assertEqual((state.active_processes, state.root_finished, state.root_exit_code,
                              state.forced), (0, True, 0, False))
            self.assertTrue(job.cleanup())
            calls = list(native.calls)
            self.assertTrue(job.cleanup())
            self.assertEqual(native.calls, calls)
            self.assertEqual([x[0] for x in calls if x[0].startswith('close_')],
                             ['close_13', 'close_12', 'close_11'])
            self.fixed(module, job.start, 'job_state_refused')

    def test_unknown_accounting_retains_all_handles_until_explicit_reconciliation(self):
        module, native, job = self.make()
        with patch.object(module, '_Kernel', return_value=native):
            job.start()
            native.failures.add('active')
            self.fixed(module, job.poll, 'job_observation_refused')
            self.assertFalse(job.cleanup())
            self.assertFalse(any(x[0].startswith('close_') for x in native.calls))
            native.failures.clear()
            self.assertTrue(job.cleanup())

    def test_close_failure_retains_remaining_handles_and_never_double_closes(self):
        module, native, job = self.make()
        with patch.object(module, '_Kernel', return_value=native):
            job.start()
            native.active, native.root_done = 0, True
            native.failures.add('close_12')
            self.assertFalse(job.cleanup())
            self.assertNotIn(('close_11', 11), native.calls)
            native.failures.clear()
            self.assertTrue(job.cleanup())
            self.assertEqual(native.calls.count(('close_13', 13)), 1)

    def test_deadline_refuses_delivery_and_terminates_owned_job_without_retry(self):
        module, native, job = self.make()
        with patch.object(module, '_Kernel', return_value=native):
            job.start()
            with patch.object(module.time, 'monotonic', return_value=job._deadline+1):
                self.fixed(module, job.poll, 'job_deadline_expired')
            self.assertIn(('terminate_job', 11), native.calls)
            self.assertTrue(job.cleanup())

    def test_disk_measurement_failure_does_not_prevent_known_native_cleanup(self):
        module, native, job = self.make()
        with patch.object(module, '_Kernel', return_value=native):
            job.start()
            native.failures.add('disk')
            self.fixed(module, job.poll, 'job_observation_refused')
            self.assertTrue(job.cleanup())

    def test_foreign_thread_never_queries_or_closes_the_owner_handles(self):
        module, native, job = self.make()
        codes = []
        with patch.object(module, '_Kernel', return_value=native):
            job.start()
            before = list(native.calls)
            def foreign():
                try:
                    job.cleanup()
                except module.JobError as error:
                    codes.append(error.code)
            thread = threading.Thread(target=foreign)
            thread.start()
            thread.join(1)
            self.assertFalse(thread.is_alive())
            self.assertEqual(codes, ['job_owner_mismatch'])
            self.assertEqual(before, native.calls)
            self.assertTrue(job.cleanup())

    def test_limit_drift_refuses_before_process_creation_and_disk_floor_is_40gib(self):
        for drift in ('flags', 'disk'):
            module, native, job = self.make()
            if drift == 'flags':
                native.flags |= 0x800
            else:
                native.free = 40 * 1024**3 - 1
            with patch.object(module, '_Kernel', return_value=native):
                self.fixed(module, job.start, 'job_start_refused')
            self.assertNotIn('create_process', [x[0] for x in native.calls])
            self.assertTrue(job.cleanup())

    def test_win64_layouts_are_explicit_and_do_not_use_mac_long_width(self):
        module = self.module()
        self.assertEqual(ctypes.sizeof(ctypes.c_void_p), 8)
        for name, size in (('_BasicLimits', 64), ('_IoCounters', 48), ('_ExtendedLimits', 144),
                           ('_Accounting', 48), ('_Startup', 104), ('_ProcessInfo', 24)):
            self.assertEqual(ctypes.sizeof(getattr(module, name)), size, name)
        self.assertEqual(module._BasicLimits.LimitFlags.offset, 16)
        self.assertEqual(module._BasicLimits.Affinity.offset, 48)
        self.assertEqual(module._Accounting.ActiveProcesses.offset, 40)
        self.assertEqual(module._Startup.hStdInput.offset, 80)
        self.assertEqual(module._ProcessInfo.dwProcessId.offset, 16)

    def test_malformed_accounting_never_closes_an_unknown_job(self):
        for value in (False, None, -1, 2**32):
            module, native, job = self.make()
            with patch.object(module, '_Kernel', return_value=native):
                job.start()
                native.active, native.root_done = value, True
                self.assertFalse(job.cleanup(), repr(value))
                self.assertFalse(any(x[0].startswith('close_') for x in native.calls))
                native.active = 0
                self.assertTrue(job.cleanup())

    def test_unknown_wait_never_proves_a_live_or_terminal_process(self):
        module, native, job = self.make()
        with patch.object(module, '_Kernel', return_value=native):
            job.start()
            with patch.object(native, 'wait', return_value=0xFFFFFFFF):
                self.fixed(module, job.poll, 'job_observation_refused')
                self.assertFalse(job.cleanup())
            self.assertFalse(any(x[0].startswith('close_') for x in native.calls))
            self.assertTrue(job.cleanup())

    def test_non_numeric_disk_and_boolean_resume_refuse_before_delivery(self):
        for value in (float('nan'), True, None):
            module, native, job = self.make()
            native.free = value
            with patch.object(module, '_Kernel', return_value=native):
                self.fixed(module, job.start, 'job_start_refused')
                self.assertNotIn('create_process', [x[0] for x in native.calls])
        module, native, job = self.make()
        native.resume_count = True
        with patch.object(module, '_Kernel', return_value=native):
            self.fixed(module, job.start, 'job_start_refused')
            self.assertTrue(job.cleanup())

    def test_interrupt_preserves_control_flow_after_owned_cleanup(self):
        module, native, job = self.make()
        with patch.object(module, '_Kernel', return_value=native):
            with patch.object(native, 'resume', side_effect=KeyboardInterrupt):
                with self.assertRaises(KeyboardInterrupt):
                    job.start()
            self.assertIn(('terminate_job', 11), native.calls)
            self.assertTrue(job.cleanup())

    def test_ambiguous_create_holds_and_known_native_false_closes_only_empty_job(self):
        for ambiguous in (True, False):
            module, native, job = self.make()
            error = OSError('PRIVATE_CREATE_CANARY') if ambiguous else module._CreateRefused()
            with patch.object(module, '_Kernel', return_value=native):
                with patch.object(native, 'create_process', side_effect=error):
                    self.fixed(module, job.start, 'job_start_refused')
                self.assertEqual(job.cleanup(), not ambiguous)
            if ambiguous:
                self.assertFalse(any(x[0].startswith('close_') for x in native.calls))
            self.assertNotIn('resume', [x[0] for x in native.calls])

    def test_result_is_refused_if_observation_returns_after_deadline(self):
        module, native, job = self.make()
        with patch.object(module, '_Kernel', return_value=native):
            job.start()
            clock = [job._deadline - 1]
            def late_exit(process):
                clock[0] = job._deadline + 1
                return 0
            native.root_done, native.active = True, 0
            with patch.object(module.time, 'monotonic', side_effect=lambda: clock[0]):
                with patch.object(native, 'exit_code', side_effect=late_exit):
                    self.fixed(module, job.poll, 'job_deadline_expired')
            self.assertTrue(job.cleanup())

    def test_failures_at_each_owned_acquisition_never_resume_or_release_unknown_state(self):
        for stage in ('create_job', 'set_limits', 'limits', 'contains', 'creation_time', 'resume'):
            module, native, job = self.make()
            native.failures.add(stage)
            with patch.object(module, '_Kernel', return_value=native):
                self.fixed(module, job.start, 'job_start_refused')
                self.assertTrue(job.cleanup())
            names = [x[0] for x in native.calls]
            if stage != 'resume':
                self.assertNotIn('resume', names)
            self.assertLessEqual(names.count('create_process'), 1)

    def test_native_facade_uses_system32_explicit_abi_and_no_handle_inheritance(self):
        module = self.module()
        calls = []
        class Function:
            def __init__(self, name):
                self.name = name
            def __call__(self, *args):
                calls.append((self.name, args))
                if self.name == 'CreateJobObjectW':
                    return 11
                if self.name == 'CreateProcessW':
                    info = ctypes.cast(args[9], ctypes.POINTER(module._ProcessInfo)).contents
                    info.hProcess, info.hThread, info.dwProcessId = 12, 13, 77
                    return 1
                return 1
        names = ('CreateJobObjectW', 'SetInformationJobObject', 'QueryInformationJobObject',
                 'CreateProcessW', 'AssignProcessToJobObject', 'IsProcessInJob', 'ResumeThread',
                 'TerminateJobObject', 'TerminateProcess', 'WaitForSingleObject',
                 'GetExitCodeProcess', 'GetProcessTimes', 'CloseHandle')
        dll = SimpleNamespace(**{name: Function(name) for name in names})
        with patch.object(module.sys, 'platform', 'win32'):
            with patch.object(module.ctypes, 'WinDLL', return_value=dll, create=True) as load:
                native = module._Kernel()
        load.assert_called_once_with('kernel32', use_last_error=True, winmode=0x800)
        self.assertEqual(native.create_job(), 11)
        self.assertEqual(calls[-1], ('CreateJobObjectW', (None, None)))
        result = native.create_process(r'C:\Memlia\python.exe', 'python.exe -I worker.py',
                                       r'C:\Memlia\run', 'SystemRoot=C:\\Windows\0\0')
        self.assertEqual(result, (12, 13, 77))
        args = calls[-1][1]
        self.assertEqual(args[0], r'C:\Memlia\python.exe')
        self.assertIsInstance(args[1], ctypes.Array)
        self.assertEqual(args[1].value, 'python.exe -I worker.py')
        self.assertEqual(args[2:6], (None, None, False, 0x08000404))
        self.assertEqual(''.join(args[6])[:-1], 'SystemRoot=C:\\Windows\0\0')
        startup = ctypes.cast(args[8], ctypes.POINTER(module._Startup)).contents
        self.assertEqual(startup.cb, 104)
        self.assertEqual((startup.dwFlags, startup.hStdInput, startup.hStdOutput,
                          startup.hStdError), (0, None, None, None))
        self.assertEqual(dll.CreateProcessW.argtypes[4], ctypes.c_int32)
        self.assertEqual(dll.ResumeThread.restype, ctypes.c_uint32)
        self.assertEqual(dll.GetProcessTimes.argtypes, [ctypes.c_void_p] +
                         [ctypes.POINTER(module._FileTime)] * 4)

    def test_native_query_lengths_failed_wait_and_false_create_remain_refused(self):
        module = self.module()
        native = object.__new__(module._Kernel)
        for length in (0, 47, 49):
            def query(job, kind, info, size, returned):
                ctypes.cast(returned, ctypes.POINTER(module._U32)).contents.value = length
                return 1
            native._query = query
            with self.assertRaises(module._NativeRefused):
                native.active_processes(11)
        for wait in (0xFFFFFFFF, 1):
            native._wait = lambda *args: wait
            with self.assertRaises(module._NativeRefused):
                native.wait(12, 0)
        native._create = lambda *args: 0
        with self.assertRaises(module._CreateRefused):
            native.create_process(r'C:\Memlia\python.exe', 'python.exe', r'C:\Memlia',
                                  'SystemRoot=C:\\Windows\0\0')

    def test_assignment_refusal_with_failed_termination_retains_handles_without_resume(self):
        module, native, job = self.make()
        native.failures.update(('assign', 'terminate_process'))
        with patch.object(module, '_Kernel', return_value=native):
            self.fixed(module, job.start, 'job_start_refused')
            self.assertFalse(job.cleanup())
            self.assertNotIn('resume', [x[0] for x in native.calls])
            self.assertFalse(any(x[0].startswith('close_') for x in native.calls))
            native.failures.clear()
            self.assertTrue(job.cleanup())

    def test_request_caps_and_unsafe_paths_refuse_without_creating_any_kernel(self):
        module = self.module()
        values = [dict(executable=r'C:\run\python.exe:other'),
                  dict(cwd=r'C:\run\..\other'), dict(arguments=('x',) * 65),
                  dict(arguments=('x' * 4097,)), dict(arguments=('x' * 4096,) * 8),
                  dict(arguments=('\ud800',)),
                  dict(environment={'SystemRoot': r'C:\Windows', 'A': 'x' * 4097}),
                  dict(environment={'SystemRoot': r'C:\Windows', 'A': 'x' * 4096,
                                    'B': 'x' * 4096, 'C': 'x' * 4096}),
                  dict(deadline_monotonic=time.monotonic() + 1801)]
        with patch.object(module, '_Kernel') as kernel:
            for value in values:
                self.fixed(module, lambda: module.OwnedJob(**self.request(**value)),
                           'invalid_job_request')
            kernel.assert_not_called()

    def test_all_win64_structure_offsets_match_the_declared_native_layout(self):
        module = self.module()
        layouts = {
            '_BasicLimits': (('PerProcessUserTimeLimit', 0), ('PerJobUserTimeLimit', 8),
                ('LimitFlags', 16), ('MinimumWorkingSetSize', 24), ('MaximumWorkingSetSize', 32),
                ('ActiveProcessLimit', 40), ('Affinity', 48), ('PriorityClass', 56),
                ('SchedulingClass', 60)),
            '_IoCounters': (('ReadOperationCount', 0), ('WriteOperationCount', 8),
                ('OtherOperationCount', 16), ('ReadTransferCount', 24),
                ('WriteTransferCount', 32), ('OtherTransferCount', 40)),
            '_ExtendedLimits': (('BasicLimitInformation', 0), ('IoInfo', 64),
                ('ProcessMemoryLimit', 112), ('JobMemoryLimit', 120),
                ('PeakProcessMemoryUsed', 128), ('PeakJobMemoryUsed', 136)),
            '_Accounting': (('TotalUserTime', 0), ('TotalKernelTime', 8),
                ('ThisPeriodTotalUserTime', 16), ('ThisPeriodTotalKernelTime', 24),
                ('TotalPageFaultCount', 32), ('TotalProcesses', 36), ('ActiveProcesses', 40),
                ('TotalTerminatedProcesses', 44)),
            '_Startup': (('cb', 0), ('lpReserved', 8), ('lpDesktop', 16), ('lpTitle', 24),
                ('dwX', 32), ('dwY', 36), ('dwXSize', 40), ('dwYSize', 44), ('dwXCountChars', 48),
                ('dwYCountChars', 52), ('dwFillAttribute', 56), ('dwFlags', 60), ('wShowWindow', 64),
                ('cbReserved2', 66), ('lpReserved2', 72), ('hStdInput', 80), ('hStdOutput', 88),
                ('hStdError', 96)),
            '_ProcessInfo': (('hProcess', 0), ('hThread', 8), ('dwProcessId', 16), ('dwThreadId', 20)),
            '_FileTime': (('low', 0), ('high', 4)),
        }
        for name, fields in layouts.items():
            for field, offset in fields:
                self.assertEqual(getattr(getattr(module, name), field).offset, offset,
                                 (name, field))

    def test_native_facade_refuses_non_windows_before_loading_any_library(self):
        module = self.module()
        with patch.object(module.sys, 'platform', 'darwin'):
            with patch.object(module.ctypes, 'WinDLL', create=True) as load:
                with self.assertRaises(module._NativeRefused):
                    module._Kernel()
                load.assert_not_called()




class BoundedIOTests(unittest.TestCase):
    module = OwnedJobTests.module
    request = OwnedJobTests.request
    """IO lifecycle is simulated; no Win32 pipe has been opened on this host."""
    def test_io_configuration_is_finite_and_never_prints_input(self):
        m = self.module()
        for kwargs in ({'stdin': bytearray(b'x')}, {'stdin': b'x' * (262144 + 1)},
                       {'stdout_limit': True}, {'stderr_limit': 0}, {'stdout_limit': 1048577}):
            with self.subTest(kwargs=tuple(kwargs)):
                with self.assertRaises(m.JobError):
                    m.JobIO(**kwargs)
        spec = m.JobIO(stdin=b'PRIVATE_INPUT', stdout_limit=20, stderr_limit=20)
        self.assertNotIn('PRIVATE_INPUT', repr(spec))
        with patch.object(m, '_Kernel') as kernel:
            job = m.OwnedJob(**self.request(io=spec))
            self.assertIsNotNone(job)
            kernel.assert_not_called()

    def test_real_io_state_machine_caps_cumulative_even_after_drain(self):
        m = self.module()
        io = m._PipeIO(m.JobIO(stdin=b'', stdout_limit=3, stderr_limit=3))
        io._accept('stdout', b'ab')
        self.assertEqual(io.take().stdout, b'ab')
        io._accept('stdout', b'c')
        with self.assertRaises(m._OutputLimit):
            io._accept('stdout', b'd')
        self.assertEqual(io.take().stdout, b'c')
        self.assertEqual(io.counts['stdout'], 3)

    def test_io_requires_drain_not_only_zero_exit_and_cleanup_cancels(self):
        m, native = self.module(), _FakeKernel()
        class Pipes:
            done = False
            def open(self): native.call('io_open')
            def startup(self): native.call('io_startup'); return object()
            def transferred(self): native.call('io_transferred')
            def pump(self): native.call('io_pump')
            def close(self, until): native.call('io_close'); return True
            def take(self): return m.JobOutput(b'', b'', False, False, False)
        pipes = Pipes()
        def create(*args):
            native.call('create_io_process')
            return 12, 13, 77
        native.create_process_io = create
        with patch.object(m, '_Kernel', return_value=native), patch.object(m, '_PipeIO', return_value=pipes):
            job = m.OwnedJob(**self.request(io=m.JobIO(stdin=b'x')))
            job.start()
            names = [x[0] for x in native.calls]
            self.assertLess(names.index('io_transferred'), names.index('resume'))
            self.assertLess(names.index('assign'), names.index('resume'))
            native.active, native.root_done = 0, True
            self.assertFalse(job.poll().io_complete)
            pipes.done = True
            self.assertTrue(job.poll().io_complete)
            self.assertTrue(job.cleanup())
            self.assertEqual(sum(x[0] == 'io_close' for x in native.calls), 1)

    def test_overflow_interrupt_and_cancel_failure_never_become_complete(self):
        m = self.module()
        for error in (m._OutputLimit(), OSError('PRIVATE'), KeyboardInterrupt()):
            native = _FakeKernel()
            class Pipes:
                done = False
                def open(self): pass
                def startup(self): return object()
                def transferred(self): pass
                def pump(self): raise error
                def close(self, until): return False
            native.create_process_io = lambda *args: (12, 13, 77)
            with patch.object(m, '_Kernel', return_value=native), patch.object(m, '_PipeIO', return_value=Pipes()):
                job = m.OwnedJob(**self.request(io=m.JobIO()))
                job.start()
                with self.assertRaises(KeyboardInterrupt if isinstance(error, KeyboardInterrupt) else m.JobError):
                    job.poll()
                self.assertFalse(job.cleanup())
                self.assertEqual(job._phase, 'hold')
                self.assertNotIn(('close_11', 11), native.calls)


class PipeABITests(unittest.TestCase):
    """Real ctypes facade/state machine against a deterministic fake DLL only."""
    module = OwnedJobTests.module

    def fixture(self, **spec):
        m = self.module()
        calls, error, handles = [], [0], [100]
        def fn(name, body):
            def call(*args):
                calls.append((name, args))
                return body(*args)
            return call
        def handle(*args):
            handles[0] += 1
            return handles[0]
        def fail(code):
            error[0] = code
            return 0
        def initialize(address, count, flags, size):
            if address is None:
                ctypes.cast(size, ctypes.POINTER(ctypes.c_size_t)).contents.value = 128
                return fail(122)
            return 1
        def client(handle, pid):
            ctypes.cast(pid, ctypes.POINTER(m._U32)).contents.value = m.os.getpid()
            return 1
        bodies = dict(CreateNamedPipeW=handle, CreateFileW=handle, CreateEventW=handle,
            ConnectNamedPipe=lambda *a: fail(535), GetNamedPipeClientProcessId=client,
            SetHandleInformation=lambda *a: 1, InitializeProcThreadAttributeList=initialize,
            UpdateProcThreadAttribute=lambda *a: 1, DeleteProcThreadAttributeList=lambda *a: None,
            ReadFile=lambda *a: fail(997), WriteFile=lambda *a: fail(997),
            GetOverlappedResult=lambda *a: fail(996), CancelIoEx=lambda *a: 1,
            CloseHandle=lambda *a: 1)
        dll = SimpleNamespace(**{name: fn(name, body) for name, body in bodies.items()})
        io = m._PipeIO(m.JobIO(**spec))
        return m, io, dll, calls, error

    def completed_result(self, m):
        def result(handle, ov, count, wait):
            self.assertIs(wait, False)
            ctypes.cast(count, ctypes.POINTER(m._U32)).contents.value = ctypes.cast(
                ov, ctypes.POINTER(m._Overlapped)).contents.InternalHigh
            return 1
        return result

    def native(self, m, dll, error):
        from contextlib import ExitStack
        stack = ExitStack()
        stack.enter_context(patch.object(m.ctypes, 'WinDLL', return_value=dll, create=True))
        stack.enter_context(patch.object(m.ctypes, 'get_last_error', side_effect=lambda: error[0], create=True))
        return stack

    def test_three_local_pipes_and_exact_handle_list_with_extended_startup(self):
        m, io, dll, calls, error = self.fixture(stdin=b'\x00x')
        with self.native(m, dll, error):
            io.open()
            startup = io.startup()
            creates = [args for name, args in calls if name == 'CreateNamedPipeW']
            self.assertEqual(len({a[0] for a in creates}), 3)
            for args, access in zip(creates, (2, 1, 1)):
                self.assertTrue(args[0].startswith('\\\\.\\pipe\\MemliaJobIO-'))
                self.assertEqual(args[1:], (0x40080000 | access, 8, 1, 16384, 16384, 0, None))
            for name, args in calls:
                if name == 'CreateFileW':
                    self.assertIsNone(args[3])  # Initially non-inheritable.
                    self.assertEqual(args[4:], (3, 0, None))
            update = next(args for name, args in calls if name == 'UpdateProcThreadAttribute')
            self.assertEqual((update[1], update[2], update[4]), (0, 0x20002, 24))
            inherited = list(update[3])
            self.assertEqual(inherited, [c['child'] for c in io.channels.values()])
            self.assertTrue(set(inherited).isdisjoint({c['parent'] for c in io.channels.values()}))
            self.assertTrue(set(inherited).isdisjoint({c['event'] for c in io.channels.values()}))
            self.assertEqual(ctypes.sizeof(m._StartupEx), 112)
            self.assertEqual(m._StartupEx.lpAttributeList.offset, 104)
            self.assertEqual(ctypes.sizeof(m._Overlapped), 32)
            self.assertEqual(m._Overlapped.hEvent.offset, 24)
            self.assertEqual(startup.StartupInfo.cb, 112)
            self.assertEqual(startup.StartupInfo.dwFlags, 0x100)
            kernel = object.__new__(m._Kernel)
            create_args = []
            def create(*args):
                create_args.append(args)
                info = ctypes.cast(args[-1], ctypes.POINTER(m._ProcessInfo)).contents
                info.hProcess, info.hThread, info.dwProcessId = 900, 901, 902
                return 1
            kernel._create = create
            self.assertEqual(kernel.create_process_io('exe', 'command', 'cwd', 'env\0\0', startup),
                             (900, 901, 902))
            self.assertEqual(create_args[0][4:6], (True, 0x08080404))
            actual = ctypes.cast(create_args[0][-2], ctypes.POINTER(m._StartupEx)).contents
            self.assertEqual(actual.lpAttributeList, ctypes.addressof(io.attributes))
            io.transferred()
            self.assertEqual([a[0] for n, a in calls if n == 'CloseHandle'], inherited)
            self.assertTrue(io.close(time.monotonic() + 1))

    def test_pending_buffers_survive_cancel_request_until_observed_completion(self):
        m, io, dll, calls, error = self.fixture(stdin=b'private')
        with self.native(m, dll, error):
            io.open(); io.startup(); io.transferred(); io.pump()
            buffers = [c['buffer'] for c in io.channels.values()]
            overlaps = [c['overlap'] for c in io.channels.values()]
            close_before = sum(n == 'CloseHandle' for n, a in calls)
            self.assertFalse(io.close(time.monotonic() - 1))
            self.assertEqual(sum(n == 'CloseHandle' for n, a in calls), close_before)
            self.assertTrue(all(c['pending'] for c in io.channels.values()))
            self.assertEqual([c['buffer'] for c in io.channels.values()], buffers)
            self.assertEqual([c['overlap'] for c in io.channels.values()], overlaps)
            self.assertFalse(io.done)
            def aborted(*args): error[0] = 995; return 0
            io.GetOverlappedResult = aborted
            self.assertTrue(io.close(time.monotonic() + 1))
            self.assertTrue(all(c['parent'] is None and c['event'] is None for c in io.channels.values()))
            self.assertFalse(io.done)  # Cancellation is not complete transport.

    def test_query_failure_is_not_a_completion_and_cancel_not_found_is_not_proof(self):
        m, io, dll, calls, error = self.fixture(stdin=b'x')
        with self.native(m, dll, error):
            io.open(); io.transferred(); io.pump()
            buffer = io.channels['stdin']['buffer']
            def bad_query(*a): error[0] = 6; return 0
            def not_found(*a): error[0] = 1168; return 0
            io.GetOverlappedResult, io.CancelIoEx = bad_query, not_found
            with self.assertRaises(m._NativeRefused): io.close(time.monotonic() + 1)
            self.assertIs(io.channels['stdin']['buffer'], buffer)
            self.assertTrue(io.channels['stdin']['pending'])
            self.assertIsNotNone(io.channels['stdin']['parent'])

    def test_finite_stdin_partial_writes_binary_and_separate_incremental_streams(self):
        m, io, dll, calls, error = self.fixture(stdin=b'a\0bc', stdout_limit=3, stderr_limit=3)
        with self.native(m, dll, error):
            io.open(); io.transferred()
            written, queues = [], {}
            queues[io.channels['stdout']['parent']] = [b'a', b'bc', None]
            queues[io.channels['stderr']['parent']] = [b'err', None]
            def write(h, buf, n, out, ov):
                count = min(n, 2)
                written.append(bytes(buf.raw[:count]))
                self.assertIsNone(out)
                ctypes.cast(ov, ctypes.POINTER(m._Overlapped)).contents.InternalHigh = count
                return 1
            def read(h, buf, n, out, ov):
                data = queues[h].pop(0)
                if data is None: error[0] = 109; return 0
                self.assertLessEqual(len(data), n)
                ctypes.memmove(buf, data, len(data))
                self.assertIsNone(out)
                ctypes.cast(ov, ctypes.POINTER(m._Overlapped)).contents.InternalHigh = len(data)
                return 1
            io.WriteFile, io.ReadFile = write, read
            io.GetOverlappedResult = self.completed_result(m)
            io.pump()
            self.assertEqual((io.take().stdout, io.counts['stderr']), (b'a', 3))
            io.pump(); io.pump()
            self.assertEqual(b''.join(written), b'a\0bc')
            self.assertEqual(io.take().stdout, b'bc')
            self.assertTrue(io.done)
            self.assertIsNone(io.channels['stdin']['parent'])
            self.assertTrue(io.close(time.monotonic() + 1))

    def test_child_stdin_closed_early_is_not_a_delivered_request(self):
        m, io, dll, calls, error = self.fixture(stdin=b'private')
        with self.native(m, dll, error):
            io.open(); io.transferred()
            def broken(*a): error[0] = 109; return 0
            io.WriteFile = broken
            with self.assertRaises(m._NativeRefused): io.pump()
            self.assertEqual(io.sent, 0)
            self.assertFalse(io.done)
            self.assertTrue(io.close(time.monotonic() + 1))

    def test_partial_acquisition_foreign_client_and_close_failure_keep_exact_ownership(self):
        m, io, dll, calls, error = self.fixture()
        def foreign(handle, pid):
            ctypes.cast(pid, ctypes.POINTER(m._U32)).contents.value = m.os.getpid() + 1
            return 1
        dll.GetNamedPipeClientProcessId = foreign
        with self.native(m, dll, error):
            with self.assertRaises(m._NativeRefused): io.open()
            owned = [v for ch in io.channels.values() for k,v in ch.items() if k in ('parent','child','event') and v]
            original_close = io.CloseHandle
            io.CloseHandle = lambda h: 0
            with self.assertRaises(m._NativeRefused): io.close(time.monotonic()+1)
            self.assertEqual(io.channels['stdin']['child'], owned[1])
            io.CloseHandle = original_close
            self.assertTrue(io.close(time.monotonic()+1))
            self.assertEqual(sorted(a[0] for n,a in calls if n == 'CloseHandle'), sorted(owned))

    def test_zero_byte_read_does_not_fabricate_eof_before_later_output(self):
        m, io, dll, calls, error = self.fixture()
        with self.native(m, dll, error):
            io.open(); io.transferred()
            def zero(h, buf, n, count, ov):
                self.assertIsNone(count)
                ctypes.cast(ov, ctypes.POINTER(m._Overlapped)).contents.InternalHigh = 0
                return 1
            io.ReadFile = zero
            io.GetOverlappedResult = self.completed_result(m)
            io.pump()
            self.assertFalse(io.done)
            self.assertFalse(io.take().stdout_eof)
            def late(h, buf, n, count, ov):
                ctypes.memmove(buf, b'x', 1)
                self.assertIsNone(count)
                ctypes.cast(ov, ctypes.POINTER(m._Overlapped)).contents.InternalHigh = 1
                return 1
            io.ReadFile = late
            io.pump()
            self.assertEqual(io.take().stdout, b'x')
            self.assertTrue(io.close(time.monotonic() + 1))

    def test_io_deadline_closes_job_then_waits_for_targeted_io_cancellation(self):
        m, io, dll, calls, error = self.fixture(stdin=b'payload')
        native = _FakeKernel()
        native.create_process_io = lambda *a: (12, 13, 77)
        cancelled = set()
        def cancel(h, ov): cancelled.add(h); return 1
        def result(h, ov, count, wait):
            error[0] = 995 if h in cancelled else 996
            return 0
        dll.CancelIoEx, dll.GetOverlappedResult = cancel, result
        with self.native(m, dll, error), patch.object(m, '_Kernel', return_value=native):
            job = m.OwnedJob(**OwnedJobTests.request(self, io=io.spec))
            job.start(); job.poll()
            job._deadline = time.monotonic() - 1
            with self.assertRaises(m.JobError) as caught: job.poll()
            self.assertEqual(str(caught.exception), 'job_deadline_expired')
            self.assertEqual(job._phase, 'closed')
            self.assertTrue(job._io_failed)
            self.assertEqual(len(cancelled), 3)
            self.assertIn(('terminate_job', 11), native.calls)
            self.assertTrue(job.cleanup())

    def test_native_startup_failure_closes_only_acquired_io_and_never_creates_child(self):
        m, io, dll, calls, error = self.fixture()
        native = _FakeKernel()
        native.create_process_io = lambda *a: self.fail('process must not be created')
        dll.UpdateProcThreadAttribute = lambda *a: 0
        with self.native(m, dll, error), patch.object(m, '_Kernel', return_value=native):
            job = m.OwnedJob(**OwnedJobTests.request(self, io=io.spec))
            with self.assertRaises(m.JobError) as caught: job.start()
            self.assertEqual(str(caught.exception), 'job_start_refused')
            self.assertEqual(job._phase, 'closed')
            self.assertEqual(sum(n == 'CloseHandle' for n,a in calls), 9)
            self.assertFalse(any(c[0] == 'resume' for c in native.calls))


if __name__ == '__main__':
    unittest.main(verbosity=2)
