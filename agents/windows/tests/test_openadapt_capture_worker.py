# Copyright (c) 2026 Memlia. All rights reserved.
"""Worker boundary tests; Recorder/verified Capture/Flow are explicit external doubles."""
import importlib.util
from contextlib import redirect_stderr
import io
from pathlib import Path
import tempfile
import time
import unittest
import os
import subprocess
import sys
from unittest.mock import patch

from memlia_agent.capture_input_filter import CaptureInputFactory


DIGEST = 'sha256:' + 'c' * 64


class CaptureWorkerTests(unittest.TestCase):
    def worker(self):
        self.assertIsNotNone(importlib.util.find_spec('memlia_agent.openadapt_capture_worker'),
                             'the owned native Recorder worker is missing')
        return __import__('memlia_agent.openadapt_capture_worker', fromlist=['capture'])

    def fixture(self, root, *, finish=True, sealed=True, large=False):
        calls = []
        class Recorder:
            def __init__(self, path, **options):
                calls.append(('options', options))
                self.path = Path(path)
                self.is_recording = True
            def __enter__(self):
                self.path.mkdir()
                (self.path / 'recording.db').write_bytes(b'fictitious-capture')
                return self
            def wait_for_ready(self, timeout):
                calls.append('ready')
                return True
            def check_health(self):
                if finish:
                    (root / 'finish').write_bytes((DIGEST + '\n').encode())
                else:
                    self.is_recording = False
            def __exit__(self, *args):
                calls.append('recorder_closed')
                self.is_recording = False
        class Verified:
            capture_dir = root / 'capture'
            def close(self):
                calls.append('verified_closed')
        class CaptureSession:
            @staticmethod
            def load_verified(path):
                calls.append('verified')
                if not sealed:
                    raise OSError('PRIVATE_CANARY')
                return Verified()
        def convert(source, target, **options):
            calls.append(('convert', options))
            self.assertEqual(source, root / 'capture')
            Path(target).mkdir()
            (Path(target) / 'meta.json').write_bytes(b'{}')
            (Path(target) / 'events.jsonl').write_bytes(b'{}\n' * (100 if large else 1))
            return Path(target)
        factory = CaptureInputFactory(1, 2, 3, 4, 'S-1-5-21-1', 1, DIGEST,
                                      time.monotonic() + 30)
        return (Recorder, CaptureSession, convert), factory, calls

    def test_normal_finish_is_delivered_only_after_recorder_and_verified_snapshot_close(self):
        worker = self.worker()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime, factory, calls = self.fixture(root)
            with patch.object(worker, '_runtime', return_value=runtime):
                result = worker.capture(root, factory=factory, operation_digest=DIGEST,
                                        deadline_monotonic=factory.deadline_monotonic, max_bytes=4096)
            self.assertEqual(result, {'status': 'recorded', 'operationDigest': DIGEST})
            self.assertLess(calls.index('recorder_closed'), calls.index('verified'))
            self.assertLess(calls.index('verified'), calls.index(('convert', {'include_structural': False})))
            self.assertEqual(calls[-1], 'verified_closed')
            options = calls[0][1]
            self.assertIs(options['input_observer_factory'], factory)
            for name in ('capture_audio', 'capture_video', 'capture_full_video',
                         'capture_browser_events', 'capture_structural_observations',
                         'control_enabled', 'send_profile'):
                self.assertIs(options[name], False)
            self.assertEqual(options['stop_sequences'], [])
            self.assertEqual((root / 'ready').read_bytes(), (DIGEST + '\n').encode())
            self.assertTrue((root / 'recording' / 'events.jsonl').is_file())

    def test_autonomous_recorder_end_never_becomes_normal_finish(self):
        worker = self.worker()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime, factory, calls = self.fixture(root, finish=False)
            with patch.object(worker, '_runtime', return_value=runtime):
                with self.assertRaises(worker.WorkerError) as caught:
                    worker.capture(root, factory=factory, operation_digest=DIGEST,
                                   deadline_monotonic=factory.deadline_monotonic, max_bytes=4096)
            self.assertEqual(caught.exception.code, 'capture_ended_without_finish')
            self.assertNotIn('verified', calls)
            self.assertIn('recorder_closed', calls)

    def test_unsealed_recording_refuses_conversion_and_has_no_private_error_context(self):
        worker = self.worker()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime, factory, calls = self.fixture(root, sealed=False)
            private_error = io.StringIO()
            with patch.object(worker, '_runtime', return_value=runtime), redirect_stderr(private_error):
                with self.assertRaises(worker.WorkerError) as caught:
                    worker.capture(root, factory=factory, operation_digest=DIGEST,
                                   deadline_monotonic=factory.deadline_monotonic, max_bytes=4096)
            self.assertEqual(caught.exception.code, 'capture_worker_failed')
            self.assertIsNone(caught.exception.__context__)
            self.assertIn('OSError: PRIVATE_CANARY', private_error.getvalue())
            self.assertNotIn('PRIVATE_', str(caught.exception))
            self.assertFalse(any(isinstance(x, tuple) and x[0] == 'convert' for x in calls))

    def test_conversion_exceeding_aggregate_limit_does_not_deliver_success(self):
        worker = self.worker()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime, factory, calls = self.fixture(root, large=True)
            with patch.object(worker, '_runtime', return_value=runtime):
                with self.assertRaises(worker.WorkerError) as caught:
                    worker.capture(root, factory=factory, operation_digest=DIGEST,
                                   deadline_monotonic=factory.deadline_monotonic, max_bytes=256)
            self.assertEqual(caught.exception.code, 'capture_storage_limit')
            self.assertEqual(calls[-1], 'verified_closed')

    def test_native_engine_stdout_cannot_corrupt_the_closed_worker_receipt(self):
        worker = self.worker()
        with tempfile.TemporaryDirectory() as directory:
            factory = CaptureInputFactory(1, 2, 3, 4, 'S-1-5-21-1', 1, DIGEST,
                                          time.monotonic() + 30)
            code = """
import os,sys
from memlia_agent import openadapt_capture_worker as worker
worker.sys.platform='win32'
def capture(*args,**kwargs):
    print('PRIVATE_PROFILE')
    sys.stdout.flush()
    os.write(1,b'PRIVATE_NATIVE\\n')
    return {'status':'recorded','operationDigest':kwargs['operation_digest']}
worker.capture=capture
raise SystemExit(worker.main())
"""
            result = subprocess.run([sys.executable, '-B', '-c', code], input=worker.request_bytes(factory, 4096),
                                    cwd=directory, env=dict(os.environ), capture_output=True, timeout=5)
            self.assertEqual(result.returncode, 0)
            import json
            self.assertEqual(json.loads(result.stdout), {'status': 'recorded', 'operationDigest': DIGEST})
            self.assertNotIn(b'PRIVATE_', result.stdout)
            self.assertIn(b'PRIVATE_PROFILE', result.stderr)
            self.assertIn(b'PRIVATE_NATIVE', result.stderr)

    def test_late_ready_never_publishes_ready_or_converts(self):
        worker = self.worker()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runtime, factory, calls = self.fixture(root)
            clock = [time.monotonic()]
            class Late(runtime[0]):
                def wait_for_ready(self, timeout):
                    clock[0] = factory.deadline_monotonic + 1
                    return True
            with patch.object(worker, '_runtime', return_value=(Late, *runtime[1:])), \
                    patch.object(worker.time, 'monotonic', side_effect=lambda: clock[0]):
                with self.assertRaises(worker.WorkerError) as caught:
                    worker.capture(root, factory=factory, operation_digest=DIGEST,
                                   deadline_monotonic=factory.deadline_monotonic, max_bytes=4096)
            self.assertEqual(caught.exception.code, 'capture_deadline_expired')
            self.assertFalse((root / 'ready').exists())
            self.assertNotIn('verified', calls)
            self.assertIn('recorder_closed', calls)

    def test_actual_hardlink_and_symlink_are_never_read_as_owned_output(self):
        worker = self.worker()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / 'owned';source.write_bytes(b'fictitious')
            for name, link in [('hardlink', os.link), ('symlink', os.symlink)]:
                target = root / name;link(source, target)
                try:
                    with self.assertRaises(worker.WorkerError) as caught: worker.read_small(target, 1024)
                    self.assertEqual(caught.exception.code, 'capture_file_invalid')
                finally: target.unlink()


if __name__ == '__main__':
    unittest.main()
