# Copyright (c) 2026 Memlia. All rights reserved.
"""Refus/lifecycle portables ; aucun double ne donne un consentement réel."""

from contextlib import contextmanager
import ctypes
import threading
import time
import unittest
from unittest.mock import patch
from types import SimpleNamespace

from memlia_agent import capture_controls as controls, resources, stop
from memlia_agent.session import SessionObservation


OBSERVED = SessionObservation('S-1-5-21-111-222-333-1001', 1, 1)
DIGEST = 'sha256:' + 'a' * 64


class DialogFactoryTests(unittest.TestCase):
    def test_default_factory_remains_the_exact_native_capture_dialog(self):
        owner = object.__new__(controls._CaptureControls)
        expected = object()
        with patch.object(controls, '_TaskDialog', return_value=expected) as factory:
            self.assertIs(owner._make_dialog(), expected)
        factory.assert_called_once_with()


class _Mutex:
    def release(self, handle):
        pass

    def close(self, handle):
        pass


class _Hotkey:
    def register(self):
        pass

    def poll(self):
        return None

    def unregister(self):
        pass


class _RefusingDialog:
    """Seulement des refus synthétiques ; jamais de notification Autoriser."""

    def __init__(self, kind='cancel'):
        self.kind = kind
        self.thread = None
        self.cancelled = 0
        self.stopping = 0
        self.authorize_calls = 0

    def show(self, owner):
        self.thread = threading.get_native_id()
        if self.kind == 'error':
            raise OSError('PRIVATE_CANARY')
        if self.kind == 'returns':
            return
        owner._notification(self, 123, 0, 0)
        if self.kind == 'cancel':
            owner._notification(self, 123, 2, 2)
        elif self.kind == 'lost':
            owner._notification(self, 123, 5, 0)
        elif self.kind == 'invisible':
            owner._notification(self, 123, 4, 0)
        elif self.kind == 'foreign':
            wrong = threading.Thread(target=lambda: owner._notification(self, 123, 4, 0))
            wrong.start()
            wrong.join(1)
        elif self.kind == 'timer':
            while not owner._signal.stopped:
                owner._notification(self, 123, 4, 0)
                time.sleep(.005)
        owner._notification(self, 123, 5, 0)

    def make_topmost(self, hwnd):
        pass

    def check_visible(self, hwnd):
        if self.kind == 'invisible':
            raise OSError('PRIVATE_CANARY')

    def cancel(self, hwnd):
        self.cancelled += 1

    def mark_stopping(self, hwnd):
        self.stopping += 1

    def mark_authorized(self, hwnd):
        self.authorize_calls += 1
        raise AssertionError('test doubles must not grant consent')


class _Alive:
    """Infrastructural state for negative checkpoints, not a consent producer."""
    def is_alive(self):
        return True


