"""Qualification explicite Windows interactif ; jamais exécutée par un mock.

Exécuter ce fichier avec Python dans la session limitée console. Il ne lit aucun
pixel/titre/événement, ne lance ni Office ni OpenAdapt et ne change aucun réglage.
"""

from __future__ import annotations

import ctypes
from ctypes import wintypes
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from memlia_agent import resources
from memlia_agent.session import observe_session


def _child(mode):
    try:
        with resources.reserve_desktop():
            print('HELD', flush=True)
            if mode == 'probe':
                return 0
            sys.stdin.readline()
            if mode == 'abort':
                os._exit(17)
        print('RELEASED', flush=True)
        return 0
    except resources.ResourceUnavailable as error:
        print(error.code, flush=True)
        return 23


def _start_child(mode):
    process = subprocess.Popen(
        [sys.executable, '-I', '-u', str(Path(__file__).resolve()), '--child', mode],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    return process


def _read_ready(process):
    result = queue.Queue()
    thread = threading.Thread(target=lambda: result.put(process.stdout.readline(256)), daemon=True)
    thread.start()
    try:
        text = result.get(timeout=15)
    except queue.Empty:
        raise AssertionError('Le sous-processus de test ne répond pas') from None
    if text.strip() != 'HELD':
        raise AssertionError('La réservation du sous-processus de test a échoué')


def _cleanup_child(process):
    if process.poll() is None:
        process.kill()  # Seulement ce Python de test possédé, jamais Excel/autre processus.
    process.communicate(timeout=10)
    process.stdin.close()
    process.stdout.close()
    process.stderr.close()


class NativeWindowsTests(unittest.TestCase):
    def test_observation_session_console_reelle(self):
        observation = observe_session()
        self.assertGreater(observation.session_id, 0)
        self.assertRegex(observation.windows_sid, r'^S-1-5-21-')
        self.assertFalse(hasattr(observation, 'consent'))

    def test_autre_processus_refuse_bureau_reserve(self):
        with resources.reserve_desktop() as reservation:
            reservation.ensure_current()
            process = _start_child('probe')
            try:
                output, error = process.communicate(timeout=20)
                self.assertEqual(process.returncode, 23)
                self.assertEqual(output.strip(), 'desktop_busy')
                self.assertEqual(error, '')
            finally:
                _cleanup_child(process)
        with resources.reserve_desktop() as reservation:
            reservation.ensure_current()

    def test_liberation_normale_interprocessus(self):
        process = _start_child('hold')
        try:
            _read_ready(process)
            with self.assertRaises(resources.ResourceUnavailable) as caught:
                resources.reserve_desktop()
            self.assertEqual(caught.exception.code, 'desktop_busy')
            output, error = process.communicate(input='release\n', timeout=20)
            self.assertEqual(process.returncode, 0)
            self.assertEqual(output.strip(), 'RELEASED')
            self.assertEqual(error, '')
            with resources.reserve_desktop() as reservation:
                reservation.ensure_current()
        finally:
            _cleanup_child(process)

    def test_abandon_reel_refuse_le_run_et_ferme_son_handle(self):
        process = _start_child('abort')
        keeper = resources._Mutex()
        handle = None
        try:
            _read_ready(process)
            # Garder l'objet vivant pour observer WAIT_ABANDONED ; sinon Windows
            # détruit l'objet au dernier handle et le mutex seul n'a aucune mémoire.
            handle = keeper.create()
            output, error = process.communicate(input='abort\n', timeout=20)
            self.assertEqual(process.returncode, 17)
            self.assertEqual((output, error), ('', ''))
            with self.assertRaises(resources.ResourceUnavailable) as caught:
                resources.reserve_desktop()
            self.assertEqual(caught.exception.code, 'abandoned_desktop')
            # Contrôle de cleanup seulement, aucune relance de travail/dispatch.
            with resources.reserve_desktop():
                pass
        finally:
            if handle is not None:
                keeper.close(handle)
            _cleanup_child(process)

    def test_sortie_exception_libere_le_bureau(self):
        with self.assertRaisesRegex(ValueError, 'fictif'):
            with resources.reserve_desktop():
                raise ValueError('fictif')
        with resources.reserve_desktop():
            pass

    def test_fermeture_par_mauvais_thread_refusee_reellement(self):
        outcome = queue.Queue()
        with resources.reserve_desktop() as reservation:
            def close_foreign():
                try:
                    reservation.close()
                except resources.ResourceUnavailable as error:
                    outcome.put(error.code)
            thread = threading.Thread(target=close_foreign)
            thread.start()
            thread.join(timeout=5)
            self.assertFalse(thread.is_alive())
            self.assertEqual(outcome.get(timeout=1), 'reservation_owner_mismatch')
            reservation.ensure_current()

    def test_handles_non_herites_et_cycles_sans_fuite(self):
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        get_process = resources._function(kernel, 'GetCurrentProcess', wintypes.HANDLE, [])
        get_count = resources._function(kernel, 'GetProcessHandleCount', wintypes.BOOL,
                                        [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)])
        get_flags = resources._function(kernel, 'GetHandleInformation', wintypes.BOOL,
                                        [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)])
        # Premier chargement WinDLL/WTS hors mesure pour ne pas compter les DLL.
        with resources.reserve_desktop():
            pass
        before = wintypes.DWORD()
        self.assertTrue(get_count(get_process(), ctypes.byref(before)))
        for _ in range(30):
            with resources.reserve_desktop() as reservation:
                flags = wintypes.DWORD()
                self.assertTrue(get_flags(reservation._handle, ctypes.byref(flags)))
                self.assertEqual(flags.value & 1, 0)  # HANDLE_FLAG_INHERIT
                reservation.ensure_current()
        after = wintypes.DWORD()
        self.assertTrue(get_count(get_process(), ctypes.byref(after)))
        self.assertEqual(after.value, before.value)


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--child':
        raise SystemExit(_child(sys.argv[2]))
    unittest.main(verbosity=2)
