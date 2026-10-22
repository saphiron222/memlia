# Copyright (c) 2026 Memlia. All rights reserved.
"""ExcelMcp 2.4.1 protocol preparation, never an execution/authority port.

The caller must separately own a qualified copy, session, desktop reservation,
consent and process lifecycle. This module opens neither files nor processes.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import hashlib
import json
import math
import re
from uuid import uuid4

_MAX_COMMANDS = 16
_MAX_INPUT = 262144
_MAX_OUTPUT = 1048576
_MAX_LINE = 65536
_PIPE = re.compile(r'MemliaExcel-[0-9a-f]{32}\Z')
_SESSION = re.compile(r'[A-Za-z0-9_-]{1,128}\Z')
_RANGE = re.compile(r'\$?([A-Z]{1,3})\$?([1-9][0-9]{0,6})(?::\$?([A-Z]{1,3})\$?([1-9][0-9]{0,6}))?\Z')
_COMMANDS = {'range.get-values', 'range.set-values'}
_OUTER = {'index', 'command', 'success', 'result', 'errorMessage', 'errorCategory',
          'exceptionType', 'hresult', 'innerError', 'partialState'}


class ExcelComError(ValueError):
    """Closed codes only; no argument, workbook, native error or decoder context."""
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def _text(value, maximum):
    if (type(value) is not str or len(value) > maximum
            or any(ord(c) < 32 or ord(c) == 127 for c in value)):
        raise ValueError()
    value.encode('utf-8', errors='strict')
    return value


def _area(value):
    match = _RANGE.fullmatch(_text(value, 32))
    if not match:
        raise ValueError()
    a, r, b, s = match.groups()
    column = lambda name: sum((ord(c)-64)*26**i for i,c in enumerate(reversed(name)))
    x, y, xx, yy = column(a), int(r), column(b or a), int(s or r)
    if not (1 <= x <= xx <= 16384 and 1 <= y <= yy <= 1048576
            and (xx-x+1)*(yy-y+1) <= 4096):
        raise ValueError()
    return x, y, xx, yy


def _scalar(value, *, writing):
    if value is None or type(value) is bool:
        return
    if type(value) in (int, float) and math.isfinite(value) and abs(value) <= 2**53-1:
        return
    if type(value) is str:
        _text(value, 4096)
        if not writing or not value.lstrip().startswith(('=', '+', '-', '@')):
            return
    raise ValueError()


def _matrix(value, area, *, writing):
    x,y,xx,yy = area
    if type(value) is not list or len(value) != yy-y+1:
        raise ValueError()
    copied = []
    for row_index in range(yy-y+1):
        row = value[row_index]
        if type(row) is not list or len(row) != xx-x+1:
            raise ValueError()
        copied_row = []
        for column_index in range(xx-x+1):
            cell = row[column_index]
            _scalar(cell, writing=writing)
            copied_row.append(cell)
        copied.append(copied_row)
    return copied


def _encode(value):
    # Stop while encoding, not after constructing an oversized JSON document.
    chunks, size = [], 0
    encoder = json.JSONEncoder(ensure_ascii=False, allow_nan=False, separators=(',', ':'))
    for text in encoder.iterencode(value):
        chunk = text.encode('utf-8')
        size += len(chunk)
        if size > _MAX_INPUT:
            raise ValueError()
        chunks.append(chunk)
    return b''.join(chunks)


@dataclass(frozen=True)
class BatchPlan:
    """Immutable serialized request. Its digest is identity, not authorization."""
    input_bytes: bytes = field(repr=False)
    pipe_name: str
    arguments: tuple[str, ...]
    environment: tuple[tuple[str, str], ...]
    sha256: str


def new_pipe_name() -> str:
    """Allocate a name before session creation, not a daemon or an authority."""
    return 'MemliaExcel-' + uuid4().hex


def prepare_batch(*, pipe_name: str, session_id: str, operations: list[dict]) -> BatchPlan:
    """Capture every command before emitting anything; no implicit open/save/retry.

    Initial bounded profile: <=16 range-value commands, <=4096 cells each,
    <=256 KiB JSON. Nonempty replacement, formulas and arbitrary CLI actions
    are deliberately outside this profile.
    """
    failed = False
    try:
        if type(pipe_name) is not str or not _PIPE.fullmatch(pipe_name):
            raise ValueError()
        if type(session_id) is not str or not _SESSION.fullmatch(session_id):
            raise ValueError()
        if type(operations) is not list or not 1 <= len(operations) <= _MAX_COMMANDS:
            raise ValueError()
        # Copy bounded values as they are validated, never retain caller lists.
        captured = []
        for index in range(len(operations)):
            operation = operations[index]
            if type(operation) is not dict or len(operation) != 2 or set(operation) != {'command','args'}:
                raise ValueError()
            command, args = operation['command'], operation['args']
            if type(command) is not str or command not in _COMMANDS or type(args) is not dict:
                raise ValueError()
            writing = command == 'range.set-values'
            if len(args) != (3 if writing else 2) or set(args) != (
                    {'sheetName','rangeAddress','values'} if writing else {'sheetName','rangeAddress'}):
                raise ValueError()
            sheet = _text(args['sheetName'], 31)
            if not sheet or sheet.startswith("'") or sheet.endswith("'") or any(c in sheet for c in '[]:*?/\\'):
                raise ValueError()
            address = args['rangeAddress']
            area = _area(address)
            checked = {'sheetName': sheet, 'rangeAddress': address}
            if writing:
                checked['values'] = _matrix(args['values'], area, writing=True)
                checked['overwritePolicy'] = 'reject-nonempty'
            captured.append({'command': command, 'sessionId': session_id, 'args': checked})
        for index, entry in enumerate(captured):
            if entry['command'] == 'range.set-values':
                if index + 1 == len(captured):
                    raise ValueError()
                next_entry = captured[index + 1]
                if (next_entry['command'] != 'range.get-values'
                        or next_entry['args']['sheetName'] != entry['args']['sheetName']
                        or _area(next_entry['args']['rangeAddress']) != _area(entry['args']['rangeAddress'])):
                    raise ValueError()
        payload = _encode(captured)
    except (ValueError, TypeError, KeyError, IndexError, OverflowError, UnicodeError, RecursionError):
        failed = True
    if failed:
        raise ExcelComError('invalid_batch')
    return BatchPlan(payload, pipe_name, ('-q', 'batch', '--input', '-', '--stop-on-error'),
                     (('EXCELMCP_TELEMETRY_MODE','off'), ('EXCELMCP_CLI_PIPE', pipe_name)),
                     hashlib.sha256(payload).hexdigest())


def _pairs(pairs):
    result = {}
    for key,value in pairs:
        if key in result:
            raise ValueError()
        result[key] = value
    return result


def _bad_constant(_):
    raise ValueError()


def _json(data):
    return json.loads(data.decode('utf-8'), object_pairs_hook=_pairs, parse_constant=_bad_constant)


@dataclass(frozen=True)
class BatchObservation:
    """Reported items only, not durable save, rollback, readback equality or closure."""
    status: str
    reason: str
    reported_successes: int
    failed_index: int | None
    # Only range values, never FilePath/ErrorMessage/partialState. Private data.
    readbacks: tuple[tuple[int, bytes], ...] = field(repr=False)


class BatchReader:
    """Incremental NDJSON reader: <=1 MiB total / 64 KiB per line.

    A runner must enforce these limits while reading, then stop only its owned
    processes on overflow. This reader itself has no process/lifecycle effect.
    """
    def __init__(self, plan: BatchPlan):
        if type(plan) is not BatchPlan:
            raise ExcelComError('invalid_plan')
        # Prepared bytes are immutable; revalidate at this boundary without any IO.
        failed = False
        try:
            if type(plan.input_bytes) is not bytes or len(plan.input_bytes) > _MAX_INPUT:
                raise ValueError()
            entries = _json(plan.input_bytes)
            if type(entries) is not list or not entries or any(
                    type(e) is not dict or type(e.get('args')) is not dict for e in entries):
                raise ValueError()
            source = [{'command': e['command'], 'args': {k:v for k,v in e['args'].items()
                       if k != 'overwritePolicy'}} for e in entries]
            checked = prepare_batch(pipe_name=plan.pipe_name, session_id=entries[0]['sessionId'], operations=source)
            if checked != plan:
                raise ValueError()
        except (ValueError, TypeError, KeyError, IndexError, UnicodeError, RecursionError):
            failed = True
        if failed:
            raise ExcelComError('invalid_plan')
        self._entries = entries
        self._pending = b''
        self._bytes = self._seen = self._successes = 0
        self._failed_index = None
        self._readbacks = []
        self._invalid = None
        self._finished = False

    def _line(self, line):
        if not line or len(line) > _MAX_LINE or self._seen >= len(self._entries) or self._failed_index is not None:
            raise ValueError()
        item = _json(line)
        expected = self._entries[self._seen]
        if (type(item) is not dict or set(item) - _OUTER
                or type(item.get('index')) is not int or item['index'] != self._seen
                or item.get('command') != expected['command'] or type(item.get('success')) is not bool):
            raise ValueError()
        if not item['success']:
            self._failed_index = self._seen
        else:
            result = item.get('result')
            if (type(result) is not dict or result.get('success') is not True
                    or any(item.get(k) is not None for k in _OUTER - {'index','command','success','result'})
                    or result.get('errorMessage') not in (None,'')):
                raise ValueError()
            if expected['command'] == 'range.get-values':
                args = expected['args'];area = _area(args['rangeAddress'])
                if result.get('sheetName') != args['sheetName'] or _area(result.get('rangeAddress')) != area:
                    raise ValueError()
                if (type(result.get('rowCount')) is not int or result['rowCount'] != area[3]-area[1]+1
                        or type(result.get('columnCount')) is not int or result['columnCount'] != area[2]-area[0]+1
                        or result.get('cellErrors') != []):
                    raise ValueError()
                _matrix(result.get('values'), area, writing=False)
                values = json.dumps(result['values'], ensure_ascii=False, allow_nan=False, separators=(',',':')).encode()
                self._readbacks.append((self._seen,values))
                if self._seen and self._entries[self._seen-1]['command'] == 'range.set-values':
                    expected_values = self._entries[self._seen-1]['args']['values']
                    for wanted_row, actual_row in zip(expected_values, result['values']):
                        for wanted, actual in zip(wanted_row, actual_row):
                            numeric = type(wanted) in (int,float) and type(actual) in (int,float)
                            if wanted != actual or (not numeric and type(wanted) is not type(actual)):
                                raise ValueError()
            elif result.get('action') != 'set-values':
                raise ValueError()
            self._successes += 1
        self._seen += 1

    def feed(self, chunk: bytes) -> None:
        if self._finished:
            raise ExcelComError('reader_closed')
        if self._invalid:
            raise ExcelComError(self._invalid)
        if type(chunk) is not bytes:
            self._invalid = 'invalid_output'
        elif self._bytes + len(chunk) > _MAX_OUTPUT:
            self._invalid = 'output_limit'
        else:
            self._bytes += len(chunk)
            data = self._pending + chunk
            lines = data.split(b'\n')
            self._pending = lines.pop()
            if len(self._pending) > _MAX_LINE:
                self._invalid = 'output_limit'
            else:
                try:
                    for line in lines:
                        self._line(line.removesuffix(b'\r'))
                except (ValueError, TypeError, KeyError, OverflowError, UnicodeError, RecursionError):
                    self._invalid = 'invalid_output'
        if self._invalid:
            self._pending = b''
            raise ExcelComError(self._invalid)

    def finish(self, *, exit_code: int | None) -> BatchObservation:
        if self._finished:
            raise ExcelComError('reader_closed')
        if self._pending and not self._invalid:
            try:
                self._line(self._pending.removesuffix(b'\r'))
            except (ValueError, TypeError, KeyError, OverflowError, UnicodeError, RecursionError):
                self._invalid = 'invalid_output'
        self._pending = b''
        self._finished = True
        if self._invalid:
            status, reason = 'unknown', self._invalid
        elif type(exit_code) is int and exit_code == 0 and self._successes == len(self._entries):
            status, reason = 'reported_complete', 'all_items_reported'
        elif type(exit_code) is int and exit_code == 1 and self._failed_index is not None:
            status, reason = 'partial_or_unknown', 'item_failed'
        else:
            status, reason = 'unknown', 'transport_or_incomplete'
        return BatchObservation(status, reason, self._successes, self._failed_index, tuple(self._readbacks))
