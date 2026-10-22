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
import stat
import sys
import unittest
from contextlib import ExitStack
from unittest.mock import patch

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
        # As in the real repository; a tracked node_modules file is refused (see below).
        (self.source / '.gitignore').write_text('node_modules/\n')
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

    def web_source(self):
        (self.source/'docker').mkdir()
        (self.source/'docker/app.Dockerfile').write_text('FROM scratch\n')
        (self.source/'apps/sim').mkdir(parents=True)
        (self.source/'apps/sim/package.json').write_text('{}')
        (self.source/'turbo.json').write_text('{"tasks":{}}')
        return [
            'apps/sim/app/.well-known',
            'apps/sim/app/api/auth/.well-known',
            'apps/sim/app/api/mcp/copilot/.well-known',
            'apps/sim/public/.well-known',
        ]

    def test_web_context_preserves_reviewed_discovery_sources_byte_exact(self):
        paths=self.web_source()
        for name in paths:
            target=self.source/name/'metadata/route.ts'
            target.parent.mkdir(parents=True);target.write_text('public discovery fixture\n')
        revision=self.commit()
        context.prepare('app',self.source,self.recipe,self.output,source_commit=revision)
        manifest=json.loads((self.output/'context-manifest.json').read_text())['sha256']
        for name in paths:
            relative=name+'/metadata/route.ts'
            self.assertEqual((self.output/relative).read_bytes(),(self.source/relative).read_bytes())
            self.assertEqual(manifest[relative],hashlib.sha256((self.source/relative).read_bytes()).hexdigest())
        self.assertEqual((self.output/'bun.lock').read_bytes(),(self.source/'bun.lock').read_bytes())

    def test_discovery_allowlist_keeps_hidden_and_sensitive_inputs_excluded(self):
        paths=self.web_source()
        for name in paths:
            for child in ('.env','.hidden/route.ts','private.key','archive.tgz'):
                target=self.source/name/child
                target.parent.mkdir(parents=True,exist_ok=True);target.write_text('excluded fixture')
        unrelated='apps/sim/app/unreviewed/.well-known/route.ts'
        (self.source/unrelated).parent.mkdir(parents=True)
        (self.source/unrelated).write_text('excluded fixture')
        revision=self.commit()
        context.prepare('app',self.source,self.recipe,self.output,source_commit=revision)
        self.assertFalse(any(b'excluded fixture' in p.read_bytes() for p in self.output.rglob('*') if p.is_file()))

    def test_untracked_discovery_source_is_refused_before_any_context_is_published(self):
        paths=self.web_source();revision=self.commit()
        target=self.source/paths[0]/'unexpected.ts';target.parent.mkdir(parents=True);target.write_text('not admitted')
        with self.assertRaises(ValueError):
            context.prepare('app',self.source,self.recipe,self.output,source_commit=revision)
        self.assertFalse(self.output.exists())

    def test_symlink_at_reviewed_discovery_path_is_refused(self):
        paths=self.web_source()
        target=self.source/paths[0];target.parent.mkdir(parents=True)
        target.symlink_to(self.source/'packages/db',target_is_directory=True)
        revision=self.commit()
        with self.assertRaises(ValueError):
            context.prepare('app',self.source,self.recipe,self.output,source_commit=revision)
        self.assertFalse(self.output.exists())
        target.unlink();target.mkdir()
        (target/'route.ts').symlink_to(self.source/'package.json')
        revision=self.commit()
        with self.assertRaises(ValueError):
            context.prepare('app',self.source,self.recipe,self.output,source_commit=revision)
        self.assertFalse(self.output.exists())

    # Real Sim source module names that also name runtime or internal folders.
    HOMONYMS = ('apps/sim/lib/uploads/core/storage.ts', 'apps/sim/lib/workflows/references/index.ts',
                'apps/sim/lib/secrets/references/route.ts', 'apps/sim/app/api/files/uploads/route.ts',
                'apps/sim/app/(landing)/solutions/engineering/page.tsx', 'packages/example/windows-lab/a.ts')

    def application_source(self):
        (self.source/'docker').mkdir()
        for kind in ('app', 'realtime'):(self.source/'docker'/(kind+'.Dockerfile')).write_text('FROM scratch\n')
        (self.recipe/'workflow-worker.Dockerfile').write_text('FROM scratch\n')
        (self.source/'turbo.json').write_text('{"tasks":{}}')
        (self.source/'apps/sim').mkdir(parents=True)
        # Same rule as the real repository: only the application-local store is ignored.
        (self.source/'apps/sim/.gitignore').write_text('/uploads\n')
        for name in self.HOMONYMS:
            target=self.source/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_text('source '+name)

    def test_tracked_source_named_like_runtime_or_internal_folders_enters_every_application_context(self):
        self.application_source();revision=self.commit()
        for kind in ('app','realtime','workflow-worker'):
            with self.subTest(kind=kind):
                output=self.root/kind
                context.prepare(kind,self.source,self.recipe,output,source_commit=revision)
                manifest=json.loads((output/'context-manifest.json').read_text())['sha256']
                for name in self.HOMONYMS:
                    self.assertEqual((output/name).read_bytes(),(self.source/name).read_bytes())
                    self.assertEqual(manifest[name],hashlib.sha256((self.source/name).read_bytes()).hexdigest())

    def recorded_reads(self):
        """Every file prepare() reads or copies; a proof of non-reading that also holds as root."""
        reads=[];read_bytes=Path.read_bytes;copyfile=context.shutil.copyfile
        def read(path):reads.append(Path(path).resolve());return read_bytes(path)
        def copy(origin,target,*a,**kw):reads.append(Path(origin).resolve());return copyfile(origin,target,*a,**kw)
        stack=ExitStack();self.addCleanup(stack.close)
        stack.enter_context(patch.object(Path,'read_bytes',read));stack.enter_context(patch.object(context.shutil,'copyfile',copy))
        return reads,stack

    def test_ee_generated_secret_and_runtime_data_stay_out_without_being_read(self):
        self.application_source()
        for name in ('apps/sim/ee/sso.ts','apps/sim/lib/ee/billing.ts','packages/example/certs/server.crt',
                     'packages/example/private.pem','apps/sim/public/bundle.tgz'):
            target=self.source/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_text('excluded fixture')
        revision=self.commit()
        # Ignored generated outputs and the runtime store, unreadable: any read would raise.
        for name in ('apps/sim/uploads/workspace/classeur.xlsx','apps/sim/.next/server.js',
                     'packages/example/node_modules/x/index.js','packages/example/dist/index.js',
                     'apps/sim/coverage/lcov.info','apps/sim/lib/uploads/__pycache__/a.pyc'):
            target=self.source/name;target.parent.mkdir(parents=True,exist_ok=True)
            target.write_text('excluded fixture');target.chmod(0)
            self.addCleanup(target.chmod,0o600)
        reads,stack=self.recorded_reads()
        with stack:context.prepare('app',self.source,self.recipe,self.output,source_commit=revision)
        excluded=[p for p in self.source.rglob('*') if p.is_file() and context.exclusion(p.relative_to(self.source).as_posix())]
        self.assertGreater(len(excluded),10)
        self.assertEqual(sorted(set(reads)&{p.resolve() for p in excluded}),[])
        self.assertIn((self.source/'apps/sim/lib/uploads/core/storage.ts').resolve(),reads)
        files=[p for p in self.output.rglob('*') if p.is_file()]
        self.assertFalse(any(b'excluded fixture' in p.read_bytes() for p in files))
        self.assertFalse(any(part=='ee' for p in files for part in p.relative_to(self.output).parts))
        self.assertTrue((self.output/'apps/sim/lib/uploads/core/storage.ts').is_file())

    def test_untracked_file_beside_homonym_source_is_refused_without_reading_it(self):
        self.application_source();revision=self.commit()
        target=self.source/'apps/sim/lib/uploads/untracked.ts';target.write_text('not admitted');target.chmod(0)
        self.addCleanup(target.chmod,0o600)
        reads,stack=self.recorded_reads()
        with stack,self.assertRaisesRegex(ValueError,'^source_refused$'):
            context.prepare('app',self.source,self.recipe,self.output,source_commit=revision)
        self.assertNotIn(target.resolve(),reads)
        self.assertFalse(self.output.exists())

    def test_tracked_source_below_a_generated_output_name_is_refused_not_dropped(self):
        self.application_source()
        for name in ('apps/sim/lib/cache/index.ts','packages/example/dist/index.js','packages/example/node_modules/x/index.js'):
            with self.subTest(name=name):
                target=self.source/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_text('tracked source')
                revision=self.commit()
                with self.assertRaisesRegex(ValueError,'^source_refused$') as refused:
                    context.prepare('app',self.source,self.recipe,self.output,source_commit=revision)
                self.assertEqual(refused.exception.detail,(name,'generated'))
                self.assertFalse(self.output.exists())
                target.unlink();shutil.rmtree(self.source/'.git')

    def test_tracked_gitlink_below_a_copied_tree_is_refused_not_dropped(self):
        self.application_source();revision=self.commit()
        def git(*args):
            return subprocess.check_output(['git','-C',str(self.source),*args],stderr=subprocess.PIPE).decode().strip()
        git('update-index','--add','--cacheinfo','160000,'+revision+',apps/sim/vendor/module')
        git('commit','-qm','fictitious gitlink');(self.source/'apps/sim/vendor/module').mkdir(parents=True)
        self.assertEqual(git('status','--porcelain','--untracked-files=no'),'')
        with self.assertRaisesRegex(ValueError,'^source_refused$') as refused:
            context.prepare('app',self.source,self.recipe,self.output,source_commit=git('rev-parse','HEAD'))
        self.assertEqual(refused.exception.detail,('apps/sim/vendor/module',None))
        self.assertFalse(self.output.exists())

    def test_exclusion_reasons_are_exact_and_paths_not_names(self):
        for path,reason in [('apps/sim/lib/uploads/a.ts',None),('apps/sim/uploads/a.xlsx','runtime-data'),
                            ('apps/realtime/uploads/a.ts',None),('apps/sim/lib/workflows/references/a.ts',None),
                            ('apps/sim/app/(landing)/solutions/engineering/page.tsx',None),
                            ('apps/sim/ee/a.ts','ee'),('packages/x/ee/y/z.ts','ee'),('apps/sim/.next/a.js','generated'),
                            ('apps/sim/lib/cache/a.ts','generated'),('a/__pycache__/b.pyc','generated'),
                            ('a/b.pyc','generated'),('packages/x/certs/a.ts','secret'),('a/b.key','secret'),
                            ('a/b.tar.gz','archive'),('apps/sim/build.log','log'),('apps/sim/.env.example','hidden'),
                            ('apps/sim/app/.well-known/a.ts',None),('apps/sim/app/.well-known/.env','hidden'),
                            ('apps/sim/app/x/.well-known/a.ts','hidden'),
                            ('packages/db/migrations/meta/0001_snapshot.json','migration-snapshot'),
                            # Case-insensitive for EE, secrets, archives and logs (as gate.py for EE);
                            # generated-output names stay exact.
                            ('a/server.PEM','secret'),('k.KEY','secret'),('x.Pfx','secret'),('a/s.Crt','secret'),
                            ('packages/x/Certs/a.ts','secret'),('packages/x/CERTIFICATES/a.ts','secret'),
                            ('b.ZIP','archive'),('b.Tar.GZ','archive'),('b.LOG','log'),
                            ('apps/sim/EE/x.ts','ee'),('packages/x/Ee/y.ts','ee'),
                            ('apps/sim/lib/Cache/a.ts',None),('apps/sim/Dist/a.ts',None)]:
            with self.subTest(path=path):self.assertEqual(context.exclusion(path),reason)

    def restrictive_umask(self):
        """The durable CI sets umask 077 before preparing contexts; restore it afterwards."""
        previous=os.umask(0o077);self.addCleanup(os.umask,previous)

    def private_parent(self):
        """A 0700 parent holding a 0600 secret, as the CI's private directory and compose.env."""
        private=self.root/'private';private.mkdir(mode=0o700)
        secret=private/'compose.env'
        os.close(os.open(secret,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600))
        return private,secret

    def assertContextModes(self,output,executables):
        # Image-readable modes: directories 0755, files 0644 or 0755 exactly as admitted.
        seen={'.':stat.S_IMODE(output.lstat().st_mode)}
        for path in output.rglob('*'):
            self.assertFalse(path.is_symlink(),path)
            seen[path.relative_to(output).as_posix()]=stat.S_IMODE(path.lstat().st_mode)
        wanted={name:(0o755 if name=='.' or (output/name).is_dir() or name in executables else 0o644) for name in seen}
        self.assertEqual(seen,wanted)
        self.assertTrue(set(executables)<=set(seen))

    def test_context_modes_follow_git_not_the_callers_umask(self):
        self.application_source()
        for name in ('packages/db/scripts/run.sh','apps/sim/scripts/tool.sh'):
            target=self.source/name;target.parent.mkdir(parents=True,exist_ok=True)
            target.write_text('#!/bin/sh\n');target.chmod(0o755)
        revision=self.commit()
        # A 100644 file checked out 0600 must still enter the image as 0644.
        (self.source/'packages/db/package.json').chmod(0o600)
        private,secret=self.private_parent();self.restrictive_umask()
        for kind,executables in (('migrations',{'packages/db/scripts/run.sh'}),
                                 ('app',{'packages/db/scripts/run.sh','apps/sim/scripts/tool.sh'}),
                                 ('realtime',{'packages/db/scripts/run.sh','apps/sim/scripts/tool.sh'}),
                                 ('workflow-worker',{'packages/db/scripts/run.sh','apps/sim/scripts/tool.sh'})):
            with self.subTest(kind=kind):
                output=private/kind
                context.prepare(kind,self.source,self.recipe,output,source_commit=revision)
                self.assertContextModes(output,executables)
        self.assertEqual(stat.S_IMODE(private.stat().st_mode),0o700)
        self.assertEqual(stat.S_IMODE(secret.stat().st_mode),0o600)

    def test_cron_assets_and_generated_files_are_image_readable_under_umask_077(self):
        assets=self.root/'assets';(assets/'apk').mkdir(parents=True);(assets/'supercronic-metadata').mkdir()
        binary=b'fictitious supercronic';(assets/'supercronic').write_bytes(binary);(assets/'supercronic').chmod(0o600)
        (assets/'supercronic-metadata/LICENSE').write_text('fixture licence')
        (assets/'apk/fixture-1.0.apk').write_bytes(b'fictitious apk')
        apk_hash=hashlib.sha256(b'fictitious apk').hexdigest()
        (self.recipe/'cron.Dockerfile').write_text('FROM scratch\n')
        (self.recipe/'tests/cron-apk.sha256').write_text(apk_hash+'  fixture-1.0.apk\n')
        (self.source/'deploy/memlia/crontab').write_text('* * * * * true\n')
        (self.source/'docker').mkdir();entry=self.source/'docker/cron-entrypoint.sh'
        entry.write_text('#!/bin/sh\n');entry.chmod(0o755)
        revision=self.commit();private,secret=self.private_parent();self.restrictive_umask()
        with patch.object(context,'SUPERCRONIC_SHA256',hashlib.sha256(binary).hexdigest()):
            context.prepare('cron',self.source,self.recipe,private/'cron',assets,source_commit=revision)
        self.assertContextModes(private/'cron',{'supercronic','cron-entrypoint.sh'})
        self.assertTrue((private/'cron/apk/SHA256SUMS').is_file())
        self.assertEqual(stat.S_IMODE(secret.stat().st_mode),0o600)

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

