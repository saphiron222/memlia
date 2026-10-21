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
    def test_export_keeps_bounded_binary_out_of_logs_in_new_readonly_file(self):
        import hashlib,tempfile,threading,time,sys,stat
        value=b'\x00owned-image-fixture\xff'
        source="import os; assert 'MEMLIA_RECIPE_CANARY' not in os.environ; os.write(1,"+repr(value)+")"
        with tempfile.TemporaryDirectory() as temporary, mock.patch.dict(q.os.environ,{'MEMLIA_RECIPE_CANARY':'fixture'}), mock.patch.object(q,'DOCKER',[sys.executable,'-I','-B','-c',source]):
            work=Path(temporary);target=work/'image.tar'
            try:
                exported=q.build_command(['image','save',IMAGE],work,time.monotonic()+2,threading.Event(),
                                         artifact=target,receipt={'diskObservations':[]})
            except TypeError as error:
                self.fail('bounded native export unavailable: '+str(error))
            self.assertEqual(target.read_bytes(),value)
            self.assertEqual(exported,{'sha256':hashlib.sha256(value).hexdigest(),'size':len(value)})
            self.assertEqual(stat.S_IMODE(target.stat().st_mode),0o400)
            self.assertEqual((work/'build.private.log').read_bytes(),b'')

    def test_export_refuses_overflow_stderr_nonzero_and_empty_output(self):
        import tempfile,threading,time,sys
        cases=[("import os; os.write(1,b'12345')",4,'recipe_export_limit'),
               ("import os; os.write(2,b'PRIVATE_CANARY')",32,'recipe_export_stderr'),
               ('raise SystemExit(3)',32,'recipe_build_failed'),
               ('pass',32,'recipe_export_refused')]
        for source,limit,code in cases:
            with self.subTest(code=code), tempfile.TemporaryDirectory() as temporary, mock.patch.object(q,'MAX_EXPORT_BYTES',limit), mock.patch.object(q,'DOCKER',[sys.executable,'-I','-B','-c',source]):
                work=Path(temporary)
                with self.assertRaisesRegex(ValueError,'^'+code+'$'):
                    q.build_command(['image','save',IMAGE],work,time.monotonic()+2,threading.Event(),
                                    artifact=work/'image.tar',receipt={'diskObservations':[]})
                self.assertLessEqual((work/'image.tar').stat().st_size,limit)
                if code=='recipe_export_stderr':
                    self.assertEqual((work/'build.private.log').read_bytes(),b'PRIVATE_CANARY')

    def test_export_never_replaces_existing_or_symlink_file(self):
        import tempfile,threading,time
        for symlink in (False,True):
            with self.subTest(symlink=symlink), tempfile.TemporaryDirectory() as temporary, mock.patch.object(q.subprocess,'Popen') as process:
                work=Path(temporary);foreign=work/'foreign';foreign.write_bytes(b'foreign')
                target=work/'image.tar'
                if symlink: target.symlink_to(foreign)
                else: target.write_bytes(b'prior')
                with self.assertRaises(OSError):
                    q.build_command(['image','save',IMAGE],work,time.monotonic()+2,threading.Event(),
                                    artifact=target,receipt={'diskObservations':[]})
                process.assert_not_called()
                self.assertEqual(foreign.read_bytes(),b'foreign')
                self.assertEqual(target.read_bytes(),b'foreign' if symlink else b'prior')

    def test_export_timeout_and_cancel_wait_for_exact_owned_child(self):
        import tempfile,threading,time,sys,os
        for cancellation in (False,True):
            with self.subTest(cancel=cancellation), tempfile.TemporaryDirectory() as temporary:
                work=Path(temporary);cancel=threading.Event()
                source="import os,time;open('child.pid','w').write(str(os.getpid()));time.sleep(10)"
                timer=threading.Timer(.2,cancel.set) if cancellation else None
                if timer: timer.start()
                try:
                    with mock.patch.object(q,'DOCKER',[sys.executable,'-I','-B','-c',source]), self.assertRaises(ValueError):
                        q.build_command(['image','save',IMAGE],work,time.monotonic()+(2 if cancellation else .2),cancel,
                                        artifact=work/'image.tar',receipt={'diskObservations':[]})
                finally:
                    if timer: timer.cancel();timer.join()
                with self.assertRaises(ProcessLookupError): os.kill(int((work/'child.pid').read_text()),0)

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
    def test_atomic_publish_uses_no_replace_and_refuses_unavailable_primitive(self):
        import ctypes,errno,os,tempfile
        from types import SimpleNamespace
        class Rename:
            def __call__(self,source_fd,source,target_fd,target,flags):
                self_test.assertEqual((source_fd,target_fd,flags),(-100,-100,1))
                source,target=Path(os.fsdecode(source)),Path(os.fsdecode(target))
                if target.exists():
                    ctypes.set_errno(errno.EEXIST)
                    return -1
                source.rename(target)
                return 0
        self_test=self
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);source=root/'staging';target=root/'final'
            source.mkdir();(source/'owned').write_bytes(b'owned')
            with mock.patch.object(q.ctypes,'CDLL',return_value=SimpleNamespace(renameat2=Rename())):
                q.publish_release(source,target)
                self.assertEqual((target/'owned').read_bytes(),b'owned')
                source.mkdir();(source/'owned').write_bytes(b'another')
                with self.assertRaises(OSError):q.publish_release(source,target)
                self.assertEqual((source/'owned').read_bytes(),b'another')
                self.assertEqual((target/'owned').read_bytes(),b'owned')
            with mock.patch.object(q.ctypes,'CDLL',return_value=SimpleNamespace()), self.assertRaises(AttributeError):
                q.publish_release(source,root/'unavailable')
            self.assertTrue(source.is_dir());self.assertFalse((root/'unavailable').exists())

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

    def lifecycle(self, exercise, fail=False, application=False, application_clean=True, release=False, change=None):
        import tempfile,hashlib
        from types import SimpleNamespace
        observed=[];label=None;recipe_cancel=None
        self.bundle = None
        self.foreign_preserved = False
        def context(source,wheels,output,base):
            output.mkdir();(output/'context.json').write_bytes(b'{}')
            return {'lockSha256':'f'*64 if change=='lock' else hashlib.sha256((q.ROOT/'runtimes/excel/requirements.lock').read_bytes()).hexdigest()}
        def build(args,work,deadline,cancel,**options):
            nonlocal label
            if args[0]=='build':
                label=args[args.index('--label')+1].split('=',1)[1]
                (work/'image.id').write_text(IMAGE)
            if args[:2] == ['image','save']:
                self.assertEqual(args,['image','save',IMAGE])
                self.assertEqual(observed,['host_consumed','application_consumed'])
                options['artifact'].write_bytes(b'owned-export-fixture')
                options['artifact'].chmod(0o400)
                observed.append('image_exported')
                if change == 'cancel': cancel.set()
                if change == 'extra': (options['artifact'].parent/'foreign').write_bytes(b'foreign')
                if change == 'context': (work/'context/context.json').write_bytes(b'changed-context')
                if change == 'export': return {'sha256':'f'*64,'size':20}
                return {'sha256':hashlib.sha256(b'owned-export-fixture').hexdigest(),'size':20}
        def docker(argv,payload,deadline,cancel,cwd,limit):
            args=argv[len(q.DOCKER):]
            if args[:2]==['image','inspect']:
                if change == 'image' and 'image_exported' in observed:
                    return json.dumps([{'Id':'sha256:'+'f'*64,'Config':{'Labels':{'org.memlia.excel.recipe':'foreign'}}}]).encode()
                return json.dumps([{'Id':q.PYTHON_CONFIG if args[2]==q.PYTHON_BASE else IMAGE,
                   'Os':'linux','Architecture':'amd64','Config':{'Labels':{'org.memlia.excel.recipe':label}}}]).encode()
            if args[:2]==['image','rm']:observed.append('image_removed');return b''
            if args[:2]==['image','ls']:return b''
            raise AssertionError('unexpected fixture transport')
        def run_case(docker,image,wire,probe,cancel,cases):
            cases[probe or 'worker']={'passed':not(change == 'case' and probe == 'cpu'),'cleanupComplete':True}
        def consume(proof,wire,deadline,cancel,record,**options):
            nonlocal recipe_cancel
            recipe_cancel=cancel
            self.assertNotIn('image_removed',observed)
            self.assertEqual(set(proof['cases']),set(q.s.admission.CASES))
            self.assertEqual(proof['imageId'],IMAGE);observed.append('host_consumed')
            if application:
                self.assertEqual(options,{'application_work':output/'application'})
                record['application']={'passed':True,'businessPassed':True,'readbackPassed':True,
                                       'cleanupComplete':application_clean,'resourcesRetained':not application_clean}
                observed.append('application_consumed')
            else:self.assertEqual(options,{})
            if fail:
                record.update(cleanupComplete=fail!='unknown',resourcesRetained=fail=='unknown')
                raise ValueError('fixture_consumer_refused')
            record.update(passed=True,cleanupComplete=True,resourcesRetained=False,
                          expectedPeerUid=1001,expectedRefusedUid=1002,peerAccepted=True,
                          otherUidRefused=True,sameQualifiedImage=True,hostStopped=True,hostExitCode=0)
        def publish(staging,destination):
            self.assertFalse(destination.exists())
            if change == 'collision':
                destination.mkdir();(destination/'foreign').write_bytes(b'foreign')
                raise FileExistsError('fixture-concurrent-operator')
            staging.rename(destination)
            observed.append('bundle_published')
            if change == 'commit_cancel': recipe_cancel.set()
            if change == 'commit_unknown': raise OSError('fixture-lost-reply')
        native_uid = q.os.getuid()
        native_parents = q.s.admission._parents
        def disk(_path):
            return SimpleNamespace(free=None if change=='disk' and 'image_exported' in observed else 10*1024**3)
        def revision(argv,**_options):
            if argv[-2:]==['rev-parse','HEAD']:
                return (b'f' if change=='source' and 'image_exported' in observed else b'c')*40
            return b''
        with tempfile.TemporaryDirectory(dir=Path(__file__).parent if release else None) as folder:
            output=Path(folder)/'owned'
            destination=Path(folder)/'operator-release'
            with mock.patch.object(q,'require_linux'), mock.patch.object(q.os,'getuid',return_value=0), mock.patch.object(q.shutil,'disk_usage',side_effect=disk), mock.patch.object(q.subprocess,'check_output',side_effect=revision), mock.patch.object(q.prepare_context,'prepare',side_effect=context), mock.patch.object(q,'build_command',side_effect=build), mock.patch.object(q.s,'_command',side_effect=docker), mock.patch.object(q,'fixture_wire',return_value=b'fixture'), mock.patch.object(q,'run_case',side_effect=run_case), mock.patch.object(q,'consume_through_host',side_effect=consume), mock.patch.object(q.s.admission,'_parents',side_effect=lambda path,owner: native_parents(path,native_uid)), mock.patch.object(q,'publish_release',side_effect=publish,create=True), mock.patch.object(q.s,'SOURCE_SHA256','f'*64 if change=='supervisor' else q.s.SOURCE_SHA256), mock.patch('builtins.print'):
                try:
                    result=q.run(Path(folder)/'wheels',output,exercise_host=exercise,
                                 exercise_application=application,
                                 **({'operator_release':destination} if release else {}))
                except TypeError as error:
                    self.fail('operator release invocation unavailable: '+str(error))
            receipt=json.loads((output/'receipt.json').read_bytes())
            if destination.exists() and (destination/'release.json').is_file():
                self.bundle = {'names':{p.name for p in destination.iterdir()},
                               'image':(destination/'image.tar').read_bytes(),
                               'manifest':json.loads((destination/'release.json').read_bytes()),
                               'admission':q.s.admission.capture(str(destination/'admission.json'),IMAGE,q.s.SOURCE_SHA256)}
            if destination.exists() and (destination/'foreign').is_file():
                self.foreign_preserved=(destination/'foreign').read_bytes()==b'foreign'
        return result,receipt,observed

    def test_default_does_not_admit_or_consume_an_image(self):
        result,receipt,observed=self.lifecycle(False)
        self.assertEqual(result,0);self.assertNotIn('hostConsumer',receipt)
        self.assertEqual(observed,['image_removed']);self.assertFalse(receipt['runtimeActivated'])

    def test_explicit_operator_release_holds_and_exports_exact_image_after_complete_cleanup(self):
        import hashlib
        result,receipt,observed=self.lifecycle(True,application=True,release=True)
        self.assertEqual(result,0)
        self.assertEqual(observed,['host_consumed','application_consumed','image_exported','bundle_published'])
        self.assertTrue(receipt['cleanupComplete'])
        self.assertFalse(receipt['runtimeActivated'])
        self.assertEqual(receipt['operatorRelease']['status'],'promoted')
        self.assertTrue(receipt['operatorRelease']['imageHeld'])
        self.assertEqual(self.bundle['image'],b'owned-export-fixture')
        self.assertEqual(self.bundle['manifest']['artifact'],
                         {'file':'image.tar','sha256':hashlib.sha256(b'owned-export-fixture').hexdigest(),'size':20})
        self.assertTrue(q.s.admission.permits(self.bundle['admission'],IMAGE,q.s.SOURCE_SHA256))

    def test_cancel_during_commit_or_lost_commit_reply_never_leaves_a_published_admission(self):
        for change in ('commit_cancel','commit_unknown'):
            with self.subTest(change=change):
                result,receipt,_=self.lifecycle(True,application=True,release=True,change=change)
                self.assertEqual(result,1)
                self.assertNotEqual(receipt['operatorRelease']['status'],'promoted')
                self.assertIsNone(self.bundle)

    def test_unexpected_export_entry_never_becomes_an_operator_bundle(self):
        result,receipt,_=self.lifecycle(True,application=True,release=True,change='extra')
        self.assertEqual(result,1)
        self.assertFalse(receipt['cleanupComplete'])
        self.assertIsNone(self.bundle)

    def test_release_requires_all_cases_provenance_image_export_and_observed_disk(self):
        for change in ('case','source','lock','context','supervisor','image','export','cancel','disk'):
            with self.subTest(change=change):
                result,receipt,observed=self.lifecycle(True,application=True,release=True,change=change)
                self.assertEqual(result,1)
                self.assertNotEqual(receipt['operatorRelease']['status'],'promoted')
                self.assertNotIn('bundleDirectory',receipt['operatorRelease'])
                self.assertIsNone(self.bundle)
                if change=='image': self.assertNotIn('image_removed',observed)

    def test_incomplete_application_or_unknown_host_cleanup_never_export(self):
        for options in ({'application_clean':False},{'fail':'unknown'}):
            with self.subTest(options=options):
                result,receipt,observed=self.lifecycle(True,application=True,release=True,**options)
                self.assertEqual(result,1)
                self.assertFalse(receipt['cleanupComplete'])
                self.assertNotIn('image_exported',observed)
                self.assertIsNone(self.bundle)

    def test_concurrent_operator_destination_is_never_replaced(self):
        result,receipt,_=self.lifecycle(True,application=True,release=True,change='collision')
        self.assertEqual(result,1)
        self.assertTrue(self.foreign_preserved)
        self.assertIsNone(self.bundle)

    def test_release_requires_explicit_host_application_and_fresh_nonsymlink_destination(self):
        import tempfile
        with tempfile.TemporaryDirectory() as folder, mock.patch.object(q,'require_linux'), mock.patch.object(q.os,'getuid',return_value=0):
            root=Path(folder);output=root/'absent';destination=root/'destination'
            for host,application in ((False,False),(True,False)):
                with self.subTest(host=host,application=application), self.assertRaises(ValueError):
                    q.run(root,output,exercise_host=host,exercise_application=application,operator_release=destination)
                self.assertFalse(output.exists())
            foreign=root/'foreign';foreign.write_bytes(b'foreign')
            for symlink in (False,True):
                if symlink: destination.symlink_to(foreign)
                else: destination.mkdir()
                with self.subTest(symlink=symlink), self.assertRaises(ValueError):
                    q.run(root,output,exercise_host=True,exercise_application=True,operator_release=destination)
                self.assertFalse(output.exists());self.assertEqual(foreign.read_bytes(),b'foreign')
                if symlink: destination.unlink()
                else: destination.rmdir()

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
