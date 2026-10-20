# Copyright (c) 2026 Memlia. All rights reserved.
"""Portable preparation tests; no Docker, PostgreSQL or authenticated API claim."""
import base64
import ast
from copy import deepcopy
from hashlib import sha256
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest import mock

import application_qualification as a
import qualification as q


class ApplicationOracleTests(unittest.TestCase):
    def answer(self):
        from memlia_excel.process import prepare
        answer = prepare(json.loads(q.fixture_wire()))
        content = base64.b64decode(answer['outputs'][0]['contentBase64'])
        return dict(status='passed', scope='native_api_in_process',
                    checks={name: True for name in a.CHECKS},
                    file=dict(contentBase64=base64.b64encode(content).decode(),
                              sha256='sha256:'+sha256(content).hexdigest(),
                              size=len(content), contentType=a.XLSX),
                    download=dict(status=200, contentType=a.XLSX,
                                  contentLength=len(content),
                                  contentBase64=base64.b64encode(content).decode()))

    def test_real_xlsx_download_matches_the_same_native_recorded_file(self):
        result = a.verify_result(json.dumps(self.answer()).encode())
        self.assertEqual(result['scope'], 'native_api_in_process')
        self.assertTrue(result['sameRecordedOutput'])
        self.assertNotIn('contentBase64', json.dumps(result))

    def test_changed_download_equal_size_is_refused(self):
        value=self.answer()
        content=bytearray(base64.b64decode(value['download']['contentBase64']))
        content[-1] ^= 1
        value['download']['contentBase64']=base64.b64encode(content).decode()
        with self.assertRaises(ValueError):a.verify_result(json.dumps(value).encode())

    def test_missing_authority_case_or_extra_field_never_qualifies(self):
        original=self.answer()
        for name in a.CHECKS:
            value=deepcopy(original);value['checks'][name]=False
            with self.subTest(name=name),self.assertRaises(ValueError):
                a.verify_result(json.dumps(value).encode())
        for delta in ({'httpQualified':True},{'secret':'PRIVATE_CANARY'}):
            with self.assertRaises(ValueError):a.verify_result(json.dumps(original|delta).encode())

    def test_digest_mime_size_and_boolean_status_are_not_coerced(self):
        original=self.answer()
        for part,key,value in [('file','sha256','sha256:'+'0'*64),
                               ('file','size',True),('download','status',True),
                               ('download','contentType','application/octet-stream'),
                               ('download','contentLength',0)]:
            changed=deepcopy(original);changed[part][key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):
                a.verify_result(json.dumps(changed).encode())

    def test_duplicate_json_and_oversize_are_refused(self):
        raw=json.dumps(self.answer()).encode()
        for value in (raw.replace(b'"status": "passed"',b'"status":"failed","status":"passed"'),
                      b' '*(a.MAX_RESULT+1)):
            with self.assertRaises(ValueError):a.verify_result(value)


