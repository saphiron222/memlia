#!/usr/bin/env python3
# Copyright 2026 Memlia. All rights reserved.
"""Classify fresh Gitleaks reports against exact reviewed blobs, never skip scanning."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys


def digest(content):
    return hashlib.sha256(content).hexdigest()


def review_index(review):
    if not isinstance(review, dict) or review.get('scanner') != 'gitleaks' or review.get('version') != '8.30.1' or not isinstance(review.get('findings'), list):
        raise ValueError('unsupported review policy')
    admitted, paths = set(), {}
    for entry in review['findings']:
        if not isinstance(entry, dict):
            raise ValueError('invalid reviewed finding')
        path, sha, rule, line, reason = (entry.get(key) for key in ('path', 'sha256', 'rule', 'line', 'reason'))
        if (not isinstance(path, str) or not path or PurePosixPath(path).is_absolute()
                or '..' in PurePosixPath(path).parts or '\\' in path
                or not isinstance(sha, str) or not re.fullmatch('[a-f0-9]{64}', sha)
                or not isinstance(rule, str) or not rule
                or type(line) is not int or line < 1
                or not isinstance(reason, str) or not reason.strip()):
            raise ValueError('review requires safe path, hash, rule, line and reason')
        key = (path, rule, line)
        if key in admitted or (path in paths and paths[path] != sha):
            raise ValueError('duplicate or conflicting reviewed finding')
        admitted.add(key)
        paths[path] = sha
    return admitted, paths


def review_findings(root, report, review):
    root = root.resolve()
    if not root.is_dir() or not isinstance(report, list):
        raise ValueError('existing source directory and Gitleaks report array required')
    admitted, paths = review_index(review)
    issues = []
    for path, sha in paths.items():
        file = root / path
        if any(part.is_symlink() for part in [file, *file.parents]) or not file.is_file():
            issues.append({'path': path, 'rule': 'reviewed-file-unavailable'})
        elif digest(file.read_bytes()) != sha:
            issues.append({'path': path, 'rule': 'reviewed-blob-changed'})
    observed = set()
    for finding in report:
        if not isinstance(finding, dict) or finding.get('Commit'):
            raise ValueError('directory report required; history needs commit-specific blob verification')
        path, rule, line = (finding.get(key) for key in ('File', 'RuleID', 'StartLine'))
        if not isinstance(path, str) or not isinstance(rule, str) or type(line) is not int or line < 1:
            raise ValueError('invalid Gitleaks finding')
        if Path(path).is_absolute():
            try:
                path = Path(path).resolve().relative_to(root).as_posix()
            except ValueError:
                issues.append({'rule': 'finding-outside-reviewed-root'})
                continue
        observed.add((path, rule, line))
        if (path, rule, line) not in admitted:
            issues.append({'path': path, 'rule': 'unreviewed-gitleaks-finding', 'scanner_rule': rule, 'line': line})
    for path, rule, line in sorted(admitted - observed):
        issues.append({'path': path, 'rule': 'expected-gitleaks-finding-missing', 'scanner_rule': rule, 'line': line})
    return issues


def review_repository_findings(root, report, review):
    """A product checkout may omit upstream fixtures; present fixtures stay exact."""
    root = root.resolve()
    review_index(review)
    present = []
    for entry in review['findings']:
        file = root / entry['path']
        if file.exists() or any(part.is_symlink() for part in [file, *file.parents]):
            present.append(entry)
    return review_findings(root, report, {**review, 'findings': present})


def review_history_findings(root, report, review):
    """Authorize each finding using commit:path bytes, never the current file."""
    root = root.resolve()
    if not root.is_dir() or not isinstance(report, list):
        raise ValueError('existing repository and Gitleaks report array required')
    admitted, paths = review_index(review)
    issues, blobs = [], {}
    for finding in report:
        if not isinstance(finding, dict):
            raise ValueError('invalid Gitleaks finding')
        path, rule, line, commit = (finding.get(key) for key in ('File', 'RuleID', 'StartLine', 'Commit'))
        if (not isinstance(path, str) or not path or PurePosixPath(path).is_absolute()
                or '..' in PurePosixPath(path).parts or '\\' in path
                or str(PurePosixPath(path)) != path
                or not isinstance(rule, str) or not rule
                or type(line) is not int or line < 1
                or not isinstance(commit, str) or not re.fullmatch('[a-f0-9]{40}', commit)):
            raise ValueError('history requires exact commit, safe path, rule and line')
        if (path, rule, line) not in admitted:
            issues.append({'path': path, 'commit': commit, 'rule': 'unreviewed-gitleaks-finding', 'scanner_rule': rule, 'line': line})
            continue
        key = (commit, path)
        if key not in blobs:
            env = {**os.environ, 'GIT_NO_REPLACE_OBJECTS': '1', 'GIT_NO_LAZY_FETCH': '1'}
            kind = subprocess.run(['git', '-C', str(root), 'cat-file', '-t', commit],
                                  capture_output=True, env=env)
            if kind.returncode or kind.stdout.strip() != b'commit':
                blobs[key] = None
            else:
                content = subprocess.run(['git', '-C', str(root), 'cat-file', 'blob', f'{commit}:{path}'],
                                         capture_output=True, env=env)
                blobs[key] = digest(content.stdout) if content.returncode == 0 else None
        if blobs[key] != paths[path]:
            issues.append({'path': path, 'commit': commit, 'rule': 'reviewed-historical-blob-unavailable-or-changed'})
    return issues


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--review', type=Path, required=True)
    parser.add_argument('--mode', choices=('source', 'repository', 'history'), default='source')
    args = parser.parse_args()
    try:
        classify = {'source': review_findings, 'repository': review_repository_findings,
                    'history': review_history_findings}[args.mode]
        issues = classify(args.root, json.loads(args.report.read_text()), json.loads(args.review.read_text()))
        print(json.dumps({'classification_passed': not issues, 'issues': issues}, ensure_ascii=False, indent=2))
        return 1 if issues else 0
    except (ValueError, OSError):
        # Never echo report content or credential values from malformed input.
        print(json.dumps({'classification_passed': False, 'error': 'source or report unavailable, malformed or unsupported'}))
        return 2


if __name__ == '__main__':
    sys.exit(main())
