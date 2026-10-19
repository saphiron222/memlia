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

    def test_bootstrap_failure_reports_its_fixed_stage_and_command_exit_codes(self):
        source = (HERE / 'run-linux-build.sh').read_text()
        cleanup = source[source.index('cleanup() {'):source.index('trap cleanup EXIT')]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            receipts = root / 'metrics'
            receipts.mkdir()
            private = root / 'memlia-build.test'
            private.mkdir()
            script = ('set -eo pipefail\n'
                      'RUNNER_TEMP="$1"; metrics="$2"; private="$3"\n'
                      'containers=(); network_created=0; completed=0\n'
                      'current_stage=database_initialization; database_ready_exit_code=0; database_init_exit_code=2\n'
                      + cleanup + '\ntrap cleanup EXIT\nexit 2\n')
            result = subprocess.run(['bash', '-c', script, 'stage-test',
                                     str(root), str(receipts), str(private)],
                                    capture_output=True, timeout=10)
            receipt = json.loads(result.stdout)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(receipt.get('stage'), 'database_initialization')
            self.assertEqual(receipt.get('databaseReadyExitCode'), 0)
            self.assertEqual(receipt.get('databaseInitExitCode'), 2)
            self.assertEqual(receipt['exitCode'], 2)
            self.assertEqual(receipt['status'], 'failed')
            self.assertTrue(receipt['cleanup'])
            self.assertFalse(private.exists())

    def test_socket_only_readiness_is_not_final_server_readiness(self):
        source = (HERE / 'run-linux-build.sh').read_text()
        start = source.index('ready=0\nfor attempt in {1..40}; do')
        block = source[start:source.index('\nphase() {', start)]
        # External Docker/time doubles: a socket-only server accepts the old probe,
        # but TCP is not listening. This is not a real PostgreSQL qualification.
        block = block[:block.index('\ndocker exec -i')] if '\ndocker exec -i' in block else block
        with tempfile.TemporaryDirectory():
            script = ('set -eo pipefail\nprefix=fixture\n'
                      'docker() { case "$*" in *"pg_isready -h 127.0.0.1"*) return 2;; *) return 0;; esac; }\n'
                      'sleep() { :; }\n' + block + '\n')
            result = subprocess.run(['bash', '-c', script], capture_output=True, timeout=10)
            self.assertNotEqual(result.returncode, 0)

    def test_sql_initialization_failure_reports_the_actual_command_exit_code(self):
        source = (HERE / 'run-linux-build.sh').read_text()
        cleanup = source[source.index('cleanup() {'):source.index('trap cleanup EXIT')]
        start = source.index('current_stage=database_readiness\n')
        block = source[start:source.index('\nphase() {', start)]
        # Docker is an external double here, not a database integration test.
        for code in [2, 3]:
            with self.subTest(code=code), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                receipts = root / 'metrics'
                receipts.mkdir()
                private = root / 'memlia-build.test'
                private.mkdir()
                (private / 'database.sql').write_text('-- Fictitious SQL fixture\n')
                script = ('set -eo pipefail\n'
                          'RUNNER_TEMP="$1"; metrics="$2"; private="$3"; sql_code="$4"\n'
                          'prefix=fixture; containers=(); network_created=0; completed=0\n'
                          'docker() { case "$*" in *"pg_isready -h 127.0.0.1"*) return 0;; *) return "$sql_code";; esac; }\n'
                          + cleanup + '\ntrap cleanup EXIT\n' + block + '\n')
                result = subprocess.run(['bash', '-c', script, 'sql-test',
                                         str(root), str(receipts), str(private), str(code)],
                                        capture_output=True, timeout=10)
                receipt = json.loads(result.stdout)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(receipt['stage'], 'database_initialization')
                self.assertEqual(receipt['exitCode'], code)
                self.assertEqual(receipt['databaseReadyExitCode'], 0)
                self.assertEqual(receipt['databaseInitExitCode'], code)
                self.assertEqual(receipt['status'], 'failed')
                self.assertTrue(receipt['cleanup'])
                self.assertFalse(private.exists())

    def test_invalid_diagnostic_values_never_leak_or_produce_success(self):
        source = (HERE / 'run-linux-build.sh').read_text()
        cleanup = source[source.index('cleanup() {'):source.index('trap cleanup EXIT')]
        for stage, code in [('FICTIVE_PRIVATE_STAGE', '0'), ('completed', '256'),
                            ('completed', 'FICTIVE_PRIVATE_CODE')]:
            with self.subTest(stage=stage, code=code), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                receipts = root / 'metrics'
                receipts.mkdir()
                private = root / 'memlia-build.test'
                private.mkdir()
                script = ('set -eo pipefail\n'
                          'RUNNER_TEMP="$1"; metrics="$2"; private="$3"\n'
                          'containers=(); network_created=0; completed=1\n'
                          'current_stage="$4"; database_ready_exit_code=0; database_init_exit_code="$5"\n'
                          + cleanup + '\ntrue\ncleanup\n')
                result = subprocess.run(['bash', '-c', script, 'diagnostic-test',
                                         str(root), str(receipts), str(private), stage, code],
                                        capture_output=True, timeout=10)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn(b'FICTIVE_PRIVATE', result.stdout + result.stderr)
                self.assertFalse(private.exists())

if __name__ == '__main__':
    unittest.main()
