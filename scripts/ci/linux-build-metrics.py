#!/usr/bin/env python3
# Copyright 2026 Memlia. All rights reserved.
"""Measure one build phase inside its own non-privileged cgroup-v2 container.

Only numeric/status metadata and allowlisted TS locations are persisted. Command output stays in an ephemeral
file, never stdout/artifacts. PID 1 remains alive to read memory.peak after the
child exits. This is not the macOS build guard and never controls other groups.
"""
import argparse
import json
import math
import os
from pathlib import Path
import resource
import shutil
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


def swap_observation(root):
    peak=root/'memory.swap.peak'
    events=root/'memory.swap.events'
    return {'peakBytes':int(peak.read_text()) if peak.exists() else None,
            'peakSource':'kernel' if peak.exists() else 'sampled',
            'events':dict((key,int(value)) for key,value in (line.split() for line in events.read_text().splitlines())) if events.exists() else None}


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


def observe_processes(owned, stage):
    """Closed diagnostics only; never an input to verdict or signal ownership.

    cgroup.procs normally excludes established zombies. A process can change
    state between that enumeration and this bounded stat read. Do not infer
    an historical worker identity or a successful cleanup from these samples.
    """
    if stage not in ('after_command', 'after_drain', 'before_term', 'before_kill', 'after_cleanup'):
        raise ValueError('observation-stage-refused')
    result = {'stage': stage, 'total': len(owned), 'truncated': len(owned) > 32,
              'identities': []}
    for pid, started in list(owned.items())[:32]:
        item = {'pid': pid, 'startTimeTicks': started}
        try:
            with Path(f'/proc/{pid}/stat').open() as handle:
                record = handle.read(8193)
            if len(record) > 8192:
                raise ValueError('stat-invalid')
            opening, closing = record.index('('), record.rindex(')')
            fields = record[closing + 2:].split()
            if (int(record[:opening].strip()) != pid or len(fields) < 20
                    or fields[0] not in ('R', 'S', 'D', 'Z', 'T', 't', 'X', 'x', 'K', 'W', 'P', 'I')):
                raise ValueError('stat-invalid')
            parent, group, session, observed_start = map(int, (fields[1], fields[2], fields[3], fields[19]))
            if min(parent, group, session, observed_start) < 0:
                raise ValueError('stat-invalid')
            if observed_start != started:
                item['result'] = 'identity_changed'
            else:
                item.update(result='present_same_identity', state=fields[0], ppid=parent,
                            pgid=group, sid=session)
        except FileNotFoundError:
            item['result'] = 'gone'
        except OSError:
            item['result'] = 'unreadable'
        except (ValueError, IndexError, UnicodeError):
            item['result'] = 'malformed'
        result['identities'].append(item)
    return result


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


def terminate_owned(root, child=None, observations=None):
    errors = []
    for sig, delay in ((signal.SIGTERM, 2), (signal.SIGKILL, 1)):
        owned = identities(cgroup_read(root)['pids'])
        if observations is not None:
            observations.append(observe_processes(owned, 'before_term' if sig == signal.SIGTERM else 'before_kill'))
        for pid, started in owned.items():
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
    remaining = identities(cgroup_read(root)['pids'])
    if observations is not None:
        observations.append(observe_processes(remaining, 'after_cleanup'))
    return list(remaining), errors


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



