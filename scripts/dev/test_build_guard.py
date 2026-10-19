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


class GuardCliTests(unittest.TestCase):
    def test_success_and_failure_are_reported_without_command_arguments(self):
        for code in (0, 3):
            with self.subTest(code=code), tempfile.TemporaryDirectory() as tmp:
                report = Path(tmp) / 'result.json'
                result = subprocess.run([sys.executable, str(SCRIPT), '--report', str(report),
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
            runner = subprocess.Popen([sys.executable, str(SCRIPT), '--report', str(report),
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
                worker = 'import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(20)'
                code = ('import subprocess,sys,time; from pathlib import Path; '
                        f'p=subprocess.Popen([sys.executable,"-c",{worker!r}],start_new_session=True); '
                        f'Path({str(pid_file)!r}).write_text(str(p.pid));time.sleep({5 if scenario == "budget" else 1})')
                def measure(pid):
                    sample = guard.mac_snapshot(pid)
                    if scenario == 'budget' and sample['processCount'] >= 2:
                        sample['footprintBytes'] = 8 * 1024**3
                    return sample
                try:
                    result = guard.run_guard([sys.executable, '-c', code], report,
                                             measure=measure, interval=0.05)
                    worker_pid = int(pid_file.read_text())
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
