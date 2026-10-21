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
    def emit(self,value=None,raw=None,link=False,name="chat-ui"):
        workflow=(HERE.parent.parent/'.github/workflows/memlia-linux-build.yml').read_text()
        code=workflow.split('      - name: Lire uniquement les reçus UI fermés\n',1)[1].split("          python3 - <<'PY'\n",1)[1].split("          PY\n",1)[0]
        code='\n'.join(line[10:] for line in code.splitlines())
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);metrics=root/'memlia-metrics';metrics.mkdir()
            target=metrics/(name+'.json')
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

    def test_readiness_and_service_receipts_are_collected_with_closed_fields(self):
        cases={
            'ui-readiness':dict(phase='ui-readiness',status='failed',service='realtime',httpStatus=503,errorClass=None),
            **{'ui-service-'+service:dict(phase='ui-service-state',service=service,running=False,oomKilled=False,errorPresent=True)
               for service in ('web','realtime','cache')},
        }
        for name,value in cases.items():
            with self.subTest(name=name):
                run=self.emit(value,name=name)
                self.assertEqual(run.returncode,0)
                self.assertEqual(json.loads(run.stdout),value)

    def test_diagnostic_receipts_refuse_unbounded_fields_types_links_and_success_claims(self):
        readiness=dict(phase='ui-readiness',status='failed',service='web',httpStatus=401,errorClass=None)
        service=dict(phase='ui-service-state',service='web',running=False,oomKilled=False,errorPresent=False)
        cases=[('ui-readiness',{**readiness,'message':'PRIVATE_CANARY'}),
               ('ui-readiness',{**readiness,'httpStatus':True}),
               ('ui-readiness',{**readiness,'errorClass':'PRIVATE_CANARY'}),
               ('ui-readiness',{**readiness,'status':'passed'}),
               ('ui-service-web',{**service,'service':'cache'}),
               ('ui-service-web',{**service,'running':1}),
               ('ui-service-web',{**service,'error':'PRIVATE_CANARY'})]
        for name,value in cases:
            with self.subTest(name=name,fields=tuple(value)):
                run=self.emit(value,name=name)
                self.assertNotEqual(run.returncode,0)
                self.assertNotIn('PRIVATE_CANARY',run.stdout+run.stderr)
        for name,value in [('ui-readiness',readiness),('ui-service-web',service)]:
            self.assertNotEqual(self.emit(value,name=name,link=True).returncode,0)
            self.assertNotEqual(self.emit(name=name,raw=' '*4097).returncode,0)

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
                script='ui_deadline=1200; ui_seeded=1; ui_resources=(); ui_cache_started=1; prefix=owned; private="$1"; metrics="$1"; state="$2"; owned="$3"\nui_owns() { [[ "$owned" == 1 ]]; }\nui_docker() { printf \'%s %s\\n\' "$1" "${@: -1}" >> "$private/events"; if [[ "$1" == inspect ]]; then printf \'%s\' "$state"; fi; }\nphase() { printf \'%s\\n\' "$1" >> "$private/events"; }\n'+functions+'\nui_close; result=$?; cat "$private/events"; exit "$result"'
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
    'network inspect')
      [[ "$#" == 4 && "$3" == "$prefix-ui" && "$4" == "$prefix-ui-front" ]] || return 91
      printf '%s\n' "$3" "$4" > "$metrics/network-inspect-targets"
      printf '[]';;
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
                targets=p/'metrics/network-inspect-targets'
                if failure in ('network_create','network_connect'):
                    self.assertFalse(targets.exists())
                else:
                    self.assertEqual(targets.read_text().splitlines(),['owned-ui','owned-ui-front'])

