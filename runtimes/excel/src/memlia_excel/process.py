# Copyright (c) 2026 Memlia. All rights reserved.
"""One bounded declarative request; no paths, commands, authority or publication."""
import base64
from contextlib import redirect_stderr, redirect_stdout
import json
import os
from pathlib import Path
import stat
import sys

VERSION = "memlia.excel-process/v1"
MAX_WIRE = 14 * 1024 * 1024
MAX_CONTENT = 10_000_000


class Refused(ValueError):
    pass


def require(condition, code="invalid_request"):
    if not condition:
        raise Refused(code)


def exact(value, names):
    require(type(value) is dict and set(value) == set(names))


def text(value):
    require(type(value) is str and 0 < len(value) <= 128)
    return value


def pairs(items):
    result = {}
    for key, value in items:
        require(key not in result)
        result[key] = value
    return result


def non_json(_value):
    raise Refused("invalid_request")


def private_temp():
    value = os.environ.get("TMPDIR")
    require(value is not None and os.path.isabs(value), "runtime_unavailable")
    folder = Path(value)
    info = folder.lstat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid()
            and stat.S_IMODE(info.st_mode) == 0o700 and os.access(folder, os.W_OK),
            "runtime_unavailable")


def prepare(raw):
    # The package initializer is inert; TMPDIR has been checked before importing
    # Polars/openpyxl. The transport delegates the ENTIRE procedure to the kernel.
    from .procedure import MEMORY_PROFILE, OutputTarget, ResolvedXlsx, prepare_procedure

    exact(raw, ("schemaVersion", "requestId", "profile", "procedure", "sources", "targets"))
    require(raw["schemaVersion"] == VERSION and raw["profile"] == MEMORY_PROFILE)
    text(raw["requestId"])
    sources, targets, total = {}, {}, 0
    for values in (raw["sources"], raw["targets"]):
        require(type(values) is dict and 0 < len(values) <= 32)
    for role, value in raw["sources"].items():
        text(role)
        exact(value, ("bindingId", "sheetId", "sheetName", "contentBase64", "sha256"))
        metadata = [text(value[key]) for key in ("bindingId", "sheetId", "sheetName")]
        encoded = value["contentBase64"]
        require(type(encoded) is str and len(encoded) <= 4 * ((MAX_CONTENT + 2) // 3), "input_limit")
        require(len(encoded) % 4 == 0)
        estimated = len(encoded) // 4 * 3 - (2 if encoded.endswith("==") else 1 if encoded.endswith("=") else 0)
        total += estimated
        require(total <= MAX_CONTENT, "input_limit")
        content = base64.b64decode(encoded, validate=True)
        require(base64.b64encode(content).decode("ascii") == encoded)
        sources[role] = ResolvedXlsx(*metadata, content, text(value["sha256"]))
    for role, value in raw["targets"].items():
        text(role)
        exact(value, ("bindingId", "sheetId", "sheetName"))
        targets[role] = OutputTarget(*(text(value[key]) for key in ("bindingId", "sheetId", "sheetName")))
    try:
        result = prepare_procedure(raw["procedure"], sources, targets, profile=raw["profile"])
    except Exception:
        raise Refused("procedure_refused") from None
    require(sum(len(item.content) for item in result.outputs) <= MAX_CONTENT, "output_limit")
    return {
        "schemaVersion": VERSION, "requestId": raw["requestId"],
        "status": result.status, "published": result.published,
        "outputs": [{"role": item.role, "bindingId": item.binding_id, "sheetId": item.sheet_id,
                     "contentBase64": base64.b64encode(item.content).decode("ascii"), "sha256": item.sha256}
                    for item in result.outputs],
        "controls": [{"index": item.index, "kind": item.kind, "severity": item.severity,
                      "satisfied": item.satisfied} for item in result.controls],
    }


def main():
    error = None
    try:
        require(len(sys.argv) == 1)
        private_temp()
        payload = sys.stdin.buffer.read(MAX_WIRE + 1)
        require(len(payload) <= MAX_WIRE, "input_limit")
        raw = json.loads(payload.decode("utf-8"), object_pairs_hook=pairs, parse_constant=non_json)
        with open(os.devnull, "w") as sink, redirect_stdout(sink), redirect_stderr(sink):
            answer = prepare(raw)
        output = json.dumps(answer, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode()
        require(len(output) + 1 <= MAX_WIRE, "output_limit")
    except Refused as caught:
        error = str(caught)
    except (ValueError, TypeError, UnicodeError, RecursionError):
        error = "invalid_request"
    except Exception:
        error = "runtime_unavailable"
    # No native traceback/cause/data leaves the process. Interruptions are not success.
    if error is not None:
        output = json.dumps({"schemaVersion": VERSION, "status": "refused", "code": error}).encode()
    sys.stdout.buffer.write(output + b"\n")
    sys.stdout.buffer.flush()
    return 2 if error is not None else 0


if __name__ == "__main__":
    raise SystemExit(main())
