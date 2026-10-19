"""Prepare a new, narrow build context from an already admitted Sim snapshot.

This is packaging, not source admission or a secret scanner. No dependency
manifest is rewritten; migration SQL and the native runner remain byte-identical.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import tempfile

SUPERCRONIC_SHA256 = 'f1f8585c66de020fef494dd636058f99949d108f569fef00016a1c8b9eb145b3'
EXCLUDED_DIRS = {'node_modules', '__pycache__', 'certs', 'certificates', 'cache', 'dist', 'coverage'}
EXCLUDED_SUFFIXES = ('.pem', '.key', '.crt', '.p12', '.pfx', '.zip', '.tar', '.tar.gz', '.tgz', '.pyc')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def prepare(kind, source, recipes, output, assets=None):
    source, recipes, output = map(Path, (source, recipes, output))
    if output.exists():
        raise FileExistsError(output)
    selected = {}

    def add(origin, destination):
        if origin.is_symlink():
            raise ValueError(f'Symlink forbidden in build inputs: {origin}')
        if origin.is_dir():
            for child in sorted(origin.iterdir()):
                if child.name.startswith('.') or child.name in EXCLUDED_DIRS:
                    continue
                if child.name.endswith(EXCLUDED_SUFFIXES) or child.name.endswith('_snapshot.json'):
                    continue
                add(child, destination / child.name)
        elif origin.is_file():
            selected[destination.as_posix()] = origin
        else:
            raise FileNotFoundError(origin)

    add(recipes / f'{kind}.Dockerfile', Path('Dockerfile'))
    add(source / 'compliance/upstream/sim', Path('licenses/sim'))
    if kind == 'migrations':
        add(recipes / 'tests/bun-LICENSE.md', Path('licenses/bun/LICENSE.md'))
        for required in ('packages/db/scripts/migrate.ts', 'packages/db/migrations/meta/_journal.json'):
            if not (source / required).is_file():
                raise FileNotFoundError(source / required)
        for name in ('package.json', 'bun.lock', 'bunfig.toml', 'patches'):
            add(source / name, Path(name))
        for name in ('db', 'logger', 'utils', 'tsconfig'):
            add(source / 'packages' / name, Path('packages') / name)
    elif kind == 'cron':
        assets = Path(assets) if assets else None
        if assets is None or digest(assets / 'supercronic') != SUPERCRONIC_SHA256:
            raise ValueError('Expected verified Linux arm64 Supercronic v0.2.33')
        add(source / 'docker/cron-entrypoint.sh', Path('cron-entrypoint.sh'))
        add(recipes.parent / 'crontab', Path('crontab'))
        add(assets / 'supercronic', Path('supercronic'))
        add(assets / 'supercronic-metadata', Path('licenses/supercronic'))
        apks = sorted((assets / 'apk').glob('*.apk'))
        if not apks:
            raise ValueError('Offline signed Alpine packages required')
        expected = dict(line.split('  ', 1)[::-1] for line in (recipes / 'tests/cron-apk.sha256').read_text().splitlines())
        actual = {apk.name: digest(apk) for apk in apks}
        if actual != expected:
            raise ValueError('Alpine package set/hashes differ from the reviewed lock')
        for apk in apks:
            add(apk, Path('apk') / apk.name)
    else:
        raise ValueError(kind)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=output.parent, prefix='.context-') as temporary:
        staging = Path(temporary) / 'context'
        staging.mkdir()
        for name, origin in selected.items():
            target = staging / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(origin, target)
        hashes = {name: digest(staging / name) for name in sorted(selected)}
        (staging / 'context-manifest.json').write_text(json.dumps({'kind': kind, 'sha256': hashes}, indent=2) + '\n')
        if kind == 'cron':
            (staging / 'apk/SHA256SUMS').write_text(''.join(f'{hashes[name]}  {Path(name).name}\n' for name in sorted(hashes) if name.startswith('apk/')))
        staging.rename(output)
    return output


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('kind', choices=['migrations', 'cron'])
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--assets', type=Path)
    args = parser.parse_args()
    prepare(args.kind, args.source, Path(__file__).resolve().parents[1], args.output, args.assets)
    print(args.output)
