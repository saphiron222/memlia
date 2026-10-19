# Copyright (c) 2026 Memlia. All rights reserved.
"""Real canonical validation/Polars/XLSX; native temporary IO, no user files/network."""

from copy import deepcopy
from dataclasses import replace
from hashlib import sha256
from io import BytesIO

import openpyxl
import pytest
from memlia_contracts import validate
from memlia_excel import procedure as module
from memlia_excel.procedure import (
    MEMORY_PROFILE,
    ProcedureError,
    ResolvedXlsx,
    OutputTarget,
    prepare_procedure,
)


def workbook(rows, sheet="Input"):
    book = openpyxl.Workbook()
    book.active.title = sheet
    for row in rows:
        book.active.append(row)
    stream = BytesIO()
    book.save(stream)
    book.close()
    return stream.getvalue()


def fixture(rows=None):
    rows = (
        rows
        if rows is not None
        else [["id", "debit", "credit"], ["a", "0.10", "0.10"], ["b", "0.20", "0.20"]]
    )
    data = workbook(rows)
    area = {
        "sheetId": "result-sheet",
        "startRow": 1,
        "endRow": len(rows),
        "startColumn": 1,
        "endColumn": 3,
    }
    recipe = {
        "schemaVersion": "memlia.excel-procedure/v1",
        "organizationId": None,
        "workspaceId": "workspace-fixture",
        "procedureId": "procedure-fixture",
        "version": 1,
        "parentVersion": None,
        "workflowId": "workflow-fixture",
        "deployedVersionId": "deployed-fixture",
        "ownerUserId": "user-fixture",
        "digest": "sha256:" + "a" * 64,
        "policyVersion": "policy-fixture",
        "inputs": [
            {
                "role": "source",
                "bindingId": "source-binding",
                "format": "xlsx",
                "sheetId": "source-sheet",
                "columns": [
                    {"name": "id", "type": "string", "nullable": False},
                    {"name": "debit", "type": "decimal", "nullable": True},
                    {"name": "credit", "type": "decimal", "nullable": True},
                ],
                "keyColumns": ["id"],
                "cardinality": "one",
                "locale": "en-US",
                "nullPolicy": "preserve",
            }
        ],
        "mappings": [],
        "operations": [
            {
                "op": "select",
                "input": "source",
                "output": "selected",
                "columns": ["id", "debit", "credit"],
            }
        ],
        "writes": [
            {
                "input": "selected",
                "destinationBindingId": "result-binding",
                "range": area,
                "columns": [
                    {"source": "id", "targetColumn": 1},
                    {"source": "debit", "targetColumn": 2},
                    {"source": "credit", "targetColumn": 3},
                ],
                "mode": "regenerate_owned_zone",
            }
        ],
        "writeScopes": [deepcopy(area)],
        "protectedScopes": [],
        "decimalPolicy": {
            "precision": 18,
            "scale": 2,
            "rounding": "half_even",
            "allNullAggregate": "null",
        },
        "formulaPolicy": {
            "externalLinks": "reject",
            "dataStrings": "literal",
            "allowedFunctions": [],
        },
        "controls": [
            {
                "kind": "balance",
                "input": "selected",
                "debit": "debit",
                "credit": "credit",
                "tolerance": "0.00",
                "severity": "blocking",
            }
        ],
        "requiredCapabilities": ["file.xlsx", "table.select"],
        "limits": {"maxRows": 100, "maxCells": 1000, "timeoutSeconds": 10},
        "idempotence": {"mode": "regenerate_owned_zone", "businessKeyColumns": ["id"]},
        "outputs": [
            {"role": "result", "bindingId": "result-binding", "format": "xlsx"}
        ],
    }
    validate("ExcelProcedure", recipe)
    sources = {
        "source": ResolvedXlsx(
            "source-binding",
            "source-sheet",
            "Input",
            data,
            "sha256:" + sha256(data).hexdigest(),
        )
    }
    targets = {"result": OutputTarget("result-binding", "result-sheet", "Result")}
    return recipe, sources, targets


def prepare(recipe, sources, targets):
    return prepare_procedure(recipe, sources, targets, profile=MEMORY_PROFILE)


def values(result):
    book = openpyxl.load_workbook(BytesIO(result.outputs[0].content), data_only=False)
    try:
        return list(book.active.values)
    finally:
        book.close()


