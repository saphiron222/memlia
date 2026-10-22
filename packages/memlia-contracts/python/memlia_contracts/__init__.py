# Copyright (c) 2026 Memlia. All rights reserved.
"""Validate wire data using the generated canonical contracts, without coercion.

This is transport validation, not authentication or authorization. Business
admission must resolve references, verify hashes, expiry, revocation and scope.
"""
from importlib.resources import files
import json
from pathlib import Path
from typing import Any
from jsonschema import Draft202012Validator, FormatChecker
from .desktop_digest import desktop_command_digest


def _reject_remote_refs(value: Any) -> None:
    if isinstance(value, dict):
        for key, item in value.items():
            if key in ("$ref", "$dynamicRef") and (not isinstance(item, str) or not item.startswith("#")):
                raise ValueError("Only document-local schema references are allowed")
            _reject_remote_refs(item)
    elif isinstance(value, list):
        for item in value:
            _reject_remote_refs(item)


def load_schema(name: str, schema_directory: Path | None = None) -> dict[str, Any]:
    # This registry is generated from the TS schema registry, not discovered from
    # arbitrary filenames. The exact set is also checked for packaged consumers.
    bundled = files(__package__).joinpath("schemas")
    registry = json.loads(bundled.joinpath("_index.json").read_text(encoding="utf-8"))
    names = registry["contracts"]
    if (registry.get("schemaVersion") != "memlia.contract-index/v1"
            or not isinstance(names, list)
            or any(not isinstance(item, str) or not item.isascii() or not item.isidentifier() for item in names)
            or len(set(names)) != len(names)):
        raise ValueError("Invalid generated contract registry")
    if name not in names:
        raise ValueError("Unknown contract name")
    directory = schema_directory if schema_directory is not None else bundled
    expected = {"_index.json", *(f"{item}.json" for item in names)}
    actual = {entry.name for entry in directory.iterdir()}
    if actual != expected:
        raise ValueError("Contract export set mismatch")
    source = directory.joinpath(f"{name}.json")
    schema = json.loads(source.read_text(encoding="utf-8"))
    _reject_remote_refs(schema)
    Draft202012Validator.check_schema(schema)
    return schema


def validate(name: str, value: Any, *, schema_directory: Path | None = None) -> Any:
    """Return the unchanged value or raise jsonschema.ValidationError."""
    schema = load_schema(name, schema_directory)
    Draft202012Validator(schema, format_checker=FormatChecker()).validate(value)
    return value