class UIReadinessDiagnostics(unittest.TestCase):
    def readiness(self, statuses, error=None):
        source=(HERE/'run-linux-build.sh').read_text()
        block=source.split('  python3 - "$readiness_seconds"',1)[1].split("<<'PYUI'\n",1)[1].split('\nPYUI',1)[0]
        with tempfile.TemporaryDirectory() as temporary:
            target=Path(temporary)/'readiness.json'
            # The production HTTP loop is intact; no host listener, Docker or real time wait.
            prefix="""import http.client,json,sys,time
clock=[0.0]
time.monotonic=lambda:clock[0]
time.sleep=lambda seconds:clock.__setitem__(0,clock[0]+seconds)
class Connection:
    def __init__(self,host,port,timeout):self.port=port
    def request(self,*args):
        if probe_error_type is not None:raise probe_error_type('PRIVATE_CANARY_body_or_url')
    def getresponse(self):return type('Response',(),{'status':statuses[str(self.port)]})()
    def close(self):pass
http.client.HTTPConnection=Connection
"""
            setup='import http.client\nstatuses='+repr(statuses)+'\nprobe_error_type='+('None' if error is None else error)+'\n'
            run=subprocess.run([__import__('sys').executable,'-c',setup+prefix+block,'1',str(target)],capture_output=True,text=True,timeout=5)
            return run,json.loads(target.read_text()) if target.exists() else None

    def test_success_names_the_last_service_and_records_only_closed_http_fields(self):
        run,receipt=self.readiness({'3002':200,'3000':200})
        self.assertEqual(run.returncode,0)
        self.assertEqual(receipt,dict(phase='ui-readiness',status='passed',service='web',httpStatus=200,errorClass=None))

    def test_failure_identifies_the_exact_service_and_last_http_status(self):
        for statuses,service in [({'3002':503,'3000':200},'realtime'),({'3002':200,'3000':401},'web')]:
            with self.subTest(service=service):
                run,receipt=self.readiness(statuses)
                self.assertNotEqual(run.returncode,0)
                self.assertEqual(receipt,dict(phase='ui-readiness',status='failed',service=service,httpStatus=statuses['3002' if service=='realtime' else '3000'],errorClass=None))
                self.assertNotIn('PRIVATE_CANARY',run.stdout+run.stderr)

    def test_transport_classes_never_print_exception_messages(self):
        for error,kind in [('TimeoutError','timeout'),('ConnectionRefusedError','connection'),('http.client.HTTPException','http'),('OSError','os'),('RuntimeError','unexpected')]:
            with self.subTest(kind=kind):
                run,receipt=self.readiness({'3002':200,'3000':200},error)
                self.assertNotEqual(run.returncode,0)
                self.assertIsNotNone(receipt)
                self.assertEqual(receipt['errorClass'],kind)
                self.assertIsNone(receipt['httpStatus'])
                self.assertEqual(receipt['service'],'realtime')
                self.assertNotIn('PRIVATE_CANARY',run.stdout+run.stderr)

    def test_service_state_is_observed_only_after_identity_check_and_before_stop(self):
        source=(HERE/'run-linux-build.sh').read_text()
        function=source[source.index('ui_stop_owned() {'):source.index('run_product_phases() {')]
        for mode,running,oom,error,owned,expected in [('web',True,False,'',True,0),('realtime',False,False,'',True,1),('cache',True,True,'PRIVATE_CANARY',True,1),('web',True,False,'',False,1)]:
            with self.subTest(mode=mode,owned=owned),tempfile.TemporaryDirectory() as temporary:
                root=Path(temporary);metrics=root/'metrics';metrics.mkdir()
                state=json.dumps({'Running':running,'OOMKilled':oom,'Error':error})
                setup='prefix=owned; private="$1"; metrics="$1/metrics"; state="$2"; owned="$3"\nui_owns() { [[ "$owned" == 1 ]]; }\nui_docker() { if [[ "$1" == inspect ]]; then printf "%s" "$state"; else printf stop >> "$private/stop"; fi; }\n'
                run=subprocess.run(['bash','-c',setup+function+'\nui_stop_owned "$4"','state-test',temporary,state,'1' if owned else '0','owned-ui-'+mode],capture_output=True,text=True,timeout=5)
                self.assertEqual(run.returncode,expected)
                target=metrics/('ui-service-'+mode+'.json')
                self.assertEqual(target.exists(),owned)
                if owned:self.assertEqual(json.loads(target.read_text()),dict(phase='ui-service-state',service=mode,running=running,oomKilled=oom,errorPresent=bool(error)))
                self.assertEqual((root/'stop').exists(),owned)
                self.assertNotIn('PRIVATE_CANARY',run.stdout+run.stderr)

