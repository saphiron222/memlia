"""Fixture explicite : enregistre brièvement Ctrl+Alt+Shift+F11 sans capture.

À ne lancer qu'après revue et réservation exclusive du laboratoire interactif.
Les messages synthétiques ciblent seulement nos threads ; aucun SendInput/hook.
Ils ne qualifient pas un appui physique sur le clavier ni le consentement local.
"""

from ctypes import wintypes
import ctypes
from pathlib import Path
import sys
import threading
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from memlia_agent import resources, stop
from memlia_agent.session import _function


class WindowsStopTests(unittest.TestCase):
    def arm(self, reservation, seconds=5):
        return stop.arm_local_stop(reservation, deadline_monotonic=time.monotonic() + seconds)

    def wait_stopped(self, signal):
        end = time.monotonic() + 2
        while not signal.stopped and time.monotonic() < end:
            time.sleep(.01)
        self.assertTrue(signal.stopped)

    def test_native_register_unregister_and_reuse_three_cycles(self):
        with resources.reserve_desktop() as reservation:
            for _ in range(3):
                with self.arm(reservation) as signal:
                    signal.checkpoint()
                    self.assertFalse(signal.stopped)
                self.assertFalse(signal._thread.is_alive())
                self.assertTrue(signal._done.is_set())
                signal.close()

    def test_real_collision_and_release_of_exact_combo(self):
        probe = stop._Hotkey()
        with resources.reserve_desktop() as reservation:
            with self.arm(reservation):
                with self.assertRaises(stop.StopUnavailable) as caught:
                    probe.register()
                self.assertEqual(caught.exception.code, 'hotkey_unavailable')
            # Preuve de libération normale, pas de réparation après cleanup inconnu.
            probe.register()
            try:
                self.assertIsNone(probe.poll())
            finally:
                probe.unregister()

    def test_synthetic_message_to_owned_thread_requests_cooperative_stop(self):
        user = ctypes.WinDLL('user32', use_last_error=True, winmode=0x800)
        post = _function(user, 'PostThreadMessageW', wintypes.BOOL,
                         [wintypes.DWORD, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM])
        with resources.reserve_desktop() as reservation:
            with self.arm(reservation) as signal:
                self.assertTrue(post(signal._thread.native_id, 0x0312, 0x4D45, (0x7A << 16) | 7))
                self.wait_stopped(signal)
                with self.assertRaises(stop.StopRequested) as caught:
                    signal.checkpoint()
                self.assertEqual(caught.exception.code, 'stop_requested')
            self.assertFalse(signal._thread.is_alive())

    def test_other_thread_can_stop_but_cannot_close_owned_context(self):
        codes = []
        with resources.reserve_desktop() as reservation:
            with self.arm(reservation) as signal:
                def request():
                    signal.request_stop()
                    try:
                        signal.close()
                    except stop.StopUnavailable as error:
                        codes.append(error.code)
                thread = threading.Thread(target=request)
                thread.start()
                thread.join(2)
                self.assertFalse(thread.is_alive())
                self.assertEqual(codes, ['stop_owner_mismatch'])
                self.assertTrue(signal.stopped)
            self.assertFalse(signal._thread.is_alive())

    def test_deadline_without_browser_or_network(self):
        with resources.reserve_desktop() as reservation:
            with self.arm(reservation, seconds=.4) as signal:
                self.wait_stopped(signal)
                with self.assertRaises(stop.StopRequested) as caught:
                    signal.checkpoint()
                self.assertEqual(caught.exception.code, 'deadline_expired')
            self.assertFalse(signal._thread.is_alive())


if __name__ == '__main__':
    if sys.platform != 'win32' or sys.argv[1:] != ['--allow-local-hotkey-test']:
        raise SystemExit('explicit_windows_hotkey_fixture_required')
    sys.argv = [sys.argv[0]]
    unittest.main(verbosity=2)
