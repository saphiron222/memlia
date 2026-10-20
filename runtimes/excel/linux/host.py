# Copyright (c) 2026 Memlia. All rights reserved.
"""One bounded request over operator-owned Unix IPC; no user authority or queue."""

import importlib.util
import os
from pathlib import Path
import select
import signal
import socket
import stat
import struct
import sys
import threading
import time

_spec = importlib.util.spec_from_file_location(
    "excel_isolation", Path(__file__).with_name("supervisor.py")
)
supervisor = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(supervisor)
MAX_WIRE = supervisor.MAX_WIRE
REFUSED = b"\x01\x00\x00\x00\x00"


def refuse():
    raise ValueError("excel_host_refused")


def peer_uid(connection):
    # Linux credentials are kernel observations, never data in the frame.
    if sys.platform != "linux" or not hasattr(socket, "SO_PEERCRED"):
        refuse()
    pid, uid, _gid = struct.unpack(
        "3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
    )
    if pid <= 0:
        refuse()
    return uid


def _receive(connection, size, deadline, stop):
    result = bytearray()
    while len(result) < size:
        if stop.is_set() or time.monotonic() >= deadline:
            refuse()
        connection.settimeout(min(0.1, max(0.001, deadline - time.monotonic())))
        try:
            chunk = connection.recv(min(65536, size - len(result)))
        except socket.timeout:
            continue
        if not chunk:
            refuse()
        result.extend(chunk)
    return bytes(result)


def _send_refusal(connection):
    try:
        connection.settimeout(0.1)
        connection.sendall(REFUSED)
    except OSError:
        pass


def handle(connection, image, allowed_uid, stop, image_admission=None):
    """Return False on unknown cleanup; the host must then stop accepting work."""
    cancel = threading.Event()
    finished = threading.Event()
    monitor = None
    clean = True
    try:
        if stop.is_set() or peer_uid(connection) != allowed_uid:
            refuse()
        deadline = time.monotonic() + 5
        size = struct.unpack("!I", _receive(connection, 4, deadline, stop))[0]
        if not 0 < size <= MAX_WIRE:
            refuse()
        wire = _receive(connection, size, deadline, stop)

        def observe_disconnect():
            while not finished.is_set():
                if stop.is_set():
                    cancel.set()
                    return
                try:
                    ready, _, _ = select.select([connection], [], [], 0.025)
                    if ready:
                        # EOF, extra frames and half-close all cancel. Never read a second job.
                        cancel.set()
                        connection.recv(1)
                        return
                except OSError:
                    cancel.set()
                    return

        monitor = threading.Thread(target=observe_disconnect)
        monitor.start()
        # Synchronous probe closes the gap before starting the native supervisor.
        if stop.is_set() or select.select([connection], [], [], 0)[0]:
            cancel.set()
        if cancel.is_set():
            refuse()
        clean = False
        if image_admission is None:
            result, receipt = supervisor.execute(image, wire, cancel=cancel)
        else:
            result, receipt = supervisor.execute(image, wire, cancel=cancel,
                                                  image_admission=image_admission)
        clean = receipt.get("cleanupComplete") is True
        if not clean or cancel.is_set() or stop.is_set():
            refuse()
        if type(result) is not bytes or not 0 < len(result) <= MAX_WIRE:
            refuse()
        connection.settimeout(5)
        connection.sendall(b"\0" + struct.pack("!I", len(result)) + result)
    except supervisor.IsolationError as error:
        clean = error.receipt.get("cleanupComplete") is True
        _send_refusal(connection)
    except (OSError, ValueError, TypeError, KeyError):
        _send_refusal(connection)
    except Exception:
        # An unclassified failure cannot certify native cleanup.
        clean = False
        _send_refusal(connection)
    finally:
        finished.set()
        if monitor is not None:
            monitor.join(1)
            if monitor.is_alive():
                clean = False
        connection.close()
    return clean


