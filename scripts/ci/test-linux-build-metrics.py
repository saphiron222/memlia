# Copyright 2026 Memlia. All rights reserved.
import errno
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

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
                          'containers=(); network_created=0; completed=1; current_stage=completed; next_started=1; standalone_verified=1\n'
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
                          'containers=(); network_created=0; completed=1; current_stage=completed; next_started=1; standalone_verified=1\n'
                          'current_stage="$4"; database_ready_exit_code=0; database_init_exit_code="$5"\n'
                          + cleanup + '\ntrue\ncleanup\n')
                result = subprocess.run(['bash', '-c', script, 'diagnostic-test',
                                         str(root), str(receipts), str(private), stage, code],
                                        capture_output=True, timeout=10)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn(b'FICTIVE_PRIVATE', result.stdout + result.stderr)
                self.assertFalse(private.exists())

    def product_phases(self, scope, fail_phase=''):
        source = (HERE / 'run-linux-build.sh').read_text()
        marker = 'run_product_phases() {'
        block = source[source.index(marker if marker in source else 'phase inventory /work/apps/sim'):]
        # Only the external phase boundary is doubled: no compiler, Docker or DB runs.
        script = ('set -euo pipefail\nscope="$1"; fail_phase="$2"\n'
                  'phase() { printf "%s\\n" "$1"; if [[ "$1" == "$fail_phase" ]]; then return 7; fi; }\n'
                  + block)
        return subprocess.run(['bash', '-c', script, 'phase-test', scope, fail_phase],
                              capture_output=True, text=True, timeout=10)

    def test_validation_stops_after_native_bundles_without_next_or_standalone(self):
        result = self.product_phases('validation')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines(), ['inventory','typegen','typecheck','cli','sandbox'])

    def test_full_build_still_requires_next_and_standalone_and_stops_on_failure(self):
        phases = ['inventory','typegen','typecheck','cli','sandbox','next','standalone']
        result = self.product_phases('build')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.splitlines(), phases)
        for scope, last in [('validation','sandbox'), ('build','standalone')]:
            for failed in phases[:phases.index(last)+1]:
                with self.subTest(scope=scope, failed=failed):
                    result = self.product_phases(scope, failed)
                    self.assertEqual(result.returncode, 7)
                    self.assertEqual(result.stdout.splitlines(), phases[:phases.index(failed)+1])

    def test_mode_is_opt_in_and_rejects_unknown_or_extra_arguments_before_bootstrap(self):
        source = (HERE / 'run-linux-build.sh').read_text()
        marker = 'scope=build\n'
        block = source[source.index(marker):source.index('root="$(git rev-parse')] if marker in source else marker
        for args, expected in [([], 'build'), (['--validation-only'], 'validation'),
                               (['--anything'], None), (['--validation-only','extra'], None)]:
            with self.subTest(args=args):
                result = subprocess.run(['bash','-c','set -euo pipefail\n'+block+'printf "%s" "$scope"',
                                         'mode-test',*args],capture_output=True,text=True,timeout=10,
                                        env={**os.environ, 'MEMLIA_CI_CHAT_UI': '0'})
                if expected is None:
                    self.assertEqual(result.returncode, 2)
                    self.assertEqual(result.stdout, '')
                else:
                    self.assertEqual(result.returncode, 0)
                    self.assertEqual(result.stdout, expected)

    def test_validation_receipt_is_distinct_and_never_hides_incomplete_or_interrupted_work(self):
        source = (HERE / 'run-linux-build.sh').read_text()
        cleanup = source[source.index('cleanup() {'):source.index('current_stage=host\n')]
        cases = [
            ('normal', 'validation_completed', 1, 0, 0, 'true', True),
            ('unfinished', 'phase_sandbox', 0, 0, 0, 'true', False),
            ('interrupted', 'phase_sandbox', 0, 0, 0, 'kill -TERM "$$"', False),
            ('next_started', 'validation_completed', 1, 1, 0, 'true', False),
            ('standalone', 'validation_completed', 1, 0, 1, 'true', False),
            ('wrong_stage', 'completed', 1, 0, 0, 'true', False),
            ('cleanup_scope', 'validation_completed', 1, 0, 0, 'true', False),
        ]
        for label, stage, completed, next_started, standalone, command, passed in cases:
            with self.subTest(case=label), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary); receipts = root/'metrics'; receipts.mkdir()
                private = root/('outside-scope' if label == 'cleanup_scope' else 'memlia-build.test'); private.mkdir()
                script = ('set -eo pipefail\nRUNNER_TEMP="$1"; metrics="$2"; private="$3"\n'
                          'containers=(); network_created=0; scope=validation\n'
                          f'current_stage={stage}; completed={completed}; next_started={next_started}; standalone_verified={standalone}\n'
                          + cleanup + command + '\n')
                result = subprocess.run(['bash','-c',script,'receipt-test',str(root),str(receipts),str(private)],
                                        capture_output=True,text=True,timeout=10)
                receipt = json.loads((receipts/'result.json').read_text())
                self.assertEqual(result.returncode == 0, passed)
                self.assertEqual(receipt['scope'], 'validation')
                self.assertEqual(receipt['status'], 'validation_passed' if passed else 'failed')
                self.assertNotEqual(receipt['buildStatus'], 'passed')
                if label == 'normal':
                    self.assertEqual(receipt['buildStatus'], 'not_run')
                    self.assertFalse(receipt['standaloneVerified'])
                if label == 'interrupted': self.assertEqual(receipt['exitCode'], 130)
                if label == 'cleanup_scope':
                    self.assertFalse(receipt['cleanup'])
                    self.assertTrue(private.exists())
                else:
                    self.assertFalse(private.exists())

    def test_full_build_receipt_requires_both_next_and_standalone(self):
        source = (HERE / 'run-linux-build.sh').read_text()
        cleanup = source[source.index('cleanup() {'):source.index('current_stage=host\n')]
        for next_started, standalone in [(0,0),(1,0),(0,1),(1,1)]:
            with self.subTest(next=next_started,standalone=standalone), tempfile.TemporaryDirectory() as temporary:
                root=Path(temporary); receipts=root/'metrics'; receipts.mkdir()
                private=root/'memlia-build.test'; private.mkdir()
                script=('set -eo pipefail\nRUNNER_TEMP="$1"; metrics="$2"; private="$3"\n'
                        'containers=(); network_created=0; scope=build; current_stage=completed; completed=1\n'
                        f'next_started={next_started}; standalone_verified={standalone}\n'+cleanup+'true\n')
                result=subprocess.run(['bash','-c',script,'build-receipt-test',str(root),str(receipts),str(private)],
                                      capture_output=True,text=True,timeout=10)
                receipt=json.loads((receipts/'result.json').read_text())
                passed=bool(next_started and standalone)
                self.assertEqual(result.returncode == 0,passed)
                self.assertEqual(receipt['status'],'passed' if passed else 'failed')
                self.assertEqual(receipt['buildStatus']=='passed',passed)

    def test_installed_next_must_match_both_exact_versioned_pins(self):
        source=(HERE/'run-linux-build.sh').read_text()
        start=source.index('manifest=json.loads(Path("/work/apps/sim/package.json")')
        code=source[start:source.index("\n' > \"$private/toolchain.log",start)]
        # Only package metadata is a fixture here; this does not qualify installation.
        cases=[('16.4.0','16.4.0','16.4.0',True),('16.4.2','16.4.2','16.4.2',True),
               ('16.4.2','16.4.2','16.4.0',False),('16.4.2','16.4.0','16.4.2',False),
               ('^16.4.2','^16.4.2','16.4.2',False),('latest','latest','16.4.2',False)]
        for pin,override,installed,passed in cases:
            with self.subTest(pin=pin,override=override,installed=installed), tempfile.TemporaryDirectory() as temporary:
                root=Path(temporary); (root/'apps/sim').mkdir(parents=True); (root/'metrics').mkdir()
                (root/'apps/sim/package.json').write_text(json.dumps({'dependencies':{'next':pin}}))
                (root/'package.json').write_text(json.dumps({'overrides':{'next':override}}))
                script=('import json,re\nfrom pathlib import Path\n'
                        + 'r='+repr({'node':'v24.22.0','bun':'1.4.2','typescript':'7.0.2','next':installed})+'\n'
                        +code.replace('/work',str(root)).replace('/metrics',str(root/'metrics')))
                result=subprocess.run([sys.executable,'-c',script],capture_output=True,timeout=10)
                self.assertEqual(result.returncode==0,passed,result.stderr)
                if passed:
                    receipt=json.loads((root/'metrics/toolchain.json').read_text())
                    self.assertEqual(receipt['expectedNext'],pin)


