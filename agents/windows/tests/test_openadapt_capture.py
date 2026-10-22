# Copyright (c) 2026 Memlia. All rights reserved.
"""Native boundaries doubled; no Windows consent or desktop capture qualification."""
import importlib.util
from contextlib import ExitStack
import json
import math
from pathlib import Path
import os
import sys
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from memlia_agent.capture_input_filter import CaptureInputFactory
from memlia_agent.owned_job import JobOutput, JobState
from memlia_agent.capture_controls import CaptureUnavailable, _CaptureControls as NativeControls
from memlia_agent.stop import StopRequested


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


class CaptureCompositionTests(unittest.TestCase):
    """Native UI/session/Job boundaries doubled; real host and filesystem lifecycle."""
    def composed(self, *, forced=False, malformed=False, clean=True, revoke=False,
                 consent=True, cancel=False, poll_error=False, partial_preparing=False):
        host = __import__('memlia_agent.openadapt_capture', fromlist=['record_capture'])
        trace, job_values, state = [], [], {'started': False, 'ready': False}
        deadline = time.monotonic() + 30
        class Reservation:
            def close(self): trace.append('release')
        class Stop:
            def __init__(self, *args, **kwargs): pass
            def _start(self): trace.append('stop_armed')
            def request_stop(self): trace.append('stop_requested')
            def close(self): trace.append('stop_closed')
        class Controls:
            def __init__(self, *args):
                self._lock = threading.RLock()
                self._work_pending = self._recording_started = self._recording_stopped = False
            def _start(self):
                if not consent: raise CaptureUnavailable('local_consent_unavailable')
                trace.append('consented')
            def consent_observation(self,**kwargs):
                return {'consentId':'fictitious-consent','confirmedLocallyAt':'2026-10-21T18:00:00.000Z',
                        'commandDigest':DIGEST,'windowsSid':'S-1-5-21-1','sessionId':'1'}
            def checkpoint(self, **kwargs):
                if cancel or partial_preparing and self._work_pending:
                    raise StopRequested('stop_requested')
                trace.append('indicator')
            def recording_preparing(self, **kwargs):
                trace.append('preparing')
                if partial_preparing: return NativeControls.recording_preparing(self, **kwargs)
            def recording_started(self, **kwargs):
                state['ready'] = True
                trace.append('started')
            def finish_requested(self, **kwargs): return state['ready']
            def recording_stopped(self, **kwargs):
                trace.append('ack');self._work_pending = False
            def close(self):
                if self._work_pending: raise CaptureUnavailable('capture_cleanup_unverified')
                trace.append('ui_closed')
        class Job:
            def __init__(self, **kwargs):
                job_values.append(kwargs)
                self.root = Path(kwargs['cwd'])
            def start(self):
                trace.append('job_start')
                (self.root / 'ready').write_bytes((DIGEST + '\n').encode())
            def poll(self):
                if poll_error: raise OSError('PRIVATE_POLL_FAILURE')
                if (self.root / 'finish').exists():
                    trace.append('finish')
                    for name in ('capture', 'recording'): (self.root / name).mkdir(exist_ok=True)
                    (self.root / 'capture' / 'recording.db').write_bytes(b'fictitious-raw')
                    (self.root / 'recording' / 'meta.json').write_bytes(b'{}')
                    (self.root / 'recording' / 'events.jsonl').write_bytes(b'{}\n')
                    return JobState(0, True, 0, forced, True)
                return JobState(1, False, None, False, False)
            def take_output(self):
                trace.append('output_taken')
                if poll_error:
                    return JobOutput(b'partial-json', b'PRIVATE_NATIVE_DIAGNOSTIC', False, False, False)
                payload = b'PRIVATE_CANARY' if malformed else json.dumps(
                    {'status': 'recorded', 'operationDigest': DIGEST}).encode()
                return JobOutput(payload, b'', True, True, True)
            def cleanup(self): trace.append('job_closed');return clean
        def authority():
            trace.append('authority')
            if revoke and state['ready']: raise OSError('PRIVATE_CANARY')
        factory = CaptureInputFactory(1, 2, 3, 4, 'S-1-5-21-1', 1, DIGEST, deadline)
        stack = ExitStack()
        stack.enter_context(patch.dict(os.environ, {'SYSTEMROOT': 'C:\\Windows'}))
        for name, value in {'_runtime_ready': lambda: None, 'reserve_desktop': Reservation,
                            'LocalStop': Stop, '_CaptureControls': Controls, 'OwnedJob': Job}.items():
            stack.enter_context(patch.object(host, name, value, create=True))
        stack.enter_context(patch.object(host.sys, 'platform', 'win32'))
        stack.enter_context(patch.object(host, '_active', None))
        stack.enter_context(patch.object(CaptureInputFactory, 'from_controls', return_value=factory))
        return host, stack, dict(operation_digest=DIGEST, deadline_monotonic=deadline,
                                max_bytes=4096, revalidate=authority), trace, job_values

    def test_consent_hook_follows_local_decision_and_precedes_worker(self):
        host,stack,request,trace,jobs=self.composed()
        def accepted(observation):
            self.assertEqual(observation['commandDigest'],DIGEST)
            trace.append('server_consent')
        request['on_local_consent']=accepted
        with stack:
            host.record_capture(**request)
        self.assertLess(trace.index('consented'),trace.index('server_consent'))
        self.assertLess(trace.index('server_consent'),trace.index('job_start'))

    def test_refused_consent_hook_never_starts_capture(self):
        host,stack,request,trace,jobs=self.composed()
        request['on_local_consent']=lambda observation:True
        with stack,self.assertRaises(host.CaptureError): host.record_capture(**request)
        self.assertNotIn('job_start',trace)

    def test_composed_capture_delivers_bytes_only_after_normal_exit_and_every_cleanup(self):
        host, stack, request, trace, jobs = self.composed()
        with stack:
            result = host.record_capture(**request)
            self.assertIsNone(host._active)
        self.assertEqual(dict(result.files), {'events.jsonl': b'{}\n', 'meta.json': b'{}'})
        self.assertEqual(dict(result.raw_files), {'recording.db': b'fictitious-raw'})
        self.assertEqual(result.operation_digest, DIGEST)
        self.assertLess(trace.index('consented'), trace.index('job_start'))
        self.assertLess(trace.index('preparing'), trace.index('job_start'))
        self.assertLess(trace.index('started'), trace.index('finish'))
        self.assertLess(trace.index('job_closed'), trace.index('ack'))
        self.assertEqual([x for x in trace if x in ('ack','ui_closed','stop_closed','release')],
                         ['ack','ui_closed','stop_closed','release'])
        self.assertFalse(Path(jobs[0]['cwd']).exists())
        self.assertEqual(jobs[0]['arguments'], ('-I','-m','memlia_agent.openadapt_capture_worker'))
        self.assertNotIn('PYTHONPATH', jobs[0]['environment'])

    def test_authority_lost_after_ready_never_requests_normal_finish(self):
        host, stack, request, trace, jobs = self.composed(revoke=True)
        with stack, self.assertRaises(host.CaptureError) as caught:
            host.record_capture(**request)
        self.assertEqual(caught.exception.code, 'capture_authority_unavailable')
        self.assertNotIn('finish', trace)
        self.assertIn('job_closed', trace)

    def test_forced_exit_and_malformed_output_cannot_deliver_a_capture(self):
        for options in ({'forced': True}, {'malformed': True}):
            with self.subTest(options=options):
                host, stack, request, trace, jobs = self.composed(**options)
                with stack, self.assertRaises(host.CaptureError) as caught:
                    host.record_capture(**request)
                self.assertEqual(caught.exception.code, 'capture_worker_refused')
                self.assertIsNone(caught.exception.__context__)

    def test_unknown_cleanup_suppresses_valid_result_and_retains_owned_resources(self):
        host, stack, request, trace, jobs = self.composed(clean=False)
        with stack:
            with self.assertRaises(host.CaptureError) as caught: host.record_capture(**request)
            self.assertEqual(caught.exception.code, 'capture_hold')
            self.assertIsNotNone(host._active)
            self.assertTrue(Path(jobs[0]['cwd']).exists())
            self.assertNotIn('ack', trace)
            self.assertNotIn('release', trace)
            # Test-only owned fixture cleanup, not a production retry.
            host._active.temporary.cleanup()

    def test_declined_consent_or_local_emergency_never_starts_a_worker(self):
        for options, code in [({'consent': False}, 'capture_consent_unavailable'),
                              ({'cancel': True}, 'capture_cancelled')]:
            with self.subTest(options=options):
                host, stack, request, trace, jobs = self.composed(**options)
                with stack, self.assertRaises(host.CaptureError) as caught:
                    host.record_capture(**request)
                self.assertEqual(caught.exception.code, code)
                self.assertNotIn('job_start', trace)
                self.assertIn('release', trace)

    def test_refused_poll_preserves_partial_native_diagnostics_after_owned_job_cleanup(self):
        host, stack, request, trace, jobs = self.composed(poll_error=True)
        with stack, self.assertRaises(host.CaptureError) as caught: host.record_capture(**request)
        self.assertEqual(caught.exception.code, 'capture_failed')
        self.assertNotIn('PRIVATE_', str(caught.exception))
        self.assertIsNotNone(caught.exception.private_output)
        output = caught.exception.private_output
        self.assertEqual(output.stdout, b'partial-json')
        self.assertEqual(output.stderr, b'PRIVATE_NATIVE_DIAGNOSTIC')
        self.assertEqual((output.stdin_complete, output.stdout_eof, output.stderr_eof), (False,False,False))
        self.assertLess(trace.index('job_closed'), trace.index('output_taken'))
        self.assertEqual(trace.count('output_taken'), 1)
        self.assertNotIn('finish', trace)

    def test_cancellation_inside_native_preparing_still_acknowledges_known_empty_job(self):
        host, stack, request, trace, jobs = self.composed(partial_preparing=True)
        with stack, self.assertRaises(host.CaptureError) as caught: host.record_capture(**request)
        self.assertEqual(caught.exception.code, 'capture_cancelled')
        self.assertNotIn('job_start', trace)
        self.assertEqual([x for x in trace if x in ('job_closed','ack','ui_closed','release')],
                         ['job_closed','ack','ui_closed','release'])


if __name__ == '__main__':
    unittest.main()
