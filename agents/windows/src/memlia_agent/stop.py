"""Arrêt local coopératif ; aucune autorité, capture ou annulation d'effet acquis."""

from __future__ import annotations

from contextlib import contextmanager
import ctypes
from ctypes import wintypes
import math
import os
import threading
import time

from .resources import DesktopReservation
from .session import _function, observe_session

_HOTKEY_ID = 0x4D45  # Application, sous 0xBFFF ; jamais choisi par une commande.
_MODIFIERS = 0x0007  # CONTROL | ALT | SHIFT
_VK_F11 = 0x7A  # F12 est réservé au débogueur Windows.
_WM_HOTKEY = 0x0312
_WM_QUIT = 0x0012
_JOIN_SECONDS = 2.0
_POLL_SECONDS = .05


class StopUnavailable(RuntimeError):
    """Refus fixe ; cleanup_unverified/cleanup_failed imposent un état HOLD."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


class StopRequested(RuntimeError):
    """Arrêt demandé ou échéance ; ne signifie jamais qu'un effet est annulé."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


class _Hotkey:
    """Les trois appels Win32 restent sur le seul thread d'enregistrement."""

    def __init__(self):
        user = ctypes.WinDLL('user32', use_last_error=True, winmode=0x800)
        self._register = _function(user, 'RegisterHotKey', wintypes.BOOL,
                                   [wintypes.HWND, ctypes.c_int, wintypes.UINT, wintypes.UINT])
        self._unregister = _function(user, 'UnregisterHotKey', wintypes.BOOL,
                                     [wintypes.HWND, ctypes.c_int])
        self._peek = _function(user, 'PeekMessageW', wintypes.BOOL,
                               [ctypes.POINTER(wintypes.MSG), wintypes.HWND,
                                wintypes.UINT, wintypes.UINT, wintypes.UINT])

    def register(self):
        if not self._register(None, _HOTKEY_ID, _MODIFIERS | 0x4000, _VK_F11):
            raise StopUnavailable('hotkey_unavailable')

    def poll(self):
        message = wintypes.MSG()
        # HWND(-1) : seuls messages de thread ; aucune fenêtre ni hook clavier.
        # Zéro veut dire « aucun message », pas une erreur via GetLastError.
        if not self._peek(ctypes.byref(message), wintypes.HWND(-1),
                          _WM_HOTKEY, _WM_HOTKEY, 1):  # PM_REMOVE
            return None
        return message.message, message.wParam, message.lParam

    def unregister(self):
        if not self._unregister(None, _HOTKEY_ID):
            raise StopUnavailable('hotkey_cleanup_failed')


