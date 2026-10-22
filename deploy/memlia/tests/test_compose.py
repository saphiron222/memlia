"""Exercise Compose's resolved deployment contract, without starting services."""
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
COMPOSE = ROOT / 'deploy/memlia/compose.yaml'
DOCKER = shlex.split(os.environ.get('MEMLIA_TEST_DOCKER', 'docker'))


def fixture_environment():
    # Private, synthetic values only. Never copied into deployment examples.
    return {
        'MEMLIA_IMAGE_PREFIX': 'memlia-test.invalid/memlia',
        **{f'MEMLIA_{name}_SHA256': 'a' * 64 for name in ['WEB', 'REALTIME', 'MIGRATIONS', 'CRON']},
        'NEXT_PUBLIC_APP_URL': 'https://memlia.example.invalid',
        'MEMLIA_CHAT_POLICY_SOURCE': '/etc/memlia/chat-policy.json',
        'POSTGRES_PASSWORD': 'synthetic-db-only',
        'DATABASE_URL': 'postgresql://memlia_web:synthetic@db:5432/memlia',
        'DATABASE_URL_REALTIME': 'postgresql://memlia_realtime:synthetic@db:5432/memlia',
        'MIGRATION_DATABASE_URL': 'postgresql://memlia_owner:synthetic@db:5432/memlia',
        **{name: 'synthetic-only-' + 'x' * 40 for name in [
            'BETTER_AUTH_SECRET', 'ENCRYPTION_KEY', 'INTERNAL_API_SECRET', 'CRON_SECRET']},
    }