class ApplicationBoundaryTests(unittest.TestCase):
    def test_operator_precondition_precedes_resources(self):
        with tempfile.TemporaryDirectory() as temporary, mock.patch.object(a.os,'getuid',return_value=1001):
            work=Path(temporary)/'not-created'
            with self.assertRaises(ValueError):
                a.consume(Path('/run/not-opened/host.sock'),b'{}',time.monotonic()+1,
                          threading.Event(),work,{})
            self.assertFalse(work.exists())

    def test_inspection_requires_exact_identity_limits_and_live_nonoom(self):
        row=dict(Id='a'*64,Config={'Labels':{'org.memlia.excel.application':'b'*32},'User':'1001:1001'},
                 State={'Running':True,'OOMKilled':False},
                 HostConfig={'ReadonlyRootfs':True,'Privileged':False,'Memory':4*1024**3,
                             'MemorySwap':4*1024**3,'NanoCpus':2_000_000_000,'PidsLimit':256,
                             'CapDrop':['ALL'],'SecurityOpt':['no-new-privileges:true']})
        a.inspect_owned(row,'a'*64,'b'*32,'1001:1001',4*1024**3,2_000_000_000,256,running=True)
        for area,key,value in [('State','OOMKilled',True),('State','Running',False),
                               ('HostConfig','MemorySwap',-1),('HostConfig','ReadonlyRootfs',False),
                               ('Config','User','0:0')]:
            changed=deepcopy(row);changed[area][key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):
                a.inspect_owned(changed,'a'*64,'b'*32,'1001:1001',4*1024**3,2_000_000_000,256,running=True)

    def test_missing_extra_or_writable_source_mount_never_passes(self):
        expected={'/work':('/owned/source',False),'/scratch':('/owned/scratch',True)}
        row={'HostConfig':{'Tmpfs':{'/tmp':'rw,noexec'}},'Mounts':[
            {'Type':'bind','Destination':'/work','Source':'/owned/source','RW':False,'Propagation':'rprivate'},
            {'Type':'bind','Destination':'/scratch','Source':'/owned/scratch','RW':True,'Propagation':'rprivate'}]}
        a.inspect_mounts(row,expected)
        for edit in ('missing','extra','writable','duplicate','volume','propagation'):
            changed=deepcopy(row)
            if edit=='missing':changed.pop('Mounts')
            elif edit=='extra':changed['Mounts'].append({'Type':'bind','Destination':'/var/run/docker.sock','Source':'/var/run/docker.sock','RW':True,'Propagation':'rprivate'})
            elif edit=='writable':changed['Mounts'][0]['RW']=True
            elif edit=='duplicate':changed['Mounts'].append(changed['Mounts'][0])
            elif edit=='volume':changed['Mounts'][0]['Type']='volume'
            else:changed['Mounts'][0]['Propagation']='rshared'
            with self.subTest(edit=edit),self.assertRaises(ValueError):a.inspect_mounts(changed,expected)

    def test_owned_tree_refuses_symlink_and_hardlink_without_removing_target(self):
        import os
        for link in ('symlink','hardlink'):
            with tempfile.TemporaryDirectory() as temporary:
                root=Path(temporary)/'owned';root.mkdir();external=Path(temporary)/'foreign';external.write_bytes(b'untouched')
                if link=='symlink':(root/'link').symlink_to(external)
                else:os.link(external,root/'link')
                with self.assertRaises(ValueError):a.tree_snapshot(root)
                self.assertEqual(external.read_bytes(),b'untouched')

    def test_closed_owned_tree_removes_nested_native_files_only_after_identity_readback(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)/'owned';(root/'nested/deep').mkdir(parents=True)
            (root/'nested/deep/output.xlsx').write_bytes(b'owned-test')
            (root/'result.json').write_bytes(b'{}')
            snapshot=a.tree_snapshot(root)
            a.remove_closed_tree(root,snapshot)
            self.assertFalse(root.exists())

    def test_file_changed_after_snapshot_is_retained(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary)/'owned';root.mkdir();path=root/'output'
            path.write_bytes(b'before');snapshot=a.tree_snapshot(root);path.write_bytes(b'changed')
            with self.assertRaises(ValueError):a.remove_closed_tree(root,snapshot)
            self.assertEqual(path.read_bytes(),b'changed')


