# Copyright (c) 2026 Memlia. All rights reserved.
"""Host-only container transport; unavailable without captured operator admission.

The caller must still authorize inputs and revalidate the complete worker wire.
No CLI, socket server, arbitrary command, job scheduler or publication authority.
"""
import json
from hashlib import sha256
import importlib.util
import os
from pathlib import Path
import re
import selectors
import subprocess
import tempfile
import time
import uuid

_admission_spec = importlib.util.spec_from_file_location(
    'excel_operator_admission', Path(__file__).with_name('admission.py'))
admission = importlib.util.module_from_spec(_admission_spec)
_admission_spec.loader.exec_module(admission)

MAX_WIRE = 14 * 1024**2
# Historical marker stays empty. Admission is an explicit protected operator file,
# captured by the host outside the request; no mutable in-process allowlist.
QUALIFIED_IMAGES = frozenset()
SOURCE_SHA256 = sha256(Path(__file__).read_bytes()).hexdigest()
IMAGE = re.compile(r"sha256:[a-f0-9]{64}\Z")
ID = re.compile(r"[a-f0-9]{64}\Z")
TMP = "rw,noexec,nosuid,nodev,size=134217728,mode=0700,uid=65532,gid=65532"
COMMAND = ["-i", "HOME=/tmp", "TMPDIR=/tmp", "PATH=/usr/local/bin:/usr/bin:/bin",
           "LANG=C.UTF-8", "POLARS_MAX_THREADS=1", "OPENBLAS_NUM_THREADS=1", "OMP_NUM_THREADS=1",
           "/opt/excel/runtime/bin/python", "-I", "-B", "-m", "memlia_excel.process"]
HOST = {
    "NetworkMode": "none", "ReadonlyRootfs": True, "Privileged": False,
    "CapDrop": ["ALL"], "SecurityOpt": ["no-new-privileges:true"],
    "Memory": 512*1024**2, "MemorySwap": 512*1024**2, "NanoCpus": 1000000000,
    "PidsLimit": 32, "ShmSize": 8*1024**2, "Tmpfs": {"/tmp": TMP},
    "PidMode": "", "IpcMode": "private", "UTSMode": "", "UsernsMode": "",
    "RestartPolicy": {"Name": "no", "MaximumRetryCount": 0},
    "AutoRemove": False, "Init": True, "LogConfig": {"Type": "none", "Config": {}},
}

class IsolationError(ValueError):
    """Fixed refusal only; receipt is host-private ownership metadata, not a result."""

    def __init__(self, code="excel_isolation_refused", receipt=None):
        super().__init__(code)
        self.receipt = dict(receipt or {"containerId": None, "nonce": None,
                                       "createAcknowledged": False, "cleanupComplete": True})


def refuse():
    raise IsolationError("excel_isolation_refused")


