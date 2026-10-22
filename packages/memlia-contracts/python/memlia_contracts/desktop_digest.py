# Copyright (c) 2026 Memlia. All rights reserved.
"""Command v2 fingerprint. Validation is not authorization or a consent receipt."""
import hashlib
import json
import math


def _canonical(value):
    if isinstance(value, dict):
        return {key: _canonical(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_canonical(item) for item in value]
    # JSON Schema permits 1.0 as an integer. Match JS serialization exactly,
    # including negative zero, without accepting an unsafe/rounded integer.
    if type(value) is float:
        if not math.isfinite(value) or not value.is_integer() or abs(value) > 9007199254740991:
            raise ValueError('command_number_refused')
        return int(value)
    return value


def desktop_command_digest(value):
    from . import validate
    validate('AgentCommand', value)
    command = {key: item for key, item in value.items() if key != 'digest'}
    encoded = json.dumps(_canonical(command), ensure_ascii=False, sort_keys=True,
                         separators=(',', ':'), allow_nan=False).encode('utf-8')
    return 'sha256:' + hashlib.sha256(b'memlia.desktop-command.v2\0' + encoded).hexdigest()
