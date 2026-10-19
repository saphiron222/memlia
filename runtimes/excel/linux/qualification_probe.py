# Copyright (c) 2026 Memlia. All rights reserved.
"""Fixed CI-only probes, executed as 65532 inside the owned worker container.

Never installed in the runtime image and never selected by a request payload.
Each bounded pressure probe first checks the cgroup's effective hard limits.
"""
import errno
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time

CG = Path('/sys/fs/cgroup')
ENV = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/tmp', 'TMPDIR': '/tmp'}


def require(ok):
    if not ok:
        raise ValueError('probe_refused')


def counters(name):
    return {key: int(value) for key, value in (line.split() for line in (CG/name).read_text().splitlines())}


def limits():
    require((CG/'memory.max').read_text().strip() == '536870912')
    require((CG/'memory.swap.max').read_text().strip() == '0')
    require((CG/'pids.max').read_text().strip() == '32')
    quota, period = map(int, (CG/'cpu.max').read_text().split())
    require(quota == period and period > 0)


def boundary():
    require(os.getuid() == os.getgid() == 65532)
    require(Path('/opt/excel/runtime/bin').stat().st_uid == 65532)
    root_denied = False
    try:
        Path('/opt/excel/runtime/recipe-write').write_bytes(b'x')
    except OSError as error:
        root_denied = error.errno == errno.EROFS
    require(root_denied)
    tmp = Path('/tmp/recipe-exec')
    require((Path('/tmp').stat().st_mode & 0o777) == 0o700)
    try:
        tmp.write_bytes(b'#!/bin/sh\nexit 0\n')
        tmp.chmod(0o700)
        try:
            subprocess.run([str(tmp)], env=ENV, timeout=2, check=True, capture_output=True)
        except OSError as error:
            require(error.errno == errno.EACCES)
        else:
            require(False)
    finally:
        tmp.unlink(missing_ok=True)
    require({p.name for p in Path('/sys/class/net').iterdir()} == {'lo'})
    with socket.socket() as channel:
        channel.settimeout(1)
        require(channel.connect_ex(('192.0.2.1', 9)) in (errno.ENETUNREACH, errno.EHOSTUNREACH))
    status = dict(line.split(':',1) for line in Path('/proc/self/status').read_text().splitlines())
    require(status['NoNewPrivs'].strip() == '1' and int(status['CapEff'].strip(),16) == 0)
    return dict(nonRoot=True, rootReadOnly=True, tmpWritable=True, networkDenied=True, noNewPrivileges=True)


def cpu():
    limits()
    before = counters('cpu.stat')['nr_throttled']
    children = []
    try:
        for _ in range(2):
            children.append(subprocess.Popen([sys.executable, '-I', '-B', '-c',
                'import time\ne=time.monotonic()+2.5\nwhile time.monotonic()<e: pass'],
                env=ENV, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
        for child in children:
            require(child.wait(timeout=8) == 0)
    finally:
        for child in children:
            if child.poll() is None: child.kill()
            child.wait(timeout=2)
    require(counters('cpu.stat')['nr_throttled'] > before)
    return dict(cpuThrottled=True)


def pids():
    limits()
    before = counters('pids.events')['max']
    children, denied = [], False
    try:
        for _ in range(40):
            try:
                children.append(subprocess.Popen([sys.executable, '-I', '-B', '-c', 'import time; time.sleep(8)'],
                    env=ENV, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
            except OSError as error:
                require(error.errno == errno.EAGAIN)
                denied = True
                break
        require(denied and 0 < len(children) < 32 and counters('pids.events')['max'] > before)
    finally:
        for child in children:
            if child.poll() is None: child.kill()
        for child in children: child.wait(timeout=2)
    return dict(pidLimitEnforced=True)


def memory():
    limits()
    before = counters('memory.events')['oom_kill']
    # Prefer the expendable allocator, never the awaiting worker or host process.
    code = "from pathlib import Path\nPath('/proc/self/oom_score_adj').write_text('1000')\nblocks=[]\nfor _ in range(160): blocks.append(bytearray(b'x'*(4*1024**2)))\n"
    child = subprocess.Popen([sys.executable, '-I', '-B', '-c', code], env=ENV,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        require(child.wait(timeout=15) == -9)
        require(counters('memory.events')['oom_kill'] > before)
    finally:
        if child.poll() is None: child.kill()
        child.wait(timeout=2)
    return dict(memoryOomEnforced=True)


def disk():
    limits()
    target, denied = Path('/tmp/recipe-disk'), False
    try:
        with target.open('wb', buffering=0) as output:
            for _ in range(130):
                try:
                    output.write(b'x' * 1024**2)
                except OSError as error:
                    require(error.errno == errno.ENOSPC)
                    denied = True
                    break
        require(denied and target.stat().st_size <= 128*1024**2)
    finally:
        target.unlink(missing_ok=True)
    return dict(tmpfsLimitEnforced=True)


if __name__ == '__main__':
    try:
        require(sys.platform == 'linux' and len(sys.argv) == 2)
        operation = {'boundary': boundary, 'cpu': cpu, 'pids': pids, 'memory': memory, 'disk': disk}[sys.argv[1]]
        print(json.dumps(operation(), separators=(',', ':')))
    except Exception:
        # Never print a traceback, path, arbitrary OS message or data.
        print('{"code":"probe_refused"}')
        raise SystemExit(2)