class TypeScriptDiagnosticTests(unittest.TestCase):
    def test_exact_tracked_paths_only_and_no_message_or_source(self):
        with tempfile.TemporaryFile() as output:
            output.write(b'lib/x.ts(2,3): error TS2322: PRIVATE_CANARY_VALUE\n'
                         b'../../packages/a/src/x.ts(4,5): error TS2339: PRIVATE_CANARY_VALUE\n'
                         b'lib/x.ts(2,3): error TS2322: duplicate\n'
                         b'lib/untracked.ts(1,1): error TS2322: PRIVATE_CANARY_VALUE\n'
                         b'../../../private.ts(1,1): error TS2322: PRIVATE_CANARY_VALUE\n'
                         b'./lib/x.ts(1,1): error TS2322: ambiguous\n'
                         b'/work/apps/sim/lib/x.ts(1,1): error TS2322: absolute\n'
                         b'lib/../lib/x.ts(1,1): error TS2322: normalization\n'
                         b'\x1b[31mlib/x.ts(1,1): error TS2322: ansi\n'
                         b'lib/x.ts(1,1): error TS2322: ansi\x1b[0m\n'
                         b'lib/x.ts(1,1): error TS2322: csi\x9b0m\n'
                         b'lib/x.ts(1,1): error TS2322: tab\tvalue\n'
                         b'lib/x.ts(999999999,1): error TS2322: huge\n'
                         b'lib/x.ts(0,1): error TS2322: zero\n'
                         b'lib/x.ts(1,1): error TS99999999: invalid\n')
            result=metrics.typescript_locations(output,['apps/sim/lib/x.ts','packages/a/src/x.ts'],'apps/sim')
            self.assertEqual(result['locations'],[
                {'path':'apps/sim/lib/x.ts','line':2,'column':3,'code':2322},
                {'path':'packages/a/src/x.ts','line':4,'column':5,'code':2339}])
            self.assertNotIn('PRIVATE_CANARY',json.dumps(result))
            self.assertTrue(all(set(item)=={'path','line','column','code'} for item in result['locations']))

    def test_window_partial_line_limits_and_large_coordinates(self):
        with tempfile.TemporaryFile() as output:
            # Place an otherwise valid header exactly at the tail boundary, but inside a line.
            suffix=b'x.ts(1,1): error TS2322: hidden\n'
            rest=b'\n'*(65536-len(suffix))
            output.write(b'PRIVATE_CANARY'+suffix+rest)
            result=metrics.typescript_locations(output,['x.ts'],'')
            self.assertEqual(result['locations'],[])
            self.assertTrue(result['truncated'])
        with tempfile.TemporaryFile() as output:
            for line in range(1,103): output.write(f'x.ts({line},1): error TS2322: secret\n'.encode())
            result=metrics.typescript_locations(output,['x.ts'],'')
            self.assertEqual(len(result['locations']),100)
            self.assertTrue(result['truncated'])
        with tempfile.TemporaryFile() as output:
            output.write(b'x.ts(1000001,1): error TS2322: huge\n'+b'x.ts(1,1): error TS2322: '+b'x'*4096+b'\n')
            self.assertEqual(metrics.typescript_locations(output,['x.ts'],'')['locations'],[])

    def test_git_allowlist_excludes_untracked_symlink_and_unsafe_names(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); repo=root/'repo'; repo.mkdir()
            def git(*args):
                return subprocess.run(['git','-C',str(repo),*args],check=True,capture_output=True)
            git('init','-q')
            for name in ['safe.ts','with space.ts','unsafe\nname.ts','not-source.txt']:
                (repo/name).write_text('fictitious')
            (repo/'link.ts').symlink_to('safe.ts')
            git('add','--all');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture')
            (repo/'untracked.ts').write_text('untracked')
            manifest=root/'paths.json'; metrics.write_tracked_sources(repo,manifest)
            self.assertEqual(metrics.load_tracked_sources(manifest),['safe.ts'])
            self.assertEqual(metrics.load_tracked_sources(root/'absent.json'),[])
            for value in [['../private.ts'],['/absolute.ts'],['safe.ts','safe.ts'],['x'*513+'.ts'],['safe.ts',4],{'message':'PRIVATE_CANARY'}]:
                manifest.write_text(json.dumps(value))
                self.assertEqual(metrics.load_tracked_sources(manifest),[])
            manifest.write_bytes(b'x'*(2*1024*1024+1))
            self.assertEqual(metrics.load_tracked_sources(manifest),[])

    def test_real_child_receipt_keeps_failure_and_drops_message(self):
        # Real subprocess/output/receipt; only Linux cgroup observations are doubles.
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); manifest=root/'paths.json'; manifest.write_text('["x.ts"]')
            args=SimpleNamespace(cgroup=str(root),report=str(root/'receipt.json'),phase='typecheck',
                                 tracked_sources=str(manifest),source_root=str(root),timeout=5,
                                 command=[sys.executable,'-c',
                                          'print("x.ts(2,3): error TS2322: PRIVATE_CANARY_VALUE"); raise SystemExit(2)'])
            reading={'pids':[os.getpid()],'limitBytes':1024,'swapBytes':0,'events':{}}
            previous=Path.cwd()
            try:
                os.chdir(root)
                with patch.object(metrics,'cgroup_read',return_value=reading), \
                     patch.object(metrics,'host_memory',return_value={'availableBytes':1024,'swapUsedBytes':0}):
                    self.assertEqual(metrics.run(args),1)
            finally:
                os.chdir(previous)
            encoded=(root/'receipt.json').read_text(); receipt=json.loads(encoded)
            self.assertEqual(receipt['status'],'failed')
            self.assertEqual(receipt['childExitCode'],2)
            self.assertEqual(receipt['typeScriptDiagnostics']['locations'],[
                {'path':'x.ts','line':2,'column':3,'code':2322}])
            self.assertNotIn('PRIVATE_CANARY',encoded)
            self.assertEqual(receipt['typeScriptErrorCodes'],[2322])

    def test_non_typecheck_phase_cannot_emit_locations(self):
        # Integration boundary uses real output and manifest; cgroup observation is tested separately.
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); manifest=root/'paths.json'; manifest.write_text('["x.ts"]')
            for phase in ['test','install','next','typecheck']:
                with tempfile.TemporaryFile() as output:
                    output.write(b'x.ts(1,1): error TS2322: PRIVATE_CANARY\n')
                    result=metrics.phase_typescript_locations(phase,output,manifest,root,root)
                    self.assertEqual(len(result['locations']),1 if phase=='typecheck' else 0)
                    self.assertNotIn('PRIVATE_CANARY',json.dumps(result))
                    self.assertEqual(metrics.phase_typescript_locations(
                        phase,output,root/'absent.json',root,root)['locations'],[])
                    self.assertEqual(metrics.phase_typescript_locations(
                        phase,output,manifest,root,root.parent)['locations'],[])


