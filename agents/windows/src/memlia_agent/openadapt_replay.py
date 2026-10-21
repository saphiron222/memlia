# Copyright (c) 2026 Memlia. All rights reserved.
"""Internal supervised native replay. Authority is supplied only by the root port."""
import ctypes
from dataclasses import dataclass, field
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import secrets
import sys
import tempfile
import threading
import time

from .capture_controls import _CaptureControls, _TaskDialog, _Button, _Config, _APPROVE, _CANCEL, _FINISH, _DIGEST
from .capture_input_filter import _SID
from .openadapt_capture import _environment
from .openadapt_capture_worker import inventory, read_small, write_once
from .openadapt_compile import BundleFile, CompiledRecording, _VERSIONS, _digest, _names
from .openadapt_compile_process import _CompileRun, _compiler_ready
from .owned_job import JobError, JobIO, OwnedJob
from .resources import reserve_desktop
from .stop import LocalStop, StopRequested


class ReplayError(RuntimeError):
    def __init__(self, code):
        self.code = code
        self.private_output = None
        self.private_artifacts = ()
        self.reason_code = code
        self.effect_state = 'not_observed'
        super().__init__(code)


class _ReplayDialog(_TaskDialog):
    def __init__(self, mode):
        if mode not in ('test', 'production'):
            raise ReplayError('replay_mode_refused')
        self.mode = mode
        super().__init__()

    def _finish_enabled(self, hwnd, enabled):
        pass  # Replay has no normal-finish button; only the owned runtime can finish.

    def mark_recording(self, hwnd):
        title = 'Memlia — essai de procédure en cours' if self.mode=='test' else 'Memlia — procédure en cours'
        if not self._title(hwnd,title):
            raise ReplayError('replay_indicator_unavailable')

    def show(self, owner):
        callback_type=ctypes.WINFUNCTYPE(ctypes.c_int32,ctypes.c_void_p,ctypes.c_uint32,
                                       ctypes.c_size_t,ctypes.c_ssize_t,ctypes.c_ssize_t)
        callback=callback_type(lambda hwnd,event,value,unused,reference:owner._notification(self,hwnd,event,value))
        trial=self.mode=='test'
        buttons=(_Button*2)(_Button(_APPROVE,'Autoriser cet essai' if trial else 'Autoriser cette exécution'),
                            _Button(_CANCEL,'Refuser / Arrêter maintenant'))
        config=_Config();config.cbSize=ctypes.sizeof(config);config.dwFlags=0x0008|0x0800
        config.pszWindowTitle='Memlia — accord local de procédure'
        config.pszMainInstruction='Autorisez-vous cet essai réel ?' if trial else 'Autorisez-vous cette exécution ?'
        config.pszContent=(
            'Memlia va rejouer les actions de la procédure sur ce bureau : clics, frappes et lectures d’écran. '
            'Ces actions peuvent modifier des applications ou des fichiers. '
            + ('Un essai ne qualifie pas automatiquement la procédure. ' if trial else '')
            + 'N’affichez aucune information confidentielle. Ce dialogue restera visible. '
            '« Arrêter maintenant » ou Ctrl + Alt + Maj + F11 demande l’arrêt ; '
            'les effets déjà livrés ne sont pas annulés et peuvent rester incertains.')
        config.cButtons,config.pButtons,config.nDefaultButton=2,buttons,_CANCEL
        config.pfCallback=ctypes.cast(callback,ctypes.c_void_p).value
        selected=ctypes.c_int32()
        if self._dialog(ctypes.byref(config),ctypes.byref(selected),None,None)!=0:
            raise ReplayError('replay_dialog_unavailable')


class _ReplayControls(_CaptureControls):
    def __init__(self,reservation,signal,digest,mode):
        if mode not in ('test','production'):raise ReplayError('replay_mode_refused')
        self.mode=mode
        super().__init__(reservation,signal,digest)

    def _make_dialog(self):return _ReplayDialog(self.mode)

    def _notification(self,api,hwnd,event,value):
        if event==2 and value==_FINISH:
            self._fail('replay_state_refused')
            return 1
        return super()._notification(api,hwnd,event,value)


