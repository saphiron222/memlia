# Copyright (c) 2026 Memlia. All rights reserved.
"""Cleanup/operator composition; native adapters and console signals are doubled."""
import asyncio
from contextlib import contextmanager
import io
import json
import os
import subprocess
import sys
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch,Mock

from memlia_agent import host
from memlia_agent.host import HostError
import test_agent_dispatcher as dispatcher_fixtures


class OperatorDouble:
    def __init__(self, *, loop, request_stop):
        self.loop,self.stop=loop,request_stop
        self.closing=False;self.waiting=False;self.future=None
    def __enter__(self):return self
    def __exit__(self,*args):self.close_recovery()
    def begin_cleanup(self):self.closing=True
    def open_recovery(self):
        self.waiting=True;self.future=self.loop.create_future();return self.future
    def close_recovery(self):
        self.waiting=False
        if self.future is not None and not self.future.done():self.future.cancel()
    def reconcile(self):
        if self.waiting and not self.future.done():self.future.set_result(None)


class HostRecoveryTests(unittest.IsolatedAsyncioTestCase):
    @contextmanager
    def composed(self,dispatcher):
        module=__import__('memlia_agent.dispatcher',fromlist=['AgentDispatcher'])
        operators=[]
        def make(**kwargs):
            operator=OperatorDouble(**kwargs);operators.append(operator);return operator
        with (patch.object(module,'AgentDispatcher',return_value=dispatcher),
              patch.object(host,'ConsoleOperator',side_effect=make),
              patch.object(host,'_CLEANUP_WAIT_SECONDS',.02)):
            yield operators

    def run_host(self,on_status):
        return host.run_host(bootstrap=SimpleNamespace(organization_id=None,workspace_id='workspace-fiction',
            owner_user_id='user-fiction'),identity=SimpleNamespace(agent_id='agent-fiction'),
            authority=object(),on_status=on_status)

    async def test_failed_cleanup_retains_host_and_only_operator_retries(self):
        calls=[];shown=asyncio.Event()
        class Dispatcher:
            async def run_once(self):calls.append('run');return dict(status='uncertain',commandId='command-fiction')
            async def aclose(self):
                calls.append('cleanup')
                if calls.count('cleanup')==1:raise HostError('agent_cleanup_unverified')
        def status(value):self.assertEqual(value['phase'],'cleanup_required');shown.set()
        with self.composed(Dispatcher()) as operators:
            task=asyncio.create_task(self.run_host(status))
            try:
                await asyncio.wait_for(shown.wait(),1)
                await asyncio.sleep(.03)
                self.assertFalse(task.done());self.assertEqual(calls,['run','cleanup'])
                operators[0].reconcile();operators[0].reconcile()
                result=await asyncio.wait_for(task,1)
            finally:
                if not task.done():operators[0].reconcile();await asyncio.wait_for(task,1)
        self.assertEqual(calls,['run','cleanup','cleanup'])
        self.assertEqual(result,dict(phase='intervention_required',commandId='command-fiction'))

    async def test_pending_cleanup_is_reobserved_not_queued_again_or_cancelled(self):
        release=asyncio.Event();shown=asyncio.Event();calls=[]
        class Dispatcher:
            async def run_once(self):return dict(status='uncertain',commandId='command-fiction')
            async def aclose(self):
                calls.append('cleanup')
                try:await release.wait()
                except asyncio.CancelledError:calls.append('cancelled');raise
        def status(value):self.assertTrue(value['cleanupPending']);shown.set()
        with self.composed(Dispatcher()) as operators:
            task=asyncio.create_task(self.run_host(status))
            try:
                await asyncio.wait_for(shown.wait(),1)
                for _ in range(4):operators[0].reconcile()
                await asyncio.sleep(.03)
                self.assertEqual(calls,['cleanup']);self.assertFalse(task.done())
                release.set();await asyncio.wait_for(task,1)
            finally:
                release.set()
                if not task.done():operators[0].reconcile();await asyncio.wait_for(task,1)
        self.assertEqual(calls,['cleanup'])

    async def test_interruption_during_capture_finishes_owned_work_before_cleanup(self):
        started=asyncio.Event();stopped=asyncio.Event();shown=asyncio.Event();calls=[]
        class Dispatcher:
            async def run_once(self):
                started.set()
                try:await asyncio.Future()
                finally:
                    await asyncio.sleep(.01);stopped.set();calls.append('native_stopped')
            async def aclose(self):
                if not stopped.is_set():raise AssertionError('owner still running')
                calls.append('cleanup')
                if calls.count('cleanup')==1:raise HostError('agent_cleanup_unverified')
        with self.composed(Dispatcher()) as operators:
            task=asyncio.create_task(self.run_host(lambda value:shown.set()))
            try:
                await asyncio.wait_for(started.wait(),1);operators[0].stop()
                await asyncio.wait_for(shown.wait(),1)
                self.assertFalse(task.done());operators[0].reconcile()
                result=await asyncio.wait_for(task,1)
            finally:
                if not task.done():operators[0].reconcile();await asyncio.wait_for(task,1)
        self.assertEqual(calls,['native_stopped','cleanup','cleanup'])
        self.assertEqual(result['phase'],'intervention_required')
        self.assertEqual(result['reasonCode'],'agent_interrupted')

    async def test_network_uncertainty_remains_blocking_after_successful_reconciliation(self):
        shown=asyncio.Event();calls=[]
        class Dispatcher:
            async def run_once(self):calls.append('run');raise HostError('agent_receipt_unconfirmed')
            async def aclose(self):
                calls.append('cleanup')
                if calls.count('cleanup')==1:raise RuntimeError('PRIVATE_CLEANUP_DIAGNOSTIC_FICTION')
        with self.composed(Dispatcher()) as operators:
            task=asyncio.create_task(self.run_host(lambda value:shown.set()))
            await asyncio.wait_for(shown.wait(),1)
            self.assertFalse(task.done());operators[0].reconcile()
            with self.assertRaises(HostError) as caught:await asyncio.wait_for(task,1)
        self.assertEqual(caught.exception.code,'agent_receipt_unconfirmed')
        self.assertEqual(calls,['run','cleanup','cleanup'])

    async def test_real_dispatcher_keeps_original_native_thread_for_operator_cleanup(self):
        module,authority,dispatcher=dispatcher_fixtures.DispatcherTests.fixture(self)
        threads,capture,compiler=dispatcher_fixtures.DispatcherTests.adapters(self,module,authority,failure=True)
        shown=asyncio.Event();cleanup_threads=[]
        def cleanup():
            cleanup_threads.append(threading.get_ident())
            if len(cleanup_threads)==1:raise HostError('agent_cleanup_unverified')
        with (self.composed(dispatcher) as operators,
              patch.object(module,'observe_session',return_value=dispatcher_fixtures.OBSERVED),
              patch.object(module,'reconcile_capture',side_effect=cleanup),capture,compiler):
            task=asyncio.create_task(self.run_host(lambda value:shown.set()))
            try:
                await asyncio.wait_for(shown.wait(),1)
                self.assertTrue(dispatcher._native.thread.is_alive())
                operators[0].reconcile();operators[0].reconcile()
                result=await asyncio.wait_for(task,1)
            finally:
                if not task.done():operators[0].reconcile();await asyncio.wait_for(task,1)
        self.assertEqual(cleanup_threads,[threads[0],threads[0]])
        self.assertFalse(dispatcher._native.thread.is_alive())
        self.assertEqual(authority.calls.count('claim'),1)
        self.assertEqual(result['phase'],'intervention_required')


