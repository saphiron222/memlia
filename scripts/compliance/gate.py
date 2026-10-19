#!/usr/bin/env python3
# Copyright 2026 Memlia. All rights reserved.
"""Fail-closed source/publication checks. Reports paths/rules, never secret values."""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import time
import tempfile

HERE = Path(__file__).resolve().parent
CODE = re.compile(r'\.(?:[cm]?[jt]sx?)$')
LICENSE = re.compile(r'^(?:license|licence|copying|notice)(?:[.\-_].*)?$', re.I)
SECRET = re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,}|AKIA[A-Z0-9]{16}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}|xox[baprs]-[A-Za-z0-9-]{20,})\b')
FONT_MAGIC = (b'wOF2', b'wOFF', b'OTTO', b'\x00\x01\x00\x00', b'ttcf')
CONTAINER_MAGIC = (b'PK\x03\x04', b'PK\x05\x06', b'\x1f\x8b', b'7z\xbc\xaf\x27\x1c', b'Rar!')

def digest(content):
    return hashlib.sha256(content).hexdigest()

def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], stderr=subprocess.PIPE, env={**os.environ, 'GIT_NO_LAZY_FETCH': '1', 'GIT_NO_REPLACE_OBJECTS': '1'})

def scan_entry(path, content, policy):
    name = PurePosixPath(path).name
    rules = []
    sha = digest(content)
    if 'ee' in PurePosixPath(path.lower()).parts or re.search(r'(?:season.?sans|s[oö]hne|soehne)', name, re.I):
        rules.append('forbidden-path')
    if sha in policy.get('denied_sha256', {}):
        rules.append('forbidden-content')
    if LICENSE.match(name) and sha not in policy.get('allowed_license_sha256', []):
        rules.append('unreviewed-license')
    if (content.startswith(FONT_MAGIC) or re.search(r'\.(?:woff2?|ttf|otf|eot)$', name, re.I)) and sha not in policy.get('allowed_font_sha256', []):
        rules.append('unreviewed-font')
    if SECRET.search(content) and policy.get('reviewed_secret_fixtures', {}).get(path, {}).get('sha256') != sha:
        rules.append('secret-signature')
    if content.startswith(CONTAINER_MAGIC) or content[257:262] == b'ustar' or re.search(r'\.(?:zip|tgz|gz|tar|7z|rar|asar|dmg|iso)$', name, re.I):
        rules.append('uninspected-container')
    if content.startswith((b'MZ', b'\x7fELF', b'\xcf\xfa\xed\xfe', b'\xfe\xed\xfa\xcf')):
        rules.append('uninspected-executable')
    if name.startswith('.env') and name not in ('.env.example', '.env.sample', '.env.template'):
        rules.append('environment-file')
    return rules

def scan_imports(entries, root, policy=None):
    # A review admits exact loader source only, never generated code or its targets.
    reviews = (policy or {}).get('reviewed_dynamic_imports', [])
    if not isinstance(reviews, list):
        raise ValueError('invalid loader review')
    admitted = set()
    for review in reviews:
        if not isinstance(review, dict):
            raise ValueError('invalid loader review')
        path, sha, lines, reason = (review.get(key) for key in ('path', 'sha256', 'lines', 'reason'))
        if (not isinstance(path, str) or not path or PurePosixPath(path).is_absolute()
                or '..' in PurePosixPath(path).parts or '\\' in path
                or str(PurePosixPath(path)) != path or not CODE.search(path)
                or not isinstance(sha, str) or not re.fullmatch('[a-f0-9]{64}', sha)
                or not isinstance(lines, list) or not lines
                or any(type(line) is not int or line < 1 for line in lines)
                or len(set(lines)) != len(lines)
                or not isinstance(reason, str) or not reason.strip()):
            raise ValueError('invalid loader review')
        for line in lines:
            key = (path, sha, line)
            if key in admitted:
                raise ValueError('duplicate loader review')
            admitted.add(key)
    if not entries:
        return []
    env = os.environ.copy()
    if env.get('MEMLIA_TYPESCRIPT_PATH'):
        parser = Path(env['MEMLIA_TYPESCRIPT_PATH']).resolve()
        if not parser.is_file() or parser.name != 'typescript.js':
            raise ValueError('invalid explicit TypeScript parser path')
        env['NODE_PATH'] = str(parser.parents[3])
    result = subprocess.run(['node', str(HERE / 'imports.mjs')], env=env, input=json.dumps({'root': str(root), 'entries': entries}), text=True, capture_output=True)
    if result.returncode:
        # Do not print parser diagnostics containing source text.
        raise ValueError('TypeScript parser unavailable or configuration invalid; publication blocked')
    hashes = {entry['path']: digest(entry['content'].encode('utf-8')) for entry in entries}
    return [issue for issue in json.loads(result.stdout)
            if issue['rule'] != 'unresolved-module-expression'
            or (issue['path'], hashes.get(issue['path']), issue.get('line')) not in admitted]