class WebpackObservation:
    """Bounded log observations, never an input to successful() or cleanup.

    Next 16.4.2's compiled debug logger emits these exact non-coloured lines.
    pread has a separate offset: reading must not move the child's shared file
    position, overwrite its output, or disturb the existing TS/OOM tail reader.
    """
    BYTE_LIMIT = 8 * 1024 * 1024
    CHUNK = 65536
    LINE_LIMIT = 512
    EVENT_LIMIT = 16
    MARKER = re.compile(
        rb'[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T'
        rb'(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z '
        rb'next:build:webpack-build '
        rb'(?:starting (server|edge-server|client) compiler|'
        rb'(server|edge-server|client) compiler finished (0|[1-9][0-9]{0,6})ms)')
    ORDER = [(compiler, event) for compiler in ('server', 'edge', 'client')
             for event in ('started', 'finished')]

    def __init__(self, enabled):
        self.enabled = enabled
        self.offset = 0
        self.pending = b''
        self.dropping = False
        self.events = []
        self.sequence_valid = True
        self.truncated = False
        self.read_error = False

    def _line(self, line):
        match = self.MARKER.fullmatch(line)
        if not match:
            return
        started, finished, duration = match.groups()
        compiler = {b'server':'server', b'edge-server':'edge', b'client':'client'}[started or finished]
        event = 'started' if started else 'finished'
        if duration is not None and int(duration) > 1800000:
            return
        if len(self.events) == self.EVENT_LIMIT:
            self.truncated = True
            return
        index = len(self.events)
        if index >= len(self.ORDER) or self.ORDER[index] != (compiler, event):
            self.sequence_valid = False
        record = {'compiler':compiler, 'event':event}
        if duration is not None:
            record['durationMs'] = int(duration)
        self.events.append(record)

    def _feed(self, data):
        # Never retain an oversized line or recognize its valid-looking suffix.
        parts = data.split(b'\n')
        for index, part in enumerate(parts):
            if not self.dropping:
                if len(self.pending) + len(part) > self.LINE_LIMIT:
                    self.pending = b''
                    self.dropping = True
                    self.truncated = True
                else:
                    self.pending += part
            if index < len(parts) - 1:
                if not self.dropping:
                    self._line(self.pending)
                self.pending = b''
                self.dropping = False

    def drain(self, output, final=False):
        if not self.enabled or self.read_error:
            return
        try:
            # One chunk per sample; final drain is still bounded by BYTE_LIMIT.
            while self.offset < self.BYTE_LIMIT:
                data = os.pread(output.fileno(), min(self.CHUNK, self.BYTE_LIMIT - self.offset), self.offset)
                if not data:
                    break
                self.offset += len(data)
                self._feed(data)
                if not final:
                    break
            if os.fstat(output.fileno()).st_size > self.BYTE_LIMIT:
                self.truncated = True
            if final and (self.pending or self.dropping):
                self.truncated = True
                self.pending = b''
                self.dropping = False
        except (OSError, ValueError):
            self.read_error = True
            self.pending = b''

    def receipt(self):
        return {'enabled':self.enabled, 'events':list(self.events),
                'sequenceValid':self.sequence_valid, 'truncated':self.truncated,
                'readError':self.read_error,
                'complete':(self.enabled and self.sequence_valid and not self.truncated
                            and not self.read_error and len(self.events) == len(self.ORDER))}