class WebpackObservationTests(unittest.TestCase):
    PREFIX = b'2026-10-19T11:16:08.269Z next:build:webpack-build '

    def observe(self, raw, enabled=True):
        observer = metrics.WebpackObservation(enabled)
        with tempfile.TemporaryFile() as output:
            output.write(raw)
            output.flush()
            observer.drain(output, final=True)
        return observer.receipt()

    def test_incremental_split_lines_keep_writer_offset_and_early_stages(self):
        observer = metrics.WebpackObservation(True)
        with tempfile.TemporaryFile() as output:
            output.write(self.PREFIX + b'starting ser')
            position = output.tell()
            output.flush()
            observer.drain(output)
            self.assertEqual(output.tell(), position)
            self.assertEqual(observer.receipt()['events'], [])
            output.write(b'ver compiler\n' + b'x\n' * 40000)
            output.flush()
            observer.drain(output)
            output.write(self.PREFIX + b'server compiler finished 12ms\n')
            output.flush()
            observer.drain(output, final=True)
            self.assertEqual(observer.receipt()['events'], [
                {'compiler':'server','event':'started'},
                {'compiler':'server','event':'finished','durationMs':12}])
            self.assertTrue(observer.receipt()['sequenceValid'])
            self.assertFalse(observer.receipt()['complete'])


    def test_real_child_can_be_observed_before_exit_without_losing_partial_line(self):
        observer = metrics.WebpackObservation(True)
        first = self.PREFIX + b'starting ser'
        with tempfile.TemporaryFile() as output:
            program = ('import os,sys; os.write(2,' + repr(first) + '); print("ready",flush=True); '
                       'sys.stdin.readline(); os.write(2,b"ver compiler\\n")')
            # Actual subprocess, real file output and stdin barrier, no /proc simulation.
            with subprocess.Popen([sys.executable,'-c',program], stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=output) as child:
                try:
                    self.assertEqual(child.stdout.readline(), b'ready\n')
                    observer.drain(output)
                    self.assertIsNone(child.poll())
                    self.assertEqual(observer.receipt()['events'], [])
                finally:
                    child.communicate(b'continue\n', timeout=5)
                self.assertEqual(child.returncode, 0)
            observer.drain(output, final=True)
            self.assertEqual(observer.receipt()['events'], [{'compiler':'server','event':'started'}])

    def test_exact_native_sequence_and_only_fixed_values(self):
        raw = b''
        for compiler in [b'server', b'edge-server', b'client']:
            raw += self.PREFIX + b'starting ' + compiler + b' compiler\n'
            raw += self.PREFIX + compiler + b' compiler finished 42ms\n'
        receipt = self.observe(raw)
        self.assertEqual(len(receipt['events']), 6)
        self.assertTrue(receipt['complete'])
        self.assertTrue(receipt['sequenceValid'])
        self.assertEqual(receipt['events'][3], {'compiler':'edge','event':'finished','durationMs':42})
        self.assertFalse(receipt['truncated'])
        self.assertEqual(self.observe(raw, False)['events'], [])

    def test_malformed_canaries_controls_and_incomplete_lines_are_not_published(self):
        canary = b'PRIVATE_CANARY_VALUE'
        raw = b''.join([
            canary + self.PREFIX + b'starting server compiler\n',
            self.PREFIX + b'starting server compiler ' + canary + b'\n',
            self.PREFIX.replace(b'webpack-build', b'webpack-build-fake') + b'starting server compiler\n',
            b'\x1b[31m' + self.PREFIX + b'starting server compiler\n',
            self.PREFIX + b'starting server compiler\x1b[0m\n',
            self.PREFIX + b'starting server compiler\r\n',
            self.PREFIX + b'starting server compiler\xff\n',
            self.PREFIX + b'server compiler finished 999999999999999ms\n',
            self.PREFIX + b'server compiler finished -1ms\n',
            self.PREFIX + b'starting secret compiler\n',
            b'x' * 700 + self.PREFIX + b'starting server compiler\n',
            self.PREFIX + b'starting server compiler'])
        receipt = self.observe(raw)
        self.assertEqual(receipt['events'], [])
        self.assertTrue(receipt['truncated'])
        self.assertNotIn(canary.decode(), json.dumps(receipt))

    def test_sequence_repetition_volume_and_event_bounds(self):
        start = self.PREFIX + b'starting server compiler\n'
        receipt = self.observe(start * 1000)
        self.assertEqual(len(receipt['events']), 16)
        self.assertFalse(receipt['sequenceValid'])
        self.assertFalse(receipt['complete'])
        self.assertTrue(receipt['truncated'])
        self.assertFalse(self.observe(self.PREFIX + b'starting client compiler\n')['sequenceValid'])
        # A valid-looking suffix at a byte boundary must not become a fresh line.
        receipt = self.observe(b'x' * (8 * 1024 * 1024) + start)
        self.assertEqual(receipt['events'], [])
        self.assertTrue(receipt['truncated'])

    def test_real_child_observation_never_changes_exit_verdict_or_exposes_output(self):
        # Real child/output/receipt; only Linux /proc+cgroup observations are doubled.
        for phase, code in [('next', 3), ('next', 0), ('typecheck', 0)]:
            with self.subTest(phase=phase, code=code), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                raw = b'PRIVATE_CANARY_VALUE\n'
                for compiler in [b'server', b'edge-server', b'client']:
                    raw += self.PREFIX + b'starting ' + compiler + b' compiler\n'
                    raw += self.PREFIX + compiler + b' compiler finished 1ms\n'
                args = SimpleNamespace(cgroup=str(root), report=str(root/'receipt.json'), phase=phase,
                                       tracked_sources=None, source_root=str(root), timeout=5,
                                       command=[sys.executable, '-c',
                                                'import os,time; os.write(1,' + repr(raw) + '); time.sleep(.03); raise SystemExit(' + str(code) + ')'])
                reading = {'pids':[os.getpid()],'limitBytes':1024,'swapBytes':0,'events':{}}
                with patch.object(metrics, 'cgroup_read', return_value=reading), \
                     patch.object(metrics, 'host_memory', return_value={'availableBytes':1024,'swapUsedBytes':0}):
                    self.assertEqual(metrics.run(args), int(code != 0))
                encoded = (root/'receipt.json').read_text(); receipt = json.loads(encoded)
                self.assertEqual(receipt['status'], 'passed' if code == 0 else 'failed')
                self.assertNotIn('PRIVATE_CANARY', encoded)
                self.assertEqual(len(receipt['webpackObservation']['events']), 6 if phase == 'next' else 0)
                self.assertEqual(receipt['webpackObservation']['complete'], phase == 'next')

    def test_read_error_is_observational_only(self):
        observer = metrics.WebpackObservation(True)
        with tempfile.TemporaryFile() as output:
            with patch.object(metrics.os, 'pread', side_effect=OSError('PRIVATE_CANARY')):
                observer.drain(output, final=True)
        self.assertTrue(observer.receipt()['readError'])
        self.assertNotIn('PRIVATE_CANARY', json.dumps(observer.receipt()))

    def test_debug_environment_is_scoped_to_the_real_next_command(self):
        source = (HERE / 'run-linux-build.sh').read_text()
        block = source[source.index('run_product_phases() {'):source.index('\nrun_product_phases\n')]
        script = ('set -e\nscope=build\n'
                  'phase() { python3 -c "import json,sys; print(json.dumps(sys.argv[1:]))" "$@"; }\n'
                  + block + '\nrun_product_phases\n')
        result = subprocess.run(['bash','-c',script],capture_output=True,text=True,timeout=10)
        self.assertEqual(result.returncode,0,result.stderr)
        calls = [json.loads(line) for line in result.stdout.splitlines()]
        call = next(c for c in calls if c[0] == 'next')
        self.assertEqual(call[2:], ['env','DEBUG=next:build:webpack-build','DEBUG_COLORS=0',
                                    'NODE_OPTIONS=--max-old-space-size=11264',
                                    'node','../../node_modules/next/dist/bin/next','build','--webpack'])
        self.assertFalse(any('DEBUG=' in arg for c in calls if c[0] != 'next' for arg in c))
        self.assertFalse(any('NODE_OPTIONS=' in arg for c in calls if c[0] != 'next' for arg in c))

    def test_next_heap_receipt_matches_its_command_and_keeps_other_phases_at_ten(self):
        # Parse the actual receipt without executing bootstrap or reading secrets.
        import ast
        source = (HERE / 'run-linux-build.sh').read_text()
        line = next(line for line in source.splitlines() if line.startswith('receipt={'))
        tree = ast.parse(line).body[0].value
        fields = {key.value: value for key, value in zip(tree.keys, tree.values)}
        self.assertEqual(ast.literal_eval(fields['v8OldSpaceMiB']), 10240)
        self.assertEqual(ast.literal_eval(fields['nextV8OldSpaceMiB']), 11264)
        # The normal environment is unchanged; only the Next phase overrides it.
        self.assertIn("'NODE_OPTIONS':'--max-old-space-size=10240'", source)

