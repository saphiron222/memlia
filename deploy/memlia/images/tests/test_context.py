"""Behavioral checks for the allowlisted build context; no Docker required."""
import importlib.util
import json
from pathlib import Path
import tempfile
import subprocess
import hashlib
import os
import re
import shutil
import sys
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
        self.recipe = self.source / 'deploy/memlia/images'
        self.recipe.mkdir(parents=True)
        (self.recipe / 'migrations.Dockerfile').write_text('FROM scratch\n')
        (self.recipe / 'tests').mkdir()
        (self.recipe / 'tests/bun-LICENSE.md').write_text('license fixture')
        for name in ('package.json', 'bun.lock', 'bunfig.toml'):
            (self.source / name).write_text('{}\n')
        for name in ('patches/postgres.patch', 'compliance/upstream/sim/LICENSE', 'compliance/upstream/sim/NOTICE',
                     'packages/db/package.json', 'packages/db/scripts/migrate.ts',
                     'deploy/memlia/database-bootstrap.ts',
                     'packages/db/migrations/0001.sql', 'packages/db/migrations/meta/_journal.json',
                     'packages/db/migrations/meta/0001_snapshot.json',
                     'packages/logger/package.json', 'packages/utils/package.json', 'packages/tsconfig/package.json'):
            target = self.source / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('fixture')

    def commit(self):
        def git(*args):
            return subprocess.check_output(['git', '-C', str(self.source), *args], stderr=subprocess.PIPE).decode().strip()
        git('init', '-q'); git('config', 'user.name', 'Fictitious'); git('config', 'user.email', 'fixture@example.invalid')
        git('add', '-A'); git('commit', '-qm', 'fictitious snapshot')
        return git('rev-parse', 'HEAD')

    def prepare(self):
        return context.prepare('migrations', self.source, self.recipe, self.output, source_commit=self.commit())

    def test_provenance_binds_verified_commit_and_original_lock(self):
        revision=self.commit()
        context.prepare('migrations', self.source, self.recipe, self.output, source_commit=revision)
        self.assertEqual((self.output/'build-provenance/source').read_text(),revision+'\n')
        self.assertEqual((self.output/'build-provenance/lock').read_text(),hashlib.sha256((self.source/'bun.lock').read_bytes()).hexdigest()+'\n')
        self.assertEqual((self.output/'build-provenance/bun.lock').read_bytes(),(self.source/'bun.lock').read_bytes())

    def test_provenance_refuses_wrong_revision_dirty_or_untracked_selected_bytes(self):
        revision=self.commit()
        with self.assertRaises(ValueError):context.prepare('migrations',self.source,self.recipe,self.output,source_commit='a'*40)
        (self.source/'bun.lock').write_text('dirty')
        with self.assertRaises(ValueError):context.prepare('migrations',self.source,self.recipe,self.output,source_commit=revision)
        (self.source/'bun.lock').write_text('{}\n')
        (self.source/'packages/db/untracked.ts').write_text('untracked')
        with self.assertRaises(ValueError):context.prepare('migrations',self.source,self.recipe,self.output,source_commit=revision)
        self.assertFalse(self.output.exists())


    def test_allowlist_preserves_bytes_and_excludes_unrelated_and_sensitive_files(self):
        for name in ('.env', 'packages/db/.env.local', 'packages/db/node_modules/stale.js',
                     'packages/db/private.key', 'packages/db/archive.tar.gz', 'apps/sim/secret.txt'):
            target = self.source / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text('must not enter image')
        self.prepare()
        self.assertEqual((self.output / 'bun.lock').read_bytes(), (self.source / 'bun.lock').read_bytes())
        self.assertTrue((self.output / 'packages/db/migrations/meta/_journal.json').is_file())
        self.assertFalse((self.output / '.git').exists())
        self.assertFalse((self.output / 'packages/db/migrations/meta/0001_snapshot.json').exists())
        self.assertFalse(any(b'must not enter image' in p.read_bytes() for p in self.output.rglob('*') if p.is_file()))
        manifest = json.loads((self.output / 'context-manifest.json').read_text())
        self.assertIn('packages/db/scripts/migrate.ts', manifest['sha256'])

    def test_web_and_realtime_context_keep_native_turbo_input(self):
        (self.source/'docker').mkdir();(self.source/'apps/realtime').mkdir(parents=True)
        (self.source/'apps/realtime/package.json').write_text('{}')
        (self.source/'turbo.json').write_text('{"tasks":{}}')
        for kind in ('app','realtime'):(self.source/'docker'/(kind+'.Dockerfile')).write_text('FROM scratch\n')
        revision=self.commit()
        for kind in ('app','realtime'):
            output=self.root/kind
            context.prepare(kind,self.source,self.recipe,output,source_commit=revision)
            self.assertEqual((output/'turbo.json').read_bytes(),(self.source/'turbo.json').read_bytes())
            self.assertEqual(json.loads((output/'context-manifest.json').read_text())['sourceCommit'],revision)

    def test_installation_cli_is_byte_exact_and_selected_individually(self):
        secret = self.source / 'deploy/memlia/operator-secret.json'
        secret.write_text('private operator configuration')
        self.prepare()
        self.assertEqual((self.output / 'deploy/memlia/database-bootstrap.ts').read_bytes(),
                         (self.source / 'deploy/memlia/database-bootstrap.ts').read_bytes())
        self.assertFalse((self.output / 'deploy/memlia/operator-secret.json').exists())

    def test_missing_installation_cli_refuses_context(self):
        (self.source / 'deploy/memlia/database-bootstrap.ts').unlink()
        with self.assertRaises(FileNotFoundError):
            self.prepare()
        self.assertFalse(self.output.exists())

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
            context.prepare('cron', self.source, self.recipe, self.output, assets, source_commit=self.commit())
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