@dataclass(frozen=True)
class ReplayObservation:
    mode: str
    transaction_outcome: str | None
    status: str  # observed_verified or uncertain; never procedure ready/qualified.
    operation_digest: str
    bundle_sha256: str
    private_artifacts: tuple[tuple[str,bytes], ...] = field(repr=False)
    private_output: object = field(repr=False)


def _request(value, *, require_session=True):
    keys={'version','nonce','operationDigest','mode','bundleSha256','deploymentSha256',
          'parametersSha256','admissionSha256','deadline','windowsSid','sessionId'}
    if (type(value) is not dict or set(value)!=keys or type(value['version']) is not int
            or value['version']!=1 or type(value['mode']) is not str or value['mode'] not in ('test','production')
            or type(value['nonce']) is not str or len(value['nonce'])!=32
            or any(c not in '0123456789abcdef' for c in value['nonce'])
            or type(value['operationDigest']) is not str or not _DIGEST.fullmatch(value['operationDigest'])
            or type(value['deadline']) not in (int,float)):
        raise ReplayError('replay_request_refused')
    if require_session:
        if (type(value['windowsSid']) is not str or len(value['windowsSid'])>184 or not _SID.fullmatch(value['windowsSid'])
                or type(value['sessionId']) is not int or not 1<=value['sessionId']<2**32):
            raise ReplayError('replay_request_refused')
    elif value['windowsSid'] is not None or value['sessionId'] is not None:
        raise ReplayError('replay_request_refused')
    for key in ('bundleSha256','deploymentSha256','parametersSha256','admissionSha256'):
        if type(value[key]) is not str or len(value[key])!=64 or any(c not in '0123456789abcdef' for c in value[key]):
            raise ReplayError('replay_request_refused')
    try: valid=math.isfinite(value['deadline']) and 0<value['deadline']-time.monotonic()<=1800
    except OverflowError:valid=False
    if not valid:raise ReplayError('replay_request_refused')
    return dict(value)


def _ready():
    try:_compiler_ready()
    except Exception:raise ReplayError('replay_runtime_unavailable') from None
    available=False
    try:available=importlib.util.find_spec('memlia_agent.openadapt_replay_admission') is not None
    except Exception:pass
    if not available:
        raise ReplayError('replay_admission_unavailable')


_active=None
_registry_lock=threading.Lock()


