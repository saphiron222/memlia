"""Essais DPAPI natifs sur données FICTIVES, sans capture ni magasin existant.

Lancer avec Python Windows x64 isolé, dans une session utilisateur limitée.
Cette suite ne se saute pas hors Windows ; l'indisponibilité est un échec.
"""

import base64
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))

from memlia_agent.session import observe_session
from memlia_agent.user_secrets import CurrentUserProtector, SecretProtectionError

FICTIVE = bytearray(b'FICTIF-MEMLIA-DPAPI-NE-PAS-UTILISER\x00\xff')
CONTEXT = b'cabinet-fictif/agent-fictif/cle-test'


def protector():
    return CurrentUserProtector(
        max_secret_bytes=4096, max_protected_bytes=16384, max_context_bytes=512,
    )


class NativeUserSecretTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Réutilise la qualification console/identité de l'agent ; pas d'export SID.
        observe_session()

    def test_octets_fictifs_nuls_et_non_utf8_retrouves_sans_modifier_entree(self):
        original = bytearray(FICTIVE)
        protected = protector().protect(original, context=CONTEXT)
        self.assertNotIn(FICTIVE, protected)
        restored = protector().unprotect(protected, context=CONTEXT)
        try:
            self.assertEqual(restored, FICTIVE)
            self.assertEqual(original, FICTIVE)
        finally:
            restored[:] = bytes(len(restored))
            original[:] = bytes(len(original))

    def test_contexte_autre_cabinet_agent_ou_usage_refuse(self):
        protected = protector().protect(bytearray(FICTIVE), context=CONTEXT)
        for context in (
            b'autre-cabinet/agent-fictif/cle-test',
            b'cabinet-fictif/autre-agent/cle-test',
            b'cabinet-fictif/agent-fictif/autre-usage',
        ):
            with self.subTest(context=context.decode('ascii')):
                with self.assertRaises(SecretProtectionError):
                    protector().unprotect(protected, context=context)

    def test_alterations_et_troncature_du_blob_natif_refusees(self):
        protected = protector().protect(bytearray(FICTIVE), context=CONTEXT)
        for index in (25, 57, len(protected) // 2, len(protected) - 1):
            changed = bytearray(protected)
            changed[index] ^= 1
            with self.subTest(index=index):
                with self.assertRaises(SecretProtectionError):
                    protector().unprotect(bytes(changed), context=CONTEXT)
        with self.assertRaises(SecretProtectionError):
            protector().unprotect(protected[:-17], context=CONTEXT)

    def test_charge_alteree_refusee_meme_si_checksum_public_recalcule(self):
        # Format du conteneur v1 : préfixe de21octets, checksum public32octets,
        # puis blob DPAPI. Le checksum public n'est pas une authentification.
        changed = bytearray(protector().protect(bytearray(FICTIVE), context=CONTEXT))
        changed[-1] ^= 1
        changed[21:53] = hashlib.sha256(changed[53:]).digest()
        with self.assertRaises(SecretProtectionError):
            protector().unprotect(bytes(changed), context=CONTEXT)

    def test_nouveau_processus_meme_compte_lit_uniquement_le_blob_fictif_par_stdin(self):
        protected = protector().protect(bytearray(FICTIVE), context=CONTEXT)
        payload = json.dumps({
            'protected': base64.b64encode(protected).decode('ascii'),
            'context': base64.b64encode(CONTEXT).decode('ascii'),
        })
        result = subprocess.run(
            [sys.executable, '-I', str(Path(__file__).resolve()), '--child'],
            input=payload, text=True, capture_output=True, timeout=20,
        )
        self.assertEqual(result.returncode, 0)
        self.assertEqual(json.loads(result.stdout), {'fictiveValueMatches': True})
        self.assertEqual(result.stderr, '')

    def test_limite_deployeur_appliquee_aux_octets_natifs(self):
        fictive = bytearray(range(256)) * 16
        protected = protector().protect(fictive, context=CONTEXT)
        restored = protector().unprotect(protected, context=CONTEXT)
        try:
            self.assertEqual(restored, fictive)
            with self.assertRaises(SecretProtectionError):
                protector().protect(bytearray(4097), context=CONTEXT)
        finally:
            restored[:] = bytes(len(restored))
            fictive[:] = bytes(len(fictive))


if __name__ == '__main__':
    if sys.argv[1:] == ['--child']:
        data = json.loads(sys.stdin.read(65536))
        protected = base64.b64decode(data['protected'], validate=True)
        context = base64.b64decode(data['context'], validate=True)
        value = protector().unprotect(protected, context=context)
        try:
            matches = value == FICTIVE
            print(json.dumps({'fictiveValueMatches': matches}))
            raise SystemExit(0 if matches else 1)
        finally:
            value[:] = bytes(len(value))
    unittest.main()