class SwapExperimentTests(unittest.TestCase):
    def test_explicit_swap_modes_reach_only_next_with_the_selected_bundler_and_heap(self):
        source = (HERE / 'run-linux-build.sh').read_text()
        block = source[source.index('run_product_phases() {'):source.index('\nrun_product_phases\n')]
        for variant, bundler, heap in [('webpack','webpack',24576), ('turbopack','turbopack',11264), ('turbopack-zram','turbopack',11264)]:
            script = ('set -e\nscope=build; swap_variant="$1"\n'
                      'phase() { python3 -c "import json,sys; print(json.dumps(sys.argv[1:]))" "$@"; }\n'
                      + block + '\nrun_product_phases\n')
            result = subprocess.run(['bash','-c',script,'phase-test',variant],capture_output=True,text=True,timeout=10)
            self.assertEqual(result.returncode,0,result.stderr)
            calls = [json.loads(line) for line in result.stdout.splitlines()]
            next_call = next(c for c in calls if c[0]=='next')
            self.assertEqual(next_call[-1], '--'+bundler)
            self.assertIn('NODE_OPTIONS=--max-old-space-size='+str(heap),next_call)
            self.assertTrue(any(c[0]=='config' for c in calls))
            self.assertFalse(any('NODE_OPTIONS=' in a for c in calls if c[0]!='next' for a in c))

    def test_swap_limit_mismatch_refuses_before_real_child(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); marker=root/'child-ran'
            args=SimpleNamespace(cgroup=str(root),report=str(root/'receipt.json'),phase='next',experiment='webpack',timeout=2,
                                 command=[sys.executable,'-c',f"open({str(marker)!r},'w').write('ran')"])
            reading={'pids':[os.getpid()],'limitBytes':13*1024**3,'swapLimitBytes':0,'swapBytes':0,'events':{}}
            with patch.object(metrics,'cgroup_read',return_value=reading), patch.object(metrics,'host_memory',return_value={'availableBytes':1024,'swapUsedBytes':0}):
                self.assertNotEqual(metrics.run(args),0)
            self.assertFalse(marker.exists())

class SwapCounterTests(unittest.TestCase):
    def test_kernel_peak_and_missing_optional_peak_are_distinct(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)
            self.assertEqual(metrics.swap_observation(root), {'peakBytes':None,'peakSource':'sampled','events':None})
            (root/'memory.swap.peak').write_text('12345')
            (root/'memory.swap.events').write_text('high 2\nmax 3\nfail 4\n')
            self.assertEqual(metrics.swap_observation(root), {'peakBytes':12345,'peakSource':'kernel','events':{'high':2,'max':3,'fail':4}})

    def test_actual_child_gets_a_failing_verdict_even_with_available_swap(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)
            (root/'memory.swap.peak').write_text('8192')
            (root/'memory.swap.events').write_text('high 0\nmax 1\nfail 0\n')
            args=SimpleNamespace(cgroup=str(root),report=str(root/'receipt.json'),phase='next',experiment='turbopack',timeout=2,
                command=[sys.executable,'-c','print("PRIVATE_CANARY"); raise SystemExit(7)'])
            reading={'pids':[os.getpid()],'limitBytes':13*1024**3,'swapLimitBytes':24*1024**3,'swapBytes':4096,'events':{},'cpuMax':[400000,100000],'cpuUsageUsec':{'usage_usec':10}}
            with patch.object(metrics,'cgroup_read',return_value=reading), patch.object(metrics,'host_memory',return_value={'availableBytes':4*1024**3,'swapUsedBytes':8192}):
                self.assertEqual(metrics.run(args),1)
            receipt=json.loads((root/'receipt.json').read_text())
            self.assertEqual(receipt['childExitCode'],7)
            self.assertEqual(receipt['swapObservation']['peakBytes'],8192)
            self.assertEqual(receipt['swapObservation']['peakSource'],'kernel')
            self.assertEqual(receipt['peakSampledSwapBytes'],4096)
            self.assertFalse(receipt['webpackObservation']['enabled'])
            self.assertNotIn('PRIVATE_CANARY',json.dumps(receipt))

class ProcessObservationTests(unittest.TestCase):
    def record(self, pid=123, start=456, state='S'):
        # Linux stat fields 3..22. The command deliberately contains parentheses.
        fields = [state, '1', '123', '123'] + ['0'] * 15 + [str(start)]
        return f'{pid} (PRIVATE_CANARY) with (parentheses)) ' + ' '.join(fields)

    def test_closed_projection_preserves_identity_and_discards_command(self):
        from io import StringIO
        with patch.object(Path, 'open', return_value=StringIO(self.record())):
            observed = metrics.observe_processes({123:456}, 'after_command')
        self.assertEqual(observed, {'stage':'after_command','total':1,'truncated':False,
            'identities':[{'pid':123,'startTimeTicks':456,'result':'present_same_identity',
                           'state':'S','ppid':1,'pgid':123,'sid':123}]})
        self.assertNotIn('PRIVATE_CANARY', json.dumps(observed))

    def test_missing_reused_unreadable_and_malformed_are_closed(self):
        from io import StringIO
        cases = [(FileNotFoundError('PRIVATE_CANARY'),'gone'),
                 (PermissionError('PRIVATE_CANARY'),'unreadable'),
                 (self.record(start=999),'identity_changed'),
                 (self.record(pid=999),'malformed'),
                 ('PRIVATE_CANARY','malformed'),
                 (self.record(state='SECRET'),'malformed'),
                 (self.record()+'X'*8193,'malformed')]
        for value, expected in cases:
            with self.subTest(expected=expected):
                options = {'side_effect':value} if isinstance(value,Exception) else {'return_value':StringIO(value)}
                with patch.object(Path,'open',**options):
                    result=metrics.observe_processes({123:456},'before_term')
                self.assertEqual(result['identities'][0]['result'],expected)
                self.assertNotIn('PRIVATE_CANARY',json.dumps(result))
                self.assertNotIn('state',result['identities'][0])

    def test_observation_is_bounded_and_never_classifies_zombie_as_success(self):
        from io import StringIO
        with patch.object(Path,'open',side_effect=FileNotFoundError()) as opened:
            result=metrics.observe_processes({i:456 for i in range(1,101)},'after_cleanup')
        self.assertEqual(opened.call_count,32)
        self.assertEqual(result['total'],100)
        self.assertTrue(result['truncated'])
        with patch.object(Path,'open',return_value=StringIO(self.record(state='Z'))):
            zombie=metrics.observe_processes({123:456},'after_command')
        self.assertEqual(zombie['identities'][0]['state'],'Z')
        self.assertFalse(metrics.successful(0,True,[123],{},[]))
        self.assertTrue(metrics.successful(0,True,[],{},[]))
        with self.assertRaises(ValueError):
            metrics.observe_processes({},'PRIVATE_CANARY')

    def test_run_keeps_failed_survivor_verdict_after_cleanup_zero(self):
        # Real child; cgroup and residual identity are explicit portable doubles.
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)
            args=SimpleNamespace(cgroup=str(root),report=str(root/'receipt.json'),phase='test',
                timeout=5,command=[sys.executable,'-c','raise SystemExit(0)'])
            reading={'pids':[os.getpid()],'limitBytes':1024,'swapBytes':0,'events':{}}
            def cleanup(_root,_child,observations=None):
                observations.append(metrics.observe_processes({},'after_cleanup'))
                return [],[]
            with patch.object(metrics,'cgroup_read',return_value=reading), \
                 patch.object(metrics,'host_memory',return_value={'availableBytes':1024,'swapUsedBytes':0}), \
                 patch.object(metrics,'identities',return_value={123:456}), \
                 patch.object(metrics,'terminate_owned',side_effect=cleanup):
                self.assertEqual(metrics.run(args),1)
            receipt=json.loads((root/'receipt.json').read_text())
            self.assertEqual(receipt['childExitCode'],0)
            self.assertEqual(receipt['descendantsAfterCommand'],1)
            self.assertEqual(receipt['descendantsAfterCleanup'],0)
            self.assertEqual(receipt['processObservations'][0]['stage'],'after_command')
            self.assertEqual(receipt['processObservations'][-1]['stage'],'after_cleanup')

    @unittest.skipUnless(sys.platform=='linux','real procfs observation requires Linux')
    def test_native_owned_child_and_zombie_observation_without_signalling_others(self):
        import time
        child=subprocess.Popen([sys.executable,'-c','import sys; print("ready",flush=True); sys.stdin.readline()'],
                               stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(),'ready')
            identity=metrics.identities([child.pid])
            self.assertEqual(list(identity),[child.pid])
            # This test also runs on the host before the isolated container.
            # Read the current unified leaf, which need not be the mount root.
            # Never allocate, migrate or signal any other cgroup member.
            current=[line[3:] for line in Path('/proc/self/cgroup').read_text().splitlines()
                     if line.startswith('0::')]
            self.assertEqual(len(current),1)
            self.assertTrue(current[0].startswith('/'))
            self.assertNotIn('..',current[0].split('/'))
            cgroup=Path('/sys/fs/cgroup')/current[0].lstrip('/')/'cgroup.procs'
            self.assertIn(child.pid,[int(pid) for pid in cgroup.read_text().split()])
            running=metrics.observe_processes(identity,'after_command')
            self.assertEqual(running['identities'][0]['result'],'present_same_identity')
            child.stdin.write('finish\n');child.stdin.flush()
            deadline=time.monotonic()+5
            while time.monotonic()<deadline:
                terminal=metrics.observe_processes(identity,'before_term')
                if terminal['identities'][0].get('state')=='Z':break
                time.sleep(.01)
            self.assertEqual(terminal['identities'][0]['state'],'Z')
            self.assertNotIn(child.pid,[int(pid) for pid in cgroup.read_text().split()])
            self.assertFalse(metrics.successful(0,True,[child.pid],{},[]))
            self.assertEqual(child.wait(timeout=5),0)
            self.assertEqual(metrics.observe_processes(identity,'after_cleanup')['identities'][0]['result'],'gone')
        finally:
            if child.poll() is None:child.kill()
            child.wait(timeout=5)
            child.stdin.close();child.stdout.close()