class _ReplayRun(_CompileRun):
    def __init__(self,files,request,inputs,revalidate):
        super().__init__(files,request['operationDigest'],request,revalidate)
        self.inputs=inputs
        self.controls=None
        self.prepared=False
        self.started_attempt=False
        self.private_artifacts=()
        self.worker_cleanup_unknown=False

    def take_output(self):
        self.output=self.job.take_output();self.output_pending=False
        if self.output.stdout_eof is True:
            try:
                value=json.loads(self.output.stdout)
                if (type(value) is dict and set(value)=={'status','errorCode'}
                        and value['status']=='refused' and value['errorCode']=='replay_cleanup_unknown'):
                    self.worker_cleanup_unknown=True
            except Exception:
                pass  # Partial/invalid receipts never become evidence of a closed worker.

    def authority(self):
        self.require_owner()
        valid=False
        try:valid=self.revalidate() is None
        except Exception:pass
        if not valid:raise ReplayError('replay_authority_unavailable')
        if time.monotonic()>=self.request['deadline']:raise ReplayError('replay_timeout')

    def checkpoint(self):
        super().checkpoint()
        if self.controls is not None:self.controls.checkpoint(operation_digest=self.operation_digest)

    def heartbeat(self,root):
        self.checkpoint()
        value=(self.request['nonce']+'\n'+repr(time.monotonic())+'\n').encode('ascii')
        write_once(root/'heartbeat.next',value)
        os.replace(root/'heartbeat.next',root/'heartbeat')  # Only this owner writes, inside its private fresh root.

    def artifacts(self,root):
        files=inventory(root,64*1024*1024)
        # All streams and run artifacts stay private, including failed native reports.
        self.private_artifacts=tuple((name,read_small(root/name,8*1024*1024)) for name,_ in files
                                     if name.startswith('run/') or name in ('input-attempted','ready'))

    def run(self):
        self.authority();_ready();self.authority()
        self.reservation=reserve_desktop()
        self.signal=LocalStop(self.reservation,self.request['deadline']);self.signal._start()
        observed=self.reservation.ensure_current()
        self.request.update(windowsSid=observed.windows_sid,sessionId=observed.session_id)
        self.request=_request(self.request)
        self.controls=_ReplayControls(self.reservation,self.signal,self.operation_digest,self.request['mode'])
        self.controls._start();self.checkpoint()
        self.temporary=tempfile.TemporaryDirectory(prefix='memlia-replay-')
        root=Path(self.temporary.name);os.chmod(root,0o700)
        bundle=root/'bundle';bundle.mkdir(mode=0o700)
        for name,data in self.files:
            self.checkpoint();target=bundle/name;target.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
            write_once(target,data)
        for name,data in self.inputs:write_once(root/name,data)
        self.checkpoint()
        self.job=OwnedJob(executable=sys.executable,arguments=('-I','-m','memlia_agent.openadapt_replay_worker'),
            cwd=str(root),environment=_environment(root),deadline_monotonic=self.request['deadline'],
            io=JobIO(json.dumps(self.request,separators=(',',':'),allow_nan=False).encode('ascii'),8192,65536))
        try:self.controls.recording_preparing(operation_digest=self.operation_digest)
        except BaseException:
            with self.controls._lock:self.prepared=self.controls._work_pending
            raise
        self.prepared=True;self.checkpoint();self.output_pending=True;self.started_attempt=True;self.job.start()
        started=False
        while True:
            self.checkpoint();inventory(root,64*1024*1024)
            state=self.job.poll()
            if state.forced:raise ReplayError('replay_worker_refused')
            if not started and (root/'ready').exists():
                if read_small(root/'ready',64)!=(self.request['nonce']+'\n').encode('ascii'):
                    raise ReplayError('replay_service_identity_refused')
                self.controls.recording_started(operation_digest=self.operation_digest)
                started=True
            if started and not (root/'go').exists():
                with self.controls._lock:indicated=self.controls._recording_indicated
                if indicated:
                    self.heartbeat(root);write_once(root/'go',(self.request['nonce']+'\n').encode('ascii'))
            if (root/'go').exists():self.heartbeat(root)
            if state.active_processes==0 and state.root_finished and state.io_complete is True:break
            time.sleep(.05)
        self.take_output()
        self.artifacts(root);self.checkpoint()
        if (state.root_exit_code!=0 or self.output.stdin_complete is not True
                or self.output.stdout_eof is not True or self.output.stderr_eof is not True):
            raise ReplayError('replay_worker_refused')
        try:
            result=json.loads(self.output.stdout)
            valid=(type(result) is dict and set(result)=={'status','reportSha256','transactionOutcome','verified'}
                   and result['status']=='observed' and type(result['verified']) is bool
                   and result['transactionOutcome'] in {'VERIFIED','HALTED_BEFORE_EFFECT','RECONCILIATION_REQUIRED',
                       'FAILED_PLATFORM','CANCELED','REJECTED_POLICY','COMPLETED_UNVERIFIED','ROLLED_BACK'}
                   and (not result['verified'] or result['transactionOutcome']=='VERIFIED'))
            report=dict(self.private_artifacts)['run/report.json']
            metadata=json.loads(report)
            if (not valid or hashlib.sha256(report).hexdigest()!=result['reportSha256']
                    or type(metadata) is not dict or metadata.get('transaction_outcome')!=result['transactionOutcome']
                    or result['verified'] and (metadata.get('execution_outcome')!='VERIFIED'
                                              or metadata.get('production_eligible') is not True)):
                raise ValueError()
        except Exception:raise ReplayError('replay_worker_refused') from None
        return ReplayObservation(self.request['mode'],result['transactionOutcome'],
            'observed_verified' if result['verified'] else 'uncertain',self.operation_digest,
            self.request['bundleSha256'],self.private_artifacts,self.output)

    def cleanup(self):
        self.require_owner()
        if self.closed:return True
        try:
            if self.signal is not None:self.signal.request_stop()
            if self.temporary is not None:
                root=Path(self.temporary.name)
                if not (root/'stop').exists():write_once(root/'stop',(self.request['nonce']+'\n').encode('ascii'))
            if self.job is not None:
                if not self.job.cleanup():return False
                if self.output_pending:
                    try:self.take_output()
                    except JobError as error:
                        if error.code!='job_state_refused':raise
                    self.output_pending=False
                self.job=None
            if self.temporary is not None:self.artifacts(Path(self.temporary.name))
            # Root admission cleanup may be unknown even after the OS Job is reaped.
            # A cleanup-only reconciliation cannot turn that report into an ACK.
            if self.worker_cleanup_unknown:return False
            if self.controls is not None:
                if self.prepared:
                    self.controls.recording_stopped(operation_digest=self.operation_digest);self.prepared=False
                self.controls.close();self.controls=None
        except Exception:return False
        return super().cleanup()


