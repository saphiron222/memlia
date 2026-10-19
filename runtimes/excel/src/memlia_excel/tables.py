# Copyright (c) 2026 Memlia. All rights reserved.
"""Primitives pures ; le schéma de transport appartient à memlia-contracts."""

from decimal import Decimal, InvalidOperation, localcontext
from typing import Any

import polars as pl
import operator
import re


class KernelError(ValueError):
    """Refus déterministe du profil de calcul, sans données dans le message."""


def decimal_series(
    name: str, values: list[Any], *, precision: int, scale: int
) -> pl.Series:
    """Conversion exacte : aucune approximation float ni arrondi implicite."""
    if not 1 <= precision <= 38 or not 0 <= scale <= min(18, precision):
        raise KernelError("decimal_policy")
    result = []
    with localcontext() as context:
        context.prec = 80
        quantum = Decimal(1).scaleb(-scale)
        bound = Decimal(10) ** (precision - scale)
        for value in values:
            if value is None:
                result.append(None)
                continue
            if isinstance(value, (bool, float)) or not isinstance(
                value, (str, int, Decimal)
            ):
                raise KernelError("decimal_type")
            if isinstance(value, str) and (
                len(value) > 80
                or not re.fullmatch(r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?", value)
            ):
                raise KernelError("decimal_syntax")
            try:
                number = Decimal(value)
                if not number.is_finite() or abs(number) >= bound:
                    raise KernelError("decimal_precision")
                exact = number.quantize(quantum)
                if exact != number:
                    raise KernelError("decimal_scale")
            except InvalidOperation as exc:
                raise KernelError("decimal_invalid") from exc
            result.append(exact)
    return pl.Series(name, result, dtype=pl.Decimal(precision, scale), strict=True)


def aggregate(
    frame: pl.DataFrame,
    group_by: list[str],
    values: list[dict[str, Any]],
    *,
    precision: int = 18,
    scale: int = 2,
) -> pl.DataFrame:
    """Agrégats Polars avec présence explicite, y compris pour count."""
    frame = _bounded(frame, precision, scale)
    expressions = []
    for spec in values:
        column = pl.col(spec["column"])
        function = spec["function"]
        if function not in {"sum", "min", "max", "count"}:
            raise KernelError("unsupported_aggregate")
        if spec["allNull"] not in {"null", "reject"}:
            raise KernelError("unsupported_all_null")
        if function == "sum" and frame.schema[spec["column"]].is_integer():
            raise KernelError("unsupported_integer_sum")
        if frame.schema[spec["column"]] == pl.Null:
            column = column.cast(pl.Int64)
        reduction = {
            "sum": column.sum,
            "min": column.min,
            "max": column.max,
            "count": column.count,
        }[function]()
        expressions.append(
            pl.when(column.count() > 0)
            .then(reduction)
            .otherwise(None)
            .alias(spec["as"])
        )
    try:
        result = (
            frame.group_by(group_by, maintain_order=True).agg(expressions)
            if group_by
            else frame.select(expressions)
        )
    except pl.exceptions.PolarsError as exc:
        raise KernelError("aggregate_invalid") from exc
    for spec in values:
        if spec["allNull"] == "reject" and result[spec["as"]].null_count():
            raise KernelError("all_null")
    return _bounded(result, precision, scale)


def join(
    left: pl.DataFrame,
    right: pl.DataFrame,
    left_keys: list[str],
    right_keys: list[str],
    how: str,
    cardinality: str,
) -> pl.DataFrame:
    """Jointure déterministe ; toute entrée gauche non appariée est refusée."""
    cardinalities = {"one_to_one": "1:1", "many_to_one": "m:1", "one_to_many": "1:m"}
    if how not in {"left", "inner"} or cardinality not in cardinalities:
        raise KernelError("unsupported_join")
    if not left_keys or len(left_keys) != len(right_keys):
        raise KernelError("join_keys")
    shared_keys = {
        left_key
        for left_key, right_key in zip(left_keys, right_keys)
        if left_key == right_key
    }
    if (set(left.columns) & set(right.columns)) - shared_keys:
        raise KernelError("join_column_collision")
    try:
        missing = left.join(right, left_on=left_keys, right_on=right_keys, how="anti")
        if missing.height:
            raise KernelError("unmatched")
        return left.join(
            right,
            left_on=left_keys,
            right_on=right_keys,
            how=how,
            validate=cardinalities[cardinality],
            maintain_order="left",
            coalesce=True,
        )
    except pl.exceptions.PolarsError as exc:
        raise KernelError("join_invalid") from exc


def _bounded(frame: pl.DataFrame, precision: int, scale: int) -> pl.DataFrame:
    # 18 digits × at most 100000 values stays below Decimal128's 38 digits.
    # This also bounds intermediate sums before the result precision check.
    if precision > 18:
        raise KernelError("unsupported_decimal_profile")
    if frame.height * max(1, frame.width) > 100000:
        raise KernelError("cell_limit")
    for name, dtype in frame.schema.items():
        if dtype.is_float() or dtype.is_nested() or dtype == pl.Object:
            raise KernelError("unsupported_column_type")
        if dtype.is_decimal():
            frame = frame.with_columns(
                decimal_series(
                    name, frame[name].to_list(), precision=precision, scale=scale
                )
            )
    return frame


def _operand(value: dict[str, Any], precision: int, scale: int) -> pl.Expr:
    match value["kind"]:
        case "col":
            return pl.col(value["name"])
        case "literal":
            literal = value["value"]
            match literal["kind"]:
                case "null":
                    return pl.lit(None)
                case "string" | "boolean":
                    return pl.lit(literal["value"])
                case "decimal":
                    number = decimal_series(
                        "literal", [literal["value"]], precision=precision, scale=scale
                    )[0]
                    return pl.lit(number, dtype=pl.Decimal(precision, scale))
    raise KernelError("unsupported_operand")


def _expression(
    frame: pl.DataFrame, expr: dict[str, Any], precision: int, scale: int
) -> pl.Expr:
    if expr["kind"] in {"col", "literal"}:
        return _operand(expr, precision, scale)
    if expr["kind"] not in {"comparison", "arithmetic"}:
        raise KernelError("unsupported_expression")
    left = _operand(expr["left"], precision, scale)
    right = _operand(expr["right"], precision, scale)
    if expr["kind"] == "comparison":
        functions = {
            "eq": operator.eq,
            "ne": operator.ne,
            "lt": operator.lt,
            "lte": operator.le,
            "gt": operator.gt,
            "gte": operator.ge,
        }
    else:
        functions = {"add": operator.add, "subtract": operator.sub}
        dtypes = frame.select(left.alias("left"), right.alias("right")).dtypes
        if any(not dtype.is_decimal() for dtype in dtypes):
            raise KernelError("unsupported_arithmetic_type")
    if expr["operator"] not in functions:
        raise KernelError("unsupported_operator")
    return functions[expr["operator"]](left, right)


def apply_operation(
    frame: pl.DataFrame,
    operation: dict[str, Any],
    *,
    precision: int,
    scale: int,
    right: pl.DataFrame | None = None,
) -> pl.DataFrame:
    """Applique une opération déjà validée par le contrat canonique.

    Primitive interne de calcul, pas admission d'ExcelProcedure. Les IDs input /
    output sont résolus par l'appelant de confiance ; aucun binding n'est ouvert.
    Une future entrée produit doit valider le schéma et les droits en amont.
    """
    frame = _bounded(frame, precision, scale)
    try:
        match operation["op"]:
            case "select":
                result = frame.select(operation["columns"])
            case "cast":
                if operation["type"] != "decimal" or operation["onInvalid"] != "reject":
                    raise KernelError("unsupported_cast")
                name = operation["column"]
                result = frame.with_columns(
                    decimal_series(
                        name, frame[name].to_list(), precision=precision, scale=scale
                    )
                )
            case "sort":
                keys = operation["keys"]
                result = frame.sort(
                    [key["column"] for key in keys],
                    descending=[key["direction"] == "desc" for key in keys],
                    nulls_last=[key["nulls"] == "last" for key in keys],
                    maintain_order=True,
                )
            case "aggregate":
                result = aggregate(
                    frame,
                    operation["groupBy"],
                    operation["values"],
                    precision=precision,
                    scale=scale,
                )
            case "join":
                if right is None or operation["onUnmatched"] != "reject":
                    raise KernelError("unsupported_join")
                result = join(
                    frame,
                    _bounded(right, precision, scale),
                    operation["leftKeys"],
                    operation["rightKeys"],
                    operation["how"],
                    operation["cardinality"],
                )
            case "derive":
                result = frame.with_columns(
                    _expression(frame, operation["expression"], precision, scale).alias(
                        operation["column"]
                    )
                )
            case "filter":
                result = frame.filter(
                    _expression(frame, operation["predicate"], precision, scale)
                )
            case _:
                raise KernelError("unsupported_operation")
        return _bounded(result, precision, scale)
    except (pl.exceptions.PolarsError, KeyError, TypeError) as exc:
        raise KernelError("invalid_operation") from exc
