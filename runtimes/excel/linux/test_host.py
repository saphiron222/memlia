# Copyright (c) 2026 Memlia. All rights reserved.
"""Real Unix socket bytes; peer identity and container execution doubled on Mac."""

import os
import json
from pathlib import Path
import socket
import tempfile
import time
import struct
import threading
import unittest
from unittest import mock

import host

IMAGE = "sha256:" + "a" * 64


class HostTests(unittest.TestCase):
    def exchange(self, wire=b"{}", *, result=b'{"native":"wire"}\n', peer=1001):
        server, client = socket.socketpair()
        client.settimeout(2)
        stop = threading.Event()

        def execute(image, body, *, cancel):
            self.assertEqual(image, IMAGE)
            self.assertEqual(body, wire)
            self.assertFalse(cancel.is_set())
            return result, {"cleanupComplete": True}

        with (
            mock.patch.object(host, "peer_uid", return_value=peer),
            mock.patch.object(
                host.supervisor, "execute", side_effect=execute
            ) as native,
        ):
            thread = threading.Thread(
                target=host.handle, args=(server, IMAGE, 1001, stop)
            )
            thread.start()
            try:
                chunks = []
                try:
                    client.sendall(struct.pack("!I", len(wire)) + wire)
                    while chunk := client.recv(65536):
                        chunks.append(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    self.assertNotEqual(peer, 1001)
                return b"".join(chunks), native.call_count
            finally:
                client.close()
                stop.set()
                thread.join(2)
                self.assertFalse(thread.is_alive())

    def test_response_only_after_native_cleanup_and_exact_wire(self):
        result = b'{"native":"wire"}\n'
        response, calls = self.exchange(result=result)
        self.assertEqual(response, b"\0" + struct.pack("!I", len(result)) + result)
        self.assertEqual(calls, 1)

    def test_wrong_peer_never_calls_supervisor(self):
        response, calls = self.exchange(peer=1002)
        self.assertIn(response, (host.REFUSED, b""))
        self.assertEqual(calls, 0)

    def test_unknown_image_uses_real_gate_without_docker(self):
        server, client = socket.socketpair()
        client.settimeout(2)
        with mock.patch.object(host, "peer_uid", return_value=1001):
            thread = threading.Thread(
                target=host.handle, args=(server, IMAGE, 1001, threading.Event())
            )
            thread.start()
            try:
                client.sendall(struct.pack("!I", 2) + b"{}")
                self.assertEqual(client.recv(100), host.REFUSED)
            finally:
                client.close()
                thread.join(2)
                self.assertFalse(thread.is_alive())
        self.assertEqual(host.supervisor.QUALIFIED_IMAGES, frozenset())

    def test_bounded_header_refuses_before_execute(self):
        for size in (0, host.MAX_WIRE + 1):
            server, client = socket.socketpair()
            client.settimeout(2)
            with (
                mock.patch.object(host, "peer_uid", return_value=1001),
                mock.patch.object(host.supervisor, "execute") as native,
            ):
                thread = threading.Thread(
                    target=host.handle, args=(server, IMAGE, 1001, threading.Event())
                )
                thread.start()
                try:
                    client.sendall(struct.pack("!I", size))
                    self.assertEqual(client.recv(10), host.REFUSED)
                finally:
                    client.close()
                    thread.join(2)
                self.assertFalse(thread.is_alive())
                native.assert_not_called()

    def test_disconnect_and_stop_cancel_native_work_before_any_result(self):
        for disconnect in (True, False):
            server, client = socket.socketpair()
            client.settimeout(2)
            entered = threading.Event()
            stopped = threading.Event()
            stop = threading.Event()
            observed = []

            def native(image, wire, *, cancel):
                entered.set()
                self.assertTrue(cancel.wait(1))
                stopped.set()
                return b"not-deliverable", {"cleanupComplete": True}

            with (
                mock.patch.object(host, "peer_uid", return_value=1001),
                mock.patch.object(host.supervisor, "execute", side_effect=native),
            ):
                thread = threading.Thread(
                    target=lambda: observed.append(
                        host.handle(server, IMAGE, 1001, stop)
                    )
                )
                thread.start()
                try:
                    client.sendall(struct.pack("!I", 2) + b"{}")
                    self.assertTrue(entered.wait(1))
                    if disconnect:
                        client.close()
                    else:
                        stop.set()
                        self.assertEqual(client.recv(100), host.REFUSED)
                finally:
                    client.close()
                    stop.set()
                    thread.join(2)
                self.assertFalse(thread.is_alive())
                self.assertTrue(stopped.is_set())
                self.assertEqual(observed, [True])

    def test_unknown_cleanup_poison_is_not_success(self):
        for outcome in ("returned", "thrown"):
            server, client = socket.socketpair()
            client.settimeout(2)
            observed = []

            def native(*args, **kwargs):
                if outcome == "thrown":
                    raise host.supervisor.IsolationError(
                        receipt={"cleanupComplete": False}
                    )
                return b"not-deliverable", {"cleanupComplete": False}

            with (
                mock.patch.object(host, "peer_uid", return_value=1001),
                mock.patch.object(host.supervisor, "execute", side_effect=native),
            ):
                thread = threading.Thread(
                    target=lambda: observed.append(
                        host.handle(server, IMAGE, 1001, threading.Event())
                    )
                )
                thread.start()
                try:
                    client.sendall(struct.pack("!I", 2) + b"{}")
                    self.assertEqual(client.recv(100), host.REFUSED)
                finally:
                    client.close()
                    thread.join(2)
                self.assertFalse(thread.is_alive())
                self.assertEqual(observed, [False])

    def test_unexpected_native_errors_poison_without_result(self):
        for error_type in (OSError, ValueError, TypeError, KeyError):
            with self.subTest(error=error_type.__name__):
                server, client = socket.socketpair()
                client.settimeout(2)
                observed = []
                with (
                    mock.patch.object(host, "peer_uid", return_value=1001),
                    mock.patch.object(
                        host.supervisor,
                        "execute",
                        side_effect=error_type("private-native-error-canary"),
                    ) as native,
                ):
                    thread = threading.Thread(
                        target=lambda: observed.append(
                            host.handle(server, IMAGE, 1001, threading.Event())
                        )
                    )
                    thread.start()
                    try:
                        client.sendall(struct.pack("!I", 2) + b"{}")
                        self.assertEqual(client.recv(100), host.REFUSED)
                        self.assertEqual(client.recv(100), b"")
                    finally:
                        client.close()
                        thread.join(2)
                    self.assertFalse(thread.is_alive())
                    self.assertEqual(native.call_count, 1)
                    self.assertEqual(observed, [False])

    def test_unexpected_native_error_stops_host_without_reuse(self):
        with tempfile.TemporaryDirectory(dir=Path.home()) as directory:
            path = Path(directory) / "worker.sock"
            stop = threading.Event()
            ready = threading.Event()
            errors = []
            native_listen = socket.socket.listen

            def listening(listener, *args):
                native_listen(listener, *args)
                ready.set()

            def serve():
                try:
                    host.serve(path, IMAGE, os.getuid() + 1, os.getgid(), stop)
                except Exception as error:
                    errors.append(type(error).__name__)

            with (
                mock.patch.object(socket.socket, "listen", new=listening),
                mock.patch.object(host.sys, "platform", "linux"),
                mock.patch.object(host, "peer_uid", return_value=os.getuid() + 1),
                mock.patch.object(
                    host.supervisor,
                    "execute",
                    side_effect=ValueError("private-native-error-canary"),
                ) as native,
            ):
                thread = threading.Thread(target=serve)
                thread.start()
                first = socket.socket(socket.AF_UNIX)
                second = socket.socket(socket.AF_UNIX)
                first.settimeout(2)
                second.settimeout(2)
                try:
                    self.assertTrue(ready.wait(1))
                    first.connect(str(path))
                    first.sendall(struct.pack("!I", 2) + b"{}")
                    self.assertEqual(first.recv(100), host.REFUSED)
                    self.assertEqual(first.recv(100), b"")
                    thread.join(2)
                    self.assertFalse(thread.is_alive())
                    self.assertTrue(stop.is_set())
                    self.assertFalse(path.exists())
                    with self.assertRaises(OSError):
                        second.connect(str(path))
                    self.assertEqual(native.call_count, 1)
                    self.assertEqual(errors, ["ValueError"])
                finally:
                    first.close()
                    second.close()
                    stop.set()
                    thread.join(3)
                self.assertFalse(thread.is_alive())

    def test_partial_request_eof_never_executes(self):
        server, client = socket.socketpair()
        client.settimeout(2)
        with (
            mock.patch.object(host, "peer_uid", return_value=1001),
            mock.patch.object(host.supervisor, "execute") as native,
        ):
            thread = threading.Thread(
                target=host.handle, args=(server, IMAGE, 1001, threading.Event())
            )
            thread.start()
            try:
                client.sendall(struct.pack("!I", 20) + b"partial")
                client.shutdown(socket.SHUT_WR)
                self.assertEqual(client.recv(100), host.REFUSED)
            finally:
                client.close()
                thread.join(2)
            self.assertFalse(thread.is_alive())
            native.assert_not_called()

    def test_extra_frame_cancels_without_delivery(self):
        server, client = socket.socketpair()
        client.settimeout(2)
        with (
            mock.patch.object(host, "peer_uid", return_value=1001),
            mock.patch.object(host.supervisor, "execute") as native,
        ):
            thread = threading.Thread(
                target=host.handle, args=(server, IMAGE, 1001, threading.Event())
            )
            thread.start()
            try:
                client.sendall(struct.pack("!I", 2) + b"{}" + b"x")
                self.assertEqual(client.recv(100), host.REFUSED)
            finally:
                client.close()
                thread.join(2)
            self.assertFalse(thread.is_alive())
            native.assert_not_called()

    def test_real_posix_ancestors_refuse_writable_directory_and_symlink(self):
        # Native filesystem ownership on Mac; no claim about a deployed Linux UID mapping.
        with tempfile.TemporaryDirectory(dir=Path.home()) as directory:
            root = Path(directory)
            private = root / "operator"
            private.mkdir(mode=0o700)
            path = private / "worker.sock"
            uid = os.getuid()
            host._parents(path, uid, uid + 1)
            private.chmod(0o777)
            with self.assertRaises(ValueError):
                host._parents(path, uid, uid + 1)
            private.chmod(0o700)
            alias = root / "alias"
            alias.symlink_to(private)
            with self.assertRaises(ValueError):
                host._parents(alias / "worker.sock", uid, uid + 1)
            with self.assertRaises(ValueError):
                host._parents(path, uid, uid)

    def test_single_active_request_and_exact_owned_socket_cleanup(self):
        with tempfile.TemporaryDirectory(dir=Path.home()) as directory:
            path = Path(directory) / "worker.sock"
            stop = threading.Event()
            entered = threading.Event()
            release = threading.Event()
            errors = []
            uid = os.getuid() + 1
            ready = threading.Event()
            native_listen = socket.socket.listen

            def listening(listener, *args):
                native_listen(listener, *args)
                ready.set()

            def native(*args, **kwargs):
                entered.set()
                self.assertTrue(release.wait(2))
                return b"wire", {"cleanupComplete": True}

            def serve():
                try:
                    host.serve(path, IMAGE, uid, os.getgid(), stop)
                except Exception as error:
                    errors.append(type(error).__name__)

            with (
                mock.patch.object(socket.socket, "listen", new=listening),
                mock.patch.object(host.sys, "platform", "linux"),
                mock.patch.object(host, "peer_uid", return_value=uid),
                mock.patch.object(
                    host.supervisor, "execute", side_effect=native
                ) as execute,
            ):
                thread = threading.Thread(target=serve)
                thread.start()
                first = socket.socket(socket.AF_UNIX)
                second = socket.socket(socket.AF_UNIX)
                first.settimeout(2)
                second.settimeout(2)
                try:
                    deadline = time.monotonic() + 1
                    while not path.exists() and time.monotonic() < deadline:
                        time.sleep(0.005)
                    self.assertTrue(ready.wait(1))
                    first.connect(str(path))
                    first.sendall(struct.pack("!I", 2) + b"{}")
                    self.assertTrue(entered.wait(1))
                    second.connect(str(path))
                    self.assertEqual(second.recv(100), host.REFUSED)
                    release.set()
                    self.assertEqual(
                        first.recv(100), b"\0" + struct.pack("!I", 4) + b"wire"
                    )
                    self.assertEqual(execute.call_count, 1)
                finally:
                    release.set()
                    first.close()
                    second.close()
                    stop.set()
                    thread.join(3)
                self.assertFalse(thread.is_alive())
                self.assertEqual(errors, [])
                self.assertFalse(path.exists())

    def test_foreign_replacement_is_never_unlinked(self):
        with tempfile.TemporaryDirectory(dir=Path.home()) as directory:
            path = Path(directory) / "worker.sock"
            stop = threading.Event()
            errors = []
            ready = threading.Event()
            native_listen = socket.socket.listen
            sentinel = Path(directory) / "sentinel"
            sentinel.write_bytes(b"owned-test-sentinel-not-a-socket")

            def listening(listener, *args):
                native_listen(listener, *args)
                ready.set()

            def serve():
                try:
                    host.serve(path, IMAGE, os.getuid() + 1, os.getgid(), stop)
                except Exception as error:
                    errors.append(type(error).__name__)

            with (
                mock.patch.object(host.sys, "platform", "linux"),
                mock.patch.object(socket.socket, "listen", new=listening),
            ):
                thread = threading.Thread(target=serve)
                thread.start()
                try:
                    self.assertTrue(ready.wait(1))
                    sentinel.replace(path)
                finally:
                    stop.set()
                    thread.join(3)
                self.assertFalse(thread.is_alive())
                self.assertEqual(errors, ["ValueError"])
                self.assertEqual(path.read_bytes(), b"owned-test-sentinel-not-a-socket")

    def test_existing_socket_is_refused_without_removal(self):
        with tempfile.TemporaryDirectory(dir=Path.home()) as directory:
            path = Path(directory) / "worker.sock"
            existing = socket.socket(socket.AF_UNIX)
            existing.bind(str(path))
            try:
                before = path.lstat()
                with (
                    mock.patch.object(host.sys, "platform", "linux"),
                    self.assertRaises(ValueError),
                ):
                    host.serve(
                        path, IMAGE, os.getuid() + 1, os.getgid(), threading.Event()
                    )
                self.assertEqual(path.lstat().st_ino, before.st_ino)
            finally:
                existing.close()
                path.unlink()

    @unittest.skipUnless(
        host.sys.platform == "linux", "SO_PEERCRED native Linux not qualified on Mac"
    )
    def test_linux_peer_uid_from_kernel(self):
        first, second = socket.socketpair()
        try:
            self.assertEqual(host.peer_uid(first), os.getuid())
        finally:
            first.close()
            second.close()


class OperatorAdmissionTests(unittest.TestCase):
    def test_bad_operator_configuration_refuses_before_listening(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as folder:
            root=Path(folder);config=root/'admission.json';config.write_bytes(b'{}');config.chmod(0o400)
            with mock.patch.object(host.sys,'platform','linux'), mock.patch.object(host,'_parents'), mock.patch.object(host.socket,'socket') as listener:
                with self.assertRaises(ValueError):
                    host.serve(root/'host.sock',IMAGE,os.getuid()+1,os.getgid(),threading.Event(),admission_file=str(config))
                listener.assert_not_called()

    def test_real_operator_capture_reaches_public_execute_and_owned_cleanup(self):
        from test_admission import proof, config
        from test_supervisor import Engine
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as folder:
            root=Path(folder);value=proof();value['supervisorSha256']=host.supervisor.SOURCE_SHA256
            raw=json.dumps(value).encode()
            for name,data in [('proof.json',raw),('admission.json',json.dumps(config(value,raw)).encode())]:
                path=root/name;path.write_bytes(data);path.chmod(0o400)
            captured=host.supervisor.admission.capture(str(root/'admission.json'),IMAGE,host.supervisor.SOURCE_SHA256)
            engine=Engine();server,client=socket.socketpair();observed=[]
            def docker(argv,payload,deadline,cancel,cwd,limit):
                return engine(argv[3:],payload,deadline=deadline,cancel=cancel,limit=limit)
            with mock.patch.object(host,'peer_uid',return_value=1001), mock.patch.object(host.supervisor.os,'uname',return_value=type('Linux',(),{'sysname':'Linux'})()), mock.patch.object(host.supervisor,'_command',side_effect=docker):
                worker=threading.Thread(target=lambda:observed.append(host.handle(server,IMAGE,1001,threading.Event(),captured)))
                worker.start();client.settimeout(2)
                try:
                    client.sendall(struct.pack('!I',7)+b'fixture');answer=b''
                    while True:
                        part=client.recv(65536)
                        if not part:break
                        answer+=part
                finally:client.close();worker.join(2)
            self.assertFalse(worker.is_alive());self.assertEqual(observed,[True])
            self.assertEqual(answer,b'\0'+struct.pack('!I',len(engine.result))+engine.result)
            self.assertIn('rm',engine.actions());self.assertIsNone(engine.row)
            # Docker and SO_PEERCRED are explicit doubles here, not Linux evidence.


if __name__ == "__main__":
    unittest.main()
