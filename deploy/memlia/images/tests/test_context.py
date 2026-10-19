"""Behavioral checks for the allowlisted build context; no Docker required."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('prepare_context', Path(__file__).with_name('prepare_context.py'))
context = importlib.util.module_from_spec(spec)
spec.loader.exec_module(context)

class ContextTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / 'source'
        self.source.mkdir()
        self.output = self.root / 'output'
        self.recipe = self.root / 'images'
        self.recipe.mkdir()
        (self.recipe / 'migrations.Dockerfile').write_text('FROM scratch\n')
        (self.recipe / 'tests').mkdir()
        (self.recipe / 'tests/bun-LICENSE.md').write_text('license fixture')
        for name in ('package.json', 'bun.lock', 'bunfig.toml'):
            (self.source / name).write_text('{}\n')
        for name in ('patches/postgres.patch', 'compliance/upstream/sim/LICENSE', 'compliance/upstream/sim/NOTICE',
                     'packages/db/package.json', 'packages/db/scripts/migrate.ts',
                     'packages/db/migrations/0001.sql', 'packages/db/migrations/meta/_journal.json',
                     'packages/db/migrations/meta/0001_snapshot.json',
                     'packages/logger/package.json', 'packages/utils/package.json', 'packages/tsconfig/package.json'):
            target = self.source / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('fixture')

    def prepare(self):
        return context.prepare('migrations', self.source, self.recipe, self.output)

    def test_allowlist_preserves_bytes_and_excludes_unrelated_and_sensitive_files(self):
        for name in ('.git/config', '.env', 'packages/db/.env.local', 'packages/db/node_modules/stale.js',
                     'packages/db/private.key', 'packages/db/archive.tar.gz', 'apps/sim/secret.txt'):
            target = self.source / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('must not enter image')
        self.prepare()
        self.assertEqual((self.output / 'bun.lock').read_bytes(), (self.source / 'bun.lock').read_bytes())
        self.assertTrue((self.output / 'packages/db/migrations/meta/_journal.json').is_file())
        self.assertFalse((self.output / 'packages/db/migrations/meta/0001_snapshot.json').exists())
        self.assertFalse(any(b'must not enter image' in p.read_bytes() for p in self.output.rglob('*') if p.is_file()))
        manifest = json.loads((self.output / 'context-manifest.json').read_text())
        self.assertIn('packages/db/scripts/migrate.ts', manifest['sha256'])

    def test_symlink_in_selected_sources_is_rejected(self):
        (self.source / 'packages/db/escape.ts').symlink_to(self.source / 'bun.lock')
        with self.assertRaises(ValueError):
            self.prepare()
        self.assertFalse(self.output.exists())

    def test_unverified_cron_binary_is_rejected(self):
        (self.recipe / 'cron.Dockerfile').write_text('FROM scratch\n')
        assets = self.root / 'assets'
        assets.mkdir()
        (assets / 'supercronic').write_bytes(b'untrusted')
        with self.assertRaises(ValueError):
            context.prepare('cron', self.source, self.recipe, self.output, assets)
        self.assertFalse(self.output.exists())

    def test_existing_destination_is_never_overwritten(self):
        self.output.mkdir()
        sentinel = self.output / 'keep'
        sentinel.write_text('keep')
        with self.assertRaises(FileExistsError):
            self.prepare()
        self.assertEqual(sentinel.read_text(), 'keep')

    def test_missing_required_native_runner_fails_closed(self):
        (self.source / 'packages/db/scripts/migrate.ts').unlink()
        with self.assertRaises(FileNotFoundError):
            self.prepare()
        self.assertFalse(self.output.exists())

if __name__ == '__main__':
    unittest.main()
