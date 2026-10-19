# Copyright 2026 Memlia. All rights reserved.
"""Contrôles de redistribution sur fixtures jetables, sans réseau."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / 'check-upstream-notices.py'
UPSTREAM = HERE.parents[1] / 'compliance/upstream/sim'


class NoticeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='memlia-notices-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def notices(self):
        target = self.root / 'compliance/upstream/sim'
        target.mkdir(parents=True, exist_ok=True)
        for name in ('LICENSE', 'NOTICE'):
            shutil.copyfile(UPSTREAM / name, target / name)
        return target

    def check(self, history=False):
        command = [sys.executable, str(SCRIPT), '--root', str(self.root)]
        if history:
            command.append('--history')
        result = subprocess.run(command, capture_output=True, text=True, timeout=20)
        return result.returncode, json.loads(result.stdout)

    def git(self, *arguments):
        return subprocess.check_output(['git', '-C', str(self.root), *arguments], stderr=subprocess.DEVNULL)

    def repository(self):
        self.git('init', '-b', 'main')
        self.git('config', 'user.name', 'Memlia CI fictive')
        self.git('config', 'user.email', 'ci@example.invalid')
        (self.root / 'README.md').write_text('Neutral fixture\n')
        self.git('add', 'README.md')
        self.git('commit', '-m', 'neutral')

    def commit(self):
        self.git('add', '-A')
        self.git('commit', '-m', 'fictive fixture')

    def test_arbre_avec_les_deux_textes_exacts_est_admis(self):
        self.notices()
        code, report = self.check()
        self.assertEqual(code, 0)
        self.assertTrue(report['passed'])

    def test_suppression_de_chaque_texte_est_refusee(self):
        for name in ('LICENSE', 'NOTICE'):
            with self.subTest(name=name):
                target = self.notices()
                (target / name).unlink()
                code, report = self.check()
                self.assertNotEqual(code, 0)
                self.assertFalse(report['passed'])

    def test_texte_modifie_est_refuse(self):
        target = self.notices()
        (target / 'NOTICE').write_text('notice changed\n')
        self.assertNotEqual(self.check()[0], 0)

    def test_lien_symbolique_vers_un_texte_valide_est_refuse(self):
        target = self.notices()
        (target / 'NOTICE').unlink()
        (target / 'NOTICE').symlink_to(UPSTREAM / 'NOTICE')
        self.assertNotEqual(self.check()[0], 0)

    def test_commit_historique_neutre_seul_est_admis(self):
        self.repository()
        self.assertEqual(self.check(history=True)[0], 0)

    def test_meme_un_commit_outils_seul_sans_textes_est_refuse(self):
        self.repository()
        (self.root / 'tool.py').write_text('print(1)\n')
        self.commit()
        self.assertNotEqual(self.check(history=True)[0], 0)

    def test_historique_sans_notice_refuse_meme_si_head_repare(self):
        self.repository()
        (self.root / 'source.py').write_text('print(1)\n')
        self.commit()
        self.notices()
        self.commit()
        self.assertEqual(self.check()[0], 0)
        self.assertNotEqual(self.check(history=True)[0], 0)

    def test_branche_non_courante_sans_notice_est_inspectee(self):
        self.repository()
        self.notices()
        self.commit()
        self.git('switch', '-c', 'bad-fixture')
        (self.root / 'compliance/upstream/sim/NOTICE').unlink()
        self.commit()
        self.git('switch', 'main')
        self.assertEqual(self.check()[0], 0)
        self.assertNotEqual(self.check(history=True)[0], 0)

    def test_historique_partiel_est_refuse(self):
        self.repository()
        self.git('config', 'remote.fake.promisor', 'true')
        self.assertNotEqual(self.check(history=True)[0], 0)

    def test_historique_shallow_est_refuse(self):
        self.repository()
        (self.root / '.git/shallow').write_bytes(self.git('rev-parse', 'HEAD'))
        self.assertNotEqual(self.check(history=True)[0], 0)


if __name__ == '__main__':
    unittest.main()
