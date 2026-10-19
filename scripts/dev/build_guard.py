# Copyright 2026 Memlia. All rights reserved.
"""Run a local build and record its outcome without recording command arguments."""

import argparse
from contextlib import contextmanager
import ctypes
import errno
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import threading
import time


MONITORING_STAGES = frozenset((
    'sysctl', 'sysctl_parse', 'pressure', 'pressure_parse', 'process_tree',
    'process_tree_parse', 'process_identity', 'process_ownership',
    'process_footprint', 'process_footprint_parse', 'process_recheck',
    'disk', 'sample_validation', 'policy', 'observation'))
MONITORING_CLASSES = frozenset((
    'timeout', 'command_exit', 'os_error', 'format', 'invalid_sample', 'unexpected'))


class _MonitoringFailure(RuntimeError):
    """Carry only fixed diagnostics, never native output or exception text."""
    def __init__(self, stage, failure_class):
        super().__init__('monitoring unavailable')
        self.stage = stage
        self.failure_class = failure_class


@contextmanager
def _monitoring_stage(stage):
    try:
        yield
    except _MonitoringFailure:
        raise
    except Exception as error:
        if isinstance(error, subprocess.TimeoutExpired):
            failure_class = 'timeout'
        elif isinstance(error, subprocess.CalledProcessError):
            failure_class = 'command_exit'
        elif isinstance(error, OSError):
            failure_class = 'os_error'
        elif stage == 'sample_validation':
            failure_class = 'invalid_sample'
        elif stage.endswith('_parse') or isinstance(
                error, (ValueError, TypeError, KeyError, IndexError, AttributeError)):
            failure_class = 'format'
        else:
            failure_class = 'unexpected'
        raise _MonitoringFailure(stage, failure_class) from None


def _monitoring_diagnostic(error):
    # Recheck the closed sets at the receipt boundary; unknown exception types
    # (including subclasses) cannot supply arbitrary diagnostic attributes.
    stage = error.stage if type(error) is _MonitoringFailure else None
    failure_class = error.failure_class if type(error) is _MonitoringFailure else None
    return {'stage': stage if type(stage) is str and stage in MONITORING_STAGES else 'observation',
            'class': failure_class if type(failure_class) is str and failure_class in MONITORING_CLASSES else 'unexpected'}


def native_identity(pid):
    """Darwin PROC_PIDTBSDINFO: PID/UID/start microseconds, no argv or environment.

    Layout checked against the installed SDK sys/proc_info.h and libproc.h.
    Identity checks narrow PID reuse races; signaling remains non-atomic and
    this advisory tool is not a sandbox for hostile/detaching programs.
    """
    class BsdInfo(ctypes.Structure):
        _fields_ = [('prefix', ctypes.c_uint32 * 12), ('comm', ctypes.c_char * 16),
                    ('name', ctypes.c_char * 32), ('tail', ctypes.c_uint32 * 6),
                    ('seconds', ctypes.c_uint64), ('microseconds', ctypes.c_uint64)]
    lib = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
    function = lib.proc_pidinfo
    function.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
    function.restype = ctypes.c_int
    info = BsdInfo()
    size = function(pid, 3, 0, ctypes.byref(info), ctypes.sizeof(info))
    if size == 0 and ctypes.get_errno() == errno.ESRCH:
        return None
    if size != ctypes.sizeof(info):
        raise RuntimeError('process identity unavailable')
    return {'pid': info.prefix[3], 'uid': info.prefix[5], 'seconds': info.seconds,
            'microseconds': info.microseconds, 'status': info.prefix[1]}


def _same_process(expected):
    current = native_identity(expected['pid'])
    return current is not None and current['status'] != 5 and all(
        current[key] == expected[key] for key in ('pid', 'uid', 'seconds', 'microseconds'))