def validate_source(root, manifest):
    if git(root, 'remote', 'get-url', 'origin').decode().strip() != manifest['repository']:
        raise ValueError('source origin does not match admitted repository')
    if git(root, 'rev-parse', 'HEAD').decode().strip() != manifest['sha']:
        raise ValueError('source SHA does not match admitted commit')
    if git(root, 'status', '--porcelain', '--untracked-files=all').strip():
        raise ValueError('dirty source; use the reviewed checkout')
    for item in manifest['license_files']:
        if digest(git(root, 'show', f"{manifest['sha']}:{item['path']}")) != item['sha256']:
            raise ValueError('source license digest mismatch')

def tree_entries(root, rev):
    for row in git(root, 'ls-tree', '-rz', '--full-tree', rev).split(b'\0'):
        if not row:
            continue
        metadata, raw_path = row.split(b'\t', 1)
        mode, kind, oid = metadata.decode().split()
        yield raw_path.decode(), mode, kind, oid

def inspect_contents(entries, root, policy):
    issues, modules = [], []
    for path, content in entries:
        issues.extend({'path': path, 'rule': rule} for rule in scan_entry(path, content, policy))
        if CODE.search(path):
            try:
                modules.append({'path': path, 'content': content.decode('utf-8')})
            except UnicodeDecodeError:
                issues.append({'path': path, 'rule': 'invalid-source-encoding'})
        if path.endswith('.map'):
            try:
                sourcemap = json.loads(content)
                if not isinstance(sourcemap, dict) or sourcemap.get('version') != 3 or 'sections' in sourcemap:
                    raise ValueError('unsupported sourcemap structure')
                sources = sourcemap.get('sources')
                contents = sourcemap.get('sourcesContent')
                source_root = sourcemap.get('sourceRoot', '')
                if (not isinstance(sources, list) or not isinstance(contents, list)
                        or not isinstance(sourcemap.get('mappings'), str)
                        or not isinstance(source_root, str)
                        or any(not isinstance(source, str) for source in sources)
                        or len(sources) != len(contents) or any(not isinstance(c, str) for c in contents)):
                    raise ValueError('missing map content')
                for source, text in zip(sources, contents):
                    mapped = f'{path}/sources/{source_root}/{source}'
                    issues.extend({'path': mapped, 'rule': rule} for rule in scan_entry(mapped, text.encode(), policy))
                    if CODE.search(source):
                        modules.append({'path': mapped, 'content': text})
            except (ValueError, TypeError, AttributeError):
                issues.append({'path': path, 'rule': 'uninspected-sourcemap'})
    issues.extend(scan_imports(modules, root, policy))
    return issues

