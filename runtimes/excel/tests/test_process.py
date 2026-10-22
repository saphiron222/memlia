# Copyright (c) 2026 Memlia. All rights reserved.
"""Real owned Python process + canonical procedure/Polars/XLSX, no OS sandbox claim."""
import base64
from copy import deepcopy
from hashlib import sha256
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

import pytest
from memlia_excel.xlsx import read_table
from test_procedure import fixture

VERSION = "memlia.excel-process/v1"


def request():
    recipe, sources, targets = fixture()
    return {
        "schemaVersion": VERSION,
        "requestId": "process-fixture",
        "profile": "memlia.excel-memory/a1-header-v1",
        "procedure": recipe,
        "sources": {role: {"bindingId": item.binding_id, "sheetId": item.sheet_id,
                            "sheetName": item.sheet_name, "contentBase64": base64.b64encode(item.content).decode(),
                            "sha256": item.sha256} for role, item in sources.items()},
        "targets": {role: {"bindingId": item.binding_id, "sheetId": item.sheet_id,
                            "sheetName": item.sheet_name} for role, item in targets.items()},
    }


def child(payload, *, tmp_mode=0o700, symlink=False):
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory); private = root / "private"; private.mkdir(mode=tmp_mode); private.chmod(tmp_mode)
        selected = private
        if symlink:
            selected = root / "link"; selected.symlink_to(private, target_is_directory=True)
        # Source-path loader only for tests; installed -I path is qualified separately.
        env = {key: value for key, value in os.environ.items() if key in ("PATH", "PYTHONPATH")}
        env.update(TMPDIR=str(selected), HOME=str(private), POLARS_MAX_THREADS="1", PYTHONDONTWRITEBYTECODE="1")
        result = subprocess.run([sys.executable, "-B", "-m", "memlia_excel.process"], input=payload,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=root, env=env, timeout=15)
        assert list(private.iterdir()) == []
        return result


def wire(value):
    return json.dumps(value, separators=(",", ":"), allow_nan=False).encode()


def test_real_child_prepares_complete_readback_without_changing_sources():
    data = request(); before = deepcopy(data)
    result = child(wire(data))
    assert result.returncode == 0
    answer = json.loads(result.stdout)
    assert result.stderr == b""
    assert answer["status"] == "prepared_in_memory" and answer["published"] is False
    assert answer["requestId"] == data["requestId"]
    assert len(answer["outputs"]) == 1
    output = answer["outputs"][0]; content = base64.b64decode(output["contentBase64"], validate=True)
    assert output["sha256"] == "sha256:" + sha256(content).hexdigest()
    table = read_table(content, expected_digest=sha256(content).hexdigest(), sheet="Result",
                       columns={"id":"string", "debit":"decimal", "credit":"decimal"}, precision=18, scale=2)
    assert table["id"].to_list() == ["a", "b"]
    assert [str(item) for item in table["debit"]] == ["0.10", "0.20"]
    assert answer["controls"] == [{"index":0,"kind":"balance","severity":"blocking","satisfied":True}]
    assert data == before


@pytest.mark.parametrize("case", ["extra", "command", "base64", "digest", "binding", "canonical", "control", "duplicate", "trailing", "nan", "oversize"])
def test_refusals_are_closed_and_never_partial(case):
    data = request()
    if case == "extra": data["PRIVATE_CANARY"] = "PRIVATE_CANARY"
    if case == "command": data["sources"]["source"]["path"] = "PRIVATE_CANARY"
    if case == "base64": data["sources"]["source"]["contentBase64"] = "PRIVATE_CANARY"
    if case == "digest": data["sources"]["source"]["sha256"] = "sha256:" + "0" * 64
    if case == "binding": data["targets"]["result"]["bindingId"] = "PRIVATE_CANARY"
    if case == "canonical": data["procedure"]["operations"][0]["code"] = "PRIVATE_CANARY"
    if case == "control": data["procedure"]["controls"][0]["credit"] = "id"
    payload = wire(data)
    if case == "duplicate": payload = b'{"schemaVersion":"PRIVATE_CANARY",' + payload[1:]
    if case == "trailing": payload += b' {}'
    if case == "nan": payload = b'{"PRIVATE_CANARY":NaN}'
    if case == "oversize": payload = b" " * (14 * 1024 * 1024 + 1)
    result = child(payload)
    assert result.returncode == 2
    answer = json.loads(result.stdout)
    assert set(answer) == {"schemaVersion", "status", "code"}
    assert answer["schemaVersion"] == VERSION and answer["status"] == "refused"
    assert answer["code"] in {"invalid_request", "input_limit", "procedure_refused"}
    assert b"PRIVATE_CANARY" not in result.stdout + result.stderr
    assert result.stderr == b""


@pytest.mark.parametrize("kwargs", [{"tmp_mode":0o755}, {"symlink":True}])
def test_temporary_directory_is_explicit_private_and_not_a_symlink(kwargs):
    result = child(wire(request()), **kwargs)
    assert result.returncode == 2
    assert json.loads(result.stdout)["code"] == "runtime_unavailable"
    assert result.stderr == b""