class CaptureControlsTests(unittest.TestCase):
    def setUp(self):
        for target in (resources, stop, controls):
            active = patch.object(target, 'observe_session', return_value=OBSERVED)
            active.start()
            self.addCleanup(active.stop)
        active = patch.object(stop, '_Hotkey', return_value=_Hotkey())
        active.start()
        self.addCleanup(active.stop)

    @contextmanager
    def owned(self, seconds=3):
        reservation = resources.DesktopReservation(_Mutex(), 123, OBSERVED)
        try:
            with stop.arm_local_stop(reservation, deadline_monotonic=time.monotonic() + seconds) as signal:
                yield reservation, signal
        finally:
            reservation.close()

    def enter(self, reservation, signal, digest=DIGEST):
        return controls.request_capture_controls(reservation, signal, operation_digest=digest)

    def assert_fixed(self, caught, code):
        self.assertEqual(caught.exception.code, code)
        self.assertEqual(str(caught.exception), code)
        self.assertIsNone(caught.exception.__cause__)
        self.assertIsNone(caught.exception.__context__)
        self.assertNotIn('PRIVATE_CANARY', repr(caught.exception))

    def test_digest_exact_immutable_and_bounded_before_dialog(self):
        class Spoof(str):
            pass
        with self.owned() as (reservation, signal):
            for digest in (None, b'a' * 32, Spoof(DIGEST), 'a' * 64, DIGEST.upper(),
                           DIGEST + '\n', 'sha256:' + 'g' * 64, 'sha256:' + 'a' * 65):
                with self.subTest(kind=type(digest).__name__):
                    with self.assertRaises(controls.CaptureUnavailable) as caught:
                        with self.enter(reservation, signal, digest):
                            self.fail('must refuse')
                    self.assert_fixed(caught, 'invalid_operation_digest')

    def test_reservation_or_local_stop_cannot_be_substituted(self):
        with self.owned() as (reservation, signal):
            for reserved, stopped in ((object(), signal), (reservation, object())):
                with self.assertRaises(controls.CaptureUnavailable) as caught:
                    with self.enter(reserved, stopped):
                        self.fail('must refuse')
                self.assert_fixed(caught, 'capture_binding_unavailable')

    def test_signal_bound_to_other_reservation_refuses_before_native_ui(self):
        with self.owned() as (reservation, signal):
            other = resources.DesktopReservation(_Mutex(), 456, OBSERVED)
            try:
                with self.assertRaises(controls.CaptureUnavailable) as caught:
                    with self.enter(other, signal):
                        self.fail('must refuse')
                self.assert_fixed(caught, 'capture_binding_unavailable')
            finally:
                other.close()

    def test_prior_stop_is_not_replaced_with_a_new_decision(self):
        with self.owned() as (reservation, signal):
            signal.request_stop()
            with self.assertRaises(stop.StopRequested):
                with self.enter(reservation, signal):
                    self.fail('must refuse')

    def test_unsupported_platform_has_no_fallback_or_approval_input(self):
        with self.owned() as (reservation, signal):
            with patch.object(controls.sys, 'platform', 'darwin'):
                with self.assertRaises(controls.CaptureUnavailable) as caught:
                    with self.enter(reservation, signal):
                        self.fail('must refuse')
                self.assert_fixed(caught, 'dialog_unavailable')
        self.assertFalse(hasattr(controls, 'approve'))

    def test_stop_after_binding_refuses_before_starting_a_dialog_thread(self):
        with self.owned() as (reservation, signal):
            owner = controls._CaptureControls(reservation, signal, DIGEST)
            signal.request_stop()
            with patch.object(controls, '_TaskDialog') as native:
                try:
                    with self.assertRaises((stop.StopRequested, controls.CaptureUnavailable)) as caught:
                        owner._start()
                    self.assertFalse(owner._started)
                    native.assert_not_called()
                    self.assert_fixed(caught, 'stop_requested')
                finally:
                    owner.close()

    def test_cancel_never_yields_and_stops_owned_operation(self):
        native = _RefusingDialog()
        with patch.object(controls, '_TaskDialog', return_value=native):
            with self.owned() as (reservation, signal):
                with self.assertRaises((controls.CaptureUnavailable, stop.StopRequested)):
                    with self.enter(reservation, signal):
                        self.fail('synthetic cancel is not consent')
                self.assertTrue(signal.stopped)
        self.assertNotEqual(native.thread, threading.get_native_id())

    def test_stop_and_deadline_keep_indicator_until_owned_close_is_requested(self):
        with self.owned() as (reservation, signal):
            owner = controls._CaptureControls(reservation, signal, DIGEST)
            native = _RefusingDialog()
            owner._ui_id, owner._api = threading.get_native_id(), native
            owner._notification(native, 123, 0, 0)
            self.assertEqual(owner._notification(native, 123, 2, 2), 1)
            self.assertTrue(signal.stopped)
            self.assertEqual(owner._hwnd, 123)
            owner._notification(native, 123, 4, 0)
            self.assertEqual(native.cancelled, 0)
            self.assertEqual(native.stopping, 1)
            self.assertFalse(owner._approved)
            # Only the owner's teardown permits a native Cancel that destroys HWND.
            owner._closing = True
            owner._notification(native, 123, 4, 0)
            self.assertEqual(native.cancelled, 1)
            self.assertEqual(owner._notification(native, 123, 2, 2), 0)
            owner._notification(native, 123, 5, 0)
            owner.close()

    def test_approval_notification_without_required_state_never_grants(self):
        for kind in ('hidden', 'expired', 'foreign_thread', 'other_session', 'unknown_button'):
            with self.subTest(kind=kind):
                with self.owned() as (reservation, signal):
                    owner = controls._CaptureControls(reservation, signal, DIGEST)
                    native = _RefusingDialog('invisible' if kind == 'hidden' else 'cancel')
                    owner._ui_id, owner._api = threading.get_native_id(), native
                    owner._notification(native, 123, 0, 0)
                    if kind == 'expired':
                        signal._deadline = time.monotonic() - 1
                    elif kind == 'foreign_thread':
                        owner._ui_id += 1
                    alternate = OBSERVED if kind != 'other_session' else SessionObservation(
                        OBSERVED.windows_sid, 2, 1)
                    with patch.object(controls, 'observe_session', return_value=alternate):
                        owner._notification(native, 123, 2, 999 if kind == 'unknown_button' else 100)
                    self.assertEqual(native.authorize_calls, 0)
                    self.assertFalse(owner._approved)
                    self.assertTrue(signal.stopped)
                    owner._ui_id = threading.get_native_id()
                    owner._notification(native, 123, 5, 0)
                    owner.close()

    def test_native_error_is_fixed_and_does_not_escape_with_local_message(self):
        with patch.object(controls, '_TaskDialog', return_value=_RefusingDialog('error')):
            with self.owned() as (reservation, signal):
                with self.assertRaises(controls.CaptureUnavailable) as caught:
                    with self.enter(reservation, signal):
                        self.fail('must refuse')
                self.assert_fixed(caught, 'dialog_unavailable')
                self.assertTrue(signal.stopped)

    def test_lost_window_return_without_decision_and_invisible_indicator_refuse(self):
        for kind in ('lost', 'returns', 'invisible', 'foreign'):
            with self.subTest(kind=kind):
                native = _RefusingDialog(kind)
                with patch.object(controls, '_TaskDialog', return_value=native):
                    with self.owned() as (reservation, signal):
                        with self.assertRaises((controls.CaptureUnavailable, stop.StopRequested)):
                            with self.enter(reservation, signal):
                                self.fail('no local positive decision')
                        self.assertTrue(signal.stopped)

    def test_worker_other_session_refuses_before_dialog_creation(self):
        with patch.object(controls, '_TaskDialog') as native:
            with self.owned() as (reservation, signal):
                with patch.object(controls, 'observe_session', return_value=SessionObservation(
                        OBSERVED.windows_sid, 2, 1)):
                    with self.assertRaises(controls.CaptureUnavailable) as caught:
                        with self.enter(reservation, signal):
                            self.fail('must refuse')
                    self.assert_fixed(caught, 'capture_session_unavailable')
                native.assert_not_called()

    def test_pending_decision_expires_without_yielding(self):
        with patch.object(controls, '_TaskDialog', return_value=_RefusingDialog('timer')):
            with self.owned(seconds=.08) as (reservation, signal):
                with self.assertRaises((controls.CaptureUnavailable, stop.StopRequested)):
                    with self.enter(reservation, signal):
                        self.fail('deadline is not consent')
                self.assertTrue(signal.stopped)

    def test_no_decision_checkpoint_and_other_digest_cannot_authorize_work(self):
        with self.owned() as (reservation, signal):
            owner = controls._CaptureControls(reservation, signal, DIGEST)
            with self.assertRaises(controls.CaptureUnavailable) as caught:
                owner.checkpoint(operation_digest=DIGEST)
            self.assert_fixed(caught, 'local_consent_unavailable')
            with self.assertRaises(controls.CaptureUnavailable) as caught:
                owner.checkpoint(operation_digest='sha256:' + 'b' * 64)
            self.assert_fixed(caught, 'capture_operation_mismatch')
            owner.close()

    def test_foreign_owner_cannot_transfer_or_close_controls(self):
        with self.owned() as (reservation, signal):
            owner = controls._CaptureControls(reservation, signal, DIGEST)
            errors = []
            def other():
                for action in (lambda: owner.checkpoint(operation_digest=DIGEST), owner.close):
                    try:
                        action()
                    except controls.CaptureUnavailable as error:
                        errors.append(error.code)
            worker = threading.Thread(target=other)
            worker.start()
            worker.join(1)
            self.assertFalse(worker.is_alive())
            self.assertEqual(errors, ['capture_owner_mismatch', 'capture_owner_mismatch'])
            self.assertTrue(signal.stopped)
            owner.close()

    def test_changed_display_count_invalidates_the_bound_desktop(self):
        with self.owned() as (reservation, signal):
            owner = controls._CaptureControls(reservation, signal, DIGEST)
            with patch.object(controls, 'observe_session', return_value=SessionObservation(
                    OBSERVED.windows_sid, OBSERVED.session_id, 2)):
                with self.assertRaises(controls.CaptureUnavailable):
                    owner._same_session()
            owner.close()

    def negative_state(self, reservation, signal):
        """Corrupt/internal approved state only to exercise refusals; never yielded."""
        owner = controls._CaptureControls(reservation, signal, DIGEST)
        owner._approved, owner._started = True, True
        owner._hwnd, owner._api = 123, _RefusingDialog()
        owner._last_tick, owner._thread = time.monotonic(), _Alive()
        self.addCleanup(lambda: signal.request_stop())
        return owner

    def test_stale_timer_closed_and_dead_monitor_refuse_before_any_next_action(self):
        for kind in ('stale', 'closed', 'missing_window', 'dead'):
            with self.subTest(kind=kind):
                with self.owned() as (reservation, signal):
                    owner = self.negative_state(reservation, signal)
                    if kind == 'stale':
                        owner._last_tick -= 2
                    elif kind == 'closed':
                        owner._closed = True
                    elif kind == 'missing_window':
                        owner._hwnd = None
                    else:
                        owner._started = False
                    with self.assertRaises(controls.CaptureUnavailable) as caught:
                        owner.checkpoint(operation_digest=DIGEST)
                    self.assert_fixed(caught, 'indicator_unavailable')
                    self.assertTrue(signal.stopped)

    def test_window_change_during_native_check_refuses_before_return(self):
        with self.owned() as (reservation, signal):
            owner = self.negative_state(reservation, signal)
            owner._api.check_visible = lambda hwnd: setattr(owner, '_hwnd', None)
            with self.assertRaises(controls.CaptureUnavailable) as caught:
                owner.checkpoint(operation_digest=DIGEST)
            self.assert_fixed(caught, 'indicator_unavailable')
            self.assertTrue(signal.stopped)

    def test_monitor_count_change_during_checkpoint_is_a_fixed_refusal(self):
        with self.owned() as (reservation, signal):
            owner = self.negative_state(reservation, signal)
            with patch.object(controls, 'observe_session', return_value=SessionObservation(
                    OBSERVED.windows_sid, OBSERVED.session_id, 2)):
                with self.assertRaises(controls.CaptureUnavailable) as caught:
                    owner.checkpoint(operation_digest=DIGEST)
            self.assert_fixed(caught, 'indicator_unavailable')

    def test_stop_during_native_visibility_check_is_not_delivered_as_consent(self):
        with self.owned() as (reservation, signal):
            owner = self.negative_state(reservation, signal)
            owner._api.check_visible = lambda hwnd: signal.request_stop()
            with self.assertRaises(stop.StopRequested):
                owner.checkpoint(operation_digest=DIGEST)

    def test_cleanup_unverified_retains_hold_even_if_dialog_api_has_returned(self):
        with self.owned() as (reservation, signal):
            owner = controls._CaptureControls(reservation, signal, DIGEST)
            owner._started = True
            owner._thread = unittest.mock.Mock()
            owner._thread.is_alive.return_value = False
            owner._done.set()
            owner._hwnd = 123
            with self.assertRaises(controls.CaptureUnavailable) as caught:
                owner.close()
            self.assert_fixed(caught, 'dialog_cleanup_unverified')
            self.assertFalse(owner._closed)
            self.assertTrue(signal.stopped)
            owner._hwnd = None
            owner.close()
            owner.close()

    def test_non_returning_dialog_cleanup_is_hold_and_thread_is_not_abandoned(self):
        entered, release = threading.Event(), threading.Event()
        native = _RefusingDialog()
        def blocked(owner):
            entered.set()
            release.wait(2)
        native.show = blocked
        owner = None
        with self.owned() as (reservation, signal):
            with patch.object(controls, '_TaskDialog', return_value=native), \
                    patch.object(controls, '_JOIN_SECONDS', .02):
                owner = controls._CaptureControls(reservation, signal, DIGEST)
                try:
                    with self.assertRaises(controls.CaptureUnavailable):
                        owner._start()
                    self.assertTrue(entered.is_set())
                    with self.assertRaises(controls.CaptureUnavailable) as caught:
                        owner.close()
                    self.assert_fixed(caught, 'dialog_cleanup_unverified')
                    self.assertTrue(owner._thread.is_alive())
                    self.assertFalse(owner._thread.daemon)
                finally:
                    release.set()
                    owner._thread.join(1)
                    owner.close()
                self.assertFalse(owner._thread.is_alive())

    def test_win64_sdk_packed_layout_is_explicit_without_loading_a_dll(self):
        self.assertEqual(ctypes.sizeof(controls._Button), 12)
        self.assertEqual(ctypes.sizeof(controls._Config), 160)
        self.assertEqual(controls._Config.pButtons.offset, 64)
        self.assertEqual(controls._Config.pfCallback.offset, 140)
        self.assertEqual(controls._Config.cxWidth.offset, 156)

    def transition_state(self, reservation, signal):
        """Internal transition fixture only; never yields a synthetic consent."""
        owner = self.negative_state(reservation, signal)
        owner._ui_id = threading.get_native_id()
        owner._api.recording = owner._api.finishing = 0
        owner._api.mark_recording = lambda hwnd: setattr(
            owner._api, 'recording', owner._api.recording + 1)
        owner._api.mark_finishing = lambda hwnd: setattr(
            owner._api, 'finishing', owner._api.finishing + 1)
        return owner

    def test_finish_before_verified_start_refuses_without_becoming_normal_finish(self):
        with self.owned() as (reservation, signal):
            owner = self.transition_state(reservation, signal)
            owner._notification(owner._api, 123, 2, 101)
            self.assertTrue(signal.stopped)
            self.assertFalse(getattr(owner, '_finish_requested', False))
            self.assertEqual(owner._api.finishing, 0)

    def test_started_notification_requires_the_real_local_context(self):
        with self.owned() as (reservation, signal):
            owner = controls._CaptureControls(reservation, signal, DIGEST)
            self.assertTrue(callable(getattr(owner, 'recording_started', None)))
            with self.assertRaises(controls.CaptureUnavailable) as caught:
                owner.recording_started(operation_digest=DIGEST)
            self.assert_fixed(caught, 'local_consent_unavailable')
            self.assertFalse(owner._recording_started)
            owner.close()

    def test_verified_start_is_indicated_on_ui_timer_not_on_authorization(self):
        with self.owned() as (reservation, signal):
            owner = self.transition_state(reservation, signal)
            self.assertTrue(callable(getattr(owner, 'recording_started', None)))
            owner._notification(owner._api, 123, 4, 0)
            self.assertEqual(owner._api.recording, 0)
            owner.recording_preparing(operation_digest=DIGEST)
            owner.recording_started(operation_digest=DIGEST)
            self.assertFalse(signal.stopped)
            owner._notification(owner._api, 123, 4, 0)
            owner._notification(owner._api, 123, 4, 0)
            self.assertEqual(owner._api.recording, 1)
            self.assertFalse(owner._finish_requested)

    def test_normal_finish_keeps_indicator_and_local_stop_armed_until_cleanup(self):
        with self.owned() as (reservation, signal):
            owner = self.transition_state(reservation, signal)
            self.assertTrue(callable(getattr(owner, 'recording_started', None)))
            owner.recording_preparing(operation_digest=DIGEST)
            owner.recording_started(operation_digest=DIGEST)
            owner._notification(owner._api, 123, 4, 0)
            self.assertEqual(owner._notification(owner._api, 123, 2, 101), 1)
            self.assertTrue(owner.finish_requested(operation_digest=DIGEST))
            self.assertFalse(signal.stopped)
            self.assertEqual(owner._api.finishing, 1)
            self.assertEqual(owner._hwnd, 123)
            self.assertEqual(owner._api.cancelled, 0)
            self.assertFalse(owner._closing)
            self.assertFalse(owner._closed)
            # Emergency stop still wins after a normal finish request.
            signal.request_stop()
            with self.assertRaises(stop.StopRequested):
                owner.finish_requested(operation_digest=DIGEST)
            self.assertEqual(owner._hwnd, 123)

    def test_finish_races_with_stop_or_session_loss_never_delivers_normal_finish(self):
        for kind in ('stop', 'session', 'deadline', 'hidden', 'foreign'):
            with self.subTest(kind=kind):
                with self.owned() as (reservation, signal):
                    owner = self.transition_state(reservation, signal)
                    self.assertTrue(callable(getattr(owner, 'recording_started', None)))
                    owner.recording_preparing(operation_digest=DIGEST)
                    owner.recording_started(operation_digest=DIGEST)
                    owner._notification(owner._api, 123, 4, 0)
                    if kind == 'stop':
                        owner._api.mark_finishing = lambda hwnd: signal.request_stop()
                    elif kind == 'session':
                        owner._api.mark_finishing = lambda hwnd: setattr(
                            owner, '_observed', SessionObservation(OBSERVED.windows_sid, 2, 1))
                    elif kind == 'deadline':
                        signal._deadline = time.monotonic() - 1
                    elif kind == 'hidden':
                        owner._api.check_visible = lambda hwnd: (_ for _ in ()).throw(OSError('PRIVATE_CANARY'))
                    else:
                        owner._ui_id += 1
                    owner._notification(owner._api, 123, 2, 101)
                    self.assertTrue(signal.stopped)
                    self.assertFalse(owner._finish_requested)
                    with self.assertRaises((stop.StopRequested, controls.CaptureUnavailable)):
                        owner.finish_requested(operation_digest=DIGEST)

    def test_duplicate_finish_never_reopens_normal_capture(self):
        with self.owned() as (reservation, signal):
            owner = self.transition_state(reservation, signal)
            self.assertTrue(callable(getattr(owner, 'recording_started', None)))
            owner.recording_preparing(operation_digest=DIGEST)
            owner.recording_started(operation_digest=DIGEST)
            owner._notification(owner._api, 123, 4, 0)
            owner._notification(owner._api, 123, 2, 101)
            owner._notification(owner._api, 123, 2, 101)
            self.assertTrue(owner.finish_requested(operation_digest=DIGEST))
            self.assertEqual(owner._api.finishing, 1)
            self.assertEqual(owner._api.recording, 1)
            self.assertFalse(signal.stopped)

    def test_work_started_requires_confirmed_cleanup_before_dialog_can_close(self):
        with self.owned() as (reservation, signal):
            owner = controls._CaptureControls(reservation, signal, DIGEST)
            owner._work_pending = True  # Unknown work, no fake success receipt.
            with self.assertRaises(controls.CaptureUnavailable) as caught:
                owner.close()
            self.assert_fixed(caught, 'capture_cleanup_unverified')
            self.assertFalse(owner._closing)
            self.assertFalse(owner._closed)
            self.assertTrue(signal.stopped)
            self.assertTrue(callable(getattr(owner, 'recording_stopped', None)))
            # A verified Job-empty acknowledgement must remain possible after stop.
            owner.recording_stopped(operation_digest=DIGEST)
            owner.close()
            self.assertTrue(owner._closed)

    def test_caller_start_finish_and_cleanup_are_bound_to_owner_and_digest(self):
        for action in ('recording_preparing', 'recording_started', 'finish_requested', 'recording_stopped'):
            with self.subTest(action=action):
                with self.owned() as (reservation, signal):
                    owner = self.transition_state(reservation, signal)
                    self.assertTrue(callable(getattr(owner, action, None)))
                    with self.assertRaises(controls.CaptureUnavailable) as caught:
                        getattr(owner, action)(operation_digest='sha256:' + 'b' * 64)
                    self.assert_fixed(caught, 'capture_operation_mismatch')
                    self.assertTrue(signal.stopped)
                with self.owned() as (reservation, signal):
                    owner = self.transition_state(reservation, signal)
                    errors = []
                    def foreign():
                        try:
                            getattr(owner, action)(operation_digest=DIGEST)
                        except controls.CaptureUnavailable as error:
                            errors.append(error.code)
                    thread = threading.Thread(target=foreign)
                    thread.start()
                    thread.join(1)
                    self.assertFalse(thread.is_alive())
                    self.assertEqual(errors, ['capture_owner_mismatch'])
                    self.assertTrue(signal.stopped)

    def test_start_after_stop_and_repeated_start_cannot_enable_finish(self):
        for stopped in (False, True):
            with self.subTest(stopped=stopped):
                with self.owned() as (reservation, signal):
                    owner = self.transition_state(reservation, signal)
                    self.assertTrue(callable(getattr(owner, 'recording_started', None)))
                    if stopped:
                        signal.request_stop()
                    else:
                        owner.recording_preparing(operation_digest=DIGEST)
                        owner.recording_started(operation_digest=DIGEST)
                    with self.assertRaises((stop.StopRequested, controls.CaptureUnavailable)):
                        owner.recording_started(operation_digest=DIGEST)
                    self.assertEqual(owner._api.recording, 0)

    def test_cleanup_without_started_work_is_not_a_completion_receipt(self):
        with self.owned() as (reservation, signal):
            owner = controls._CaptureControls(reservation, signal, DIGEST)
            self.assertTrue(callable(getattr(owner, 'recording_stopped', None)))
            with self.assertRaises(controls.CaptureUnavailable) as caught:
                owner.recording_stopped(operation_digest=DIGEST)
            self.assert_fixed(caught, 'capture_state_unavailable')
            self.assertFalse(owner._recording_stopped)
            owner.close()

    def test_prepare_arms_cleanup_before_process_creation_without_claiming_recording(self):
        with self.owned() as (reservation, signal):
            owner = self.transition_state(reservation, signal)
            self.assertTrue(callable(getattr(owner, 'recording_preparing', None)))
            owner.recording_preparing(operation_digest=DIGEST)
            self.assertTrue(owner._work_pending)
            self.assertFalse(owner._recording_started)
            owner._notification(owner._api, 123, 4, 0)
            self.assertEqual(owner._api.recording, 0)
            with self.assertRaises(controls.CaptureUnavailable) as caught:
                owner.close()
            self.assert_fixed(caught, 'capture_cleanup_unverified')
            self.assertEqual(owner._hwnd, 123)
            self.assertFalse(owner._closing)

    def test_start_without_preparing_is_not_a_verified_start(self):
        with self.owned() as (reservation, signal):
            owner = self.transition_state(reservation, signal)
            self.assertTrue(callable(getattr(owner, 'recording_started', None)))
            with self.assertRaises(controls.CaptureUnavailable) as caught:
                owner.recording_started(operation_digest=DIGEST)
            self.assert_fixed(caught, 'capture_state_unavailable')
            self.assertFalse(owner._recording_started)

    def test_finish_while_button_still_disabled_is_not_a_normal_finish(self):
        with self.owned() as (reservation, signal):
            owner = self.transition_state(reservation, signal)
            owner.recording_preparing(operation_digest=DIGEST)
            owner.recording_started(operation_digest=DIGEST)
            # The UI timer has not yet displayed the verified recording state.
            owner._notification(owner._api, 123, 2, 101)
            self.assertTrue(signal.stopped)
            self.assertFalse(owner._finish_requested)
            self.assertEqual(owner._api.finishing, 0)

    def test_finish_read_rechecks_stop_after_capturing_local_state(self):
        with self.owned() as (reservation, signal):
            owner = self.transition_state(reservation, signal)
            owner.recording_preparing(operation_digest=DIGEST)
            owner.recording_started(operation_digest=DIGEST)
            owner._notification(owner._api, 123, 4, 0)
            owner._notification(owner._api, 123, 2, 101)
            lock = owner._lock
            class StopOnRead:
                def __enter__(self):
                    lock.acquire()
                def __exit__(self, *args):
                    lock.release()
                    signal.request_stop()
            # Checkpoints keep their native session checks. Only the final state
            # read introduces a cancellation between checkpoint and delivery.
            def checked(*, operation_digest):
                with patch.object(owner, '_lock', lock):
                    controls._CaptureControls.checkpoint(owner, operation_digest=operation_digest)
            with patch.object(owner, '_lock', StopOnRead()), patch.object(owner, 'checkpoint', checked):
                with self.assertRaises(stop.StopRequested):
                    owner.finish_requested(operation_digest=DIGEST)

    def test_cleanup_hold_keeps_reservation_in_the_current_owner_frame(self):
        with self.owned() as (reservation, signal):
            owner = self.transition_state(reservation, signal)
            owner.recording_preparing(operation_digest=DIGEST)
            with self.assertRaises(controls.CaptureUnavailable):
                owner.close()
            self.assertEqual(reservation.ensure_current(), OBSERVED)
            self.assertFalse(reservation._closed)
            self.assertFalse(owner._closing)


