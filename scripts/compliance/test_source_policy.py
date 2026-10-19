# Copyright 2026 Memlia. All rights reserved.
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location('source_policy', HERE / 'source_policy.py')
source_policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(source_policy)

class ReviewTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / 'fixture.txt').write_text('a fictional credential placeholder\n')
        self.review = {'scanner': 'gitleaks', 'version': '8.30.1', 'findings': [{
            'path': 'fixture.txt', 'sha256': source_policy.digest((self.root / 'fixture.txt').read_bytes()),
            'rule': 'generic-api-key', 'line': 1, 'reason': 'Fixture fictive examinée.'}]}
        self.report = [{'File': 'fixture.txt', 'RuleID': 'generic-api-key', 'StartLine': 1}]

    def tearDown(self):
        self.tmp.cleanup()

    def test_exact_reviewed_finding_is_classified(self):
        self.assertEqual([], source_policy.review_findings(self.root, self.report, self.review))

    def test_new_rule_or_line_or_path_stays_blocking(self):
        for field, value in [('RuleID', 'new-rule'), ('StartLine', 2), ('File', 'other.txt')]:
            report = [dict(self.report[0], **{field: value})]
            self.assertTrue(source_policy.review_findings(self.root, report, self.review))

    def test_missing_expected_findings_block_an_incomplete_report(self):
        self.assertTrue(source_policy.review_findings(self.root, [], self.review))

    def test_changed_blob_blocks_even_if_current_report_has_no_findings(self):
        (self.root / 'fixture.txt').write_text('modified fixture')
        self.assertTrue(source_policy.review_findings(self.root, [], self.review))

    def test_absent_reviewed_blob_is_not_silently_ignored(self):
        (self.root / 'fixture.txt').unlink()
        self.assertTrue(source_policy.review_findings(self.root, [], self.review))

    def test_missing_reason_is_not_a_valid_exemption(self):
        del self.review['findings'][0]['reason']
        with self.assertRaises(ValueError):
            source_policy.review_findings(self.root, self.report, self.review)

    def test_review_paths_cannot_escape_the_root(self):
        self.review['findings'][0]['path'] = '../outside.txt'
        with self.assertRaises(ValueError):
            source_policy.review_findings(self.root, self.report, self.review)

    def test_absolute_scanner_path_inside_root_is_normalized(self):
        self.report[0]['File'] = str(self.root / 'fixture.txt')
        self.assertEqual([], source_policy.review_findings(self.root, self.report, self.review))

    def test_symlink_cannot_substitute_a_reviewed_file(self):
        original = self.root / 'fixture.txt'
        original.rename(self.root / 'actual.txt')
        original.symlink_to('actual.txt')
        self.assertTrue(source_policy.review_findings(self.root, self.report, self.review))

    def test_missing_or_malformed_scanner_report_is_not_clean(self):
        for malformed in [None, {}, [{'File': 'fixture.txt'}]]:
            with self.assertRaises(ValueError):
                source_policy.review_findings(self.root, malformed, self.review)

    def test_history_report_requires_separate_commit_blob_verification(self):
        self.report[0]['Commit'] = 'a' * 40
        with self.assertRaises(ValueError):
            source_policy.review_findings(self.root, self.report, self.review)

    def test_findings_never_echo_secret_or_match_values(self):
        self.report[0].update({'RuleID': 'new-rule', 'Secret': 'fictional sensitive text', 'Match': 'fictional sensitive text'})
        issues = source_policy.review_findings(self.root, self.report, self.review)
        self.assertTrue(issues)
        self.assertNotIn('fictional sensitive text', json.dumps(issues))

    def test_repository_mode_allows_a_reviewed_fixture_not_in_this_checkout(self):
        (self.root / 'fixture.txt').unlink()
        self.assertEqual([], source_policy.review_repository_findings(self.root, [], self.review))

    def test_repository_mode_still_requires_findings_for_present_reviewed_files(self):
        self.assertTrue(source_policy.review_repository_findings(self.root, [], self.review))
        self.assertEqual([], source_policy.review_repository_findings(self.root, self.report, self.review))


class HistoryReviewTests(unittest.TestCase):
    tearDown = ReviewTests.tearDown

    def setUp(self):
        ReviewTests.setUp(self)
        self.git('init', '-q')
        self.git('config', 'user.email', 'fixture@example.invalid')
        self.git('config', 'user.name', 'Fixture')
        self.git('add', 'fixture.txt')
        self.git('commit', '-q', '-m', 'fixture')
        self.commit = self.git('rev-parse', 'HEAD').strip()
        self.history_report = [dict(self.report[0], Commit=self.commit)]

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.root), *args], text=True, stderr=subprocess.PIPE)

    def test_historical_blob_passes_after_file_is_removed_from_checkout(self):
        (self.root / 'fixture.txt').unlink()
        self.git('add', '--all')
        self.git('commit', '-q', '-m', 'remove fixture')
        self.assertEqual([], source_policy.review_history_findings(self.root, self.history_report, self.review))

    def test_current_clean_file_cannot_authorize_a_different_historical_blob(self):
        (self.root / 'fixture.txt').write_text('modified fixture\n')
        self.git('add', 'fixture.txt')
        self.git('commit', '-q', '-m', 'change fixture')
        dirty_commit = self.git('rev-parse', 'HEAD').strip()
        (self.root / 'fixture.txt').write_text('a fictional credential placeholder\n')
        report = [dict(self.report[0], Commit=dirty_commit)]
        self.assertTrue(source_policy.review_history_findings(self.root, report, self.review))

    def test_commit_path_and_detection_must_all_be_exact(self):
        for changes in [
            {'Commit': 'a' * 40}, {'Commit': 'HEAD'}, {'Commit': '--all'},
            {'File': '../fixture.txt'}, {'File': '/fixture.txt'},
            {'File': 'other.txt'}, {'RuleID': 'other-rule'}, {'StartLine': 2},
            {'Commit': None},
        ]:
            with self.subTest(changes=changes):
                report = [dict(self.history_report[0], **changes)]
                try:
                    issues = source_policy.review_history_findings(self.root, report, self.review)
                except ValueError:
                    continue
                self.assertTrue(issues)

    def test_git_replace_cannot_substitute_a_reviewed_historical_blob(self):
        reviewed_blob = self.git('rev-parse', self.commit + ':fixture.txt').strip()
        (self.root / 'fixture.txt').write_text('unreviewed content\n')
        self.git('add', 'fixture.txt')
        self.git('commit', '-q', '-m', 'different blob')
        changed_commit = self.git('rev-parse', 'HEAD').strip()
        changed_blob = self.git('rev-parse', changed_commit + ':fixture.txt').strip()
        self.git('replace', changed_blob, reviewed_blob)
        report = [dict(self.report[0], Commit=changed_commit)]
        self.assertTrue(source_policy.review_history_findings(self.root, report, self.review))

    def test_history_never_echoes_secret_values(self):
        report = [dict(self.history_report[0], RuleID='unreviewed', Secret='fictional sensitive text')]
        issues = source_policy.review_history_findings(self.root, report, self.review)
        self.assertTrue(issues)
        self.assertNotIn('fictional sensitive text', json.dumps(issues))

if __name__ == '__main__':
    unittest.main()