class ClosedReadinessPublication(unittest.TestCase):
    def emit(self, name, value=None, raw=None, link=False):
        source=(HERE/'run-linux-build.sh').read_text()
        code=source.split('  # Only our fixed-schema JSON receipts are shown; no raw build logs/artifacts.\n',1)[1].split("<<'PY' || receipt_ok=0\n",1)[1].split('\nPY',1)[0]
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);metrics=root/'metrics';metrics.mkdir();target=metrics/name
            if link:
                (root/'foreign').write_text(json.dumps(value));target.symlink_to(root/'foreign')
            else:target.write_text(raw if raw is not None else json.dumps(value))
            return subprocess.run([__import__('sys').executable,'-c',code,str(metrics)],capture_output=True,text=True,timeout=5)

    def test_readiness_and_service_states_cross_only_the_fixed_projection(self):
        examples=[('ui-readiness.json',dict(phase='ui-readiness',status='failed',service='realtime',httpStatus=503,errorClass=None)),
                  ('ui-service-web.json',dict(phase='ui-service-state',service='web',running=True,oomKilled=False,errorPresent=False))]
        for name,value in examples:
            with self.subTest(name=name):
                run=self.emit(name,value);self.assertEqual(run.returncode,0);self.assertEqual(json.loads(run.stdout),value)
                for bad in [{**value,'body':'PRIVATE_CANARY'},{**value,'phase':'PRIVATE_CANARY'},
                            {**value,'httpStatus':True} if name=='ui-readiness.json' else {**value,'running':1},
                            {**value,'service':'PRIVATE_CANARY'},
                            {**value,'status':'passed'} if name=='ui-readiness.json' else {**value,'service':'cache'}]:
                    with self.subTest(fields=tuple(bad)):
                        rejected=self.emit(name,bad);self.assertNotEqual(rejected.returncode,0);self.assertNotIn('PRIVATE_CANARY',rejected.stdout+rejected.stderr)
                self.assertNotEqual(self.emit(name,raw=' '*4097).returncode,0)
                self.assertNotEqual(self.emit(name,value,link=True).returncode,0)

