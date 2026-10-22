# Copyright (c) 2026 Memlia. All rights reserved.
"""Actual dispatcher/canonical contracts; native adapters and authority are doubles.

These tests perform no Windows observation, local consent, capture or network IO.
"""
import asyncio
import copy
from datetime import datetime, timedelta, timezone
import hashlib
import importlib
import io
import json
import threading
import unittest
from unittest.mock import patch
import zipfile

from memlia_contracts import desktop_command_digest
from memlia_agent.host import HostError
from memlia_agent.session import SessionObservation
from memlia_agent.openadapt_capture import CapturedRecording, CaptureError
from memlia_agent.openadapt_compile import BundleFile, CompiledRecording, _digest, _VERSIONS
from memlia_agent.openadapt_compile_process import CompiledCapture

OBSERVED=SessionObservation('S-1-5-21-111-222-333-1001',1,1)

def stamp(value): return value.isoformat(timespec='milliseconds').replace('+00:00','Z')

def command():
    now=datetime.now(timezone.utc)
    value=dict(schemaVersion='memlia.desktop-command/v2',organizationId=None,workspaceId='workspace-fiction',
        agentId='agent-fiction',ownerUserId='user-fiction',windowsSid=OBSERVED.windows_sid,sessionId='1',
        leaseEpoch=3,issuedAt=stamp(now-timedelta(seconds=1)),expiresAt=stamp(now+timedelta(seconds=45)),
        resourceLocks=[dict(kind='desktop',resourceId='desktop-fiction',fence=4)],
        commandId='command-fiction',runId='run-fiction',capabilityId='capability-fiction',
        bundle=dict(artifactId='manifest-fiction',sha256='sha256:'+hashlib.sha256(b'{}').hexdigest()),
        qualification=dict(artifactId='intent-fiction',sha256='sha256:'+hashlib.sha256(b'{}').hexdigest()),
        action=dict(kind='capture.start',maxDurationSeconds=30,maxBytes=4096,audio=False),digest='sha256:'+'0'*64)
    value['digest']=desktop_command_digest(value)
    return value

class AuthorityDouble:
    def __init__(self,value): self.value=value;self.receipts=[];self.calls=[];self.bad_capability=False
    async def claim(self,session): self.calls.append('claim');return self.value
    async def checkpoint(self,command,capability): self.calls.append('checkpoint')
    async def consent(self,command,observation):
        self.calls.append('consent')
        value={key:copy.deepcopy(command[key]) for key in ('organizationId','workspaceId','agentId','ownerUserId',
            'windowsSid','sessionId','leaseEpoch','issuedAt','expiresAt','resourceLocks','capabilityId','qualification')}
        value.update(schemaVersion='memlia.session-capability/v1',capabilities=['desktop.capture'],
            consent={key:observation[key] for key in ('consentId','confirmedLocallyAt','commandDigest')})
        if self.bad_capability: value['resourceLocks'][0]['fence']+=1
        return value
    async def artifact(self,command,reference,maximum): self.calls.append('artifact');return b'{}'
    async def publish(self,command,receipt,artifacts):
        self.receipts.append((copy.deepcopy(receipt),artifacts));self.calls.append('publish')

