"""Observation Win32 en lecture seule, sans capture, consentement ou autorité."""

from __future__ import annotations

import ctypes
from ctypes import wintypes
from dataclasses import dataclass
import struct
import sys
from types import SimpleNamespace


class SessionUnavailable(RuntimeError):
    """Refus local ; code stable ne contenant ni secret ni contenu du bureau."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


@dataclass(frozen=True)
class SessionObservation:
    """Métadonnées instantanées, jamais une SessionCapability du contrat P00."""

    windows_sid: str
    session_id: int
    monitor_count: int


def observe_session() -> SessionObservation:
    """Refuse hors profil Windows 11 x64, console locale et Default.

    Réinterroger avant chaque action. Ce résultat n'est ni un consentement, ni une
    garantie que le bureau restera disponible, ni une qualification OpenAdapt/Excel.
    """
    if sys.platform != 'win32':
        raise SessionUnavailable('unsupported_platform')
    try:
        observed = _collect_native()
    except (OSError, AttributeError):
        raise SessionUnavailable('native_observation_failed') from None
    checks = (
        (observed.build >= 22000 and observed.product_type == 1, 'unsupported_windows'),
        (observed.pointer_size == 8 and observed.native_machine == 0x8664
         and observed.process_machine == 0, 'unsupported_architecture'),
        (observed.session_id != 0, 'session_zero'),
        (observed.console_session_id != 0xFFFFFFFF
         and observed.console_session_id == observed.session_id, 'inactive_console'),
        (observed.connection_state == 0, 'inactive_session'),
        (observed.protocol == 0, 'remote_session'),
        (not observed.elevated, 'elevated_process'),
        (observed.windows_sid not in {'S-1-5-18', 'S-1-5-19', 'S-1-5-20'}, 'service_identity'),
        (observed.window_station.lower() == 'winsta0', 'noninteractive_station'),
        (observed.thread_desktop.lower() == 'default', 'nondefault_desktop'),
        (observed.input_desktop.lower() == 'default', 'input_desktop_unavailable'),
    )
    for valid, code in checks:
        if not valid:
            raise SessionUnavailable(code)
    return SessionObservation(observed.windows_sid, observed.session_id, observed.monitor_count)


def _function(dll, name, result, arguments):
    function = getattr(dll, name)
    function.restype = result
    function.argtypes = arguments
    return function


def _collect_native() -> SimpleNamespace:
    """Ne lit que token User/Elevation, session et noms d'objets système."""
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    user = ctypes.WinDLL('user32', use_last_error=True)
    advapi = ctypes.WinDLL('advapi32', use_last_error=True)
    wts = ctypes.WinDLL('wtsapi32', use_last_error=True)
    pointer = ctypes.c_void_p
    get_process = _function(kernel, 'GetCurrentProcess', wintypes.HANDLE, [])
    get_pid = _function(kernel, 'GetCurrentProcessId', wintypes.DWORD, [])
    get_tid = _function(kernel, 'GetCurrentThreadId', wintypes.DWORD, [])
    to_session = _function(kernel, 'ProcessIdToSessionId', wintypes.BOOL,
                           [wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)])
    console = _function(kernel, 'WTSGetActiveConsoleSessionId', wintypes.DWORD, [])
    wow64 = _function(kernel, 'IsWow64Process2', wintypes.BOOL,
                     [wintypes.HANDLE, ctypes.POINTER(wintypes.WORD), ctypes.POINTER(wintypes.WORD)])
    close_handle = _function(kernel, 'CloseHandle', wintypes.BOOL, [wintypes.HANDLE])
    open_token = _function(advapi, 'OpenProcessToken', wintypes.BOOL,
                          [wintypes.HANDLE, wintypes.DWORD, ctypes.POINTER(wintypes.HANDLE)])
    token_info = _function(advapi, 'GetTokenInformation', wintypes.BOOL,
                          [wintypes.HANDLE, ctypes.c_int, pointer, wintypes.DWORD,
                           ctypes.POINTER(wintypes.DWORD)])
    convert_sid = _function(advapi, 'ConvertSidToStringSidW', wintypes.BOOL,
                           [pointer, ctypes.POINTER(pointer)])
    local_free = _function(kernel, 'LocalFree', pointer, [pointer])
    station = _function(user, 'GetProcessWindowStation', wintypes.HANDLE, [])
    thread_desktop = _function(user, 'GetThreadDesktop', wintypes.HANDLE, [wintypes.DWORD])
    input_desktop = _function(user, 'OpenInputDesktop', wintypes.HANDLE,
                             [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD])
    object_info = _function(user, 'GetUserObjectInformationW', wintypes.BOOL,
                           [wintypes.HANDLE, ctypes.c_int, pointer, wintypes.DWORD,
                            ctypes.POINTER(wintypes.DWORD)])
    close_desktop = _function(user, 'CloseDesktop', wintypes.BOOL, [wintypes.HANDLE])
    metrics = _function(user, 'GetSystemMetrics', ctypes.c_int, [ctypes.c_int])
    query_wts = _function(wts, 'WTSQuerySessionInformationW', wintypes.BOOL,
                         [wintypes.HANDLE, wintypes.DWORD, ctypes.c_int,
                          ctypes.POINTER(pointer), ctypes.POINTER(wintypes.DWORD)])
    free_wts = _function(wts, 'WTSFreeMemory', None, [pointer])

    def require(value):
        if not value:
            raise ctypes.WinError(ctypes.get_last_error())
        return value

    def object_name(handle):
        require(handle)
        text = ctypes.create_unicode_buffer(256)
        needed = wintypes.DWORD()
        require(object_info(handle, 2, text, ctypes.sizeof(text), ctypes.byref(needed)))
        return text.value

    current_session = wintypes.DWORD()
    require(to_session(get_pid(), ctypes.byref(current_session)))
    # Aucun appel au bureau/token n'est nécessaire depuis un service ou SSH session0.
    if current_session.value == 0:
        raise SessionUnavailable('session_zero')
    process_machine, native_machine = wintypes.WORD(), wintypes.WORD()
    require(wow64(get_process(), ctypes.byref(process_machine), ctypes.byref(native_machine)))

    def wts_number(info_class, scalar):
        buffer, size = pointer(), wintypes.DWORD()
        require(query_wts(None, current_session.value, info_class, ctypes.byref(buffer), ctypes.byref(size)))
        try:
            if not buffer.value or size.value != ctypes.sizeof(scalar):
                raise OSError('Invalid WTS response')
            return ctypes.cast(buffer, ctypes.POINTER(scalar)).contents.value
        finally:
            free_wts(buffer)

    token = wintypes.HANDLE()
    require(open_token(get_process(), 0x0008, ctypes.byref(token)))  # TOKEN_QUERY uniquement
    try:
        needed = wintypes.DWORD()
        elevation = wintypes.DWORD()
        require(token_info(token, 20, ctypes.byref(elevation), ctypes.sizeof(elevation), ctypes.byref(needed)))
        token_info(token, 1, None, 0, ctypes.byref(needed))
        if not 0 < needed.value <= 65536:
            raise OSError('Invalid token size')
        token_user = ctypes.create_string_buffer(needed.value)
        require(token_info(token, 1, token_user, needed.value, ctypes.byref(needed)))
        sid = ctypes.cast(token_user, ctypes.POINTER(pointer)).contents
        sid_text = pointer()
        require(convert_sid(sid, ctypes.byref(sid_text)))
        try:
            windows_sid = ctypes.wstring_at(sid_text)
        finally:
            if local_free(sid_text):
                raise OSError('SID buffer cleanup failed')
    finally:
        require(close_handle(token))
    # Handles station/thread empruntés ; seul OpenInputDesktop doit être fermé.
    station_name = object_name(station())
    thread_name = object_name(thread_desktop(get_tid()))
    desktop = require(input_desktop(0, False, 0x0001))  # DESKTOP_READOBJECTS, sans hook
    try:
        input_name = object_name(desktop)
    finally:
        require(close_desktop(desktop))
    version = sys.getwindowsversion()
    return SimpleNamespace(
        build=version.build, product_type=version.product_type, pointer_size=struct.calcsize('P'),
        native_machine=native_machine.value, process_machine=process_machine.value,
        session_id=current_session.value, console_session_id=console(),
        connection_state=wts_number(8, wintypes.DWORD), protocol=wts_number(16, wintypes.WORD),
        windows_sid=windows_sid, elevated=bool(elevation.value),
        window_station=station_name, thread_desktop=thread_name, input_desktop=input_name,
        monitor_count=metrics(80),
    )
