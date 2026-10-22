# Copyright (c) 2026 Memlia. All rights reserved.
"""Owned agent composition. Remote commands never choose imports or native ports."""
from __future__ import annotations
from dataclasses import dataclass,field
import asyncio
import json
import re
import signal

_CLEANUP_WAIT_SECONDS = 10.0

class HostError(RuntimeError):
    def __init__(self,code): self.code=code;super().__init__(code)


class ConsoleOperator:
    """Scoped console interruption, never a command or business permission.

    SIGINT first requests cooperative stop. Once cleanup starts, SIGINT can only
    request an explicit reconciliation while HOLD is displayed. It never cancels
    a second time an owned native worker or the pending cleanup task.
    """
    def __init__(self, *, loop, request_stop):
        self.loop, self.request_stop = loop, request_stop
        self.closing = self.stopping = self.waiting = False
        self.request = None
        self.previous = None
        self.installed = self._signal

    def __enter__(self):
        failed = False
        try:
            self.previous = signal.getsignal(signal.SIGINT)
            signal.signal(signal.SIGINT, self.installed)
        except (ValueError, OSError, RuntimeError):
            failed = True
        if failed:
            raise HostError('agent_operator_unavailable')
        return self

    def __exit__(self, *_args):
        self.close_recovery()
        # Restore the exact asyncio.Runner handler only after verified cleanup.
        if signal.getsignal(signal.SIGINT) is self.installed:
            signal.signal(signal.SIGINT, self.previous)

    def _signal(self, _number, _frame):
        if self.closing:
            if self.waiting and self.request is not None and not self.request.done():
                self.loop.call_soon_threadsafe(self._request_reconciliation, self.request)
        elif not self.stopping:
            self.stopping = True
            self.loop.call_soon_threadsafe(self.request_stop)

    def _request_reconciliation(self, requested):
        if (self.waiting and self.request is requested and not requested.done()):
            self.request.set_result(None)

    def begin_cleanup(self):
        self.closing = True

    def open_recovery(self):
        self.waiting = True
        self.request = self.loop.create_future()
        return self.request

    def close_recovery(self):
        self.waiting = False
        if self.request is not None and not self.request.done():
            self.request.cancel()


def _consume_cancellation():
    task = asyncio.current_task()
    if task is not None:
        task.uncancel()


