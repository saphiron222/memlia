# Copyright (c) 2026 Memlia. All rights reserved.
"""Closed mTLS control port, using generated contracts and existing HTTPS lifecycle.

No automatic retry, alternate endpoint, cookie, proxy identity or arbitrary HTTP
method. A validated response still requires the dispatcher's semantic admission.
"""
import base64
import hashlib
import json
import uuid

import httpx
from memlia_contracts import validate

from .dispatcher import OpaqueArtifact, _snapshot
from .transport import MutualTLSChannel, TransportError

_BODY = 524288
_CHUNK = 262144
_ARTIFACT = 34603008


def _contract(name, value, maximum=_BODY):
    captured, failed = None, False
    try:
        captured = _snapshot(value, maximum)
        validate(name, captured)
    except Exception:
        failed = True
    if failed:
        raise TransportError('control_contract_refused')
    return captured


def _reference(command):
    captured = _contract('AgentCommand', command)
    return {key: captured[key] for key in ('commandId', 'digest', 'leaseEpoch')}


def _key(reference):
    return tuple(reference[key] for key in ('commandId', 'digest', 'leaseEpoch'))


def _decode(value):
    raw, failed = None, False
    try:
        raw = base64.b64decode(value, validate=True)
        if len(raw) > _CHUNK or base64.b64encode(raw).decode('ascii') != value:
            raise ValueError()
    except (ValueError, TypeError, UnicodeError):
        failed = True
    if failed:
        raise TransportError('control_chunk_refused')
    return raw


class AgentControlChannel(MutualTLSChannel):
    def __init__(self, **options):
        super().__init__(**options)
        self._capabilities = {}

    async def aclose(self):
        try:
            await super().aclose()
        finally:
            self._capabilities.clear()

    async def _exchange(self, operation, **fields):
        request_id = str(uuid.uuid4())
        value = _contract('AgentControlRequest', dict(schemaVersion='memlia.agent-control-request/v1',
            requestId=request_id, op=operation, **fields))
        payload = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf-8')
        if len(payload) > _BODY:
            raise TransportError('request_too_large')
        request = httpx.Request('POST', self._origin + '/v1/agent/control', content=payload,
            headers={'Accept': 'application/json', 'Accept-Encoding': 'identity', 'Content-Type': 'application/json'})
        def response(_status, raw):
            captured = _contract('AgentControlResponse', raw)
            if captured['requestId'] != request_id:
                raise TransportError('control_response_refused')
            if captured['op'] == 'refused':
                raise TransportError(captured['code'])
            if captured['op'] != operation:
                raise TransportError('control_response_refused')
            return captured
        _, result = await self._request_json(request, (200,), response)
        return result

    async def claim(self, session):
        result = await self._exchange('claim', session=session)
        return result['command']

    async def checkpoint(self, command, capability):
        reference = _reference(command)
        capability_id = None
        if capability is not None:
            captured = _contract('SessionCapability', capability)
            capability_id = captured['capabilityId']
        await self._exchange('checkpoint', command=reference, capabilityId=capability_id)

    async def consent(self, command, observation):
        command = _contract('AgentCommand', command)
        observation = _snapshot(observation, 4096)
        reference = _reference(command)
        result = await self._exchange('consent', command=reference, observation=observation)
        capability = result['capability']
        fixed = ('organizationId', 'workspaceId', 'agentId', 'ownerUserId', 'windowsSid',
                 'sessionId', 'leaseEpoch', 'resourceLocks', 'capabilityId', 'qualification')
        if (any(capability[key] != command[key] for key in fixed)
                or capability['consent'] != {key: observation[key] for key in
                    ('consentId', 'confirmedLocallyAt', 'commandDigest')}
                or capability['consent']['commandDigest'] != reference['digest']):
            raise TransportError('control_consent_refused')
        key = _key(reference)
        if len(self._capabilities) >= 4096 and key not in self._capabilities:
            raise TransportError('control_session_full')
        self._capabilities[key] = capability['capabilityId']
        # No local grant is issued. The dispatcher must verify the returned
        # capability against its immutable command AND native observation.
        return result['capability']

    async def artifact(self, command, reference, maximum):
        command_ref = _reference(command)
        reference = _snapshot(reference, 4096)
        if type(maximum) is not int or not 1 <= maximum <= _ARTIFACT:
            raise TransportError('control_artifact_refused')
        offset, total, captured = 0, None, bytearray()
        while True:
            result = await self._exchange('artifact.read', command=command_ref,
                capabilityId=self._capabilities.get(_key(command_ref)),
                reference=reference, offset=offset, limit=min(_CHUNK, maximum - offset))
            part = _decode(result['dataBase64'])
            if (result['reference'] != reference or result['offset'] != offset
                    or result['totalBytes'] > maximum or total is not None and result['totalBytes'] != total):
                raise TransportError('control_artifact_refused')
            total = result['totalBytes']
            if (len(part) > min(_CHUNK, maximum - offset) or offset + len(part) > total
                    or result['done'] != (offset + len(part) == total)
                    or not part and not result['done']):
                raise TransportError('control_chunk_refused')
            captured.extend(part); offset += len(part)
            if result['done']:
                break
        data = bytes(captured)
        if 'sha256:' + hashlib.sha256(data).hexdigest() != reference['sha256']:
            raise TransportError('control_artifact_refused')
        return data

    async def publish(self, command, receipt, artifacts):
        command_ref = _reference(command)
        captured = _contract('RunReceipt', receipt)
        if (type(artifacts) is not tuple or len(artifacts) > 128
                or any(type(item) is not OpaqueArtifact or type(item.content) is not bytes
                       or not 1 <= len(item.content) <= _ARTIFACT for item in artifacts)
                or sum(len(item.content) for item in artifacts) > _ARTIFACT):
            raise TransportError('control_artifact_refused')
        references = [item.reference for item in artifacts]
        if (len(set(item['artifactId'] for item in references)) != len(references)
                or captured['outcome']['evidence'] != references
                or any(captured[key] != command[key] for key in ('commandId', 'runId', 'organizationId', 'workspaceId'))):
            raise TransportError('control_receipt_refused')
        capability_id = self._capabilities.get(_key(command_ref))
        if artifacts and capability_id is None:
            raise TransportError('control_consent_required')
        for item, reference in zip(artifacts, references):
            offset = 0
            while offset < len(item.content):
                part = item.content[offset:offset + _CHUNK]
                result = await self._exchange('artifact.put', command=command_ref,
                    capabilityId=capability_id, reference=reference, totalBytes=len(item.content),
                    offset=offset, dataBase64=base64.b64encode(part).decode('ascii'))
                expected_offset = offset + len(part)
                if (result['reference'] != reference or result['nextOffset'] != expected_offset
                        or result['complete'] != (expected_offset == len(item.content))):
                    raise TransportError('control_upload_unconfirmed')
                offset = expected_offset
        await self._exchange('publish', command=command_ref, capabilityId=capability_id,
                             receipt=captured, artifacts=references)
