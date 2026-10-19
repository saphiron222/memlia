"""Politiques portables ; les doublures ne qualifient pas les API Windows."""

import sys
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from memlia_agent import session


def facts(**changes):
    values = dict(
        build=26200, product_type=1, pointer_size=8,
        native_machine=0x8664, process_machine=0,
        session_id=1, console_session_id=1, connection_state=0, protocol=0,
        windows_sid='S-1-5-21-111-222-333-1001', elevated=False,
        window_station='WinSta0', thread_desktop='Default',
        input_desktop='Default', monitor_count=1,
    )
    return SimpleNamespace(**(values | changes))


class SessionTests(unittest.TestCase):
    def test_refuse_un_hote_non_windows(self):
        with patch.object(sys, 'platform', 'darwin'):
            with self.assertRaises(session.SessionUnavailable) as caught:
                session.observe_session()
        self.assertEqual(caught.exception.code, 'unsupported_platform')

    def test_observation_admet_uniquement_identite_et_session_sans_autorite(self):
        with patch.object(sys, 'platform', 'win32'), patch.object(
            session, '_collect_native', return_value=facts(), create=True
        ):
            observation = session.observe_session()
        self.assertEqual(observation.windows_sid, 'S-1-5-21-111-222-333-1001')
        self.assertEqual(observation.session_id, 1)
        self.assertEqual(set(vars(observation)), {'windows_sid', 'session_id', 'monitor_count'})

    def test_multi_ecrans_observe_sans_confondre_session_et_qualification(self):
        with patch.object(sys, 'platform', 'win32'), patch.object(
            session, '_collect_native', return_value=facts(monitor_count=2), create=True
        ):
            observation = session.observe_session()
        self.assertEqual(observation.monitor_count, 2)

    def test_absence_information_native_refuse_sans_fuite(self):
        with patch.object(sys, 'platform', 'win32'), patch.object(
            session, '_collect_native', side_effect=OSError('PRIVATE-SENTINEL'), create=True
        ):
            with self.assertRaises(session.SessionUnavailable) as caught:
                session.observe_session()
        self.assertEqual(caught.exception.code, 'native_observation_failed')
        self.assertNotIn('PRIVATE-SENTINEL', str(caught.exception))

    def test_refus_contextes_non_pris_en_charge(self):
        cases = [
            ({'build': 19045}, 'unsupported_windows'),
            ({'product_type': 3}, 'unsupported_windows'),
            ({'pointer_size': 4}, 'unsupported_architecture'),
            ({'native_machine': 0xAA64}, 'unsupported_architecture'),
            ({'process_machine': 0x14C}, 'unsupported_architecture'),
            ({'session_id': 0}, 'session_zero'),
            ({'console_session_id': 0xFFFFFFFF}, 'inactive_console'),
            ({'console_session_id': 2}, 'inactive_console'),
            ({'connection_state': 4}, 'inactive_session'),
            ({'protocol': 2}, 'remote_session'),
            ({'elevated': True}, 'elevated_process'),
            ({'windows_sid': 'S-1-5-18'}, 'service_identity'),
            ({'windows_sid': 'S-1-5-19'}, 'service_identity'),
            ({'windows_sid': 'S-1-5-20'}, 'service_identity'),
            ({'window_station': 'Service-0x0-3e7$'}, 'noninteractive_station'),
            ({'thread_desktop': 'Private'}, 'nondefault_desktop'),
            ({'input_desktop': 'Winlogon'}, 'input_desktop_unavailable'),
        ]
        for changes, code in cases:
            with self.subTest(changes=changes), patch.object(sys, 'platform', 'win32'), patch.object(
                session, '_collect_native', return_value=facts(**changes), create=True
            ):
                with self.assertRaises(session.SessionUnavailable) as caught:
                    session.observe_session()
                self.assertEqual(caught.exception.code, code)


if __name__ == '__main__':
    unittest.main()
