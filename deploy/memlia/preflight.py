# Copyright (c) 2026 Memlia. All rights reserved.
"""Read-only checks of resolved Compose JSON on stdin; never start services.

Input includes credentials: pipe directly from Compose, never save or print it.
Success validates these configuration checks only, not a release or environment.
"""
import ipaddress
import json
import posixpath
import re
import sys
from urllib.parse import unquote, urlsplit

_BASE = frozenset(('web', 'realtime', 'migrations', 'cron', 'db', 'redis'))
_APPS = ('web', 'realtime', 'migrations', 'cron')
_CONTROL_TARGETS = frozenset(('/etc/memlia-agent-control/config.json', '/etc/memlia-agent-control/server.pem',
                              '/etc/memlia-agent-control/client-ca.pem', '/run/memlia-agent-control'))
_IMAGE = re.compile(r'[a-z0-9][a-z0-9._:/-]*@sha256:[0-9a-f]{64}\Z')
_MAX_INPUT = 1024 * 1024


def repo_digest(image):
    """RepoDigests entry Docker 29 records for a pulled `repository[:tag]@digest`, or None.

    Docker drops the tag; repository and digest stay exact. Shared with
    operations.py and runtimes/excel/linux/application_qualification.py.
    """
    if type(image) is not str or not _IMAGE.fullmatch(image):
        return None
    name, digest = image.split('@')
    parent, _, leaf = name.rpartition('/')
    repository = leaf.partition(':')[0]
    return parent + '/' + repository + '@' + digest if parent and repository else None


