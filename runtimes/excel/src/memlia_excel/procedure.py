# Copyright (c) 2026 Memlia. All rights reserved.
"""Whole-procedure preparation on owned bytes; never publication or authority."""

from dataclasses import dataclass
from decimal import localcontext
from hashlib import sha256
import json
import math
import re
from time import monotonic
from typing import Any

from memlia_contracts import validate
import polars as pl

from .tables import apply_operation, decimal_series
from .xlsx import read_table, write_table

MEMORY_PROFILE = "memlia.excel-memory/a1-header-v1"
_SUPPORTED = {"select", "cast", "join", "aggregate", "sort", "derive", "filter"}


class ProcedureError(ValueError):
    """Fixed refusal code; no cell, path or underlying library exception."""


@dataclass(frozen=True)
class ResolvedXlsx:
    binding_id: str
    sheet_id: str
    sheet_name: str
    content: bytes
    sha256: str


@dataclass(frozen=True)
class OutputTarget:
    binding_id: str
    sheet_id: str
    sheet_name: str


@dataclass(frozen=True)
class ControlObservation:
    index: int
    kind: str
    severity: str
    satisfied: bool


@dataclass(frozen=True)
class PreparedOutput:
    role: str
    binding_id: str
    sheet_id: str
    content: bytes
    sha256: str


@dataclass(frozen=True)
class PreparedProcedure:
    outputs: tuple[PreparedOutput, ...]
    controls: tuple[ControlObservation, ...]
    status: str = "prepared_in_memory"
    published: bool = False


def _require(condition: bool, code: str) -> None:
    if not condition:
        raise ProcedureError(code)


def _capture(value: Any) -> Any:
    """Own JSON primitives without invoking custom iteration/serialization hooks."""
    nodes = 0
    size = 0
    ancestors: set[int] = set()

    def copy(item: Any, depth: int) -> Any:
        nonlocal nodes, size
        nodes += 1
        _require(depth <= 32 and nodes <= 25000, "input_limit")
        kind = type(item)
        if kind is str:
            size += len(item.encode("utf-8"))
            _require(size <= 512 * 1024, "input_limit")
            return item
        if item is None or kind is bool:
            return item
        if kind is int:
            _require(abs(item) <= 9007199254740991, "invalid_input")
            return item
        if kind is float:
            _require(math.isfinite(item), "invalid_input")
            return item
        _require(kind in (dict, list) and id(item) not in ancestors, "invalid_input")
        ancestors.add(id(item))
        try:
            if kind is list:
                return [copy(entry, depth + 1) for entry in item]
            _require(all(type(key) is str for key in item), "invalid_input")
            return {
                copy(key, depth + 1): copy(entry, depth + 1)
                for key, entry in item.items()
            }
        finally:
            ancestors.remove(id(item))

    result = copy(value, 0)
    _require(
        len(json.dumps(result, ensure_ascii=False).encode("utf-8")) <= 512 * 1024,
        "input_limit",
    )
    return result


def _resolved(values: Any, kind: type) -> dict:
    _require(type(values) is dict and len(values) <= 32, "resolved_input")
    result = {}
    total_bytes = 0
    for role, value in values.items():
        _require(type(role) is str and type(value) is kind, "resolved_input")
        fields = (value.binding_id, value.sheet_id, value.sheet_name)
        _require(
            all(type(item) is str and 0 < len(item) <= 128 for item in fields),
            "resolved_input",
        )
        _require(
            len(fields[2]) <= 31 and re.search(r"[\\/*?:\[\]]", fields[2]) is None,
            "resolved_input",
        )
        if kind is ResolvedXlsx:
            content, digest = value.content, value.sha256
            _require(type(content) is bytes and type(digest) is str, "resolved_input")
            _require(
                re.fullmatch(r"sha256:[0-9a-f]{64}", digest) is not None,
                "resolved_input",
            )
            total_bytes += len(content)
            _require(total_bytes <= 10000000, "input_limit")
            result[role] = ResolvedXlsx(*fields, content, digest)
        else:
            result[role] = OutputTarget(*fields)
    return result


def _names(names: list[str]) -> None:
    _require(len(names) == len(set(names)), "column_duplicate")


def _columns(frame: pl.DataFrame, names: list[str]) -> None:
    _names(names)
    _require(set(names) <= set(frame.columns), "column_missing")


def _unique(frame: pl.DataFrame, names: list[str], *, non_null: bool) -> bool:
    _columns(frame, names)
    selected = frame.select(names)
    return (
        not non_null or all(selected[name].null_count() == 0 for name in names)
    ) and selected.n_unique() == frame.height


