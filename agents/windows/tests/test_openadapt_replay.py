# Copyright (c) 2026 Memlia. All rights reserved.
"""Read-only consent/lifecycle tests; no double can grant real Windows authority."""
import importlib
from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from memlia_agent.capture_input_filter import CaptureInputFactory, InputFilterUnavailable
from memlia_agent.owned_job import JobState,JobOutput
from memlia_agent.stop import StopRequested
from test_openadapt_compile_worker import compiled,OUTPUT


class ReplayControlsTests(unittest.TestCase):
    def module(self):return importlib.import_module('memlia_agent.openadapt_replay')

    def test_replay_controls_cannot_create_a_capture_factory(self):
        module=self.module()
        owner=object.__new__(module._ReplayControls)
        with patch.object(owner,'checkpoint') as checkpoint:
            with self.assertRaises(InputFilterUnavailable):
                CaptureInputFactory.from_controls(owner,operation_digest='sha256:'+'a'*64)
        checkpoint.assert_not_called()

    def test_unknown_replay_mode_refuses_before_native_dialog(self):
        module=self.module()
        with patch.object(module._TaskDialog,'__init__') as native:
            with self.assertRaises(module.ReplayError):module._ReplayDialog('automatic')
        native.assert_not_called()


class ReplayCompositionTests(unittest.TestCase):
    def fixture(self,*,cancel=False,revoke=False,clean=True,forced=False,partial=False,verified=False,worker_unknown=False):
        module=importlib.import_module('memlia_agent.openadapt_replay')
        trace=[];jobs=[];state={'input':False}
        class Reservation:
            def ensure_current(self):return SimpleNamespace(windows_sid='S-1-5-21-1',session_id=1)
            def close(self):trace.append('release')
        class Signal:
            def __init__(self,*args):pass
            def _start(self):trace.append('stop_armed')
            def checkpoint(self):
                if cancel and state['input']:raise StopRequested('stop_requested')
            def request_stop(self):trace.append('stop')
            def close(self):trace.append('stop_closed')
        class Controls:
            def __init__(self,*args):self._lock=threading.RLock();self._recording_indicated=False
            def _start(self):trace.append('consented')
            def checkpoint(self,**kwargs):trace.append('indicator')
            def recording_preparing(self,**kwargs):trace.append('preparing')
            def recording_started(self,**kwargs):self._recording_indicated=True;trace.append('indicated')
            def recording_stopped(self,**kwargs):trace.append('ack')
            def close(self):trace.append('ui_closed')
        class Job:
            def __init__(self,**kwargs):
                self.kwargs=kwargs;self.root=Path(kwargs['cwd']);self.request=json.loads(kwargs['io'].stdin);jobs.append(self)
            def start(self):
                trace.append('start');(self.root/'ready').write_text(self.request['nonce']+'\n')
                assert self.request['sessionId']==1 and self.request['windowsSid']=='S-1-5-21-1'
            def poll(self):
                if not (self.root/'go').exists():return JobState(1,False,None,False,False)
                state['input']=True
                (self.root/'input-attempted').write_text(self.request['nonce']+'\n')
                report={'transaction_outcome':'VERIFIED' if verified else 'COMPLETED_UNVERIFIED',
                        'execution_outcome':'VERIFIED' if verified else 'COMPLETED_UNVERIFIED',
                        'production_eligible':verified}
                (self.root/'run').mkdir(exist_ok=True)
                (self.root/'run'/'report.json').write_text(json.dumps(report))
                return JobState(0,True,1 if worker_unknown else 0,forced,True)
            def take_output(self):
                trace.append('output')
                report=(self.root/'run'/'report.json').read_bytes()
                result=dict(status='observed',reportSha256=hashlib.sha256(report).hexdigest(),
                            transactionOutcome='VERIFIED' if verified else 'COMPLETED_UNVERIFIED',verified=verified)
                if worker_unknown:result={'status':'refused','errorCode':'replay_cleanup_unknown'}
                return JobOutput(json.dumps(result).encode(),b'PRIVATE_REPLAY_DIAGNOSTIC',True,not partial,not partial)
            def cleanup(self):trace.append('job_closed');return clean
        def authority():
            if revoke and state['input']:raise ValueError('PRIVATE_LEASE_FAILURE')
        stack=ExitStack()
        for key,value in dict(_ready=lambda:None,reserve_desktop=Reservation,LocalStop=Signal,
                              _ReplayControls=Controls,OwnedJob=Job,_active=None).items():
            stack.enter_context(patch.object(module,key,value))
        stack.enter_context(patch.object(module.sys,'platform','win32'))
        stack.enter_context(patch.dict(os.environ,{'SYSTEMROOT':'C:\\Windows'}))
        request=dict(compiled=compiled(),operation_digest='sha256:'+'a'*64,mode='test',
                     deployment_bytes=b'{}',parameters_bytes=b'{}',admission_bytes=b'fictive-only',
                     deadline_monotonic=time.monotonic()+20,revalidate=authority)
        return module,stack,request,trace,jobs

    def test_unverified_native_completion_is_uncertain_after_real_host_cleanup(self):
        module,stack,request,trace,jobs=self.fixture()
        with stack:result=module.replay_compiled_recording(**request)
        self.assertEqual(result.status,'uncertain')
        self.assertEqual(result.transaction_outcome,'COMPLETED_UNVERIFIED')
        self.assertIn('run/report.json',dict(result.private_artifacts))
        self.assertNotIn('PRIVATE_',repr(result))
        self.assertEqual(result.private_output.stderr,b'PRIVATE_REPLAY_DIAGNOSTIC')
        self.assertLess(trace.index('consented'),trace.index('start'))
        self.assertLess(trace.index('job_closed'),trace.index('ack'))
        self.assertEqual([x for x in trace if x in ('ack','ui_closed','stop_closed','release')],
                         ['ack','ui_closed','stop_closed','release'])
        self.assertFalse(jobs[0].root.exists())
        self.assertEqual(jobs[0].kwargs['arguments'],('-I','-m','memlia_agent.openadapt_replay_worker'))

    def test_post_input_cancel_lost_lease_partial_and_forced_retain_uncertain_raw(self):
        for option in ('cancel','revoke','partial','forced'):
            with self.subTest(option=option):
                module,stack,request,trace,jobs=self.fixture(**{option:True})
                with stack,self.assertRaises(module.ReplayError) as caught:
                    module.replay_compiled_recording(**request)
                self.assertEqual(caught.exception.code,'replay_result_uncertain')
                self.assertEqual(caught.exception.effect_state,'uncertain')
                self.assertIn('run/report.json',dict(caught.exception.private_artifacts))
                self.assertEqual(caught.exception.private_output.stderr,b'PRIVATE_REPLAY_DIAGNOSTIC')
                self.assertNotIn('PRIVATE_',str(caught.exception))
                self.assertIn('release',trace)

    def test_unknown_cleanup_retains_owner_and_never_replays_on_reconcile(self):
        module,stack,request,trace,jobs=self.fixture(clean=False)
        with stack:
            with self.assertRaises(module.ReplayError) as caught:module.replay_compiled_recording(**request)
            self.assertEqual(caught.exception.code,'replay_hold')
            self.assertNotEqual(caught.exception.effect_state,'not_observed')
            self.assertNotIn('ack',trace);self.assertTrue(jobs[0].root.exists())
            jobs[0].cleanup=lambda:True
            self.assertTrue(module.reconcile_replay())
            self.assertEqual(trace.count('start'),1)
            self.assertFalse(jobs[0].root.exists())

    def test_explicit_worker_cleanup_unknown_retains_hold_even_after_job_is_reaped(self):
        module,stack,request,trace,jobs=self.fixture(worker_unknown=True)
        with stack:
            with self.assertRaises(module.ReplayError) as caught:module.replay_compiled_recording(**request)
            self.assertEqual(caught.exception.code,'replay_hold')
            self.assertTrue(jobs[0].root.exists());self.assertNotIn('ack',trace)
            self.assertIn('job_closed',trace);self.assertIsNotNone(caught.exception.private_output)
            self.assertFalse(module.reconcile_replay())
            self.assertEqual(trace.count('start'),1)
            # Test-only disposal after proving retention; no product escape or permission.
            owner=module._active;owner.worker_cleanup_unknown=False
            self.assertTrue(module.reconcile_replay())
            self.assertFalse(jobs[0].root.exists())

    def test_no_implicit_mode_parameters_or_boolean_authority(self):
        module,stack,request,trace,jobs=self.fixture()
        request['mode']='automatic'
        with stack,self.assertRaises(module.ReplayError) as caught:module.replay_compiled_recording(**request)
        self.assertEqual(caught.exception.code,'replay_request_refused');self.assertEqual(trace,[])
        module,stack,request,trace,jobs=self.fixture()
        request['revalidate']=lambda:True
        with stack,self.assertRaises(module.ReplayError) as caught:module.replay_compiled_recording(**request)
        self.assertEqual(caught.exception.code,'replay_authority_unavailable');self.assertEqual(trace,[])


if __name__=='__main__':unittest.main()
