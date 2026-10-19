# Copyright 2026 Memlia. All rights reserved.
"""Tests réels du garde CI : ignorer un secret par configuration serait un défaut."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('check-secrets.sh').resolve()
SCANNER = os.environ.get('MEMLIA_GITLEAKS_BIN')


class SecretChecks(unittest.TestCase):
    def setUp(self):
        self.assertTrue(SCANNER and Path(SCANNER).is_file(), 'MEMLIA_GITLEAKS_BIN doit désigner le vrai scanner ; test non simulé')
        self.tmp = tempfile.TemporaryDirectory(prefix='memlia-secret-gate-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.git('init', '-q')
        self.git('config', 'user.email', 'fixture@example.invalid')
        self.git('config', 'user.name', 'Fixture')
        (self.root / 'README.md').write_text('Fixture fictive Memlia\n')
        self.commit()
        self.base_branch = self.git('branch', '--show-current').stdout.strip()

    def git(self, *args):
        return subprocess.run(['git', '-C', str(self.root), *args], check=True, text=True, capture_output=True)

    def commit(self):
        self.git('add', '--all')
        self.git('commit', '-q', '-m', 'fixture')

    def secret(self):
        # Valeur synthétique sans compte ni autorité ; pas de secret littéral dans Git.
        token = 'gh' + 'p_' + hashlib.sha256(b'memlia-synthetic-scanner-fixture').hexdigest()[:36]
        (self.root / 'input.txt').write_text('token = "' + token + '" # gitleaks:allow\n')

    def generic_secret(self):
        token = hashlib.sha256(b'memlia-generic-synthetic-scanner-fixture').hexdigest()[:40]
        (self.root / 'input.txt').write_text('api_key = "' + token + '"\n')

    def scan(self, **environment):
        result = subprocess.run(['bash', str(SCRIPT), SCANNER], cwd=self.root,
                                env={**os.environ, **environment}, capture_output=True, text=True)
        self.assertNotIn('token =', result.stdout + result.stderr, 'le garde ne doit pas afficher la ligne sensible')
        return result.returncode

    def review_fixture(self):
        policy = self.root / 'compliance/reviewed-gitleaks.json'
        policy.parent.mkdir(exist_ok=True)
        policy.write_text(json.dumps({
            'scanner': 'gitleaks', 'version': '8.30.1', 'findings': [{
                'path': 'input.txt', 'sha256': hashlib.sha256((self.root / 'input.txt').read_bytes()).hexdigest(),
                'rule': 'generic-api-key', 'line': 1,
                'reason': 'Valeur synthétique produite par le test, sans compte.'
            }]
        }))

    def test_clean_repository_passes(self):
        self.assertEqual(0, self.scan())

    def test_untracked_secret_is_detected_despite_inline_allow(self):
        self.secret()
        self.assertEqual(1, self.scan())

    def test_repository_configuration_cannot_disable_scan(self):
        self.secret()
        (self.root / '.gitleaks.toml').write_text('[allowlist]\npaths = [".*"]\n')
        (self.root / '.gitleaksignore').write_text('ignored-token\n')
        self.assertEqual(1, self.scan())

    def test_ambient_configuration_cannot_disable_scan(self):
        self.secret()
        self.assertEqual(1, self.scan(GITLEAKS_CONFIG_TOML='[allowlist]\npaths = [".*"]\n'))

    def test_removed_secret_still_fails_history_check(self):
        self.secret()
        self.commit()
        (self.root / 'input.txt').unlink()
        self.commit()
        self.assertEqual(1, self.scan())

    def test_exact_repository_ignore_cannot_hide_generic_secret(self):
        self.generic_secret()
        (self.root / '.gitleaksignore').write_text('input.txt:generic-api-key:1\n')
        self.assertEqual(1, self.scan())

    def test_binary_attribute_cannot_hide_removed_generic_secret(self):
        (self.root / '.gitattributes').write_text('input.txt -diff\n')
        self.commit()
        self.generic_secret()
        self.commit()
        (self.root / 'input.txt').unlink()
        self.commit()
        self.assertEqual(1, self.scan())

    def test_secret_introduced_only_in_merge_is_detected_after_deletion(self):
        self.git('checkout', '-q', '-b', 'fixture-feature')
        (self.root / 'feature.txt').write_text('feature\n')
        self.commit()
        self.git('checkout', '-q', self.base_branch)
        (self.root / 'base.txt').write_text('base\n')
        self.commit()
        self.git('merge', '--no-ff', '--no-commit', 'fixture-feature')
        self.generic_secret()
        self.commit()
        (self.root / 'input.txt').unlink()
        self.commit()
        self.assertEqual(1, self.scan())

    def test_exact_reviewed_fixture_can_pass_directory_and_history_scans(self):
        self.generic_secret()
        self.review_fixture()
        self.commit()
        self.assertEqual(0, self.scan())

    def test_removed_reviewed_fixture_is_checked_against_its_historical_blob(self):
        self.generic_secret()
        self.review_fixture()
        self.commit()
        (self.root / 'input.txt').unlink()
        self.commit()
        self.assertEqual(0, self.scan())

    def test_reviewed_current_blob_cannot_hide_a_different_removed_secret(self):
        self.generic_secret()
        self.commit()
        (self.root / 'input.txt').write_text('api_key = "' + hashlib.sha256(b'another-fictional-fixture').hexdigest()[:40] + '"\n')
        self.review_fixture()
        self.commit()
        self.assertEqual(1, self.scan())

    def test_changed_reviewed_file_stays_blocked_when_its_secret_is_removed(self):
        self.generic_secret()
        self.review_fixture()
        (self.root / 'input.txt').write_text('no credential here\n')
        self.assertEqual(1, self.scan())

    def test_replace_ref_cannot_hide_a_removed_historical_secret(self):
        clean_commit = self.git('rev-parse', 'HEAD').stdout.strip()
        self.generic_secret()
        self.commit()
        secret_commit = self.git('rev-parse', 'HEAD').stdout.strip()
        (self.root / 'input.txt').unlink()
        self.commit()
        self.git('replace', secret_commit, clean_commit)
        self.assertEqual(1, self.scan())

    def test_grafted_repository_is_rejected_before_history_scan(self):
        head = self.git('rev-parse', 'HEAD').stdout.strip()
        (self.root / '.git/info/grafts').write_text(head + '\n')
        self.assertEqual(2, self.scan())

    def test_log_configuration_cannot_hide_a_deleted_root_commit_secret(self):
        self.generic_secret()
        self.git('add', 'input.txt')
        self.git('commit', '-q', '--amend', '--no-edit')
        (self.root / 'input.txt').unlink()
        self.commit()
        self.assertEqual(1, self.scan(), 'the real rule must first detect the root secret')
        self.git('config', 'log.showRoot', 'false')
        self.assertEqual(1, self.scan())


if __name__ == '__main__':
    unittest.main()