class PassiveDrainTests(unittest.TestCase):
    def run_owned(self, *, release=False, timeout=5, signal_stage=None, oom=False,
                  inventory_error=False, command_code=0, late_empty=False):
        # Real leader and waiting process, but a portable, dedicated cgroup double.
        # Linux additionally uses the real procfs identity/observation readers.
        import signal
        import threading
        import time
        waiting=subprocess.Popen([sys.executable,'-c',
            'import sys; print("ready",flush=True); sys.stdin.readline()'],
            stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
        timer=None
        seen=[]
        cleanup_live=[]
        original_observe=metrics.observe_processes
        original_identities=metrics.identities
        try:
            self.assertEqual(waiting.stdout.readline().strip(),'ready')
            with tempfile.TemporaryDirectory() as temporary:
                root=Path(temporary)
                args=SimpleNamespace(cgroup=str(root),report=str(root/'receipt.json'),phase='test',
                    timeout=timeout,command=[sys.executable,'-c',f'raise SystemExit({command_code})'])
                reads=0
                def reading(_root):
                    nonlocal reads
                    reads+=1
                    if inventory_error and 'after_command' in seen:
                        raise OSError('PRIVATE_CANARY')
                    pids=[os.getpid()]
                    if reads>1 and waiting.poll() is None:pids.append(waiting.pid)
                    return {'pids':pids,'limitBytes':1024,'swapBytes':0,
                            'events':{'oom_kill':int(oom and 'after_command' in seen)}}
                def identities(pids):
                    if sys.platform=='linux':return original_identities(pids)
                    return {pid:456 for pid in pids if pid!=os.getpid() and waiting.poll() is None}
                def observe(owned,stage):
                    nonlocal timer
                    seen.append(stage)
                    if stage=='after_command' and release:
                        def finish():
                            if waiting.poll() is None:
                                waiting.stdin.write('finish\n');waiting.stdin.flush()
                        timer=threading.Timer(.1,finish);timer.start()
                    if stage==signal_stage:os.kill(os.getpid(),signal.SIGTERM)
                    if sys.platform=='linux':return original_observe(owned,stage)
                    return {'stage':stage,'total':len(owned),'truncated':False,'identities':[]}
                def cleanup(_root,_child,observations=None):
                    cleanup_live.append(waiting.poll() is None)
                    if signal_stage=='cleanup':os.kill(os.getpid(),signal.SIGTERM)
                    if waiting.poll() is None:waiting.terminate()
                    waiting.wait(timeout=5)
                    observations.append(observe({},'after_cleanup'))
                    return [],[]
                began=time.monotonic()
                offset=0
                def sleep(seconds):
                    nonlocal offset
                    if late_empty and 'after_command' in seen and not offset:
                        waiting.stdin.write('finish\n');waiting.stdin.flush()
                        waiting.wait(timeout=5)
                        offset=3  # Deterministic scheduler stall beyond the 2s deadline.
                    else:time.sleep(seconds)
                with patch.object(metrics,'cgroup_read',side_effect=reading), \
                     patch.object(metrics,'time',SimpleNamespace(monotonic=lambda:time.monotonic()+offset,sleep=sleep)), \
                     patch.object(metrics,'host_memory',return_value={'availableBytes':1024,'swapUsedBytes':0}), \
                     patch.object(metrics,'sample_processes',return_value=(0,0)), \
                     patch.object(metrics,'identities',side_effect=identities), \
                     patch.object(metrics,'observe_processes',side_effect=observe), \
                     patch.object(metrics,'terminate_owned',side_effect=cleanup):
                    code=metrics.run(args)
                receipt=json.loads((root/'receipt.json').read_text())
                elapsed=time.monotonic()-began
                if timer is not None:timer.join(timeout=2)
                return code,receipt,waiting.poll(),cleanup_live,elapsed
        finally:
            if timer is not None:timer.cancel();timer.join(timeout=2)
            if waiting.poll() is None:waiting.terminate()
            waiting.wait(timeout=5)
            waiting.stdin.close();waiting.stdout.close()

    def test_natural_drain_waits_after_observation_without_signalling(self):
        code,receipt,child_code,cleanup_live,_=self.run_owned(release=True)
        self.assertEqual(code,0)
        self.assertEqual(child_code,0)
        self.assertEqual(cleanup_live,[False])
        self.assertEqual(receipt['descendantsAfterCommand'],1)
        self.assertEqual(receipt['descendantsAfterDrain'],0)
        self.assertEqual(receipt['drainOutcome'],'empty')
        self.assertEqual(receipt['processObservations'][1]['stage'],'after_drain')

    def test_persistent_descendant_fails_even_when_cleanup_is_zero(self):
        code,receipt,_,cleanup_live,elapsed=self.run_owned()
        self.assertEqual(code,1)
        self.assertEqual(receipt['descendantsAfterCommand'],1)
        self.assertEqual(receipt['descendantsAfterDrain'],1)
        self.assertEqual(receipt['descendantsAfterCleanup'],0)
        self.assertEqual(receipt['drainOutcome'],'grace_expired')
        self.assertEqual(cleanup_live,[True])
        self.assertGreaterEqual(receipt['drainSeconds'],2)
        self.assertLess(elapsed,4)

    def test_global_deadline_does_not_restart_after_command(self):
        code,receipt,_,_,elapsed=self.run_owned(timeout=.45)
        self.assertEqual(code,1)
        self.assertIn('timeout',receipt['errors'])
        self.assertLess(elapsed,1.5)

    def test_empty_first_observed_after_grace_deadline_is_not_success(self):
        code,receipt,child_code,_,_=self.run_owned(late_empty=True)
        self.assertEqual(child_code,0)
        self.assertEqual(code,1)
        self.assertEqual(receipt['drainOutcome'],'grace_expired')

    def test_interruption_after_command_and_during_cleanup_cannot_pass(self):
        for stage in ('after_command','after_drain','cleanup'):
            with self.subTest(stage=stage):
                code,receipt,_,_,_=self.run_owned(release=stage=='cleanup',signal_stage=stage)
                self.assertEqual(code,1)
                self.assertIn('interrupted',receipt['errors'])

    def test_oom_after_command_remains_a_failure_after_natural_drain(self):
        code,receipt,child_code,_,_=self.run_owned(release=True,oom=True)
        self.assertEqual(code,1)
        self.assertEqual(child_code,0)
        self.assertEqual(receipt['descendantsAfterDrain'],0)
        self.assertEqual(receipt['cgroup']['eventsDelta']['oom_kill'],1)

    def test_inventory_failure_and_nonzero_command_never_pass(self):
        for options in ({'inventory_error':True},{'command_code':3}):
            with self.subTest(options=options):
                code,receipt,_,_,_=self.run_owned(**options)
                self.assertEqual(code,1)
                self.assertNotIn('PRIVATE_CANARY',json.dumps(receipt))

    def test_cleanup_reused_identity_never_signals_another_process(self):
        # Portable procfs/cgroup doubles, real unrelated witness kept alive.
        witness=subprocess.Popen([sys.executable,'-c','import sys; sys.stdin.readline()'],
                                 stdin=subprocess.PIPE)
        try:
            record=ProcessObservationTests().record(pid=witness.pid,start=999)
            calls=iter([{witness.pid:456},{},{},{},{}])
            with patch.object(metrics,'cgroup_read',return_value={'pids':[witness.pid]}), \
                 patch.object(metrics,'identities',side_effect=lambda _:next(calls)), \
                 patch.object(Path,'read_text',return_value=record), \
                 patch.object(os,'kill') as sent:
                remaining,errors=metrics.terminate_owned(Path('/unused'))
            self.assertEqual(remaining,[])
            self.assertEqual(errors,[])
            sent.assert_not_called()
            self.assertIsNone(witness.poll())
        finally:
            witness.stdin.close()
            witness.wait(timeout=5)

class ProcfsExitRaceTests(unittest.TestCase):
    @staticmethod
    def stat(start):
        return '900002 (owned worker) ' + ' '.join(['S'] + ['0'] * 18 + [str(start)])

    def test_identity_esrch_does_not_fabricate_identity_or_retry(self):
        with patch.object(Path, 'read_text', side_effect=[
                ProcessLookupError(errno.ESRCH, 'fixture'), self.stat(42)]) as read:
            self.assertEqual(metrics.identities([900001, 900002]), {900002: 42})
        self.assertEqual(read.call_count, 2)

    def test_sample_esrch_preserves_other_process_measurements_without_retry(self):
        with patch.object(Path, 'read_text', side_effect=[
                'VmRSS: 3 kB\nVmHWM: 9 kB\n',
                ProcessLookupError(errno.ESRCH, 'fixture'),
                'VmRSS: 5 kB\nVmHWM: 7 kB\n']) as read:
            self.assertEqual(metrics.sample_processes([900001, 900002, 900003]),
                             (8 * 1024, 9 * 1024))
        self.assertEqual(read.call_count, 3)

    def test_non_esrch_errors_remain_fatal_at_both_read_boundaries(self):
        for function in (metrics.identities, metrics.sample_processes):
            for error in (PermissionError(errno.EACCES, 'fixture'),
                          OSError(errno.EIO, 'fixture'),
                          ProcessLookupError(errno.EIO, 'fixture'),
                          ProcessLookupError(), OSError('fixture')):
                with self.subTest(function=function.__name__, error=type(error).__name__,
                                  errno=error.errno):
                    with patch.object(Path, 'read_text', side_effect=error) as read:
                        with self.assertRaises(type(error)) as raised:
                            function([900001])
                        self.assertIs(raised.exception, error)
                    self.assertEqual(read.call_count, 1)

    def test_malformed_identity_and_measurements_remain_fatal(self):
        for function, value in ((metrics.identities, 'not a stat record'),
                                (metrics.sample_processes, 'VmRSS: unknown kB')):
            with self.subTest(function=function.__name__):
                with patch.object(Path, 'read_text', return_value=value):
                    with self.assertRaises(ValueError):
                        function([900001])

    def test_legacy_enoent_and_new_identity_are_not_replaced_with_cached_values(self):
        with patch.object(Path, 'read_text', side_effect=[
                self.stat(42), FileNotFoundError(), self.stat(43)]):
            self.assertEqual(metrics.identities([900002]), {900002: 42})
            self.assertEqual(metrics.identities([900002]), {})
            self.assertEqual(metrics.identities([900002]), {900002: 43})
        with patch.object(Path, 'read_text', side_effect=FileNotFoundError()):
            self.assertEqual(metrics.sample_processes([900001]), (0, 0))


class UIPhaseAdmissionTests(unittest.TestCase):
    def test_every_ui_phase_still_requires_real_cgroup_before_child(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)
            for phase in ('bootstrap','migrate','grants','metadata','baseline','seed','stage','cleanup','readback'):
                with self.subTest(phase=phase):
                    report=root/(phase+'.json');marker=root/(phase+'.started')
                    run=subprocess.run([sys.executable,str(HERE/'linux-build-metrics.py'),
                        '--cgroup',temporary,'--report',str(report),'--phase','ui-'+phase,
                        '--',sys.executable,'-c',f"from pathlib import Path;Path({str(marker)!r}).touch()"],capture_output=True,timeout=5)
                    self.assertNotEqual(run.returncode,0)
                    receipt=json.loads(report.read_text())
                    self.assertEqual(receipt['status'],'failed');self.assertFalse(receipt['normalCompletion'])
                    self.assertFalse(marker.exists())


class UINetworkPublicationTests(unittest.TestCase):
    def inspect(self, mode='realtime', networks=None, effective=None):
        source=(HERE/'run-linux-build.sh').read_text().split('ui_inspect() {',1)[1]
        code=source.split("<<'PYUI'\n",1)[1].split('\nPYUI',1)[0]
        prefix='memlia-build-abc123'
        port='3000' if mode=='web' else '3002'
        ports={} if mode=='cache' else {port+'/tcp':[{'HostIp':'127.0.0.1','HostPort':port}]}
        expected={prefix+'-ui':{}}
        if mode!='cache':expected[prefix+'-ui-front']={}
        raw={'State':{'Running':True,'OOMKilled':False},
             'Config':{'User':'1000:1000','Labels':{'org.memlia.ci':prefix}},
             'HostConfig':{'ReadonlyRootfs':True,'CapDrop':['ALL'],'SecurityOpt':['no-new-privileges:true'],
                           'Memory':128,'MemorySwap':128,'NanoCpus':500,'PidsLimit':16,'Init':True,'PortBindings':ports},
             'NetworkSettings':{'Networks':expected if networks is None else networks,
                                'Ports':ports if effective is None else effective}}
        with tempfile.TemporaryDirectory() as temporary:
            path=Path(temporary)/'inspect.json';path.write_text(json.dumps([raw]))
            with patch.object(sys,'argv',['-',str(path),prefix,mode,'128','500','16','1000:1000']):
                exec(compile(code,'<native-ui-inspect>','exec'),{})

    def test_services_require_both_networks_and_effective_loopback_publication(self):
        self.inspect();self.inspect('web');self.inspect('cache')
        for mode in ('web','realtime'):
            for effective in ({},{('3000' if mode=='web' else '3002')+'/tcp':None}):
                with self.subTest(mode=mode,effective=effective),self.assertRaises(AssertionError):
                    self.inspect(mode,effective=effective)

    def test_internal_only_services_and_frontend_cache_are_refused(self):
        with self.assertRaises(AssertionError):self.inspect(networks={'memlia-build-abc123-ui':{}})
        with self.assertRaises(AssertionError):self.inspect('cache',networks={'memlia-build-abc123-ui':{},'memlia-build-abc123-ui-front':{}})
        with self.assertRaises(AssertionError):self.inspect(networks={'foreign':{}})

    def test_service_start_attaches_only_owned_backend_and_frontend(self):
        source=(HERE/'run-linux-build.sh').read_text()
        function=source[source.index('ui_service() {'):source.index('ui_inspect() {')]
        with tempfile.TemporaryDirectory() as temporary:
            script='set -euo pipefail\n'+function+"""
prefix=memlia-build-abc123
private="$1";root=/owned/source;image=owned-image
containers=();ui_resources=()
ui_docker() { printf '%s\\n' "$@" >> "$private/argv"; }
ui_owns() { return 0; }
ui_inspect() { return 0; }
ui_service realtime 256m .5 96 /work/apps/realtime 3002 bun src/index.ts
"""
            result=subprocess.run(['bash','-c',script,'-',temporary],capture_output=True,timeout=3)
            self.assertEqual(result.returncode,0,result.stderr)
            args=(Path(temporary)/'argv').read_text().splitlines()
            networks=[args[i+1] for i,x in enumerate(args) if x=='--network']
            self.assertEqual(networks,['name=memlia-build-abc123-ui,alias=realtime','name=memlia-build-abc123-ui-front'])
            self.assertEqual(args[args.index('--publish')+1],'127.0.0.1:3002:3002')


    def test_frontend_gateway_is_the_only_host_rate_limit_scope(self):
        source=(HERE/'run-linux-build.sh').read_text().split('  current_stage=ui_network_identity',1)[1]
        code=source.split("<<'PYUI'\n",1)[1].split('\nPYUI',1)[0]
        prefix='memlia-build-abc123'
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);(root/'ui').mkdir()
            (root/'ui/credentials.private.json').write_text('{}')
            (root/'ui-network.log').write_text('a'*64+'\n')
            (root/'ui-front-network.log').write_text('b'*64+'\n')
            rows=[{'Id':'a'*64,'Internal':True,'Labels':{'org.memlia.ci':prefix},'IPAM':{'Config':[{'Gateway':'172.20.0.1'}]}},
                  {'Id':'b'*64,'Internal':False,'Labels':{'org.memlia.ci':prefix},'IPAM':{'Config':[{'Gateway':'172.21.0.1'}]}}]
            for foreign in (False,True):
                if foreign:rows[1]['Labels']={'org.memlia.ci':'foreign'}
                (root/'ui-networks-inspect.private.json').write_text(json.dumps(rows))
                with patch.object(sys,'argv',['-',str(root),prefix+'-ui',prefix+'-ui-front']):
                    if foreign:
                        with self.assertRaises(AssertionError):exec(compile(code,'<native-network-identity>','exec'),{})
                    else:exec(compile(code,'<native-network-identity>','exec'),{})
            self.assertEqual(json.loads((root/'ui/credentials.private.json').read_text())['socketBucketKeys'],
                             ['route:socket-token-ip:ip:172.21.0.1','route:socket-token-ip:ip:::ffff:172.21.0.1'])

    def test_frontend_cleanup_requires_recorded_id_and_owner(self):
        source=(HERE/'run-linux-build.sh').read_text()
        code=source[source.index('  if [[ "${ui_front_created:-0}"'):source.index('  if [[ "${ui_network_created:-0}"')]
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);(root/'ui-front-network.log').write_text('a'*64+'\n')
            for foreign in (False,True):
                script="""set -euo pipefail
private="$1"; prefix=memlia-build-abc123; ui_front_created=1; cleanup_ok=1
record="$2"
docker() { if [[ "$2" == inspect ]]; then printf '%s\\n' "$record"; else printf '%s\\n' "$@" > "$private/removed"; fi; }
"""+code+"\nprintf '%s' \"$cleanup_ok\"\n"
                record=('b' if foreign else 'a')*64+' memlia-build-abc123'
                removal=root/'removed';removal.unlink(missing_ok=True)
                result=subprocess.run(['bash','-c',script,'-',temporary,record],capture_output=True,timeout=3)
                self.assertEqual(result.returncode,0,result.stderr)
                self.assertEqual(result.stdout,b'0' if foreign else b'1')
                self.assertEqual(removal.exists(),not foreign)


