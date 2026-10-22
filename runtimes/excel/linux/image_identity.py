# Copyright (c) 2026 Memlia. All rights reserved.
"""Admit a pinned base image under either Docker image store; stdlib only, no network.

Classic store: `docker image inspect` reports Id = the image config digest.
containerd image store (io.containerd.snapshotter.v1, Docker 29 default): Id = the pulled
manifest digest, and no inspect field carries the config digest. The manifest is then read
from a local `docker image save` OCI archive, verified against that digest, and must name
the pinned config. Shared by qualification.py and scripts/ci/workflow-worker-image.py.

Observed on the build VM (run9, Docker 29.9.2): member names of real archives are kept in
fixtures/docker29-containerd-save-member-names.json (names only); only
blobs/sha256/<pinned manifest> is read.
"""
import hashlib
import json
import re
import tarfile

DIGEST = re.compile(r'sha256:[a-f0-9]{64}\Z')
MANIFEST_TYPES = frozenset(('application/vnd.oci.image.manifest.v1+json',
                            'application/vnd.docker.distribution.manifest.v2+json'))
INDEX_TYPES = frozenset(('application/vnd.oci.image.index.v1+json',
                         'application/vnd.docker.distribution.manifest.list.v2+json'))
MAX_MANIFEST = 1024*1024
MAX_MEMBERS = 65536


def _require(ok):
    if not ok: raise ValueError('image_identity_refused')


def digest(raw):
    return 'sha256:'+hashlib.sha256(raw).hexdigest()


def manifest_config(raw):
    """Config digest named by one image manifest document (never an index)."""
    def unique(pairs):
        _require(len({key for key, _ in pairs}) == len(pairs)); return dict(pairs)
    try: value = json.loads(raw, object_pairs_hook=unique)
    except ValueError: _require(False)
    _require(type(value) is dict and type(value.get('schemaVersion')) is int and value['schemaVersion'] == 2
             and value.get('mediaType') in MANIFEST_TYPES and type(value.get('config')) is dict
             and type(value['config'].get('digest')) is str and DIGEST.fullmatch(value['config']['digest']))
    return value['config']['digest']


def member_names(archive):
    """Sorted member names of a saved archive, for a names-only evidence record."""
    try:
        with tarfile.open(archive, 'r:') as tar:
            names = []
            for count, member in enumerate(tar, 1):
                _require(count <= MAX_MEMBERS); names.append(member.name)
    except (tarfile.TarError, OSError): _require(False)
    return sorted(names)


def saved_manifest(archive, manifest):
    """Bytes of blobs/sha256/<manifest> in a `docker image save` archive, hash-verified."""
    name = 'blobs/sha256/'+manifest[len('sha256:'):]; found = None
    try:
        with tarfile.open(archive, 'r:') as tar:
            for count, member in enumerate(tar, 1):
                _require(count <= MAX_MEMBERS)
                if member.name != name: continue
                _require(found is None and member.isreg() and 0 < member.size <= MAX_MANIFEST)
                found = tar.extractfile(member).read(); _require(len(found) == member.size)
    except (tarfile.TarError, OSError): _require(False)
    _require(found is not None and digest(found) == manifest)
    return found


def admit(row, reference, config, save):
    """Return the admitted inspect Id of `reference`; `save()` gives a local archive path."""
    _require(type(reference) is str and reference.count('@') == 1 and type(config) is str
             and DIGEST.fullmatch(config) and type(row) is dict)
    manifest = reference.split('@')[1]; _require(DIGEST.fullmatch(manifest))
    descriptor = row.get('Descriptor')
    if type(descriptor) is dict and descriptor.get('mediaType') in INDEX_TYPES:
        # Pulled by an index digest: never admitted, but reported with its own closed code.
        raise ValueError('image_identity_index_refused')
    if row.get('Id') == config:
        _require(descriptor is None)
        return config
    _require(row.get('Id') == manifest)
    _require(descriptor is None or type(descriptor) is dict and descriptor.get('digest') == manifest
             and descriptor.get('mediaType') in MANIFEST_TYPES)
    _require(manifest_config(saved_manifest(save(), manifest)) == config)
    return manifest