ROOT = Path(__file__).resolve().parents[4]
SOURCE_SUFFIXES = ('.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs')
ALIAS_IMPORT = re.compile(r'''(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](@/[^'"\s]+)['"]''')
RESOLUTIONS = ('', '.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.json',
               '/index.ts', '/index.tsx', '/index.js', '/index.jsx')


def git_bytes(root, *args, data=None):
    return subprocess.run(['git', '-C', str(root), *args], input=data, capture_output=True, check=True, timeout=120,
        env={'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'GIT_NO_REPLACE_OBJECTS': '1'}).stdout


def tracked_blobs(root, commit):
    """Admitted tree of `commit` (not the working tree): path -> blob id."""
    rows = {}
    for entry in git_bytes(root, 'ls-tree', '-rz', commit).split(b'\0'):
        if entry:
            header, name = entry.split(b'\t', 1)
            rows[name.decode()] = header.split()[2].decode()
    return rows


def application_inventory(paths):
    """Tracked files a web/realtime/worker context must contain, and those it leaves out."""
    roots = context.APPLICATION_TREES
    below = [p for p in paths if any(p.startswith(r + '/') for r in roots)]
    excluded = context.excluded_tracked(below, roots)
    return {p for p in below if p not in excluded}, excluded


def is_test(path):
    parts = path.split('/')
    return (any(p in ('__tests__', '__mocks__') for p in parts) or re.search(r'\.(test|spec)\.[cm]?[jt]sx?$', parts[-1])
            or parts[-1] in ('vitest.config.ts', 'vitest.setup.ts'))


def unresolved_imports(root, blobs, included):
    """`@/x` imports of non-test apps/sim sources (tsconfig `@/*` -> apps/sim/*) absent from the context."""
    sources = sorted(p for p in included if p.startswith('apps/sim/') and p.endswith(SOURCE_SUFFIXES) and not is_test(p))
    output = git_bytes(root, 'cat-file', '--batch', data=''.join(blobs[p] + '\n' for p in sources).encode())
    missing, offset = [], 0
    for path in sources:
        header_end = output.index(b'\n', offset); size = int(output[offset:header_end].split()[2])
        text = output[header_end + 1:header_end + 1 + size].decode('utf-8', 'replace'); offset = header_end + 2 + size
        for specifier in sorted(set(ALIAS_IMPORT.findall(text))):
            target = 'apps/sim/' + specifier[2:]
            if not any(target + suffix in included for suffix in RESOLUTIONS):
                missing.append((path, specifier))
    return sources, missing


class AdmittedRepositoryContextTests(unittest.TestCase):
    """Static proof on the admitted HEAD of the repository holding this file."""
    def setUp(self):
        try:
            self.commit = git_bytes(ROOT, 'rev-parse', 'HEAD').decode().strip()
        except (OSError, subprocess.CalledProcessError):
            self.skipTest('admitted Git repository required')
        self.blobs = tracked_blobs(ROOT, self.commit)
        if not any(p.startswith('apps/sim/') for p in self.blobs):
            self.skipTest('Sim application sources required')
        self.included, self.excluded = application_inventory(self.blobs)

    def test_application_contexts_leave_out_only_tolerated_tracked_files(self):
        refused = {p: r for p, r in self.excluded.items() if r not in context.TOLERATED_EXCLUSIONS}
        self.assertEqual(refused, {})
        self.assertFalse(any(part.lower() == 'ee' for p in self.included for part in p.split('/')))

    def test_no_tracked_well_known_path_is_silently_hidden(self):
        # A new discovery route outside DISCOVERY_SOURCE_DIRS must be reviewed, not dropped.
        hidden = sorted(p for p in self.blobs if '.well-known' in p.split('/') and context.exclusion(p) == 'hidden')
        self.assertEqual(hidden, [])

    def test_every_non_test_sim_alias_import_resolves_inside_the_context(self):
        sources, missing = unresolved_imports(ROOT, self.blobs, self.included)
        self.assertGreater(len(sources), 0)
        self.assertEqual(missing, [])


if __name__ == '__main__':
    unittest.main()
