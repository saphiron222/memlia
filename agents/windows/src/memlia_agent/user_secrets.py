"""Protection des futurs secrets utilisateur de Memlia Agent."""

import ctypes
import hashlib
import hmac
import struct
import sys
from dataclasses import dataclass

_PREFIX = b'Memlia.UserSecret.v1\x00'
_PAYLOAD = b'Memlia.Payload.v1\x00'
_ENTROPY = b'Memlia.CurrentUser.v1\x00'
_OVERHEAD = len(_PAYLOAD) + 4 + 32
_OUTER_SIZE = len(_PREFIX) + 32


class SecretProtectionError(RuntimeError):
    """Code stable sans contenu sensible."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


@dataclass(frozen=True, kw_only=True)
class CurrentUserProtector:
    max_secret_bytes: int
    max_protected_bytes: int
    max_context_bytes: int

    def __post_init__(self):
        for value in (self.max_secret_bytes, self.max_protected_bytes, self.max_context_bytes):
            if type(value) is not int or not 1 <= value < 2 ** 32:
                raise SecretProtectionError('invalid_limits')
        if (self.max_secret_bytes + _OVERHEAD >= 2 ** 32
                or self.max_context_bytes + len(_ENTROPY) >= 2 ** 32
                or self.max_protected_bytes <= _OUTER_SIZE):
            raise SecretProtectionError('invalid_limits')

    def protect(self, secret: bytearray, *, context: bytes) -> bytes:
        if type(secret) is not bytearray or not 1 <= len(secret) <= self.max_secret_bytes:
            raise SecretProtectionError('invalid_secret')
        if type(context) is not bytes or not 1 <= len(context) <= self.max_context_bytes:
            raise SecretProtectionError('invalid_context')
        if sys.platform != 'win32':
            raise SecretProtectionError('unsupported_platform')
        frame = bytearray(_PAYLOAD)
        try:
            frame.extend(struct.pack('<I', len(secret)))
            frame.extend(secret)
            digest = hashlib.sha256(_ENTROPY + context)
            digest.update(frame)
            frame.extend(digest.digest())
            encrypted = _crypt(
                frame, _ENTROPY + context, protect=True,
                output_limit=self.max_protected_bytes - _OUTER_SIZE,
            )
            # Détection de corruption des métadonnées que DPAPI peut ignorer ;
            # ce checksum public n'est pas une authentification du blob.
            return _PREFIX + hashlib.sha256(encrypted).digest() + bytes(encrypted)
        except OSError:
            raise SecretProtectionError('dpapi_failed') from None
        finally:
            _wipe(frame)

    def unprotect(self, protected: bytes, *, context: bytes) -> bytearray:
        if (type(protected) is not bytes or not _OUTER_SIZE < len(protected) <= self.max_protected_bytes
                or not protected.startswith(_PREFIX)):
            raise SecretProtectionError('invalid_protected_secret')
        encrypted = protected[_OUTER_SIZE:]
        if not hmac.compare_digest(hashlib.sha256(encrypted).digest(), protected[len(_PREFIX):_OUTER_SIZE]):
            raise SecretProtectionError('invalid_protected_secret')
        if type(context) is not bytes or not 1 <= len(context) <= self.max_context_bytes:
            raise SecretProtectionError('invalid_context')
        if sys.platform != 'win32':
            raise SecretProtectionError('unsupported_platform')
        try:
            frame = _crypt(bytearray(encrypted), _ENTROPY + context,
                           protect=False, output_limit=self.max_secret_bytes + _OVERHEAD)
        except OSError:
            raise SecretProtectionError('dpapi_failed') from None
        try:
            if not _OVERHEAD < len(frame) <= self.max_secret_bytes + _OVERHEAD or not frame.startswith(_PAYLOAD):
                raise SecretProtectionError('invalid_payload')
            size = struct.unpack_from('<I', frame, len(_PAYLOAD))[0]
            if size != len(frame) - _OVERHEAD:
                raise SecretProtectionError('invalid_payload')
            digest = hashlib.sha256(_ENTROPY + context)
            digest.update(memoryview(frame)[:-32])
            if not hmac.compare_digest(digest.digest(), frame[-32:]):
                raise SecretProtectionError('invalid_payload')
            return frame[len(_PAYLOAD) + 4:-32]
        finally:
            _wipe(frame)


def _wipe(value: bytearray):
    if value:
        ctypes.memset((ctypes.c_ubyte * len(value)).from_buffer(value), 0, len(value))


def _crypt(data: bytearray, entropy: bytes, *, protect: bool, output_limit: int) -> bytearray:
    """API Windows uniquement, sans fournisseur alternatif ni flag machine."""
    pointer = ctypes.c_void_p
    # Recherche exclusivement dans System32, pas dans le CWD ou le PATH.
    crypt = ctypes.WinDLL('crypt32', use_last_error=True, winmode=0x800)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True, winmode=0x800)
    function = crypt.CryptProtectData if protect else crypt.CryptUnprotectData
    function.restype = ctypes.c_int
    function.argtypes = [ctypes.POINTER(_DataBlob), pointer, ctypes.POINTER(_DataBlob),
                         pointer, pointer, ctypes.c_uint32, ctypes.POINTER(_DataBlob)]
    free = kernel.LocalFree
    free.restype = pointer
    free.argtypes = [pointer]
    source_buffer = (ctypes.c_ubyte * len(data)).from_buffer(data)
    entropy_buffer = (ctypes.c_ubyte * len(entropy)).from_buffer_copy(entropy)
    source = _DataBlob(len(data), ctypes.cast(source_buffer, pointer))
    extra = _DataBlob(len(entropy), ctypes.cast(entropy_buffer, pointer))
    output = _DataBlob()
    result = None
    try:
        # CRYPTPROTECT_UI_FORBIDDEN=1 ; LOCAL_MACHINE=4 n'est jamais demandé.
        if not function(ctypes.byref(source), None, ctypes.byref(extra), None, None,
                        1, ctypes.byref(output)):
            raise OSError('dpapi_operation_failed')
        if not output.data or not 1 <= output.size <= output_limit:
            raise SecretProtectionError('native_output_out_of_bounds')
        result = bytearray((ctypes.c_ubyte * output.size).from_address(output.data))
    finally:
        if output.data:
            ctypes.memset(output.data, 0, output.size)
            if free(output.data):
                if result is not None:
                    _wipe(result)
                raise OSError('dpapi_cleanup_failed')
    return result


class _DataBlob(ctypes.Structure):
    _fields_ = [('size', ctypes.c_uint32), ('data', ctypes.c_void_p)]
