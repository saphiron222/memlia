#!/usr/bin/env python3
# Copyright 2026 Memlia. All rights reserved.
"""Owned ephemeral Linux swap experiment; existing swap is never reconfigured."""
import json
import os
from pathlib import Path
import platform
import re
import signal
import stat
import subprocess
import sys
import tempfile
import time

GIB = 1024**3
DISK_BYTES = 24*GIB
RESERVE_BYTES = 12*GIB
ZRAM_LOGICAL_BYTES = 2*GIB
ZRAM_PHYSICAL_BYTES = 512*1024**2
VARIANTS = ('webpack', 'turbopack', 'turbopack-zram')


FAILURE_CODES = frozenset((
    'host_operation_unavailable', 'tool_unavailable', 'environment_unavailable',
    'filesystem_unavailable', 'filesystem_unsupported', 'disk_inventory_invalid',
    'disk_capacity_insufficient', 'memory_inventory_invalid', 'memory_capacity_insufficient',
    'swap_inventory_unavailable', 'swap_inventory_invalid', 'privilege_unavailable',
    'interrupted',
))


class Refused(RuntimeError):
    def __init__(self, code='host_operation_unavailable'):
        self.code = code if code in FAILURE_CODES else 'host_operation_unavailable'
        super().__init__(self.code)


