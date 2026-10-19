"""Mutex du bureau local : ni autorité, ni consentement, ni bail/fence durable."""

from __future__ import annotations

import ctypes
from ctypes import wintypes
import os
import threading

from .session import SessionObservation, _function, observe_session

# Le namespace Local est isolé par session Windows. Ne pas le partitionner par
# cabinet/agent : deux installations ne peuvent pas contrôler le même bureau.
_MUTEX_NAME = 'Local\\Memlia.Desktop.v1'
_registry_lock = threading.Lock()
_reserved = False


class ResourceUnavailable(RuntimeError):
    """Refus local ; abandoned_desktop impose une réconciliation durable au caller."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


class _Mutex:
    def __init__(self):
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        self._create = _function(kernel, 'CreateMutexExW', wintypes.HANDLE,
                                 [ctypes.c_void_p, wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD])
        self._wait = _function(kernel, 'WaitForSingleObject', wintypes.DWORD,
                               [wintypes.HANDLE, wintypes.DWORD])
        self._release = _function(kernel, 'ReleaseMutex', wintypes.BOOL, [wintypes.HANDLE])
        self._close = _function(kernel, 'CloseHandle', wintypes.BOOL, [wintypes.HANDLE])

    def create(self):
        # ACL par défaut du token utilisateur ; handle non héritable ; pas de Global.
        handle = self._create(None, _MUTEX_NAME, 0, 0x00100001)  # SYNCHRONIZE | MUTEX_MODIFY_STATE
        if not handle:
            raise ResourceUnavailable('mutex_create_failed')
        return handle

    def wait(self, handle):
        return self._wait(handle, 0)  # Jamais d'attente bloquante ni de retry automatique.

    def release(self, handle):
        if not self._release(handle):
            raise ResourceUnavailable('mutex_release_failed')

    def close(self, handle):
        if not self._close(handle):
            raise ResourceUnavailable('mutex_close_failed')


class DesktopReservation:
    """Handle possédé par un thread, à fermer via with/finally dans ce même thread.

    Une réservation ne peut pas être transférée à un pool de threads. Le futur
    dispatcher doit conserver ce thread jusqu'à l'arrêt des seuls travaux possédés.
    """

    def __init__(self, api: _Mutex, handle, observation: SessionObservation):
        self._api = api
        self._handle = handle
        self.observation = observation
        # Référence forte : un numéro natif peut être réattribué après décès.
        self._thread = threading.current_thread()
        # Les DummyThread de callbacks natifs ne suivent pas la fin du thread.
        # Profil Python 3.12+ qualifié : principal et threading.Thread uniquement.
        if isinstance(self._thread, threading._DummyThread):
            raise ResourceUnavailable('unsupported_thread')
        self._pid = os.getpid()
        self._thread_id = threading.get_native_id()
        self._owned = True
        self._closed = False
        self._entered = False

    def _require_owner(self):
        if self._closed:
            raise ResourceUnavailable('reservation_closed')
        if (self._pid != os.getpid()
                or self._thread is not threading.current_thread()
                or not self._thread.is_alive()
                or self._thread_id != threading.get_native_id()):
            raise ResourceUnavailable('reservation_owner_mismatch')

    def ensure_current(self) -> SessionObservation:
        """Recontrôle instantané avant action ; pas d'autorisation d'effet."""
        self._require_owner()
        if not self._owned:
            raise ResourceUnavailable('reservation_not_owned')
        current = observe_session()
        if (current.windows_sid, current.session_id) != (self.observation.windows_sid, self.observation.session_id):
            raise ResourceUnavailable('session_changed')
        return current

    def close(self) -> None:
        global _reserved
        if self._closed:
            return
        self._require_owner()
        # Conserver l'état sur échec pour permettre au propriétaire de réparer la
        # fermeture ; surtout ne pas annoncer une libération qui a échoué.
        if self._owned:
            self._api.release(self._handle)
            self._owned = False
        self._api.close(self._handle)
        self._closed = True
        with _registry_lock:
            _reserved = False

    def __enter__(self):
        self._require_owner()
        if self._entered:
            raise ResourceUnavailable('reservation_already_entered')
        self._entered = True
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        self.close()
        return False


def reserve_desktop() -> DesktopReservation:
    """Réserve sans attendre le bureau observé ; refus hors profil interactif.

    Le caller doit déjà disposer d'une autorité serveur, d'une qualification, d'un
    consentement local et de fences valides avant tout effet. Aucun effet ici.
    """
    global _reserved
    observation = observe_session()
    with _registry_lock:
        # Win32 autorise la réentrance du même thread ; Memlia doit la refuser.
        if _reserved:
            raise ResourceUnavailable('desktop_busy')
        _reserved = True
    handle = None
    owned = False
    try:
        api = _Mutex()
        handle = api.create()
        status = api.wait(handle)
        if status == 0x80:  # WAIT_ABANDONED donne la propriété, mais jamais un run sûr.
            owned = True
            raise ResourceUnavailable('abandoned_desktop')
        if status == 0x102:
            raise ResourceUnavailable('desktop_busy')
        if status != 0:
            raise ResourceUnavailable('mutex_wait_failed')
        owned = True
        reservation = DesktopReservation(api, handle, observation)
        reservation.ensure_current()
        return reservation
    except BaseException:
        # Aucun transfert de travail n'a eu lieu. Si cleanup échoue, le registre
        # reste réservé : arrêt/refus, pas de deuxième acquisition supposée sûre.
        if handle is not None:
            if owned:
                api.release(handle)
            api.close(handle)
        with _registry_lock:
            _reserved = False
        raise
