# Copyright (c) 2026 Memlia. All rights reserved.
"""Real owned loopback TLS; no remote enrollment, CSR signing or Windows identity."""
import asyncio
import json
import os
import unittest
from unittest.mock import patch

import test_transport as fixtures
from memlia_agent import transport
from memlia_agent.user_credentials import CurrentUserCredentialStore

ENROLLMENT_ID = '00000000-0000-4000-8000-000000000001'
CHALLENGE = {
    'enrollmentId': ENROLLMENT_ID, 'code': 'a' * 43,
    'csrPem': '-----BEGIN CERTIFICATE REQUEST-----\npublic-fixture\n-----END CERTIFICATE REQUEST-----',
    'windowsSid': 'S-1-5-21-1-2-3-1001',
}
COMPLETE = {key: value for key, value in CHALLENGE.items() if key != 'windowsSid'}
COMPLETE['signature'] = 'cHJvb2Y'
CHALLENGE_RESULT = {'enrollmentId': ENROLLMENT_ID, 'challengePayload': 'bound-public-fixture', 'expiresAt': 301000}
UNKNOWN_RESULT = {'status': 'issuance_unknown', 'enrollmentId': ENROLLMENT_ID}
ISSUED_RESULT = {'status': 'issued', 'enrollmentId': ENROLLMENT_ID, 'agentId': 'agent-fixture',
    'issuanceId': 'issuance_01', 'bindingDigest': 'd' * 64,
    'certificate': {'certificateSerial': '02', 'certificateSha256': 'c' * 64,
                    'certificatePem': '-----BEGIN CERTIFICATE-----\npublic-fixture\n-----END CERTIFICATE-----',
                    'spkiSha256': 'b' * 64, 'notBefore': 1000, 'notAfter': 301000}}


class EnrollmentTransportTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        # Reuse the established fixture builder, without collecting its GET test cases.
        fixtures.PreparationTransportTests.setUpClass()
        cls.addClassCleanup(fixtures.PreparationTransportTests.tearDownClass)
        cls.ca = fixtures.PreparationTransportTests.ca
        cls.context = fixtures.PreparationTransportTests.server_tls
        cls.fixture_root = fixtures.PreparationTransportTests.root

    def channel(self, origin, **changes):
        options = {'origin': origin, 'ca_pem': self.ca, 'max_response_bytes': 65536,
                   'total_timeout_seconds': 1, 'max_connections': 1}
        options.update(changes)
        return transport.EnrollmentChannel(**options)

    async def test_challenge_posts_exact_bounded_body_to_only_the_fixed_path(self):
        raw = json.dumps(CHALLENGE_RESULT).encode()
        async with fixtures.TlsServer(self.context, fixtures.response(body=raw),
                                      max_request_body_bytes=196608) as server:
            with patch.object(CurrentUserCredentialStore, 'load', side_effect=AssertionError('no agent identity before issue')) as load:
                async with self.channel(server.origin) as channel:
                    self.assertEqual(await channel.challenge(CHALLENGE), CHALLENGE_RESULT)
                    self.assertFalse(hasattr(channel, 'post'))
                    self.assertFalse(hasattr(channel, 'post_json'))
                load.assert_not_called()
            self.assertEqual(len(server.requests), 1)
            self.assertTrue(server.requests[0].startswith(b'POST /api/desktop-agent-enrollments/challenge HTTP/1.1\r\n'))
            self.assertEqual(json.loads(server.request_bodies[0]), CHALLENGE)
            self.assertLessEqual(len(server.request_bodies[0]), 196608)
            headers = server.requests[0].lower()
            self.assertIn(b'content-type: application/json\r\n', headers)
            for name in [b'cookie:', b'authorization:', b'origin:']:
                self.assertNotIn(name, headers)

    async def test_complete_returns_explicit_unknown_202_once_without_retry(self):
        async with fixtures.TlsServer(self.context,
                fixtures.response(body=json.dumps(UNKNOWN_RESULT).encode(), status=202),
                max_request_body_bytes=196608) as server:
            async with self.channel(server.origin) as channel:
                self.assertEqual(await channel.complete(COMPLETE), UNKNOWN_RESULT)
            self.assertEqual(len(server.requests), 1)
            self.assertTrue(server.requests[0].startswith(b'POST /api/desktop-agent-enrollments/complete HTTP/1.1\r\n'))
            self.assertEqual(json.loads(server.request_bodies[0]), COMPLETE)

    async def test_contract_inputs_are_refused_before_any_request(self):
        changes = [
            ('challenge', {}),
            ('challenge', {**CHALLENGE, 'ownerUserId': 'foreign'}),
            ('challenge', {**CHALLENGE, 'enrollmentId': 'x' * 129}),
            ('challenge', {**CHALLENGE, 'code': 'a' * 42}),
            ('challenge', {**CHALLENGE, 'code': 'a' * 43 + '\n'}),
            ('challenge', {**CHALLENGE, 'csrPem': ''}),
            ('challenge', {**CHALLENGE, 'csrPem': 'x' * 16385}),
            ('challenge', {**CHALLENGE, 'csrPem': '\U0001f600' * 8193}),
            ('challenge', {**CHALLENGE, 'csrPem': 'bad\0csr'}),
            ('challenge', {**CHALLENGE, 'windowsSid': 'S-1-５-21'}),
            ('challenge', {**CHALLENGE, 'windowsSid': 'S-1-5-21\n'}),
            ('complete', {**COMPLETE, 'signature': 'x' * 8193}),
            ('complete', {**COMPLETE, 'signature': 'signature with spaces'}),
            ('complete', {**COMPLETE, 'windowsSid': CHALLENGE['windowsSid']}),
        ]
        async with fixtures.TlsServer(self.context,
                fixtures.response(body=json.dumps(CHALLENGE_RESULT).encode()),
                max_request_body_bytes=196608) as server:
            async with self.channel(server.origin) as channel:
                for kind, body in changes:
                    with self.subTest(kind=kind, keys=list(body)):
                        with self.assertRaises(transport.TransportError) as error:
                            await getattr(channel, kind)(body)
                        self.assertEqual(error.exception.code, 'invalid_enrollment_request')
                        self.assertIsNone(error.exception.__context__)
            self.assertEqual(server.requests, [])

    async def test_response_contract_rejects_foreign_private_or_mismatched_status(self):
        bad_certificate = {**ISSUED_RESULT, 'certificate': {**ISSUED_RESULT['certificate'], 'privateKey': 'FICTIONAL_PRIVATE'}}
        cases = [
            ('challenge', 200, {**CHALLENGE_RESULT, 'enrollmentId': 'foreign'}),
            ('challenge', 200, {**CHALLENGE_RESULT, 'challengePayload': ''}),
            ('challenge', 200, {**CHALLENGE_RESULT, 'expiresAt': True}),
            ('challenge', 200, {**CHALLENGE_RESULT, 'expiresAt': 10 ** 400}),
            ('complete', 200, UNKNOWN_RESULT),
            ('complete', 202, ISSUED_RESULT),
            ('complete', 200, bad_certificate),
            ('complete', 200, {**ISSUED_RESULT, 'certificate': {**ISSUED_RESULT['certificate'], 'notAfter': 1}}),
        ]
        for kind, status, result in cases:
            with self.subTest(kind=kind, status=status):
                async with fixtures.TlsServer(self.context,
                        fixtures.response(body=json.dumps(result).encode(), status=status),
                        max_request_body_bytes=196608) as server:
                    async with self.channel(server.origin) as channel:
                        with self.assertRaises(transport.TransportError) as error:
                            await getattr(channel, kind)(CHALLENGE if kind == 'challenge' else COMPLETE)
                        self.assertEqual(error.exception.code, 'invalid_enrollment_response')
                        self.assertNotIn('FICTIONAL_PRIVATE', str(error.exception))
                        self.assertIsNone(error.exception.__context__)
                    self.assertEqual(len(server.requests), 1)

    async def test_issued200_preserves_public_fields_at_request_field_bounds(self):
        body = {**COMPLETE, 'csrPem': 'x' * 16384, 'signature': 'a' * 8192}
        async with fixtures.TlsServer(self.context,
                fixtures.response(body=json.dumps(ISSUED_RESULT).encode()),
                max_request_body_bytes=196608) as server:
            async with self.channel(server.origin) as channel:
                self.assertEqual(await channel.complete(body), ISSUED_RESULT)
            self.assertEqual(json.loads(server.request_bodies[0]), body)
            length = len(server.request_bodies[0])
            self.assertIn(f'Content-Length: {length}\r\n'.encode(), server.requests[0])
            self.assertLessEqual(length, 196608)

    async def test_encoder_fault_cannot_send_over_the_hard_request_byte_cap(self):
        async with fixtures.TlsServer(self.context, fixtures.response(),
                                      max_request_body_bytes=196608) as server:
            async with self.channel(server.origin) as channel:
                # Fault injection, not a claim that valid bounded fields reach this cap.
                with patch.object(transport.json, 'dumps', return_value='x' * 196609):
                    with self.assertRaises(transport.TransportError) as error:
                        await channel.challenge(CHALLENGE)
                self.assertEqual(error.exception.code, 'request_too_large')
            self.assertEqual(server.requests, [])

    async def test_malformed_compressed_oversize_and_error_responses_never_retry(self):
        cases = [(b'{"raw":"FICTIONAL_PRIVATE"', 200, b'', 'invalid_json'),
                 (b'{"x":true,"x":false}', 200, b'', 'invalid_json'),
                 (b'x' * 129, 200, b'', 'response_too_large'),
                 (b'{}', 200, b'Content-Encoding: gzip\r\n', 'compression_refused'),
                 (b'FICTIONAL_PRIVATE', 503, b'', 'http_status_refused')]
        for body, status, extra, code in cases:
            with self.subTest(code=code):
                async with fixtures.TlsServer(self.context,
                        fixtures.response(body=body, status=status, extra=extra),
                        max_request_body_bytes=196608) as server:
                    async with self.channel(server.origin, max_response_bytes=128) as channel:
                        with self.assertRaises(transport.TransportError) as error:
                            await channel.challenge(CHALLENGE)
                        self.assertEqual(error.exception.code, code)
                        self.assertNotIn('FICTIONAL_PRIVATE', str(error.exception))
                        self.assertIsNone(error.exception.__cause__)
                        self.assertIsNone(error.exception.__context__)
                    self.assertEqual(len(server.requests), 1)

    async def test_redirect_never_forwards_a_code_to_the_second_listener(self):
        async with fixtures.TlsServer(self.context, fixtures.response(),
                                      max_request_body_bytes=196608) as other:
            extra = f'Location: {other.origin}/never\r\n'.encode()
            async with fixtures.TlsServer(self.context,
                    fixtures.response(status=307, extra=extra), max_request_body_bytes=196608) as server:
                async with self.channel(server.origin) as channel:
                    with self.assertRaises(transport.TransportError) as error:
                        await channel.complete(COMPLETE)
                    self.assertEqual(error.exception.code, 'redirect_refused')
                self.assertEqual(len(server.requests), 1)
            self.assertEqual(other.requests, [])

    async def test_no_cookies_proxy_ca_or_keylog_from_ambient_state(self):
        keylog = self.fixture_root / 'enrollment-no-keylog.log'
        poison = {'HTTPS_PROXY': 'http://127.0.0.1:1', 'ALL_PROXY': 'http://127.0.0.1:1',
                  'SSL_CERT_FILE': str(self.fixture_root / 'absent.pem'),
                  'SSL_CERT_DIR': str(self.fixture_root / 'absent-dir'), 'SSLKEYLOGFILE': str(keylog)}
        async with fixtures.TlsServer(self.context,
                fixtures.response(body=json.dumps(CHALLENGE_RESULT).encode(),
                                  extra=b'Set-Cookie: private=FICTIONAL; Secure; Path=/\r\n'),
                max_request_body_bytes=196608) as server:
            with patch.dict(os.environ, poison):
                async with self.channel(server.origin) as channel:
                    for _ in range(2):
                        self.assertEqual(await channel.challenge(CHALLENGE), CHALLENGE_RESULT)
                    self.assertEqual(len(channel._client.cookies), 0)
            for request in server.requests:
                lower = request.lower()
                for field in [b'cookie:', b'authorization:', b'origin:']:
                    self.assertNotIn(field, lower)
                self.assertIn(b'accept-encoding: identity\r\n', lower)
            self.assertEqual(len(server.requests), 2)
            self.assertFalse(keylog.exists())

    async def test_tls_peer_refusal_precedes_any_code_delivery(self):
        for context, ca in [(self.context, fixtures.PreparationTransportTests.foreign_ca),
                            (fixtures.PreparationTransportTests.wrong_name_tls, self.ca),
                            (fixtures.PreparationTransportTests.expired_tls, self.ca)]:
            async with fixtures.TlsServer(context, fixtures.response(),
                                          max_request_body_bytes=196608) as server:
                async with self.channel(server.origin, ca_pem=ca) as channel:
                    with self.assertRaises(transport.TransportError) as error:
                        await channel.challenge(CHALLENGE)
                    self.assertEqual(error.exception.code, 'tls_failed')
                self.assertEqual(server.requests, [])
                self.assertEqual(server.connections, 1)

    async def test_absolute_deadline_bounds_dripping_post_response(self):
        async def drip(writer, _):
            writer.write(b'HTTP/1.1 200 fixture\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n')
            await writer.drain()
            for _ in range(30):
                writer.write(b' ')
                await writer.drain()
                await asyncio.sleep(.025)
        async with fixtures.TlsServer(self.context, drip, max_request_body_bytes=196608) as server:
            async with self.channel(server.origin, total_timeout_seconds=.1) as channel:
                with self.assertRaises(transport.TransportError) as error:
                    await channel.challenge(CHALLENGE)
                self.assertEqual(error.exception.code, 'request_timeout')
            self.assertEqual(len(server.requests), 1)

    async def test_cancelled_post_is_not_retried_and_pool_remains_owned(self):
        entered = asyncio.Event()
        async def handler(writer, n):
            if n == 1:
                entered.set()
                await asyncio.sleep(5)
            else:
                await fixtures.response(body=json.dumps(CHALLENGE_RESULT).encode())(writer, n)
        async with fixtures.TlsServer(self.context, handler, max_request_body_bytes=196608) as server:
            async with self.channel(server.origin) as channel:
                task = asyncio.create_task(channel.challenge(CHALLENGE))
                await asyncio.wait_for(entered.wait(), 1)
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
                self.assertEqual(len(server.requests), 1)
                self.assertEqual(await channel.challenge(CHALLENGE), CHALLENGE_RESULT)
            self.assertEqual(len(server.requests), 2)

    async def test_caller_mutation_cannot_change_a_sent_enrollment_binding(self):
        entered, release = asyncio.Event(), asyncio.Event()
        async def handler(writer, n):
            entered.set()
            await release.wait()
            await fixtures.response(body=json.dumps(CHALLENGE_RESULT).encode())(writer, n)
        async with fixtures.TlsServer(self.context, handler, max_request_body_bytes=196608) as server:
            async with self.channel(server.origin) as channel:
                body = dict(CHALLENGE)
                task = asyncio.create_task(channel.challenge(body))
                await asyncio.wait_for(entered.wait(), 1)
                body['enrollmentId'] = 'foreign'
                body['code'] = 'b' * 43
                release.set()
                self.assertEqual(await task, CHALLENGE_RESULT)
            self.assertEqual(json.loads(server.request_bodies[0]), CHALLENGE)

    async def test_pool_close_failure_is_explicit_and_disables_posts(self):
        channel = self.channel('https://fixture.invalid')
        original = channel._client.aclose
        async def broken_close():
            raise OSError('FICTIONAL_PRIVATE_CLOSE')
        try:
            with patch.object(channel._client, 'aclose', side_effect=broken_close):
                with self.assertRaises(transport.TransportError) as error:
                    await channel.aclose()
                self.assertEqual(error.exception.code, 'close_failed')
                self.assertIsNone(error.exception.__context__)
                with self.assertRaises(transport.TransportError) as error:
                    await channel.challenge(CHALLENGE)
                self.assertEqual(error.exception.code, 'channel_closed')
        finally:
            await original()

    async def test_late_contract_validation_cannot_deliver_after_deadline(self):
        import time
        native = transport._enrollment_result
        def delayed(*args):
            value = native(*args)
            time.sleep(.12)
            return value
        async with fixtures.TlsServer(self.context,
                fixtures.response(body=json.dumps(CHALLENGE_RESULT).encode()),
                max_request_body_bytes=196608) as server:
            async with self.channel(server.origin, total_timeout_seconds=.1) as channel:
                with patch.object(transport, '_enrollment_result', side_effect=delayed):
                    with self.assertRaises(transport.TransportError) as error:
                        await channel.challenge(CHALLENGE)
                self.assertEqual(error.exception.code, 'request_timeout')
            self.assertEqual(len(server.requests), 1)

    async def test_cancellation_during_contract_validation_beats_delivery(self):
        native = transport._enrollment_result
        def cancelled(*args):
            value = native(*args)
            asyncio.current_task().cancel()
            return value
        async with fixtures.TlsServer(self.context,
                fixtures.response(body=json.dumps(CHALLENGE_RESULT).encode()),
                max_request_body_bytes=196608) as server:
            async with self.channel(server.origin) as channel:
                with patch.object(transport, '_enrollment_result', side_effect=cancelled):
                    task = asyncio.create_task(channel.challenge(CHALLENGE))
                    with self.assertRaises(asyncio.CancelledError):
                        await task
            self.assertEqual(len(server.requests), 1)

    async def test_new_binding_fields_are_required_and_closed_on_issued_responses(self):
        for missing in ('issuanceId','bindingDigest'):
            body={key:value for key,value in ISSUED_RESULT.items() if key!=missing}
            async with fixtures.TlsServer(self.context,fixtures.response(body=json.dumps(body).encode()),
                    max_request_body_bytes=196608) as server:
                async with self.channel(server.origin) as channel:
                    with self.assertRaises(transport.TransportError) as error:
                        await channel.complete(COMPLETE)
                    self.assertEqual(error.exception.code,'invalid_enrollment_response')
                self.assertEqual(len(server.requests),1)