class NativeVisibilityTests(unittest.TestCase):
    """Win32 calls doubled; no native display/consent qualification."""

    def native(self):
        api = object.__new__(controls._TaskDialog)
        api._pid, api._tid = 1234, 5678
        def thread(hwnd, pointer):
            pointer._obj.value = 1234
            return 5678
        def rect(hwnd, pointer):
            area = pointer._obj
            area.left, area.top = 10, 10
            area.right, area.bottom = 100, 100
            return 1
        def monitor_info(handle, pointer):
            area = pointer._obj.work
            area.left, area.top = 0, 0
            area.right, area.bottom = 1000, 1000
            return 1
        api._thread, api._rect, api._monitor_info = thread, rect, monitor_info
        api._visible = api._enabled = lambda hwnd: 1
        api._iconic = lambda hwnd: 0
        api._style = lambda hwnd, style: 8
        api._cloaked = lambda *args: 0
        api._monitor = lambda *args: 9
        api._button = lambda *args: 456
        api._point = lambda point: 123
        api._child = lambda *args: 0
        return api

    def test_hidden_minimized_disabled_nontopmost_foreign_or_cloaked_refuse(self):
        for field, value in (('_visible', 0), ('_iconic', 1), ('_enabled', 0),
                             ('_style', 0), ('_thread', 123), ('_cloaked', -1)):
            with self.subTest(field=field):
                api = self.native()
                setattr(api, field, lambda *args: value)
                with self.assertRaises(controls.CaptureUnavailable):
                    api.check_visible(123)

    def test_unknown_display_offscreen_missing_stop_button_or_occlusion_refuse(self):
        for field, value in (('_monitor', 0), ('_monitor_info', 0), ('_rect', 0),
                             ('_button', 0), ('_point', 999)):
            with self.subTest(field=field):
                api = self.native()
                setattr(api, field, lambda *args: value)
                with self.assertRaises(controls.CaptureUnavailable):
                    api.check_visible(123)

    def test_approve_button_must_exist_even_when_disabling_it(self):
        api = self.native()
        api._button = lambda *args: None
        api._enabled = lambda hwnd: 0
        api._send = lambda *args: 0
        api._title = lambda *args: 1
        with self.assertRaises(controls.CaptureUnavailable):
            api.mark_authorized(123)

    def test_cancel_only_current_ui_thread_and_only_cancel_message(self):
        api = self.native()
        api._tid = threading.get_native_id()
        sent = []
        api._send = lambda *args: sent.append(args)
        api.cancel(123)
        self.assertEqual(sent, [(123, 0x400 + 102, 2, 0)])
        api._tid += 1
        with self.assertRaises(controls.CaptureUnavailable):
            api.cancel(123)
        self.assertEqual(len(sent), 1)

    def test_real_config_uses_cancel_default_timer_and_keeps_callback_alive(self):
        api = object.__new__(controls._TaskDialog)
        received, notices = [], []
        callback_type = ctypes.CFUNCTYPE(ctypes.c_int32, ctypes.c_void_p, ctypes.c_uint32,
                                         ctypes.c_size_t, ctypes.c_ssize_t, ctypes.c_ssize_t)
        def call(config_pointer, selected_pointer, radio, verification):
            config = config_pointer._obj
            self.assertIsNone(radio)
            self.assertIsNone(verification)
            received.append((config.cbSize, config.dwFlags, config.nDefaultButton,
                             [(item.nButtonID, item.pszButtonText)
                              for item in config.pButtons[:config.cButtons]],
                             config.pszContent, config.dwCommonButtons))
            # Exercise only a native-shaped cancel notification. No approved state.
            callback = callback_type(config.pfCallback)
            self.assertEqual(callback(123, 2, 2, 0, 0), 0)
            selected_pointer._obj.value = 2
            return 0
        api._dialog = call
        owner = SimpleNamespace(_digest=DIGEST, _notification=lambda *args: notices.append(args) or 0)
        with patch.object(ctypes, 'WINFUNCTYPE', ctypes.CFUNCTYPE, create=True):
            api.show(owner)
        size, flags, default, buttons, text, common = received[0]
        self.assertEqual((size, flags, default, common), (160, 0x808, 2, 0))
        self.assertEqual(buttons, [(100, 'Autoriser cet enregistrement'),
                                  (101, 'Terminer l’enregistrement'), (2, 'Refuser / Arrêter maintenant')])
        self.assertNotIn(DIGEST, text)
        self.assertNotIn('sha256:', text)
        self.assertIn('clics', text)
        self.assertIn('frappes', text)
        self.assertIn('mot de passe', text)
        self.assertIn('Ctrl + Alt + Maj + F11', text)
        self.assertEqual(len(notices), 1)

    def test_finish_is_disabled_on_creation_enabled_after_start_then_disabled_on_finish(self):
        api = self.native()
        enabled = {100: 1, 101: 1, 2: 1}
        titles = []
        api._set_pos = lambda *args: 1
        api._button = lambda hwnd, button: button if button in enabled else 0
        api._enabled = lambda button: enabled[button]
        api._send = lambda hwnd, message, button, value: enabled.__setitem__(button, value)
        api._title = lambda hwnd, title: titles.append(title) or 1
        api.make_topmost(123)
        self.assertEqual(enabled, {100: 1, 101: 0, 2: 1})
        api.mark_authorized(123)
        self.assertEqual(enabled, {100: 0, 101: 0, 2: 1})
        self.assertNotIn('enregistrement en cours', titles[-1])
        api.mark_recording(123)
        self.assertEqual(enabled, {100: 0, 101: 1, 2: 1})
        self.assertEqual(titles[-1], 'Memlia — enregistrement en cours')
        api.mark_finishing(123)
        self.assertEqual(enabled, {100: 0, 101: 0, 2: 1})
        self.assertEqual(titles[-1], 'Memlia — finalisation ; arrêt en cours de vérification')

    def test_finish_button_missing_or_native_enable_ineffective_refuses(self):
        for missing in (False, True):
            with self.subTest(missing=missing):
                api = self.native()
                api._set_pos = lambda *args: 1
                api._button = lambda hwnd, button: 0 if missing else button
                api._enabled = lambda button: 1
                api._send = lambda *args: 0  # Fails to disable the real button state.
                with self.assertRaises(controls.CaptureUnavailable):
                    api.make_topmost(123)

    def test_taskdialog_hresult_refusal_has_only_fixed_code(self):
        api = object.__new__(controls._TaskDialog)
        api._dialog = lambda *args: -2147467259
        owner = SimpleNamespace(_digest=DIGEST, _notification=lambda *args: 0)
        with patch.object(ctypes, 'WINFUNCTYPE', ctypes.CFUNCTYPE, create=True):
            with self.assertRaises(controls.CaptureUnavailable) as caught:
                api.show(owner)
        self.assertEqual(caught.exception.code, 'dialog_unavailable')


if __name__ == '__main__':
    unittest.main()
