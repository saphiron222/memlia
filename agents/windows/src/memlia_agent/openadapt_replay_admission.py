# Copyright (c) 2026 Memlia. All rights reserved.
"""Personal test admission through the SAME owned parent, never a local permit.

The worker has no mTLS key. Each synchronous checkpoint needs a fresh parent ACK;
that parent invokes the dispatcher's real mTLS checkpoint with its consent/fence.
No production qualification or provider signing authority is manufactured here.
"""
import hashlib
import json
import os
from pathlib import Path
import stat
import time

from .openadapt_capture_worker import read_small, write_once

class AdmissionError(RuntimeError):
    def __init__(self): super().__init__('replay_personal_admission_refused')

def _need(value):
    if not value: raise AdmissionError()

def _encoded(value):
    return json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode('utf8')

def _decode(raw):
    def unique(pairs):
        result={}
        for k,v in pairs:
            _need(k not in result);result[k]=v
        return result
    return json.loads(raw,object_pairs_hook=unique,parse_constant=lambda _: (_ for _ in ()).throw(AdmissionError()))

def _stage(stage,method,path):
    _need(stage in ('admit','startup','before_run','request','after_run','cleanup','close'))
    if stage=='request':
        _need((method=='GET' and path in ('/health','/screenshot')) or
              (method=='POST' and path in ('/context/identity','/uia/locator-at','/uia/text-at-point','/uia/find','/input/guarded','/uia/act')))
    else:_need(method is None and path is None)

def _root(path):
    info=path.lstat()
    _need(stat.S_ISDIR(info.st_mode) and not path.is_symlink() and path.resolve()==path)
    return info.st_dev,info.st_ino

class ParentAdmission:
    def __init__(self,root,request,revalidate):
        _need(request.get('mode')=='test' and callable(revalidate))
        self.root=Path(root).resolve();self.identity=_root(self.root)
        self.request=_decode(_encoded(request));self.revalidate=revalidate
        self.binding=hashlib.sha256(b'memlia.personal-test-ipc/v1\0'+_encoded(self.request)).digest()
        self.sequence=0;self.last=None;self.closed=False
    def serve(self):
        _need(_root(self.root)==self.identity)
        if (self.root/'admission.response').exists():return
        target=self.root/'admission.request'
        if not target.exists():return
        raw=read_small(target,4096);value=_decode(raw)
        _need(type(value) is dict and set(value)=={'nonce','sequence','binding','stage','method','path'})
        _need(value['nonce']==self.request['nonce'] and value['binding']==self.binding.hex())
        _stage(value['stage'],value['method'],value['path'])
        if value['sequence']==self.sequence:
            _need(raw==self.last);return
        _need(not self.closed and type(value['sequence']) is int and value['sequence']==self.sequence+1
              and value['sequence']<=10000 and time.monotonic()<self.request['deadline']
              and not (self.root/'stop').exists())
        _need((self.sequence==0)==(value['stage']=='admit'))
        # A None return is the existing dispatcher's positive checkpoint contract.
        _need(self.revalidate() is None)
        _need(time.monotonic()<self.request['deadline'] and not (self.root/'stop').exists())
        response=_encoded({'nonce':value['nonce'],'sequence':value['sequence'],'binding':value['binding'],'accepted':True})
        write_once(self.root/'admission.response.next',response)
        _need(not (self.root/'admission.response').exists())
        os.replace(self.root/'admission.response.next',self.root/'admission.response')
        self.sequence=value['sequence'];self.last=raw;self.closed=value['stage']=='close'

_active={}

def _exchange(state,stage,method=None,path=None):
    _stage(stage,method,path)
    root=state['root'];_need(_root(root)==state['identity'])
    _need(not state['closed'] and state['sequence']<10000)
    state['sequence']+=1
    request=dict(nonce=state['request']['nonce'],sequence=state['sequence'],binding=state['binding'].hex(),
                 stage=stage,method=method,path=path)
    _need(time.monotonic()<state['request']['deadline'] and not (root/'stop').exists())
    write_once(root/'admission.request.next',_encoded(request))
    _need(not (root/'admission.request').exists())
    os.replace(root/'admission.request.next',root/'admission.request')
    deadline=min(state['request']['deadline'],time.monotonic()+5)
    while True:
        _need(time.monotonic()<deadline and not (root/'stop').exists() and _root(root)==state['identity'])
        if (root/'admission.response').exists():
            response=_decode(read_small(root/'admission.response',4096))
            _need(type(response) is dict and type(response.get('sequence')) is int
                  and response.get('accepted') is True
                  and response==dict(nonce=request['nonce'],sequence=request['sequence'],binding=request['binding'],accepted=True))
            # Delete request first so the parent cannot reconsider it after response removal.
            _need(read_small(root/'admission.request',4096)==_encoded(request))
            (root/'admission.request').unlink();(root/'admission.response').unlink()
            return
        time.sleep(.01)

def admit_replay(request,*,bundle_sha256,deployment_sha256,parameters_sha256,operation_digest,mode,deadline,admission_bytes):
    _need(mode=='test' and request['mode']=='test' and not _active and request['deadline']==deadline)
    for key,value in (('bundleSha256',bundle_sha256),('deploymentSha256',deployment_sha256),
                      ('parametersSha256',parameters_sha256),('operationDigest',operation_digest)):
        _need(request[key]==value)
    _need(type(admission_bytes) is bytes and 0<len(admission_bytes)<=65536 and hashlib.sha256(admission_bytes).hexdigest()==request['admissionSha256'])
    captured=_decode(_encoded(request));root=Path.cwd().resolve()
    binding=hashlib.sha256(b'memlia.personal-test-ipc/v1\0'+_encoded(captured)).digest()
    state=dict(root=root,identity=_root(root),request=captured,binding=binding,sequence=0,closed=False)
    _exchange(state,'admit');_active[binding]=state
    return binding

def checkpoint_replay(binding,*,stage,method=None,path=None):
    _need(type(binding) is bytes and binding in _active and stage not in ('admit','close'))
    _exchange(_active[binding],stage,method,path)

def flow_guards(binding,*,workflow,deployment,bundle_dir,gate_report):
    _need(binding in _active and deployment.runtime.profile=='demo' and gate_report.passed is True)
    checkpoint_replay(binding,stage='before_run')
    # This is an attended personal trial, not a signed qualification campaign.
    return dict(production_qualification_guard=None,qualification_campaign_guard=None,approval_gate=None)

def close_replay_admission(binding):
    _need(type(binding) is bytes and binding in _active)
    state=_active[binding];_exchange(state,'close');state['closed']=True;del _active[binding]
