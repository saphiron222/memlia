#!/usr/bin/env python3
# Copyright (c) 2026 Memlia. All rights reserved.
"""Administrator-only, stopped-volume operations for the existing Compose profile.

No scheduler, migration implementation, automatic recovery or external-effect replay.
A pending intent is never retried. Restore/update/rollback leave the project stopped.
"""
import argparse
import fcntl
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath
import pwd
import re
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import time
import uuid
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
MIN_FREE = 40 * 1024**3
MAX_LOG = 1024**2
VOLUMES = ('postgres_data', 'uploads', 'redis_data')
APP = ('web', 'realtime', 'cron', 'workflow-worker')
CONFIG_VERSION = 'memlia.operations/v1'


class Refused(ValueError):
    pass


def need(value, code='operations_refused'):
    if not value: raise Refused(code)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def decode(raw):
    def pairs(items):
        result = {}
        for k, v in items:
            need(k not in result, 'duplicate_json_key'); result[k] = v
        return result
    return json.loads(raw.decode('utf-8'), object_pairs_hook=pairs,
                      parse_constant=lambda _: need(False, 'json_constant'))


def identity(st):
    return st.st_dev, st.st_ino, st.st_mode, st.st_uid, st.st_gid, st.st_nlink, st.st_size, st.st_mtime_ns, st.st_ctime_ns


def safe_directory(path, private=False):
    path = Path(path)
    need(path.is_absolute() and path == path.resolve(), 'directory_not_canonical')
    for item in (path, *path.parents):
        st = item.lstat()
        need(stat.S_ISDIR(st.st_mode) and st.st_uid in (0, os.geteuid()) and not st.st_mode & 0o022,
             'directory_permissions')
    if private: need(stat.S_IMODE(path.stat().st_mode) == 0o700, 'directory_private')
    return path


def read_file(path, limit, *, private=False):
    path = Path(path); safe_directory(path.parent, private=private)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and before.st_uid == os.geteuid() and before.st_nlink == 1
             and not before.st_mode & (0o077 if private else 0o022) and before.st_size <= limit, 'file_permissions')
        with os.fdopen(os.dup(fd), 'rb') as stream: raw = stream.read(limit + 1)
        need(len(raw) == before.st_size and identity(before) == identity(os.fstat(fd))
             == identity(path.lstat()), 'file_changed')
        return raw
    finally: os.close(fd)


def write_new(path, raw):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(os.dup(fd), 'wb') as stream:
            stream.write(raw); stream.flush(); os.fsync(stream.fileno())
    finally: os.close(fd)
    sync_dir(Path(path).parent)


def sync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try: os.fsync(fd)
    finally: os.close(fd)


