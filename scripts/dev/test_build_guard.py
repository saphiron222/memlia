# Copyright 2026 Memlia. All rights reserved.
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

spec = importlib.util.spec_from_file_location('build_guard', Path(__file__).with_name('build_guard.py'))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)

SCRIPT = Path(__file__).with_name('build_guard.py')


def lifecycle_cli(directory):
    """Real native process observations; only host-wide pressure/swap/free are doubled.

    A busy user's host must not decide whether the lifecycle test reaches its child.
    Real global observation and strict warning refusal have separate tests below.
    """
    wrapper = Path(directory) / 'lifecycle.py'
    wrapper.write_text(f"""import importlib.util
spec=importlib.util.spec_from_file_location('guard', {str(SCRIPT)!r})
g=importlib.util.module_from_spec(spec);spec.loader.exec_module(g)
def measure(pid):
 sample=g.mac_snapshot(pid)
 sample.update(pressureLevel=1,freePercent=70,swapBytes=0)
 return sample
g.run_guard.__kwdefaults__['measure']=measure
raise SystemExit(g.main())
""")
    return wrapper


class GuardCliTests(unittest.TestCase):
    def test_success_and_failure_are_reported_without_command_arguments(self):
        for code in (0, 3):
            with self.subTest(code=code), tempfile.TemporaryDirectory() as tmp:
                report = Path(tmp) / 'result.json'
                result = subprocess.run([sys.executable, str(lifecycle_cli(tmp)), '--report', str(report),
                                         '--', sys.executable, '-c', f'raise SystemExit({code})'],
                                        capture_output=True, text=True)
                self.assertEqual(code, result.returncode)
                receipt = json.loads(report.read_text())
                self.assertEqual('completed' if code == 0 else 'failed', receipt['status'])
                self.assertEqual(code, receipt['childExitCode'])
                self.assertNotIn('SystemExit', report.read_text())
                self.assertGreaterEqual(receipt['observations'], 1)

    def test_memory_budget_stops_only_the_owned_process_group(self):
        # A controller ignoring the measurement would run until the external timeout.
        other = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])
        try:
            with tempfile.TemporaryDirectory() as tmp:
                report = Path(tmp) / 'report.json'
                def measure(pid):
                    return {'footprintBytes': 8 * 1024**3 if pid else 0,
                            'swapBytes': 123, 'pressureLevel': 1, 'freePercent': 70}
                result = guard.run_guard(
                    [sys.executable, '-c', 'import time; time.sleep(30)'], report,
                    measure=measure, interval=0.01)
                self.assertEqual(130, result)
                receipt = json.loads(report.read_text())
                self.assertEqual('interrupted', receipt['status'])
                self.assertEqual('footprint-budget', receipt['reason'])
                self.assertLess(receipt['childExitCode'], 0)
                self.assertIsNone(other.poll())
        finally:
            other.terminate()
            other.wait(timeout=5)

    def test_bad_global_conditions_refuse_launch_and_swap_growth_interrupts(self):
        # Ignoring preflight would create a marker despite existing pressure.
        for bad in ({'pressureLevel': 2}, {'freePercent': 19}):
            with self.subTest(bad=bad), tempfile.TemporaryDirectory() as tmp:
                marker = Path(tmp) / 'launched'
                report = Path(tmp) / 'report.json'
                sample = {'footprintBytes': 0, 'swapBytes': 5 * 1024**3,
                          'pressureLevel': 1, 'freePercent': 70, **bad}
                result = guard.run_guard([sys.executable, '-c',
                    f'from pathlib import Path; Path({str(marker)!r}).touch()'], report,
                    measure=lambda pid: sample)
                self.assertEqual(125, result)
                self.assertFalse(marker.exists())
                self.assertEqual('refused', json.loads(report.read_text())['status'])
        with tempfile.TemporaryDirectory() as tmp:
            report = Path(tmp) / 'report.json'
            def measure(pid):
                return {'footprintBytes': 1, 'swapBytes': (7 if pid else 5) * 1024**3,
                        'pressureLevel': 1, 'freePercent': 70}
            self.assertEqual(130, guard.run_guard(
                [sys.executable, '-c', 'import time; time.sleep(30)'], report,
                measure=measure, interval=0.01))
            self.assertEqual('swap-growth-budget', json.loads(report.read_text())['reason'])


    def test_native_monitor_failure_has_fixed_stage_and_class_without_private_details(self):
        from unittest.mock import patch
        marker = 'fictitious-private-monitor-value'
        cases = (
            ('sysctl', 'timeout', subprocess.TimeoutExpired([marker], 5, output=marker, stderr=marker)),
            ('sysctl', 'command_exit', subprocess.CalledProcessError(7, [marker], output=marker, stderr=marker)),
            ('sysctl', 'os_error', OSError(marker)),
        )
        for stage, failure_class, failure in cases:
            with self.subTest(failure_class=failure_class), tempfile.TemporaryDirectory() as tmp:
                report = Path(tmp) / 'report.json'
                with patch.object(guard.sys, 'platform', 'darwin'), patch.object(
                        guard.subprocess, 'run', side_effect=failure):
                    result = guard.run_guard(
                        [sys.executable, '-c', 'raise SystemExit(0)'], report,
                        measure=guard.mac_snapshot)
                self.assertEqual(125, result)
                receipt = json.loads(report.read_text())
                self.assertEqual('refused', receipt['status'])
                self.assertEqual('monitoring-unavailable', receipt['reason'])
                self.assertEqual({'stage': stage, 'class': failure_class}, receipt['monitoringFailure'])
                self.assertIsNone(receipt['childExitCode'])
                self.assertNotIn(marker, report.read_text())

    def test_generic_monitor_failure_during_child_keeps_interruption_and_cleanup(self):
        with tempfile.TemporaryDirectory() as tmp:
            report = Path(tmp) / 'report.json'
            def measure(pid):
                if pid is not None:
                    raise RuntimeError('fictitious-private-monitor-value')
                return {'footprintBytes': 0, 'swapBytes': 0, 'pressureLevel': 1, 'freePercent': 70}
            result = guard.run_guard(
                [sys.executable, '-c', 'import time; time.sleep(30)'], report,
                measure=measure, interval=0.01)
            receipt = json.loads(report.read_text())
            self.assertEqual(130, result)
            self.assertEqual('interrupted', receipt['status'])
            self.assertEqual('monitoring-unavailable', receipt['reason'])
            self.assertEqual({'stage': 'observation', 'class': 'unexpected'}, receipt['monitoringFailure'])
            self.assertLess(receipt['childExitCode'], 0)
            self.assertNotIn('cleanupFailure', receipt)
            self.assertNotIn('fictitious-private-monitor-value', report.read_text())

    def test_missing_observation_refuses_or_interrupts_without_leaking_exception(self):
        for fail_before_launch in (True, False):
            with self.subTest(preflight=fail_before_launch), tempfile.TemporaryDirectory() as tmp:
                report = Path(tmp) / 'report.json'
                def measure(pid):
                    if fail_before_launch or pid:
                        raise RuntimeError('private-measurement-details')
                    return {'footprintBytes': 0, 'swapBytes': 100,
                            'pressureLevel': 1, 'freePercent': 70}
                result = guard.run_guard(
                    [sys.executable, '-c', 'import time; time.sleep(30)'], report,
                    measure=measure, interval=0.01)
                self.assertEqual(125 if fail_before_launch else 130, result)
                receipt = json.loads(report.read_text())
                self.assertEqual('refused' if fail_before_launch else 'interrupted', receipt['status'])
                self.assertEqual('monitoring-unavailable', receipt['reason'])
                self.assertNotIn('private-measurement-details', report.read_text())

    @unittest.skipUnless(sys.platform == 'darwin', 'native macOS observation')
    def test_native_observation_counts_a_real_child_and_grandchild(self):
        with tempfile.TemporaryDirectory() as tmp:
            ready = Path(tmp) / 'ready'
            code = ('import pathlib,subprocess,sys,time; '
                    'p=subprocess.Popen([sys.executable,"-c","import time; time.sleep(10)"]); '
                    f'pathlib.Path({str(ready)!r}).touch(); p.wait()')
            child = subprocess.Popen([sys.executable, '-c', code], start_new_session=True)
            try:
                for _ in range(100):
                    if ready.exists():
                        break
                    time.sleep(0.01)
                self.assertTrue(ready.exists())
                sample = guard.mac_snapshot(child.pid)
                self.assertGreater(sample['footprintBytes'], 0)
                self.assertGreaterEqual(sample['processCount'], 2)
                self.assertGreaterEqual(sample['swapBytes'], 0)
                self.assertIn(sample['pressureLevel'], (1, 2, 4))
                self.assertGreaterEqual(sample['freePercent'], 0)
            finally:
                import os
                import signal
                os.killpg(child.pid, signal.SIGTERM)
                child.wait(timeout=5)

    def test_cli_termination_interrupts_the_owned_child(self):
        import signal
        with tempfile.TemporaryDirectory() as tmp:
            ready, late, report = [Path(tmp) / name for name in ('ready', 'late', 'report.json')]
            code = (f'from pathlib import Path; import time; Path({str(ready)!r}).touch(); '
                    f'time.sleep(2); Path({str(late)!r}).touch()')
            runner = subprocess.Popen([sys.executable, str(lifecycle_cli(tmp)), '--report', str(report),
                                       '--', sys.executable, '-c', code])
            try:
                for _ in range(200):
                    if ready.exists() or runner.poll() is not None:
                        break
                    time.sleep(0.01)
                self.assertTrue(ready.exists())
                runner.send_signal(signal.SIGTERM)
                self.assertEqual(130, runner.wait(timeout=10))
                self.assertEqual('interrupted', json.loads(report.read_text())['status'])
                time.sleep(2)
                self.assertFalse(late.exists())
            finally:
                if runner.poll() is None:
                    runner.terminate()
                    runner.wait(timeout=10)

    @unittest.skipUnless(sys.platform == 'darwin', 'native macOS descendant observation')
    def test_observed_detached_workers_stop_after_leader_finish_or_budget(self):
        import os
        import signal
        for scenario in ('finish', 'budget'):
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory() as tmp:
                pid_file, report = Path(tmp) / 'worker.pid', Path(tmp) / 'report.json'
                observed_file = Path(tmp) / 'worker.observed'
                worker_observed = False
                worker = 'import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(20)'
                code = ('import subprocess,sys,time; from pathlib import Path; '
                        f'p=subprocess.Popen([sys.executable,"-c",{worker!r}],start_new_session=True); '
                        f'Path({str(pid_file)!r}).write_text(str(p.pid));'
                        'deadline=time.monotonic()+10\n'
                        f'while not Path({str(observed_file)!r}).exists() and time.monotonic()<deadline: time.sleep(.01)\n'
                        f'if not Path({str(observed_file)!r}).exists(): raise SystemExit(77)\n'
                        f'time.sleep({5 if scenario == "budget" else 0})')
                def measure(pid):
                    nonlocal worker_observed
                    sample = guard.mac_snapshot(pid)
                    sample.update(pressureLevel=1, freePercent=70, swapBytes=0)
                    if pid_file.exists():
                        worker_pid = int(pid_file.read_text())
                        if any(item['pid'] == worker_pid for item in sample['processes']):
                            worker_observed = True
                            # Release the leader only after native descendant capture.
                            observed_file.touch()
                    if scenario == 'budget' and sample['processCount'] >= 2:
                        sample['footprintBytes'] = 8 * 1024**3
                    return sample
                try:
                    result = guard.run_guard([sys.executable, '-c', code], report,
                                             measure=measure, interval=0.05)
                    worker_pid = int(pid_file.read_text())
                    self.assertTrue(worker_observed, 'fixture must establish native observation')
                    self.assertEqual(130, result)
                    receipt = json.loads(report.read_text())
                    self.assertEqual('descendants-still-running' if scenario == 'finish' else
                                     'footprint-budget', receipt['reason'])
                    self.assertNotIn('cleanupFailure', receipt)
                    probe = subprocess.run(['/bin/ps', '-p', str(worker_pid), '-o', 'stat='],
                                           capture_output=True, text=True)
                    self.assertTrue(not probe.stdout.strip() or probe.stdout.strip().startswith('Z'))
                finally:
                    if pid_file.exists():
                        try:
                            os.kill(int(pid_file.read_text()), signal.SIGKILL)
                        except ProcessLookupError:
                            pass

    def test_signal_during_budget_cleanup_preserves_interrupted_receipt(self):
        with tempfile.TemporaryDirectory() as tmp:
            report, ready = Path(tmp) / 'report.json', Path(tmp) / 'ready'
            wrapper = Path(tmp) / 'wrapper.py'
            wrapper.write_text(f'''import importlib.util,os,signal,threading,time,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('guard', {str(SCRIPT)!r})
g=importlib.util.module_from_spec(spec);spec.loader.exec_module(g)
def measure(pid):
 if pid:
  for _ in range(200):
   if Path({str(ready)!r}).exists():break
   time.sleep(.01)
  threading.Timer(.1,lambda:os.kill(os.getpid(),signal.SIGTERM)).start()
 return dict(footprintBytes=8*1024**3 if pid else 0,swapBytes=0,pressureLevel=1,freePercent=70)
g.run_guard.__kwdefaults__['measure']=measure
raise SystemExit(g.main())
''')
            code = (f'import signal,time;from pathlib import Path;signal.signal(signal.SIGTERM,signal.SIG_IGN);'
                    f'Path({str(ready)!r}).touch();time.sleep(20)')
            result = subprocess.run([sys.executable, str(wrapper), '--report', str(report),
                                     '--', sys.executable, '-c', code], timeout=10,
                                    capture_output=True, text=True)
            self.assertEqual(130, result.returncode, result.stderr)
            receipt = json.loads(report.read_text())
            self.assertEqual('interrupted', receipt['status'])
            self.assertEqual('footprint-budget', receipt['reason'])
            self.assertNotIn('cleanupFailure', receipt)


