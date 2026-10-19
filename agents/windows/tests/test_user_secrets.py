"""Tests portables ; la frontière DPAPI simulée ne qualifie pas Windows."""

from contextlib import redirect_stderr, redirect_stdout
import ctypes
import io
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from memlia_agent import user_secrets


class NativeBlob(ctypes.Structure):
    _fields_ = [('size', ctypes.c_uint32), ('data', ctypes.c_void_p)]


class NativeFunction:
    def __init__(self, operation):
        self.operation = operation

    def __call__(self, *arguments):
        return self.operation(*arguments)


class SimulatedWindows:
    """ABI simulée, vraies allocations ctypes possédées ; aucune cryptographie."""

    def __init__(self):
        self.allocations = []
        self.freed = []
        self.flags = []
        self.load_modes = []
        self.saved = b''
        self.fail_after_allocating = False
        self.free_fails = False
        self.crypt = SimpleNamespace(
            CryptProtectData=NativeFunction(self.protect),
            CryptUnprotectData=NativeFunction(self.unprotect),
        )
        self.kernel = SimpleNamespace(LocalFree=NativeFunction(self.free))

    def load(self, name, **options):
        self.load_modes.append(options.get('winmode'))
        return self.crypt if name.lower() == 'crypt32' else self.kernel

    def allocate(self, value, output):
        buffer = ctypes.create_string_buffer(value, len(value))
        self.allocations.append(buffer)
        blob = ctypes.cast(output, ctypes.POINTER(NativeBlob)).contents
        blob.size = len(value)
        blob.data = ctypes.addressof(buffer)
        return not self.fail_after_allocating

    def protect(self, data, description, entropy, reserved, prompt, flags, output):
        self.flags.append((flags, description, reserved, prompt))
        blob = ctypes.cast(data, ctypes.POINTER(NativeBlob)).contents
        self.saved = ctypes.string_at(blob.data, blob.size)
        return self.allocate(b'chiffre natif fictif', output)

    def unprotect(self, data, description, entropy, reserved, prompt, flags, output):
        self.flags.append((flags, description, reserved, prompt))
        return self.allocate(self.saved, output)

    def free(self, pointer):
        buffer = next(b for b in self.allocations if ctypes.addressof(b) == pointer)
        self.freed.append(bytes(buffer))
        return pointer if self.free_fails else None


