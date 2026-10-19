#!/usr/bin/env python3
# Copyright 2026 Memlia. All rights reserved.
"""Measure one build phase inside its own non-privileged cgroup-v2 container.

Only numeric/status metadata and allowlisted TS locations are persisted. Command output stays in an ephemeral
file, never stdout/artifacts. PID 1 remains alive to read memory.peak after the
child exits. This is not the macOS build guard and never controls other groups.
"""
import argparse
import json
import os
from pathlib import Path
import resource
import re
import signal
import subprocess
import tempfile
import time


def proc_start(record):
    return int(record[record.rindex(')') + 2:].split()[19])


def cgroup_read(root):
    def number(name):
        text = (root / name).read_text().strip()
        return None if text == 'max' else int(text)
    events = dict((key, int(value)) for key, value in (line.split() for line in (root / 'memory.events').read_text().splitlines()))
    return {'currentBytes': number('memory.current'), 'peakBytes': number('memory.peak'),
            'limitBytes': number('memory.max'), 'swapBytes': number('memory.swap.current'),
            'swapLimitBytes': number('memory.swap.max'), 'events': events,
            'cpuMax': [None if value == 'max' else int(value) for value in (root / 'cpu.max').read_text().split()],
            'cpuUsageUsec': dict((key, int(value)) for key, value in (line.split() for line in (root / 'cpu.stat').read_text().splitlines())),
            'pids': [int(value) for value in (root / 'cgroup.procs').read_text().split()]}


def host_memory():
    fields = dict((key, int(value.split()[0]) * 1024) for key, value in (line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines()))
    return {'availableBytes': fields['MemAvailable'], 'swapUsedBytes': fields['SwapTotal'] - fields['SwapFree']}


def successful(code, normal, survivors, events, errors):
    return code == 0 and normal and not survivors and not errors and not any(events.get(key, 0) for key in ('oom', 'oom_kill', 'oom_group_kill'))


def identities(pids):
    found = {}
    for pid in pids:
        if pid == os.getpid() or pid <= 0:
            continue
        try:
            found[pid] = proc_start(Path(f'/proc/{pid}/stat').read_text())
        except FileNotFoundError:
            pass
    return found


def sample_processes(pids):
    rss_sum = high_water = 0
    for pid in pids:
        try:
            fields = dict(line.split(':', 1) for line in Path(f'/proc/{pid}/status').read_text().splitlines() if ':' in line)
            rss_sum += int(fields.get('VmRSS', '0 kB').split()[0]) * 1024
            high_water = max(high_water, int(fields.get('VmHWM', '0 kB').split()[0]) * 1024)
        except FileNotFoundError:
            pass
    return rss_sum, high_water


def terminate_owned(root, child=None):
    errors = []
    for sig, delay in ((signal.SIGTERM, 2), (signal.SIGKILL, 1)):
        for pid, started in identities(cgroup_read(root)['pids']).items():
            try:
                if proc_start(Path(f'/proc/{pid}/stat').read_text()) == started:
                    os.kill(pid, sig)
            except ProcessLookupError:
                pass
            except FileNotFoundError:
                pass
            except Exception as error:
                errors.append(type(error).__name__)
        deadline = time.monotonic() + delay
        while identities(cgroup_read(root)['pids']) and time.monotonic() < deadline:
            # As container PID 1, also reap orphaned grandchildren.
            if child is not None:
                child.poll()
            for orphan in identities(cgroup_read(root)['pids']):
                if child is not None and orphan == child.pid:
                    continue
                try:
                    os.waitpid(orphan, os.WNOHANG)
                except ChildProcessError:
                    pass
            time.sleep(0.05)
    return list(identities(cgroup_read(root)['pids'])), errors


# Only names from the public commit may cross the raw-output boundary.
SOURCE_PATH = re.compile(r'[A-Za-z0-9_@+.()/\[\]-]+\.(?:ts|tsx|mts|cts)\Z')


def safe_source_path(value):
    return (isinstance(value, str) and len(value) <= 512 and value.isascii()
            and SOURCE_PATH.fullmatch(value) is not None
            and all(part not in ('', '.', '..') for part in value.split('/')))


