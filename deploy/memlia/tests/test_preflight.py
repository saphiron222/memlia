# Copyright (c) 2026 Memlia. All rights reserved.
"""Real Compose resolution and CLI refusals; no daemon or deployment is started."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from test_compose import COMPOSE, DOCKER, fixture_environment, resolve

SCRIPT = Path(__file__).resolve().parents[1] / 'preflight.py'


class PreflightTests(unittest.TestCase):
    def check(self, changes=None, *, model_change=None, worker=False):
        values = fixture_environment()
        if worker:
            values.update(MEMLIA_WORKFLOW_WORKER_SHA256='b' * 64,
                          DATABASE_URL_WORKFLOW_WORKER='postgresql://memlia_worker:synthetic@db/memlia',
                          MEMLIA_PG_BOSS_DATABASE_URL='postgresql://memlia_queue:synthetic@db/memlia')
        values.update(changes or {})
        if worker:
            env = {k: v for k, v in os.environ.items()
                   if k in ('PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONFIG')}
            env.update(values)
            with tempfile.NamedTemporaryFile() as empty_env:
                resolved = subprocess.run(DOCKER + ['compose', '--env-file', empty_env.name,
                    '-p', 'memlia-preflight-contract', '-f', str(COMPOSE),
                    '-f', str(COMPOSE.with_name('compose.excel.yaml')), 'config', '--format', 'json'],
                    env=env, text=True, capture_output=True, timeout=30)
        else:
            resolved = resolve(values)
        self.assertEqual(resolved.returncode, 0, 'synthetic Compose resolution failed')
        model = json.loads(resolved.stdout)
        if model_change:
            model_change(model)
        result = subprocess.run([sys.executable, '-I', '-B', str(SCRIPT)],
                                input=json.dumps(model), text=True, capture_output=True, timeout=5)
        # Neither success nor refusal may print resolved configuration/credentials.
        for private in ('synthetic-db-only', 'synthetic-only-', 'synthetic@', 'PRIVATE_CANARY'):
            self.assertNotIn(private, result.stdout + result.stderr)
        self.assertEqual(result.stderr, '')
        return result, json.loads(result.stdout)

    def test_valid_configuration_has_no_release_or_runtime_qualification_claim(self):
        result, report = self.check()
        self.assertEqual(result.returncode, 0)
        self.assertEqual(report, {'status': 'configuration_valid', 'errors': []})

    def test_http_origin_is_refused_before_services_can_be_started(self):
        result, report = self.check({'NEXT_PUBLIC_APP_URL': 'http://memlia.example.invalid'})
        self.assertEqual(result.returncode, 1)
        self.assertIn('invalid_https_origin', report['errors'])

    def test_origin_with_credentials_path_query_or_fragment_is_refused(self):
        for origin in ('https://PRIVATE_CANARY@memlia.invalid',
                       'https://memlia.invalid/path', 'https://memlia.invalid?q=PRIVATE_CANARY',
                       'https://memlia.invalid/#fragment', 'https://memlia.invalid:0',
                       'https://memlia.invalid\\@other.invalid'):
            with self.subTest(origin=origin):
                result, report = self.check({'NEXT_PUBLIC_APP_URL': origin})
                self.assertEqual(result.returncode, 1)
                self.assertIn('invalid_https_origin', report['errors'])

    def test_one_mismatched_auth_origin_is_refused(self):
        def change(model):
            model['services']['realtime']['environment']['BETTER_AUTH_URL'] = 'https://other.invalid'
        result, report = self.check(model_change=change)
        self.assertEqual(result.returncode, 1)
        self.assertIn('inconsistent_origin', report['errors'])

    def test_invalid_digest_is_refused_despite_successful_compose_resolution(self):
        result, report = self.check({'MEMLIA_WEB_SHA256': 'PRIVATE_CANARY'})
        self.assertEqual(result.returncode, 1)
        self.assertIn('invalid_image_reference', report['errors'])

    def test_mixed_application_image_prefixes_are_refused(self):
        def change(model):
            model['services']['web']['image'] = 'other.invalid/memlia/web@sha256:' + 'a' * 64
        result, report = self.check(model_change=change)
        self.assertEqual(result.returncode, 1)
        self.assertIn('inconsistent_image_prefix', report['errors'])

    def test_same_database_role_is_refused_even_with_different_passwords(self):
        result, report = self.check({
            'DATABASE_URL_REALTIME': 'postgresql://memlia_web:PRIVATE_CANARY@db:5432/memlia'})
        self.assertEqual(result.returncode, 1)
        self.assertIn('shared_database_role', report['errors'])

    def test_encoded_postgres_role_cannot_bypass_superuser_name_refusal(self):
        result, report = self.check({'DATABASE_URL': 'postgresql://%70ostgres:PRIVATE_CANARY@db/memlia'})
        self.assertEqual(result.returncode, 1)
        self.assertIn('database_admin_role', report['errors'])

    def test_query_overrides_cannot_bypass_database_role_validation(self):
        result, report = self.check({
            'DATABASE_URL': 'postgresql://memlia_web:PRIVATE_CANARY@db/memlia?user=postgres'})
        self.assertEqual(result.returncode, 1)
        self.assertIn('invalid_database_url', report['errors'])

    def test_optional_worker_configuration_uses_real_compose_overlay(self):
        result, report = self.check(worker=True)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(report['status'], 'configuration_valid')

    def test_queue_can_use_its_own_database_without_mixing_business_databases(self):
        result, report = self.check(worker=True, changes={
            'MEMLIA_PG_BOSS_DATABASE_URL': 'postgresql://memlia_queue:synthetic@db/transport'})
        self.assertEqual(result.returncode, 0)
        self.assertEqual(report['status'], 'configuration_valid')

    def test_optional_worker_cannot_reuse_the_web_role(self):
        result, report = self.check(worker=True, changes={
            'DATABASE_URL_WORKFLOW_WORKER': 'postgresql://memlia_web:PRIVATE_CANARY@db/memlia'})
        self.assertEqual(result.returncode, 1)
        self.assertIn('shared_database_role', report['errors'])

    def test_malformed_or_wrong_database_target_is_refused(self):
        for url, expected in (
            ('https://PRIVATE_CANARY@db/memlia', 'invalid_database_url'),
            ('postgresql://memlia_realtime:PRIVATE_CANARY@db/other', 'inconsistent_database_target'),
            ('postgresql://memlia_realtime:PRIVATE_CANARY@other/memlia', 'inconsistent_database_target'),
        ):
            with self.subTest(url=url):
                result, report = self.check({'DATABASE_URL_REALTIME': url})
                self.assertEqual(result.returncode, 1)
                self.assertIn(expected, report['errors'])

    def test_invalid_or_empty_compose_output_is_opaque_and_fails_closed(self):
        for text in ('', '{"PRIVATE_CANARY":', '{}', '[]',
                     '{"services":{},"services":{}}', '{"services":NaN}'):
            result = subprocess.run([sys.executable, '-I', '-B', str(SCRIPT)], input=text,
                                    text=True, capture_output=True, timeout=5)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(json.loads(result.stdout),
                             {'status': 'refused', 'errors': ['invalid_compose_model']})
            self.assertEqual(result.stderr, '')

    def test_oversized_compose_input_is_refused_without_echo(self):
        result = subprocess.run([sys.executable, '-I', '-B', str(SCRIPT)],
                                input=' ' * (1024 * 1024 + 1), text=True,
                                capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout),
                         {'status': 'refused', 'errors': ['invalid_compose_model']})
        self.assertEqual(result.stderr, '')


class AgentControlProfile(unittest.TestCase):
    """Synthetic resolved model and real YAML parsing; no Docker/daemon qualification."""
    @staticmethod
    def model():
        import importlib.util
        spec=importlib.util.spec_from_file_location('control_preflight',SCRIPT)
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        services={name:{'image':'fixture/'+name+'@sha256:'+'a'*64,'environment':{}} for name in ('web','realtime','migrations','cron','db','redis')}
        for name in ('web','realtime'):
            services[name]['environment'].update(NEXT_PUBLIC_APP_URL='https://fixture.invalid',BETTER_AUTH_URL='https://fixture.invalid')
        for name in ('web','realtime','migrations'):
            services[name]['environment']['DATABASE_URL']='postgres://'+name+':synthetic@db/memlia'
        control={'image':'fixture/workflow-worker@sha256:'+'a'*64,'user':'1001:1001','command':['node','dist/memlia-agent-control.mjs'],'working_dir':'/app/apps/sim','pull_policy':'never','init':True,'restart':'no','read_only':True,'cap_drop':['ALL'],'security_opt':['no-new-privileges:true'],'cpus':1.0,'mem_limit':1073741824,'memswap_limit':1073741824,'pids_limit':128,'stop_signal':'SIGTERM','stop_grace_period':'160s','healthcheck':{'disable':True},'networks':{'backend':{}},'depends_on':{'db':{'condition':'service_healthy'},'migrations':{'condition':'service_completed_successfully'}},'ports':[{'host_ip':'127.0.0.1','target':9443,'published':'9443','protocol':'tcp'}],'environment':{'NODE_ENV':'production','SIM_DB_ROLE':'web','DB_APP_NAME':'memlia-agent-control','DATABASE_URL':services['web']['environment']['DATABASE_URL'],'MEMLIA_AGENT_CONTROL_CONFIG':'/etc/memlia-agent-control/config.json','DO_NOT_TRACK':'1','SIM_TELEMETRY_DISABLED':'1'},'volumes':[{'type':'bind','source':'/protected/agent-control/'+name,'target':target,'read_only':True,'bind':{'create_host_path':False}} for name,target in [('config.json','/etc/memlia-agent-control/config.json'),('server.pem','/etc/memlia-agent-control/server.pem'),('client-ca.pem','/etc/memlia-agent-control/client-ca.pem'),('secrets','/run/memlia-agent-control')]]}
        services['agent-control']=control
        return module,{'services':services,'networks':{'backend':{'internal':True}}},control

    def test_optin_control_reuses_exact_worker_image_and_web_dml_role(self):
        module,model,control=self.model();self.assertEqual(module.validate(model),[])
        model['services']['workflow-worker']={'image':control['image'],'environment':{'DATABASE_URL':'postgres://worker:synthetic@db/memlia','MEMLIA_PG_BOSS_DATABASE_URL':'postgres://queue:synthetic@db/memlia','NEXT_PUBLIC_APP_URL':'https://fixture.invalid','BETTER_AUTH_URL':'https://fixture.invalid'}}
        model['services']['web']['environment']['MEMLIA_PG_BOSS_DATABASE_URL']='postgres://queue:synthetic@db/memlia'
        self.assertEqual(module.validate(model),[])
        control['image']='fixture/workflow-worker@sha256:'+'b'*64
        self.assertIn('agent_control_image_mismatch',module.validate(model))

    def test_control_dsn_is_exact_web_and_never_owner_transport_or_other_target(self):
        for value in ['postgres://postgres:PRIVATE_CANARY@db/memlia','postgres://worker:PRIVATE_CANARY@db/memlia','postgres://web:PRIVATE_CANARY@db/other']:
            module,model,control=self.model();control['environment']['DATABASE_URL']=value
            with self.subTest(value=value):
                codes=module.validate(model);self.assertIn('agent_control_database_mismatch',codes);self.assertNotIn('PRIVATE_CANARY',json.dumps(codes))

    def test_only_loopback_or_explicit_rfc1918_address_fixed_control_port(self):
        for address,allowed in [('127.0.0.1',True),('192.168.1.10',True),('10.0.0.4',True),('172.20.1.1',True),('0.0.0.0',False),('8.8.8.8',False),('169.254.1.1',False),('198.51.100.1',False),('::',False)]:
            module,model,control=self.model();control['ports'][0]['host_ip']=address
            with self.subTest(address=address):self.assertEqual('agent_control_exposure_refused' in module.validate(model),not allowed)
        for change in [{'target':9444},{'published':'443'},{'protocol':'udp'}]:
            module,model,control=self.model();control['ports'][0].update(change)
            self.assertIn('agent_control_exposure_refused',module.validate(model))

    def test_restart_writable_mount_fake_health_and_secrets_outside_consumers_refuse(self):
        import copy
        for change in [{'restart':'always'},{'read_only':False},{'user':'0:0'},{'command':['bun','dist/memlia-agent-control.mjs']},{'healthcheck':{'test':['CMD','true']}},{'networks':{'backend':{},'egress':{}}}]:
            module,model,control=self.model();control.update(copy.deepcopy(change))
            with self.subTest(change=change):self.assertIn('agent_control_profile_refused',module.validate(model))
        for delta in [{'read_only':False},{'bind':{'create_host_path':True}},{'target':'/run/ca-private'}]:
            module,model,control=self.model();control['volumes'][0].update(delta)
            self.assertIn('agent_control_mount_refused',module.validate(model))
        module,model,control=self.model();control['environment']['ANTHROPIC_API_KEY']='PRIVATE_CANARY'
        self.assertIn('agent_control_environment_refused',module.validate(model))

    def test_hidden_authority_mounts_bad_types_and_missing_dependencies_refuse_closed(self):
        for delta in [{'privileged':True},{'entrypoint':['sh','-c','PRIVATE_CANARY']},{'secrets':['private-ca']},{'configs':['private-ca']},{'network_mode':'host'},{'networks':None},{'cpus':True},{'healthcheck':{'disable':1}},{'depends_on':{}}]:
            module,model,control=self.model();control.update(delta)
            with self.subTest(delta=delta):self.assertIn('agent_control_profile_refused',module.validate(model))
        module,model,control=self.model();model['networks']['backend']['internal']=False
        self.assertIn('agent_control_profile_refused',module.validate(model))

    def test_overlay_keeps_no_host_creation_and_no_automatic_start_or_health_claim(self):
        import yaml
        path=SCRIPT.with_name('compose.agent-control.yaml')
        parsed=yaml.safe_load(path.read_text());self.assertEqual(set(parsed['services']),{'agent-control'})
        control=parsed['services']['agent-control']
        self.assertEqual(control['restart'],'no');self.assertEqual(control['healthcheck'],{'disable':True})
        self.assertEqual(control['ports'][0]['host_ip'],'${MEMLIA_AGENT_CONTROL_BIND_ADDRESS:-127.0.0.1}')
        self.assertEqual(control['command'],['node','dist/memlia-agent-control.mjs'])
        self.assertEqual(len(control['volumes']),4)
        self.assertTrue(all(v['read_only'] and v['bind']['create_host_path'] is False for v in control['volumes']))


class RepoDigestTests(unittest.TestCase):
    """Shared by operations.py and application_qualification.py; literal Docker 29.9.2 forms."""
    def setUp(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('preflight_repo_digest', SCRIPT)
        self.preflight = importlib.util.module_from_spec(spec); spec.loader.exec_module(self.preflight)

    def test_pinned_tag_is_dropped_exactly_as_docker_records_it(self):
        digest = 'ac08538c6f8b9904c33c8224c5e5706dbe760aca29db1d096972b4052c22a75d'
        cache = '081c2f5cb575efc901aa80ff9cdbd1ec6a301682fd35e1ebb4b0990a4a4a8507'
        rows = (('pgvector/pgvector:pg17@sha256:' + digest, 'pgvector/pgvector@sha256:' + digest),
                ('valkey/valkey:8.1.10-alpine@sha256:' + cache, 'valkey/valkey@sha256:' + cache),
                ('127.0.0.1:15000/c' + '3' * 32 + '/workflow-worker@sha256:' + 'd' * 64,
                 '127.0.0.1:15000/c' + '3' * 32 + '/workflow-worker@sha256:' + 'd' * 64),
                ('registry.invalid:5000/team/web:v1@sha256:' + 'e' * 64, 'registry.invalid:5000/team/web@sha256:' + 'e' * 64))
        for image, recorded in rows:
            with self.subTest(image=image): self.assertEqual(self.preflight.repo_digest(image), recorded)

    def test_unpinned_or_malformed_references_have_no_repo_digest(self):
        for image in ('pgvector/pgvector:pg17', 'pgvector@sha256:' + 'a' * 64, 'a@b@sha256:' + 'a' * 64,
                      'pgvector/pgvector@sha256:' + 'a' * 63, 'pgvector/pgvector@sha256:' + 'A' * 64,
                      'pgvector/:pg17@sha256:' + 'a' * 64, 'pgvector/pgvector@sha512:' + 'a' * 64,
                      'pgvector/pgvector@sha256:' + 'a' * 64 + '\n', '', None, b'pgvector/pgvector@sha256:' + b'a' * 64):
            with self.subTest(image=image): self.assertIsNone(self.preflight.repo_digest(image))


if __name__ == '__main__':
    unittest.main(verbosity=2)
