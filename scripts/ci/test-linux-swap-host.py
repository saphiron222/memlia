# Copyright 2026 Memlia. All rights reserved.
import importlib.util
import contextlib
import io
import unittest
import os
import sys
import json
import subprocess
import tempfile
import signal
import time
from unittest.mock import patch
from pathlib import Path

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location('swap_host', HERE / 'linux-swap-host.py')
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)
GIB = 1024**3


class AANativeLinuxInventoryTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform=='linux','native procfs read requires Linux')
    def test_real_inventory_read_before_experiment_without_mock_or_allocation(self):
        # No patch, sudo, swapon or fixture allocation: this is the actual Linux ABI.
        rows=host.swaps()
        self.assertTrue(isinstance(rows,dict) and len(rows)<=128,'bounded inventory required')
        for name,row in rows.items():
            self.assertTrue(isinstance(name,str) and name.startswith('/'),'absolute identity required')
            self.assertTrue(row['name']==name and row['type'] in ('file','partition'),'closed row shape required')
            self.assertTrue(0<=row['used']<=row['size']<=2**63-1,'bounded byte counters required')
            self.assertTrue(-32768<=row['prio']<=32767,'bounded priority required')


class BoundedInventoryTests(unittest.TestCase):
    header=b'Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n'

    def test_swaps_reads_constant_procfs_path_with_cap_and_no_subprocess(self):
        fixture=self.header+b'/system-swap file 4096 1024 -2\n'
        class Source(io.BytesIO):
            def read(self, size=-1):
                self_size=size
                if self_size!=65537: raise AssertionError('read must be explicitly bounded')
                return super().read(size)
        def opened(path, mode):
            self.assertEqual(path,'/proc/swaps'); self.assertEqual(mode,'rb')
            return Source(fixture)
        with patch('builtins.open',side_effect=opened), patch.object(host,'command',side_effect=AssertionError('inventory must not invoke swapon')):
            self.assertEqual(host.swaps(),{'/system-swap':{'name':'/system-swap','type':'file','size':4194304,'used':1048576,'prio':-2}})

    def test_empty_inventory_is_valid_but_empty_file_is_not(self):
        self.assertEqual(host.parse_proc_swaps(self.header),{})
        with self.assertRaises(host.Refused): host.parse_proc_swaps(b'')

    def test_octal_names_are_decoded_once_and_units_are_kib(self):
        fixture=self.header+br'/space\040tab\011line\012back\134040 file 8192 0 10'+b'\n'+b'/dev/zram0\tpartition\t2048\t3\t100\n'
        rows=host.parse_proc_swaps(fixture)
        self.assertEqual(set(rows),{'/space tab\tline\nback\\040','/dev/zram0'})
        self.assertEqual(rows['/dev/zram0']['size'],2048*1024)
        self.assertEqual(rows['/dev/zram0']['used'],3*1024)
        self.assertEqual(rows['/dev/zram0']['prio'],100)

    def test_non_utf8_identity_is_roundtripped_without_replacement(self):
        rows=host.parse_proc_swaps(self.header+b'/byte-\xff file 1 0 -1\n')
        self.assertEqual(os.fsencode(next(iter(rows))),b'/byte-\xff')

    def test_malformed_truncated_duplicate_or_oversized_inventory_refused(self):
        bad=[b'wrong header\n', self.header+b'/a file 1 0 1',
             self.header+b'/a file 1 2 1\n', self.header+b'/a device 1 0 1\n',
             self.header+b'relative file 1 0 1\n', self.header+b'/a file -1 0 1\n',
             self.header+b'/a file 1 0 32768\n',self.header+b'/a file 1 0 -32769\n',
             self.header+b'/a file 9999999999999999999 0 1\n',
             self.header+b'/a file 1 0 1 extra\n',self.header+b'/a\0 file 1 0 1\n',
             self.header+br'/a\999 file 1 0 1'+b'\n',
             self.header+br'/a\134 file 1 0 1'+b'\n'+br'/a\134 file 1 0 1'+b'\n',
             self.header+b'/a file 1 0 1\n'*129, b'x'*65537]
        for index,data in enumerate(bad):
            with self.subTest(index=index):
                with self.assertRaises(host.Refused) as caught: host.parse_proc_swaps(data)
                self.assertEqual(str(caught.exception),'swap_inventory_invalid')

    def test_unavailable_inventory_has_fixed_error_without_os_path(self):
        with patch('builtins.open',side_effect=OSError('PRIVATE_PATH_CANARY')):
            with self.assertRaises(host.Refused) as caught: host.swaps()
        self.assertEqual(str(caught.exception),'swap_inventory_unavailable')

    def test_inventory_suite_precedes_ci_allocation_step(self):
        workflow=(HERE.parents[1]/'.github/workflows/memlia-linux-swap-build.yml').read_text()
        self.assertLess(workflow.index('python3 scripts/ci/test-linux-swap-host.py'),workflow.index('run: bash scripts/ci/run-linux-build.sh --swap'))


