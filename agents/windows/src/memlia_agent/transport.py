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

    async def __aexit__(self, *exc):
        await self.aclose()

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
        if self._closed:
            raise TransportError('channel_closed')
        # Explicit Request avoids merging client cookies/headers/params. No user
        # header, auth, query, absolute URL, proxy or per-call transport override.
        request = httpx.Request('GET', self._origin + path,
                                headers={'Accept': 'application/json',
                                         'Accept-Encoding': 'identity'})
        deadline = asyncio.get_running_loop().time() + self._duration
        try:
            async with asyncio.timeout_at(deadline):
                response = await self._client.send(request, stream=True, follow_redirects=False)
                body_cancelled = False
                try:
                    if 300 <= response.status_code < 400:
                        raise TransportError('redirect_refused')
                    if response.status_code != 200:
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
                return result
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