def json_bytes(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def empty_target(path):
    need(path.is_dir() and not path.is_symlink() and not any(path.iterdir()), 'restore_target_not_empty')


def tree_entries(root, limit):
    """No links, devices, sockets, hard links or cross-filesystem content."""
    root = Path(root); initial = root.lstat(); need(stat.S_ISDIR(initial.st_mode), 'tree_root')
    rows = []; total = 0
    for base, dirs, files in os.walk(root, followlinks=False):
        for name in sorted(dirs + files):
            path = Path(base) / name; st = path.lstat()
            need(st.st_dev == initial.st_dev and (stat.S_ISDIR(st.st_mode) or stat.S_ISREG(st.st_mode))
                 and not st.st_mode & 0o7000, 'tree_type_refused')
            if stat.S_ISREG(st.st_mode):
                need(st.st_nlink == 1, 'tree_link_refused'); total += st.st_size
            need(total <= limit and len(rows) < 1_000_000, 'tree_limit')
            rows.append((path.relative_to(root).as_posix(), identity(st)))
    need(identity(initial) == identity(root.lstat()), 'tree_root_changed')
    return rows


def inspect_archive(path, limit):
    entries = []; names = set(); size = 0
    with tarfile.open(path, 'r:') as archive:
        for entry in archive:
            p = PurePosixPath(entry.name)
            need(not p.is_absolute() and str(p) == entry.name and '..' not in p.parts
                 and p.parts and p.parts[0] in (*VOLUMES, 'config', 'manifest.json')
                 and entry.name not in names and (entry.isfile() or entry.isdir())
                 and not entry.mode & 0o7000 and 0 <= entry.uid < 2**31 and 0 <= entry.gid < 2**31,
                 'archive_member_refused')
            need(p.parts[0] != 'manifest.json' or (entry.name == 'manifest.json' and entry.isfile()), 'archive_manifest')
            size += entry.size; need(size <= limit and len(entries) < 1_000_000, 'archive_limit')
            names.add(entry.name); entries.append(entry)
    return entries


def encryption_args(source, target, recipient):
    return ['cms', '-encrypt', '-aes-256-gcm', '-binary', '-stream', '-outform', 'DER',
            '-in', str(source), '-out', str(target), str(recipient)]


def decryption_args(source, target, key, passphrase):
    return ['cms', '-decrypt', '-binary', '-inform', 'DER', '-in', str(source),
            '-inkey', str(key), '-passin', 'file:' + str(passphrase), '-out', str(target)]


def verify_mounts(row, service, model):
    expected = {}
    for mount in service.get('volumes', []):
        if mount['type'] == 'volume':
            expected[mount['target']] = ('volume', model['volumes'][mount['source']]['name'], not mount.get('read_only', False))
        elif mount['type'] == 'bind':
            expected[mount['target']] = ('bind', mount['source'], not mount.get('read_only', False))
    actual = {}
    for mount in row['Mounts']:
        if mount['Type'] == 'tmpfs': continue
        need(mount['Destination'] not in actual, 'mount_duplicate')
        actual[mount['Destination']] = (mount['Type'], mount.get('Name') if mount['Type'] == 'volume' else mount['Source'], mount['RW'])
    need(actual == expected, 'container_mounts_changed')
    environment = dict(item.split('=', 1) for item in row['Config'].get('Env', []) if '=' in item)
    need(all(environment.get(key) == str(value) for key, value in service.get('environment', {}).items()), 'container_environment_changed')


def verify_agent_control_container(row, service, model, image):
    """Attest effective Docker configuration, never infer mTLS/business readiness."""
    config=row['Config'];host=row['HostConfig']
    need(row['Image']==image['Id'] and config['Image']==service['image'], 'agent_control_image_changed')
    need(image['Config'].get('Entrypoint')==['docker-entrypoint.sh']
         and config.get('Entrypoint')==image['Config']['Entrypoint']
         and config.get('Cmd')==service['command']==['node','dist/memlia-agent-control.mjs']
         and config.get('WorkingDir')=='/app/apps/sim' and config.get('User')=='1001:1001',
         'agent_control_command_changed')
    need(host.get('Init') is True and host.get('ReadonlyRootfs') is True
         and host.get('Privileged') is False and host.get('CapDrop')==['ALL']
         and host.get('CapAdd') in (None,[]) and host.get('SecurityOpt')==['no-new-privileges:true']
         and host.get('PidMode')=='' and host.get('IpcMode')=='private'
         and host.get('Devices') in (None,[]) and host.get('DeviceRequests') in (None,[])
         and host.get('Tmpfs') in (None,{})
         and not any(mount.get('Type')=='tmpfs' for mount in row['Mounts'])
         and host.get('Memory')==1073741824 and host.get('MemorySwap')==1073741824
         and host.get('NanoCpus')==1000000000 and host.get('PidsLimit')==128
         and host.get('NetworkMode')==model['networks']['backend']['name'], 'agent_control_authority_changed')
    def environment(items):
        need(type(items) is list and all(type(item) is str and '=' in item for item in items), 'agent_control_environment_changed')
        values=dict(item.split('=',1) for item in items)
        need(len(values)==len(items), 'agent_control_environment_changed')
        return values
    expected=environment(image['Config'].get('Env',[]))
    expected.update({key:str(value) for key,value in service.get('environment',{}).items()})
    need(environment(config.get('Env',[]))==expected, 'agent_control_environment_changed')
    bindings=service['ports']
    need(len(bindings)==1, 'agent_control_ports_changed')
    binding=bindings[0]
    ports={'9443/tcp':[{'HostIp':binding['host_ip'],'HostPort':str(binding['published'])}]}
    need(host.get('PortBindings')==ports, 'agent_control_ports_changed')
    # Docker may omit effective bindings while the container is created/stopped.
    # HostConfig still has to match, and every running observation must match both.
    effective=row['NetworkSettings'].get('Ports')
    need(effective==ports or (row['State']['Running'] is False and effective in ({},{'9443/tcp':None})),
         'agent_control_ports_changed')
    networks=row['NetworkSettings'].get('Networks')
    need(type(networks) is dict and (set(networks)=={model['networks']['backend']['name']}
         or (row['State']['Running'] is False and not networks)), 'agent_control_network_changed')


def compatible_release(old, new):
    need(old['migrationSource'] == new['migrationSource'], 'schema_change_requires_separate_migration')
    for name in ('db', 'redis', 'migrations'):
        need(old['images'].get(name) == new['images'].get(name), 'schema_change_requires_separate_migration')


class Journal:
    def __init__(self, state, action):
        self.state, self.action = Path(state), action
        self.work = self.state / uuid.uuid4().hex
        self.lock = None

    def __enter__(self):
        self.lock = os.open(self.state / 'lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        st = os.fstat(self.lock)
        need(stat.S_ISREG(st.st_mode) and st.st_nlink == 1 and st.st_uid == os.geteuid()
             and not st.st_mode & 0o077, 'operation_lock')
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            for path in self.state.iterdir():
                if path.name == 'lock': continue
                need(path.is_dir() and not path.is_symlink(), 'journal_unknown')
                need((path / 'result.json').exists(), 'previous_operation_unknown')
                result = decode(read_file(path / 'result.json', 16384, private=True))
                need(result['status'] == 'PASS', 'previous_operation_hold')
            self.work.mkdir(mode=0o700); sync_dir(self.state)
            write_new(self.work / 'intent.json', json_bytes({'action': self.action, 'createdAt': time.time()}))
            return self
        except BaseException:
            os.close(self.lock); self.lock = None; raise

    def intent(self, phase):
        write_new(self.work / (phase + '.intent.json'), json_bytes({'phase': phase, 'at': time.time()}))

    def finish(self, result):
        write_new(self.work / 'result.json', json_bytes(result))

    def __exit__(self, *unused):
        if self.lock is not None: os.close(self.lock)


class Commands:
    """CLI-specific bounded capture, following the existing owned_client WNOWAIT cycle.

    Private raw streams precede exit/JSON decisions; HOME remains the actual account.
    No arbitrary executable/argv is accepted by the public CLI.
    """
    def __init__(self, work, tools, deadline):
        self.work, self.tools, self.deadline = work, tools, deadline
        self.index = 0

    def run(self, tool, args, timeout=180, output=None):
        spec = self.tools[tool]; executable = Path(spec['path'])
        need(digest(read_file(executable, 128 * 1024**2)) == spec['sha256'], 'tool_pin_changed')
        need(os.access(executable, os.X_OK), 'tool_not_executable')
        self.index += 1; prefix = self.work / ('command-%03d' % self.index)
        env = {'PATH': '/usr/bin:/bin', 'HOME': pwd.getpwuid(os.geteuid()).pw_dir,
               'LANG': 'C.UTF-8', 'DOCKER_CONFIG': str(self.work)}
        end = min(self.deadline, time.monotonic() + timeout)
        child = None; returned = bytearray(); total = 0; record = {'closed': False}
        logs = [os.open(str(prefix) + suffix, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                for suffix in ('.stdout.private.log', '.stderr.private.log')]
        try:
            need(time.monotonic() < end, 'operation_timeout')
            child = subprocess.Popen([str(executable), *args], stdin=subprocess.DEVNULL,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                     cwd=self.work, env=env, start_new_session=True)
            record['pid'] = child.pid
            with selectors.DefaultSelector() as poll:
                for i, pipe in enumerate((child.stdout, child.stderr)):
                    os.set_blocking(pipe.fileno(), False); poll.register(pipe, selectors.EVENT_READ, i)
                status = None
                while poll.get_map() or status is None:
                    need(time.monotonic() < end, 'operation_timeout')
                    need(shutil.disk_usage(self.work).free >= MIN_FREE, 'disk_reserve')
                    status = os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
                    for key, _ in poll.select(.05):
                        raw = os.read(key.fileobj.fileno(), 65536)
                        if not raw: poll.unregister(key.fileobj); continue
                        accepted = raw[:max(0, MAX_LOG - total)]
                        os.write(logs[key.data], accepted); total += len(raw)
                        if key.data == 0: returned.extend(accepted)
                        need(total <= MAX_LOG, 'diagnostic_limit')
                    if output is not None and output.exists():
                        need(shutil.disk_usage(output.parent).free >= MIN_FREE, 'disk_reserve')
                        need(output.stat().st_size <= spec.get('outputLimit', 128 * 1024**3), 'output_limit')
                need(status.si_code == os.CLD_EXITED and status.si_status == 0, 'command_failed')
                return bytes(returned)
        finally:
            try:
                if child is not None:
                    # Same zombie/EPERM handling as the existing owned_client, without reading argv.
                    def live_group():
                        rows = subprocess.check_output(['/bin/ps', '-axo', 'pid=,pgid=,stat='], timeout=2)
                        write_new(str(prefix) + '.processes-' + uuid.uuid4().hex + '.private.log', rows[:MAX_LOG])
                        need(len(rows) <= MAX_LOG, 'process_inventory_limit')
                        return any(int(row.split()[1]) == child.pid and not row.split()[2].startswith(b'Z')
                                   for row in rows.splitlines() if row.split())
                    # The unreaped leader reserves this group until its descendants are signalled.
                    for sig in (signal.SIGTERM, signal.SIGKILL):
                        try: os.killpg(child.pid, sig)
                        except ProcessLookupError: pass
                        except PermissionError:
                            need(not live_group(), 'command_group_unknown')
                        if sig == signal.SIGTERM: time.sleep(.05)
                    child.wait(timeout=2)
                    try: os.killpg(child.pid, 0)
                    except ProcessLookupError: record['closed'] = True
                    except PermissionError: record['closed'] = not live_group()
            finally:
                if child is not None:
                    child.stdout.close(); child.stderr.close()
                for fd in logs: os.fsync(fd); os.close(fd)
                write_new(str(prefix) + '.closed.json', json_bytes(record))
            need(child is None or record['closed'], 'command_group_unknown')


def configuration(raw):
    cfg = decode(raw)
    fields={'version', 'project', 'configDirectory', 'stateDirectory', 'backupDirectory',
            'source', 'migrationSource', 'lockSha256', 'tools', 'recipientCertificate', 'recipientSha256', 'maxBackupBytes'}
    need(set(cfg) in (fields,fields|{'agentControlEnabled'}), 'config_fields')
    need(type(cfg.get('agentControlEnabled',False)) is bool,'config_agent_control')
    need(cfg['version'] == CONFIG_VERSION and re.fullmatch(r'memlia-[a-z0-9-]{8,48}', cfg['project'])
         and re.fullmatch(r'[a-f0-9]{40}', cfg['source'])
         and re.fullmatch(r'[a-f0-9]{40}', cfg['migrationSource']) and re.fullmatch(r'[a-f0-9]{64}', cfg['lockSha256']), 'config_identity')
    need(type(cfg['maxBackupBytes']) is int and 1024**2 <= cfg['maxBackupBytes'] <= 128 * 1024**3, 'config_limit')
    need(set(cfg['tools']) == {'docker', 'openssl'}, 'config_tools')
    for name, tool in cfg['tools'].items():
        need(set(tool) == {'path', 'sha256'} and re.fullmatch(r'[a-f0-9]{64}', tool['sha256']), 'config_tool')
        need(Path(tool['path']).is_absolute() and Path(tool['path']).name == name, 'config_tool')
    paths = [Path(cfg[k]) for k in ('configDirectory', 'stateDirectory', 'backupDirectory')]
    need(len(set(paths)) == 3 and not any(a in b.parents for a in paths for b in paths if a != b), 'directories_overlap')
    need(re.fullmatch(r'[a-f0-9]{64}', cfg['recipientSha256']), 'recipient_pin')
    return cfg


class Operator:
    def __init__(self, cfg, journal):
        self.cfg, self.journal = cfg, journal
        self.config = safe_directory(cfg['configDirectory'], private=True)
        self.backups = safe_directory(cfg['backupDirectory'], private=True)
        tools = {name: dict(value) for name, value in cfg['tools'].items()}
        tools['openssl']['outputLimit'] = cfg['maxBackupBytes'] + 64 * 1024**2
        self.cmd = Commands(journal.work, tools, time.monotonic() + 3600)
        self.project = cfg['project']; self.model = None
        self.compose = ['--host', 'unix:///var/run/docker.sock', 'compose', '--project-name', self.project,
                        '--project-directory', str(ROOT / 'deploy/memlia'), '--env-file', str(self.config / 'compose.env'),
                        '-f', str(ROOT / 'deploy/memlia/compose.yaml'), '-f', str(ROOT / 'deploy/memlia/compose.excel.yaml')]
        if cfg.get('agentControlEnabled',False):self.compose += ['-f',str(ROOT/'deploy/memlia/compose.agent-control.yaml')]
        need(digest(read_file(cfg['recipientCertificate'], 65536)) == cfg['recipientSha256'], 'recipient_changed')
        self.recipient = read_file(cfg['recipientCertificate'], 65536)
        need(b'BEGIN CERTIFICATE' in self.recipient and b'PRIVATE KEY' not in self.recipient, 'recipient_certificate')
        need(self.config not in Path(cfg['recipientCertificate']).parents, 'recipient_must_be_separate')

    def checkpoint(self):
        need(time.monotonic() < self.cmd.deadline, 'operation_timeout')
        need(min(shutil.disk_usage(self.journal.work).free, shutil.disk_usage(self.backups).free) >= MIN_FREE, 'disk_reserve')

    def docker(self, *args):
        return self.cmd.run('docker', ['--host', 'unix:///var/run/docker.sock', *args])

    def compose_run(self, *args):
        return self.cmd.run('docker', [*self.compose, *args], timeout=600)

    def one(self, *args):
        value = decode(self.docker(*args)); need(type(value) is list and len(value) == 1, 'docker_shape'); return value[0]

    def model_read(self):
        read_file(self.config / 'compose.env', 65536, private=True)
        model = decode(self.compose_run('config', '--format', 'json'))
        spec = importlib.util.spec_from_file_location('memlia_operations_preflight', ROOT / 'deploy/memlia/preflight.py')
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        need(module.validate(model) == [], 'compose_preflight')
        need(('agent-control' in model['services'])==self.cfg.get('agentControlEnabled',False),'agent_control_optin_mismatch')
        if 'agent-control' in model['services']:self.agent_control_inputs(model,module._https_origin)
        need(set(model['volumes']) == set(VOLUMES), 'volume_set')
        for name in VOLUMES:
            need(model['volumes'][name]['name'] == self.project + '_' + name
                 and not model['volumes'][name].get('external') and not model['volumes'][name].get('driver_opts'), 'volume_configuration')
        for service in model['services'].values():
            for mount in service.get('volumes', []):
                if mount['type'] == 'bind' and mount['target'] != '/run/memlia-excel':
                    need(self.config in Path(mount['source']).parents, 'uncaptured_configuration_bind')
        info = decode(self.docker('info', '--format', '{{json .}}'))
        need(info['OSType'] == 'linux' and not any('rootless' in x for x in info.get('SecurityOptions', [])), 'daemon_profile')
        self.docker_root = safe_directory(info['DockerRootDir'])
        self.model = model
        for name, service in model['services'].items():
            row = self.one('image', 'inspect', service['image'])
            recorded = module.repo_digest(service['image'])
            need(row['Os'] == 'linux' and recorded is not None and recorded in (row.get('RepoDigests') or []), 'image_digest')
            if name in (*APP, 'agent-control', 'migrations'):
                labels = row['Config'].get('Labels', {})
                expected_source = self.cfg['migrationSource'] if name == 'migrations' else self.cfg['source']
                need(labels.get('org.memlia.source') == expected_source
                     and labels.get('org.memlia.lock') == self.cfg['lockSha256'], 'image_source')
        return {'source': self.cfg['source'], 'migrationSource': self.cfg['migrationSource'], 'lockSha256': self.cfg['lockSha256'],
                'images': {k: v['image'] for k, v in model['services'].items()}}

    def agent_control_inputs(self,model,normalize_origin):
        # Root preflight checks public files and secret metadata only. The existing
        # UID1001 native runtime remains authoritative for key/cert/DPAPI-free TLS.
        control=model['services']['agent-control']
        mounts={item['target']:Path(item['source']) for item in control['volumes']}
        cfg=decode(read_file(mounts['/etc/memlia-agent-control/config.json'],8192))
        fields={'version','installation','controlOrigin','listenHost','certificatePath','certificateSha256',
                'encryptedKeyPath','encryptedKeySha256','passphraseFilePath','clientCaPath','clientCaSha256'}
        need(type(cfg) is dict and set(cfg)==fields and cfg['version']=='memlia.agent-control-runtime/v1','agent_control_config')
        install=cfg['installation']
        need(type(install) is dict and set(install)=={'id','fqdn'} and type(install['id']) is str
             and re.fullmatch(r'[A-Za-z0-9_-]{1,128}',install['id']),'agent_control_installation')
        need(normalize_origin(install['fqdn'])==install['fqdn']==normalize_origin(model['services']['web']['environment']['NEXT_PUBLIC_APP_URL'])
             and normalize_origin(cfg['controlOrigin'])==cfg['controlOrigin'] and urlsplit(cfg['controlOrigin']).port==9443
             and cfg['listenHost']=='0.0.0.0','agent_control_origin')
        for field,target in (('certificatePath','/etc/memlia-agent-control/server.pem'),('clientCaPath','/etc/memlia-agent-control/client-ca.pem'),
                             ('encryptedKeyPath','/run/memlia-agent-control/key.pem'),('passphraseFilePath','/run/memlia-agent-control/passphrase')):
            need(cfg[field]==target,'agent_control_path')
        for field in ('certificateSha256','clientCaSha256','encryptedKeySha256'):
            need(type(cfg[field]) is str and re.fullmatch(r'[a-f0-9]{64}',cfg[field]),'agent_control_pin')
        for field,digest_field in (('certificatePath','certificateSha256'),('clientCaPath','clientCaSha256')):
            public=read_file(mounts[cfg[field]],16384)
            need(digest(public)==cfg[digest_field] and public.startswith(b'-----BEGIN CERTIFICATE-----')
                 and b'PRIVATE KEY' not in public,'agent_control_public_certificate')
        secret=mounts['/run/memlia-agent-control'];safe_directory(secret.parent)
        owner=secret.lstat()
        need(secret==secret.resolve() and stat.S_ISDIR(owner.st_mode) and owner.st_uid==1001 and owner.st_gid==1001
             and stat.S_IMODE(owner.st_mode)==0o700,'agent_control_secret_directory')
        need({p.name for p in secret.iterdir()}=={'key.pem','passphrase'},'agent_control_secret_roster')
        for name,minimum,maximum in (('key.pem',64,32768),('passphrase',16,1024)):
            child=(secret/name).lstat()
            need(stat.S_ISREG(child.st_mode) and child.st_dev==owner.st_dev and child.st_uid==1001 and child.st_gid==1001
                 and child.st_nlink==1 and stat.S_IMODE(child.st_mode) in (0o400,0o600)
                 and minimum<=child.st_size<=maximum,'agent_control_secret_metadata')
        # No key/passphrase read or new certificate issuance; TLS rechecks all pins
        # and exact SAN/EKU/key/expiry before listener or DB import in UID1001.

    def containers(self, stopped=False):
        ids = self.docker('container', 'ls', '-aq', '--no-trunc', '--filter', 'label=com.docker.compose.project=' + self.project).decode().split()
        need(len(ids) <= 12 and len(set(ids)) == len(ids), 'container_set')
        rows = []
        for cid in ids:
            need(re.fullmatch('[a-f0-9]{64}', cid), 'container_id')
            row = self.one('container', 'inspect', cid); labels = row['Config']['Labels']; service = labels.get('com.docker.compose.service')
            need(row['Id'] == cid and labels.get('com.docker.compose.project') == self.project
                 and service in self.model['services'] and row['Config']['Image'] == self.model['services'][service]['image'], 'container_owner')
            verify_mounts(row, self.model['services'][service], self.model)
            if service=='agent-control':
                verify_agent_control_container(row,self.model['services'][service],self.model,
                                               self.one('image','inspect',self.model['services'][service]['image']))
            if stopped:
                need(row['State']['Running'] is False and row['State']['Status'] in ('exited', 'created')
                     and not row['State']['OOMKilled'] and row['State'].get('ExitCode') not in (137, 143), 'stop_not_clean')
            rows.append(row)
        return rows

    def volumes(self):
        roots = {}
        all_ids = self.docker('container', 'ls', '-aq', '--no-trunc').decode().split()
        need(len(all_ids) <= 256, 'container_inventory_limit')
        for name in VOLUMES:
            volume_name = self.project + '_' + name
            row = self.one('volume', 'inspect', volume_name); labels = row.get('Labels', {})
            expected = self.docker_root / 'volumes' / volume_name / '_data'
            need(row['Name'] == volume_name and row['Driver'] == 'local' and row['Scope'] == 'local'
                 and row.get('Options') in (None, {}) and labels.get('com.docker.compose.project') == self.project
                 and labels.get('com.docker.compose.volume') == name and row['Mountpoint'] == str(expected), 'volume_owner')
            need(expected == expected.resolve() and expected.is_dir(), 'volume_path')
            roots[name] = expected
        for cid in all_ids:
            need(re.fullmatch('[a-f0-9]{64}', cid), 'container_id')
            row = self.one('container', 'inspect', cid)
            for mount in row['Mounts']:
                if mount.get('Name') in {self.project + '_' + name for name in VOLUMES}:
                    need(row['Config']['Labels'].get('com.docker.compose.project') == self.project
                         and row['State']['Running'] is False, 'volume_in_use')
        return roots

    def stop(self):
        self.containers(); self.journal.intent('stop')
        if 'agent-control' in self.model['services']:
            self.compose_run('stop','--timeout','120','agent-control')
            controllers=[row for row in self.containers() if row['Config']['Labels'].get('com.docker.compose.service')=='agent-control']
            need(len(controllers)<=1 and all(row['State']['Running'] is False and row['State']['Status'] in ('created','exited')
                 and not row['State']['OOMKilled'] and row['State'].get('ExitCode')==0 for row in controllers),'agent_control_stop_unknown')
        self.compose_run('stop', '--timeout', '120', *[n for n in APP if n in self.model['services']])
        self.compose_run('stop', '--timeout', '120', 'migrations', 'db', 'redis')
        rows = self.containers(stopped=True)
        need(rows, 'project_absent')

    def fresh(self):
        for kind in ('container', 'volume', 'network'):
            args = [kind, 'ls', '-q', '--filter', 'label=com.docker.compose.project=' + self.project]
            if kind == 'container': args.insert(2, '-a')
            need(not self.docker(*args).strip(), 'installation_exists')
        for name in VOLUMES:
            need(not self.docker('volume', 'ls', '-q', '--filter', 'name=^' + self.project + '_' + name + '$').strip(), 'volume_collision')

        networks = self.model['networks'].values() if self.model is not None else [{'name': self.project + '_' + name} for name in ('backend', 'egress')]
        for network in networks:
            need(re.fullmatch(r'[a-z0-9_-]+', network['name']) and not network.get('external')
                 and not self.docker('network', 'ls', '-q', '--filter', 'name=^' + network['name'] + '$').strip(), 'network_collision')

    def bootstrap(self, phase):
        private = self.config / 'bootstrap'; raw = read_file(private / 'config.json', 16384, private=True)
        config = decode(raw)
        need(config['stateDirectory'] == '/run/memlia-bootstrap/state', 'bootstrap_state')
        environments = self.model['services']
        for role, service, key in (('migrate', 'migrations', 'DATABASE_URL'), ('web', 'web', 'DATABASE_URL'),
                                   ('realtime', 'realtime', 'DATABASE_URL'), ('worker', 'workflow-worker', 'DATABASE_URL'),
                                   ('transport', 'workflow-worker', 'MEMLIA_PG_BOSS_DATABASE_URL')):
            need(config['urls'][role] == environments[service]['environment'][key], 'bootstrap_profile_mismatch')
        self.journal.intent('bootstrap-' + phase)
        reference = self.model['services']['migrations']['image']
        answer = self.docker('run', '--name', self.project + '-bootstrap-' + phase, '--pull', 'never',
                            '--network', self.model['networks']['backend']['name'], '--user', '0:0', '--read-only',
                            '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--memory', '1g', '--pids-limit', '128',
                            '--mount', 'type=bind,src=' + str(private) + ',dst=/run/memlia,readonly',
                            '--mount', 'type=bind,src=' + str(self.config / 'bootstrap-journal') + ',dst=/run/memlia-bootstrap',
                            reference, 'bun', '--no-env-file', '/app/deploy/memlia/database-bootstrap.ts',
                            '--config', '/run/memlia/config.json', '--phase', phase)
        result = decode(answer)
        need(result.get('version') == 'memlia.database-bootstrap-receipt/v1' and result.get('status') == 'PASS'
             and result.get('phase') == phase and result.get('prepared') is True
             and result.get('deploymentId') == config['deploymentId'] and result.get('database') == config['database']
             and result.get('queueSchema') == 'memlia_jobs' and result.get('runtimeDdl') is False
             and result.get('transportBusinessRead') is False and (phase == 'prepare' or result.get('grantsVerified') is True), 'bootstrap_receipt')
        row = self.one('container', 'inspect', self.project + '-bootstrap-' + phase)
        need(row['State']['Running'] is False and row['State']['ExitCode'] == 0
             and row['Config']['Image'] == reference, 'bootstrap_close')
        self.docker('container', 'rm', row['Id'])

    def install(self):
        release = self.model_read()
        need(release['migrationSource'] == release['source'], 'initial_migration_source')
        self.fresh(); self.journal.intent('install')
        safe_directory(self.config / 'bootstrap-journal', private=True)
        self.compose_run('create', '--no-build', '--pull', 'never')
        self.compose_run('up', '--no-build', '--pull', 'never', '--no-deps', '-d', '--wait', '--wait-timeout', '180', 'db', 'redis')
        self.bootstrap('prepare')
        self.compose_run('up', '--no-build', '--pull', 'never', '--no-deps', '--abort-on-container-exit', '--exit-code-from', 'migrations', 'migrations')
        self.bootstrap('grants'); self.bootstrap('verify')
        # Native health checks, not a promise that every business route is qualified.
        self.compose_run('up', '--no-build', '--pull', 'never', '--no-deps', '-d', '--wait', '--wait-timeout', '180', 'web', 'realtime', 'cron')
        return {'status': 'PASS', 'action': 'install', 'release': release, 'workerStarted': False, 'agentControlStarted': False, 'businessQualified': False}

    def backup(self):
        release = self.model_read(); self.stop(); roots = self.volumes(); roots['config'] = self.config
        self.journal.intent('backup')
        before = {name: tree_entries(path, self.cfg['maxBackupBytes']) for name, path in roots.items()}
        total = sum(row[1][6] for rows in before.values() for row in rows if stat.S_ISREG(row[1][2]))
        need(total <= self.cfg['maxBackupBytes'] and shutil.disk_usage(self.journal.work).free >= MIN_FREE + total * 2, 'backup_space')
        plain = self.journal.work / 'archive.private.tar'; write_new(plain, b'')
        manifest = {'version': CONFIG_VERSION, 'project': self.project, 'release': release,
                    'configDirectory': str(self.config), 'runtimeRestartAllowed': False}
        operator = self
        class CheckedReader:
            def __init__(self, stream): self.stream = stream; self.checked = 0
            def read(self, size):
                if time.monotonic() - self.checked >= .25:
                    operator.checkpoint(); self.checked = time.monotonic()
                return self.stream.read(size)
        with tarfile.open(plain, 'w', format=tarfile.PAX_FORMAT) as archive:
            raw = json_bytes(manifest); entry = tarfile.TarInfo('manifest.json'); entry.mode = 0o600; entry.size = len(raw)
            archive.addfile(entry, io.BytesIO(raw))
            for name, root in roots.items():
                for relative, frozen in before[name]:
                    self.checkpoint()
                    path = root / relative; need(identity(path.lstat()) == frozen, 'backup_source_changed')
                    info = archive.gettarinfo(str(path), arcname=name + '/' + relative)
                    if info.isfile():
                        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
                        with os.fdopen(fd, 'rb') as stream:
                            need(identity(os.fstat(stream.fileno())) == frozen, 'backup_source_changed')
                            archive.addfile(info, CheckedReader(stream))
                    else: archive.addfile(info)
        need(plain.stat().st_size <= self.cfg['maxBackupBytes'] + 64*1024**2, 'archive_limit')
        for name, root in roots.items(): need(tree_entries(root, self.cfg['maxBackupBytes']) == before[name], 'backup_source_changed')
        self.containers(stopped=True); self.volumes()
        recipient = self.journal.work / 'recipient.pem'; write_new(recipient, self.recipient)
        encrypted = self.backups / (self.journal.work.name + '.cms'); write_new(encrypted, b'')
        self.cmd.run('openssl', encryption_args(plain, encrypted, recipient), timeout=1800, output=encrypted)
        with encrypted.open('rb') as stream: archive_hash = hashlib.file_digest(stream, 'sha256').hexdigest(); os.fsync(stream.fileno())
        need(encrypted.stat().st_size > 0, 'backup_empty')
        plain.unlink(); recipient.unlink(); sync_dir(self.journal.work); sync_dir(self.backups)
        return {'status': 'PASS', 'action': 'backup', 'archive': encrypted.name, 'sha256': archive_hash,
                'bytes': encrypted.stat().st_size, 'release': release, 'project': self.project, 'servicesStopped': True, 'reconciled': False}

    def restore(self, archive, expected_hash, key, passphrase):
        empty_target(self.config)
        self.fresh()
        need(re.fullmatch('[a-f0-9]{64}', expected_hash), 'archive_pin')
        need(self.config not in Path(key).parents and self.config not in Path(passphrase).parents, 'restore_key_separate')
        raw_key = read_file(key, 65536, private=True)
        need(b'BEGIN ENCRYPTED PRIVATE KEY' in raw_key, 'encrypted_private_key_required')
        password = read_file(passphrase, 1024, private=True)
        need(16 <= len(password.rstrip(b'\n')) <= 1024 and b'\x00' not in password and b'\r' not in password
             and b'\n' not in password.rstrip(b'\n'), 'passphrase_shape')
        archive = Path(archive); safe_directory(archive.parent, private=True)
        need(not archive.is_symlink(), 'archive_link')
        with archive.open('rb') as stream:
            st = os.fstat(stream.fileno()); need(stat.S_ISREG(st.st_mode) and st.st_uid == 0 and st.st_nlink == 1
                                                and not st.st_mode & 0o077 and st.st_size <= self.cfg['maxBackupBytes'] + 64*1024**2, 'archive_metadata')
            need(hashlib.file_digest(stream, 'sha256').hexdigest() == expected_hash, 'archive_changed')
        self.journal.intent('decrypt')
        plain = self.journal.work / 'restore.private.tar'; write_new(plain, b'')
        # Passphrase path, never its value, appears in argv; both files are root-only.
        self.cmd.run('openssl', decryption_args(archive, plain, key, passphrase), timeout=1800, output=plain)
        entries = inspect_archive(plain, self.cfg['maxBackupBytes'])
        with tarfile.open(plain, 'r:') as source:
            manifest_entry = source.getmember('manifest.json'); need(manifest_entry.size <= 16384, 'manifest_limit')
            manifest = decode(source.extractfile(manifest_entry).read())
            need(manifest['version'] == CONFIG_VERSION and manifest['project'] == self.project
                 and manifest['configDirectory'] == str(self.config) and manifest['runtimeRestartAllowed'] is False
                 and manifest['release']['source'] == self.cfg['source']
                 and manifest['release']['migrationSource'] == self.cfg['migrationSource'] and manifest['release']['lockSha256'] == self.cfg['lockSha256'], 'restore_provenance')
            self.journal.intent('restore-config')
            self.extract(source, entries, {'config': self.config})
        release = self.model_read(); need(release == manifest['release'], 'restore_images_changed'); self.fresh()
        self.journal.intent('restore-volumes'); self.compose_run('create', '--no-build', '--pull', 'never')
        roots = self.volumes()
        for path in roots.values(): empty_target(path)
        with tarfile.open(plain, 'r:') as source: self.extract(source, entries, roots)
        self.containers(stopped=True); self.volumes(); plain.unlink(); sync_dir(self.journal.work)
        return {'status': 'HOLD', 'action': 'restore', 'restored': True, 'servicesStopped': True,
                'release': release, 'reason': 'external_effects_and_queue_reconciliation_required'}

    def extract(self, source, entries, roots):
        for entry in entries:
            if self is not None: self.checkpoint()
            parts = PurePosixPath(entry.name).parts
            if parts[0] not in roots: continue
            need(len(parts) > 1, 'archive_root_member')
            path = roots[parts[0]].joinpath(*parts[1:]); parent = path.parent
            parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            need(parent == parent.resolve(), 'restore_path_link')
            if entry.isdir(): path.mkdir(exist_ok=True, mode=0o700)
            else:
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                with os.fdopen(fd, 'wb') as target, source.extractfile(entry) as content:
                    copied = hashlib.sha256()
                    while block := content.read(1024**2):
                        if self is not None: self.checkpoint()
                        copied.update(block); target.write(block)
                    target.flush(); os.fsync(target.fileno())
                    need(target.tell() == entry.size, 'restore_size')
                fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
                with os.fdopen(fd, 'rb') as restored:
                    need(hashlib.file_digest(restored, 'sha256').digest() == copied.digest(), 'restore_readback')
            os.chown(path, entry.uid, entry.gid, follow_symlinks=False)
            os.chmod(path, entry.mode & 0o777, follow_symlinks=False)
        for root in roots.values(): sync_dir(root)

    def stage_release(self, previous_receipt, rollback=False):
        old = decode(read_file(previous_receipt, 16384, private=True))
        need(Path(previous_receipt).parent.parent == self.journal.state and Path(previous_receipt).name == 'result.json'
             and old['status'] == 'PASS' and old['action'] == 'backup' and old['servicesStopped'] is True
             and old['project'] == self.project, 'backup_required')
        archive = self.backups / old['archive']
        need(archive.parent == self.backups and not archive.is_symlink(), 'backup_path')
        with archive.open('rb') as stream:
            need(hashlib.file_digest(stream, 'sha256').hexdigest() == old['sha256'], 'backup_changed')
        release = self.model_read(); compatible_release(old['release'], release)
        # No automatic down-migration, queue reset or restart following a version change.
        # Explicit operator-pinned backup is the N/N-1 identity; no tag-based selection.
        need(old['release']['source'] != release['source'], 'release_unchanged')
        self.journal.intent('rollback' if rollback else 'update')
        # Existing containers must already be stopped; they intentionally have the old image refs.
        ids = self.docker('container', 'ls', '-aq', '--no-trunc', '--filter', 'label=com.docker.compose.project=' + self.project).decode().split()
        need(0 < len(ids) <= 12, 'release_requires_existing_project')
        for cid in ids:
            need(re.fullmatch('[a-f0-9]{64}', cid), 'container_id')
            row = self.one('container', 'inspect', cid); labels = row['Config']['Labels']
            service = labels.get('com.docker.compose.service')
            need(row['State']['Running'] is False and row['State']['Status'] in ('created', 'exited')
                 and row['State']['ExitCode'] not in (137, 143) and not row['State']['OOMKilled']
                 and labels.get('com.docker.compose.project') == self.project
                 and row['Config']['Image'] == old['release']['images'].get(service), 'release_previous_identity')
            verify_mounts(row, self.model['services'][service], self.model)
        self.volumes()
        self.compose_run('create', '--no-build', '--pull', 'never', '--force-recreate')
        self.containers(stopped=True)
        return {'status': 'HOLD', 'action': 'rollback' if rollback else 'update', 'staged': True,
                'servicesStopped': True, 'release': release, 'previousRelease': old['release'],
                'reason': 'compatibility_and_effect_reconciliation_required'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    parser.add_argument('action', choices=('install', 'backup', 'restore', 'update', 'rollback'))
    parser.add_argument('--archive'); parser.add_argument('--archive-sha256')
    parser.add_argument('--key'); parser.add_argument('--passphrase-file'); parser.add_argument('--previous-receipt')
    args = parser.parse_args(); os.umask(0o077)
    need(sys.version_info >= (3, 11), 'python_311_required')
    need(sys.platform == 'linux' and os.geteuid() == 0, 'linux_root_required')
    cfg = configuration(read_file(args.config, 8192, private=True))
    state = safe_directory(cfg['stateDirectory'], private=True)
    need(shutil.disk_usage(state).free >= MIN_FREE, 'disk_reserve')
    with Journal(state, args.action) as journal:
        try:
            operator = Operator(cfg, journal)
            if args.action == 'install': result = operator.install()
            elif args.action == 'backup': result = operator.backup()
            elif args.action == 'restore': result = operator.restore(args.archive, args.archive_sha256, args.key, args.passphrase_file)
            else: result = operator.stage_release(args.previous_receipt, args.action == 'rollback')
            journal.finish(result)
            print(json.dumps({'status': result['status'], 'action': args.action,
                              'journal': journal.work.name, 'servicesStopped': result.get('servicesStopped', False)}))
            return 0 if result['status'] == 'PASS' else 2
        except BaseException as error:
            # Keep native bounded diagnostics private; no command replay or automatic resource deletion.
            write_new(journal.work / 'error.private.log', repr(error).encode('utf-8', 'replace')[:8192])
            journal.finish({'status': 'HOLD', 'action': args.action, 'reason': 'operation_unknown', 'resourcesRetained': True})
            raise


if __name__ == '__main__':
    try: raise SystemExit(main())
    except (Exception, KeyboardInterrupt):
        print('Memlia operation refused; inspect the private journal.', file=sys.stderr)
        raise SystemExit(1) from None