class CronArchitectureTests(unittest.TestCase):
    def test_real_cron_architecture_guard_rejects_cross_architecture(self):
        text=Path(__file__).resolve().parents[1].joinpath('cron.Dockerfile').read_text()
        command=text.split('RUN test "$(cat /tmp/memlia-build/architecture)"',1)[1].split('&& cd /tmp/apk',1)[0]
        command='test "$(cat /tmp/memlia-build/architecture)"'+command
        command=command.replace('\\\n','').strip()
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'architecture'
            command=command.replace('/tmp/memlia-build/architecture',str(path))
            for selected,target,ok in [('amd64','amd64',True),('arm64','arm64',True),('amd64','arm64',False),('arm64','amd64',False),('other','other',False),('amd64','',False)]:
                path.write_text(selected+'\n')
                result=subprocess.run(['/bin/sh','-c',command],env={'PATH':'/usr/bin:/bin','TARGETARCH':target},capture_output=True,timeout=5)
                self.assertEqual(result.returncode==0,ok,result.stderr)

    def test_pinned_amd64_selection_keeps_versions_and_separate_hashes(self):
        spec=importlib.util.spec_from_file_location('cron_assets',Path(__file__).with_name('fetch_cron_assets.py'))
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        arm=module.asset_pins('arm64');amd=module.asset_pins('amd64')
        self.assertEqual(set(arm),set(amd))
        self.assertEqual(len([n for n in amd if n.startswith('apk/')]),19)
        self.assertTrue(amd['supercronic'][0].endswith('supercronic-linux-amd64'))
        self.assertNotEqual(arm['supercronic'][1],amd['supercronic'][1])
        for name in amd:
            if name.startswith('apk/'):
                self.assertIn('/x86_64/',amd[name][0]);self.assertNotEqual(amd[name][1],arm[name][1])
        with self.assertRaises(ValueError):module.asset_pins('amd64\n')

