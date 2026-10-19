# Copyright (c) 2026 Memlia. All rights reserved.
"""Portable corpus validator: read [{name,value}] and write boolean outcomes."""
import json
from pathlib import Path
import sys
from jsonschema import ValidationError
from . import validate


def reject_non_json(value: str) -> None:
    raise ValueError(f"Non-JSON numeric value: {value}")


directory = Path(sys.argv[1]) if len(sys.argv) > 1 else None
cases = json.load(sys.stdin, parse_constant=reject_non_json)
results = []
for case in cases:
    try:
        validate(case["name"], case["value"], schema_directory=directory)
        results.append(True)
    except ValidationError:
        results.append(False)
json.dump(results, sys.stdout, allow_nan=False)