def test_prepares_real_readback_without_mutating_source_or_claiming_publication():
    recipe, sources, targets = fixture()
    before = deepcopy(recipe)
    original = sources["source"].content
    result = prepare(recipe, sources, targets)
    assert result.status == "prepared_in_memory"
    assert result.published is False
    assert values(result) == [
        ("id", "debit", "credit"),
        ("a", "0.10", "0.10"),
        ("b", "0.20", "0.20"),
    ]
    assert result.controls[0].satisfied is True
    assert (
        result.outputs[0].sha256
        == "sha256:" + sha256(result.outputs[0].content).hexdigest()
    )
    assert recipe == before and sources["source"].content == original
    assert values(prepare(recipe, sources, targets)) == values(result)


def test_blocking_balance_is_not_silently_ignored_before_output(monkeypatch):
    recipe, sources, targets = fixture(
        [["id", "debit", "credit"], ["a", "0.10", "0.20"]]
    )
    calls = []
    monkeypatch.setattr(module, "write_table", lambda *a, **kw: calls.append(1))
    with pytest.raises(ProcedureError, match="control_failed"):
        prepare(recipe, sources, targets)
    assert calls == []


@pytest.mark.parametrize("kind", ["unique", "not_null"])
@pytest.mark.parametrize("severity", ["blocking", "informative"])
def test_controls_really_check_values_and_preserve_informative_failure(kind, severity):
    recipe, sources, targets = fixture(
        [["id", "debit", "credit"], ["a", None, "0"], ["b", None, "0"]]
    )
    recipe["controls"] = [
        {"kind": kind, "input": "selected", "columns": ["debit"], "severity": severity}
    ]
    if severity == "blocking":
        with pytest.raises(ProcedureError, match="control_failed"):
            prepare(recipe, sources, targets)
    else:
        result = prepare(recipe, sources, targets)
        assert result.controls[0].satisfied is False
        assert values(result)[1] == ("a", None, "0.00")


@pytest.mark.parametrize(
    "tolerance,passes", [("0.10", True), ("0.09", False), ("-0.10", False)]
)
def test_balance_exact_tolerance_not_float(tolerance, passes):
    recipe, sources, targets = fixture(
        [["id", "debit", "credit"], ["a", "0.10", "0.20"]]
    )
    recipe["controls"][0]["tolerance"] = tolerance
    if passes:
        assert prepare(recipe, sources, targets).controls[0].satisfied
    else:
        with pytest.raises(ProcedureError):
            prepare(recipe, sources, targets)


def test_all_null_balance_is_not_zero():
    recipe, sources, targets = fixture([["id", "debit", "credit"], ["a", None, None]])
    with pytest.raises(ProcedureError, match="control_unresolved"):
        prepare(recipe, sources, targets)


