# Copyright (c) 2026 Memlia. All rights reserved.
"""Real composition/files; external Windows reservation, hotkey and Job doubled."""
from contextlib import ExitStack
from dataclasses import replace
import importlib
import json
import os
from pathlib import Path
import threading
import time
import unittest
from unittest.mock import patch

from memlia_agent.openadapt_capture import CapturedRecording
from memlia_agent.owned_job import JobOutput, JobState
from memlia_agent.stop import StopRequested
from test_openadapt_compile_worker import INPUT, OUTPUT, SOURCE, BUNDLE


class CompileProcessTests(unittest.TestCase):
    def fixture(self, *, forced=False, partial=False, wrong_hash=False, cleanup=True,
                stop=False, authority_lost=False, poll_error=False, late_cleanup=False,
                mutate_after_capture=False):
        module=importlib.import_module('memlia_agent.openadapt_compile_process')
        trace=[]; jobs=[]; state={'poll':False,'cleanup':cleanup}
        clock=[time.monotonic()]
        class Reservation:
            def close(self): trace.append('release')
        class Signal:
            def __init__(self,*args): pass
            def _start(self): trace.append('stop_armed')
            def checkpoint(self):
                if stop and state['poll']: raise StopRequested('stop_requested')
            def request_stop(self): trace.append('stop_requested')
            def close(self): trace.append('stop_closed')
        class Job:
            def __init__(self,**kwargs):
                self.kwargs=kwargs; self.root=Path(kwargs['cwd']); jobs.append(self)
            def start(self):
                trace.append('start')
                self.request=json.loads(self.kwargs['io'].stdin)
                assert {p.name:p.read_bytes() for p in (self.root/'recording').iterdir()}==dict(INPUT)
                (self.root/'bundle').mkdir()
                for name,data in OUTPUT: (self.root/'bundle'/name).write_bytes(data)
            def poll(self):
                trace.append('poll'); state['poll']=True
                if poll_error: raise OSError('PRIVATE_JOB_ERROR')
                return JobState(0,True,0,forced,True)
            def take_output(self):
                trace.append('output')
                from memlia_agent.openadapt_compile import _VERSIONS
                result=dict(status='to_test',sourceSha256=SOURCE,bundleSha256='0'*64 if wrong_hash else BUNDLE,
                            stepCount=1,versions=sorted(_VERSIONS.items()))
                return JobOutput(json.dumps(result).encode(),b'PRIVATE_DIAGNOSTIC',True,not partial,not partial)
            def cleanup(self):
                trace.append('job_closed')
                if late_cleanup: clock[0]=self.kwargs['deadline_monotonic']+1
                return state['cleanup']
        def authority():
            trace.append('authority')
            if authority_lost and state['poll']: raise ValueError('PRIVATE_LEASE_ERROR')
            if mutate_after_capture:
                object.__setattr__(recording,'files',(('events.jsonl',b'CHANGED'),('meta.json',b'{}')))
        stack=ExitStack()
        for key,value in dict(OwnedJob=Job,LocalStop=Signal,reserve_desktop=Reservation,
                              _compiler_ready=lambda:None,_active=None).items():
            stack.enter_context(patch.object(module,key,value))
        stack.enter_context(patch.object(module.sys,'platform','win32'))
        stack.enter_context(patch.dict(os.environ,{'SYSTEMROOT':'C:\\Windows'}))
        if late_cleanup: stack.enter_context(patch.object(module.time,'monotonic',side_effect=lambda:clock[0]))
        recording=CapturedRecording(INPUT,(), 'sha256:'+'a'*64,SOURCE,None)
        kwargs=dict(recording=recording,name='Fictitious procedure',deadline_monotonic=time.monotonic()+20,
                    revalidate=authority)
        return module,stack,kwargs,trace,jobs

    def test_compiled_bytes_are_to_test_only_after_owned_cleanup(self):
        module,stack,request,trace,jobs=self.fixture()
        with stack:
            result=module.compile_captured_recording(**request)
            self.assertIsNone(module._active)
        self.assertEqual(result.compiled.status,'to_test')
        self.assertEqual(result.compiled.source_sha256,SOURCE)
        self.assertEqual(result.compiled.bundle_sha256,BUNDLE)
        self.assertEqual(tuple((f.path,f.content) for f in result.compiled.files),OUTPUT)
        self.assertEqual(result.private_output.stderr,b'PRIVATE_DIAGNOSTIC')
        self.assertLess(trace.index('job_closed'),trace.index('stop_closed'))
        self.assertLess(trace.index('stop_closed'),trace.index('release'))
        self.assertFalse(jobs[0].root.exists())
        self.assertEqual(jobs[0].kwargs['arguments'],('-I','-m','memlia_agent.openadapt_compile_worker'))
        self.assertNotIn('PYTHONPATH',jobs[0].kwargs['environment'])

    def test_captured_files_are_detached_before_authority_callback(self):
        module,stack,request,trace,jobs=self.fixture(mutate_after_capture=True)
        with stack: result=module.compile_captured_recording(**request)
        self.assertEqual(result.compiled.source_sha256,SOURCE)

    def test_invalid_capture_or_name_is_refused_before_authority_and_job(self):
        for change in ({'status':'ready'}, {'source_sha256':'0'*64},
                       {'files':(('events.jsonl',bytearray(b'{}')),('meta.json',b'{}'))}):
            with self.subTest(change=tuple(change)):
                module,stack,request,trace,jobs=self.fixture()
                request['recording']=replace(request['recording'],**change)
                with stack,self.assertRaises(module.CompileProcessError) as caught:
                    module.compile_captured_recording(**request)
                self.assertEqual(caught.exception.code,'invalid_compile_request')
                self.assertEqual(trace,[])
                self.assertEqual(jobs,[])

    def test_cleanup_past_deadline_never_delivers_compiled_result(self):
        module,stack,request,trace,jobs=self.fixture(late_cleanup=True)
        with stack,self.assertRaises(module.CompileProcessError) as caught:
            module.compile_captured_recording(**request)
        self.assertEqual(caught.exception.code,'compile_timeout')
        self.assertIn('release',trace)

    def test_boolean_authority_cannot_start_native_work(self):
        module,stack,request,trace,jobs=self.fixture()
        request['revalidate']=lambda:True
        with stack,self.assertRaises(module.CompileProcessError) as caught:
            module.compile_captured_recording(**request)
        self.assertEqual(caught.exception.code,'compile_authority_unavailable')
        self.assertEqual(trace,[])
        self.assertEqual(jobs,[])

    def test_forced_partial_or_hash_mismatch_never_becomes_compiled_success(self):
        for option in ('forced','partial','wrong_hash'):
            with self.subTest(option=option):
                module,stack,request,trace,jobs=self.fixture(**{option:True})
                with stack,self.assertRaises(module.CompileProcessError) as caught:
                    module.compile_captured_recording(**request)
                self.assertEqual(caught.exception.code,'compile_worker_refused')
                self.assertIsNotNone(caught.exception.private_output)
                self.assertNotIn('PRIVATE_',str(caught.exception))

    def test_cancel_and_lost_lease_after_native_exit_still_refuse_delivery(self):
        for option,code in [('stop','compile_cancelled'),('authority_lost','compile_authority_unavailable')]:
            with self.subTest(option=option):
                module,stack,request,trace,jobs=self.fixture(**{option:True})
                with stack,self.assertRaises(module.CompileProcessError) as caught:
                    module.compile_captured_recording(**request)
                self.assertEqual(caught.exception.code,code)
                self.assertIn('release',trace)

    def test_poll_failure_preserves_private_output_after_cleanup_once(self):
        module,stack,request,trace,jobs=self.fixture(poll_error=True)
        with stack,self.assertRaises(module.CompileProcessError) as caught:
            module.compile_captured_recording(**request)
        self.assertEqual(caught.exception.code,'compile_process_failed')
        self.assertEqual(caught.exception.private_output.stderr,b'PRIVATE_DIAGNOSTIC')
        self.assertLess(trace.index('job_closed'),trace.index('output'))
        self.assertEqual(trace.count('output'),1)

    def test_unknown_cleanup_retains_owner_and_blocks_next_work(self):
        module,stack,request,trace,jobs=self.fixture(cleanup=False)
        with stack:
            with self.assertRaises(module.CompileProcessError) as caught:
                module.compile_captured_recording(**request)
            self.assertEqual(caught.exception.code,'compile_hold')
            self.assertIsNotNone(module._active)
            self.assertNotIn('release',trace)
            self.assertTrue(jobs[0].root.exists())
            with self.assertRaises(module.CompileProcessError) as second:
                module.compile_captured_recording(**request)
            self.assertEqual(second.exception.code,'compile_hold')
            errors=[]
            def wrong_owner():
                try: module.reconcile_compile()
                except module.CompileProcessError as error: errors.append(error.code)
            thread=threading.Thread(target=wrong_owner);thread.start();thread.join(2)
            self.assertFalse(thread.is_alive())
            self.assertEqual(errors,['compile_owner_mismatch'])
            # Test-only native port changes from unknown to confirmed closed.
            jobs[0].cleanup=lambda:True
            self.assertTrue(module.reconcile_compile())
            self.assertIsNone(module._active)
            self.assertEqual(trace.count('start'),1)
            self.assertFalse(jobs[0].root.exists())


if __name__=='__main__': unittest.main()
