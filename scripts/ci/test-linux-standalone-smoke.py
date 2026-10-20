#!/usr/bin/env python3
# Copyright 2026 Memlia. All rights reserved.
import json
from pathlib import Path
import subprocess
import unittest

HERE = Path(__file__).resolve().parent

class WiringTests(unittest.TestCase):
    def calls(self, scope):
        source = (HERE/'run-linux-build.sh').read_text()
        block = source[source.index('run_product_phases() {'):source.index('\nrun_product_phases\n')]
        script = 'set -e\nscope="$1"\nphase() { python3 -c "import json,sys; print(json.dumps(sys.argv[1:]))" "$@"; }\n'+block+'\nrun_product_phases\n'
        result = subprocess.run(['bash','-c',script,'fixture',scope], capture_output=True,text=True,timeout=10)
        self.assertEqual(result.returncode,0,result.stderr)
        return [json.loads(row) for row in result.stdout.splitlines()]

    def test_full_build_reaches_the_real_http_probe_after_next(self):
        calls = self.calls('build')
        standalone = next(call for call in calls if call[0]=='standalone')
        self.assertIn('/work/scripts/ci/linux-standalone-smoke.py',standalone)
        self.assertLess(next(i for i,c in enumerate(calls) if c[0]=='next'),calls.index(standalone))

    def test_validation_only_never_starts_the_http_server(self):
        self.assertFalse(any(call[0] in ('next','standalone') for call in self.calls('validation')))


# Infrastructure boundaries: real owned child/HTTP; procfs ownership only on Linux.
import importlib.util
import os
import signal
import socket
import sys
import tempfile
import time
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('smoke', HERE/'linux-standalone-smoke.py')
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)

SERVER = r'''
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import sys,time
port,mode,record=int(sys.argv[1]),sys.argv[2],Path(sys.argv[3])
class Handler(BaseHTTPRequestHandler):
 def do_GET(self):
  with record.open('a') as f:f.write(self.path+'\n')
  status=200;kind='application/json';body=b'{"status":"ok"}'
  if self.path=='/login':
   kind='text/html';body=b'<html><script src="/_next/static/one.js"></script><link href="/_next/static/two.css"></html>'
   if mode=='fonts':body=body.replace(b'<html>',b'<html><link href="/_next/static/media/font.woff2">')
   if mode=='redirect':status=302
   if mode=='oversize':body=b'x'*1048577
   if mode=='traversal':body=b'<html><script src="/_next/static/../one.js"></script><link href="/_next/static/two.css"></html>'
  elif self.path.startswith('/_next/static/'):
   kind='text/css' if self.path.endswith('.css') else 'application/javascript';body=b'fictitious'
   if mode=='empty':body=b''
  if mode=='health-invalid' and self.path=='/api/health':body=b'{"status":"bad"}'
  self.send_response(status);self.send_header('Content-Type',kind);self.send_header('Content-Length',str(len(body)));self.send_header('Location','https://invalid.example/PRIVATE_CANARY');self.end_headers()
  try:self.wfile.write(body)
  except BrokenPipeError:pass
 def log_message(self,*args):pass
print('PRIVATE_CANARY',flush=True)
HTTPServer(('127.0.0.1',port),Handler).serve_forever()
'''