def _supported_expression(expr: dict) -> None:
    kind = expr["kind"]
    _require(
        kind in {"col", "literal", "comparison", "arithmetic"}, "unsupported_expression"
    )
    if kind == "literal":
        _require(expr["value"]["kind"] != "date", "unsupported_expression")
    if kind in {"comparison", "arithmetic"}:
        if kind == "arithmetic":
            _require(expr["operator"] in {"add", "subtract"}, "unsupported_expression")
        _supported_expression(expr["left"])
        _supported_expression(expr["right"])


def _profile(recipe: dict, sources: dict, targets: dict) -> None:
    policy = recipe["decimalPolicy"]
    _require(
        policy["precision"] <= 18
        and policy["scale"] <= policy["precision"]
        and policy["rounding"] == "half_even",
        "unsupported_decimal_policy",
    )
    _require(
        recipe["limits"]["maxCells"] <= 100000
        and recipe["limits"]["maxRows"] <= 100000,
        "unsupported_limits",
    )
    _require(
        not recipe["mappings"]
        and not recipe["protectedScopes"]
        and not recipe["formulaPolicy"]["allowedFunctions"],
        "unsupported_profile",
    )
    _require(
        recipe["idempotence"]["mode"] == "regenerate_owned_zone",
        "unsupported_idempotence",
    )
    _names(recipe["idempotence"]["businessKeyColumns"])
    input_roles = [item["role"] for item in recipe["inputs"]]
    output_roles = [item["role"] for item in recipe["outputs"]]
    _require(
        len(set(input_roles + output_roles)) == len(input_roles + output_roles),
        "role_duplicate",
    )
    _require(
        set(sources) == set(input_roles) and set(targets) == set(output_roles),
        "resolved_input",
    )
    bindings = [item["bindingId"] for item in recipe["inputs"] + recipe["outputs"]]
    _require(len(bindings) == len(set(bindings)), "binding_duplicate")
    needed = {"file.xlsx"}
    for item in recipe["inputs"]:
        _require(
            item["format"] == "xlsx"
            and item["locale"] == "en-US"
            and item["cardinality"] == "one",
            "unsupported_input",
        )
        names = [col["name"] for col in item["columns"]]
        _names(names)
        _names(item["keyColumns"])
        _require(set(item["keyColumns"]) <= set(names), "column_missing")
        _require(
            all(col["type"] != "date" for col in item["columns"]), "unsupported_input"
        )
        source = sources[item["role"]]
        _require(
            (source.binding_id, source.sheet_id)
            == (item["bindingId"], item["sheetId"]),
            "resolved_input",
        )
    for operation in recipe["operations"]:
        name = operation["op"]
        _require(name in _SUPPORTED, "unsupported_operation")
        needed.add("table." + name)
        if name == "cast":
            _require(
                operation["type"] == "decimal" and operation["onInvalid"] == "reject",
                "unsupported_operation",
            )
        elif name == "join":
            _require(
                operation["how"] in {"left", "inner"}
                and operation["onUnmatched"] == "reject",
                "unsupported_operation",
            )
        elif name == "aggregate":
            _require(
                all(
                    spec["function"] != "mean"
                    and spec["allNull"] == policy["allNullAggregate"]
                    for spec in operation["values"]
                ),
                "unsupported_operation",
            )
        elif name in {"derive", "filter"}:
            _supported_expression(
                operation.get("expression", operation.get("predicate"))
            )
    declared = set(recipe["requiredCapabilities"])
    _require(
        needed <= declared
        and declared <= {"file.xlsx", *("table." + name for name in _SUPPORTED)},
        "unsupported_capability",
    )
    _require(len(recipe["writes"]) == len(recipe["outputs"]), "unsupported_write")
    writes = {write["destinationBindingId"]: write for write in recipe["writes"]}
    _require(len(writes) == len(recipe["writes"]), "unsupported_write")
    for output in recipe["outputs"]:
        target = targets[output["role"]]
        _require(
            output["format"] == "xlsx"
            and target.binding_id == output["bindingId"]
            and output["bindingId"] in writes,
            "unsupported_output",
        )
        write = writes[output["bindingId"]]
        area = write["range"]
        _require(
            write["mode"] == "regenerate_owned_zone"
            and area["sheetId"] == target.sheet_id,
            "unsupported_write",
        )
        _require(
            area["startRow"] == area["startColumn"] == 1
            and area["endColumn"] == len(write["columns"]),
            "unsupported_write",
        )
        _require(
            [col["targetColumn"] for col in write["columns"]]
            == list(range(1, len(write["columns"]) + 1)),
            "unsupported_write",
        )
        _names([col["source"] for col in write["columns"]])

    # No surplus scope, no implicit interpretation of a different header placement.
    def key(area: dict) -> tuple:
        return (
            area["sheetId"],
            area["startRow"],
            area["endRow"],
            area["startColumn"],
            area["endColumn"],
        )

    _require(
        sorted(map(key, recipe["writeScopes"]))
        == sorted(key(w["range"]) for w in recipe["writes"]),
        "write_scope",
    )


