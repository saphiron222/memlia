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


if __name__ == '__main__':
    unittest.main(verbosity=2)