class CleanupDiagnosticTests(unittest.TestCase):
    def test_closed_cleanup_failure_projection_refuses_extra_or_unbounded_fields(self):
        value=dict(status='failed',code='fixture_cleanup_refused',stage='baseline_compare',
                   index=182,sqlstate='23503')
        self.assertEqual(a.project_cleanup_failure(json.dumps(value).encode()),value)
        for delta in ({'message':'PRIVATE_CANARY'},{'stage':'PRIVATE_CANARY'},
                      {'sqlstate':'23503\n'},{'sqlstate':'private'},{'sqlstate':True},
                      {'index':True},{'index':183},{'index':-1},
                      {'stage':'native_account_deletion','index':0}):
            with self.subTest(delta=delta),self.assertRaises(ValueError):
                a.project_cleanup_failure(json.dumps(value|delta).encode())
        raw=json.dumps(value).encode()
        for raw in (raw.replace(b'"status": "failed"',b'"status":"passed","status":"failed"'),
                    b' '*1025):
            with self.assertRaises(ValueError):a.project_cleanup_failure(raw)

    def run_phase(self, *, failure=None, exit_code=0, inspection_failure=False, raw=None):
        # Execute the real nested phase, with the Docker command/inspection boundary doubled.
        tree=ast.parse(Path(a.__file__).read_text())
        node=next(n for n in ast.walk(tree) if isinstance(n,ast.FunctionDef) and n.name=='phase')
        code=compile(ast.fix_missing_locations(ast.Module(body=[node],type_ignores=[])),a.__file__,'exec')
        record={'containers':[{'id':'a'*64,'closed':False}]};owned=[('a'*64,)]
        def inspect(*args,**kwargs):
            if inspection_failure:raise ValueError('PRIVATE_CANARY inspection')
            return {'State':{'ExitCode':exit_code}}
        calls=[]
        scope=dict(record=record,create=lambda *args:owned[0],NODE='fixture-image',
                   work=Path('/owned/work'),ROOT=Path('/owned/source'),tools=Path('/owned/tools'),
                   scratch=Path('/owned/scratch'),socket=Path('/owned/socket/host.sock'),
                   inspect=inspect,command=lambda args,**kwargs:calls.append(args) or b'',
                   owned=owned,require=a.require,read_closed=lambda *args:raw,
                   project_cleanup_failure=getattr(a,'project_cleanup_failure',None),
                   json=json,STAGES=a.STAGES,deadline=time.monotonic()+5,cancel=threading.Event())
        exec(code,scope)
        with mock.patch.object(q,'build_command',side_effect=failure):
            try:scope['phase']('cleanup')
            except Exception:pass
        return record,calls

    def test_execution_failure_is_classified_without_turning_it_into_success(self):
        raw=json.dumps(dict(status='failed',code='fixture_cleanup_refused',
                            stage='baseline_compare',index=3,sqlstate=None)).encode()
        record,calls=self.run_phase(failure=RuntimeError('PRIVATE_CANARY'),exit_code=1,raw=raw)
        self.assertEqual(record['cleanupExecution'],dict(boundary='execution',exitCode=1))
        self.assertEqual(record['cleanupFailure']['stage'],'baseline_compare')
        self.assertNotIn('phases',record)
        self.assertEqual(calls,[])
        self.assertNotIn('PRIVATE_CANARY',json.dumps(record))

    def test_invalid_private_receipt_and_unknown_exit_never_leak_or_pass(self):
        raw=b'{"status":"failed","message":"PRIVATE_CANARY"}'
        for exit_code in (-1,256,True,'PRIVATE_CANARY'):
            record,calls=self.run_phase(failure=RuntimeError('PRIVATE_CANARY'),exit_code=exit_code,raw=raw)
            self.assertEqual(record['cleanupExecution'],dict(boundary='execution',exitCode=None))
            self.assertNotIn('cleanupFailure',record)
            self.assertNotIn('phases',record);self.assertEqual(calls,[])
            self.assertNotIn('PRIVATE_CANARY',json.dumps(record))

    def test_owned_inspection_refusal_and_nonzero_exit_remain_refusals(self):
        record,calls=self.run_phase(inspection_failure=True)
        self.assertEqual(record['cleanupExecution'],dict(boundary='owned_inspection',exitCode=None))
        self.assertNotIn('phases',record);self.assertEqual(calls,[])
        record,calls=self.run_phase(exit_code=3)
        self.assertEqual(record['cleanupExecution'],dict(boundary='exit_code',exitCode=3))
        self.assertNotIn('phases',record);self.assertEqual(calls,[])

    def test_successful_ephemeral_cleanup_still_requires_closed_inspection_and_owned_removal(self):
        record,calls=self.run_phase()
        self.assertEqual(record['phases'],['cleanup'])
        self.assertTrue(record['containers'][0]['closed'])
        self.assertNotIn('cleanupExecution',record)
        self.assertEqual([args[:2] for args in calls],[['container','rm'],['container','ls']])


if __name__=='__main__':unittest.main()