def _command(argv, payload, deadline, cancel, cwd, limit=MAX_WIRE):
    """Bound all three pipes; kill/wait only the Popen child on any interruption."""
    child = None
    output = bytearray()
    try:
        if time.monotonic() >= deadline or (cancel and cancel.is_set()):
            refuse()
        child = subprocess.Popen(argv, cwd=cwd, shell=False, env={
            "PATH": "/usr/bin:/bin", "HOME": str(cwd), "DOCKER_CONFIG": str(cwd),
            "LANG": "C.UTF-8"}, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        with selectors.DefaultSelector() as poll:
            for pipe in (child.stdin, child.stdout, child.stderr):
                os.set_blocking(pipe.fileno(), False)
            poll.register(child.stdout, selectors.EVENT_READ)
            poll.register(child.stderr, selectors.EVENT_READ)
            if payload:
                poll.register(child.stdin, selectors.EVENT_WRITE)
            else:
                child.stdin.close()
            sent = 0
            while poll.get_map():
                if time.monotonic() >= deadline or (cancel and cancel.is_set()):
                    refuse()
                for key, _ in poll.select(min(.05, max(0, deadline-time.monotonic()))):
                    pipe = key.fileobj
                    if pipe is child.stdin:
                        count = os.write(pipe.fileno(), payload[sent:sent+65536])
                        sent += count
                        if sent == len(payload):
                            poll.unregister(pipe)
                            pipe.close()
                    else:
                        chunk = os.read(pipe.fileno(), 65536)
                        if not chunk:
                            poll.unregister(pipe)
                            pipe.close()
                        elif pipe is child.stderr or len(output)+len(chunk) > limit:
                            refuse()
                        else:
                            output.extend(chunk)
            remaining = deadline-time.monotonic()
            if remaining <= 0 or child.wait(timeout=remaining) != 0 or (cancel and cancel.is_set()):
                refuse()
        return bytes(output)
    except (OSError, ValueError, subprocess.TimeoutExpired):
        raise IsolationError("excel_isolation_refused") from None
    finally:
        if child is not None:
            if child.poll() is None:
                try:
                    child.terminate()
                except ProcessLookupError:
                    pass
                try:
                    child.wait(timeout=1)
                except subprocess.TimeoutExpired:
                    try:
                        child.kill()
                    except ProcessLookupError:
                        pass
                    try:
                        child.wait(timeout=1)
                    except subprocess.TimeoutExpired:
                        raise IsolationError("excel_isolation_refused") from None
            for pipe in (child.stdin, child.stdout, child.stderr):
                pipe.close()


def _one(raw):
    # Only bounded Docker metadata, never workbook/procedure parsing.
    try:
        value = json.loads(raw)
        if type(value) is not list or len(value) != 1 or type(value[0]) is not dict:
            refuse()
        return value[0]
    except (ValueError, UnicodeError):
        raise IsolationError("excel_isolation_refused") from None


def _inspect(docker, cid, name, nonce, image, deadline):
    row = _one(docker(["container", "inspect", cid], deadline=deadline))
    try:
        cfg, host = row["Config"], row["HostConfig"]
        if (row["Id"] != cid or row["Image"] != image or row["Name"] != "/"+name
                or cfg["Labels"].get("org.memlia.excel.nonce") != nonce
                or cfg["Labels"].get("org.memlia.excel.profile") != "v1"
                or cfg["User"] != "65532:65532" or cfg["WorkingDir"] != "/tmp"
                or cfg["Entrypoint"] != ["/usr/bin/env"] or cfg["Cmd"] != COMMAND
                or cfg["Tty"] is not False or cfg["OpenStdin"] is not True):
            refuse()
        for key, expected in HOST.items():
            # Avoid Python's True == 1 equivalence in isolation metadata.
            if type(host[key]) is not type(expected) or host[key] != expected:
                refuse()
        for key in ("CapAdd", "Binds", "Devices", "DeviceRequests", "VolumesFrom", "PortBindings"):
            if key not in host or host[key] not in (None, [], {}):
                refuse()
        # Moby HostConfig.Mounts is a request spec tagged json:",omitempty".
        # Our --tmpfs is checked in HOST; any supplied request mount still refuses.
        if "Mounts" in host and host["Mounts"] not in (None, []):
            refuse()
        limits = sorted((u["Name"], u["Soft"], u["Hard"]) for u in host["Ulimits"])
        if limits != [("core", 0, 0), ("nofile", 256, 256)]:
            refuse()
        # Docker versions may list --tmpfs here or only in HostConfig.Tmpfs.
        if type(row["Mounts"]) is not list:
            refuse()
        for mount in row["Mounts"]:
            if mount["Type"] != "tmpfs" or mount["Destination"] != "/tmp" or mount.get("Source") not in (None, ""):
                refuse()
        state = row["State"]
        if any(type(state[k]) is not bool for k in ("Running", "Paused", "Restarting", "Dead", "OOMKilled")):
            refuse()
        if type(state["ExitCode"]) is not int or type(state["Status"]) is not str or type(state["Error"]) is not str:
            refuse()
        return state
    except (KeyError, TypeError, AttributeError):
        raise IsolationError("excel_isolation_refused") from None


def _find(docker, nonce, deadline):
    raw = docker(["container", "ls", "--all", "--no-trunc", "--filter",
                  "label=org.memlia.excel.nonce="+nonce, "--format", "{{.ID}}"], deadline=deadline)
    try:
        values = raw.decode("ascii").splitlines()
        if len(values) > 1 or any(not ID.fullmatch(v) for v in values):
            refuse()
        return values[0] if values else None
    except UnicodeError:
        raise IsolationError("excel_isolation_refused") from None


def _run_owned(docker, image, wire, cancel=None, *, _receipt=None):
    """Private recipe seam; fake Docker in portable tests. No authorizing inputs."""
    if (type(image) is not str or not IMAGE.fullmatch(image) or type(wire) is not bytes
            or not 0 < len(wire) <= MAX_WIRE or (cancel and cancel.is_set())):
        refuse()
    nonce = uuid.uuid4().hex
    name = "memlia-excel-" + nonce
    cid, created, result, passed = None, False, None, False
    acknowledged, cleanup_complete = False, True
    deadline = time.monotonic() + 120
    try:
        info = _one(docker(["image", "inspect", image], deadline=deadline))
        if info.get("Id") != image or info.get("Os") != "linux" or info.get("Architecture") != "amd64":
            refuse()
        args = ["container", "create", "--pull", "never", "--name", name,
                "--label", "org.memlia.excel.nonce="+nonce, "--label", "org.memlia.excel.profile=v1",
                "--network", "none", "--read-only", "--user", "65532:65532", "--workdir", "/tmp",
                "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--memory", "536870912",
                "--memory-swap", "536870912", "--cpus", "1", "--pids-limit", "32", "--shm-size", "8388608",
                "--ipc", "private", "--tmpfs", "/tmp:"+TMP, "--ulimit", "nofile=256:256", "--ulimit", "core=0:0",
                "--restart", "no", "--log-driver", "none", "--init", "--interactive",
                "--entrypoint", "/usr/bin/env", image, *COMMAND]
        created = True  # The daemon may create it even if the CLI reply is lost.
        cleanup_complete = False
        cid = docker(args, deadline=deadline, cancel=cancel).decode("ascii").strip()
        if not ID.fullmatch(cid):
            cid = None
            refuse()
        acknowledged = True
        state = _inspect(docker, cid, name, nonce, image, deadline)
        if (state["Status"] != "created"
                or any(state[k] for k in ("Running", "Paused", "Restarting", "Dead", "OOMKilled"))
                or state["ExitCode"] != 0 or state["Error"]):
            refuse()
        result = docker(["container", "start", "--attach", "--interactive", cid], wire,
                        deadline=deadline, cancel=cancel, limit=MAX_WIRE)
        state = _inspect(docker, cid, name, nonce, image, deadline)
        if (state["Status"] != "exited" or any(state[k] for k in ("Running", "Paused", "Restarting", "Dead", "OOMKilled"))
                or state["ExitCode"] != 0 or state["Error"] or not result or (cancel and cancel.is_set())):
            refuse()
        passed = True
    except (OSError, ValueError, UnicodeError):
        passed = False
    finally:
        # A separate ten-second cleanup allowance cannot extend execution.
        cleanup_deadline = time.monotonic()+10
        if created:
            try:
                if cid is None:
                    cid = _find(docker, nonce, cleanup_deadline)
                if cid:
                    state = _inspect(docker, cid, name, nonce, image, cleanup_deadline)
                    if state["Running"]:
                        docker(["container", "stop", "--time", "1", cid], deadline=cleanup_deadline)
                        state = _inspect(docker, cid, name, nonce, image, cleanup_deadline)
                    if state["Running"] or state["Paused"] or state["Restarting"]:
                        refuse()
                    docker(["container", "rm", cid], deadline=cleanup_deadline)
                if _find(docker, nonce, cleanup_deadline) is not None:
                    refuse()
                # Empty lookup after a lost create reply cannot prove that the
                # daemon won't finish creating the resource later.
                cleanup_complete = cid is not None
            except (OSError, ValueError, UnicodeError):
                passed = False
        if cancel and cancel.is_set():
            passed = False
    receipt = {"containerId": cid, "nonce": nonce, "createAcknowledged": acknowledged,
               "cleanupComplete": cleanup_complete}
    if _receipt is not None:
        _receipt.update(receipt)
    if not passed:
        raise IsolationError(receipt=receipt)
    return result


def execute(image, wire, *, cancel=None, image_admission=None):
    """Server-only entry; requires the exact image's captured local operator approval."""
    if (type(image) is not str or os.uname().sysname != "Linux"
            or not admission.permits(image_admission, image, SOURCE_SHA256)):
        raise IsolationError("excel_isolation_unavailable")
    with tempfile.TemporaryDirectory(prefix="memlia-excel-host-") as temporary:
        os.chmod(temporary, 0o700)
        def docker(args, payload=b"", *, deadline, cancel=None, limit=1024**2):
            return _command(["/usr/bin/docker", "--host", "unix:///var/run/docker.sock", *args],
                            payload, deadline, cancel, Path(temporary), limit)
        receipt = {}
        wire = _run_owned(docker, image, wire, cancel, _receipt=receipt)
        return wire, receipt