def command(args, data=None):
    try:
        result = subprocess.run(args, input=data, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        raise Refused('tool_unavailable') from None
    if result.returncode:
        raise Refused('Host operation unavailable')
    return result.stdout.strip()


def parse_proc_swaps(data):
    # Linux procfs ABI, independently implemented; no util-linux code is copied.
    if len(data)>65536 or not data.endswith(b'\n'):
        raise Refused('swap_inventory_invalid')
    lines=data[:-1].split(b'\n')
    if re.split(rb'[ \t]+',lines[0])!=[b'Filename',b'Type',b'Size',b'Used',b'Priority'] or len(lines)>129:
        raise Refused('swap_inventory_invalid')
    rows={}
    escapes={b'040':b' ',b'011':b'\t',b'012':b'\n',b'134':b'\\'}
    for line in lines[1:]:
        match=re.fullmatch(rb'(/[^ \t\n]+)[ \t]+(file|partition)[ \t]+([0-9]{1,19})[ \t]+([0-9]{1,19})[ \t]+(-?[0-9]{1,6})',line)
        if not match: raise Refused('swap_inventory_invalid')
        encoded,kind,size,used,priority=match.groups()
        decoded=bytearray(); index=0
        while index<len(encoded):
            if encoded[index]==92:
                escape=encoded[index+1:index+4]
                if escape not in escapes: raise Refused('swap_inventory_invalid')
                decoded.extend(escapes[escape]); index+=4
            else:
                decoded.append(encoded[index]); index+=1
        name=os.fsdecode(bytes(decoded))
        size=int(size)*1024; used=int(used)*1024; priority=int(priority)
        if (b'\0' in decoded or name in rows or not 0<=used<=size<=2**63-1
                or not -32768<=priority<=32767):
            raise Refused('swap_inventory_invalid')
        rows[name]={'name':name,'type':kind.decode('ascii'),'size':size,'used':used,'prio':priority}
    return rows


def swaps():
    try:
        with open('/proc/swaps','rb') as source:
            data=source.read(65537)
    except OSError:
        raise Refused('swap_inventory_unavailable') from None
    return parse_proc_swaps(data)


def validate_host(snapshot):
    if snapshot['system']!='Linux' or not snapshot['public'] or not snapshot['runner']:
        raise Refused('environment_unavailable')
    if snapshot['filesystem'] not in ('ext4','xfs'):
        raise Refused('filesystem_unsupported')
    if snapshot['freeBytes']<DISK_BYTES+RESERVE_BYTES or snapshot['workFreeBytes']<RESERVE_BYTES:
        raise Refused('disk_capacity_insufficient')
    if snapshot['memoryBytes']<14*GIB or snapshot['availableBytes']<13*GIB:
        raise Refused('memory_capacity_insufficient')


def preflight(temporary, work, observed=None):
    observed = {} if observed is None else observed
    snapshot={'system':'Linux' if platform.system()=='Linux' else 'other',
              'public':os.environ.get('MEMLIA_PUBLIC_RUN')=='1',
              'runner':os.environ.get('GITHUB_ACTIONS')=='true' and os.environ.get('RUNNER_OS')=='Linux'}
    observed.update(snapshot)
    if snapshot['system']!='Linux' or not snapshot['public'] or not snapshot['runner']:
        raise Refused('environment_unavailable')
    snapshot['swapNames']=list(swaps())
    observed['preexistingSwapCount']=len(snapshot['swapNames'])
    try:
        with open('/proc/meminfo','rb') as source: data=source.read(65537)
        if len(data)>65536: raise ValueError()
        memory={}
        for line in data.split(b'\n'):
            if line.startswith((b'MemTotal:',b'MemAvailable:')):
                match=re.fullmatch(rb'(MemTotal|MemAvailable):[ \t]+([0-9]{1,19}) kB',line)
                if not match or match[1] in memory: raise ValueError()
                memory[match[1]]=int(match[2])*1024
        total,available=memory[b'MemTotal'],memory[b'MemAvailable']
        if not 0<=available<=total<=2**63-1: raise ValueError()
    except (OSError,KeyError,ValueError):
        raise Refused('memory_inventory_invalid') from None
    snapshot.update(memoryBytes=total,availableBytes=available)
    observed.update(memoryBytes=total,availableBytes=available)
    try: filesystem=command(['findmnt','-n','-o','FSTYPE','-T',str(temporary)])
    except Refused as error:
        if error.code=='tool_unavailable': raise
        raise Refused('filesystem_unavailable') from None
    snapshot['filesystem']=filesystem if filesystem in ('ext4','xfs') else 'other'
    observed['filesystem']=snapshot['filesystem']
    def free(path):
        value=command(['df','-B1','--output=avail',str(path)]).splitlines()
        if len(value)!=2 or not re.fullmatch(r'[0-9]{1,19}',value[-1].strip()):
            raise Refused('disk_inventory_invalid')
        number=int(value[-1].strip())
        if number>2**63-1: raise Refused('disk_inventory_invalid')
        return number
    for key,path in [('freeBytes',temporary),('workFreeBytes',work)]:
        snapshot[key]=free(path); observed[key]=snapshot[key]
    validate_host(snapshot)
    try: command(['sudo','-n','true'])
    except Refused: raise Refused('privilege_unavailable') from None
    return snapshot


def verify_active_swap(temporary, path, zram=None):
    path=Path(path)
    info=path.lstat()
    if (path.resolve(strict=True)!=path or path.parent.parent!=Path(temporary).resolve(strict=True)
            or not path.parent.name.startswith('memlia-swap.') or path.name!='swapfile'
            or not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode)!=0o600
            or info.st_uid!=os.getuid() or info.st_size!=DISK_BYTES):
        raise Refused('Owned active swap unavailable')
    rows=swaps()
    row=rows.get(str(path))
    if row is None or int(row['prio'])!=10 or not DISK_BYTES-4096<=int(row['size'])<=DISK_BYTES:
        raise Refused('Owned active swap unavailable')
    if zram:
        identifier=zram.removeprefix('/dev/zram')
        if not zram.startswith('/dev/zram') or not identifier.isascii() or not identifier.isdigit():
            raise Refused('Owned active zram unavailable')
        settings=Path('/sys/block')/('zram'+identifier)
        if (zram not in rows or int(rows[zram]['prio'])!=100
                or int((settings/'disksize').read_text())!=ZRAM_LOGICAL_BYTES
                or int((settings/'mem_limit').read_text())!=ZRAM_PHYSICAL_BYTES):
            raise Refused('Owned active zram unavailable')


