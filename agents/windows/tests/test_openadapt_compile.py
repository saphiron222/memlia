# Copyright (c) 2026 Memlia. All rights reserved.
"""Real filesystem/PNG boundary tests; OpenAdapt and ONNX ports are explicit doubles."""

from contextlib import ExitStack, contextmanager
import hashlib
import importlib
import io
import os
from pathlib import Path
import stat
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

try:
    from memlia_agent import openadapt_compile as module
except ImportError:
    module = None


class CompileTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(module, 'The bounded native compilation adapter is missing')
        self.root = tempfile.TemporaryDirectory(prefix='memlia-compile-test-')
        self.addCleanup(self.root.cleanup)
        self.calls = []
        self.expected_files = self.recording()
        self.engine = self.compile_engine
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.dict(os.environ, {
            'ORT_DISABLE_TELEMETRY': '1', 'OPENADAPT_FLOW_OCR': 'rapidocr'}, clear=True))
        self.stack.enter_context(patch.object(module, '_claimed', False))
        self.stack.enter_context(patch.object(module.tempfile, 'tempdir', self.root.name))
        self.stack.enter_context(patch.object(module.metadata, 'version', side_effect={
            'openadapt-flow': '2.2.0', 'openadapt-types': '0.24.0',
            'rapidocr-onnxruntime': '1.4.4', 'onnxruntime': '1.31.0'}.__getitem__))
        self.real_import = importlib.import_module
        self.stack.enter_context(patch.object(module.importlib, 'import_module', self.import_port))

    def import_port(self, name):
        if name == 'onnxruntime':
            return SimpleNamespace(disable_telemetry_events=lambda: self.calls.append('telemetry-off'))
        if name == 'openadapt_flow.compiler.compile':
            self.calls.append('compiler-import')
            return SimpleNamespace(compile_recording=lambda *a, **kw: self.engine(*a, **kw))
        if name == 'openadapt_flow.ir':
            return SimpleNamespace(Workflow=SimpleNamespace(load=self.load_workflow))
        return self.real_import(name)

    def load_workflow(self, bundle, **kwargs):
        self.calls.append(('load', kwargs))
        return SimpleNamespace(steps=[object()])

    def compile_engine(self, recording, bundle, **kwargs):
        self.calls.append(('compile', kwargs))
        self.assertEqual({p.relative_to(recording).as_posix(): p.read_bytes()
                          for p in recording.rglob('*') if p.is_file()}, self.expected_files)
        if os.name != 'nt':
            for p in (recording.parent, recording, bundle):
                self.assertEqual(stat.S_IMODE(p.stat().st_mode), 0o700)
            for p in recording.rglob('*'):
                if p.is_dir():
                    continue
                self.assertEqual(stat.S_IMODE(p.stat().st_mode), 0o600)
        (bundle / 'workflow.json').write_bytes(b'{"native":"schema"}')
        (bundle / 'manifest.json').write_bytes(b'{"native":"manifest"}')
        (bundle / 'workflow.py').write_bytes(b'raise RuntimeError("MUST NEVER EXECUTE")')
        return SimpleNamespace(manifest=SimpleNamespace(file_hashes={}))

    def recording(self):
        return {'meta.json': b'{}', 'events.jsonl': b'{"i":0,"kind":"key","key":"Tab"}\n',
                'check.json': b'{"native":"preserved"}'}

    def run_compile(self, files=None, **kw):
        return module.compile_raw_recording(self.recording() if files is None else files,
            name='Fictitious procedure', deadline_monotonic=time.monotonic() + 20, **kw)

    def test_real_owned_staging_preserves_native_inputs_and_returns_opaque_unverified_bytes(self):
        files = self.recording()
        result = self.run_compile(files)
        self.assertEqual(result.status, 'to_test')
        self.assertEqual(result.profile, 'raw-recording-v1')
        self.assertEqual(result.step_count, 1)
        self.assertEqual(dict((f.path, f.content) for f in result.files), {
            'workflow.json': b'{"native":"schema"}', 'manifest.json': b'{"native":"manifest"}',
            'workflow.py': b'raise RuntimeError("MUST NEVER EXECUTE")'})
        self.assertEqual(self.calls, ['telemetry-off', 'compiler-import', ('compile', {
            'name': 'Fictitious procedure', 'annotate': False, 'mine_effects': False,
            'admit_api_bindings': False}), ('load', {'validate': True, 'verify_integrity': True})])
        self.assertEqual(list(Path(self.root.name).iterdir()), [])
        self.assertEqual(files, self.recording())
        for f in result.files:
            self.assertEqual(f.sha256, hashlib.sha256(f.content).hexdigest())
        self.assertNotIn('MUST NEVER EXECUTE', repr(result))

    def refused(self, files=None, code=None, **kw):
        with self.assertRaises(module.CompileError) as caught:
            self.run_compile(files, **kw)
        if code is not None:
            self.assertEqual(caught.exception.code, code)
        self.assertIsNone(caught.exception.__cause__)
        self.assertIsNone(caught.exception.__context__)
        self.assertNotIn('PRIVATE_CANARY', repr(caught.exception))
        return caught.exception

    def test_windows_surface_is_native_bound_and_still_requires_test(self):
        with patch.object(self, 'load_workflow', return_value=SimpleNamespace(
                steps=[object()], surface='windows')):
            result = self.run_compile(target_surface='windows')
        native = next(call[1] for call in self.calls
                      if type(call) is tuple and call[0] == 'compile')
        self.assertEqual(native['target_surface'], 'windows')
        self.assertEqual(result.status, 'to_test')
        self.assertEqual(list(Path(self.root.name).iterdir()), [])

    def test_requested_windows_surface_requires_matching_native_readback(self):
        for surface in (None, 'web'):
            with self.subTest(surface=surface), patch.object(module, '_claimed', False):
                with patch.object(self, 'load_workflow', return_value=SimpleNamespace(
                        steps=[object()], surface=surface)):
                    self.refused(code='invalid_output', target_surface='windows')
                self.assertEqual(list(Path(self.root.name).iterdir()), [])

    def test_invalid_target_surface_refuses_before_io_or_runtime_claim(self):
        for surface in ('web', '', True, 1, [], {'surface': 'windows'}):
            with self.subTest(surface=surface):
                self.refused(code='invalid_request', target_surface=surface)
                self.assertEqual(self.calls, [])
                self.assertFalse(module._claimed)
                self.assertEqual(list(Path(self.root.name).iterdir()), [])

    def test_input_aliases_and_windows_names_refuse_before_io(self):
        paths = ('/absolute', '../parent', 'a/../b', 'a\\b', 'C:stream', 'file:stream',
                 'a//b', '.', 'a/.', 'x.', 'x ', 'NUL.txt', 'CON', 'COM1', 'LPT9.log',
                 'CONIN$', 'CONOUT$', 'a\x00x', 'a\nx', 'é.png', 'a?b', 'a*b',
                 'PROGRA~1/x', 'NUL .txt', 'a/' * 9 + 'b', 'x' * 129)
        for path in paths:
            with self.subTest(path=path):
                files = self.recording() | {path: b'PRIVATE_CANARY'}
                self.refused(files, 'invalid_path')
                self.assertEqual(self.calls, [])
                self.assertEqual(list(Path(self.root.name).iterdir()), [])
        for extras in ({'FRAMES/x': b'', 'frames/y': b''}, {'a': b'', 'a/b': b''},
                       {'META.JSON': b''}):
            with self.subTest(extras=extras):
                self.refused(self.recording() | extras, 'invalid_path')

    def test_approval_evidence_is_refused_instead_of_discarded(self):
        for name in ('.openadapt-approval.json', '.openadapt-sanitization.json',
                     'raw.approved.zip', 'FRAMES/RAW.APPROVED.ZIP'):
            with self.subTest(name=name):
                files = self.recording() | {name: b'PRIVATE_CANARY'}
                self.refused(files, 'approved_recording_unsupported')
                self.assertEqual(files[name], b'PRIVATE_CANARY')
                self.assertEqual(self.calls, [])

    def test_exact_immutable_input_and_required_flow_files(self):
        class DictSubclass(dict):
            pass
        class BytesSubclass(bytes):
            pass
        for files in (DictSubclass(self.recording()), list(self.recording().items()),
                      {'meta.json': b'{}'}, {'meta.json': b'{}', 'EVENTS.JSONL': b''},
                      self.recording() | {'x': bytearray(b'private')},
                      self.recording() | {'x': BytesSubclass(b'private')},
                      self.recording() | {1: b'private'}):
            with self.subTest(kind=type(files).__name__):
                self.refused(files, 'invalid_recording')
                self.assertEqual(self.calls, [])

    def test_admission_caps_precede_runtime_import_and_staging(self):
        cases = [('_FILES', 2, self.recording()),
                 ('_TOTAL', 3, self.recording()),
                 ('_FILE', 4, self.recording()),
                 ('_JSON', 1, self.recording()),
                 ('_EVENTS', 4, self.recording()),
                 ('_LINE', 4, self.recording()),
                 ('_LINES', 0, self.recording())]
        for constant, bound, files in cases:
            with self.subTest(constant=constant), patch.object(module, constant, bound):
                self.refused(files)
                self.assertEqual(self.calls, [])
                self.assertEqual(list(Path(self.root.name).iterdir()), [])

    def test_50_normalized_flow_records_not_raw_mouse_events(self):
        # Count admission only; semantic validation still belongs to the native engine.
        files = self.recording() | {'events.jsonl': b'{}\n' * 51}
        self.refused(files, 'recording_limit')
        self.assertEqual(self.calls, [])
        files['events.jsonl'] = b'{}\n' * 50 + b' \n\n'
        self.expected_files = files.copy()
        self.assertEqual(self.run_compile(files).status, 'to_test')

    def test_worker_environment_is_required_before_any_import(self):
        for key in ('ORT_DISABLE_TELEMETRY', 'OPENADAPT_FLOW_OCR'):
            for value in ('', '0', 'auto', 'PRIVATE_CANARY'):
                with self.subTest(key=key, value=value), patch.dict(os.environ, {key: value}):
                    self.refused(code='fresh_worker_required')
                    self.assertEqual(self.calls, [])

    def test_loaded_runtime_and_second_job_refuse_without_reimport(self):
        for name in ('onnxruntime', 'onnxruntime.capi.test', 'rapidocr_onnxruntime',
                     'openadapt_flow', 'openadapt_flow.compiler.compile'):
            with self.subTest(name=name), patch.dict(sys.modules, {name: SimpleNamespace()}):
                self.refused(code='fresh_worker_required')
        self.run_compile()
        before = list(self.calls)
        self.refused(code='fresh_worker_required')
        self.assertEqual(self.calls, before)

    def test_wrong_thread_refuses_before_import(self):
        errors = []
        def run():
            try:
                self.run_compile()
            except module.CompileError as error:
                errors.append(error.code)
        thread = threading.Thread(target=run)
        thread.start()
        thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertEqual(errors, ['fresh_worker_required'])
        self.assertEqual(self.calls, [])

    def test_wrong_runtime_version_never_loads_onnx(self):
        with patch.object(module.metadata, 'version', return_value='wrong'):
            self.refused(code='runtime_unavailable')
        self.assertEqual(self.calls, [])

    def test_absent_runtime_is_an_explicit_unavailability_before_onnx_import(self):
        with patch.object(module.metadata, 'version',
                          side_effect=module.metadata.PackageNotFoundError('PRIVATE_CANARY')):
            self.refused(code='runtime_unavailable')
        self.assertEqual(self.calls, [])

    def test_import_failure_is_fixed_and_not_retried(self):
        with patch.object(module.importlib, 'import_module', side_effect=OSError('PRIVATE_CANARY')) as port:
            self.refused(code='compile_failed')
        self.assertEqual(port.call_count, 1)
        self.assertEqual(list(Path(self.root.name).iterdir()), [])

    def test_caller_mutation_after_capture_does_not_change_native_inputs(self):
        files = self.recording()
        original = self.import_port
        def mutate(name):
            files.clear()
            files['../unowned'] = b'PRIVATE_CANARY'
            return original(name)
        with patch.object(module.importlib, 'import_module', side_effect=mutate):
            self.run_compile(files)
        self.assertEqual(list(Path(self.root.name).iterdir()), [])

    def test_runtime_exception_and_python_logs_do_not_escape(self):
        import logging
        def fail(*_, **__):
            print('PRIVATE_CANARY')
            print('PRIVATE_CANARY', file=sys.stderr)
            logging.error('PRIVATE_CANARY')
            raise OSError('PRIVATE_CANARY')
        self.engine = fail
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch('sys.stdout', stdout), patch('sys.stderr', stderr):
            error = self.refused(code='compile_failed')
        self.assertEqual(stdout.getvalue() + stderr.getvalue(), '')
        self.assertIn(b'OSError: PRIVATE_CANARY', error.private_diagnostic)
        self.assertIs(error.private_diagnostic_complete, True)
        self.assertEqual(list(Path(self.root.name).iterdir()), [])

    def test_native_error_diagnostic_is_bounded_private_and_excludes_locals(self):
        def fail(*_, **__):
            local_only = 'LOCAL_ONLY_CANARY'
            raise OSError('PRIVATE_CANARY' + 'x' * 100000)
        self.engine = fail
        error = self.refused(code='compile_failed')
        self.assertEqual(len(error.private_diagnostic), 65536)
        self.assertIs(error.private_diagnostic_complete, False)
        self.assertNotIn(b'LOCAL_ONLY_CANARY', error.private_diagnostic)

    def check_logging_after_compile(self, fails):
        import logging

        def noisy_engine(*args, **kwargs):
            logging.error('PRIVATE_CANARY')
            if fails:
                raise OSError('PRIVATE_CANARY')
            return self.compile_engine(*args, **kwargs)

        self.engine = noisy_engine
        output = io.StringIO()
        # Isolate this test's root configuration, including implicit basicConfig.
        # Existing caller handlers must neither be closed nor changed by the test.
        with patch.object(logging.root, 'handlers', []):
            try:
                if fails:
                    self.refused(code='compile_failed')
                else:
                    self.run_compile()
                logging.basicConfig(stream=output)
                logging.warning('after_compile')
                self.assertEqual(output.getvalue(), 'WARNING:root:after_compile\n')
            finally:
                for handler in list(logging.root.handlers):
                    logging.root.removeHandler(handler)
                    handler.close()

    def test_successful_compile_does_not_leave_diagnostics_on_closed_stream(self):
        self.check_logging_after_compile(False)

    def test_failed_compile_does_not_leave_diagnostics_on_closed_stream(self):
        self.check_logging_after_compile(True)

    def test_cancellation_before_compile_and_after_engine_refuses_delivery(self):
        event = threading.Event()
        event.set()
        self.refused(code='compile_cancelled', cancel=event)
        self.assertEqual(self.calls, [])
        event.clear()
        def cancel_after(*a, **kw):
            result = self.compile_engine(*a, **kw)
            event.set()
            return result
        self.engine = cancel_after
        self.refused(code='compile_cancelled', cancel=event)
        self.assertEqual(list(Path(self.root.name).iterdir()), [])

    def test_cleanup_is_before_deadline_delivery(self):
        clock = [1.0]
        original = module.tempfile.TemporaryDirectory.cleanup
        def late(directory):
            original(directory)
            clock[0] = 100.0
        with patch.object(module.time, 'monotonic', side_effect=lambda: clock[0]), \
                patch.object(module.tempfile.TemporaryDirectory, 'cleanup', late):
            self.refused(code='compile_timeout')
        self.assertEqual(list(Path(self.root.name).iterdir()), [])

    def test_cleanup_failure_is_fixed_without_returning_bundle(self):
        original = module.tempfile.TemporaryDirectory.cleanup
        def fail(directory):
            original(directory)
            raise OSError('PRIVATE_CANARY')
        with patch.object(module.tempfile.TemporaryDirectory, 'cleanup', fail):
            self.refused(code='compile_cleanup_failed')
        self.assertEqual(list(Path(self.root.name).iterdir()), [])

    def test_keyboard_interrupt_cleans_owned_workspace(self):
        def interrupt(*a, **kw):
            raise KeyboardInterrupt
        self.engine = interrupt
        with self.assertRaises(KeyboardInterrupt):
            self.run_compile()
        self.assertEqual(list(Path(self.root.name).iterdir()), [])

    def test_invalid_request_and_nonfinite_deadlines_refuse(self):
        for deadline in (None, True, float('nan'), float('inf'), 10 ** 1000):
            with self.subTest(deadline_type=type(deadline).__name__):
                with self.assertRaises(module.CompileError) as caught:
                    module.compile_raw_recording(self.recording(), name='valid', deadline_monotonic=deadline)
                self.assertEqual(caught.exception.code, 'invalid_request')
        self.assertEqual(self.calls, [])

    def test_replaced_output_root_is_refused(self):
        outside = Path(self.root.name) / 'outside'
        outside.mkdir()
        for name in ('workflow.json', 'manifest.json', 'workflow.py'):
            (outside / name).write_bytes(b'PRIVATE_CANARY')
        def replace_root(recording, bundle, **kwargs):
            bundle.rmdir()
            bundle.symlink_to(outside, target_is_directory=True)
            return SimpleNamespace(manifest=SimpleNamespace(file_hashes={}))
        self.engine = replace_root
        self.refused(code='invalid_output')
        self.assertEqual((outside / 'workflow.json').read_bytes(), b'PRIVATE_CANARY')

    def test_post_validation_mutation_does_not_deliver_a_different_snapshot(self):
        original = self.load_workflow
        def mutate(bundle, **kwargs):
            loaded = original(bundle, **kwargs)
            (bundle / 'workflow.json').write_bytes(b'PRIVATE_CANARY')
            return loaded
        with patch.object(self, 'load_workflow', side_effect=mutate):
            self.refused(code='invalid_output')

    def test_final_checkpoint_errors_have_no_native_context(self):
        closed = [False]
        original = module.tempfile.TemporaryDirectory.cleanup
        def cleanup(directory):
            original(directory)
            closed[0] = True
        clock = time.monotonic
        def fail_after_cleanup():
            if closed[0]:
                raise OSError('PRIVATE_CANARY')
            return clock()
        with patch.object(module.tempfile.TemporaryDirectory, 'cleanup', cleanup), \
                patch.object(module.time, 'monotonic', fail_after_cleanup):
            self.refused(code='compile_failed')

    def test_output_symlink_hardlink_and_special_file_refuse_before_native_load(self):
        outside = Path(self.root.name) / 'outside'
        outside.write_bytes(b'private')
        for kind in ('symlink', 'hardlink', 'fifo'):
            with self.subTest(kind=kind), patch.object(module, '_claimed', False):
                def malicious(*a, **kw):
                    result = self.compile_engine(*a, **kw)
                    target = a[1] / 'bad'
                    if kind == 'symlink':
                        target.symlink_to(outside)
                    elif kind == 'hardlink':
                        os.link(outside, target)
                    else:
                        os.mkfifo(target)
                    return result
                self.engine = malicious
                self.refused(code='invalid_output')
                self.assertFalse(any(isinstance(v, tuple) and v[0] == 'load' for v in self.calls))
        self.assertEqual(outside.read_bytes(), b'private')

    def test_asset_escape_or_absence_refuses_before_native_load(self):
        for asset in ('../outside', '/absolute', 'missing.png', 'C:stream'):
            with self.subTest(asset=asset), patch.object(module, '_claimed', False):
                def malformed(*a, **kw):
                    result = self.compile_engine(*a, **kw)
                    result.manifest.file_hashes = {asset: '0' * 64}
                    return result
                self.engine = malformed
                self.refused()
                self.assertFalse(any(isinstance(v, tuple) and v[0] == 'load' for v in self.calls))

    def test_output_limit_and_unexpected_annotations_never_deliver(self):
        def unexpected(*a, **kw):
            result = self.compile_engine(*a, **kw)
            (a[1] / 'annotations.json').write_bytes(b'PRIVATE_CANARY')
            return result
        self.engine = unexpected
        self.refused(code='invalid_output')

    def test_output_byte_and_count_caps_act_on_generated_files(self):
        for constant, bound, additions in (
                ('_FILE', 100, {'extra': b'x' * 101}),
                ('_TOTAL', 100, {'extra': b'x' * 100}),
                ('_FILES', 4, {'extra-a': b'', 'extra-b': b''})):
            with self.subTest(constant=constant), patch.object(module, '_claimed', False), \
                    patch.object(module, constant, bound):
                def too_large(*a, **kw):
                    result = self.compile_engine(*a, **kw)
                    for name, data in additions.items():
                        (a[1] / name).write_bytes(data)
                    return result
                self.engine = too_large
                self.refused(code='output_limit')
        self.assertEqual(list(Path(self.root.name).iterdir()), [])

    def test_output_case_collisions_and_missing_native_files_refuse(self):
        for kind in ('case', 'missing', 'manifest'):
            with self.subTest(kind=kind), patch.object(module, '_claimed', False):
                if kind == 'case':
                    probe = Path(self.root.name) / 'case-probe'
                    probe.write_bytes(b'')
                    case_sensitive = not (Path(self.root.name) / 'CASE-PROBE').exists()
                    probe.unlink()
                    if not case_sensitive:
                        self.skipTest('Native output case collision requires a case-sensitive filesystem')
                def malformed(*a, **kw):
                    result = self.compile_engine(*a, **kw)
                    if kind == 'case':
                        (a[1] / 'WORKFLOW.JSON').write_bytes(b'PRIVATE_CANARY')
                    elif kind == 'missing':
                        (a[1] / 'workflow.py').unlink()
                    else:
                        result.manifest = None
                    return result
                self.engine = malformed
                self.refused()

    def test_cancellation_during_native_validation_never_delivers(self):
        event = threading.Event()
        original = self.load_workflow
        def cancel(bundle, **kw):
            result = original(bundle, **kw)
            event.set()
            return result
        with patch.object(self, 'load_workflow', side_effect=cancel):
            self.refused(cancel=event, code='compile_cancelled')
        self.assertEqual(list(Path(self.root.name).iterdir()), [])

    def test_native_validation_cannot_inflate_step_count(self):
        with patch.object(self, 'load_workflow', return_value=SimpleNamespace(steps=[None] * 51)):
            self.refused(code='output_limit')

    def test_source_hash_is_order_independent_but_byte_bound(self):
        files = self.recording()
        first = self.run_compile(files)
        with patch.object(module, '_claimed', False):
            self.assertEqual(self.run_compile(dict(reversed(list(files.items())))).source_sha256,
                             first.source_sha256)
        files['safe-sidecar.json'] = b'PRIVATE_CANARY'
        self.expected_files = files.copy()
        with patch.object(module, '_claimed', False):
            self.assertNotEqual(self.run_compile(files).source_sha256, first.source_sha256)

    def test_native_load_failure_is_not_reported_as_ready(self):
        with patch.object(self, 'load_workflow', side_effect=ValueError('PRIVATE_CANARY')):
            self.refused(code='compile_failed')

    def test_real_pillow_checks_png_pixels_and_rejects_invalid_png_before_engine(self):
        from PIL import Image
        png = io.BytesIO()
        Image.new('RGB', (3, 2), 'white').save(png, format='PNG')
        files = self.recording() | {'frames/0000_before.png': png.getvalue()}
        with patch.object(module, '_PIXELS', 5):
            self.refused(files, 'invalid_image')
        self.assertEqual(self.calls, [])
        with patch.object(module, '_claimed', False):
            self.refused(self.recording() | {'frames/0000_before.png': b'PRIVATE_CANARY'})
        self.assertEqual(self.calls, [])
        with patch.object(module, '_claimed', False):
            self.expected_files = files.copy()
            self.assertEqual(self.run_compile(files).status, 'to_test')


