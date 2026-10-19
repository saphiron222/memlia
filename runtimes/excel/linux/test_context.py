# Copyright (c) 2026 Memlia. All rights reserved.
"""Real source/wheel hash capture, no Docker or Linux installation."""
import hashlib
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("excel_context", Path(__file__).with_name("prepare_context.py"))
c = importlib.util.module_from_spec(spec); spec.loader.exec_module(c)
BASE = "python@sha256:" + "d"*64  # syntactic fixture only; never pulled or built

class ContextTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.out = Path(self.temp.name)/"context"
        self.wheels = Path(os.environ["MEMLIA_TEST_WHEELHOUSE"])

    def test_real_native_capture_and_linux_locked_wheels_only(self):
        receipt = c.prepare(ROOT, self.wheels, self.out, BASE)
        self.assertEqual(receipt["status"], "context_prepared_not_built")
        self.assertFalse(receipt["linuxIsolationQualified"])
        self.assertEqual(receipt["pythonBase"], BASE)
        self.assertTrue((self.out/"source/runtimes/excel/src/memlia_excel/process.py").is_file())
        self.assertFalse((self.out/"source/apps").exists())
        for relative, digest in receipt["files"].items():
            self.assertEqual(hashlib.sha256((self.out/relative).read_bytes()).hexdigest(), digest)
        dockerfile = (self.out/"Dockerfile").read_text()
        self.assertEqual(dockerfile.count("FROM --platform=linux/amd64 " + BASE), 2)
        self.assertIn("RUN --network=none", dockerfile)
        self.assertIn('"/source/runtimes/excel/scripts/package.py"', dockerfile)
        self.assertIn("USER 65532:65532", dockerfile)
        self.assertNotIn("COPY . ", dockerfile)
        names = [p.name for p in (self.out/"wheels").iterdir()]
        self.assertFalse(any("macosx" in n or n.startswith("memlia_") for n in names))
        self.assertTrue(any("manylinux" in n for n in names))
        self.assertEqual(self.out.stat().st_mode & 0o777, 0o700)

    def test_tag_or_arbitrary_base_refused_before_creation(self):
        for base in ["python:3.12", "other@sha256:"+"d"*64, BASE+"\nRUN bad", "python@sha256:"+"D"*64]:
            with self.subTest(base=base[:16]), self.assertRaisesRegex(ValueError, "^excel_image_context_refused$"):
                c.prepare(ROOT, self.wheels, self.out, base)
            self.assertFalse(self.out.exists())

    def test_existing_or_symlink_destination_preserved(self):
        self.out.mkdir(); sentinel=self.out/"owned-by-other";sentinel.write_text("preserve")
        with self.assertRaises(ValueError):
            c.prepare(ROOT, self.wheels, self.out, BASE)
        self.assertEqual(sentinel.read_text(), "preserve")
        link=Path(self.temp.name)/"link";link.symlink_to(self.out, target_is_directory=True)
        with self.assertRaises(ValueError):
            c.prepare(ROOT, self.wheels, link, BASE)
        self.assertEqual(sentinel.read_text(), "preserve")

    def test_source_symlink_and_missing_wheels_refused(self):
        alias=Path(self.temp.name)/"alias";alias.symlink_to(ROOT, target_is_directory=True)
        with self.assertRaises(ValueError):
            c.prepare(alias, self.wheels, self.out, BASE)
        missing=Path(self.temp.name)/"missing";missing.mkdir()
        with self.assertRaises(ValueError):
            c.prepare(ROOT, missing, self.out, BASE)
        self.assertFalse(self.out.exists())

class RuntimeOwnershipTests(unittest.TestCase):
    setUp = ContextTests.setUp
    # Configuration invariant only; does not claim to execute Docker or chown.
    def test_rendered_runtime_copies_match_non_root_user_without_widening_modes(self):
        import shlex
        c.prepare(ROOT, self.wheels, self.out, BASE)
        lines = (self.out / "Dockerfile").read_text().splitlines()
        user = next(line.split()[1] for line in lines if line.startswith("USER "))
        self.assertEqual(user, "65532:65532")
        copies = [shlex.split(line) for line in lines if line.startswith("COPY --from=builder ")]
        self.assertEqual(len(copies), 2)
        self.assertEqual({tuple(tokens[-2:]) for tokens in copies}, {
            ("/opt/excel/runtime", "/opt/excel/runtime"),
            ("/opt/excel/manifest.json", "/opt/excel/manifest.json"),
        })
        for tokens in copies:
            self.assertIn("--chown=" + user, tokens)
            self.assertFalse(any(token.startswith("--chmod") for token in tokens))
        self.assertFalse(any(line.startswith("RUN ") for line in lines[lines.index("USER " + user):]))


if __name__ == "__main__":
    unittest.main()