class OwnedSwap:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.path = self.directory/'swapfile'
        self.identity = None
        self.zram = None
        self.zram_sys = None
        self.disk_active = False
        self.zram_active = False
        self.zram_allocation_pending = False

    def same_file(self):
        info = self.path.lstat()
        return (stat.S_ISREG(info.st_mode) and (info.st_dev,info.st_ino)==self.identity
                and stat.S_IMODE(info.st_mode)==0o600 and info.st_uid==os.getuid())

    def prepare(self, with_zram):
        fd = os.open(self.path, os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o600)
        try:
            info = os.fstat(fd)
            self.identity = (info.st_dev,info.st_ino)
        finally:
            os.close(fd)
        command(['fallocate','--length',str(DISK_BYTES),str(self.path)])
        info = self.path.stat()
        if not self.same_file() or info.st_size!=DISK_BYTES or info.st_blocks*512<DISK_BYTES:
            raise Refused('Owned allocation unavailable')
        command(['sudo','-n','mkswap',str(self.path)])
        command(['sudo','-n','swapon','--priority','10',str(self.path)])
        self.disk_active = True
        row = swaps().get(str(self.path))
        if row is None or int(row['prio'])!=10 or not DISK_BYTES-4096 <= int(row['size']) <= DISK_BYTES:
            raise Refused('Owned swap verification failed')
        if with_zram:
            self.prepare_zram()

    def prepare_zram(self):
        before = {path.name for path in Path('/sys/block').glob('zram*')}
        command(['sudo','-n','modprobe','zram','num_devices=0'])
        self.zram_allocation_pending = True
        identifier = command(['sudo','-n','cat','/sys/class/zram-control/hot_add'])
        if not identifier.isascii() or not identifier.isdigit() or len(identifier)>6 or 'zram'+identifier in before:
            raise Refused('Owned zram unavailable')
        self.zram = '/dev/zram'+identifier
        self.zram_sys = Path('/sys/block')/('zram'+identifier)
        self.zram_allocation_pending = False
        algorithms = (self.zram_sys/'comp_algorithm').read_text().replace('[','').replace(']','').split()
        if 'lz4' not in algorithms:
            raise Refused('Required zram algorithm unavailable')
        for field,value in [('comp_algorithm','lz4'),('disksize',str(ZRAM_LOGICAL_BYTES)),('mem_limit',str(ZRAM_PHYSICAL_BYTES))]:
            command(['sudo','-n','tee',str(self.zram_sys/field)],value+'\n')
        if int((self.zram_sys/'disksize').read_text())!=ZRAM_LOGICAL_BYTES or int((self.zram_sys/'mem_limit').read_text())!=ZRAM_PHYSICAL_BYTES:
            raise Refused('Zram limits unavailable')
        command(['sudo','-n','mkswap',self.zram])
        command(['sudo','-n','swapon','--priority','100',self.zram])
        self.zram_active = True
        row = swaps().get(self.zram)
        if row is None or int(row['prio'])!=100:
            raise Refused('Owned zram verification failed')

    def sample(self):
        rows = swaps()
        result = {'diskSwapUsedBytes':int(rows.get(str(self.path),{}).get('used',0))}
        if self.zram:
            fields = [int(value) for value in (self.zram_sys/'mm_stat').read_text().split()]
            if len(fields)<5:
                raise Refused('Zram counters unavailable')
            result.update({'zramOriginalBytes':fields[0],'zramCompressedBytes':fields[1],
                           'zramPhysicalBytes':fields[2],'zramPhysicalPeakBytes':fields[4],
                           'zramDeviceSwapUsedBytes':int(rows.get(self.zram,{}).get('used',0))})
        return result

    def cleanup(self):
        # Only resources allocated by this object can reach swapoff/reset/unlink.
        ok = not self.zram_allocation_pending
        if self.zram:
            try:
                if self.zram in swaps():
                    command(['sudo','-n','swapoff',self.zram])
                if self.zram in swaps():
                    raise Refused('Owned zram still active')
                command(['sudo','-n','tee',str(self.zram_sys/'reset')],'1\n')
                command(['sudo','-n','tee','/sys/class/zram-control/hot_remove'],self.zram.removeprefix('/dev/zram')+'\n')
                if self.zram_sys.exists():
                    raise Refused('Owned zram still present')
            except Exception:
                ok = False
        if self.identity is not None:
            try:
                if not self.same_file():
                    raise Refused('Owned file changed')
                if str(self.path) in swaps():
                    command(['sudo','-n','swapoff',str(self.path)])
                if str(self.path) in swaps():
                    raise Refused('Owned swap still active')
                self.path.unlink()
                if self.path.exists():
                    raise Refused('Owned file still present')
            except Exception:
                ok = False
        try:
            self.directory.rmdir()
        except OSError:
            ok = False
        return ok


def terminate_group(child):
    try: os.killpg(child.pid,signal.SIGTERM)
    except ProcessLookupError: pass
    try: child.wait(timeout=30)
    except subprocess.TimeoutExpired: pass
    # A runner may already have exited while one of its descendants ignores TERM.
    try: os.killpg(child.pid,signal.SIGKILL)
    except ProcessLookupError: pass
    child.wait(timeout=5)