class HttpTests(unittest.TestCase):
    def run_fixture(self, mode='good', ownership=True, native=False, timeout=9):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);server=root/'server.py';record=root/'requests'
            server.write_text(SERVER)
            with socket.socket() as listener:
                listener.bind(('127.0.0.1',0));port=listener.getsockname()[1]
            observed=[]
            def portable_listener(pid, target):
                observed.append(pid)
                if not ownership:return False
                try:
                    with socket.create_connection(('127.0.0.1',target),timeout=.05):return True
                except OSError:return False
            with patch.object(smoke,'owned_listener',wraps=smoke.owned_listener if native else portable_listener) as listener_probe:
                result=smoke.smoke([sys.executable,str(server),str(port),mode,str(record)],root,
                                   {'PATH':os.environ.get('PATH','/usr/bin:/bin')},port,timeout=timeout)
            observed.extend(call.args[0] for call in listener_probe.call_args_list)
            requests=record.read_text().splitlines() if record.exists() else []
            for pid in set(observed):
                with self.assertRaises(ProcessLookupError):os.kill(pid,0)
            self.assertTrue(result['cleanup'])
            self.assertNotIn('PRIVATE_CANARY',json.dumps(result))
            return result,requests

    def test_real_loopback_health_login_and_two_assets_with_owned_child_cleanup(self):
        result,requests=self.run_fixture()
        self.assertEqual(result['status'],'passed')
        self.assertEqual(requests,['/api/health','/login','/_next/static/one.js','/_next/static/two.css'])
        self.assertEqual(result['assets'],2)
        self.assertFalse(result['databaseQualified'])
        self.assertFalse(result['authenticationQualified'])

    def test_font_preloads_do_not_replace_the_two_javascript_or_css_assets(self):
        result,requests=self.run_fixture('fonts')
        self.assertEqual(result['status'],'passed')
        self.assertEqual(requests,['/api/health','/login','/_next/static/one.js','/_next/static/two.css'])

    def test_http_failures_never_become_passed_because_cleanup_succeeds(self):
        for mode in ('redirect','oversize','empty','health-invalid','traversal'):
            with self.subTest(mode=mode):
                result,requests=self.run_fixture(mode)
                self.assertEqual(result['status'],'failed')
                self.assertFalse(any('PRIVATE' in request or '/../' in request for request in requests))

    def test_foreign_listener_is_never_probed(self):
        result,requests=self.run_fixture(ownership=False)
        self.assertEqual(result['status'],'failed')
        self.assertEqual(requests,[])

    def test_real_interruption_during_cleanup_is_not_a_pass(self):
        original_popen = smoke.subprocess.Popen
        children=[]
        def spawn(*args, **kwargs):
            child=original_popen(*args, **kwargs);children.append(child)
            terminate=child.terminate
            def interrupt_then_terminate():
                os.kill(os.getpid(),signal.SIGTERM)
                terminate()
            child.terminate=interrupt_then_terminate
            return child
        def interrupt(_signum,_frame):raise KeyboardInterrupt()
        previous=signal.signal(signal.SIGTERM,interrupt)
        try:
            with patch.object(smoke.subprocess,'Popen',side_effect=spawn):
                try:result,_=self.run_fixture()
                except KeyboardInterrupt:self.fail('cleanup interruption escaped without owned cleanup')
            self.assertEqual(result['status'],'failed')
            self.assertEqual(result['reason'],'interrupted')
        finally:
            signal.signal(signal.SIGTERM,previous)
            for child in children:
                if child.poll() is None:child.kill()
                child.wait(timeout=3)

    def test_real_nonzero_child_and_timeout_fail_with_owned_cleanup(self):
        for program,reason in [('raise SystemExit(3)','server_exited'),('import time; time.sleep(30)','timeout')]:
            with self.subTest(reason=reason), tempfile.TemporaryDirectory() as temporary:
                with patch.object(smoke,'owned_listener',return_value=False):
                    result=smoke.smoke([sys.executable,'-c',program],Path(temporary),{},12345,timeout=9)
                self.assertEqual(result['status'],'failed');self.assertEqual(result['reason'],reason)
                self.assertTrue(result['cleanup'])

    def test_stubborn_owned_child_is_killed_and_waited_without_reclassifying_timeout(self):
        with tempfile.TemporaryDirectory() as temporary:
            with patch.object(smoke,'owned_listener',return_value=False) as observe:
                result=smoke.smoke([sys.executable,'-c','import signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); time.sleep(30)'],Path(temporary),{},12345,timeout=9)
            self.assertEqual(result['status'],'failed');self.assertEqual(result['reason'],'timeout')
            self.assertTrue(result['forcedStop']);self.assertTrue(result['cleanup'])
            for pid in {call.args[0] for call in observe.call_args_list}:
                with self.assertRaises(ProcessLookupError):os.kill(pid,0)

    @unittest.skipUnless(sys.platform=='linux','Linux procfs ownership required; no emulation qualification')
    def test_linux_real_child_socket_inode_ownership(self):
        result,_=self.run_fixture(native=True)
        self.assertEqual(result['status'],'passed')

