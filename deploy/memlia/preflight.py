# Copyright (c) 2026 Memlia. All rights reserved.
"""Read-only checks of resolved Compose JSON on stdin; never start services.

Input includes credentials: pipe directly from Compose, never save or print it.
Success validates these configuration checks only, not a release or environment.
"""
import ipaddress
import json
import re
import sys
from urllib.parse import unquote, urlsplit

_BASE = frozenset(('web', 'realtime', 'migrations', 'cron', 'db', 'redis'))
_APPS = ('web', 'realtime', 'migrations', 'cron')
_IMAGE = re.compile(r'[a-z0-9][a-z0-9._:/-]*@sha256:[0-9a-f]{64}\Z')
_MAX_INPUT = 1024 * 1024


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


def validate(model):
    """Return fixed codes only; never include values, URLs or exception messages."""
    if type(model) is not dict or type(model.get('services')) is not dict:
        return ['invalid_compose_model']
    services = model['services']
    if not _BASE.issubset(services) or not set(services).issubset(_BASE | {'workflow-worker'}):
        return ['invalid_compose_model']
    if any(type(row) is not dict or type(row.get('environment', {})) is not dict
           for row in services.values()):
        return ['invalid_compose_model']
    errors = set()
    apps = _APPS + (('workflow-worker',) if 'workflow-worker' in services else ())
    prefixes = set()
    for name, row in services.items():
        image = row.get('image')
        if type(image) is not str or not _IMAGE.fullmatch(image):
            errors.add('invalid_image_reference')
        elif name in apps:
            reference = image.split('@', 1)[0]
            prefix, _, leaf = reference.rpartition('/')
            if not prefix or leaf != name:
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
