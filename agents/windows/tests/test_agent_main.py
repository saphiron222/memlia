# Copyright (c) 2026 Memlia. All rights reserved.
"""Entry-point refusals, not native Windows/runtime qualification."""
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch,AsyncMock
from types import SimpleNamespace

from memlia_agent import host

def bootstrap(**changes):
    value=dict(schemaVersion='memlia.agent-bootstrap/v1',installationId='instance-fiction',
        origin='https://app-fiction.invalid',organizationId=None,workspaceId='workspace-fiction',
        ownerUserId='user-fiction',enrollmentId='enrollment-fiction',tlsCaPem='public-fictional-app-ca',
        agentCaPem='public-fictional-agent-ca')
    value.update(changes);return value

class AgentMainTests(unittest.TestCase):
    def run_agent(self,*args,input=b''):
        return subprocess.run([sys.executable,'-B','-m','memlia_agent',*args],input=input,
            stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=3,check=False)

    def test_unknown_arguments_are_refused_without_echoing_a_secret(self):
        result=self.run_agent('--code','FICTIONAL_ARG_SECRET')
        self.assertEqual(result.returncode,2)
        self.assertNotIn(b'FICTIONAL_ARG_SECRET',result.stdout+result.stderr)
        self.assertEqual(json.loads(result.stdout),{'error':'agent_arguments_refused'})

    def test_bootstrap_rejects_unknown_fields_without_logging_the_input(self):
        result=self.run_agent('enroll',input=json.dumps({'schemaVersion':'memlia.agent-bootstrap/v1',
            'code':'FICTIONAL_STDIN_SECRET','untrusted':'FICTIONAL_PRIVATE'}).encode())
        self.assertEqual(result.returncode,2)
        self.assertEqual(json.loads(result.stdout),{'error':'agent_bootstrap_refused'})
        self.assertNotIn(b'FICTIONAL_',result.stdout+result.stderr)

    def test_bootstrap_byte_cap_refuses_before_loading_windows_or_crypto(self):
        result=self.run_agent('status',input=b'x'*131073)
        self.assertEqual(result.returncode,2)
        self.assertEqual(json.loads(result.stdout),{'error':'agent_bootstrap_refused'})
        self.assertEqual(result.stderr,b'')

    def test_run_requires_explicit_administrator_control_configuration(self):
        with self.assertRaises(host.HostError):
            host.AgentBootstrap.decode(json.dumps(bootstrap()).encode(),operation='run')
        configured=host.AgentBootstrap.decode(json.dumps(bootstrap(controlOrigin='https://control-fiction.invalid',
            controlCaPem='public-fictional-control-ca')).encode(),operation='run')
        self.assertEqual(configured.origin,'https://app-fiction.invalid')
        self.assertEqual(configured.control_origin,'https://control-fiction.invalid')
        self.assertNotIn('fictional',repr(configured))

    def test_duplicate_bootstrap_key_is_refused_without_native_io(self):
        raw=json.dumps(bootstrap()).encode()[:-1]+b',"origin":"https://foreign-fiction.invalid"}'
        with patch.object(host,'create_enrollment') as native:
            with self.assertRaises(host.HostError):host.AgentBootstrap.decode(raw,operation='status')
        native.assert_not_called()

class HostCompositionTests(unittest.IsolatedAsyncioTestCase):
    async def test_enroll_uses_existing_durable_prepare_challenge_complete_and_activation(self):
        configured=host.AgentBootstrap.decode(json.dumps(bootstrap(code='a'*43,expiresAt=1800000000000)).encode(),operation='enroll')
        client=SimpleNamespace(prepare=unittest.mock.Mock(),advance=AsyncMock(side_effect=['challenged','issued_pending_activation']),
            activate=unittest.mock.Mock(),state=lambda:dict(phase='active'))
        with patch.object(host,'create_enrollment',return_value=client):
            self.assertEqual(await host.perform_operation('enroll',configured),{'phase':'active'})
        client.prepare.assert_called_once_with(code='a'*43,expires_at=1800000000000)
        self.assertEqual(client.advance.await_count,2);client.activate.assert_called_once_with()

    async def test_run_activates_identity_then_composes_required_authority_and_host(self):
        configured=host.AgentBootstrap.decode(json.dumps(bootstrap(controlOrigin='https://control-fiction.invalid',
            controlCaPem='public-fictional-control-ca')).encode(),operation='run')
        identity=object();authority=unittest.mock.MagicMock()
        authority.__aenter__=AsyncMock(return_value=authority);authority.__aexit__=AsyncMock(return_value=False)
        client=SimpleNamespace(activate=unittest.mock.Mock(return_value=identity))
        runner=AsyncMock(return_value={'phase':'intervention_required'})
        with (patch.object(host,'create_enrollment',return_value=client),
              patch.object(host,'create_authority',return_value=authority) as factory,
              patch.object(host,'run_host',runner)):
            self.assertEqual(await host.perform_operation('run',configured),{'phase':'intervention_required'})
        factory.assert_called_once_with(configured,identity)
        runner.assert_awaited_once_with(bootstrap=configured,identity=identity,authority=authority)
        authority.__aexit__.assert_awaited_once()