class ArtifactTests(unittest.TestCase):
    def test_preserves_all_original_artifact_and_effective_config_requirements(self):
        with tempfile.TemporaryDirectory() as temporary:
            app=Path(temporary);root=app/'.next';(root/'standalone/apps/sim').mkdir(parents=True);(root/'static').mkdir()
            names=('BUILD_ID','standalone/apps/sim/server.js','routes-manifest.json','prerender-manifest.json')
            for name in names:(root/name).write_text('fixture')
            config={'output':'standalone','productionBrowserSourceMaps':False,'experimental':{'serverSourceMaps':False,'cpus':2},'enablePrerenderSourceMaps':False}
            manifest=root/'required-server-files.json';manifest.write_text(json.dumps({'config':config}))
            smoke.verify_artifacts(app,True)
            for name in names:
                path=root/name;saved=path.read_bytes();path.unlink()
                with self.assertRaises((smoke.Refused,FileNotFoundError)):smoke.verify_artifacts(app,True)
                path.write_bytes(saved)
            (root/'BUILD_ID').write_text(' ')
            with self.assertRaises(smoke.Refused):smoke.verify_artifacts(app,True)
            (root/'BUILD_ID').write_text('fixture')
            for field in ('productionBrowserSourceMaps','enablePrerenderSourceMaps','serverSourceMaps','cpus','output'):
                changed=json.loads(json.dumps(config));target=changed['experimental'] if field in ('serverSourceMaps','cpus') else changed
                target[field]='export' if field=='output' else 4 if field=='cpus' else True
                manifest.write_text(json.dumps({'config':changed}))
                with self.assertRaises(smoke.Refused):smoke.verify_artifacts(app,True)
            # As before, non-swap mode imposes output but does not add new map requirements.
            manifest.write_text(json.dumps({'config':{'output':'standalone'}}));smoke.verify_artifacts(app,False)

class StagingTests(unittest.TestCase):
    def test_never_follow_symlink_outside_source_or_absolute_link(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);source=root/'source';source.mkdir();outside=root/'outside';outside.write_text('FICTITIOUS')
            for target in ('../outside',str(outside)):
                link=source/'link';link.symlink_to(target)
                with self.assertRaises(smoke.Refused):smoke.copy_owned_tree(source,root/'target')
                self.assertFalse((root/'target').exists());link.unlink()
            self.assertEqual(outside.read_text(),'FICTITIOUS')

    def test_rejects_a_source_root_symlink(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); outside=root/'outside';outside.mkdir();(outside/'sentinel').write_text('owned fixture')
            source=root/'source';source.symlink_to(outside,target_is_directory=True)
            with self.assertRaises(smoke.Refused):smoke.copy_owned_tree(source,root/'target')
            self.assertFalse((root/'target').exists())

    def test_staging_refuses_symlinked_output_ancestor(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);app=root/'app';app.mkdir();outside=root/'outside';outside.mkdir()
            (outside/'standalone').mkdir();(outside/'standalone/sentinel').write_text('owned fixture')
            (outside/'static').mkdir();(app/'public').mkdir()
            (app/'.next').symlink_to(outside,target_is_directory=True)
            stage=root/'stage';stage.mkdir()
            with self.assertRaises(smoke.Refused):smoke.stage_artifacts(app,stage)
            self.assertFalse((stage/'sentinel').exists())

    def test_staging_never_overwrites_a_linked_destination(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);source=root/'source';source.mkdir();(source/'sentinel').write_text('new')
            outside=root/'outside';outside.mkdir();(outside/'sentinel').write_text('preserved')
            target=root/'target';target.symlink_to(outside,target_is_directory=True)
            with self.assertRaises(smoke.Refused):smoke.copy_owned_tree(source,target)
            self.assertEqual((outside/'sentinel').read_text(),'preserved')

    def test_preserves_internal_relative_link_without_source_dependency(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);source=root/'source';source.mkdir();(source/'real').write_text('fixture');(source/'link').symlink_to('real')
            smoke.copy_owned_tree(source,root/'target')
            self.assertTrue((root/'target/link').is_symlink())
            self.assertEqual((root/'target/link').resolve(),(root/'target/real').resolve())

    def test_runtime_excludes_migration_and_provider_secrets(self):
        source={key:'fictitious' for key in ('BETTER_AUTH_SECRET','ENCRYPTION_KEY','INTERNAL_API_SECRET','BETTER_AUTH_URL','NEXT_PUBLIC_APP_URL','NEXT_PUBLIC_SOCKET_URL')}
        source.update(DATABASE_URL='postgresql://memlia_build:fixture@database:5432/memlia_build',HOME='/scratch',TMPDIR='/scratch/tmp',MIGRATION_DATABASE_URL='PRIVATE_OWNER',OPENAI_API_KEY='PRIVATE_PROVIDER')
        result=smoke.runtime_env(source,12345)
        self.assertNotIn('MIGRATION_DATABASE_URL',result);self.assertNotIn('OPENAI_API_KEY',result)
        self.assertEqual(result['HOSTNAME'],'127.0.0.1');self.assertEqual(result['NEXT_TELEMETRY_DISABLED'],'1')
        source['DATABASE_URL']='postgresql://foreign:fixture@outside:5432/user_database'
        with self.assertRaises(smoke.Refused):smoke.runtime_env(source,12345)


