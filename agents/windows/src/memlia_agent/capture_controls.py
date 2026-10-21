# Copyright (c) 2026 Memlia. All rights reserved.
"""Local decision and indicator, not command authority or a recording engine."""
from __future__ import annotations

from contextlib import contextmanager
import ctypes
import os
import re
import sys
import threading
import time

from .resources import DesktopReservation
from .session import _function, observe_session
from .stop import LocalStop

_APPROVE = 100
_FINISH = 101
_CANCEL = 2
_JOIN_SECONDS = 2.0
_POLL_SECONDS = .05
_HEARTBEAT_SECONDS = 1.0
_DIGEST = re.compile(r'sha256:[a-f0-9]{64}\Z')


# WinSDK CommCtrl.h places BOTH structures between pshpack1.h and poppack.h.
# Fixed-width integers avoid host-dependent wintypes sizes in portable ABI tests.
class _Button(ctypes.Structure):
    _pack_ = 1
    _fields_ = [('nButtonID', ctypes.c_int32), ('pszButtonText', ctypes.c_wchar_p)]


class _Config(ctypes.Structure):
    _pack_ = 1
    _fields_ = [
        ('cbSize', ctypes.c_uint32), ('hwndParent', ctypes.c_void_p),
        ('hInstance', ctypes.c_void_p), ('dwFlags', ctypes.c_uint32),
        ('dwCommonButtons', ctypes.c_uint32), ('pszWindowTitle', ctypes.c_wchar_p),
        ('mainIcon', ctypes.c_void_p), ('pszMainInstruction', ctypes.c_wchar_p),
        ('pszContent', ctypes.c_wchar_p), ('cButtons', ctypes.c_uint32),
        ('pButtons', ctypes.POINTER(_Button)), ('nDefaultButton', ctypes.c_int32),
        ('cRadioButtons', ctypes.c_uint32), ('pRadioButtons', ctypes.POINTER(_Button)),
        ('nDefaultRadioButton', ctypes.c_int32), ('pszVerificationText', ctypes.c_wchar_p),
        ('pszExpandedInformation', ctypes.c_wchar_p), ('pszExpandedControlText', ctypes.c_wchar_p),
        ('pszCollapsedControlText', ctypes.c_wchar_p), ('footerIcon', ctypes.c_void_p),
        ('pszFooter', ctypes.c_wchar_p), ('pfCallback', ctypes.c_void_p),
        ('lpCallbackData', ctypes.c_ssize_t), ('cxWidth', ctypes.c_uint32),
    ]


class _Rect(ctypes.Structure):
    _fields_ = [(name, ctypes.c_int32) for name in ('left', 'top', 'right', 'bottom')]


class _Point(ctypes.Structure):
    _fields_ = [('x', ctypes.c_int32), ('y', ctypes.c_int32)]


class _Monitor(ctypes.Structure):
    _fields_ = [('cbSize', ctypes.c_uint32), ('monitor', _Rect),
                ('work', _Rect), ('flags', ctypes.c_uint32)]


class CaptureUnavailable(RuntimeError):
    """Fixed refusal; cleanup_unverified requires HOLD, never a new capture."""

    def __init__(self, code):
        self.code = code
        super().__init__(code)


