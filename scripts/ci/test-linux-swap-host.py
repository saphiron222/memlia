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
