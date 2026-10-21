# Copyright (c) 2026 Memlia. All rights reserved.
"""Fake Docker state, real bounded pipe children; not Linux isolation evidence."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("excel_linux", Path(__file__).with_name("supervisor.py"))
s = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)
IMAGE = "sha256:" + "a" * 64
CID = "b" * 64
TMP = "rw,noexec,nosuid,nodev,size=134217728,mode=0700,uid=65532,gid=65532"
COMMAND = ["-i", "HOME=/tmp", "TMPDIR=/tmp", "PATH=/usr/local/bin:/usr/bin:/bin", "LANG=C.UTF-8", "POLARS_MAX_THREADS=1", "OPENBLAS_NUM_THREADS=1", "OMP_NUM_THREADS=1", "/opt/excel/runtime/bin/python", "-I", "-B", "-m", "memlia_excel.process"]

class Engine:
    def __init__(self):
        self.calls = []
        self.row = None
        self.result = b'{"fixture":"complete-output-not-a-real-worker"}\n'
        self.before_inspect = None
        self.start_error = False
        self.remove_error = False
        self.uncertain_create = False
        self.inspections = 0

    def __call__(self, args, payload=b"", *, deadline, cancel=None, limit=1024**2):
        self.calls.append((list(args), payload))
        if args[:2] == ["image", "inspect"]:
            return json.dumps([{"Id": IMAGE, "Os": "linux", "Architecture": "amd64"}]).encode()
        if args[:2] == ["container", "create"]:
            def option(key):
                return args[args.index(key) + 1]
            labels = [args[n+1] for n, x in enumerate(args) if x == "--label"]
            self.row = {
                "Id": CID, "Name": "/" + option("--name"), "Image": IMAGE,
                "Config": {"User": "65532:65532", "WorkingDir": "/tmp", "Entrypoint": ["/usr/bin/env"], "Cmd": COMMAND,
                           "Tty": False, "OpenStdin": True, "Labels": dict(x.split("=", 1) for x in labels)},
                "HostConfig": {"NetworkMode": "none", "ReadonlyRootfs": True, "Privileged": False,
                    "CapDrop": ["ALL"], "CapAdd": None, "SecurityOpt": ["no-new-privileges:true"],
                    "Memory": 512*1024**2, "MemorySwap": 512*1024**2, "NanoCpus": 1000000000, "PidsLimit": 32,
                    "ShmSize": 8*1024**2, "Tmpfs": {"/tmp": TMP}, "Binds": None, "Mounts": None,
                    "Devices": [], "DeviceRequests": None, "VolumesFrom": None, "PortBindings": {},
                    "PidMode": "", "IpcMode": "private", "UTSMode": "", "UsernsMode": "",
                    "RestartPolicy": {"Name": "no", "MaximumRetryCount": 0}, "AutoRemove": False, "Init": True,
                    "LogConfig": {"Type": "none", "Config": {}},
                    "Ulimits": [{"Name":"nofile", "Soft":256, "Hard":256}, {"Name":"core", "Soft":0, "Hard":0}]},
                "Mounts": [], "State": {"Status":"created", "Running":False, "Paused":False, "Restarting":False,
                    "Dead":False, "ExitCode":0, "OOMKilled":False, "Error":""}}
            if self.uncertain_create:
                raise s.IsolationError("excel_isolation_refused")
            return (CID + "\n").encode()
        if args[:2] == ["container", "inspect"]:
            self.inspections += 1
            if self.before_inspect:
                self.before_inspect(self.row, self.inspections)
            return json.dumps([self.row]).encode()
        if args[:2] == ["container", "start"]:
            self.row["State"].update(Status="running", Running=True)
            if self.start_error:
                raise s.IsolationError("excel_isolation_refused")
            self.row["State"].update(Status="exited", Running=False)
            return self.result
        if args[:2] == ["container", "stop"]:
            self.row["State"].update(Status="exited", Running=False, ExitCode=143)
            return (CID + "\n").encode()
        if args[:2] == ["container", "rm"]:
            if self.remove_error:
                raise s.IsolationError("excel_isolation_refused")
            self.row = None
            return (CID + "\n").encode()
        if args[:2] == ["container", "ls"]:
            return ((CID + "\n") if self.row else "").encode()
        raise AssertionError("unexpected fixed command")

    def actions(self):
        return [args[1] for args, _ in self.calls if args[0] == "container"]

class LifecycleTests(unittest.TestCase):
    def test_public_entry_blocked_before_docker(self):
        self.assertEqual(s.QUALIFIED_IMAGES, frozenset())
        with self.assertRaisesRegex(s.IsolationError, "^excel_isolation_unavailable$"):
            s.execute(IMAGE, b"{}")

    def test_complete_output_only_after_checked_removal(self):
        engine = Engine()
        result = s._run_owned(engine, IMAGE, b"fixture-input")
        self.assertEqual(result, engine.result)
        self.assertEqual(engine.actions(), ["create", "inspect", "start", "inspect", "inspect", "rm", "ls"])
        args, payload = next(call for call in engine.calls if call[0][1] == "start")
        self.assertEqual(args, ["container", "start", "--attach", "--interactive", CID])
        self.assertEqual(payload, b"fixture-input")
        create = next(args for args, _ in engine.calls if args[1] == "create")
        for option in ["--network", "--read-only", "--memory-swap", "--pids-limit", "--log-driver", "--tmpfs"]:
            self.assertIn(option, create)
        self.assertNotIn("fixture-input", " ".join(create))
        self.assertIsNone(engine.row)

    def test_each_isolation_or_identity_mismatch_blocks_start_and_removal(self):
        changes = [
            lambda r: r.update(Id="c"*64), lambda r: r.update(Image="sha256:"+"c"*64),
            lambda r: r.update(Name="/foreign"), lambda r: r["Config"]["Labels"].clear(),
            lambda r: r["Config"].update(User="0", Cmd=["sh"]),
            lambda r: r["HostConfig"].update(NetworkMode="bridge"),
            lambda r: r["HostConfig"].update(ReadonlyRootfs=False),
            lambda r: r["HostConfig"].update(MemorySwap=-1),
            lambda r: r["HostConfig"].update(Privileged=True),
            lambda r: r["HostConfig"].update(SecurityOpt=["seccomp=unconfined"]),
            lambda r: r["HostConfig"].update(Binds=["/:/host"]),
            lambda r: r["HostConfig"].update(PidsLimit=0),
            lambda r: r["HostConfig"].update(Tmpfs={}),
            lambda r: r["HostConfig"].update(LogConfig={"Type":"json-file"}),
            lambda r: r["HostConfig"].pop("Memory", None),
        ]
        for change in changes:
            with self.subTest(change=changes.index(change)):
                engine = Engine()
                engine.before_inspect = lambda row, count: change(row)
                with self.assertRaisesRegex(s.IsolationError, "^excel_isolation_refused$"):
                    s._run_owned(engine, IMAGE, b"{}")
                self.assertNotIn("start", engine.actions())
                self.assertNotIn("stop", engine.actions())
                self.assertNotIn("rm", engine.actions())

    def test_timeout_or_cancel_requires_owned_stop_wait_remove(self):
        engine = Engine()
        engine.start_error = True
        with self.assertRaises(s.IsolationError):
            s._run_owned(engine, IMAGE, b"{}")
        self.assertEqual(engine.actions(), ["create", "inspect", "start", "inspect", "stop", "inspect", "rm", "ls"])
        self.assertIsNone(engine.row)

    def test_changed_identity_during_start_never_signals_foreign(self):
        engine = Engine()
        engine.start_error = True
        engine.before_inspect = lambda row, count: row.update(Id="c"*64) if count > 1 else None
        with self.assertRaises(s.IsolationError):
            s._run_owned(engine, IMAGE, b"{}")
        self.assertNotIn("stop", engine.actions())
        self.assertNotIn("rm", engine.actions())

    def test_oom_nonzero_dead_and_running_never_return_partial_result(self):
        for state in [{"OOMKilled":True}, {"ExitCode":2}, {"Dead":True}, {"Running":True, "Status":"running"}]:
            engine = Engine()
            engine.before_inspect = lambda row, count: row["State"].update(state) if count == 2 else None
            with self.subTest(state=state), self.assertRaises(s.IsolationError):
                s._run_owned(engine, IMAGE, b"{}")

    def test_create_response_unknown_recovers_only_exact_nonce_identity_for_cleanup(self):
        engine = Engine()
        engine.uncertain_create = True
        with self.assertRaises(s.IsolationError):
            s._run_owned(engine, IMAGE, b"{}")
        self.assertNotIn("start", engine.actions())
        self.assertIn("inspect", engine.actions())
        self.assertIn("rm", engine.actions())
        self.assertIsNone(engine.row)

    def test_refusal_retains_only_closed_ownership_receipt(self):
        engine = Engine(); engine.remove_error = True
        with self.assertRaises(s.IsolationError) as raised:
            s._run_owned(engine, IMAGE, b"NEVER-IN-RECEIPT")
        receipt = raised.exception.receipt
        self.assertEqual(set(receipt), {"containerId", "nonce", "createAcknowledged", "cleanupComplete"})
        self.assertEqual(receipt["containerId"], CID)
        self.assertFalse(receipt["cleanupComplete"])
        self.assertTrue(receipt["createAcknowledged"])
        self.assertNotIn("NEVER-IN-RECEIPT", json.dumps(receipt))

    def test_cancel_during_cleanup_never_becomes_success(self):
        engine = Engine(); event = threading.Event()
        engine.before_inspect = lambda row, count: event.set() if count == 3 else None
        with self.assertRaises(s.IsolationError) as raised:
            s._run_owned(engine, IMAGE, b"{}", event)
        self.assertIsNone(engine.row)
        self.assertTrue(raised.exception.receipt["cleanupComplete"])

    def test_replaced_owner_just_before_removal_is_not_removed(self):
        engine = Engine()
        engine.before_inspect = lambda row, count: row["Config"]["Labels"].clear() if count == 3 else None
        with self.assertRaises(s.IsolationError):
            s._run_owned(engine, IMAGE, b"{}")
        self.assertNotIn("rm", engine.actions())

    def test_unknown_creation_remains_unknown_even_when_lookup_empty(self):
        engine = Engine(); engine.uncertain_create = True
        native = engine.__call__
        def lost_reply(args, *rest, **kwargs):
            if args[:2] == ["container", "ls"]:
                return b""
            return native(args, *rest, **kwargs)
        with self.assertRaises(s.IsolationError) as raised:
            s._run_owned(lost_reply, IMAGE, b"{}")
        self.assertFalse(raised.exception.receipt["createAcknowledged"])
        self.assertFalse(raised.exception.receipt["cleanupComplete"])
        self.assertNotIn("rm", engine.actions())

    def test_remove_failure_does_not_release_success(self):
        engine = Engine()
        engine.remove_error = True
        with self.assertRaises(s.IsolationError):
            s._run_owned(engine, IMAGE, b"{}")
        self.assertIn("rm", engine.actions())

    def test_bad_image_oversize_or_pre_cancel_has_no_side_effect(self):
        event = threading.Event(); event.set()
        for image, wire, cancel in [("tag:latest", b"{}", None), (IMAGE, b"x"*(s.MAX_WIRE+1), None), (IMAGE, b"{}", event)]:
            engine = Engine()
            with self.subTest(image=image[:8]), self.assertRaises(s.IsolationError):
                s._run_owned(engine, image, wire, cancel)
            self.assertEqual(engine.calls, [])

class PipeTests(unittest.TestCase):
    def run_child(self, code, payload=b"", timeout=2, cancel=None, limit=1024):
        with tempfile.TemporaryDirectory() as directory:
            return s._command([sys.executable, "-I", "-B", "-c", code], payload, time.monotonic()+timeout, cancel, Path(directory), limit)

    def test_real_pipes_eof_exact_output_and_closed_environment(self):
        with mock.patch.dict(os.environ, {"MEMLIA_CANARY_SECRET": "fictitious-private-canary"}):
            result = self.run_child("import os,sys; data=sys.stdin.buffer.read(); assert 'MEMLIA_CANARY_SECRET' not in os.environ;sys.stdout.buffer.write(data)", b"complete")
        self.assertEqual(result, b"complete")

    def test_real_overflow_stderr_nonzero_timeout_refuse(self):
        for code in ["print('x'*2048)", "import sys;sys.stderr.write('private-canary')", "raise SystemExit(3)", "import time;time.sleep(3)"]:
            with self.subTest(code=code), self.assertRaisesRegex(s.IsolationError, "^excel_isolation_refused$"):
                self.run_child(code, timeout=.3)

    def test_real_killed_child_is_waited_before_refusal_returns(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory)/"child.pid"
            code = "import os,time,pathlib;pathlib.Path(" + repr(str(marker)) + ").write_text(str(os.getpid()));time.sleep(20)"
            observed = threading.Event()
            done = threading.Event()
            def watch_marker():
                end = time.monotonic()+2
                while not done.wait(.01) and time.monotonic() < end:
                    if marker.exists():
                        observed.set()
                        return
            watcher = threading.Thread(target=watch_marker)
            watcher.start()
            try:
                with self.assertRaises(s.IsolationError):
                    self.run_child(code, timeout=3, cancel=observed)
            finally:
                done.set()
                watcher.join(timeout=3)
            self.assertTrue(observed.is_set(), "owned child must be observed before cancellation")
            self.assertFalse(watcher.is_alive())
            pid = int(marker.read_text())
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)

    def test_real_cancellation_waits_owned_child(self):
        event = threading.Event()
        timer = threading.Timer(.1, event.set); timer.start()
        try:
            with self.assertRaises(s.IsolationError):
                self.run_child("import time;time.sleep(3)", cancel=event)
        finally:
            timer.join()

if __name__ == "__main__":
    unittest.main()