@pytest.mark.parametrize(
    "change",
    [
        "unknown",
        "csv",
        "mapping",
        "formula",
        "locale",
        "cardinality",
        "rounding",
        "precision",
        "protected",
        "update",
        "idempotence",
        "capability",
        "undeclared",
        "date",
        "null-policy",
        "nullable",
        "range",
        "scope",
        "noncontiguous",
        "same-binding",
        "source-hash",
        "source-binding",
        "sheet-id",
        "duplicate-role",
        "forward",
        "redefine",
        "duplicate-column",
        "duplicate-target",
        "missing-key",
        "duplicate-key",
        "cell-limit",
        "row-limit",
        "unsupported-op",
        "multiply",
        "output-extra",
    ],
)
def test_rejects_unsupported_or_inconsistent_declarations_before_output(
    change, monkeypatch
):
    recipe, sources, targets = fixture()
    if change == "unknown":
        recipe["private-canary"] = "secret"
    elif change == "csv":
        recipe["inputs"][0]["format"] = "csv"
    elif change == "mapping":
        recipe["mappings"] = [{"artifactId": "map", "sha256": "sha256:" + "b" * 64}]
    elif change == "formula":
        recipe["formulaPolicy"]["allowedFunctions"] = ["SUM"]
    elif change == "locale":
        recipe["inputs"][0]["locale"] = "fr-FR"
    elif change == "cardinality":
        recipe["inputs"][0]["cardinality"] = "many"
    elif change == "rounding":
        recipe["decimalPolicy"]["rounding"] = "half_up"
    elif change == "precision":
        recipe["decimalPolicy"]["precision"] = 28
    elif change == "protected":
        recipe["protectedScopes"] = deepcopy(recipe["writeScopes"])
    elif change == "update":
        recipe["writes"][0]["mode"] = "update_input"
    elif change == "idempotence":
        recipe["idempotence"]["mode"] = "update_input"
    elif change == "capability":
        recipe["requiredCapabilities"].append("excel.styles")
    elif change == "undeclared":
        recipe["requiredCapabilities"] = ["file.xlsx"]
    elif change == "date":
        recipe["inputs"][0]["columns"][0]["type"] = "date"
    elif change in ("null-policy", "nullable"):
        recipe, sources, targets = fixture(
            [["id", "debit", "credit"], ["a", None, None]]
        )
        recipe["controls"] = [
            {
                "kind": "not_null",
                "input": "selected",
                "columns": ["id"],
                "severity": "blocking",
            }
        ]
        if change == "null-policy":
            recipe["inputs"][0]["nullPolicy"] = "reject"
        else:
            recipe["inputs"][0]["columns"][1]["nullable"] = False
    elif change == "range":
        recipe["writes"][0]["range"]["endRow"] += 1
    elif change == "scope":
        recipe["writeScopes"][0]["endRow"] += 1
    elif change == "noncontiguous":
        recipe["writes"][0]["columns"][0]["targetColumn"] = 4
    elif change == "same-binding":
        recipe["outputs"][0]["bindingId"] = "source-binding"
    elif change == "source-hash":
        sources["source"] = replace(sources["source"], sha256="sha256:" + "0" * 64)
    elif change == "source-binding":
        sources["source"] = replace(sources["source"], binding_id="other")
    elif change == "sheet-id":
        targets["result"] = replace(targets["result"], sheet_id="other")
    elif change == "duplicate-role":
        recipe["inputs"].append(deepcopy(recipe["inputs"][0]))
    elif change == "forward":
        recipe["operations"][0]["input"] = "later"
    elif change == "redefine":
        recipe["operations"][0]["output"] = "source"
    elif change == "duplicate-column":
        recipe["inputs"][0]["columns"].append(
            deepcopy(recipe["inputs"][0]["columns"][0])
        )
    elif change == "duplicate-target":
        recipe["writes"][0]["columns"][1]["targetColumn"] = 1
    elif change == "missing-key":
        recipe["idempotence"]["businessKeyColumns"] = ["absent"]
    elif change == "duplicate-key":
        recipe["idempotence"]["businessKeyColumns"] = ["id", "id"]
    elif change == "cell-limit":
        recipe["limits"]["maxCells"] = 8
    elif change == "row-limit":
        recipe["limits"]["maxRows"] = 1
    elif change == "unsupported-op":
        recipe["operations"][0] = {
            "op": "cast",
            "input": "source",
            "output": "selected",
            "column": "debit",
            "type": "string",
            "onInvalid": "reject",
        }
    elif change == "multiply":
        recipe["operations"][0] = {
            "op": "derive",
            "input": "source",
            "output": "selected",
            "column": "debit",
            "expression": {
                "kind": "arithmetic",
                "operator": "multiply",
                "left": {"kind": "col", "name": "debit"},
                "right": {"kind": "col", "name": "credit"},
            },
        }
    elif change == "output-extra":
        targets["unused"] = targets["result"]
    calls = []
    monkeypatch.setattr(module, "write_table", lambda *a, **kw: calls.append(1))
    with pytest.raises(ProcedureError) as caught:
        prepare(recipe, sources, targets)
    assert calls == []
    assert "private-canary" not in str(caught.value)
    assert caught.value.__cause__ is None and caught.value.__context__ is None


def test_profile_is_explicit_not_an_implicit_ir_interpretation():
    recipe, sources, targets = fixture()
    with pytest.raises(TypeError):
        prepare_procedure(recipe, sources, targets)
    with pytest.raises(ProcedureError):
        prepare_procedure(recipe, sources, targets, profile="other")


def test_rejects_python_callbacks_cycles_and_non_json_before_library_calls():
    recipe, sources, targets = fixture()

    class Evil(dict):
        def items(self):
            raise AssertionError("callback invoked")

    for value in (
        Evil(recipe),
        {**recipe, "x": object()},
        {**recipe, "x": float("nan")},
    ):
        with pytest.raises(ProcedureError):
            prepare(value, sources, targets)
    recipe["cycle"] = recipe
    with pytest.raises(ProcedureError):
        prepare(recipe, sources, targets)


