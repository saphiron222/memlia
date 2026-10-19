"""Tests portables des refus/lifecycle ; aucune qualification Win32 par doublure."""

import threading
import unittest
from unittest.mock import patch

from memlia_agent import resources
from memlia_agent.session import SessionObservation, SessionUnavailable

OBSERVATION = SessionObservation('S-1-5-21-111-222-333-1001', 1, 1)


class FakeMutex:
    def __init__(self, result=0):
        self.result = result
        self.released = 0
        self.closed = 0

    def create(self):
        return 123

    def wait(self, handle):
        return self.result

    def release(self, handle):
        self.released += 1

    def close(self, handle):
        self.closed += 1


class ResourceTests(unittest.TestCase):
    def setUp(self):
        self.observer = patch.object(resources, 'observe_session', return_value=OBSERVATION, create=True)
        self.observe = self.observer.start()
        self.addCleanup(self.observer.stop)
        self.native = FakeMutex()
        self.factory = patch.object(resources, '_Mutex', return_value=self.native, create=True)
        self.factory.start()
        self.addCleanup(self.factory.stop)

    def test_un_bureau_indisponible_ne_reserve_rien(self):
        self.observe.side_effect = SessionUnavailable('session_zero')
        with self.assertRaises(SessionUnavailable):
            resources.reserve_desktop()
        self.assertEqual((self.native.released, self.native.closed), (0, 0))

    def test_refuse_autre_proprietaire_sans_attente_et_ferme_le_handle(self):
        self.native.result = 0x102
        with self.assertRaises(resources.ResourceUnavailable) as caught:
            resources.reserve_desktop()
        self.assertEqual(caught.exception.code, 'desktop_busy')
        self.assertEqual((self.native.released, self.native.closed), (0, 1))

    def test_abandon_refuse_et_libere_la_propriete_acquise(self):
        self.native.result = 0x80
        with self.assertRaises(resources.ResourceUnavailable) as caught:
            resources.reserve_desktop()
        self.assertEqual(caught.exception.code, 'abandoned_desktop')
        self.assertEqual((self.native.released, self.native.closed), (1, 1))

    def test_erreur_wait_ne_devient_pas_succes(self):
        self.native.result = 0xFFFFFFFF
        with self.assertRaises(resources.ResourceUnavailable) as caught:
            resources.reserve_desktop()
        self.assertEqual(caught.exception.code, 'mutex_wait_failed')
        self.assertEqual((self.native.released, self.native.closed), (0, 1))

    def test_double_reservation_meme_thread_refuse_la_reentrance_win32(self):
        with resources.reserve_desktop():
            with self.assertRaises(resources.ResourceUnavailable) as caught:
                resources.reserve_desktop()
            self.assertEqual(caught.exception.code, 'desktop_busy')
        self.assertEqual((self.native.released, self.native.closed), (1, 1))

    def test_fermeture_lors_d_exception_et_idempotence(self):
        reservation = resources.reserve_desktop()
        with self.assertRaisesRegex(ValueError, 'fictif'):
            with reservation:
                raise ValueError('fictif')
        reservation.close()
        self.assertEqual((self.native.released, self.native.closed), (1, 1))
        with self.assertRaises(resources.ResourceUnavailable) as caught:
            reservation.ensure_current()
        self.assertEqual(caught.exception.code, 'reservation_closed')

    def test_changement_session_pendant_acquisition_refuse_et_libere(self):
        self.observe.side_effect = [OBSERVATION, SessionObservation(OBSERVATION.windows_sid, 2, 1)]
        with self.assertRaises(resources.ResourceUnavailable) as caught:
            resources.reserve_desktop()
        self.assertEqual(caught.exception.code, 'session_changed')
        self.assertEqual((self.native.released, self.native.closed), (1, 1))

    def test_perte_bureau_au_controle_pre_action_ne_devient_pas_succes(self):
        with resources.reserve_desktop() as reservation:
            self.observe.side_effect = SessionUnavailable('input_desktop_unavailable')
            with self.assertRaises(SessionUnavailable):
                reservation.ensure_current()
        self.assertEqual((self.native.released, self.native.closed), (1, 1))

    def test_echec_liberation_ne_declare_pas_le_bureau_libre(self):
        reservation = resources.reserve_desktop()
        try:
            with patch.object(self.native, 'release', side_effect=resources.ResourceUnavailable('mutex_release_failed')):
                with self.assertRaises(resources.ResourceUnavailable):
                    reservation.close()
                with self.assertRaises(resources.ResourceUnavailable) as caught:
                    resources.reserve_desktop()
                self.assertEqual(caught.exception.code, 'desktop_busy')
            self.assertEqual(self.native.closed, 0)
        finally:
            reservation.close()

    def test_echec_fermeture_handle_conserve_un_etat_reparable(self):
        reservation = resources.reserve_desktop()
        try:
            with patch.object(self.native, 'close', side_effect=resources.ResourceUnavailable('mutex_close_failed')):
                with self.assertRaises(resources.ResourceUnavailable):
                    reservation.close()
                with self.assertRaises(resources.ResourceUnavailable) as caught:
                    reservation.ensure_current()
                self.assertEqual(caught.exception.code, 'reservation_not_owned')
                with self.assertRaises(resources.ResourceUnavailable):
                    resources.reserve_desktop()
            self.assertEqual(self.native.released, 1)
        finally:
            reservation.close()
        self.assertEqual(self.native.released, 1)

    def test_changement_ecrans_observable_sans_casser_le_mutex_du_bureau(self):
        with resources.reserve_desktop() as reservation:
            self.observe.return_value = SessionObservation(OBSERVATION.windows_sid, 1, 2)
            current = reservation.ensure_current()
            self.assertEqual(current.monitor_count, 2)

    def test_thread_proprietaire_termine_refuse_autre_objet_avec_id_recycle_modele(self):
        # Le vrai thread termine. Seul le recyclage numérique est modélisé :
        # aucune réutilisation d'identifiant natif n'est revendiquée comme observée.
        held = []
        def make_reservation():
            held.append(resources.DesktopReservation(self.native, 123, OBSERVATION))
        owner = threading.Thread(target=make_reservation)
        owner.start()
        owner.join(timeout=5)
        self.assertFalse(owner.is_alive())
        self.assertEqual(len(held), 1)
        reservation = held[0]
        with patch.object(resources.threading, 'get_native_id', return_value=reservation._thread_id):
            with self.assertRaises(resources.ResourceUnavailable) as caught:
                reservation.ensure_current()
            self.assertEqual(caught.exception.code, 'reservation_owner_mismatch')
        self.observe.assert_not_called()
        self.assertEqual((self.native.released, self.native.closed), (0, 0))

    def test_thread_natif_etranger_non_suivi_par_python_refuse(self):
        # Pas de lancement natif : objet Dummy non initialisé, sans insertion
        # dans le registre global threading ; seule sa classe marque le profil.
        dummy = object.__new__(threading._DummyThread)
        with patch.object(resources.threading, 'current_thread', return_value=dummy):
            with self.assertRaises(resources.ResourceUnavailable) as caught:
                resources.DesktopReservation(self.native, 123, OBSERVATION)
            self.assertEqual(caught.exception.code, 'unsupported_thread')

    def test_mauvais_thread_ne_libere_pas_un_mutex_d_autrui(self):
        with resources.reserve_desktop() as reservation:
            with patch.object(resources.threading, 'get_native_id', return_value=-1):
                with self.assertRaises(resources.ResourceUnavailable) as caught:
                    reservation.close()
                self.assertEqual(caught.exception.code, 'reservation_owner_mismatch')
            self.assertEqual(self.native.released, 0)


if __name__ == '__main__':
    unittest.main()
