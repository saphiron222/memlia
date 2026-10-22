# Copyright (c) 2026 Memlia. All rights reserved.
"""Real TLS on owned loopback sockets; certificates are generated test-only."""
import asyncio
import datetime
import ipaddress
import json
import os
from pathlib import Path
import ssl
import tempfile
import time
import unittest
from unittest.mock import patch

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

try:
    from memlia_agent import transport
except ImportError:
    transport = None


class TlsServer:
    """One request per connection, no external network, bounded parser for fixtures."""
    def __init__(self, context, handler, *, max_request_body_bytes=0):
        self.context, self.handler = context, handler
        self.max_request_body_bytes = max_request_body_bytes
        self.request_bodies = []
        self.requests, self.tasks, self.writers = [], set(), set()
        self.connections = 0

    async def __aenter__(self):
        self.server = await asyncio.start_server(self.accept, '127.0.0.1', 0,
                                               )
        self.port = self.server.sockets[0].getsockname()[1]
        self.origin = f'https://127.0.0.1:{self.port}'
        return self

    async def accept(self, reader, writer):
        self.connections += 1
        task = asyncio.current_task()
        self.tasks.add(task)
        self.writers.add(writer)
        try:
            await writer.start_tls(self.context, ssl_handshake_timeout=1)
            headers = await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'), 1)
            lengths = [line.split(b':', 1)[1].strip() for line in headers.split(b'\r\n')
                       if line.lower().startswith(b'content-length:')]
            if len(lengths) > 1:
                raise ValueError('duplicate fixture length')
            length = int(lengths[0]) if lengths else 0
            if not 0 <= length <= self.max_request_body_bytes:
                raise ValueError('fixture request body limit')
            body = await asyncio.wait_for(reader.readexactly(length), 1) if length else b''
            self.request_bodies.append(body)
            self.requests.append(headers)
            await self.handler(writer, len(self.requests))
        except (asyncio.TimeoutError, ConnectionError, asyncio.IncompleteReadError, ssl.SSLError, ValueError):
            pass
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except (ConnectionError, ssl.SSLError):
                pass
            self.writers.discard(writer)
            self.tasks.discard(task)

    async def __aexit__(self, *exc):
        self.server.close()
        await self.server.wait_closed()
        for writer in list(self.writers):
            writer.close()
        for task in list(self.tasks):
            task.cancel()
        if self.tasks:
            await asyncio.gather(*list(self.tasks), return_exceptions=True)


def response(body=b'{"prepared":true}', status=200, extra=b''):
    async def serve(writer, _):
        writer.write(f'HTTP/1.1 {status} fixture\r\n'.encode() +
                     b'Content-Type: application/json\r\nConnection: close\r\n' +
                     f'Content-Length: {len(body)}\r\n'.encode() + extra + b'\r\n' + body)
        await writer.drain()
    return serve


class PreparationTransportTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix='memlia-fictional-tls-')
        cls.root = Path(cls.tmp.name)
        now = datetime.datetime.now(datetime.timezone.utc)
        def ca(label):
            key = ec.generate_private_key(ec.SECP256R1())
            name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, label)])
            cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
                    .public_key(key.public_key()).serial_number(x509.random_serial_number())
                    .not_valid_before(now-datetime.timedelta(days=1))
                    .not_valid_after(now+datetime.timedelta(days=1))
                    .add_extension(x509.BasicConstraints(ca=True, path_length=0), True)
                    .add_extension(x509.KeyUsage(False,False,False,False,False,True,True,False,False), True)
                    .sign(key, hashes.SHA256()))
            return key, cert
        key, cert = ca('Memlia fictional test CA')
        _, foreign = ca('Memlia foreign fictional test CA')
        cls.ca = cert.public_bytes(serialization.Encoding.PEM)
        cls.foreign_ca = foreign.public_bytes(serialization.Encoding.PEM)
        def server(label, san, expired=False):
            private = ec.generate_private_key(ec.SECP256R1())
            subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, label)])
            leaf = (x509.CertificateBuilder().subject_name(subject).issuer_name(cert.subject)
                    .public_key(private.public_key()).serial_number(x509.random_serial_number())
                    .not_valid_before(now-datetime.timedelta(days=2))
                    .not_valid_after(now-datetime.timedelta(days=1) if expired else now+datetime.timedelta(hours=1))
                    .add_extension(x509.SubjectAlternativeName([san]),False)
                    .add_extension(x509.BasicConstraints(ca=False,path_length=None),True)
                    .add_extension(x509.ExtendedKeyUsage([x509.oid.ExtendedKeyUsageOID.SERVER_AUTH]),False)
                    .sign(key, hashes.SHA256()))
            certpath, keypath = cls.root/(label+'.pem'), cls.root/(label+'-encrypted.pem')
            certpath.write_bytes(leaf.public_bytes(serialization.Encoding.PEM))
            # All keys fictional and encrypted even in test fixtures; no global trust.
            keypath.write_bytes(private.private_bytes(serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.BestAvailableEncryption(b'fictional-test-only-passphrase')))
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ctx.minimum_version = ssl.TLSVersion.TLSv1_2
            ctx.load_cert_chain(certpath,keypath,password=b'fictional-test-only-passphrase')
            return ctx
        cls.server_tls = server('expected', x509.IPAddress(ipaddress.ip_address('127.0.0.1')))
        cls.wrong_name_tls = server('wrong-name', x509.DNSName('foreign.invalid'))
        cls.expired_tls = server('expired', x509.IPAddress(ipaddress.ip_address('127.0.0.1')), True)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def channel(self, origin, **kwargs):
        self.assertIsNotNone(transport, 'The preparation HTTPS transport is not implemented')
        return transport.PreparationChannel(origin=origin, ca_pem=kwargs.pop('ca_pem',self.ca),
            max_response_bytes=kwargs.pop('max_response_bytes',65536),
            total_timeout_seconds=kwargs.pop('total_timeout_seconds',1),
            max_connections=kwargs.pop('max_connections',2), **kwargs)

    async def test_00_first_suite_call_refuses_late_json_without_wall_time_claim(self):
        decoder=json.loads
        def slow(*args,**kwargs):
            value=decoder(*args,**kwargs)
            time.sleep(.15)
            return value
        # First channel call in this suite, after imports and fixture setup.
        # This is NOT a measurement of a cold interpreter startup. If decoding
        # is reached, its controlled delay also exceeds the cooperative budget.
        async with TlsServer(self.server_tls,response()) as server:
            async with self.channel(server.origin,total_timeout_seconds=.12) as channel:
                start=asyncio.get_running_loop().time()
                with patch.object(transport.json,'loads',side_effect=slow):
                    with self.assertRaises(transport.TransportError) as error:
                        await channel.get_json('/cold-fixture')
                self.assertEqual(error.exception.code,'request_timeout')
                print('MEMLIA_FIRST_CALL_OBSERVATION '+json.dumps({
                    'elapsedSeconds':round(asyncio.get_running_loop().time()-start,6),
                    'lateJsonDelivered':False,'wallTimeCeilingClaimed':False,
                    'interpreterColdStartMeasured':False}))

    async def test_server_only_t1_does_not_read_windows_credentials(self):
        from memlia_agent.user_credentials import CurrentUserCredentialStore
        async with TlsServer(self.server_tls, response()) as server:
            with patch.object(CurrentUserCredentialStore, 'load', side_effect=AssertionError('Unexpected credential read')) as load:
                async with self.channel(server.origin) as channel:
                    self.assertEqual(await channel.get_json('/server-only-fixture'), {'prepared': True})
            load.assert_not_called()
            self.assertEqual(len(server.requests), 1)

    async def test_verified_tls_returns_json_without_exposing_client(self):
        async with TlsServer(self.server_tls,response()) as server:
            async with self.channel(server.origin) as channel:
                self.assertEqual(await channel.get_json('/preparation-fixture'), {'prepared':True})
                self.assertFalse(hasattr(channel,'client'))
                self.assertFalse(hasattr(channel,'post'))
            self.assertEqual(len(server.requests),1)
            self.assertTrue(server.requests[0].startswith(b'GET /preparation-fixture HTTP/1.1\r\n'))

    async def test_untrusted_wrong_name_and_expired_tls_refused(self):
        for context, ca in [(self.server_tls,self.foreign_ca),(self.wrong_name_tls,self.ca),
                            (self.expired_tls,self.ca)]:
            with self.subTest(context=context,foreign_ca=ca is self.foreign_ca):
                async with TlsServer(context,response()) as server:
                    channel = self.channel(server.origin,ca_pem=ca)
                    async with channel:
                        with self.assertRaises(transport.TransportError) as error:
                            await channel.get_json('/fixture')
                        self.assertEqual(error.exception.code,'tls_failed')
                        self.assertIsNone(error.exception.__cause__)
                    self.assertEqual(server.requests,[])
                    self.assertEqual(server.connections,1)

    async def test_foreign_destinations_and_query_rejected_before_send(self):
        async with TlsServer(self.server_tls,response()) as server:
            async with self.channel(server.origin) as channel:
                for path in ['https://foreign.invalid/','//foreign.invalid/','http://127.0.0.1/',
                             '/fixture?secret=fictional','/fixture#fragment','/../x','/%2e%2e/x',
                             '/x\\y','/x\r\nHost: foreign.invalid','', '/', '/x%2fy']:
                    with self.subTest(path=path):
                        with self.assertRaises(transport.TransportError) as error:
                            await channel.get_json(path)
                        self.assertEqual(error.exception.code,'invalid_path')
                self.assertEqual(server.requests,[])

    async def test_redirect_never_reaches_second_listener(self):
        async with TlsServer(self.server_tls,response()) as other:
            redirect = f'Location: {other.origin}/never\r\n'.encode()
            async with TlsServer(self.server_tls,response(status=307,extra=redirect)) as server:
                async with self.channel(server.origin) as channel:
                    with self.assertRaises(transport.TransportError) as error:
                        await channel.get_json('/fixture')
                    self.assertEqual(error.exception.code,'redirect_refused')
                self.assertEqual(len(server.requests),1)
                self.assertEqual(other.requests,[])

    async def test_compression_and_oversized_body_refused(self):
        cases=[(b'{}',b'Content-Encoding: gzip\r\n','compression_refused'),
               (b'x'*129,b'','response_too_large')]
        for body,extra,code in cases:
            async with TlsServer(self.server_tls,response(body=body,extra=extra)) as server:
                async with self.channel(server.origin,max_response_bytes=128) as channel:
                    with self.assertRaises(transport.TransportError) as error:
                        await channel.get_json('/fixture')
                    self.assertEqual(error.exception.code,code)

    async def test_cookies_and_ambient_proxy_ca_keylog_are_not_used(self):
        keylog = self.root/'must-not-exist.log'
        poison = {'HTTPS_PROXY':'http://127.0.0.1:1','ALL_PROXY':'http://127.0.0.1:1',
                  'SSL_CERT_FILE':str(self.root/'absent-ca.pem'),
                  'SSL_CERT_DIR':str(self.root/'absent-ca-dir'),'SSLKEYLOGFILE':str(keylog)}
        async with TlsServer(self.server_tls,response(extra=b'Set-Cookie: private=fictional; Secure; Path=/\r\n')) as server:
            with patch.dict(os.environ,poison):
                async with self.channel(server.origin) as channel:
                    for _ in range(2):
                        self.assertEqual(await channel.get_json('/fixture'),{'prepared':True})
                    self.assertEqual(len(channel._client.cookies),0)
            self.assertEqual(len(server.requests),2)
            for request in server.requests:
                lower=request.lower()
                self.assertNotIn(b'cookie:',lower)
                self.assertNotIn(b'authorization:',lower)
                self.assertIn(b'accept-encoding: identity\r\n',lower)
                self.assertIn(f'host: 127.0.0.1:{server.port}\r\n'.encode(),lower)
            self.assertFalse(keylog.exists())

    async def test_absolute_deadline_bounds_dripping_response(self):
        # Explicit public-API fixture warmup, with a distinct channel/server.
        # The measured channel below retains exactly .12s / .65s.
        async with TlsServer(self.server_tls,response()) as warm_server:
            async with self.channel(warm_server.origin,total_timeout_seconds=2) as warm:
                self.assertEqual(await warm.get_json('/warmup-fixture'),{'prepared':True})
            self.assertEqual(len(warm_server.requests),1)
        async def drip(writer,n):
            writer.write(b'HTTP/1.1 200 fixture\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n')
            await writer.drain()
            for _ in range(30):
                writer.write(b' ')
                await writer.drain()
                await asyncio.sleep(.025)
        async with TlsServer(self.server_tls,drip) as server:
            async with self.channel(server.origin,total_timeout_seconds=.12) as channel:
                start=asyncio.get_running_loop().time()
                with self.assertRaises(transport.TransportError) as error:
                    await channel.get_json('/fixture')
                self.assertEqual(error.exception.code,'request_timeout')
                self.assertLess(asyncio.get_running_loop().time()-start,.65)
            self.assertEqual(len(server.requests),1)

    async def test_cancel_during_response_propagates_and_next_call_works(self):
        entered=asyncio.Event()
        async def handler(writer,n):
            if n==1:
                entered.set()
                await asyncio.sleep(5)
            else:
                await response()(writer,n)
        async with TlsServer(self.server_tls,handler) as server:
            async with self.channel(server.origin,max_connections=1) as channel:
                task=asyncio.create_task(channel.get_json('/fixture'))
                await asyncio.wait_for(entered.wait(),1)
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
                self.assertEqual(await channel.get_json('/fixture'),{'prepared':True})
            self.assertEqual(len(server.requests),2)

    async def test_invalid_json_and_status_do_not_leak_response(self):
        for body,status,code in [(b'{"raw":"FICTIONAL_PRIVATE"',200,'invalid_json'),
                                 (b'{"number":NaN}',200,'invalid_json'),
                                 (b'FICTIONAL_PRIVATE',503,'http_status_refused')]:
            async with TlsServer(self.server_tls,response(body=body,status=status)) as server:
                async with self.channel(server.origin) as channel:
                    with self.assertRaises(transport.TransportError) as error:
                        await channel.get_json('/fixture')
                    self.assertEqual(error.exception.code,code)
                    self.assertNotIn('FICTIONAL_PRIVATE',str(error.exception))
                    self.assertIsNone(error.exception.__cause__)
                self.assertEqual(len(server.requests),1)


    async def test_json_overflow_duplicate_keys_and_bad_utf8_are_refused(self):
        for body in [b'{"x":1e999}', b'{"x":true,"x":false}', b'{"x":"\xff"}']:
            async with TlsServer(self.server_tls,response(body=body)) as server:
                async with self.channel(server.origin) as channel:
                    with self.assertRaises(transport.TransportError) as error:
                        await channel.get_json('/fixture')
                    self.assertEqual(error.exception.code,'invalid_json')
                    self.assertIsNone(error.exception.__cause__)
                    self.assertIsNone(error.exception.__context__)

    async def test_connection_bound_and_cancelled_waiter_never_sends(self):
        entered=asyncio.Event()
        release=asyncio.Event()
        active=0
        peak=0
        async def hold(writer,n):
            nonlocal active,peak
            active+=1
            peak=max(active,peak)
            try:
                entered.set()
                await release.wait()
                await response()(writer,n)
            finally:
                active-=1
        async with TlsServer(self.server_tls,hold) as server:
            async with self.channel(server.origin,max_connections=1,total_timeout_seconds=.2) as channel:
                first=asyncio.create_task(channel.get_json('/first'))
                await asyncio.wait_for(entered.wait(),1)
                second=asyncio.create_task(channel.get_json('/second'))
                await asyncio.sleep(.025)
                second.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await second
                self.assertEqual(len(server.requests),1)
                with self.assertRaises(transport.TransportError) as error:
                    await first
                self.assertEqual(error.exception.code,'request_timeout')
                release.set()
                self.assertEqual(peak,1)
                # Cancellation before entering the coroutine must never send.
                never=asyncio.create_task(channel.get_json('/never'))
                never.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await never
                self.assertEqual(len(server.requests),1)

    async def test_chunked_size_bound_and_no_retry_after_connection_close(self):
        async def large(writer,_):
            writer.write(b'HTTP/1.1 200 fixture\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n80\r\n'+b'x'*128+b'\r\n80\r\n'+b'y'*128+b'\r\n0\r\n\r\n')
            await writer.drain()
        async with TlsServer(self.server_tls,large) as server:
            async with self.channel(server.origin,max_response_bytes=128) as channel:
                with self.assertRaises(transport.TransportError) as error:
                    await channel.get_json('/fixture')
                self.assertEqual(error.exception.code,'response_too_large')
            self.assertEqual(len(server.requests),1)
        async def close(writer,_):
            writer.close()
        async with TlsServer(self.server_tls,close) as server:
            async with self.channel(server.origin) as channel:
                with self.assertRaises(transport.TransportError) as error:
                    await channel.get_json('/fixture')
                self.assertEqual(error.exception.code,'transport_failed')
                self.assertIsNone(error.exception.__context__)
            self.assertEqual(len(server.requests),1)

    async def test_non_json_mime_refused_and_ssl_requires_tls12_or_newer(self):
        async def wrong_type(writer,_):
            writer.write(b'HTTP/1.1 200 fixture\r\nContent-Type: text/html\r\nContent-Length: 2\r\n\r\n{}')
            await writer.drain()
        async with TlsServer(self.server_tls,wrong_type) as server:
            async with self.channel(server.origin) as channel:
                with self.assertRaises(transport.TransportError) as error:
                    await channel.get_json('/fixture')
                self.assertEqual(error.exception.code,'content_type_refused')
        # Real negotiated protocol observed by the owned server, no mocked SSL.
        versions=[]
        async def version(writer,n):
            versions.append(writer.get_extra_info('ssl_object').version())
            await response()(writer,n)
        async with TlsServer(self.server_tls,version) as server:
            async with self.channel(server.origin) as channel:
                await channel.get_json('/fixture')
            self.assertIn(versions[0],{'TLSv1.2','TLSv1.3'})


    async def test_late_cancellation_during_decode_beats_delivery(self):
        decoder=json.loads
        def cancel(*args,**kwargs):
            value=decoder(*args,**kwargs)
            asyncio.current_task().cancel()
            return value
        async with TlsServer(self.server_tls,response()) as server:
            async with self.channel(server.origin) as channel:
                with patch.object(transport.json,'loads',side_effect=cancel):
                    task=asyncio.create_task(channel.get_json('/fixture'))
                    with self.assertRaises(asyncio.CancelledError):
                        await task
            self.assertEqual(len(server.requests),1)

    async def test_elapsed_deadline_during_bounded_decode_is_not_delivered(self):
        decoder=json.loads
        def slow(*args,**kwargs):
            value=decoder(*args,**kwargs)
            time.sleep(.12)  # Only this owned decoder; no system pressure/stress.
            return value
        async with TlsServer(self.server_tls,response()) as server:
            async with self.channel(server.origin,total_timeout_seconds=.1) as channel:
                with patch.object(transport.json,'loads',side_effect=slow):
                    with self.assertRaises(transport.TransportError) as error:
                        await channel.get_json('/fixture')
                self.assertEqual(error.exception.code,'request_timeout')
            self.assertEqual(len(server.requests),1)

    async def test_ca_configuration_refusal_and_boundary_json_body(self):
        for ca in [b'',b'not a certificate',b'\xff',b'x'*262145]:
            with self.subTest(length=len(ca)),self.assertRaises(transport.TransportError) as error:
                self.channel('https://example.invalid',ca_pem=ca)
            self.assertEqual(error.exception.code,'invalid_ca')
        async with TlsServer(self.server_tls,response(body=b'null')) as server:
            async with self.channel(server.origin,max_response_bytes=4) as channel:
                self.assertIsNone(await channel.get_json('/fixture'))

    async def test_close_failure_is_fixed_and_channel_is_not_reusable(self):
        channel=self.channel('https://example.invalid')
        original=channel._client.aclose
        async def broken_close():
            raise OSError('FICTIONAL_PRIVATE_CLOSE_DETAIL')
        with patch.object(channel._client,'aclose',side_effect=broken_close):
            with self.assertRaises(transport.TransportError) as error:
                await channel.aclose()
            self.assertEqual(error.exception.code,'close_failed')
            self.assertIsNone(error.exception.__cause__)
            self.assertIsNone(error.exception.__context__)
            self.assertNotIn('FICTIONAL_PRIVATE',str(error.exception))
            with self.assertRaises(transport.TransportError) as error:
                await channel.get_json('/fixture')
            self.assertEqual(error.exception.code,'channel_closed')
        await original()  # Real test-owned pool cleanup after the injected failure.

    async def test_context_pool_close_failure_preserves_task_cancellation(self):
        channel = self.channel('https://example.invalid')
        original = channel._client.aclose
        entered = asyncio.Event()

        async def broken_close():
            raise OSError('FICTIONAL_PRIVATE_POOL_CLOSE_DETAIL')

        async def operation():
            async with channel:
                entered.set()
                await asyncio.Event().wait()

        try:
            with patch.object(channel._client, 'aclose', side_effect=broken_close):
                task = asyncio.create_task(operation())
                await asyncio.wait_for(entered.wait(), 1)
                task.cancel()
                with self.assertRaises(asyncio.CancelledError) as cancelled:
                    await task
                self.assertTrue(task.cancelled())
                self.assertIn('channel_cleanup_unverified: close_failed', cancelled.exception.__notes__)
            with self.assertRaises(transport.TransportError) as error:
                await channel.get_json('/fixture')
            self.assertEqual(error.exception.code, 'channel_closed')
        finally:
            await original()

    async def test_context_without_cancellation_still_reports_pool_close_failure(self):
        channel = self.channel('https://example.invalid')
        original = channel._client.aclose

        async def broken_close():
            raise OSError('FICTIONAL_PRIVATE_POOL_CLOSE_DETAIL')

        try:
            with patch.object(channel._client, 'aclose', side_effect=broken_close):
                with self.assertRaises(transport.TransportError) as error:
                    async with channel:
                        pass
                self.assertEqual(error.exception.code, 'close_failed')
                self.assertIsNone(error.exception.__cause__)
                self.assertIsNone(error.exception.__context__)
        finally:
            await original()

    async def test_response_close_after_deadline(self):
        original=transport.httpx.Response.aclose
        counts={}
        async def close(res):
            counts[id(res)]=counts.get(id(res),0)+1
            await original(res)
            if counts[id(res)]==2:
                time.sleep(.15)
        async with TlsServer(self.server_tls,response()) as server:
            async with self.channel(server.origin,total_timeout_seconds=.1) as channel:
                async with self.channel(server.origin,total_timeout_seconds=2) as warm:
                    await warm.get_json('/warm')
                with patch.object(transport.httpx.Response,'aclose',close):
                    with self.assertRaises(transport.TransportError) as error:
                        await channel.get_json('/fixture')
                self.assertEqual(error.exception.code,'request_timeout')

    async def test_response_close_error_is_fixed(self):
        # aiter_raw closes automatically once; our finalizer then closes again.
        # Unknown failures from that native first close must also stay opaque.
        for fail_at,code in [(1,'transport_failed'),(2,'close_failed')]:
            with self.subTest(fail_at=fail_at):
                original=transport.httpx.Response.aclose
                counts={}
                async def close(res):
                    counts[id(res)]=counts.get(id(res),0)+1
                    await original(res)
                    if counts[id(res)]==fail_at:
                        raise OSError('FICTIONAL_CLOSE_CANARY')
                async with TlsServer(self.server_tls,response()) as server:
                    async with self.channel(server.origin) as channel:
                        with patch.object(transport.httpx.Response,'aclose',close):
                            with self.assertRaises(transport.TransportError) as error:
                                await channel.get_json('/fixture')
                        self.assertEqual(error.exception.code,code)
                        self.assertIsNone(error.exception.__context__)
                        self.assertIsNone(error.exception.__cause__)

    async def test_response_close_failure_cannot_replace_body_cancellation(self):
        original=transport.httpx.Response.aclose
        entered=asyncio.Event()
        async def wait(writer,_):
            writer.write(b'HTTP/1.1 200 fixture\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n')
            await writer.drain()
            entered.set()
            await asyncio.sleep(5)
        async def close(res):
            await original(res)
            raise OSError('FICTIONAL_CANCEL_CLOSE_CANARY')
        async with TlsServer(self.server_tls,wait) as server:
            async with self.channel(server.origin) as channel:
                with patch.object(transport.httpx.Response,'aclose',close):
                    task=asyncio.create_task(channel.get_json('/fixture'))
                    await asyncio.wait_for(entered.wait(),1)
                    await asyncio.sleep(.025)
                    task.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await task
                with self.assertRaises(transport.TransportError) as error:
                    await channel.get_json('/fixture')
                self.assertEqual(error.exception.code,'channel_closed')

    async def test_closed_channel_and_invalid_configuration_are_fixed_refusals(self):
        self.assertIsNotNone(transport,'The preparation HTTPS transport is not implemented')
        for origin in ['http://example.invalid','https://user:pass@example.invalid',
                       'https://example.invalid/path','https://example.invalid?x=1',
                       'https://example.invalid#x','https://example.invalid:0','https://example.invalid:65536',
                       'https://example.invalid/\n','https://example.invalid.','https://EXAMPLE.invalid',
                       'https://[fe80::1%eth0]']:
            with self.subTest(origin=origin),self.assertRaises(transport.TransportError):
                self.channel(origin)
        for options in [{'max_response_bytes':0},{'max_response_bytes':True},
                        {'max_response_bytes':1048577},{'total_timeout_seconds':float('nan')},
                        {'total_timeout_seconds':float('inf')},{'total_timeout_seconds':10**500},
                        {'total_timeout_seconds':31},
                        {'max_connections':0},{'max_connections':5}]:
            with self.subTest(options=options),self.assertRaises(transport.TransportError):
                self.channel('https://example.invalid',**options)
        async with self.channel('https://example.invalid') as channel:
            pass
        with self.assertRaises(transport.TransportError) as error:
            await channel.get_json('/fixture')
        self.assertEqual(error.exception.code,'channel_closed')


if __name__ == '__main__':
    unittest.main()
