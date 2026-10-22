# Copyright (c) 2026 Memlia. All rights reserved.
"""Installed-package tests; no provider, database or user workbook."""

import email
import base64
import csv
import io
import ast
import hashlib
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[3]


class PackagingTests(unittest.TestCase):
    def test_excel_wheel_declares_canonical_contract_dependency(self):
        # Native setuptools build, not a missing-module test. Run with the
        # reviewed build backend already installed; never resolve dependencies.
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            source = work / "source"
            source.mkdir()
            shutil.copy(ROOT / "runtimes/excel/pyproject.toml", source)
            shutil.copytree(ROOT / "runtimes/excel/src", source / "src")
            env = {
                "PATH": os.defpath,
                "PIP_CONFIG_FILE": os.devnull,
                "PIP_NO_INDEX": "1",
                "PYTHONDONTWRITEBYTECODE": "1",
            }
            build = subprocess.run(
                [
                    os.environ.get("MEMLIA_TEST_BUILD_PYTHON", sys.executable),
                    "-I",
                    "-m",
                    "pip",
                    "wheel",
                    "--no-index",
                    "--no-deps",
                    "--no-build-isolation",
                    "--wheel-dir",
                    str(work / "wheels"),
                    str(source),
                ],
                env=env,
                cwd=work,
                capture_output=True,
                text=True,
                timeout=60,
            )
            self.assertEqual(build.returncode, 0, build.stderr)
            (wheel,) = (work / "wheels").glob("*.whl")
            with zipfile.ZipFile(wheel) as archive:
                (metadata,) = [
                    name
                    for name in archive.namelist()
                    if name.endswith(".dist-info/METADATA")
                ]
                message = email.message_from_bytes(archive.read(metadata))
            self.assertIn("memlia-contracts==0.1.0", message.get_all("Requires-Dist"))


