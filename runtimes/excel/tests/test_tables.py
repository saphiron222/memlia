from decimal import Decimal

import polars as pl
import pytest

from memlia_excel import tables


def test_all_null_sum_is_missing_and_zero_is_present():
    frame = pl.DataFrame(
        {
            "group": ["empty", "zero", "sum", "sum"],
            "amount": [None, Decimal("0"), Decimal("0.10"), Decimal("0.20")],
        }
    )
    result = tables.aggregate(
        frame,
        ["group"],
        [{"column": "amount", "as": "total", "function": "sum", "allNull": "null"}],
    )
    assert result.to_dicts() == [
        {"group": "empty", "total": None},
        {"group": "zero", "total": Decimal("0")},
        {"group": "sum", "total": Decimal("0.30")},
    ]


def test_all_null_rejection():
    with pytest.raises(tables.KernelError, match="all_null"):
        tables.aggregate(
            pl.DataFrame({"n": [None]}),
            [],
            [{"column": "n", "as": "total", "function": "sum", "allNull": "reject"}],
        )


@pytest.mark.parametrize(
    "value", ["1.001", "10000000000000000.00", "NaN", "Infinity", 0.1, True]
)
def test_decimal_rejects_loss_or_ambiguous_values(value):
    with pytest.raises(tables.KernelError, match="decimal"):
        tables.decimal_series("amount", [value], precision=18, scale=2)


def test_decimal_conversion_keeps_null_zero_and_large_exact_value():
    result = tables.decimal_series(
        "amount", [None, "0", "9999999999999999.99"], precision=18, scale=2
    )
    assert result.to_list() == [None, Decimal("0.00"), Decimal("9999999999999999.99")]


def test_join_rejects_duplicate_mapping_keys():
    with pytest.raises(tables.KernelError, match="join"):
        tables.join(
            pl.DataFrame({"id": ["a"]}),
            pl.DataFrame({"key": ["a", "a"], "label": ["one", "two"]}),
            ["id"],
            ["key"],
            "left",
            "many_to_one",
        )


def test_join_rejects_unmatched_instead_of_silent_drop():
    with pytest.raises(tables.KernelError, match="unmatched"):
        tables.join(
            pl.DataFrame({"id": ["missing"]}),
            pl.DataFrame({"key": ["a"]}),
            ["id"],
            ["key"],
            "inner",
            "many_to_one",
        )


def test_join_preserves_left_order_and_null_amount():
    result = tables.join(
        pl.DataFrame({"id": ["b", "a"]}),
        pl.DataFrame({"key": ["a", "b"], "amount": [Decimal("0"), None]}),
        ["id"],
        ["key"],
        "left",
        "many_to_one",
    )
    assert result.to_dicts() == [
        {"id": "b", "amount": None},
        {"id": "a", "amount": Decimal("0")},
    ]


def operation(op, **fields):
    return {"op": op, "input": "source", "output": "result", **fields}


def run(frame, op):
    return tables.apply_operation(frame, op, precision=18, scale=2)


def test_cast_select_sort_and_filter_are_generic():
    source = pl.DataFrame({"code": ["b", "a", "z"], "text": ["2.00", "0", None]})
    cast = run(
        source, operation("cast", column="text", type="decimal", onInvalid="reject")
    )
    selected = run(cast, operation("select", columns=["text", "code"]))
    sorted_frame = run(
        selected,
        operation(
            "sort", keys=[{"column": "code", "direction": "asc", "nulls": "last"}]
        ),
    )
    result = run(
        sorted_frame,
        operation(
            "filter",
            predicate={
                "kind": "comparison",
                "operator": "gte",
                "left": {"kind": "col", "name": "text"},
                "right": {
                    "kind": "literal",
                    "value": {"kind": "decimal", "value": "0"},
                },
            },
        ),
    )
    assert result.rows() == [(Decimal("0"), "a"), (Decimal("2"), "b")]
    assert source["text"].to_list() == ["2.00", "0", None]


def test_decimal_derive_add_preserves_unknown_and_exact_amounts():
    frame = pl.DataFrame(
        {"a": [Decimal("0.10"), None], "b": [Decimal("0.20"), Decimal("1")]}
    )
    result = run(
        frame,
        operation(
            "derive",
            column="total",
            expression={
                "kind": "arithmetic",
                "operator": "add",
                "left": {"kind": "col", "name": "a"},
                "right": {"kind": "col", "name": "b"},
            },
        ),
    )
    assert result["total"].to_list() == [Decimal("0.30"), None]


@pytest.mark.parametrize(
    "op",
    [
        operation("map"),
        operation("shell", command="harmless"),
        operation(
            "derive",
            column="result",
            expression={"kind": "python", "code": "raise RuntimeError"},
        ),
        operation("cast", column="a", type="decimal", onInvalid="null"),
    ],
)
def test_unimplemented_operation_or_expression_is_refused(op):
    with pytest.raises(tables.KernelError, match="unsupported"):
        run(pl.DataFrame({"a": ["1"]}), op)


def test_addition_precision_overflow_is_rejected():
    frame = pl.DataFrame({"a": [Decimal("9999999999999999.99")]})
    with pytest.raises(tables.KernelError, match="decimal_precision"):
        run(
            frame,
            operation(
                "derive",
                column="total",
                expression={
                    "kind": "arithmetic",
                    "operator": "add",
                    "left": {"kind": "col", "name": "a"},
                    "right": {
                        "kind": "literal",
                        "value": {"kind": "decimal", "value": "0.01"},
                    },
                },
            ),
        )


def test_aggregate_precision_overflow_is_rejected():
    with pytest.raises(tables.KernelError, match="decimal_precision"):
        tables.aggregate(
            pl.DataFrame({"n": [Decimal("9999999999999999.99"), Decimal("0.01")]}),
            [],
            [{"column": "n", "as": "total", "function": "sum", "allNull": "null"}],
        )


@pytest.mark.parametrize("value", ["1e2", " 1", "1_000", "1,25", "", "+1"])
def test_decimal_cast_rejects_ambiguous_text_syntax(value):
    with pytest.raises(tables.KernelError, match="decimal"):
        tables.decimal_series("n", [value], precision=18, scale=2)


def test_join_rejects_collision_with_differently_named_right_key():
    with pytest.raises(tables.KernelError, match="collision"):
        tables.join(
            pl.DataFrame({"id": ["a"]}),
            pl.DataFrame({"key": ["a"], "id": ["other"]}),
            ["id"],
            ["key"],
            "left",
            "many_to_one",
        )


@pytest.mark.parametrize(
    "dtype,count,expected",
    [
        (pl.Int64, 2000, 18_000_000_000_000_000_000),
        (pl.UInt64, 3000, 27_000_000_000_000_000_000),
    ],
)
def test_integer_sum_is_refused_before_signed_or_unsigned_overflow(
    dtype, count, expected
):
    # Independent Python integers exceed both storage and Decimal(18,2) domains.
    values = [9_000_000_000_000_000] * count
    assert sum(values) == expected
    frame = pl.DataFrame({"n": pl.Series(values, dtype=dtype)})
    with pytest.raises(tables.KernelError, match="unsupported_integer_sum"):
        tables.aggregate(
            frame,
            [],
            [{"column": "n", "as": "total", "function": "sum", "allNull": "null"}],
        )


def test_small_integer_sum_requires_explicit_decimal_cast():
    with pytest.raises(tables.KernelError, match="unsupported_integer_sum"):
        tables.aggregate(
            pl.DataFrame({"n": [1, 2]}),
            [],
            [{"column": "n", "as": "total", "function": "sum", "allNull": "null"}],
        )