def mac_snapshot(pid):
    """Read footprint (including compressed memory), descendants and global pressure.

    No arguments/environment are read. Shared footprint may be counted twice;
    this intentionally errs on the conservative side for this development host.
    """
    if sys.platform != 'darwin':
        raise RuntimeError('macOS observation required')
    def read(command, stage):
        with _monitoring_stage(stage):
            return subprocess.run(command, check=True, capture_output=True, text=True,
                                  timeout=5).stdout
    global_usage = read(['/usr/sbin/sysctl', 'kern.memorystatus_vm_pressure_level',
                         'vm.swapusage'], 'sysctl')
    with _monitoring_stage('sysctl_parse'):
        pressure = int(re.search(r'pressure_level:\s*(\d+)', global_usage)[1])
        swap_mb = float(re.search(r'used\s*=\s*([\d.]+)M', global_usage)[1])
    free_usage = read(['/usr/bin/memory_pressure', '-Q'], 'pressure')
    with _monitoring_stage('pressure_parse'):
        free = int(re.search(r'free percentage:\s*(\d+)%', free_usage)[1])
    total = 0
    count = 0
    identities = []
    if pid is not None:
        process_rows = read(['/bin/ps', '-axo', 'pid=,ppid=,pgid='], 'process_tree')
        with _monitoring_stage('process_tree_parse'):
            rows = [tuple(map(int, line.split())) for line in
                    process_rows.splitlines() if line.strip()]
            members = {p for p, _, group in rows if group == pid}
            # Include trusted build descendants even if a worker created a new group.
            parents = {pid}
            seen = {pid}
            while True:
                following = {p for p, parent, _ in rows if parent in parents} - seen
                if not following:
                    break
                members.update(following)
                seen.update(following)
                parents = following
        for member in members:
            try:
                with _monitoring_stage('process_identity'):
                    identity = native_identity(member)
                if identity is None or identity['status'] == 5:
                    continue
                with _monitoring_stage('process_ownership'):
                    if identity['uid'] != os.getuid():
                        raise RuntimeError('process ownership changed')
                summary = read(['/usr/bin/vmmap', '-summary', str(member)], 'process_footprint')
                with _monitoring_stage('process_footprint_parse'):
                    footprint = re.search(r'^Physical footprint:\s*([\d.]+)([KMGT]?)B?\s*$',
                                          summary, re.MULTILINE)
                    if not footprint:
                        raise RuntimeError('footprint unavailable')
                    total += int(float(footprint[1]) * 1024**(' KMGT'.index(footprint[2] or ' ')))
                count += 1
                identities.append(identity)
            except Exception:
                # A short-lived worker may have exited between ps and vmmap.
                remaining = read(['/bin/ps', '-axo', 'pid='], 'process_recheck').split()
                if str(member) in remaining:
                    # ps still lists unreaped terminal processes. Confirm native
                    # liveness; never retry vmmap or accept an unknown/live state.
                    with _monitoring_stage('process_recheck'):
                        current = native_identity(member)
                        terminal = current is None or current['status'] == 5
                    if not terminal:
                        raise
    return {'footprintBytes': total, 'processCount': count,
            'swapBytes': int(swap_mb * 1024**2), 'pressureLevel': pressure,
            'freePercent': free, 'processes': identities}


def _stop_owned(child):
    if child.poll() is not None:
        return
    if os.getpgid(child.pid) != child.pid:
        raise RuntimeError('owned process group unavailable')
    os.killpg(child.pid, signal.SIGTERM)
    # Keep the leader unreaped so the group ID cannot be recycled during grace.
    time.sleep(0.5)
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    except PermissionError:
        # Darwin returns EPERM for groups containing only exited zombies.
        states = subprocess.run(['/bin/ps', '-axo', 'pgid=,stat='], check=True,
                                capture_output=True, text=True, timeout=5).stdout.splitlines()
        if any(int(row.split()[0]) == child.pid and
               not row.split()[1].startswith('Z') for row in states):
            raise
    child.wait(timeout=5)


