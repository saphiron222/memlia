#!/usr/bin/env python3
# Copyright 2026 Memlia. All rights reserved.
"""Test the public PostgreSQL lane without any server or inherited credential."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('postgres_tests',Path(__file__).with_name('postgres-tests.py'))
lane=importlib.util.module_from_spec(spec);spec.loader.exec_module(lane)
NONCE='a'*32
CONFIG={'MEMLIA_PG_NONCE':NONCE}


class LaneTests(unittest.TestCase):
    def test_only_disposable_loopback_admin_database_is_admitted(self):
        self.assertEqual(lane.target('postgres://postgres@127.0.0.1:60339/postgres').port,60339)
        for raw in ('postgres://postgres@example.com/postgres','postgres://postgres@localhost/real',
                    'postgres://postgres@localhost/postgres?sslmode=disable',
                    'postgres://postgres@localhost/postgres#x','https://localhost/postgres',
                    'postgres://postgres@localhost:0/postgres','postgres://bad%0aname@localhost/postgres'):
            with self.subTest(raw=raw),self.assertRaises(ValueError):lane.target(raw)

    def test_generated_roles_differ_and_secrets_never_come_from_ambient_environment(self):
        env=lane.environment({**os.environ,'OPENAI_API_KEY':'no','DATABASE_URL_WEB':'no','GITHUB_TOKEN':'no'})
        self.assertFalse({'OPENAI_API_KEY','DATABASE_URL_WEB','GITHUB_TOKEN'}&env.keys())
        config=lane.configuration('postgres://postgres@127.0.0.1:60339/postgres',NONCE)
        self.assertNotEqual(config['MEMLIA_PG_MIGRATE_URL'],config['MEMLIA_PG_WEB_URL'])
        self.assertIn('/memlia_p06_budget_test',config['MEMLIA_PG_WEB_URL'])
        self.assertNotIn('DATABASE_URL',config)

    def test_real_child_nonzero_timeout_and_closed_output_are_failures(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            code,value=lane.phase([sys.executable,'-c','print("sensitive fixture");raise SystemExit(3)'],root,dict(os.environ),2)
            self.assertEqual((code,value),(3,None))
            code,value=lane.phase([sys.executable,'-c','import time;time.sleep(2)'],root,dict(os.environ),.05)
            self.assertEqual((code,value),(124,None))
            code,value=lane.phase([sys.executable,'-c','print("not json")','baseline'],root,dict(os.environ),2)
            self.assertEqual((code,value),(1,None))

    def test_existing_report_refuses_before_any_effect(self):
        with tempfile.TemporaryDirectory() as folder:
            report=Path(folder)/'report.json';report.write_text('existing')
            with patch.object(lane,'phase') as child,self.assertRaises(FileExistsError):
                lane.run(Path(folder),CONFIG,report)
            child.assert_not_called();self.assertEqual(report.read_text(),'existing')

    def test_unknown_bootstrap_retains_resources_and_never_migrates_or_cleans(self):
        with tempfile.TemporaryDirectory() as folder:
            report=Path(folder)/'report.json'
            with patch.object(lane,'phase',return_value=(124,None)) as child:
                self.assertEqual(lane.run(Path(folder),CONFIG,report),1)
            self.assertEqual(child.call_count,1)
            value=json.loads(report.read_text())
            self.assertEqual(value['status'],'failed');self.assertTrue(value['resourcesRetained'])
            self.assertEqual(value['phases'][0]['reason'],'phase_failed')

    def test_readback_mismatch_or_missing_tests_cannot_reach_cleanup(self):
        for bad in ('test','readback','digest'):
            with self.subTest(bad=bad),tempfile.TemporaryDirectory() as folder:
                report=Path(folder)/'report.json';seen=[]
                def child(argv,cwd,env,timeout,test=False):
                    name=lane.phase_name(argv);seen.append(name)
                    if name==bad:return 1,None
                    if name=='readback' and bad=='digest':return 0,{'phase':name,'passed':True,'digest':'a'*64}
                    return 0,{'phase':name,'passed':True,'digest':'f'*64}
                with patch.object(lane,'phase',side_effect=child):
                    self.assertEqual(lane.run(Path(folder),CONFIG,report),1)
                self.assertNotIn('cleanup',seen)
                self.assertTrue(json.loads(report.read_text())['resourcesRetained'])

    def test_interruption_is_failed_and_retained_not_an_implicit_cleanup(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(lane.subprocess,'run',side_effect=KeyboardInterrupt):
                self.assertEqual(lane.phase([sys.executable,'-c','pass'],Path(folder),{},1),(1,None))

    def test_success_requires_every_phase_and_cleanup(self):
        with tempfile.TemporaryDirectory() as folder:
            report=Path(folder)/'report.json';seen=[]
            def child(argv,cwd,env,timeout,test=False):
                name=lane.phase_name(argv);seen.append(name)
                return 0,{'phase':name,'passed':True,'digest':'f'*64}
            with patch.object(lane,'phase',side_effect=child):
                self.assertEqual(lane.run(Path(folder),CONFIG,report),0)
            self.assertEqual(seen,['bootstrap','migrate','grants','baseline','test','readback','cleanup'])
            value=json.loads(report.read_text());self.assertEqual(value['status'],'passed')
            self.assertFalse(value['resourcesRetained']);self.assertFalse(value['cacheTested'])

    def test_owned_identity_is_persisted_before_the_first_effect_without_credentials(self):
        with tempfile.TemporaryDirectory() as folder:
            report=Path(folder)/'report.json'
            config=lane.configuration('postgres://postgres@127.0.0.1:60442/postgres',NONCE)
            def child(*args,**kwargs):
                before=json.loads(report.read_text())
                self.assertEqual(before['namespace'],{'nonce':NONCE,'database':'memlia_p06_budget_test',
                                                     'roles':['pgwin_m_'+NONCE,'pgwin_w_'+NONCE]})
                self.assertEqual(before['status'],'failed');self.assertTrue(before['resourcesRetained'])
                return 124,None
            with patch.object(lane,'phase',side_effect=child):
                self.assertEqual(lane.run(Path(folder),config,report),1)
            value=report.read_text()
            for key in ('MEMLIA_PG_ADMIN_URL','MEMLIA_PG_MIGRATE_URL','MEMLIA_PG_WEB_URL'):
                self.assertNotIn(config[key],value)

    def test_no_schema_mock_and_existing_budget_assertions_are_selected(self):
        argv,cwd=lane.command(Path('/repo'),'test')
        self.assertEqual(cwd,Path('/repo/apps/sim'))
        self.assertEqual(argv,['bun','--no-env-file','test','--timeout','10000',
                              './lib/memlia/ai/chat-budget-window.integration.test.ts'])
        self.assertEqual(lane.test_summary(b'9 pass\n0 fail\n9 tests'),True)
        for raw in (b'0 pass\n0 fail\n0 tests',b'9 pass\n0 fail\n1 skip',b'8 pass\n1 fail',b''):
            self.assertFalse(lane.test_summary(raw))


if __name__=='__main__':unittest.main()
