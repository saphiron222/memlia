"""Threads et réservation réels ; API Win32 doublée, sans qualification Windows."""

import queue
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from memlia_agent import resources, stop
from memlia_agent.session import SessionObservation, SessionUnavailable

OBSERVATION = SessionObservation('S-1-5-21-111-222-333-1001', 1, 1)


class FakeMutex:
    def create(self):
        return 123

    def wait(self, handle):
        return 0

    def release(self, handle):
        pass

    def close(self, handle):
        pass


class FakeHotkey:
    def __init__(self):
        self.messages = queue.Queue()
        self.calls = []
        self.polled = threading.Event()
        self.register_error = None
        self.poll_error = None
        self.unregister_error = None
        self.register_gate = None
        self.unregister_gate = None

    def register(self):
        self.calls.append(('register', threading.get_native_id()))
        if self.register_gate is not None:
            self.register_gate.wait(2)
        if self.register_error:
            raise self.register_error

    def poll(self):
        self.polled.set()
        if self.poll_error:
            raise self.poll_error
        try:
            return self.messages.get_nowait()
        except queue.Empty:
            return None

    def unregister(self):
        self.calls.append(('unregister', threading.get_native_id()))
        if self.unregister_gate is not None:
            self.unregister_gate.wait(2)
        if self.unregister_error:
            raise self.unregister_error