class _TaskDialog:
    """System dialog only; no activation-context/settings fallback or UI manager."""

    def __init__(self):
        if (sys.platform != 'win32' or ctypes.sizeof(ctypes.c_void_p) != 8
                or ctypes.sizeof(ctypes.c_wchar) != 2):
            raise CaptureUnavailable('dialog_unavailable')
        user = ctypes.WinDLL('user32', use_last_error=True, winmode=0x800)
        common = ctypes.WinDLL('comctl32', use_last_error=True, winmode=0x800)
        dwm = ctypes.WinDLL('dwmapi', use_last_error=True, winmode=0x800)
        pointer, u32, i32 = ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int32
        self._dialog = _function(common, 'TaskDialogIndirect', i32,
                                 [ctypes.POINTER(_Config), ctypes.POINTER(i32), pointer, pointer])
        self._set_pos = _function(user, 'SetWindowPos', i32, [pointer, pointer, i32, i32, i32, i32, u32])
        self._visible = _function(user, 'IsWindowVisible', i32, [pointer])
        self._iconic = _function(user, 'IsIconic', i32, [pointer])
        self._enabled = _function(user, 'IsWindowEnabled', i32, [pointer])
        self._thread = _function(user, 'GetWindowThreadProcessId', u32, [pointer, ctypes.POINTER(u32)])
        self._style = _function(user, 'GetWindowLongPtrW', ctypes.c_ssize_t, [pointer, i32])
        self._rect = _function(user, 'GetWindowRect', i32, [pointer, ctypes.POINTER(_Rect)])
        self._monitor = _function(user, 'MonitorFromWindow', pointer, [pointer, u32])
        self._monitor_info = _function(user, 'GetMonitorInfoW', i32, [pointer, ctypes.POINTER(_Monitor)])
        self._cloaked = _function(dwm, 'DwmGetWindowAttribute', i32, [pointer, u32, pointer, u32])
        self._button = _function(user, 'GetDlgItem', pointer, [pointer, i32])
        self._point = _function(user, 'WindowFromPoint', pointer, [_Point])
        self._child = _function(user, 'IsChild', i32, [pointer, pointer])
        self._send = _function(user, 'SendMessageW', ctypes.c_ssize_t,
                               [pointer, u32, ctypes.c_size_t, ctypes.c_ssize_t])
        self._title = _function(user, 'SetWindowTextW', i32, [pointer, ctypes.c_wchar_p])
        self._tid = threading.get_native_id()
        self._pid = os.getpid()

    def make_topmost(self, hwnd):
        # Keep the indicator above ordinary application windows even when inactive.
        if not self._set_pos(hwnd, ctypes.c_void_p(-1), 0, 0, 0, 0, 0x13):
            raise CaptureUnavailable('indicator_unavailable')  # NOMOVE|NOSIZE|NOACTIVATE
        self._finish_enabled(hwnd, False)

    def _finish_enabled(self, hwnd, enabled):
        button = self._button(hwnd, _FINISH)
        if not button:
            raise CaptureUnavailable('indicator_unavailable')
        self._send(hwnd, 0x400 + 111, _FINISH, int(enabled))  # TDM_ENABLE_BUTTON
        if bool(self._enabled(button)) != enabled:
            raise CaptureUnavailable('indicator_unavailable')

    def check_visible(self, hwnd):
        pid = ctypes.c_uint32()
        if (not hwnd or self._thread(hwnd, ctypes.byref(pid)) != self._tid
                or pid.value != self._pid or not self._visible(hwnd) or self._iconic(hwnd)
                or not self._enabled(hwnd) or not self._style(hwnd, -20) & 0x8):  # TOPMOST
            raise CaptureUnavailable('indicator_unavailable')
        cloaked = ctypes.c_uint32()
        if self._cloaked(hwnd, 14, ctypes.byref(cloaked), ctypes.sizeof(cloaked)) != 0 or cloaked.value:
            raise CaptureUnavailable('indicator_unavailable')
        rect, monitor = _Rect(), _Monitor()
        monitor.cbSize = ctypes.sizeof(monitor)
        display = self._monitor(hwnd, 0)  # MONITOR_DEFAULTTONULL; no off-screen fallback.
        if (not self._rect(hwnd, ctypes.byref(rect)) or not display
                or not self._monitor_info(display, ctypes.byref(monitor))
                or not (monitor.work.left <= rect.left < rect.right <= monitor.work.right
                        and monitor.work.top <= rect.top < rect.bottom <= monitor.work.bottom)):
            raise CaptureUnavailable('indicator_unavailable')
        button = self._button(hwnd, _CANCEL)
        button_rect = _Rect()
        if (not button or not self._enabled(button) or not self._visible(button)
                or not self._rect(button, ctypes.byref(button_rect))
                or not (rect.left <= button_rect.left < button_rect.right <= rect.right
                        and rect.top <= button_rect.top < button_rect.bottom <= rect.bottom)):
            raise CaptureUnavailable('indicator_unavailable')
        # Native hit tests check sampled indicator/Stop points for occlusion. They
        # are not a screenshot or proof that a person has seen/read the window.
        for area in (rect, button_rect):
            # GetWindowRect may contain invisible resize borders. Sample interior
            # quarters, not those borders; do not infer that every pixel is visible.
            dx, dy = (area.right - area.left) // 4, (area.bottom - area.top) // 4
            if dx < 1 or dy < 1:
                raise CaptureUnavailable('indicator_unavailable')
            for x, y in ((area.left + dx, area.top + dy), (area.right - dx, area.top + dy),
                         (area.left + dx, area.bottom - dy), (area.right - dx, area.bottom - dy),
                         ((area.left + area.right) // 2, (area.top + area.bottom) // 2)):
                target = self._point(_Point(x, y))
                if target != hwnd and not self._child(hwnd, target):
                    raise CaptureUnavailable('indicator_unavailable')

    def mark_authorized(self, hwnd):
        button = self._button(hwnd, _APPROVE)
        if not button:
            raise CaptureUnavailable('indicator_unavailable')
        self._send(hwnd, 0x400 + 111, _APPROVE, 0)  # TDM_ENABLE_BUTTON, disable only.
        if (self._enabled(button)
                or not self._title(hwnd, 'Memlia — autorisation donnée ; démarrage en attente')):
            raise CaptureUnavailable('indicator_unavailable')

    def mark_recording(self, hwnd):
        if not self._title(hwnd, 'Memlia — enregistrement en cours'):
            raise CaptureUnavailable('indicator_unavailable')
        self._finish_enabled(hwnd, True)

    def mark_finishing(self, hwnd):
        self._finish_enabled(hwnd, False)
        if not self._title(hwnd, 'Memlia — finalisation ; arrêt en cours de vérification'):
            raise CaptureUnavailable('indicator_unavailable')

    def mark_stopping(self, hwnd):
        self._finish_enabled(hwnd, False)
        if not self._title(hwnd, 'Memlia — arrêt demandé ; vérification en cours'):
            raise CaptureUnavailable('indicator_unavailable')

    def cancel(self, hwnd):
        # Called only by the dialog's own callback/thread; never synthesize Approve.
        if threading.get_native_id() != self._tid:
            raise CaptureUnavailable('dialog_owner_mismatch')
        self._send(hwnd, 0x400 + 102, _CANCEL, 0)  # TDM_CLICK_BUTTON

    def show(self, owner):
        callback_type = ctypes.WINFUNCTYPE(ctypes.c_int32, ctypes.c_void_p, ctypes.c_uint32,
                                          ctypes.c_size_t, ctypes.c_ssize_t, ctypes.c_ssize_t)
        callback = callback_type(lambda hwnd, event, value, unused, reference:
                                 owner._notification(self, hwnd, event, value))
        buttons = (_Button * 3)(
            _Button(_APPROVE, 'Autoriser cet enregistrement'),
            _Button(_FINISH, 'Terminer l’enregistrement'),
            _Button(_CANCEL, 'Refuser / Arrêter maintenant'))
        config = _Config()
        config.cbSize = ctypes.sizeof(config)
        config.dwFlags = 0x0008 | 0x0800  # CANCELLATION|CALLBACK_TIMER; no minimize/hyperlinks.
        config.pszWindowTitle = 'Memlia — demande locale de capture'
        config.pszMainInstruction = 'Autorisez-vous cette capture du bureau ?'
        config.pszContent = (
            'Memlia enregistrera les images de ce bureau, vos clics et vos frappes au clavier '
            'pour préparer une démonstration. Le microphone ne fait pas partie de cette autorisation. '
            'N’affichez ni ne saisissez de mot de passe ou d’information confidentielle.\n\n'
            'Aucun enregistrement ne commence avant votre accord local. Ce dialogue restera visible. '
            '« Terminer l’enregistrement » sera disponible après le démarrage vérifié. '
            '« Arrêter maintenant » ou Ctrl + Alt + Maj + F11 annule l’enregistrement ; '
            'aucun résultat n’est alors accepté.')
        config.cButtons, config.pButtons, config.nDefaultButton = 3, buttons, _CANCEL
        config.pfCallback = ctypes.cast(callback, ctypes.c_void_p).value
        selected = ctypes.c_int32()
        # callback/buttons/config remain strongly owned until the modal API returns.
        if self._dialog(ctypes.byref(config), ctypes.byref(selected), None, None) != 0:
            raise CaptureUnavailable('dialog_unavailable')


class _CaptureControls:
    def __init__(self, reservation, signal, digest):
        if type(digest) is not str or not _DIGEST.fullmatch(digest):
            raise CaptureUnavailable('invalid_operation_digest')
        if (not isinstance(reservation, DesktopReservation) or not isinstance(signal, LocalStop)
                or signal._reservation is not reservation):
            raise CaptureUnavailable('capture_binding_unavailable')
        signal.checkpoint()
        self._reservation, self._signal, self._digest = reservation, signal, digest
        # Reuse the stop's captured desktop; checkpoint above revalidated the same
        # reservation. No extra unnormalised observation between these two steps.
        self._observed = signal._observation
        self._owner, self._pid = threading.current_thread(), os.getpid()
        self._owner_id = threading.get_native_id()
        self._lock = threading.RLock()
        self._created, self._decided, self._done = threading.Event(), threading.Event(), threading.Event()
        self._hwnd, self._api, self._failure = None, None, None
        self._approved, self._started, self._closed = False, False, False
        self._closing, self._stopping = False, False
        self._work_pending = self._recording_started = self._recording_stopped = False
        self._recording_indicated = self._finish_requested = False
        self._ui_id, self._last_tick = None, None
        self._thread = threading.Thread(target=self._show, name='Memlia-capture-controls', daemon=False)

    def _fail(self, code):
        with self._lock:
            if self._failure is None:
                self._failure = code
        self._signal.request_stop()
        self._decided.set()

    def _require_owner(self):
        if (self._owner is not threading.current_thread() or not self._owner.is_alive()
                or self._pid != os.getpid() or self._owner_id != threading.get_native_id()):
            self._fail('capture_owner_mismatch')
            raise CaptureUnavailable('capture_owner_mismatch')

    def _same_session(self):
        current = observe_session()
        if current != self._observed:
            raise CaptureUnavailable('capture_session_unavailable')

    def _stop_indicator(self, api, hwnd, *, clicked=False):
        self._signal.request_stop()
        self._decided.set()
        with self._lock:
            closing = self._closing
        if closing:
            if not clicked:
                api.cancel(hwnd)
            return 0
        if not self._stopping:
            api.mark_stopping(hwnd)
            self._stopping = True
        # A stop request does not prove Recorder has finished. Keep the indicator
        # until its owner leaves the context AFTER verifying its owned work stopped.
        return 1

    def _notification(self, api, hwnd, event, value):
        # No exception crosses a ctypes callback. Unknown/failed state only stops.
        try:
            if threading.get_native_id() != self._ui_id or api is not self._api:
                raise CaptureUnavailable('dialog_owner_mismatch')
            if event == 0:  # TDN_CREATED, before display; not consent or visibility.
                with self._lock:
                    if self._hwnd is not None or not hwnd:
                        raise CaptureUnavailable('indicator_unavailable')
                    self._hwnd = hwnd
                api.make_topmost(hwnd)
                self._created.set()
            elif event == 5:  # TDN_DESTROYED: no more messages to this HWND.
                with self._lock:
                    if hwnd != self._hwnd:
                        raise CaptureUnavailable('indicator_unavailable')
                    self._hwnd = None
                self._signal.request_stop()
                self._decided.set()
            elif event == 4 or event == 2:
                if hwnd != self._hwnd or not hwnd:
                    raise CaptureUnavailable('indicator_unavailable')
                if event == 2 and value == _CANCEL:
                    return self._stop_indicator(api, hwnd, clicked=True)
                if self._signal.stopped or time.monotonic() >= self._signal._deadline:
                    return self._stop_indicator(api, hwnd)
                self._same_session()
                api.check_visible(hwnd)
                with self._lock:
                    self._last_tick = time.monotonic()
                if event == 2:
                    if value == _FINISH:
                        if (not self._approved or not self._recording_started
                                or not self._recording_indicated or self._recording_stopped):
                            raise CaptureUnavailable('capture_state_unavailable')
                        if not self._finish_requested:
                            api.mark_finishing(hwnd)
                            self._same_session()
                            api.check_visible(hwnd)
                            if self._signal.stopped or time.monotonic() >= self._signal._deadline:
                                return self._stop_indicator(api, hwnd)
                            with self._lock:
                                self._finish_requested = True
                        return 1
                    if value != _APPROVE or self._approved:
                        raise CaptureUnavailable('local_consent_unavailable')
                    api.mark_authorized(hwnd)
                    self._same_session()
                    api.check_visible(hwnd)
                    if self._signal.stopped or time.monotonic() >= self._signal._deadline:
                        self._stop_indicator(api, hwnd)
                    else:
                        with self._lock:
                            self._approved = True
                        self._decided.set()
                elif (self._approved and self._recording_started and not self._recording_stopped
                      and not self._recording_indicated and not self._finish_requested):
                    api.mark_recording(hwnd)
                    self._same_session()
                    api.check_visible(hwnd)
                    if self._signal.stopped or time.monotonic() >= self._signal._deadline:
                        return self._stop_indicator(api, hwnd)
                    self._recording_indicated = True
                return 1 if event == 2 else 0  # S_FALSE keeps indicator open after approval.
        except BaseException:
            self._fail('indicator_unavailable')
        return 0 if event == 5 else 1

    def _make_dialog(self):
        return _TaskDialog()

    def _show(self):
        stage = 'capture_session_unavailable'
        try:
            self._ui_id = threading.get_native_id()
            self._same_session()
            if self._signal.stopped or time.monotonic() >= self._signal._deadline:
                return
            stage = 'dialog_unavailable'
            self._api = self._make_dialog()
            self._api.show(self)
        except BaseException:
            self._fail(stage)
        finally:
            self._signal.request_stop()
            self._created.set()
            self._decided.set()
            self._done.set()

    def _raise_failure(self):
        with self._lock:
            failure = self._failure
        if failure:
            raise CaptureUnavailable(failure)

    def _start(self):
        self._require_owner()
        self._signal.checkpoint()
        self._started = True
        failed = False
        try:
            self._thread.start()
        except Exception:
            self._started = self._thread.ident is not None
            failed = True
        if failed:
            self._fail('dialog_unavailable')
        if not self._created.wait(min(_JOIN_SECONDS, max(0, self._signal._deadline - time.monotonic()))):
            self._fail('dialog_start_timeout')
        while not self._decided.is_set():
            self._raise_failure()
            self._signal.checkpoint()
            self._decided.wait(_POLL_SECONDS)
        self.checkpoint(operation_digest=self._digest)

    def _require_operation(self, operation_digest):
        self._require_owner()
        if type(operation_digest) is not str or operation_digest != self._digest:
            self._fail('capture_operation_mismatch')
            raise CaptureUnavailable('capture_operation_mismatch')

    def recording_preparing(self, *, operation_digest):
        """Arm cleanup BEFORE creating the owned worker; not proof it has started."""
        self.checkpoint(operation_digest=operation_digest)
        with self._lock:
            invalid = self._work_pending or self._recording_started or self._recording_stopped
            if not invalid:
                self._work_pending = True
        if invalid:
            self._fail('capture_state_unavailable')
            raise CaptureUnavailable('capture_state_unavailable')
        self.checkpoint(operation_digest=operation_digest)

    def recording_started(self, *, operation_digest):
        """Trusted owner only, AFTER its native Job/Recorder-ready verification."""
        self.checkpoint(operation_digest=operation_digest)
        with self._lock:
            invalid = not self._work_pending or self._recording_started or self._recording_stopped
            if not invalid:
                self._recording_started = True
        if invalid:
            self._fail('capture_state_unavailable')
            raise CaptureUnavailable('capture_state_unavailable')
        self.checkpoint(operation_digest=operation_digest)

    def finish_requested(self, *, operation_digest) -> bool:
        """Local request only; owner must revalidate authority/lease before accepting."""
        self.checkpoint(operation_digest=operation_digest)
        with self._lock:
            requested = self._finish_requested
        self.checkpoint(operation_digest=operation_digest)
        return requested

    def recording_stopped(self, *, operation_digest):
        """Trusted owner AFTER native cleanup proof, including failed/cancelled work.

        This acknowledgement permits UI teardown; it is never a successful result.
        A stop/session failure does not prevent cleanup of the owned resources.
        """
        self._require_operation(operation_digest)
        with self._lock:
            invalid = not self._work_pending
            if not invalid:
                self._recording_stopped = True
                self._work_pending = False
        if invalid:
            self._fail('capture_state_unavailable')
            raise CaptureUnavailable('capture_state_unavailable')

    def checkpoint(self, *, operation_digest):
        """Just before each next owned action/batch; never a server permission."""
        self._require_operation(operation_digest)
        self._raise_failure()
        with self._lock:
            approved, hwnd, api, tick = self._approved, self._hwnd, self._api, self._last_tick
        if not approved:
            self._fail('local_consent_unavailable')
            raise CaptureUnavailable('local_consent_unavailable')
        if (self._closed or not self._started or not self._thread.is_alive() or not hwnd
                or tick is None or time.monotonic() - tick > _HEARTBEAT_SECONDS):
            self._fail('indicator_unavailable')
            raise CaptureUnavailable('indicator_unavailable')
        self._signal.checkpoint()
        failed = False
        try:
            self._same_session()
            api.check_visible(hwnd)
        except Exception:
            failed = True
        if failed:
            self._fail('indicator_unavailable')
            raise CaptureUnavailable('indicator_unavailable')
        self._signal.checkpoint()
        self._raise_failure()
        with self._lock:
            if (self._hwnd != hwnd or self._closed or not self._thread.is_alive()
                    or self._last_tick is None
                    or time.monotonic() - self._last_tick > _HEARTBEAT_SECONDS):
                self._fail('indicator_unavailable')
                raise CaptureUnavailable('indicator_unavailable')

    def close(self):
        self._require_owner()
        if self._closed:
            return
        with self._lock:
            pending = self._work_pending
        if pending:
            self._fail('capture_cleanup_unverified')
            raise CaptureUnavailable('capture_cleanup_unverified')
        with self._lock:
            self._closing = True
        self._signal.request_stop()
        if self._started:
            failed = False
            try:
                self._thread.join(_JOIN_SECONDS)
            except Exception:
                failed = True
            if failed or self._thread.is_alive() or not self._done.is_set() or self._hwnd is not None:
                self._fail('dialog_cleanup_unverified')
                raise CaptureUnavailable('dialog_cleanup_unverified')
        self._closed = True


@contextmanager
def request_capture_controls(reservation, signal, *, operation_digest):
    """Yield only after a local native decision; keep indicator for this operation.

    The caller must already validate command, user/agent, lease/fences and scope.
    Neither an automated fixture nor a network reply is a local decision.
    """
    owner = _CaptureControls(reservation, signal, operation_digest)
    try:
        owner._start()
        yield owner
    finally:
        owner.close()
