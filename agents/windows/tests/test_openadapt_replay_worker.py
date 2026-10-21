# Copyright (c) 2026 Memlia. All rights reserved.
"""Native authority/Flow/Windows ports are explicit doubles, never qualification."""
from contextlib import ExitStack
import hashlib
import importlib
import json
import os
import sys
import subprocess
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch


class ReplayWorkerTests(unittest.TestCase):
    def worker(self):
        return importlib.import_module('memlia_agent.openadapt_replay_worker')

    def test_missing_root_admission_refuses_before_runtime_or_server(self):
        worker = self.worker()
        with patch.dict(sys.modules,{'memlia_agent.openadapt_replay_admission':None}), \
                patch.object(worker, '_runtime') as runtime:
            with self.assertRaises(worker.ReplayWorkerError) as caught:
                worker._admission_port()
        self.assertEqual(caught.exception.code,'replay_admission_unavailable')
        runtime.assert_not_called()

    def test_closed_guarded_request_paths_never_fall_back(self):
        worker = self.worker()
        allowed=[('GET','/health'),('GET','/screenshot'),('POST','/input/guarded'),('POST','/uia/act')]
        for method,path in allowed:
            with self.subTest(path=path):self.assertEqual(worker.request_path(method,'http://127.0.0.1:5000'+path,5000),path)
        for method,url in [('POST','http://127.0.0.1:5000/input'),
                           ('POST','http://127.0.0.1:5000/execute_windows'),
                           ('GET','http://127.0.0.1:5000/screenshot?x=1'),
                           ('GET','http://localhost:5000/screenshot'),
                           ('GET','http://127.0.0.1:5001/screenshot'),
                           ('GET','https://127.0.0.1:5000/screenshot')]:
            with self.subTest(url=url),self.assertRaises(worker.ReplayWorkerError):
                worker.request_path(method,url,5000)

    def test_local_nonce_permit_is_not_admission_and_old_permit_is_refused(self):
        worker=self.worker()
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); (root/'go').write_bytes(b'other\n')
            with self.assertRaises(worker.ReplayWorkerError):worker.local_checkpoint(root,'a'*32,100,lambda:101)