def _type(dtype: pl.DataType) -> str:
    if dtype.is_decimal():
        return "decimal"
    if dtype.is_integer():
        return "integer"
    return {pl.String: "string", pl.Boolean: "boolean", pl.Null: "null"}.get(
        dtype, "unsupported"
    )


def _expression_type(expr: dict, frame: pl.DataFrame) -> str:
    kind = expr["kind"]
    if kind == "col":
        _columns(frame, [expr["name"]])
        return _type(frame.schema[expr["name"]])
    if kind == "literal":
        return expr["value"]["kind"]
    left, right = (
        _expression_type(expr["left"], frame),
        _expression_type(expr["right"], frame),
    )
    if kind == "arithmetic":
        _require(left == right == "decimal", "type_mismatch")
        return "decimal"
    _require(left == right or "null" in (left, right), "type_mismatch")
    return "boolean"


def _check_operation(
    operation: dict, frame: pl.DataFrame, right: pl.DataFrame | None
) -> None:
    name = operation["op"]
    if name == "select":
        _columns(frame, operation["columns"])
    elif name == "sort":
        _columns(frame, [key["column"] for key in operation["keys"]])
    elif name == "cast":
        _columns(frame, [operation["column"]])
    elif name in {"derive", "filter"}:
        dtype = _expression_type(
            operation.get("expression", operation.get("predicate")), frame
        )
        _require(dtype != "null", "type_mismatch")
    elif name == "aggregate":
        _columns(frame, operation["groupBy"])
        for spec in operation["values"]:
            _columns(frame, [spec["column"]])
        _names(operation["groupBy"] + [spec["as"] for spec in operation["values"]])
    elif name == "join":
        _require(right is not None, "table_missing")
        _columns(frame, operation["leftKeys"])
        _columns(right, operation["rightKeys"])
        _require(len(operation["leftKeys"]) == len(operation["rightKeys"]), "join_keys")
        _require(
            all(
                frame.schema[left_key] == right.schema[right_key]
                for left_key, right_key in zip(
                    operation["leftKeys"], operation["rightKeys"]
                )
            ),
            "type_mismatch",
        )


def _control(control: dict, frame: pl.DataFrame, precision: int, scale: int) -> bool:
    kind = control["kind"]
    if kind == "unique":
        return _unique(frame, control["columns"], non_null=False)
    if kind == "not_null":
        _columns(frame, control["columns"])
        return all(frame[name].null_count() == 0 for name in control["columns"])
    _columns(frame, [control["debit"], control["credit"]])
    _require(
        all(frame.schema[control[name]].is_decimal() for name in ("debit", "credit")),
        "type_mismatch",
    )
    _require(
        all(frame[control[name]].null_count() == 0 for name in ("debit", "credit")),
        "control_unresolved",
    )
    tolerance = decimal_series(
        "tolerance", [control["tolerance"]], precision=precision, scale=scale
    )[0]
    _require(tolerance >= 0, "invalid_tolerance")
    # Native null-aware exact Decimal aggregation. No second calculation engine.
    sums = apply_operation(
        frame,
        {
            "op": "aggregate",
            "groupBy": [],
            "values": [
                {
                    "column": control[name],
                    "as": name,
                    "function": "sum",
                    "allNull": "null",
                }
                for name in ("debit", "credit")
            ],
        },
        precision=precision,
        scale=scale,
    ).row(0)
    _require(all(value is not None for value in sums), "control_unresolved")
    with localcontext() as context:
        context.prec = 80
        return abs(sums[0] - sums[1]) <= tolerance