class StopTests(unittest.TestCase):
    def setUp(self):
        self.native = FakeHotkey()
        self.patches = [
            patch.object(resources, 'observe_session', return_value=OBSERVATION),
            patch.object(resources, '_Mutex', return_value=FakeMutex()),
            patch.object(stop, 'observe_session', return_value=OBSERVATION),
            patch.object(stop, '_Hotkey', return_value=self.native),
        ]
        self.mocks = [item.start() for item in self.patches]
        for item in self.patches:
            self.addCleanup(item.stop)

    def arm(self, reservation, seconds=5):
        return stop.arm_local_stop(reservation, deadline_monotonic=time.monotonic() + seconds)

    def wait_stopped(self, signal):
        end = time.monotonic() + 1
        while not signal.stopped and time.monotonic() < end:
            time.sleep(.005)
        self.assertTrue(signal.stopped)

    def assert_fixed(self, caught, code):
        self.assertEqual(caught.exception.code, code)
        self.assertEqual(str(caught.exception), code)
        self.assertNotIn('PRIVATE_CANARY', repr(caught.exception))
        self.assertIsNone(caught.exception.__cause__)
        self.assertIsNone(caught.exception.__context__)

    def test_arm_before_operation_and_same_listener_thread_unregisters(self):
        owner = threading.get_native_id()
        with resources.reserve_desktop() as reservation:
            with self.arm(reservation) as signal:
                signal.checkpoint()
                self.assertFalse(signal.stopped)
                self.assertEqual(self.native.calls[0][0], 'register')
                self.assertNotEqual(self.native.calls[0][1], owner)
            self.assertTrue(signal.stopped)
            signal.close()
        self.assertEqual([x[0] for x in self.native.calls], ['register', 'unregister'])
        self.assertEqual(self.native.calls[0][1], self.native.calls[1][1])

    def test_register_failure_never_yields_or_unregisters_unowned_hotkey(self):
        self.native.register_error = OSError('PRIVATE_CANARY')
        with resources.reserve_desktop() as reservation:
            with self.assertRaises(stop.StopUnavailable) as caught:
                with self.arm(reservation):
                    self.fail('operation must not start')
        self.assert_fixed(caught, 'hotkey_unavailable')
        self.assertEqual([x[0] for x in self.native.calls], ['register'])

    def test_reservation_missing_or_closed_refuses_before_listener(self):
        with self.assertRaises(stop.StopUnavailable) as caught:
            with self.arm(object()):
                self.fail('invalid reservation')
        self.assert_fixed(caught, 'reservation_unavailable')
        with resources.reserve_desktop() as reservation:
            pass
        with self.assertRaises(stop.StopUnavailable) as caught:
            with self.arm(reservation):
                self.fail('closed reservation')
        self.assert_fixed(caught, 'reservation_unavailable')
        self.assertEqual(self.native.calls, [])

    def test_invalid_or_expired_deadline_refuses_before_listener(self):
        with resources.reserve_desktop() as reservation:
            for deadline in (True, None, '10', float('nan'), float('inf'), -1, time.monotonic() - 1):
                with self.subTest(deadline=deadline):
                    with self.assertRaises(stop.StopUnavailable) as caught:
                        with stop.arm_local_stop(reservation, deadline_monotonic=deadline):
                            self.fail('invalid deadline')
                    self.assert_fixed(caught, 'invalid_deadline')
        self.assertEqual(self.native.calls, [])

    def test_unrepresentable_integer_deadline_is_a_fixed_refusal(self):
        with resources.reserve_desktop() as reservation:
            with self.assertRaises(stop.StopUnavailable) as caught:
                with stop.arm_local_stop(reservation, deadline_monotonic=10**10000):
                    self.fail('unrepresentable deadline')
            self.assert_fixed(caught, 'invalid_deadline')
        self.assertEqual(self.native.calls, [])

    def test_worker_session_failure_or_changed_session_refuses_registration(self):
        with resources.reserve_desktop() as reservation:
            for observation in (SessionUnavailable('PRIVATE_CANARY'),
                                SessionObservation(OBSERVATION.windows_sid, 2, 1)):
                with self.subTest(observation=type(observation).__name__):
                    self.mocks[2].side_effect = observation if isinstance(observation, Exception) else None
                    self.mocks[2].return_value = observation
                    with self.assertRaises(stop.StopUnavailable) as caught:
                        with self.arm(reservation):
                            self.fail('unavailable session')
                    self.assert_fixed(caught, 'session_unavailable')
        self.assertEqual(self.native.calls, [])

    def test_request_from_other_thread_is_monotone_before_next_action(self):
        with resources.reserve_desktop() as reservation:
            with self.arm(reservation) as signal:
                worker = threading.Thread(target=signal.request_stop)
                worker.start()
                worker.join(1)
                self.assertFalse(worker.is_alive())
                self.assertTrue(signal.stopped)
                for _ in range(2):
                    with self.assertRaises(stop.StopRequested) as caught:
                        signal.checkpoint()
                    self.assert_fixed(caught, 'stop_requested')
            with self.arm(reservation) as new_signal:
                signal.request_stop()
                self.assertFalse(new_signal.stopped)
                new_signal.checkpoint()

    def test_only_owned_hotkey_message_stops_and_quit_refuses(self):
        with resources.reserve_desktop() as reservation:
            with self.arm(reservation) as signal:
                self.native.messages.put((0x0312, 1, (0x7A << 16) | 7))
                self.native.messages.put((0x0312, 0x4D45, (0x7B << 16) | 7))
                self.native.messages.put((0x0312, 0x4D45, (0x7A << 16) | 2))
                self.native.messages.put((0x0312, 0x4D45, (0x7A << 16) | 7))
                self.wait_stopped(signal)
                with self.assertRaises(stop.StopRequested):
                    signal.checkpoint()
            self.native.messages.put((0x0012, 0, 0))
            with self.assertRaises(stop.StopUnavailable) as caught:
                with self.arm(reservation) as signal:
                    self.wait_stopped(signal)
                    signal.checkpoint()
            self.assert_fixed(caught, 'hotkey_pump_failed')

    def test_foreign_messages_cannot_request_stop(self):
        with resources.reserve_desktop() as reservation:
            with self.arm(reservation) as signal:
                self.native.messages.put((0x0312, 1, (0x7A << 16) | 7))
                self.native.messages.put((0x0312, 0x4D45, (0x7B << 16) | 7))
                self.native.messages.put((0x0312, 0x4D45, (0x7A << 16) | 2))
                end = time.monotonic() + 1
                while not self.native.messages.empty() and time.monotonic() < end:
                    time.sleep(.005)
                self.assertTrue(self.native.messages.empty())
                signal.checkpoint()
                self.assertFalse(signal.stopped)

    def test_deadline_stops_even_without_network_or_messages(self):
        with resources.reserve_desktop() as reservation:
            with self.arm(reservation, seconds=.08) as signal:
                self.wait_stopped(signal)
                with self.assertRaises(stop.StopRequested) as caught:
                    signal.checkpoint()
                self.assert_fixed(caught, 'deadline_expired')

    def test_session_loss_at_checkpoint_stops_and_cleanup_still_runs(self):
        with resources.reserve_desktop() as reservation:
            with self.arm(reservation) as signal:
                self.mocks[0].side_effect = SessionUnavailable('PRIVATE_CANARY')
                with self.assertRaises(stop.StopUnavailable) as caught:
                    signal.checkpoint()
                self.assert_fixed(caught, 'reservation_unavailable')
                self.assertTrue(signal.stopped)
        self.assertEqual(self.native.calls[-1][0], 'unregister')

    def test_cancellation_during_session_observation_is_rechecked(self):
        with resources.reserve_desktop() as reservation:
            with self.arm(reservation) as signal:
                def cancel_and_observe():
                    signal.request_stop()
                    return OBSERVATION
                self.mocks[0].side_effect = cancel_and_observe
                with self.assertRaises(stop.StopRequested) as caught:
                    signal.checkpoint()
                self.assert_fixed(caught, 'stop_requested')

    def test_session_changed_between_registration_and_yield_never_starts(self):
        with resources.reserve_desktop() as reservation:
            self.mocks[0].side_effect = [OBSERVATION, SessionUnavailable('PRIVATE_CANARY')]
            with self.assertRaises(stop.StopUnavailable) as caught:
                with self.arm(reservation):
                    self.fail('session lost before yield')
            self.assert_fixed(caught, 'reservation_unavailable')
        self.assertEqual([x[0] for x in self.native.calls], ['register', 'unregister'])

    def test_pump_failure_after_start_is_fixed_and_stops_before_action(self):
        with resources.reserve_desktop() as reservation:
            with self.arm(reservation) as signal:
                self.native.poll_error = OSError('PRIVATE_CANARY')
                self.wait_stopped(signal)
                with self.assertRaises(stop.StopUnavailable) as caught:
                    signal.checkpoint()
                self.assert_fixed(caught, 'hotkey_pump_failed')

    def test_body_exception_is_preserved_after_confirmed_cleanup(self):
        with resources.reserve_desktop() as reservation:
            with self.assertRaisesRegex(ValueError, '^fictitious$'):
                with self.arm(reservation):
                    raise ValueError('fictitious')
        self.assertEqual([x[0] for x in self.native.calls], ['register', 'unregister'])

    def test_main_interrupt_still_unregisters(self):
        with resources.reserve_desktop() as reservation:
            with self.assertRaises(KeyboardInterrupt):
                with self.arm(reservation):
                    raise KeyboardInterrupt()
        self.assertEqual([x[0] for x in self.native.calls], ['register', 'unregister'])

    def test_interrupt_during_start_does_not_claim_cleanup_without_join(self):
        gate = self.native.unregister_gate = threading.Event()
        started = []
        original_start = threading.Thread.start
        def interrupted_start(thread):
            original_start(thread)
            started.append(thread)
            raise KeyboardInterrupt()
        try:
            with resources.reserve_desktop() as reservation:
                with patch.object(threading.Thread, 'start', side_effect=interrupted_start, autospec=True):
                    with patch.object(stop, '_JOIN_SECONDS', .03):
                        with self.assertRaises(stop.StopUnavailable) as caught:
                            with self.arm(reservation):
                                self.fail('interrupted start never yields')
                self.assertEqual(caught.exception.code, 'hotkey_cleanup_unverified')
        finally:
            gate.set()
            for thread in started:
                thread.join(2)
                self.assertFalse(thread.is_alive())
        self.assertEqual([x[0] for x in self.native.calls], ['register', 'unregister'])

    def test_thread_start_error_is_fixed_before_any_native_call(self):
        with resources.reserve_desktop() as reservation:
            with patch.object(threading.Thread, 'start', side_effect=RuntimeError('PRIVATE_CANARY')):
                with self.assertRaises(stop.StopUnavailable) as caught:
                    with self.arm(reservation):
                        self.fail('thread did not start')
            self.assert_fixed(caught, 'hotkey_start_failed')
        self.assertEqual(self.native.calls, [])

    def test_closed_signal_never_authorizes_another_action(self):
        with resources.reserve_desktop() as reservation:
            with self.arm(reservation) as signal:
                pass
            with self.assertRaises(stop.StopUnavailable) as caught:
                signal.checkpoint()
            self.assert_fixed(caught, 'stop_closed')

    def test_cleanup_failure_is_not_announced_closed_or_retried_elsewhere(self):
        self.native.unregister_error = OSError('PRIVATE_CANARY')
        with resources.reserve_desktop() as reservation:
            with self.assertRaises(stop.StopUnavailable) as caught:
                with self.arm(reservation) as signal:
                    pass
            self.assert_fixed(caught, 'hotkey_cleanup_failed')
            self.assertTrue(signal.stopped)
            with self.assertRaises(stop.StopUnavailable) as caught:
                signal.close()
            self.assert_fixed(caught, 'hotkey_cleanup_failed')
        self.assertEqual([x[0] for x in self.native.calls].count('unregister'), 1)

    def test_foreign_thread_cannot_checkpoint_or_cleanup(self):
        errors = []
        with resources.reserve_desktop() as reservation:
            with self.arm(reservation) as signal:
                def foreign():
                    for operation in (signal.checkpoint, signal.close):
                        try:
                            operation()
                        except stop.StopUnavailable as error:
                            errors.append(error.code)
                worker = threading.Thread(target=foreign)
                worker.start()
                worker.join(1)
                self.assertFalse(worker.is_alive())
                self.assertEqual(errors, ['stop_owner_mismatch', 'stop_owner_mismatch'])
                self.assertTrue(signal.stopped)

    def test_startup_timeout_never_yields_and_delayed_registration_is_cleaned(self):
        gate = self.native.register_gate = threading.Event()
        # La doublure est relâchée explicitement ; aucun thread bloqué abandonné.
        timer = threading.Timer(.08, gate.set)
        timer.start()
        try:
            with patch.object(stop, '_JOIN_SECONDS', .03):
                with resources.reserve_desktop() as reservation:
                    with self.assertRaises(stop.StopUnavailable) as caught:
                        with self.arm(reservation):
                            self.fail('startup timed out')
                    self.assertIn(caught.exception.code, ('hotkey_start_timeout', 'hotkey_cleanup_unverified'))
            gate.set()
            timer.join(1)
        finally:
            gate.set()
            timer.join(1)
        # Réemploi du nettoyage par le même propriétaire après fin confirmée.
        end = time.monotonic() + 1
        while len(self.native.calls) < 2 and time.monotonic() < end:
            time.sleep(.005)
        self.assertEqual([x[0] for x in self.native.calls], ['register', 'unregister'])

    def test_cleanup_timeout_keeps_unverified_until_thread_actually_finishes(self):
        gate = self.native.unregister_gate = threading.Event()
        with resources.reserve_desktop() as reservation:
            signal = None
            try:
                with patch.object(stop, '_JOIN_SECONDS', .03):
                    with self.assertRaises(stop.StopUnavailable) as caught:
                        with self.arm(reservation) as signal:
                            pass
                    self.assert_fixed(caught, 'hotkey_cleanup_unverified')
                    self.assertTrue(signal.stopped)
                    with self.assertRaises(stop.StopUnavailable):
                        signal.checkpoint()
            finally:
                gate.set()
                if signal is not None:
                    signal.close()
        self.assertEqual([x[0] for x in self.native.calls], ['register', 'unregister'])

    def test_dummy_owner_refused_before_start(self):
        dummy = object.__new__(threading._DummyThread)
        with resources.reserve_desktop() as reservation:
            with patch.object(threading, 'current_thread', return_value=dummy):
                with self.assertRaises(stop.StopUnavailable) as caught:
                    with self.arm(reservation):
                        self.fail('unsupported owner')
            self.assert_fixed(caught, 'unsupported_thread')
        self.assertEqual(self.native.calls, [])