class ReplayRequestTests(unittest.TestCase):
    def worker(self):return importlib.import_module('memlia_agent.openadapt_replay_worker')

    def test_strict_json_never_hides_duplicate_keys_or_nonfinite_parameters(self):
        worker=self.worker()
        for raw in (b'{"count":1,"count":2}',b'{"count":NaN}',b'{"count":Infinity}'):
            with self.subTest(raw=raw),self.assertRaises(worker.ReplayWorkerError):worker._json(raw)
        self.assertEqual(worker._json(b'{"count":3,"name":"fictitious"}'),{'count':3,'name':'fictitious'})

    def session(self,root,*,status=200,nonce='a'*32,checkpoint=None):
        worker=self.worker();trace=[]
        request={'nonce':'a'*32,'deadline':time.monotonic()+10}
        (root/'go').write_text(request['nonce']+'\n')
        (root/'heartbeat').write_text(request['nonce']+'\n'+repr(time.monotonic())+'\n')
        class NativeSession:
            def request(self,method,url,**kwargs):
                trace.append(('delivered',method,url,kwargs))
                return SimpleNamespace(headers={'X-Memlia-Replay-Nonce':nonce},status_code=status,
                                       close=lambda:trace.append('response_closed'))
        def authority(binding,**kwargs):
            trace.append(('authority',binding,kwargs))
            if checkpoint:return checkpoint()
        ports=SimpleNamespace(checkpoint=authority)
        session=worker._session(SimpleNamespace(Session=NativeSession),SimpleNamespace(port=5000),
                                root,request,ports,b'binding')
        return worker,session,trace,request

    def test_each_request_rechecks_root_even_if_flow_clears_its_own_guard(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);worker,session,trace,request=self.session(root)
            self.assertFalse(session.trust_env)
            session.request('POST','http://127.0.0.1:5000/input/guarded',allow_redirects=True,timeout=99)
            self.assertEqual((root/'input-attempted').read_text(),request['nonce']+'\n')
            delivered=trace[-1];self.assertFalse(delivered[3]['allow_redirects']);self.assertLessEqual(delivered[3]['timeout'],2)
            self.assertEqual(trace[0][2],{'stage':'request','method':'POST','path':'/input/guarded'})
            with patch.object(worker,'_root_checkpoint',side_effect=worker.ReplayWorkerError('replay_authority_unavailable')):
                with self.assertRaises(worker.ReplayWorkerError):session.request('POST','http://127.0.0.1:5000/uia/act')
            self.assertEqual(len([v for v in trace if type(v) is tuple and v[0]=='delivered']),1)
            with self.assertRaises(worker.ReplayWorkerError):session.request('POST','http://127.0.0.1:5000/input')
            self.assertEqual(len(trace),2)

    def test_lost_local_indicator_or_authority_refuses_before_input_marker(self):
        for cause in ('stop','stale','authority'):
            with self.subTest(cause=cause),tempfile.TemporaryDirectory() as directory:
                root=Path(directory)
                def refusal():raise RuntimeError('PRIVATE_LEASE')
                worker,session,trace,request=self.session(root,checkpoint=refusal if cause=='authority' else None)
                if cause=='stop':(root/'stop').write_bytes(b'')
                if cause=='stale':(root/'heartbeat').write_text(request['nonce']+'\n0\n')
                with self.assertRaises(Exception):session.request('POST','http://127.0.0.1:5000/uia/act')
                self.assertFalse((root/'input-attempted').exists())
                self.assertFalse(any(type(v) is tuple and v[0]=='delivered' for v in trace))

    def test_redirect_or_wrong_service_nonce_is_never_followed_or_accepted(self):
        for options in ({'status':302},{'nonce':'b'*32}):
            with self.subTest(options=options),tempfile.TemporaryDirectory() as directory:
                root=Path(directory);worker,session,trace,_=self.session(root,**options)
                with self.assertRaises(worker.ReplayWorkerError) as caught:
                    session.request('GET','http://127.0.0.1:5000/health')
                self.assertEqual(caught.exception.code,'replay_service_identity_refused')
                self.assertEqual(trace[-1],'response_closed')
                self.assertFalse((root/'input-attempted').exists())


