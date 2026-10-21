# Copyright (c) 2026 Memlia. All rights reserved.
"""Source-time policy mechanics, fake Win32 metadata; no consent or OS hooks."""
import importlib.util
import hashlib
import pickle
import sys
import tempfile
from pathlib import Path
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from memlia_agent.session import SessionObservation


SID = 'S-1-5-21-100-200-300-1001'  # Fictitious, never resolved against Windows.
DIGEST = 'sha256:' + 'a' * 64


class _NativeFixture:
    """Read-only Windows metadata doubled; it cannot create a local decision."""
    def __init__(self):
        self.current = SessionObservation(SID, 7, 1)
        self.birth, self.session, self.alive = 50000, 7, True
        self.ui_window = (100, 123, 17)
        self.target = (200, 456, 18)
        self.emergency, self.calls = False, []

    def current_session(self):
        self.calls.append('session')
        return self.current

    def process_info(self, pid):
        self.calls.append(('process', pid))
        return self.birth, self.session, self.alive

    def window_info(self, hwnd):
        self.calls.append(('window', hwnd))
        return self.ui_window if hwnd == 100 else self.target

    def window_at(self, x, y):
        self.calls.append(('point', x, y))
        return self.target[0]

    def foreground(self):
        self.calls.append('foreground')
        return self.target[0]

    def emergency_down(self):
        self.calls.append('emergency')
        return self.emergency


