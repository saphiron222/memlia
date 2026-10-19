"""Opt-in real infrastructure smoke; unique project, synthetic data, own cleanup only.

Run: python3 deploy/memlia/tests/smoke_infrastructure.py --evidence /private/result.json
No application image is started. This does not qualify Sim's Redis consumers.
"""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import uuid

from test_compose import COMPOSE, DOCKER, fixture_environment, resolve


def check_cron_mount(compose, env, run):
    """Real Compose mount/expansion check, using a shell image, not the scheduler."""
    resolved = resolve(fixture_environment())
    if resolved.returncode:
        raise AssertionError('Cannot resolve the cache image for the mount probe')
    image = json.loads(resolved.stdout)['services']['redis']['image']
    with tempfile.TemporaryDirectory() as directory:
        override = Path(directory) / 'override.json'
        override.write_text(json.dumps({'services': {'cron': {'image': image}}}))
        # Keep the cron service's read-only root, UID, mounts and security options.
        # A shell function records expanded curl arguments; no HTTP calls are made.
        script = r"""set -eu
        test -r /etc/sim/crontab
        curl() { printf '%s\0' "$@"; }
        command=$(awk '/^[^#].*curl / {print substr($0, index($0, "curl ")); exit}' /etc/sim/crontab)
        test -n "$command"
        eval "$command"
        """
        output = run('cron-readonly-config-runtime', compose + ['-f', str(override),
            'run', '--rm', '--no-deps', '-T', '--entrypoint', '/bin/sh', 'cron', '-c', script])
        expected = ['-fsS', '-m', '60', '-o', '/dev/null', '-H',
                    'Authorization: Bearer ' + env['CRON_SECRET'],
                    'http://web:3000/api/schedules/execute', '']
        if output.split('\0') != expected:
            raise AssertionError('Mounted cron command did not preserve runtime secret/URL expansion')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence', type=Path, required=True)
    args = parser.parse_args()
    project = 'memlia-p03-smoke-' + uuid.uuid4().hex[:12]
    records = []
    started = time.monotonic()
    env = {k: v for k, v in os.environ.items() if k in ['PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONFIG']}
    env.update(fixture_environment())
    env['CRON_SECRET'] = 'synthetic-only-$literal-$(false)-"quoted"-single\'quote'
    report = {'project': project, 'startedUtc': datetime.now(timezone.utc).isoformat(),
              'scope': 'PostgreSQL/pgvector and Valkey only; no application qualification', 'records': records}

    def run(label, command, expected=None, timeout=90):
        tick = time.monotonic()
        result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=timeout)
        records.append({'operation': label, 'exitCode': result.returncode,
                        'seconds': round(time.monotonic() - tick, 3),
                        'stdout': result.stdout, 'stderr': result.stderr})
        if result.returncode != 0:
            raise AssertionError(f'{label} failed (exit {result.returncode})')
        if expected is not None and expected not in result.stdout:
            raise AssertionError(f'{label}: expected output absent')
        return result.stdout

    errors = []
    completed_normally = False
    with tempfile.NamedTemporaryFile() as empty_env:
        compose = DOCKER + ['compose', '--env-file', empty_env.name, '-p', project, '-f', str(COMPOSE)]
        try:
            run('engine-version', DOCKER + ['version', '--format', '{{json .Server}}'])
            run('compose-version', DOCKER + ['compose', 'version'])
            run('start-infrastructure', compose + ['up', '-d', '--wait', '--wait-timeout', '60', 'db', 'redis'])
            ids = run('owned-container-ids', compose + ['ps', '-q', 'db', 'redis']).split()
            for container_id in ids:
                bindings = run('host-port-bindings', DOCKER + ['inspect', '--format', '{{json .HostConfig.PortBindings}}', container_id])
                if json.loads(bindings):
                    raise AssertionError('Infrastructure port published on host')
            run('database-write-vector', compose + ['exec', '-T', 'db', 'psql', '-U', 'postgres', '-d', 'memlia', '-v', 'ON_ERROR_STOP=1', '-Atc',
                "CREATE EXTENSION vector; CREATE TABLE p03_smoke (value text NOT NULL); INSERT INTO p03_smoke VALUES ('retained'); SELECT '[1,2,3]'::vector <-> '[1,2,4]'::vector; SELECT version();"], '1\n')
            cli = compose + ['exec', '-T', 'redis', 'valkey-cli', '--raw']
            run('cache-version', cli + ['INFO', 'server'], 'valkey_version:8.1.10')
            run('cache-write', cli + ['SET', 'p03:persist', 'retained'], 'OK')
            run('cache-lua', cli + ['EVAL', "return redis.call('INCR', KEYS[1])", '1', 'p03:counter'], '1\n')
            run('cache-ttl-write', cli + ['SET', 'p03:ttl', 'expires', 'PX', '100'], 'OK')
            time.sleep(0.2)
            if run('cache-ttl-expired', cli + ['EXISTS', 'p03:ttl']).strip() != '0':
                raise AssertionError('TTL did not expire')
            # A second container reaches Valkey by service DNS over the private network.
            # This catches protected-mode or network errors hidden by a localhost PING.
            run('cache-private-network', compose + ['exec', '-T', 'db', 'bash', '-c',
                "exec 3<>/dev/tcp/redis/6379; printf '*1\\r\\n$4\\r\\nPING\\r\\n' >&3; head -c 7 <&3"], '+PONG')
            check_cron_mount(compose, env, run)
            run('recreate-infrastructure', compose + ['up', '-d', '--force-recreate', '--wait', '--wait-timeout', '60', 'db', 'redis'])
            run('database-retained', compose + ['exec', '-T', 'db', 'psql', '-U', 'postgres', '-d', 'memlia', '-Atc', 'SELECT value FROM p03_smoke'], 'retained')
            run('cache-retained', cli + ['GET', 'p03:persist'], 'retained')
            completed_normally = True
        except BaseException as error:
            report['failure'] = f'{type(error).__name__}: {error}'
            errors.append(error)
        finally:
            cleanup_errors = []
            try:
                run('cleanup-owned-project', compose + ['down', '--volumes', '--remove-orphans', '--timeout', '30'])
            except BaseException as error:
                cleanup_errors.append(error)
            # Check all resource classes even if down or an earlier check failed.
            for kind, arguments in [('containers', ['ps', '-aq']),
                                    ('volumes', ['volume', 'ls', '-q']),
                                    ('networks', ['network', 'ls', '-q'])]:
                try:
                    remaining = run('check-owned-' + kind + '-removed', DOCKER + arguments +
                        ['--filter', f'label=com.docker.compose.project={project}'])
                    if remaining.strip():
                        raise AssertionError(f'Owned {kind} remain after cleanup')
                except BaseException as error:
                    cleanup_errors.append(error)
            if cleanup_errors:
                report['cleanupFailure'] = '; '.join(f'{type(error).__name__}: {error}' for error in cleanup_errors)
                errors.extend(cleanup_errors)
            report['result'] = 'passed' if completed_normally and not errors else 'failed'
            report['seconds'] = round(time.monotonic() - started, 3)
            args.evidence.parent.mkdir(parents=True, exist_ok=True)
            args.evidence.write_text(json.dumps(report, indent=2) + '\n')
    # Defer interrupts only to save the failed receipt and attempt owned cleanup.
    # Propagate the original object (including SystemExit's exit code).
    for error in errors:
        if not isinstance(error, Exception):
            raise error
    if errors:
        raise RuntimeError('; '.join(str(error) for error in errors)) from errors[0]
    print(f'{project}: passed, own resources removed, {report["seconds"]} seconds')


if __name__ == '__main__':
    main()