class ConsoleOperatorTests(unittest.IsolatedAsyncioTestCase):
    async def test_queued_signal_cannot_request_a_later_recovery_generation(self):
        prior=object();handlers={host.signal.SIGINT:prior};loop=asyncio.get_running_loop()
        def register(number,handler):
            old=handlers[number];handlers[number]=handler;return old
        with (patch.object(host.signal,'getsignal',side_effect=lambda number:handlers[number]),
              patch.object(host.signal,'signal',side_effect=register)):
            with host.ConsoleOperator(loop=loop,request_stop=lambda:None) as operator:
                operator.begin_cleanup();operator.open_recovery()
                handlers[host.signal.SIGINT](host.signal.SIGINT,None)
                operator.close_recovery();next_request=operator.open_recovery()
                await asyncio.sleep(0)
                self.assertFalse(next_request.done())

    async def test_sigint_is_scoped_restored_and_coalesces_running_and_cleanup_states(self):
        seen=[];prior=object();handlers={host.signal.SIGINT:prior};loop=asyncio.get_running_loop()
        def register(number,handler):
            old=handlers[number];handlers[number]=handler;return old
        with (patch.object(host.signal,'getsignal',side_effect=lambda number:handlers[number]),
              patch.object(host.signal,'signal',side_effect=register)):
            with host.ConsoleOperator(loop=loop,request_stop=lambda:seen.append('stop')) as operator:
                callback=handlers[host.signal.SIGINT]
                callback(host.signal.SIGINT,None);callback(host.signal.SIGINT,None)
                await asyncio.sleep(0);self.assertEqual(seen,['stop'])
                operator.begin_cleanup();callback(host.signal.SIGINT,None)
                future=operator.open_recovery()
                callback(host.signal.SIGINT,None);callback(host.signal.SIGINT,None)
                await asyncio.sleep(0)
                self.assertTrue(future.done());self.assertEqual(seen,['stop'])
                operator.close_recovery()
            self.assertIs(handlers[host.signal.SIGINT],prior)