class CaptureInputFilterTests(unittest.TestCase):
    def module(self):
        self.assertIsNotNone(importlib.util.find_spec('memlia_agent.capture_input_filter'),
                             'the source-time Windows adapter is missing')
        return __import__('memlia_agent.capture_input_filter', fromlist=['CaptureInputFactory'])

    def values(self, **replace):
        values = dict(ui_pid=123, ui_birth=50000, ui_hwnd=100, ui_thread=17,
                      windows_sid=SID, session_id=7, operation_digest=DIGEST,
                      deadline_monotonic=time.monotonic() + 30)
        values.update(replace)
        return values

    def policy(self):
        module, native = self.module(), _NativeFixture()
        return module, module._InputPolicy(module.CaptureInputFactory(**self.values()), native), native

    def key(self, policy, vk=65, pressed=True):
        return policy.keyboard(pressed=pressed, vk_code=vk, scan_code=1, flags=0)

    def mouse(self, policy, message=0x201):
        return policy.mouse(message=message, x=10, y=20, mouse_data=0, flags=0)

    def assert_fixed(self, module, operation):
        with self.assertRaises(module.InputFilterUnavailable) as caught:
            operation()
        self.assertEqual(str(caught.exception), 'capture_input_filter_unavailable')
        self.assertIsNone(caught.exception.__cause__)
        self.assertIsNone(caught.exception.__context__)

    def test_factory_is_an_immutable_module_reference_with_scalar_fields_and_no_engine_import(self):
        module = self.module()
        before = {n for n in sys.modules if n.startswith(('openadapt_capture', 'openadapt_flow', 'onnxruntime'))}
        factory = module.CaptureInputFactory(**self.values())
        copied = pickle.loads(pickle.dumps(factory))
        self.assertEqual(factory, copied)
        self.assertIs(type(copied), module.CaptureInputFactory)
        self.assertTrue(all(type(v) in (int, float, str) for v in vars(factory).values()))
        with self.assertRaises(AttributeError):
            copied.ui_pid = 999
        self.assertEqual(before, {n for n in sys.modules if n.startswith(
            ('openadapt_capture', 'openadapt_flow', 'onnxruntime'))})

    def test_profile_bounds_unknown_fields_and_deserialized_mutations_fail_closed(self):
        module = self.module()
        for name in ('ui_pid', 'ui_birth', 'ui_hwnd', 'ui_thread', 'session_id'):
            for value in (True, 0, -1, '123', 2**65):
                with self.subTest(name=name, value=value):
                    self.assert_fixed(module, lambda: module.CaptureInputFactory(**self.values(**{name: value})))
        for replace in (dict(operation_digest=DIGEST + '\n'), dict(windows_sid='unknown'),
                        dict(deadline_monotonic=float('inf')), dict(deadline_monotonic=True)):
            self.assert_fixed(module, lambda: module.CaptureInputFactory(**self.values(**replace)))
        with self.assertRaises(TypeError):
            module.CaptureInputFactory(**self.values(), accept=True)
        factory = module.CaptureInputFactory(**self.values())
        object.__setattr__(factory, 'ui_pid', True)  # Malformed deserialization, not a permission.
        self.assert_fixed(module, lambda: factory(lambda e: None, observe_keyboard=True,
                           observe_mouse=True, capture_mouse_moves=True))

    def test_fake_controls_cannot_supply_local_approval_or_a_binding(self):
        module = self.module()
        with patch.object(module, '_Windows') as native:
            self.assert_fixed(module, lambda: module.CaptureInputFactory.from_controls(
                SimpleNamespace(accept=True), operation_digest=DIGEST))
            native.assert_not_called()

    def test_worker_rechecks_process_birth_session_window_and_deadline_before_retention(self):
        mutations = [lambda n: setattr(n, 'birth', n.birth + 1),
                     lambda n: setattr(n, 'session', 8),
                     lambda n: setattr(n, 'alive', False),
                     lambda n: setattr(n, 'current', SessionObservation(SID, 8, 1)),
                     lambda n: setattr(n, 'current', SessionObservation(SID + '-2', 7, 1)),
                     lambda n: setattr(n, 'ui_window', (100, 999, 17)),
                     lambda n: setattr(n, 'ui_window', (100, 123, 99)),
                     lambda n: setattr(n, 'ui_window', (0, 123, 17))]
        for mutate in mutations:
            module, policy, native = self.policy()
            mutate(native)
            self.assert_fixed(module, lambda: self.key(policy))
        module, policy, native = self.policy()
        with patch.object(module.time, 'monotonic', return_value=policy.binding.deadline_monotonic + 1):
            self.assert_fixed(module, lambda: self.mouse(policy))

    def test_owned_window_and_same_process_events_are_suppressed_with_paired_release_after_focus_change(self):
        module, policy, native = self.policy()
        native.target = (300, 123, 19)  # Another child/window of the exact UI process.
        self.assertFalse(self.key(policy))
        self.assertFalse(self.mouse(policy))
        native.target = (200, 456, 18)
        self.assertFalse(self.key(policy, pressed=False))
        self.assertFalse(self.mouse(policy, 0x202))
        self.assertTrue(self.key(policy, 66))
        self.assertTrue(self.mouse(policy))

    def test_crossing_from_a_retained_press_into_memlia_refuses_the_whole_recording(self):
        for kind in ('keyboard', 'mouse'):
            module, policy, native = self.policy()
            self.assertTrue(self.key(policy) if kind == 'keyboard' else self.mouse(policy))
            native.target = (100, 123, 17)
            self.assert_fixed(module, lambda: self.key(policy, pressed=False) if kind == 'keyboard'
                              else self.mouse(policy, 0x202))

    def test_command_chord_is_a_refusal_not_a_posthoc_truncation_or_normal_finish(self):
        module, policy, native = self.policy()
        native.emergency = True
        self.assert_fixed(module, lambda: self.key(policy, 0x7A))  # F11, OS modifiers doubled.
        self.assertEqual(policy._keys, {})

    def test_unknown_command_key_state_cannot_be_treated_as_not_pressed(self):
        module, policy, native = self.policy()
        native.emergency = None
        self.assert_fixed(module, lambda: self.key(policy, 0x7A))

    def test_factory_checks_the_current_binding_and_uses_only_the_native_filtered_subclass(self):
        module, native = self.module(), _NativeFixture()
        calls = []
        class Observer:
            def __init__(self, callback, **options):
                calls.append(options)
            @staticmethod
            def _physical_vk(transition):
                return transition.vk_code
        factory = module.CaptureInputFactory(**self.values())
        with patch.object(module, '_Windows', return_value=native), \
                patch.object(module, '_observer_runtime', return_value=Observer):
            observer = factory(lambda event: None, observe_keyboard=True,
                               observe_mouse=True, capture_mouse_moves=True)
            self.assertIsInstance(observer, Observer)
            self.assertTrue(observer._retain_keyboard(pressed=True, vk_code=65, scan_code=1, flags=0))
            native.target = (100, 123, 17)
            self.assertFalse(observer._retain_mouse(message=0x201, x=10, y=20, mouse_data=0, flags=0))
        self.assertEqual(calls, [dict(observe_keyboard=True, observe_mouse=True, capture_mouse_moves=True)])

    def test_filter_reuses_the_native_physical_key_mapper_before_pairing(self):
        module = self.module()
        calls = []
        observer = SimpleNamespace(_physical_vk=lambda transition: 0xA1,
            _memlia_policy=SimpleNamespace(keyboard=lambda **event: calls.append(event) or True))
        self.assertTrue(module._retain_keyboard(observer, pressed=True, vk_code=0x10,
                                               scan_code=0x36, flags=0))
        self.assertEqual(calls, [dict(pressed=True, vk_code=0xA1, scan_code=0x36, flags=0)])

    def test_readonly_process_handle_is_closed_for_success_and_failed_queries(self):
        module = self.module()
        for failure in (None, 'times', 'wait', 'close'):
            with self.subTest(failure=failure):
                closed, opened = [], []
                native = module._Windows.__new__(module._Windows)
                native._open = lambda *args: opened.append(args) or 777
                def times(handle, creation, end, kernel, user):
                    creation._obj.low, creation._obj.high = 5, 1
                    return failure != 'times'
                native._times = times
                native._session = lambda pid, out: setattr(out._obj, 'value', 7) or 1
                native._wait = lambda *args: 0xFFFFFFFF if failure == 'wait' else 258
                native._close = lambda handle: closed.append(handle) or failure != 'close'
                if failure is None:
                    self.assertEqual(native.process_info(123), (2**32 + 5, 7, True))
                else:
                    with self.assertRaises(module.InputFilterUnavailable):
                        native.process_info(123)
                self.assertEqual(opened, [(0x101000, False, 123)])
                self.assertEqual(closed, [777])

    def test_original_version_or_source_hash_drift_refuses_before_observer_import_without_fallback(self):
        module = self.module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pins = {}
            for name in ('recorder.py', 'windows.py'):
                content = ('fictitious module ' + name).encode()
                (root / name).write_bytes(content)
                pins[name] = (len(content), hashlib.sha256(content).hexdigest())
            distribution = SimpleNamespace(version='1.3.0', locate_file=lambda name: root / name)
            with patch.object(module.metadata, 'distribution', return_value=distribution), \
                    patch.object(module, '_SOURCE_FILES', pins), patch.object(module, 'import_module') as imported:
                self.assert_fixed(module, module._observer_runtime)
                imported.assert_not_called()
                distribution.version = '1.3.0+memlia.1'
                (root / 'windows.py').write_bytes(b'PRIVATE_CANARY')
                self.assert_fixed(module, module._observer_runtime)
                imported.assert_not_called()

    def test_exact_source_bytes_and_local_version_are_required_before_loading_the_base(self):
        module = self.module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pins = {}
            for name in ('recorder.py', 'windows.py'):
                data = ('fictitious module ' + name).encode()
                (root / name).write_bytes(data)
                pins[name] = (len(data), hashlib.sha256(data).hexdigest())
            base = SimpleNamespace(_retain_keyboard=lambda: True, _retain_mouse=lambda: True)
            distribution = SimpleNamespace(version='1.3.0+memlia.1', locate_file=lambda name: root / name)
            with patch.object(module.metadata, 'distribution', return_value=distribution), \
                    patch.object(module, '_SOURCE_FILES', pins), \
                    patch.object(module, 'import_module', return_value=SimpleNamespace(WindowsInputObserver=base)):
                self.assertIs(module._observer_runtime(), base)

    def test_unknown_window_native_failure_and_orphan_business_release_never_default_to_retain(self):
        module, policy, native = self.policy()
        native.target = (0, 0, 0)
        self.assert_fixed(module, lambda: self.key(policy))
        module, policy, native = self.policy()
        def refused(*args):
            raise OSError('PRIVATE_CANARY')
        native.window_at = refused
        self.assert_fixed(module, lambda: self.mouse(policy))
        module, policy, native = self.policy()
        self.assert_fixed(module, lambda: self.mouse(policy, 0x202))
        self.assert_fixed(module, lambda: self.key(policy, pressed=False))

    def test_foreign_callback_thread_cannot_borrow_state_or_query_the_desktop(self):
        module, policy, native = self.policy()
        self.assertTrue(self.key(policy))
        before, codes = len(native.calls), []
        def foreign():
            try:
                self.mouse(policy)
            except module.InputFilterUnavailable as error:
                codes.append(error.code)
        worker = threading.Thread(target=foreign)
        worker.start()
        worker.join(1)
        self.assertFalse(worker.is_alive())
        self.assertEqual(codes, ['capture_input_filter_unavailable'])
        self.assertEqual(len(native.calls), before)

    def test_late_loss_during_native_observation_refuses_before_decision(self):
        module, policy, native = self.policy()
        def changed(*args):
            native.birth += 1
            return 200
        native.window_at = changed
        self.assert_fixed(module, lambda: self.mouse(policy))

    def test_late_final_window_or_command_query_never_delivers_a_retention_decision(self):
        for kind in ('window', 'command'):
            module, policy, native = self.policy()
            clock = [time.monotonic()]
            if kind == 'window':
                original = native.window_info
                calls = [0]
                def late_window(hwnd):
                    result = original(hwnd)
                    if hwnd == 200:
                        calls[0] += 1
                        if calls[0] == 2:
                            clock[0] = policy.binding.deadline_monotonic + 1
                    return result
                native.window_info = late_window
            else:
                def late_command():
                    clock[0] = policy.binding.deadline_monotonic + 1
                    return False
                native.emergency_down = late_command
            with patch.object(module.time, 'monotonic', side_effect=lambda: clock[0]):
                self.assert_fixed(module, lambda: self.mouse(policy) if kind == 'window'
                                  else self.key(policy, 0x7A))


if __name__ == '__main__':
    unittest.main()