def write_tracked_sources(root, destination):
    result = subprocess.run(['git', '-C', str(root), 'ls-tree', '-rz', '--full-tree', 'HEAD'],
                            capture_output=True, timeout=10)
    if result.returncode or len(result.stdout) > 8 * 1024 * 1024:
        raise ValueError('Tracked source inventory unavailable')
    paths = []
    for record in result.stdout.split(b'\0'):
        if not record:
            continue
        header, raw_path = record.split(b'\t', 1)
        mode, kind, _ = header.split(b' ')
        if mode not in (b'100644', b'100755') or kind != b'blob':
            continue
        try:
            path = raw_path.decode('ascii')
        except UnicodeDecodeError:
            continue
        if safe_source_path(path):
            paths.append(path)
    encoded = json.dumps(sorted(paths))
    if len(paths) > 50000 or len(encoded) > 2 * 1024 * 1024:
        raise ValueError('Tracked source inventory exceeds bound')
    Path(destination).write_text(encoded)


def load_tracked_sources(manifest):
    try:
        with Path(manifest).open('rb') as source:
            raw = source.read(2 * 1024 * 1024 + 1)
        if len(raw) > 2 * 1024 * 1024:
            return []
        paths = json.loads(raw)
        if (not isinstance(paths, list) or len(paths) > 50000
                or not all(safe_source_path(path) for path in paths)
                or len(set(paths)) != len(paths)):
            return []
        return paths
    except (OSError, TypeError, ValueError):
        return []


def typescript_locations(output, paths, relative_cwd):
    # Precalculate exact spellings; never normalize a compiler-provided path.
    allowed = {os.path.relpath(path, relative_cwd or '.'): path for path in paths}
    output.seek(0, os.SEEK_END)
    end = output.tell()
    offset = max(0, end - 65536)
    output.seek(offset)
    data = output.read(65536)
    if offset:
        # The first bytes may begin in the middle of a path or message.
        data = data.partition(b'\n')[2]
    result = {'locations': [], 'truncated': bool(offset)}
    seen = set()
    header = re.compile(rb'^([A-Za-z0-9_@+.()/\[\]-]{1,512})\(([1-9][0-9]{0,6}),([1-9][0-9]{0,6})\): error TS([1-9][0-9]{2,4}):')
    for raw in data.splitlines(keepends=True):
        if not raw.endswith(b'\n') or len(raw) > 4096:
            result['truncated'] = True
            continue
        line = raw[:-1]
        if line.endswith(b'\r'):
            line = line[:-1]
        if any(byte < 32 or 127 <= byte <= 159 for byte in line):
            continue
        match = header.match(line)
        if not match:
            continue
        spelling, row, column, code = match.groups()
        path = allowed.get(spelling.decode('ascii'))
        row, column, code = int(row), int(column), int(code)
        if path is None or row > 1000000 or column > 1000000:
            continue
        key = (path, row, column, code)
        if key in seen:
            continue
        if len(seen) == 100:
            result['truncated'] = True
            break
        seen.add(key)
        result['locations'].append({'path': path, 'line': row, 'column': column, 'code': code})
    return result


def phase_typescript_locations(phase, output, manifest, root, cwd):
    empty = {'locations': [], 'truncated': False}
    if phase != 'typecheck':
        return empty
    try:
        relative_cwd = Path(cwd).resolve().relative_to(Path(root).resolve()).as_posix()
        paths = load_tracked_sources(manifest)
        return typescript_locations(output, paths, relative_cwd) if paths else empty
    except (OSError, TypeError, ValueError):
        return empty


