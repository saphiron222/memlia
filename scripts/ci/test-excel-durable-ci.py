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
            body=next(n for n in run.body if isinstance(n,ast.Try)).body
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
                for change in ({'errorCode':'PRIVATE_CANARY'},{'step':'PRIVATE_CANARY'},
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

if __name__=='__main__':unittest.main()
