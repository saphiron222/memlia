#!/usr/bin/env python3
# Copyright 2026 Memlia. All rights reserved.
"""Require exact Sim attribution texts in the candidate or every published commit."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

REQUIRED = {
    'compliance/upstream/sim/LICENSE': 'b13f17c74ba17a5cc136e624fd6f78d75124f2b038a25f0b7eba48a1ca00c0ec',
    'compliance/upstream/sim/NOTICE': 'f7c2fd75ef8745b6f966111bbeb1b592649aaae081ed4d689bd3d6f8571786b7',
}
NEUTRAL = {'README.md', '.gitignore'}


def git(root, *arguments):
    return subprocess.check_output(['git', '-C', str(root), *arguments], stderr=subprocess.PIPE,
        env={**os.environ, 'GIT_NO_REPLACE_OBJECTS': '1', 'GIT_NO_LAZY_FETCH': '1'})


def check_tree(root):
    for path, expected in REQUIRED.items():
        file = root / path
        if any(part.is_symlink() for part in (file, *file.parents)) or not file.is_file():
            raise ValueError('required-upstream-text-unavailable')
        if hashlib.sha256(file.read_bytes()).hexdigest() != expected:
            raise ValueError('required-upstream-text-changed')


def check_history(root):
    if os.environ.get('GIT_GRAFT_FILE'):
        raise ValueError('grafted-history')
    graft = Path(git(root, 'rev-parse', '--path-format=absolute', '--git-path', 'info/grafts').decode().strip())
    if graft.exists() or graft.is_symlink():
        raise ValueError('grafted-history')
    if git(root, 'rev-parse', '--is-shallow-repository').strip() != b'false':
        raise ValueError('shallow-history')
    for row in git(root, 'config', '--local', '--list').decode().splitlines():
        key, _, value = row.partition('=')
        if key.lower() == 'extensions.partialclone' or (key.lower().startswith('remote.')
                and key.lower().endswith('.promisor') and value.lower() not in ('false', 'no', 'off', '0')):
            raise ValueError('partial-history')
    git(root, 'fsck', '--full', '--no-reflogs')
    commits = git(root, 'rev-list', '--all').decode().splitlines()
    if not commits:
        raise ValueError('empty-history')
    for commit in commits:
        entries = {}
        for row in git(root, 'ls-tree', '-rz', '--full-tree', commit).split(b'\0'):
            if row:
                metadata, path = row.split(b'\t', 1)
                entries[path.decode()] = metadata.decode().split()
        if set(entries) <= NEUTRAL:
            continue
        for path, expected in REQUIRED.items():
            entry = entries.get(path)
            if not entry or entry[0] not in ('100644', '100755') or entry[1] != 'blob':
                raise ValueError('required-historical-text-unavailable')
            if hashlib.sha256(git(root, 'cat-file', 'blob', entry[2])).hexdigest() != expected:
                raise ValueError('required-historical-text-changed')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--history', action='store_true', help='Inspect all committed refs; allow only neutral README/.gitignore snapshots without notices')
    args = parser.parse_args()
    try:
        if args.root.is_symlink() or not args.root.is_dir():
            raise ValueError('invalid-root')
        root = args.root.resolve()
        (check_history if args.history else check_tree)(root)
        print(json.dumps({'passed': True, 'mode': 'history' if args.history else 'tree'}))
        return 0
    except (OSError, ValueError, subprocess.SubprocessError):
        # No Git diagnostics or file contents: they may contain private data.
        print(json.dumps({'passed': False, 'error': 'upstream-notices-check-failed'}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
