# Copyright (c) 2026 Memlia. All rights reserved.
"""Fresh-process boundary; native compiler doubled, filesystem/child Python real."""
import hashlib
import importlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from memlia_agent.openadapt_compile import BundleFile, CompiledRecording, _digest, _VERSIONS


INPUT = (('events.jsonl', b'{}\n'), ('meta.json', b'{}'))
OUTPUT = (('manifest.json', b'{}'), ('workflow.json', b'{}'),
          ('workflow.py', b'raise RuntimeError("NEVER EXECUTE")'))
SOURCE = _digest(INPUT, b'memlia.raw-recording-v1\0')
BUNDLE = _digest(OUTPUT, b'memlia.openadapt-bundle/v1\0')


def compiled():
    return CompiledRecording(tuple(BundleFile(n, b, hashlib.sha256(b).hexdigest()) for n,b in OUTPUT),
                             SOURCE, BUNDLE, 1, tuple(sorted(_VERSIONS.items())))


class CompileWorkerBoundaryTests(unittest.TestCase):
    def worker(self):
        return importlib.import_module('memlia_agent.openadapt_compile_worker')

    def stage(self, directory):
        root = Path(directory); (root/'recording').mkdir()
        for name, data in INPUT: (root/'recording'/name).write_bytes(data)
        return root

    def request(self):
        return dict(version=1, name='Fictitious procedure', sourceSha256=SOURCE,
                    deadline=time.monotonic()+20)

    def test_exact_input_native_port_and_unverified_bundle_only(self):
        worker = self.worker()
        with tempfile.TemporaryDirectory() as directory:
            root = self.stage(directory)
            with patch.object(worker, 'compile_raw_recording', return_value=compiled()) as port:
                result = worker.compile_directory(root, self.request())
            self.assertEqual(port.call_args.args[0], dict(INPUT))
            self.assertEqual(port.call_args.kwargs['name'], 'Fictitious procedure')
            self.assertEqual(result['status'], 'to_test')
            self.assertEqual(result['bundleSha256'], BUNDLE)
            self.assertEqual({p.name:p.read_bytes() for p in (root/'bundle').iterdir()}, dict(OUTPUT))
            self.assertNotIn('ready', result)

    def test_changed_source_or_existing_destination_refuses_before_compile(self):
        worker = self.worker()
        for mode in ('source', 'destination'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                root = self.stage(directory)
                if mode=='source': (root/'recording'/'meta.json').write_bytes(b'{"changed":true}')
                else: (root/'bundle').mkdir()
                with patch.object(worker, 'compile_raw_recording') as port:
                    with self.assertRaises(worker.CompileError): worker.compile_directory(root,self.request())
                port.assert_not_called()

    def test_windows_capture_worker_requests_native_windows_surface(self):
        worker = self.worker()
        with tempfile.TemporaryDirectory() as directory:
            root = self.stage(directory)
            with patch.object(worker, 'compile_raw_recording', return_value=compiled()) as port:
                result = worker.compile_directory(root, self.request())
            self.assertEqual(port.call_args.kwargs.get('target_surface'), 'windows')
            self.assertEqual(result['status'], 'to_test')

    def test_real_child_is_fresh_and_native_stdout_cannot_corrupt_receipt(self):
        worker = self.worker()
        with tempfile.TemporaryDirectory() as directory:
            self.stage(directory)
            code = '''
import os,sys,hashlib
from memlia_agent import openadapt_compile_worker as worker
from memlia_agent.openadapt_compile import BundleFile,CompiledRecording,_claim_worker,_digest,_VERSIONS
worker.sys.platform='win32'
def compile(files,**kwargs):
    _claim_worker()
    print('PRIVATE_COMPILER_STDOUT');sys.stdout.flush();os.write(1,b'PRIVATE_NATIVE\\n')
    output=(('manifest.json',b'{}'),('workflow.json',b'{}'),('workflow.py',b'raise RuntimeError("NEVER EXECUTE")'))
    return CompiledRecording(tuple(BundleFile(n,b,hashlib.sha256(b).hexdigest()) for n,b in output),
        _digest(tuple(sorted(files.items())),b'memlia.raw-recording-v1\\0'),
        _digest(output,b'memlia.openadapt-bundle/v1\\0'),1,tuple(sorted(_VERSIONS.items())))
worker.compile_raw_recording=compile
raise SystemExit(worker.main())
'''
            env=dict(os.environ,ORT_DISABLE_TELEMETRY='1',OPENADAPT_FLOW_OCR='rapidocr')
            result=subprocess.run([sys.executable,'-B','-c',code],input=json.dumps(self.request()).encode(),
                                  cwd=directory,env=env,capture_output=True,timeout=5)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual(json.loads(result.stdout)['status'],'to_test')
            self.assertNotIn(b'PRIVATE_',result.stdout)
            self.assertIn(b'PRIVATE_COMPILER_STDOUT',result.stderr)
            self.assertIn(b'PRIVATE_NATIVE',result.stderr)

    def test_real_child_native_refusal_keeps_cause_only_on_private_stderr(self):
        with tempfile.TemporaryDirectory() as directory:
            self.stage(directory)
            code = '''
from memlia_agent import openadapt_compile_worker as worker
from memlia_agent.openadapt_compile import CompileError
worker.sys.platform='win32'
def compile(*args,**kwargs):
    error=CompileError('compile_failed')
    error.private_diagnostic=b'PRIVATE_NATIVE_CAUSE'
    error.private_diagnostic_complete=False
    raise error
worker.compile_raw_recording=compile
raise SystemExit(worker.main())
'''
            result=subprocess.run([sys.executable,'-B','-c',code],input=json.dumps(self.request()).encode(),
                                  cwd=directory,env=dict(os.environ),capture_output=True,timeout=5)
            self.assertEqual(result.returncode,1)
            self.assertEqual(json.loads(result.stdout),{'status':'refused','errorCode':'compile_failed',
                                                       'privateDiagnosticComplete':False})
            self.assertEqual(result.stderr,b'PRIVATE_NATIVE_CAUSE')
            self.assertNotIn(b'PRIVATE_',result.stdout)
            self.assertFalse((Path(directory)/'bundle').exists())


if __name__=='__main__': unittest.main()