class ClosedPreflightDiagnosticsTests(unittest.TestCase):
    def test_prerequisite_failures_have_distinct_fixed_codes(self):
        for key,value,code in [('system','other','environment_unavailable'),('public',False,'environment_unavailable'),
                ('filesystem','arbitrary-path-canary','filesystem_unsupported'),('freeBytes',1,'disk_capacity_insufficient'),
                ('memoryBytes',1,'memory_capacity_insufficient')]:
            snapshot=HostPreflightTests().good(); snapshot[key]=value
            with self.subTest(key=key),self.assertRaises(host.Refused) as caught: host.validate_host(snapshot)
            self.assertEqual(caught.exception.code,code)

    def test_receipt_retains_only_fixed_code_and_owned_metadata_before_child(self):
        for error,expected in [(host.Refused('swap_inventory_invalid'),'swap_inventory_invalid'),(RuntimeError('PRIVATE_CANARY'),'host_operation_unavailable')]:
            with tempfile.TemporaryDirectory() as temporary:
                def preflight(_temporary,_work,observed):
                    observed.update(memoryBytes=16*GIB,filesystem='ext4')
                    raise error
                output=io.StringIO()
                with patch.dict(os.environ,{'RUNNER_TEMP':temporary}), patch.object(host,'preflight',side_effect=preflight), \
                     patch.object(host.OwnedSwap,'prepare') as allocate, patch.object(host,'run_child') as child, contextlib.redirect_stdout(output):
                    self.assertEqual(host.run('webpack'),1)
                allocate.assert_not_called(); child.assert_not_called()
                receipt=json.loads(output.getvalue())
                self.assertEqual(receipt['status'],'not_tested'); self.assertTrue(receipt['cleanup'])
                self.assertEqual(receipt['diagnostic'],{'stage':'preflight','code':expected})
                self.assertEqual(receipt['preflight'],{'memoryBytes':16*GIB,'filesystem':'ext4'})
                self.assertNotIn('PRIVATE_CANARY',output.getvalue());self.assertNotIn(temporary,output.getvalue())
                self.assertNotIn('child',receipt)

    def test_real_preflight_collects_closed_metadata_and_refuses_raw_filesystem(self):
        memory=b'MemTotal:       16777216 kB\nMemAvailable: 14680064 kB\n'
        def opened(path, mode):
            if path!='/proc/meminfo' or mode!='rb': raise AssertionError('unexpected read')
            return io.BytesIO(memory)
        def execute(args,data=None):
            if args[0]=='findmnt': return 'PRIVATE_FS_CANARY'
            if args[0]=='df': return 'Avail\n42949672960'
            raise AssertionError('no privileged operation before refusal')
        observed={}
        with patch.object(host.platform,'system',return_value='Linux'), \
             patch.dict(os.environ,{'MEMLIA_PUBLIC_RUN':'1','GITHUB_ACTIONS':'true','RUNNER_OS':'Linux'}), \
             patch.object(host,'swaps',return_value={'PRIVATE_SWAP_CANARY':{}}), \
             patch('builtins.open',side_effect=opened),patch.object(host,'command',side_effect=execute):
            with self.assertRaises(host.Refused) as caught: host.preflight(Path('/fixture'),Path('/fixture-work'),observed)
        self.assertEqual(caught.exception.code,'filesystem_unsupported')
        self.assertEqual(observed,{'system':'Linux','public':True,'runner':True,'preexistingSwapCount':1,
                                  'memoryBytes':16*GIB,'availableBytes':14*GIB,'filesystem':'other',
                                  'freeBytes':40*GIB,'workFreeBytes':40*GIB})
        self.assertNotIn('PRIVATE',json.dumps(observed))

    def test_unknown_refusal_text_cannot_become_a_diagnostic(self):
        error=host.Refused('PRIVATE_CANARY')
        self.assertEqual(error.code,'host_operation_unavailable')
        self.assertEqual(str(error),'host_operation_unavailable')

    def test_missing_tool_and_nonzero_tool_output_never_expose_raw_text(self):
        for outcome in [FileNotFoundError('PRIVATE_CANARY'),subprocess.TimeoutExpired(['PRIVATE_CANARY'],30)]:
            with patch.object(host.subprocess,'run',side_effect=outcome):
                with self.assertRaises(host.Refused) as caught: host.command(['fake'])
            self.assertEqual(str(caught.exception),'tool_unavailable')
        with patch.object(host.subprocess,'run',return_value=subprocess.CompletedProcess(['fake'],1,'PRIVATE_CANARY','PRIVATE_CANARY')):
            with self.assertRaises(host.Refused) as caught: host.command(['fake'])
        self.assertEqual(str(caught.exception),'host_operation_unavailable')

