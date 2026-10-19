# Copyright 2026 Memlia. All rights reserved.
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location('gate', HERE / 'gate.py')
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)

class PublicationTests(unittest.TestCase):
    def test_enterprise_path_is_rejected(self):
        self.assertIn('forbidden-path', gate.scan_entry('apps/sim/ee/x.ts', b'export {}', {}))

    def test_renamed_enterprise_blob_is_rejected(self):
        content = b'fictional restricted code'
        policy = {'denied_sha256': {gate.digest(content): 'enterprise'}}
        self.assertIn('forbidden-content', gate.scan_entry('lib/innocent.ts', content, policy))

    def test_unknown_font_and_renamed_font_are_rejected(self):
        for name in ['font.woff2', 'harmless.bin']:
            self.assertIn('unreviewed-font', gate.scan_entry(name, b'wOF2fictional', {}))

    def test_nested_license_needs_hash_admission(self):
        self.assertIn('unreviewed-license', gate.scan_entry('vendor/LICENSE', b'restrictive terms', {}))
        approved = {'allowed_license_sha256': [gate.digest(b'approved terms')]}
        self.assertEqual([], gate.scan_entry('vendor/LICENSE', b'approved terms', approved))

    def test_secret_signatures_are_rejected_without_echoing_values(self):
        samples = [b'-----BEGIN ' + b'RSA PRIVATE KEY-----', ('ghp_' + 'A' * 36).encode(), ('AKIA' + 'A' * 16).encode()]
        for content in samples:
            self.assertIn('secret-signature', gate.scan_entry('config.txt', content, {}))

    def test_secret_exception_is_bound_to_exact_reviewed_path_and_content(self):
        content = b'-----BEGIN ' + b'PRIVATE KEY-----'
        policy = {'reviewed_secret_fixtures': {'placeholder.txt': {'sha256': gate.digest(content), 'reason': 'header only'}}}
        self.assertEqual([], gate.scan_entry('placeholder.txt', content, policy))
        self.assertIn('secret-signature', gate.scan_entry('other.txt', content, policy))
        self.assertIn('secret-signature', gate.scan_entry('placeholder.txt', content + b'changed', policy))

    def test_archive_fails_closed_even_after_rename(self):
        self.assertIn('uninspected-container', gate.scan_entry('image.dat', b'PK\x03\x04hidden', {}))

    def test_legitimate_apache_source_is_preserved(self):
        self.assertEqual([], gate.scan_entry('tools/season.ts', b'export const season = 2026', {}))

    def test_imports_include_static_type_reexport_require_and_dynamic(self):
        source = '''import {x} from '@/ee/one';
import type {Y} from '@/ee/two'; export {z} from '@/ee/three';
type T = import('@/ee/four').T; const a = import('@/ee/five');
import six = require('@/ee/six'); const seven = require('@/ee/seven');
const eight = import('@/e' + 'e/eight');'''
        issues = gate.scan_imports([{'path': 'apps/sim/a.ts', 'content': source}], Path('.'))
        self.assertEqual(8, sum(x['rule'] == 'enterprise-import' for x in issues))

    def test_relative_alias_and_escaped_imports(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'tsconfig.json').write_text(json.dumps({'compilerOptions': {'baseUrl': '.', 'paths': {'private/*': ['apps/sim/ee/*']}}}))
            entries = [{'path': 'apps/sim/lib/a.ts', 'content': "import x from '../ee/x'; import y from 'private/y'; import z from '@/\\u0065e/z';"}]
            self.assertEqual(3, len(gate.scan_imports(entries, root)))

    def test_nonliteral_dynamic_import_and_parse_failure_fail_closed(self):
        issues = gate.scan_imports([{'path': 'a.ts', 'content': 'import(variable);'}], Path('.'))
        self.assertTrue(any(x['rule'] == 'unresolved-module-expression' for x in issues))
        issues = gate.scan_imports([{'path': 'a.ts', 'content': "import { from 'broken'"}], Path('.'))
        self.assertTrue(any(x['rule'] == 'parse-error' for x in issues))

    def test_comments_and_strings_are_not_imports(self):
        source = '// import x from "@/ee/x"\nconst prose = "@/ee/y";'
        self.assertEqual([], gate.scan_imports([{'path': 'a.ts', 'content': source}], Path('.')))

class WorkspaceConfigTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.package = self.root / 'packages/tsconfig'
        self.package.mkdir(parents=True)
        (self.package / 'package.json').write_text(json.dumps({
            'name': '@sim/tsconfig', 'exports': {'./base.json': './base.json'}}))
        (self.package / 'base.json').write_text(json.dumps({'compilerOptions': {
            'baseUrl': '../..', 'paths': {'restricted/*': ['apps/sim/ee/*']}}}))
        (self.root / 'apps/sim').mkdir(parents=True)
        (self.root / 'apps/sim/tsconfig.json').write_text(json.dumps({'extends': '@sim/tsconfig/base.json'}))

    def tearDown(self):
        self.tmp.cleanup()

    def test_local_workspace_config_is_resolved_without_installing_dependencies(self):
        entries = [{'path': 'apps/sim/a.ts', 'content': "import x from 'permitted-package';"}]
        self.assertEqual([], gate.scan_imports(entries, self.root))

    def test_inherited_workspace_alias_cannot_hide_enterprise_import(self):
        entries = [{'path': 'apps/sim/a.ts', 'content': "import x from 'restricted/module';"}]
        self.assertEqual(['enterprise-import'], [i['rule'] for i in gate.scan_imports(entries, self.root)])

    def test_missing_misidentified_or_escaping_config_is_not_silently_ignored(self):
        for manifest in [None, {'name': 'wrong', 'exports': {'./base.json': './base.json'}},
                         {'name': '@sim/tsconfig', 'exports': {'./base.json': '../../outside.json'}},
                         {'name': '@sim/tsconfig', 'exports': {'./base.json': './missing.json'}}]:
            if manifest is None:
                (self.package / 'package.json').unlink()
            else:
                (self.package / 'package.json').write_text(json.dumps(manifest))
            with self.subTest(manifest=manifest), self.assertRaises(ValueError):
                gate.scan_imports([{'path': 'apps/sim/a.ts', 'content': 'export {}'}], self.root)

class ReviewedLoaderTests(unittest.TestCase):
    def setUp(self):
        self.path = 'apps/sim/bootstrap.ts'
        self.content = b"const server = './server.js';\nvoid import(server);\n"
        self.review = {'path': self.path, 'sha256': gate.digest(self.content),
                       'lines': [2], 'reason': 'Reviewed fixed generated standalone entry; artifact separately inspected.'}

    def inspect(self, content=None, path=None, review=None):
        return gate.inspect_contents([(path or self.path, self.content if content is None else content)],
                                     Path('.'), {'reviewed_dynamic_imports': [self.review if review is None else review]})

    def test_reviewed_exact_loader_source_can_be_admitted(self):
        self.assertEqual([], self.inspect())

    def test_renamed_changed_or_different_line_loader_still_blocks(self):
        for issues in [self.inspect(path='apps/sim/renamed.ts'),
                       self.inspect(content=self.content + b'// changed\n'),
                       self.inspect(review={**self.review, 'lines': [1]})]:
            self.assertEqual(['unresolved-module-expression'], [i['rule'] for i in issues])

    def test_review_cannot_hide_a_second_dynamic_loader_in_same_blob(self):
        content = self.content + b'void import(otherModule);\n'
        issues = self.inspect(content=content, review={**self.review, 'sha256': gate.digest(content)})
        self.assertEqual([3], [i['line'] for i in issues])

    def test_review_never_admits_enterprise_import_or_source_secrets(self):
        content = b"void import('@/ee/restricted');\n" + ('const token = "ghp_' + 'A' * 36 + '";\n').encode()
        issues = self.inspect(content=content, review={**self.review, 'sha256': gate.digest(content), 'lines': [1]})
        self.assertEqual({'enterprise-import', 'secret-signature'}, {i['rule'] for i in issues})

    def test_review_never_admits_invalid_syntax(self):
        content = b'import { from broken'
        issues = self.inspect(content=content, review={**self.review, 'sha256': gate.digest(content), 'lines': [1]})
        self.assertIn('parse-error', [i['rule'] for i in issues])

    def test_review_cannot_authorize_embedded_source_map_loader(self):
        sourcemap = {'version': 3, 'sources': [self.path], 'sourcesContent': [self.content.decode()], 'mappings': ''}
        issues = gate.inspect_contents([('bundle.js.map', json.dumps(sourcemap).encode())], Path('.'),
                                       {'reviewed_dynamic_imports': [self.review]})
        self.assertEqual(['unresolved-module-expression'], [i['rule'] for i in issues])

    def test_review_schema_is_strict_without_echoing_source(self):
        invalid = [None, {}, {**self.review, 'path': '../escape.ts'},
                   {**self.review, 'path': 'a\\b.ts'}, {**self.review, 'sha256': '0'},
                   {**self.review, 'lines': [True]}, {**self.review, 'lines': [0]},
                   {**self.review, 'lines': []}, {**self.review, 'lines': [2, 2]},
                   {**self.review, 'reason': '  '}]
        for review in invalid:
            with self.subTest(review=review), self.assertRaisesRegex(ValueError, 'loader review'):
                gate.inspect_contents([(self.path, self.content)], Path('.'), {'reviewed_dynamic_imports': [review]})