class DispatcherTests(unittest.IsolatedAsyncioTestCase):
    def fixture(self,value=None):
        module=importlib.import_module('memlia_agent.dispatcher')
        authority=AuthorityDouble(command() if value is None else value)
        binding=module.AgentScope(organization_id=None,workspace_id='workspace-fiction',
            agent_id='agent-fiction',owner_user_id='user-fiction')
        dispatcher=module.AgentDispatcher(scope=binding,authority=authority)
        self.addAsyncCleanup(dispatcher.aclose)
        return module,authority,dispatcher

    def adapters(self,module,authority,*,failure=False):
        threads=[]
        def capture(**kwargs):
            threads.append(threading.get_ident());authority.calls.append('native_dialog')
            kwargs['revalidate']()
            kwargs['on_local_consent'](dict(consentId='consent-fiction',confirmedLocallyAt=stamp(datetime.now(timezone.utc)),
                commandDigest=authority.value['digest'],windowsSid=OBSERVED.windows_sid,sessionId='1'))
            authority.calls.append('effect');kwargs['revalidate']()
            if failure:
                error=CaptureError('capture_hold');error.private_output=b'PRIVATE_NATIVE_FICTION';raise error
            return CapturedRecording((),(),authority.value['digest'],'0'*64,None)
        def compile(**kwargs):
            threads.append(threading.get_ident());kwargs['revalidate']();authority.calls.append('compile')
            data=(('deployment.json',b'{}'),('manifest.json',b'{}'),('workflow.json',b'{}'))
            files=tuple(BundleFile(name,raw,hashlib.sha256(raw).hexdigest()) for name,raw in data)
            compiled=CompiledRecording(files,'0'*64,_digest(data,b'memlia.openadapt-bundle/v1\0'),1,
                                       tuple(sorted(_VERSIONS.items())))
            return CompiledCapture(compiled,authority.value['digest'],None)
        return threads,patch.object(module,'record_capture',side_effect=capture),patch.object(
            module,'compile_captured_recording',side_effect=compile)

    async def test_capture_consent_compile_and_receipts_use_canonical_contracts(self):
        module,authority,dispatcher=self.fixture()
        threads,capture,compiler=self.adapters(module,authority)
        with patch.object(module,'observe_session',return_value=OBSERVED),capture,compiler:
            result=await dispatcher.run_once()
        self.assertEqual(result['status'],'to_test')
        self.assertEqual(len(set(threads)),1);self.assertNotEqual(threads[0],threading.get_ident())
        self.assertLess(authority.calls.index('native_dialog'),authority.calls.index('consent'))
        self.assertLess(authority.calls.index('consent'),authority.calls.index('effect'))
        self.assertLess(authority.calls.index('effect'),authority.calls.index('compile'))
        self.assertEqual([item[0]['outcome']['status'] for item in authority.receipts],
                         ['awaiting_local_consent','running','succeeded_verified'])
        receipt,artifacts=authority.receipts[-1]
        self.assertEqual(receipt['outcome']['verifierId'],'memlia_capture_compile_v1')
        self.assertEqual(len(artifacts),1)
        self.assertEqual(receipt['outcome']['evidence'],[artifacts[0].reference])
        with zipfile.ZipFile(io.BytesIO(artifacts[0].content)) as archive:
            manifest=json.loads(archive.read('memlia-compiled-recording.json'))
            self.assertEqual(manifest['status'],'to_test')
        self.assertNotIn('PRIVATE_',repr(result))

    async def test_replayed_claim_never_executes_twice(self):
        module,authority,dispatcher=self.fixture();threads,capture,compiler=self.adapters(module,authority)
        with patch.object(module,'observe_session',return_value=OBSERVED),capture,compiler:
            await dispatcher.run_once()
            with self.assertRaises(HostError): await dispatcher.run_once()
        self.assertEqual(len(threads),2)  # capture + compile of a single command.

    async def test_changed_digest_expiry_scope_or_fence_refuses_before_adapter(self):
        for change in ('digest','expiry','scope','fence','session'):
            with self.subTest(change=change):
                value=command()
                if change=='digest': value['digest']='sha256:'+'1'*64
                elif change=='expiry': value['expiresAt']=stamp(datetime.now(timezone.utc)-timedelta(seconds=2))
                elif change=='scope': value['workspaceId']='foreign-fiction'
                elif change=='fence': value['resourceLocks'][0]['fence']+=1
                else: value['sessionId']='2'
                # Expiry/scope/session negatives also carry a valid new digest.
                if change in ('expiry','scope','session'): value['digest']=desktop_command_digest(value)
                module,authority,dispatcher=self.fixture(value)
                with patch.object(module,'observe_session',return_value=OBSERVED),patch.object(module,'record_capture') as adapter:
                    with self.assertRaises(HostError): await dispatcher.run_once()
                adapter.assert_not_called()

    async def test_wrong_capability_fence_cannot_admit_effect(self):
        module,authority,dispatcher=self.fixture();authority.bad_capability=True
        threads,capture,compiler=self.adapters(module,authority)
        with patch.object(module,'observe_session',return_value=OBSERVED),capture,compiler:
            result=await dispatcher.run_once()
        self.assertEqual(result['status'],'failed');self.assertNotIn('effect',authority.calls)
        self.assertNotIn('compile',authority.calls)

    async def test_artifact_hash_is_checked_before_native_dialog(self):
        module,authority,dispatcher=self.fixture()
        async def changed(*args):return b'PRIVATE_CHANGED_ARTIFACT'
        authority.artifact=changed
        with patch.object(module,'observe_session',return_value=OBSERVED),patch.object(module,'record_capture') as adapter:
            with self.assertRaises(HostError): await dispatcher.run_once()
        adapter.assert_not_called()

    async def test_unverified_cleanup_stays_uncertain_and_keeps_private_output(self):
        module,authority,dispatcher=self.fixture();threads,capture,compiler=self.adapters(module,authority,failure=True)
        with patch.object(module,'observe_session',return_value=OBSERVED),capture,compiler:
            result=await dispatcher.run_once()
        self.assertEqual(result['status'],'uncertain')
        self.assertEqual(dispatcher.private_output,b'PRIVATE_NATIVE_FICTION')
        self.assertNotIn('PRIVATE_',json.dumps(result))
        self.assertTrue(authority.receipts[-1][0]['outcome']['reconciliationRequired'])

    async def test_missing_live_authority_refuses_before_native_dialog(self):
        module,authority,dispatcher=self.fixture()
        async def refused(*args):raise OSError('PRIVATE_AUTHORITY_FICTION')
        authority.checkpoint=refused
        with patch.object(module,'observe_session',return_value=OBSERVED),patch.object(module,'record_capture') as adapter:
            with self.assertRaises(HostError) as caught: await dispatcher.run_once()
        self.assertNotIn('PRIVATE_',str(caught.exception));adapter.assert_not_called()

    async def test_production_and_excel_are_closed_not_emulated(self):
        for kind in ('procedure.run','excel.apply'):
            value=command()
            if kind=='procedure.run':value['action']=dict(kind=kind,mode='production',procedure=value['bundle'],parameters=value['bundle'])
            else:value['action']=dict(kind=kind,patch=value['bundle'],approvalId='approval-fiction',backup=value['bundle'])
            value['digest']=desktop_command_digest(value)
            module,authority,dispatcher=self.fixture(value)
            with patch.object(module,'observe_session',return_value=OBSERVED),patch.object(module,'record_capture') as adapter:
                with self.assertRaises(HostError) as caught: await dispatcher.run_once()
            self.assertEqual(caught.exception.code,'agent_adapter_unconfigured');adapter.assert_not_called()

    async def test_empty_claim_is_idle_without_a_consent_or_receipt(self):
        module,authority,dispatcher=self.fixture();authority.value=None
        with patch.object(module,'observe_session',return_value=OBSERVED):self.assertIsNone(await dispatcher.run_once())
        self.assertEqual(authority.calls,['claim'])

    async def test_lost_publication_is_not_retried_or_reported_as_success(self):
        module,authority,dispatcher=self.fixture();threads,capture,compiler=self.adapters(module,authority)
        original=authority.publish
        async def lost(command,receipt,artifacts):
            await original(command,receipt,artifacts)
            if artifacts:raise OSError('PRIVATE_LOST_RESPONSE_FICTION')
        authority.publish=lost
        with patch.object(module,'observe_session',return_value=OBSERVED),capture,compiler:
            with self.assertRaises(HostError):await dispatcher.run_once()
            with self.assertRaises(HostError):await dispatcher.run_once()
        self.assertEqual(len([item for item in authority.receipts if item[1]]),1)
        self.assertEqual(len(threads),2)

    async def test_native_owner_remains_alive_and_cleanup_uses_same_thread_after_hold(self):
        module,authority,dispatcher=self.fixture();threads,capture,compiler=self.adapters(module,authority,failure=True)
        with patch.object(module,'observe_session',return_value=OBSERVED),capture,compiler:
            result=await dispatcher.run_once()
        self.assertEqual(result['status'],'uncertain');self.assertTrue(dispatcher._native.thread.is_alive())
        cleanup_threads=[]
        def cleanup():cleanup_threads.append(threading.get_ident())
        with patch.object(module,'reconcile_capture',side_effect=cleanup):await dispatcher.aclose()
        self.assertEqual(cleanup_threads,[threads[0]])
        self.assertFalse(dispatcher._native.thread.is_alive())

    async def test_cleanup_unknown_keeps_owner_until_explicit_reconciliation_succeeds(self):
        module,authority,dispatcher=self.fixture();threads,capture,compiler=self.adapters(module,authority,failure=True)
        with patch.object(module,'observe_session',return_value=OBSERVED),capture,compiler:await dispatcher.run_once()
        with patch.object(module,'reconcile_capture',side_effect=RuntimeError('PRIVATE_CLEANUP_FICTION')):
            with self.assertRaises(HostError) as caught:await dispatcher.aclose()
        self.assertEqual(caught.exception.code,'agent_cleanup_unverified')
        self.assertTrue(dispatcher._native.thread.is_alive())
        with patch.object(module,'observe_session',return_value=OBSERVED):
            with self.assertRaises(HostError):await dispatcher.run_once()
        await dispatcher.aclose()

    async def test_mutating_source_during_checkpoint_does_not_change_captured_command(self):
        module,authority,dispatcher=self.fixture();threads,capture,compiler=self.adapters(module,authority)
        original=authority.checkpoint
        async def changed(value,capability):
            self.assertEqual(value['workspaceId'],'workspace-fiction')
            await original(value,capability)
            value['workspaceId']='foreign-mutated-fiction'
            authority.value['action']['audio']=True
        authority.checkpoint=changed
        with patch.object(module,'observe_session',return_value=OBSERVED),capture,compiler:
            result=await dispatcher.run_once()
        self.assertEqual(result['status'],'to_test')

