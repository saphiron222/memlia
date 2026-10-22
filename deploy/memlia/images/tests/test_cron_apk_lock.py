"""Offline checks of the cron APK lock and its explicit refresh.

Every repository below is fictitious: indexes and packages are built here and
signed by RSA keys generated for the test with the openssl CLI, an
implementation independent from the verifier under test. No network access.
"""
import base64
import gzip
import hashlib
import importlib.util
import io
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('cron_assets_lock', Path(__file__).with_name('fetch_cron_assets.py'))
assets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(assets)

KEY_NAME = 'fixture@example.invalid-0000f1x7.rsa.pub'
MAIN = 'https://dl-cdn.alpinelinux.org/alpine/v3.24/main/x86_64/'
# name: (current version, D: dependencies, p: provides)
CURRENT = {
    'z-ares': ('1.1-r0', '', 'so:libzares.so.1=1'),
    'tool': ('2.0-r1', 'so:libzares.so.1 tool-data=2.0-r1 !tool-legacy', 'cmd:tool=2.0-r1'),
    'tool-data': ('2.0-r1', '', ''),
}
OLD_LOCK = ('1' * 64 + '  tool-2.0-r1.apk\n' + '2' * 64 + '  tool-data-2.0-r1.apk\n'
            + '3' * 64 + '  z-ares-1.0-r0.apk\n')


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def tar(files):
    return tar_members([(name, content, tarfile.REGTYPE) for name, content in files.items()])


def tar_members(members):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w', format=tarfile.USTAR_FORMAT) as archive:
        for name, content, kind in members:
            info = tarfile.TarInfo(name)
            info.type = kind
            if kind == tarfile.SYMTYPE:
                info.linkname = content.decode()
                archive.addfile(info)
            else:
                info.size = len(content)
                archive.addfile(info, io.BytesIO(content))
    return buffer.getvalue()


def pkcs1_block(size, hashed, padding=None, separator=b'\0', trailer=b'', header=b'\0\1'):
    """An EMSA-PKCS1-v1_5 block; the defaults give the valid encoding."""
    if padding is None:
        padding = b'\xff' * (size - len(header) - len(separator) - len(hashed) - len(trailer))
    block = header + padding + separator + hashed + trailer
    assert len(block) == size, len(block)
    return block


def gz(raw):
    return gzip.compress(raw, mtime=0)


class Signer:
    """Test keys created by openssl in a private temporary directory."""

    def __init__(self, directory):
        self.openssl = shutil.which('openssl')
        if not self.openssl:
            raise RuntimeError('openssl CLI required to sign the fictitious fixtures')
        self.directory = Path(directory)
        self.private = {}
        self.public = {}
        for role in ('trusted', 'rogue'):
            private = self.directory / (role + '.pem')
            self.run('genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:2048', '-out', str(private))
            self.private[role] = private
            self.public[role] = self.run('pkey', '-in', str(private), '-pubout').decode()

    def run(self, *args, data=None):
        return subprocess.run([self.openssl, *args], input=data, capture_output=True, check=True, timeout=60).stdout

    def sign(self, role, data, digest='sha1'):
        return self.run('dgst', '-' + digest, '-sign', str(self.private[role]), data=data)

    def raw(self, role, block):
        """Textbook RSA private operation on a fabricated block (no padding added).
        OpenSSL 4 `pkeyutl -sign` treats its input as a digest, so the raw
        private-key operation is requested as a padding-free decryption."""
        return self.run('pkeyutl', '-decrypt', '-inkey', str(self.private[role]), '-pkeyopt', 'rsa_padding_mode:none',
                        data=block)

    def modulus(self, pem):
        line = self.run('rsa', '-pubin', '-modulus', '-noout', data=pem.encode()).decode().strip()
        if not line.startswith('Modulus='):
            raise RuntimeError('unexpected openssl modulus output')
        return int(line[len('Modulus='):], 16)

    def segment(self, data, role='trusted', key_name=KEY_NAME, digest='sha1'):
        prefix = '.SIGN.RSA.' if digest == 'sha1' else '.SIGN.RSA256.'
        return gz(tar({prefix + key_name: self.sign(role, data, digest)}))


