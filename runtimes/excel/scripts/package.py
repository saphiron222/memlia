#!/usr/bin/env python3
# Copyright (c) 2026 Memlia. All rights reserved.
"""Offline assembly of two fixed local packages. Not a job runner or sandbox."""

import argparse
import base64
import csv
import io
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import time
import zipfile

PROFILES = {
    "linux-cp312-x86_64": ("linux", "x86_64"),
    "macos-cp312-arm64": ("darwin", "arm64"),
}
WHEEL = re.compile(
    r"# wheel (linux-cp312-x86_64|macos-cp312-arm64) ([A-Za-z0-9_.-]+\.whl) ([a-f0-9]{64})\Z"
)
PACKAGES = ("packages/memlia-contracts", "runtimes/excel")


class PackagingError(ValueError):
    """Closed administrative error; no source data or child stderr."""


def digest(path):
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def regular(path):
    if path.is_symlink() or not path.is_file():
        raise PackagingError("regular_file_required")


def verify_wheels(lock, wheelhouse, profile):
    if profile not in PROFILES or wheelhouse.is_symlink() or not wheelhouse.is_dir():
        raise PackagingError("wheel_profile_refused")
    regular(lock)
    entries = []
    allowed = set()
    declared = {}
    for line in lock.read_text().splitlines():
        if line.startswith("# wheel "):
            match = WHEEL.fullmatch(line)
            if match is None:
                raise PackagingError("lock_invalid")
            selected, name, sha = match.groups()
            if name.lower().startswith(("memlia_", "memlia-")):
                raise PackagingError("local_package_required")
            allowed.add(name)
            if selected == profile:
                entries.append((name, sha))
        elif line and not line.startswith("#"):
            match = re.fullmatch(
                r"([A-Za-z0-9_.-]+)==([0-9.]+)((?: --hash=sha256:[a-f0-9]{64})+)", line
            )
            if match is None:
                raise PackagingError("lock_invalid")
            name, version, hashes = match.groups()
            name = re.sub(r"[-_.]+", "-", name).lower()
            if name in declared:
                raise PackagingError("lock_invalid")
            declared[name] = (
                version,
                set(re.findall(r"sha256:([a-f0-9]{64})", hashes)),
            )
    names = set()
    for filename, sha in entries:
        name, version, _ = filename.split("-", 2)
        name = name.replace("_", "-").lower()
        if (
            name not in declared
            or declared[name][0] != version
            or sha not in declared[name][1]
        ):
            raise PackagingError("lock_invalid")
        names.add(name)
    if names != set(declared):
        raise PackagingError("lock_invalid")
    if not entries or len({name for name, _ in entries}) != len(entries):
        raise PackagingError("lock_invalid")
    if any(p.name not in allowed for p in wheelhouse.glob("*.whl")):
        raise PackagingError("unexpected_wheel")
    for name, sha in entries:
        regular(wheelhouse / name)
        if digest(wheelhouse / name) != sha:
            raise PackagingError("wheel_hash_mismatch")
    return entries


def capture_sources(root, destination):
    """Copy only these reviewed package inputs, never the checkout wholesale."""
    inventory = {}
    if destination.exists() or destination.is_symlink():
        raise PackagingError("fresh_context_required")
    destination.mkdir(mode=0o700)
    if root.is_symlink():
        raise PackagingError("source_refused")
    for package in PACKAGES:
        folder = root / package
        if any(p.is_symlink() for p in (folder, folder.parent)):
            raise PackagingError("source_refused")
        names = [Path("pyproject.toml")]
        tree = Path("python" if package == PACKAGES[0] else "src")
        if package == PACKAGES[0]:
            names += [Path("setup.py"), Path("LICENSE"), Path("DEPENDENCIES.md")]
        if not (folder / tree).is_dir() or (folder / tree).is_symlink():
            raise PackagingError("source_refused")
        for path in sorted((folder / tree).rglob("*")):
            if path.is_symlink():
                raise PackagingError("source_refused")
            relative = path.relative_to(folder)
            if any(
                part.startswith(".") or part == "__pycache__" for part in relative.parts
            ):
                raise PackagingError("source_refused")
            if path.is_dir():
                continue
            if path.suffix not in (".py", ".json") or path.stat().st_size > 2 * 1024**2:
                raise PackagingError("source_refused")
            names.append(relative)
        for relative in names:
            original = folder / relative
            regular(original)
            target = destination / package / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(original, target)
            inventory[f"{package}/{relative.as_posix()}"] = digest(target)
    return inventory


