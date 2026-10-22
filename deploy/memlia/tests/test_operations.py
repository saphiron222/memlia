# Copyright (c) 2026 Memlia. All rights reserved.
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import tarfile
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('operations', Path(__file__).parents[1] / 'operations.py')
ops = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ops)


class OperationsTests(unittest.TestCase):
    def test_archive_rejects_traversal_links_devices_and_duplicate_members(self):
        for name, kind in (('../escape', tarfile.REGTYPE), ('/escape', tarfile.REGTYPE),
                           ('config/key', tarfile.SYMTYPE), ('config/dev', tarfile.CHRTYPE)):
            with self.subTest(name=name, kind=kind), tempfile.TemporaryDirectory() as temp:
                path = Path(temp) / 'data.tar'
                with tarfile.open(path, 'w') as archive:
                    entry = tarfile.TarInfo(name); entry.type = kind
                    archive.addfile(entry, io.BytesIO())
                with self.assertRaises(ops.Refused): ops.inspect_archive(path, 1024 * 1024)

    def test_archive_accepts_only_regular_scoped_content_and_preserves_modes(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'data.tar'
            with tarfile.open(path, 'w') as archive:
                for name, raw in (('manifest.json', b'{}'), ('config/secret', b'private'),
                                  ('postgres_data/PG_VERSION', b'17')):
                    entry = tarfile.TarInfo(name); entry.size = len(raw); entry.mode = 0o600
                    archive.addfile(entry, io.BytesIO(raw))
            entries = ops.inspect_archive(path, 1024 * 1024)
            self.assertEqual([e.name for e in entries], ['manifest.json', 'config/secret', 'postgres_data/PG_VERSION'])

    def test_update_rejects_schema_or_database_image_change(self):
        old = {'images': {'migrations': 'a', 'db': 'b', 'redis': 'c', 'web': 'd'}, 'source': 'old', 'migrationSource': 'fixed'}
        new = {'images': dict(old['images'], web='e'), 'source': 'new', 'migrationSource': 'fixed'}
        ops.compatible_release(old, new)
        for name in ('migrations', 'db', 'redis'):
            with self.subTest(name=name), self.assertRaises(ops.Refused):
                ops.compatible_release(old, {'images': dict(new['images'], **{name: 'changed'}), 'source': 'new', 'migrationSource': 'fixed'})

    def test_pending_journal_refuses_retry_and_closed_hold_also_blocks_start(self):
        with tempfile.TemporaryDirectory() as temp:
            state = Path(temp)
            op = ops.Journal(state, 'backup')
            with op: op.intent('stop')
            with self.assertRaises(ops.Refused):
                with ops.Journal(state, 'backup'): pass

    def test_empty_restore_target_never_overwrites_existing_content(self):
        with tempfile.TemporaryDirectory() as temp:
            target = Path(temp)
            (target / 'valuable').write_text('retain')
            with self.assertRaises(ops.Refused): ops.empty_target(target)
            self.assertEqual((target / 'valuable').read_text(), 'retain')

    def test_backup_rejects_symlink_and_hardlink_without_reading_target(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); source = root / 'source'; source.mkdir()
            (root / 'external').write_text('retain')
            (source / 'link').symlink_to(root / 'external')
            with self.assertRaises(ops.Refused): ops.tree_entries(source, 1024)
            (source / 'link').unlink(); os.link(root / 'external', source / 'linked')
            with self.assertRaises(ops.Refused): ops.tree_entries(source, 1024)


COMPOSE_FILE = Path(__file__).resolve().parents[1] / 'compose.yaml'


def pinned_digest(reference):
    """Digest pinned for `repository:tag` in compose.yaml, the single source; fails loudly."""
    found = re.findall(r'^    image: ' + re.escape(reference) + r'@sha256:([0-9a-f]{64})$',
                       COMPOSE_FILE.read_text(), re.MULTILINE)
    if len(found) != 1: raise AssertionError('compose.yaml must pin exactly one ' + reference)
    return found[0]


POSTGRES_DIGEST = pinned_digest('pgvector/pgvector:pg17')
CACHE_DIGEST = pinned_digest('valkey/valkey:8.1.10-alpine')
# compose.yaml pins `repository:tag@digest`; after `docker pull`, Docker 29.9.2 records only
# `repository@digest` in RepoDigests (observed on the build VM). Built by literal
# concatenation of the expected repository, never derived by the function under test.
PINNED = {'db': ('pgvector/pgvector:pg17@sha256:' + POSTGRES_DIGEST, 'pgvector/pgvector@sha256:' + POSTGRES_DIGEST),
          'redis': ('valkey/valkey:8.1.10-alpine@sha256:' + CACHE_DIGEST, 'valkey/valkey@sha256:' + CACHE_DIGEST)}


class CompositionTests(unittest.TestCase):
    def composed(self):
        operator = object.__new__(ops.Operator)
        operator.project = 'memlia-fixture1'; operator.config = Path('/protected')
        operator.cfg = {'source': 'b' * 40, 'migrationSource': 'a' * 40, 'lockSha256': 'c' * 64}
        names = (*ops.APP, 'migrations', 'db', 'redis')
        services = {name: {'image': PINNED[name][0] if name in PINNED else 'fixture/' + name + '@sha256:' + 'd' * 64,
                           'environment': {}} for name in names}
        for name in ('web', 'realtime', 'workflow-worker'):
            services[name]['environment'].update(NEXT_PUBLIC_APP_URL='https://fixture.test', BETTER_AUTH_URL='https://fixture.test')
        for name, role in (('web', 'web'), ('realtime', 'realtime'), ('migrations', 'migrate'), ('workflow-worker', 'worker')):
            services[name]['environment']['DATABASE_URL'] = 'postgres://' + role + ':fake@db/business'
        for name in ('web', 'workflow-worker'):
            services[name]['environment']['MEMLIA_PG_BOSS_DATABASE_URL'] = 'postgres://transport:fake@db/business'
        model = {'services': services, 'volumes': {name: {'name': operator.project + '_' + name} for name in ops.VOLUMES}}
        operator.compose_run = lambda *args: ops.json_bytes(model)
        operator.docker = lambda *args: ops.json_bytes({'OSType': 'linux', 'DockerRootDir': '/owned-docker'})
        labels = {name: {'org.memlia.source': 'a' * 40 if name == 'migrations' else 'b' * 40,
                         'org.memlia.lock': 'c' * 64} for name in names}
        # Local-registry application images carry no tag: Docker records the reference itself.
        recorded = {name: [PINNED[name][1] if name in PINNED else services[name]['image']] for name in names}
        platform = {name: 'linux' for name in names}
        def inspect(*args):
            name = next(name for name in names if services[name]['image'] == args[-1])
            row = {'Os': platform[name], 'Config': {'Labels': labels[name]}}
            if recorded[name] is not None: row['RepoDigests'] = recorded[name]
            return row
        operator.one = inspect
        return operator, recorded, labels, services, platform

    def test_recorded_forms_are_the_ones_observed_on_the_build_vm(self):
        # Run5 (Docker 29.9.2) RepoDigests, compared on the first digest characters only.
        self.assertTrue(PINNED['db'][1].startswith('pgvector/pgvector@sha256:ac08538c'))
        self.assertTrue(PINNED['redis'][1].startswith('valkey/valkey@sha256:081c2f5c'))

    def test_pinned_services_are_admitted_by_the_untagged_repo_digest_docker_records(self):
        from unittest.mock import patch
        operator, recorded, _, services, platform = self.composed()
        with patch.object(ops, 'read_file', return_value=b''), patch.object(ops, 'safe_directory', return_value=Path('/owned-docker')):
            self.assertEqual(operator.model_read()['images']['db'], PINNED['db'][0])
            for name, digest in (('db', POSTGRES_DIGEST), ('redis', CACHE_DIGEST)):
                repository = PINNED[name][1].split('@')[0]
                for edit, value in (('digest', [repository + '@sha256:' + '0' * 64]),
                                    ('repository', ['attacker/' + repository.split('/')[1] + '@sha256:' + digest]),
                                    ('registry', ['registry.invalid/' + repository + '@sha256:' + digest]),
                                    ('tagged-never-recorded', [PINNED[name][0]]),
                                    ('truncated', [PINNED[name][1][:-1]]), ('empty', []), ('absent', None)):
                    saved = recorded[name]; recorded[name] = value
                    with self.subTest(name=name, edit=edit), self.assertRaisesRegex(ops.Refused, 'image_digest'):
                        operator.model_read()
                    recorded[name] = saved
                # One image may be recorded under several repositories (local mirror + Hub), in any order.
                mirror = '127.0.0.1:15000/mirror/' + repository + '@sha256:' + digest
                for order in ([mirror, PINNED[name][1]], [PINNED[name][1], mirror]):
                    saved = recorded[name]; recorded[name] = order
                    with self.subTest(name=name, order=order): operator.model_read()
                    recorded[name] = saved
                saved = recorded[name]
                recorded[name] = ['attacker/' + repository.split('/')[1] + '@sha256:' + digest,
                                  'registry.invalid/' + repository + '@sha256:' + digest]
                with self.subTest(name=name, edit='several-foreign'), self.assertRaisesRegex(ops.Refused, 'image_digest'):
                    operator.model_read()
                recorded[name] = saved
                platform[name] = 'windows'
                with self.subTest(name=name, edit='os'), self.assertRaisesRegex(ops.Refused, 'image_digest'):
                    operator.model_read()
                platform[name] = 'linux'
            saved = recorded['web']; recorded['web'] = ['fixture/web@sha256:' + 'e' * 64]
            with self.assertRaisesRegex(ops.Refused, 'image_digest'): operator.model_read()
            recorded['web'] = saved
            # Admitted by preflight's reference pattern, but no repository Docker could record.
            services['db']['image'] = 'pgvector/:pg17@sha256:' + POSTGRES_DIGEST; recorded['db'] = [PINNED['db'][1]]
            with self.assertRaisesRegex(ops.Refused, 'image_digest'): operator.model_read()

    def test_new_application_source_composes_with_pinned_previous_migrations(self):
        from unittest.mock import patch
        operator, _, labels, _, _ = self.composed()
        # External Docker/filesystem boundaries doubled; Compose preflight and image admission are real.
        with patch.object(ops, 'read_file', return_value=b''), patch.object(ops, 'safe_directory', return_value=Path('/owned-docker')):
            release = operator.model_read()
            self.assertEqual(release['migrationSource'], 'a' * 40)
            old = dict(release, source='a' * 40, images=dict(release['images'], web='old-web'))
            ops.compatible_release(old, release)
            with self.assertRaises(ops.Refused): ops.compatible_release(old, dict(release, migrationSource='b' * 40))
            for service in ('migrations', 'web'):
                saved = labels[service]['org.memlia.source']; labels[service]['org.memlia.source'] = 'e' * 40
                with self.subTest(service=service), self.assertRaisesRegex(ops.Refused, 'image_source'):
                    operator.model_read()
                labels[service]['org.memlia.source'] = saved

    def test_initial_install_rejects_split_source_before_any_effect(self):
        operator = object.__new__(ops.Operator); calls = []
        operator.model_read = lambda: {'source': 'b' * 40, 'migrationSource': 'a' * 40}
        operator.fresh = lambda: calls.append('fresh')
        operator.journal = type('Journal', (), {'intent': lambda *args: calls.append('intent')})()
        operator.compose_run = lambda *args: calls.append('compose')
        with self.assertRaisesRegex(ops.Refused, 'initial_migration_source'):
            operator.install()
        self.assertEqual(calls, [])

    def test_same_image_with_foreign_volume_or_changed_database_is_refused(self):
        service = {'volumes': [{'type': 'volume', 'source': 'uploads', 'target': '/uploads'}],
                   'environment': {'DATABASE_URL': 'fixture-only'}}
        model = {'volumes': {'uploads': {'name': 'owned_uploads'}}}
        row = {'Mounts': [{'Type': 'volume', 'Name': 'owned_uploads', 'Destination': '/uploads', 'RW': True}],
               'Config': {'Env': ['DATABASE_URL=fixture-only']}}
        ops.verify_mounts(row, service, model)
        row['Mounts'][0]['Name'] = 'foreign_uploads'
        with self.assertRaisesRegex(ops.Refused, 'container_mounts_changed'): ops.verify_mounts(row, service, model)
        row['Mounts'][0]['Name'] = 'owned_uploads'; row['Config']['Env'] = ['DATABASE_URL=other-fixture']
        with self.assertRaisesRegex(ops.Refused, 'container_environment_changed'): ops.verify_mounts(row, service, model)

    def test_native_install_order_keeps_worker_stopped_and_verifies_grants(self):
        from unittest.mock import patch
        operator = object.__new__(ops.Operator)
        calls = []; operator.config = Path('/protected')
        operator.journal = type('Journal', (), {'intent': lambda _, phase: calls.append(('intent', phase))})()
        operator.model_read = lambda: {'source': 'fixed', 'migrationSource': 'fixed'}
        operator.fresh = lambda: calls.append(('fresh',))
        operator.compose_run = lambda *args: calls.append(('compose', *args))
        operator.bootstrap = lambda phase: calls.append(('bootstrap', phase))
        with patch.object(ops, 'safe_directory'):
            result = operator.install()
        phases = [x[1] for x in calls if x[0] == 'bootstrap']
        self.assertEqual(phases, ['prepare', 'grants', 'verify'])
        migrate = next(i for i, x in enumerate(calls) if '--exit-code-from' in x)
        self.assertLess(calls.index(('bootstrap', 'prepare')), migrate)
        self.assertLess(migrate, calls.index(('bootstrap', 'grants')))
        self.assertNotIn('workflow-worker', calls[-1])
        self.assertFalse(result['workerStarted'])
        self.assertFalse(result['businessQualified'])

    def test_failed_bootstrap_never_starts_applications(self):
        from unittest.mock import patch
        operator = object.__new__(ops.Operator); calls = []; operator.config = Path('/protected')
        operator.journal = type('Journal', (), {'intent': lambda *_: None})()
        operator.model_read = lambda: {'source': 'fixed', 'migrationSource': 'fixed'}; operator.fresh = lambda: None
        operator.compose_run = lambda *args: calls.append(args)
        def refused(_): raise ops.Refused('native_unknown')
        operator.bootstrap = refused
        with patch.object(ops, 'safe_directory'), self.assertRaises(ops.Refused): operator.install()
        self.assertFalse(any('web' in args or 'workflow-worker' in args for args in calls))

    def test_extract_readback_and_unrelated_file_preserved(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve(); archive = root / 'data.tar'; out = root / 'out'; out.mkdir()
            (root / 'unrelated').write_bytes(b'keep')
            with tarfile.open(archive, 'w') as target:
                entry = tarfile.TarInfo('uploads/folder/file'); entry.size = 3; entry.mode = 0o600
                entry.uid = os.geteuid(); entry.gid = os.getegid(); target.addfile(entry, io.BytesIO(b'abc'))
            entries = ops.inspect_archive(archive, 1024)
            with tarfile.open(archive) as source:
                ops.Operator.extract(None, source, entries, {'uploads': out})
            self.assertEqual((out / 'folder/file').read_bytes(), b'abc')
            self.assertEqual((root / 'unrelated').read_bytes(), b'keep')
            with tarfile.open(archive) as source, self.assertRaises(FileExistsError):
                ops.Operator.extract(None, source, entries, {'uploads': out})

    def test_archive_duplicate_and_capacity_are_rejected(self):
        for duplicate in (True, False):
            with self.subTest(duplicate=duplicate), tempfile.TemporaryDirectory() as temp:
                archive = Path(temp) / 'archive.tar'
                with tarfile.open(archive, 'w') as out:
                    for i in range(2):
                        entry = tarfile.TarInfo('uploads/x' if duplicate else f'uploads/{i}')
                        entry.size = 2; out.addfile(entry, io.BytesIO(b'ab'))
                with self.assertRaises(ops.Refused): ops.inspect_archive(archive, 10 if duplicate else 3)

    def test_completed_hold_is_not_silently_retried(self):
        # Journal lock/permissions use real files; no Docker or root simulation.
        with tempfile.TemporaryDirectory() as temp:
            state = Path(temp).resolve()
            with ops.Journal(state, 'restore') as operation:
                operation.finish({'status': 'HOLD', 'restored': True})
            with self.assertRaises(ops.Refused):
                with ops.Journal(state, 'install'): pass

    def test_restore_existing_project_refuses_before_config_or_crypto(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as temp:
            operator = object.__new__(ops.Operator); operator.config = Path(temp)
            def refuse(): raise ops.Refused('installation_exists')
            operator.fresh = refuse
            with patch.object(ops, 'read_file') as read, self.assertRaisesRegex(ops.Refused, 'installation_exists'):
                operator.restore('unused', '0'*64, 'unused', 'unused')
            read.assert_not_called()
            self.assertEqual(list(Path(temp).iterdir()), [])

    def test_wrong_ciphertext_never_reaches_extraction(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve(); destination = root / 'configuration'; destination.mkdir()
            operator = object.__new__(ops.Operator); operator.config = destination; operator.fresh = lambda: None
            operator.cfg = {'maxBackupBytes': 1024**2}
            with patch.object(ops, 'read_file', side_effect=[b'-----BEGIN ENCRYPTED PRIVATE KEY-----', b'a'*20]), \
                 patch.object(ops, 'safe_directory'), patch.object(ops.Operator, 'extract') as extract:
                archive = root / 'backup.cms'; archive.write_bytes(b'tampered'); archive.chmod(0o600)
                # UID check can refuse on Mac before the digest; neither path writes/restores.
                with self.assertRaises(ops.Refused):
                    operator.restore(archive, '0'*64, root / 'key', root / 'pass')
                extract.assert_not_called()


class NativeCryptoTest(unittest.TestCase):
    @unittest.skipUnless(os.environ.get('MEMLIA_TEST_OPENSSL'), 'explicit existing OpenSSL3 required')
    def test_production_cms_argv_roundtrip_and_authentication_refusal(self):
        import subprocess
        tool = os.environ['MEMLIA_TEST_OPENSSL']
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); password = root / 'pass'; password.write_bytes(b'fictitious-password-operations-2026\n'); password.chmod(0o600)
            key = root / 'key.pem'; cert = root / 'cert.pem'; plain = root / 'source'; encrypted = root / 'encrypted'; restored = root / 'restored'
            def run(args):
                result = subprocess.run([tool, *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                        timeout=20, env={'PATH': '/usr/bin:/bin', 'HOME': os.environ['HOME']})
                # Diagnostics remain in the test supervisor's private output, never product output.
                if result.returncode: print(result.stderr[:4096].decode('utf-8', 'replace'))
                return result
            self.assertEqual(run(['req', '-x509', '-newkey', 'rsa:3072', '-sha256', '-days', '1',
                                  '-subj', '/CN=Memlia Fictitious Backup', '-keyout', str(key), '-out', str(cert),
                                  '-passout', 'file:' + str(password)]).returncode, 0)
            plain.write_bytes(b'fictitious-DB-files-trust-config\x00' * 128)
            self.assertEqual(run(ops.encryption_args(plain, encrypted, cert)).returncode, 0)
            self.assertNotIn(b'fictitious-DB-files', encrypted.read_bytes())
            self.assertEqual(run(ops.decryption_args(encrypted, restored, key, password)).returncode, 0)
            self.assertEqual(restored.read_bytes(), plain.read_bytes())
            raw = bytearray(encrypted.read_bytes()); raw[-16] ^= 1; encrypted.write_bytes(raw)
            self.assertNotEqual(run(ops.decryption_args(encrypted, restored, key, password)).returncode, 0)


class NativeCaptureTest(unittest.TestCase):
    def test_nonzero_child_raw_is_private_before_fixed_refusal_and_group_closed(self):
        import sys
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as temp:
            work = Path(temp).resolve()
            executable = Path(sys.executable).resolve()
            # File-policy boundary is doubled for this non-root Mac author test only.
            tool_bytes = executable.read_bytes()
            commands = ops.Commands(work, {'docker': {'path': str(executable),
                                    'sha256': ops.digest(tool_bytes)}}, ops.time.monotonic() + 10)
            with patch.object(ops, 'read_file', return_value=tool_bytes):
                with self.assertRaisesRegex(ops.Refused, '^command_failed$'):
                    commands.run('docker', ['-c', 'import sys; sys.stderr.write("fictitious-private-canary"); sys.exit(7)'])
            logs = list(work.glob('*.stderr.private.log'))
            self.assertEqual(len(logs), 1)
            self.assertEqual(logs[0].read_bytes(), b'fictitious-private-canary')
            self.assertEqual(logs[0].stat().st_mode & 0o777, 0o600)
            closed = json.loads(next(work.glob('*.closed.json')).read_text())
            self.assertTrue(closed['closed'])


class AgentControlOperations(unittest.TestCase):
    def test_effective_controller_command_image_and_ports_are_attested_before_stop(self):
        from copy import deepcopy
        service={'image':'fixture/workflow-worker@sha256:'+'a'*64,
                 'command':['node','dist/memlia-agent-control.mjs'],
                 'ports':[{'host_ip':'192.168.1.20','target':9443,'published':'9443','protocol':'tcp'}]}
        image={'Id':'sha256:'+'b'*64,'Config':{'Entrypoint':['docker-entrypoint.sh'],'Env':['NODE_ENV=production']}}
        ports={'9443/tcp':[{'HostIp':'192.168.1.20','HostPort':'9443'}]}
        model={'networks':{'backend':{'name':'memlia-fixture001_backend'}}}
        row={'Image':image['Id'],'Config':{'Image':service['image'],
             'Entrypoint':['docker-entrypoint.sh'],'Cmd':service['command'][:],
             'WorkingDir':'/app/apps/sim','User':'1001:1001','Env':['NODE_ENV=production']},
             'HostConfig':{'Init':True,'ReadonlyRootfs':True,'Privileged':False,
               'CapDrop':['ALL'],'CapAdd':None,'SecurityOpt':['no-new-privileges:true'],
               'NetworkMode':'memlia-fixture001_backend','PortBindings':deepcopy(ports),
               'PidMode':'','IpcMode':'private','Devices':[],'DeviceRequests':None,'Tmpfs':None,
               'Memory':1073741824,'MemorySwap':1073741824,'NanoCpus':1000000000,'PidsLimit':128},
             'Mounts':[],'NetworkSettings':{'Ports':deepcopy(ports),
               'Networks':{'memlia-fixture001_backend':{}}},'State':{'Running':True,'Status':'running'}}
        ops.verify_agent_control_container(row,service,model,image)
        for branch,key,value in [('Config','Cmd',['node','foreign.mjs']),
             ('Config','Entrypoint',[]),('Config','WorkingDir','/tmp'),('Config','User','0:0'),
             ('Config','Env',['NODE_ENV=production','NODE_OPTIONS=--require=/tmp/foreign.cjs']),
             ('Config','Env',['NODE_ENV=production','NODE_ENV=production']),
             ('HostConfig','Init',False),('HostConfig','Privileged',True),
             ('HostConfig','ReadonlyRootfs',False),('HostConfig','CapAdd',['SYS_ADMIN']),
             ('HostConfig','SecurityOpt',[]),('HostConfig','NetworkMode','host'),
             ('HostConfig','PidMode','host'),('HostConfig','IpcMode','host'),
             ('HostConfig','Devices',[{'PathOnHost':'/dev/mem'}]),
             ('HostConfig','DeviceRequests',[{'Capabilities':[['gpu']]}]),
             ('HostConfig','Tmpfs',{'/app/apps/sim':'rw'}),
             ('HostConfig','Memory',0),('HostConfig','MemorySwap',-1),
             ('HostConfig','NanoCpus',0),('HostConfig','PidsLimit',0),
             ('HostConfig','PortBindings',{'9443/tcp':[{'HostIp':'0.0.0.0','HostPort':'9443'}]}),
             ('NetworkSettings','Ports',{'9443/tcp':[{'HostIp':'::','HostPort':'9443'}]}),
             ('NetworkSettings','Networks',{'memlia-fixture001_backend':{},'foreign_network':{}})]:
            changed=deepcopy(row);changed[branch][key]=value
            with self.subTest(branch=branch,key=key),self.assertRaises(ops.Refused):
                ops.verify_agent_control_container(changed,service,model,image)
        changed=deepcopy(row);changed['Image']='sha256:'+'c'*64
        with self.assertRaises(ops.Refused):ops.verify_agent_control_container(changed,service,model,image)
        changed=deepcopy(row);changed['Mounts']=[{'Type':'tmpfs','Destination':'/app/apps/sim'}]
        with self.assertRaises(ops.Refused):ops.verify_agent_control_container(changed,service,model,image)
        for running in [False,True]:
            changed=deepcopy(row);changed['State']={'Running':running,'Status':'created' if not running else 'running'}
            changed['NetworkSettings']['Ports']={}
            if not running:ops.verify_agent_control_container(changed,service,model,image)
            else:
                with self.assertRaises(ops.Refused):ops.verify_agent_control_container(changed,service,model,image)
        # Exercise the existing native-inspect/stop composition: refusal must occur
        # before even the stop intent, rather than testing an unused validator.
        operator=object.__new__(ops.Operator);operator.project='memlia-fixture001';calls=[]
        operator.model=dict(model,services={'agent-control':service})
        cid='d'*64;row['Id']=cid;row['Mounts']=[]
        row['Config']['Labels']={'com.docker.compose.project':operator.project,'com.docker.compose.service':'agent-control'}
        operator.docker=lambda *args:cid.encode()
        operator.one=lambda kind,*args:row if kind=='container' else image
        operator.journal=type('Journal',(),{'intent':lambda _,phase:calls.append(('intent',phase))})()
        def stop(*args):
            calls.append(args)
            if args[-1]=='agent-control':row['State'].update(Running=False,Status='exited',ExitCode=0,OOMKilled=False)
        operator.compose_run=stop
        operator.stop()
        self.assertEqual(calls[1],('stop','--timeout','120','agent-control'))
        calls.clear();row['Config']['Cmd']=['node','foreign.mjs']
        with self.assertRaisesRegex(ops.Refused,'agent_control_command_changed'):operator.stop()
        self.assertEqual(calls,[])

    @staticmethod
    def config():
        cert=b'-----BEGIN CERTIFICATE-----\nfictitious-recipient\n-----END CERTIFICATE-----\n'
        return {'version':'memlia.operations/v1','project':'memlia-fixture001','configDirectory':'/protected/config','stateDirectory':'/protected/state','backupDirectory':'/protected/backups','source':'a'*40,'migrationSource':'a'*40,'lockSha256':'b'*64,'tools':{name:{'path':'/usr/bin/'+name,'sha256':'c'*64} for name in ('docker','openssl')},'recipientCertificate':'/protected-recipient/recipient.pem','recipientSha256':ops.digest(cert),'maxBackupBytes':1024**2},cert

    def test_administrator_optin_is_exact_boolean_and_never_environment_selected(self):
        cfg,_=self.config()
        for value in [False,True]:self.assertEqual(ops.configuration(ops.json_bytes(cfg|{'agentControlEnabled':value}))['agentControlEnabled'],value)
        self.assertNotIn('agentControlEnabled',ops.configuration(ops.json_bytes(cfg)))
        for value in [1,'true',None,[]]:
            with self.subTest(value=value),self.assertRaises(ops.Refused):ops.configuration(ops.json_bytes(cfg|{'agentControlEnabled':value}))
        with self.assertRaises(ops.Refused):ops.configuration(ops.json_bytes(cfg|{'agentControlProfile':'PRIVATE_CANARY'}))

    def test_operator_selects_only_fixed_overlay_after_explicit_optin(self):
        from unittest.mock import patch
        cfg,cert=self.config();journal=type('Journal',(),{'work':Path('/owned')})()
        with patch.object(ops,'safe_directory',side_effect=lambda p,**kw:Path(p)),patch.object(ops,'read_file',return_value=cert):
            for enabled in [False,True]:
                operator=ops.Operator(cfg|{'agentControlEnabled':enabled},journal)
                self.assertEqual(str(ops.ROOT/'deploy/memlia/compose.agent-control.yaml') in operator.compose,enabled)
                self.assertNotIn('PRIVATE_CANARY',operator.compose)

    def test_controller_is_stopped_and_proved_closed_before_other_producers_and_database(self):
        operator=object.__new__(ops.Operator);calls=[]
        operator.model={'services':{n:{} for n in (*ops.APP,'agent-control','db','redis','migrations')}}
        row={'Config':{'Labels':{'com.docker.compose.service':'agent-control'}},'State':{'Running':False,'Status':'exited','ExitCode':0,'OOMKilled':False}}
        operator.containers=lambda stopped=False:[row]
        operator.journal=type('Journal',(),{'intent':lambda _,phase:calls.append(('intent',phase))})()
        operator.compose_run=lambda *args:calls.append(args)
        operator.stop()
        stop_calls=[call for call in calls if call[0]=='stop']
        self.assertEqual(stop_calls[0],('stop','--timeout','120','agent-control'))
        self.assertIn('web',stop_calls[1]);self.assertEqual(stop_calls[-1][-3:],('migrations','db','redis'))
        for change in [{'Running':True},{'ExitCode':1},{'ExitCode':134},{'ExitCode':137},{'ExitCode':143},{'OOMKilled':True}]:
            calls.clear();row['State'].update(Running=False,Status='exited',ExitCode=0,OOMKilled=False);row['State'].update(change)
            with self.subTest(change=change),self.assertRaisesRegex(ops.Refused,'agent_control_stop_unknown'):operator.stop()
            self.assertEqual(len([call for call in calls if call[0]=='stop']),1)

    def test_initial_install_never_promotes_controller_or_claims_readiness(self):
        from unittest.mock import patch
        operator=object.__new__(ops.Operator);calls=[];operator.config=Path('/protected')
        operator.model_read=lambda:{'source':'fixed','migrationSource':'fixed'};operator.fresh=lambda:None
        operator.journal=type('Journal',(),{'intent':lambda *_:None})();operator.bootstrap=lambda _:None
        operator.compose_run=lambda *args:calls.append(args)
        with patch.object(ops,'safe_directory'):result=operator.install()
        self.assertFalse(result['agentControlStarted']);self.assertFalse(result['businessQualified'])
        self.assertTrue(all('agent-control' not in call for call in calls if call[0]=='up'))

    def test_model_and_runtime_config_bindings_and_two_private_metadata_files(self):
        from unittest.mock import patch
        from urllib.parse import urlsplit
        import stat
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary).resolve();secrets=root/'control-secrets';secrets.mkdir(mode=0o700)
            (secrets/'key.pem').write_bytes(b'FICTITIOUS-ENCRYPTED-KEY-'+b'x'*128);(secrets/'key.pem').chmod(0o600)
            (secrets/'passphrase').write_bytes(b'FICTITIOUS-PASSPHRASE-ONLY');(secrets/'passphrase').chmod(0o600)
            cert=b'-----BEGIN CERTIFICATE-----\nfictitious\n-----END CERTIFICATE-----\n'
            config={'version':'memlia.agent-control-runtime/v1','installation':{'id':'fixture-install','fqdn':'https://fixture.invalid'},'controlOrigin':'https://control.fixture.invalid:9443','listenHost':'0.0.0.0','certificatePath':'/etc/memlia-agent-control/server.pem','certificateSha256':ops.digest(cert),'encryptedKeyPath':'/run/memlia-agent-control/key.pem','encryptedKeySha256':'a'*64,'passphraseFilePath':'/run/memlia-agent-control/passphrase','clientCaPath':'/etc/memlia-agent-control/client-ca.pem','clientCaSha256':ops.digest(cert)}
            mounts=[{'target':target,'source':str(source)} for target,source in [('/etc/memlia-agent-control/config.json',root/'config.json'),('/etc/memlia-agent-control/server.pem',root/'server.pem'),('/etc/memlia-agent-control/client-ca.pem',root/'client-ca.pem'),('/run/memlia-agent-control',secrets)]]
            model={'services':{'web':{'environment':{'NEXT_PUBLIC_APP_URL':'https://fixture.invalid'}},'agent-control':{'volumes':mounts}}}
            operator=object.__new__(ops.Operator);operator.config=root
            original=Path.lstat
            def metadata(path,*args,**kwargs):
                value=original(path,*args,**kwargs)
                if path==secrets or path.parent==secrets:
                    parts=list(value);parts[4]=1001;parts[5]=1001;return os.stat_result(parts)
                return value
            def read(path,*args,**kwargs):return ops.json_bytes(config) if Path(path).name=='config.json' else cert
            def origin(value):return value if urlsplit(value).scheme=='https' else 'refused'
            # Only the UID/GID and public protected-read boundaries are doubled. Secret bytes are never read.
            with patch.object(ops,'safe_directory'),patch.object(ops,'read_file',side_effect=read),patch.object(Path,'lstat',metadata):
                operator.agent_control_inputs(model,origin)
                for field,value in [('listenHost','127.0.0.1'),('encryptedKeyPath','/run/ca-private.key'),('controlOrigin','https://control.fixture.invalid:9444')]:
                    before=config[field];config[field]=value
                    with self.subTest(field=field),self.assertRaises(ops.Refused):operator.agent_control_inputs(model,origin)
                    config[field]=before
                (secrets/'passphrase').chmod(0o644)
                with self.assertRaises(ops.Refused):operator.agent_control_inputs(model,origin)
                (secrets/'passphrase').chmod(0o600);(secrets/'private-ca.pem').write_bytes(b'fictitious-forbidden')
                with self.assertRaises(ops.Refused):operator.agent_control_inputs(model,origin)


if __name__ == '__main__': unittest.main()
