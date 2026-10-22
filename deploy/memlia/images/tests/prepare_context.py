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
import re
import subprocess
import os
import stat

SUPERCRONIC_SHA256 = 'f1f8585c66de020fef494dd636058f99949d108f569fef00016a1c8b9eb145b3'
# Directory names excluded at any depth: EE code (licence), generated outputs and
# caches, certificate stores. None of them names a Sim source module.
EE_DIRS = {'ee'}
GENERATED_DIRS = {'.next', '.turbo', '.cache', 'node_modules', '__pycache__', 'cache', 'dist', 'coverage'}
SECRET_DIRS = {'certs', 'certificates'}
SECRET_SUFFIXES = ('.pem', '.key', '.crt', '.p12', '.pfx')
ARCHIVE_SUFFIXES = ('.zip', '.tar', '.tar.gz', '.tgz')
LOG_SUFFIXES = ('.log',)
# Runtime stores, excluded by exact repository path only: `uploads`, `references`
# or `engineering` are also real source modules (apps/sim/lib/uploads, ...).
RUNTIME_DATA_PATHS = {'apps/sim/uploads'}
# Public discovery routes/assets are source inputs, despite their dot-prefixed
# directory. Only these reviewed locations pass the usual Git/byte verification.
DISCOVERY_SOURCE_DIRS = {
    'apps/sim/app/.well-known',
    'apps/sim/app/api/auth/.well-known',
    'apps/sim/app/api/mcp/copilot/.well-known',
    'apps/sim/public/.well-known',
}
# Trees copied whole for the web, realtime and workflow-worker contexts.
APPLICATION_TREES = ('patches', 'packages', 'apps', 'compliance/upstream')
# Tracked files that may stay out of a copied tree; any other exclusion of a
# tracked file (e.g. source below a `dist` or `cache` name) refuses the context.
TOLERATED_EXCLUSIONS = {'ee', 'runtime-data', 'secret', 'archive', 'log', 'hidden', 'migration-snapshot'}


def exclusion(relative):
    """Why a source-relative POSIX path stays out of a context, or None."""
    parts = relative.split('/')
    for index, name in enumerate(parts):
        prefix = '/'.join(parts[:index + 1])
        folded = name.lower()  # EE, secrets, archives, logs: any case (as the EE gate)
        if folded in EE_DIRS:
            return 'ee'
        if prefix in RUNTIME_DATA_PATHS:
            return 'runtime-data'
        if name in GENERATED_DIRS or name.endswith('.pyc'):
            return 'generated'
        if folded in SECRET_DIRS or folded.endswith(SECRET_SUFFIXES):
            return 'secret'
        if folded.endswith(ARCHIVE_SUFFIXES):
            return 'archive'
        if folded.endswith(LOG_SUFFIXES):
            return 'log'
        if name.startswith('.') and prefix not in DISCOVERY_SOURCE_DIRS:
            return 'hidden'
    return 'migration-snapshot' if parts[-1].endswith('_snapshot.json') else None


def refused(code, path, reason):
    """Closed error code for callers; the offending path and reason ride along as `detail`."""
    error = ValueError(code)
    error.detail = (path, reason)
    return error


def below(path, roots):
    """True when a source-relative path lies inside one of the `roots` directories."""
    parts = path.split('/')
    return any('/'.join(parts[:index]) in roots for index in range(1, len(parts)))


def excluded_tracked(paths, roots):
    """Tracked paths below a copied root that stay out, with their reason."""
    return {path: exclusion(path) for path in paths if below(path, roots) and exclusion(path) is not None}


# Verified cron assets (not in Git) that the image executes.
EXECUTABLE_ASSETS = {'supercronic'}


def image_modes(staging, executables):
    """Give every context entry the mode its image needs, whatever the caller's umask.

    Directories 0755; files 0755 when admitted executable (Git 100755 or a verified
    executable asset), else 0644. Docker COPY keeps these modes in the image.
    """
    for path in [staging, *sorted(staging.rglob('*'))]:
        if path.is_symlink():
            raise ValueError('mode_refused')
        wanted = 0o755 if path.is_dir() or path.relative_to(staging).as_posix() in executables else 0o644
        os.chmod(path, wanted)
        if stat.S_IMODE(os.lstat(path).st_mode) != wanted:
            raise ValueError('mode_refused')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_provenance(destination, source_commit, lock_bytes):
    """Call only after checking source bytes against the admitted Git snapshot."""
    if not isinstance(source_commit,str) or not re.fullmatch(r'[a-f0-9]{40}',source_commit):
        raise ValueError('source_refused')
    target=Path(destination)/'build-provenance'
    target.mkdir()
    lock=hashlib.sha256(lock_bytes).hexdigest()
    for name,data in [('source',(source_commit+'\n').encode()),('lock',(lock+'\n').encode()),('bun.lock',lock_bytes)]:
        with (target/name).open('xb') as stream:stream.write(data)
    return lock


