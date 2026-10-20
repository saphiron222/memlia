# Copyright 2026 Memlia. All rights reserved.
"""Real shell result boundary; no Docker, database or browser qualification."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
HERE=Path(__file__).parent
class ChatCI(unittest.TestCase):
    def result(self,selected,passed):
        source=(HERE/'run-linux-build.sh').read_text()
        cleanup=source[source.index('cleanup() {'):source.index('trap cleanup EXIT')]
        with tempfile.TemporaryDirectory() as d:
            p=Path(d);(p/'metrics').mkdir();(p/'memlia-build.test').mkdir()
            script=('set -eo pipefail\nRUNNER_TEMP="$1"; metrics="$1/metrics"; private="$1/memlia-build.test"\n'
                    'containers=(); network_created=0; completed=1; current_stage=completed; next_started=1; standalone_verified=1\n'
                    f'ui_selected={selected}; ui_verified={passed}; ui_seeded=0; ui_resources=()\n'+cleanup+'\ntrue\ncleanup\n')
            run=subprocess.run(['bash','-c',script,'test',d],capture_output=True,timeout=10)
            return run.returncode,json.loads((p/'metrics/result.json').read_text())
    def test_selected_ui_missing_or_failed_never_reports_build_success(self):
        code,receipt=self.result(1,0)
        self.assertNotEqual(code,0);self.assertEqual(receipt['status'],'failed')
    def test_complete_ui_and_existing_smoke_are_both_required(self):
        code,receipt=self.result(1,1)
        self.assertEqual(code,0);self.assertTrue(receipt.get('uiVerified'))
    def test_unselected_legacy_build_keeps_its_behavior(self):
        code,receipt=self.result(0,0)
        self.assertEqual(code,0);self.assertEqual(receipt['status'],'passed')


class ClosedPublication(unittest.TestCase):
    def emit(self,value=None,raw=None,link=False):
        workflow=(HERE.parent.parent/'.github/workflows/memlia-linux-build.yml').read_text()
        code=workflow.split('      - name: Lire uniquement les reçus UI fermés\n',1)[1].split("          python3 - <<'PY'\n",1)[1].split("          PY\n",1)[0]
        code='\n'.join(line[10:] for line in code.splitlines())
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);metrics=root/'memlia-metrics';metrics.mkdir()
            target=metrics/'chat-ui.json'
            if link:
                (root/'foreign').write_text(json.dumps(value));target.symlink_to(root/'foreign')
            else:target.write_text(raw if raw is not None else json.dumps(value))
            return subprocess.run([__import__('sys').executable,'-c',code],env={'RUNNER_TEMP':temporary},capture_output=True,text=True,timeout=5)
    def valid(self):
        return dict(status='passed',reason=None,authenticated=True,socket=True,workflow=True,canvas=True,chatRefused=True,browserClosed=True)
    def test_closed_success_published(self):
        run=self.emit(self.valid());self.assertEqual(run.returncode,0)
        self.assertEqual(json.loads(run.stdout)['phase'],'chat-ui')
    def test_malformed_unknown_and_partial_success_never_published(self):
        examples=[{**self.valid(),'password':'CANARY'}, {**self.valid(),'canvas':False},
                  {**self.valid(),'socket':1}, {**self.valid(),'reason':'CANARY'}, [],
                  {k:v for k,v in self.valid().items() if k!='browserClosed'}]
        for value in examples:
            with self.subTest(value_type=type(value).__name__):
                run=self.emit(value);self.assertNotEqual(run.returncode,0)
                self.assertNotIn('CANARY',run.stdout+run.stderr)
    def test_byte_limit_and_symlink_refused(self):
        self.assertNotEqual(self.emit(raw=' '*4097).returncode,0)
        self.assertNotEqual(self.emit(self.valid(),link=True).returncode,0)
    def test_failure_receipt_is_observation_not_success(self):
        value={**self.valid(),'status':'failed','reason':'journey_failed','canvas':False}
        run=self.emit(value);self.assertEqual(run.returncode,0)
        self.assertEqual(json.loads(run.stdout)['status'],'failed')

class DeadlineAndOwnership(unittest.TestCase):
    def test_total_remaining_budget_reserves_cleanup_and_never_extends(self):
        source=(HERE/'run-linux-build.sh').read_text()
        function=source[source.index('ui_remaining() {'):source.index('ui_docker() {')]
        run=subprocess.run(['bash','-c',function+"\nSECONDS=10; ui_deadline=1200; ui_remaining 900 150; ui_remaining 1800 150; ui_deadline=160; ui_remaining 900 150"],capture_output=True,text=True,timeout=5)
        self.assertEqual(run.stdout.splitlines(),['900','1040']);self.assertNotEqual(run.returncode,0)
    def test_cleanup_failure_is_retained_when_exit_trap_calls_cleanup_again(self):
        source=(HERE/'run-linux-build.sh').read_text()
        function=source[source.index('ui_close() {'):source.index('run_product_phases() {')]
        script='ui_deadline=1200; ui_seeded=1; ui_resources=(); phase() { return 1; }; '+function+'\nui_close; first=$?; ui_close; second=$?; printf "%s %s" "$first" "$second"'
        run=subprocess.run(['bash','-c',script],capture_output=True,text=True,timeout=5)
        self.assertEqual(run.stdout,'1 1')

    def test_identity_requires_exact_nonce_and_container_id(self):
        source=(HERE/'run-linux-build.sh').read_text()
        function=source[source.index('ui_owns() {'):source.index('ui_close() {')]
        with tempfile.TemporaryDirectory() as d:
            p=Path(d);(p/'ui-web-start.log').write_text('a'*64+'\n')
            for identity,expected in [('a'*64+' owned',0),('b'*64+' owned',1),('a'*64+' foreign',1)]:
                script='prefix=owned; private="$1"; ui_docker() { printf "%s\\n" "$2"; }; '+function+'\nui_docker() { printf "%s\\n" "$identity"; }; identity="$2"; ui_owns owned-ui-web'
                run=subprocess.run(['bash','-c',script,'test',d,identity],capture_output=True,timeout=5)
                self.assertEqual(run.returncode,expected)


class ReviewRegressions(unittest.TestCase):
    def test_install_resolves_hoisted_cli_and_checks_version_before_launch(self):
        import shutil
        source=(HERE/'run-linux-build.sh').read_text()
        install=source[source.index('  export PLAYWRIGHT_BROWSERS_PATH='):source.index('  current_stage=ui_prepare')]
        node=shutil.which('node');self.assertIsNotNone(node)
        for version,code in [('1.61.1',0),('1.61.0',1)]:
            with self.subTest(version=version), tempfile.TemporaryDirectory() as d:
                root=Path(d);app=root/'apps/sim';app.mkdir(parents=True);(app/'package.json').write_text('{}')
                package=root/'node_modules/@playwright/test';package.mkdir(parents=True)
                (package/'package.json').write_text(json.dumps({'name':'@playwright/test','version':version,'exports':{'./package.json':'./package.json','./cli':'./cli.js'}}))
                (package/'cli.js').write_text("require('node:fs').writeFileSync(process.env.PLAYWRIGHT_BROWSERS_PATH+'.called',JSON.stringify(process.argv.slice(2)))")
                script='set -eo pipefail; root="$1"; private="$1"; ui_node="$2"; ui_remaining() { echo 1; }; timeout() { shift 2; "$@"; }; install_cli() { '+install+'\n}; install_cli'
                run=subprocess.run(['bash','-c',script,'test',d,node],capture_output=True,text=True,timeout=5)
                self.assertEqual(run.returncode==0,code==0)
                called=root/'chromium.called'
                self.assertEqual(called.exists(),code==0)
                if code==0:self.assertEqual(json.loads(called.read_text()),['install','--with-deps','chromium'])

    def test_cache_checked_and_stopped_after_fixture_cleanup(self):
        source=(HERE/'run-linux-build.sh').read_text()
        functions=source[source.index('ui_close() {'):source.index('run_product_phases() {')]
        for running,oom,owned,expected in [(True,False,True,0),(False,False,True,1),(True,True,True,1),(True,False,False,1)]:
            with self.subTest(running=running,oom=oom,owned=owned), tempfile.TemporaryDirectory() as d:
                state=json.dumps({'Running':running,'OOMKilled':oom,'Error':''})
                script='ui_deadline=1200; ui_seeded=1; ui_resources=(); ui_cache_started=1; prefix=owned; private="$1"; state="$2"; owned="$3"\nui_owns() { [[ "$owned" == 1 ]]; }\nui_docker() { printf \'%s %s\\n\' "$1" "${@: -1}" >> "$private/events"; if [[ "$1" == inspect ]]; then printf \'%s\' "$state"; fi; }\nphase() { printf \'%s\\n\' "$1" >> "$private/events"; }\n'+functions+'\nui_close; result=$?; cat "$private/events"; exit "$result"'
                run=subprocess.run(['bash','-c',script,'test',d,state,'1' if owned else '0'],capture_output=True,text=True,timeout=5)
                self.assertEqual(run.returncode,expected)
                events=run.stdout.splitlines()
                self.assertEqual(events[:2],['ui-cleanup','ui-readback'])
                if owned:self.assertEqual(events[2:],['inspect owned-ui-cache','stop owned-ui-cache'])
                else:self.assertEqual(len(events),2)


class UIServiceDiagnostics(unittest.TestCase):
    def run_cleanup(self, stage):
        source=(HERE/'run-linux-build.sh').read_text()
        cleanup=source[source.index('cleanup() {'):source.index('trap cleanup EXIT')]
        with tempfile.TemporaryDirectory() as d:
            p=Path(d);(p/'metrics').mkdir();(p/'memlia-build.test').mkdir()
            script=('set -eo pipefail\nRUNNER_TEMP="$1"; metrics="$1/metrics"; private="$1/memlia-build.test"\n'
                    'containers=(); network_created=0; completed=0; next_started=1; standalone_verified=1\n'
                    'ui_selected=1; ui_verified=0; ui_seeded=0; ui_resources=(); current_stage="$2"\n'
                    'ui_close() { current_stage=phase_ui-readback; return 0; }\n'
                    +cleanup+'\ntrap cleanup EXIT\nexit 17\n')
            run=subprocess.run(['bash','-c',script,'stage-test',d,stage],capture_output=True,text=True,timeout=5)
            target=p/'metrics/result.json'
            return run,json.loads(target.read_text()) if target.exists() else None

    def test_cleanup_keeps_primary_failure_stage_before_native_readback(self):
        run,receipt=self.run_cleanup('ui_services')
        self.assertNotEqual(run.returncode,0)
        self.assertEqual(receipt['stage'],'ui_services')
        self.assertEqual(receipt['exitCode'],17)
        self.assertEqual(receipt['status'],'failed')
        self.assertTrue(receipt['cleanup'])

    def test_unknown_primary_stage_refuses_closed_receipt_without_leaking_value(self):
        run,receipt=self.run_cleanup('ui_PRIVATE_CANARY_stage')
        self.assertNotEqual(run.returncode,0);self.assertIsNone(receipt)
        self.assertNotIn('PRIVATE_CANARY',run.stdout+run.stderr)

    def test_each_real_service_boundary_keeps_its_fixed_failure_stage(self):
        source=(HERE/'run-linux-build.sh').read_text()
        command=source.index('  ui_docker network create --internal')
        start=source.rfind('\n  current_stage=',0,command)+1
        block=source[start:source.index('  current_stage=ui_readiness',command)]
        cleanup=source[source.index('cleanup() {'):source.index('trap cleanup EXIT')]
        # The shell fragment is native. Only external Docker/inspect calls are doubled.
        steps={'network_create':'ui_network_create','network_connect':'ui_network_connect',
               'network_identity':'ui_network_identity','cache_pull':'ui_cache_pull',
               'cache_start':'ui_cache_start','cache_inspect':'ui_cache_inspect',
               'realtime':'ui_realtime','web':'ui_web'}
        for failure,expected in steps.items():
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as d:
                p=Path(d);(p/'metrics').mkdir();(p/'memlia-build.test').mkdir()
                setup=r"""set -eo pipefail