def run(args):
    root, report = Path(args.cgroup), Path(args.report)
    receipt = {'phase': args.phase, 'status': 'failed', 'normalCompletion': False,
               'childExitCode': None, 'samples': 0, 'peakProcessRssBytes': 0,
               'peakSampledGroupRssBytes': 0, 'peakSampledSwapBytes': 0, 'errors': [],
               'peakObservedHostSwapGrowthBytes': 0, 'minObservedHostAvailableBytes': None}
    experiment = getattr(args, 'experiment', None)
    webpack = WebpackObservation(args.phase == 'next' and experiment not in ('turbopack','turbopack-zram'))
    started = time.monotonic()
    child = None
    interrupted = False
    scope_verified = False
    baseline = None
    drain_started = None
    drain_owned = {}
    def stop(signum, frame):
        nonlocal interrupted
        interrupted = True
    previous = {sig: signal.signal(sig, stop) for sig in (signal.SIGINT, signal.SIGTERM)}
    try:
        baseline = cgroup_read(root)
        if set(baseline['pids']) != {os.getpid()} or baseline['limitBytes'] is None:
            raise RuntimeError('A dedicated finite cgroup is required')
        scope_verified = True
        if experiment:
            if (args.phase != 'next' or experiment not in ('webpack','turbopack','turbopack-zram')
                    or baseline['limitBytes'] != 13*1024**3 or baseline.get('swapLimitBytes') != 24*1024**3
                    or baseline.get('cpuMax') != [400000,100000]
                    or not math.isfinite(args.timeout) or not 0 < args.timeout <= 6000):
                raise RuntimeError('Experiment limits unavailable')
            receipt['experiment'] = experiment
            receipt['swapObservationBefore'] = swap_observation(root)
            receipt['minObservedDiskFreeBytes'] = shutil.disk_usage(Path.cwd()).free
            receipt['peakSampledCpuPercent'] = 0
            receipt['peakSampledDescendants'] = 0
            cpu_previous = (time.monotonic(), baseline['cpuUsageUsec']['usage_usec'])
        host_baseline = host_memory()
        with tempfile.TemporaryFile() as output:
            child = subprocess.Popen(args.command, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
            while True:
                webpack.drain(output)
                reading = cgroup_read(root)
                host = host_memory()
                if experiment:
                    now = time.monotonic()
                    cpu_used = reading['cpuUsageUsec']['usage_usec']
                    receipt['peakSampledCpuPercent'] = max(receipt['peakSampledCpuPercent'],
                        round(100*(cpu_used-cpu_previous[1])/1000000/max(now-cpu_previous[0],0.000001),3))
                    cpu_previous = (now,cpu_used)
                    receipt['peakSampledDescendants'] = max(receipt['peakSampledDescendants'],len(identities(reading['pids'])))
                    receipt['minObservedDiskFreeBytes'] = min(receipt['minObservedDiskFreeBytes'], shutil.disk_usage(Path.cwd()).free)
                    if receipt['minObservedDiskFreeBytes'] < 2*1024**3:
                        receipt['errors'].append('disk-reserve-exhausted')
                        break
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
                    if child.returncode != 0:
                        break
                    if drain_started is None:
                        drain_started = time.monotonic()
                        drain_owned = identities(cgroup_read(root)['pids'])
                        receipt['descendantsAfterCommand'] = len(drain_owned)
                        receipt['processObservations'] = [observe_processes(drain_owned, 'after_command')]
                        receipt['drainLimitSeconds'] = 2
                    else:
                        drain_owned = identities(reading['pids'])
                if interrupted or time.monotonic() - started >= args.timeout:
                    receipt['errors'].append('interrupted' if interrupted else 'timeout')
                    if drain_started is not None:
                        receipt['drainOutcome'] = 'interrupted' if interrupted else 'timeout'
                    break
                if drain_started is not None:
                    if time.monotonic() >= drain_started + 2:
                        receipt['drainOutcome'] = 'grace_expired'
                        receipt['errors'].append('drain-timeout')
                        break
                    if not drain_owned:
                        receipt['drainOutcome'] = 'empty'
                        break
                    time.sleep(min(0.05, max(0, min(drain_started + 2, started + args.timeout) - time.monotonic())))
                else:
                    time.sleep(0.25)
            webpack.drain(output, final=True)
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
                if drain_started is None:
                    owned_after_command = identities(cgroup_read(root)['pids'])
                    survivors = list(owned_after_command)
                    receipt['descendantsAfterCommand'] = len(survivors)
                    receipt['processObservations'] = [observe_processes(owned_after_command, 'after_command')]
                else:
                    survivors = list(drain_owned)
                    receipt['descendantsAfterDrain'] = len(survivors)
                    receipt['drainSeconds'] = round(time.monotonic() - drain_started, 3)
                    receipt.setdefault('drainOutcome', 'observation_failed')
                    receipt['processObservations'].append(observe_processes(drain_owned, 'after_drain'))
                remaining, errors = terminate_owned(root, child, receipt['processObservations'])
                receipt['descendantsAfterCleanup'] = len(remaining)
                receipt['errors'].extend(errors)
                if remaining:
                    receipt['errors'].append('cleanup-incomplete')
                if child is not None:
                    child.wait(timeout=2)
                    receipt['childExitCode'] = child.returncode
                receipt['waitedChildrenMaxRssBytes'] = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss * 1024
                final = cgroup_read(root)
                if experiment:
                    after = swap_observation(root)
                    before = receipt.get('swapObservationBefore', {})
                    after['eventsDelta'] = ({key:value-(before.get('events') or {}).get(key,0) for key,value in after['events'].items()}
                                            if after['events'] is not None else None)
                    if after['peakBytes'] is None:
                        after['peakBytes'] = receipt['peakSampledSwapBytes']
                    receipt['swapObservation'] = after
                receipt['cgroup'] = {key: value for key, value in final.items() if key != 'pids'}
                receipt['cgroup']['eventsDelta'] = {key: value - baseline['events'].get(key, 0) for key, value in final['events'].items()}
                if interrupted and 'interrupted' not in receipt['errors']:
                    receipt['errors'].append('interrupted')
                receipt['status'] = 'passed' if successful(receipt['childExitCode'], receipt['normalCompletion'], survivors, receipt['cgroup']['eventsDelta'], receipt['errors']) else 'failed'
            except BaseException as error:
                receipt['errors'].append(type(error).__name__)
                receipt['status'] = 'failed'
        receipt['webpackObservation'] = webpack.receipt()
        receipt['seconds'] = round(time.monotonic() - started, 3)
        if interrupted:
            if 'interrupted' not in receipt['errors']:
                receipt['errors'].append('interrupted')
            receipt['status'] = 'failed'
        report.parent.mkdir(parents=True, exist_ok=True)
        report.write_text(json.dumps(receipt, indent=2) + '\n')
        for sig, handler in previous.items():
            signal.signal(sig, handler)
    return 0 if receipt['status'] == 'passed' else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cgroup', default='/sys/fs/cgroup')
    parser.add_argument('--report', required=True)
    parser.add_argument('--phase', required=True, choices=['install','inventory','typegen','typecheck','cli','sandbox','next','standalone','test','config'])
    parser.add_argument('--experiment', choices=['webpack','turbopack','turbopack-zram'])
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