def run_child(command_line, output, sample, timeout=6900):
    child = subprocess.Popen(command_line, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
    stopped = False
    peaks = {}
    started = time.monotonic()
    def stop(_signum, _frame):
        nonlocal stopped
        stopped = True
    previous = {sig:signal.signal(sig,stop) for sig in (signal.SIGINT,signal.SIGTERM)}
    reason = None
    terminated = False
    try:
        while child.poll() is None:
            for key,value in sample().items():
                peaks[key] = max(peaks.get(key,0),value)
            if stopped or time.monotonic()-started >= timeout:
                reason = 'interrupted' if stopped else 'timeout'
                break
            time.sleep(1)
        if not reason:
            # A normally exited runner must not abandon a process in its owned session.
            try:
                os.killpg(child.pid,0)
                reason = 'descendants'
            except ProcessLookupError:
                pass
        if reason:
            terminate_group(child)
            terminated = True
        exit_code = child.wait(timeout=5)
    finally:
        try:
            if not terminated:
                terminate_group(child)
        finally:
            for sig,handler in previous.items(): signal.signal(sig,handler)
    # Decide only after cleanup and restoration: cancellation can arrive after poll()
    # reports natural completion, including while its owned group is being checked.
    return {'exitCode':exit_code,'reason':'interrupted' if stopped else reason,
            'peaks':peaks,'seconds':round(time.monotonic()-started,3)}


def run(variant):
    receipt = {'variant':variant,'status':'not_tested','cleanup':False,
               'diskSwapCapacityBytes':DISK_BYTES,'diskPriority':10,
               'zramLogicalBytes':ZRAM_LOGICAL_BYTES if variant=='turbopack-zram' else 0,
               'zramPhysicalLimitBytes':ZRAM_PHYSICAL_BYTES if variant=='turbopack-zram' else 0,
               'zramPriority':100 if variant=='turbopack-zram' else None,
               'fallbackUnderSaturationVerified':False,'fallbackQualification':'not_tested'}
    owned = None
    destination = None
    started = time.monotonic()
    def interrupted(_signum, _frame):
        raise Refused('interrupted')
    previous = {sig:signal.signal(sig,interrupted) for sig in (signal.SIGINT,signal.SIGTERM)}
    child_started = False
    stage = 'environment'
    try:
        if variant not in VARIANTS: raise Refused('Unsupported variant')
        temporary = Path(os.environ['RUNNER_TEMP']).resolve(strict=True)
        destination = temporary/'memlia-swap-host.json'
        if destination.exists(): raise Refused('Receipt already exists')
        work = Path(__file__).resolve().parents[2]
        stage = 'preflight'
        receipt['preflight'] = {}
        snapshot = preflight(temporary,work,receipt['preflight'])
        receipt['hostBefore'] = {key:snapshot[key] for key in ('freeBytes','workFreeBytes','memoryBytes','availableBytes','filesystem')}
        receipt['preexistingSwapCount'] = len(snapshot['swapNames'])
        stage = 'allocation'
        owned = OwnedSwap(tempfile.mkdtemp(prefix='memlia-swap.',dir=temporary))
        owned.prepare(variant=='turbopack-zram')
        os.environ['MEMLIA_SWAP_HOST_READY']='1'
        os.environ['MEMLIA_SWAP_FILE']=str(owned.path)
        os.environ['MEMLIA_ZRAM_DEVICE']=owned.zram or ''
        with tempfile.TemporaryFile() as output:
            stage = 'child'
            child_started = True
            result = run_child(['bash',str(work/'scripts/ci/run-linux-build.sh'),'--swap',variant],output,owned.sample)
        receipt['child'] = result
        receipt['status'] = 'passed' if result['exitCode']==0 and result['reason'] is None else 'failed'
    except Exception as error:
        receipt['reason'] = 'experiment_unavailable'
        code = error.code if isinstance(error, Refused) else ('environment_unavailable' if stage=='environment' else 'host_operation_unavailable')
        receipt['diagnostic'] = {'stage':stage,'code':code}
        if child_started: receipt['status']='failed'
    finally:
        def cancellation_during_cleanup(_signum, _frame):
            receipt['status'] = 'failed'
            receipt['reason'] = 'interrupted'
        for sig in previous: signal.signal(sig,cancellation_during_cleanup)
        receipt['cleanup'] = owned.cleanup() if owned is not None else True
        if not receipt['cleanup']: receipt['status']='failed'
        receipt['seconds'] = round(time.monotonic()-started,3)
        if destination is not None and not destination.exists():
            try:
                with destination.open('x') as target: json.dump(receipt,target,indent=2); target.write('\n')
                os.chmod(destination,0o600)
            except Exception: receipt['status']='failed'
        print(json.dumps(receipt,sort_keys=True))
        for sig,handler in previous.items(): signal.signal(sig,handler)
    return 0 if receipt['status']=='passed' else 1


if __name__ == '__main__':
    os.umask(0o077)
    if len(sys.argv)!=2 or sys.argv[1] not in VARIANTS:
        raise SystemExit('Unsupported experiment')
    raise SystemExit(run(sys.argv[1]))
