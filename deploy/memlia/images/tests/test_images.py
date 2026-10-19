"""Opt-in Linux image tests. No database mutation or outbound cron calls.

Set MEMLIA_IMAGE_SMOKE=1 and DOCKER_CONFIG / DOCKER_HOST explicitly.
Images default to the local P03 tags; override MEMLIA_{MIGRATIONS,CRON}_IMAGE.
"""
import json
import os
from pathlib import Path
import subprocess
import time
import unittest
import uuid

@unittest.skipUnless(os.environ.get('MEMLIA_IMAGE_SMOKE') == '1', 'requires explicit image smoke opt-in')
class ImageTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not os.environ.get('DOCKER_CONFIG') or not os.environ.get('DOCKER_HOST'):
            raise RuntimeError('Explicit isolated Docker config and host required')
        cls.docker = [os.environ.get('DOCKER_BIN', 'docker'), '--config', os.environ['DOCKER_CONFIG'], '--host', os.environ['DOCKER_HOST']]
        cls.migrations = os.environ.get('MEMLIA_MIGRATIONS_IMAGE', 'memlia/migrations:p03-local')
        cls.cron = os.environ.get('MEMLIA_CRON_IMAGE', 'memlia/cron:p03-local')

    def command(self, *args, check=True):
        result = subprocess.run(self.docker + list(args), text=True, capture_output=True, timeout=45)
        if check:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def container(self, image, *args, entrypoint=None, env=None):
        name = 'memlia-p03-image-test-' + uuid.uuid4().hex[:12]
        # Register before creation: even a client-side failure can leave a container.
        self.addCleanup(self.remove_container, name)
        options = ['create', '--name', name, '--network', 'none', '--read-only', '--cap-drop', 'ALL',
                   '--security-opt', 'no-new-privileges:true', '--memory', '256m', '--pids-limit', '64',
                   '--tmpfs', '/tmp:rw,noexec,nosuid,size=32m']
        if entrypoint:
            options += ['--entrypoint', entrypoint]
        for key, value in (env or {}).items():
            options += ['--env', key + '=' + value]
        self.command(*options, image, *args)
        return name

    def remove_container(self, name):
        # rm -f returns nonzero when create never succeeded; absence is authoritative.
        self.command('rm', '-f', name, check=False)
        remaining = self.command('ps', '-a', '--filter', 'name=^/' + name + '$', '--format', '{{.Names}}')
        self.assertEqual(remaining.stdout.strip(), '', 'container cleanup failed')

    def test_migrator_refuses_missing_configuration_before_connecting(self):
        name = self.container(self.migrations)
        self.command('start', '-a', name, check=False)
        state = json.loads(self.command('inspect', '--format', '{{json .State}}', name).stdout)
        self.assertEqual(state['ExitCode'], 1)
        logs = self.command('logs', name)
        self.assertIn('Missing DATABASE_URL', logs.stdout + logs.stderr)

    def test_runtime_is_arm64_and_nonroot_and_not_writable(self):
        for image in (self.migrations, self.cron):
            with self.subTest(image=image):
                info = json.loads(self.command('image', 'inspect', image).stdout)[0]
                self.assertEqual((info['Os'], info['Architecture']), ('linux', 'arm64'))
                self.assertEqual(info['Config']['User'], '1001:1001')
                name = self.container(image, '-ec', 'test "$(id -u)" = 1001; test -r /usr/share/licenses/sim/LICENSE; ! touch /cannot-write', entrypoint='/bin/sh')
                self.command('start', '-a', name)
                state = json.loads(self.command('inspect', '--format', '{{json .State}}', name).stdout)
                self.assertEqual(state['ExitCode'], 0)

    def test_cron_native_no_secret_behavior(self):
        name = self.container(self.cron)
        self.command('start', '-a', name)
        state = json.loads(self.command('inspect', '--format', '{{json .State}}', name).stdout)
        self.assertEqual(state['ExitCode'], 0)
        logs = self.command('logs', name)
        self.assertIn('background jobs are disabled', logs.stdout + logs.stderr)

    def test_cron_validates_and_starts_then_stops_gracefully(self):
        check = self.container(self.cron, '-test', '/etc/sim/crontab', entrypoint='/usr/local/bin/supercronic')
        self.command('start', '-a', check)
        checked_state = json.loads(self.command('inspect', '--format', '{{json .State}}', check).stdout)
        self.assertEqual(checked_state['ExitCode'], 0)
        name = self.container(self.cron, env={'CRON_SECRET': 'synthetic-smoke-only'})
        self.command('start', name)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            logs = self.command('logs', name)
            if 'read crontab' in (logs.stdout + logs.stderr).lower():
                break
            time.sleep(0.1)
        else:
            self.fail('scheduler did not announce crontab startup')
        self.command('stop', '--time', '5', name)
        state = json.loads(self.command('inspect', '--format', '{{json .State}}', name).stdout)
        self.assertEqual(state['ExitCode'], 0)
        self.assertFalse(state['OOMKilled'])

if __name__ == '__main__':
    unittest.main()
