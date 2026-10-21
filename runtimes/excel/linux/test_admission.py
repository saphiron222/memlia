# Copyright (c) 2026 Memlia. All rights reserved.
"""Real private files; no Docker or image qualification is simulated as native."""
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import admission

IMAGE = 'sha256:' + 'a' * 64
SUPERVISOR = 'b' * 64


def proof():
    return {'schemaVersion': 'memlia.excel-isolation-proof/v1', 'imageId': IMAGE,
            'sourceCommit': 'c' * 40, 'lockSha256': 'd' * 64,
            'contextSha256': 'e' * 64, 'supervisorSha256': SUPERVISOR,
            'imageHeld': True,
            'cases': {name: {'passed': True, 'cleanupComplete': True} for name in admission.CASES}}


def config(value, raw):
    return {'schemaVersion': 'memlia.excel-local-admission/v1', 'purpose': 'local-host',
            **{k: value[k] for k in ('imageId', 'sourceCommit', 'lockSha256',
                                   'contextSha256', 'supervisorSha256')},
            'proofSha256': hashlib.sha256(raw).hexdigest()}


class AdmissionTests(unittest.TestCase):
    def setUp(self):
        # Ancestors have real protected modes, unlike world-writable /tmp.
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.path = self.root / 'admission.json'

    def write(self, value=None, change=None):
        value = proof() if value is None else value
        raw = json.dumps(value, separators=(',', ':')).encode()
        record = config(value, raw)
        record.update(change or {})
        for path, data in ((self.root / 'proof.json', raw),
                           (self.path, json.dumps(record).encode())):
            if path.exists() or path.is_symlink(): path.unlink()
            path.write_bytes(data)
            path.chmod(0o400)

    def load(self):
        return admission.capture(str(self.path), IMAGE, SUPERVISOR)

    def test_exact_operator_files_are_captured_without_later_mutation(self):
        self.write()
        captured = self.load()
        self.path.unlink()
        self.assertTrue(admission.permits(captured, IMAGE, SUPERVISOR))
        self.assertFalse(admission.permits(captured, 'sha256:' + 'f' * 64, SUPERVISOR))
        self.assertFalse(admission.permits(captured, IMAGE, 'f' * 64))
        self.assertFalse(admission.permits(None, IMAGE, SUPERVISOR))
        self.assertFalse(admission.permits(proof(), IMAGE, SUPERVISOR))

    def test_wrong_digest_source_lock_context_code_or_proof_refuses(self):
        for key, value in [('imageId', 'sha256:' + 'f' * 64), ('sourceCommit', 'f' * 40),
                           ('lockSha256', 'f' * 64), ('contextSha256', 'f' * 64),
                           ('supervisorSha256', 'f' * 64), ('proofSha256', 'f' * 64)]:
            with self.subTest(key=key):
                self.write(change={key: value})
                with self.assertRaises(ValueError): self.load()

    def test_every_case_and_its_cleanup_are_required(self):
        for name in admission.CASES:
            for key in ('passed', 'cleanupComplete'):
                value = proof(); value['cases'][name][key] = False
                self.write(value)
                with self.subTest(name=name, key=key), self.assertRaises(ValueError): self.load()

    def test_missing_extra_or_numeric_true_case_refuses(self):
        variants = []
        value = proof(); del value['cases']['worker']; variants.append(value)
        value = proof(); value['cases']['foreign'] = {}; variants.append(value)
        value = proof(); value['cases']['worker']['passed'] = 1; variants.append(value)
        value = proof(); value['imageHeld'] = False; variants.append(value)
        for value in variants:
            self.write(value)
            with self.assertRaises(ValueError): self.load()

    def test_unknown_operator_field_and_purpose_refuse(self):
        for change in ({'foreign': 'CANARY'}, {'purpose': 'request'}, {'imageId': 'latest'}):
            self.write(change=change)
            with self.assertRaises(ValueError): self.load()

    def test_writable_file_parent_hardlink_and_symlink_refuse(self):
        for name in ('admission.json', 'proof.json'):
            self.write(); path = self.root / name; path.chmod(0o600)
            with self.subTest(name=name), self.assertRaises(ValueError): self.load()
        self.write(); self.root.chmod(0o770)
        try:
            with self.assertRaises(ValueError): self.load()
        finally: self.root.chmod(0o700)
        self.write(); os.link(self.path, self.root / 'other')
        with self.assertRaises(ValueError): self.load()
        (self.root / 'other').unlink()
        self.path.unlink(); self.path.symlink_to(self.root / 'proof.json')
        with self.assertRaises(ValueError): self.load()

    def test_duplicate_keys_bounds_and_relative_path_refuse(self):
        self.write()
        for raw in (b'{"imageId":"x","imageId":"x"}', b'x' * 16385):
            self.path.chmod(0o600)
            self.path.write_bytes(raw)
            self.path.chmod(0o400)
            with self.assertRaises(ValueError): self.load()
        with self.assertRaises(ValueError): admission.capture('admission.json', IMAGE, SUPERVISOR)

    def test_wrong_owner_and_same_bytes_path_substitution_refuse(self):
        self.write()
        with mock.patch.object(admission.os, 'getuid', return_value=os.getuid()+1):
            with self.assertRaises(ValueError): self.load()
        original = os.open
        def replacing(path, flags, *args):
            fd = original(path, flags, *args)
            if Path(path) == self.path:
                replacement = self.root / 'replacement'
                replacement.write_bytes(self.path.read_bytes())
                replacement.chmod(0o400)
                replacement.replace(self.path)
            return fd
        with mock.patch.object(admission.os, 'open', side_effect=replacing):
            with self.assertRaises(ValueError): self.load()


if __name__ == '__main__': unittest.main()
