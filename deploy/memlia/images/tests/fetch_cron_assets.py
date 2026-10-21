"""Fetch pinned public build inputs; never execute downloaded programs.

Requires curl with TLS verification. Source module ZIPs are checksum-verified
against the Go build information embedded in the pinned Supercronic binary.
Only license/notice files and provenance metadata enter the build context.
"""
import argparse
import base64
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import tempfile
import zipfile

COMMIT = 'cca6b3a90abc99a024f4b437da0f1886da68ca7a'
PINNED = {
    'supercronic': ('https://github.com/aptible/supercronic/releases/download/v0.2.33/supercronic-linux-arm64', 'f1f8585c66de020fef494dd636058f99949d108f569fef00016a1c8b9eb145b3'),
    'supercronic-metadata/LICENSE.md': (f'https://raw.githubusercontent.com/aptible/supercronic/{COMMIT}/LICENSE.md', 'f61b5a0800deae2cca667eaf6429e92613db156226eaa7cdb139dbc803001ae3'),
    'supercronic-metadata/go.mod': (f'https://raw.githubusercontent.com/aptible/supercronic/{COMMIT}/go.mod', '785b66083572fc7b369368fa9f6e14d14b7041834d0377e8610251ba6c784efb'),
    'supercronic-metadata/go.sum': (f'https://raw.githubusercontent.com/aptible/supercronic/{COMMIT}/go.sum', 'd41ae296919d66ac245d9078e389212237af34a2285f42f30f22a4b985943828'),
}


def download(url):
    return subprocess.run(['curl', '--fail', '--location', '--silent', '--show-error', '--max-time', '90', '--max-filesize', '67108864', url], capture_output=True, check=True).stdout


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def go_zip_hash(archive):
    lines = ''.join(sha256(archive.read(name)) + '  ' + name + '\n' for name in sorted(archive.namelist()) if not name.endswith('/'))
    return 'h1:' + base64.b64encode(hashlib.sha256(lines.encode()).digest()).decode()


def asset_pins(architecture):
    if architecture not in ('arm64','amd64'):
        raise ValueError('Unsupported cron architecture')
    pins=dict(PINNED)
    if architecture=='amd64':
        pins['supercronic']=('https://github.com/aptible/supercronic/releases/download/v0.2.33/supercronic-linux-amd64',
            'feefa310da569c81b99e1027b86b27b51e6ee9ab647747b49099645120cfc671')
    lock='cron-apk.sha256' if architecture=='arm64' else 'cron-apk-amd64.sha256'
    platform='aarch64' if architecture=='arm64' else 'x86_64'
    for line in Path(__file__).with_name(lock).read_text().splitlines():
        digest,name=line.split('  ',1)
        pins['apk/'+name]=('https://dl-cdn.alpinelinux.org/alpine/v3.24/main/'+platform+'/'+name,digest)
    return pins


def fetch(output, architecture):
    pins=asset_pins(architecture)
    output = Path(output)
    if output.exists():
        raise FileExistsError(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=output.parent, prefix='.assets-') as temporary:
        staging = Path(temporary) / 'assets'
        staging.mkdir()
        receipts = {}
        for name, (url, expected) in pins.items():
            data = download(url)
            if sha256(data) != expected:
                raise ValueError(f'Hash mismatch: {name}')
            target = staging / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            receipts[name] = {'url': url, 'sha256': expected, 'bytes': len(data)}
        modules = sorted(set(re.findall(rb'dep\t([^\t\n]+)\t([^\t\n]+)\t(h1:[^\n\x00]+)', (staging / 'supercronic').read_bytes())))
        if len(modules) != 16:
            raise ValueError('Unexpected Supercronic module inventory')
        metadata = staging / 'supercronic-metadata'
        dependencies = []
        for entry in modules:
            module, version, expected = (value.decode() for value in entry)
            url = f'https://proxy.golang.org/{module}/@v/{version}.zip'
            data = download(url)
            archive = zipfile.ZipFile(io.BytesIO(data))
            if go_zip_hash(archive) != expected:
                raise ValueError(f'Module checksum mismatch: {module}')
            licenses = {}
            for name in archive.namelist():
                leaf = name.rsplit('/', 1)[-1].lower()
                if name.endswith('/') or not leaf.startswith(('license', 'notice', 'copying', 'copyright')):
                    continue
                if Path(name).is_absolute() or '..' in Path(name).parts:
                    raise ValueError('Unsafe archive path')
                target = metadata / 'dependencies' / name
                target.parent.mkdir(parents=True, exist_ok=True)
                content = archive.read(name)
                target.write_bytes(content)
                licenses[name] = sha256(content)
            if not licenses:
                raise ValueError(f'Module license missing: {module}')
            dependencies.append({'module': module, 'version': version, 'binary_h1': expected, 'source': url, 'zip_sha256': sha256(data), 'licenses': licenses})
        (metadata / 'provenance.json').write_text(json.dumps(receipts, indent=2) + '\n')
        (metadata / 'dependencies.json').write_text(json.dumps(dependencies, indent=2) + '\n')
        staging.rename(output)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    parser.add_argument('--architecture',choices=['arm64','amd64'],required=True)
    args=parser.parse_args()
    fetch(args.output,args.architecture)