def test_snapshot_and_timeout_after_native_read_prevent_late_output(monkeypatch):
    recipe, sources, targets = fixture()
    original = module.read_table
    clock = [0.0]
    monkeypatch.setattr(module, "monotonic", lambda: clock[0])

    def read(*args, **kwargs):
        frame = original(*args, **kwargs)
        recipe["writes"][0]["destinationBindingId"] = "attacker"
        clock[0] = 11.0
        return frame

    monkeypatch.setattr(module, "read_table", read)
    with pytest.raises(ProcedureError, match="deadline"):
        prepare(recipe, sources, targets)


def test_snapshot_retains_owned_targets_and_recipe(monkeypatch):
    recipe, sources, targets = fixture()
    original = module.read_table

    def read(*args, **kwargs):
        frame = original(*args, **kwargs)
        recipe["outputs"][0]["role"] = "attacker"
        targets.clear()
        sources.clear()
        return frame

    monkeypatch.setattr(module, "read_table", read)
    result = prepare(recipe, sources, targets)
    assert result.outputs[0].role == "result"
    assert values(result)[1] == ("a", "0.10", "0.10")


def test_readback_failure_returns_no_prepared_output_and_no_cell_message(monkeypatch):
    recipe, sources, targets = fixture()

    def corrupted(*args, **kwargs):
        raise ValueError("private-cell-canary")

    monkeypatch.setattr(module, "write_table", corrupted)
    with pytest.raises(ProcedureError) as caught:
        prepare(recipe, sources, targets)
    assert "private-cell-canary" not in str(caught.value)
    assert caught.value.__context__ is None


def set_write(recipe, table, names, rows):
    write = recipe["writes"][0]
    write["input"] = table
    write["columns"] = [
        {"source": name, "targetColumn": index + 1} for index, name in enumerate(names)
    ]
    write["range"].update(endRow=rows + 1, endColumn=len(names))
    recipe["writeScopes"] = [deepcopy(write["range"])]


def test_complete_native_chain_cast_derive_filter_join_aggregate_sort_select():
    recipe, sources, targets = fixture(
        [
            ["id", "debit", "credit"],
            ["a", "0.10", "0.10"],
            ["b", "0.20", "0.20"],
            ["c", None, "0"],
        ]
    )
    recipe["inputs"][0]["columns"][1]["type"] = "string"
    lookup = workbook([["key", "group"], ["a", "x"], ["b", "x"], ["c", "y"]], "Lookup")
    recipe["inputs"].append(
        {
            "role": "lookup",
            "bindingId": "lookup-binding",
            "format": "xlsx",
            "sheetId": "lookup-sheet",
            "columns": [
                {"name": "key", "type": "string", "nullable": False},
                {"name": "group", "type": "string", "nullable": False},
            ],
            "keyColumns": ["key"],
            "cardinality": "one",
            "locale": "en-US",
            "nullPolicy": "reject",
        }
    )
    sources["lookup"] = ResolvedXlsx(
        "lookup-binding",
        "lookup-sheet",
        "Lookup",
        lookup,
        "sha256:" + sha256(lookup).hexdigest(),
    )
    recipe["operations"] = [
        {
            "op": "cast",
            "input": "source",
            "output": "casted",
            "column": "debit",
            "type": "decimal",
            "onInvalid": "reject",
        },
        {
            "op": "derive",
            "input": "casted",
            "output": "derived",
            "column": "sum",
            "expression": {
                "kind": "arithmetic",
                "operator": "add",
                "left": {"kind": "col", "name": "debit"},
                "right": {"kind": "col", "name": "credit"},
            },
        },
        {
            "op": "filter",
            "input": "derived",
            "output": "filtered",
            "predicate": {
                "kind": "comparison",
                "operator": "gte",
                "left": {"kind": "col", "name": "debit"},
                "right": {
                    "kind": "literal",
                    "value": {"kind": "decimal", "value": "0.10"},
                },
            },
        },
        {
            "op": "join",
            "input": "filtered",
            "output": "joined",
            "rightInput": "lookup",
            "leftKeys": ["id"],
            "rightKeys": ["key"],
            "how": "left",
            "cardinality": "many_to_one",
            "onUnmatched": "reject",
        },
        {
            "op": "aggregate",
            "input": "joined",
            "output": "grouped",
            "groupBy": ["group"],
            "values": [
                {"column": "sum", "as": "total", "function": "sum", "allNull": "null"}
            ],
        },
        {
            "op": "sort",
            "input": "grouped",
            "output": "sorted",
            "keys": [{"column": "group", "direction": "asc", "nulls": "last"}],
        },
        {
            "op": "select",
            "input": "sorted",
            "output": "selected",
            "columns": ["group", "total"],
        },
    ]
    recipe["requiredCapabilities"] = [
        "file.xlsx",
        *["table." + item["op"] for item in recipe["operations"]],
    ]
    recipe["controls"] = [
        {
            "kind": "not_null",
            "input": "selected",
            "columns": ["total"],
            "severity": "blocking",
        }
    ]
    recipe["idempotence"]["businessKeyColumns"] = ["group"]
    set_write(recipe, "selected", ["group", "total"], 1)
    assert values(prepare(recipe, sources, targets)) == [
        ("group", "total"),
        ("x", "0.60"),
    ]