class MonitoringDiagnosticsTests(unittest.TestCase):
    def test_native_stages_are_captured_without_retry_or_private_data(self):
        import os
        from unittest.mock import patch
        marker = 'fictitious-private-monitor-details'
        scenarios = (
            ('sysctl_parse', 'format'), ('pressure', 'command_exit'),
            ('pressure_parse', 'format'), ('process_tree', 'os_error'),
            ('process_tree_parse', 'format'), ('process_tree_parse_shape', 'format'),
            ('process_identity', 'unexpected'),
            ('process_ownership', 'unexpected'), ('process_footprint', 'timeout'),
            ('process_footprint_parse', 'format'), ('process_recheck', 'command_exit'),
        )
        for failed_stage, failure_class in scenarios:
            with self.subTest(stage=failed_stage), tempfile.TemporaryDirectory() as tmp:
                calls = []
                def read(command, **kwargs):
                    calls.append(tuple(command))
                    if command[0] == '/usr/sbin/sysctl':
                        value = 'invalid' if failed_stage == 'sysctl_parse' else 'pressure_level: 1\nused = 0.00M'
                    elif command[0] == '/usr/bin/memory_pressure':
                        if failed_stage == 'pressure':
                            raise subprocess.CalledProcessError(7, [marker], output=marker, stderr=marker)
                        value = 'invalid' if failed_stage == 'pressure_parse' else 'free percentage: 70%'
                    elif command == ['/bin/ps', '-axo', 'pid=,ppid=,pgid=']:
                        if failed_stage == 'process_tree': raise OSError(marker)
                        value = 'invalid' if failed_stage == 'process_tree_parse' else ('321 0' if failed_stage == 'process_tree_parse_shape' else '321 0 321')
                    elif command == ['/usr/bin/vmmap', '-summary', '321']:
                        if failed_stage == 'process_footprint': raise subprocess.TimeoutExpired([marker], 5, output=marker)
                        value = 'invalid' if failed_stage == 'process_footprint_parse' else 'Physical footprint: 1M'
                    elif command == ['/bin/ps', '-axo', 'pid=']:
                        if failed_stage == 'process_recheck':
                            raise subprocess.CalledProcessError(8, [marker], stderr=marker)
                        value = '321'
                    else:
                        self.fail('unexpected native command')
                    return subprocess.CompletedProcess(command, 0, stdout=value)
                identity_calls = 0
                def identity(pid):
                    nonlocal identity_calls
                    identity_calls += 1
                    if failed_stage == 'process_recheck' or (failed_stage == 'process_identity' and identity_calls == 1):
                        raise RuntimeError(marker)
                    return {'pid':321,'uid':os.getuid()+(1 if failed_stage=='process_ownership' else 0),
                            'seconds':1,'microseconds':2,'status':2}
                report=Path(tmp)/'report.json'
                with patch.object(guard.sys,'platform','darwin'), patch.object(
                        guard.subprocess,'run',side_effect=read), patch.object(
                        guard,'native_identity',side_effect=identity), patch.object(
                        guard.os,'kill',side_effect=AssertionError('fixture must never signal a synthetic identity')):
                    result=guard.run_guard([sys.executable,'-c','raise SystemExit(0)'],report,
                                           measure=lambda pid:guard.mac_snapshot(321))
                receipt=json.loads(report.read_text())
                self.assertEqual(125,result)
                self.assertEqual('refused',receipt['status'])
                self.assertEqual('monitoring-unavailable',receipt['reason'])
                self.assertIsNone(receipt['childExitCode'])
                self.assertEqual({'stage':failed_stage.removesuffix('_shape'),'class':failure_class},receipt['monitoringFailure'])
                self.assertNotIn(marker,report.read_text())
                # One attempt per real command site: no diagnostic retry.
                self.assertEqual(len(calls),len(set(calls)))

    def test_disappeared_worker_race_remains_ignored(self):
        from unittest.mock import patch
        def read(command,**kwargs):
            if command[0]=='/usr/sbin/sysctl': value='pressure_level: 1\nused = 0.00M'
            elif command[0]=='/usr/bin/memory_pressure': value='free percentage: 70%'
            elif command==['/bin/ps','-axo','pid=,ppid=,pgid=']: value='321 0 321'
            elif command==['/bin/ps','-axo','pid=']: value=''
            else: self.fail('unexpected native command')
            return subprocess.CompletedProcess(command,0,stdout=value)
        with patch.object(guard.sys,'platform','darwin'), patch.object(
                guard.subprocess,'run',side_effect=read), patch.object(
                guard,'native_identity',side_effect=RuntimeError('fictitious-private-race')):
            sample=guard.mac_snapshot(321)
        self.assertEqual(0,sample['processCount'])
        self.assertEqual([],sample['processes'])
        self.assertEqual(0,sample['footprintBytes'])

    def test_disk_validation_policy_and_unknown_exception_have_fixed_diagnostics(self):
        from unittest.mock import patch
        Unknown=type('FictitiousPrivateExceptionName',(Exception,),{})
        cases=(('disk','disk','os_error'),('invalid_sample','sample_validation','invalid_sample'),
               ('invalid_clock','policy','invalid_sample'),('unknown','observation','unexpected'))
        for case,stage,failure_class in cases:
            with self.subTest(case=case), tempfile.TemporaryDirectory() as tmp:
                report=Path(tmp)/'report.json'
                def measure(pid):
                    if case=='unknown': raise Unknown('fictitious-private-value')
                    return {'footprintBytes':0,'swapBytes':0,'pressureLevel':3 if case=='invalid_sample' else 1,
                            'freePercent':70,'processes':[]}
                def disk():
                    if case=='disk': raise OSError('fictitious-private-value')
                    return 40*1024**3
                ticks=iter([0,float('nan'),1])
                result=guard.run_guard([sys.executable,'-c','raise SystemExit(0)'],report,
                    profile='milestone',measure=measure,measure_disk=disk,
                    clock=(lambda:next(ticks)) if case=='invalid_clock' else time.monotonic)
                receipt=json.loads(report.read_text())
                self.assertEqual(125,result)
                self.assertEqual('refused',receipt['status'])
                self.assertEqual('monitoring-unavailable',receipt['reason'])
                self.assertEqual({'stage':stage,'class':failure_class},receipt['monitoringFailure'])
                self.assertNotIn('FictitiousPrivateExceptionName',report.read_text())
                self.assertNotIn('fictitious-private-value',report.read_text())


    @unittest.skipUnless(sys.platform == 'darwin', 'native macOS terminal-process race')
    def test_worker_exiting_between_identity_and_vmmap_is_not_live_missing_monitoring(self):
        import os
        import select
        from unittest.mock import patch
        # Only this owned process is released. Keep it unreaped until after the
        # real vmmap, so a real terminal PID remains visible to ps/libproc.
        child = subprocess.Popen([sys.executable, '-c',
            "import sys;print('ready',flush=True);sys.stdin.buffer.read(1)"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, start_new_session=True)
        native_identity = guard.native_identity
        native_run = guard.subprocess.run
        transitioned = False
        vmmap_exits = []
        try:
            self.assertTrue(select.select([child.stdout], [], [], 3)[0])
            self.assertEqual(b'ready\n', child.stdout.readline())
            def identity(pid):
                nonlocal transitioned
                observed = native_identity(pid)
                if pid == child.pid and not transitioned:
                    self.assertIsNotNone(observed)
                    self.assertNotEqual(5, observed['status'])
                    child.stdin.write(b'x'); child.stdin.flush(); child.stdin.close()
                    deadline = time.monotonic() + 3
                    while time.monotonic() < deadline:
                        terminal = native_identity(pid)
                        if terminal is None or terminal['status'] == 5:
                            break
                        time.sleep(.01)
                    self.assertTrue(terminal is None or terminal['status'] == 5, 'owned fixture must reach terminal state')
                    state = native_run(['/bin/ps', '-p', str(pid), '-o', 'stat='],
                                       capture_output=True, text=True, timeout=3)
                    self.assertTrue(state.stdout.strip().startswith('Z'),
                                    'owned fixture must remain an unreaped zombie in ps')
                    transitioned = True
                return observed
            def run(command, **kwargs):
                try:
                    result = native_run(command, **kwargs)
                except subprocess.CalledProcessError as error:
                    if command == ['/usr/bin/vmmap', '-summary', str(child.pid)]:
                        vmmap_exits.append(error.returncode)
                    raise
                if command == ['/usr/bin/vmmap', '-summary', str(child.pid)]:
                    vmmap_exits.append(result.returncode)
                return result
            with patch.object(guard, 'native_identity', side_effect=identity), patch.object(
                    guard.subprocess, 'run', side_effect=run):
                try:
                    sample = guard.mac_snapshot(child.pid)
                except guard._MonitoringFailure as error:
                    self.fail('terminal owned fixture was refused at ' +
                              repr(guard._monitoring_diagnostic(error)) +
                              '; real vmmap exit codes=' + repr(vmmap_exits))
            self.assertTrue(transitioned)
            self.assertEqual(1, len(vmmap_exits))
            self.assertNotEqual(0, vmmap_exits[0])
            self.assertEqual(0, sample['processCount'])
            self.assertEqual(0, sample['footprintBytes'])
            self.assertEqual([], sample['processes'])
        finally:
            # No PID scan or global kill. This Popen is the only child owned here.
            if child.stdin and not child.stdin.closed:
                child.stdin.close()
            if child.poll() is None:
                child.terminate()
            child.wait(timeout=5)
            child.stdout.close()

    def test_footprint_failure_is_ignored_only_after_a_terminal_native_recheck(self):
        import os
        from unittest.mock import patch
        original = {'pid':321,'uid':os.getuid(),'seconds':1,'microseconds':2,'status':2}
        cases = (
            ('gone', None, None), ('zombie', {**original,'status':5}, None),
            ('live', original, {'stage':'process_footprint','class':'command_exit'}),
            ('reused_live', {**original,'seconds':9}, {'stage':'process_footprint','class':'command_exit'}),
            ('unknown_state', {**original,'status':None}, {'stage':'process_footprint','class':'command_exit'}),
            ('malformed_state', {}, {'stage':'process_recheck','class':'format'}),
            ('unavailable', OSError('fictitious-private-recheck'), {'stage':'process_recheck','class':'os_error'}),
            ('unavailable_native_result', RuntimeError('fictitious-private-recheck'), {'stage':'process_recheck','class':'unexpected'}),
        )
        for scenario, current, expected in cases:
            with self.subTest(scenario=scenario):
                identity_calls = 0
                vmmap_calls = 0
                def identity(pid):
                    nonlocal identity_calls
                    identity_calls += 1
                    if identity_calls == 1: return original
                    if isinstance(current, Exception): raise current
                    return current
                def read(command, **kwargs):
                    nonlocal vmmap_calls
                    if command[0]=='/usr/sbin/sysctl': value='pressure_level: 1\nused = 0.00M'
                    elif command[0]=='/usr/bin/memory_pressure': value='free percentage: 70%'
                    elif command==['/bin/ps','-axo','pid=,ppid=,pgid=']: value='321 0 321'
                    elif command==['/bin/ps','-axo','pid=']: value='321'
                    elif command==['/usr/bin/vmmap','-summary','321']:
                        vmmap_calls += 1
                        raise subprocess.CalledProcessError(255, command, stderr='fictitious-private-vmmap')
                    else: self.fail('unexpected native command')
                    return subprocess.CompletedProcess(command,0,stdout=value)
                with patch.object(guard.sys,'platform','darwin'), patch.object(
                        guard,'native_identity',side_effect=identity), patch.object(
                        guard.subprocess,'run',side_effect=read):
                    if expected is None:
                        sample=guard.mac_snapshot(321)
                        self.assertEqual(0,sample['processCount'])
                        self.assertEqual([],sample['processes'])
                    else:
                        with self.assertRaises(guard._MonitoringFailure) as failure:
                            guard.mac_snapshot(321)
                        self.assertEqual(expected,guard._monitoring_diagnostic(failure.exception))
                self.assertEqual(1,vmmap_calls, 'failed footprint must never be retried')
                self.assertEqual(2,identity_calls)

    @unittest.skipUnless(sys.platform == 'darwin', 'native macOS live-process recheck')
    def test_injected_vmmap_failure_on_real_live_owned_child_remains_refused(self):
        import select
        from unittest.mock import patch
        child=subprocess.Popen([sys.executable,'-c',
            "import sys;print('ready',flush=True);sys.stdin.buffer.read(1)"],
            stdin=subprocess.PIPE,stdout=subprocess.PIPE,start_new_session=True)
        run=guard.subprocess.run
        failures=0
        def failing_vmmap(command,**kwargs):
            nonlocal failures
            if command==['/usr/bin/vmmap','-summary',str(child.pid)]:
                failures+=1
                raise subprocess.CalledProcessError(255,command,stderr='fictitious-private-failure')
            return run(command,**kwargs)
        try:
            self.assertTrue(select.select([child.stdout],[],[],3)[0])
            self.assertEqual(b'ready\n',child.stdout.readline())
            with patch.object(guard.subprocess,'run',side_effect=failing_vmmap):
                with self.assertRaises(guard._MonitoringFailure) as failure:
                    guard.mac_snapshot(child.pid)
            self.assertEqual({'stage':'process_footprint','class':'command_exit'},
                             guard._monitoring_diagnostic(failure.exception))
            self.assertEqual(1,failures)
            self.assertIsNone(child.poll())
            current=guard.native_identity(child.pid)
            self.assertIsNotNone(current)
            self.assertNotEqual(5,current['status'])
        finally:
            if child.stdin and not child.stdin.closed: child.stdin.close()
            if child.poll() is None: child.terminate()
            child.wait(timeout=5)
            child.stdout.close()

    def test_diagnostic_boundary_keeps_closed_strings_for_forged_and_subclass_errors(self):
        Unknown=type('FictitiousPrivateExceptionName',(guard._MonitoringFailure,),{})
        cases=((guard._MonitoringFailure('private-stage','private-class'),
                {'stage':'observation','class':'unexpected'}),
               (guard._MonitoringFailure([],{}),{'stage':'observation','class':'unexpected'}),
               (Unknown('sysctl','timeout'),{'stage':'observation','class':'unexpected'}))
        for failure,expected in cases:
            with self.subTest(expected=expected), tempfile.TemporaryDirectory() as tmp:
                report=Path(tmp)/'report.json'
                def measure(pid): raise failure
                result=guard.run_guard([sys.executable,'-c','raise SystemExit(0)'],report,measure=measure)
                self.assertEqual(125,result)
                receipt=json.loads(report.read_text())
                self.assertEqual(expected,receipt['monitoringFailure'])
                self.assertNotIn('private-stage',report.read_text())
                self.assertNotIn('private-class',report.read_text())
                self.assertNotIn('FictitiousPrivateExceptionName',report.read_text())

    def test_diagnostic_is_absent_for_success_budget_and_operator_interrupt(self):
        for case,expected in [('success',0),('budget',125),('operator',130)]:
            with self.subTest(case=case), tempfile.TemporaryDirectory() as tmp:
                report=Path(tmp)/'report.json'
                def measure(pid):
                    if case=='operator': raise KeyboardInterrupt
                    return dict(footprintBytes=0,swapBytes=0,pressureLevel=2 if case=='budget' else 1,freePercent=70)
                result=guard.run_guard([sys.executable,'-c','raise SystemExit(0)'],report,
                                       measure=measure,interval=.01)
                self.assertEqual(expected,result)
                self.assertNotIn('monitoringFailure',json.loads(report.read_text()))


class MilestonePolicyTests(unittest.TestCase):
    def policy(self):
        module_spec = importlib.util.spec_from_file_location(
            'milestone_policy', SCRIPT.with_name('milestone_policy.py'))
        module = importlib.util.module_from_spec(module_spec)
        module_spec.loader.exec_module(module)
        return module.MilestonePolicy(started=0)

    def sample(self, pressure=1, **updates):
        return {'footprintBytes': 12 * 1024**3, 'swapBytes': 8 * 1024**3,
                'pressureLevel': pressure, 'freePercent': 5,
                'diskFreeBytes': 40 * 1024**3, **updates}

    def test_milestone_ignores_strict_memory_budgets_and_warning(self):
        policy = self.policy()
        for now, pressure in [(0, 1), (60, 2), (120, 2), (1000, 1)]:
            self.assertIsNone(policy.evaluate(self.sample(pressure), now))
        self.assertEqual(0, policy.critical_seconds)

    def test_critical_threshold_is_sixty_seconds(self):
        policy = self.policy()
        for now in (0, 59):
            self.assertIsNone(policy.evaluate(self.sample(4), now))
        self.assertEqual('sustained-critical-pressure', policy.evaluate(self.sample(4), 60))

    def test_short_spike_and_recovery_then_new_episode(self):
        policy = self.policy()
        for now, pressure in [(0, 4), (30, 4), (31, 2), (45, 2)]:
            self.assertIsNone(policy.evaluate(self.sample(pressure), now))
        self.assertEqual(30, policy.critical_seconds)
        self.assertIsNone(policy.evaluate(self.sample(1), 46))
        self.assertEqual(0, policy.critical_seconds)
        self.assertIsNone(policy.evaluate(self.sample(4), 47))
        self.assertIsNone(policy.evaluate(self.sample(4), 106))
        self.assertEqual('sustained-critical-pressure', policy.evaluate(self.sample(4), 107))

    def test_flapping_keeps_critical_total_but_warning_time_is_not_critical(self):
        policy = self.policy()
        for now, pressure in [(0, 4), (20, 4), (21, 2), (30, 4), (50, 4), (51, 1), (60, 4), (79, 4)]:
            self.assertIsNone(policy.evaluate(self.sample(pressure), now))
        self.assertEqual(59, policy.critical_seconds)
        self.assertEqual('sustained-critical-pressure', policy.evaluate(self.sample(4), 80))

    def test_missing_unknown_and_invalid_measurements_fail_closed(self):
        for updates in ({'pressureLevel': 3}, {'pressureLevel': 0}, {'pressureLevel': True},
                        {'pressureLevel': None}, {'swapBytes': -1}, {'freePercent': 101},
                        {'diskFreeBytes': None}, {'footprintBytes': float('nan')}):
            with self.subTest(updates=updates):
                self.assertEqual('monitoring-unavailable', self.policy().evaluate(self.sample(**updates), 0))
        value = self.sample(); del value['pressureLevel']
        self.assertEqual('monitoring-unavailable', self.policy().evaluate(value, 0))
        for now in (float('inf'), float('nan'), -1):
            self.assertEqual('monitoring-unavailable', self.policy().evaluate(self.sample(), now))
        policy = self.policy(); policy.evaluate(self.sample(), 10)
        self.assertEqual('monitoring-unavailable', policy.evaluate(self.sample(), 9))

    def test_disk_and_timeout_boundaries(self):
        self.assertIsNone(self.policy().evaluate(self.sample(), 5399))
        self.assertEqual('timeout', self.policy().evaluate(self.sample(), 5400))
        self.assertEqual('disk-budget', self.policy().evaluate(
            self.sample(diskFreeBytes=40 * 1024**3 - 1), 0))


class MilestoneGuardTests(unittest.TestCase):
    def sample(self, pid=None):
        return {'footprintBytes': 10 * 1024**3, 'swapBytes': 8 * 1024**3,
                'pressureLevel': 2, 'freePercent': 4, 'private': 'DO-NOT-REPORT'}

    def test_disk_refusal_and_timeout_before_launch(self):
        for scenario in ('disk', 'timeout', 'manual', 'unknown', 'missing'):
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory() as tmp:
                marker, report = Path(tmp) / 'marker', Path(tmp) / 'report.json'
                times = iter([0, 5400, 5400, 5400])
                def measure(pid):
                    if scenario == 'manual': raise KeyboardInterrupt
                    if scenario == 'missing': raise RuntimeError('DO-NOT-REPORT')
                    return {**self.sample(), 'pressureLevel': 3 if scenario == 'unknown' else 2}
                code = guard.run_guard(
                    [sys.executable, '-c', f'from pathlib import Path; Path({str(marker)!r}).touch()'],
                    report, profile='milestone', measure=measure,
                    measure_disk=lambda: (39 if scenario == 'disk' else 40) * 1024**3,
                    clock=(lambda: next(times)) if scenario == 'timeout' else time.monotonic)
                self.assertEqual(130 if scenario == 'manual' else 125, code)
                self.assertFalse(marker.exists())
                receipt = json.loads(report.read_text())
                self.assertEqual({'disk':'disk-budget','timeout':'timeout','manual':'operator-interrupt',
                    'unknown':'monitoring-unavailable','missing':'monitoring-unavailable'}[scenario], receipt['reason'])
                self.assertNotIn('DO-NOT-REPORT', report.read_text())

    def test_disk_drop_after_launch_stops_only_owned_child(self):
        with tempfile.TemporaryDirectory() as tmp:
            report = Path(tmp) / 'report.json'
            disks = iter([40 * 1024**3, 39 * 1024**3])
            code = guard.run_guard([sys.executable, '-c', 'import time; time.sleep(20)'], report,
                profile='milestone', measure=self.sample, measure_disk=lambda: next(disks), interval=.01)
            self.assertEqual(130, code)
            receipt = json.loads(report.read_text())
            self.assertEqual('disk-budget', receipt['reason'])
            self.assertLess(receipt['childExitCode'], 0)
            self.assertEqual(39 * 1024**3, receipt['minDiskFreeBytes'])

    def test_warning_and_large_metrics_are_not_stops_and_receipt_is_bounded(self):
        with tempfile.TemporaryDirectory() as tmp:
            report = Path(tmp) / 'report.json'
            samples = 0
            def measure(pid):
                nonlocal samples
                samples += 1
                return {**self.sample(), 'swapBytes': (8 if samples == 1 else 10) * 1024**3}
            result = guard.run_guard([sys.executable, '-c', 'pass'], report,
                profile='milestone', measure=measure, measure_disk=lambda: 45 * 1024**3, interval=.01)
            self.assertEqual(0, result)
            receipt = json.loads(report.read_text())
            self.assertEqual('completed', receipt['status'])
            self.assertEqual(10 * 1024**3, receipt['peakSwapBytes'])
            self.assertEqual(2 * 1024**3, receipt['peakSwapGrowthBytes'])
            self.assertEqual(4, receipt['minFreePercent'])
            self.assertNotIn('DO-NOT-REPORT', report.read_text())
            self.assertNotIn('command', receipt)
            self.assertNotIn('environment', receipt)

    def test_timeout_and_critical_with_injected_clock_terminate_owned_child(self):
        for scenario in ('timeout', 'critical'):
            with self.subTest(scenario=scenario), tempfile.TemporaryDirectory() as tmp:
                report = Path(tmp) / 'report.json'
                ticks = iter([0, 0, 5400 if scenario == 'timeout' else 60, 5401])
                result = guard.run_guard([sys.executable, '-c', 'import time; time.sleep(20)'], report,
                    profile='milestone', measure=lambda pid: {**self.sample(), 'pressureLevel':4},
                    measure_disk=lambda:40 * 1024**3, clock=lambda:next(ticks), interval=.01)
                self.assertEqual(130, result)
                self.assertEqual('timeout' if scenario == 'timeout' else 'sustained-critical-pressure',
                                 json.loads(report.read_text())['reason'])


    def test_missing_measurement_after_launch_is_not_hidden_by_child_exit(self):
        with tempfile.TemporaryDirectory() as tmp:
            report = Path(tmp) / 'report.json'
            count = 0
            def measure(pid):
                nonlocal count
                count += 1
                if count > 1: raise RuntimeError('DO-NOT-REPORT')
                return self.sample()
            result = guard.run_guard([sys.executable, '-c', 'pass'], report,
                profile='milestone', measure=measure, measure_disk=lambda:40 * 1024**3, interval=.01)
            self.assertEqual(130, result)
            self.assertEqual('monitoring-unavailable', json.loads(report.read_text())['reason'])
            self.assertNotIn('DO-NOT-REPORT', report.read_text())

    def test_pressure_history_is_capped_without_changing_policy(self):
        with tempfile.TemporaryDirectory() as tmp:
            report = Path(tmp) / 'report.json'
            tick = 0
            def clock():
                nonlocal tick
                tick += 1
                return tick / 10000
            def measure(pid):
                return {**self.sample(), 'pressureLevel': 1 if tick % 2 else 2}
            result = guard.run_guard([sys.executable, '-c', 'import time; time.sleep(.4)'], report,
                profile='milestone', measure=measure, measure_disk=lambda:40 * 1024**3,
                clock=clock, interval=.0001)
            self.assertEqual(0, result)
            receipt = json.loads(report.read_text())
            self.assertEqual(128, len(receipt['pressureSequence']))
            self.assertTrue(receipt['pressureSequenceTruncated'])
            self.assertEqual(0, receipt['peakCriticalSeconds'])

    def test_cli_opt_in_and_argument_validation(self):
        with tempfile.TemporaryDirectory() as tmp:
            wrapper, report = Path(tmp) / 'wrapper.py', Path(tmp) / 'report.json'
            wrapper.write_text(f"""import importlib.util
spec=importlib.util.spec_from_file_location('guard', {str(SCRIPT)!r})
g=importlib.util.module_from_spec(spec);spec.loader.exec_module(g)
g.run_guard.__kwdefaults__['measure']=lambda pid:dict(footprintBytes=10*1024**3,swapBytes=8*1024**3,pressureLevel=2,freePercent=5)
g.run_guard.__kwdefaults__['measure_disk']=lambda:40*1024**3
raise SystemExit(g.main())
""")
            for profile, expected in [(None,125),('strict',125),('milestone',0),('other',2)]:
                args=[] if profile is None else ['--profile',profile]
                result=subprocess.run([sys.executable,str(wrapper),'--report',str(report),*args,
                    '--',sys.executable,'-c','pass'],capture_output=True,text=True,timeout=5)
                self.assertEqual(expected,result.returncode,result.stderr)
            result=subprocess.run([sys.executable,str(wrapper),'--report',str(report),
                '--disk-path',str(Path(tmp)),'--',sys.executable,'-c','pass'],
                capture_output=True,text=True,timeout=5)
            self.assertEqual(2,result.returncode)

    def test_native_disk_observation_uses_selected_volume_available_bytes(self):
        import os
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as tmp:
            report=Path(tmp)/'report.json'
            class Usage:
                f_bavail=40*1024**2
                f_frsize=1024
            with patch.object(guard.os,'statvfs',return_value=Usage()) as read:
                self.assertEqual(0,guard.run_guard([sys.executable,'-c','pass'],report,
                    profile='milestone',disk_path=Path(tmp),measure=self.sample,interval=.01))
                self.assertGreaterEqual(read.call_count,2)
                self.assertTrue(all(call.args==(Path(tmp),) for call in read.call_args_list))
            self.assertEqual(40*1024**3,json.loads(report.read_text())['minDiskFreeBytes'])


    @unittest.skipUnless(sys.platform == 'darwin', 'native ownership tracking')
    def test_disk_measure_failure_preserves_already_observed_detached_identity(self):
        self.assert_observed_cleanup('disk')

    @unittest.skipUnless(sys.platform == 'darwin', 'native ownership tracking')
    def test_unknown_pressure_preserves_already_observed_detached_identity(self):
        self.assert_observed_cleanup('pressure')

    def assert_observed_cleanup(self, scenario):
        import os
        import signal
        with tempfile.TemporaryDirectory() as tmp:
            pid_file, report = Path(tmp)/'worker', Path(tmp)/'report.json'
            worker='import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(20)'
            code=('import subprocess,sys,time;from pathlib import Path;'
                  f'p=subprocess.Popen([sys.executable,"-c",{worker!r}],start_new_session=True);'
                  f'Path({str(pid_file)!r}).write_text(str(p.pid));time.sleep(5)')
            identities=[]
            def measure(pid):
                if pid:
                    for _ in range(200):
                        if pid_file.exists(): break
                        time.sleep(.01)
                result=guard.mac_snapshot(pid)
                identities.extend(result['processes'])
                if pid and scenario == 'pressure': result['pressureLevel'] = 3
                return result
            calls=0
            def disk():
                nonlocal calls
                calls+=1
                if calls>1 and scenario == 'disk': raise RuntimeError('PRIVATE-DISK-ERROR')
                return 40*1024**3
            try:
                self.assertEqual(130,guard.run_guard([sys.executable,'-c',code],report,
                    profile='milestone',measure=measure,measure_disk=disk,interval=.01))
                self.assertTrue(pid_file.exists())
                worker_id=next(item for item in identities if item['pid']==int(pid_file.read_text()))
                self.assertFalse(guard._same_process(worker_id))
                self.assertNotIn('PRIVATE-DISK-ERROR',report.read_text())
                self.assertEqual('monitoring-unavailable',json.loads(report.read_text())['reason'])
            finally:
                for identity in identities:
                    if guard._same_process(identity): os.kill(identity['pid'],signal.SIGKILL)
