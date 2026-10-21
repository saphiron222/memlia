"""Vrais fichiers POSIX fictifs, sans watcher, stockage durable ou exécution."""
from hashlib import sha256
from dataclasses import FrozenInstanceError, replace
import fcntl
import errno
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from memlia_excel import ingestion

ABC = 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'


class IngestionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve() / 'inbox'
        self.root.mkdir()

    def observations(self, name='sample.xlsx'):
        first = ingestion.observe_inbox(self.root).candidates[0]
        time.sleep(0.002)
        second = ingestion.observe_inbox(self.root).candidates[0]
        return first, second

    def test_invalid_root_inputs_have_fixed_diagnostics(self):
        # Canonical existing parents prevent a symlink refusal masking Unicode.
        invalid = (None, bytes(self.root), self.root / '\ud800')
        for root in invalid:
            with self.subTest(input_type=type(root).__name__):
                with self.assertRaisesRegex(ingestion.IngestionRefused, '^invalid_root$'):
                    ingestion.observe_inbox(root)

    def test_offline_inbox_is_explicit_refusal_not_an_empty_success(self):
        self.root.rmdir()
        with self.assertRaisesRegex(ingestion.IngestionRefused, '^inbox_unavailable$'):
            ingestion.observe_inbox(self.root)

    def test_same_events_repeat_same_content_identity_without_publication(self):
        (self.root / 'sample.xlsx').write_bytes(b'abc')
        first, second = self.observations()
        a = ingestion.take_snapshot(self.root, first, second, handoff_digest=ABC,
                                    minimum_stable_ns=1_000_000)
        b = ingestion.take_snapshot(self.root, first, second, handoff_digest=ABC,
                                    minimum_stable_ns=1_000_000)
        self.assertEqual((a.content, a.sha256), (b.content, b.sha256))
        self.assertEqual(list(self.root.iterdir()), [self.root / 'sample.xlsx'])
        with self.assertRaises(FrozenInstanceError):
            a.content = b'changed'

    def test_changed_same_name_needs_new_observations_and_handoff(self):
        file = self.root / 'sample.xlsx'; file.write_bytes(b'abc')
        first, second = self.observations()
        file.write_bytes(b'new')
        with self.assertRaisesRegex(ingestion.IngestionRefused, '^source_changed$'):
            ingestion.take_snapshot(self.root, first, second, handoff_digest=ABC,
                                     minimum_stable_ns=1_000_000)
        new_first, new_second = self.observations()
        digest = 'sha256:' + sha256(b'new').hexdigest()
        result = ingestion.take_snapshot(self.root, new_first, new_second,
                                         handoff_digest=digest, minimum_stable_ns=1_000_000)
        self.assertEqual(result.content, b'new')
        self.assertNotEqual(result.sha256, ABC)

    def test_stable_size_without_matching_handoff_is_not_completion(self):
        (self.root / 'sample.xlsx').write_bytes(b'abc')
        first, second = self.observations()
        for digest, code in [(None, 'invalid_handoff'), ('sha256:'+'0'*64, 'handoff_mismatch')]:
            with self.subTest(digest=digest), self.assertRaisesRegex(ingestion.IngestionRefused, '^'+code+'$'):
                ingestion.take_snapshot(self.root, first, second, handoff_digest=digest,
                                         minimum_stable_ns=1_000_000)

    def test_observation_delay_is_required_without_sleeping_inside_module(self):
        (self.root / 'sample.xlsx').write_bytes(b'abc')
        first, second = self.observations()
        with self.assertRaisesRegex(ingestion.IngestionRefused, '^source_not_stable$'):
            ingestion.take_snapshot(self.root, first, second, handoff_digest=ABC,
                                     minimum_stable_ns=10**18)

    def test_file_still_written_between_observations_is_refused(self):
        file = self.root / 'sample.xlsx'; file.write_bytes(b'abc')
        first = ingestion.observe_inbox(self.root).candidates[0]
        file.write_bytes(b'abcd')
        time.sleep(0.002)
        second = ingestion.observe_inbox(self.root).candidates[0]
        with self.assertRaisesRegex(ingestion.IngestionRefused, '^source_not_stable$'):
            ingestion.take_snapshot(self.root, first, second, handoff_digest=ABC,
                                     minimum_stable_ns=1_000_000)

    def test_partial_unsupported_symlink_hardlink_and_fifo_are_reported(self):
        outside = self.root.parent / 'outside'; outside.write_bytes(b'secret fixture')
        (self.root / 'sample.partial').write_bytes(b'partial')
        (self.root / 'legacy.xls').write_bytes(b'legacy')
        (self.root / 'link.xlsx').symlink_to(outside)
        os.link(outside, self.root / 'hard.xlsx')
        os.mkfifo(self.root / 'pipe.xlsx')
        result = ingestion.observe_inbox(self.root)
        self.assertEqual(result.candidates, ())
        self.assertEqual({r.name:r.code for r in result.rejected}, {
            'sample.partial':'producer_not_ready', 'legacy.xls':'unsupported_extension',
            'link.xlsx':'not_regular', 'hard.xlsx':'unsafe_link_count', 'pipe.xlsx':'not_regular'})
        self.assertEqual(outside.read_bytes(), b'secret fixture')

    def test_root_and_parent_symlinks_are_refused(self):
        link = self.root.parent / 'alias'; link.symlink_to(self.root, target_is_directory=True)
        for path in (link, link / 'nested'):
            with self.subTest(path=path), self.assertRaisesRegex(ingestion.IngestionRefused, '^inbox_unavailable$'):
                ingestion.observe_inbox(path)

    def test_bounds_refuse_entries_size_and_invalid_configuration(self):
        for i in range(2): (self.root / f'{i}.xlsx').write_bytes(b'abc')
        with self.assertRaisesRegex(ingestion.IngestionRefused, '^entry_limit$'):
            ingestion.observe_inbox(self.root, max_entries=1)
        result = ingestion.observe_inbox(self.root, max_bytes=2)
        self.assertEqual(result.candidates, ())
        self.assertEqual({r.code for r in result.rejected}, {'input_limit'})
        for config in ({'max_bytes':0},{'max_bytes':10_000_001},{'max_entries':True},{'max_entries':33}):
            with self.subTest(config=config), self.assertRaisesRegex(ingestion.IngestionRefused, '^invalid_limits$'):
                ingestion.observe_inbox(self.root, **config)

    def test_forged_outside_name_is_refused_before_read(self):
        (self.root / 'sample.xlsx').write_bytes(b'abc')
        first, second = self.observations()
        for name in ('../outside.xlsx','/outside.xlsx','a/b.xlsx','a\\b.xlsx','..','\ud800.xlsx'):
            with self.subTest(name=name), self.assertRaisesRegex(ingestion.IngestionRefused, '^invalid_name$'):
                ingestion.take_snapshot(self.root, replace(first,name=name), replace(second,name=name),
                                         handoff_digest=ABC, minimum_stable_ns=1_000_000)

    def test_exclusive_producer_lock_is_refused_nonblocking(self):
        source=self.root / 'sample.xlsx'; source.write_bytes(b'abc')
        first, second=self.observations()
        with source.open('rb') as locked:
            fcntl.flock(locked.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaisesRegex(ingestion.IngestionRefused, '^source_locked$'):
                ingestion.take_snapshot(self.root, first, second, handoff_digest=ABC,
                                         minimum_stable_ns=1_000_000)

    def test_real_mutations_during_read_leave_no_snapshot_or_output(self):
        for mutation in ('rewrite','replace','hardlink','root_replace','root_symlink','parent_symlink','grow'):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as directory:
                container=Path(directory).resolve() / 'parent'; container.mkdir()
                root=container/'inbox'; root.mkdir(); source=root/'sample.xlsx'; source.write_bytes(b'abc')
                first=ingestion.observe_inbox(root).candidates[0];time.sleep(.002)
                second=ingestion.observe_inbox(root).candidates[0]
                real_read=os.read; changed=False
                def read_then_mutate(fd,size):
                    nonlocal changed
                    content=real_read(fd,size)
                    if content and not changed:
                        changed=True
                        if mutation=='rewrite':source.write_bytes(b'XYZ')
                        elif mutation=='replace':source.rename(root/'old');source.write_bytes(b'new')
                        elif mutation=='hardlink':os.link(source,container/'another')
                        elif mutation=='root_replace':root.rename(container/'old');root.mkdir();(root/'sample.xlsx').write_bytes(b'abc')
                        elif mutation=='root_symlink':root.rename(container/'old');root.symlink_to(container/'old',target_is_directory=True)
                        elif mutation=='parent_symlink':container.rename(container.parent/'old');container.symlink_to(container.parent/'old',target_is_directory=True)
                        elif mutation=='grow':
                            with source.open('ab') as stream:stream.write(b'x')
                    return content
                with patch.object(ingestion.os,'read',side_effect=read_then_mutate):
                    with self.assertRaises(ingestion.IngestionRefused):
                        ingestion.take_snapshot(root,first,second,handoff_digest=ABC,
                                                 minimum_stable_ns=1_000_000,max_bytes=3)
                self.assertTrue(changed)

    def test_root_close_failure_never_delivers_success_or_native_detail(self):
        real_scan, real_close = os.scandir, os.close
        directory = []
        def scan(fd):
            directory.append(fd)
            return real_scan(fd)
        def close(fd):
            real_close(fd)
            if directory and fd == directory[0]:
                raise OSError(errno.EIO, 'PRIVATE_CLOSE_CANARY')
        with patch.object(ingestion.os, 'scandir', scan), patch.object(ingestion.os, 'supports_fd', os.supports_fd | {scan}), patch.object(ingestion.os, 'close', side_effect=close):
            with self.assertRaisesRegex(ingestion.IngestionRefused, '^inbox_unavailable$'):
                ingestion.observe_inbox(self.root)

    def test_snapshot_bytes_hashes_handoff_and_preserves_source(self):
        source = self.root / 'sample.xlsx'
        source.write_bytes(b'abc')
        first, second = self.observations()
        result = ingestion.take_snapshot(self.root, first, second, handoff_digest=ABC,
                                         minimum_stable_ns=1_000_000)
        self.assertEqual(result.content, b'abc')
        self.assertEqual(result.sha256, ABC)
        self.assertEqual(source.read_bytes(), b'abc')
        source.write_bytes(b'new')
        self.assertEqual(result.content, b'abc')


def test_snapshot_feeds_existing_kernel_without_a_new_parser_or_publish(tmp_path):
    # Composition réelle avec fixture/contrat/Polars/openpyxl existants ; aucun job.
    from test_procedure import fixture
    from memlia_excel.procedure import MEMORY_PROFILE, prepare_procedure
    from memlia_excel.xlsx import read_table
    recipe, sources, targets = fixture()
    source = sources['source']
    inbox = tmp_path.resolve() / 'inbox'; inbox.mkdir()
    path = inbox / 'input.xlsx'; path.write_bytes(source.content)
    first = ingestion.observe_inbox(inbox).candidates[0]; time.sleep(.002)
    second = ingestion.observe_inbox(inbox).candidates[0]
    snapshot = ingestion.take_snapshot(inbox, first, second, handoff_digest=source.sha256,
                                      minimum_stable_ns=1_000_000)
    result = prepare_procedure(recipe, {'source':replace(source, content=snapshot.content,
                                                       sha256=snapshot.sha256)}, targets, profile=MEMORY_PROFILE)
    assert result.status == 'prepared_in_memory' and result.published is False
    output = result.outputs[0]
    table = read_table(output.content, expected_digest=output.sha256[7:], sheet='Result',
                       columns={'id':'string','debit':'decimal','credit':'decimal'}, precision=18, scale=2)
    assert table['id'].to_list() == ['a','b']
    assert [str(value) for value in table['debit']] == ['0.10','0.20']
    assert path.read_bytes() == source.content


if __name__ == '__main__':
    unittest.main()