def run_guard(command, report, *, measure=mac_snapshot, interval=2, profile='strict',
              disk_path=None, measure_disk=None, clock=time.monotonic):
    if profile not in ('strict', 'milestone'):
        raise ValueError('unknown profile')
    started = clock()
    policy = None
    if profile == 'milestone':
        # Load only our sibling, including for callers importing this script by path.
        spec = importlib.util.spec_from_file_location(
            'memlia_milestone_policy', Path(__file__).with_name('milestone_policy.py'))
        milestone = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(milestone)
        policy = milestone.MilestonePolicy(started=started)
        volume = Path.cwd() if disk_path is None else disk_path
        if measure_disk is None:
            def measure_disk():
                usage = os.statvfs(volume)
                return usage.f_bavail * usage.f_frsize
    receipt = {'status': 'refused', 'reason': None, 'childExitCode': None,
               'observations': 0, 'peakFootprintBytes': 0, 'peakSwapGrowthBytes': 0}
    if policy is not None:
        receipt.update(profile='milestone', timeoutSeconds=milestone.TIMEOUT_SECONDS,
                       minimumDiskBytes=milestone.MIN_DISK_BYTES,
                       peakSwapBytes=0, minDiskFreeBytes=None, minFreePercent=None,
                       criticalSeconds=0, peakCriticalSeconds=0, pressureSequence=[], pressureSequenceTruncated=False)
    owned = {}
    def write():
        receipt['elapsedSeconds'] = round(clock() - started, 3)
        report.write_text(json.dumps(receipt, indent=2) + '\n')
    def observe(pid):
        with _monitoring_stage('observation'):
            sample = measure(pid)
        if policy is not None:
            # Ownership survives an independent disk/pressure measurement failure.
            with _monitoring_stage('sample_validation'):
                identities = milestone.capture_identities(sample)
            for identity in identities:
                owned[identity['pid']] = identity
            with _monitoring_stage('disk'):
                disk_free_bytes = measure_disk()
            with _monitoring_stage('sample_validation'):
                sample = milestone.capture_sample(sample, disk_free_bytes, identities)
        else:
            with _monitoring_stage('sample_validation'):
                for identity in sample.get('processes', []):
                    owned[identity['pid']] = identity
        with _monitoring_stage('sample_validation'):
            receipt['observations'] += 1
            receipt['lastObservation'] = sample
            receipt['peakFootprintBytes'] = max(receipt['peakFootprintBytes'], sample['footprintBytes'])
            if policy is not None:
                receipt['peakSwapBytes'] = max(receipt['peakSwapBytes'], sample['swapBytes'])
                for receipt_key, sample_key in (('minDiskFreeBytes', 'diskFreeBytes'),
                                                ('minFreePercent', 'freePercent')):
                    old = receipt[receipt_key]
                    receipt[receipt_key] = sample[sample_key] if old is None else min(old, sample[sample_key])
        return sample
    def budget(sample):
        if policy is not None:
            now = clock()
            reason = policy.evaluate(sample, now)
            if reason == 'monitoring-unavailable':
                receipt['monitoringFailure'] = {'stage': 'policy', 'class': 'invalid_sample'}
            receipt['criticalSeconds'] = round(policy.critical_seconds, 3)
            receipt['peakCriticalSeconds'] = max(receipt['peakCriticalSeconds'], receipt['criticalSeconds'])
            growth = sample['swapBytes'] - receipt['baseline']['swapBytes']
            receipt['peakSwapGrowthBytes'] = max(receipt['peakSwapGrowthBytes'], growth)
            sequence = receipt['pressureSequence']
            entry = {'elapsedSeconds': round(now - started, 3), 'level': sample['pressureLevel']}
            if not sequence or sequence[-1]['level'] != entry['level']:
                if len(sequence) < 128:
                    sequence.append(entry)
                else:
                    receipt['pressureSequenceTruncated'] = True
            return reason

        if sample['pressureLevel'] != 1:
            return 'system-pressure'
        if sample['freePercent'] < 20:
            return 'system-free-budget'
        if sample['footprintBytes'] > 7 * 1024**3:
            return 'footprint-budget'
        growth = sample['swapBytes'] - receipt['baseline']['swapBytes']
        receipt['peakSwapGrowthBytes'] = max(receipt['peakSwapGrowthBytes'], growth)
        if growth > 1024**3:
            return 'swap-growth-budget'
        return None
    try:
        receipt['baseline'] = observe(None)
        with _monitoring_stage('policy'):
            receipt['reason'] = budget(receipt['baseline'])
    except Exception as error:
        receipt['reason'] = 'monitoring-unavailable'
        receipt['monitoringFailure'] = _monitoring_diagnostic(error)
    except KeyboardInterrupt:
        receipt['reason'] = 'operator-interrupt'
    if receipt['reason']:
        write()
        return 130 if receipt['reason'] == 'operator-interrupt' else 125
    try:
        child = subprocess.Popen(command, start_new_session=True)
    except OSError:
        receipt.update(status='failed', reason='launch-failed')
        write()
        return 126
    receipt['childPid'] = child.pid
    try:
        while child.poll() is None:
            try:
                sample = observe(child.pid)
                with _monitoring_stage('policy'):
                    receipt['reason'] = budget(sample)
            except Exception as error:
                # Finishing between ps/vmmap is a normal race, not missing monitoring.
                if policy is not None or child.poll() is None:
                    receipt['reason'] = 'monitoring-unavailable'
                    receipt['monitoringFailure'] = _monitoring_diagnostic(error)
            if receipt['reason']:
                break
            try:
                child.wait(timeout=interval)
            except subprocess.TimeoutExpired:
                pass
    except KeyboardInterrupt:
        receipt['reason'] = 'operator-interrupt'
    try:
        # Even an immediate child exit must not skip the final disk/deadline observation.
        if policy is not None and not receipt['reason']:
            sample = observe(None)
            with _monitoring_stage('policy'):
                receipt['reason'] = budget(sample)
    except KeyboardInterrupt:
        receipt['reason'] = 'operator-interrupt'
    except Exception as error:
        receipt['reason'] = 'monitoring-unavailable'
        receipt['monitoringFailure'] = _monitoring_diagnostic(error)
    try:
        with _monitoring_stage('process_identity'):
            if not receipt['reason'] and any(_same_process(item) for item in owned.values()):
                receipt['reason'] = 'descendants-still-running'
    except Exception as error:
        receipt['reason'] = receipt['reason'] or 'monitoring-unavailable'
        receipt['monitoringFailure'] = _monitoring_diagnostic(error)
    if receipt['reason']:
        previous_handlers = {}
        if threading.current_thread() is threading.main_thread():
            for signum in (signal.SIGINT, signal.SIGTERM):
                previous_handlers[signum] = signal.signal(signum, signal.SIG_IGN)
        failures = set()
        def signal_observed(signum):
            for identity in owned.values():
                try:
                    if _same_process(identity):
                        os.kill(identity['pid'], signum)
                except ProcessLookupError:
                    pass  # A disappearing target must not skip other targets.
                except Exception as error:
                    failures.add(type(error).__name__)
        signal_observed(signal.SIGTERM)
        try:
            _stop_owned(child)
        except ProcessLookupError:
            pass
        except Exception as error:
            failures.add(type(error).__name__)
        time.sleep(0.1)
        signal_observed(signal.SIGKILL)
        time.sleep(0.1)
        for identity in owned.values():
            try:
                if _same_process(identity):
                    failures.add('observed-process-still-alive')
            except Exception as error:
                failures.add(type(error).__name__)
        if failures:
            receipt['cleanupFailure'] = sorted(failures)
        receipt['status'] = 'interrupted'
    else:
        receipt['status'] = 'completed' if child.returncode == 0 else 'failed'
    receipt['childExitCode'] = child.poll()
    write()
    for signum, handler in (previous_handlers.items() if receipt['reason'] else []):
        signal.signal(signum, handler)
    return 130 if receipt['reason'] else child.returncode


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--profile', choices=('strict', 'milestone'), default='strict')
    parser.add_argument('--disk-path', type=Path, help='milestone build output volume; default cwd')
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command:
        parser.error('a command is required after --')
    interrupted = False
    def interrupt(_signum, _frame):
        nonlocal interrupted
        if not interrupted:
            interrupted = True
            raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGINT, interrupt)
    if args.disk_path is not None and args.profile != 'milestone':
        parser.error('--disk-path requires --profile milestone')
    return run_guard(command, args.report, profile=args.profile, disk_path=args.disk_path)


if __name__ == '__main__':
    raise SystemExit(main())