def replay_compiled_recording(*,compiled,operation_digest,mode,deployment_bytes,parameters_bytes,
                              admission_bytes,deadline_monotonic,revalidate):
    """Internal only. Root must bind command, exact artifacts, mode, SID, lease/fence.

    Compilation to_test is provenance, never permission or qualification. No default
    mode/parameters/admission, no network dispatcher and no CLI command are supplied.
    """
    global _active
    try:
        if (type(compiled) is not CompiledRecording or type(compiled.files) is not tuple
                or not 3<=len(compiled.files)<=128 or compiled.status!='to_test'
                or compiled.versions!=tuple(sorted(_VERSIONS.items())) or not callable(revalidate)):
            raise ValueError()
        files=[]
        for item in compiled.files:
            if (type(item) is not BundleFile or type(item.content) is not bytes
                    or len(item.content)>8*1024*1024 or hashlib.sha256(item.content).hexdigest()!=item.sha256):
                raise ValueError()
            files.append((item.path,item.content))
        _names(name for name,_ in files);files=tuple(sorted(files))
        if (len({name for name,_ in files})!=len(files) or sum(len(data) for _,data in files)>32*1024*1024
                or _digest(files,b'memlia.openadapt-bundle/v1\0')!=compiled.bundle_sha256):raise ValueError()
        inputs=(('deployment.json',deployment_bytes),('parameters.json',parameters_bytes),('admission.bin',admission_bytes))
        for name,data in inputs:
            if type(data) is not bytes or not 1<=len(data)<=(262144 if name=='deployment.json' else 65536):raise ValueError()
        request=_request(dict(version=1,nonce=secrets.token_hex(16),operationDigest=operation_digest,mode=mode,
            bundleSha256=compiled.bundle_sha256,deploymentSha256=hashlib.sha256(deployment_bytes).hexdigest(),
            parametersSha256=hashlib.sha256(parameters_bytes).hexdigest(),admissionSha256=hashlib.sha256(admission_bytes).hexdigest(),
            deadline=deadline_monotonic,windowsSid=None,sessionId=None),require_session=False)
    except Exception:raise ReplayError('replay_request_refused') from None
    with _registry_lock:
        if _active is not None:raise ReplayError('replay_hold')
        if sys.platform!='win32':raise ReplayError('replay_runtime_unavailable')
        owner=_ReplayRun(files,request,inputs,revalidate);_active=owner
    failure,result='replay_failed',None
    try:result=owner.run();failure=None
    except ReplayError as error:failure=error.code
    except StopRequested as error:failure='replay_timeout' if error.code=='deadline_expired' else 'replay_cancelled'
    except Exception:pass
    finally:
        clean=owner.cleanup()
        if clean:
            with _registry_lock:
                if _active is owner:_active=None
        else:failure='replay_hold'
    if failure is None:
        try:owner.authority()
        except ReplayError as error:failure=error.code
    if failure is not None:
        attempted='input-attempted' in dict(owner.private_artifacts)
        code='replay_result_uncertain' if attempted and failure!='replay_hold' else failure
        error=ReplayError(code);error.reason_code=failure
        error.effect_state='uncertain' if attempted else ('unknown' if owner.started_attempt else 'not_observed')
        error.private_output=owner.output;error.private_artifacts=owner.private_artifacts
        raise error
    return result


def reconcile_replay():
    """Same owner, cleanup only; never resubmit an input or rerun a procedure."""
    global _active
    with _registry_lock:owner=_active
    if owner is None:return True
    if not owner.cleanup():return False
    with _registry_lock:
        if _active is owner:_active=None
    return True
