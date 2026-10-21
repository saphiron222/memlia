# Copyright 2026 Memlia. All rights reserved.
"""Preparation boundaries only: Docker/Compose/browser execution is not simulated qualification."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

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
                           (b'unkno\x1b[31mwn flag: --cgroup-parent\n','control'),(b'\xffunknown flag: --cgroup-parent','utf8'),
                           (b'\x00unknown flag: --cgroup-parent','control'),(b'PRIVATE_CANARY\vunknown flag: --cgroup-parent','control'),
                           (b'unknown flag: --cgroup-parent\vPRIVATE_CANARY','control'),(b'PRIVATE_CANARY\xe2\x80\xa8unknown flag: --cgroup-parent','no_marker'),
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
            def observed(data):self.assertEqual((work/'build.private.log').read_bytes(),raw);return original(data)
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
            self.assertEqual(len(commands),1);self.assertEqual(commands[0][1],{'seconds':180})
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
               (b'\xffPRIVATE_CANARY','diagnostic_unknown_utf8'),(b'PRIVATE_CANARY\x00','diagnostic_unknown_control'),
               (b'unkno\x1b[31mwn flag: --cgroup-parent','diagnostic_unknown_control'),
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

if __name__=='__main__':unittest.main()