def packager():
    spec = importlib.util.spec_from_file_location(
        "excel_package", ROOT / "runtimes/excel/scripts/package.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class PackageBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.work = Path(self.temp.name)
        self.module = packager()

    def wheel_fixture(self):
        wheelhouse = self.work / "wheels"
        wheelhouse.mkdir()
        wheel = wheelhouse / "example-1.0-py3-none-any.whl"
        wheel.write_bytes(b"fixture-not-installed")
        lock = self.work / "requirements.lock"
        lock.write_text(
            "# wheel macos-cp312-arm64 "
            + wheel.name
            + " "
            + hashlib.sha256(wheel.read_bytes()).hexdigest()
            + "\nexample==1.0 --hash=sha256:"
            + hashlib.sha256(wheel.read_bytes()).hexdigest()
            + "\n"
        )
        return lock, wheelhouse, wheel

    def test_lock_requirement_and_selected_wheel_must_agree(self):
        house = Path(os.environ["MEMLIA_TEST_WHEELHOUSE"])
        lock = self.work / "requirements.lock"
        original = (ROOT / "runtimes/excel/requirements.lock").read_text()
        lock.write_text(original.replace("openpyxl==3.1.5", "openpyxl==3.1.4"))
        with self.assertRaisesRegex(self.module.PackagingError, "lock_invalid"):
            self.module.verify_wheels(lock, house, "macos-cp312-arm64")

    def test_missing_wheel_and_wrong_hash_refuse_before_install(self):
        lock, house, wheel = self.wheel_fixture()
        wheel.write_bytes(b"wrong")
        with self.assertRaisesRegex(self.module.PackagingError, "wheel_hash_mismatch"):
            self.module.verify_wheels(lock, house, "macos-cp312-arm64")
        wheel.unlink()
        with self.assertRaisesRegex(
            self.module.PackagingError, "regular_file_required"
        ):
            self.module.verify_wheels(lock, house, "macos-cp312-arm64")

    def test_foreign_contract_wheel_never_used_as_fallback(self):
        lock, house, _ = self.wheel_fixture()
        (house / "memlia_contracts-0.1.0-py3-none-any.whl").write_bytes(b"foreign")
        with self.assertRaisesRegex(self.module.PackagingError, "unexpected_wheel"):
            self.module.verify_wheels(lock, house, "macos-cp312-arm64")
        lock.write_text(
            "# wheel macos-cp312-arm64 memlia_contracts-0.1.0-py3-none-any.whl "
            + "a" * 64
            + "\n"
        )
        with self.assertRaisesRegex(
            self.module.PackagingError, "local_package_required"
        ):
            self.module.verify_wheels(lock, house, "macos-cp312-arm64")

    def test_unrecognized_profile_duplicate_and_malformed_lock_refused(self):
        lock, house, _ = self.wheel_fixture()
        with self.assertRaisesRegex(
            self.module.PackagingError, "wheel_profile_refused"
        ):
            self.module.verify_wheels(lock, house, "anything")
        lock.write_text(lock.read_text() * 2)
        with self.assertRaisesRegex(self.module.PackagingError, "lock_invalid"):
            self.module.verify_wheels(lock, house, "macos-cp312-arm64")
        lock.write_text("# wheel macos-cp312-arm64 ../escape.whl " + "a" * 64 + "\n")
        with self.assertRaisesRegex(self.module.PackagingError, "lock_invalid"):
            self.module.verify_wheels(lock, house, "macos-cp312-arm64")

    def test_source_contract_absent_or_secret_named_or_link_refused(self):
        source = self.work / "source"
        self.module.capture_sources(ROOT, source)
        contract = source / "packages/memlia-contracts/python/memlia_contracts"
        secret = contract / ".env"
        secret.write_text("private fixture")
        with self.assertRaisesRegex(self.module.PackagingError, "source_refused"):
            self.module.capture_sources(source, self.work / "copy1")
        secret.unlink()
        (contract / "linked.py").symlink_to(contract / "__init__.py")
        with self.assertRaisesRegex(self.module.PackagingError, "source_refused"):
            self.module.capture_sources(source, self.work / "copy2")
        (contract / "linked.py").unlink()
        shutil.rmtree(source / "packages/memlia-contracts")
        with self.assertRaisesRegex(self.module.PackagingError, "source_refused"):
            self.module.capture_sources(source, self.work / "copy3")

    def test_foreign_local_wheel_bytes_refused(self):
        source = self.work / "source"
        self.module.capture_sources(ROOT, source)
        wheels = self.work / "local"
        wheels.mkdir()
        for name in ("memlia_excel", "memlia_contracts"):
            with zipfile.ZipFile(
                wheels / f"{name}-0.1.0-py3-none-any.whl", "w"
            ) as archive:
                archive.writestr(name + "/__init__.py", "# foreign")
        with self.assertRaisesRegex(
            self.module.PackagingError, "local_wheel_source_mismatch"
        ):
            self.module.verify_local_wheels(wheels, source)


class LocalWheelIntegrityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temporary.cleanup)
        cls.work = Path(cls.temporary.name)
        cls.module = packager()
        cls.source = cls.work / "source"
        cls.module.capture_sources(ROOT, cls.source)
        cls.wheels = cls.work / "original"
        cls.wheels.mkdir()
        env = {
            "PATH": os.defpath,
            "PIP_CONFIG_FILE": os.devnull,
            "PIP_NO_INDEX": "1",
            "PYTHONDONTWRITEBYTECODE": "1",
        }
        for package in cls.module.PACKAGES:
            result = subprocess.run(
                [
                    os.environ.get("MEMLIA_TEST_BUILD_PYTHON", sys.executable),
                    "-I",
                    "-B",
                    "-m",
                    "pip",
                    "wheel",
                    "--no-index",
                    "--no-deps",
                    "--no-build-isolation",
                    "--wheel-dir",
                    str(cls.wheels),
                    str(cls.source / package),
                ],
                cwd=cls.work,
                env=env,
                capture_output=True,
                timeout=60,
            )
            if result.returncode:
                raise AssertionError("Native fixture wheel build failed")
        cls.module.verify_local_wheels(cls.wheels, cls.source)

    def changed(self, change):
        # Only mutate copied ZIP bytes. Never install or import forged artifacts.
        destination = self.work / self.id().split(".")[-1]
        shutil.copytree(self.wheels, destination)
        wheel = destination / "memlia_contracts-0.1.0-py3-none-any.whl"
        with zipfile.ZipFile(wheel) as archive:
            entries = {name: archive.read(name) for name in archive.namelist()}
        change(entries, "memlia_contracts-0.1.0.dist-info/")
        # RECORD is self-reported integrity, not provenance: keep it coherent
        # so these negatives must fail on metadata/licence comparison itself.
        record = "memlia_contracts-0.1.0.dist-info/RECORD"
        rows = io.StringIO(newline="")
        writer = csv.writer(rows, lineterminator="\n")
        for name, data in entries.items():
            if name != record:
                sha = (
                    base64.urlsafe_b64encode(hashlib.sha256(data).digest())
                    .rstrip(b"=")
                    .decode("ascii")
                )
                writer.writerow((name, "sha256=" + sha, len(data)))
        writer.writerow((record, "", ""))
        entries[record] = rows.getvalue().encode("utf-8")
        with zipfile.ZipFile(wheel, "w") as archive:
            for name, data in entries.items():
                archive.writestr(name, data)
        return destination

    def test_changed_canonical_license_is_refused(self):
        wheels = self.changed(
            lambda files, prefix: files.__setitem__(
                prefix + "licenses/LICENSE",
                b"Altered fixture license, not redistributable",
            )
        )
        with self.assertRaisesRegex(
            self.module.PackagingError, "local_wheel_metadata_mismatch"
        ):
            self.module.verify_local_wheels(wheels, self.source)

    def test_added_console_entrypoint_is_refused(self):
        wheels = self.changed(
            lambda files, prefix: files.__setitem__(
                prefix + "entry_points.txt",
                b"[console_scripts]\nfixture=memlia_contracts:unused\n",
            )
        )
        with self.assertRaisesRegex(
            self.module.PackagingError, "local_wheel_metadata_invalid"
        ):
            self.module.verify_local_wheels(wheels, self.source)

    def test_native_metadata_and_canonical_license_are_accepted(self):
        self.assertEqual(
            len(self.module.verify_local_wheels(self.wheels, self.source)), 2
        )

    def test_altered_dependency_metadata_is_refused(self):
        def change(files, prefix):
            files[prefix + "METADATA"] = files[prefix + "METADATA"].replace(
                b"jsonschema==4.26.0", b"foreign-fixture==0.0.0"
            )

        with self.assertRaises(self.module.PackagingError):
            self.module.verify_local_wheels(self.changed(change), self.source)

    def test_other_dist_info_directory_is_refused(self):
        wheels = self.changed(
            lambda files, prefix: files.__setitem__(
                "foreign-0.1.0.dist-info/entry_points.txt",
                b"[console_scripts]\nfixture=unused:unused\n",
            )
        )
        with self.assertRaises(self.module.PackagingError):
            self.module.verify_local_wheels(wheels, self.source)

    def test_altered_wheel_installation_profile_is_refused(self):
        def change(files, prefix):
            files[prefix + "WHEEL"] = files[prefix + "WHEEL"].replace(
                b"Root-Is-Purelib: true", b"Root-Is-Purelib: false"
            )

        with self.assertRaises(self.module.PackagingError):
            self.module.verify_local_wheels(self.changed(change), self.source)

    def test_incomplete_record_is_refused(self):
        wheels = self.changed(lambda files, prefix: None)
        wheel = wheels / "memlia_contracts-0.1.0-py3-none-any.whl"
        with zipfile.ZipFile(wheel) as archive:
            entries = {name: archive.read(name) for name in archive.namelist()}
        entries["memlia_contracts-0.1.0.dist-info/RECORD"] = b""
        with zipfile.ZipFile(wheel, "w") as archive:
            for name, data in entries.items():
                archive.writestr(name, data)
        with self.assertRaisesRegex(
            self.module.PackagingError, "local_wheel_record_mismatch"
        ):
            self.module.verify_local_wheels(wheels, self.source)