class RealtimeStartupDiagnostics(unittest.TestCase):
    def stop(self, logs='', owned=True, failed=False, link=False, stderr_logs=''):
        source=(HERE/'run-linux-build.sh').read_text()
        function=source[source.index('ui_stop_owned() {'):source.index('run_product_phases() {')]
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);(root/'metrics').mkdir();(root/'logs-input').write_text(logs)
            (root/'stderr-input').write_text(stderr_logs)
            if link:
                (root/'foreign').write_text('PRIVATE_CANARY_unchanged')
                (root/'ui-realtime-startup.private.log').symlink_to(root/'foreign')
            setup=r'''prefix=owned; private="$1"; metrics="$1/metrics"; owned="$2"; failed="$3"
ui_owns() { printf 'owner\n' >> "$private/events"; [[ "$owned" == 1 ]]; }
ui_docker() {
  printf '%s\n' "$1" >> "$private/events"
  case "$1" in
    inspect) printf '{"Running":true,"OOMKilled":false,"Error":""}';;
    logs) [[ "$failed" != 1 ]] || return 17; cat "$private/logs-input"; cat "$private/stderr-input" >&2;;
    stop) :;;
    *) return 91;;
  esac
}
'''
            run=subprocess.run(['bash','-c',setup+function+'\nui_stop_owned owned-ui-realtime',
                'startup-test',temporary,'1' if owned else '0','1' if failed else '0'],
                capture_output=True,text=True,timeout=5)
            target=root/'metrics/ui-realtime-startup.json'
            return run,json.loads(target.read_text()) if target.exists() else None,\
                (root/'events').read_text().splitlines(),\
                (root/'foreign').read_text() if link else None

    def test_native_markers_only_are_projected_after_ownership_before_stop(self):
        logs='\n'.join(json.dumps(value) for value in [
            dict(level='INFO',module='CollaborativeSocketServer',message='Starting Socket.IO server...',secret='PRIVATE_CANARY'),
            dict(level='INFO',module='SocketIOConfig',message='Socket.IO Redis adapter connected - cross-pod broadcasting enabled'),
            dict(level='INFO',module='foreign',message='Schema-compatibility check passed'),
        ])+'\n'
        error=json.dumps(dict(level='ERROR',module='SocketIOConfig',message='PRIVATE_CANARY',errorCode='ECONNREFUSED'))+'\n'
        run,receipt,events,_=self.stop(logs,stderr_logs=error)
        self.assertEqual(run.returncode,0)
        self.assertEqual(receipt,dict(phase='ui-realtime-startup',service='realtime',logStatus='observed',
            lastMarker='redis_adapter_ready',errorCode='ECONNREFUSED'))
        self.assertEqual(events[0],'owner');self.assertLess(events.index('logs'),events.index('stop'))
        self.assertNotIn('PRIVATE_CANARY',run.stdout+run.stderr+json.dumps(receipt))

    def test_missing_unknown_oversized_and_symlink_logs_never_claim_a_startup_marker(self):
        examples=[('',False,False,'empty'),('PRIVATE_CANARY',False,False,'empty'),
                  ('x'*65537,False,False,'refused'),('',True,False,'unavailable'),('',False,True,'unavailable')]
        for logs,failed,link,status in examples:
            with self.subTest(status=status,link=link):
                run,receipt,events,foreign=self.stop(logs,failed=failed,link=link)
                self.assertEqual(run.returncode,0)
                self.assertEqual(receipt,dict(phase='ui-realtime-startup',service='realtime',logStatus=status,lastMarker=None,errorCode=None))
                self.assertIn('stop',events)
                if link:self.assertEqual(foreign,'PRIVATE_CANARY_unchanged')
                self.assertNotIn('PRIVATE_CANARY',run.stdout+run.stderr+json.dumps(receipt))
        run,receipt,events,_=self.stop('PRIVATE_CANARY',owned=False)
        self.assertNotEqual(run.returncode,0);self.assertIsNone(receipt)
        self.assertEqual(events,['owner'])

    def test_real_environment_preparation_enables_info_for_realtime_only(self):
        source=(HERE/'run-linux-build.sh').read_text()
        block=source.split('  current_stage=ui_prepare\n',1)[1].split("<<'PYUI'\n",1)[1].split('\nPYUI',1)[0]
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);(root/'postgres.env').write_text('POSTGRES_PASSWORD='+'a'*64+'\n')
            run=subprocess.run([__import__('sys').executable,'-c',block,temporary,'owned'],capture_output=True,text=True,timeout=5)
            self.assertEqual(run.returncode,0)
            def env(name):return dict(line.split('=',1) for line in (root/(name+'.env')).read_text().splitlines())
            self.assertEqual(env('ui-realtime').get('LOG_LEVEL'),'INFO')
            self.assertNotIn('LOG_LEVEL',env('ui-web'))
            self.assertNotIn('LOG_LEVEL',env('ui-seed'))

    def test_both_real_readers_keep_the_new_receipt_closed_and_observational(self):
        valid=dict(phase='ui-realtime-startup',service='realtime',logStatus='observed',lastMarker='schema_ready',errorCode=None)
        readers=[lambda value,**kwargs:ClosedPublication().emit(value,name='ui-realtime-startup',**kwargs),
                 lambda value,**kwargs:ClosedReadinessPublication().emit('ui-realtime-startup.json',value,**kwargs)]
        for reader in readers:
            run=reader(valid);self.assertEqual(run.returncode,0);self.assertEqual(json.loads(run.stdout),valid)
            for bad in [{**valid,'message':'PRIVATE_CANARY'},{**valid,'logStatus':'passed'},
                        {**valid,'lastMarker':'PRIVATE_CANARY'},{**valid,'errorCode':'PRIVATE_CANARY'},
                        {**valid,'service':'web'},{**valid,'logStatus':'empty'},{**valid,'lastMarker':True},
                        {**valid,'lastMarker':None,'errorCode':None}]:
                rejected=reader(bad);self.assertNotEqual(rejected.returncode,0)
                self.assertNotIn('PRIVATE_CANARY',rejected.stdout+rejected.stderr)
            self.assertNotEqual(reader(valid,link=True).returncode,0)
            self.assertNotEqual(reader(valid,raw=' '*4097).returncode,0)

if __name__=='__main__':unittest.main()