def scan_history(root, policy):
    if os.environ.get('GIT_GRAFT_FILE'):
        raise ValueError('grafted history cannot prove publication safety')
    grafts = Path(git(root, 'rev-parse', '--path-format=absolute', '--git-path', 'info/grafts').decode().strip())
    if grafts.exists() or grafts.is_symlink():
        raise ValueError('grafted history cannot prove publication safety')
    if git(root, 'rev-parse', '--is-shallow-repository').strip() != b'false':
        raise ValueError('shallow history cannot prove publication safety')
    configuration = git(root, 'config', '--local', '--list').decode().splitlines()
    for setting in configuration:
        key, _, value = setting.partition('=')
        if key.lower() == 'extensions.partialclone' or (
                key.lower().startswith('remote.') and key.lower().endswith('.promisor')
                and value.lower() not in ('false', 'no', 'off', '0')):
            raise ValueError('partial clone cannot prove complete history')
    try:
        # A non-shallow repository may still be corrupt or have missing objects.
        # This is read-only and lazy fetching is disabled by git().
        git(root, 'fsck', '--full', '--no-reflogs')
    except subprocess.CalledProcessError as error:
        raise ValueError('incomplete or invalid Git object database') from error
    issues = []
    # Parse each commit with ITS configuration, not today's aliases. Context changes matter
    # even when an importing blob is unchanged, so source parsing is not deduplicated.
    for commit in git(root, 'rev-list', '--all').decode().splitlines():
        entries = []
        with tempfile.TemporaryDirectory(prefix='memlia-history-') as tmp, blob_reader(root) as read:
            snapshot = Path(tmp)
            for path, mode, kind, oid in tree_entries(root, commit):
                if mode not in ('100644', '100755') or kind != 'blob':
                    issues.append({'path': path, 'rule': 'unsupported-git-mode', 'commit': commit})
                    continue
                content = read(oid)
                entries.append((path, content))
                if path.endswith(('.json', '.jsonc')):
                    target = snapshot / path
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(content)
            issues.extend(dict(issue, commit=commit) for issue in inspect_contents(entries, snapshot, policy))
    return issues

def scan_tree(root, policy):
    if not root.is_dir():
        raise ValueError('tree root must be an existing directory')
    def traversal_error(error):
        raise error
    entries, issues = [], []
    for directory, dirs, files in os.walk(root, followlinks=False, onerror=traversal_error):
        # Dependencies are audited as shipped artefacts, not implicitly licensed by this source gate.
        dirs[:] = sorted(d for d in dirs if d not in ('.git', 'node_modules', '__pycache__'))
        for name in list(dirs) + files:
            file = Path(directory) / name
            path = file.relative_to(root).as_posix()
            if path == '.git':
                continue
            if file.is_symlink():
                issues.append({'path': path, 'rule': 'unsupported-git-mode'})
            elif file.is_file():
                entries.append((path, file.read_bytes()))
    return issues + inspect_contents(entries, root, policy)