def test_count_requires_explicit_cast_before_output():
    recipe, sources, targets = fixture()
    recipe["operations"] = [
        {
            "op": "aggregate",
            "input": "source",
            "output": "counted",
            "groupBy": [],
            "values": [
                {"column": "id", "as": "count", "function": "count", "allNull": "null"}
            ],
        }
    ]
    recipe["requiredCapabilities"] = ["file.xlsx", "table.aggregate"]
    recipe["controls"] = [
        {
            "kind": "not_null",
            "input": "counted",
            "columns": ["count"],
            "severity": "blocking",
        }
    ]
    recipe["idempotence"]["businessKeyColumns"] = ["count"]
    set_write(recipe, "counted", ["count"], 1)
    with pytest.raises(ProcedureError, match="write_type"):
        prepare(recipe, sources, targets)
    recipe["operations"].append(
        {
            "op": "cast",
            "input": "counted",
            "output": "result",
            "column": "count",
            "type": "decimal",
            "onInvalid": "reject",
        }
    )
    recipe["requiredCapabilities"].append("table.cast")
    set_write(recipe, "result", ["count"], 1)
    assert values(prepare(recipe, sources, targets)) == [("count",), ("2.00",)]


def test_partial_missing_balance_does_not_become_known_sum():
    recipe, sources, targets = fixture(
        [["id", "debit", "credit"], ["a", "0.10", "0.10"], ["b", None, "0"]]
    )
    with pytest.raises(ProcedureError, match="control_unresolved"):
        prepare(recipe, sources, targets)


def test_numeric_precision_overflow_and_non_exact_scale_are_refused():
    for number in ("99999999999999999.00", "0.001"):
        recipe, sources, targets = fixture(
            [["id", "debit", "credit"], ["a", number, number]]
        )
        with pytest.raises(ProcedureError):
            prepare(recipe, sources, targets)


def test_input_and_business_keys_are_not_silently_assumed_unique():
    recipe, sources, targets = fixture(
        [["id", "debit", "credit"], ["a", "0.10", "0.10"], ["a", "0.10", "0.10"]]
    )
    with pytest.raises(ProcedureError, match="input_key"):
        prepare(recipe, sources, targets)
    recipe["inputs"][0]["keyColumns"] = []
    with pytest.raises(ProcedureError, match="business_key"):
        prepare(recipe, sources, targets)


def test_timeout_after_native_write_never_returns_a_prepared_result(monkeypatch):
    recipe, sources, targets = fixture()
    clock = [0.0]
    monkeypatch.setattr(module, "monotonic", lambda: clock[0])
    original = module.write_table

    def write(*args, **kwargs):
        result = original(*args, **kwargs)
        clock[0] = 11.0
        return result

    monkeypatch.setattr(module, "write_table", write)
    with pytest.raises(ProcedureError, match="deadline"):
        prepare(recipe, sources, targets)


def test_interrupt_propagates_and_never_returns_a_partial_result(monkeypatch):
    recipe, sources, targets = fixture()

    def interrupt(*args, **kwargs):
        raise KeyboardInterrupt()

    monkeypatch.setattr(module, "write_table", interrupt)
    with pytest.raises(KeyboardInterrupt):
        prepare(recipe, sources, targets)


