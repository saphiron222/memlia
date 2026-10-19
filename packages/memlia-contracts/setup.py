# Copyright (c) 2026 Memlia. All rights reserved.
"""Keep the Python wheel's schema set identical to the generated registry."""
import json
from pathlib import Path
from setuptools import setup
from setuptools.command.build_py import build_py

SOURCE = Path(__file__).parent / "python" / "memlia_contracts" / "schemas"


class CheckedBuildPy(build_py):
    def run(self):
        registry = json.loads((SOURCE / "_index.json").read_text(encoding="utf-8"))
        expected = {"_index.json", *(f"{name}.json" for name in registry["contracts"])}
        if {entry.name for entry in SOURCE.iterdir()} != expected:
            raise ValueError("Contract export set mismatch in source package")
        super().run()
        # A stale build directory can retain a deleted schema even when source
        # is clean. Reject that artifact too; do not quietly package it.
        target = Path(self.build_lib) / "memlia_contracts" / "schemas"
        if {entry.name for entry in target.iterdir()} != expected:
            raise ValueError("Contract export set mismatch in built package")


setup(cmdclass={"build_py": CheckedBuildPy})