class RealtimeConnectionDiagnostics(unittest.TestCase):
    def fragment(self):
        import ast
        source=(HERE/'run-linux-build.sh').read_text()
        block=source.split('  python3 - "$readiness_seconds"',1)[1].split("<<'PYUI'\n",1)[1].split('\nPYUI',1)[0]
        tree=ast.parse(block)
        helper=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='diagnose_realtime')
        return block,compile(ast.Module(body=[helper],type_ignores=[]),'<native-readiness>','exec')

    def exercise(self, mutation=None, expired=False, local_extra=False, symlink=False, whole=False, late_owner=False, command_timeout=False, command_failure=None):
        import contextlib,io,time,stat,http.client
        block,helper=self.fragment()
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);identity='a'*64;prefix='memlia-build-abc123'
            (root/'ui-realtime-start.log').write_text(identity+'\n')
            foreign=root/'foreign';foreign.write_text('untouched')
            if symlink:(root/'ui-realtime-connection.private.json').symlink_to(foreign)
            clock=[10.0];calls=[];connections=[]
            owner={'id':identity,'image':'image@sha256:'+'b'*64,'owner':prefix,'running':True,
                   'networks':{prefix+'-ui':{'NetworkID':'c'*64},prefix+'-ui-front':{'NetworkID':'d'*64}},
                   'ports':{'3002/tcp':[{'HostIp':'127.0.0.1','HostPort':'3002'}]}}
            if mutation:mutation(owner)
            def run(argv,**kwargs):
                calls.append((argv,kwargs));self.assertGreater(kwargs['timeout'],0);self.assertLessEqual(kwargs['timeout'],2)
                if command_timeout:raise subprocess.TimeoutExpired(argv,kwargs['timeout'],output=b'PRIVATE_CANARY_timeout_stdout',stderr=b'PRIVATE_CANARY_timeout_stderr')
                if command_failure:
                    stdout,stderr,code=command_failure
                    return SimpleNamespace(returncode=code,stdout=stdout,stderr=stderr)
                if argv[1]=='inspect':
                    data=dict(owner)
                    if late_owner and len(calls)>1:data['owner']='replaced'
                else:
                    self.assertEqual(argv[1:4],['exec',identity,'/usr/local/bin/node'])
                    data={'httpStatus':200,'errorCode':None}
                    if local_extra:data['message']='PRIVATE_CANARY_DSN'
                return SimpleNamespace(returncode=0,stdout=json.dumps(data).encode(),stderr=b'')
            class Connection:
                def __init__(self,host,port,timeout):connections.append(host);self.host=host;self.sock=None
                def request(self,*args):
                    if self.host=='localhost':raise ConnectionRefusedError(61,'PRIVATE_CANARY_DSN')
                def getresponse(self):return SimpleNamespace(status=200)
                def close(self):pass
            argv=['-', '1', str(root/'readiness.json'), str(root),prefix,owner['image']]
            # Expected image is independently captured, never taken from mutated inspect.
            argv[-1]='image@sha256:'+'b'*64
            ns={'http':__import__('http'),'json':json,'time':time,'sys':SimpleNamespace(argv=argv),
                'Path':Path,'os':os,'stat':stat,'subprocess':subprocess,'re':__import__('re'),
                'started':10.0,'end':10.0 if expired else 20.0}
            output=io.StringIO();native_loads=json.loads
            def guarded_loads(data,*args,**kwargs):
                if isinstance(data,bytes):
                    captured=root/('ui-realtime-command-'+str(len(calls))+'.private.json')
                    self.assertTrue(captured.exists(),'command trace must precede JSON parsing')
                return native_loads(data,*args,**kwargs)
            with patch.object(subprocess,'run',run),patch.object(http.client,'HTTPConnection',Connection), \
                 patch.object(time,'monotonic',lambda:clock[0]),patch.object(time,'sleep',lambda n:clock.__setitem__(0,clock[0]+n)), \
                 patch.object(sys,'argv',argv),patch.object(json,'loads',guarded_loads),contextlib.redirect_stdout(output):
                if whole:
                    with self.assertRaises(SystemExit):exec(compile(block,'<native-readiness>','exec'),ns)
                else:
                    exec(helper,ns);ns['diagnose_realtime'](ConnectionRefusedError(61,'PRIVATE_CANARY_DSN'))
            public=output.getvalue();self.assertNotIn('PRIVATE_CANARY',public)
            records=[json.loads((root/'ui-realtime-connection.json').read_text())]
            self.assertNotIn('PRIVATE_CANARY',json.dumps(records))
            target=root/'ui-realtime-connection.private.json'
            evidence=None if target.is_symlink() or not target.exists() else json.loads(target.read_text())
            mode=None if evidence is None else stat.S_IMODE(target.stat().st_mode)
            result=json.loads((root/'readiness.json').read_text()) if whole else None
            if evidence is not None:
                evidence['commands']=[json.loads(p.read_text()) for p in sorted(root.glob('ui-realtime-command-*.private.json'))]
                self.assertTrue(all(stat.S_IMODE(p.stat().st_mode)==0o600 for p in root.glob('ui-realtime-command-*.private.json')))
            self.assertEqual(foreign.read_text(),'untouched')
            return records,calls,connections,evidence,mode,result

    def test_real_fragment_preserves_private_error_before_closed_pair(self):
        records,calls,connections,private,mode,_=self.exercise()
        self.assertEqual(len(records),1);r=records[0]
        self.assertEqual(r['status'],'observed');self.assertEqual(r['hostHttpStatus'],200)
        self.assertEqual(r['localHttpStatus'],200);self.assertTrue(r['publishedIPv4Matched'])
        self.assertTrue(r['namespaceMatched']);self.assertTrue(r['ownerVerified'])
        self.assertIn('PRIVATE_CANARY',private['message']);self.assertEqual(mode,0o600)
        self.assertEqual(connections,['127.0.0.1']);self.assertEqual(len(calls),3)

    def test_foreign_identity_image_label_or_namespace_never_executes_probe(self):
        for key,value in [('id','d'*64),('image','foreign'),('owner','foreign'),('networks',{'foreign':{}})]:
            with self.subTest(key=key):
                records,calls,connections,_,_,_=self.exercise(lambda o:o.update({key:value}))
                self.assertEqual(records[0]['status'],'refused');self.assertEqual(connections,[])
                self.assertFalse(any(c[0][1]=='exec' for c in calls))

    def test_expired_budget_preserves_error_without_any_external_call(self):
        records,calls,connections,private,_,_=self.exercise(expired=True)
        self.assertEqual(records[0]['status'],'budget_expired');self.assertEqual(calls,[])
        self.assertEqual(connections,[]);self.assertIsNotNone(private)

    def test_effective_port_mismatch_is_evidence_not_owner_bypass(self):
        records,calls,connections,*_=self.exercise(lambda o:o.update(ports={}))
        self.assertEqual(records[0]['status'],'refused');self.assertFalse(records[0]['publishedIPv4Matched'])
        self.assertEqual(connections,[]);self.assertEqual(len(calls),1)

    def test_foreign_local_output_and_preexisting_private_symlink_refuse(self):
        records,*_=self.exercise(local_extra=True);self.assertEqual(records[0]['status'],'refused')
        records,calls,connections,*_=self.exercise(symlink=True)
        self.assertEqual(records[0]['status'],'refused');self.assertEqual(calls,[]);self.assertEqual(connections,[])

    def test_owner_change_after_exec_and_external_timeout_are_not_observed(self):
        records,*_=self.exercise(late_owner=True)
        self.assertEqual(records[0]['status'],'refused');self.assertIsNone(records[0]['localHttpStatus'])
        records,calls,connections,*_=self.exercise(command_timeout=True)
        self.assertEqual(records[0]['status'],'budget_expired');self.assertEqual(connections,[])
        self.assertEqual(len(calls),1)
        import base64
        records,_,_,private,_,_=self.exercise(command_timeout=True)
        command=private['commands'][0];self.assertTrue(command['timedOut'])
        self.assertIn(b'PRIVATE_CANARY_timeout',base64.b64decode(command['stdoutBase64']))
        self.assertIn(b'PRIVATE_CANARY_timeout',base64.b64decode(command['stderrBase64']))
        for stdout,stderr,code in [(b'PRIVATE_CANARY_bad_json',b'PRIVATE_CANARY_stderr',0),
                                   (b'PRIVATE_CANARY_nonzero',b'PRIVATE_CANARY_stderr',2),
                                   (b'x'*9000,b'y'*2000,0)]:
            records,_,connections,private,_,_=self.exercise(command_failure=(stdout,stderr,code))
            self.assertEqual(records[0]['status'],'refused');self.assertEqual(connections,[])
            command=private['commands'][0]
            self.assertEqual(base64.b64decode(command['stdoutBase64']),stdout[:8193])
            self.assertEqual(base64.b64decode(command['stderrBase64']),stderr[:1025])
            self.assertEqual(command['stdoutTruncated'],len(stdout)>8192)
            self.assertEqual(command['stderrTruncated'],len(stderr)>1024)
            self.assertEqual(command['returnCode'],code)

    def test_both_existing_readers_reject_canaries_unknown_fields_and_bounds(self):
        spec=importlib.util.spec_from_file_location('chat_ci_projection',HERE/'test-linux-chat-ci.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        value=self.exercise()[0][0]
        readers=[lambda value=None,**kw:module.ClosedPublication().emit(value,name='ui-realtime-connection',**kw),
                 lambda value=None,**kw:module.ClosedReadinessPublication().emit('ui-realtime-connection.json',value,**kw)]
        for emit in readers:
            accepted=emit(value);self.assertEqual(accepted.returncode,0);self.assertEqual(json.loads(accepted.stdout),value)
            for bad in [[],{**value,'secret':'PRIVATE_CANARY'}, {**value,'phase':'PRIVATE_CANARY'},
                        {**value,'hostErrorCode':'PRIVATE_CANARY'},{**value,'elapsedMs':True},
                        {**value,'elapsedMs':180001},{**value,'hostHttpStatus':True},
                        {**value,'ownerVerified':False},{**value,'namespaceMatched':1},
                        {**value,'localHttpStatus':None},{**value,'status':'passed'}]:
                rejected=emit(bad);self.assertNotEqual(rejected.returncode,0)
                self.assertNotIn('PRIVATE_CANARY',rejected.stdout+rejected.stderr)
            for kw in ({'raw':' '*4097},{'link':True}):self.assertNotEqual(emit(value,**kw).returncode,0)

    def test_pair_success_does_not_replace_failed_readiness_and_runs_once(self):
        records,_,_,_,_,result=self.exercise(whole=True)
        self.assertEqual(len(records),1);self.assertEqual(records[0]['localHttpStatus'],200)
        self.assertEqual(result['status'],'failed');self.assertEqual(result['errorClass'],'connection')

if __name__ == '__main__':
    unittest.main()
