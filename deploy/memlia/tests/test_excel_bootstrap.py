# Copyright (c) 2026 Memlia. All rights reserved.
"""Read optional deployment contracts; no systemd, Docker, database or model runs.

PyYAML is the already installed test parser, not an application dependency.
Resolved Compose, native UID mappings and service lifecycle require Linux qualification.
"""
import configparser
from pathlib import Path
import shlex
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[3]
DEPLOY = ROOT / 'deploy/memlia'


class ExcelBootstrapContract(unittest.TestCase):
    def unit(self):
        path = DEPLOY / 'excel-host.service'
        self.assertTrue(path.is_file(), 'optional native Excel host unit is missing')
        unit = configparser.ConfigParser(interpolation=None, strict=True)
        unit.optionxform = str
        unit.read_string(path.read_text())
        return unit

    def overlay(self):
        path = DEPLOY / 'compose.excel.yaml'
        self.assertTrue(path.is_file(), 'optional worker deployment overlay is missing')
        return yaml.safe_load(path.read_text())

    def test_unit_invokes_existing_host_without_shell_or_new_business_bootstrap(self):
        service = self.unit()['Service']
        self.assertEqual(shlex.split(service['ExecStart']), [
            '/usr/bin/python3', '-I', '-B', '/opt/memlia/excel-host/host.py',
            '/run/memlia-excel/host.sock', '${MEMLIA_EXCEL_IMAGE_ID}', '1001', '1001',
            '--admission-file', '/etc/memlia/excel/admission.json'])
        self.assertEqual(service['EnvironmentFile'], '/etc/memlia/excel/host.env')
        self.assertEqual(service['Type'], 'exec')  # process exec, never socket readiness

    def test_host_separates_operator_identity_from_worker_and_protects_runtime(self):
        service = self.unit()['Service']
        for key, value in {'User': 'root', 'Group': '1001', 'UMask': '0077',
                           'NoNewPrivileges': 'yes', 'ProtectSystem': 'strict',
                           'ProtectHome': 'yes', 'PrivateTmp': 'yes',
                           'RuntimeDirectory': 'memlia-excel',
                           'RuntimeDirectoryMode': '0750',
                           'RuntimeDirectoryPreserve': 'yes'}.items():
            self.assertEqual(service[key], value, key)
        self.assertEqual(service['RestrictAddressFamilies'], 'AF_UNIX')
        self.assertGreater(int(service['TasksMax']), 0)
        self.assertEqual(service['MemoryMax'], '256M')
        self.assertEqual(service['CPUQuota'], '100%')

    def test_host_preserves_unknown_cleanup_and_does_not_restart_or_unlink(self):
        service = self.unit()['Service']
        self.assertEqual(service['Restart'], 'no')
        self.assertEqual(service['KillMode'], 'mixed')
        self.assertEqual(service['KillSignal'], 'SIGTERM')
        # Native host joins for 140s; allow its supervisor's 120s + cleanup and margin.
        self.assertGreaterEqual(int(service['TimeoutStopSec']), 150)
        self.assertLessEqual(int(service['TimeoutStopSec']), 180)
        for key in ('ExecStartPre', 'ExecStop', 'ExecStopPost', 'ExecReload', 'PIDFile'):
            self.assertNotIn(key, service)
        self.assertNotIn('Install', self.unit())  # deliberate manual start after qualification

    def test_default_deployment_has_no_worker_activation_or_excel_socket(self):
        default = yaml.safe_load((DEPLOY / 'compose.yaml').read_text())
        self.assertNotIn('workflow-worker', default['services'])
        for name, row in default['services'].items():
            self.assertFalse(any(key.startswith('MEMLIA_EXCEL_')
                                 for key in row.get('environment', {})), name)
            for mount in row.get('volumes', []):
                self.assertNotIn('memlia-excel', str(mount))

    def test_overlay_adds_only_worker_and_native_web_durable_selection(self):
        overlay = self.overlay()
        self.assertEqual(set(overlay), {'services'})
        self.assertEqual(set(overlay['services']), {'web', 'workflow-worker'})
        web = overlay['services']['web']
        self.assertEqual(set(web), {'environment'})
        self.assertEqual(web['environment'], {
            'MEMLIA_DURABLE_WORKFLOWS_ENABLED': '1', 'MEMLIA_PG_BOSS_ENABLED': '1',
            'MEMLIA_PG_BOSS_DATABASE_URL': '${MEMLIA_PG_BOSS_DATABASE_URL:?Dedicated transport role required}',
            'TRIGGER_DEV_ENABLED': 'false'})
        # No socket, wrapper or Docker authority is added to web through merge.

    def test_worker_uses_digest_and_native_entrypoint_without_command_override(self):
        worker = self.overlay()['services']['workflow-worker']
        self.assertEqual(worker['image'], '${MEMLIA_IMAGE_PREFIX:?Memlia image prefix required}/workflow-worker@sha256:${MEMLIA_WORKFLOW_WORKER_SHA256:?Qualified worker digest required}')
        self.assertEqual(worker['user'], '1001:1001')
        self.assertEqual(worker['working_dir'], '/app/apps/sim')
        self.assertEqual(worker['pull_policy'], 'never')
        for key in ('build', 'entrypoint', 'command', 'healthcheck', 'ports',
                    'privileged', 'devices', 'pid', 'network_mode', 'env_file'):
            self.assertNotIn(key, worker)

    def test_worker_shares_only_native_uploads_and_read_only_operator_ipc(self):
        worker = self.overlay()['services']['workflow-worker']
        self.assertEqual(worker['volumes'], [
            {'type': 'volume', 'source': 'uploads', 'target': '/app/apps/sim/uploads'},
            {'type': 'bind', 'source': '/run/memlia-excel', 'target': '/run/memlia-excel',
             'read_only': True, 'bind': {'create_host_path': False}}])
        self.assertEqual(worker['environment']['MEMLIA_EXCEL_HOST_SOCKET'], '/run/memlia-excel/host.sock')
        self.assertEqual(worker['environment']['MEMLIA_EXCEL_HOST_OPERATOR_UID'], '0')

    def test_worker_limits_and_stop_preserve_native_cancellation(self):
        worker = self.overlay()['services']['workflow-worker']
        self.assertEqual(worker['restart'], 'no')
        self.assertTrue(worker['init'])
        self.assertTrue(worker['read_only'])
        self.assertEqual(worker['cap_drop'], ['ALL'])
        self.assertEqual(worker['security_opt'], ['no-new-privileges:true'])
        self.assertEqual(worker['mem_limit'], '4g')
        self.assertEqual(worker['memswap_limit'], '4g')
        self.assertEqual(worker['cpus'], '2.0')
        self.assertEqual(worker['pids_limit'], 256)
        self.assertEqual(worker['stop_signal'], 'SIGTERM')
        self.assertEqual(worker['stop_grace_period'], '160s')
        self.assertEqual(worker['tmpfs'], ['/tmp:rw,nosuid,nodev,size=268435456,mode=0700,uid=1001,gid=1001'])

    def test_worker_business_and_transport_configuration_remain_distinct(self):
        worker = self.overlay()['services']['workflow-worker']
        env = worker['environment']
        self.assertEqual(env['DATABASE_URL'], '${DATABASE_URL_WORKFLOW_WORKER:?Non-owner worker business role required}')
        self.assertEqual(env['MEMLIA_PG_BOSS_DATABASE_URL'], '${MEMLIA_PG_BOSS_DATABASE_URL:?Dedicated transport role required}')
        for key in ('MIGRATION_DATABASE_URL', 'POSTGRES_PASSWORD', 'DATABASE_URL_WEB',
                    'COPILOT_API_KEY', 'DISABLE_AUTH', 'DATABASE_URL_REALTIME'):
            self.assertNotIn(key, env)
        self.assertEqual(env['MEMLIA_DURABLE_WORKFLOWS_ENABLED'], '1')
        self.assertEqual(env['MEMLIA_PG_BOSS_ENABLED'], '1')
        self.assertEqual(env['TRIGGER_DEV_ENABLED'], 'false')
        self.assertEqual(env['SIM_DB_ROLE'], 'trigger')
        self.assertEqual(set(worker['networks']), {'backend', 'egress'})
        self.assertEqual(worker['depends_on'], {
            'db': {'condition': 'service_healthy'},
            'redis': {'condition': 'service_healthy'},
            'migrations': {'condition': 'service_completed_successfully'},
            'realtime': {'condition': 'service_healthy'}})


if __name__ == '__main__':
    unittest.main(verbosity=2)