RUNNER_TEMP="$1"; metrics="$1/metrics"; private="$1/memlia-build.test"; failure="$2"; prefix=owned
containers=(); network_created=0; completed=0; next_started=1; standalone_verified=1
ui_selected=1; ui_verified=0; ui_seeded=0; ui_resources=(); current_stage=phase_ui-stage
step() { [[ "$failure" != "$1" ]] || return 17; }
ui_docker() {
  case "$1 $2" in
    'network create') step network_create; printf networkid;;
    'network connect') step network_connect;;
    'pull --platform') step cache_pull;;
    'run -d') step cache_start; printf '%064d\n' 0;;
    *) return 91;;
  esac
}
python3() { if [[ "${2:-}" == "$private" ]]; then step network_identity; else command python3 "$@"; fi; }
ui_owns() { return 0; }
ui_inspect() { step cache_inspect; }
ui_service() { step "$1"; }
docker() { if [[ "$1 $2" == 'network inspect' ]]; then printf 'networkid owned'; fi; }
ui_close() { current_stage=phase_ui-readback; return 0; }
"""
                script=setup+cleanup+'\ntrap cleanup EXIT\nservices() {\n'+block+'\n}\nservices\n'
                run=subprocess.run(['bash','-c',script,'services-test',d,failure],capture_output=True,text=True,timeout=5)
                self.assertNotEqual(run.returncode,0)
                receipt=json.loads((p/'metrics/result.json').read_text())
                self.assertEqual(receipt['stage'],expected)
                self.assertEqual(receipt['exitCode'],17)
                self.assertEqual(receipt['status'],'failed')

if __name__=='__main__':unittest.main()