class OutputStatTests(unittest.TestCase):
    """Real files/descriptors, with explicit Windows metadata-view doubles on POSIX."""

    def setUp(self):
        self.root = tempfile.TemporaryDirectory(prefix='memlia-output-stat-')
        self.addCleanup(self.root.cleanup)
        self.bundle = Path(self.root.name)
        for name, content in (('workflow.json', b'json'), ('manifest.json', b'manifest'),
                              ('workflow.py', b'opaque-not-executed')):
            (self.bundle / name).write_bytes(content)

    @contextmanager
    def views(self, *, windows=True, zero_direntry=False, ctime_difference=False,
              change_fd=None, change_path=None, birthtime=123456789):
        native = os
        port = SimpleNamespace(**vars(native))  # Does not mutate global os/pathlib.
        port.name = 'nt' if windows else 'posix'
        counts = {'fd': 0, 'path': 0}

        def view(info, kind):
            value = SimpleNamespace(**{key: getattr(info, key) for key in (
                'st_dev', 'st_ino', 'st_nlink', 'st_size', 'st_mode', 'st_mtime_ns', 'st_ctime_ns')})
            value.st_file_attributes = 0
            if windows:
                value.st_birthtime_ns = birthtime
            if ctime_difference and kind == 'fd':
                value.st_ctime_ns += 1_000_000
            return value

        def by_path(path, *, follow_symlinks=True):
            value = view(native.stat(path, follow_symlinks=follow_symlinks), 'path')
            counts['path'] += 1
            if change_path:
                change_path(value, counts['path'])
            return value

        def by_fd(descriptor):
            value = view(native.fstat(descriptor), 'fd')
            counts['fd'] += 1
            if change_fd:
                change_fd(value, counts['fd'])
            return value

        @contextmanager
        def scanned(directory):
            with native.scandir(directory) as entries:
                def converted():
                    for entry in entries:
                        def entry_stat(*, follow_symlinks=True, entry=entry):
                            value = view(entry.stat(follow_symlinks=follow_symlinks), 'path')
                            if zero_direntry:
                                value.st_dev = value.st_ino = value.st_nlink = 0
                            return value
                        yield SimpleNamespace(path=entry.path, stat=entry_stat)
                yield converted()

        port.scandir, port.stat, port.fstat = scanned, by_path, by_fd
        with patch.object(module, 'os', port):
            yield port

    def output_refused(self):
        with self.assertRaises(module.CompileError) as caught:
            module._output(self.bundle)
        self.assertEqual(caught.exception.code, 'invalid_output')

    def output_accepted(self):
        try:
            result = module._output(self.bundle)
        except module.CompileError as error:
            self.fail(f'Compatible real-file views were rejected: {error.code}')
        self.assertEqual(dict(result), {'workflow.json': b'json', 'manifest.json': b'manifest',
                                        'workflow.py': b'opaque-not-executed'})

    def test_windows_zero_direntry_identity_requires_real_nonfollowed_stat(self):
        with self.views(zero_direntry=True):
            self.output_accepted()

    def test_windows_cross_view_ctime_difference_can_preserve_opaque_output(self):
        with self.views(ctime_difference=True):
            self.output_accepted()

    def test_windows_birthtime_is_a_required_positive_integer(self):
        for value in (None, 0, -1, True, 1.5):
            with self.subTest(value=value), self.views(birthtime=value):
                self.output_refused()
        def absent(info, count):
            if count == 1:
                del info.st_birthtime_ns
        with self.views(change_fd=absent):
            self.output_refused()

    def test_windows_cross_view_identity_fields_must_match(self):
        for field in ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_nlink', 'st_birthtime_ns'):
            def change(info, count, field=field):
                if count == 1:
                    setattr(info, field, getattr(info, field) + 1)
            with self.subTest(field=field), self.views(change_fd=change):
                self.output_refused()

    def test_windows_fd_ctime_change_alone_is_not_masked_by_constant_birthtime(self):
        def change(info, count):
            if count == 2:
                info.st_ctime_ns += 1
        with self.views(change_fd=change):
            self.output_refused()

    def test_windows_path_ctime_change_after_read_is_not_masked_by_birthtime(self):
        def change(info, count):
            if count == 2:
                info.st_ctime_ns += 1
        with self.views(change_path=change):
            self.output_refused()

    def test_windows_fd_birthtime_change_after_read_is_refused(self):
        def change(info, count):
            if count == 2:
                info.st_birthtime_ns += 1
        with self.views(change_fd=change):
            self.output_refused()

    def test_windows_postread_path_changes_never_deliver_the_old_descriptor_bytes(self):
        for field in ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_birthtime_ns', 'st_nlink'):
            def change(info, count, field=field):
                if count == 2:
                    setattr(info, field, getattr(info, field) + 1)
            with self.subTest(field=field), self.views(change_path=change):
                self.output_refused()

    def test_postread_link_count_and_reparse_or_symlink_are_refused(self):
        for field, value in (('st_nlink', 0), ('st_nlink', 2),
                             ('st_file_attributes', stat.FILE_ATTRIBUTE_REPARSE_POINT),
                             ('st_mode', stat.S_IFLNK | 0o600)):
            def change(info, count, field=field, value=value):
                if count == 2:
                    setattr(info, field, value)
            with self.subTest(field=field, value=value), self.views(change_path=change):
                self.output_refused()

    def test_posix_cross_view_ctime_difference_still_refuses(self):
        with self.views(windows=False, ctime_difference=True):
            self.output_refused()

    def test_posix_fd_ctime_only_change_still_refuses(self):
        def change(info, count):
            if count == 2:
                info.st_ctime_ns += 1
        with self.views(windows=False, change_fd=change):
            self.output_refused()

    def test_real_postread_path_replacement_refuses_even_when_fd_snapshot_is_unchanged(self):
        replacement_root = tempfile.TemporaryDirectory(prefix='memlia-replacement-')
        self.addCleanup(replacement_root.cleanup)
        with self.views(windows=False) as port:
            opening, fstat = port.open, port.fstat
            active = {}
            def owned_open(path, *args):
                active['path'] = Path(path)
                return opening(path, *args)
            count = 0
            def after_snapshot(descriptor):
                nonlocal count
                value = fstat(descriptor)
                count += 1
                if count == 2:
                    replacement = Path(replacement_root.name) / 'replacement'
                    replacement.write_bytes(active['path'].read_bytes())
                    os.replace(replacement, active['path'])
                return value
            port.open, port.fstat = owned_open, after_snapshot
            self.output_refused()


if __name__ == '__main__':
    unittest.main()
