# Copyright (c) 2026 Memlia. All rights reserved.
"""Portable recipe tests: Docker is doubled; real isolation belongs to Linux CI."""
import importlib.util
import json
from pathlib import Path
import sys
import unittest
from unittest import mock
from test_supervisor import Engine, IMAGE, CID

spec = importlib.util.spec_from_file_location('qualification', Path(__file__).with_name('qualification.py'))
q = importlib.util.module_from_spec(spec)
spec.loader.exec_module(q)

# These are checkout-source unit tests; installed-wheel tests run separately.
# Resolve both packages before any test, without relying on fixture execution order
# or an editable Memlia installation in the interpreter's environment.
for source in (q.ROOT / 'packages/memlia-contracts/python', q.ROOT / 'runtimes/excel/src'):
    sys.path.insert(0, str(source))


class RecipeTests(unittest.TestCase):
    def test_omitted_optional_host_mounts_keeps_native_start_and_exact_cleanup(self):
        engine = Engine()
        engine.before_inspect = lambda row, count: row['HostConfig'].pop('Mounts', None)
        adapter = q.RecipeDocker(engine, IMAGE)
        try:
            result = q.s._run_owned(adapter, IMAGE, b'fixture')
        except q.s.IsolationError:
            self.fail('valid omitted request Mounts refused before exact owned cleanup')
        self.assertEqual(result, engine.result)
        self.assertEqual(adapter.missing_fields, [])
        self.assertEqual(engine.actions(), ['create', 'inspect', 'start', 'inspect', 'inspect', 'rm', 'ls'])
        self.assertIsNone(engine.row)

    def test_effective_mounts_must_be_present_and_a_list(self):
        for change in (lambda row: row.pop('Mounts', None),
                       *(lambda row, value=value: row.update(Mounts=value)
                         for value in ({}, '', None, False))):
            engine = Engine()
            engine.before_inspect = lambda row, count: change(row)
            with self.subTest(change=change), self.assertRaises(q.s.IsolationError):
                q.s._run_owned(engine, IMAGE, b'fixture')
            self.assertNotIn('start', engine.actions())
            self.assertNotIn('stop', engine.actions())
            self.assertNotIn('rm', engine.actions())

    def test_optional_request_mounts_reject_malformed_empty_values(self):
        for value in ({}, '', False, 0, True):
            engine = Engine()
            engine.before_inspect = lambda row, count: row['HostConfig'].update(Mounts=value)
            with self.subTest(value=value), self.assertRaises(q.s.IsolationError):
                q.s._run_owned(engine, IMAGE, b'fixture')
            self.assertNotIn('start', engine.actions())
            self.assertNotIn('stop', engine.actions())
            self.assertNotIn('rm', engine.actions())

    def test_optional_request_mount_omission_never_permits_foreign_mounts_or_missing_limits(self):
        changes = [
            lambda row: row['HostConfig'].update(Mounts=[{'Type': 'bind', 'Source': '/foreign'}]),
            lambda row: row['HostConfig'].update(Mounts={'Type': 'volume'}),
            lambda row: row.update(Mounts=[{'Type': 'bind', 'Destination': '/tmp', 'Source': '/foreign'}]),
            lambda row: row.update(Mounts=[{'Type': 'volume', 'Destination': '/tmp', 'Source': 'foreign'}]),
            lambda row: row.update(Mounts=[{'Type': 'tmpfs', 'Destination': '/foreign'}]),
            lambda row: row.update(Mounts=[{'Type': 'tmpfs', 'Destination': '/tmp', 'Source': '/foreign'}]),
            lambda row: row['HostConfig'].pop('Memory', None),
            lambda row: row['HostConfig'].pop('Tmpfs', None),
            lambda row: row['HostConfig'].update(Tmpfs={'/tmp': 'rw'}),
            lambda row: row['Config']['Labels'].clear(),
        ]
        for index, change in enumerate(changes):
            engine = Engine()
            def malformed(row, count):
                row['HostConfig'].pop('Mounts', None)
                change(row)
            engine.before_inspect = malformed
            with self.subTest(change=index), self.assertRaises(q.s.IsolationError):
                q.s._run_owned(engine, IMAGE, b'fixture')
            self.assertNotIn('start', engine.actions())
            self.assertNotIn('stop', engine.actions())
            self.assertNotIn('rm', engine.actions())

    def test_recipe_refuses_non_linux_without_a_docker_call(self):
        with mock.patch.object(q.platform, 'system', return_value='Darwin'):
            with self.assertRaisesRegex(ValueError, '^linux_recipe_unavailable$'):
                q.require_linux()

    def test_fixture_reuses_canonical_constructor_and_real_xlsx(self):
        wire = q.fixture_wire()
        body = json.loads(wire)
        self.assertEqual(body['schemaVersion'], 'memlia.excel-process/v1')
        self.assertEqual(body['requestId'], 'linux-image-recipe')
        self.assertEqual(body['procedure']['operations'][0]['op'], 'select')
        import base64
        self.assertTrue(base64.b64decode(body['sources']['source']['contentBase64']).startswith(b'PK'))

    def test_missing_metadata_report_is_closed_and_never_relaxes_inspection(self):
        engine = Engine()
        def remove(row, count):
            row['HostConfig'].pop('Memory', None)
            row['HostConfig']['FOREIGN_CANARY'] = 'private'
        engine.before_inspect = remove
        adapter = q.RecipeDocker(engine, IMAGE)
        with self.assertRaises(q.s.IsolationError):
            q.s._run_owned(adapter, IMAGE, b'{}')
        self.assertEqual(adapter.missing_fields, ['HostConfig.Memory'])
        self.assertNotIn('start', engine.actions())
        self.assertNotIn('rm', engine.actions())

    def test_normal_recipe_keeps_the_exact_production_start(self):
        engine = Engine()
        adapter = q.RecipeDocker(engine, IMAGE)
        result = q.s._run_owned(adapter, IMAGE, b'fixture')
        self.assertEqual(result, engine.result)
        self.assertIn(['container','start','--attach','--interactive',CID], [a for a, _ in engine.calls])
        self.assertIsNone(engine.row)

    def test_unknown_probe_cannot_select_a_command(self):
        with self.assertRaisesRegex(ValueError, '^recipe_probe_refused$'):
            q.RecipeDocker(Engine(), IMAGE, probe='arbitrary-canary')

    def test_probe_output_closed_against_extra_false_and_wrong_types(self):
        expected = {'nonRoot': True, 'rootReadOnly': True, 'tmpWritable': True,
                    'networkDenied': True, 'noNewPrivileges': True}
        self.assertEqual(q.probe_result('boundary', json.dumps(expected).encode()), expected)
        for change in ({'extra': 'canary'}, {'nonRoot': False}, {'nonRoot': 1}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                q.probe_result('boundary', json.dumps(expected | change).encode())

    def test_timeout_refusal_requires_acknowledged_owned_cleanup(self):
        for receipt in ({}, {'createAcknowledged':True,'cleanupComplete':False},
                        {'createAcknowledged':False,'cleanupComplete':True}):
            with self.subTest(receipt=receipt), self.assertRaises(ValueError):
                q.refusal_receipt(receipt)
        q.refusal_receipt({'createAcknowledged':True,'cleanupComplete':True})

    def test_recipe_never_admits_image_or_uses_a_mutable_base(self):
        self.assertEqual(q.s.QUALIFIED_IMAGES, frozenset())
        self.assertEqual(q.PYTHON_BASE, 'python@sha256:2ed6491b93cd49272ee6de2b5a38440c3448360322c089fc23e370722d74179d')


class ProbeEngine(Engine):
    def __call__(self, args, payload=b'', **kwargs):
        if args[:2] == ['container', 'start'] and '--attach' not in args:
            self.calls.append((args, payload))
            self.row['State'].update(Status='running', Running=True)
            return (CID+'\n').encode()
        if args[:2] == ['container','exec']:
            self.calls.append((args,payload))
            return json.dumps({k:True for k in q.PROBES['boundary']}).encode()
        if args[:2] == ['container','attach']:
            self.calls.append((args,payload))
            self.row['State'].update(Status='exited',Running=False)
            return self.result
        return super().__call__(args,payload,**kwargs)


class ProbeAdapterTests(unittest.TestCase):
    def test_real_native_xlsx_answer_after_fixed_probe_and_owned_cleanup(self):
        from memlia_excel.process import prepare
        wire = q.fixture_wire()
        engine = ProbeEngine()
        engine.result = json.dumps(prepare(json.loads(wire))).encode()
        cases = {}
        import threading
        q.run_case(engine,IMAGE,wire,'boundary',threading.Event(),cases)
        self.assertTrue(cases['boundary']['passed'])
        self.assertTrue(cases['boundary']['cleanupComplete'])
        self.assertIsNone(engine.row)
        execution = next(args for args,_ in engine.calls if args[:2] == ['container','exec'])
        self.assertEqual(execution[:5], ['container','exec','--user','65532:65532',CID])
        self.assertEqual(execution[-1], 'boundary')
        self.assertNotIn(wire.decode(), ' '.join(execution))
        actions = engine.actions()
        self.assertEqual(actions[actions.index('exec')-1], 'inspect')
        self.assertEqual(actions[actions.index('exec')+1], 'inspect')

    def test_identity_change_before_exec_never_executes_or_removes_foreign(self):
        engine = ProbeEngine()
        engine.before_inspect = lambda row,count: row.update(Id='c'*64) if count >= 3 else None
        with self.assertRaises(q.s.IsolationError):
            q.s._run_owned(q.RecipeDocker(engine,IMAGE,'boundary'),IMAGE,b'{}')
        self.assertNotIn('exec',engine.actions())
        self.assertNotIn('rm',engine.actions())

    def test_partial_answer_never_passes_even_with_clean_removal(self):
        import threading
        engine=Engine();engine.result=b'{"status":"prepared_in_memory"}'
        cases={}
        with self.assertRaises(ValueError):
            q.run_case(engine,IMAGE,b'{}',None,threading.Event(),cases)
        self.assertFalse(cases['worker']['passed'])
        self.assertTrue(cases['worker']['cleanupComplete'])

    def test_real_child_timeout_and_cancellation_retain_native_cleanup(self):
        import sys,threading,tempfile
        class Waiting(ProbeEngine):
            def __call__(self,args,payload=b'',**kwargs):
                if args[:2] == ['container','exec']:
                    with tempfile.TemporaryDirectory() as temporary:
                        return q.s._command([sys.executable,'-I','-B','-c','import time; time.sleep(10)'],
                            b'',kwargs['deadline'],kwargs.get('cancel'),Path(temporary),1024)
                return super().__call__(args,payload,**kwargs)
        for probe in ('timeout','cancel'):
            engine=Waiting();cases={}
            q.run_case(engine,IMAGE,b'{}',probe,threading.Event(),cases)
            self.assertTrue(cases[probe]['passed'])
            self.assertTrue(cases[probe]['cleanupComplete'])
            self.assertIn('stop',engine.actions())
            self.assertIsNone(engine.row)


class ReceiptAndImageTests(unittest.TestCase):
    def test_memory_probe_is_an_explicit_refusal_with_measured_oom_and_cleanup(self):
        import threading
        class Memory(ProbeEngine):
            def __call__(self,args,payload=b'',**kwargs):
                if args[:2] == ['container','exec']:
                    self.calls.append((args,payload))
                    return b'{"memoryOomEnforced":true}'
                return super().__call__(args,payload,**kwargs)
        engine=Memory();cases={}
        q.run_case(engine,IMAGE,b'{}','memory',threading.Event(),cases)
        self.assertTrue(cases['memory']['passed'])
        self.assertTrue(cases['memory']['cleanupComplete'])
        self.assertFalse(cases['memory']['workerCompletionAfterOomQualified'])
        self.assertNotIn('attach',engine.actions())
        self.assertIn('stop',engine.actions())
        self.assertIsNone(engine.row)

    def test_failed_removal_cannot_be_a_passed_case(self):
        import threading
        engine=Engine();engine.remove_error=True;cases={}
        with self.assertRaises(ValueError):
            q.run_case(engine,IMAGE,b'{}',None,threading.Event(),cases)
        self.assertFalse(cases['worker']['passed'])
        self.assertFalse(cases['worker']['cleanupComplete'])

    def test_real_xlsx_readback_rejects_changed_digest_and_extra_data(self):
        wire=q.fixture_wire()
        from memlia_excel.process import prepare
        answer=prepare(json.loads(wire))
        q.verify_answer(json.dumps(answer).encode())
        changed=json.loads(json.dumps(answer));changed['outputs'][0]['sha256']='sha256:'+'0'*64
        with self.assertRaises(ValueError): q.verify_answer(json.dumps(changed).encode())
        with self.assertRaises(ValueError): q.verify_answer(json.dumps(answer | {'foreign':True}).encode())
        with self.assertRaises(ValueError): q.verify_answer(json.dumps(answer).encode()+b' {}')
        duplicate=json.dumps(answer).replace('"published": false','"published": true,"published": false')
        with self.assertRaises(ValueError): q.verify_answer(duplicate.encode())

    def test_recipe_probe_source_is_fixed_not_an_envelope_field(self):
        import ast
        source=Path(q.__file__).with_name('qualification_probe.py').read_text()
        ast.parse(source)
        self.assertNotIn('eval(',source)
        self.assertNotIn('shell=True',source)
        self.assertIn("(CG/'memory.max').read_text().strip() == '536870912'",source)
        self.assertIn("(CG/'memory.swap.max').read_text().strip() == '0'",source)
        self.assertIn("(CG/'pids.max').read_text().strip() == '32'",source)
        self.assertIn('range(130)',source)
        self.assertIn('range(40)',source)


class BuildPipeTests(unittest.TestCase):
    def test_real_build_child_has_closed_env_and_private_bounded_output(self):
        import tempfile,threading,time,sys,os
        code="import os,sys; assert 'MEMLIA_RECIPE_CANARY' not in os.environ; print('fixed-progress', file=sys.stderr)"
        with tempfile.TemporaryDirectory() as temporary, mock.patch.dict(os.environ,{'MEMLIA_RECIPE_CANARY':'fixture'}), mock.patch.object(q,'DOCKER',[sys.executable,'-I','-B','-c',code]):
            q.build_command([],Path(temporary),time.monotonic()+2,threading.Event())
            self.assertEqual((Path(temporary)/'build.private.log').read_text(),'fixed-progress\n')

    def test_combined_pull_build_log_cap_is_not_reset_between_commands(self):
        import tempfile,threading,time,sys
        with tempfile.TemporaryDirectory() as temporary:
            work=Path(temporary)
            (work/'build.private.log').write_bytes(b'1234567')
            with mock.patch.object(q,'MAX_BUILD_LOG',8,create=True), mock.patch.object(q,'DOCKER',[sys.executable,'-I','-B','-c',"print('ab')"]), self.assertRaises(ValueError):
                q.build_command([],work,time.monotonic()+2,threading.Event())
            self.assertEqual((work/'build.private.log').read_bytes(),b'1234567')

    def test_real_build_timeout_waits_exact_owned_child(self):
        import tempfile,threading,time,sys,os
        with tempfile.TemporaryDirectory() as temporary:
            path=Path(temporary)/'child.pid'
            code='import os,time; open("child.pid","w").write(str(os.getpid())); time.sleep(10)'
            with mock.patch.object(q,'DOCKER',[sys.executable,'-I','-B','-c',code]), self.assertRaises(ValueError):
                q.build_command([],Path(temporary),time.monotonic()+.2,threading.Event())
            pid=int(path.read_text())
            with self.assertRaises(ProcessLookupError): os.kill(pid,0)


class DiskBudgetTests(unittest.TestCase):
    def test_six_gib_reaches_context_and_records_cleanup_after_context_refusal(self):
        import tempfile
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as temporary:
            output=Path(temporary)/'owned'
            with mock.patch.object(q,'require_linux'), mock.patch.object(q.shutil,'disk_usage',return_value=SimpleNamespace(free=6*1024**3)), mock.patch.object(q.subprocess,'check_output',return_value=b''), mock.patch.object(q.prepare_context,'prepare',side_effect=ValueError('fixed-context-refusal')) as prepare, mock.patch('builtins.print'):
                self.assertEqual(q.run(Path(temporary)/'wheels',output),1)
            prepare.assert_called_once()
            receipt=json.loads((output/'receipt.json').read_text())
            self.assertEqual(receipt['status'],'failed')
            self.assertTrue(receipt['cleanupComplete'])
            self.assertEqual([r['phase'] for r in receipt['diskObservations']],
                             ['context','cleanup_before','cleanup_after'])

    def test_recipe_disk_budget_boundary_and_unknown_are_closed(self):
        from types import SimpleNamespace
        minimum = 6*1024**3
        for free in (minimum-1, minimum, minimum+1):
            receipt = {'diskObservations': []}
            with mock.patch.object(q.shutil, 'disk_usage', return_value=SimpleNamespace(free=free)):
                if free < minimum:
                    with self.assertRaisesRegex(ValueError, '^recipe_disk_refused$'):
                        q.check_disk(Path('.'), receipt, 'context')
                else:
                    q.check_disk(Path('.'), receipt, 'context')
            self.assertEqual(receipt['diskObservations'], [dict(phase='context', freeBytes=free,
                requiredFreeBytes=minimum, sufficient=free >= minimum)])
        for bad in (None, True, -1, 'unknown'):
            receipt = {'diskObservations': []}
            with mock.patch.object(q.shutil, 'disk_usage', return_value=SimpleNamespace(free=bad)):
                with self.assertRaisesRegex(ValueError, '^recipe_disk_refused$'):
                    q.check_disk(Path('.'), receipt, 'context')
            self.assertEqual(receipt['diskObservations'][0]['freeBytes'], None)
        receipt = {'diskObservations': []}
        with mock.patch.object(q.shutil, 'disk_usage', side_effect=OSError('PRIVATE_CANARY')):
            with self.assertRaisesRegex(ValueError, '^recipe_disk_refused$'):
                q.check_disk(Path('.'), receipt, 'cleanup_before')
        self.assertNotIn('PRIVATE_CANARY', json.dumps(receipt))

    def test_disk_measurement_during_cleanup_can_record_without_preventing_cleanup(self):
        receipt = {'diskObservations': []}
        with mock.patch.object(q.shutil, 'disk_usage', side_effect=OSError('PRIVATE_CANARY')):
            q.check_disk(Path('.'), receipt, 'cleanup_before', enforce=False)
        self.assertEqual(receipt['diskObservations'], [dict(phase='cleanup_before', freeBytes=None,
            requiredFreeBytes=6*1024**3, sufficient=False)])


class OperatorConsumptionTests(unittest.TestCase):
    def test_application_mode_never_creates_resources_without_explicit_host(self):
        import tempfile
        with tempfile.TemporaryDirectory() as folder, mock.patch.object(q,'require_linux'):
            output=Path(folder)/'absent'
            with self.assertRaisesRegex(ValueError,'^application_host_required$'):
                q.run(Path(folder),output,exercise_application=True)
            self.assertFalse(output.exists())
    def receipt(self):
        return {'imageId':IMAGE,'sourceCommit':'c'*40,'lockSha256':'d'*64,'contextSha256':'e'*64,
                'cases':{name:{'passed':True,'cleanupComplete':True} for name in q.s.admission.CASES}}

    def test_proof_requires_all_eight_cases_and_each_owned_cleanup(self):
        import copy
        original=self.receipt()
        value=q.qualification_proof(original)
        self.assertEqual(value['supervisorSha256'],q.s.SOURCE_SHA256)
        self.assertTrue(value['imageHeld'])
        for case in original['cases']:
            for key in ('passed','cleanupComplete'):
                changed=copy.deepcopy(original);changed['cases'][case][key]=False
                with self.subTest(case=case,key=key),self.assertRaises(ValueError):q.qualification_proof(changed)
        changed=copy.deepcopy(original);del changed['cases']['worker']
        with self.assertRaises(ValueError):q.qualification_proof(changed)

    def test_explicit_host_mode_requires_root_before_creating_output(self):
        import tempfile
        with tempfile.TemporaryDirectory() as folder, mock.patch.object(q,'require_linux'), mock.patch.object(q.os,'getuid',return_value=1001):
            output=Path(folder)/'absent'
            with self.assertRaises(ValueError):q.run(Path(folder),output,exercise_host=True)
            self.assertFalse(output.exists())

    def lifecycle(self, exercise, fail=False, application=False, application_clean=True):
        import tempfile,hashlib
        from types import SimpleNamespace
        observed=[];label=None
        def context(source,wheels,output,base):
            output.mkdir();(output/'context.json').write_bytes(b'{}')
            return {'lockSha256':hashlib.sha256((q.ROOT/'runtimes/excel/requirements.lock').read_bytes()).hexdigest()}
        def build(args,work,deadline,cancel):
            nonlocal label
            if args[0]=='build':
                label=args[args.index('--label')+1].split('=',1)[1]
                (work/'image.id').write_text(IMAGE)
        def docker(argv,payload,deadline,cancel,cwd,limit):
            args=argv[len(q.DOCKER):]
            if args[:2]==['image','inspect']:
                return json.dumps([{'Id':q.PYTHON_CONFIG if args[2]==q.PYTHON_BASE else IMAGE,
                   'Os':'linux','Architecture':'amd64','Config':{'Labels':{'org.memlia.excel.recipe':label}}}]).encode()
            if args[:2]==['image','rm']:observed.append('image_removed');return b''
            if args[:2]==['image','ls']:return b''
            raise AssertionError('unexpected fixture transport')
        def run_case(docker,image,wire,probe,cancel,cases):
            cases[probe or 'worker']={'passed':True,'cleanupComplete':True}
        def consume(proof,wire,deadline,cancel,record,**options):
            self.assertNotIn('image_removed',observed)
            self.assertEqual(set(proof['cases']),set(q.s.admission.CASES))
            self.assertEqual(proof['imageId'],IMAGE);observed.append('host_consumed')
            if application:
                self.assertEqual(options,{'application_work':output/'application'})
                record['application']={'passed':True,'cleanupComplete':application_clean}
                observed.append('application_consumed')
            else:self.assertEqual(options,{})
            if fail:
                record.update(cleanupComplete=fail!='unknown',resourcesRetained=fail=='unknown')
                raise ValueError('fixture_consumer_refused')
            record.update(passed=True,cleanupComplete=True)
        with tempfile.TemporaryDirectory() as folder:
            output=Path(folder)/'owned'
            with mock.patch.object(q,'require_linux'), mock.patch.object(q.os,'getuid',return_value=0), mock.patch.object(q.shutil,'disk_usage',return_value=SimpleNamespace(free=10*1024**3)), mock.patch.object(q.subprocess,'check_output',side_effect=lambda argv,**kw: b'c'*40 if argv[-2:]==['rev-parse','HEAD'] else b''), mock.patch.object(q.prepare_context,'prepare',side_effect=context), mock.patch.object(q,'build_command',side_effect=build), mock.patch.object(q.s,'_command',side_effect=docker), mock.patch.object(q,'fixture_wire',return_value=b'fixture'), mock.patch.object(q,'run_case',side_effect=run_case), mock.patch.object(q,'consume_through_host',side_effect=consume), mock.patch('builtins.print'):
                result=q.run(Path(folder)/'wheels',output,exercise_host=exercise,
                             exercise_application=application)
            receipt=json.loads((output/'receipt.json').read_bytes())
        return result,receipt,observed

    def test_default_does_not_admit_or_consume_an_image(self):
        result,receipt,observed=self.lifecycle(False)
        self.assertEqual(result,0);self.assertNotIn('hostConsumer',receipt)
        self.assertEqual(observed,['image_removed']);self.assertFalse(receipt['runtimeActivated'])

    def test_consumer_uses_same_image_after_eight_cases_before_exact_removal(self):
        result,receipt,observed=self.lifecycle(True)
        self.assertEqual(result,0);self.assertTrue(receipt['hostConsumer']['passed'])
        self.assertEqual(observed,['host_consumed','image_removed']);self.assertTrue(receipt['cleanupComplete'])
        self.assertFalse(receipt['runtimeActivated'])

    def test_manual_application_is_composed_before_same_image_cleanup(self):
        result,receipt,observed=self.lifecycle(True,application=True)
        self.assertEqual(result,0)
        self.assertEqual(observed,['host_consumed','application_consumed','image_removed'])
        self.assertTrue(receipt['hostConsumer']['application']['passed'])
        self.assertTrue(receipt['cleanupComplete'])

    def test_unknown_application_cleanup_never_qualifies_the_recipe(self):
        result,receipt,_=self.lifecycle(True,application=True,application_clean=False)
        self.assertEqual(result,1)
        self.assertFalse(receipt['cleanupComplete'])
        self.assertEqual(receipt['code'],'recipe_cleanup_refused')

    def test_consumer_refusal_remains_failed_and_keeps_original_image_cleanup(self):
        result,receipt,observed=self.lifecycle(True,fail=True)
        self.assertEqual(result,1);self.assertEqual(receipt['status'],'failed')
        self.assertEqual(observed,['host_consumed','image_removed']);self.assertTrue(receipt['cleanupComplete'])

    def test_unknown_host_cleanup_cannot_claim_global_cleanup_complete(self):
        result,receipt,observed=self.lifecycle(True,fail='unknown')
        self.assertEqual(result,1);self.assertFalse(receipt['cleanupComplete'])
        self.assertTrue(receipt['hostConsumer']['resourcesRetained'])
        self.assertEqual(receipt['code'],'recipe_cleanup_refused')


if __name__ == '__main__':
    unittest.main()
