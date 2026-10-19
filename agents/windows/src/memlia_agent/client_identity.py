# Copyright (c) 2026 Memlia. All rights reserved.
"""Local TLS identity composition, not enrolment, authority or persistent key storage."""
from dataclasses import dataclass, field
import os
import re
import ssl
import tempfile

from cryptography import x509
from cryptography.hazmat.primitives import serialization

from .user_credentials import CurrentUserCredentialStore
from .user_secrets import _wipe

_LIMIT = 262144
_CERTIFICATES = re.compile(
    rb'(?:-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\r?\n?){1,32}\Z')
_ENCRYPTED_KEY = re.compile(
    rb'-----BEGIN ENCRYPTED PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END ENCRYPTED PRIVATE KEY-----\r?\n?\Z')


class ClientIdentityError(RuntimeError):
    """Fixed local refusal; never serialize local frames, key material or native causes."""
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def _temporary_file(directory: str, content: bytes) -> str:
    descriptor, path = tempfile.mkstemp(prefix='identity-', suffix='.pem', dir=directory)
    try:
        # closefd=False ensures the original descriptor is closed even if fdopen/flush fails.
        with os.fdopen(descriptor, 'wb', closefd=False) as output:
            output.write(content)
    finally:
        os.close(descriptor)
    return path


@dataclass(frozen=True, kw_only=True)
class ClientIdentity:
    instance_id: str = field(repr=False)
    agent_id: str = field(repr=False)
    certificate_chain_pem: bytes = field(repr=False)
    encrypted_pkcs8_pem: bytes = field(repr=False)
    _store: CurrentUserCredentialStore = field(init=False, repr=False)

    def __post_init__(self):
        invalid = False
        try:
            # Immutable bytes only: no original path or caller serialization hook is retained.
            if (type(self.certificate_chain_pem) is not bytes
                    or not 1 <= len(self.certificate_chain_pem) <= _LIMIT
                    or not _CERTIFICATES.fullmatch(self.certificate_chain_pem)
                    or type(self.encrypted_pkcs8_pem) is not bytes
                    or not 1 <= len(self.encrypted_pkcs8_pem) <= _LIMIT
                    or not _ENCRYPTED_KEY.fullmatch(self.encrypted_pkcs8_pem)):
                raise ValueError()
            store = CurrentUserCredentialStore(instance_id=self.instance_id, agent_id=self.agent_id)
            # A PEM label is not evidence of its DER payload. Parse in memory before
            # reading a credential or creating any file; do not accept relabelled keys.
            x509.load_pem_x509_certificates(self.certificate_chain_pem)
            encrypted = False
            try:
                serialization.load_pem_private_key(self.encrypted_pkcs8_pem, password=None)
            except TypeError:
                # Official API: no password supplied for a recognised encrypted key.
                # Successful decryption is still required below, before temporary IO.
                encrypted = True
            if not encrypted:
                raise ValueError()
            object.__setattr__(self, '_store', store)
        except Exception:
            invalid = True
        if invalid:
            raise ClientIdentityError('invalid_client_identity')

    def _load_into(self, context: ssl.SSLContext) -> None:
        """Called before HTTPX creation, only on the owned strict client SSL context.

        Cryptography parses/decrypts the captured bytes before any temporary IO.
        OpenSSL then loads/matches the same encrypted bytes using the same buffer.
        Neither parser is replaced with a local ASN.1 or cryptography implementation.
        """
        if (type(context) is not ssl.SSLContext or context.protocol != ssl.PROTOCOL_TLS_CLIENT
                or context.verify_mode != ssl.CERT_REQUIRED or not context.check_hostname
                or context.minimum_version < ssl.TLSVersion.TLSv1_2
                or context.keylog_filename is not None):
            raise ClientIdentityError('invalid_identity_context')
        temporary = None
        secret = None
        supplied = False
        error = None

        def password():
            nonlocal supplied
            if supplied:
                raise ClientIdentityError('identity_load_failed')
            supplied = True
            # CPython's official callback accepts bytearray; no immutable Python copy.
            return secret

        try:
            secret = self._store.load()  # Exact validated namespace; never enumerate credentials.
            if type(secret) is not bytearray or not 1 <= len(secret) <= 2048:
                raise ClientIdentityError('identity_load_failed')
            # A recognised encrypted envelope may still contain invalid ciphertext.
            # Require native successful decryption before writing even encrypted bytes.
            serialization.load_pem_private_key(self.encrypted_pkcs8_pem, password=secret)
            temporary = tempfile.TemporaryDirectory(prefix='memlia-client-identity-')
            certificate = _temporary_file(temporary.name, self.certificate_chain_pem)
            key = _temporary_file(temporary.name, self.encrypted_pkcs8_pem)
            context.load_cert_chain(certificate, key, password=password)
            if not supplied:
                raise ClientIdentityError('identity_load_failed')
        except Exception:
            error = 'identity_load_failed'
        finally:
            if type(secret) is bytearray:
                _wipe(secret)
            if temporary is not None:
                try:
                    temporary.cleanup()
                except Exception:
                    error = 'identity_cleanup_failed'
        # Outside except: no native exception/context containing secret input survives.
        # BaseException cancellation/interrupts propagate after finally; no channel is returned.
        if error is not None:
            raise ClientIdentityError(error)