def _parents(path, operator_uid, allowed_uid):
    if (
        not path.is_absolute()
        or str(path) != os.path.normpath(str(path))
        or allowed_uid == operator_uid
        or allowed_uid <= 0
    ):
        refuse()
    for parent in (path.parent, *path.parent.parents):
        row = parent.lstat()
        if (
            not stat.S_ISDIR(row.st_mode)
            or row.st_uid not in (0, operator_uid)
            or row.st_uid == allowed_uid
            or row.st_mode & 0o022
        ):
            refuse()


def _socket_identity(path):
    row = path.lstat()
    if not stat.S_ISSOCK(row.st_mode):
        refuse()
    return row.st_dev, row.st_ino, row.st_uid, row.st_gid, stat.S_IMODE(row.st_mode)


def serve(path, image, allowed_uid, socket_gid, stop, *, admission_file=None):
    """Operator-only entry. The caller installs signals; no arbitrary paths from a request."""
    path = Path(path)
    operator_uid = os.getuid()
    if (
        sys.platform != "linux"
        or type(image) is not str
        or not supervisor.IMAGE.fullmatch(image)
        or type(allowed_uid) is not int
        or type(socket_gid) is not int
        or socket_gid < 0
        or len(os.fsencode(path)) > 100
    ):
        refuse()
    _parents(path, operator_uid, allowed_uid)
    # Operator configuration is captured outside the frame before any listener exists.
    image_admission = None if admission_file is None else supervisor.admission.capture(
        admission_file, image, supervisor.SOURCE_SHA256)
    # Never unlink a stale/foreign socket. Operator reconciliation is required.
    if path.exists() or path.is_symlink():
        refuse()
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    identity = None
    worker = None
    active = threading.Lock()
    poisoned = threading.Event()
    try:
        prior = os.umask(0o177)
        try:
            listener.bind(str(path))
        finally:
            os.umask(prior)
        identity = _socket_identity(path)
        os.chown(path, operator_uid, socket_gid)
        os.chmod(path, 0o660)
        identity = _socket_identity(path)
        listener.listen(1)
        listener.settimeout(0.1)

        def run(connection):
            try:
                if not handle(connection, image, allowed_uid, stop, image_admission):
                    poisoned.set()
                    stop.set()
            finally:
                active.release()

        while not stop.is_set():
            _parents(path, operator_uid, allowed_uid)
            if _socket_identity(path) != identity:
                refuse()
            try:
                connection, _ = listener.accept()
            except socket.timeout:
                continue
            if not active.acquire(blocking=False):
                _send_refusal(connection)
                connection.close()
                continue
            if worker is not None:
                worker.join()
            worker = threading.Thread(target=run, args=(connection,))
            worker.start()
        if poisoned.is_set():
            refuse()
    finally:
        stop.set()
        listener.close()
        if worker is not None:
            worker.join(140)
            if worker.is_alive():
                # Never advertise a clean host shutdown while native work may survive.
                refuse()
        if identity is not None:
            if _socket_identity(path) != identity:
                refuse()
            path.unlink()


def main():
    stop = threading.Event()
    previous = {}
    try:
        if len(sys.argv) not in (5, 7):
            refuse()
        path, image, uid, gid = sys.argv[1:5]
        admission_file = None
        if len(sys.argv) == 7:
            if sys.argv[5] != '--admission-file':
                refuse()
            admission_file = sys.argv[6]
        if (
            not uid.isascii()
            or not uid.isdecimal()
            or not gid.isascii()
            or not gid.isdecimal()
        ):
            refuse()
        for value in (signal.SIGTERM, signal.SIGINT):
            previous[value] = signal.signal(value, lambda *_: stop.set())
        serve(path, image, int(uid), int(gid), stop, admission_file=admission_file)
        return 0
    except Exception:
        print("excel_host_refused", file=sys.stderr)
        return 1
    finally:
        for value, handler in previous.items():
            signal.signal(value, handler)


if __name__ == "__main__":
    raise SystemExit(main())