class ReplayWorkerCompositionTests(unittest.TestCase):
    """Native Flow/root authority/server/HTTP doubled; real staging and retained report."""
    def fixture(self,root,*,admit=True,guards=None,surface='windows',mode='test',service_close=True,run_error=False):
        worker=importlib.import_module('memlia_agent.openadapt_replay_worker');trace=[]
        from test_openadapt_compile_worker import OUTPUT,BUNDLE
        (root/'bundle').mkdir()
        for name,data in OUTPUT:(root/'bundle'/name).write_bytes(data)
        request=dict(nonce='a'*32,deadline=time.monotonic()+10,mode=mode,bundleSha256=BUNDLE,
                     operationDigest='sha256:'+'b'*64,sessionId=1)
        for key,data in (('deployment',b'{}'),('parameters',b'{"count":3}'),('admission',b'fictive-only')):
            (root/(key+('.bin' if key=='admission' else '.json'))).write_bytes(data)
            request[key+'Sha256']=hashlib.sha256(data).hexdigest()
        (root/'go').write_text(request['nonce']+'\n')
        class ProdGuard:
            def verify(self,workflow,**kwargs):trace.append('production_verify')
        class CampaignGuard:pass
        class ApprovalGate:pass
        cfg=SimpleNamespace(backend=SimpleNamespace(kind='windows',agent_url=None,agent_token=None,agent_tls_pin=None),
            surfaces=None,actuation=SimpleNamespace(api=None),effects=None,runtime=SimpleNamespace(profile='demo' if mode=='test' else 'standard',
            allow_model_grounding=False,grounding_model=SimpleNamespace(enabled=False),durable=False,require_settled=False))
        workflow=SimpleNamespace(surface=surface,surfaces=None)
        def admission(value,**kwargs):
            trace.append(('admit',kwargs))
            if not admit:raise RuntimeError('PRIVATE_ADMISSION')
            return b'opaque-binding'
        def checkpoint(binding,**kwargs):trace.append(('checkpoint',kwargs['stage']))
        def native_guards(binding,**kwargs):
            trace.append(('guards',kwargs))
            return guards if guards is not None else dict(production_qualification_guard=None,qualification_campaign_guard=None,approval_gate=None)
        ports=SimpleNamespace(admit=admission,checkpoint=checkpoint,guards=native_guards,
                              close=lambda binding:trace.append('admission_closed'))
        raw={'transaction_outcome':'COMPLETED_UNVERIFIED','execution_outcome':'COMPLETED_UNVERIFIED','production_eligible':False}
        report=SimpleNamespace(**raw,model_dump=lambda **kwargs:raw)
        class Replayer:
            def run(self,*args,**kwargs):
                trace.append(('run',kwargs));(root/'run'/'report.json').write_text(json.dumps(raw))
                if run_error:raise RuntimeError('PRIVATE_ENGINE_CANARY')
                return report
        def build_replayer(backend,**kwargs):
            trace.append(('build_replayer',kwargs));return Replayer()
        profile=SimpleNamespace(require_durable=False,require_settled=False,strict_templates=False,require_encryption=False)
        rt=SimpleNamespace(deployment=SimpleNamespace(DeploymentConfig=SimpleNamespace(model_validate_json=lambda raw:cfg),
            incomplete_deployment_reasons=lambda cfg:[],build_effect_verifier=lambda *args,**kwargs:None,build_replayer=build_replayer),
            Workflow=SimpleNamespace(load=lambda *args,**kwargs:workflow),RunReport=SimpleNamespace(model_validate_json=lambda value:report),
            execution_profile_contract=lambda value:profile,resolve_execution_profile=lambda value:value,normalize_runtime_param_scalar=lambda value:value,
            run_gate=SimpleNamespace(evaluate_run_gate=lambda *args,**kwargs:SimpleNamespace(passed=True),build_runtime_authorization=lambda *args,**kwargs:object()),
            ProductionQualificationGuard=ProdGuard,QualificationCampaignGuard=CampaignGuard,ApprovalGate=ApprovalGate,
            WindowsBackend=lambda *args,**kwargs:SimpleNamespace())
        class Service:
            def __init__(self,*args):self.port=5000;self.token='PRIVATE_LOOPBACK_TOKEN'
            def start(self):trace.append('service_started')
            def close(self):
                trace.append('service_closed')
                if not service_close:raise RuntimeError('PRIVATE_CLOSE')
        health=SimpleNamespace(json=lambda:{'agent':'openadapt_flow.win_agent','auth_required':True,'active_console_session':1},
                               close=lambda:trace.append('health_closed'))
        session=SimpleNamespace(get=lambda url:health,close=lambda:trace.append('session_closed'))
        stack=ExitStack()
        for name,value in (('_admission_port',lambda:ports),('_runtime',lambda:trace.append('runtime') or rt),
                           ('_OwnedServer',Service),('_session',lambda *args:session),('_private_error',lambda error:trace.append(('private',str(error))))):
            stack.enter_context(patch.object(worker,name,value))
        return worker,stack,request,trace,rt

    def test_root_refusal_happens_before_native_imports_or_service(self):
        with tempfile.TemporaryDirectory() as directory:
            worker,stack,request,trace,rt=self.fixture(Path(directory),admit=False)
            with stack,self.assertRaises(worker.ReplayWorkerError) as caught:worker.run_directory(Path(directory),request)
            self.assertEqual(caught.exception.code,'replay_native_failure')
            self.assertNotIn('runtime',trace);self.assertNotIn('service_started',trace)
            self.assertIn(('private','PRIVATE_ADMISSION'),trace)

    def test_native_flow_run_and_unverified_report_preserve_guards_and_close_all_owners(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);worker,stack,request,trace,rt=self.fixture(root)
            with stack:result=worker.run_directory(root,request)
            self.assertFalse(result['verified']);self.assertEqual(result['transactionOutcome'],'COMPLETED_UNVERIFIED')
            self.assertEqual(result['reportSha256'],hashlib.sha256((root/'run'/'report.json').read_bytes()).hexdigest())
            args=next(v[1] for v in trace if type(v) is tuple and v[0]=='build_replayer')
            self.assertFalse(args['allow_egress']);self.assertIsNone(args['api_actuator'])
            self.assertEqual({key:args[key] for key in ('production_qualification_guard','qualification_campaign_guard','approval_gate')},
                             dict(production_qualification_guard=None,qualification_campaign_guard=None,approval_gate=None))
            self.assertEqual(trace[-4:],['session_closed','service_closed',('checkpoint','cleanup'),'admission_closed'])
            admission=next(v[1] for v in trace if type(v) is tuple and v[0]=='admit')
            self.assertEqual(admission['parameters_sha256'],request['parametersSha256'])
            self.assertEqual(next(v[1]['execution_target_kind'] for v in trace if type(v) is tuple and v[0]=='run'),'windows')

    def test_production_without_bound_windows_surface_or_actual_native_guards_never_starts(self):
        for surface in (None,'web','windows'):
            with self.subTest(surface=surface),tempfile.TemporaryDirectory() as directory:
                worker,stack,request,trace,rt=self.fixture(Path(directory),mode='production',surface=surface)
                with stack,self.assertRaises(worker.ReplayWorkerError):worker.run_directory(Path(directory),request)
                self.assertNotIn('service_started',trace);self.assertIn('admission_closed',trace)

    def test_service_close_unknown_retains_report_and_still_closes_admission(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);worker,stack,request,trace,rt=self.fixture(root,service_close=False)
            with stack,self.assertRaises(worker.ReplayWorkerError) as caught:worker.run_directory(root,request)
            self.assertEqual(caught.exception.code,'replay_cleanup_unknown')
            self.assertTrue((root/'run'/'report.json').is_file());self.assertEqual(trace[-1],'admission_closed')
            self.assertIn(('private','PRIVATE_CLOSE'),trace)

    def test_fresh_child_reserves_stdout_and_preserves_admission_failure_privately(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);worker,stack,request,trace,rt=self.fixture(root)
            # This child has no root port and grants nothing. Only its refusal is doubled.
            stack.close();request.update(version=1,windowsSid='S-1-5-21-1')
            code = """
import os,sys
from types import SimpleNamespace
from memlia_agent import openadapt_replay_worker as worker
worker.sys.platform='win32'
def admit(*args,**kwargs):
    print('PRIVATE_NATIVE_STDOUT');sys.stdout.flush();os.write(1,b'PRIVATE_NATIVE_FD\\n')
    raise RuntimeError('PRIVATE_ADMISSION_CANARY')
worker._admission_port=lambda:SimpleNamespace(admit=admit)
worker._runtime=lambda:(_ for _ in ()).throw(RuntimeError('UNREACHABLE_RUNTIME'))
raise SystemExit(worker.main())
"""
            result=subprocess.run([sys.executable,'-B','-c',code],input=json.dumps(request).encode(),
                                  cwd=root,env=dict(os.environ),capture_output=True,timeout=5)
            self.assertEqual(result.returncode,1,result.stderr)
            self.assertEqual(json.loads(result.stdout),{'status':'refused','errorCode':'replay_native_failure'})
            self.assertNotIn(b'PRIVATE_',result.stdout)
            self.assertIn(b'PRIVATE_NATIVE_STDOUT',result.stderr);self.assertIn(b'PRIVATE_NATIVE_FD',result.stderr)
            self.assertIn(b'PRIVATE_ADMISSION_CANARY',result.stderr);self.assertNotIn(b'UNREACHABLE_RUNTIME',result.stderr)

    def test_native_failure_keeps_private_cause_and_report_before_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);worker,stack,request,trace,rt=self.fixture(root,run_error=True)
            with stack,self.assertRaises(worker.ReplayWorkerError) as caught:worker.run_directory(root,request)
            self.assertEqual(str(caught.exception),'replay_native_failure')
            self.assertIn(('private','PRIVATE_ENGINE_CANARY'),trace)
            self.assertLess(trace.index(('private','PRIVATE_ENGINE_CANARY')),trace.index('session_closed'))
            self.assertTrue((root/'run'/'report.json').is_file())


