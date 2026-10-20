#!/usr/bin/env python3
# Copyright 2026 Memlia. All rights reserved.
"""Real subprocess tests for the fast-test runner, without installing dependencies."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import subprocess
import tempfile
import textwrap
import unittest
from unittest.mock import patch

source=Path(__file__).with_name('fast-tests.py')
spec=importlib.util.spec_from_file_location('fast_tests',source)
fast=importlib.util.module_from_spec(spec);spec.loader.exec_module(fast)


class WorkflowProjectionTests(unittest.TestCase):
    def project(self,groups):
        workflow=source.resolve().parents[2]/'.github/workflows/memlia-fast-tests.yml'
        script=workflow.read_text().split("          python3 - <<'PY'\n")
        self.assertEqual(len(script),2)
        body=script[1].split('\n          PY\n')
        self.assertEqual(len(body),2)
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)/'memlia-fast-tests/scratch'
            root.mkdir(parents=True)
            receipt={'status':'passed','groups':groups,'nextBuildExecuted':False,
                     'liveProviderQualified':False,'databaseQualified':False,'cacheQualified':False}
            (root/'groups.json').write_text(json.dumps(receipt))
            return subprocess.run([sys.executable,'-B','-c',textwrap.dedent(body[0])],
                                  env={'RUNNER_TEMP':folder},capture_output=True,text=True,timeout=5)

    def groups(self):
        return [{'group':name,'files':len(config[2]),'status':'passed',
                 'exitCode':0,'reason':None,'seconds':.01} for name,config in fast.GROUPS.items()]

    def test_workflow_projects_all_six_current_groups(self):
        groups=self.groups()
        self.assertEqual(len(groups),6)
        result=self.project(groups)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual([json.loads(line) for line in result.stdout.splitlines()],groups)

    def test_workflow_refuses_historical_five_group_receipt(self):
        result=self.project([group for group in self.groups() if group['group']!='chat_ui'])
        self.assertNotEqual(result.returncode,0)
        self.assertEqual(result.stderr.strip(),'Invalid groups')

    def test_workflow_refuses_wrong_group_order(self):
        groups=self.groups()
        groups[0],groups[1]=groups[1],groups[0]
        result=self.project(groups)
        self.assertNotEqual(result.returncode,0)
        self.assertEqual(result.stderr.strip(),'Invalid group')


class RunnerTests(unittest.TestCase):
    def test_failure_is_not_success_and_later_groups_never_execute(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);report=root/'report.json';effect=root/'unwanted'
            commands=[
                {'group':'contracts','files':1,'cwd':root,'argv':[sys.executable,'-c','pass']},
                {'group':'limiter','files':1,'cwd':root,'argv':[sys.executable,'-c','raise SystemExit(3)']},
                {'group':'chat','files':1,'cwd':root,'argv':[sys.executable,'-c',f'open({str(effect)!r},"w").close()']},
            ]
            self.assertEqual(fast.run_plan(commands,dict(os.environ),report),1)
            receipt=json.loads(report.read_bytes())
            self.assertEqual(receipt['status'],'failed')
            self.assertEqual([r['status'] for r in receipt['groups']],['passed','failed','not_run'])
            self.assertEqual(receipt['groups'][1]['exitCode'],3)
            self.assertFalse(effect.exists())

    def test_interrupt_during_a_group_cannot_leave_a_passed_receipt(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);report=root/'report.json'
            commands=[{'group':'chat','files':1,'cwd':root,'argv':[sys.executable,'-c','pass']}]
            with patch.object(fast.subprocess,'run',side_effect=KeyboardInterrupt):
                self.assertEqual(fast.run_plan(commands,dict(os.environ),report),1)
            self.assertEqual(json.loads(report.read_bytes())['status'],'failed')

    def test_real_timeout_is_failure_and_stops_the_next_group(self):
        native=fast.subprocess.run
        def short(*args,**kwargs):
            kwargs['timeout']=.05
            return native(*args,**kwargs)
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);report=root/'report.json'
            commands=[{'group':'chat','files':1,'cwd':root,
                       'argv':[sys.executable,'-c','import time;time.sleep(2)']}]
            with patch.object(fast.subprocess,'run',short):
                self.assertEqual(fast.run_plan(commands,dict(os.environ),report),1)
            self.assertEqual(json.loads(report.read_bytes())['groups'][0]['reason'],'timeout')

    def test_existing_report_refuses_before_any_child_effect(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);report=root/'report.json';report.write_bytes(b'existing')
            command={'group':'chat','files':1,'cwd':root,
                     'argv':[sys.executable,'-c',f'open({str(root/"effect")!r},"w").close()']}
            with self.assertRaises(FileExistsError):fast.run_plan([command],dict(os.environ),report)
            self.assertEqual(report.read_bytes(),b'existing');self.assertFalse((root/'effect').exists())

    def test_real_child_has_no_ambient_provider_or_database_secret(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);effect=root/'effect'
            environment=fast.test_environment({**os.environ,'OPENAI_API_KEY':'test-only',
                                               'TEST_DATABASE_URL':'test-only','GITHUB_TOKEN':'test-only'})
            code='import os;assert not ({"OPENAI_API_KEY","TEST_DATABASE_URL","GITHUB_TOKEN"}&set(os.environ));open('+repr(str(effect))+',"w").write("clean")'
            command={'group':'chat','files':1,'cwd':root,'argv':[sys.executable,'-c',code]}
            self.assertEqual(fast.run_plan([command],environment,root/'report.json'),0)
            self.assertEqual(effect.read_text(),'clean')

    def test_missing_or_symlink_selected_test_cannot_start_any_runner(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);path=root/'packages/memlia-contracts/tests/contracts.test.ts'
            with self.assertRaises(ValueError):fast.commands(root,['contracts'])
            path.parent.mkdir(parents=True);target=root/'target';target.write_text('fixture')
            path.symlink_to(target)
            with self.assertRaises(ValueError):fast.commands(root,['contracts'])

    def test_pricing_and_limiter_use_the_bun_engine_not_vitest(self):
        root=source.resolve().parents[2]
        selected=fast.commands(root,['limiter'],vitest=Path('/not-used'))
        self.assertEqual(selected[0]['argv'][:5],['bun','--no-env-file','test','--timeout','10000'])
        self.assertIn('lib/memlia/ai/chat-pricing-profile.test.ts',selected[0]['argv'])
        for command in fast.commands(root,['chat'],vitest=Path('/vitest')):
            self.assertNotIn('lib/memlia/ai/chat-pricing-profile.test.ts',command['argv'])


if __name__=='__main__':unittest.main()