class TurboLockTests(unittest.TestCase):
    HEADER = b'// Modified by Memlia in 2026. Upstream Apache-2.0 license and notices retained.\n'
    BODY = b'{"lockfileVersion":1,"workspaces":{},"packages":{}}\n'

    def prune(self, recipe, original=None, provenance=None):
        """Execute the actual RUN with native Bun; only Turbo is substituted.

        Native Turbo parsing/pruning is a separate opt-in diagnostic. This small
        oracle checks its exact input and that downstream stages get the original.
        """
        bun = shutil.which('bun')
        if not bun:
            self.skipTest('native Bun required for Docker RUN input check')
        text = (Path(__file__).resolve().parents[4] / 'docker' / recipe).read_text()
        command = next(line[4:] for line in text.replace('\\\n', '').splitlines()
                       if line.startswith('RUN ') and ' prune ' in line)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            lock = self.HEADER + self.BODY if original is None else original
            (root / 'bun.lock').write_bytes(lock)
            source = root / 'provenance'; source.mkdir()
            (source / 'bun.lock').write_bytes(lock if provenance is None else provenance)
            (root / 'package.json').write_text('{"devDependencies":{"turbo":"2.9.14"}}')
            (root / 'apps/sim').mkdir(parents=True)
            (root / 'apps/sim/package.json').write_text('{"name":"@sim/app"}')
            binary = root / 'bin'; binary.mkdir()
            (binary / 'bun').symlink_to(bun)
            fake = binary / 'bunx'
            fake.write_text('#!' + sys.executable + '\n'
                'from pathlib import Path\n'
                'import json\n'
                'data=Path("bun.lock").read_bytes()\n'
                'assert data==' + repr(self.BODY) + '\n'
                'assert json.loads(data)["lockfileVersion"]==1\n'
                'Path("prune-called").write_text("called")\n')
            fake.chmod(0o700)
            result = subprocess.run(['/bin/sh', '-ec', command.replace('/tmp/memlia-build', str(source))],
                cwd=root, env={'PATH': str(binary) + ':/usr/bin:/bin'},
                capture_output=True, timeout=10)
            return result, (root / 'bun.lock').read_bytes(), (root / 'prune-called').exists()

    def test_pruner_receives_only_lock_body_then_restores_original_notice_and_bytes(self):
        for recipe in ('app.Dockerfile', 'realtime.Dockerfile'):
            with self.subTest(recipe=recipe):
                result, lock, called = self.prune(recipe)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertTrue(called)
                self.assertEqual(lock, self.HEADER + self.BODY)

    def test_unexpected_header_is_refused_before_turbo_or_lock_mutation(self):
        for lock in (self.BODY, b'// another header\n' + self.BODY,
                     self.HEADER + b'\n' + self.BODY):
            for recipe in ('app.Dockerfile', 'realtime.Dockerfile'):
                with self.subTest(recipe=recipe, lock=lock):
                    result, after, called = self.prune(recipe, original=lock)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertFalse(called)
                    self.assertEqual(after, lock)

    def test_mismatched_admitted_lock_is_refused_before_turbo_or_mutation(self):
        for recipe in ('app.Dockerfile', 'realtime.Dockerfile'):
            with self.subTest(recipe=recipe):
                result, lock, called = self.prune(recipe, provenance=b'different source')
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(called)
                self.assertEqual(lock, self.HEADER + self.BODY)


class DockerProvenanceTests(unittest.TestCase):
    def test_real_guard_rejects_missing_malformed_or_mismatched_arguments(self):
        root=Path(__file__).resolve().parents[4]
        names=['docker/app.Dockerfile','docker/realtime.Dockerfile',*['deploy/memlia/images/'+n+'.Dockerfile' for n in ('migrations','cron','workflow-worker')]]
        for name in names:
            text=(root/name).read_text()
            with self.subTest(recipe=name):
                guard=text.split('# Verify admitted build provenance before installation.\n',1)[1].split('\n# End build provenance.',1)[0]
                command=guard.split('RUN ',1)[1].replace('\\\n','')
                with tempfile.TemporaryDirectory() as d:
                    dest=Path(d); (dest/'source').write_text('a'*40+'\n');(dest/'bun.lock').write_text('fixed lock');(dest/'context-bun.lock').write_text('fixed lock')
                    lock=hashlib.sha256(b'fixed lock').hexdigest();(dest/'lock').write_text(lock+'\n')
                    command=command.replace('/tmp/memlia-build',str(dest))
                    for source,sha,success in [('a'*40,lock,True),('',lock,False),('a'*39,lock,False),('a'*40+'\n',lock,False),('b'*40,lock,False),('a'*40,'',False),('a'*40,'c'*64,False),('a'*40,lock+'\n',False)]:
                        env={'PATH':'/usr/bin:/bin:/sbin','MEMLIA_SOURCE_COMMIT':source,'MEMLIA_LOCK_SHA256':sha}
                        result=subprocess.run(['/bin/sh','-c',command],env=env,capture_output=True,timeout=5)
                        self.assertEqual(result.returncode==0,success,(name,source,sha,result.stderr))
                    (dest/'context-bun.lock').write_text('changed lock')
                    self.assertNotEqual(subprocess.run(['/bin/sh','-c',command],env={'PATH':'/usr/bin:/bin:/sbin','MEMLIA_SOURCE_COMMIT':'a'*40,'MEMLIA_LOCK_SHA256':lock},capture_output=True).returncode,0)
                final=text.rsplit('FROM ',1)[1]
                self.assertIn('org.memlia.source=$MEMLIA_SOURCE_COMMIT',final)
                self.assertIn('org.memlia.lock=$MEMLIA_LOCK_SHA256',final)

if __name__ == '__main__':
    unittest.main()
