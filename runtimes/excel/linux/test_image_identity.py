# Copyright (c) 2026 Memlia. All rights reserved.
"""Pinned image identity under both Docker stores; real registry manifests, no daemon."""
from copy import deepcopy
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

import image_identity as i

FIXTURES = Path(__file__).with_name('fixtures')
# Pins of qualification.py and scripts/ci/workflow-worker-image.py; the fixture files are
# the exact registry bytes of these manifests (their sha256 is the pinned digest).
PYTHON = ('python@sha256:2ed6491b93cd49272ee6de2b5a38440c3448360322c089fc23e370722d74179d',
          'sha256:4f228bc1cbcfc794e4878312cfc241d368eff55a21c08d1e2bb263116c4ef524',
          FIXTURES/'python-3.12.15-slim-bookworm-amd64.manifest.json')
BUILDKIT = ('moby/buildkit@sha256:ca9db05302dc3a4846e3401ecfbd27e349fcc614ab046a7d89a83b0a5c313cee',
            'sha256:4a177e10126688bb9608de9661b5c2204222e232d261339ff4c94eb785b211fa',
            FIXTURES/'moby-buildkit-v0.27.0-amd64.manifest.json')
OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json'


def manifest_of(pin):
    return pin[0].split('@')[1]


def classic_row(pin):
    # `docker image inspect` with the classic store (GitHub runner): Id is the config digest,
    # no Descriptor field.
    return {'Id': pin[1], 'Os': 'linux', 'Architecture': 'amd64', 'RepoDigests': [pin[0]]}


def containerd_row(pin):
    # Docker 29.9.2, io.containerd.snapshotter.v1 (build VM): Id is the pulled manifest
    # digest and Descriptor names that manifest.
    digest = manifest_of(pin)
    return {'Id': digest, 'Os': 'linux', 'Architecture': 'amd64', 'RepoDigests': [pin[0]],
            'Descriptor': {'mediaType': OCI_MANIFEST, 'digest': digest, 'size': pin[2].stat().st_size}}


def archive(folder, members):
    """OCI layout written by `docker image save`: index.json, oci-layout, blobs/sha256/<hex>."""
    path = Path(folder)/'saved.tar'
    with tarfile.open(path, 'w') as tar:
        for name, data in members:
            info = tarfile.TarInfo(name)
            if data is None: info.type = tarfile.DIRTYPE
            elif isinstance(data, str): info.type = tarfile.SYMTYPE; info.linkname = data
            else: info.size = len(data)
            tar.addfile(info, None if not isinstance(data, bytes) else io.BytesIO(data))
    return path


REAL_NAMES = json.loads((FIXTURES/'docker29-containerd-save-member-names.json').read_bytes())


def saved_members(pin):
    """Exact member names of the real VM archive; only the manifest blob carries real bytes."""
    names = REAL_NAMES['python' if pin is PYTHON else 'buildkit']; digest = manifest_of(pin)
    raw = pin[2].read_bytes(); members = []
    for name in names:
        if name in ('blobs', 'blobs/sha256'): members.append((name, None))
        elif name == 'blobs/sha256/'+digest[7:]: members.append((name, raw))
        else: members.append((name, b'{}'))
    return members


class FixtureTests(unittest.TestCase):
    def test_fixtures_are_the_pinned_manifests_and_name_the_pinned_configs(self):
        for pin in (PYTHON, BUILDKIT):
            raw = pin[2].read_bytes()
            self.assertEqual(i.digest(raw), manifest_of(pin))
            self.assertEqual(json.loads(raw)['config']['digest'], pin[1])


class AdmitTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(); self.addCleanup(self.folder.cleanup)
        self.saves = []

    def save(self, members):
        def run():
            self.saves.append(1); return archive(self.folder.name, members)
        return run

    def test_classic_store_admits_the_exact_config_id_without_reading_any_archive(self):
        for pin in (PYTHON, BUILDKIT):
            with self.subTest(pin=pin[0]):
                self.assertEqual(i.admit(classic_row(pin), pin[0], pin[1], self.save([])), pin[1])
        self.assertEqual(self.saves, [])

    def test_containerd_store_admits_the_pinned_manifest_whose_saved_bytes_name_the_config(self):
        for pin in (PYTHON, BUILDKIT):
            with self.subTest(pin=pin[0]):
                self.assertEqual(i.admit(containerd_row(pin), pin[0], pin[1], self.save(saved_members(pin))),
                                 manifest_of(pin))
            row = containerd_row(pin); row.pop('Descriptor')
            with self.subTest(pin=pin[0], descriptor='absent'):
                self.assertEqual(i.admit(row, pin[0], pin[1], self.save(saved_members(pin))), manifest_of(pin))
        self.assertEqual(len(self.saves), 4)

    def test_any_other_identity_is_refused(self):
        other = 'sha256:'+'0'*64
        cases = {
            'other-id': (dict(classic_row(PYTHON), Id=other), PYTHON),
            'absent-id': ({k: v for k, v in classic_row(PYTHON).items() if k != 'Id'}, PYTHON),
            'other-manifest': (containerd_row(BUILDKIT), PYTHON),
            'classic-with-descriptor': (dict(classic_row(PYTHON), Descriptor=containerd_row(PYTHON)['Descriptor']), PYTHON),
            'descriptor-other-digest': (deepcopy(containerd_row(PYTHON)), PYTHON),
            'descriptor-not-dict': (dict(containerd_row(PYTHON), Descriptor=manifest_of(PYTHON)), PYTHON),
            'not-a-row': ([classic_row(PYTHON)], PYTHON),
        }
        cases['descriptor-other-digest'][0]['Descriptor']['digest'] = other
        for name, (row, pin) in cases.items():
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'image_identity_refused'):
                i.admit(row, pin[0], pin[1], self.save(saved_members(PYTHON)))

    def test_image_pulled_by_index_has_its_own_closed_refusal_code(self):
        for media in ('application/vnd.oci.image.index.v1+json',
                      'application/vnd.docker.distribution.manifest.list.v2+json'):
            row = containerd_row(PYTHON); row['Id'] = row['Descriptor']['digest'] = 'sha256:'+'1'*64
            row['Descriptor']['mediaType'] = media
            with self.subTest(media=media), self.assertRaisesRegex(ValueError, '^image_identity_index_refused$'):
                i.admit(row, PYTHON[0], PYTHON[1], self.save(saved_members(PYTHON)))
        self.assertEqual(self.saves, [])

    def test_archive_member_count_is_bounded(self):
        original = i.MAX_MEMBERS; members = saved_members(PYTHON)
        i.MAX_MEMBERS = len(members)-1
        try:
            with self.assertRaisesRegex(ValueError, 'image_identity_refused'):
                i.admit(containerd_row(PYTHON), PYTHON[0], PYTHON[1], self.save(members))
        finally: i.MAX_MEMBERS = original
        i.admit(containerd_row(PYTHON), PYTHON[0], PYTHON[1], self.save(members))

    def test_member_names_match_the_real_docker29_containerd_archives(self):
        for pin, key in ((PYTHON, 'python'), (BUILDKIT, 'buildkit')):
            path = archive(self.folder.name, saved_members(pin))
            with self.subTest(pin=key):
                self.assertEqual(i.member_names(path), REAL_NAMES[key])
                self.assertIn('blobs/sha256/'+manifest_of(pin)[7:], REAL_NAMES[key])
                self.assertIn('blobs/sha256/'+pin[1][7:], REAL_NAMES[key])
            path.unlink()

    def test_config_named_by_the_manifest_must_be_the_pinned_config(self):
        # Real buildkit manifest, held under its own digest, but pinned with python's config.
        with self.assertRaisesRegex(ValueError, 'image_identity_refused'):
            i.admit(containerd_row(BUILDKIT), BUILDKIT[0], PYTHON[1], self.save(saved_members(BUILDKIT)))

    def test_saved_archive_must_hold_exactly_the_hash_verified_manifest_blob(self):
        name = 'blobs/sha256/'+manifest_of(PYTHON)[7:]
        real = PYTHON[2].read_bytes(); members = saved_members(PYTHON)
        cases = {
            'absent': [m for m in members if m[0] != name],
            'other-bytes': [(n, BUILDKIT[2].read_bytes() if n == name else d) for n, d in members],
            'same-json-other-bytes': [(n, real+b'\n' if n == name else d) for n, d in members],
            'duplicate': members+[(name, real)],
            'dot-prefixed': [('./'+n if n == name else n, d) for n, d in members],
            'symlink': [(n, 'index.json' if n == name else d) for n, d in members],
            'directory': [(n, None if n == name else d) for n, d in members],
            'empty': [(n, b'' if n == name else d) for n, d in members],
            'oversized': [(n, real+b' '*(i.MAX_MANIFEST) if n == name else d) for n, d in members],
        }
        # A blob larger than the bound is refused before it is read, even with a matching hash.
        bound = len(real)-1
        original = i.MAX_MANIFEST; i.MAX_MANIFEST = bound
        try:
            with self.subTest(case='bound'), self.assertRaisesRegex(ValueError, 'image_identity_refused'):
                i.admit(containerd_row(PYTHON), PYTHON[0], PYTHON[1], self.save(members))
        finally: i.MAX_MANIFEST = original
        for label, value in cases.items():
            with self.subTest(case=label), self.assertRaisesRegex(ValueError, 'image_identity_refused'):
                i.admit(containerd_row(PYTHON), PYTHON[0], PYTHON[1], self.save(value))
        not_tar = Path(self.folder.name)/'not.tar'; not_tar.write_bytes(b'not an archive')
        with self.assertRaisesRegex(ValueError, 'image_identity_refused'):
            i.admit(containerd_row(PYTHON), PYTHON[0], PYTHON[1], lambda: not_tar)
        with self.assertRaisesRegex(ValueError, 'image_identity_refused'):
            i.admit(containerd_row(PYTHON), PYTHON[0], PYTHON[1], lambda: Path(self.folder.name)/'absent.tar')

    def test_manifest_document_is_a_single_image_manifest_with_one_config(self):
        good = json.loads(PYTHON[2].read_bytes())
        self.assertEqual(i.manifest_config(PYTHON[2].read_bytes()), PYTHON[1])
        docker_v2 = dict(good, mediaType='application/vnd.docker.distribution.manifest.v2+json')
        self.assertEqual(i.manifest_config(json.dumps(docker_v2).encode()), PYTHON[1])
        bad = [dict(good, mediaType='application/vnd.oci.image.index.v1+json'), dict(good, schemaVersion=1),
               {k: v for k, v in good.items() if k != 'config'}, dict(good, config=PYTHON[1]),
               dict(good, config={'mediaType': good['config']['mediaType']}),
               dict(good, config=dict(good['config'], digest='sha256:'+'A'*64)), [good]]
        for value in bad:
            with self.subTest(value=str(value)[:60]), self.assertRaisesRegex(ValueError, 'image_identity_refused'):
                i.manifest_config(json.dumps(value).encode())
        duplicate = PYTHON[2].read_bytes().replace(b'"schemaVersion": 2,', b'"schemaVersion": 2, "schemaVersion": 2,')
        for raw in (duplicate, b'\xff', b'{'):
            with self.subTest(raw=raw[:20]), self.assertRaisesRegex(ValueError, 'image_identity_refused'):
                i.manifest_config(raw)

    def test_pinned_reference_must_carry_one_exact_sha256_digest(self):
        for reference in ('python:3.12', 'python@sha256:'+'a'*63, 'a@b@sha256:'+'a'*64, None):
            with self.subTest(reference=reference), self.assertRaisesRegex(ValueError, 'image_identity_refused'):
                i.admit(classic_row(PYTHON), reference, PYTHON[1], self.save([]))
        for config in ('sha256:'+'A'*64, 'sha256:'+'a'*63, None):
            row = dict(classic_row(PYTHON), Id=config)
            with self.subTest(config=config), self.assertRaisesRegex(ValueError, 'image_identity_refused'):
                i.admit(row, PYTHON[0], config, self.save([]))


if __name__ == '__main__':
    unittest.main()