def prepare_procedure(
    raw: Any,
    sources: dict[str, ResolvedXlsx],
    targets: dict[str, OutputTarget],
    *,
    profile: str,
) -> PreparedProcedure:
    """Prepare new read-back XLSX bytes, never resolve or publish any binding.

    Caller must resolve authority, canonical procedure digest/version and owned
    artefacts first. This function checks their shape and data, not their authority.
    Deadline is cooperative; the isolated caller must enforce process limits.
    """
    error = None
    result = None
    try:
        _require(
            type(profile) is str and profile == MEMORY_PROFILE, "unsupported_profile"
        )
        started = monotonic()
        recipe = _capture(raw)
        validate("ExcelProcedure", recipe)
        inputs = _resolved(sources, ResolvedXlsx)
        outputs = _resolved(targets, OutputTarget)
        _profile(recipe, inputs, outputs)
        deadline = started + recipe["limits"]["timeoutSeconds"]

        def checkpoint() -> None:
            _require(monotonic() < deadline, "deadline")

        precision, scale = (
            recipe["decimalPolicy"]["precision"],
            recipe["decimalPolicy"]["scale"],
        )
        tables: dict[str, pl.DataFrame] = {}
        cached_cells = 0

        def store(name: str, frame: pl.DataFrame) -> None:
            nonlocal cached_cells
            checkpoint()
            _require(name not in tables, "table_redefinition")
            cells = (frame.height + 1) * frame.width
            _require(
                frame.height <= recipe["limits"]["maxRows"]
                and cells <= recipe["limits"]["maxCells"],
                "resource_limit",
            )
            cached_cells += cells
            _require(cached_cells <= 100000, "cache_limit")
            tables[name] = frame

        checkpoint()
        for item in recipe["inputs"]:
            source = inputs[item["role"]]
            frame = read_table(
                source.content,
                expected_digest=source.sha256[7:],
                sheet=source.sheet_name,
                columns={col["name"]: col["type"] for col in item["columns"]},
                precision=precision,
                scale=scale,
                max_cells=recipe["limits"]["maxCells"],
            )
            for col in item["columns"]:
                _require(
                    (col["nullable"] and item["nullPolicy"] == "preserve")
                    or frame[col["name"]].null_count() == 0,
                    "input_null",
                )
            if item["keyColumns"]:
                _require(_unique(frame, item["keyColumns"], non_null=True), "input_key")
            store(item["role"], frame)
        for operation in recipe["operations"]:
            checkpoint()
            _require(
                operation["input"] in tables and operation["output"] not in tables,
                "table_reference",
            )
            frame = tables[operation["input"]]
            right = tables.get(operation.get("rightInput"))
            _check_operation(operation, frame, right)
            store(
                operation["output"],
                apply_operation(
                    frame, operation, precision=precision, scale=scale, right=right
                ),
            )
        observations = []
        for index, control in enumerate(recipe["controls"]):
            checkpoint()
            _require(control["input"] in tables, "table_reference")
            satisfied = _control(control, tables[control["input"]], precision, scale)
            observations.append(
                ControlObservation(
                    index, control["kind"], control["severity"], satisfied
                )
            )
            _require(
                satisfied or control["severity"] == "informative", "control_failed"
            )
        plans = {}
        for write in recipe["writes"]:
            checkpoint()
            _require(write["input"] in tables, "table_reference")
            frame = tables[write["input"]]
            _require(
                _unique(
                    frame, recipe["idempotence"]["businessKeyColumns"], non_null=True
                ),
                "business_key",
            )
            names = [col["source"] for col in write["columns"]]
            _columns(frame, names)
            selected = frame.select(names)
            _require(
                all(
                    _type(dtype) in {"decimal", "string", "boolean"}
                    for dtype in selected.dtypes
                ),
                "write_type",
            )
            _require(write["range"]["endRow"] == selected.height + 1, "write_range")
            _require(
                (selected.height + 1) * selected.width <= recipe["limits"]["maxCells"],
                "resource_limit",
            )
            plans[write["destinationBindingId"]] = selected
        prepared = []
        for output in recipe["outputs"]:
            checkpoint()
            target = outputs[output["role"]]
            frame = plans[output["bindingId"]]
            content = write_table(frame, sheet=target.sheet_name)
            checkpoint()
            digest = sha256(content).hexdigest()
            readback = read_table(
                content,
                expected_digest=digest,
                sheet=target.sheet_name,
                columns={name: _type(dtype) for name, dtype in frame.schema.items()},
                precision=precision,
                scale=scale,
                max_cells=recipe["limits"]["maxCells"],
            )
            _require(readback.equals(frame), "readback_mismatch")
            checkpoint()
            prepared.append(
                PreparedOutput(
                    output["role"],
                    target.binding_id,
                    target.sheet_id,
                    content,
                    "sha256:" + digest,
                )
            )
        checkpoint()
        result = PreparedProcedure(tuple(prepared), tuple(observations))
    except ProcedureError as caught:
        error = str(caught)
    except Exception:
        error = "invalid_procedure_or_data"
    # Outside except: never retain native cause/context containing data. Interrupts propagate.
    if error is not None:
        raise ProcedureError(error)
    return result