class HostPreflightTests(unittest.TestCase):
    def good(self):
        return {'system':'Linux','public':True,'runner':True,'filesystem':'ext4',
                'freeBytes':40*GIB,'workFreeBytes':40*GIB,'memoryBytes':16*GIB,
                'availableBytes':14*GIB,'swapNames':['/existing-system-swap']}

    def test_refuses_unavailable_capacity_or_wrong_host_before_allocating(self):
        for key,value in [('system','Darwin'),('public',False),('runner',False),
                          ('filesystem','overlay'),('freeBytes',35*GIB),
                          ('workFreeBytes',11*GIB),('memoryBytes',13*GIB),('availableBytes',12*GIB)]:
            with self.subTest(key=key):
                snapshot=self.good(); snapshot[key]=value
                with self.assertRaises(host.Refused): host.validate_host(snapshot)

    def test_existing_swap_is_allowed_without_becoming_owned(self):
        snapshot=self.good()
        host.validate_host(snapshot)
        self.assertEqual(snapshot['swapNames'],['/existing-system-swap'])

class OwnershipAndChildTests(unittest.TestCase):
    def owned_file(self, root):
        directory=root/'owned'; directory.mkdir()
        owner=host.OwnedSwap(directory)
        owner.path.write_bytes(b'fictitious small file')
        owner.path.chmod(0o600)
        info=owner.path.stat(); owner.identity=(info.st_dev,info.st_ino)
        return owner

    def test_claimed_host_ready_requires_a_real_owned_active_swap(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary).resolve(); directory=root/'memlia-swap.fixture'; directory.mkdir()
            path=directory/'swapfile'; path.write_bytes(b'x'*4096); path.chmod(0o600)
            with patch.object(host,'DISK_BYTES',4096):
                with patch.object(host,'swaps',return_value={}):
                    with self.assertRaises(host.Refused): host.verify_active_swap(root,path)
                with patch.object(host,'swaps',return_value={str(path):{'size':4096,'prio':10}}):
                    host.verify_active_swap(root,path)
                    path.chmod(0o644)
                    with self.assertRaises(host.Refused): host.verify_active_swap(root,path)
                path.chmod(0o600)
                with patch.object(host,'swaps',return_value={str(path):{'size':4096,'prio':9}}):
                    with self.assertRaises(host.Refused): host.verify_active_swap(root,path)

    def test_cleanup_removes_only_owned_swap_and_preserves_preexisting_device(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); sentinel=root/'foreign'; sentinel.write_text('keep')
            owner=self.owned_file(root)
            active={str(owner.path):{},str(sentinel):{}}
            def execute(args,data=None):
                self.assertEqual(args,['sudo','-n','swapoff',str(owner.path)])
                del active[str(owner.path)]
                return ''
            with patch.object(host,'swaps',side_effect=lambda:dict(active)), patch.object(host,'command',side_effect=execute):
                self.assertTrue(owner.cleanup())
            self.assertEqual(sentinel.read_text(),'keep')
            self.assertIn(str(sentinel),active)
            self.assertFalse(owner.directory.exists())

    def test_swapoff_failure_retains_owned_file_and_returns_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            owner=self.owned_file(Path(temporary))
            with patch.object(host,'swaps',return_value={str(owner.path):{}}), patch.object(host,'command',side_effect=host.Refused()):
                self.assertFalse(owner.cleanup())
            self.assertTrue(owner.path.exists())

    def test_replaced_file_is_not_deleted_or_swapped_off(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); owner=self.owned_file(root)
            owner.path.rename(root/'original')
            owner.path.write_text('foreign replacement'); owner.path.chmod(0o600)
            with patch.object(host,'command') as command:
                self.assertFalse(owner.cleanup())
                command.assert_not_called()
            self.assertEqual(owner.path.read_text(),'foreign replacement')

    def test_unknown_zram_allocation_cannot_claim_cleanup_success(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory=Path(temporary)/'owned'; directory.mkdir()
            owner=host.OwnedSwap(directory); owner.zram_allocation_pending=True
            self.assertFalse(owner.cleanup())

    def test_zram_metrics_separate_logical_compressed_physical_and_swap_usage(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary); owner=self.owned_file(root)
            owner.zram='/dev/zram999999'; owner.zram_sys=root/'zram'; owner.zram_sys.mkdir()
            (owner.zram_sys/'mm_stat').write_text('4096 1024 1536 536870912 2048 0 0 0')
            with patch.object(host,'swaps',return_value={str(owner.path):{'used':900},owner.zram:{'used':8192}}):
                self.assertEqual(owner.sample(),{'diskSwapUsedBytes':900,'zramOriginalBytes':4096,'zramCompressedBytes':1024,'zramPhysicalBytes':1536,'zramPhysicalPeakBytes':2048,'zramDeviceSwapUsedBytes':8192})

    def test_real_child_failure_and_timeout_do_not_pass_or_publish_raw_output(self):
        for program,timeout,reason in [('print("PRIVATE_CANARY"); raise SystemExit(7)',5,None),('import time; time.sleep(30)',0.05,'timeout')]:
            with tempfile.TemporaryFile() as output:
                receipt=host.run_child([sys.executable,'-c',program],output,lambda:{'diskSwapUsedBytes':3},timeout)
            self.assertNotEqual(receipt['exitCode'],0)
            self.assertEqual(receipt['reason'],reason)
            self.assertNotIn('PRIVATE_CANARY',json.dumps(receipt))

    def test_cancellation_during_owned_resource_cleanup_cannot_publish_success(self):
        with tempfile.TemporaryDirectory() as temporary:
            def cleanup(_owner):
                os.kill(os.getpid(),signal.SIGTERM)
                return True
            output=io.StringIO()
            with patch.dict(os.environ,{'RUNNER_TEMP':temporary}), \
                    patch.object(host,'preflight',return_value=HostPreflightTests().good()), \
                    patch.object(host.OwnedSwap,'prepare'), \
                    patch.object(host.OwnedSwap,'cleanup',cleanup), \
                    patch.object(host,'run_child',return_value={'exitCode':0,'reason':None}), \
                    contextlib.redirect_stdout(output):
                code=host.run('webpack')
            receipt=json.loads((Path(temporary)/'memlia-swap-host.json').read_text())
            self.assertEqual(code,1)
            self.assertEqual(receipt['status'],'failed')
            self.assertEqual(receipt['reason'],'interrupted')
            self.assertTrue(receipt['cleanup'])
            self.assertEqual(json.loads(output.getvalue()),receipt)

    def test_interruption_after_natural_exit_or_during_cleanup_cannot_pass(self):
        for boundary in (0, signal.SIGTERM):
            with self.subTest(boundary=boundary):
                original=os.killpg
                sent=False
                def barrier(pgid, sig):
                    nonlocal sent
                    if sig==boundary and not sent:
                        sent=True
                        os.kill(os.getpid(),signal.SIGTERM)
                    return original(pgid,sig)
                with tempfile.TemporaryFile() as output, patch.object(host.os,'killpg',side_effect=barrier):
                    receipt=host.run_child([sys.executable,'-c','pass'],output,lambda:{},5)
                self.assertTrue(sent)
                self.assertEqual(receipt['exitCode'],0)
                self.assertEqual(receipt['reason'],'interrupted')

    def test_exited_runner_cannot_abandon_a_term_resistant_descendant(self):
        with tempfile.TemporaryDirectory() as temporary, tempfile.TemporaryFile() as output:
            root=Path(temporary); ready=root/'ready'; pidfile=root/'pid'
            descendant=f"import os,signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); open({str(ready)!r},'w').write('ready'); time.sleep(30)"
            program=(f"import subprocess,sys,time; from pathlib import Path; p=subprocess.Popen([sys.executable,'-c',{descendant!r}]); "
                     f"Path({str(pidfile)!r}).write_text(str(p.pid)); "
                     f"\nwhile not Path({str(ready)!r}).exists(): time.sleep(.01)\n")
            receipt=host.run_child([sys.executable,'-c',program],output,lambda:{},5)
            pid=int(pidfile.read_text())
            def running():
                result=subprocess.run(['ps','-p',str(pid),'-o','stat='],capture_output=True,text=True)
                return bool(result.stdout.strip()) and not result.stdout.strip().startswith('Z')
            try:
                self.assertEqual(receipt['reason'],'descendants')
                for _ in range(20):
                    if not running(): break
                    time.sleep(.05)
                self.assertFalse(running())
            finally:
                if running(): os.kill(pid,signal.SIGKILL)

    @unittest.skipUnless(sys.platform!='linux','portable negative: no Linux host operations on this platform')
    def test_non_linux_entry_refuses_without_creating_swap_resources(self):
        with tempfile.TemporaryDirectory() as temporary:
            env={**os.environ,'RUNNER_TEMP':temporary}
            result=subprocess.run([sys.executable,str(HERE/'linux-swap-host.py'),'webpack'],env=env,capture_output=True,text=True,timeout=5)
            self.assertEqual(result.returncode,1)
            receipt=json.loads(result.stdout)
            self.assertEqual(receipt['status'],'not_tested')
            self.assertTrue(receipt['cleanup'])
            self.assertEqual(sorted(p.name for p in Path(temporary).iterdir()),['memlia-swap-host.json'])

if __name__ == '__main__': unittest.main()