@contextmanager
def blob_reader(root):
    process = subprocess.Popen(['git', '-C', str(root), 'cat-file', '--batch'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env={**os.environ, 'GIT_NO_LAZY_FETCH': '1', 'GIT_NO_REPLACE_OBJECTS': '1'})
    def read(oid):
        process.stdin.write((oid + '\n').encode())
        process.stdin.flush()
        header = process.stdout.readline().split()
        if len(header) != 3 or header[1] != b'blob':
            raise ValueError('invalid Git blob')
        content = process.stdout.read(int(header[2]))
        if process.stdout.read(1) != b'\n':
            raise ValueError('invalid Git object framing')
        return content
    try:
        yield read
    finally:
        process.stdin.close()
        process.wait()
        process.stdout.close()
        process.stderr.close()


def exclusion(path, policy):
    parts = PurePosixPath(path).parts
    if 'ee' in [p.lower() for p in parts]:
        return 'enterprise'
    if any(p in ('.github', '.husky', '.claude', '.agents', '.cursor') for p in parts) or parts[-1] in ('AGENTS.md', 'CLAUDE.md'):
        return 'upstream-development-automation'
    if parts[0] == 'scripts':
        return 'upstream-development-scripts-review-individually-before-reuse'
    if path in ('README.md', '.gitignore'):
        return 'preserve-product-file'
    if path.startswith(('packages/memlia-contracts/', 'packages/excel-contracts/')):
        return 'integrator-owned'
    if re.search(r'(?:season.?sans|s[oö]hne|soehne)', parts[-1], re.I):
        return 'font-rights-not-established'
    if re.search(r'\.(?:woff2?|ttf|otf|eot)$', path, re.I):
        return 'font-requires-explicit-admission'
    return None


def prepare(root, destination, manifest, policy):
    validate_source(root, manifest)
    if policy.get('source_sha', manifest['sha']) != manifest['sha']:
        raise ValueError('policy source SHA mismatch')
    destination = destination.resolve()
    if destination == root.resolve() or root.resolve() in destination.parents:
        raise ValueError('destination must be outside the reference checkout')
    plan, excluded = [], []
    with blob_reader(root) as read:
        for path, mode, kind, oid in tree_entries(root, manifest['sha']):
            reason = exclusion(path, policy)
            if reason:
                excluded.append({'path': path, 'reason': reason})
                continue
            if mode not in ('100644', '100755') or kind != 'blob':
                raise ValueError(f'unsupported source Git mode: {path}')
            content = read(oid)
            explicit_exclusion = policy.get('excluded_sources', {}).get(path)
            if explicit_exclusion is not None:
                if (explicit_exclusion.get('sha256') != digest(content)
                        or not isinstance(explicit_exclusion.get('reason'), str)
                        or not explicit_exclusion['reason'].strip()):
                    raise ValueError(f'source exclusion changed or invalid: {path}')
                excluded.append({'path': path, 'sha256': digest(content), 'reason': explicit_exclusion['reason']})
                continue
            rules = scan_entry(path, content, policy)
            # Preparation is a source quarantine, not a publication acceptance.
            # Opaque archives/binaries stay excluded pending separate inventory.
            if any(rule in rules for rule in ('uninspected-container', 'uninspected-executable', 'unreviewed-font')):
                excluded.append({'path': path, 'reason': 'opaque-asset-requires-separate-admission', 'sha256': digest(content)})
                continue
            if rules:
                raise ValueError(f'source admission failed: {path}: {",".join(rules)}')
            target_path = 'compliance/upstream/sim/' + path if path in ('LICENSE', 'NOTICE') else path
            target = destination / target_path
            if any(parent.is_symlink() for parent in [target, *target.parents]):
                raise ValueError(f'destination symlink: {target_path}')
            if any(parent.exists() and not parent.is_dir() for parent in target.parents):
                raise ValueError(f'destination parent collision: {target_path}')
            if target.exists() and (not target.is_file() or target.read_bytes() != content):
                raise ValueError(f'destination collision: {target_path}')
            plan.append({'source': path, 'path': target_path, 'blob': oid, 'sha256': digest(content), 'mode': mode})
        # Only start writing once the complete source and every collision were checked.
        for item in plan:
            target = destination / item['path']
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.exists():
                target.write_bytes(read(item['blob']))
                target.chmod(0o755 if item['mode'] == '100755' else 0o644)
    return {'source': manifest['repository'], 'sha': manifest['sha'], 'status': 'prepared-not-publication-approved', 'admitted': plan, 'excluded': excluded}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['tree', 'history', 'source', 'prepare'])
    parser.add_argument('--root', required=True, type=Path)
    parser.add_argument('--policy', type=Path, default=HERE.parent.parent / 'compliance/policy.json')
    parser.add_argument('--manifest', type=Path)
    parser.add_argument('--destination', type=Path)
    parser.add_argument('--inventory', type=Path)
    args = parser.parse_args()
    start = time.monotonic()
    try:
        if args.mode == 'prepare':
            inventory = prepare(args.root, args.destination, json.loads(args.manifest.read_text()), json.loads(args.policy.read_text()))
            args.inventory.write_text(json.dumps(inventory, indent=2) + '\n')
            print(json.dumps({'prepared': len(inventory['admitted']), 'excluded': len(inventory['excluded']), 'duration_seconds': round(time.monotonic() - start, 3)}))
            return 0
        if args.mode == 'source':
            validate_source(args.root, json.loads(args.manifest.read_text()))
            issues = []
        else:
            policy = json.loads(args.policy.read_text())
            issues = (scan_tree if args.mode == 'tree' else scan_history)(args.root.resolve(), policy)
        print(json.dumps({'mode': args.mode, 'passed': not issues, 'duration_seconds': round(time.monotonic() - start, 3), 'issues': issues}, indent=2))
        return 1 if issues else 0
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(json.dumps({'passed': False, 'error': str(error) if isinstance(error, ValueError) else type(error).__name__}))
        return 2

if __name__ == '__main__':
    sys.exit(main())