class ReceiptPublicationTests(unittest.TestCase):
    workflows = ('memlia-linux-build.yml', 'memlia-linux-swap-build.yml')

    def reader(self, workflow):
        source = (HERE.parents[1]/'.github/workflows'/workflow).read_text()
        start = source.index("          python3 - <<'PY'\n") + len("          python3 - <<'PY'\n")
        end = source.index('          PY\n', start)
        return ''.join(line[10:] for line in source[start:end].splitlines(keepends=True))

    def publish(self, workflow, raw, linked=False):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); metrics = root/'memlia-metrics'; metrics.mkdir()
            receipt = metrics/'standalone-http.json'
            if linked:
                target = root/'foreign.json'; target.write_bytes(raw); receipt.symlink_to(target)
            else:
                receipt.write_bytes(raw)
            # Historical closed receipts still appear; raw logs must never be enumerated.
            (metrics/'standalone.json').write_text('{"phase":"standalone","status":"failed"}')
            (metrics/'standalone.log').write_text('PRIVATE_CANARY')
            return subprocess.run([sys.executable, '-c', self.reader(workflow)],
                                  env={'RUNNER_TEMP':str(root)}, capture_output=True,
                                  text=True, timeout=5)

    def test_actual_workflow_readers_publish_the_existing_closed_http_failure(self):
        receipt = {'status':'failed', 'reason':'listener_unavailable', 'health':False,
                   'loginHtml':False, 'assets':0, 'cleanup':True, 'forcedStop':False,
                   'databaseQualified':False, 'authenticationQualified':False, 'seconds':24.061}
        for workflow in self.workflows:
            with self.subTest(workflow=workflow):
                result = self.publish(workflow, json.dumps(receipt).encode())
                self.assertEqual(result.returncode, 0, result.stderr)
                rows = [json.loads(row) for row in result.stdout.splitlines()]
                self.assertIn({'phase':'standalone-http', **receipt}, rows)
                self.assertIn({'phase':'standalone','status':'failed'}, rows)
                self.assertNotIn('PRIVATE_CANARY', result.stdout+result.stderr)

    def test_early_failure_and_success_shapes_are_both_visible(self):
        cases = [{'status':'failed','reason':'artifact_invalid','cleanup':True},
                 {'status':'passed','reason':None,'health':True,'loginHtml':True,'assets':2,
                  'cleanup':True,'forcedStop':False,'databaseQualified':False,
                  'authenticationQualified':False,'seconds':1.25}]
        for workflow in self.workflows:
            for receipt in cases:
                with self.subTest(workflow=workflow,status=receipt['status']):
                    result = self.publish(workflow,json.dumps(receipt).encode())
                    self.assertEqual(result.returncode,0,result.stderr)
                    self.assertIn({'phase':'standalone-http',**receipt},
                                  [json.loads(row) for row in result.stdout.splitlines()])

    def test_unknown_fields_values_malformed_and_oversized_receipts_are_not_published(self):
        base = {'status':'failed','reason':'artifact_invalid','cleanup':True}
        cases = [json.dumps({**base,'raw':'PRIVATE_CANARY'}).encode(),
                 json.dumps({**base,'reason':'PRIVATE_CANARY'}).encode(),
                 json.dumps({**base,'cleanup':'PRIVATE_CANARY'}).encode(),
                 b'{"status":"PRIVATE_CANARY"', b'PRIVATE_CANARY'+b' '*4096,
                 json.dumps({**base,'status':'passed'}).encode()]
        for workflow in self.workflows:
            for raw in cases:
                with self.subTest(workflow=workflow,bytes=len(raw)):
                    result = self.publish(workflow,raw)
                    self.assertNotEqual(result.returncode,0)
                    self.assertNotIn('PRIVATE_CANARY',result.stdout+result.stderr)
                    self.assertNotIn('"phase": "standalone-http"',result.stdout)

    def test_linked_receipt_is_not_read_or_published(self):
        raw=b'{"status":"failed","reason":"PRIVATE_CANARY","cleanup":true}'
        for workflow in self.workflows:
            result=self.publish(workflow,raw,linked=True)
            self.assertNotEqual(result.returncode,0)
            self.assertNotIn('PRIVATE_CANARY',result.stdout+result.stderr)

    def test_reader_code_is_identical_and_checked_before_build_in_both_workflows(self):
        self.assertEqual(self.reader(self.workflows[0]),self.reader(self.workflows[1]))
        for workflow in self.workflows:
            source=(HERE.parents[1]/'.github/workflows'/workflow).read_text()
            self.assertIn('python3 scripts/ci/test-linux-standalone-smoke.py -v', source)
            self.assertLess(source.index('python3 scripts/ci/test-linux-standalone-smoke.py -v'),
                            source.index('run: bash scripts/ci/run-linux-build.sh'))

