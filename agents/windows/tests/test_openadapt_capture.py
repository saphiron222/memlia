# Copyright (c) 2026 Memlia. All rights reserved.
"""Inactive host boundaries; no synthetic local consent or desktop capture."""
import importlib.util
import math
import sys
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch


DIGEST = 'sha256:' + 'd' * 64


class CaptureHostContractTests(unittest.TestCase):
    def host(self):
        self.assertIsNotNone(importlib.util.find_spec('memlia_agent.openadapt_capture'))
        return __import__('memlia_agent.openadapt_capture', fromlist=['record_capture'])

    def request(self, **replace):
        values = dict(operation_digest=DIGEST, deadline_monotonic=time.monotonic() + 30,
                      max_bytes=4 * 1024 * 1024, revalidate=lambda: None)
        values.update(replace)
        return values

    def test_inactive_adapter_has_an_owned_run_and_explicit_reconciliation_port(self):
        spec = importlib.util.find_spec('memlia_agent.openadapt_capture')
        self.assertIsNotNone(spec, 'the owned capture adapter is missing')
        host = __import__('memlia_agent.openadapt_capture', fromlist=['record_capture'])
        self.assertTrue(callable(getattr(host, 'record_capture', None)))
        self.assertTrue(callable(getattr(host, 'reconcile_capture', None)))

    def test_request_bounds_and_authority_port_refuse_before_any_ui_or_worker(self):
        host = self.host()
        class Spoof(str):
            pass
        invalid = [dict(operation_digest=x) for x in (None, DIGEST + '\n', Spoof(DIGEST), 'x')]
        invalid += [dict(deadline_monotonic=x) for x in (True, math.nan, math.inf, 0, time.monotonic() + 1801)]
        invalid += [dict(max_bytes=x) for x in (True, 0, -1, 2**31 + 1, 3.5)]
        invalid += [dict(revalidate=x) for x in (None, True, {'accept': True})]
        with patch.object(host, '_CaptureRun') as owner:
            for values in invalid:
                with self.subTest(fields=tuple(values)):
                    with self.assertRaises(host.CaptureError) as caught:
                        host.record_capture(**self.request(**values))
                    self.assertEqual(caught.exception.code, 'invalid_capture_request')
                    self.assertIsNone(caught.exception.__cause__)
                    self.assertIsNone(caught.exception.__context__)
            owner.assert_not_called()

    def test_unavailable_native_runtime_is_a_fixed_refusal_without_engine_import(self):
        host = self.host()
        before = {name for name in sys.modules if name.startswith(('openadapt_capture', 'openadapt_flow', 'onnxruntime'))}
        with patch.object(host.sys, 'platform', 'darwin'):
            with self.assertRaises(host.CaptureError) as caught:
                host.record_capture(**self.request())
        self.assertEqual(caught.exception.code, 'capture_runtime_unavailable')
        self.assertEqual(before, {name for name in sys.modules if name.startswith(
            ('openadapt_capture', 'openadapt_flow', 'onnxruntime'))})

    def test_held_owner_is_strongly_retained_and_blocks_new_run_before_authority(self):
        host = self.host()
        held = object()
        calls = []
        with patch.object(host, '_active', held), patch.object(host, '_CaptureRun') as owner:
            with self.assertRaises(host.CaptureError) as caught:
                host.record_capture(**self.request(revalidate=lambda: calls.append('authority')))
            self.assertEqual(caught.exception.code, 'capture_hold')
            self.assertIs(host._active, held)
            self.assertEqual(calls, [])
            owner.assert_not_called()

    def test_reconciliation_without_active_work_does_not_create_or_release_resources(self):
        host = self.host()
        with patch.object(host, '_active', None), patch.object(host, '_CaptureRun') as owner:
            self.assertIsNone(host.reconcile_capture())
            owner.assert_not_called()

    def test_boolean_authority_response_is_not_a_consent_or_permission(self):
        host = self.host()
        run = host._CaptureRun(**self.request(revalidate=lambda: True))
        with self.assertRaises(host.CaptureError) as caught:
            run._authority()
        self.assertEqual(caught.exception.code, 'capture_authority_unavailable')

    def test_authority_exception_is_fixed_and_contains_no_native_cause(self):
        host = self.host()
        def refused():
            raise OSError('PRIVATE_CANARY')
        run = host._CaptureRun(**self.request(revalidate=refused))
        with self.assertRaises(host.CaptureError) as caught:
            run._authority()
        self.assertEqual(str(caught.exception), 'capture_authority_unavailable')
        self.assertIsNone(caught.exception.__cause__)
        self.assertIsNone(caught.exception.__context__)
        self.assertNotIn('PRIVATE_CANARY', repr(caught.exception))

    def test_missing_source_filter_refuses_before_any_native_resources_or_engine_import(self):
        host = self.host()
        calls = []
        run = host._CaptureRun(**self.request(revalidate=lambda: calls.append('authority')))
        before = {name for name in sys.modules if name.startswith(
            ('openadapt_capture', 'openadapt_flow', 'onnxruntime'))}
        with self.assertRaises(host.CaptureError) as caught:
            run.run()
        self.assertEqual(caught.exception.code, 'capture_source_filter_unavailable')
        self.assertEqual(calls, ['authority'])
        self.assertEqual(before, {name for name in sys.modules if name.startswith(
            ('openadapt_capture', 'openadapt_flow', 'onnxruntime'))})
        self.assertTrue(all(getattr(run, name) is None for name in
                            ('reservation', 'signal', 'controls', 'job', 'temporary')))

    def test_source_filter_gate_cannot_replace_current_authority_or_deadline_checks(self):
        host = self.host()
        for replacement, expected in ((dict(revalidate=lambda: True), 'capture_authority_unavailable'),
                (dict(deadline_monotonic=time.monotonic() - 1), 'capture_deadline_expired')):
            with self.subTest(expected=expected):
                run = host._CaptureRun(**self.request(**replacement))
                with self.assertRaises(host.CaptureError) as caught:
                    run.run()
                self.assertEqual(caught.exception.code, expected)

    def test_public_gate_clears_only_a_proven_empty_owner_and_never_returns_a_recording(self):
        host = self.host()
        with patch.object(host.sys, 'platform', 'win32'), patch.object(host, '_active', None):
            with self.assertRaises(host.CaptureError) as caught:
                host.record_capture(**self.request())
            self.assertEqual(caught.exception.code, 'capture_source_filter_unavailable')
            self.assertIsNone(caught.exception.__cause__)
            self.assertIsNone(caught.exception.__context__)
            self.assertIsNone(host._active)

    def test_cleanup_failure_keeps_strong_owner_without_leaking_error_text(self):
        host = self.host()
        run = host._CaptureRun(**self.request())
        def fails():
            raise host.CaptureError('capture_failed')
        run.run = fails
        for throws in (False, True):
            with self.subTest(throws=throws):
                run.cleanup = (lambda: (_ for _ in ()).throw(OSError('PRIVATE_CANARY'))) if throws else lambda: False
                with patch.object(host, '_active', None), patch.object(host.sys, 'platform', 'win32'), \
                        patch.object(host, '_CaptureRun', return_value=run):
                    with self.assertRaises(host.CaptureError) as caught:
                        host.record_capture(**self.request())
                    self.assertEqual(caught.exception.code, 'capture_hold')
                    self.assertIs(host._active, run)
                    self.assertIsNone(caught.exception.__context__)
                    self.assertNotIn('PRIVATE_CANARY', repr(caught.exception))

    def test_unimplemented_run_cannot_deliver_an_unverified_result_on_unexpected_return(self):
        host = self.host()
        run = host._CaptureRun(**self.request())
        # The run port is doubled, not a local decision or a successful capture.
        run.run = lambda: object()
        with patch.object(host, '_active', None), patch.object(host.sys, 'platform', 'win32'), \
                patch.object(host, '_CaptureRun', return_value=run):
            with self.assertRaises(host.CaptureError) as caught:
                host.record_capture(**self.request())
            self.assertEqual(caught.exception.code, 'capture_failed')
            self.assertIsNone(host._active)

    def test_job_cleanup_exception_stops_and_retains_the_owner_before_releasing_anything(self):
        host = self.host()
        run = host._CaptureRun(**self.request())
        calls = []
        def unknown_job():
            calls.append('job')
            raise OSError('PRIVATE_CANARY')
        run.job = SimpleNamespace(cleanup=unknown_job)
        run.signal = SimpleNamespace(request_stop=lambda: calls.append('stop_requested'),
                                     close=lambda: calls.append('signal_closed'))
        run.reservation = SimpleNamespace(close=lambda: calls.append('reservation_released'))
        self.assertFalse(run.cleanup())
        self.assertEqual(calls, ['stop_requested', 'job'])
        self.assertEqual(run.phase, 'hold')
        self.assertIsNotNone(run.job)
        self.assertIsNotNone(run.signal)
        self.assertIsNotNone(run.reservation)

    def test_reconcile_releases_only_after_a_fresh_known_cleanup_and_never_restarts_work(self):
        host = self.host()
        run = host._CaptureRun(**self.request())
        state = {'empty': False}
        run.job = SimpleNamespace(cleanup=lambda: state['empty'])
        run.run = lambda: self.fail('reconciliation must not start a recording')
        with patch.object(host, '_active', run):
            with self.assertRaises(host.CaptureError) as caught:
                host.reconcile_capture()
            self.assertEqual(caught.exception.code, 'capture_hold')
            self.assertIs(host._active, run)
            state['empty'] = True
            self.assertIsNone(host.reconcile_capture())
            self.assertIsNone(host._active)

    def test_unknown_job_or_ui_cleanup_never_releases_signal_or_reservation(self):
        host = self.host()
        for failure in ('job', 'files', 'ui', 'stop', 'reservation'):
            with self.subTest(failure=failure):
                trace = []
                run = host._CaptureRun(**self.request())
                def close(label):
                    trace.append(label)
                    if label == failure:
                        raise OSError('PRIVATE_CANARY')
                run.job = SimpleNamespace(cleanup=lambda: False if failure == 'job' else trace.append('job') or True)
                run.temporary = SimpleNamespace(cleanup=lambda: close('files'))
                run.controls = SimpleNamespace(recording_stopped=lambda **kwargs: trace.append('ack'), close=lambda: close('ui'))
                run.work_prepared = True
                run.signal = SimpleNamespace(request_stop=lambda: None, close=lambda: close('stop'))
                run.reservation = SimpleNamespace(close=lambda: close('reservation'))
                self.assertFalse(run.cleanup())
                if failure in ('job', 'files', 'ui'):
                    self.assertNotIn('stop', trace)
                    self.assertNotIn('reservation', trace)
                elif failure == 'stop':
                    self.assertNotIn('reservation', trace)
                self.assertEqual(run.phase, 'hold')

    def test_empty_job_cleanup_precedes_indicator_signal_and_reservation_release(self):
        host = self.host()
        trace = []
        run = host._CaptureRun(**self.request())
        run.job = SimpleNamespace(cleanup=lambda: trace.append('job_empty') or True)
        run.temporary = SimpleNamespace(cleanup=lambda: trace.append('files'))
        run.controls = SimpleNamespace(recording_stopped=lambda **kwargs: trace.append('ack'), close=lambda: trace.append('ui'))
        run.work_prepared = True
        run.signal = SimpleNamespace(request_stop=lambda: None, close=lambda: trace.append('stop'))
        run.reservation = SimpleNamespace(close=lambda: trace.append('reservation'))
        self.assertTrue(run.cleanup())
        self.assertEqual(trace, ['job_empty', 'files', 'ack', 'ui', 'stop', 'reservation'])
        self.assertEqual(run.phase, 'closed')
        self.assertTrue(run.cleanup())
        self.assertEqual(len(trace), 6)

    def test_foreign_owner_cannot_reconcile_or_release_the_desktop(self):
        host = self.host()
        run = host._CaptureRun(**self.request())
        trace, errors = [], []
        run.reservation = SimpleNamespace(close=lambda: trace.append('released'))
        def foreign():
            try:
                host.reconcile_capture()
            except host.CaptureError as error:
                errors.append(error.code)
        with patch.object(host, '_active', run):
            worker = threading.Thread(target=foreign)
            worker.start()
            worker.join(1)
            self.assertFalse(worker.is_alive())
            self.assertIs(host._active, run)
        self.assertEqual(errors, ['capture_owner_mismatch'])
        self.assertEqual(trace, [])


if __name__ == '__main__':
    unittest.main()