class LocalStop:
    """Signal monotone et lifecycle possédé ; obtenir via arm_local_stop()."""

    def __init__(self, reservation: DesktopReservation, deadline_monotonic: float):
        valid_deadline = False
        try:
            valid_deadline = (type(deadline_monotonic) in (int, float)
                              and math.isfinite(deadline_monotonic)
                              and deadline_monotonic > time.monotonic())
        except OverflowError:
            pass
        if not valid_deadline:
            raise StopUnavailable('invalid_deadline')
        self._owner = threading.current_thread()
        if isinstance(self._owner, threading._DummyThread):
            raise StopUnavailable('unsupported_thread')
        self._pid = os.getpid()
        self._native_id = threading.get_native_id()
        current = None
        if isinstance(reservation, DesktopReservation):
            try:
                current = reservation.ensure_current()
            except Exception:
                pass
        if current is None:
            raise StopUnavailable('reservation_unavailable')
        self._reservation = reservation
        self._observation = current
        self._deadline = deadline_monotonic
        self._stop = threading.Event()
        self._ready = threading.Event()
        self._done = threading.Event()
        self._lock = threading.Lock()
        self._failure = None
        self._cleanup_failed = False
        self._started = False
        self._closed = False
        self._thread = threading.Thread(target=self._listen, name='Memlia-local-stop', daemon=False)

    @property
    def stopped(self) -> bool:
        return self._stop.is_set()

    def request_stop(self) -> None:
        """Utilisable depuis tout thread ; aucun reset/transfert vers un autre run."""
        self._stop.set()

    def _fail(self, code):
        with self._lock:
            if self._failure is None:
                self._failure = code
        self.request_stop()

    def _require_owner(self):
        if (self._pid != os.getpid() or self._owner is not threading.current_thread()
                or not self._owner.is_alive() or self._native_id != threading.get_native_id()):
            self._fail('stop_owner_mismatch')
            raise StopUnavailable('stop_owner_mismatch')

    def _listen(self):
        api = None
        registered = False
        stage = 'session_unavailable'
        try:
            current = observe_session()
            if ((current.windows_sid, current.session_id)
                    != (self._observation.windows_sid, self._observation.session_id)):
                self._fail(stage)
                return
            stage = 'hotkey_unavailable'
            api = _Hotkey()
            api.register()
            registered = True
            self._ready.set()
            stage = 'hotkey_pump_failed'
            while not self.stopped:
                if time.monotonic() >= self._deadline:
                    self.request_stop()
                    break
                # Borne de drainage contre la famine en cas de messages répétés.
                for _ in range(32):
                    message = api.poll()
                    if message is None:
                        break
                    kind, identifier, keys = message
                    if kind == _WM_QUIT:
                        self._fail(stage)
                        break
                    if (kind == _WM_HOTKEY and identifier == _HOTKEY_ID
                            and keys == (_VK_F11 << 16) | _MODIFIERS):
                        self.request_stop()
                        break
                self._stop.wait(min(_POLL_SECONDS, max(0, self._deadline - time.monotonic())))
        except BaseException:
            self._fail(stage)
        finally:
            if registered:
                try:
                    api.unregister()
                except Exception:
                    with self._lock:
                        self._cleanup_failed = True
                    self._fail('hotkey_cleanup_failed')
            self._ready.set()
            self._done.set()

    def _start(self):
        failed = False
        # KeyboardInterrupt peut interrompre Thread.start après création native.
        # Close devra alors tenter join, même sans retour normal de start().
        self._started = True
        try:
            self._thread.start()
        except Exception:
            self._started = self._thread.ident is not None
            failed = True
        if failed:
            self._fail('hotkey_start_failed')
            raise StopUnavailable('hotkey_start_failed')
        remaining = max(0, self._deadline - time.monotonic())
        if not self._ready.wait(min(_JOIN_SECONDS, remaining)):
            self._fail('hotkey_start_timeout')
            raise StopUnavailable('hotkey_start_timeout')
        self.checkpoint()

    def _check_signal(self):
        with self._lock:
            failure = self._failure
        if failure:
            raise StopUnavailable(failure)
        if self._closed:
            raise StopUnavailable('stop_closed')
        if time.monotonic() >= self._deadline:
            self.request_stop()
            raise StopRequested('deadline_expired')
        if self.stopped:
            raise StopRequested('stop_requested')
        if not self._started or not self._thread.is_alive():
            self._fail('hotkey_monitor_unavailable')
            raise StopUnavailable('hotkey_monitor_unavailable')

    def checkpoint(self) -> None:
        """Exiger ce contrôle juste avant chaque prochaine action/batch possédé."""
        self._require_owner()
        self._check_signal()
        failed = False
        try:
            self._reservation.ensure_current()
        except Exception:
            failed = True
        if failed:
            self._fail('reservation_unavailable')
            raise StopUnavailable('reservation_unavailable')
        # Un signal/délai peut être arrivé pendant l'observation native synchrone.
        self._check_signal()

    def close(self) -> None:
        self._require_owner()
        if self._closed:
            return
        self.request_stop()
        if self._started:
            failed = False
            try:
                self._thread.join(_JOIN_SECONDS)
            except Exception:
                failed = True
            if failed or self._thread.is_alive() or not self._done.is_set():
                self._fail('hotkey_cleanup_unverified')
                raise StopUnavailable('hotkey_cleanup_unverified')
            with self._lock:
                cleanup_failed = self._cleanup_failed
            if cleanup_failed:
                raise StopUnavailable('hotkey_cleanup_failed')
        self._closed = True


@contextmanager
def arm_local_stop(reservation: DesktopReservation, *, deadline_monotonic: float):
    """N'accorde aucun droit ; aucun travail ne peut commencer avant le yield."""
    signal = LocalStop(reservation, deadline_monotonic)
    try:
        signal._start()
        yield signal
    finally:
        signal.close()
