# Copyright (c) 2026 Memlia. All rights reserved.
"""Serial native command composition. Authority ports are required, never inferred.

The server owns durable claims and fences across process restarts. This host never
retries a command, a publication or an effect after an uncertain exchange.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import datetime, timezone
import hashlib
import io
import json
import queue
import re
import stat
import threading
import time
from typing import Protocol
import uuid
import zipfile

from memlia_contracts import desktop_command_digest, validate

from .host import HostError
from .openadapt_capture import record_capture, reconcile_capture
from .openadapt_compile import BundleFile, CompiledRecording, _digest, _names, _private_traceback, _VERSIONS
from .openadapt_compile_process import CompiledCapture, compile_captured_recording, reconcile_compile
from .openadapt_replay import reconcile_replay, replay_compiled_recording, ReplayObservation
from .session import observe_session

_MAX_ARTIFACT = 33 * 1024 * 1024


class AgentAuthority(Protocol):
    """Trusted mTLS composition, not ports selected by a command or model."""
    async def claim(self, session: dict) -> dict | None: ...
    async def checkpoint(self, command: dict, capability: dict | None) -> None: ...
    async def consent(self, command: dict, observation: dict) -> dict: ...
    async def artifact(self, command: dict, reference: dict, maximum: int) -> bytes: ...
    async def publish(self, command: dict, receipt: dict, artifacts: tuple) -> None: ...


@dataclass(frozen=True, kw_only=True)
class AgentScope:
    organization_id: str | None
    workspace_id: str
    agent_id: str
    owner_user_id: str


@dataclass(frozen=True)
class OpaqueArtifact:
    artifact_id: str
    content: bytes = field(repr=False)

    @property
    def reference(self):
        return {'artifactId': self.artifact_id,
                'sha256': 'sha256:' + hashlib.sha256(self.content).hexdigest()}


class _NativeOwner:
    """One live owner for adapters AND their exact cleanup after a HOLD."""
    def __init__(self):
        self.queue = queue.Queue(maxsize=1)
        self.stopping = False
        self.thread = threading.Thread(target=self._run, name='Memlia-native-command', daemon=False)
        self.thread.start()

    def _run(self):
        while True:
            task = self.queue.get()
            if task is None:
                return
            function, loop, future = task
            result = function()
            loop.call_soon_threadsafe(future.set_result, result)

    async def execute(self, function):
        loop = asyncio.get_running_loop()
        result = loop.create_future()
        self.queue.put_nowait((function, loop, result))
        return await asyncio.shield(result)

    async def close(self):
        def cleanup():
            failed = False
            for reconcile, expected in ((reconcile_capture, None),
                                        (reconcile_compile, True), (reconcile_replay, True)):
                try:
                    if reconcile() is not expected:
                        failed = True
                except BaseException:
                    failed = True
            return not failed
        if not self.stopping:
            if not self.thread.is_alive() or not await self.execute(cleanup):
                # Keep the SAME live native owner and its UI/resources. Never
                # signal exit while their shutdown cannot be proved.
                raise HostError('agent_cleanup_unverified')
            self.stopping = True
            self.queue.put_nowait(None)
        self.thread.join(1)
        if self.thread.is_alive():
            raise HostError('agent_cleanup_unverified')


def _snapshot(value, maximum=262144):
    # Reject serialization hooks and bound before JSON Schema or an await.
    pending, count = [(value, 0)], 0
    while pending:
        item, depth = pending.pop(); count += 1
        if count > 16384 or depth > 24:
            raise HostError('agent_contract_refused')
        if type(item) is dict:
            if any(type(key) is not str for key in item):
                raise HostError('agent_contract_refused')
            pending.extend((part, depth + 1) for part in item.values())
        elif type(item) is list:
            pending.extend((part, depth + 1) for part in item)
        elif item is not None and type(item) not in (str, int, float, bool):
            raise HostError('agent_contract_refused')
    chunks, size, failed = [], 0, False
    try:
        for part in json.JSONEncoder(ensure_ascii=False, allow_nan=False,
                                     separators=(',', ':')).iterencode(value):
            raw = part.encode('utf-8'); size += len(raw)
            if size > maximum:
                raise ValueError()
            chunks.append(raw)
    except (ValueError, TypeError, UnicodeError, RecursionError):
        failed = True
    if failed:
        raise HostError('agent_contract_refused')
    return json.loads(b''.join(chunks))


def _validated(name, value):
    captured, failed = _snapshot(value), False
    try:
        validate(name, captured)
    except Exception:
        failed = True
    if failed:
        raise HostError('agent_contract_refused')
    return captured


def _instant(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


def _now():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def _archive(result):
    """Opaque data export with validated relative Flow names; never an OS path."""
    if type(result) is not CompiledCapture or type(result.compiled) is not CompiledRecording:
        raise HostError('agent_capture_result_refused')
    compiled = result.compiled
    if (compiled.status != 'to_test' or compiled.profile != 'raw-recording-v1'
            or compiled.versions != tuple(sorted(_VERSIONS.items()))
            or type(compiled.files) is not tuple or not 3 <= len(compiled.files) <= 128):
        raise HostError('agent_capture_result_refused')
    files = []
    for item in compiled.files:
        if (type(item) is not BundleFile or type(item.content) is not bytes or len(item.content) > 8 * 1024 * 1024
                or hashlib.sha256(item.content).hexdigest() != item.sha256):
            raise HostError('agent_capture_result_refused')
        files.append((item.path, item.content))
    _names(name for name, _ in files)
    if (len(set(name for name, _ in files)) != len(files)
            or sum(len(raw) for _, raw in files) > 32 * 1024 * 1024
            or _digest(tuple(sorted(files)), b'memlia.openadapt-bundle/v1\0') != compiled.bundle_sha256
            or any(name == 'memlia-compiled-recording.json' for name, _ in files)):
        raise HostError('agent_capture_result_refused')
    metadata = dict(schemaVersion='memlia.compiled-capture/v1', status='to_test',
        sourceSha256=compiled.source_sha256, bundleSha256=compiled.bundle_sha256,
        stepCount=compiled.step_count, versions=dict(compiled.versions), profile=compiled.profile)
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', compression=zipfile.ZIP_STORED, allowZip64=False) as archive:
        for name, raw in sorted(files):
            archive.writestr(zipfile.ZipInfo(name), raw)
        archive.writestr(zipfile.ZipInfo('memlia-compiled-recording.json'),
                         json.dumps(metadata, separators=(',', ':'), allow_nan=False).encode('utf-8'))
    data = buffer.getvalue()
    if not 1 <= len(data) <= _MAX_ARTIFACT:
        raise HostError('agent_capture_result_refused')
    return OpaqueArtifact(str(uuid.uuid4()), data)


def _personal_inputs(command, bodies):
    """Read a bounded native export as data, never extract arbitrary archive paths."""
    from .openadapt_replay_worker import _json
    try:
        admission = _json(bodies['qualification'])
        scope = ('commandId','runId','agentId','organizationId','workspaceId','ownerUserId','windowsSid','sessionId')
        keys = set(scope) | {'schemaVersion','purpose','productionAdmitted','procedureId','revision',
                            'maxDurationSeconds','bundle','procedure','parameters','localConsentRequired'}
        if (type(admission) is not dict or set(admission) != keys
                or any(admission[k] != command[k] for k in scope)
                or admission['schemaVersion'] != 'memlia.personal-test-admission/v1'
                or admission['purpose'] != 'personal_test' or admission['productionAdmitted'] is not False
                or admission['localConsentRequired'] is not True
                or type(admission['procedureId']) is not str or str(uuid.UUID(admission['procedureId'])) != admission['procedureId']
                or type(admission['revision']) is not int or not 1 <= admission['revision'] < 2**53
                or type(admission['maxDurationSeconds']) is not int or not 1 <= admission['maxDurationSeconds'] <= 1800
                or admission['bundle'] != command['bundle']
                or any(admission[k] != command['action'][k] for k in ('procedure','parameters'))):
            raise ValueError()
        expected = {'backend':{'kind':'windows'},'runtime':{'profile':'demo','allow_model_grounding':False,
                    'grounding_model':{'enabled':False}},'effects':{'kind':'none'}}
        if _json(bodies['procedure']) != expected or _json(bodies['parameters']) != {}:
            raise ValueError()
        with zipfile.ZipFile(io.BytesIO(bodies['bundle'])) as archive:
            infos = archive.infolist()
            if not 4 <= len(infos) <= 129 or archive.comment:
                raise ValueError()
            names = [i.filename for i in infos]; _names(names)
            if len(set(names)) != len(names):raise ValueError()
            total = 0; files = []; metadata = None
            for item in infos:
                mode = item.external_attr >> 16
                if (item.compress_type != zipfile.ZIP_STORED or item.flag_bits & 1 or item.is_dir()
                        or item.extra or item.comment or stat.S_IFMT(mode) not in (0,stat.S_IFREG)
                        or item.file_size != item.compress_size or item.file_size > 8*1024*1024):
                    raise ValueError()
                total += item.file_size
                if total > 32*1024*1024 + 4096:raise ValueError()
                if item.filename == 'memlia-compiled-recording.json':
                    if item.file_size > 4096:raise ValueError()
                    metadata = _json(archive.read(item))
                else:files.append(BundleFile(item.filename,archive.read(item),''))
        if (type(metadata) is not dict or set(metadata) != {'schemaVersion','status','sourceSha256',
                'bundleSha256','stepCount','versions','profile'}
                or metadata['schemaVersion'] != 'memlia.compiled-capture/v1' or metadata['status'] != 'to_test'
                or metadata['profile'] != 'raw-recording-v1' or metadata['versions'] != _VERSIONS
                or type(metadata['stepCount']) is not int or not 1 <= metadata['stepCount'] <= 100000
                or any(type(metadata[k]) is not str or re.fullmatch('[0-9a-f]{64}',metadata[k]) is None
                       for k in ('sourceSha256','bundleSha256'))):raise ValueError()
        compiled = CompiledRecording(tuple(BundleFile(f.path,f.content,hashlib.sha256(f.content).hexdigest()) for f in files),
                    metadata['sourceSha256'],metadata['bundleSha256'],metadata['stepCount'],tuple(sorted(metadata['versions'].items())))
        # Reuse the same native export validator for aggregate bounds and bundle digest.
        _archive(CompiledCapture(compiled,command['digest'],None))
        return compiled
    except Exception:
        raise HostError('agent_personal_source_refused') from None


def _private_report_artifact(artifacts):
    if (type(artifacts) is not tuple or len(artifacts)>128
            or any(type(item) is not tuple or len(item)!=2 or type(item[0]) is not str
                   or type(item[1]) is not bytes for item in artifacts)):return None
    reports=[raw for name,raw in artifacts if name=='run/report.json']
    if len(reports)!=1 or type(reports[0]) is not bytes or not 1<=len(reports[0])<=1048576:return None
    return OpaqueArtifact(str(uuid.uuid4()),reports[0])


def _test_evidence(observation, command, compiled):
    if (type(observation) is not ReplayObservation or observation.mode != 'test'
            or observation.operation_digest != command['digest'] or observation.bundle_sha256 != compiled.bundle_sha256
            or observation.status not in ('test_observed','uncertain')):
        raise HostError('agent_personal_result_unverified')
    reports = [raw for name,raw in observation.private_artifacts if name == 'run/report.json']
    if len(reports) != 1 or type(reports[0]) is not bytes or not 1 <= len(reports[0]) <= 1048576:
        raise HostError('agent_personal_result_unverified')
    from .openadapt_replay_worker import _json
    report = _json(reports[0])
    if (report.get('execution_profile') != 'demo' or report.get('execution_outcome') == 'VERIFIED'
            or report.get('transaction_outcome') != observation.transaction_outcome or report.get('production_eligible') is not False):
        raise HostError('agent_personal_result_unverified')
    return OpaqueArtifact(str(uuid.uuid4()), reports[0])


class AgentDispatcher:
    def __init__(self, *, scope: AgentScope, authority: AgentAuthority):
        if (type(scope) is not AgentScope or not all(callable(getattr(authority, name, None))
                for name in ('claim', 'checkpoint', 'consent', 'artifact', 'publish'))):
            raise HostError('agent_authority_unconfigured')
        self.scope, self.authority = scope, authority
        self.private_output = None
        self.private_diagnostic = None
        self.private_artifacts = ()
        self._seen, self._busy = set(), False
        self._native = None
        self._blocked = self._closed = False

    async def aclose(self):
        if self._closed:
            return
        if self._busy:
            raise HostError('agent_host_busy')
        if self._native is not None:
            await self._native.close()
        self._closed = True

    async def _call(self, name, *args):
        failed, result = False, None
        try:
            result = await getattr(self.authority, name)(*args)
        except Exception:
            failed = True
        if failed:
            if name == 'publish':
                self._blocked = True
                raise HostError('agent_receipt_unconfirmed')
            raise HostError('agent_authority_unavailable')
        return result

    async def run_once(self):
        if self._busy or self._blocked or self._closed:
            raise HostError('agent_host_busy')
        self._busy = True
        try:
            return await self._run_once()
        finally:
            self._busy = False

    async def _run_once(self):
        observed = observe_session()
        candidate = await self._call('claim', {'windowsSid': observed.windows_sid,
                                              'sessionId': str(observed.session_id)})
        if candidate is None:
            return None
        command = _validated('AgentCommand', candidate)
        if desktop_command_digest(command) != command['digest']:
            raise HostError('agent_command_digest_refused')
        expected = dict(organizationId=self.scope.organization_id, workspaceId=self.scope.workspace_id,
            agentId=self.scope.agent_id, ownerUserId=self.scope.owner_user_id,
            windowsSid=observed.windows_sid, sessionId=str(observed.session_id))
        if any(command[key] != value for key, value in expected.items()):
            raise HostError('agent_scope_refused')
        now = time.time()
        expires = _instant(command['expiresAt'])
        if not _instant(command['issuedAt']) <= now < expires <= now + 1800:
            raise HostError('agent_command_expired')
        locks = [(value['kind'], value['resourceId']) for value in command['resourceLocks']]
        if len(locks) != len(set(locks)) or not any(kind == 'desktop' for kind, _ in locks):
            raise HostError('agent_resource_refused')
        if command['commandId'] in self._seen or len(self._seen) >= 4096:
            raise HostError('agent_command_already_claimed')
        self._seen.add(command['commandId'])
        personal = command['action']['kind'] == 'procedure.run' and command['action']['mode'] == 'test'
        if command['action']['kind'] != 'capture.start' and not personal:
            raise HostError('agent_adapter_unconfigured')
        deadline, capability, sequence = time.monotonic() + expires - now, None, 0
        command_json = json.dumps(command, separators=(',', ':'))
        def fresh_command(): return json.loads(command_json)

        async def checkpoint():
            if (time.monotonic() >= deadline or observe_session() != observed
                    or capability is not None and time.time() >= _instant(capability['expiresAt'])
                    or await self._call('checkpoint', fresh_command(),
                                        _snapshot(capability) if capability else None) is not None):
                raise HostError('agent_authority_unavailable')

        async def publish(outcome, artifacts=()):
            nonlocal sequence
            if (type(artifacts) is not tuple or len(artifacts) > 128
                    or any(type(item) is not OpaqueArtifact or type(item.content) is not bytes
                           or not 1 <= len(item.content) <= _MAX_ARTIFACT for item in artifacts)
                    or sum(len(item.content) for item in artifacts) > _MAX_ARTIFACT):
                raise HostError('agent_artifact_refused')
            receipt = _validated('RunReceipt', dict(schemaVersion='memlia.run-receipt/v1',
                organizationId=self.scope.organization_id, workspaceId=self.scope.workspace_id,
                runId=command['runId'], commandId=command['commandId'], sequence=sequence,
                recordedAt=_now(), outcome=outcome))
            sequence += 1  # Never retry this sequence after an uncertain response.
            if await self._call('publish', fresh_command(), receipt, artifacts) is not None:
                raise HostError('agent_receipt_unconfirmed')

        await checkpoint()
        bodies = {}
        refs = [('bundle',command['bundle'],_MAX_ARTIFACT if personal else 1048576),
                ('qualification',command['qualification'],65536 if personal else 1048576)]
        if personal:refs += [(k,command['action'][k],262144 if k=='procedure' else 65536) for k in ('procedure','parameters')]
        for key,reference,maximum in refs:
            raw = await self._call('artifact',fresh_command(),_snapshot(reference),maximum)
            if (type(raw) is not bytes or not 1 <= len(raw) <= maximum
                    or 'sha256:' + hashlib.sha256(raw).hexdigest() != reference['sha256']):
                raise HostError('agent_artifact_refused')
            bodies[key] = raw
        compiled_source = _personal_inputs(command,bodies) if personal else None
        await checkpoint()
        await publish(dict(status='awaiting_local_consent', effect='none', evidence=[]))

        loop, cancelled = asyncio.get_running_loop(), threading.Event()
        consented, attempted = False, False

        async def local_consent(observation):
            nonlocal capability, consented
            value = _snapshot(observation, 4096)
            if (type(value) is not dict or set(value) != {'consentId', 'confirmedLocallyAt',
                    'commandDigest', 'windowsSid', 'sessionId'}
                    or value['commandDigest'] != command['digest']
                    or value['windowsSid'] != observed.windows_sid or value['sessionId'] != str(observed.session_id)):
                raise HostError('agent_consent_refused')
            await checkpoint()
            candidate = _validated('SessionCapability', await self._call('consent', fresh_command(), _snapshot(value)))
            fixed = ('organizationId', 'workspaceId', 'agentId', 'ownerUserId', 'windowsSid',
                     'sessionId', 'leaseEpoch', 'resourceLocks', 'capabilityId', 'qualification')
            if (any(candidate[key] != command[key] for key in fixed)
                    or candidate['consent'] != {key: value[key] for key in ('consentId', 'confirmedLocallyAt', 'commandDigest')}
                    or candidate['capabilities'] != (['desktop.replay'] if personal else ['desktop.capture'])
                    or not _instant(command['issuedAt']) <= _instant(candidate['issuedAt']) <= time.time()
                    or not time.time() < _instant(candidate['expiresAt']) <= expires):
                raise HostError('agent_consent_refused')
            capability = candidate
            await checkpoint()
            await publish(dict(status='running', effect='none', evidence=[]))
            consented = True

        def bridge(coroutine):
            future = asyncio.run_coroutine_threadsafe(coroutine, loop)
            failed, value = False, None
            try:
                value = future.result(timeout=max(.01, min(5, deadline - time.monotonic())))
            except Exception:
                future.cancel(); failed = True
            if failed:
                raise HostError('agent_authority_unavailable')
            return value

        def revalidate():
            if cancelled.is_set() or observe_session() != observed:
                raise HostError('agent_session_unavailable')
            return bridge(checkpoint())

        def native_work():
            nonlocal attempted
            result, error = None, None
            try:
                revalidate()
                if personal:
                    replay = replay_compiled_recording(compiled=compiled_source,operation_digest=command['digest'],mode='test',
                        deployment_bytes=bodies['procedure'],parameters_bytes=bodies['parameters'],admission_bytes=bodies['qualification'],
                        deadline_monotonic=deadline,revalidate=revalidate,
                        on_local_consent=lambda value: bridge(local_consent(value)))
                    attempted = True
                    self.private_output = replay.private_output
                    self.private_artifacts = replay.private_artifacts
                    result = _test_evidence(replay,command,compiled_source)
                else:
                    captured = record_capture(operation_digest=command['digest'],
                        deadline_monotonic=min(deadline, time.monotonic() + command['action']['maxDurationSeconds']),
                        max_bytes=command['action']['maxBytes'], revalidate=revalidate,
                        on_local_consent=lambda value: bridge(local_consent(value)))
                    attempted = True
                    compiled = compile_captured_recording(recording=captured, name='Memlia ' + command['runId'],
                        deadline_monotonic=deadline, revalidate=revalidate)
                    if compiled.operation_digest != command['digest']:
                        raise HostError('agent_capture_result_refused')
                    self.private_output = (captured.private_output, compiled.private_output)
                    result = _archive(compiled)
                revalidate()
            except BaseException as failure:
                # Capture before projecting a closed result, including partial IO.
                self.private_output = getattr(failure, 'private_output', self.private_output)
                self.private_artifacts = getattr(failure, 'private_artifacts', self.private_artifacts)
                self.private_diagnostic = _private_traceback(failure)
                if personal and consented:result = _private_report_artifact(self.private_artifacts)
                error = 'agent_native_unverified' if consented or attempted else 'agent_native_refused'
            return result, error

        if self._native is None:
            self._native = _NativeOwner()
        work = asyncio.create_task(self._native.execute(native_work))
        try:
            result, error = await asyncio.shield(work)
        except asyncio.CancelledError:
            cancelled.set()
            await asyncio.shield(work)  # Owned cleanup must finish before the loop/channel closes.
            self._blocked = True
            raise
        if error:
            evidence = [result.reference] if personal and result is not None else []
            outcome = (dict(status='uncertain', effect='unknown', reconciliationRequired=True, evidence=evidence)
                       if error == 'agent_native_unverified' else
                       dict(status='failed', effect='none', reasonCode=error, evidence=[]))
            if error == 'agent_native_unverified':
                self._blocked = True
            await publish(outcome,(result,) if evidence else ())
            return {'commandId': command['commandId'], 'status': outcome['status']}
        if personal:
            self._blocked = True
            await publish(dict(status='uncertain',effect='unknown',reconciliationRequired=True,evidence=[result.reference]),(result,))
            return {'commandId':command['commandId'],'status':'uncertain'}
        await publish(dict(status='succeeded_verified', effect='known', evidence=[result.reference],
                           verifierId='memlia_capture_compile_v1'), (result,))
        return {'commandId': command['commandId'], 'status': 'to_test'}