class OfflineInstallationTests(unittest.TestCase):
    def test_real_offline_install_and_native_procedure_without_source_path(self):
        # Explicit external artifact input; a missing cache is an error, never a skip.
        wheelhouse = Path(os.environ["MEMLIA_TEST_WHEELHOUSE"])
        module = packager()
        profile = (
            "macos-cp312-arm64" if sys.platform == "darwin" else "linux-cp312-x86_64"
        )
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            receipt = module.assemble(ROOT, wheelhouse, work / "assembled", profile)
            self.assertEqual(receipt["status"], "installed")
            self.assertFalse(receipt["osIsolationQualified"])
            self.assertEqual(len(receipt["localWheels"]), 2)
            # Reuse the existing canonical fixture constructor, not a second IR.
            fixture_source = (
                ROOT / "runtimes/excel/tests/test_procedure.py"
            ).read_text()
            tree = ast.parse(fixture_source)
            builders = "\n".join(
                ast.get_source_segment(fixture_source, node)
                for node in tree.body
                if isinstance(node, ast.FunctionDef)
                and node.name in ("workbook", "fixture")
            )
            code = (
                """from copy import deepcopy
from hashlib import sha256
from io import BytesIO
from pathlib import Path
import importlib.resources, json, shutil, sys, tempfile
import openpyxl
import memlia_contracts, memlia_excel.procedure
from memlia_contracts import validate, load_schema
from memlia_excel.procedure import ResolvedXlsx, OutputTarget, prepare_procedure, MEMORY_PROFILE
"""
                + builders
                + """
assert Path(memlia_contracts.__file__).resolve().is_relative_to(Path(sys.prefix).resolve())
assert Path(memlia_excel.procedure.__file__).resolve().is_relative_to(Path(sys.prefix).resolve())
recipe, sources, targets = fixture()
result = prepare_procedure(recipe, sources, targets, profile=MEMORY_PROFILE)
assert result.status == 'prepared_in_memory' and result.published is False
book = openpyxl.load_workbook(BytesIO(result.outputs[0].content), read_only=True)
assert list(book.active.values) == [('id','debit','credit'),('a','0.10','0.10'),('b','0.20','0.20')]
book.close()
# A real remote reference in a copied schema must be rejected, never retrieved.
with tempfile.TemporaryDirectory() as directory:
    schemas = Path(directory) / 'schemas'
    shutil.copytree(importlib.resources.files(memlia_contracts).joinpath('schemas'), schemas)
    (schemas / 'ExcelProcedure.json').write_text('{"$ref":"https://example.invalid/canary"}')
    try: load_schema('ExcelProcedure', schema_directory=schemas)
    except ValueError as error: assert str(error) == 'Only document-local schema references are allowed'
    else: raise AssertionError('remote reference accepted')
print('installed_native_procedure_verified')
"""
            )
            # The same installed runtime must also cross the declarative process
            # boundary. Keep the direct-kernel assertions above unchanged.
            code += r"""
import base64, os, subprocess
original_sources = {role: value.content for role, value in sources.items()}
envelope = {
    "schemaVersion": "memlia.excel-process/v1",
    "requestId": "installed-process-fixture",
    "profile": MEMORY_PROFILE,
    "procedure": recipe,
    "sources": {role: {
        "bindingId": value.binding_id, "sheetId": value.sheet_id,
        "sheetName": value.sheet_name,
        "contentBase64": base64.b64encode(value.content).decode("ascii"),
        "sha256": value.sha256,
    } for role, value in sources.items()},
    "targets": {role: {
        "bindingId": value.binding_id, "sheetId": value.sheet_id,
        "sheetName": value.sheet_name,
    } for role, value in targets.items()},
}
wire = json.dumps(envelope, separators=(",", ":")).encode("utf-8")
def exchange(payload):
    return subprocess.run(
        [sys.executable, "-I", "-B", "-m", "memlia_excel.process"],
        input=payload, capture_output=True, timeout=10,
        env={"PATH": os.defpath, "TMPDIR": os.environ["TMPDIR"],
             "HOME": os.environ["TMPDIR"], "POLARS_MAX_THREADS": "1"},
        cwd=Path.cwd(),
    )
child = exchange(wire)
assert child.returncode == 0 and child.stderr == b"", "installed process failed"
answer = json.loads(child.stdout)
assert set(answer) == {"schemaVersion", "requestId", "status", "published", "outputs", "controls"}
assert answer["schemaVersion"] == "memlia.excel-process/v1"
assert answer["requestId"] == "installed-process-fixture"
assert answer["status"] == "prepared_in_memory" and answer["published"] is False
assert len(answer["outputs"]) == 1
output = answer["outputs"][0]
assert set(output) == {"role", "bindingId", "sheetId", "contentBase64", "sha256"}
assert (output["role"], output["bindingId"], output["sheetId"]) == ("result", "result-binding", "result-sheet")
content = base64.b64decode(output["contentBase64"], validate=True)
assert content and output["sha256"] == "sha256:" + sha256(content).hexdigest()
assert answer["controls"] == [{"index": 0, "kind": "balance", "severity": "blocking", "satisfied": True}]
book = openpyxl.load_workbook(BytesIO(content), read_only=True)
assert list(book.active.values) == [('id','debit','credit'),('a','0.10','0.10'),('b','0.20','0.20')]
book.close()
assert {role: value.content for role, value in sources.items()} == original_sources
unknown = deepcopy(envelope)
unknown["command"] = "fixture-must-not-execute"
for rejected in (json.dumps(unknown).encode("utf-8"), wire + b" {}"):
    child = exchange(rejected)
    assert child.returncode == 2 and child.stderr == b"", "process refusal failed"
    assert json.loads(child.stdout) == {
        "schemaVersion": "memlia.excel-process/v1", "status": "refused", "code": "invalid_request"
    }
assert list(Path(os.environ["TMPDIR"]).iterdir()) == []
"""
            outside = work / "outside"
            outside.mkdir()
            temporary = work / "owned-tmp"
            temporary.mkdir(mode=0o700)
            python = work / "assembled/runtime/bin/python"
            env = {
                "PATH": os.defpath,
                "TMPDIR": str(temporary),
                "POLARS_MAX_THREADS": "1",
            }
            result = subprocess.run(
                [str(python), "-I", "-B", "-c", code],
                cwd=outside,
                env=env,
                capture_output=True,
                text=True,
                timeout=30,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(
                result.stdout.strip(), "installed_native_procedure_verified"
            )
            self.assertEqual(list(temporary.iterdir()), [])
            self.assertEqual(temporary.stat().st_mode & 0o777, 0o700)
            with self.assertRaisesRegex(module.PackagingError, "fresh_output_required"):
                module.assemble(ROOT, wheelhouse, work / "assembled", profile)
            self.assertEqual(
                module.verify_wheels(
                    ROOT / "runtimes/excel/requirements.lock",
                    wheelhouse,
                    "linux-cp312-x86_64",
                ).__len__(),
                15,
            )


if __name__ == "__main__":
    unittest.main()