class EntryRecoveryTests(unittest.TestCase):
    def test_broken_console_never_raises_or_prints_a_native_exception(self):
        from memlia_agent import __main__ as entry
        from test_agent_main import bootstrap
        async def operation(*args,**kwargs):return {'phase':'active'}
        output=Mock();output.write.side_effect=OSError('PRIVATE_BROKEN_CONSOLE_FICTION')
        diagnostic=io.StringIO()
        with (patch.object(host,'perform_operation',side_effect=operation),
              patch.object(entry.sys,'stdin',SimpleNamespace(buffer=io.BytesIO(json.dumps(bootstrap()).encode()))),
              patch.object(entry.sys,'stdout',output),patch.object(entry.sys,'stderr',diagnostic)):
            result=entry.main(['status'])
        self.assertEqual(result,2);self.assertEqual(diagnostic.getvalue(),'')

    @unittest.skipUnless(os.name=='posix','Actual POSIX signals do not qualify Windows console handling')
    def test_actual_asyncio_runner_sigint_stop_reconcile_and_handler_restore(self):
        # Real POSIX SIGINT in an owned child, no Windows/UI/engine or network.
        program='''
import asyncio,json,os,signal
from types import SimpleNamespace
from memlia_agent import host,dispatcher
class FakeDispatcher:
    attempts=0
    async def run_once(self):
        asyncio.get_running_loop().call_later(.02,os.kill,os.getpid(),signal.SIGINT)
        await asyncio.Future()
    async def aclose(self):
        self.attempts+=1
        if self.attempts==1:raise host.HostError('agent_cleanup_unverified')
dispatcher.AgentDispatcher=lambda **kwargs:FakeDispatcher()
def status(value):
    print(json.dumps(value),flush=True)
    loop=asyncio.get_running_loop()
    loop.call_later(.01,os.kill,os.getpid(),signal.SIGINT)
    loop.call_later(.01,os.kill,os.getpid(),signal.SIGINT)
async def run():
    before=signal.getsignal(signal.SIGINT)
    result=await host.run_host(bootstrap=SimpleNamespace(organization_id=None,workspace_id='fiction',owner_user_id='fiction'),
        identity=SimpleNamespace(agent_id='fiction'),authority=object(),on_status=status)
    assert signal.getsignal(signal.SIGINT) is before
    print(json.dumps(result),flush=True)
asyncio.run(run())
assert signal.getsignal(signal.SIGINT) is signal.default_int_handler
'''
        result=subprocess.run([sys.executable,'-B','-c',program],stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,timeout=3,check=False)
        self.assertEqual(result.returncode,0,result.stderr.decode(errors='replace'))
        lines=[json.loads(line) for line in result.stdout.splitlines()]
        self.assertEqual(len(lines),2)
        self.assertEqual(lines[0]['phase'],'cleanup_required')
        self.assertEqual(lines[1],dict(phase='intervention_required',reasonCode='agent_interrupted'))
        self.assertEqual(result.stderr,b'')

    def test_entry_emits_only_closed_recovery_status_and_preserves_network_error(self):
        from memlia_agent import __main__ as entry
        from test_agent_main import bootstrap
        raw=json.dumps(bootstrap(controlOrigin='https://control-fiction.invalid',
            controlCaPem='public-fictional-control-ca')).encode()
        async def operation(_operation,_bootstrap,*,on_status):
            on_status(dict(phase='cleanup_required',code='agent_cleanup_unverified',cleanupPending=False,
                           operatorAction='press_ctrl_c_to_reconcile'))
            raise HostError('agent_receipt_unconfirmed') from OSError('PRIVATE_NATIVE_DIAGNOSTIC_FICTION')
        output=io.StringIO()
        with (patch.object(host,'perform_operation',side_effect=operation),
              patch.object(entry.sys,'stdin',SimpleNamespace(buffer=io.BytesIO(raw))),
              patch.object(entry.sys,'stdout',output)):
            result=entry.main(['run'])
        values=[json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(result,2)
        self.assertEqual(values[-1],{'error':'agent_receipt_unconfirmed'})
        self.assertNotIn('PRIVATE_',output.getvalue())
