# Copyright (c) 2026 Memlia. All rights reserved.
"""Real private-file IPC; parent mTLS authority is an explicit test double."""
import hashlib
import json
import tempfile
import threading
import time
from pathlib import Path
import unittest
from unittest.mock import patch

class PersonalAdmissionTests(unittest.TestCase):
    def test_each_worker_checkpoint_requires_parent_ack_and_exact_binding(self):
        from memlia_agent import openadapt_replay_admission as a
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); calls=[]; stop=threading.Event(); errors=[]
            request=dict(nonce='a'*32,mode='test',deadline=time.monotonic()+4,bundleSha256='b'*64,
                deploymentSha256='c'*64,parametersSha256='d'*64,admissionSha256=hashlib.sha256(b'{}').hexdigest(),
                operationDigest='sha256:'+'e'*64,sessionId=1,windowsSid='S-1-5-21-1-2-3-1001')
            parent=a.ParentAdmission(root,request,lambda:calls.append('native-checkpoint'))
            def serve():
                try:
                    while not stop.is_set():parent.serve();time.sleep(.002)
                except BaseException as error:errors.append(error)
            thread=threading.Thread(target=serve);thread.start()
            try:
                with patch.object(a.Path,'cwd',return_value=root):
                    binding=a.admit_replay(request,bundle_sha256='b'*64,deployment_sha256='c'*64,parameters_sha256='d'*64,
                        operation_digest=request['operationDigest'],mode='test',deadline=request['deadline'],admission_bytes=b'{}')
                a.checkpoint_replay(binding,stage='request',method='POST',path='/input/guarded')
                with self.assertRaises(a.AdmissionError):a.checkpoint_replay(binding,stage='request',method='POST',path='/execute')
                a.close_replay_admission(binding)
                with self.assertRaises(a.AdmissionError):a.checkpoint_replay(binding,stage='startup')
                self.assertEqual(len(calls),3)
                self.assertTrue(parent.closed)
            finally:stop.set();thread.join(1)
            self.assertEqual(errors,[])
    def test_production_and_missing_parent_refuse_without_runtime(self):
        from memlia_agent import openadapt_replay_admission as a
        with tempfile.TemporaryDirectory() as folder:
            request=dict(nonce='a'*32,mode='production',deadline=time.monotonic()+1)
            with self.assertRaises(a.AdmissionError):a.ParentAdmission(Path(folder),request,lambda:None)
            self.assertEqual(list(Path(folder).iterdir()),[])
    def test_parent_rejects_changed_nonce_sequence_and_abort_before_ack(self):
        from memlia_agent import openadapt_replay_admission as a
        for field,value in [('nonce','b'*32),('sequence',2)]:
            with self.subTest(field=field),tempfile.TemporaryDirectory() as folder:
                root=Path(folder);request=dict(nonce='a'*32,mode='test',deadline=time.monotonic()+1)
                parent=a.ParentAdmission(root,request,lambda:None)
                message=dict(nonce='a'*32,sequence=1,binding=parent.binding.hex(),stage='admit',method=None,path=None)
                message[field]=value
                (root/'admission.request').write_text(json.dumps(message))
                with self.assertRaises(a.AdmissionError):parent.serve()
                self.assertFalse((root/'admission.response').exists())

    def test_real_child_requires_fresh_parent_and_aborts_when_parent_revoked(self):
        import subprocess
        import sys
        from memlia_agent import openadapt_replay_admission as a
        child_code = '''import json,sys,time
from memlia_agent import openadapt_replay_admission as a
r=json.loads(sys.stdin.buffer.read(4096))
b=a.admit_replay(r,bundle_sha256=r['bundleSha256'],deployment_sha256=r['deploymentSha256'],parameters_sha256=r['parametersSha256'],operation_digest=r['operationDigest'],mode='test',deadline=r['deadline'],admission_bytes=b'{}')
try:
 a.checkpoint_replay(b,stage='request',method='POST',path='/input/guarded')
 a.close_replay_admission(b)
 print('closed')
except a.AdmissionError:
 print('refused')
'''
        for revoke in (False,True):
            with self.subTest(revoke=revoke),tempfile.TemporaryDirectory() as folder:
                root=Path(folder);request=dict(nonce='a'*32,mode='test',deadline=time.monotonic()+3,
                    bundleSha256='b'*64,deploymentSha256='c'*64,parametersSha256='d'*64,
                    admissionSha256=hashlib.sha256(b'{}').hexdigest(),operationDigest='sha256:'+'e'*64)
                calls=[]
                def authority():
                    calls.append(1)
                    if revoke and len(calls)>1:raise a.AdmissionError()
                parent=a.ParentAdmission(root,request,authority)
                # A real isolated Python child; only native mTLS authority is doubled.
                source=str(Path(a.__file__).parents[1])
                code='import sys;sys.path.insert(0,'+repr(source)+')\n'+child_code
                process=subprocess.Popen([sys.executable,'-I','-B','-c',code],cwd=root,
                    stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
                try:
                    process.stdin.write(json.dumps(request).encode());process.stdin.close();process.stdin=None
                    deadline=time.monotonic()+4
                    while process.poll() is None and time.monotonic()<deadline:
                        try:parent.serve()
                        except a.AdmissionError:
                            if not (root/'stop').exists():(root/'stop').write_bytes(b'owned-abort')
                        time.sleep(.005)
                    stdout,stderr=process.communicate(timeout=1)
                    self.assertEqual(process.returncode,0,stderr[:1024])
                    self.assertEqual(stdout,b'refused\n' if revoke else b'closed\n')
                    self.assertEqual(parent.closed,not revoke)
                    self.assertEqual(len(calls),2 if revoke else 3)
                finally:
                    if process.poll() is None:process.kill()
                    process.communicate(timeout=1)

    def test_boolean_ack_cannot_be_replaced_with_numeric_json(self):
        from memlia_agent import openadapt_replay_admission as a
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);request=dict(nonce='a'*32,mode='test',deadline=time.monotonic()+1,
                bundleSha256='b'*64,deploymentSha256='c'*64,parametersSha256='d'*64,
                admissionSha256=hashlib.sha256(b'{}').hexdigest(),operationDigest='sha256:'+'e'*64)
            parent=a.ParentAdmission(root,request,lambda:None)
            (root/'admission.response').write_text(json.dumps(dict(nonce=request['nonce'],sequence=1,binding=parent.binding.hex(),accepted=1)))
            try:
                with patch.object(a.Path,'cwd',return_value=root),self.assertRaises(a.AdmissionError):
                    a.admit_replay(request,bundle_sha256='b'*64,deployment_sha256='c'*64,parameters_sha256='d'*64,
                        operation_digest=request['operationDigest'],mode='test',deadline=request['deadline'],admission_bytes=b'{}')
            finally:a._active.clear()  # Test-only disposal after the deliberately malformed ACK.