def verify_local_wheels(wheels, source):
    """Compare fixed local wheels to source and native backend metadata before install."""
    expected = {
        "memlia_contracts-0.1.0-py3-none-any.whl": source
        / PACKAGES[0]
        / "python"
        / "memlia_contracts",
        "memlia_excel-0.1.0-py3-none-any.whl": source
        / PACKAGES[1]
        / "src"
        / "memlia_excel",
    }
    if {p.name for p in wheels.iterdir()} != set(expected):
        raise PackagingError("local_wheel_set_mismatch")
    result = {}
    for filename, tree in expected.items():
        path = wheels / filename
        regular(path)
        with zipfile.ZipFile(path) as archive:
            names = archive.namelist()
            if len(set(names)) != len(names) or any(
                n.startswith("/") or ".." in n.split("/") for n in names
            ):
                raise PackagingError("local_wheel_invalid")
            actual = {n for n in names if ".dist-info/" not in n}
            sources = {
                p.relative_to(tree.parent).as_posix(): p
                for p in tree.rglob("*")
                if p.is_file()
            }
            if actual != set(sources) or any(
                archive.read(n) != p.read_bytes() for n, p in sources.items()
            ):
                raise PackagingError("local_wheel_source_mismatch")
            # These are the two fixed pure-Python distributions built by the
            # pinned setuptools backend, not an arbitrary wheel validator.
            prefix = filename.removesuffix("-py3-none-any.whl") + ".dist-info/"
            egg = tree.parent / (tree.name + ".egg-info")
            metadata = {}
            for target, origin in (
                ("METADATA", "PKG-INFO"),
                ("top_level.txt", "top_level.txt"),
            ):
                native = egg / origin
                regular(native)
                metadata[prefix + target] = native.read_bytes()
            # Native bdist_wheel.write_wheelfile output for our locked backend
            # and pure py3-none-any profile. No dependency parser is duplicated.
            metadata[prefix + "WHEEL"] = (
                b"Wheel-Version: 1.0\nGenerator: setuptools (80.9.0)\n"
                b"Root-Is-Purelib: true\nTag: py3-none-any\n\n"
            )
            if tree.name == "memlia_contracts":
                license_file = source / PACKAGES[0] / "LICENSE"
                regular(license_file)
                metadata[prefix + "licenses/LICENSE"] = license_file.read_bytes()
            record = prefix + "RECORD"
            if set(names) != set(sources) | set(metadata) | {record}:
                raise PackagingError("local_wheel_metadata_invalid")
            if any(
                archive.getinfo(n).file_size != len(data) or archive.read(n) != data
                for n, data in metadata.items()
            ):
                raise PackagingError("local_wheel_metadata_mismatch")
            # RECORD alone is not provenance. Only after checking the native
            # source/metadata bytes do we verify its exact closed inventory.
            rows = io.StringIO(newline="")
            writer = csv.writer(rows, lineterminator="\n")
            for name in names:
                if name != record:
                    data = archive.read(name)
                    sha = (
                        base64.urlsafe_b64encode(hashlib.sha256(data).digest())
                        .rstrip(b"=")
                        .decode("ascii")
                    )
                    writer.writerow((name, "sha256=" + sha, len(data)))
            writer.writerow((record, "", ""))
            expected_record = rows.getvalue().encode("utf-8")
            if (
                archive.getinfo(record).file_size != len(expected_record)
                or archive.read(record) != expected_record
            ):
                raise PackagingError("local_wheel_record_mismatch")
        result[filename] = digest(path)
    return result


