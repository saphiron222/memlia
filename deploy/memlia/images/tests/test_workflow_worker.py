# Copyright (c) 2026 Memlia. All rights reserved.
"""Exercise the image's actual argv with native Bun; no Docker or database.

The tiny worker is a launch fixture, not a substitute for the product worker.
An image build and native pg-boss/isolated-vm tests remain separate gates.
"""
import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import tempfile
import unittest


RECIPE = Path(__file__).resolve().parents[1] / 'workflow-worker.Dockerfile'
BUN = os.environ.get('MEMLIA_TEST_BUN')


class WorkerLaunchTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(RECIPE.is_file(), 'The existing durable worker has no image recipe')
        recipe = RECIPE.read_text().splitlines()
        commands = [json.loads(line[4:]) for line in recipe
                    if line.startswith('CMD ')]
        self.assertEqual(len(commands), 1, 'One direct, exec-form worker command is required')
        self.assertEqual(commands[0][0], 'bun')
        if not BUN:
            self.skipTest('Set MEMLIA_TEST_BUN to the existing Bun 1.4.2 binary')
        self.assertEqual(subprocess.check_output([BUN, '--version'], text=True, timeout=5).strip(),
                         '1.4.2')
        self.command = [BUN, *commands[0][1:]]
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.app = root / 'app/apps/sim'
        workdirs = [line[8:].strip() for line in recipe if line.startswith('WORKDIR ')]
        self.assertTrue(workdirs and workdirs[-1].startswith('/'))
        self.cwd = root / workdirs[-1].lstrip('/')
        (self.app / 'scripts').mkdir(parents=True)
        (self.app / 'lib').mkdir()
        (self.app / 'tsconfig.json').write_text(json.dumps({
            'compilerOptions': {'paths': {'@/*': ['./*']}}
        }))
        (self.app / 'lib/value.ts').write_text('export const appValue = 37\n')
        package = root / 'app/packages/probe'
        (package / 'src').mkdir(parents=True)
        (package / 'package.json').write_text(json.dumps({
            'name': '@memlia-fixture/probe',
            'exports': {'./value': {'default': './src/value.ts'}}
        }))
        (package / 'src/value.ts').write_text('export const packageValue = 5\n')
        modules = root / 'app/node_modules/@memlia-fixture'
        modules.mkdir(parents=True)
        (modules / 'probe').symlink_to(package, target_is_directory=True)
        self.worker = self.app / 'scripts/memlia-workflow-worker.ts'
        self.environment = {'PATH': os.environ.get('PATH', ''), 'NODE_ENV': 'production'}

    def run_worker(self, code):
        self.worker.write_text(code)
        self.assertTrue(self.cwd.is_dir(), 'Image WORKDIR does not contain the native app')
        return subprocess.run(self.command, cwd=self.cwd, env=self.environment,
                              text=True, capture_output=True, timeout=8)

    def test_native_command_resolves_app_and_workspace_typescript(self):
        # Missing tsconfig/cwd/workspaces must break the consumed image command.
        result = self.run_worker("""
import { appValue } from '@/lib/value'
import { packageValue } from '@memlia-fixture/probe/value'
console.log(JSON.stringify({ value: appValue + packageValue, runtime: Bun.version }))
""")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {'value': 42, 'runtime': '1.4.2'})

    def test_native_command_does_not_load_repository_or_app_env_files(self):
        for directory in (self.app, self.app.parents[1]):
            (directory / '.env').write_text('MEMLIA_IMAGE_FIXTURE_SECRET=FICTITIOUS_DO_NOT_LOAD\n')
        result = self.run_worker("console.log(JSON.stringify({ loaded: process.env.MEMLIA_IMAGE_FIXTURE_SECRET !== undefined }))")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {'loaded': False})

    def test_native_worker_start_failure_is_a_nonzero_process_exit(self):
        result = self.run_worker("throw new Error('FICTITIOUS_WORKER_START_FAILURE')")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('FICTITIOUS_WORKER_START_FAILURE', result.stderr)

    def test_direct_command_receives_sigterm_and_can_finish_drain(self):
        # A shell launcher swallowing SIGTERM would fail this process boundary.
        self.worker.write_text("""
process.once('SIGTERM', () => { console.log('drained'); process.exit(0) })
setInterval(() => {}, 1000)
console.log('ready')
""")
        self.assertTrue(self.cwd.is_dir(), 'Image WORKDIR does not contain the native app')
        with subprocess.Popen(self.command, cwd=self.cwd, env=self.environment,
                              text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as child:
            try:
                with selectors.DefaultSelector() as selected:
                    selected.register(child.stdout, selectors.EVENT_READ)
                    self.assertTrue(selected.select(timeout=5), 'Native launch did not become ready')
                    self.assertEqual(child.stdout.readline().strip(), 'ready')
                child.send_signal(signal.SIGTERM)
                stdout, stderr = child.communicate(timeout=5)
                self.assertEqual(child.returncode, 0, stderr)
                self.assertEqual(stdout.strip(), 'drained')
            finally:
                if child.poll() is None:
                    child.kill()
                    child.communicate(timeout=2)


if __name__ == '__main__':
    unittest.main()
