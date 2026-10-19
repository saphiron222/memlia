#!/usr/bin/env python3
# Copyright 2026 Memlia. All rights reserved.
"""Measure one build phase inside its own non-privileged cgroup-v2 container.

Only numeric/status metadata is persisted. Command output stays in an ephemeral
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
    parser.add_argument('command', nargs=argparse.REMAINDER)
    arguments = parser.parse_args()
    if arguments.command[:1] == ['--']:
        arguments.command = arguments.command[1:]
    if not arguments.command:
        parser.error('command required')
    raise SystemExit(run(arguments))