@pytest.mark.parametrize(
    "option",
    [
        "full_join",
        "reported_join",
        "mean",
        "all_null_override",
        "date_literal",
        "condition",
        "map",
        "pivot",
        "melt",
    ],
)
def test_canonical_but_unsupported_options_refuse_before_loading_xlsx(
    option, monkeypatch
):
    recipe, sources, targets = fixture()
    common = {"input": "source", "output": "selected"}
    col = {"kind": "col", "name": "debit"}
    literal = {"kind": "literal", "value": {"kind": "decimal", "value": "1.00"}}
    comparison = {"kind": "comparison", "operator": "eq", "left": col, "right": literal}
    if option in ("full_join", "reported_join"):
        operation = {
            "op": "join",
            **common,
            "rightInput": "source",
            "leftKeys": ["id"],
            "rightKeys": ["id"],
            "how": "full" if option == "full_join" else "left",
            "cardinality": "one_to_one",
            "onUnmatched": "report" if option == "reported_join" else "reject",
        }
    elif option in ("mean", "all_null_override"):
        operation = {
            "op": "aggregate",
            **common,
            "groupBy": [],
            "values": [
                {
                    "column": "debit",
                    "as": "total",
                    "function": "mean" if option == "mean" else "sum",
                    "allNull": "reject" if option == "all_null_override" else "null",
                }
            ],
        }
    elif option in ("date_literal", "condition"):
        expression = (
            {"kind": "literal", "value": {"kind": "date", "value": "2026-10-19"}}
            if option == "date_literal"
            else {
                "kind": "condition",
                "when": comparison,
                "then": col,
                "otherwise": literal,
            }
        )
        operation = {
            "op": "derive",
            **common,
            "column": "debit",
            "expression": expression,
        }
    elif option == "map":
        operation = {
            "op": "map",
            **common,
            "column": "id",
            "mapping": {"artifactId": "mapping", "sha256": "sha256:" + "b" * 64},
            "onUnmatched": "reject",
        }
    elif option == "pivot":
        operation = {
            "op": "pivot",
            **common,
            "index": ["id"],
            "on": "id",
            "value": "debit",
            "function": "sum",
            "allNull": "null",
        }
    else:
        operation = {
            "op": "melt",
            **common,
            "index": ["id"],
            "values": ["debit"],
            "variableName": "variable",
            "valueName": "value",
        }
    recipe["operations"] = [operation]
    recipe["requiredCapabilities"] = ["file.xlsx", "table." + operation["op"]]
    validate("ExcelProcedure", recipe)
    calls = []
    monkeypatch.setattr(module, "read_table", lambda *args, **kwargs: calls.append(1))
    with pytest.raises(ProcedureError):
        prepare(recipe, sources, targets)
    assert calls == []


def test_rejects_implicit_comparison_coercion_and_derived_null_only_column():
    recipe, sources, targets = fixture()
    for expression in (
        {
            "kind": "comparison",
            "operator": "eq",
            "left": {"kind": "col", "name": "id"},
            "right": {"kind": "col", "name": "debit"},
        },
        {"kind": "literal", "value": {"kind": "null"}},
    ):
        recipe["operations"] = [
            {
                "op": "derive",
                "input": "source",
                "output": "selected",
                "column": "debit",
                "expression": expression,
            }
        ]
        recipe["requiredCapabilities"] = ["file.xlsx", "table.derive"]
        with pytest.raises(ProcedureError, match="type_mismatch"):
            prepare(recipe, sources, targets)


def test_final_readback_checkpoint_cannot_return_after_deadline(monkeypatch):
    recipe, sources, targets = fixture()
    clock, calls = [0.0], []
    original = module.read_table
    monkeypatch.setattr(module, "monotonic", lambda: clock[0])

    def read(*args, **kwargs):
        frame = original(*args, **kwargs)
        calls.append(1)
        if len(calls) == 2:
            clock[0] = 11.0
        return frame

    monkeypatch.setattr(module, "read_table", read)
    with pytest.raises(ProcedureError, match="deadline"):
        prepare(recipe, sources, targets)
    assert len(calls) == 2


def test_real_output_reread_catches_wrong_values_after_writer(monkeypatch):
    recipe, sources, targets = fixture()
    wrong = workbook([["id", "debit", "credit"], ["a", "9.00", "9.00"]], "Result")
    monkeypatch.setattr(module, "write_table", lambda *args, **kwargs: wrong)
    with pytest.raises(ProcedureError, match="readback_mismatch"):
        prepare(recipe, sources, targets)