class ReplayOwnedServiceTests(unittest.TestCase):
    """Win-agent server/socket/thread are doubles: no Win32 input and no listener."""
    def test_native_loopback_config_and_raw_input_denial_cannot_fall_back(self):
        worker=importlib.import_module('memlia_agent.openadapt_replay_worker');trace=[]
        class Config:
            def __init__(self,**kwargs):self.__dict__.update(kwargs);trace.append(('config',kwargs))
            def authed(self):return bool(self.token)
        class Handler:
            path='/input'
            def _send_json(self,status,body):trace.append(('refused',status,body['code']))
            def do_POST(self):trace.append('native_post')
            def send_header(self,key,value):trace.append((key,value))
            def end_headers(self):trace.append('headers_done')
        server=SimpleNamespace(server_address=('127.0.0.1',5000),RequestHandlerClass=Handler,
            get_request=lambda:None,shutdown_request=lambda connection:None,serve_forever=lambda **kwargs:None,
            server_close=lambda:trace.append('server_closed'),socket=SimpleNamespace(fileno=lambda:-1))
        class Thread:
            def __init__(self,**kwargs):trace.append(('thread',kwargs))
            def start(self):trace.append('thread_started')
            def is_alive(self):return False
        rt=SimpleNamespace(AgentConfig=Config,create_server=lambda cfg:server)
        with patch.object(worker.threading,'Thread',Thread):
            owned=worker._OwnedServer(rt,'a'*32,time.monotonic()+10);owned.start()
        config=trace[0][1];self.assertEqual(config['host'],'127.0.0.1');self.assertEqual(config['port'],0)
        self.assertFalse(config['allow_legacy_exec']);self.assertGreaterEqual(len(config['token']),32)
        handler=server.RequestHandlerClass()
        handler.do_POST();self.assertIn(('refused',403,'guarded_input_required'),trace);self.assertNotIn('native_post',trace)
        handler.path='/input/guarded';handler.do_POST();self.assertEqual(trace[-1],'native_post')
        handler.end_headers();self.assertIn(('X-Memlia-Replay-Nonce','a'*32),trace)
        owned.close();self.assertEqual(trace[-1],'server_closed')

    def test_accepted_connections_close_before_join_and_listener_close(self):
        worker=importlib.import_module('memlia_agent.openadapt_replay_worker');trace=[]
        class Connection:
            def shutdown(self,how):trace.append('connection_shutdown')
            def close(self):trace.append('connection_closed')
        class ServeThread:
            def is_alive(self):return 'serve_joined' not in trace
            def join(self,deadline):trace.append('serve_joined');self.deadline=deadline
        class CloseThread:
            def __init__(self,*,target,**kwargs):self.target=target
            def start(self):trace.append('shutdown_thread');self.target()
            def join(self,deadline):trace.append('shutdown_joined');self.deadline=deadline
            def is_alive(self):return False
        owned=worker._OwnedServer(None,'a'*32,time.monotonic()+10)
        owned.connections.add(Connection());owned.thread=ServeThread()
        owned.server=SimpleNamespace(shutdown=lambda:trace.append('shutdown'),server_close=lambda:trace.append('listener_closed'),
                                     socket=SimpleNamespace(fileno=lambda:-1))
        with patch.object(worker.threading,'Thread',CloseThread):owned.close()
        self.assertEqual(trace,['connection_shutdown','connection_closed','shutdown_thread','shutdown','shutdown_joined','serve_joined','listener_closed'])


if __name__=='__main__':unittest.main()