def run(args):
    root, report = Path(args.cgroup), Path(args.report)
    receipt = {'phase': args.phase, 'status': 'failed', 'normalCompletion': False,
               'childExitCode': None, 'samples': 0, 'peakProcessRssBytes': 0,
               'peakSampledGroupRssBytes': 0, 'peakSampledSwapBytes': 0, 'errors': [],
               'peakObservedHostSwapGrowthBytes': 0, 'minObservedHostAvailableBytes': None}
    started = time.monotonic()
    child = None
    interrupted = False
    scope_verified = False
    baseline = None
    def stop(signum, frame):
        nonlocal interrupted
        interrupted = True
    previous = {sig: signal.signal(sig, stop) for sig in (signal.SIGINT, signal.SIGTERM)}
    try:
        baseline = cgroup_read(root)
        if set(baseline['pids']) != {os.getpid()} or baseline['limitBytes'] is None:
            raise RuntimeError('A dedicated finite cgroup is required')
        scope_verified = True
        host_baseline = host_memory()
        with tempfile.TemporaryFile() as output:
            child = subprocess.Popen(args.command, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
            while True:
                reading = cgroup_read(root)
                host = host_memory()
                receipt['minObservedHostAvailableBytes'] = min(receipt['minObservedHostAvailableBytes'] or host['availableBytes'], host['availableBytes'])
                receipt['peakObservedHostSwapGrowthBytes'] = max(receipt['peakObservedHostSwapGrowthBytes'], host['swapUsedBytes'] - host_baseline['swapUsedBytes'])
                rss, high_water = sample_processes(reading['pids'])
                receipt['samples'] += 1
                receipt['peakProcessRssBytes'] = max(receipt['peakProcessRssBytes'], high_water)
                receipt['peakSampledGroupRssBytes'] = max(receipt['peakSampledGroupRssBytes'], rss)
                receipt['peakSampledSwapBytes'] = max(receipt['peakSampledSwapBytes'], reading['swapBytes'])
                if child.poll() is not None:
                    receipt['childExitCode'] = child.returncode
                    receipt['normalCompletion'] = True
                    break
                if interrupted or time.monotonic() - started >= args.timeout:
                    receipt['errors'].append('interrupted' if interrupted else 'timeout')
                    break
                time.sleep(0.25)
            receipt['typeScriptDiagnostics'] = phase_typescript_locations(
                args.phase, output, getattr(args, 'tracked_sources', None),
                getattr(args, 'source_root', '/work'), Path.cwd())
            output.seek(max(0, output.tell() - 65536))
            tail = output.read().lower()
            receipt['v8HeapOOM'] = b'heap out of memory' in tail
            receipt['typeScriptErrorCodes'] = sorted(set(int(code) for code in re.findall(rb'error ts(\d+)', tail)))[:100]
            receipt['diagnosticClass'] = ('v8-heap-oom' if receipt['v8HeapOOM'] else 'disk-full' if b'enospc' in tail else 'typescript-diagnostics' if receipt['typeScriptErrorCodes'] else 'dependency-missing' if b'module_not_found' in tail or b'cannot find module' in tail else 'none' if receipt['childExitCode'] == 0 else 'command-failed')
    except BaseException as error:
        receipt['errors'].append(type(error).__name__)
    finally:
        survivors = []
        if interrupted and 'interrupted' not in receipt['errors']:
            receipt['errors'].append('interrupted')
        if scope_verified:
            try:
                survivors = list(identities(cgroup_read(root)['pids']))
                receipt['descendantsAfterCommand'] = len(survivors)
                remaining, errors = terminate_owned(root, child)
                receipt['descendantsAfterCleanup'] = len(remaining)
                receipt['errors'].extend(errors)
                if remaining:
                    receipt['errors'].append('cleanup-incomplete')
                if child is not None:
                    child.wait(timeout=2)
                    receipt['childExitCode'] = child.returncode
                receipt['waitedChildrenMaxRssBytes'] = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss * 1024
                final = cgroup_read(root)
                receipt['cgroup'] = {key: value for key, value in final.items() if key != 'pids'}
                receipt['cgroup']['eventsDelta'] = {key: value - baseline['events'].get(key, 0) for key, value in final['events'].items()}
                receipt['status'] = 'passed' if successful(receipt['childExitCode'], receipt['normalCompletion'], survivors, receipt['cgroup']['eventsDelta'], receipt['errors']) else 'failed'
            except BaseException as error:
                receipt['errors'].append(type(error).__name__)
                receipt['status'] = 'failed'
        receipt['seconds'] = round(time.monotonic() - started, 3)
        report.parent.mkdir(parents=True, exist_ok=True)
        report.write_text(json.dumps(receipt, indent=2) + '\n')
        for sig, handler in previous.items():
            signal.signal(sig, handler)
    return 0 if receipt['status'] == 'passed' else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cgroup', default='/sys/fs/cgroup')
    parser.add_argument('--report', required=True)
    parser.add_argument('--phase', required=True, choices=['install','inventory','typegen','typecheck','cli','sandbox','next','standalone','test'])
    parser.add_argument('--timeout', type=float, default=1800)
    parser.add_argument('--tracked-sources')
    parser.add_argument('--source-root', default='/work')
    parser.add_argument('command', nargs=argparse.REMAINDER)
    arguments = parser.parse_args()
    if arguments.command[:1] == ['--']:
        arguments.command = arguments.command[1:]
    if not arguments.command:
        parser.error('command required')
    raise SystemExit(run(arguments))
