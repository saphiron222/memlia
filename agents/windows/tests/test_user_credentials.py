"""ABI Win32 simulée ; aucune preuve de confidentialité Windows n'en découle."""

import ctypes
import importlib
import io
import unittest
from contextlib import ExitStack, redirect_stderr, redirect_stdout
from types import SimpleNamespace
from unittest.mock import Mock, patch


class NativeFunction:
    def __init__(self, operation):
        self.operation = operation

    def __call__(self, *args):
        return self.operation(*args)


class SimulatedCredentials:
    def __init__(self, module):
        self.module = module
        self.rows = {}
        self.allocations = {}
        self.freed = []
        self.calls = []
        self.error = 0
        self.fail = 0
        self.size_override = None
        self.persist_override = None
        self.api = SimpleNamespace(
            CredWriteW=NativeFunction(self.write), CredReadW=NativeFunction(self.read),
            CredDeleteW=NativeFunction(self.delete), CredFree=NativeFunction(self.free),
        )

    def write(self, pointer, flags):
        row = pointer._obj
        self.calls.append(('write', row.TargetName, row.Type, row.Persist, flags, row.AttributeCount))
        if self.fail:
            self.error = self.fail
            return 0
        self.rows[row.TargetName] = ctypes.string_at(row.CredentialBlob, row.CredentialBlobSize)
        return 1

    def read(self, target, kind, flags, output):
        self.calls.append(('read', target, kind, flags))
        if self.fail or target not in self.rows:
            self.error = self.fail or 1168
            return 0
        value = self.rows[target]
        buffer = (ctypes.c_ubyte * len(value)).from_buffer_copy(value)
        row = self.module._Credential()
        row.TargetName = target
        row.Type = 1
        row.Persist = self.persist_override or 2
        row.CredentialBlobSize = self.size_override or len(value)
        row.CredentialBlob = ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte))
        self.allocations[ctypes.addressof(row)] = (row, buffer)
        ctypes.cast(output, ctypes.POINTER(ctypes.POINTER(self.module._Credential)))[0] = ctypes.pointer(row)
        return 1

    def delete(self, target, kind, flags):
        self.calls.append(('delete', target, kind, flags))
        if self.fail or target not in self.rows:
            self.error = self.fail or 1168
            return 0
        del self.rows[target]
        return 1

    def free(self, pointer):
        _, buffer = self.allocations.pop(ctypes.addressof(pointer.contents))
        self.freed.append(bytes(buffer))


