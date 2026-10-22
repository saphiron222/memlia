# Copyright (c) 2026 Memlia. All rights reserved.
"""Bounded server-authenticated HTTPS preparation; no agent/enrolment authority."""

import asyncio
from http.cookiejar import CookieJar, DefaultCookiePolicy
import ipaddress
import json
import math
import re
import ssl
from urllib.parse import urlsplit

from .client_identity import ClientIdentity

import httpx


class TransportError(RuntimeError):
    """Fixed public code only. Never serialize exception frames or local data."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


class _NoCookies(DefaultCookiePolicy):
    def set_ok(self, cookie, request):
        return False


def _origin(value: str) -> str:
    if (type(value) is not str or not 1 <= len(value) <= 2048
            or any(ord(c) <= 32 or ord(c) >= 127 for c in value) or '\\' in value or '%' in value):
        raise TransportError('invalid_origin')
    try:
        parsed = urlsplit(value)
        host, port = parsed.hostname, parsed.port
        if (parsed.scheme != 'https' or not host or parsed.username is not None
                or parsed.password is not None or parsed.path not in ('', '/')
                or parsed.query or parsed.fragment or '?' in value or '#' in value
                or parsed.netloc.endswith(':') or port is not None and not 1 <= port <= 65535):
            raise ValueError
        if ':' in host:
            canonical_host = '[' + ipaddress.IPv6Address(host).compressed + ']'
        else:
            if (len(host) > 253 or host.endswith('.') or
                    not all(re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', p)
                            for p in host.split('.'))):
                raise ValueError
            canonical_host = host
        authority = canonical_host + (f':{port}' if port is not None else '')
        # No silent repair of case, host representation, escaped authority, or port.
        if parsed.netloc != authority:
            raise ValueError
        return 'https://' + authority
    except (ValueError, UnicodeError):
        raise TransportError('invalid_origin') from None


def _path(value: str) -> str:
    if (type(value) is not str or not 2 <= len(value) <= 2048
            or not re.fullmatch(r'(?:/[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})+', value)
            or any(part in ('.', '..') for part in value.split('/'))):
        raise TransportError('invalid_path')
    return value


def _non_json(_):
    raise ValueError


def _finite_float(value):
    number = float(value)
    if not math.isfinite(number):
        raise ValueError
    return number


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError
        result[key] = value
    return result


def _json(data):
    try:
        return json.loads(data.decode('utf-8'), parse_constant=_non_json,
                          parse_float=_finite_float, object_pairs_hook=_unique_object)
    except (ValueError, UnicodeError, RecursionError):
        pass
    # Outside except: the public exception retains neither a raw decoder cause
    # nor its context (which can contain the whole remote response).
    raise TransportError('invalid_json')


class PreparationChannel:
    """Private owned client/context; only GET, no credentials or free HTTP options.

    A trusted installation caller supplies origin and public CA, never model data.
    This primitive does not prove enrolment and cannot dispatch agent commands.
    Use within one asyncio loop; cancellation propagates as CancelledError.
    """

    def __init__(self, *, origin: str, ca_pem: bytes, max_response_bytes: int,
                 total_timeout_seconds: float, max_connections: int,
                 _client_identity: ClientIdentity | None = None):
        self._origin = _origin(origin)
        if (type(max_response_bytes) is not int or not 1 <= max_response_bytes <= 1048576
                or type(total_timeout_seconds) not in (int, float)
                or not 0 < total_timeout_seconds <= 30
                or type(max_connections) is not int or not 1 <= max_connections <= 4):
            raise TransportError('invalid_limits')
        if type(ca_pem) is not bytes or not 1 <= len(ca_pem) <= 262144:
            raise TransportError('invalid_ca')
        try:
            # Do not use create_default_context: it reads SSLKEYLOGFILE. No system
            # roots/environment/global trust modification or client key is loaded.
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            context.minimum_version = ssl.TLSVersion.TLSv1_2
            context.verify_mode = ssl.CERT_REQUIRED
            context.check_hostname = True
            context.keylog_filename = None
            context.load_verify_locations(cadata=ca_pem.decode('ascii'))
        except (ssl.SSLError, UnicodeError, ValueError, OSError):
            raise TransportError('invalid_ca') from None
        if _client_identity is not None:
            failed = False
            try:
                if type(_client_identity) is not ClientIdentity:
                    raise ValueError()
                _client_identity._load_into(context)
            except Exception:
                failed = True
            if failed:
                raise TransportError('client_identity_failed')
        self._max_response = max_response_bytes
        self._duration = float(total_timeout_seconds)
        self._closed = False
        limits = httpx.Limits(max_connections=max_connections,
                              max_keepalive_connections=max_connections)
        backend = httpx.AsyncHTTPTransport(verify=context, trust_env=False, retries=0,
                                          limits=limits, http1=True, http2=False)
        self._client = httpx.AsyncClient(transport=backend, trust_env=False,
            follow_redirects=False, auth=None, cookies=CookieJar(policy=_NoCookies()),
            timeout=httpx.Timeout(self._duration))

    async def __aenter__(self):
        if self._closed:
            raise TransportError('channel_closed')
        return self

    async def __aexit__(self, exc_type, exc, traceback):
        try:
            await self.aclose()
        except TransportError:
            if not isinstance(exc, asyncio.CancelledError):
                raise
            # A failed pool close must not turn an already cancelled task into
            # an ordinary failure eligible for retry. aclose has disabled reuse;
            # keep the cleanup uncertainty explicit on the original cancellation.
            exc.add_note('channel_cleanup_unverified: close_failed')

    async def aclose(self) -> None:
        self._closed = True
        try:
            await self._client.aclose()
            return
        except Exception:
            pass
        # Cancellation remains a BaseException and propagates; any other close
        # failure is explicit/uncertain, never a successful cleanup receipt.
        raise TransportError('close_failed')

    async def get_json(self, path: str):
        path = _path(path)
        # Explicit Request avoids merging client cookies/headers/params. No user
        # header, auth, query, absolute URL, proxy or per-call transport override.
        request = httpx.Request('GET', self._origin + path,
                                headers={'Accept': 'application/json',
                                         'Accept-Encoding': 'identity'})
        _, result = await self._request_json(request, (200,))
        return result

    async def _request_json(self, request: httpx.Request, statuses: tuple[int, ...], validator=None):
        # Private shared transport mechanics. Public callers never supply a Request,
        # destination, method or status policy; closed adapters create those here.
        if self._closed:
            raise TransportError('channel_closed')
        deadline = asyncio.get_running_loop().time() + self._duration
        try:
            async with asyncio.timeout_at(deadline):
                response = await self._client.send(request, stream=True, follow_redirects=False)
                body_cancelled = False
                try:
                    if 300 <= response.status_code < 400:
                        raise TransportError('redirect_refused')
                    if response.status_code not in statuses:
                        raise TransportError('http_status_refused')
                    if response.headers.get('content-encoding', '').strip().lower() not in ('', 'identity'):
                        raise TransportError('compression_refused')
                    if response.headers.get('content-type', '').split(';', 1)[0].strip().lower() != 'application/json':
                        raise TransportError('content_type_refused')
                    data = bytearray()
                    async for chunk in response.aiter_raw():
                        if len(chunk) > self._max_response - len(data):
                            raise TransportError('response_too_large')
                        data.extend(chunk)
                    result = _json(data)
                    if validator is not None:
                        result = validator(response.status_code, result)
                except asyncio.CancelledError:
                    body_cancelled = True
                    raise
                finally:
                    close_failed = False
                    try:
                        await response.aclose()
                    except asyncio.CancelledError:
                        self._closed = True
                        raise
                    except Exception:
                        close_failed = True
                    if close_failed:
                        self._closed = True
                        # Preserve a body cancellation even if response cleanup
                        # also fails. The caller must still close the whole pool.
                        if not body_cancelled:
                            raise TransportError('close_failed')
                # Cleanup may itself yield or take synchronous time. Delivery
                # must be checked AFTER it, not in a return pending its finally.
                await asyncio.sleep(0)
                if asyncio.get_running_loop().time() >= deadline:
                    raise TimeoutError
                return response.status_code, result
        except TransportError as error:
            failure = error.code
        except (TimeoutError, httpx.TimeoutException):
            failure = 'request_timeout'
        except httpx.ConnectError as error:
            # Exception chain used only for classification, never exposed/logged.
            failure = 'connection_failed'
            cause = error
            for _ in range(8):
                if isinstance(cause, ssl.SSLError):
                    failure = 'tls_failed'
                    break
                cause = cause.__cause__ or cause.__context__
                if cause is None:
                    break
        except httpx.HTTPError:
            failure = 'transport_failed'
        except Exception:
            # Native automatic response-close or an unknown adapter failure may
            # escape HTTPX's exception mapping. Never expose it or reuse the pool.
            self._closed = True
            failure = 'transport_failed'
        # Never chain raw HTTP/SSL exceptions into the public failure.
        raise TransportError(failure)


class MutualTLSChannel(PreparationChannel):
    """T1 transport with a required local client identity; never enrolment or authority."""

    def __init__(self, *, origin: str, ca_pem: bytes, max_response_bytes: int,
                 total_timeout_seconds: float, max_connections: int,
                 client_identity: ClientIdentity):
        if type(client_identity) is not ClientIdentity:
            raise TransportError('client_identity_required')
        super().__init__(origin=origin, ca_pem=ca_pem, max_response_bytes=max_response_bytes,
                         total_timeout_seconds=total_timeout_seconds,
                         max_connections=max_connections, _client_identity=client_identity)


# Request/response bounds derive from the existing authoritative server contract:
# apps/sim/lib/api/contracts/desktop-agent-enrollment.ts. No authority is minted here.
_ENROLLMENT_REQUEST_BYTES = 196608
_ENROLLMENT_ID = re.compile(r'[A-Za-z0-9_-]{1,128}', re.ASCII)
_ENROLLMENT_CODE = re.compile(r'[A-Za-z0-9_-]{43}', re.ASCII)
_ENROLLMENT_SID = re.compile(r'S-1-\d+(?:-\d+){1,14}', re.ASCII)
_ENROLLMENT_SIGNATURE = re.compile(r'[A-Za-z0-9_+/=-]+', re.ASCII)


def _exact_fields(value, names):
    return (type(value) is dict and len(value) == len(names)
            and all(type(key) is str for key in value) and set(value) == set(names))


def _text(value, maximum):
    # Zod/JavaScript count UTF-16 code units; Python len alone counts code points.
    return (type(value) is str and 1 <= len(value) <= maximum and '\0' not in value
            and sum(1 + (ord(char) > 0xFFFF) for char in value) <= maximum)


def _enrollment_payload(body, stage):
    fields = ('enrollmentId', 'code', 'csrPem', 'windowsSid' if stage == 'challenge' else 'signature')
    valid = (_exact_fields(body, fields)
             and _text(body['enrollmentId'], 128) and _ENROLLMENT_ID.fullmatch(body['enrollmentId'])
             and _text(body['code'], 43) and _ENROLLMENT_CODE.fullmatch(body['code'])
             and _text(body['csrPem'], 16384))
    if valid:
        valid = (_text(body['windowsSid'], 184) and _ENROLLMENT_SID.fullmatch(body['windowsSid'])
                 if stage == 'challenge' else
                 _text(body['signature'], 8192) and _ENROLLMENT_SIGNATURE.fullmatch(body['signature']))
    if not valid:
        raise TransportError('invalid_enrollment_request')
    payload = None
    try:
        # Captured immutable bytes before the first await; no custom object hooks survive.
        payload = json.dumps(body, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    except (ValueError, TypeError, UnicodeError):
        pass
    if payload is None:
        raise TransportError('invalid_enrollment_request')
    if len(payload) > _ENROLLMENT_REQUEST_BYTES:
        raise TransportError('request_too_large')
    return payload


def _instant(value):
    return (type(value) in (int, float) and 0 <= value <= 8640000000000000
            and math.isfinite(value) and value == int(value))


def _enrollment_result(stage, enrollment_id, status, result):
    def identifier(value):
        return _text(value, 128) and _ENROLLMENT_ID.fullmatch(value)

    def digest(value):
        return type(value) is str and re.fullmatch(r'[0-9a-f]{64}', value, re.ASCII)

    if stage == 'challenge':
        valid = (_exact_fields(result, ('enrollmentId', 'challengePayload', 'expiresAt'))
                 and result['enrollmentId'] == enrollment_id
                 and _text(result['challengePayload'], 4096) and _instant(result['expiresAt']))
    elif status == 202:
        valid = (_exact_fields(result, ('status', 'enrollmentId'))
                 and result['status'] == 'issuance_unknown' and result['enrollmentId'] == enrollment_id)
    else:
        valid = (_exact_fields(result, ('status', 'enrollmentId', 'agentId', 'issuanceId', 'bindingDigest', 'certificate'))
                 and result['status'] == 'issued' and result['enrollmentId'] == enrollment_id
                 and identifier(result['agentId']) and identifier(result['issuanceId'])
                 and digest(result['bindingDigest']))
        if valid:
            cert = result['certificate']
            valid = (_exact_fields(cert, ('certificateSerial', 'certificateSha256', 'certificatePem',
                                          'spkiSha256', 'notBefore', 'notAfter'))
                     and type(cert['certificateSerial']) is str
                     and re.fullmatch(r'[0-9a-f]{1,40}', cert['certificateSerial'], re.ASCII)
                     and digest(cert['certificateSha256']) and digest(cert['spkiSha256'])
                     and _text(cert['certificatePem'], 16384)
                     and _instant(cert['notBefore']) and _instant(cert['notAfter'])
                     and cert['notBefore'] < cert['notAfter'])
    if not valid:
        raise TransportError('invalid_enrollment_response')
    # Structural/correlation check only. No cryptographic certificate installation or trust.
    return result


class EnrollmentChannel(PreparationChannel):
    """Server-authenticated one-shot exchange only; no agent identity or authority.

    The caller must already own durable pending state before a remote enrollment
    journey uses this primitive. No key, credential store or certificate is installed.
    """

    def __init__(self, *, origin: str, ca_pem: bytes, max_response_bytes: int,
                 total_timeout_seconds: float, max_connections: int):
        super().__init__(origin=origin, ca_pem=ca_pem,
                         max_response_bytes=max_response_bytes,
                         total_timeout_seconds=total_timeout_seconds,
                         max_connections=max_connections)

    async def challenge(self, body: dict):
        payload = _enrollment_payload(body, 'challenge')
        request = httpx.Request('POST', self._origin + '/api/desktop-agent-enrollments/challenge',
                                content=payload, headers={'Accept': 'application/json',
                                    'Accept-Encoding': 'identity', 'Content-Type': 'application/json'})
        enrollment_id = body['enrollmentId']
        _, result = await self._request_json(request, (200,),
            lambda status, result: _enrollment_result('challenge', enrollment_id, status, result))
        return result

    async def complete(self, body: dict):
        payload = _enrollment_payload(body, 'complete')
        request = httpx.Request('POST', self._origin + '/api/desktop-agent-enrollments/complete',
                                content=payload, headers={'Accept': 'application/json',
                                    'Accept-Encoding': 'identity', 'Content-Type': 'application/json'})
        enrollment_id = body['enrollmentId']
        _, result = await self._request_json(request, (200, 202),
            lambda status, result: _enrollment_result('complete', enrollment_id, status, result))
        return result