async def _wait_owned(tasks, timeout=None):
    """Bound observation, not native ownership. Never cancel a cleanup task."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout if timeout is not None else None
    while True:
        remaining = max(0, deadline - loop.time()) if deadline is not None else None
        try:
            done, _ = await asyncio.wait(tasks, timeout=remaining,
                                         return_when=asyncio.FIRST_COMPLETED)
            return done
        except asyncio.CancelledError:
            # A second cancellation during cleanup cannot abandon the owner.
            # SIGINT uses the explicit operator path, not task.cancel here.
            _consume_cancellation()


def _announce_cleanup(on_status, *, pending):
    if on_status is not None:
        try:
            on_status(dict(phase='cleanup_required', code='agent_cleanup_unverified',
                cleanupPending=pending, operatorAction='press_ctrl_c_to_reconcile'))
        except BaseException:
            pass  # A broken console must not release or lose the native owner.


def _cleanup_result(task):
    if not task.done():
        return False
    try:
        return task.result() is None
    except BaseException:
        return False


async def _close_retaining_owner(dispatcher, operator, on_status):
    """One owned attempt; failed attempts require a new explicit console request."""
    operator.begin_cleanup()
    attempt = asyncio.create_task(dispatcher.aclose())
    while True:
        await _wait_owned({attempt}, _CLEANUP_WAIT_SECONDS)
        if _cleanup_result(attempt):
            return
        if attempt.done():
            attempt = None
        request = operator.open_recovery()
        _announce_cleanup(on_status, pending=attempt is not None)
        try:
            while True:
                targets = {request, attempt} if attempt is not None else {request}
                completed = await _wait_owned(targets)
                if attempt is not None and attempt in completed:
                    if _cleanup_result(attempt):
                        return
                    attempt = None
                    _announce_cleanup(on_status, pending=False)
                if request in completed:
                    break
        finally:
            operator.close_recovery()
        if attempt is None:
            attempt = asyncio.create_task(dispatcher.aclose())
        # If still pending, observe the SAME attempt for another bounded interval.

_ID=re.compile(r'[A-Za-z0-9][A-Za-z0-9_-]{0,127}',re.ASCII)

def _pairs(pairs):
    value={}
    for key,item in pairs:
        if key in value: raise ValueError()
        value[key]=item
    return value

def _non_json(value): raise ValueError()

@dataclass(frozen=True,kw_only=True)
class AgentBootstrap:
    installation_id: str = field(repr=False)
    origin: str = field(repr=False)
    organization_id: str|None = field(repr=False)
    workspace_id: str = field(repr=False)
    owner_user_id: str = field(repr=False)
    enrollment_id: str = field(repr=False)
    tls_ca_pem: bytes = field(repr=False)
    agent_ca_pem: bytes = field(repr=False)
    code: str|None = field(default=None,repr=False)
    expires_at: int|None = field(default=None,repr=False)
    control_origin: str|None = field(default=None,repr=False)
    control_ca_pem: bytes|None = field(default=None,repr=False)

    @classmethod
    def decode(cls,raw: bytes, *, operation: str):
        parsed=None
        try:
            if type(raw) is not bytes or not 1<=len(raw)<=131072: raise ValueError()
            value=json.loads(raw.decode('utf-8'),object_pairs_hook=_pairs,parse_constant=_non_json)
            fields={'schemaVersion','installationId','origin','organizationId','workspaceId','ownerUserId',
                    'enrollmentId','tlsCaPem','agentCaPem'}
            if operation=='enroll': fields|={'code','expiresAt'}
            if operation=='run': fields|={'controlOrigin','controlCaPem'}
            if type(value) is not dict or set(value)!=fields or value['schemaVersion']!='memlia.agent-bootstrap/v1':
                raise ValueError()
            for key in ('installationId','workspaceId','ownerUserId','enrollmentId'):
                if type(value[key]) is not str or not _ID.fullmatch(value[key]): raise ValueError()
            org=value['organizationId']
            if org is not None and (type(org) is not str or not _ID.fullmatch(org)): raise ValueError()
            if type(value['origin']) is not str or not 1<=len(value['origin'])<=2048: raise ValueError()
            for key in ('tlsCaPem','agentCaPem'):
                if type(value[key]) is not str or not 1<=len(value[key])<=32768: raise ValueError()
                value[key].encode('ascii')
            if operation=='run':
                if (type(value['controlOrigin']) is not str or not 1<=len(value['controlOrigin'])<=2048
                        or type(value['controlCaPem']) is not str or not 1<=len(value['controlCaPem'])<=32768):
                    raise ValueError()
                value['controlCaPem'].encode('ascii')
            if operation=='enroll' and (type(value['code']) is not str
                    or not re.fullmatch(r'[A-Za-z0-9_-]{43}',value['code'],re.ASCII)
                    or type(value['expiresAt']) is not int or not 0<value['expiresAt']<2**53):
                raise ValueError()
            parsed=cls(installation_id=value['installationId'],origin=value['origin'],organization_id=org,
                workspace_id=value['workspaceId'],owner_user_id=value['ownerUserId'],enrollment_id=value['enrollmentId'],
                tls_ca_pem=value['tlsCaPem'].encode('ascii'),agent_ca_pem=value['agentCaPem'].encode('ascii'),
                code=value.get('code'),expires_at=value.get('expiresAt'),control_origin=value.get('controlOrigin'),
                control_ca_pem=value['controlCaPem'].encode('ascii') if operation=='run' else None)
        except (ValueError,TypeError,UnicodeError,RecursionError): pass
        if parsed is None: raise HostError('agent_bootstrap_refused')
        return parsed

def create_enrollment(bootstrap: AgentBootstrap):
    # Lazy: a malformed bootstrap must not load native Windows/crypto dependencies.
    from .enrollment import EnrollmentBinding,EnrollmentClient
    return EnrollmentClient(binding=EnrollmentBinding(installation_id=bootstrap.installation_id,
        origin=bootstrap.origin,workspace_id=bootstrap.workspace_id,owner_user_id=bootstrap.owner_user_id,
        enrollment_id=bootstrap.enrollment_id),tls_ca_pem=bootstrap.tls_ca_pem,agent_ca_pem=bootstrap.agent_ca_pem)

async def perform_operation(operation,bootstrap,*,on_status=None):
    client=create_enrollment(bootstrap)
    if operation=='status':
        return client.state() or {'phase':'not_enrolled','enrollmentId':bootstrap.enrollment_id}
    if operation=='enroll':
        client.prepare(code=bootstrap.code,expires_at=bootstrap.expires_at)
        phase=await client.advance()
    elif operation=='resume': phase=await client.reconcile()
    elif operation=='activate':
        client.activate();return client.state()
    elif operation=='run':
        identity=client.activate()
        authority=create_authority(bootstrap,identity)
        async with authority:
            options={'on_status':on_status} if on_status is not None else {}
            return await run_host(bootstrap=bootstrap,identity=identity,authority=authority,**options)
    else: raise HostError('agent_arguments_refused')
    if phase=='challenged': phase=await client.advance()
    if phase=='issued_pending_activation': client.activate()
    return client.state()

def create_authority(bootstrap,identity):
    # Fixed implementation and installation configuration only. No import/route,
    # browser cookie or authorization headers can be chosen by a command.
    unavailable=False
    try:
        from .control import AgentControlChannel
    except ImportError:
        unavailable=True
    if unavailable:raise HostError('agent_authority_unconfigured')
    return AgentControlChannel(origin=bootstrap.control_origin,ca_pem=bootstrap.control_ca_pem,
        client_identity=identity,max_response_bytes=524288,total_timeout_seconds=5,max_connections=1)

async def run_host(*,bootstrap,identity,authority,on_status=None):
    from .dispatcher import AgentDispatcher,AgentScope
    loop=asyncio.get_running_loop();owner_task=asyncio.current_task()
    if on_status is not None and not callable(on_status):raise HostError('agent_operator_unavailable')
    with ConsoleOperator(loop=loop,request_stop=owner_task.cancel) as operator:
        dispatcher=AgentDispatcher(scope=AgentScope(organization_id=bootstrap.organization_id,
            workspace_id=bootstrap.workspace_id,agent_id=identity.agent_id,owner_user_id=bootstrap.owner_user_id),
            authority=authority)
        outcome,failure=None,None
        try:
            while True:
                result=await dispatcher.run_once()
                if result is not None and result['status']=='uncertain':
                    outcome=dict(phase='intervention_required',commandId=result['commandId'])
                    break
                # Polling never resubmits an effect or retries an uncertain publish.
                await asyncio.sleep(1 if result is None else 0)
        except asyncio.CancelledError:
            _consume_cancellation()
            outcome=dict(phase='intervention_required',reasonCode='agent_interrupted')
        except Exception as error:
            failure=error.code if type(error) is HostError else 'agent_operation_refused'
        finally:
            # Keep dispatcher, signal handler and asyncio loop alive through HOLD.
            await _close_retaining_owner(dispatcher,operator,on_status)
    if failure is not None:raise HostError(failure)
    return outcome