class UserCredentialTests(unittest.TestCase):
    def setUp(self):
        try:
            self.module = importlib.import_module('memlia_agent.user_credentials')
        except ImportError:
            self.fail('Adaptateur Credential Manager absent')
        self.windows = SimulatedCredentials(self.module)
        self.protector = SimpleNamespace(
            protect=Mock(return_value=b'blob-DPAPI-fictif'),
            unprotect=Mock(return_value=bytearray(b'valeur-fictive\x00\xff')),
        )
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(self.module.sys, 'platform', 'win32'))
        self.loader = self.stack.enter_context(patch.object(
            self.module.ctypes, 'WinDLL', return_value=self.windows.api, create=True,
        ))
        self.stack.enter_context(patch.object(
            self.module.ctypes, 'get_last_error', side_effect=lambda: self.windows.error, create=True,
        ))
        self.factory = self.stack.enter_context(patch.object(
            self.module, 'CurrentUserProtector', return_value=self.protector,
        ))

    def store(self, instance='instance-1', agent='agent-1'):
        return self.module.CurrentUserCredentialStore(instance_id=instance, agent_id=agent)

    def test_absence_lire_et_supprimer_est_distincte_d_un_echec(self):
        self.assertIsNone(self.store().load())
        self.assertFalse(self.store().delete())
        self.windows.fail = 1312
        for operation in (self.store().load, self.store().delete):
            with self.assertRaises(self.module.CredentialStoreError) as caught:
                operation()
            self.assertEqual(caught.exception.code, 'credential_logon_unavailable')

    def test_stocke_recharge_remplace_supprime_uniquement_la_cible_liee(self):
        value = bytearray(b'valeur-fictive\x00\xff')
        first = self.store()
        self.assertIsNone(first.store(value))
        self.assertEqual(value, bytearray(b'valeur-fictive\x00\xff'))
        self.assertEqual(self.store().load(), value)
        self.protector.protect.return_value = b'autre-blob-fictif'
        first.store(value)
        self.assertEqual(len(self.windows.rows), 1)
        self.assertEqual(next(iter(self.windows.rows.values())), b'autre-blob-fictif')
        self.assertTrue(first.delete())
        self.assertFalse(first.delete())
        self.assertIsNone(first.load())

    def test_namespace_derive_ids_et_preserve_leur_casse_sans_cible_arbitraire(self):
        for instance, agent in [('Ab', 'agent'), ('ab', 'agent'), ('Ab', 'autre')]:
            self.store(instance, agent).store(bytearray(b'fictif'))
        self.assertEqual(len(self.windows.rows), 3)
        for target in self.windows.rows:
            self.assertTrue(target.startswith('Memlia:agent:v1:'))
        self.assertIn('Memlia:agent:v1:4162:6167656e74', self.windows.rows)
        for value in (None, b'a', '', ' ', 'a:b', 'a/b', 'a\x00b', 'é', 'a' * 129):
            for kwargs in ({'instance_id': value, 'agent_id': 'a'}, {'instance_id': 'a', 'agent_id': value}):
                with self.assertRaises(self.module.CredentialStoreError):
                    self.module.CurrentUserCredentialStore(**kwargs)

    def test_contexte_dpapi_est_la_cible_exacte_et_limites_sont_bornees(self):
        self.store('A', 'b').store(bytearray(b'fictif'))
        self.store('A', 'b').load()
        context = b'Memlia:agent:v1:41:62'
        self.protector.protect.assert_called_once_with(bytearray(b'fictif'), context=context)
        self.protector.unprotect.assert_called_once_with(b'blob-DPAPI-fictif', context=context)
        self.factory.assert_called_with(max_secret_bytes=2048, max_protected_bytes=2560, max_context_bytes=1024)

    def test_aucun_backend_sur_plateforme_non_windows(self):
        with patch.object(self.module.sys, 'platform', 'linux'):
            for operation in (lambda: self.store().store(bytearray(b'fictif')), self.store().load, self.store().delete):
                with self.assertRaises(self.module.CredentialStoreError) as caught:
                    operation()
                self.assertEqual(caught.exception.code, 'unsupported_platform')
        self.loader.assert_not_called()
        self.protector.protect.assert_not_called()

    def test_valeurs_vides_immuables_et_hors_limite_refusees_avant_win32(self):
        for value in (None, b'fictif', bytearray(), bytearray(2049)):
            with self.assertRaises(self.module.CredentialStoreError) as caught:
                self.store().store(value)
            self.assertEqual(caught.exception.code, 'invalid_secret')
        self.loader.assert_not_called()

    def test_blob_protege_trop_grand_n_est_jamais_ecrit(self):
        self.protector.protect.return_value = bytes(2561)
        with self.assertRaises(self.module.CredentialStoreError) as caught:
            self.store().store(bytearray(b'fictif'))
        self.assertEqual(caught.exception.code, 'credential_blob_too_large')
        self.loader.assert_not_called()

    def test_flags_generiques_persistants_meme_compte_et_system32_uniquement(self):
        self.store().store(bytearray(b'fictif'))
        self.store().load()
        self.store().delete()
        self.assertEqual(self.windows.calls[0][2:], (1, 2, 0, 0))
        self.assertTrue(all(call.args == ('advapi32',) and call.kwargs == {'use_last_error': True, 'winmode': 0x800} for call in self.loader.call_args_list))
        self.assertEqual(self.windows.calls[1][2:], (1, 0))
        self.assertEqual(self.windows.calls[2][2:], (1, 0))

    def test_lecture_efface_blob_natif_avant_credfree(self):
        self.store().store(bytearray(b'fictif'))
        self.store().load()
        self.assertEqual(self.windows.freed, [bytes(len(b'blob-DPAPI-fictif'))])
        self.assertEqual(self.windows.allocations, {})

    def test_blob_natif_invalide_libere_sans_dechiffrement(self):
        self.store().store(bytearray(b'fictif'))
        for override in ('size_override', 'persist_override'):
            setattr(self.windows, override, 2561 if override == 'size_override' else 3)
            with self.assertRaises(self.module.CredentialStoreError):
                self.store().load()
            setattr(self.windows, override, None)
        self.assertEqual(self.windows.allocations, {})
        self.assertEqual(len(self.windows.freed), 2)
        self.protector.unprotect.assert_not_called()

    def test_echec_de_protection_ou_dechiffrement_reste_un_refus_sans_detail(self):
        self.store().store(bytearray(b'fictif'))
        self.protector.protect.side_effect = self.module.SecretProtectionError('fictif-sensible')
        self.protector.unprotect.side_effect = self.module.SecretProtectionError('fictif-sensible')
        output = io.StringIO()
        with redirect_stdout(output), redirect_stderr(output):
            for operation in (lambda: self.store().store(bytearray(b'fictif-sensible')), self.store().load):
                with self.assertRaises(self.module.CredentialStoreError) as caught:
                    operation()
                self.assertEqual(caught.exception.code, 'credential_protection_failed')
                self.assertTrue(caught.exception.__suppress_context__)
        self.assertEqual(output.getvalue(), '')
        self.assertEqual(self.windows.allocations, {})

    def test_erreurs_native_et_chargement_ne_revelent_pas_le_secret(self):
        self.windows.fail = 5
        for operation in (lambda: self.store().store(bytearray(b'fictif-sensible')), self.store().load, self.store().delete):
            with self.assertRaises(self.module.CredentialStoreError) as caught:
                operation()
            self.assertEqual(caught.exception.code, 'credential_access_denied')
            self.assertNotIn('fictif', str(caught.exception))
        self.loader.side_effect = OSError('fictif-sensible')
        with self.assertRaises(self.module.CredentialStoreError) as caught:
            self.store().load()
        self.assertEqual(caught.exception.code, 'credential_api_unavailable')


if __name__ == '__main__':
    unittest.main()
