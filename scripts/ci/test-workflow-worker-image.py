# Copyright (c) 2026 Memlia. All rights reserved.
"""Packaging recipe contracts; portable tests never qualify Docker/BuildKit."""
import importlib.util
import hashlib
import json
from pathlib import Path
import subprocess
import os
import re
import sys
import threading
import time
import tempfile
import unittest
from contextlib import ExitStack
from types import SimpleNamespace
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('worker_image', HERE/'workflow-worker-image.py')
m = importlib.util.module_from_spec(spec)
if spec.loader is not None and Path(spec.origin).exists():
    spec.loader.exec_module(m)


class ContextTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)/'source'; self.root.mkdir()
        subprocess.run(['git','init','-q',str(self.root)],check=True)
        self.git('config','user.email','fixture@example.invalid')
        self.git('config','user.name','Fictitious Fixture')
        for name in ('package.json','bun.lock','bunfig.toml','patches/fix.patch',
                     'packages/logger/package.json','apps/sim/script.ts',
                     'compliance/upstream/sim/LICENSE',
                     'deploy/memlia/images/workflow-worker.Dockerfile',
                     'deploy/memlia/images/workflow-worker.Dockerfile.dockerignore',
                     'deploy/memlia/images/tests/bun-LICENSE.md'):
            self.write(name, 'FICTITIOUS '+name)

    def git(self,*args):
        return subprocess.check_output(['git','-C',str(self.root),*args],stderr=subprocess.PIPE).decode().strip()

    def write(self,name,text):
        p=self.root/name; p.parent.mkdir(parents=True,exist_ok=True); p.write_text(text)

    def commit(self):
        self.git('add','-A'); self.git('commit','-qm','fictitious fixture')
        return self.git('rev-parse','HEAD')

    def prepare(self,revision=None):
        return m.prepare_context(self.root,self.root.parent/'context',revision or self.commit())

    def test_uses_committed_bytes_not_dirty_worktree_or_untracked_credentials(self):
        rev=self.commit(); old=(self.root/'bun.lock').read_bytes()
        self.write('bun.lock','DIRTY FICTITIOUS LOCK'); self.write('apps/sim/untracked.ts','UNTRACKED')
        result=self.prepare(rev)
        self.assertEqual((self.root.parent/'context/bun.lock').read_bytes(),old)
        self.assertEqual((self.root.parent/'context/build-provenance/source').read_text(),rev+'\n')
        self.assertEqual((self.root.parent/'context/build-provenance/bun.lock').read_bytes(),old)
        self.assertNotIn('apps/sim/untracked.ts',result['sha256'])
        self.assertEqual(result['sourceCommit'],rev)

    def test_forbidden_files_are_excluded_before_context_exists(self):
        names=['apps/sim/.env.local','apps/sim/ee/restricted.ts','packages/a/node_modules/a.js',
               'apps/sim/uploads/private.txt','apps/sim/tls.key','apps/sim/.next/cache.js']
        for name in names:self.write(name,'FICTITIOUS FORBIDDEN')
        result=self.prepare()
        for name in names:
            self.assertNotIn(name,result['sha256']); self.assertFalse((self.root.parent/'context'/name).exists())

    def test_selected_symlink_refuses_and_context_is_not_committed(self):
        (self.root/'apps/sim/link.ts').symlink_to('/etc/passwd')
        with self.assertRaisesRegex(ValueError,'context_refused'):self.prepare()
        self.assertFalse((self.root.parent/'context').exists())

    def test_revision_must_equal_head_and_output_must_be_new(self):
        old=self.commit(); self.write('apps/sim/script.ts','CHANGED'); self.commit()
        with self.assertRaisesRegex(ValueError,'source_refused'):self.prepare(old)
        self.prepare(self.git('rev-parse','HEAD'))
        with self.assertRaisesRegex(ValueError,'context_refused'):self.prepare(self.git('rev-parse','HEAD'))

    def test_missing_required_source_fails_before_build(self):
        (self.root/'bun.lock').unlink()
        with self.assertRaisesRegex(ValueError,'context_refused'):self.prepare()

    def test_bounds_refuse_oversized_member(self):
        rev=self.commit(); original=m.MAX_MEMBER
        try:
            m.MAX_MEMBER=4
            with self.assertRaisesRegex(ValueError,'context_refused'):self.prepare(rev)
        finally:m.MAX_MEMBER=original

    def test_archive_substitution_cannot_rewrite_admitted_source_bytes(self):
        self.write('.gitattributes','apps/sim/readme.txt export-subst\n')
        self.write('apps/sim/readme.txt','$Format:%H$')
        with self.assertRaisesRegex(ValueError,'context_refused'):self.prepare()
        self.assertFalse((self.root.parent/'context').exists())

    def test_overall_context_bound_also_refuses(self):
        rev=self.commit(); original=m.MAX_CONTEXT
        try:
            m.MAX_CONTEXT=8
            with self.assertRaisesRegex(ValueError,'context_refused'):self.prepare(rev)
        finally:m.MAX_CONTEXT=original