class PersonalTestDispatcher(unittest.IsolatedAsyncioTestCase):
    def personal(self):
        from memlia_agent import dispatcher as d
        from test_openadapt_compile_worker import OUTPUT
        files=tuple(BundleFile(name,raw,hashlib.sha256(raw).hexdigest()) for name,raw in OUTPUT)
        compiled=CompiledRecording(files,'a'*64,_digest(tuple(sorted(OUTPUT)),b'memlia.openadapt-bundle/v1\0'),1,tuple(sorted(_VERSIONS.items())))
        archive=d._archive(CompiledCapture(compiled,'sha256:'+'b'*64,None))
        value=command(); value['bundle']=archive.reference
        bodies={archive.artifact_id:archive.content}
        def ref(name,raw):bodies[name]=raw;return dict(artifactId=name,sha256='sha256:'+hashlib.sha256(raw).hexdigest())
        deployment=ref('deployment',b'{"backend":{"kind":"windows"},"runtime":{"profile":"demo","allow_model_grounding":false,"grounding_model":{"enabled":false}},"effects":{"kind":"none"}}')
        parameters=ref('parameters',b'{}')
        value['action']=dict(kind='procedure.run',mode='test',procedure=deployment,parameters=parameters)
        admission={key:value[key] for key in ('commandId','runId','agentId','organizationId','workspaceId','ownerUserId','windowsSid','sessionId')}
        admission.update(schemaVersion='memlia.personal-test-admission/v1',purpose='personal_test',productionAdmitted=False,
            procedureId='11111111-1111-4111-8111-111111111111',revision=1,maxDurationSeconds=45,bundle=archive.reference,
            procedure=deployment,parameters=parameters,localConsentRequired=True)
        value['qualification']=ref('admission',json.dumps(admission).encode());value['digest']=desktop_command_digest(value)
        class Authority(AuthorityDouble):
            async def artifact(self,command,reference,maximum):return bodies[reference['artifactId']]
            async def consent(self,command,observation):
                cap=await super().consent(command,observation);cap['capabilities']=['desktop.replay'];return cap
        auth=Authority(value);scope=d.AgentScope(organization_id=None,workspace_id=value['workspaceId'],agent_id=value['agentId'],owner_user_id=value['ownerUserId'])
        dispatcher=d.AgentDispatcher(scope=scope,authority=auth);self.addAsyncCleanup(dispatcher.aclose)
        return d,compiled,value,bodies,auth,dispatcher

    async def test_personal_test_uses_replay_consent_and_preserves_unverified_report_without_capture(self):
        from memlia_agent.openadapt_replay import ReplayObservation
        d,compiled,value,bodies,auth,dispatcher=self.personal()
        def replay(**kwargs):
            kwargs['revalidate']()
            kwargs['on_local_consent'](dict(consentId='test-consent',confirmedLocallyAt=stamp(datetime.now(timezone.utc)),commandDigest=value['digest'],windowsSid=OBSERVED.windows_sid,sessionId='1'))
            kwargs['revalidate']()
            self.assertEqual(kwargs['compiled'],compiled);self.assertEqual(kwargs['mode'],'test')
            return ReplayObservation('test','COMPLETED_UNVERIFIED','test_observed',value['digest'],compiled.bundle_sha256,
                (('run/report.json',b'{"execution_profile":"demo","execution_outcome":"COMPLETED_UNVERIFIED","transaction_outcome":"COMPLETED_UNVERIFIED","production_eligible":false}'),),None)
        with patch.object(d,'observe_session',return_value=OBSERVED),patch.object(d,'replay_compiled_recording',side_effect=replay),patch.object(d,'record_capture') as capture,patch.object(d,'compile_captured_recording') as compile:
            result=await dispatcher.run_once()
        capture.assert_not_called();compile.assert_not_called()
        self.assertEqual(result['status'],'uncertain')
        self.assertTrue(dispatcher._blocked)
        self.assertEqual(auth.receipts[-1][0]['outcome']['status'],'uncertain')
        self.assertTrue(auth.receipts[-1][0]['outcome']['evidence'])

    async def test_bad_personal_manifest_or_source_refuses_before_any_consent_or_native_adapter(self):
        for field in ('qualification','procedure','bundle'):
            with self.subTest(field=field):
                d,compiled,value,bodies,auth,dispatcher=self.personal()
                ref=value[field] if field in ('qualification','bundle') else value['action'][field]
                if field=='qualification':
                    manifest=json.loads(bodies[ref['artifactId']]);manifest['sessionId']='foreign';raw=json.dumps(manifest).encode()
                elif field=='procedure':raw=b'{"runtime":{"profile":"standard"}}'
                else:raw=b'not-a-native-compiled-archive'
                bodies[ref['artifactId']]=raw;ref['sha256']='sha256:'+hashlib.sha256(raw).hexdigest()
                value['digest']=desktop_command_digest(value)
                with patch.object(d,'observe_session',return_value=OBSERVED),patch.object(d,'replay_compiled_recording') as replay,patch.object(d,'record_capture') as capture:
                    with self.assertRaises(HostError):await dispatcher.run_once()
                replay.assert_not_called();capture.assert_not_called();self.assertNotIn('consent',auth.calls)
                self.assertEqual(auth.receipts,[])

    async def test_personal_worker_failure_preserves_private_report_and_never_retries(self):
        from memlia_agent.openadapt_replay import ReplayError
        d,compiled,value,bodies,auth,dispatcher=self.personal()
        def replay(**kwargs):
            kwargs['on_local_consent'](dict(consentId='test-consent',confirmedLocallyAt=stamp(datetime.now(timezone.utc)),commandDigest=value['digest'],windowsSid=OBSERVED.windows_sid,sessionId='1'))
            error=ReplayError('replay_result_uncertain')
            error.private_artifacts=(('run/report.json',b'{"partial":"PRIVATE_FICTIVE_REPORT"}'),)
            raise error
        with patch.object(d,'observe_session',return_value=OBSERVED),patch.object(d,'replay_compiled_recording',side_effect=replay) as native:
            result=await dispatcher.run_once()
            with self.assertRaises(HostError):await dispatcher.run_once()
        self.assertEqual(result['status'],'uncertain');self.assertEqual(native.call_count,1)
        receipt,artifacts=auth.receipts[-1]
        self.assertEqual(receipt['outcome']['evidence'],[artifacts[0].reference])
        self.assertEqual(artifacts[0].content,b'{"partial":"PRIVATE_FICTIVE_REPORT"}')
        self.assertNotIn('PRIVATE_',json.dumps(receipt))
