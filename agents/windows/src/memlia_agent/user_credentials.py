"""Credentials Memlia du compte Windows courant, sans accès à une cible arbitraire."""

import ctypes
import re
import sys
from dataclasses import dataclass, field

from .user_secrets import CurrentUserProtector, SecretProtectionError, _wipe

_ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9_-]{0,127}', re.ASCII)
_MAX_SECRET = 2048
_MAX_BLOB = 5 * 512
_GENERIC = 1
# Même compte, même ordinateur, entre sessions. Pas le flag DPAPI machine=4.
_PERSIST_SAME_USER_LOCAL = 2
_NOT_FOUND = 1168


class CredentialStoreError(RuntimeError):
    """Code public fixe ; ne pas sérialiser les frames/variables locales."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


class _FileTime(ctypes.Structure):
    _fields_ = [('low', ctypes.c_uint32), ('high', ctypes.c_uint32)]


class _Credential(ctypes.Structure):
    _fields_ = [
        ('Flags', ctypes.c_uint32), ('Type', ctypes.c_uint32),
        ('TargetName', ctypes.c_wchar_p), ('Comment', ctypes.c_wchar_p),
        ('LastWritten', _FileTime), ('CredentialBlobSize', ctypes.c_uint32),
        ('CredentialBlob', ctypes.POINTER(ctypes.c_ubyte)), ('Persist', ctypes.c_uint32),
        ('AttributeCount', ctypes.c_uint32), ('Attributes', ctypes.c_void_p),
        ('TargetAlias', ctypes.c_wchar_p), ('UserName', ctypes.c_wchar_p),
    ]


def _native_api():
    if sys.platform != 'win32':
        raise CredentialStoreError('unsupported_platform')
    try:
        api = ctypes.WinDLL('advapi32', use_last_error=True, winmode=0x800)
    except OSError:
        raise CredentialStoreError('credential_api_unavailable') from None
    api.CredWriteW.argtypes = [ctypes.POINTER(_Credential), ctypes.c_uint32]
    api.CredReadW.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32,
                             ctypes.POINTER(ctypes.POINTER(_Credential))]
    api.CredDeleteW.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32]
    for function in (api.CredWriteW, api.CredReadW, api.CredDeleteW):
        function.restype = ctypes.c_int
    api.CredFree.argtypes = [ctypes.c_void_p]
    api.CredFree.restype = None
    return api


def _failure(operation: str, error: int):
    code = {5: 'credential_access_denied', 1312: 'credential_logon_unavailable'}.get(error)
    raise CredentialStoreError(code or operation) from None


@dataclass(frozen=True, kw_only=True)
class CurrentUserCredentialStore:
    instance_id: str = field(repr=False)
    agent_id: str = field(repr=False)
    _target: str = field(init=False, repr=False)

    def __post_init__(self):
        for value in (self.instance_id, self.agent_id):
            if type(value) is not str or not _ID.fullmatch(value):
                raise CredentialStoreError('invalid_credential_identity')
        # CredMan est insensible à la casse ; l'hex préserve les IDs distincts.
        target = f'Memlia:agent:v1:{self.instance_id.encode("ascii").hex()}:{self.agent_id.encode("ascii").hex()}'
        object.__setattr__(self, '_target', target)

    def _protector(self):
        return CurrentUserProtector(max_secret_bytes=_MAX_SECRET, max_protected_bytes=_MAX_BLOB,
                                    max_context_bytes=1024)

    def store(self, secret: bytearray) -> None:
        if type(secret) is not bytearray or not 1 <= len(secret) <= _MAX_SECRET:
            raise CredentialStoreError('invalid_secret')
        if sys.platform != 'win32':
            raise CredentialStoreError('unsupported_platform')
        try:
            protected = self._protector().protect(secret, context=self._target.encode('ascii'))
        except SecretProtectionError:
            raise CredentialStoreError('credential_protection_failed') from None
        if len(protected) > _MAX_BLOB:
            raise CredentialStoreError('credential_blob_too_large')
        blob = bytearray(protected)
        try:
            self._write_protected(blob)
        finally:
            _wipe(blob)

    def load(self) -> bytearray | None:
        blob = self._read_protected()
        if blob is None:
            return None
        try:
            return self._protector().unprotect(bytes(blob), context=self._target.encode('ascii'))
        except SecretProtectionError:
            raise CredentialStoreError('credential_protection_failed') from None
        finally:
            _wipe(blob)

    def delete(self) -> bool:
        api = _native_api()
        if api.CredDeleteW(self._target, _GENERIC, 0):
            return True
        error = ctypes.get_last_error()
        if error == _NOT_FOUND:
            return False
        _failure('credential_delete_failed', error)

    def _write_protected(self, blob: bytearray) -> None:
        """Frontière privée, toujours liée aux seuls IDs validés de cet objet."""
        if type(blob) is not bytearray or not 1 <= len(blob) <= _MAX_BLOB:
            raise CredentialStoreError('invalid_credential_blob')
        api = _native_api()
        buffer = (ctypes.c_ubyte * len(blob)).from_buffer(blob)
        row = _Credential()
        row.Type = _GENERIC
        row.TargetName = self._target
        row.CredentialBlobSize = len(blob)
        row.CredentialBlob = ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte))
        row.Persist = _PERSIST_SAME_USER_LOCAL
        if not api.CredWriteW(ctypes.byref(row), 0):
            _failure('credential_write_failed', ctypes.get_last_error())

    def _read_protected(self) -> bytearray | None:
        api = _native_api()
        pointer = ctypes.POINTER(_Credential)()
        try:
            if not api.CredReadW(self._target, _GENERIC, 0, ctypes.byref(pointer)):
                error = ctypes.get_last_error()
                if error == _NOT_FOUND:
                    return None
                _failure('credential_read_failed', error)
            if not pointer:
                raise CredentialStoreError('invalid_native_credential')
            row = pointer.contents
            if (row.Type != _GENERIC or row.Persist != _PERSIST_SAME_USER_LOCAL
                    or row.TargetName != self._target or row.Flags != 0 or row.AttributeCount != 0
                    or not row.CredentialBlob or not 1 <= row.CredentialBlobSize <= _MAX_BLOB):
                raise CredentialStoreError('invalid_native_credential')
            return bytearray((ctypes.c_ubyte * row.CredentialBlobSize).from_address(
                ctypes.addressof(row.CredentialBlob.contents)))
        finally:
            if pointer:
                row = pointer.contents
                # Ne jamais parcourir une taille native hors contrat.
                if row.CredentialBlob and 1 <= row.CredentialBlobSize <= _MAX_BLOB:
                    ctypes.memset(row.CredentialBlob, 0, row.CredentialBlobSize)
                api.CredFree(pointer)