def prepare(kind, source, recipes, output, assets=None, *, source_commit, architecture='arm64'):
    source, recipes, output = map(Path, (source, recipes, output))
    if architecture not in ('arm64','amd64'):raise ValueError('architecture_refused')
    if output.exists() or output.is_symlink():
        raise FileExistsError(output)
    if not isinstance(source_commit,str) or not re.fullmatch(r'[a-f0-9]{40}',source_commit):
        raise ValueError('source_refused')
    def git(*args):
        return subprocess.check_output(['git','-C',str(source),*args],stderr=subprocess.PIPE,timeout=30,
            env={'PATH':os.environ.get('PATH','/usr/bin:/bin'),'GIT_NO_REPLACE_OBJECTS':'1','GIT_NO_LAZY_FETCH':'1'})
    def stable():
        if git('rev-parse','HEAD').decode().strip()!=source_commit or git('status','--porcelain','--untracked-files=no').strip():
            raise ValueError('source_refused')
    stable()
    inventory={}
    for entry in git('ls-tree','-rz',source_commit).split(b'\0'):
        if entry:
            header,name=entry.split(b'\t');mode,kind_,oid=header.split();inventory[name.decode()]=(mode,kind_,oid)
    selected = {}
    expected = {}
    walked = set()
    def verified(origin):
        relative=origin.relative_to(source).as_posix()
        row=inventory.get(relative)
        # Refuse an unadmitted path before reading any of its bytes.
        if row is None or row[0] not in (b'100644',b'100755') or row[1]!=b'blob':
            raise ValueError('source_refused')
        data=origin.read_bytes()
        oid=hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest().encode()
        if row[2]!=oid:
            raise ValueError('source_refused')
        return hashlib.sha256(data).hexdigest()

    def add(origin, destination):
        if origin.is_symlink():
            raise ValueError(f'Symlink forbidden in build inputs: {origin}')
        if origin.is_dir():
            inside=origin.is_relative_to(source)
            if inside: walked.add(origin.relative_to(source).as_posix())
            for child in sorted(origin.iterdir()):
                if exclusion(child.relative_to(source).as_posix() if inside else child.name) is not None:
                    continue
                add(child, destination / child.name)
        elif origin.is_file():
            selected[destination.as_posix()] = origin
            if origin.is_relative_to(source): expected[destination.as_posix()] = verified(origin)
        else:
            raise FileNotFoundError(origin)

    if not recipes.is_relative_to(source):raise ValueError('source_refused')
    recipe=source/'docker'/f'{kind}.Dockerfile' if kind in ('app','realtime') else recipes/f'{kind}.Dockerfile'
    add(recipe, Path('Dockerfile'))
    lock_path=source/'bun.lock'
    if lock_path.is_symlink():raise ValueError('source_refused')
    lock_hash=verified(lock_path);lock_bytes=lock_path.read_bytes()
    if hashlib.sha256(lock_bytes).hexdigest()!=lock_hash:raise ValueError('source_refused')
    add(source / 'compliance/upstream/sim', Path('licenses/sim'))
    if kind == 'migrations':
        add(recipes / 'tests/bun-LICENSE.md', Path('licenses/bun/LICENSE.md'))
        add(source / 'deploy/memlia/database-bootstrap.ts', Path('deploy/memlia/database-bootstrap.ts'))
        for required in ('packages/db/scripts/migrate.ts', 'packages/db/migrations/meta/_journal.json'):
            if not (source / required).is_file():
                raise FileNotFoundError(source / required)
        for name in ('package.json', 'bun.lock', 'bunfig.toml', 'patches'):
            add(source / name, Path(name))
        for name in ('db', 'logger', 'utils', 'tsconfig'):
            add(source / 'packages' / name, Path('packages') / name)
    elif kind in ('app','realtime','workflow-worker'):
        for name in ('package.json','bun.lock','bunfig.toml',*APPLICATION_TREES):
            add(source/name,Path(name))
        if kind in ('app','realtime'):add(source/'turbo.json',Path('turbo.json'))
        if kind=='workflow-worker':
            add(recipes/'tests/bun-LICENSE.md',Path('deploy/memlia/images/tests/bun-LICENSE.md'))
    elif kind == 'cron':
        add(lock_path,Path('bun.lock'))
        assets = Path(assets) if assets else None
        binary_hash=SUPERCRONIC_SHA256 if architecture=='arm64' else 'feefa310da569c81b99e1027b86b27b51e6ee9ab647747b49099645120cfc671'
        if assets is None or digest(assets / 'supercronic') != binary_hash:
            raise ValueError('Expected verified Supercronic v0.2.33 for selected architecture')
        add(source / 'docker/cron-entrypoint.sh', Path('cron-entrypoint.sh'))
        add(recipes.parent / 'crontab', Path('crontab'))
        add(assets / 'supercronic', Path('supercronic'))
        add(assets / 'supercronic-metadata', Path('licenses/supercronic'))
        apks = sorted((assets / 'apk').glob('*.apk'))
        if not apks:
            raise ValueError('Offline signed Alpine packages required')
        apk_lock=recipes/'tests'/('cron-apk.sha256' if architecture=='arm64' else 'cron-apk-amd64.sha256')
        verified(apk_lock)
        expected_apks = dict(line.split('  ', 1)[::-1] for line in apk_lock.read_text().splitlines())
        actual = {apk.name: digest(apk) for apk in apks}
        if actual != expected_apks:
            raise ValueError('Alpine package set/hashes differ from the reviewed lock')
        for apk in apks:
            add(apk, Path('apk') / apk.name)
    else:
        raise ValueError(kind)
    # Every tracked file below a walked directory is copied or left out for a
    # tolerated reason: no source is ever dropped silently (gitlinks included).
    copied={origin.relative_to(source).as_posix() for origin in selected.values() if origin.is_relative_to(source)}
    left_out=excluded_tracked(inventory,walked)
    for path,reason in sorted(left_out.items()):
        if reason not in TOLERATED_EXCLUSIONS:raise refused('source_refused',path,reason)
    for path in sorted(inventory):
        if path not in copied and path not in left_out and below(path,walked):
            raise refused('source_refused',path,None)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=output.parent, prefix='.context-') as temporary:
        staging = Path(temporary) / 'context'
        staging.mkdir()
        for name, origin in selected.items():
            target = staging / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(origin, target)
        hashes = {name: digest(staging / name) for name in sorted(selected)}
        if any(hashes[name]!=value for name,value in expected.items()) or digest(lock_path)!=lock_hash:
            raise ValueError('source_refused')
        stable()
        write_provenance(staging,source_commit,lock_bytes)
        if kind=='cron':(staging/'build-provenance/architecture').write_text(architecture+'\n')
        for child in (staging/'build-provenance').iterdir():hashes[child.relative_to(staging).as_posix()]=digest(child)
        (staging / 'context-manifest.json').write_text(json.dumps({'kind': kind, 'sourceCommit': source_commit, 'lockSha256': lock_hash, 'sha256': hashes}, indent=2) + '\n')
        if kind == 'cron':
            (staging / 'apk/SHA256SUMS').write_text(''.join(f'{hashes[name]}  {Path(name).name}\n' for name in sorted(hashes) if name.startswith('apk/')))
        image_modes(staging, {name for name, origin in selected.items()
                              if (inventory[origin.relative_to(source).as_posix()][0] == b'100755'
                                  if origin.is_relative_to(source) else name in EXECUTABLE_ASSETS)})
        staging.rename(output)
    return output


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('kind', choices=['app','realtime','migrations','cron','workflow-worker'])
    parser.add_argument('--source', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--assets', type=Path)
    parser.add_argument('--source-commit', required=True)
    parser.add_argument('--architecture',choices=['arm64','amd64'],default='arm64')
    args = parser.parse_args()
    prepare(args.kind, args.source, Path(__file__).resolve().parents[1], args.output, args.assets, source_commit=args.source_commit, architecture=args.architecture)
    print(args.output)