def assemble(root, wheelhouse, output, profile):
    if sys.version_info[:2] != (3, 12) or PROFILES.get(profile) != (
        sys.platform,
        platform.machine(),
    ):
        raise PackagingError("native_profile_required")
    entries = verify_wheels(
        root / "runtimes/excel/requirements.lock", wheelhouse, profile
    )
    # Exclusive output owns all following writes. Never erase an existing tree.
    if output.exists() or output.is_symlink():
        raise PackagingError("fresh_output_required")
    output.mkdir(mode=0o700)
    output = output.resolve()
    temporary = output / "tmp"
    temporary.mkdir(mode=0o700)
    env = {
        "PATH": os.defpath,
        "HOME": str(output),
        "TMPDIR": str(temporary),
        "PIP_CONFIG_FILE": os.devnull,
        "PIP_NO_INDEX": "1",
        "PIP_NO_CACHE_DIR": "1",
        "PIP_DISABLE_PIP_VERSION_CHECK": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONNOUSERSITE": "1",
        "POLARS_MAX_THREADS": "1",
    }
    deadline = time.monotonic() + 120

    def run(argv):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise PackagingError("packaging_timeout")
        # A parent ownership supervisor remains required for descendants.
        with (output / "build.log").open("ab") as log:
            try:
                completed = subprocess.run(
                    argv,
                    cwd=output,
                    env=env,
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    timeout=remaining,
                )
            except subprocess.TimeoutExpired:
                raise PackagingError("packaging_timeout") from None
        if completed.returncode:
            raise PackagingError("packaging_command_failed")

    source = output / "source"
    inventory = capture_sources(root, source)
    local = output / "local-wheels"
    local.mkdir()
    cached = output / "third-party"
    cached.mkdir()
    for name, sha in entries:
        shutil.copyfile(wheelhouse / name, cached / name)
        if digest(cached / name) != sha:
            raise PackagingError("wheel_hash_mismatch")
    requirements = output / "installed-wheels.txt"
    requirements.write_text(
        "\n".join(
            f"{(cached / name).as_uri()} --hash=sha256:{sha}" for name, sha in entries
        )
        + "\n"
    )
    builder = output / "builder"
    runtime = output / "runtime"
    for venv in (builder, runtime):
        selected = [
            (name, sha)
            for name, sha in entries
            if venv == builder
            or not name.startswith(("setuptools-", "wheel-", "packaging-"))
        ]
        requirements = output / (venv.name + "-requirements.txt")
        requirements.write_text(
            "\n".join(
                f"{(cached / name).as_uri()} --hash=sha256:{sha}"
                for name, sha in selected
            )
            + "\n"
        )
        run([sys.executable, "-I", "-B", "-m", "venv", str(venv)])
        python = str(venv / "bin/python")
        run(
            [
                python,
                "-I",
                "-B",
                "-m",
                "pip",
                "install",
                "--no-index",
                "--no-deps",
                "--require-hashes",
                "-r",
                str(requirements),
            ]
        )
    python = str(builder / "bin/python")
    for package in PACKAGES:
        run(
            [
                python,
                "-I",
                "-B",
                "-m",
                "pip",
                "wheel",
                "--no-index",
                "--no-deps",
                "--no-build-isolation",
                "--wheel-dir",
                str(local),
                str(source / package),
            ]
        )
    hashes = verify_local_wheels(local, source)
    requirements = output / "local-wheels.txt"
    requirements.write_text(
        "\n".join(
            f"{(local / name).as_uri()} --hash=sha256:{sha}"
            for name, sha in hashes.items()
        )
        + "\n"
    )
    python = str(runtime / "bin/python")
    run(
        [
            python,
            "-I",
            "-B",
            "-m",
            "pip",
            "install",
            "--no-index",
            "--no-deps",
            "--require-hashes",
            "-r",
            str(requirements),
        ]
    )
    run([python, "-I", "-B", "-m", "pip", "check"])
    # Load the installed registry with no checkout path; wheel bytes were checked above.
    run(
        [
            python,
            "-I",
            "-B",
            "-c",
            "from memlia_contracts import load_schema; load_schema('ExcelProcedure'); "
            "import memlia_excel.procedure",
        ]
    )
    if any(temporary.iterdir()):
        raise PackagingError("temporary_cleanup_incomplete")
    receipt = {
        "status": "installed",
        "profile": profile,
        "python": platform.python_version(),
        "sourceFiles": inventory,
        "sourceInventorySha256": hashlib.sha256(
            json.dumps(inventory, sort_keys=True).encode()
        ).hexdigest(),
        "lockSha256": digest(root / "runtimes/excel/requirements.lock"),
        "localWheels": hashes,
        "thirdPartyWheels": dict(entries),
        "networkInstallation": False,
        "osIsolationQualified": False,
    }
    (output / "manifest.json").write_text(json.dumps(receipt, indent=2) + "\n")
    return receipt


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--wheelhouse", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--profile", choices=PROFILES, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    try:
        assemble(args.source, args.wheelhouse, args.output, args.profile)
    except (PackagingError, OSError, ValueError, zipfile.BadZipFile):
        print("packaging_failed", file=sys.stderr)
        sys.exit(1)
    print("packaging_installed")