class HttpDiagnosticTests(unittest.TestCase):
    def test_each_non_200_response_reports_its_stage_without_following_or_continuing(self):
        cases = [('health','/api/health',503), ('login','/login',302),
                 ('asset_1','/_next/static/one.js',403), ('asset_2','/_next/static/two.css',404)]
        order = ['/api/health','/login','/_next/static/one.js','/_next/static/two.css']
        for stage, path, status in cases:
            server = SERVER.replace('  self.send_response(status);',
                                    f'  if self.path=={path!r}:status={status}\n  self.send_response(status);')
            with self.subTest(stage=stage), patch.dict(globals(), SERVER=server):
                result, requests = HttpTests().run_fixture()
                self.assertEqual(result['status'], 'failed')
                self.assertEqual(result['reason'], 'http_refused')
                self.assertEqual(result.get('requestStage'), stage)
                self.assertEqual(result.get('httpStatus'), status)
                self.assertEqual(requests, order[:order.index(path)+1])

    def test_success_records_the_last_asset_200_without_qualifying_authentication(self):
        result, _ = HttpTests().run_fixture()
        self.assertEqual(result['status'], 'passed')
        self.assertEqual(result.get('requestStage'), 'asset_2')
        self.assertEqual(result.get('httpStatus'), 200)
        self.assertFalse(result['databaseQualified'])
        self.assertFalse(result['authenticationQualified'])

    def test_a_later_request_without_response_does_not_retain_the_previous_200(self):
        server = SERVER.replace('  self.send_response(status);',
                                "  if self.path=='/login':return\n  self.send_response(status);")
        with patch.dict(globals(), SERVER=server):
            result, requests = HttpTests().run_fixture()
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['reason'], 'http_refused')
        self.assertEqual(result.get('requestStage'), 'login')
        self.assertIn('httpStatus', result)
        self.assertIsNone(result['httpStatus'])
        self.assertEqual(requests, ['/api/health','/login'])

    def test_response_timeout_keeps_the_current_stage_and_no_previous_status(self):
        server = SERVER.replace('  self.send_response(status);',
                                "  if self.path=='/login':time.sleep(30)\n  self.send_response(status);")
        with patch.dict(globals(), SERVER=server):
            result, requests = HttpTests().run_fixture()
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['reason'], 'timeout')
        self.assertEqual(result.get('requestStage'), 'login')
        self.assertIn('httpStatus', result)
        self.assertIsNone(result['httpStatus'])
        self.assertEqual(requests, ['/api/health','/login'])

    def test_no_request_and_early_artifact_failure_have_explicit_null_diagnostics(self):
        result, requests = HttpTests().run_fixture(ownership=False)
        self.assertEqual(requests, [])
        self.assertIn('requestStage', result)
        self.assertIsNone(result['requestStage'])
        self.assertIn('httpStatus', result)
        self.assertIsNone(result['httpStatus'])
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); report = root/'receipt.json'
            with patch.object(sys, 'argv', ['smoke',str(root/'absent'),str(root),str(report)]):
                self.assertEqual(smoke.main(), 1)
            receipt = json.loads(report.read_text())
        self.assertIn('requestStage', receipt)
        self.assertIsNone(receipt['requestStage'])
        self.assertIn('httpStatus', receipt)
        self.assertIsNone(receipt['httpStatus'])

    def test_nonstandard_status_is_refused_without_publishing_an_out_of_range_number(self):
        server = SERVER.replace('  self.send_response(status);',
                                '  status=600\n  self.send_response(status);')
        with patch.dict(globals(), SERVER=server):
            result, requests = HttpTests().run_fixture()
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['reason'], 'http_refused')
        self.assertEqual(result.get('requestStage'), 'health')
        self.assertIn('httpStatus', result)
        self.assertIsNone(result['httpStatus'])
        self.assertEqual(requests, ['/api/health'])


