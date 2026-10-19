"""Credential Manager + DPAPI réels, uniquement cibles aléatoires fictives possédées."""

import ctypes
import json
from pathlib import Path
import subprocess
import sys
import unittest
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

from memlia_agent.session import observe_session
from memlia_agent.user_credentials import CurrentUserCredentialStore, CredentialStoreError, _Credential

FICTIVE = bytearray(b'MEMLIA-FICTIF-CREDMAN-NE-PAS-UTILISER\x00\xff')
OWNED_TARGETS = []
CLEANED_TARGETS = []


class NativeUserCredentialTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        observe_session()

    def owned(self, *, long_ids=False):
        instance = uuid4().hex
        agent = uuid4().hex
        if long_ids:
            instance *= 4
            agent *= 4
        store = CurrentUserCredentialStore(instance_id=instance, agent_id=agent)
        # Réserver uniquement une cible dont l'absence exacte vient d'être vérifiée.
        initial = store._read_protected()
        try:
            self.assertTrue(initial is None, 'New random fixture target already exists; no overwrite')
        finally:
            if initial is not None:
                initial[:] = bytes(len(initial))
        OWNED_TARGETS.append(store._target)

        def cleanup():
            store.delete()
            self.assertIsNone(store.load())
            CLEANED_TARGETS.append(store._target)

        self.addCleanup(cleanup)
        return store

    def test_aller_retour_persistant_remplacement_suppression_et_absence(self):
        store = self.owned()
        source = bytearray(FICTIVE)
        store.store(source)
        value = store.load()
        try:
            self.assertEqual(value, FICTIVE)
            self.assertEqual(source, FICTIVE)
            store.store(bytearray(b'autre-valeur-fictive'))
            updated = store.load()
            try:
                self.assertEqual(updated, bytearray(b'autre-valeur-fictive'))
            finally:
                updated[:] = bytes(len(updated))
            self.assertTrue(store.delete())
            self.assertFalse(store.delete())
            self.assertIsNone(store.load())
        finally:
            source[:] = bytes(len(source))
            if value is not None:
                value[:] = bytes(len(value))

    def test_nouveau_processus_meme_compte_charge_la_valeur_fictive(self):
        store = self.owned()
        store.store(bytearray(FICTIVE))
        result = subprocess.run(
            [sys.executable, '-I', str(Path(__file__).resolve()), '--child'],
            input=json.dumps({'instance_id': store.instance_id, 'agent_id': store.agent_id}),
            capture_output=True, text=True, timeout=20,
        )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout), {'fictiveValueMatches': True})
        self.assertEqual(result.stderr, '')

    def test_copie_du_blob_vers_une_autre_cible_possedee_refusee_par_dpapi(self):
        first, other = self.owned(), self.owned()
        first.store(bytearray(FICTIVE))
        protected = first._read_protected()
        try:
            self.assertNotIn(FICTIVE, protected)
            other._write_protected(protected)
            with self.assertRaises(CredentialStoreError) as caught:
                other.load()
            self.assertEqual(caught.exception.code, 'credential_protection_failed')
        finally:
            protected[:] = bytes(len(protected))

    def test_blob_altere_sur_notre_seule_cible_reste_un_refus(self):
        store = self.owned()
        store.store(bytearray(FICTIVE))
        protected = store._read_protected()
        try:
            protected[-1] ^= 1
            store._write_protected(protected)
            with self.assertRaises(CredentialStoreError):
                store.load()
        finally:
            protected[:] = bytes(len(protected))

    def test_limites_utiles_et_natives_avec_ids_maximaux(self):
        store = self.owned(long_ids=True)
        source = bytearray(range(256)) * 8
        value = None
        protected = None
        try:
            store.store(source)
            value = store.load()
            protected = store._read_protected()
            self.assertEqual(value, source)
            self.assertLessEqual(len(protected), 2560)
            with self.assertRaises(CredentialStoreError) as caught:
                store.store(bytearray(2049))
            self.assertEqual(caught.exception.code, 'invalid_secret')
        finally:
            for data in (source, value, protected):
                if data is not None:
                    data[:] = bytes(len(data))

    def test_abi_windows_x64_attendue(self):
        self.assertEqual(sys.platform, 'win32')
        self.assertEqual(ctypes.sizeof(ctypes.c_void_p), 8)
        self.assertEqual(ctypes.sizeof(_Credential), 80)
        self.assertEqual(_Credential.CredentialBlob.offset, 40)


if __name__ == '__main__':
    if sys.argv[1:] == ['--child']:
        identity = json.loads(sys.stdin.read(1024))
        store = CurrentUserCredentialStore(**identity)
        value = store.load()
        try:
            matches = value == FICTIVE
            print(json.dumps({'fictiveValueMatches': matches}))
            raise SystemExit(0 if matches else 1)
        finally:
            if value is not None:
                value[:] = bytes(len(value))
    unittest.main()
