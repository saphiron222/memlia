# Copyright (c) 2026 Memlia. All rights reserved.
"""Real mTLS/SSL/HTTPX; only the Windows-only credential read is doubled on Mac."""
import asyncio
import base64
import datetime
import ipaddress
import os
from pathlib import Path
import ssl
import tempfile
import unittest
from unittest.mock import patch

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

from memlia_agent import client_identity as identity_module
from memlia_agent import transport
from memlia_agent.user_credentials import CurrentUserCredentialStore
from test_transport import TlsServer, response

from memlia_agent.client_identity import ClientIdentity, ClientIdentityError


class ClientIdentityTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix='memlia-fictional-mtls-')
        cls.root = Path(cls.tmp.name)
        cls.password = b'fictional-memlia-client-passphrase'
        now = datetime.datetime.now(datetime.timezone.utc)

        def authority(label):
            key = ec.generate_private_key(ec.SECP256R1())
            name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, label)])
            cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
                    .public_key(key.public_key()).serial_number(x509.random_serial_number())
                    .not_valid_before(now - datetime.timedelta(days=1))
                    .not_valid_after(now + datetime.timedelta(days=1))
                    .add_extension(x509.BasicConstraints(ca=True, path_length=0), True)
                    .add_extension(x509.KeyUsage(False, False, False, False, False, True, True, False, False), True)
                    .sign(key, hashes.SHA256()))
            return key, cert

        ca_key, ca = authority('Memlia fictional client identity CA')
        foreign_key, foreign = authority('Memlia foreign fictional client CA')
        cls.ca = ca.public_bytes(serialization.Encoding.PEM)
        cls.foreign_ca = foreign.public_bytes(serialization.Encoding.PEM)

        def leaf(label, *, client, issuer=ca, issuer_key=ca_key, expired=False, wrong_name=False):
            key = ec.generate_private_key(ec.SECP256R1())
            name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, label)])
            builder = (x509.CertificateBuilder().subject_name(name).issuer_name(issuer.subject)
                       .public_key(key.public_key()).serial_number(x509.random_serial_number())
                       .not_valid_before(now - datetime.timedelta(days=2))
                       .not_valid_after(now - datetime.timedelta(days=1) if expired else now + datetime.timedelta(hours=1))
                       .add_extension(x509.BasicConstraints(ca=False, path_length=None), True)
                       .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.CLIENT_AUTH if client else ExtendedKeyUsageOID.SERVER_AUTH]), False))
            if not client:
                builder = builder.add_extension(x509.SubjectAlternativeName([
                    x509.DNSName('foreign.invalid') if wrong_name else x509.IPAddress(ipaddress.ip_address('127.0.0.1'))]), False)
            cert = builder.sign(issuer_key, hashes.SHA256())
            encrypted = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                          serialization.BestAvailableEncryption(cls.password))
            return cert.public_bytes(serialization.Encoding.PEM), encrypted, key

        cls.client_cert, cls.client_key, cls.private = leaf('fictional-agent', client=True)
        cls.client_der = x509.load_pem_x509_certificate(cls.client_cert).public_bytes(serialization.Encoding.DER)
        cls.foreign_cert, cls.foreign_key, _ = leaf('foreign-agent', client=True, issuer=foreign, issuer_key=foreign_key)
        cls.expired_cert, cls.expired_key, _ = leaf('expired-agent', client=True, expired=True)

        def server(label, wrong_name=False):
            cert, key, _ = leaf(label, client=False, wrong_name=wrong_name)
            certfile, keyfile = cls.root / (label + '.pem'), cls.root / (label + '-encrypted.pem')
            certfile.write_bytes(cert)
            keyfile.write_bytes(key)
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.minimum_version = ssl.TLSVersion.TLSv1_2
            context.load_cert_chain(certfile, keyfile, password=cls.password)
            context.verify_mode = ssl.CERT_REQUIRED
            context.load_verify_locations(cadata=cls.ca.decode('ascii'))
            return context

        cls.server_tls = server('expected-server')
        cls.wrong_name_tls = server('wrong-name-server', wrong_name=True)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def identity(self, **changes):
        options = dict(instance_id='fixture-instance', agent_id='fixture-agent',
                       certificate_chain_pem=self.client_cert, encrypted_pkcs8_pem=self.client_key)
        options.update(changes)
        return ClientIdentity(**options)

    def channel(self, origin, **changes):
        options = dict(origin=origin, ca_pem=self.ca, max_response_bytes=65536,
                       total_timeout_seconds=2, max_connections=1)
        options.update(changes)
        return transport.MutualTLSChannel(**options, client_identity=self.identity())

    async def test_authenticated_get_presents_the_expected_client_certificate(self):
        peers = []
        async def serve(writer, count):
            peers.append(writer.get_extra_info('ssl_object').getpeercert(binary_form=True))
            await response()(writer, count)
        secrets = []
        def load(store):
            self.assertEqual((store.instance_id, store.agent_id), ('fixture-instance', 'fixture-agent'))
            value = bytearray(self.password)
            secrets.append(value)
            return value
        async with TlsServer(self.server_tls, serve) as server:
            with patch.object(CurrentUserCredentialStore, 'load', autospec=True, side_effect=load):
                try:
                    async with self.channel(server.origin) as channel:
                        result = await channel.get_json('/identity-fixture')
                except transport.TransportError:
                    self.fail('The mTLS channel did not authenticate to the owned fixture')
            self.assertEqual(result, {'prepared': True})
            self.assertEqual(peers, [self.client_der])
            self.assertEqual(len(server.requests), 1)
            self.assertEqual(len(secrets), 1)
            self.assertEqual(secrets[0], bytearray(len(self.password)))


    async def test_server_requiring_client_certificate_refuses_server_only_t1(self):
        async with TlsServer(self.server_tls, response()) as server:
            async with transport.PreparationChannel(origin=server.origin, ca_pem=self.ca,
                    max_response_bytes=65536, total_timeout_seconds=2, max_connections=1) as channel:
                with self.assertRaises(transport.TransportError):
                    await channel.get_json('/identity-fixture')
            self.assertEqual(server.requests, [])
            self.assertEqual(server.connections, 1)

    def test_missing_identity_cannot_construct_an_http_client(self):
        for identity in (None, object()):
            with self.subTest(kind=type(identity).__name__):
                with patch.object(transport.httpx, 'AsyncClient') as client:
                    with self.assertRaises(transport.TransportError) as caught:
                        transport.MutualTLSChannel(origin='https://fixture.invalid', ca_pem=self.ca,
                            max_response_bytes=65536, total_timeout_seconds=2,
                            max_connections=1, client_identity=identity)
                self.assertEqual(caught.exception.code, 'client_identity_required')
                self.assertIsNone(caught.exception.__cause__)
                self.assertIsNone(caught.exception.__context__)
                client.assert_not_called()

    def test_clear_key_unknown_envelopes_and_bad_ids_refuse_before_secret_or_files(self):
        clear = self.private.private_bytes(serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
        cases = [
            {'encrypted_pkcs8_pem': clear},
            {'encrypted_pkcs8_pem': self.client_key + clear},
            {'certificate_chain_pem': self.client_cert + clear},
            {'encrypted_pkcs8_pem': b'x' * 262145},
            {'certificate_chain_pem': b'x' * 262145},
            {'certificate_chain_pem': b''},
            {'encrypted_pkcs8_pem': bytearray(self.client_key)},
            {'instance_id': '../foreign'},
            {'agent_id': 'agent:foreign'},
        ]
        for index, changes in enumerate(cases):
            with self.subTest(case=index):
                with patch.object(CurrentUserCredentialStore, 'load') as load:
                    with patch.object(identity_module.tempfile, 'TemporaryDirectory') as temporary:
                        with self.assertRaises(ClientIdentityError) as caught:
                            self.identity(**changes)
                self.assertEqual(caught.exception.code, 'invalid_client_identity')
                self.assertIsNone(caught.exception.__cause__)
                self.assertIsNone(caught.exception.__context__)
                load.assert_not_called()
                temporary.assert_not_called()

    def test_relabeled_clear_key_and_certificate_payload_refuse_before_secret_or_files(self):
        clear = self.private.private_bytes(serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
        relabeled_key = clear.replace(b'BEGIN PRIVATE KEY', b'BEGIN ENCRYPTED PRIVATE KEY').replace(
            b'END PRIVATE KEY', b'END ENCRYPTED PRIVATE KEY')
        relabeled_certificate = clear.replace(b'PRIVATE KEY', b'CERTIFICATE')
        cases = [
            {'encrypted_pkcs8_pem': relabeled_key},
            {'certificate_chain_pem': relabeled_certificate},
            {'certificate_chain_pem': self.client_cert + relabeled_certificate},
        ]
        for index, changes in enumerate(cases):
            with self.subTest(case=index):
                with patch.object(CurrentUserCredentialStore, 'load') as load:
                    with patch.object(identity_module.tempfile, 'TemporaryDirectory') as temporary:
                        with self.assertRaises(ClientIdentityError) as caught:
                            self.identity(**changes)
                self.assertEqual(caught.exception.code, 'invalid_client_identity')
                self.assertIsNone(caught.exception.__cause__)
                self.assertIsNone(caught.exception.__context__)
                load.assert_not_called()
                temporary.assert_not_called()

    def test_wrong_secret_refuses_before_any_temporary_creation(self):
        secret = bytearray(b'wrong-fictional-password')
        with patch.object(CurrentUserCredentialStore, 'load', return_value=secret):
            with patch.object(identity_module.tempfile, 'TemporaryDirectory') as temporary:
                with self.assertRaises(transport.TransportError) as caught:
                    self.channel('https://fixture.invalid')
        self.assertEqual(caught.exception.code, 'client_identity_failed')
        self.assertEqual(secret, bytearray(len(secret)))
        temporary.assert_not_called()

    def test_corrupted_encrypted_payload_refuses_before_any_temporary_creation(self):
        # Alter ciphertext bytes only; cryptography still owns ASN.1/key decoding.
        encoded = b''.join(self.client_key.splitlines()[1:-1])
        payload = bytearray(base64.b64decode(encoded, validate=True))
        payload[-1] ^= 1
        label = b'ENCRYPTED PRIVATE KEY'
        damaged = (b'-----BEGIN ' + label + b'-----\n' + base64.encodebytes(payload)
                   + b'-----END ' + label + b'-----\n')
        secret = bytearray(self.password)
        with patch.object(CurrentUserCredentialStore, 'load', return_value=secret):
            with patch.object(identity_module.tempfile, 'TemporaryDirectory') as temporary:
                with self.assertRaises(transport.TransportError) as caught:
                    transport.MutualTLSChannel(origin='https://fixture.invalid', ca_pem=self.ca,
                        max_response_bytes=65536, total_timeout_seconds=2, max_connections=1,
                        client_identity=self.identity(encrypted_pkcs8_pem=damaged))
        self.assertEqual(caught.exception.code, 'client_identity_failed')
        self.assertEqual(secret, bytearray(len(secret)))
        temporary.assert_not_called()

    def test_own_encrypted_temporary_files_are_removed_before_http_creation(self):
        native = ssl.SSLContext.load_cert_chain
        paths = []
        loaded = []
        def load_context(context, certificate, key, password):
            paths.extend([Path(certificate), Path(key)])
            self.assertEqual(paths[-2].read_bytes(), self.client_cert)
            self.assertEqual(paths[-1].read_bytes(), self.client_key)
            self.assertNotIn(b'BEGIN PRIVATE KEY', paths[-1].read_bytes())
            if os.name == 'posix':
                self.assertEqual(paths[-1].stat().st_mode & 0o777, 0o600)
                self.assertEqual(paths[-1].parent.stat().st_mode & 0o777, 0o700)
            return native(context, certificate, key, password=password)
        def credential(_store):
            value = bytearray(self.password)
            loaded.append(value)
            return value
        original_client = transport.httpx.AsyncClient
        def client(*args, **kwargs):
            self.assertEqual(len(paths), 2)
            self.assertTrue(all(not path.exists() for path in paths))
            self.assertEqual(loaded[0], bytearray(len(self.password)))
            return original_client(*args, **kwargs)
        with patch.object(CurrentUserCredentialStore, 'load', autospec=True, side_effect=credential):
            with patch.object(ssl.SSLContext, 'load_cert_chain', new=load_context):
                with patch.object(transport.httpx, 'AsyncClient', side_effect=client):
                    channel = self.channel('https://fixture.invalid')
        # No request was made; the pool still has to be closed by its owner.
        asyncio.run(channel.aclose())
        self.assertTrue(all(not path.parent.exists() for path in paths))

    def test_missing_wrong_or_failed_secret_never_returns_channel_or_native_cause(self):
        for kind in ('missing', 'wrong', 'error'):
            with self.subTest(kind=kind):
                values = []
                temporary_paths = []
                native_directory = identity_module.tempfile.TemporaryDirectory
                def temporary(*args, **kwargs):
                    result = native_directory(*args, **kwargs)
                    temporary_paths.append(Path(result.name))
                    return result
                def load(_store):
                    if kind == 'missing':
                        return None
                    if kind == 'error':
                        raise OSError('private-credential-path-canary')
                    value = bytearray(b'wrong-fictional-password')
                    values.append(value)
                    return value
                with patch.object(CurrentUserCredentialStore, 'load', autospec=True, side_effect=load):
                    with patch.object(identity_module.tempfile, 'TemporaryDirectory', side_effect=temporary):
                        with patch.object(transport.httpx, 'AsyncClient') as client:
                            with self.assertRaises(transport.TransportError) as caught:
                                self.channel('https://fixture.invalid')
                self.assertEqual(caught.exception.code, 'client_identity_failed')
                self.assertIsNone(caught.exception.__cause__)
                self.assertIsNone(caught.exception.__context__)
                self.assertTrue(all(value == bytearray(len(value)) for value in values))
                self.assertTrue(all(not path.exists() for path in temporary_paths))
                client.assert_not_called()

    async def test_foreign_and_expired_client_certificates_never_reach_http(self):
        for certificate, key in ((self.foreign_cert, self.foreign_key), (self.expired_cert, self.expired_key)):
            async with TlsServer(self.server_tls, response()) as server:
                with patch.object(CurrentUserCredentialStore, 'load', return_value=bytearray(self.password)):
                    identity = self.identity(certificate_chain_pem=certificate, encrypted_pkcs8_pem=key)
                    async with transport.MutualTLSChannel(origin=server.origin, ca_pem=self.ca,
                            max_response_bytes=65536, total_timeout_seconds=2,
                            max_connections=1, client_identity=identity) as channel:
                        with self.assertRaises(transport.TransportError):
                            await channel.get_json('/identity-fixture')
                self.assertEqual(server.requests, [])
                self.assertEqual(server.connections, 1)

    def test_mismatched_key_refuses_before_http_creation_and_secret_is_wiped(self):
        secret = bytearray(self.password)
        with patch.object(CurrentUserCredentialStore, 'load', return_value=secret):
            with patch.object(transport.httpx, 'AsyncClient') as client:
                with self.assertRaises(transport.TransportError) as caught:
                    transport.MutualTLSChannel(origin='https://fixture.invalid', ca_pem=self.ca,
                        max_response_bytes=65536, total_timeout_seconds=2, max_connections=1,
                        client_identity=self.identity(encrypted_pkcs8_pem=self.foreign_key))
        self.assertEqual(caught.exception.code, 'client_identity_failed')
        self.assertEqual(secret, bytearray(len(secret)))
        client.assert_not_called()

    async def test_wrong_server_ca_or_hostname_is_still_refused_with_client_identity(self):
        for context, ca in ((self.server_tls, self.foreign_ca), (self.wrong_name_tls, self.ca)):
            async with TlsServer(context, response()) as server:
                with patch.object(CurrentUserCredentialStore, 'load', side_effect=lambda: bytearray(self.password)):
                    async with self.channel(server.origin, ca_pem=ca) as channel:
                        with self.assertRaises(transport.TransportError) as caught:
                            await channel.get_json('/identity-fixture')
                self.assertEqual(caught.exception.code, 'tls_failed')
                self.assertEqual(server.requests, [])
                self.assertEqual(server.connections, 1)

    async def test_redirect_cannot_present_identity_to_another_origin(self):
        async with TlsServer(self.server_tls, response()) as other:
            async with TlsServer(self.server_tls, response(status=307,
                    extra=f'Location: {other.origin}/forbidden\r\n'.encode())) as server:
                with patch.object(CurrentUserCredentialStore, 'load', side_effect=lambda: bytearray(self.password)):
                    async with self.channel(server.origin) as channel:
                        with self.assertRaises(transport.TransportError) as caught:
                            await channel.get_json('/identity-fixture')
                self.assertEqual(caught.exception.code, 'redirect_refused')
                self.assertEqual(len(server.requests), 1)
                self.assertEqual(other.connections, 0)

    def test_cleanup_failure_blocks_http_even_after_successful_native_load(self):
        native_directory = identity_module.tempfile.TemporaryDirectory
        paths = []
        class FailAfterRealCleanup:
            def __init__(self, *args, **kwargs):
                self.inner = native_directory(*args, **kwargs)
                self.name = self.inner.name
                paths.append(Path(self.name))
            def cleanup(self):
                self.inner.cleanup()
                raise OSError('private-cleanup-canary')
        with patch.object(identity_module.tempfile, 'TemporaryDirectory', FailAfterRealCleanup):
            with patch.object(CurrentUserCredentialStore, 'load', side_effect=lambda: bytearray(self.password)):
                with patch.object(transport.httpx, 'AsyncClient') as client:
                    with self.assertRaises(transport.TransportError) as caught:
                        self.channel('https://fixture.invalid')
        self.assertEqual(caught.exception.code, 'client_identity_failed')
        self.assertIsNone(caught.exception.__cause__)
        self.assertIsNone(caught.exception.__context__)
        self.assertTrue(all(not path.exists() for path in paths))
        client.assert_not_called()

    def test_cancelled_load_propagates_after_secret_wipe_and_temp_cleanup(self):
        secret = bytearray(self.password)
        paths = []
        def interrupted(_context, certificate, key, password):
            paths.extend([Path(certificate), Path(key)])
            password()
            raise asyncio.CancelledError()
        with patch.object(ssl.SSLContext, 'load_cert_chain', new=interrupted):
            with patch.object(CurrentUserCredentialStore, 'load', return_value=secret):
                with patch.object(transport.httpx, 'AsyncClient') as client:
                    with self.assertRaises(asyncio.CancelledError):
                        self.channel('https://fixture.invalid')
        self.assertEqual(secret, bytearray(len(secret)))
        self.assertTrue(all(not path.parent.exists() for path in paths))
        client.assert_not_called()


    def test_invalid_context_refuses_before_credential_or_temporary_io(self):
        identity = self.identity()
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        with patch.object(CurrentUserCredentialStore, 'load') as load:
            with patch.object(identity_module.tempfile, 'TemporaryDirectory') as temporary:
                with self.assertRaises(ClientIdentityError) as caught:
                    identity._load_into(context)
        self.assertEqual(caught.exception.code, 'invalid_identity_context')
        load.assert_not_called()
        temporary.assert_not_called()

    def test_second_temporary_write_failure_cleans_owned_files_and_wipes_validated_secret(self):
        native_write = identity_module._temporary_file
        paths = []
        secret = bytearray(self.password)
        def write(directory, content):
            path = native_write(directory, content)
            paths.append(Path(path))
            if len(paths) == 2:
                raise OSError('private-temporary-path-canary')
            return path
        with patch.object(identity_module, '_temporary_file', side_effect=write):
            with patch.object(CurrentUserCredentialStore, 'load', return_value=secret) as load:
                with patch.object(transport.httpx, 'AsyncClient') as client:
                    with self.assertRaises(transport.TransportError) as caught:
                        self.channel('https://fixture.invalid')
        self.assertEqual(caught.exception.code, 'client_identity_failed')
        self.assertIsNone(caught.exception.__cause__)
        self.assertIsNone(caught.exception.__context__)
        self.assertEqual(len(paths), 2)
        self.assertTrue(all(not path.parent.exists() for path in paths))
        load.assert_called_once_with()
        self.assertEqual(secret, bytearray(len(secret)))
        client.assert_not_called()

    def test_native_decryption_precedes_temporary_creation_and_reuses_secret(self):
        native_parse = serialization.load_pem_private_key
        native_directory = identity_module.tempfile.TemporaryDirectory
        secret = bytearray(self.password)
        steps = []
        def parse(data, password):
            steps.append('recognize' if password is None else 'decrypt')
            if password is not None:
                self.assertIs(password, secret)
            return native_parse(data, password=password)
        def temporary(*args, **kwargs):
            self.assertEqual(steps, ['recognize', 'decrypt'])
            steps.append('temporary')
            return native_directory(*args, **kwargs)
        with patch.object(serialization, 'load_pem_private_key', side_effect=parse):
            with patch.object(CurrentUserCredentialStore, 'load', return_value=secret) as load:
                with patch.object(identity_module.tempfile, 'TemporaryDirectory', side_effect=temporary):
                    channel = self.channel('https://fixture.invalid')
        asyncio.run(channel.aclose())
        self.assertEqual(steps, ['recognize', 'decrypt', 'temporary'])
        self.assertEqual(secret, bytearray(len(secret)))
        load.assert_called_once_with()

    def test_cancelled_native_decryption_wipes_before_any_temporary_io(self):
        native_parse = serialization.load_pem_private_key
        secret = bytearray(self.password)
        def parse(data, password):
            if password is not None:
                raise asyncio.CancelledError()
            return native_parse(data, password=password)
        with patch.object(serialization, 'load_pem_private_key', side_effect=parse):
            with patch.object(CurrentUserCredentialStore, 'load', return_value=secret):
                with patch.object(identity_module.tempfile, 'TemporaryDirectory') as temporary:
                    with self.assertRaises(asyncio.CancelledError):
                        self.channel('https://fixture.invalid')
        self.assertEqual(secret, bytearray(len(secret)))
        temporary.assert_not_called()


if __name__ == '__main__':
    unittest.main()