class UserSecretTests(unittest.TestCase):
    def test_corruption_du_blob_chiffre_refusee_avant_win32(self):
        protector = user_secrets.CurrentUserProtector(
            max_secret_bytes=4096, max_protected_bytes=16384, max_context_bytes=512,
        )
        with patch.object(user_secrets.sys, 'platform', 'win32'):
            with patch.object(user_secrets, '_crypt', return_value=bytearray(b'chiffre fictif')):
                protected = protector.protect(bytearray(b'fictif'), context=b'installation/agent/cle')
            changed = bytearray(protected)
            changed[-1] ^= 1
            with patch.object(user_secrets, '_crypt', return_value=bytearray(b'ne doit pas etre utilise')) as native:
                with self.assertRaises(user_secrets.SecretProtectionError) as caught:
                    protector.unprotect(bytes(changed), context=b'installation/agent/cle')
                self.assertEqual(caught.exception.code, 'invalid_protected_secret')
                native.assert_not_called()

    def test_echec_natif_avec_allocation_libere_et_efface_sans_repli(self):
        windows = SimulatedWindows()
        windows.fail_after_allocating = True
        protector = user_secrets.CurrentUserProtector(
            max_secret_bytes=4096, max_protected_bytes=16384, max_context_bytes=512,
        )
        with patch.object(user_secrets.sys, 'platform', 'win32'):
            with patch.object(user_secrets.ctypes, 'WinDLL', side_effect=windows.load, create=True):
                with self.assertRaises(user_secrets.SecretProtectionError) as caught:
                    protector.protect(bytearray(b'fictif'), context=b'installation/agent/cle')
        self.assertEqual(caught.exception.code, 'dpapi_failed')
        self.assertEqual(windows.freed, [bytes(20)])

    def test_echec_liberation_ne_devient_pas_succes(self):
        windows = SimulatedWindows()
        windows.free_fails = True
        protector = user_secrets.CurrentUserProtector(
            max_secret_bytes=4096, max_protected_bytes=16384, max_context_bytes=512,
        )
        with patch.object(user_secrets.sys, 'platform', 'win32'):
            with patch.object(user_secrets.ctypes, 'WinDLL', side_effect=windows.load, create=True):
                with self.assertRaises(user_secrets.SecretProtectionError) as caught:
                    protector.protect(bytearray(b'fictif'), context=b'installation/agent/cle')
        self.assertEqual(caught.exception.code, 'dpapi_failed')
        self.assertEqual(windows.freed, [bytes(20)])

    def test_sortie_native_hors_budget_refuse_et_libere(self):
        windows = SimulatedWindows()
        protector = user_secrets.CurrentUserProtector(
            max_secret_bytes=4096, max_protected_bytes=64, max_context_bytes=512,
        )
        with patch.object(user_secrets.sys, 'platform', 'win32'):
            with patch.object(user_secrets.ctypes, 'WinDLL', side_effect=windows.load, create=True):
                with self.assertRaises(user_secrets.SecretProtectionError) as caught:
                    protector.protect(bytearray(b'fictif'), context=b'installation/agent/cle')
        self.assertEqual(caught.exception.code, 'native_output_out_of_bounds')
        self.assertEqual(windows.freed, [bytes(20)])

    def test_dechiffrement_refuse_plateforme_et_contexte_invalides_avant_win32(self):
        protector = user_secrets.CurrentUserProtector(
            max_secret_bytes=4096, max_protected_bytes=16384, max_context_bytes=512,
        )
        with patch.object(user_secrets.sys, 'platform', 'win32'):
            with patch.object(user_secrets, '_crypt', return_value=bytearray(b'chiffre fictif')):
                blob = protector.protect(bytearray(b'fictif'), context=b'installation/agent/cle')
        with patch.object(user_secrets, '_crypt') as native:
            with patch.object(user_secrets.sys, 'platform', 'linux'):
                with self.assertRaises(user_secrets.SecretProtectionError) as caught:
                    protector.unprotect(blob, context=b'installation/agent/cle')
                self.assertEqual(caught.exception.code, 'unsupported_platform')
            for context in (None, '', b'', bytes(513)):
                with self.assertRaises(user_secrets.SecretProtectionError) as caught:
                    protector.unprotect(blob, context=context)
                self.assertEqual(caught.exception.code, 'invalid_context')
            native.assert_not_called()

    def test_frontiere_win32_utilisateur_sans_ui_libere_et_efface_sorties_natives(self):
        windows = SimulatedWindows()
        protector = user_secrets.CurrentUserProtector(
            max_secret_bytes=4096, max_protected_bytes=16384, max_context_bytes=512,
        )
        with patch.object(user_secrets.sys, 'platform', 'win32'):
            with patch.object(user_secrets.ctypes, 'WinDLL', side_effect=windows.load, create=True):
                protected = protector.protect(bytearray(b'fictif'), context=b'installation/agent/cle')
                restored = protector.unprotect(protected, context=b'installation/agent/cle')
        self.assertEqual(restored, bytearray(b'fictif'))
        self.assertEqual(windows.flags, [(1, None, None, None), (1, None, None, None)])
        self.assertTrue(all(mode == 0x800 for mode in windows.load_modes))
        self.assertEqual(len(windows.freed), 2)
        self.assertTrue(all(value == bytes(len(value)) for value in windows.freed))

    def test_erreur_native_reste_un_refus_sans_valeur_dans_erreur_ou_sorties(self):
        protector = user_secrets.CurrentUserProtector(
            max_secret_bytes=4096, max_protected_bytes=16384, max_context_bytes=512,
        )
        frames = []
        def failed_native(data, entropy, *, protect, output_limit):
            frames.append(data)
            raise OSError('sentinelle fictive sensible')
        out, err = io.StringIO(), io.StringIO()
        with patch.object(user_secrets.sys, 'platform', 'win32'):
            with patch.object(user_secrets, '_crypt', side_effect=failed_native):
                with redirect_stdout(out), redirect_stderr(err):
                    with self.assertRaises(user_secrets.SecretProtectionError) as caught:
                        protector.protect(bytearray(b'sentinelle fictive sensible'), context=b'installation/agent/cle')
        self.assertEqual(caught.exception.code, 'dpapi_failed')
        self.assertIsNone(caught.exception.__cause__)
        self.assertTrue(caught.exception.__suppress_context__)
        self.assertNotIn('sentinelle', str(caught.exception))
        self.assertEqual(out.getvalue() + err.getvalue(), '')
        self.assertEqual(frames[0], bytearray(len(frames[0])))

    def test_reponse_native_alteree_ou_autre_contexte_ne_retourne_pas_de_secret(self):
        protector = user_secrets.CurrentUserProtector(
            max_secret_bytes=4096, max_protected_bytes=16384, max_context_bytes=512,
        )
        saved = []
        def simulated_native(data, entropy, *, protect, output_limit):
            if protect:
                saved.append(bytearray(data))
                return bytearray(b'chiffre-fictif')
            return bytearray(saved[0])
        with patch.object(user_secrets.sys, 'platform', 'win32'):
            with patch.object(user_secrets, '_crypt', side_effect=simulated_native):
                protected = protector.protect(bytearray(b'valeur fictive'), context=b'installation/agent/cle')
                with self.assertRaises(user_secrets.SecretProtectionError) as caught:
                    protector.unprotect(protected, context=b'autre-installation/agent/cle')
                self.assertEqual(caught.exception.code, 'invalid_payload')
                saved[0][-1] ^= 1
                with self.assertRaises(user_secrets.SecretProtectionError) as caught:
                    protector.unprotect(protected, context=b'installation/agent/cle')
                self.assertEqual(caught.exception.code, 'invalid_payload')

    def test_blob_non_reconnu_refuse_avant_tout_dechiffrement(self):
        protector = user_secrets.CurrentUserProtector(
            max_secret_bytes=4096, max_protected_bytes=16384, max_context_bytes=512,
        )
        with patch.object(user_secrets.sys, 'platform', 'win32'):
            with patch.object(user_secrets, '_crypt') as native:
                for invalid in (None, bytearray(b'blob'), b'', b'blob natif non importe', bytes(16385)):
                    with self.subTest(blob_type=type(invalid).__name__):
                        with self.assertRaises(user_secrets.SecretProtectionError) as caught:
                            protector.unprotect(invalid, context=b'installation/agent/cle')
                        self.assertEqual(caught.exception.code, 'invalid_protected_secret')
                native.assert_not_called()

    def test_aller_retour_binaire_conserve_la_valeur_et_efface_les_copies_possedees(self):
        # Doublure uniquement de la frontière système : aucune crypto simulée
        # n'est présentée comme confidentialité ou preuve DPAPI.
        frames = []
        ciphertext = bytearray(b'chiffre-fictif')
        frame_copy = []
        def simulated_native(data, entropy, *, protect, output_limit):
            if protect:
                frames.append(data)
                frame_copy.append(bytearray(data))
                return ciphertext
            return frame_copy[0]
        protector = user_secrets.CurrentUserProtector(
            max_secret_bytes=4096, max_protected_bytes=16384, max_context_bytes=512,
        )
        secret = bytearray(b'\x00\xffdonnee fictive\x00')
        with patch.object(user_secrets.sys, 'platform', 'win32'):
            with patch.object(user_secrets, '_crypt', side_effect=simulated_native, create=True):
                protected = protector.protect(secret, context=b'installation/agent/cle')
                self.assertIsInstance(protected, bytes)
                restored = protector.unprotect(protected, context=b'installation/agent/cle')
                self.assertIsInstance(restored, bytearray)
                self.assertEqual(restored, bytearray(b'\x00\xffdonnee fictive\x00'))
        self.assertEqual(secret, bytearray(b'\x00\xffdonnee fictive\x00'))
        self.assertEqual(frames[0], bytearray(len(frames[0])))
        self.assertEqual(frame_copy[0], bytearray(len(frame_copy[0])))

    def test_entrees_vides_mal_typees_et_trop_longues_refusees(self):
        protector = user_secrets.CurrentUserProtector(
            max_secret_bytes=16, max_protected_bytes=512, max_context_bytes=8,
        )
        for secret in (None, b'immuable', '', bytearray(), bytearray(17)):
            with self.subTest(secret_type=type(secret).__name__):
                with self.assertRaises(user_secrets.SecretProtectionError) as caught:
                    protector.protect(secret, context=b'agent/1')
                self.assertEqual(caught.exception.code, 'invalid_secret')
        for context in (None, '', bytearray(b'agent/1'), b'', b'123456789'):
            with self.subTest(context_type=type(context).__name__):
                with self.assertRaises(user_secrets.SecretProtectionError) as caught:
                    protector.protect(bytearray(b'fictif'), context=context)
                self.assertEqual(caught.exception.code, 'invalid_context')

    def test_limites_explicites_rejettent_config_non_bornee_ou_booleenne(self):
        for field in ('max_secret_bytes', 'max_protected_bytes', 'max_context_bytes'):
            for invalid in (None, 0, -1, True, 1.5, '4096', 2 ** 32):
                with self.subTest(field=field, invalid=invalid):
                    limits = dict(max_secret_bytes=4096, max_protected_bytes=16384, max_context_bytes=512)
                    limits[field] = invalid
                    with self.assertRaises(user_secrets.SecretProtectionError) as caught:
                        user_secrets.CurrentUserProtector(**limits)
                    self.assertEqual(caught.exception.code, 'invalid_limits')

    def test_refuse_hors_windows_sans_repli_en_clair(self):
        protector = user_secrets.CurrentUserProtector(
            max_secret_bytes=4096, max_protected_bytes=16384, max_context_bytes=512,
        )
        with patch.object(user_secrets.sys, 'platform', 'darwin'):
            with self.assertRaises(user_secrets.SecretProtectionError) as caught:
                protector.protect(bytearray(b'valeur fictive'), context=b'cabinet-fictif/agent/cle')
            self.assertEqual(caught.exception.code, 'unsupported_platform')


if __name__ == '__main__':
    unittest.main()
