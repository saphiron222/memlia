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

    def test_output_no_overwrite(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'private';ci.write_private(p,b'first')
            with self.assertRaises(FileExistsError):ci.write_private(p,b'second')
            self.assertEqual(p.read_bytes(),b'first');self.assertEqual(p.stat().st_mode&0o777,0o600)

if __name__=='__main__':unittest.main()
