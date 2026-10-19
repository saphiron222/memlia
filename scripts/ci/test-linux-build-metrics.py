# Copyright 2026 Memlia. All rights reserved.
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location('metrics', HERE / 'linux-build-metrics.py')
metrics = importlib.util.module_from_spec(spec)
spec.loader.exec_module(metrics)

class MetricsTests(unittest.TestCase):
    def test_cgroup_peak_and_oom_are_not_process_rss(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for name, value in {'memory.current':'300', 'memory.peak':'900', 'memory.max':'1024',
                                'memory.swap.current':'0', 'memory.swap.peak':'0', 'memory.swap.max':'0',
                                'memory.events':'low 0\nhigh 0\nmax 1\noom 1\noom_kill 1\n',
                                'cpu.max':'400000 100000', 'cpu.stat':'usage_usec 100\nuser_usec 90\nsystem_usec 10\n',
                                'cgroup.procs':f'{os.getpid()}\n'}.items():
                (root / name).write_text(value)
            reading = metrics.cgroup_read(root)
            self.assertEqual(reading['peakBytes'], 900)
            self.assertEqual(reading['events']['oom_kill'], 1)
            self.assertFalse(metrics.successful(0, True, [], reading['events'], []))

    def test_abnormal_completion_or_cleanup_never_passes(self):
        self.assertTrue(metrics.successful(0, True, [], {}, []))
        for args in [(0,False,[],{},[]),(0,True,[99],{},[]),(1,True,[],{},[]),(0,True,[],{},['cleanup'])]:
            self.assertFalse(metrics.successful(*args))

    def test_missing_cgroup_cannot_be_reported_as_success(self):
        with tempfile.TemporaryDirectory() as temporary:
            report = Path(temporary) / 'result.json'
            result = subprocess.run([sys.executable,str(HERE/'linux-build-metrics.py'),'--cgroup',temporary,
                                     '--report',str(report),'--phase','test','--',sys.executable,'-c','raise SystemExit(0)'],capture_output=True,timeout=10)
            self.assertNotEqual(result.returncode,0)
            receipt = json.loads(report.read_text())
            self.assertEqual(receipt['status'],'failed')
            self.assertFalse(receipt['normalCompletion'])
            self.assertNotIn('command',receipt)

    def test_cleanup_receipt_io_failure_cannot_exit_successfully(self):
        # Execute the production cleanup function with real filesystem failures.
        # No Docker resource exists at this boundary; no command is stubbed.
        source = (HERE / 'run-linux-build.sh').read_text()
        cleanup = source[source.index('cleanup() {'):source.index('trap cleanup EXIT')]
        for failure in ['none', 'write', 'emit']:
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                receipts = root / 'metrics'
                receipts.mkdir()
                private = root / 'memlia-build.test'
                private.mkdir()
                if failure == 'write':
                    (receipts / 'result.json').mkdir()
                elif failure == 'emit':
                    (receipts / 'invalid.json').write_text('invalid JSON')
                # macOS Bash 3 treats an empty array as unset; Linux uses Bash 5.
                script = ('set -eo pipefail\n'
                          'RUNNER_TEMP="$1"; metrics="$2"; private="$3"\n'
                          'containers=(); network_created=0; completed=1\n'
                          + cleanup + '\ntrue\ncleanup\n')
                result = subprocess.run(['bash', '-c', script, 'cleanup-test',
                                         str(root), str(receipts), str(private)],
                                        capture_output=True, timeout=10)
                self.assertEqual(result.returncode == 0, failure == 'none')
                self.assertFalse(private.exists())
                if failure == 'none':
                    self.assertEqual(json.loads(result.stdout)['status'], 'passed')

    def test_proc_parser_handles_spaces_and_parentheses(self):
        record = '123 (worker (test)) ' + ' '.join(['S'] + ['0'] * 18 + ['456', '0', '0'])
        self.assertEqual(metrics.proc_start(record),456)

if __name__ == '__main__':
    unittest.main()
