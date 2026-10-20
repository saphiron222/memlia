#!/usr/bin/env python3
# Copyright 2026 Memlia. All rights reserved.
"""Owned loopback HTTP smoke; receipts never contain bodies, URLs, logs or secrets."""
import http.client
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit

LIMIT = 1024 * 1024

class Refused(Exception):
    pass


def read_json(path):
    with path.open('rb') as stream:
        data = stream.read(LIMIT + 1)
    if len(data) > LIMIT:
        raise Refused('artifact_invalid')
    return json.loads(data)


def verify_artifacts(app, profile):
    root = app / '.next'
    # Preserve the original file/config checks; their success alone is insufficient.
    if not (root/'BUILD_ID').read_text().strip():
        raise Refused('artifact_invalid')
    for name in ('standalone/apps/sim/server.js', 'routes-manifest.json',
                 'prerender-manifest.json', 'required-server-files.json'):
        if not (root/name).is_file():
            raise Refused('artifact_invalid')
    if not (root/'static').is_dir():
        raise Refused('artifact_invalid')
    config = read_json(root/'required-server-files.json')['config']
    if config['output'] != 'standalone':
        raise Refused('artifact_invalid')
    if profile and (config['productionBrowserSourceMaps'] is not False
                    or config['experimental']['serverSourceMaps'] is not False
                    or config['enablePrerenderSourceMaps'] is not False
                    or config['experimental']['cpus'] != 2):
        raise Refused('artifact_invalid')


def copy_owned_tree(source, target):
    if source.is_symlink() or target.is_symlink():
        raise Refused('staging_refused')
    source = source.resolve(strict=True)
    if target.exists():
        for directory, dirs, files in os.walk(target, followlinks=False):
            if any((Path(directory)/name).is_symlink() for name in dirs + files):
                raise Refused('staging_refused')
    for directory, dirs, files in os.walk(source, followlinks=False):
        for name in dirs + files:
            path = Path(directory)/name
            kind = path.lstat().st_mode
            if not (stat.S_ISREG(kind) or stat.S_ISDIR(kind) or stat.S_ISLNK(kind)):
                raise Refused('staging_refused')
            if path.is_symlink():
                if os.path.isabs(os.readlink(path)):
                    raise Refused('staging_refused')
                try:
                    path.resolve(strict=True).relative_to(source)
                except (ValueError, OSError, RuntimeError):
                    raise Refused('staging_refused') from None
    shutil.copytree(source, target, dirs_exist_ok=True, symlinks=True)


def stage_artifacts(app, stage):
    # Validate all ancestors before copying any source/overlay. The stage is
    # newly owned; an artifact may not redirect a later public/static overlay.
    def path_without_links(root, relative):
        cursor = root
        if cursor.is_symlink():
            raise Refused('staging_refused')
        for part in Path(relative).parts:
            cursor = cursor/part
            if cursor.is_symlink():
                raise Refused('staging_refused')
    for relative in ('.next/standalone', 'public', '.next/static'):
        path_without_links(app, relative)
    copy_owned_tree(app/'.next/standalone', stage)
    for relative in ('apps/sim/public', 'apps/sim/.next/static'):
        path_without_links(stage, relative)
    copy_owned_tree(app/'public', stage/'apps/sim/public')
    copy_owned_tree(app/'.next/static', stage/'apps/sim/.next/static')


def owned_listener(pid, port):
    """Only this unreaped child may own the IPv4 loopback LISTEN inode."""
    sockets = set()
    try:
        for fd in Path(f'/proc/{pid}/fd').iterdir():
            try:
                match = re.fullmatch(r'socket:\[(\d+)\]', os.readlink(fd))
                if match:
                    sockets.add(match[1])
            except FileNotFoundError:
                continue
        with Path('/proc/net/tcp').open() as stream:
            rows = stream.read(1048577)
        if len(rows) > 1048576:
            raise Refused('listener_unavailable')
        for row in rows.splitlines()[1:]:
            fields = row.split()
            if len(fields) >= 10 and fields[1] == f'0100007F:{port:04X}' and fields[3] == '0A':
                return fields[9] in sockets
        return False
    except FileNotFoundError:
        return False