class DiagnosticPublicationTests(unittest.TestCase):
    def test_both_readers_publish_only_the_closed_stage_and_bounded_status(self):
        base = {'status':'failed','reason':'http_refused','health':False,'loginHtml':False,
                'assets':0,'cleanup':True,'forcedStop':False,'databaseQualified':False,
                'authenticationQualified':False,'seconds':1.25}
        cases = [{**base,'requestStage':stage,'httpStatus':status}
                 for stage, status in [('health',100),('login',302),('asset_1',599),('asset_2',None)]]
        cases += [{'status':'failed','reason':'artifact_invalid','cleanup':True,
                   'requestStage':None,'httpStatus':None},
                  {**base,'status':'passed','reason':None,'health':True,'loginHtml':True,
                   'assets':2,'requestStage':'asset_2','httpStatus':200}]
        reader = ReceiptPublicationTests()
        for workflow in reader.workflows:
            for receipt in cases:
                with self.subTest(workflow=workflow,stage=receipt['requestStage'],status=receipt['httpStatus']):
                    result = reader.publish(workflow,json.dumps(receipt).encode())
                    self.assertEqual(result.returncode,0,result.stderr)
                    self.assertIn({'phase':'standalone-http',**receipt},
                                  [json.loads(row) for row in result.stdout.splitlines()])

    def test_a_real_oversized_200_is_published_as_failed_without_its_body(self):
        receipt, requests = HttpTests().run_fixture('oversize')
        self.assertEqual(receipt['status'], 'failed')
        self.assertEqual(receipt['reason'], 'http_refused')
        self.assertEqual(receipt.get('requestStage'), 'login')
        self.assertEqual(receipt.get('httpStatus'), 200)
        self.assertEqual(requests, ['/api/health','/login'])
        reader = ReceiptPublicationTests()
        for workflow in reader.workflows:
            with self.subTest(workflow=workflow):
                result = reader.publish(workflow,json.dumps(receipt).encode())
                self.assertEqual(result.returncode,0,result.stderr)
                self.assertIn({'phase':'standalone-http',**receipt},
                              [json.loads(row) for row in result.stdout.splitlines()])
                self.assertNotIn('PRIVATE_CANARY', result.stdout+result.stderr)
                self.assertLess(len(result.stdout),4096)

    def test_readers_refuse_invalid_diagnostics_without_printing_their_values(self):
        base = {'status':'failed','reason':'http_refused','health':False,'loginHtml':False,
                'assets':0,'cleanup':True,'forcedStop':False,'databaseQualified':False,
                'authenticationQualified':False,'seconds':1.25,
                'requestStage':'health','httpStatus':503}
        cases = [{**base,'requestStage':value} for value in ('PRIVATE_CANARY',True,1,{},[])]
        cases += [{**base,'httpStatus':value} for value in ('PRIVATE_CANARY',True,99,600,503.0,{},[])]
        cases += [{key:value for key,value in base.items() if key != missing}
                  for missing in ('requestStage','httpStatus')]
        cases += [{**base,'requestStage':None}, {**base,'extra':'PRIVATE_CANARY'},
                  {'status':'failed','reason':'artifact_invalid','cleanup':True,
                   'requestStage':'health','httpStatus':503},
                  {**base,'status':'passed','reason':None,'health':True,'loginHtml':True,
                   'assets':2,'requestStage':'login','httpStatus':200}]
        reader = ReceiptPublicationTests()
        for workflow in reader.workflows:
            for receipt in cases:
                with self.subTest(workflow=workflow,stage=receipt.get('requestStage'),status=receipt.get('httpStatus')):
                    result = reader.publish(workflow,json.dumps(receipt).encode())
                    self.assertNotEqual(result.returncode,0)
                    self.assertNotIn('PRIVATE_CANARY',result.stdout+result.stderr)
                    self.assertNotIn('"phase": "standalone-http"',result.stdout)