class Repository:
    """A fictitious v3.24/main for one architecture, served by a fake download."""

    def __init__(self, signer, packages=CURRENT, arch='x86_64'):
        self.signer = signer
        self.arch = arch
        self.packages = dict(packages)
        self.apks = {name: self.apk(name, version) for name, (version, _, _) in self.packages.items()}
        self.overrides = {}
        self.index_fields = {}
        self.urls = []

    def control(self, name, version, data, pkgname=None, arch=None):
        # Like Alpine, a data-only package says noarch in .PKGINFO, the index says the repository arch.
        arch = arch or ('noarch' if name == 'tool-data' else self.arch)
        pkginfo = (f'# Generated by a test\npkgname = {pkgname or name}\npkgver = {version}\n'
                   f'arch = {arch}\ndepend = so:libc.fixture.so.1\ndatahash = {sha256(data)}\n')
        return gz(tar({'.PKGINFO': pkginfo.encode()}))

    def apk(self, name, version, pkgname=None, data=None, role='trusted', arch=None):
        data = data or gz(tar({'usr/share/' + name: b'fictitious ' + name.encode()}))
        control = self.control(name, version, data, pkgname, arch)
        return self.signer.segment(control, role) + control + data

    def entry(self, name):
        version, depends, provides = self.packages[name]
        apk = self.apks[name]
        control = assets.gzip_streams(apk)[1][0]
        fields = {'C': 'Q1' + base64.b64encode(hashlib.sha1(control).digest()).decode(), 'P': name,
                  'V': version, 'A': self.arch, 'S': str(len(apk)), 'I': '4096', 'T': 'fixture', 'D': depends,
                  'p': provides}
        fields.update(self.index_fields.get(name, {}))
        return ''.join(f'{key}:{value}\n' for key, value in fields.items() if value is not None)

    def text(self):
        return '\n'.join(self.entry(name) for name in self.packages) + '\n'

    def index(self, role='trusted', key_name=KEY_NAME, digest='sha1', text=None):
        signed = gz(tar({'DESCRIPTION': b'v3.24-fixture', 'APKINDEX': (text or self.text()).encode()}))
        return self.signer.segment(signed, role, key_name, digest) + signed

    def download(self, url):
        self.urls.append(url)
        if url in self.overrides:
            value = self.overrides[url]
            if isinstance(value, Exception):
                raise value
            return value
        if url == MAIN + 'APKINDEX.tar.gz':
            return self.index()
        for name, apk in self.apks.items():
            if url == MAIN + f'{name}-{self.packages[name][0]}.apk':
                return apk
        raise assets.UpstreamMissing(url, 404)


class RefreshLockTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.keys = tempfile.TemporaryDirectory()
        cls.signer = Signer(cls.keys.name)

    @classmethod
    def tearDownClass(cls):
        cls.keys.cleanup()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.lock = Path(self.tmp.name) / 'cron-apk-amd64.sha256'
        self.lock.write_text(OLD_LOCK)
        self.repo = Repository(self.signer)

    def refresh(self):
        with patch.object(assets, 'download', self.repo.download), \
             patch.dict(assets.ALPINE_KEYS, {'amd64': (KEY_NAME, self.signer.public['trusted'])}):
            return assets.refresh_lock('amd64', lock=self.lock)

    def assertRefused(self, pattern):
        with self.assertRaisesRegex(assets.Refused, pattern):
            self.refresh()
        self.assertEqual(self.lock.read_text(), OLD_LOCK, 'a refused refresh must leave the lock untouched')

    def expected_lock(self):
        rows = sorted((f'{name}-{version}.apk', sha256(self.repo.apks[name]))
                      for name, (version, _, _) in self.repo.packages.items())
        return ''.join(f'{digest}  {filename}\n' for filename, digest in rows)

    def test_refresh_resolves_same_names_to_signed_current_versions(self):
        changes = self.refresh()
        self.assertEqual(self.lock.read_text(), self.expected_lock())
        # Same version, new bytes is reported too: a silent rebuild deserves review.
        self.assertEqual(changes, [('tool-2.0-r1.apk', 'tool-2.0-r1.apk'), ('tool-data-2.0-r1.apk', 'tool-data-2.0-r1.apk'),
                                   ('z-ares-1.0-r0.apk', 'z-ares-1.1-r0.apk')])
        self.assertIn(MAIN + 'APKINDEX.tar.gz', self.repo.urls)

    def test_refresh_is_deterministic_and_idempotent(self):
        self.refresh()
        first = self.lock.read_bytes()
        self.assertEqual(self.refresh(), [])
        self.assertEqual(self.lock.read_bytes(), first)
        self.assertTrue(first.endswith(b'.apk\n'))
        self.assertEqual(first.splitlines(), sorted(first.splitlines(), key=lambda line: line.split(b'  ')[1]))

    def test_refresh_accepts_the_sha256_signature_variant(self):
        self.repo.overrides[MAIN + 'APKINDEX.tar.gz'] = self.repo.index(digest='sha256')
        self.refresh()
        self.assertEqual(self.lock.read_text(), self.expected_lock())

    def test_tampered_index_signature_is_refused(self):
        genuine = self.repo.index()
        signature_end = len(assets.gzip_streams(genuine)[0][0])
        forged = gz(tar({'DESCRIPTION': b'v3.24-fixture', 'APKINDEX': self.repo.text().replace('2.0-r1', '2.0-r9').encode()}))
        self.repo.overrides[MAIN + 'APKINDEX.tar.gz'] = genuine[:signature_end] + forged
        self.assertRefused('signature')

    def test_index_signed_by_another_key_under_the_pinned_name_is_refused(self):
        self.repo.overrides[MAIN + 'APKINDEX.tar.gz'] = self.repo.index(role='rogue')
        self.assertRefused('signature')

    def test_index_signed_by_an_unknown_key_name_is_refused(self):
        self.repo.overrides[MAIN + 'APKINDEX.tar.gz'] = self.repo.index(key_name='unknown@example.invalid.rsa.pub')
        self.assertRefused('signing key')

    def test_unsigned_index_is_refused(self):
        signed = gz(tar({'DESCRIPTION': b'x', 'APKINDEX': self.repo.text().encode()}))
        self.repo.overrides[MAIN + 'APKINDEX.tar.gz'] = signed
        self.assertRefused('signature')

    def test_truncated_index_is_refused(self):
        genuine = self.repo.index()
        for cut in (len(genuine) - 9, len(genuine) // 2, 20):
            with self.subTest(cut=cut):
                self.repo.overrides[MAIN + 'APKINDEX.tar.gz'] = genuine[:cut]
                self.assertRefused('gzip')

    def test_trailing_data_after_signed_index_is_refused(self):
        self.repo.overrides[MAIN + 'APKINDEX.tar.gz'] = self.repo.index() + gz(b'appended')
        self.assertRefused('unsigned trailing')

    def test_locked_package_absent_from_the_index_is_refused_by_name(self):
        del self.repo.packages['tool-data']
        self.repo.packages['tool'] = ('2.0-r1', 'so:libzares.so.1', '')
        self.assertRefused('tool-data')

    def test_unexpected_lock_line_is_refused(self):
        for text in ('1' * 64 + '  ../escape-1.0-r0.apk\n', '1' * 64 + '  noversion.apk\n',
                     'A' * 64 + '  tool-2.0-r1.apk\n', '1' * 64 + ' tool-2.0-r1.apk\n',
                     OLD_LOCK.replace('\n', '', 1), OLD_LOCK + OLD_LOCK.splitlines(True)[0],
                     ''.join(reversed(OLD_LOCK.splitlines(True))), ''):
            with self.subTest(text=text):
                self.lock.write_text(text)
                with self.assertRaises(assets.Refused):
                    self.refresh()
                self.assertEqual(self.lock.read_text(), text)

    def test_unexpected_name_or_version_from_the_index_is_refused(self):
        self.repo.index_fields['tool'] = {'V': '2.0-r1/../x'}
        self.assertRefused('Unexpected')

    def test_package_whose_control_differs_from_the_index_is_refused(self):
        served = self.repo.apk('tool', '2.0-r1', data=gz(tar({'other': b'x'})))
        self.repo.overrides[MAIN + 'tool-2.0-r1.apk'] = served
        self.repo.index_fields['tool'] = {'S': str(len(served))}
        self.assertRefused('control hash.*tool')

    def test_package_data_not_matching_its_signed_datahash_is_refused(self):
        apk = self.repo.apks['tool']
        signature, control = (stream for stream, _ in assets.gzip_streams(apk)[:2])
        served = signature + control + gz(tar({'evil': b'payload'}))
        self.repo.overrides[MAIN + 'tool-2.0-r1.apk'] = served
        self.repo.index_fields['tool'] = {'S': str(len(served))}
        self.assertRefused('data hash.*tool')

    def test_package_size_differs_from_the_index_is_refused(self):
        self.repo.index_fields['tool'] = {'S': '1'}
        self.assertRefused('size.*tool')

    def test_package_with_a_bad_signature_is_refused(self):
        self.repo.apks['tool'] = self.repo.apk('tool', '2.0-r1', role='rogue')
        self.assertRefused('signature.*tool')

    def test_package_declaring_another_name_is_refused(self):
        self.repo.apks['tool'] = self.repo.apk('tool', '2.0-r1', pkgname='tool-evil')
        self.assertRefused('Unexpected package metadata.*tool')

    def test_package_built_for_another_architecture_is_refused(self):
        self.repo.apks['tool'] = self.repo.apk('tool', '2.0-r1', arch='aarch64')
        self.assertRefused('Unexpected package metadata.*tool')

    def test_index_entry_for_another_architecture_is_refused(self):
        self.repo.index_fields['tool'] = {'A': 'aarch64'}
        self.assertRefused('architecture.*tool')

    def test_duplicate_package_in_index_is_refused(self):
        text = self.repo.text() + self.repo.entry('tool')
        self.repo.overrides[MAIN + 'APKINDEX.tar.gz'] = self.repo.index(text=text)
        self.assertRefused('Duplicate.*tool')

    def test_dependency_outside_the_locked_set_is_refused(self):
        self.repo.packages['libnew'] = ('1.0-r0', '', '')
        self.repo.apks['libnew'] = self.repo.apk('libnew', '1.0-r0')
        self.repo.packages['tool'] = ('2.0-r1', 'so:libzares.so.1 libnew', '')
        self.assertRefused('tool -> libnew')

    def test_exact_dependency_not_satisfied_by_the_locked_set_is_refused(self):
        self.repo.packages['tool-data'] = ('2.0-r2', '', '')
        self.repo.apks['tool-data'] = self.repo.apk('tool-data', '2.0-r2')
        self.assertRefused('tool -> tool-data=2.0-r1')

    def test_stale_but_validly_signed_index_cannot_downgrade(self):
        self.lock.write_text(OLD_LOCK.replace('z-ares-1.0-r0.apk', 'z-ares-1.2-r0.apk'))
        locked = self.lock.read_text()
        with self.assertRaisesRegex(assets.Refused, 'older than the lock for z-ares: 1.2-r0 -> 1.1-r0'):
            self.refresh()
        self.assertEqual(self.lock.read_text(), locked)
        self.assertEqual(self.repo.urls, [MAIN + 'APKINDEX.tar.gz'], 'refused before any package download')

    def test_refresh_logs_the_direction_of_each_change(self):
        lines = []
        with patch.object(assets, 'download', self.repo.download), \
             patch.dict(assets.ALPINE_KEYS, {'amd64': (KEY_NAME, self.signer.public['trusted'])}):
            assets.refresh_lock('amd64', lock=self.lock, log=lines.append)
        self.assertIn('z-ares-1.0-r0.apk -> z-ares-1.1-r0.apk (upgrade)', lines)
        self.assertIn('tool-2.0-r1.apk: same version, new sha256', lines)

    def test_index_fields_may_contain_unicode_line_separators(self):
        self.repo.index_fields['tool'] = {'T': 'fictitious\u2028description\x85with\x0cseparators'}
        self.refresh()
        self.assertEqual(self.lock.read_text(), self.expected_lock())

    def test_duplicate_or_non_regular_control_member_is_refused(self):
        apk = self.repo.apks['tool']
        streams = assets.gzip_streams(apk)
        pkginfo = assets.tar_files(streams[1][1], 'control')['.PKGINFO']
        for label, members in (('duplicate', [('.PKGINFO', pkginfo, tarfile.REGTYPE), ('.PKGINFO', b'pkgname = evil\n', tarfile.REGTYPE)]),
                               ('symlink', [('.PKGINFO', pkginfo, tarfile.REGTYPE), ('.post-install', b'/etc/shadow', tarfile.SYMTYPE)])):
            with self.subTest(label):
                control = gz(tar_members(members))
                self.repo.apks['tool'] = self.signer.segment(control) + control + streams[2][0]
                self.assertRefused('Unexpected control member')

    def test_oversized_gzip_stream_is_refused(self):
        with patch.object(assets, 'MAX_SEGMENT', 1024):
            with self.assertRaisesRegex(assets.Refused, 'Oversized'):
                assets.gzip_streams(gz(b'\0' * 4096))
            self.assertEqual(assets.gzip_streams(gz(b'\0' * 1024))[0][1], b'\0' * 1024)

    def test_lock_is_synced_before_it_replaces_the_old_one(self):
        calls = []
        real_fsync, real_replace = assets.os.fsync, assets.os.replace
        with patch.object(assets.os, 'fsync', side_effect=lambda fd: (calls.append('fsync'), real_fsync(fd))), \
             patch.object(assets.os, 'replace', side_effect=lambda a, b: (calls.append('replace'), real_replace(a, b))):
            self.refresh()
        self.assertEqual(calls, ['fsync', 'replace'])
        self.assertEqual(self.lock.read_text(), self.expected_lock())

    def test_failed_open_leaks_neither_descriptor_nor_temporary_file(self):
        opened = []
        real_mkstemp = tempfile.mkstemp

        def mkstemp(*args, **kwargs):
            result = real_mkstemp(*args, **kwargs)
            opened.append(result[0])
            return result
        with patch.object(assets.tempfile, 'mkstemp', side_effect=mkstemp), \
             patch.object(assets.os, 'fdopen', side_effect=OSError('simulated')):
            with self.assertRaisesRegex(OSError, 'simulated'):
                self.refresh()
        self.assertEqual(len(opened), 1)
        with self.assertRaises(OSError):
            os.fstat(opened[0])
        self.assertEqual(sorted(path.name for path in self.lock.parent.iterdir()), [self.lock.name])
        self.assertEqual(self.lock.read_text(), OLD_LOCK)

    def test_missing_current_package_during_refresh_is_refused_by_name(self):
        self.repo.overrides[MAIN + 'z-ares-1.1-r0.apk'] = assets.UpstreamMissing(MAIN + 'z-ares-1.1-r0.apk', 404)
        self.assertRefused('z-ares-1.1-r0.apk')


class FetchNeverRefreshesTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.output = Path(self.tmp.name) / 'private-assets-dir'
        self.urls = []
        self.url = 'https://dl-cdn.alpinelinux.org/alpine/v3.24/main/x86_64/ca-certificates-20260909-r0.apk'
        self.pins = {'apk/ca-certificates-20260909-r0.apk': (self.url, '6' * 64)}

    def fetch(self, behaviour):
        def download(url):
            self.urls.append(url)
            return behaviour(url)
        with patch.object(assets, 'download', download), patch.object(assets, 'asset_pins', lambda _: self.pins):
            assets.fetch(self.output, 'amd64')

    def test_missing_pinned_package_names_it_and_the_refresh_command_only(self):
        def missing(url):
            raise assets.UpstreamMissing(url, 404)
        with self.assertRaises(assets.Refused) as caught:
            self.fetch(missing)
        message = str(caught.exception)
        self.assertIn('ca-certificates-20260909-r0.apk', message)
        self.assertIn('python3 deploy/memlia/images/tests/fetch_cron_assets.py --refresh-lock --architecture amd64', message)
        self.assertNotIn(self.tmp.name, message)
        self.assertNotIn(str(Path(assets.__file__).parent), message)
        self.assertEqual(self.urls, [self.url], 'the build fetch must never read the index nor resolve versions')
        self.assertFalse(self.output.exists())

    def test_divergent_sha256_still_fails_closed(self):
        with self.assertRaisesRegex(assets.Refused, 'Hash mismatch: apk/ca-certificates-20260909-r0.apk'):
            self.fetch(lambda url: b'served by a cache, different bytes')
        self.assertFalse(self.output.exists())

    def test_other_download_failures_are_not_reported_as_unpublished(self):
        def broken(url):
            raise RuntimeError('Download failed (HTTP 503)')
        with self.assertRaisesRegex(RuntimeError, '503'):
            self.fetch(broken)
        self.assertFalse(self.output.exists())


class DownloadStatusTests(unittest.TestCase):
    def run_download(self, returncode, stdout, stderr):
        result = subprocess.CompletedProcess([], returncode, stdout, stderr)
        with patch.object(assets.subprocess, 'run', return_value=result) as run:
            return assets.download('https://example.invalid/x.apk'), run

    def test_success_returns_the_body(self):
        body, run = self.run_download(0, b'body', b'memlia-http-status:200\n')
        self.assertEqual(body, b'body')
        self.assertIn('--fail', run.call_args.args[0])

    def test_http_404_is_reported_as_unpublished_whatever_curl_exit_code(self):
        for code in (22, 56):
            with self.subTest(code=code), self.assertRaises(assets.UpstreamMissing) as caught:
                self.run_download(code, b'', b'curl: (%d) The requested URL returned error: 404\nmemlia-http-status:404\n' % code)
            self.assertEqual(caught.exception.status, 404)

    def test_other_failures_stay_generic(self):
        for stderr in (b'memlia-http-status:503\n', b'curl: (6) Could not resolve host\nmemlia-http-status:000\n', b''):
            with self.subTest(stderr=stderr), self.assertRaises(RuntimeError) as caught:
                self.run_download(22, b'', stderr)
            self.assertNotIsInstance(caught.exception, assets.UpstreamMissing)


class PinnedLockAndKeyTests(unittest.TestCase):
    # Key files cross-checked on 22/10/2026 against alpinelinux.org/keys, aports
    # 3.24-stable main/alpine-keys, and /etc/apk/keys of the digest-pinned base.
    DIGESTS = {'amd64': ('alpine-devel@lists.alpinelinux.org-6165ee59.rsa.pub',
                         '207e4696d3c05f7cb05966aee557307151f1f00217af4143c1bcaf33b8df733f'),
               'arm64': ('alpine-devel@lists.alpinelinux.org-616ae350.rsa.pub',
                         'd11f6b21c61b4274e182eb888883a8ba8acdbf820dcc7a6d82a7d9fc2fd2836d')}

    def test_embedded_alpine_keys_are_the_official_files(self):
        for architecture, (name, digest) in self.DIGESTS.items():
            with self.subTest(architecture=architecture):
                key_name, pem = assets.ALPINE_KEYS[architecture]
                self.assertEqual(key_name, name)
                self.assertEqual(sha256(pem.encode()), digest)
                modulus, exponent = assets.rsa_public_key(pem)
                self.assertEqual((modulus.bit_length(), exponent), (4096, 65537))

    def test_key_parser_agrees_with_openssl(self):
        # The parser only reads pinned constants: its output is checked against
        # an independent implementation instead of hardening it for hostile input.
        with tempfile.TemporaryDirectory() as directory:
            signer = Signer(directory)
            pems = [pem for _, pem in assets.ALPINE_KEYS.values()] + list(signer.public.values())
            for pem in pems:
                with self.subTest(key=pem[27:60]):
                    self.assertEqual(assets.rsa_public_key(pem)[0], signer.modulus(pem))

    def test_signature_of_wrong_length_does_not_verify(self):
        pem = assets.ALPINE_KEYS['amd64'][1]
        self.assertFalse(assets.rsa_verify(pem, b'\x01' * 511, b'message', 'sha1'))
        self.assertFalse(assets.rsa_verify(pem, b'\xff' * 512, b'message', 'sha1'))

    def test_reviewed_locks_cover_the_same_names_on_both_architectures(self):
        names = {}
        for architecture in ('arm64', 'amd64'):
            rows = assets.parse_lock(Path(__file__).with_name(assets.LOCKS[architecture]).read_text())
            names[architecture] = [assets.split_package(filename)[0] for _, filename in rows]
            self.assertEqual(len(rows), 19)
        self.assertEqual(names['arm64'], names['amd64'])


class RawSignatureTests(unittest.TestCase):
    """Blocks fabricated by hand and raised to the private exponent by openssl:
    only the exact, complete PKCS#1 v1.5 encoding may verify."""

    @classmethod
    def setUpClass(cls):
        cls.keys = tempfile.TemporaryDirectory()
        cls.signer = Signer(cls.keys.name)
        cls.pem = cls.signer.public['trusted']
        cls.modulus = assets.rsa_public_key(cls.pem)[0]
        cls.size = (cls.modulus.bit_length() + 7) // 8

    @classmethod
    def tearDownClass(cls):
        cls.keys.cleanup()

    def hashed(self, message, digest='sha1'):
        return assets.DIGEST_INFO[digest] + hashlib.new(digest, message).digest()

    def verifies(self, block, message=b'message'):
        return assets.rsa_verify(self.pem, self.signer.raw('trusted', block), message, 'sha1')

    def test_fabricated_valid_block_verifies_and_equals_the_standard_signature(self):
        block = pkcs1_block(self.size, self.hashed(b'message'))
        self.assertEqual(self.signer.raw('trusted', block), self.signer.sign('trusted', b'message'))
        self.assertTrue(self.verifies(block))

    def test_every_deviation_from_the_exact_encoding_is_refused(self):
        hashed = self.hashed(b'message')
        sha256_info_on_sha1 = assets.DIGEST_INFO['sha256'] + hashlib.sha1(b'message').digest()
        cases = {
            'short padding': pkcs1_block(self.size, hashed, padding=b'\xff' * (self.size - len(hashed) - 4), separator=b'\0\0'),
            'bytes after the hash': pkcs1_block(self.size, hashed, trailer=b'XXXX'),
            'wrong DigestInfo': pkcs1_block(self.size, sha256_info_on_sha1),
            'no 00 separator': pkcs1_block(self.size, hashed, separator=b''),
            'non-FF padding': pkcs1_block(self.size, hashed, padding=b'\xff' * 8 + b'\xab' + b'\xff' * (self.size - len(hashed) - 12)),
            'block type 2': pkcs1_block(self.size, hashed, header=b'\0\2'),
            'other message': pkcs1_block(self.size, self.hashed(b'another message')),
        }
        for label, block in cases.items():
            with self.subTest(label):
                self.assertFalse(self.verifies(block))

    def test_valid_signature_with_a_leading_zero_byte_is_refused(self):
        signature = self.signer.sign('trusted', b'message')
        self.assertTrue(assets.rsa_verify(self.pem, signature, b'message', 'sha1'))
        self.assertFalse(assets.rsa_verify(self.pem, b'\0' + signature, b'message', 'sha1'))

    def test_signature_plus_modulus_is_refused(self):
        # s + n raises to the same block; it must still be refused as >= n.
        for attempt in range(400):
            message = b'message %d' % attempt
            signature = int.from_bytes(self.signer.sign('trusted', message), 'big')
            if signature + self.modulus < 1 << (8 * self.size):
                break
        else:
            self.fail('no signature leaves room for s + n in the modulus size')
        self.assertTrue(assets.rsa_verify(self.pem, signature.to_bytes(self.size, 'big'), message, 'sha1'))
        forged = (signature + self.modulus).to_bytes(self.size, 'big')
        self.assertEqual(pow(int.from_bytes(forged, 'big'), 65537, self.modulus), pow(signature, 65537, self.modulus))
        self.assertFalse(assets.rsa_verify(self.pem, forged, message, 'sha1'))


class VersionOrderTests(unittest.TestCase):
    def test_versions_in_lock_forms_are_ordered_like_apk(self):
        ordered = ['0.21.5-r3', '1.2.0-r1', '1.2.1-r0', '1.2.6-r2', '1.2.6-r3', '1.9-r0', '1.10-r0',
                   '1.34.8-r0', '1.34.9-r0', '1.37.0-r9', '1.37.0-r10', '1.37.0-r31', '1.37.0-r32', '2026-r0', '2026a-r0', '2026e-r0',
                   '2026f-r0', '20260909-r0', '20261020-r0']
        for lower, higher in zip(ordered, ordered[1:]):
            with self.subTest(lower=lower, higher=higher):
                self.assertLess(assets.version_key(lower), assets.version_key(higher))
        suffixes = ['1.0_alpha1-r0', '1.0_beta2-r0', '1.0_pre1-r0', '1.0_rc1-r0', '1.0_rc2-r0', '1.0-r0',
                    '1.0_git20230424-r0', '1.0_p1-r0', '1.0a-r0', '1.0.1_rc1-r0', '1.0.1-r0']
        for lower, higher in zip(suffixes, suffixes[1:]):
            with self.subTest(lower=lower, higher=higher):
                self.assertLess(assets.version_key(lower), assets.version_key(higher))
        self.assertEqual(assets.version_key('1.2.6-r3'), assets.version_key('1.2.6-r3'))

    def test_unsupported_version_forms_are_refused(self):
        for version in ('1.02-r0', '1.0~abc-r0', '1.0', '1.0-r', '1.0_foo1-r0', 'v1.0-r0', '1.0ab-r0'):
            with self.subTest(version=version), self.assertRaises(assets.Refused):
                assets.version_key(version)

    def test_every_version_of_the_reviewed_locks_is_supported(self):
        for architecture in ('arm64', 'amd64'):
            for _, filename in assets.parse_lock(Path(__file__).with_name(assets.LOCKS[architecture]).read_text()):
                with self.subTest(filename=filename):
                    assets.version_key(assets.split_package(filename)[1])


class CommandLineTests(unittest.TestCase):
    def test_refresh_and_fetch_modes_are_exclusive(self):
        for argv in (['--refresh-lock', '--architecture', 'amd64', 'out'], ['--architecture', 'amd64'],
                     ['--refresh-lock'], ['out', '--architecture', 'x86_64']):
            with self.subTest(argv=argv), self.assertRaises(SystemExit) as caught, \
                 patch('sys.stderr', io.StringIO()):
                assets.main(argv)
            self.assertEqual(caught.exception.code, 2)

    def test_refusal_prints_message_without_traceback(self):
        def refused(*_, **__):
            raise assets.Refused('refused for a reason')
        stderr = io.StringIO()
        with patch.object(assets, 'refresh_lock', refused), patch('sys.stderr', stderr), \
             self.assertRaises(SystemExit) as caught:
            assets.main(['--refresh-lock', '--architecture', 'arm64'])
        self.assertEqual(caught.exception.code, 1)
        self.assertEqual(stderr.getvalue(), 'fetch_cron_assets: refused for a reason\n')


if __name__ == '__main__':
    unittest.main()