def get(child, port, path, deadline, receipt):
    receipt['httpStatus'] = None
    if child.poll() is not None:
        raise Refused('server_exited')
    if not owned_listener(child.pid, port):
        raise Refused('listener_unavailable')
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise Refused('timeout')
    client = http.client.HTTPConnection('127.0.0.1', port, timeout=min(5, remaining))
    try:
        client.request('GET', path)
        response = client.getresponse()
        if type(response.status) is int and 100 <= response.status <= 599:
            receipt['httpStatus'] = response.status
        if response.status != 200:  # No redirect is ever followed.
            raise Refused('http_refused')
        data = bytearray()
        while len(data) <= LIMIT:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise Refused('timeout')
            if client.sock:
                client.sock.settimeout(min(5, remaining))
            chunk = response.read1(min(65536, LIMIT + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
        if len(data) > LIMIT:
            raise Refused('http_refused')
        return response.getheader('Content-Type', '').split(';', 1)[0].strip(), bytes(data)
    finally:
        client.close()


def probe(child, port, deadline, receipt):
    receipt['requestStage'] = 'health'
    kind, body = get(child, port, '/api/health', deadline, receipt)
    if kind != 'application/json' or json.loads(body).get('status') != 'ok':
        raise Refused('health_refused')
    receipt['requestStage'] = 'login'
    kind, body = get(child, port, '/login', deadline, receipt)
    if kind != 'text/html' or b'<html' not in body.lower():
        raise Refused('login_refused')
    candidates = re.findall(rb'["\'](/_next/static/[A-Za-z0-9_./-]+)["\']', body)
    assets = list(dict.fromkeys(path for path in candidates if path.endswith((b'.js', b'.css'))))[:2]
    if len(assets) != 2 or any(b'..' in asset.split(b'/') for asset in assets):
        raise Refused('assets_missing')
    for index, asset in enumerate(assets, 1):
        receipt['requestStage'] = 'asset_1' if index == 1 else 'asset_2'
        kind, content = get(child, port, asset.decode('ascii'), deadline, receipt)
        if not content or kind not in ('text/css', 'text/javascript', 'application/javascript'):
            raise Refused('asset_refused')
    if child.poll() is not None:
        raise Refused('server_exited')


def smoke(argv, cwd, env, port, timeout=75):
    started = time.monotonic()
    deadline = started + timeout - 8
    receipt = {'status': 'failed', 'reason': None, 'health': False, 'loginHtml': False,
               'assets': 0, 'cleanup': False, 'forcedStop': False, 'databaseQualified': False,
               'authenticationQualified': False, 'requestStage': None, 'httpStatus': None}
    child = None
    with tempfile.TemporaryFile() as private_log:
        try:
            child = subprocess.Popen(argv, cwd=cwd, env=env, stdout=private_log, stderr=subprocess.STDOUT)
            while child.poll() is None and not owned_listener(child.pid, port):
                if time.monotonic() >= deadline:
                    raise Refused('timeout')
                if os.fstat(private_log.fileno()).st_size > 8 * LIMIT:
                    raise Refused('private_log_limit')
                time.sleep(.05)
            probe(child, port, deadline, receipt)
            if os.fstat(private_log.fileno()).st_size > 8 * LIMIT:
                raise Refused('private_log_limit')
            receipt.update(health=True, loginHtml=True, assets=2, status='passed')
        except Refused as error:
            receipt['reason'] = error.args[0]
        except KeyboardInterrupt:
            receipt['reason'] = 'interrupted'
        except Exception:
            receipt['reason'] = 'smoke_unavailable'
        finally:
            # Cancellation during cleanup remains a failure, while cleanup may
            # finish signalling/waiting only for this owned unreaped child.
            cleanup_handlers = {}
            def cleanup_interrupted(_signum, _frame):
                receipt.update(status='failed', reason='interrupted')
            for signum in (signal.SIGINT, signal.SIGTERM):
                cleanup_handlers[signum] = signal.signal(signum, cleanup_interrupted)
            try:
                if child is not None:
                    if child.poll() is None:
                        child.terminate()
                        try:
                            child.wait(timeout=3)
                        except subprocess.TimeoutExpired:
                            receipt['forcedStop'] = True
                            child.kill()
                            child.wait(timeout=3)
                    elif receipt['status'] == 'passed':
                        receipt.update(status='failed', reason='server_exited')
                    if child.returncode not in (0, -signal.SIGTERM, -signal.SIGKILL):
                        receipt.update(status='failed', reason=receipt['reason'] or 'server_exited')
                receipt['cleanup'] = True
            except Exception:
                receipt.update(status='failed', reason='cleanup_failed')
            finally:
                for signum, handler in cleanup_handlers.items():
                    signal.signal(signum, handler)
    receipt['seconds'] = round(time.monotonic() - started, 3)
    return receipt


def runtime_env(source, port):
    required = ('DATABASE_URL', 'BETTER_AUTH_SECRET', 'ENCRYPTION_KEY', 'INTERNAL_API_SECRET',
                'BETTER_AUTH_URL', 'NEXT_PUBLIC_APP_URL', 'NEXT_PUBLIC_SOCKET_URL', 'HOME', 'TMPDIR')
    if any(not source.get(key) for key in required):
        raise Refused('environment_invalid')
    database = urlsplit(source['DATABASE_URL'])
    if (database.scheme != 'postgresql' or database.hostname != 'database' or database.port != 5432
            or database.path != '/memlia_build' or database.username != 'memlia_build'
            or source['HOME'] != '/scratch' or source['TMPDIR'] != '/scratch/tmp'):
        raise Refused('environment_invalid')
    env = {key: source[key] for key in required}
    env.update(PATH='/usr/local/bin:/usr/bin:/bin', NODE_ENV='production', HOSTNAME='127.0.0.1',
               PORT=str(port), NEXT_TELEMETRY_DISABLED='1', DO_NOT_TRACK='1', DOCKER_BUILD='true',
               MEMLIA_LOCAL_BUILD='1', NODE_OPTIONS='--max-old-space-size=10240')
    return env


def main():
    # These three paths are supplied by the owned Docker phase, never by HTTP.
    app, scratch, report = map(Path, sys.argv[1:])
    os.umask(0o077)
    result = {'status': 'failed', 'reason': 'artifact_invalid', 'cleanup': True,
              'requestStage': None, 'httpStatus': None}
    stage = None
    previous = {}
    def interrupted(_signum, _frame):
        raise KeyboardInterrupt()
    try:
        for signum in (signal.SIGTERM, signal.SIGINT):
            previous[signum] = signal.signal(signum, interrupted)
        verify_artifacts(app, bool(os.environ.get('MEMLIA_SWAP_VARIANT')))
        stage = Path(tempfile.mkdtemp(prefix='standalone-http-', dir=scratch))
        stage_artifacts(app, stage)
        with socket.socket() as reservation:
            reservation.bind(('127.0.0.1', 0))
            port = reservation.getsockname()[1]
        result = smoke(['/usr/local/bin/node', 'apps/sim/server.js'], stage, runtime_env(os.environ, port), port)
    except Refused as error:
        result.update(status='failed', reason=error.args[0])
    except KeyboardInterrupt:
        result.update(status='failed', reason='interrupted')
    except Exception:
        result.update(status='failed', reason='smoke_unavailable')
    finally:
        def cleanup_interrupted(_signum, _frame):
            result.update(status='failed', reason='interrupted')
        for signum in previous:
            signal.signal(signum, cleanup_interrupted)
        try:
            if stage is not None:
                shutil.rmtree(stage)
        except Exception:
            result.update(status='failed', reason='cleanup_failed', cleanup=False)
        for signum, handler in previous.items():
            signal.signal(signum, handler)
        with report.open('x') as output:
            json.dump(result, output, sort_keys=True)
            output.write('\n')
    return 0 if result['status'] == 'passed' and result['cleanup'] else 1

if __name__ == '__main__':
    raise SystemExit(main())