class BindingTests(unittest.TestCase):
    def dll(self, register_result=1, unregister_result=1, message=None):
        def peek(pointer, _window, _minimum, _maximum, _remove):
            if message is None:
                return 0
            pointer._obj.message, pointer._obj.wParam, pointer._obj.lParam = message
            return 1
        return SimpleNamespace(RegisterHotKey=unittest.mock.Mock(return_value=register_result),
                               UnregisterHotKey=unittest.mock.Mock(return_value=unregister_result),
                               PeekMessageW=unittest.mock.Mock(side_effect=peek))

    def test_native_calls_use_system_library_fixed_combo_thread_messages_and_no_repeat(self):
        dll = self.dll(message=(0x0312, 0x4D45, (0x7A << 16) | 7))
        with patch.object(stop.ctypes, 'WinDLL', create=True, return_value=dll) as load:
            api = stop._Hotkey()
            api.register()
            self.assertEqual(api.poll(), (0x0312, 0x4D45, (0x7A << 16) | 7))
            api.unregister()
        load.assert_called_once_with('user32', use_last_error=True, winmode=0x800)
        dll.RegisterHotKey.assert_called_once_with(None, 0x4D45, 0x4007, 0x7A)
        dll.UnregisterHotKey.assert_called_once_with(None, 0x4D45)
        arguments = dll.PeekMessageW.call_args.args
        self.assertEqual(arguments[1].value, stop.wintypes.HWND(-1).value)
        self.assertEqual(arguments[2:], (0x0312, 0x0312, 1))

    def test_no_message_is_not_a_native_error(self):
        with patch.object(stop.ctypes, 'WinDLL', create=True, return_value=self.dll()):
            self.assertIsNone(stop._Hotkey().poll())

    def test_register_and_unregister_zero_are_fixed_failures(self):
        with patch.object(stop.ctypes, 'WinDLL', create=True,
                          return_value=self.dll(register_result=0, unregister_result=0)):
            api = stop._Hotkey()
            for operation, code in ((api.register, 'hotkey_unavailable'),
                                    (api.unregister, 'hotkey_cleanup_failed')):
                with self.assertRaises(stop.StopUnavailable) as caught:
                    operation()
                self.assertEqual(caught.exception.code, code)


if __name__ == '__main__':
    unittest.main()
