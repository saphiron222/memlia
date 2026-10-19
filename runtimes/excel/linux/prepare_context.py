# Copyright (c) 2026 Memlia. All rights reserved.
"""Prepare only native package inputs and locked Linux wheels, never build/pull."""
import importlib.util
import json
from pathlib import Path
import re
import shutil

BASE = re.compile(r"python@sha256:[a-f0-9]{64}\Z")


def prepare(source: Path, wheelhouse: Path, destination: Path, python_image: str) -> dict:
    """Trusted operator paths, not request fields. No compilation or installation."""
    created = False
    try:
        if (type(python_image) is not str or not BASE.fullmatch(python_image)
                or source.is_symlink() or destination.exists() or destination.is_symlink()):
            raise ValueError()
        package_path = source / "runtimes/excel/scripts/package.py"
        if package_path.is_symlink() or package_path.parent.is_symlink():
            raise ValueError()
        spec = importlib.util.spec_from_file_location("memlia_native_package", package_path)
        package = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(package)
        lock = source / "runtimes/excel/requirements.lock"
        selected = package.verify_wheels(lock, wheelhouse, "linux-cp312-x86_64")
        template = Path(__file__).with_name("Dockerfile")
        package.regular(template)
        dockerfile = template.read_text()
        if dockerfile.count("@MEMLIA_PYTHON_BASE@") != 2:
            raise ValueError()
        destination.mkdir(mode=0o700)
        created = True
        package.capture_sources(source, destination / "source")
        for original, relative in [(package_path, "runtimes/excel/scripts/package.py"), (lock, "runtimes/excel/requirements.lock")]:
            package.regular(original)
            target = destination / "source" / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(original, target)
        (destination / "wheels").mkdir()
        for filename, digest in selected:
            target = destination / "wheels" / filename
            shutil.copyfile(wheelhouse / filename, target)
            if package.digest(target) != digest:
                raise ValueError()
        (destination / "Dockerfile").write_text(dockerfile.replace("@MEMLIA_PYTHON_BASE@", python_image))
        # Revalidate the copied lock/wheels, not only their possibly changed source.
        package.verify_wheels(destination / "source/runtimes/excel/requirements.lock", destination / "wheels", "linux-cp312-x86_64")
        files = {p.relative_to(destination).as_posix(): package.digest(p)
                 for p in sorted(destination.rglob("*")) if p.is_file()}
        receipt = {"status": "context_prepared_not_built", "pythonBase": python_image,
                   "profile": "linux-cp312-x86_64", "files": files, "linuxIsolationQualified": False,
                   "lockSha256": files["source/runtimes/excel/requirements.lock"]}
        (destination / "context.json").write_text(json.dumps(receipt, indent=2)+"\n")
        return receipt
    except (OSError, ValueError, ImportError, AttributeError):
        if created:
            shutil.rmtree(destination)
        raise ValueError("excel_image_context_refused") from None