class LimitTests(unittest.TestCase):
    def state(self):
        return {'limitBytes':4*1024**3,'swapLimitBytes':0,'cpuMax':[200000,100000],
                'events':{'oom':0,'oom_kill':0},'pidsLimit':512,'swapBytes':0}

    def test_effective_kernel_limits_required_not_only_cli_flags(self):
        m.require_limits(self.state())
        for key,value in [('limitBytes',None),('swapLimitBytes',None),('swapLimitBytes',1),
                          ('cpuMax',[100000,100000]),('pidsLimit',None),('pidsLimit',1024),
                          ('events',{'oom_kill':1}),('events',{}),('swapBytes',1)]:
            with self.subTest(key=key,value=value):
                state=self.state(); state[key]=value
                with self.assertRaisesRegex(ValueError,'limits_refused'):m.require_limits(state)

    def test_cgroup_path_is_from_kernel_and_cannot_select_host_root(self):
        self.assertEqual(m.cgroup_relative('0::/system.slice/docker-abc.scope\n'),
                         Path('system.slice/docker-abc.scope'))
        for data in ('0::/\n','0::/../other\n','1:cpu:/x\n','0::/a\n0::/b\n','0:://x\n'):
            with self.subTest(data=data),self.assertRaisesRegex(ValueError,'cgroup_refused'):
                m.cgroup_relative(data)

    def test_only_fixed_native_build_and_no_registry_output(self):
        command=m.build_args('memlia-worker-fictitious',Path('/tmp/context'),Path('/tmp/work'),'a'*40,'d'*64)
        self.assertIn('--load',command); self.assertIn('--cgroup-parent=/',command)
        self.assertNotIn('--push',command); self.assertNotIn('--allow',command)
        self.assertNotIn('--secret',command); self.assertNotIn('--ssh',command)
        self.assertIn('--platform=linux/amd64',command)
        self.assertIn('MEMLIA_SOURCE_COMMIT='+'a'*40,command)
        self.assertIn('MEMLIA_LOCK_SHA256='+'d'*64,command)
        for source,lock in [('a'*40+'\n','d'*64),('a'*40,''),('a'*40,'d'*64+'\n')]:
            with self.assertRaisesRegex(ValueError,'source_refused'):
                m.build_args('fixed',Path('/tmp/context'),Path('/tmp/work'),source,lock)