class HealthReadinessTests(unittest.TestCase):
    def run_delayed_health(self, delay, timeout, status=200):
        server = SERVER.replace(
            '  self.send_response(status);',
            f"  if self.path=='/api/health':time.sleep({delay});status={status}\n"
            '  self.send_response(status);')
        with patch.dict(globals(), SERVER=server):
            return HttpTests().run_fixture(timeout=timeout)

    def test_health_headers_can_arrive_after_five_seconds_within_startup_budget(self):
        result, requests = self.run_delayed_health(5.2, 15)
        self.assertEqual(result['status'], 'passed')
        self.assertEqual(len(requests), 4)
        self.assertFalse(result['forcedStop'])

    def test_health_headers_cannot_extend_the_existing_startup_deadline(self):
        result, requests = self.run_delayed_health(3, 9)
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['reason'], 'timeout')
        self.assertEqual(result['requestStage'], 'health')
        self.assertIsNone(result['httpStatus'])
        self.assertEqual(requests, ['/api/health'])
        self.assertLess(result['seconds'], 3)

    def test_delayed_non_200_health_is_not_retried_or_treated_as_ready(self):
        result, requests = self.run_delayed_health(.1, 9, 503)
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['reason'], 'http_refused')
        self.assertEqual(result['httpStatus'], 503)
        self.assertEqual(requests, ['/api/health'])

    def test_health_body_keeps_five_second_bound_after_headers(self):
        server = SERVER.replace(
            '  try:self.wfile.write(body)',
            "  if self.path=='/api/health':time.sleep(5.2)\n"
            '  try:self.wfile.write(body)')
        with patch.dict(globals(), SERVER=server):
            result, requests = HttpTests().run_fixture(timeout=15)
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['reason'], 'timeout')
        self.assertEqual(result['httpStatus'], 200)
        self.assertEqual(requests, ['/api/health'])


class OwnedTerminationTests(unittest.TestCase):
    def run_exit_fixture(self, mode='good', spontaneous=False):
        # Actual child/signal/HTTP; only Linux procfs ownership is replaced by
        # the existing portable listener boundary. No Next build is claimed.
        server = SERVER.replace('import sys,time', 'import sys,time,signal,os')
        server = server.replace(
            'class Handler(BaseHTTPRequestHandler):',
            'signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))\n'
            'class Handler(BaseHTTPRequestHandler):')
        if spontaneous:
            server = server.replace(
                '  try:self.wfile.write(body)',
                '  if self.path=="/_next/static/two.css":\n'
                '   self.wfile.write(body);self.wfile.flush();os._exit(143)\n'
                '  try:self.wfile.write(body)')
        children = []
        real_popen, real_probe = smoke.subprocess.Popen, smoke.probe
        def spawn(*args, **kwargs):
            child = real_popen(*args, **kwargs)
            children.append(child)
            return child
        def probe(*args, **kwargs):
            real_probe(*args, **kwargs)
            if spontaneous:
                args[0].wait(timeout=2)
        with patch.dict(globals(), SERVER=server), \
             patch.object(smoke.subprocess, 'Popen', side_effect=spawn), \
             patch.object(smoke, 'probe', side_effect=probe):
            result, requests = HttpTests().run_fixture(mode)
        self.assertEqual(len(children), 1)
        self.assertEqual(children[0].returncode, 143)
        return result, requests

    def test_owned_sigterm_exit_143_preserves_successful_http_result(self):
        result, requests = self.run_exit_fixture()
        self.assertEqual(len(requests), 4)
        self.assertEqual(result['status'], 'passed')
        self.assertIsNone(result['reason'])
        self.assertFalse(result['forcedStop'])

    def test_owned_sigterm_exit_143_never_erases_http_failure(self):
        result, requests = self.run_exit_fixture('health-invalid')
        self.assertEqual(requests, ['/api/health'])
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['reason'], 'health_refused')

    def test_spontaneous_exit_143_after_http_probes_remains_failed(self):
        result, requests = self.run_exit_fixture(spontaneous=True)
        self.assertEqual(len(requests), 4)
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['reason'], 'server_exited')


if __name__ == '__main__': unittest.main()