class ScanCompletenessTests(unittest.TestCase):
    def test_missing_root_cannot_pass_tree_scan_or_cli(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing = Path(tmp) / 'absent'
            result = subprocess.run(['python3', str(HERE / 'gate.py'), 'tree', '--root', str(missing)], capture_output=True, text=True)
            self.assertEqual(2, result.returncode)
            self.assertFalse(json.loads(result.stdout)['passed'])
            with self.assertRaisesRegex(ValueError, 'directory'):
                gate.scan_tree(missing, {})

    def test_file_root_is_not_a_scannable_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'file'
            root.write_text('ordinary file')
            with self.assertRaisesRegex(ValueError, 'directory'):
                gate.scan_tree(root, {})

    def test_empty_existing_directory_is_scannable(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual([], gate.scan_tree(Path(tmp), {}))

    def test_unreadable_subdirectory_cannot_be_silently_skipped(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            child = root / 'unreadable'
            child.mkdir()
            (child / 'hidden.txt').write_text('fixture')
            child.chmod(0)
            try:
                self.assertFalse(os.access(child, os.R_OK), 'test must run without root privileges')
                with self.assertRaises(PermissionError):
                    gate.scan_tree(root, {})
            finally:
                child.chmod(0o700)

    def test_unreadable_file_cannot_pass_tree_scan(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            file = root / 'unreadable.txt'
            file.write_text('fixture')
            file.chmod(0)
            try:
                self.assertFalse(os.access(file, os.R_OK), 'test must run without root privileges')
                with self.assertRaises(PermissionError):
                    gate.scan_tree(root, {})
            finally:
                file.chmod(0o600)

    def test_indexed_sourcemaps_are_refused_instead_of_skipped(self):
        nested = {'version': 3, 'sources': ['a.ts'], 'sourcesContent': ["import x from '@/ee/x'"], 'mappings': ''}
        indexed = {'version': 3, 'sections': [{'offset': {'line': 0, 'column': 0}, 'map': nested}]}
        issues = gate.inspect_contents([('bundle.js.map', json.dumps(indexed).encode())], Path('.'), {})
        self.assertTrue(any(x['rule'] == 'uninspected-sourcemap' for x in issues))

    def test_external_sourcemap_sections_are_refused(self):
        indexed = {'version': 3, 'sections': [{'offset': {'line': 0, 'column': 0}, 'url': 'https://example.invalid/map'}]}
        issues = gate.inspect_contents([('bundle.js.map', json.dumps(indexed).encode())], Path('.'), {})
        self.assertTrue(any(x['rule'] == 'uninspected-sourcemap' for x in issues))

    def test_json_without_sourcemap_structure_cannot_pass(self):
        for invalid in [{}, {'version': 2, 'sources': [], 'sourcesContent': [], 'mappings': ''}, {'version': 3, 'sources': '', 'sourcesContent': '', 'mappings': ''}]:
            with self.subTest(invalid=invalid):
                issues = gate.inspect_contents([('bundle.js.map', json.dumps(invalid).encode())], Path('.'), {})
                self.assertTrue(any(x['rule'] == 'uninspected-sourcemap' for x in issues))

    def test_flat_sourcemap_embedded_import_is_inspected(self):
        sourcemap = {'version': 3, 'sources': ['a.ts'], 'sourcesContent': ["import x from '@/ee/x'"], 'mappings': ''}
        issues = gate.inspect_contents([('bundle.js.map', json.dumps(sourcemap).encode())], Path('.'), {})
        self.assertTrue(any(x['rule'] == 'enterprise-import' for x in issues))

class SourceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.git('init', '-q')
        self.git('config', 'user.email', 'fixture@example.invalid')
        self.git('config', 'user.name', 'Fictional fixture')
        self.git('remote', 'add', 'origin', 'https://example.invalid/source.git')
        (self.root / 'LICENSE').write_text('approved terms')
        self.git('add', 'LICENSE')
        self.git('commit', '-qm', 'initial')
        self.manifest = {'repository': 'https://example.invalid/source.git', 'sha': self.git('rev-parse', 'HEAD'), 'license_files': [{'path': 'LICENSE', 'sha256': gate.digest(b'approved terms')}]}

    def tearDown(self):
        self.tmp.cleanup()

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.root), *args], stderr=subprocess.DEVNULL).decode().strip()

    def test_wrong_origin_is_rejected(self):
        self.manifest['repository'] = 'https://example.invalid/other.git'
        with self.assertRaisesRegex(ValueError, 'origin'):
            gate.validate_source(self.root, self.manifest)

    def test_wrong_sha_is_rejected(self):
        self.manifest['sha'] = '0' * 40
        with self.assertRaisesRegex(ValueError, 'SHA'):
            gate.validate_source(self.root, self.manifest)

    def test_dirty_source_is_rejected(self):
        (self.root / 'LICENSE').write_text('changed')
        with self.assertRaisesRegex(ValueError, 'dirty'):
            gate.validate_source(self.root, self.manifest)

    def test_wrong_license_hash_is_rejected(self):
        self.manifest['license_files'][0]['sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'license'):
            gate.validate_source(self.root, self.manifest)

    def test_valid_source_is_admitted(self):
        gate.validate_source(self.root, self.manifest)

    def test_loader_review_checks_historical_blob_instead_of_current_checkout(self):
        original = b'void import(unreviewedTarget);\n'
        (self.root / 'loader.ts').write_bytes(original)
        self.git('add', 'loader.ts')
        self.git('commit', '-qm', 'unreviewed loader')
        old_commit = self.git('rev-parse', 'HEAD')
        reviewed = b"const target = './server.js'; void import(target);\n"
        (self.root / 'loader.ts').write_bytes(reviewed)
        self.git('add', 'loader.ts')
        self.git('commit', '-qm', 'reviewed loader')
        policy = {'allowed_license_sha256': [gate.digest(b'approved terms')],
                  'reviewed_dynamic_imports': [{'path': 'loader.ts', 'sha256': gate.digest(reviewed),
                                               'lines': [1], 'reason': 'Fixed standalone entry source.'}]}
        self.assertEqual([], gate.scan_tree(self.root, policy))
        self.assertEqual([{'path': 'loader.ts', 'rule': 'unresolved-module-expression',
                           'line': 1, 'commit': old_commit}], gate.scan_history(self.root, policy))

    def test_copy_uses_git_blobs_and_excludes_restricted_and_development_files(self):
        files = {'apps/sim/lib/allowed.ts': 'export const allowed = true',
                 'apps/sim/ee/blocked.ts': 'restricted',
                 '.github/workflows/publish.yml': 'publish',
                 'apps/sim/CLAUDE.md': 'upstream guidance',
                 'apps/sim/public/SeasonSans.woff2': 'font',
                 'README.md': 'upstream readme'}
        for name, text in files.items():
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text)
        self.git('add', '.')
        self.git('commit', '-qm', 'source')
        self.manifest['sha'] = self.git('rev-parse', 'HEAD')
        with tempfile.TemporaryDirectory() as tmp:
            destination = Path(tmp)
            (destination / 'README.md').write_text('neutral product')
            result = gate.prepare(self.root, destination, self.manifest, {'allowed_license_sha256': [gate.digest(b'approved terms')]})
            self.assertTrue((destination / 'apps/sim/lib/allowed.ts').exists())
            self.assertEqual('export const allowed = true', (destination / 'apps/sim/lib/allowed.ts').read_text())
            self.assertEqual('neutral product', (destination / 'README.md').read_text())
            self.assertFalse((destination / 'apps/sim/ee').exists())
            self.assertFalse((destination / '.github').exists())
            self.assertFalse((destination / 'apps/sim/CLAUDE.md').exists())
            self.assertFalse((destination / 'apps/sim/public/SeasonSans.woff2').exists())
            self.assertGreater(len(result['excluded']), 0)

    def test_copy_refuses_existing_different_file_before_writing_anything(self):
        with tempfile.TemporaryDirectory() as tmp:
            destination = Path(tmp)
            target = destination / 'compliance/upstream/sim/LICENSE'
            target.parent.mkdir(parents=True)
            target.write_text('do not overwrite')
            with self.assertRaisesRegex(ValueError, 'collision'):
                gate.prepare(self.root, destination, self.manifest, {'allowed_license_sha256': [gate.digest(b'approved terms')]})
            self.assertEqual('do not overwrite', target.read_text())

    def test_explicit_tracker_exclusion_is_bound_to_reviewed_blob(self):
        tracker = 'apps/sim/lib/consent/scripts.ts'
        target = self.root / tracker
        target.parent.mkdir(parents=True)
        target.write_text('fictional upstream analytics identifiers')
        self.git('add', '.')
        self.git('commit', '-qm', 'tracker fixture')
        self.manifest['sha'] = self.git('rev-parse', 'HEAD')
        policy = {'allowed_license_sha256': [gate.digest(b'approved terms')], 'excluded_sources': {
            tracker: {'sha256': gate.digest(target.read_bytes()), 'reason': 'Trackers amont à remplacer P01.'}}}
        with tempfile.TemporaryDirectory() as tmp:
            result = gate.prepare(self.root, Path(tmp), self.manifest, policy)
            self.assertFalse((Path(tmp) / tracker).exists())
            excluded = next(x for x in result['excluded'] if x['path'] == tracker)
            self.assertEqual(policy['excluded_sources'][tracker]['sha256'], excluded['sha256'])
        target.write_text('changed tracker fixture')
        self.git('add', '.')
        self.git('commit', '-qm', 'tracker changed')
        self.manifest['sha'] = self.git('rev-parse', 'HEAD')
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(ValueError, 'exclusion'):
                gate.prepare(self.root, Path(tmp), self.manifest, policy)
            self.assertEqual([], list(Path(tmp).iterdir()))

    def test_parent_collision_is_refused_before_any_copy(self):
        (self.root / 'z').mkdir()
        (self.root / 'z/allowed.txt').write_text('allowed')
        self.git('add', '.')
        self.git('commit', '-qm', 'nested file')
        self.manifest['sha'] = self.git('rev-parse', 'HEAD')
        with tempfile.TemporaryDirectory() as tmp:
            destination = Path(tmp)
            (destination / 'z').write_text('existing user file')
            error = None
            try:
                gate.prepare(self.root, destination, self.manifest, {'allowed_license_sha256': [gate.digest(b'approved terms')]})
            except (ValueError, OSError) as caught:
                error = caught
            self.assertEqual(['z'], sorted(p.name for p in destination.iterdir()))
            self.assertEqual('existing user file', (destination / 'z').read_text())
            self.assertIsInstance(error, ValueError)

    def test_shallow_history_cannot_hide_deleted_enterprise_file(self):
        (self.root / 'ee').mkdir()
        (self.root / 'ee/x.ts').write_text('export {}')
        self.git('add', '.')
        self.git('commit', '-qm', 'introduce')
        self.git('rm', '-qr', 'ee')
        self.git('commit', '-qm', 'remove')
        with tempfile.TemporaryDirectory() as tmp:
            clone = Path(tmp) / 'shallow'
            subprocess.run(['git', 'clone', '-q', '--depth=1', self.root.as_uri(), str(clone)], check=True, capture_output=True)
            self.assertEqual(b'true', gate.git(clone, 'rev-parse', '--is-shallow-repository').strip())
            with self.assertRaisesRegex(ValueError, 'shallow'):
                gate.scan_history(clone, {'allowed_license_sha256': [gate.digest(b'approved terms')]})

    def test_partial_clone_configuration_is_not_full_history_proof(self):
        self.git('config', 'remote.origin.promisor', 'true')
        self.git('config', 'remote.origin.partialclonefilter', 'blob:none')
        with self.assertRaisesRegex(ValueError, 'partial'):
            gate.scan_history(self.root, {'allowed_license_sha256': [gate.digest(b'approved terms')]})

    def test_missing_historical_object_fails_without_fetching(self):
        old_blob = self.git('rev-parse', 'HEAD:LICENSE')
        (self.root / 'LICENSE').write_text('replacement terms')
        self.git('add', '.')
        self.git('commit', '-qm', 'change')
        object_path = self.root / '.git/objects' / old_blob[:2] / old_blob[2:]
        self.assertTrue(object_path.is_file())
        object_path.unlink()
        with self.assertRaises(ValueError):
            gate.scan_history(self.root, {})

    def test_deleted_forbidden_file_remains_in_history(self):
        target = self.root / 'apps/sim/ee/x.ts'
        target.parent.mkdir(parents=True)
        target.write_text('export {}')
        self.git('add', '.')
        self.git('commit', '-qm', 'introduce')
        self.git('rm', '-q', 'apps/sim/ee/x.ts')
        self.git('commit', '-qm', 'remove')
        issues = gate.scan_history(self.root, {'allowed_license_sha256': [gate.digest(b'approved terms')]})
        self.assertTrue(any(x['rule'] == 'forbidden-path' for x in issues))

    def test_replace_commit_cannot_hide_deleted_forbidden_file(self):
        clean = self.git('rev-parse', 'HEAD')
        (self.root / 'ee').mkdir()
        (self.root / 'ee/fixture.txt').write_text('synthetic excluded content')
        self.git('add', '.')
        self.git('commit', '-qm', 'introduce')
        original = self.git('rev-parse', 'HEAD')
        self.git('rm', '-qr', 'ee')
        self.git('commit', '-qm', 'remove')
        self.git('replace', original, clean)
        issues = gate.scan_history(self.root, {'allowed_license_sha256': [gate.digest(b'approved terms')]})
        self.assertTrue(any(issue['rule'] == 'forbidden-path' for issue in issues))

    def test_grafted_history_is_not_complete_publication_proof(self):
        grafts = self.root / '.git/info/grafts'
        grafts.write_text(self.git('rev-parse', 'HEAD') + '\n')
        with self.assertRaisesRegex(ValueError, 'graft'):
            gate.scan_history(self.root, {'allowed_license_sha256': [gate.digest(b'approved terms')]})

    def test_replace_blob_cannot_hide_forbidden_content_at_innocent_path(self):
        forbidden = b'synthetic forbidden source fixture'
        (self.root / 'fixture.txt').write_bytes(forbidden)
        self.git('add', '.')
        self.git('commit', '-qm', 'introduce')
        original = self.git('rev-parse', 'HEAD:fixture.txt')
        (self.root / 'fixture.txt').write_text('safe replacement fixture')
        self.git('add', '.')
        self.git('commit', '-qm', 'remove')
        replacement = self.git('rev-parse', 'HEAD:fixture.txt')
        self.git('replace', original, replacement)
        policy = {'allowed_license_sha256': [gate.digest(b'approved terms')],
                  'denied_sha256': {gate.digest(forbidden): 'synthetic fixture'}}
        issues = gate.scan_history(self.root, policy)
        self.assertTrue(any(issue['rule'] == 'forbidden-content' for issue in issues))

    def test_deleted_alias_config_cannot_hide_an_enterprise_import(self):
        (self.root / 'tsconfig.json').write_text(json.dumps({'compilerOptions': {'paths': {'private/*': ['./apps/sim/ee/*']}}}))
        (self.root / 'a.ts').write_text("import x from 'private/hidden'")
        self.git('add', '.')
        self.git('commit', '-qm', 'alias import')
        self.git('rm', '-q', 'a.ts', 'tsconfig.json')
        self.git('commit', '-qm', 'remove alias')
        issues = gate.scan_history(self.root, {'allowed_license_sha256': [gate.digest(b'approved terms')]})
        self.assertTrue(any(x['rule'] == 'enterprise-import' for x in issues))

    def test_symlink_is_rejected(self):
        (self.root / 'link').symlink_to('/etc/passwd')
        self.git('add', 'link')
        self.git('commit', '-qm', 'link')
        issues = gate.scan_history(self.root, {'allowed_license_sha256': [gate.digest(b'approved terms')]})
        self.assertTrue(any(x['rule'] == 'unsupported-git-mode' for x in issues))

if __name__ == '__main__':
    unittest.main()