class NativeMetadataTests(unittest.TestCase):
    def builder(self):
        return {'Id':'a'*64,'Name':'/buildx_buildkit_memlia-worker-fictitious0',
                'Image':m.BUILDKIT_CONFIG}

    def image(self):
        return {'Id':'sha256:'+'b'*64,'Architecture':'amd64','Os':'linux',
                'Config':{'User':'1001:1001','WorkingDir':'/app/apps/sim',
                          'Cmd':['bun','--no-env-file','--tsconfig-override=tsconfig.json',
                                 'scripts/memlia-workflow-worker.ts'],
                          'Labels':{'org.memlia.worker.campaign':'memlia-worker-fictitious',
                                    'org.memlia.worker.source':'c'*40,'org.memlia.source':'c'*40,'org.memlia.lock':'d'*64}}}

    def test_builder_identity_is_exact_before_owned_mutation(self):
        m.verify_builder(self.builder(),'a'*64,'memlia-worker-fictitious')
        for key,value in [('Id','b'*64),('Name','/different'),('Image','sha256:'+'d'*64)]:
            row=self.builder(); row[key]=value
            with self.subTest(key=key),self.assertRaisesRegex(ValueError,'builder_identity_refused'):
                m.verify_builder(row,'a'*64,'memlia-worker-fictitious')

    def test_built_image_requires_amd64_nonroot_source_and_campaign(self):
        m.verify_image(self.image(),'sha256:'+'b'*64,'memlia-worker-fictitious','c'*40,'d'*64)
        changes=[('Architecture','arm64'),('Os','windows'),('Id','sha256:'+'f'*64)]
        for key,value in changes:
            row=self.image();row[key]=value
            with self.subTest(key=key),self.assertRaisesRegex(ValueError,'image_refused'):
                m.verify_image(row,'sha256:'+'b'*64,'memlia-worker-fictitious','c'*40,'d'*64)
        for key,value in [('User','0:0'),('WorkingDir','/'),('Cmd',['node','wrong.js']),('Labels',{})]:
            row=self.image();row['Config'][key]=value
            with self.subTest(key=key),self.assertRaisesRegex(ValueError,'image_refused'):
                m.verify_image(row,'sha256:'+'b'*64,'memlia-worker-fictitious','c'*40,'d'*64)

        for key in ('org.memlia.source','org.memlia.lock'):
            row=self.image();row['Config']['Labels'][key]='f'*64
            with self.assertRaisesRegex(ValueError,'image_refused'):
                m.verify_image(row,'sha256:'+'b'*64,'memlia-worker-fictitious','c'*40,'d'*64)

    def test_non_linux_host_refuses_before_any_output_or_docker(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(m.platform,'system',return_value='Darwin'):
            output=Path(tmp)/'output'
            with self.assertRaisesRegex(ValueError,'host_refused'):m.run('a'*40,output)
            self.assertFalse(output.exists())

    def test_workflow_has_no_automatic_or_privileged_pr_trigger(self):
        text=(HERE.parents[1]/'.github/workflows/memlia-workflow-worker-image.yml').read_text()
        self.assertNotIn('pull_request',text);self.assertNotIn('push:',text)
        self.assertNotIn('secrets.',text);self.assertNotIn('write',text)
        self.assertNotIn('upload-artifact',text);self.assertNotIn('setup-buildx',text)
        self.assertIn('workflow_call:',text);self.assertNotIn('workflow_dispatch:',text)
        self.assertIn('contents: read',text)
        self.assertIn('runs-on: ubuntu-24.04',text)
        self.assertIn('persist-credentials: false',text)


class WorkflowSelectionTests(unittest.TestCase):
    def setUp(self):
        root=HERE.parents[1]/'.github/workflows'
        self.caller=(root/'memlia-linux-swap-build.yml').read_text()
        self.called=(root/'memlia-workflow-worker-image.yml').read_text()

    def job(self,text,name):
        return re.search(r'^  '+name+r':\n(.*?)(?=^  \S|\Z)',text,re.M|re.S).group(1)

    def selected(self,text,name,event='workflow_dispatch',worker=False,
                 private=False,repository='saphiron222/memlia',expected=None):
        # Evaluate these boolean/equality guards on typed dispatch inputs only.
        # This is a contract truth table, not a GitHub Actions engine emulator.
        expression=re.search(r'^    if: (.+)$',self.job(text,name),re.M).group(1)
        expression=expression.replace('&&',' and ').replace('||',' or ')
        expression=re.sub(r'\btrue\b','True',expression)
        expression=re.sub(r'\bfalse\b','False',expression)
        github=SimpleNamespace(event_name=event,repository=repository,sha='a'*40,
                               event=SimpleNamespace(repository=SimpleNamespace(private=private)))
        inputs=SimpleNamespace(worker_image=worker,expected_source_sha=expected or github.sha)
        return eval(expression,{'__builtins__':{}},{'github':github,'inputs':inputs})

    def test_existing_entry_keeps_next_as_the_boolean_default(self):
        dispatch=self.caller.split('  workflow_dispatch:\n',1)[1].split('  push:\n',1)[0]
        self.assertRegex(dispatch,r'worker_image:\n(?:.*\n)*?        type: boolean\n        default: false\n')
        for worker in (False,None):
            with self.subTest(worker=worker):
                self.assertTrue(self.selected(self.caller,'measure',worker=worker))
                self.assertFalse(self.selected(self.caller,'worker-image',worker=worker))

    def test_explicit_worker_selection_excludes_all_next_matrix_jobs(self):
        self.assertTrue(self.selected(self.caller,'worker-image',worker=True))
        self.assertFalse(self.selected(self.caller,'measure',worker=True))
        self.assertTrue(self.selected(self.called,'packaging'))

    def test_worker_refuses_automatic_private_and_foreign_contexts(self):
        contexts=[{'event':event} for event in ('push','pull_request','schedule','workflow_call')]
        contexts.extend([{'private':True},{'repository':'fictitious-fork/memlia'}])
        for context in contexts:
            with self.subTest(context=context):
                self.assertFalse(self.selected(self.caller,'worker-image',worker=True,**context))
                self.assertFalse(self.selected(self.called,'packaging',**context))
        self.assertTrue(self.selected(self.caller,'measure',event='push',worker=None))
        self.assertFalse(self.selected(self.caller,'measure',private=True))

    def test_local_call_and_checkout_bind_the_same_running_source_sha(self):
        job=self.job(self.caller,'worker-image')
        self.assertIn('uses: ./.github/workflows/memlia-workflow-worker-image.yml\n',job)
        self.assertIn('expected_source_sha: ${{ github.sha }}\n',job)
        self.assertNotIn('secrets:',job);self.assertNotIn('steps:',job)
        self.assertIn('ref: ${{ github.sha }}\n',self.job(self.called,'packaging'))
        self.assertIn('EXPECTED_SOURCE_SHA: ${{ inputs.expected_source_sha }}',self.called)
        self.assertIn('--expected-commit "$EXPECTED_SOURCE_SHA"',self.called)
        self.assertFalse(self.selected(self.called,'packaging',expected='b'*40))

    def test_both_paths_keep_read_only_permissions_and_existing_bounds(self):
        for text in (self.caller,self.called):
            permissions=text.split('permissions:\n',1)[1].split('concurrency:\n',1)[0]
            self.assertEqual(permissions,'  contents: read\n')
            self.assertNotIn('secrets:',text);self.assertNotIn('pull_request:',text)
            self.assertNotIn('upload-artifact',text)
        measure=self.job(self.caller,'measure')
        self.assertIn('timeout-minutes: 120',measure)
        self.assertIn('variant: [turbopack, webpack, turbopack-zram]',measure)
        self.assertIn('run: bash scripts/ci/run-linux-build.sh --swap "$MEMLIA_VARIANT"',measure)
        self.assertIn('branches: [build/linux-swap-measurement]',self.caller)
        self.assertIn('timeout-minutes: 25',self.called)
        self.assertIn('timeout --signal=TERM --kill-after=60s 1200s',self.called)


class BuildClientTests(unittest.TestCase):
    def test_real_client_has_closed_environment_and_bounded_private_log(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ,{'MEMLIA_BUILD_CANARY':'FICTITIOUS'}):
            code="import os; assert 'MEMLIA_BUILD_CANARY' not in os.environ; print('fixed-progress')"
            result=m.owned_client([sys.executable,'-I','-B','-c',code],Path(tmp),time.monotonic()+3,threading.Event(),capture=True)
            self.assertEqual(result,b'fixed-progress\n')
            self.assertEqual((Path(tmp)/'build.private.log').read_bytes(),result)

    def test_cumulative_output_cap_cannot_reset_between_commands(self):
        with tempfile.TemporaryDirectory() as tmp,patch.object(m,'MAX_LOG',8):
            (Path(tmp)/'build.private.log').write_bytes(b'1234567')
            with self.assertRaisesRegex(ValueError,'recipe_build_log_limit'):
                m.owned_client([sys.executable,'-c',"print('ab')"],Path(tmp),time.monotonic()+3,threading.Event())
            self.assertEqual((Path(tmp)/'build.private.log').read_bytes(),b'1234567')

    def test_real_exited_client_cannot_leave_live_plugin_or_recycle_group(self):
        with tempfile.TemporaryDirectory() as tmp:
            # Parent exits immediately, plugin inherits the open output pipe.
            code="import subprocess,sys; p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)']);open('plugin.pid','w').write(str(p.pid))"
            with self.assertRaisesRegex(ValueError,'recipe_build_interrupted'):
                m.owned_client([sys.executable,'-I','-B','-c',code],Path(tmp),time.monotonic()+.4,threading.Event())
            pid=int((Path(tmp)/'plugin.pid').read_text())
            deadline=time.monotonic()+2
            while time.monotonic()<deadline:
                try:os.kill(pid,0)
                except ProcessLookupError:break
                time.sleep(.02)
            else:self.fail('owned plugin identity remains after leader exit')

    def test_live_plugin_closing_its_pipes_cannot_be_reported_as_success(self):
        with tempfile.TemporaryDirectory() as tmp:
            code="import subprocess,sys; p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);open('plugin.pid','w').write(str(p.pid))"
            with self.assertRaisesRegex(ValueError,'client_ownership_refused'):
                m.owned_client([sys.executable,'-I','-B','-c',code],Path(tmp),time.monotonic()+3,threading.Event())
            pid=int((Path(tmp)/'plugin.pid').read_text())
            with self.assertRaises(ProcessLookupError):os.kill(pid,0)

    def test_real_cancel_and_nonzero_exit_refuse_after_owned_client_is_waited(self):
        for code,cancel in [('raise SystemExit(3)',threading.Event()),('import time; time.sleep(30)',threading.Event())]:
            with tempfile.TemporaryDirectory() as tmp:
                timer=threading.Timer(.1,cancel.set);timer.start()
                try:
                    with self.assertRaisesRegex(ValueError,'recipe_build_(failed|interrupted)'):
                        m.owned_client([sys.executable,'-I','-B','-c',code],Path(tmp),time.monotonic()+3,cancel)
                finally:timer.join()


class RecipeFlowTests(unittest.TestCase):
    setUp=ContextTests.setUp
    git=ContextTests.git
    write=ContextTests.write
    commit=ContextTests.commit
    """Docker/namespace doubles exercise refusal order, never qualify Linux."""
    def test_limits_failure_never_starts_product_build_and_closes_owned_builder(self):
        result,calls=self.flow(bad_limits=True)
        self.assertEqual(result['status'],'failed')
        self.assertNotIn('product-build',calls)
        self.assertIn('remove-owned-builder',calls)
        self.assertTrue(result['cleanup'])

    def test_bootstrap_without_ack_keeps_unknown_and_never_removes_by_name(self):
        result,calls=self.flow(bootstrap_failure=True)
        self.assertEqual(result['status'],'failed')
        self.assertTrue(result['serverStateUnknown'])
        self.assertFalse(result['cleanup'])
        self.assertNotIn('product-build',calls)
        self.assertNotIn('remove-owned-builder',calls)

    def test_known_success_stops_and_removes_only_acknowledged_ids(self):
        result,calls=self.flow()
        self.assertEqual(result['status'],'passed')
        self.assertFalse(result['workerDatabaseQualified'])
        self.assertFalse(result['composeActivated'])
        self.assertTrue(result['limitsVerifiedBeforeBuild'])
        self.assertLess(calls.index('update-pids'),calls.index('product-build'))
        self.assertLess(calls.index('stop-owned-builder'),calls.index('remove-owned-builder'))

    def test_build_transport_failure_keeps_output_unknown_without_retry(self):
        result,calls=self.flow(build_failure=True)
        self.assertEqual(result['status'],'failed')
        self.assertTrue(result['imageStateUnknown'])
        self.assertFalse(result['cleanup'])
        self.assertEqual(calls.count('product-build'),1)
        self.assertIn('remove-owned-builder',calls)

    def flow(self,bad_limits=False,bootstrap_failure=False,build_failure=False):
        revision=self.commit(); output=self.root.parent/'receipt'; calls=[]
        group=self.root.parent/'group';group.mkdir();(group/'pids.max').write_text('512')
        cid='a'*64;image='sha256:'+'b'*64; running=True;present=True;volume=True
        name='memlia-worker-'+'c'*32
        metadata=NativeMetadataTests()
        def command(argv,payload,deadline,cancel,cwd,limit):
            nonlocal running,present,volume
            args=argv[len(m.DOCKER):]
            if args[0]=='info':return json.dumps({'OSType':'linux','Architecture':'x86_64',
                 'CgroupVersion':'2','DockerRootDir':'/var/lib/docker'}).encode()
            if args[0]=='version':return b'"29.1.0"'
            if args[:2]==['buildx','version']:return b'github.com/docker/buildx v0.31.1 '+b'd'*40
            if args[:2]==['buildx','create']:return name.encode()
            if args[:2] in (['container','ls'],['volume','ls']):return b''
            if args[:2]==['container','inspect']:
                row={'Id':cid,'Name':'/buildx_buildkit_'+name+'0','Image':m.BUILDKIT_CONFIG,
                     'Mounts':[{'Destination':'/var/lib/buildkit','Type':'volume',
                                'Name':'buildx_buildkit_'+name+'0_state'}],
                     'HostConfig':{'Memory':4*1024**3,'MemorySwap':4*1024**3,
                       'CpuQuota':200000,'CpuPeriod':100000,'PidsLimit':512,'Privileged':True},
                     'State':{'Running':running,'OOMKilled':False,'Pid':999999}}
                if bad_limits:row['HostConfig']['Memory']=0
                return json.dumps([row]).encode()
            if args[:2]==['container','update']:
                self.assertEqual(args[-1],cid);calls.append('update-pids');return cid.encode()
            if args[:2]==['container','exec']:return b'0::/\n'
            if args[:2]==['container','stop']:
                self.assertEqual(args[-1],cid);running=False;calls.append('stop-owned-builder');return cid.encode()
            if args[:2]==['container','rm']:
                self.assertEqual(args[-1],cid);present=False;calls.append('remove-owned-builder');return cid.encode()
            if args[:2]==['volume','rm']:
                self.assertEqual(args[-1],'buildx_buildkit_'+name+'0_state');volume=False;return b'fixed'
            if args[:2]==['image','inspect']:
                row=metadata.image();row['Config']['Labels']['org.memlia.worker.campaign']=name
                row['Config']['Labels']['org.memlia.worker.source']=revision
                row['Config']['Labels']['org.memlia.source']=revision
                row['Config']['Labels']['org.memlia.lock']=hashlib.sha256((self.root/'bun.lock').read_bytes()).hexdigest()
                return json.dumps([row]).encode()
            if args[:2]==['image','rm']:
                self.assertEqual(args[-1],image);return b'fixed'
            self.fail('unexpected Docker command')
        def build(args,work,deadline,cancel):
            if args[:2]==['buildx','inspect']:
                if bootstrap_failure:raise ValueError('recipe_build_failed')
            else:
                calls.append('product-build')
                if build_failure:raise ValueError('recipe_build_failed')
                (work/'image.iid').write_text(image)
        native=SimpleNamespace(_command=command,_one=lambda raw:json.loads(raw)[0])
        kernel=LimitTests().state();kernel.update(peakBytes=1,pids=[])
        metrics=SimpleNamespace(cgroup_read=lambda _:kernel,identities=lambda _:{})
        original_read=Path.read_text
        def read(path,*a,**kw):
            if str(path)=='/proc/999999/cgroup':return '0::/owned-test-group\n'
            return original_read(path,*a,**kw)
        with ExitStack() as stack:
            stack.enter_context(patch.object(m,'ROOT',self.root))
            stack.enter_context(patch.object(m.platform,'system',return_value='Linux'))
            stack.enter_context(patch.object(m.platform,'machine',return_value='x86_64'))
            stack.enter_context(patch.object(m,'load',side_effect=[native,metrics]))
            def client(argv,work,deadline,cancel,**kwargs):
                kwargs['receipt'].update(pid=999998,waited=True,groupClosed=True)
                args=argv[len(m.DOCKER):]
                if args[:2] in (['buildx','inspect'],['buildx','build']):
                    build(args,work,deadline,cancel);return b''
                return command(argv,b'',deadline,cancel,work,1024**2)
            stack.enter_context(patch.object(m,'owned_client',side_effect=client))
            stack.enter_context(patch.object(m.shutil,'disk_usage',return_value=SimpleNamespace(free=14*1024**3)))
            stack.enter_context(patch.object(m.uuid,'uuid4',return_value=SimpleNamespace(hex='c'*32)))
            stack.enter_context(patch.object(m.os,'readlink',side_effect=['private','host']))
            stack.enter_context(patch.object(m,'cgroup_relative',return_value=group))
            stack.enter_context(patch.object(Path,'read_text',read))
            stack.enter_context(patch('builtins.print'))
            code=m.run(revision,output)
        result=json.loads((output/'result.json').read_text())
        self.assertEqual(code,0 if result['status']=='passed' else 1)
        return result,calls


if __name__=='__main__':unittest.main()