def _https_origin(value):
    if (type(value) is not str or not 1 <= len(value) <= 2048
            or any(ord(c) <= 32 or ord(c) >= 127 for c in value)
            or any(c in value for c in ('\\', '%', '?', '#'))):
        raise ValueError()
    parsed = urlsplit(value)
    host, port = parsed.hostname, parsed.port
    if (parsed.scheme != 'https' or not host or parsed.username is not None
            or parsed.password is not None or parsed.path not in ('', '/')
            or parsed.netloc.endswith(':') or port is not None and not 1 <= port <= 65535):
        raise ValueError()
    if ':' in host:
        host = '[' + ipaddress.IPv6Address(host).compressed + ']'
    elif (len(host) > 253 or not all(re.fullmatch(
            r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', part) for part in host.split('.'))):
        raise ValueError()
    if parsed.netloc != host + (f':{port}' if port is not None else ''):
        raise ValueError()
    return 'https://' + host + (f':{port}' if port not in (None, 443) else '')


def _database(value):
    if (type(value) is not str or not 1 <= len(value) <= 16384
            or any(ord(c) <= 32 or ord(c) == 127 for c in value)
            or any(c in value for c in ('\\', '#', '?'))
            or re.search(r'%(?![0-9a-fA-F]{2})', value)):
        raise ValueError()
    parsed = urlsplit(value)
    if (parsed.scheme not in ('postgres', 'postgresql') or not parsed.hostname
            or not parsed.username or not parsed.password
            or parsed.path in ('', '/') or parsed.port is not None and not 1 <= parsed.port <= 65535):
        raise ValueError()
    role = unquote(parsed.username, errors='strict')
    name = unquote(parsed.path[1:], errors='strict')
    if any(ord(c) < 32 or ord(c) == 127 for c in role + name) or '/' in name:
        raise ValueError()
    return role, (parsed.hostname, parsed.port or 5432, name)


def _agent_control(services,networks):
    if 'agent-control' not in services:return set()
    row=services['agent-control'];env=row.get('environment',{});errors=set()
    if env.get('DATABASE_URL')!=services['web'].get('environment',{}).get('DATABASE_URL'):
        errors.add('agent_control_database_mismatch')
    if 'workflow-worker' in services and row.get('image')!=services['workflow-worker'].get('image'):
        errors.add('agent_control_image_mismatch')
    expected={'NODE_ENV':'production','SIM_DB_ROLE':'web','DB_APP_NAME':'memlia-agent-control',
              'MEMLIA_AGENT_CONTROL_CONFIG':'/etc/memlia-agent-control/config.json',
              'DO_NOT_TRACK':'1','SIM_TELEMETRY_DISABLED':'1'}
    if set(env)!=set(expected)|{'DATABASE_URL'} or any(env.get(k)!=v for k,v in expected.items()):
        errors.add('agent_control_environment_refused')
    def memory(value):return type(value) is int and value==1073741824 or type(value) is str and value in ('1g','1073741824')
    network=row.get('networks');cpu=row.get('cpus');health=row.get('healthcheck');deps=row.get('depends_on')
    network_ok=type(network) is dict and set(network)=={'backend'} and type(networks) is dict and type(networks.get('backend')) is dict and networks['backend'].get('internal') is True
    cpu_ok=type(cpu) in (int,float) and cpu==1 or type(cpu) is str and cpu=='1.0'
    health_ok=type(health) is dict and set(health)=={'disable'} and health['disable'] is True
    deps_ok=type(deps) is dict and set(deps)=={'db','migrations'} and all(type(deps[name]) is dict and deps[name].get('condition')==condition and deps[name].get('required',True) is True for name,condition in (('db','service_healthy'),('migrations','service_completed_successfully')))
    extra_authority=any(row.get(k) for k in ('privileged','entrypoint','cap_add','devices','network_mode','pid','ipc','volumes_from','secrets','configs','tmpfs'))
    if (row.get('user')!='1001:1001' or row.get('command')!=['node','dist/memlia-agent-control.mjs']
        or row.get('working_dir')!='/app/apps/sim' or row.get('pull_policy')!='never'
        or row.get('init') is not True or row.get('restart')!='no' or row.get('read_only') is not True
        or row.get('cap_drop')!=['ALL'] or row.get('security_opt')!=['no-new-privileges:true']
        or not network_ok or not health_ok or not deps_ok or extra_authority
        or not memory(row.get('mem_limit')) or not memory(row.get('memswap_limit'))
        or type(row.get('pids_limit')) is not int or row['pids_limit']!=128
        or not cpu_ok or row.get('stop_signal')!='SIGTERM'
        or row.get('stop_grace_period') not in ('160s','2m40s')):
        errors.add('agent_control_profile_refused')
    ports=row.get('ports',[])
    valid=False
    if type(ports) is list and len(ports)==1 and type(ports[0]) is dict:
        binding=ports[0]
        try:
            address=ipaddress.IPv4Address(binding.get('host_ip'))
            valid=(address.is_loopback or any(address in ipaddress.IPv4Network(n) for n in ('10.0.0.0/8','172.16.0.0/12','192.168.0.0/16')))
        except (ValueError,TypeError):pass
        valid=valid and type(binding.get('target')) is int and binding['target']==9443 and binding.get('published') in ('9443',9443) and binding.get('protocol')=='tcp'
    if not valid:errors.add('agent_control_exposure_refused')
    mounts=row.get('volumes',[]);targets=set();sources=set()
    if type(mounts) is not list or len(mounts)!=4:errors.add('agent_control_mount_refused')
    else:
        for mount in mounts:
            if type(mount) is not dict:errors.add('agent_control_mount_refused');continue
            source=mount.get('source');target=mount.get('target');bind=mount.get('bind',{})
            if (type(source) is not str or not posixpath.isabs(source) or posixpath.normpath(source)!=source
                or source=='/' or any(c in source for c in ('\0','\r','\n')) or source in sources
                or type(target) is not str or target not in _CONTROL_TARGETS or target in targets
                or mount.get('type')!='bind' or mount.get('read_only') is not True
                or type(bind) is not dict or bind.get('create_host_path') is not False):
                errors.add('agent_control_mount_refused')
            if type(source) is str:sources.add(source)
            if type(target) is str:targets.add(target)
        if targets!=_CONTROL_TARGETS:errors.add('agent_control_mount_refused')
    return errors


def validate(model):
    """Return fixed codes only; never include values, URLs or exception messages."""
    if type(model) is not dict or type(model.get('services')) is not dict:
        return ['invalid_compose_model']
    services = model['services']
    if not _BASE.issubset(services) or not set(services).issubset(_BASE | {'workflow-worker','agent-control'}):
        return ['invalid_compose_model']
    if any(type(row) is not dict or type(row.get('environment', {})) is not dict
           for row in services.values()):
        return ['invalid_compose_model']
    errors = set()
    apps = _APPS + (('workflow-worker',) if 'workflow-worker' in services else ()) + (('agent-control',) if 'agent-control' in services else ())
    prefixes = set()
    for name, row in services.items():
        image = row.get('image')
        if type(image) is not str or not _IMAGE.fullmatch(image):
            errors.add('invalid_image_reference')
        elif name in apps:
            reference = image.split('@', 1)[0]
            prefix, _, leaf = reference.rpartition('/')
            if not prefix or leaf != ('workflow-worker' if name=='agent-control' else name):
                errors.add('invalid_image_reference')
            prefixes.add(prefix)
    if len(prefixes) > 1:
        errors.add('inconsistent_image_prefix')
    origins = set()
    for name in ('web', 'realtime') + (('workflow-worker',) if 'workflow-worker' in services else ()):
        env = services[name].get('environment', {})
        for key in ('NEXT_PUBLIC_APP_URL', 'BETTER_AUTH_URL'):
            try:
                origins.add(_https_origin(env.get(key)))
            except (ValueError, UnicodeError):
                errors.add('invalid_https_origin')
    if len(origins) > 1:
        errors.add('inconsistent_origin')
    connections = [(services[name].get('environment', {}).get('DATABASE_URL'), True)
                   for name in ('web', 'realtime', 'migrations')]
    if 'workflow-worker' in services:
        worker = services['workflow-worker'].get('environment', {})
        connections += [(worker.get('DATABASE_URL'), True),
                        (worker.get('MEMLIA_PG_BOSS_DATABASE_URL'), False)]
        if worker.get('MEMLIA_PG_BOSS_DATABASE_URL') != services['web'].get('environment', {}).get('MEMLIA_PG_BOSS_DATABASE_URL'):
            errors.add('inconsistent_transport_database')
    roles, targets = set(), set()
    for value, business in connections:
        try:
            role, target = _database(value)
        except (ValueError, UnicodeError):
            errors.add('invalid_database_url')
            continue
        if role == 'postgres':
            errors.add('database_admin_role')
        if role in roles:
            errors.add('shared_database_role')
        roles.add(role)
        if business:
            targets.add(target)
    if len(targets) > 1:
        errors.add('inconsistent_database_target')
    errors.update(_agent_control(services,model.get('networks')))
    return sorted(errors)


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError()
        result[key] = value
    return result


def _non_json(_):
    raise ValueError()


def main():
    errors = ['invalid_compose_model']
    try:
        data = sys.stdin.buffer.read(_MAX_INPUT + 1)
        if len(data) <= _MAX_INPUT:
            model = json.loads(data.decode('utf-8'), object_pairs_hook=_unique_object,
                               parse_constant=_non_json)
            errors = validate(model)
    except (ValueError, UnicodeError, RecursionError, OSError):
        pass
    print(json.dumps({'status': 'refused' if errors else 'configuration_valid', 'errors': errors}))
    return 1 if errors else 0


if __name__ == '__main__':
    sys.exit(main())
