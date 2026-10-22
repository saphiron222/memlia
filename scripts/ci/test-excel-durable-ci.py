# Copyright 2026 Memlia. All rights reserved.
"""Preparation boundaries only: Docker/Compose/browser execution is not simulated qualification."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('ci',Path(__file__).with_name('excel-durable-ci.py'))
ci=importlib.util.module_from_spec(spec);spec.loader.exec_module(ci)

class Preparation(unittest.TestCase):
    def test_five_builds_exact_source_origin_and_local_registry(self):
        for name in ci.APPS:
            args=ci.build_arguments('owned',Path('/context'),name,'a'*40,'b'*64,'c'*32)
            self.assertIn('MEMLIA_SOURCE_COMMIT='+'a'*40,args)
            self.assertIn('MEMLIA_LOCK_SHA256='+'b'*64,args)
            self.assertIn('127.0.0.1:15000/c'+('c'*32)+'/'+name+':candidate',args)
            self.assertIn('--load',args);self.assertNotIn('--push',args)
            self.assertEqual('NEXT_PUBLIC_APP_URL=https://localhost:18443' in args,name=='web')
        with self.assertRaises(ValueError):ci.build_arguments('owned',Path('/c'),'foreign','a'*40,'b'*64,'c'*32)
    def test_registry_observation_cannot_substitute_foreign_digest_or_source(self):
        row={'Id':'sha256:'+'d'*64,'Os':'linux','Architecture':'amd64','RepoDigests':['127.0.0.1:15000/c'+('c'*32)+'/web@sha256:'+'e'*64], 'Config':{'Labels':{'org.memlia.source':'a'*40,'org.memlia.lock':'b'*64,'org.memlia.durable-ci':'c'*32}}}
        got=ci.image_record(row,'web','a'*40,'b'*64,'c'*32)
        self.assertEqual(got['imageId'],row['Id'])
        for change in ({'Architecture':'arm64'},{'RepoDigests':['external.invalid/web@sha256:'+'e'*64]}, {'Id':'bad'}):
            with self.subTest(change=change),self.assertRaises(ValueError):ci.image_record(row|change,'web','a'*40,'b'*64,'c'*32)
        row['Config']['Labels']['org.memlia.source']='f'*40
        with self.assertRaises(ValueError):ci.image_record(row,'web','a'*40,'b'*64,'c'*32)
    def test_private_configuration_five_roles_and_no_provider(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d);images={n:{'reference':'127.0.0.1:15000/c'+('c'*32)+'/'+n+'@sha256:'+'e'*64} for n in ci.APPS}
            env,bootstrap=ci.configuration_values(p,'c'*32,images)
            self.assertEqual(set(bootstrap['urls']),{'migrate','web','realtime','worker','transport'})
            self.assertEqual(len(set(bootstrap['urls'].values())),5)
            self.assertEqual(env['DATABASE_URL'],bootstrap['urls']['web'])
            self.assertEqual(env['DATABASE_URL_WORKFLOW_WORKER'],bootstrap['urls']['worker'])
            self.assertEqual(env['MEMLIA_PG_BOSS_DATABASE_URL'],bootstrap['urls']['transport'])
            self.assertEqual(env['NEXT_PUBLIC_APP_URL'],'https://localhost:18443')
            self.assertEqual(env['AUTH_TRUSTED_PROXIES'],'')
            self.assertFalse(any(env.get(k) for k in ('OPENAI_API_KEY','ANTHROPIC_API_KEY','OLLAMA_URL')))
    def test_closed_projection_does_not_echo_unknown_keys_or_errors(self):
        source={'status':'failed','phase':'images','error':'PRIVATE_CANARY','images':{},'cleanup':False}
        got=ci.project(source)
        self.assertNotIn('CANARY',json.dumps(got));self.assertNotIn('error',got)
        with self.assertRaises(ValueError):ci.project(source|{'phase':'PRIVATE_CANARY'})
        with self.assertRaises(ValueError):ci.project(source|{'status':'passed','phase':'complete'})
        complete=source|{'status':'passed','phase':'complete','cleanup':True,'images':dict.fromkeys(ci.APPS),'durableQualified':True}
        self.assertTrue(ci.project(complete)['durableQualified'])
    def test_registry_cleanup_requires_exact_identity_mapping_and_no_mount_foreign(self):
        row={'Id':'d'*64,'Name':'/owned','Image':'sha256:'+'a'*64,'Config':{'Labels':{'org.memlia.durable-ci':'c'*32}},'HostConfig':{'PortBindings':{'5000/tcp':[{'HostIp':'127.0.0.1','HostPort':'15000'}]}},'Mounts':[{'Type':'bind','Source':'/owned/data','Destination':'/var/lib/registry','RW':True}]}
        ci.registry_owned(row,'d'*64,'owned','sha256:'+'a'*64,'c'*32,Path('/owned/data'))
        for change in ({'Id':'e'*64},{'Mounts':[]},{'HostConfig':{'PortBindings':{'5000/tcp':[{'HostIp':'0.0.0.0','HostPort':'15000'}]}}}):
            with self.subTest(change=change),self.assertRaises(ValueError):ci.registry_owned(row|change,'d'*64,'owned','sha256:'+'a'*64,'c'*32,Path('/owned/data'))
    def test_full_typecheck_sequence_and_first_failure_blocks_next(self):
        seen=[]
        ci.check_types(lambda phase,argv:seen.append((phase,argv)))
        self.assertEqual([v[0] for v in seen],['typegen','typecheck'])
        self.assertIn('--incremental',seen[1][1]);self.assertIn('false',seen[1][1])
        self.assertIn('--noEmit',seen[1][1]);self.assertNotIn('--skipLibCheck',seen[1][1])
        def refuse(phase,argv):
            seen.append(phase)
            raise ValueError('native_typegen_failed')
        seen.clear()
        with self.assertRaisesRegex(ValueError,'native_typegen_failed'):ci.check_types(refuse)
        self.assertEqual(seen,['typegen'])

    def test_real_git_context_precedes_next_generated_untracked_declaration(self):
        import ast
        import os
        import subprocess
        helper=ci.load(ci.ROOT/'deploy/memlia/images/tests/prepare_context.py','context_order_fixture')
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)/'source';root.mkdir();private=Path(d)/'private';private.mkdir()
            files={'docker/app.Dockerfile':'FROM scratch\n','bun.lock':'fixture lock\n',
                   'package.json':'{}','bunfig.toml':'','turbo.json':'{}','patches/f.patch':'fixture',
                   'packages/example/file.ts':'export {}','apps/sim/page.tsx':'export {}',
                   'apps/sim/.gitignore':'next-env.d.ts\n','compliance/upstream/sim/LICENSE':'fixture license'}
            for name,data in files.items():
                target=root/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_text(data)
            def git(*args):
                return subprocess.check_output(['git','-C',str(root),*args],stderr=subprocess.PIPE,timeout=10,
                    env={'PATH':os.environ['PATH'],'HOME':os.environ['HOME'],'GIT_CONFIG_NOSYSTEM':'1'})
            git('init','-q');git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-qm','fixture')
            expected=git('rev-parse','HEAD').decode().strip();seen=[]
            def execute(phase,argv):
                seen.append(phase)
                if phase=='typegen':(root/'apps/sim/next-env.d.ts').write_text('/// <reference types="next" />\n')
            # Execute the actual ordering fragment, with native context/Git verification;
            # only Next generation is doubled, no Docker or full application build.
            tree=ast.parse(Path(ci.__file__).read_text());run=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='run')
            body=next(n for n in ast.walk(run) if isinstance(n,ast.If) and ast.unparse(n.test)=="mode == 'web-check'" and any(isinstance(c,ast.Name) and c.id=='check_web_context' for c in ast.walk(n))).orelse
            selected=[n for n in body if (isinstance(n,ast.Expr) and isinstance(n.value,ast.Call) and isinstance(n.value.func,ast.Name) and n.value.func.id=='check_types') or (isinstance(n,ast.For) and isinstance(n.iter,ast.Name) and n.iter.id=='APPS' and any(isinstance(c,ast.Call) and isinstance(c.func,ast.Attribute) and isinstance(c.func.value,ast.Name) and c.func.value.id=='prepare' for c in ast.walk(n)))]
            self.assertEqual(len(selected),2)
            scope={'check_types':ci.check_types,'type_phase':execute,'APPS':('web',), 'prepare':helper,
                   'ROOT':root,'private':private,'expected':expected,'record':{}}
            exec(compile(ast.Module(body=selected,type_ignores=[]),str(ci.__file__),'exec'),scope)
            self.assertEqual(seen,['typegen','typecheck'])
            self.assertTrue((private/'web/Dockerfile').is_file())
            self.assertFalse((private/'web/apps/sim/next-env.d.ts').exists())
            self.assertTrue((root/'apps/sim/next-env.d.ts').is_file())
            self.assertEqual(git('status','--porcelain','--untracked-files=no'),b'')
            # The admission guard remains strict even though Git status ignores it.
            with self.assertRaisesRegex(ValueError,'source_refused'):
                helper.prepare('app',root,root/'deploy/memlia/images',private/'rejected',source_commit=expected,architecture='amd64')

    def test_failure_projection_is_closed_and_never_echoes_primitive_diagnostics(self):
        import subprocess
        record={'status':'failed','phase':'contexts','step':'context-web','cleanup':True,'images':{}}
        for error,code in [(ValueError('source_refused'),'source_refused'),
                           (ValueError('PRIVATE_CANARY'),'preparation_refused'),
                           (ValueError('recipe_build_failed'),'command_failed'),
                           (FileNotFoundError('PRIVATE_CANARY'),'file_missing'),
                           (subprocess.CalledProcessError(1,['PRIVATE_CANARY']),'command_failed'),
                           (TimeoutError('PRIVATE_CANARY'),'timeout'),
                           (RuntimeError('PRIVATE_CANARY'),'unexpected_failure')]:
            projected=ci.project(record|{'errorCode':ci.error_code(error)})
            self.assertEqual(projected['errorCode'],code)
            self.assertNotIn('PRIVATE_CANARY',json.dumps(projected))
            self.assertEqual(projected['step'],'context-web')
        for change in ({'step':'PRIVATE_CANARY'},{'errorCode':'PRIVATE_CANARY'},{'errorCode':'none'},
                       {'phase':'images','step':'cron-assets'}):
            with self.assertRaises(ValueError):ci.project(record|change)

    def test_workflow_projection_executes_same_closed_schema_and_four_kib_bound(self):
        import contextlib
        import io
        import os
        import sys
        import textwrap
        from types import SimpleNamespace
        from unittest.mock import patch
        workflow=(ci.ROOT/'.github/workflows/memlia-excel-linux.yml').read_text()
        start='          import importlib.util,json,os,stat,sys\n'
        block=start+workflow.split(start,1)[1].split('          PY',1)[0]
        code=compile(textwrap.dedent(block),'workflow-projection','exec')
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'summary.json'
            good={'status':'failed','phase':'contexts','step':'context-web','errorCode':'source_refused',
                  'cleanup':True,'imagesBuilt':0,'durableQualified':False}
            real_fstat=os.fstat
            def root_owned(fd):
                value=real_fstat(fd)
                return SimpleNamespace(st_mode=value.st_mode,st_uid=0,st_nlink=value.st_nlink)
            with patch.object(sys,'argv',['projection',str(ci.ROOT),d]),patch.object(os,'fstat',root_owned):
                path.write_text(json.dumps(good));output=io.StringIO()
                with contextlib.redirect_stdout(output):exec(code,{})
                self.assertEqual(json.loads(output.getvalue()),good)
                image=good|{'phase':'images','step':'image-web-build','errorCode':'observed_cli_flag_refused'}
                for value in [image,good|{'phase':'tools','step':'buildx-cli-help','errorCode':'cli_option_unavailable'}]:
                    path.write_text(json.dumps(value));output=io.StringIO()
                    with contextlib.redirect_stdout(output):exec(code,{})
                    self.assertEqual(json.loads(output.getvalue()),value)
                short=good|{'status':'passed','phase':'web-check','step':'web-check','errorCode':'none'}
                path.write_text(json.dumps(short));output=io.StringIO()
                with patch.dict(os.environ,{'MEMLIA_CHECK_WEB_CONTEXT':'1'}),contextlib.redirect_stdout(output):exec(code,{})
                self.assertEqual(json.loads(output.getvalue()),short)
                for change in ({'imagesBuilt':1},{'durableQualified':True},{'cleanup':False},
                               {'phase':'complete','step':'complete'},
                               {'phase':'complete','step':'complete','imagesBuilt':5,'durableQualified':True},{'step':'image-web-build'}):
                    path.write_text(json.dumps(short|change));output=io.StringIO()
                    with patch.dict(os.environ,{'MEMLIA_CHECK_WEB_CONTEXT':'1'}),contextlib.redirect_stdout(output),self.assertRaises(AssertionError):exec(code,{})
                    self.assertEqual(output.getvalue(),'')
                for change in ({'errorCode':'PRIVATE_CANARY'},{'step':'PRIVATE_CANARY'},
                               {'phase':'images','step':'context-web'},{'phase':'contexts','step':'image-web-build'},
                               {'extra':'PRIVATE_CANARY'},{'errorCode':'none'}):
                    path.write_text(json.dumps(good|change));output=io.StringIO()
                    with contextlib.redirect_stdout(output),self.assertRaises(AssertionError):exec(code,{})
                    self.assertEqual(output.getvalue(),'')
                path.write_text(' '*4097)
                with self.assertRaises(AssertionError):exec(code,{})

    def test_output_no_overwrite(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'private';ci.write_private(p,b'first')
            with self.assertRaises(FileExistsError):ci.write_private(p,b'second')
            self.assertEqual(p.read_bytes(),b'first');self.assertEqual(p.stat().st_mode&0o777,0o600)

class ImageDiagnostics(unittest.TestCase):
    def test_image_operation_survives_closed_projection_without_free_data(self):
        source={'status':'failed','phase':'images','step':'image-web-build','errorCode':'observed_cli_flag_refused','cleanup':True,'images':{},'stderr':'PRIVATE_CANARY'}
        got=ci.project(source)
        self.assertEqual(got['step'],'image-web-build')
        self.assertEqual(got['errorCode'],'observed_cli_flag_refused')
        self.assertEqual(len(got),7);self.assertNotIn('PRIVATE_CANARY',json.dumps(got))
        for phase,step in [('contexts','image-web-build'),('images','image-foreign-build'),('images','image-web-PRIVATE_CANARY'),('complete','image-web-build')]:
            with self.subTest(phase=phase,step=step),self.assertRaises(ValueError):ci.project(source|{'phase':phase,'step':step})

    def test_each_real_image_operation_is_identified_and_first_failure_stops(self):
        import subprocess
        operations=['build','guard','push','inspect-tag','pull','inspect-digest','verify-digest']
        row={'Id':'sha256:'+'d'*64,'Os':'linux','Architecture':'amd64','RepoDigests':['127.0.0.1:15000/c'+('c'*32)+'/web@sha256:'+'e'*64],'Config':{'Labels':{'org.memlia.source':'a'*40,'org.memlia.lock':'b'*64,'org.memlia.durable-ci':'c'*32}}}
        for failure in [None,*operations]:
            stages=[];commands=[]
            def check():
                if stages[-1]=='image-web-'+str(failure):raise subprocess.CalledProcessError(1,['PRIVATE_CANARY'])
            def docker(args,**kw):commands.append(args);check()
            def one(args):
                commands.append(args)
                if failure=='verify-digest' and stages[-1]=='image-web-inspect-digest':return row|{'Id':'sha256:'+'f'*64}
                check();return row
            def execute():return ci.build_image('web','owned',Path('/context'),'a'*40,'b'*64,'c'*32,docker=docker,one=one,guard=check,step=stages.append)
            if failure is None:
                self.assertEqual(execute()['imageId'],row['Id']);self.assertEqual(stages,['image-web-'+op for op in operations])
                self.assertEqual(commands[0][0:2],['buildx','build']);self.assertEqual(commands[1][0],'push')
                self.assertEqual(commands[3][0],'pull')
            else:
                with self.subTest(failure=failure),self.assertRaises((subprocess.CalledProcessError,ValueError)):execute()
                self.assertEqual(stages,['image-web-'+op for op in operations[:operations.index(failure)+1]])

    def test_recognized_cli_buildkit_and_runtime_observations_never_echo_raw(self):
        cases=[(b'unknown flag: --cgroup-parent\n','observed_cli_flag_refused'),
               (b'ERROR: failed to build: failed to solve: write PRIVATE_CANARY: no space left on device\n','observed_no_space'),
               (b'Error response from daemon: PRIVATE_CANARY: x509: certificate signed by unknown authority\n','observed_tls_refused'),
               (b'Error response from daemon: PRIVATE_CANARY: connect: connection refused\n','observed_connection_refused'),
               (b'#17 12.34 error: lockfile had changes, but lockfile is frozen\n','observed_lockfile_frozen'),
               (b'#17 1.25 FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n','observed_js_heap_limit'),
               (b'ERROR: failed to build: failed to solve: process "PRIVATE_CANARY" did not complete successfully: exit code: 137\n','observed_exit_137'),
               (b'ERROR: failed to build: failed to solve: process "PRIVATE_CANARY" did not complete successfully: exit code: 1\n','observed_process_exit')]
        for raw,expected in cases:
            with self.subTest(expected=expected):
                got=ci.classify_command_output(raw);self.assertEqual(got,expected)
                self.assertNotIn('PRIVATE_CANARY',got);self.assertIn(got,ci.ERROR_CODES)

    def test_arbitrary_substrings_ansi_splices_contradictions_and_bounds_remain_unknown(self):
        for raw,reason in [(b'PRIVATE_CANARY unknown flag: --cgroup-parent','no_marker'),(b'RUN echo "no space left on device"','no_marker'),
                           (b'unknown flag: --PRIVATE_CANARY','no_marker'),(b'unknown flag: --cgroup-parent;PRIVATE_CANARY','no_marker'),
                           (b'unkno\x1b[31mwn flag: --cgroup-parent\n','control_sgr'),(b'\xffunknown flag: --cgroup-parent','utf8'),
                           (b'\x00unknown flag: --cgroup-parent','control_nul'),(b'PRIVATE_CANARY\vunknown flag: --cgroup-parent','control_other'),
                           (b'unknown flag: --cgroup-parent\vPRIVATE_CANARY','control_other'),(b'PRIVATE_CANARY\xe2\x80\xa8unknown flag: --cgroup-parent','no_marker'),
                           (b'unknown flag: --cgroup-parent\nERROR: failed to build: no space left on device\n','ambiguous')]:
            with self.subTest(reason=reason):self.assertEqual(ci.classify_command_output(raw),'diagnostic_unknown_'+reason)
        self.assertEqual(ci.classify_command_output(b'\x1b[31munknown flag: --cgroup-parent\x1b[0m\n'),'observed_cli_flag_refused')
        self.assertEqual(ci.classify_command_output(b'x'*(ci.DIAGNOSTIC_BYTES+1)),'diagnostic_truncated')
        self.assertEqual(ci.classify_command_output(b'x'*8193),'diagnostic_unknown_bounds')

    def test_private_log_requires_closed_owner_exact_file_and_full_capture(self):
        import os
        with tempfile.TemporaryDirectory() as d:
            work=Path(d);work.chmod(0o700);p=work/'build.private.log'
            closed={'pid':123,'waited':True,'groupClosed':True}
            error=ValueError('recipe_build_failed')
            self.assertEqual(ci.command_failure(error,work,closed),'diagnostic_unavailable')
            ci.write_private(p,b'unknown flag: --cgroup-parent\n')
            self.assertEqual(ci.command_failure(error,work,closed),'observed_cli_flag_refused')
            self.assertEqual(ci.command_failure(error,work,{'waited':True,'groupClosed':False}),'diagnostic_unavailable')
            self.assertEqual(ci.command_failure(ValueError('recipe_build_log_limit'),work,closed),'diagnostic_truncated')
            self.assertEqual(ci.command_failure(ValueError('recipe_build_interrupted'),work,closed),'command_interrupted')
            self.assertEqual(ci.command_failure(ValueError('PRIVATE_CANARY'),work,closed),'preparation_refused')
            p.chmod(0o644);self.assertEqual(ci.command_failure(error,work,closed),'diagnostic_unavailable')
            p.chmod(0o600);other=work/'link';os.link(p,other)
            self.assertEqual(ci.command_failure(error,work,closed),'diagnostic_unavailable');other.unlink()
            p.unlink();p.symlink_to('/dev/null');self.assertEqual(ci.command_failure(error,work,closed),'diagnostic_unavailable')

    def test_failure_transport_keeps_raw_before_classification_nonzero_and_no_retry(self):
        import threading,time
        from types import SimpleNamespace
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as d:
            work=Path(d);work.chmod(0o700);ci.write_private(work/'build.private.log',b'')
            calls=[];raw=b'PRIVATE_CANARY\nunknown flag: --cgroup-parent\n';receipt={}
            def client(argv,target,deadline,cancel,**kwargs):
                calls.append(argv)
                with (target/'build.private.log').open('ab') as out:out.write(raw)
                kwargs['receipt'].update(pid=123,waited=True,groupClosed=True)
                raise ValueError('recipe_build_failed')
            original=ci.classify_command_output
            def observed(data,**kw):
                self.assertEqual((work/'build.private.log').read_bytes(),raw);self.assertEqual(kw,{'buildx_client':False})
                return original(data,**kw)
            with patch.object(ci,'classify_command_output',observed),self.assertRaisesRegex(ValueError,'recipe_build_failed'):
                ci.owned_command(SimpleNamespace(owned_client=client),['PRIVATE_CANARY'],work,time.monotonic()+3,threading.Event(),receipt=receipt)
            self.assertEqual(len(calls),1);self.assertEqual(receipt['failureCode'],'observed_cli_flag_refused')
            self.assertEqual((work/'build.private.log').read_bytes(),raw);self.assertNotIn('PRIVATE_CANARY',receipt['failureCode'])

    def test_buildx_probe_checks_real_usage_exact_option_before_any_build(self):
        calls=[];steps=[]
        outputs=[b'github.com/docker/buildx v0.29.1 '+b'a'*40+b'\n',b'Usage:  docker buildx build [OPTIONS] PATH | URL | -\n\n      --cgroup-parent string   Parent cgroup\n']
        def execute(args,**kw):calls.append((args,kw));return outputs[len(calls)-1]
        result=ci.probe_buildx(execute,steps.append)
        self.assertEqual(steps,['buildx-cli-version','buildx-cli-help'])
        self.assertEqual([r[0] for r in calls],[['buildx','version'],['buildx','build','--help']])
        self.assertTrue(all(r[1]=={'capture':True,'seconds':15} for r in calls))
        self.assertTrue(result['realUsage']);self.assertTrue(result['cgroupParentListed'])
        self.assertEqual(set(result),{'realUsage','cgroupParentListed','versionBytes','helpBytes'})
        self.assertTrue(ci.valid_step('tools','buildx-cli-help'))
        self.assertFalse(ci.valid_step('images','buildx-cli-help'))

    def test_buildx_probe_refuses_missing_option_or_unknown_help_without_building(self):
        version=b'github.com/docker/buildx v0.29.1 '+b'a'*40+b'\n'
        real=b'Usage:  docker buildx build [OPTIONS] PATH | URL | -\n'
        for help_text,code in [(real+b'      --load Load\n','cli_option_unavailable'),
                               (real+b'      --cgroup-parent-fake string nope\n','cli_option_unavailable'),
                               (b'Usage: docker [OPTIONS] COMMAND\n      --cgroup-parent string PRIVATE_CANARY\n','diagnostic_unknown'),
                               (real+b'\x1b[31m      --cgroup-parent string nope\n','diagnostic_unknown'),
                               (real+b'      --cgroup-parent string one\n      --cgroup-parent string two\n','diagnostic_unknown'),
                               (b'PRIVATE_CANARY'+b'x'*65536,'diagnostic_unknown')]:
            calls=[]
            def execute(args,**kw):calls.append(args);return version if len(calls)==1 else help_text
            with self.subTest(code=code),self.assertRaises(ValueError) as caught:ci.probe_buildx(execute,lambda _:None)
            self.assertEqual(ci.error_code(caught.exception),code)
            self.assertEqual(len(calls),2);self.assertNotIn('PRIVATE_CANARY',ci.error_code(caught.exception))

    @unittest.skipUnless(hasattr(__import__('os'),'waitid'),'native WNOWAIT port unavailable on this interpreter')
    def test_linux_native_nonzero_subprocess_capture_without_docker(self):
        import sys,time,threading
        native=ci.load(ci.ROOT/'scripts/ci/workflow-worker-image.py','native_failed_diagnostic')
        with tempfile.TemporaryDirectory() as d:
            work=Path(d);work.chmod(0o700);ci.write_private(work/'build.private.log',b'');receipt={}
            argv=[sys.executable,'-c',"import sys;print('PRIVATE_CANARY');print('unknown flag: --cgroup-parent',file=sys.stderr);sys.exit(7)"]
            with self.assertRaisesRegex(ValueError,'recipe_build_failed'):
                ci.owned_command(native,argv,work,time.monotonic()+5,threading.Event(),receipt=receipt)
            self.assertEqual(receipt['failureCode'],'observed_cli_flag_refused')
            self.assertTrue(receipt['waited']);self.assertTrue(receipt['groupClosed'])
            self.assertIn(b'PRIVATE_CANARY',(work/'build.private.log').read_bytes())

class ControlDiagnostics(unittest.TestCase):
    def test_refused_controls_have_only_closed_classes(self):
        cases=[(b'PRIVATE_CANARY\x00','nul'),(b'PRIV\x1b[31mATE_CANARY','sgr'),
               (b'PRIVATE_CANARY\x1b[2K','escape_csi'),(b'PRIVATE_CANARY\x1b','escape'),(b'PRIVATE_CANARY\rmore','cr'),
               (b'PRIVATE_CANARY\x08','backspace'),(b'PRIVATE_CANARY\x7f','del'),
               (b'PRIVATE_CANARY\x0b','other'),(b'PRIVATE_CANARY\x08\rmore','mixed'),
               (b'#12 3.456 \x1b[32mPRIVATE CANARY','sgr_after_prefix'),(b'#5 0.3 \x1b[31m\tPRIVATE\x1b[0m','sgr_after_prefix'),
               (b'#5 0.3 PRIV\x1b[31mATE','sgr'),(b'#5 0.3 \x1b[32mPRIV\x1b[39mATE','sgr'),(b'#12 3.456 PRIV\x1b[2KATE','escape_csi'),
               (b'PRIV\x1b[31','escape'),(b'PRIV\x1b['+b';'*33+b'mATE','escape'),(b'PRIVATE\r\r\n','cr'),
               (b'PRIV\x1b[31mATE\x1b[2K','mixed'),(b'#7 \x1b[31mPRIVATE\x1b[0m\rCANARY','mixed')]
        for raw,kind in cases:
            with self.subTest(kind=kind):
                value=ci.classify_command_output(raw)
                self.assertEqual(value,'diagnostic_unknown_control_'+kind)
                self.assertIn(value,ci.ERROR_CODES)
                self.assertNotIn('PRIVATE_CANARY',value)
    def test_control_splices_remain_unknown_and_other_recognition_is_unchanged(self):
        self.assertEqual(ci.classify_command_output(b'unkno\x1b[31mwn flag: --cgroup-parent'),'diagnostic_unknown_control_sgr')
        self.assertEqual(ci.classify_command_output(b'\x1b[31munknown flag: --cgroup-parent\x1b[0m\r\n'),'observed_cli_flag_refused')
        self.assertEqual(ci.classify_command_output(b'\xffPRIVATE_CANARY'),'diagnostic_unknown_utf8')
        self.assertEqual(ci.classify_command_output(b'\xffPRIVATE_CANARY\x00'),'diagnostic_unknown_control_nul')
        self.assertEqual(ci.classify_command_output(b'x'*8193),'diagnostic_unknown_bounds')
        self.assertEqual(ci.classify_command_output(b'PRIVATE_CANARY unknown flag: --cgroup-parent'),'diagnostic_unknown_no_marker')
        self.assertEqual(ci.classify_command_output(b'unknown flag: --cgroup-parent\nerror: lockfile had changes, but lockfile is frozen'),'diagnostic_unknown_ambiguous')
    def test_refusal_and_classification_agree_for_every_code_point(self):
        # The refusal rule is unchanged; every refused character yields a closed control class, and only those.
        for point in range(0x200):
            if point==10:continue
            value=ci.classify_command_output(('x'+chr(point)+'y').encode())
            refused=(point<32 and point!=9) or point==0x7f
            with self.subTest(point=point):
                self.assertEqual(value.startswith('diagnostic_unknown_control_'),refused)
                self.assertNotEqual(value,'diagnostic_unknown_control')
    def test_inner_sgr_splices_behind_a_prefix_never_claim_edge_normalization(self):
        for raw in (b'#5 0.3 unkno\x1b[31mwn flag: --cgroup-parent',b'#5 0.3 e\x1b[31mrror: lockfile had changes, but lockfile is frozen'):
            with self.subTest(raw=raw):self.assertEqual(ci.classify_command_output(raw),'diagnostic_unknown_control_sgr')
    def test_first_refused_line_names_the_class_and_only_the_final_client_line_is_read(self):
        raw=b'#9 1.2 PRIV\x08ATE\n#9 1.3 x\rCANARY\nERROR: failed to build: failed to solve: process "x" did not complete successfully: exit code: 137\n'
        self.assertEqual(ci.classify_command_output(raw,buildx_client=True),'observed_exit_137')
        self.assertEqual(ci.classify_command_output(raw),'diagnostic_unknown_control_backspace')
        self.assertEqual(ci.classify_command_output(raw.rsplit(b'ERROR',1)[0],buildx_client=True),'diagnostic_unknown_control_backspace')
    def test_the_public_projection_is_still_seven_closed_fields(self):
        for kind in ['nul','sgr','escape','escape_csi','sgr_after_prefix','cr','backspace','del','other','mixed']:
            code='diagnostic_unknown_control_'+kind
            got=ci.project({'status':'failed','phase':'images','step':'image-web-build','errorCode':code,'cleanup':True,'images':{},'privateText':'PRIVATE_CANARY'})
            self.assertEqual(len(got),7);self.assertEqual(got['errorCode'],code)
            self.assertNotIn('PRIVATE_CANARY',json.dumps(got));self.assertFalse(got['durableQualified'])
    def test_owned_capture_keeps_raw_private_and_open_capture_stays_unavailable(self):
        raw=b'PRIV\x1b[31mATE_CANARY\n'
        with tempfile.TemporaryDirectory() as name:
            work=Path(name);work.chmod(0o700);path=work/'build.private.log';ci.write_private(path,raw)
            self.assertEqual(ci.command_failure(ValueError('recipe_build_failed'),work,{'pid':123,'waited':True,'groupClosed':True}),'diagnostic_unknown_control_sgr')
            self.assertEqual(path.read_bytes(),raw);self.assertEqual(path.stat().st_mode&0o777,0o600)
            with patch.object(ci,'classify_command_output',side_effect=AssertionError('must not read open producer')):
                self.assertEqual(ci.command_failure(ValueError('recipe_build_failed'),work,{'pid':123,'waited':True,'groupClosed':False}),'diagnostic_unavailable')

FINAL_137=b'ERROR: failed to build: failed to solve: process "/bin/sh -c bun run build" did not complete successfully: exit code: 137'
FINAL_1=FINAL_137.removesuffix(b'137')+b'1'

def buildx_failure(final,quoted=b'12.34 PRIVATE_CANARY',refused=b'#15 3.210 PRIVATE_CANARY 10%\rPRIVATE_CANARY 20%'):
    # Shape of a real `docker buildx build --progress=plain` failure: streamed child lines carry
    # '#N ', BuildKit's '------' summary quotes them behind a timestamp, then the client's own
    # Dockerfile excerpt and its single final 'ERROR: ' line (buildx cmd/buildx/main.go).
    return (b'#15 [builder 6/8] RUN bun run build\n'+refused+b'\n'
            b'#15 ERROR: process "/bin/sh -c bun run build" did not complete successfully: exit code: 137\n'
            b'------\n > [builder 6/8] RUN bun run build:\n'+quoted+b'\n------\n'
            b'Dockerfile:42\n--------------------\n  41 |     COPY . .\n  42 | >>> RUN bun run build\n--------------------\n'
            +final+b'\n')

class ClientLineAfterRefusal(unittest.TestCase):
    def assertClosed(self,raw,expected):
        value=ci.classify_command_output(raw,buildx_client=True)
        self.assertEqual(value,expected);self.assertIn(value,ci.ERROR_CODES);self.assertNotIn('CANARY',value)

    def test_final_line_is_read_only_for_an_explicit_buildx_client(self):
        raw=b'#5 1.0 a\rb\n'+FINAL_137+b'\n'
        # bun, apt-get, playwright, curl or Python helpers own their last line: refusal stays the answer.
        self.assertEqual(ci.classify_command_output(raw),'diagnostic_unknown_control_cr')
        self.assertEqual(ci.classify_command_output(raw,buildx_client=False),'diagnostic_unknown_control_cr')
        self.assertEqual(ci.classify_command_output(raw,buildx_client=True),'observed_exit_137')
        with self.assertRaises(TypeError):ci.classify_command_output(raw,True)
        with tempfile.TemporaryDirectory() as name:
            work=Path(name);work.chmod(0o700);ci.write_private(work/'build.private.log',raw)
            closed={'pid':123,'waited':True,'groupClosed':True};error=ValueError('recipe_build_failed')
            self.assertEqual(ci.command_failure(error,work,closed),'diagnostic_unknown_control_cr')
            self.assertEqual(ci.command_failure(error,work,closed,buildx_client=True),'observed_exit_137')

    def test_final_line_must_stay_last_and_clean(self):
        self.assertClosed(b'a\rb\n'+FINAL_137+b'\nZ\rY\n','diagnostic_unknown_control_cr')
        self.assertClosed(b'a\rb\n'+FINAL_137+b'\n   \n','diagnostic_unknown_control_cr')
        self.assertClosed(b'a\rb\n'+FINAL_137+b'\n\x00','diagnostic_unknown_control_nul')
        self.assertClosed(FINAL_137+b'\n\x00','diagnostic_unknown_control_nul')
        self.assertClosed(FINAL_137+b'\n   \n','observed_exit_137')  # no refusal: recognition unchanged

    def run_transport(self,raw):
        # Execute run()'s real command/docker closures; only the native client is doubled.
        import ast,textwrap,threading,time
        from types import SimpleNamespace
        tree=ast.parse(Path(ci.__file__).read_text());run=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='run')
        defs=[n for n in run.body if isinstance(n,ast.FunctionDef) and n.name in ('command','docker')]
        self.assertEqual([d.name for d in defs],['command','docker'])
        source='def factory():\n    count=0\n'+''.join(textwrap.indent(ast.unparse(d),'    ')+'\n' for d in defs)+'    return command,docker\n'
        calls=[]
        def client(argv,target,deadline,cancel,**kwargs):
            calls.append(argv)
            with (target/'build.private.log').open('ab') as out:out.write(raw)
            kwargs['receipt'].update(pid=123,waited=True,groupClosed=True)
            raise ValueError('recipe_build_failed')
        private=Path(self.enterContext(tempfile.TemporaryDirectory()));private.chmod(0o700);record={'clientSessions':[]}
        scope={'private':private,'record':record,'disk':lambda:None,'cancel':threading.Event(),'deadline':time.monotonic()+30,
               'native':SimpleNamespace(DOCKER=['/usr/bin/docker'],owned_client=client),'owned_command':ci.owned_command,
               'time':time,'threading':threading,'write_private':ci.write_private,'require':ci.require}
        exec(compile(source,str(ci.__file__),'exec'),scope)
        command,docker=scope['factory']()
        return command,docker,record,calls

    def test_run_transport_marks_only_explicit_buildx_builds(self):
        raw=b'#5 1.0 a\rb\n'+FINAL_137+b'\n'
        command,docker,record,calls=self.run_transport(raw)
        for call,expected in [(lambda:command(['/usr/bin/bun','install']),'diagnostic_unknown_control_cr'),
                              (lambda:docker(['push','x']),'diagnostic_unknown_control_cr'),
                              (lambda:docker(['buildx','build','--progress=plain','.']),'diagnostic_unknown_control_cr'),
                              (lambda:docker(['buildx','build','--progress=plain','.'],buildx_client=True),'observed_exit_137')]:
            record.pop('errorCode',None)
            with self.assertRaisesRegex(ValueError,'recipe_build_failed'):call()
            self.assertEqual(record['errorCode'],expected)
        self.assertEqual(len(calls),4)
        for args in (['push','x'],['container','start','--attach','x'],['buildx','version']):
            with self.subTest(args=args),self.assertRaises(ValueError):docker(args,buildx_client=True)
        self.assertEqual(len(calls),4)

    def test_only_the_image_build_call_declares_the_buildx_client(self):
        row={'Id':'sha256:'+'d'*64,'Os':'linux','Architecture':'amd64','RepoDigests':['127.0.0.1:15000/c'+('c'*32)+'/web@sha256:'+'e'*64],'Config':{'Labels':{'org.memlia.source':'a'*40,'org.memlia.lock':'b'*64,'org.memlia.durable-ci':'c'*32}}}
        seen=[]
        ci.build_image('web','owned',Path('/context'),'a'*40,'b'*64,'c'*32,docker=lambda args,**kw:seen.append((args[:2],kw)),
                       one=lambda args:row,guard=lambda:None,step=lambda _:None)
        self.assertEqual(seen[0],(['buildx','build'],{'seconds':5400,'buildx_client':True}))
        self.assertTrue(all('buildx_client' not in kw for _,kw in seen[1:]))

    def test_final_client_line_after_a_refusal_names_the_observation(self):
        for final,expected in [(FINAL_137,'observed_exit_137'),(FINAL_1,'observed_process_exit_next_build_1'),
                               (FINAL_137+b'\r','observed_exit_137'),
                               (b'ERROR: failed to build: failed to solve: write PRIVATE_CANARY: no space left on device','observed_no_space')]:
            with self.subTest(expected=expected):self.assertClosed(buildx_failure(final),expected)
        for refused in (b'#15 3.2 PRIV\x1b[31mATE',b'#15 3.2 PRIV\x08ATE',b'#15 3.2 PRIV\x7fATE',b'#15 3.2 PRIV\x1b[2KATE',b'PRIVATE\x0bCANARY'):
            with self.subTest(refused=refused):self.assertClosed(buildx_failure(FINAL_137,refused=refused),'observed_exit_137')

    def test_private_log_with_carriage_returns_reports_the_client_exit(self):
        with tempfile.TemporaryDirectory() as name:
            work=Path(name);work.chmod(0o700);ci.write_private(work/'build.private.log',buildx_failure(FINAL_137))
            got=ci.command_failure(ValueError('recipe_build_failed'),work,{'pid':123,'waited':True,'groupClosed':True},buildx_client=True)
            self.assertEqual(got,'observed_exit_137')
            projected=ci.project({'status':'failed','phase':'images','step':'image-web-build','errorCode':got,'cleanup':False,'images':{}})
            self.assertEqual(len(projected),7);self.assertNotIn('CANARY',json.dumps(projected))

    def test_child_lines_after_a_refusal_never_become_client_lines(self):
        child=b'ERROR: failed to build: failed to solve: process "PRIVATE_CANARY" did not complete successfully: exit code: 137'
        not_marker=b'ERROR: failed to build: failed to solve: PRIVATE_CANARY'
        for raw in [buildx_failure(not_marker,quoted=b'12.34 '+child),            # quoted with its timestamp
                    buildx_failure(not_marker,quoted=child),                      # quoted bare: resumed partial line
                    buildx_failure(b'#15 4.000 '+child),                          # streamed child, last
                    buildx_failure(b'12.34 '+child),
                    buildx_failure(not_marker).replace(b'#15 ERROR:',b'#15 4.000 '+child+b'\n#15 ERROR:'),
                    b'#15 3.2 x\ry\n'+child+b'\n------\n']:                       # bare child, not last
            with self.subTest(raw=raw[-90:]):self.assertClosed(raw,'diagnostic_unknown_control_cr')

    def test_distinct_markers_after_a_refusal_stay_ambiguous(self):
        forged=b'ERROR: failed to build: failed to solve: process "PRIVATE_CANARY" did not complete successfully: exit code: 137'
        self.assertClosed(buildx_failure(FINAL_1,quoted=forged),'diagnostic_unknown_ambiguous')
        self.assertClosed(buildx_failure(FINAL_137,quoted=b'unknown flag: --load'),'diagnostic_unknown_ambiguous')
        self.assertClosed(buildx_failure(FINAL_137,quoted=b'error: lockfile had changes, but lockfile is frozen'),'diagnostic_unknown_ambiguous')
        self.assertClosed(buildx_failure(FINAL_137,quoted=forged),'observed_exit_137')

    def test_markers_before_the_refusal_keep_todays_answer(self):
        self.assertClosed(FINAL_137+b'\n#9 1.0 x\rPRIVATE_CANARY\n','diagnostic_unknown_control_cr')
        self.assertClosed(b'unknown flag: --load\n#9 x\ry\n------\n','diagnostic_unknown_control_cr')
        # Observations before the refusal are neither added to nor compared with the final line.
        self.assertClosed(b'unknown flag: --cgroup-parent\n#9 x\ry\n'+FINAL_1+b'\n','observed_process_exit_next_build_1')
        # Without any refusal, recognition (prefix stripping, priority over the exit) is unchanged.
        clean=buildx_failure(FINAL_1,refused=b'#15 3.210 PRIVATE_CANARY 10%')
        self.assertClosed(clean,'observed_process_exit_next_build_1')
        self.assertClosed(clean.replace(b'#15 3.210 PRIVATE_CANARY 10%',b'#15 3.210 error: lockfile had changes, but lockfile is frozen'),'observed_lockfile_frozen')

    def test_bounds_nul_and_utf8_keep_priority_over_the_final_line(self):
        raw=buildx_failure(FINAL_137)
        self.assertClosed(raw.replace(b'Dockerfile:42',b'Dockerfile:42\0'),'diagnostic_unknown_control_nul')
        self.assertClosed(raw.replace(b'Dockerfile:42',b'Dockerfile:\xff'),'diagnostic_unknown_utf8')
        self.assertClosed(raw+b'\n'*65537,'diagnostic_unknown_bounds')
        self.assertEqual(ci.classify_command_output(raw+b'x'*ci.DIAGNOSTIC_BYTES),'diagnostic_truncated')
        self.assertClosed(raw.replace(b'Dockerfile:42',b'x'*8193),'diagnostic_unknown_control_cr')
        self.assertClosed(raw.replace(b'#15 [builder',b'x'*8193+b'\n#15 [builder'),'diagnostic_unknown_bounds')

    def test_no_normalization_after_a_refusal(self):
        for final in (b'\x1b[31m'+FINAL_137+b'\x1b[0m',b'PRIVATE_CANARY\r'+FINAL_137,FINAL_137+b'\t',b' '+FINAL_137):
            with self.subTest(final=final[:20]):self.assertClosed(buildx_failure(final),'diagnostic_unknown_control_cr')
        self.assertClosed(b'#9 x\ry\n','diagnostic_unknown_control_cr')
        self.assertClosed(b'#9 x\ry\n\n\n','diagnostic_unknown_control_cr')
        self.assertClosed(b'#9 x\ry\n'+FINAL_137+b'\n\n','observed_exit_137')

def go_quoted(text):
    # Independent oracle of Go strconv.Quote (buildkit's %q): named escapes, \xNN for C0/DEL,
    # \u/\U for other non-printable runes, printable runes verbatim.
    named={'\a':'\\a','\b':'\\b','\f':'\\f','\n':'\\n','\r':'\\r','\t':'\\t','\v':'\\v','\\':'\\\\','"':'\\"'}
    out=[]
    for c in text:
        if c in named:out.append(named[c])
        elif ord(c)<32 or ord(c)==0x7f:out.append('\\x%02x'%ord(c))
        elif c.isprintable():out.append(c)
        else:out.append('\\u%04x'%ord(c) if ord(c)<0x10000 else '\\U%08x'%ord(c))
    return '"'+''.join(out)+'"'
assert go_quoted('a"b\\c\td\x1b\u2028')=='"a\\"b\\\\c\\td\\x1b\\u2028"'

def client_process(args,code):
    # buildx 'ERROR: %v' of buildkit's errors.Wrapf(err, "process %q did not complete successfully",
    # strings.Join(e.op.Meta.Args, " ")) around ExitError "exit code: %d" (v0.25.0 ops/exec.go).
    return (b'ERROR: failed to build: failed to solve: process '+go_quoted(args).encode()
            +b' did not complete successfully: exit code: '+str(code).encode())

def dockerfile_runs(path):
    """RUN commands as buildkit v0.25.0 builds Meta.Args: parser.go continuation regex
    `([^\\])\\[ \t]*$|^\\[ \t]*$` -> `$1`, comment and empty continuation lines skipped, next
    lines NOT left-stripped; extractBuilderFlags drops leading --flags; withShell appends the
    command joined to the default /bin/sh -c. Whitespace is kept raw, never normalized here."""
    import re
    continuation=re.compile(r'([^\\])\\[ \t]*$|^\\[ \t]*$')
    lines=path.read_text().split('\n');runs=[];i=0
    while i<len(lines):
        line=lines[i].lstrip();start=i+1;i+=1
        if not line or line.startswith('#'):continue
        joined=continuation.sub(r'\1',line);more=continuation.search(line) is not None
        while more and i<len(lines):
            raw=lines[i];i+=1
            if raw.lstrip().startswith('#') or not raw.strip():continue
            more=continuation.search(raw) is not None;joined+=continuation.sub(r'\1',raw)
        word,_,rest=joined.strip().partition(' ')
        if word.upper()!='RUN':continue
        rest=rest.lstrip()
        while rest.startswith('--'):rest=rest.split(None,1)[1]
        assert not rest.startswith('[') and '<<' not in rest,(path,start)
        runs.append((start,' '.join(['/bin/sh','-c',rest])))
    return runs

# Every RUN of the five images built through build_image (buildx_client=True), in Dockerfile order.
# Pinned by order, not line number: an edit inside a RUN must not redden this check, an added,
# removed or reordered RUN must. Line numbers only label failures.
RUN_FAMILIES={
    'docker/app.Dockerfile':['provenance','apt','apt','prune','install','next_build','bootstrap','runtime_setup',
                             'oracledb_selftest','runtime_setup'],
    'docker/realtime.Dockerfile':['provenance','apk','prune','install','runtime_setup'],
    'deploy/memlia/images/migrations.Dockerfile':['provenance','install','runtime_setup'],
    'deploy/memlia/images/cron.Dockerfile':['provenance','apk','pinned_binary','runtime_setup'],
    'deploy/memlia/images/workflow-worker.Dockerfile':['provenance','pinned_binary','install','native_rebuild','bundles',
                                                       'install','runtime_setup','oracledb_selftest']}

class ProcessExitDetail(unittest.TestCase):
    def assertClosed(self,raw,expected,buildx_client=True):
        value=ci.classify_command_output(raw,buildx_client=buildx_client)
        self.assertEqual(value,expected);self.assertIn(value,ci.ERROR_CODES);self.assertNotIn('CANARY',value)

    def both_paths(self,final,expected):
        # Same final client line, after a refused child line and in an entirely clean log.
        self.assertClosed(buildx_failure(final),expected)
        self.assertClosed(buildx_failure(final,refused=b'#15 3.210 PRIVATE_CANARY 10%'),expected)

    def test_every_real_run_of_the_five_images_is_one_closed_family(self):
        source=(ci.ROOT/'deploy/memlia/images/tests/prepare_context.py').read_text()
        self.assertIn("recipe=source/'docker'/f'{kind}.Dockerfile' if kind in ('app','realtime') else recipes/f'{kind}.Dockerfile'",source)
        self.assertEqual({'app' if n=='web' else n for n in ci.APPS},{Path(p).name.removesuffix('.Dockerfile') for p in RUN_FAMILIES})
        for path,expected in RUN_FAMILIES.items():
            text=(ci.ROOT/path).read_text()
            self.assertNotRegex(text,r'(?im)^\s*(SHELL|#\s*escape=)')
            runs=dockerfile_runs(ci.ROOT/path)
            self.assertEqual(len(runs),len(expected),[f'{path}:{line}' for line,_ in runs])  # a new or removed RUN must be classified
            for (line,args),family in zip(runs,expected):
                for code,kind in ((1,'1'),(134,'134'),(255,'other')):
                    with self.subTest(run=f'{path}:{line}',code=code):
                        self.both_paths(client_process(args,code),'observed_process_exit_'+family+'_'+kind)
        used={family for families in RUN_FAMILIES.values() for family in families}
        self.assertEqual(used,{family for family,_ in ci.PROCESS_EXIT_FAMILIES})  # no dead family

    def test_web_next_build_heap_abort_through_the_private_log(self):
        final=client_process('/bin/sh -c bun run build',134)
        with tempfile.TemporaryDirectory() as name:
            work=Path(name);work.chmod(0o700);ci.write_private(work/'build.private.log',buildx_failure(final))
            closed={'pid':123,'waited':True,'groupClosed':True};error=ValueError('recipe_build_failed')
            got=ci.command_failure(error,work,closed,buildx_client=True)
            self.assertEqual(got,'observed_process_exit_next_build_134')
            self.assertEqual(ci.command_failure(error,work,closed),'diagnostic_unknown_control_cr')
            projected=ci.project({'status':'failed','phase':'images','step':'image-web-build','errorCode':got,'cleanup':True,'images':{}})
            self.assertEqual(len(projected),7);self.assertEqual(projected['errorCode'],got)

    def test_exit_classes_are_closed_and_137_keeps_its_code(self):
        for code,kind in [(1,'1'),(2,'2'),(127,'127'),(134,'134'),(139,'139'),(3,'other'),(126,'other'),(128,'other'),
                          (130,'other'),(135,'other'),(136,'other'),(138,'other'),(140,'other'),(143,'other'),(255,'other')]:
            with self.subTest(code=code):self.both_paths(client_process('/bin/sh -c bun run build',code),'observed_process_exit_next_build_'+kind)
        self.both_paths(client_process('/bin/sh -c bun run build',137),'observed_exit_137')
        self.both_paths(client_process('/bin/sh -c PRIVATE_CANARY',137),'observed_exit_137')
        # Outside the existing exit grammar nothing changes: no marker, so the refusal or no_marker stays.
        for code in (0,256,999,'01','1x'):
            with self.subTest(code=code):
                self.assertClosed(buildx_failure(client_process('/bin/sh -c bun run build',code)),'diagnostic_unknown_control_cr')
                self.assertClosed(client_process('/bin/sh -c bun run build',code)+b'\n','diagnostic_unknown_no_marker')

    def test_unrecognized_malformed_or_foreign_commands_are_other_and_never_echo(self):
        build=b'ERROR: failed to build: failed to solve: process '
        tail=b' did not complete successfully: exit code: 2'
        for body in ['/bin/sh -c echo PRIVATE_CANARY','/bin/sh -c bun run build:PRIVATE_CANARY','/bin/sh -c bun run buildPRIVATE_CANARY',
                     '/bin/sh -c bun run build-x','/bin/sh -c bun run build.CANARY','/bin/sh -c bun run build/x','/bin/sh -c bun run build=1',
                     '/bin/bash -c bun run build','bun run build','/bin/sh -cbun run build','/bin/sh -c CANARY bun run build',
                     '/bin/sh -c bun run build\nPRIVATE_CANARY','/bin/sh -c bun run build\x1bCANARY','/bin/sh -c bun run build\x7f',
                     '/bin/sh -c apk  add\x00x','/bin/sh -c','',
                     '/bin/sh -c groupadd\u00a0CANARY','/bin/sh -c bun run build \x1b[31mCANARY','/bin/sh -c bun run build caf\u00e9',
                     '/bin/sh -c bun run build \u2028','/bin/sh -c bun run build ;\x00','/bin/sh -c apt-get autoremove']:
            with self.subTest(body=body):self.both_paths(client_process(body,2),'observed_process_exit_other_2')
        for literal in [b'"/bin/sh -c bun run build" PRIVATE_CANARY "x"',b'"/bin/sh -c bun run build\\q"',b'"/bin/sh -c bun run build\\xff"',
                        b'"/bin/sh -c bun run build\\ud800"',b'"/bin/sh -c bun run build\\U00110000"',b'"/bin/sh -c bun run build\\"',
                        b'"/bin/sh -c bun run build\\',b'/bin/sh -c bun run build',b"'/bin/sh -c bun run build'",
                        b'"/bin/sh -c bun run build\\x2"',b'"/bin/sh -c bun \\101run build"',b'"/bin/sh -c bun run build\\\'"',
                        b'"/bin/sh -c bun run build \\q"',b'"/bin/sh -c bun run build \\101"',b'"/bin/sh -c bun run build \\xff"',
                        b'"/bin/sh -c bun run build \\x"',b'"/bin/sh -c bun run build \\u00e9"']:
            with self.subTest(literal=literal):self.both_paths(build+literal+tail,'observed_process_exit_other_2')
        # Faithful Go escapes and whitespace from joined continuation lines are decoded, never refused.
        for literal in [b'"/bin/sh -c bun run build"',b'"/bin/sh -c  bun\\trun   build "',b'"\\x2fbin/sh -c bun run build"',
                        b'"/bin/sh -c bun run \\u0062uild"',b'"/bin/sh -c bun run \\U00000062uild"',b'"/bin/sh\\t-c bun run build"']:
            with self.subTest(literal=literal):self.both_paths(build+literal+tail,'observed_process_exit_next_build_2')
        self.both_paths(client_process('/bin/sh -c bun run build && echo "PRIVATE_CANARY \\\\ x"',2),'observed_process_exit_next_build_2')
        self.both_paths(client_process('/bin/sh -c bun run build;PRIVATE_CANARY',2),'observed_process_exit_next_build_2')

    def test_go_unquoted_is_the_exact_inverse_of_strconv_quote(self):
        for text in ['/bin/sh -c bun run build','a"b\\c\td\x1b\x7f','tab\there "q" \\\\','é \U0001f600','']:
            with self.subTest(text=text):self.assertEqual(ci.go_unquoted(go_quoted(text)[1:-1]),text)
        for body in ['a"b','a\\','a\\q','a\\101','a\\xff','a\\x8','a\\ud800','a\\U00110000','a\\\'','a\\0']:
            with self.subTest(body=body):self.assertIsNone(ci.go_unquoted(body))

    def test_two_recognized_families_are_other(self):
        families=dict(ci.PROCESS_EXIT_FAMILIES)
        overlapping={**families,'bundles':families['bundles']+('bun run',)}
        with patch.object(ci,'PROCESS_EXIT_FAMILIES',tuple(overlapping.items())):
            self.both_paths(client_process('/bin/sh -c bun run build',1),'observed_process_exit_other_1')
            self.both_paths(client_process('/bin/sh -c bun --no-env-file run build:cli-runtime',1),'observed_process_exit_bundles_1')
        same={**families,'bootstrap':families['bootstrap']+('bun run build',)}
        with patch.object(ci,'PROCESS_EXIT_FAMILIES',tuple(same.items())):
            self.both_paths(client_process('/bin/sh -c bun run build',1),'observed_process_exit_other_1')
        # The real table never recognizes one prefix inside another family's.
        prefixes=[(family,prefix) for family,values in ci.PROCESS_EXIT_FAMILIES for prefix in values]
        for family,prefix in prefixes:
            self.assertEqual(prefix,' '.join(prefix.split()))
            self.assertEqual(ci.process_exit_family('/bin/sh -c '+prefix),family)

    def test_forged_child_lines_never_choose_family_or_class(self):
        final=client_process('/bin/sh -c bun run build',1)
        forged=client_process('/bin/sh -c apt-get update && apt-get install PRIVATE_CANARY',2)
        for raw in [buildx_failure(final,quoted=b'12.34 '+forged),buildx_failure(final,quoted=forged),
                    buildx_failure(final).replace(b'#15 ERROR:',b'#15 4.000 '+forged+b'\n#15 ERROR:'),
                    buildx_failure(final,refused=b'#15 3.2 PRIVATE_CANARY').replace(b'#15 ERROR:',b'#15 4.000 '+forged+b'\n#15 ERROR:'),
                    forged+b'\n#9 x\ry\n'+final+b'\n']:
            with self.subTest(raw=raw[-70:]):self.assertClosed(raw,'observed_process_exit_next_build_1')
        # A forged line that is last but prefixed, or not last, never becomes the detail.
        clean=b'#15 3.2 ok\n'
        for raw in [clean+b'#15 4.000 '+forged+b'\n',clean+forged+b'\n#15 done\n',clean+b'\x1b[31m'+forged+b'\x1b[0m\n',
                    clean+forged+b'\n   \n']:
            with self.subTest(raw=raw[-60:]):self.assertClosed(raw,'observed_process_exit')
        for raw in [b'#9 x\ry\n#15 4.000 '+forged+b'\n',b'#9 x\ry\n'+forged+b'\n#15 done\n']:
            with self.subTest(raw=raw[-60:]):self.assertClosed(raw,'diagnostic_unknown_control_cr')

    def test_detail_never_applies_outside_the_declared_client_or_another_marker(self):
        final=client_process('/bin/sh -c bun run build',1)
        self.assertClosed(final+b'\n','observed_process_exit',buildx_client=False)
        self.assertClosed(buildx_failure(final,refused=b'#15 PRIVATE_CANARY'),'observed_process_exit',buildx_client=False)
        self.assertClosed(buildx_failure(final),'diagnostic_unknown_control_cr',buildx_client=False)
        self.assertEqual(ci.classify_command_output(final+b'\n'),'observed_process_exit')
        for other,expected in [(b'#15 1.0 FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory','observed_js_heap_limit'),
                               (b'#15 1.0 error: lockfile had changes, but lockfile is frozen','observed_lockfile_frozen')]:
            self.assertClosed(other+b'\n'+final+b'\n',expected)
        self.assertClosed(buildx_failure(final,quoted=b'unknown flag: --load'),'diagnostic_unknown_ambiguous')
        self.assertClosed(buildx_failure(final,quoted=client_process('/bin/sh -c bun run build',137)),'diagnostic_unknown_ambiguous')
        self.assertClosed(client_process('/bin/sh -c bun run build',2)+b'\n'+final+b'\n','observed_process_exit_next_build_1')
        self.assertClosed(client_process('/bin/sh -c bun run build',137)+b'\n'+final+b'\n','diagnostic_unknown_ambiguous')
        self.assertClosed(final+b'\r\n','observed_process_exit_next_build_1')
        self.assertClosed(final+b'\n\n\n','observed_process_exit_next_build_1')

    def test_run_transport_publishes_detail_only_for_the_declared_build(self):
        raw=buildx_failure(client_process('/bin/sh -c bun run build',134))
        command,docker,record,calls=ClientLineAfterRefusal.run_transport(self,raw)
        for call,expected in [(lambda:command(['/usr/bin/bun','install']),'diagnostic_unknown_control_cr'),
                              (lambda:docker(['buildx','build','.']),'diagnostic_unknown_control_cr'),
                              (lambda:docker(['buildx','build','.'],buildx_client=True),'observed_process_exit_next_build_134')]:
            record.pop('errorCode',None)
            with self.assertRaisesRegex(ValueError,'recipe_build_failed'):call()
            self.assertEqual(record['errorCode'],expected)
        self.assertEqual(len(calls),3)

    def test_generated_codes_are_closed_and_accepted_by_the_workflow(self):
        # Depends on the YAML shape of the workflow's verdict block (its 10-space 'import importlib...'
        # first line and closing '          PY'), like the projection test above: reindenting that
        # block fails loudly here (split IndexError or compile error), never silently passes.
        import contextlib,io,os,re,sys,textwrap
        from types import SimpleNamespace
        families=[family for family,_ in ci.PROCESS_EXIT_FAMILIES]
        self.assertEqual(len(families),len(set(families)));self.assertNotIn('other',families)
        expected={'observed_process_exit_'+f+'_'+k for f in (*families,'other') for k in ('1','2','127','134','139','other')}
        self.assertEqual(set(ci.PROCESS_EXIT_CODES),expected);self.assertEqual(len(expected),6*(len(families)+1))
        self.assertLessEqual(expected,ci.ERROR_CODES)
        self.assertTrue({'observed_process_exit','observed_exit_137'}<=ci.ERROR_CODES)
        self.assertTrue(all(re.fullmatch('[a-z0-9_]{1,64}',code) for code in ci.ERROR_CODES))
        workflow=(ci.ROOT/'.github/workflows/memlia-excel-linux.yml').read_text()
        start='          import importlib.util,json,os,stat,sys\n'
        block=start+workflow.split(start,1)[1].split('          PY',1)[0]
        self.assertIn("value['errorCode'] in module.ERROR_CODES",block)
        code=compile(textwrap.dedent(block),'workflow-projection','exec')
        real_fstat=os.fstat
        def root_owned(fd):
            value=real_fstat(fd);return SimpleNamespace(st_mode=value.st_mode,st_uid=0,st_nlink=value.st_nlink)
        with tempfile.TemporaryDirectory() as d,patch.object(sys,'argv',['projection',str(ci.ROOT),d]),patch.object(os,'fstat',root_owned):
            for value in sorted(expected):
                summary=ci.project({'status':'failed','phase':'images','step':'image-web-build','errorCode':value,'cleanup':True,'images':{}})
                (Path(d)/'summary.json').write_text(json.dumps(summary));output=io.StringIO()
                with contextlib.redirect_stdout(output):exec(code,{})
                self.assertEqual(json.loads(output.getvalue()),summary)
            (Path(d)/'summary.json').write_text(json.dumps(summary|{'errorCode':'observed_process_exit_PRIVATE_CANARY_1'}))
            with contextlib.redirect_stdout(io.StringIO()),self.assertRaises(AssertionError):exec(code,{})

class WebContextCheck(unittest.TestCase):
    def test_check_arguments_preserve_exact_inputs_without_build_outputs(self):
        args=ci.web_check_arguments('owned',Path('/context'),'a'*40,'b'*64,'c'*32)
        self.assertEqual(args[:2],['buildx','build']);self.assertIn('--call=check',args)
        self.assertIn('--cgroup-parent=/',args);self.assertIn('NEXT_PUBLIC_APP_URL='+ci.ORIGIN,args)
        self.assertIn('MEMLIA_SOURCE_COMMIT='+'a'*40,args);self.assertIn('MEMLIA_LOCK_SHA256='+'b'*64,args)
        self.assertEqual(args[-3:],['--file','/context/Dockerfile','/context'])
        for word in ('--load','--push','--tag','--output','RUN'):
            self.assertNotIn(word,args)

    def test_web_check_uses_real_git_context_and_only_frontend_command(self):
        import os,subprocess
        helper=ci.load(ci.ROOT/'deploy/memlia/images/tests/prepare_context.py','web_check_context_fixture')
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)/'source';root.mkdir();private=Path(d)/'private';private.mkdir();seen=[];commands=[]
            files={'docker/app.Dockerfile':'FROM scratch\n','bun.lock':'fixture lock\n','package.json':'{}',
                   'bunfig.toml':'','turbo.json':'{}','patches/f.patch':'fixture','packages/example/a.ts':'export {}',
                   'apps/sim/page.tsx':'export {}','compliance/upstream/sim/LICENSE':'fixture license'}
            for name,value in files.items():
                p=root/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(value)
            def git(*args):return subprocess.check_output(['git','-C',str(root),*args],stderr=subprocess.PIPE,timeout=10,
                env={'PATH':os.environ['PATH'],'HOME':os.environ['HOME'],'GIT_CONFIG_NOSYSTEM':'1'})
            git('init','-q');git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-qm','fixture')
            source=git('rev-parse','HEAD').decode().strip();lock=__import__('hashlib').sha256((root/'bun.lock').read_bytes()).hexdigest()
            record={'status':'failed','phase':'tools','cleanup':False,'images':{}}
            def start():seen.append('builder');return lambda:seen.append('guard')
            def docker(args,**kw):commands.append((args,kw));seen.append('check')
            ci.check_web_context(helper,root,private,source,lock,'c'*32,'owned',docker=docker,start_builder=start,
                                 source=lambda:seen.append('source'),disk=lambda:seen.append('disk'),record=record)
            self.assertTrue((private/'web/Dockerfile').is_file());self.assertFalse((private/'assets').exists())
            self.assertEqual(len(commands),1);self.assertEqual(commands[0][1],{'seconds':180,'buildx_client':True})
            self.assertIn('--call=check',commands[0][0]);self.assertEqual(seen,['source','disk','source','builder','check','guard','source'])
            self.assertEqual(record['phase'],'web-check');self.assertEqual(record['step'],'web-check')
            self.assertEqual(record['status'],'passed');self.assertFalse(record['durableQualified']);self.assertEqual(record['images'],{})
            # This helper stops at a command failure: no retry, typegen or image side effect.
            record.update(status='failed');calls=[]
            def refuse(*args,**kwargs):calls.append(1);raise ValueError('native_check_failed')
            with self.assertRaisesRegex(ValueError,'native_check_failed'):
                ci.check_web_context(helper,root,private/'second',source,lock,'c'*32,'owned',docker=refuse,
                    start_builder=start,source=lambda:None,disk=lambda:None,record=record)
            self.assertEqual(calls,[1]);self.assertEqual(record['status'],'failed')

    def test_call_option_must_be_announced_by_real_help(self):
        version=b'github.com/docker/buildx v0.29.1 '+b'a'*40+b'\n'
        help_text=b'Usage:  docker buildx build [OPTIONS] PATH | URL | -\n      --cgroup-parent string Parent\n'
        for option,code in [(b'      --call string Set frontend method\n',None),
                            (b'', 'cli_call_unavailable'),(b'      --call-fake string PRIVATE_CANARY\n','cli_call_unavailable'),
                            (b'      --call string one\n      --call string two\n','diagnostic_unknown')]:
            calls=[]
            def execute(args,**kw):calls.append(args);return version if len(calls)==1 else help_text+option
            if code is None:self.assertTrue(ci.probe_buildx(execute,lambda _:None,require_call=True)['callListed'])
            else:
                with self.assertRaises(ValueError) as caught:ci.probe_buildx(execute,lambda _:None,require_call=True)
                self.assertEqual(ci.error_code(caught.exception),code)
            self.assertEqual(len(calls),2)

    def test_short_success_never_projects_as_durable_or_emits_extra_data(self):
        good={'status':'passed','phase':'web-check','step':'web-check','cleanup':True,'images':{},'durableQualified':False,'stderr':'PRIVATE_CANARY'}
        projected=ci.project(good)
        self.assertEqual(len(projected),7);self.assertEqual(projected['imagesBuilt'],0);self.assertFalse(projected['durableQualified'])
        self.assertNotIn('PRIVATE_CANARY',json.dumps(projected))
        for change in ({'images':{'web':{}}},{'durableQualified':True},{'cleanup':False},{'step':'image-web-build'},
                       {'phase':'complete','step':'complete'},{'errorCode':'diagnostic_unknown_no_marker'}):
            with self.subTest(change=change),self.assertRaises(ValueError):ci.project(good|change)
        with self.assertRaises(ValueError):ci.project(good|{'mode':'web-check','phase':'complete','step':'complete','images':dict.fromkeys(ci.APPS,{}),'durableQualified':True})

    def test_unknown_reasons_are_closed_and_do_not_weaken_recognition(self):
        cases=[(b'PRIVATE_CANARY', 'diagnostic_unknown_no_marker'),(b'','diagnostic_unknown_bounds'),
               (b'\xffPRIVATE_CANARY','diagnostic_unknown_utf8'),(b'PRIVATE_CANARY\x00','diagnostic_unknown_control_nul'),
               (b'unkno\x1b[31mwn flag: --cgroup-parent','diagnostic_unknown_control_sgr'),
               (b'x'*8193,'diagnostic_unknown_bounds'),(b'\n'*65537,'diagnostic_unknown_bounds'),
               (b'unknown flag: --cgroup-parent\nerror: lockfile had changes, but lockfile is frozen\n','diagnostic_unknown_ambiguous'),
               (b'ERROR: failed to build: failed to solve: process "x" did not complete successfully: exit code: 1\nERROR: failed to build: failed to solve: process "x" did not complete successfully: exit code: 137\n','diagnostic_unknown_ambiguous')]
        for raw,expected in cases:
            with self.subTest(expected=expected):
                value=ci.classify_command_output(raw);self.assertEqual(value,expected);self.assertIn(value,ci.ERROR_CODES)
                self.assertNotIn('PRIVATE_CANARY',value)
        self.assertEqual(ci.classify_command_output(b'unknown flag: --cgroup-parent;PRIVATE_CANARY'),'diagnostic_unknown_no_marker')
        self.assertEqual(ci.classify_command_output(b'\x1b[31munknown flag: --cgroup-parent\x1b[0m\n'),'observed_cli_flag_refused')

    def test_short_mode_is_explicit_and_skips_installs_types_registry_and_qualification(self):
        import ast
        args=ci.arguments(['--check-web-context','--expected-commit','a'*40,'--output','/var/lib/memlia-excel-ci-fixture'])
        self.assertEqual(args.mode,'web-check');self.assertIsNone(args.node);self.assertIsNone(args.wheelhouse)
        with self.assertRaises(SystemExit):ci.arguments(['--check-web-context','--exercise-durable','--expected-commit','a'*40,'--output','/tmp/x'])
        tree=ast.parse(Path(ci.__file__).read_text());run=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='run')
        branch=next(n for n in ast.walk(run) if isinstance(n,ast.If) and ast.unparse(n.test)=="mode == 'web-check'" and any(isinstance(c,ast.Name) and c.id=='check_web_context' for c in ast.walk(n)))
        calls=[n.func.id if isinstance(n.func,ast.Name) else '' for n in ast.walk(ast.Module(body=branch.body,type_ignores=[])) if isinstance(n,ast.Call)]
        self.assertEqual(calls,['check_web_context'])
        self.assertIn('check_types',[n.func.id for n in ast.walk(ast.Module(body=branch.orelse,type_ignores=[])) if isinstance(n,ast.Call) and isinstance(n.func,ast.Name)])
        self.assertEqual(sum(isinstance(n,ast.FunctionDef) and n.name=='start_builder' for n in ast.walk(run)),1)
        workflow=(ci.ROOT/'.github/workflows/memlia-excel-linux.yml').read_text()
        self.assertIn('check_web_context:',workflow);self.assertIn('!inputs.check_web_context',workflow)
        self.assertIn("inputs.exercise_durable || inputs.check_web_context",workflow)
        self.assertIn('MEMLIA_CHECK_WEB_CONTEXT',workflow);self.assertIn('--check-web-context',workflow)

    def test_workflow_refuses_conflicting_modes_before_checkout(self):
        import os,subprocess
        workflow=(ci.ROOT/'.github/workflows/memlia-excel-linux.yml').read_text()
        job=workflow.split('  durable:\n',1)[1]
        line=next(line.strip().removeprefix('run: ') for line in job.splitlines() if line.strip().startswith('run: test '))
        self.assertLess(job.index('run: test '),job.index('actions/checkout@'))
        for durable,check,expected in [('0','0',0),('1','0',0),('0','1',0),('1','1',1)]:
            result=subprocess.run(['/bin/bash','-c',line],env=os.environ|{'MEMLIA_EXERCISE_DURABLE':durable,'MEMLIA_CHECK_WEB_CONTEXT':check},
                                  capture_output=True,timeout=2)
            self.assertEqual(result.returncode,expected);self.assertEqual(result.stdout+result.stderr,b'')

class InactiveJourney(unittest.TestCase):
    def test_qualification_json_is_unchanged_by_default_and_selects_only_exact_journey(self):
        import ast
        private=Path('/var/lib/memlia-excel-ci-fixture/private');images={'owned':'image'};browser={'owned':'browser'}
        expected={'schemaVersion':'memlia.excel-durable-qualification/v1','sourceCommit':'a'*40,'lockSha256':'b'*64,'nonce':'c'*32,
                  'envFile':str(private/'compose.env'),'bootstrapFile':str(private/'bootstrap.json'),'images':images,'browser':browser}
        original=(json.dumps(expected,sort_keys=True)+'\n').encode()
        default=ci.qualification_values('a'*40,'b'*64,'c'*32,private,images,browser)
        explicit=ci.qualification_values('a'*40,'b'*64,'c'*32,private,images,browser,inactive_test=False)
        self.assertEqual((json.dumps(default,sort_keys=True)+'\n').encode(),original)
        self.assertEqual((json.dumps(explicit,sort_keys=True)+'\n').encode(),original)
        selected=ci.qualification_values('a'*40,'b'*64,'c'*32,private,images,browser,inactive_test=True)
        self.assertEqual(selected,expected|{'journey':'inactive-test'})
        self.assertEqual((json.dumps(expected,sort_keys=True)+'\n').encode(),original)
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'qualification.json';ci.write_private(path,default)
            self.assertEqual(path.read_bytes(),original)
        # Execute the producer's actual configuration assignment, not an alternative fixture producer.
        tree=ast.parse(Path(ci.__file__).read_text())
        run=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='run')
        assignment=next(n for n in ast.walk(run) if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='qualification' for t in n.targets))
        for flag in (False,True):
            scope={'qualification_values':ci.qualification_values,'expected':'a'*40,'lock':'b'*64,'nonce':'c'*32,
                   'private':private,'images':images,'browser':browser,'inactive_test':flag}
            exec(compile(ast.Module(body=[assignment],type_ignores=[]),str(ci.__file__),'exec'),scope)
            self.assertEqual(scope['qualification'],expected|({'journey':'inactive-test'} if flag else {}))

    def test_cli_selector_is_explicit_closed_and_refused_outside_durable(self):
        import contextlib,io
        common=['--expected-commit','a'*40,'--output','/var/lib/memlia-excel-ci-fixture']
        tools=['--node','/tools/node','--wheelhouse','/tools/wheels']
        for extra,expected in [([],False),(['--inactive-test'],True)]:
            parsed=ci.arguments(['--exercise-durable',*common,*tools,*extra])
            self.assertIs(parsed.inactive_test,expected);self.assertEqual(parsed.mode,'durable')
        self.assertIs(ci.arguments(['--check-web-context',*common]).inactive_test,False)
        for flags in [['--check-web-context','--inactive-test'],['--inactive-test'],
                      ['--check-web-context','--exercise-durable','--inactive-test'],
                      ['--exercise-durable','--inactive-test=other'],['--exercise-durable','--journey','other']]:
            with self.subTest(flags=flags),contextlib.redirect_stderr(io.StringIO()),self.assertRaises(SystemExit) as error:
                ci.arguments([*flags,*common,*tools])
            self.assertEqual(error.exception.code,2)

    def test_incompatible_selection_is_refused_before_platform_or_filesystem_io(self):
        from unittest.mock import patch
        with patch.object(ci.os,'geteuid',side_effect=AssertionError('platform reached')),patch.object(Path,'exists',side_effect=AssertionError('filesystem reached')):
            for mode,flag in [('web-check',True),('durable','inactive-test'),('durable',1),('durable',None)]:
                with self.subTest(mode=mode,flag=flag),self.assertRaises(ValueError):
                    ci.run('a'*40,Path('/var/lib/memlia-excel-ci-fixture'),Path('/tools/node'),Path('/tools/wheels'),mode=mode,inactive_test=flag)
        for invalid in ('inactive-test',1,None):
            with self.subTest(invalid=invalid),self.assertRaises(ValueError):
                ci.qualification_values('a'*40,'b'*64,'c'*32,Path('/private'),{}, {},inactive_test=invalid)

    def test_manual_input_and_all_flag_combinations_are_closed_before_checkout(self):
        import os,subprocess
        workflow=(ci.ROOT/'.github/workflows/memlia-excel-linux.yml').read_text()
        inputs=workflow.split('  workflow_dispatch:\n',1)[1].split('  pull_request:',1)[0]
        option=inputs.split('      inactive_test:\n',1)[1].split('      check_web_context:\n',1)[0]
        for field in ('        required: false\n','        default: false\n','        type: boolean\n'):self.assertIn(field,option)
        self.assertIn('!inputs.inactive_test',workflow.split('  durable:\n',1)[0])
        job=workflow.split('  durable:\n',1)[1]
        self.assertIn('inputs.exercise_durable || inputs.check_web_context || inputs.inactive_test',job)
        line=next(line.strip().removeprefix('run: ') for line in job.splitlines() if line.strip().startswith('run: test '))
        self.assertLess(job.index('run: test '),job.index('actions/checkout@'))
        for durable in ('0','1'):
            for check in ('0','1'):
                for inactive in ('0','1'):
                    result=subprocess.run(['/bin/bash','-c',line],env=os.environ|{'MEMLIA_EXERCISE_DURABLE':durable,
                        'MEMLIA_CHECK_WEB_CONTEXT':check,'MEMLIA_INACTIVE_TEST':inactive},capture_output=True,timeout=2)
                    expected=not(durable=='1' and check=='1') and (inactive=='0' or (durable=='1' and check=='0'))
                    with self.subTest(durable=durable,check=check,inactive=inactive):
                        self.assertEqual(result.returncode,0 if expected else 1);self.assertEqual(result.stdout+result.stderr,b'')

    def test_manual_runner_forwards_selector_only_when_requested(self):
        import os,subprocess
        workflow=(ci.ROOT/'.github/workflows/memlia-excel-linux.yml').read_text()
        step=workflow.split('      - name: Exécuter uniquement le parcours manuel sélectionné\n',1)[1].split('      - name:',1)[0]
        self.assertIn("MEMLIA_INACTIVE_TEST: ${{ inputs.inactive_test && '1' || '0' }}",step)
        block='if [[ "$MEMLIA_CHECK_WEB_CONTEXT" == 1 ]]; then'+step.split('if [[ "$MEMLIA_CHECK_WEB_CONTEXT" == 1 ]]; then',1)[1].split('          timeout --signal=',1)[0]
        for check,inactive,expected in [('0','0',['--exercise-durable','--node','/fixture/node','--wheelhouse','/fixture/temp/excel-durable-wheels']),
                                       ('0','1',['--exercise-durable','--node','/fixture/node','--wheelhouse','/fixture/temp/excel-durable-wheels','--inactive-test']),
                                       ('1','0',['--check-web-context'])]:
            code='set -euo pipefail\ncommand() { printf /fixture/node; }\n'+block+'\nprintf "%s\\0" "${extra[@]}"'
            result=subprocess.run(['/bin/bash','-c',code],env=os.environ|{'MEMLIA_CHECK_WEB_CONTEXT':check,'MEMLIA_INACTIVE_TEST':inactive,
                'RUNNER_TEMP':'/fixture/temp'},capture_output=True,timeout=2)
            self.assertEqual(result.returncode,0);self.assertEqual(result.stderr,b'')
            self.assertEqual(result.stdout.decode().split('\0')[:-1],expected)

class BuilderAdmission(unittest.TestCase):
    """Real start_builder fragment of run(), Docker doubled; shared admission/verify are real."""
    def start(self,store):
        import ast,sys,textwrap,time
        directory=str(ci.ROOT/'runtimes/excel/linux')
        if directory not in sys.path:sys.path.insert(0,directory)
        import test_image_identity as fixture
        native=ci.load(ci.ROOT/'scripts/ci/workflow-worker-image.py','builder_admission_native')
        tree=ast.parse(Path(ci.__file__).read_text())
        run=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='run')
        node=next(n for n in run.body if isinstance(n,ast.FunctionDef) and n.name=='start_builder')
        source=('def outer():\n    builder_unknown=builder_id=builder_image=None\n'
                +textwrap.indent(ast.unparse(node),'    ')
                +'\n    return start_builder,lambda:(builder_unknown,builder_id,builder_image)\n')
        folder=tempfile.TemporaryDirectory();self.addCleanup(folder.cleanup)
        private=Path(folder.name);calls=[];manifest=native.BUILDKIT.split('@')[1]
        cid='e'*64;name='memlia-excel-build-fixture'
        def docker(args,**kw):
            calls.append(args[:2])
            if args[:2]==['image','save']:
                self.assertEqual((args[2],args[4],kw.get('seconds')),('--output',native.BUILDKIT,180))
                if store=='save-fails':
                    Path(args[3]).write_bytes(b'partial');raise ValueError('command_failed')
                members=fixture.saved_members(fixture.BUILDKIT)
                if store=='containerd-config':
                    members=[(n,fixture.PYTHON[2].read_bytes() if n.endswith(manifest[7:]) else d) for n,d in members]
                (private/'fixture').mkdir(exist_ok=True)
                Path(args[3]).write_bytes(fixture.archive(private/'fixture',members).read_bytes())
                return b''
            if args[:2]==['container','exec']:
                return {'memory.max':str(13*1024**3),'memory.swap.max':str(24*1024**3),'cpu.max':'400000 100000','pids.max':'512'}[args[-1].rsplit('/',1)[1]].encode()
            if args[:2]==['container','update']:self.assertFalse((private/'buildkit-image.tar').exists())
            return b''
        def one(args,**kw):
            if args[:2]==['image','inspect']:
                row=fixture.classic_row(fixture.BUILDKIT) if store=='classic' else fixture.containerd_row(fixture.BUILDKIT)
                if store=='index':row['Descriptor']['mediaType']='application/vnd.oci.image.index.v1+json'
                return row
            return {'Id':cid,'Name':'/buildx_buildkit_'+name+'0','Image':native.BUILDKIT_CONFIG if store=='classic' else manifest,
                    'Mounts':[{'Type':'volume','Name':'buildx_buildkit_'+name+'0_state','Destination':'/var/lib/buildkit'}],
                    'HostConfig':{'Memory':13*1024**3,'MemorySwap':37*1024**3,'CpuQuota':400000,'CpuPeriod':100000,'PidsLimit':512},
                    'State':{'Running':True,'OOMKilled':False}}
        scope={'docker':docker,'one':one,'require':ci.require,'native':native,'private':private,'builder':name,
               'record':{},'write_private':lambda path,data:path.write_bytes(data)}
        exec(compile(source,str(ci.__file__),'exec'),scope)
        start,state=scope['outer']()
        return start,state,calls,private,native

    def test_classic_and_containerd_builders_are_admitted_then_reverified_by_the_kernel_check(self):
        for store in ('classic','containerd'):
            with self.subTest(store=store):
                start,state,calls,private,native=self.start(store)
                kernel=start();unknown,builder_id,image=state()
                self.assertEqual((unknown,builder_id),(False,'e'*64))
                self.assertEqual(image,native.BUILDKIT_CONFIG if store=='classic' else native.BUILDKIT.split('@')[1])
                self.assertEqual(['image','save'] in calls,store=='containerd')
                self.assertFalse((private/'buildkit-image.tar').exists())
                kernel()

    def test_foreign_manifest_or_failed_export_is_refused_before_any_builder_mutation(self):
        for store in ('containerd-config','save-fails'):
            with self.subTest(store=store):
                start,state,calls,private,native=self.start(store)
                with self.assertRaises(ValueError):start()
                self.assertIsNone(state()[2]);self.assertNotIn(['container','update'],calls)
                self.assertFalse((private/'buildkit-image.tar').exists())

    def test_builder_pulled_by_index_keeps_a_distinct_closed_receipt_code(self):
        start,state,calls,private,native=self.start('index')
        with self.assertRaises(ValueError) as caught:start()
        self.assertEqual(ci.error_code(caught.exception),'builder_identity_index_refused')
        self.assertIn('builder_identity_index_refused',ci.ERROR_CODES)
        self.assertNotIn(['image','save'],calls);self.assertNotIn(['container','update'],calls)


if __name__=='__main__':unittest.main()