def resolve(values):
    # No inherited application secrets or adjacent .env; only explicit fixture values.
    env = {k: v for k, v in os.environ.items() if k in ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONFIG']}
    env.update(values)
    with tempfile.NamedTemporaryFile() as empty_env:
        return subprocess.run(DOCKER + ['compose', '--env-file', empty_env.name,
            '-p', 'memlia-compose-contract', '-f', str(COMPOSE), 'config', '--format', 'json'],
            env=env, text=True, capture_output=True, timeout=30)


class ComposeContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        result = resolve(fixture_environment())
        if result.returncode:
            raise AssertionError('Compose model did not resolve: ' + result.stderr)
        cls.model = json.loads(result.stdout)
        cls.services = cls.model['services']

    def test_missing_required_values_refuse_configuration(self):
        for key in fixture_environment():
            with self.subTest(key=key):
                values = fixture_environment()
                del values[key]
                result = resolve(values)
                self.assertNotEqual(result.returncode, 0, key)
                self.assertIn(key, result.stderr)

    def test_local_chat_is_selected_without_worker_credentials(self):
        env = self.services['web']['environment']
        self.assertEqual(env.get('MEMLIA_CHAT_POLICY_FILE'), '/etc/memlia/chat-policy.json')
        self.assertEqual(env.get('COPILOT_TOOL_PERMISSIONS_ENABLED'), 'true')
        self.assertNotIn('COPILOT_API_KEY', env)
        self.assertNotIn('COPILOT_API_KEY', fixture_environment())

    def test_local_policy_bind_is_read_only_without_host_path_creation(self):
        mounts = [m for m in self.services['web']['volumes']
                  if m['target'] == '/etc/memlia/chat-policy.json']
        self.assertEqual(len(mounts), 1)
        mount = mounts[0]
        self.assertEqual(mount['type'], 'bind')
        self.assertEqual(mount['source'], fixture_environment()['MEMLIA_CHAT_POLICY_SOURCE'])
        self.assertTrue(mount['read_only'])
        self.assertFalse(mount['bind'].get('create_host_path', True))
        self.assertEqual(self.services['web']['user'], '1001:1001')

    def test_local_policy_is_only_visible_to_web(self):
        for name in ['db', 'redis', 'cron', 'realtime', 'migrations']:
            self.assertNotIn('MEMLIA_CHAT_POLICY_FILE', self.services[name].get('environment', {}))
            self.assertNotIn('MEMLIA_CHAT_POLICY_SOURCE', self.services[name].get('environment', {}))
            for mount in self.services[name].get('volumes', []):
                self.assertNotEqual(mount['target'], '/etc/memlia/chat-policy.json')

    def test_host_policy_source_can_change_without_changing_container_target(self):
        values = fixture_environment()
        values['MEMLIA_CHAT_POLICY_SOURCE'] = '/srv/cabinet/memlia/chat-policy.json'
        # Inherited environment cannot override the deliberate server values.
        values['MEMLIA_CHAT_POLICY_FILE'] = '/attacker-policy.json'
        values['COPILOT_TOOL_PERMISSIONS_ENABLED'] = 'false'
        values['COPILOT_API_KEY'] = 'synthetic-should-not-be-forwarded'
        result = resolve(values)
        self.assertEqual(result.returncode, 0, result.stderr)
        web = json.loads(result.stdout)['services']['web']
        self.assertEqual(web['environment']['MEMLIA_CHAT_POLICY_FILE'], '/etc/memlia/chat-policy.json')
        self.assertEqual(web['environment']['COPILOT_TOOL_PERMISSIONS_ENABLED'], 'true')
        self.assertNotIn('COPILOT_API_KEY', web['environment'])
        mounts = [m for m in web['volumes'] if m['target'] == '/etc/memlia/chat-policy.json']
        self.assertEqual(mounts[0]['source'], values['MEMLIA_CHAT_POLICY_SOURCE'])
        self.assertTrue(mounts[0]['read_only'])
        self.assertFalse(mounts[0]['bind'].get('create_host_path', True))

    def test_secrets_are_scoped_to_their_consumers(self):
        values = fixture_environment()
        result = resolve(values)
        self.assertEqual(result.returncode, 0, result.stderr)
        services = json.loads(result.stdout)['services']
        for name in ['web', 'cron']:
            self.assertEqual(services[name]['environment']['CRON_SECRET'], values['CRON_SECRET'])
        for name in ['db', 'redis', 'realtime', 'migrations']:
            self.assertNotIn('CRON_SECRET', services[name].get('environment', {}))

    def test_database_and_cache_have_no_host_ports(self):
        for name in ['db', 'redis', 'cron', 'migrations']:
            self.assertFalse(self.services[name].get('ports'))
        for name, port in [('web', 3000), ('realtime', 3002)]:
            self.assertEqual(len(self.services[name]['ports']), 1)
            binding = self.services[name]['ports'][0]
            self.assertEqual(binding['host_ip'], '127.0.0.1')
            self.assertEqual(binding['target'], port)
        self.assertTrue(self.model['networks']['backend']['internal'])
        for name in ['db', 'redis']:
            self.assertEqual(set(self.services[name]['networks']), {'backend'})

    def test_migrations_gate_both_database_consumers(self):
        for name in ['web', 'realtime']:
            dependencies = self.services[name]['depends_on']
            self.assertEqual(dependencies['migrations']['condition'], 'service_completed_successfully')
            self.assertEqual(dependencies['db']['condition'], 'service_healthy')
            self.assertEqual(dependencies['redis']['condition'], 'service_healthy')
        self.assertEqual(self.services['migrations']['restart'], 'no')
        self.assertEqual(self.services['migrations']['command'], ['bun', 'run', 'db:migrate'])

    def test_images_are_digest_bound_without_upstream_app_images(self):
        for name, service in self.services.items():
            self.assertRegex(service['image'], r'@sha256:[0-9a-f]{64}$')
            if name not in ['db', 'redis']:
                self.assertTrue(service['image'].startswith('memlia-test.invalid/memlia/'))
                self.assertEqual(service['user'], '1001:1001')
        self.assertNotIn('worker', self.services)  # no nonexistent entrypoint

    def test_data_survives_container_replacement_by_named_volumes(self):
        for name, target in [('db', '/var/lib/postgresql/data'), ('redis', '/data'),
                             ('web', '/app/apps/sim/uploads')]:
            mounts = [m for m in self.services[name]['volumes'] if m['target'] == target]
            self.assertEqual(len(mounts), 1)
            self.assertEqual(mounts[0]['type'], 'volume')
            self.assertIn(mounts[0]['source'], self.model['volumes'])

    def test_bounded_execution_and_telemetry_off(self):
        env = self.services['web']['environment']
        for name, expected in {'MAX_TOOL_ITERATIONS': '20', 'EXECUTION_TIMEOUT_FREE': '900',
            'EXECUTION_TIMEOUT_ASYNC_FREE': '900', 'NEXT_TELEMETRY_DISABLED': '1',
            'DO_NOT_TRACK': '1', 'NEXT_PUBLIC_POSTHOG_ENABLED': 'false'}.items():
            self.assertEqual(env[name], expected)
        self.assertFalse(env.get('OPENAI_API_KEY'))
        self.assertFalse(env.get('ANTHROPIC_API_KEY'))
        self.assertFalse(env.get('NEXT_PUBLIC_POSTHOG_KEY'))
        self.assertFalse(env.get('SENTRY_DSN'))
        for name, service in self.services.items():
            self.assertGreater(service['pids_limit'], 0)
            self.assertTrue(service.get('mem_limit'))
            self.assertTrue(service.get('stop_grace_period'))
            if name != 'migrations':
                self.assertGreater(service['healthcheck']['retries'], 0)
                self.assertTrue(service['healthcheck']['timeout'])


class SmokeReceipt(unittest.TestCase):
    """Bookkeeping only: failures are injected at the subprocess boundary.

    These doubles do not claim an infrastructure test. They exercise the real
    harness's return/exception/report handling after an initial or cleanup error.
    """

    def check_failure(self, initial_failure=False, cleanup_failure=False, residue=None):
        import smoke_infrastructure as smoke

        def response(command, **kwargs):
            code, output = 0, ''
            if 'version' in command and initial_failure:
                code = 7
            elif 'down' in command and cleanup_failure:
                code = 9
            elif '--filter' in command and residue:
                kind = ('volumes' if 'volume' in command else
                        'networks' if 'network' in command else 'containers')
                if kind == residue:
                    output = 'owned-resource-remains\n'
            elif 'valkey-cli' in command:
                if 'INFO' in command:
                    output = 'valkey_version:8.1.10\n'
                elif 'SET' in command:
                    output = 'OK\n'
                elif 'EVAL' in command:
                    output = '1\n'
                elif 'EXISTS' in command:
                    output = '0\n'
                elif 'GET' in command:
                    output = 'retained\n'
            elif 'psql' in command:
                output = '1\nretained\n'
            elif 'bash' in command:
                output = '+PONG\n'
            return subprocess.CompletedProcess(command, code, output, '')

        with tempfile.TemporaryDirectory() as directory:
            receipt = Path(directory) / 'receipt.json'
            with patch.object(smoke.subprocess, 'run', side_effect=response), \
                    patch.object(smoke.time, 'sleep'), \
                    patch.object(smoke, 'check_cron_mount'), \
                    patch('sys.argv', ['smoke', '--evidence', str(receipt)]):
                with self.assertRaises(Exception):
                    smoke.main()
            report = json.loads(receipt.read_text())
        self.assertEqual(report['result'], 'failed')
        if initial_failure:
            self.assertIn('exit 7', report['failure'])
        if cleanup_failure:
            self.assertIn('exit 9', report['cleanupFailure'])
        if residue:
            self.assertIn('remain', report['cleanupFailure'])

    def test_cleanup_failure_cannot_produce_passed_receipt(self):
        self.check_failure(cleanup_failure=True)

    def test_cleanup_failure_preserves_original_failure(self):
        self.check_failure(initial_failure=True, cleanup_failure=True)

    def test_leftover_resource_cannot_produce_passed_receipt(self):
        for kind in ['containers', 'volumes', 'networks']:
            with self.subTest(kind=kind):
                self.check_failure(residue=kind)

    def test_interruptions_are_failed_and_propagated_with_cleanup_details(self):
        import smoke_infrastructure as smoke

        for interruption in [KeyboardInterrupt('controlled interruption'), SystemExit(23)]:
            for cleanup_fails in [False, True]:
                with self.subTest(interruption=type(interruption).__name__, cleanup_fails=cleanup_fails):
                    def response(command, **kwargs):
                        if 'version' in command:
                            raise interruption
                        code = 9 if cleanup_fails and 'down' in command else 0
                        return subprocess.CompletedProcess(command, code, '', '')

                    with tempfile.TemporaryDirectory() as directory:
                        receipt = Path(directory) / 'receipt.json'
                        with patch.object(smoke.subprocess, 'run', side_effect=response), \
                                patch('sys.argv', ['smoke', '--evidence', str(receipt)]):
                            with self.assertRaises(type(interruption)) as raised:
                                smoke.main()
                        report = json.loads(receipt.read_text())
                    self.assertIs(raised.exception, interruption)
                    self.assertEqual(report['result'], 'failed')
                    self.assertIn(type(interruption).__name__, report['failure'])
                    if cleanup_fails:
                        self.assertIn('exit 9', report['cleanupFailure'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
