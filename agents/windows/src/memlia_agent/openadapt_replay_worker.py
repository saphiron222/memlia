# Copyright (c) 2026 Memlia. All rights reserved.
"""Owned native Flow replay. Missing root admission always refuses before engines."""
import hashlib
import json
import math
from pathlib import Path
import secrets
import socket
import sys
import threading
import time
from types import SimpleNamespace
from urllib.parse import urlsplit

from .openadapt_capture_worker import _engine_stdout, inventory, read_small, write_once
from .openadapt_compile import _digest, _output, _private_traceback

_READS = frozenset({'/context/identity', '/uia/locator-at', '/uia/text-at-point', '/uia/find'})
_INPUTS = frozenset({'/input/guarded', '/uia/act'})
_STAGES = frozenset({'startup', 'before_run', 'request', 'after_run', 'cleanup'})


class ReplayWorkerError(RuntimeError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def _admission_port():
    try:
        # Static root-owned implementation only; no import path from a request.
        from .openadapt_replay_admission import (admit_replay, checkpoint_replay,
                                                 close_replay_admission, flow_guards)
        ports = (admit_replay, checkpoint_replay, flow_guards, close_replay_admission)
        if not all(callable(port) for port in ports):
            raise ValueError()
        return SimpleNamespace(admit=admit_replay, checkpoint=checkpoint_replay,
                               guards=flow_guards, close=close_replay_admission)
    except Exception:
        raise ReplayWorkerError('replay_admission_unavailable') from None


def _runtime():
    # Parent has checked pinned versions. This process imports engines only after admission.
    from openadapt_flow import deployment, run_gate
    from openadapt_flow.ir import Workflow, RunReport
    from openadapt_flow.execution_profiles import execution_profile_contract, resolve_execution_profile
    from openadapt_flow.production_qualification import ProductionQualificationGuard
    from openadapt_flow.qualification_campaign_authority import QualificationCampaignGuard
    from openadapt_flow.approval_mode.gate import ApprovalGate
    from openadapt_flow.runtime.authorization import normalize_runtime_param_scalar
    from openadapt_flow.backends.windows_backend import WindowsBackend
    from openadapt_flow.backends.win_agent.server import AgentConfig, create_server
    from requests import Session
    return SimpleNamespace(**locals())


def _json(raw):
    def unique(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise ReplayWorkerError('replay_json_refused')
            value[key] = item
        return value
    def constant(_value):
        raise ReplayWorkerError('replay_json_refused')
    return json.loads(raw, object_pairs_hook=unique, parse_constant=constant)


def request_path(method, url, port):
    if type(method) is not str or type(url) is not str:
        raise ReplayWorkerError('replay_endpoint_refused')
    parsed = urlsplit(url)
    if (parsed.scheme != 'http'
            or parsed.netloc != f'127.0.0.1:{port}' or parsed.query or parsed.fragment
            or not ((method == 'GET' and parsed.path in {'/health', '/screenshot'})
                    or (method == 'POST' and parsed.path in _READS | _INPUTS))):
        raise ReplayWorkerError('replay_endpoint_refused')
    return parsed.path


def local_checkpoint(root, nonce, deadline, clock=time.monotonic):
    now = clock()
    if now >= deadline or (root / 'stop').exists():
        raise ReplayWorkerError('replay_stopped')
    if read_small(root / 'go', 64) != (nonce + '\n').encode('ascii'):
        raise ReplayWorkerError('replay_indicator_unavailable')
    fields = read_small(root / 'heartbeat', 128).decode('ascii').splitlines()
    if len(fields) != 2 or fields[0] != nonce:
        raise ReplayWorkerError('replay_indicator_unavailable')
    stamp = float(fields[1])
    if not math.isfinite(stamp) or not 0 <= now - stamp <= 1:
        raise ReplayWorkerError('replay_indicator_unavailable')


def _root_checkpoint(ports, binding, stage, method=None, path=None):
    if (stage not in _STAGES or (stage == 'request') != (method is not None and path is not None)
            or method is not None and method not in {'GET', 'POST'}
            or path is not None and path not in _READS | _INPUTS | {'/health', '/screenshot'}):
        raise ReplayWorkerError('replay_checkpoint_refused')
    if ports.checkpoint(binding, stage=stage, method=method, path=path) is not None:
        raise ReplayWorkerError('replay_authority_unavailable')


def _private_error(error):
    private,complete=_private_traceback(error)
    try:
        sys.stderr.buffer.write(private);sys.stderr.buffer.flush()
    except Exception:
        complete=False
    return complete


class _OwnedServer:
    """The native single serve thread retains UIA COM affinity; no parallel handlers."""
    def __init__(self, rt, nonce, deadline):
        self.deadline, self.nonce = deadline, nonce
        self.rt = rt
        self.connections, self.lock = set(), threading.Lock()
        self.thread = None
        self.server = None
        self.token = secrets.token_urlsafe(32)

    def start(self):
        rt = self.rt
        config = rt.AgentConfig(host='127.0.0.1', port=0, token=self.token, allow_legacy_exec=False)
        self.server = rt.create_server(config)
        address = self.server.server_address
        if (address[0] != '127.0.0.1' or type(address[1]) is not int or not 1 <= address[1] <= 65535
                or config.allow_legacy_exec is not False or not config.authed()):
            self.server.server_close()
            raise ReplayWorkerError('replay_service_refused')
        self.port = address[1]
        base, nonce = self.server.RequestHandlerClass, self.nonce
        class Handler(base):
            def end_headers(self):
                self.send_header('X-Memlia-Replay-Nonce', nonce)
                super().end_headers()
            def do_POST(self):
                if self.path not in _READS | _INPUTS:
                    self._send_json(403, {'status': 'error', 'code': 'guarded_input_required'})
                    return
                super().do_POST()
        self.server.RequestHandlerClass = Handler
        native_get, native_shutdown = self.server.get_request, self.server.shutdown_request
        def get_request():
            connection, address = native_get()
            connection.settimeout(max(.01, min(2, self.deadline - time.monotonic())))
            with self.lock:
                self.connections.add(connection)
            return connection, address
        def shutdown_request(connection):
            try:
                native_shutdown(connection)
            finally:
                with self.lock:
                    self.connections.discard(connection)
        self.server.get_request, self.server.shutdown_request = get_request, shutdown_request

        self.thread = threading.Thread(target=lambda:self.server.serve_forever(poll_interval=.05),
                                       name='Memlia-owned-Windows-backend', daemon=False)
        self.thread.start()

    def close(self):
        if self.server is None:return
        if self.thread is not None and self.thread.is_alive():
            with self.lock:
                for connection in tuple(self.connections):
                    try: connection.shutdown(socket.SHUT_RDWR)
                    except OSError: pass
                    connection.close()
            closer = threading.Thread(target=self.server.shutdown, name='Memlia-backend-close', daemon=False)
            closer.start(); closer.join(2); self.thread.join(2)
            if closer.is_alive() or self.thread.is_alive():
                raise ReplayWorkerError('replay_service_cleanup_unknown')
        self.server.server_close()
        if self.server.socket.fileno() != -1:
            raise ReplayWorkerError('replay_service_cleanup_unknown')


def _session(rt, service, root, request, ports, binding):
    class Session(rt.Session):
        def request(self, method, url, **kwargs):
            path = request_path(method, url, service.port)
            local_checkpoint(root, request['nonce'], request['deadline'])
            _root_checkpoint(ports, binding, 'request', method, path)
            if path in _INPUTS and not (root / 'input-attempted').exists():
                write_once(root / 'input-attempted', (request['nonce'] + '\n').encode('ascii'))
            kwargs['allow_redirects'] = False
            kwargs['timeout'] = max(.01, min(2, request['deadline'] - time.monotonic()))
            result = super().request(method, url, **kwargs)
            if (result.headers.get('X-Memlia-Replay-Nonce') != request['nonce']
                    or 300 <= result.status_code < 400):
                result.close()
                raise ReplayWorkerError('replay_service_identity_refused')
            return result
    result = Session()
    result.trust_env = False
    return result


def run_directory(root, request):
    ports = _admission_port()  # Before native imports, model initialization or sockets.
    binding = service = session = None
    try:
        bundle = _output(root / 'bundle')
        if _digest(bundle, b'memlia.openadapt-bundle/v1\0') != request['bundleSha256']:
            raise ReplayWorkerError('replay_source_changed')
        inputs = {}
        for name, limit in (('deployment', 262144), ('parameters', 65536), ('admission', 65536)):
            value = read_small(root / (name + ('.bin' if name == 'admission' else '.json')), limit)
            if hashlib.sha256(value).hexdigest() != request[name + 'Sha256']:
                raise ReplayWorkerError('replay_source_changed')
            inputs[name] = value
        binding = ports.admit(request, bundle_sha256=request['bundleSha256'],
            deployment_sha256=request['deploymentSha256'], parameters_sha256=request['parametersSha256'],
            operation_digest=request['operationDigest'], mode=request['mode'], deadline=request['deadline'],
            admission_bytes=inputs['admission'])
        if type(binding) is not bytes or not 1 <= len(binding) <= 65536:
            raise ReplayWorkerError('replay_authority_unavailable')
        _root_checkpoint(ports, binding, 'startup')
        rt = _runtime()
        cfg = rt.deployment.DeploymentConfig.model_validate_json(inputs['deployment'])
        if (rt.deployment.incomplete_deployment_reasons(cfg) or cfg.backend.kind != 'windows'
                or cfg.backend.agent_url or cfg.backend.agent_token or cfg.backend.agent_tls_pin
                or cfg.surfaces or cfg.actuation.api or cfg.runtime.allow_model_grounding
                or cfg.runtime.grounding_model.enabled
                or cfg.runtime.profile not in ({'demo'} if request['mode']=='test' else {'standard','regulated'})):
            raise ReplayWorkerError('replay_deployment_refused')
        workflow = rt.Workflow.load(root/'bundle', validate=True, verify_integrity=True)
        if (workflow.surface not in (None,'windows') or workflow.surfaces
                or request['mode']=='production' and workflow.surface!='windows'):
            raise ReplayWorkerError('replay_surface_refused')
        raw_params = _json(inputs['parameters'])
        if type(raw_params) is not dict or len(raw_params)>128:
            raise ReplayWorkerError('replay_parameters_refused')
        params = {key:rt.normalize_runtime_param_scalar(value) for key,value in raw_params.items()}
        profile = rt.execution_profile_contract(rt.resolve_execution_profile(cfg.runtime.profile))
        effects = rt.deployment.build_effect_verifier(cfg.effects, params=params)
        durable = bool(cfg.runtime.durable or profile.require_durable)
        settled = bool(cfg.runtime.require_settled or profile.require_settled)
        gate = rt.run_gate.evaluate_run_gate(workflow, bundle_dir=root/'bundle', deployment=cfg,
            effect_verifier=effects, api_actuator=None, approval_available=False,
            strict_templates=profile.strict_templates, require_encryption=profile.require_encryption,
            profile_contract=profile, effective_durable=durable, effective_require_settled=settled)
        if gate.passed is not True:
            raise ReplayWorkerError('replay_native_gate_refused')
        guards = ports.guards(binding, workflow=workflow, deployment=cfg, bundle_dir=root/'bundle', gate_report=gate)
        if (type(guards) is not dict or set(guards)!={'production_qualification_guard','qualification_campaign_guard','approval_gate'}
                or guards['production_qualification_guard'] is not None and type(guards['production_qualification_guard']) is not rt.ProductionQualificationGuard
                or guards['qualification_campaign_guard'] is not None and type(guards['qualification_campaign_guard']) is not rt.QualificationCampaignGuard
                or guards['approval_gate'] is not None and type(guards['approval_gate']) is not rt.ApprovalGate):
            raise ReplayWorkerError('replay_native_authority_refused')
        if request['mode']=='production':
            guard = guards['production_qualification_guard']
            if guard is None or guards['approval_gate'] is None:
                raise ReplayWorkerError('replay_native_authority_refused')
            guard.verify(workflow, for_actuation=False)
        authorization = rt.run_gate.build_runtime_authorization(workflow, gate,
            approval_source='memlia-native-admission', params=params)
        _root_checkpoint(ports, binding, 'before_run')
        service = _OwnedServer(rt, request['nonce'], request['deadline'])
        service.start()
        write_once(root/'ready',(request['nonce']+'\n').encode('ascii'))
        while not (root/'go').exists():
            if time.monotonic() >= request['deadline'] or (root/'stop').exists():
                raise ReplayWorkerError('replay_stopped')
            time.sleep(.05)
        session = _session(rt,service,root,request,ports,binding)
        origin=f'http://127.0.0.1:{service.port}'
        health=session.get(origin+'/health')
        value=health.json();health.close()
        if (type(value) is not dict or value.get('agent')!='openadapt_flow.win_agent'
                or value.get('auth_required') is not True
                or type(value.get('active_console_session')) is not int
                or value['active_console_session']!=request['sessionId']):
            raise ReplayWorkerError('replay_service_identity_refused')
        backend=rt.WindowsBackend(origin,session=session,auth_token=service.token,allow_legacy_exec=False,
                                  timeout_s=2,screenshot_max_retries=1,screenshot_retry_delay_s=0)
        replayer=rt.deployment.build_replayer(backend,allow_egress=False,effect_verifier=effects,
            api_actuator=None,durable=durable,use_structural=True,governed_authorization=authorization,
            runtime_config=cfg.runtime,**guards)
        run=root/'run';run.mkdir(mode=0o700)
        report=replayer.run(workflow,params=params,bundle_dir=root/'bundle',run_dir=run,
                            execution_target_kind='windows')
        _root_checkpoint(ports,binding,'after_run')
        # Preserve the native report bytes; this adapter never evaluates business effects.
        raw=read_small(run/'report.json',1048576)
        observed=rt.RunReport.model_validate_json(raw)
        if observed.model_dump(mode='json')!=report.model_dump(mode='json'):
            raise ReplayWorkerError('replay_report_changed')
        inventory(root,64*1024*1024)
        return dict(status='observed',reportSha256=hashlib.sha256(raw).hexdigest(),
                    transactionOutcome=observed.transaction_outcome,
                    verified=(observed.transaction_outcome=='VERIFIED' and observed.execution_outcome=='VERIFIED'
                              and observed.production_eligible is True))
    except ReplayWorkerError as error:
        _private_error(error)
        raise
    except Exception as error:
        _private_error(error)
        raise ReplayWorkerError('replay_native_failure') from None
    finally:
        failed=False
        if session is not None:
            try:session.close()
            except Exception as error:
                _private_error(error);failed=True
        if service is not None:
            try:service.close()
            except Exception as error:
                _private_error(error);failed=True
        if binding is not None:
            try:_root_checkpoint(ports,binding,'cleanup')
            except Exception as error:
                _private_error(error);failed=True
            try:
                if ports.close(binding) is not None:failed=True
            except Exception as error:
                _private_error(error);failed=True
        if failed:raise ReplayWorkerError('replay_cleanup_unknown')


def main():
    result={'status':'refused','errorCode':'replay_worker_failed'}
    try:
        if sys.platform!='win32':raise ReplayWorkerError('replay_runtime_unavailable')
        raw=sys.stdin.buffer.read(4097)
        if len(raw)>4096:raise ReplayWorkerError('replay_request_refused')
        request=_json(raw)
        # Full request validation is shared with the parent, without importing engines.
        from .openadapt_replay import _request
        request=_request(request)
        with _engine_stdout():result=run_directory(Path.cwd(),request)
    except ReplayWorkerError as error:
        result['errorCode']=error.code
    except Exception as error:
        result['privateDiagnosticComplete']=_private_error(error)
    sys.stdout.write(json.dumps(result,separators=(',',':'))+'\n')
    return 0 if result['status']=='observed' else 1


if __name__=='__main__':raise SystemExit(main())
