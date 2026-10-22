# Copyright (c) 2026 Memlia. All rights reserved.
"""Real owned loopback mTLS with fictional keys; credential API is doubled.

The remote control service/DB and Windows CredMan are not qualified here.
"""
import base64
import hashlib
import importlib
import json
import os
import unittest
from unittest.mock import patch

from memlia_contracts import validate
from memlia_agent.client_identity import ClientIdentity
from memlia_agent.user_credentials import CurrentUserCredentialStore
from memlia_agent.transport import TransportError
from memlia_agent.dispatcher import OpaqueArtifact
import test_agent_dispatcher as dispatcher_fixtures
from test_agent_dispatcher import command, AuthorityDouble, OBSERVED
import test_client_identity as identities
import test_transport as fixtures


class AgentControlTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        identities.ClientIdentityTests.setUpClass()
        cls.addClassCleanup(identities.ClientIdentityTests.tearDownClass)
        cls.identity_fixture=identities.ClientIdentityTests

    def channel(self,origin,**changes):
        module=importlib.import_module('memlia_agent.control');fixture=self.identity_fixture
        identity=ClientIdentity(instance_id='fixture-instance',agent_id='fixture-agent',
            certificate_chain_pem=fixture.client_cert,encrypted_pkcs8_pem=fixture.client_key)
        with patch.object(CurrentUserCredentialStore,'load',return_value=bytearray(fixture.password)):
            return module.AgentControlChannel(origin=origin,ca_pem=fixture.ca,max_response_bytes=524288,
                total_timeout_seconds=changes.get('timeout',2),max_connections=1,client_identity=identity)

    def reply(self,request,**fields):
        return dict(schemaVersion='memlia.agent-control-response/v1',requestId=request['requestId'],
                    op=request['op'],**fields)

    async def test_claim_posts_only_fixed_control_path_with_client_certificate(self):
        peers=[]
        async def serve(writer,count):
            peers.append(writer.get_extra_info('ssl_object').getpeercert(binary_form=True))
            request=json.loads(server.request_bodies[-1]);validate('AgentControlRequest',request)
            self.assertEqual(request['op'],'claim')
            await fixtures.response(json.dumps(self.reply(request,command=None)).encode())(writer,count)
        async with fixtures.TlsServer(self.identity_fixture.server_tls,serve,max_request_body_bytes=524288) as server:
            with patch.dict(os.environ,{'HTTPS_PROXY':'http://127.0.0.1:1','SSLKEYLOGFILE':'/not-owned/no-keylog'}):
                async with self.channel(server.origin) as channel:
                    self.assertIsNone(await channel.claim(dict(windowsSid='S-1-5-21-1',sessionId='1')))
            self.assertEqual(peers,[self.identity_fixture.client_der])
            self.assertEqual(len(server.requests),1)
            self.assertTrue(server.requests[0].startswith(b'POST /v1/agent/control HTTP/1.1\r\n'))
            for header in (b'cookie:',b'authorization:',b'origin:'):
                self.assertNotIn(header,server.requests[0].lower())

    async def test_response_operation_and_request_id_are_both_correlated(self):
        for change in ('op','requestId','unknown'):
            async def serve(writer,count):
                request=json.loads(server.request_bodies[-1]);value=self.reply(request,command=None)
                if change=='op':value=self.reply(request,accepted=True);value['op']='checkpoint'
                elif change=='requestId':value['requestId']='foreign-fiction'
                else:value['private']='PRIVATE_SERVER_FICTION'
                await fixtures.response(json.dumps(value).encode())(writer,count)
            async with fixtures.TlsServer(self.identity_fixture.server_tls,serve,max_request_body_bytes=524288) as server:
                async with self.channel(server.origin) as channel:
                    with self.assertRaises(TransportError) as caught:
                        await channel.claim(dict(windowsSid='S-1-5-21-1',sessionId='1'))
                self.assertEqual(len(server.requests),1)
                self.assertNotIn('PRIVATE_',str(caught.exception))

    async def test_artifact_read_checks_contiguous_chunks_hash_and_declared_bound(self):
        data=b'f'*(262144+17);reference=dict(artifactId='artifact-fiction',sha256='sha256:'+hashlib.sha256(data).hexdigest())
        async def serve(writer,count):
            request=json.loads(server.request_bodies[-1]);validate('AgentControlRequest',request)
            offset=request['offset'];part=data[offset:offset+request['limit']]
            value=self.reply(request,reference=reference,offset=offset,totalBytes=len(data),
                dataBase64=base64.b64encode(part).decode('ascii'),done=offset+len(part)==len(data))
            await fixtures.response(json.dumps(value).encode())(writer,count)
        async with fixtures.TlsServer(self.identity_fixture.server_tls,serve,max_request_body_bytes=524288) as server:
            async with self.channel(server.origin) as channel:
                self.assertEqual(await channel.artifact(command(),reference,len(data)),data)
            self.assertEqual([json.loads(raw)['offset'] for raw in server.request_bodies],[0,262144])

    async def test_bad_read_offset_base64_or_size_never_continues(self):
        reference=dict(artifactId='artifact-fiction',sha256='sha256:'+hashlib.sha256(b'M').hexdigest())
        for bad in ('offset','base64','decoded_size','size'):
            async def serve(writer,count):
                request=json.loads(server.request_bodies[-1]);value=self.reply(request,reference=reference,
                    offset=1 if bad=='offset' else 0,totalBytes=2 if bad=='size' else 1,
                    dataBase64='TR==' if bad=='base64' else ('A'*349528 if bad=='decoded_size' else 'TQ=='),done=True)
                await fixtures.response(json.dumps(value).encode())(writer,count)
            async with fixtures.TlsServer(self.identity_fixture.server_tls,serve,max_request_body_bytes=524288) as server:
                async with self.channel(server.origin) as channel:
                    with self.assertRaises(TransportError):await channel.artifact(command(),reference,1)
                self.assertEqual(len(server.requests),1)

    async def test_publish_uploads_exact_bytes_then_one_strict_receipt(self):
        value=command();authority=AuthorityDouble(value)
        observation=dict(consentId='consent-fiction',confirmedLocallyAt=value['issuedAt'],
            commandDigest=value['digest'],windowsSid=value['windowsSid'],sessionId=value['sessionId'])
        capability=await authority.consent(value,observation)
        artifact=OpaqueArtifact('output-fiction',b'g'*(262144+7));uploaded=bytearray()
        receipt=dict(schemaVersion='memlia.run-receipt/v1',organizationId=value['organizationId'],workspaceId=value['workspaceId'],
            runId=value['runId'],commandId=value['commandId'],sequence=2,recordedAt=value['issuedAt'],
            outcome=dict(status='succeeded_verified',effect='known',evidence=[artifact.reference],verifierId='memlia_capture_compile_v1'))
        async def serve(writer,count):
            request=json.loads(server.request_bodies[-1]);validate('AgentControlRequest',request)
            if request['op']=='consent':reply=self.reply(request,capability=capability)
            elif request['op']=='artifact.put':
                self.assertEqual(request['offset'],len(uploaded))
                part=base64.b64decode(request['dataBase64'],validate=True);uploaded.extend(part)
                reply=self.reply(request,reference=artifact.reference,nextOffset=len(uploaded),complete=len(uploaded)==len(artifact.content))
            else:
                self.assertEqual(request['op'],'publish');self.assertEqual(bytes(uploaded),artifact.content)
                self.assertEqual(request['receipt'],receipt)
                reply=self.reply(request,accepted=True)
            await fixtures.response(json.dumps(reply).encode())(writer,count)
        async with fixtures.TlsServer(self.identity_fixture.server_tls,serve,max_request_body_bytes=524288) as server:
            async with self.channel(server.origin) as channel:
                await channel.consent(value,observation)
                self.assertIsNone(await channel.publish(value,receipt,(artifact,)))
            self.assertEqual([json.loads(raw)['op'] for raw in server.request_bodies],['consent','artifact.put','artifact.put','publish'])
            self.assertTrue(all(len(raw)<=524288 for raw in server.request_bodies))

    async def test_unknown_upload_ack_never_retries_or_publishes_receipt(self):
        value=command();artifact=OpaqueArtifact('output-fiction',b'x'*262145)
        receipt=dict(schemaVersion='memlia.run-receipt/v1',organizationId=value['organizationId'],workspaceId=value['workspaceId'],
            runId=value['runId'],commandId=value['commandId'],sequence=2,recordedAt=value['issuedAt'],
            outcome=dict(status='succeeded_verified',effect='known',evidence=[artifact.reference],verifierId='memlia_capture_compile_v1'))
        async def serve(writer,count):
            request=json.loads(server.request_bodies[-1]);reply=self.reply(request,reference=artifact.reference,nextOffset=1,complete=False)
            await fixtures.response(json.dumps(reply).encode())(writer,count)
        async with fixtures.TlsServer(self.identity_fixture.server_tls,serve,max_request_body_bytes=524288) as server:
            async with self.channel(server.origin) as channel:
                channel._capabilities[(value['commandId'],value['digest'],value['leaseEpoch'])]=value['capabilityId'] # Explicit server-consent state double.
                with self.assertRaises(TransportError):await channel.publish(value,receipt,(artifact,))
            self.assertEqual(len(server.requests),1)

    async def test_refused_and_redirect_are_closed_without_a_second_request(self):
        for redirect in (False,True):
            async def serve(writer,count):
                request=json.loads(server.request_bodies[-1]);reply=self.reply(request,code='control_refused');reply['op']='refused'
                await fixtures.response(json.dumps(reply).encode(),status=307 if redirect else 200,
                    extra=b'Location: https://127.0.0.1:1/forbidden\r\n' if redirect else b'')(writer,count)
            async with fixtures.TlsServer(self.identity_fixture.server_tls,serve,max_request_body_bytes=524288) as server:
                async with self.channel(server.origin) as channel:
                    with self.assertRaises(TransportError) as caught:await channel.claim(dict(windowsSid='S-1-5-21-1',sessionId='1'))
                self.assertEqual(caught.exception.code,'redirect_refused' if redirect else 'control_refused')
                self.assertEqual(len(server.requests),1)

    async def test_preallocated_or_other_epoch_capability_cannot_upload(self):
        value=command();artifact=OpaqueArtifact('output-fiction',b'opaque-fiction')
        receipt=dict(schemaVersion='memlia.run-receipt/v1',organizationId=value['organizationId'],workspaceId=value['workspaceId'],
            runId=value['runId'],commandId=value['commandId'],sequence=2,recordedAt=value['issuedAt'],
            outcome=dict(status='succeeded_verified',effect='known',evidence=[artifact.reference],verifierId='memlia_capture_compile_v1'))
        async with fixtures.TlsServer(self.identity_fixture.server_tls,fixtures.response(),max_request_body_bytes=524288) as server:
            async with self.channel(server.origin) as channel:
                with self.assertRaises(TransportError):await channel.publish(value,receipt,(artifact,))
                channel._capabilities[(value['commandId'],value['digest'],value['leaseEpoch']+1)]=value['capabilityId']
                with self.assertRaises(TransportError):await channel.publish(value,receipt,(artifact,))
            self.assertEqual(server.requests,[])

    async def test_read_total_larger_than_caller_limit_refuses_before_second_chunk(self):
        reference=dict(artifactId='manifest-fiction',sha256='sha256:'+'f'*64)
        async def serve(writer,count):
            request=json.loads(server.request_bodies[-1]);reply=self.reply(request,reference=reference,offset=0,
                totalBytes=1048577,dataBase64=base64.b64encode(b'x'*262144).decode('ascii'),done=False)
            await fixtures.response(json.dumps(reply).encode())(writer,count)
        async with fixtures.TlsServer(self.identity_fixture.server_tls,serve,max_request_body_bytes=524288) as server:
            async with self.channel(server.origin) as channel:
                with self.assertRaises(TransportError):await channel.artifact(command(),reference,1048576)
            self.assertEqual(len(server.requests),1)

    async def test_foreign_consent_never_populates_capability_cache(self):
        value=command();authority=AuthorityDouble(value)
        observation=dict(consentId='consent-fiction',confirmedLocallyAt=value['issuedAt'],
            commandDigest=value['digest'],windowsSid=value['windowsSid'],sessionId=value['sessionId'])
        capability=await authority.consent(value,observation);capability['leaseEpoch']+=1
        async def serve(writer,count):
            request=json.loads(server.request_bodies[-1]);reply=self.reply(request,capability=capability)
            await fixtures.response(json.dumps(reply).encode())(writer,count)
        async with fixtures.TlsServer(self.identity_fixture.server_tls,serve,max_request_body_bytes=524288) as server:
            async with self.channel(server.origin) as channel:
                with self.assertRaises(TransportError):await channel.consent(value,observation)
                self.assertEqual(channel._capabilities,{})

    async def test_dispatcher_and_real_mtls_channel_compose_capture_to_test(self):
        # Actual host/channel/contracts, doubled native adapters and server use
        # case. This is not Windows or PostgreSQL end-to-end qualification.
        dispatcher_module=importlib.import_module('memlia_agent.dispatcher')
        value=command();authority=AuthorityDouble(value);uploaded=bytearray();publications=[]
        async def serve(writer,count):
            request=json.loads(server.request_bodies[-1]);validate('AgentControlRequest',request)
            op=request['op']
            if op=='claim':reply=self.reply(request,command=value)
            elif op=='checkpoint':reply=self.reply(request,accepted=True)
            elif op=='consent':reply=self.reply(request,capability=await authority.consent(value,request['observation']))
            elif op=='artifact.read':reply=self.reply(request,reference=request['reference'],offset=0,totalBytes=2,dataBase64='e30=',done=True)
            elif op=='artifact.put':
                self.assertEqual(request['offset'],len(uploaded))
                uploaded.extend(base64.b64decode(request['dataBase64'],validate=True))
                reply=self.reply(request,reference=request['reference'],nextOffset=len(uploaded),complete=len(uploaded)==request['totalBytes'])
            else:
                self.assertEqual(op,'publish');publications.append(request['receipt'])
                reply=self.reply(request,accepted=True)
            await fixtures.response(json.dumps(reply).encode())(writer,count)
        async with fixtures.TlsServer(self.identity_fixture.server_tls,serve,max_request_body_bytes=524288) as server:
            async with self.channel(server.origin) as channel:
                dispatcher=dispatcher_module.AgentDispatcher(scope=dispatcher_module.AgentScope(organization_id=None,
                    workspace_id=value['workspaceId'],agent_id=value['agentId'],owner_user_id=value['ownerUserId']),authority=channel)
                threads,capture,compiler=dispatcher_fixtures.DispatcherTests.adapters(self,dispatcher_module,authority)
                try:
                    with patch.object(dispatcher_module,'observe_session',return_value=OBSERVED),capture,compiler:
                        result=await dispatcher.run_once()
                finally:await dispatcher.aclose()
            self.assertEqual(result['status'],'to_test')
            self.assertEqual([receipt['outcome']['status'] for receipt in publications],
                ['awaiting_local_consent','running','succeeded_verified'])
            reference=publications[-1]['outcome']['evidence'][0]
            self.assertEqual(reference['sha256'],'sha256:'+hashlib.sha256(uploaded).hexdigest())
