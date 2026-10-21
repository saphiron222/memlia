# Copyright (c) 2026 Memlia. All rights reserved.
"""Explicit native-API or Compose qualification recipes, with separate scopes."""
import base64
import importlib.util
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import time
import uuid
from urllib.parse import urlsplit

import supervisor as s

ROOT=Path(__file__).resolve().parents[3]
NODE='node:24.22.0-bookworm@sha256:14078204b6bb268c107ceff6d3c43f45a888105e5c2b18b14c32b3409d93a1b0'
POSTGRES='pgvector/pgvector:pg17@sha256:ac08538c6f8b9904c33c8224c5e5706dbe760aca29db1d096972b4052c22a75d'
CACHE='valkey/valkey:8.1.10-alpine@sha256:081c2f5cb575efc901aa80ff9cdbd1ec6a301682fd35e1ebb4b0990a4a4a8507'
DOCKER=['/usr/bin/docker','--host','unix:///var/run/docker.sock']
MAX_RESULT=1024*1024
XLSX='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
CHECKS=('noKeyDenied','wrongKeyDenied','authenticated','webHasNoDdl','uploaded',
        'otherWorkspaceKeyAuthenticated','crossWorkspaceDenied','graphSaved','nativeRunCompleted','nativeFileRecorded',
        'downloadNoKeyDenied','downloadCrossWorkspaceDenied','sameRecordedOutput','sourceUnchanged',
        'ownedRunFixtureRetired')
STAGES=('preflight','database_identity','native_credential','workspace_preparation',
        'authentication_negatives','file_upload','workflow_graph','native_execution',
        'native_recorded_file','download_authorization','same_output_download','source_readback','owned_run_cleanup')
CLEANUP_STAGES=('preflight','owner_readback','scope_readback','native_account_deletion',
                'deleted_user_readback','residue_capture','residue_delete','baseline_compare','proof_write',
                'application_connections_close','database_connection_close','unknown')

FINAL_PHASES=('preflight','bootstrap','migrate','grants','metadata','baseline','seed',
              'business','cleanup','readback','post_readback_inspection',
              'container_cleanup','container_absence','network_cleanup',
              'tree_identity','tree_snapshot','tree_remove','complete')
FINAL_PHASES+=('durable_preflight','durable_migrations','durable_browser','durable_worker_start',
               'durable_worker_drain',*('durable_bootstrap_'+p for p in ('prepare','grants','verify')),
               *('durable_fixture_'+p for p in ('metadata','metadata-final','baseline','seed','durable-prepare','durable-publish',
                                              'durable-readback','durable-retire','cleanup','readback')))


def remember_failure(work,record,error):
    """Keep the first bounded private cause before emitting closed public fields."""
    if 'firstFailure' in record:return
    phase=record.get('phase')
    phase=phase if phase in FINAL_PHASES else 'unknown'
    kind=('os_error' if isinstance(error,OSError) else
          'isolation_error' if isinstance(error,s.IsolationError) else
          'validation_error' if isinstance(error,ValueError) else 'other_error')
    number=error.errno if isinstance(error,OSError) else None
    number=number if type(number)is int and 0<number<=4095 else None
    failure=dict(code='application_recipe_refused',phase=phase,kind=kind,errno=number)
    saved=False
    try:
        # Never follow or overwrite an older receipt; it lives outside the tree
        # being retired and contains no captured process output or environment.
        detail=str(error)[:2048]
        raw=json.dumps(dict(failure=failure,detail=detail),ensure_ascii=True).encode()
        require(len(raw)<=16_384)
        fd=os.open(work.parent/'application-finalization-failure.private.json',
                   os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        with os.fdopen(fd,'wb') as stream:stream.write(raw+b'\n')
        saved=True
    except Exception:pass
    record['firstFailure']=failure
    record['failureEvidenceSaved']=saved


def require(value,check='application_recipe_refused'):
    if not value:raise ValueError(check)


def verify_durable_submission(raw,prepared):
    """Only the real browser's completed session/202/closure receipt permits a worker start."""
    from memlia_excel.process import pairs,non_json
    require(0<len(raw)<=16384)
    value=json.loads(raw,object_pairs_hook=pairs,parse_constant=non_json)
    fields={'status','scope','authenticated','deployed','queued','browserClosed',
            'workflowId','workspaceId','deploymentVersionId','executionId','jobId'}
    require(type(value)is dict and set(value)==fields
            and value['status']=='passed' and value['scope']=='native_session_durable_submission'
            and all(value[key] is True for key in ('authenticated','deployed','queued','browserClosed')))
    for key in ('workflowId','workspaceId','deploymentVersionId','executionId','jobId'):
        require(type(value[key])is str and re.fullmatch(r'[a-zA-Z0-9:_-]{1,160}',value[key]))
    require(value['workflowId']==prepared['workflowId'] and value['workspaceId']==prepared['workspaceId']
            and value['jobId']=='workflow-execution:'+value['executionId'])
    return value


def project_cleanup_failure(raw):
    from memlia_excel.process import pairs,non_json
    require(0<len(raw)<=1024)
    value=json.loads(raw,object_pairs_hook=pairs,parse_constant=non_json)
    require(type(value)is dict and set(value)=={'status','code','stage','index','sqlstate'})
    require(value['status']=='failed' and value['code']=='fixture_cleanup_refused'
            and value['stage'] in CLEANUP_STAGES)
    index,state=value['index'],value['sqlstate']
    require(index is None or (value['stage']=='baseline_compare' and type(index)is int and 0<=index<183))
    require(state is None or (type(state)is str and len(state)==5
            and all(char in 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' for char in state)))
    return value


def verify_result(raw):
    from memlia_excel.process import pairs,non_json
    require(0<len(raw)<=MAX_RESULT)
    value=json.loads(raw,object_pairs_hook=pairs,parse_constant=non_json)
    require(type(value)is dict and set(value)=={'status','scope','checks','file','download'})
    require(value['status']=='passed' and value['scope']=='native_api_in_process')
    require(type(value['checks'])is dict and set(value['checks'])==set(CHECKS)
            and all(v is True for v in value['checks'].values()))
    content=verify_recorded_download(value['file'],value['download'])
    return dict(scope=value['scope'],**value['checks'],**content,httpQualified=False,nextQualified=False,
                browserQualified=False,durableJobQualified=False,liveProviderTested=False)


def verify_recorded_download(file,download):
    import openpyxl
    from io import BytesIO
    require(type(file)is dict and set(file)=={'contentBase64','sha256','size','contentType'})
    require(type(download)is dict and set(download)=={'status','contentType','contentLength','contentBase64'})
    require(type(download['status'])is int and download['status']==200
            and file['contentType']==download['contentType']==XLSX)
    require(type(file['contentBase64'])is str and type(download['contentBase64'])is str)
    content=base64.b64decode(file['contentBase64'],validate=True)
    require(0<len(content)<=100_000 and base64.b64encode(content).decode()==file['contentBase64'])
    require(type(file['size'])is int and type(download['contentLength'])is int
            and file['size']==download['contentLength']==len(content))
    require(file['sha256']=='sha256:'+sha256(content).hexdigest()
            and download['contentBase64']==file['contentBase64'])
    book=openpyxl.load_workbook(BytesIO(content),read_only=True,data_only=False)
    try:
        require(book.sheetnames==['Result'] and list(book.active.values)==[
            ('id','debit','credit'),('a','0.10','0.10'),('b','0.20','0.20')])
    finally:book.close()
    return dict(outputSha256=file['sha256'],outputBytes=len(content))


def verify_durable_result(raw,submission):
    from memlia_excel.process import pairs,non_json
    require(0<len(raw)<=MAX_RESULT)
    value=json.loads(raw,object_pairs_hook=pairs,parse_constant=non_json)
    require(type(value)is dict and set(value)=={'status','scope','checks','durable','file','download'}
            and value['status']=='passed' and value['scope']=='native_durable_compose')
    require(type(value['checks'])is dict and set(value['checks'])==set(CHECKS)
            and all(value['checks'][key] is (key!='ownedRunFixtureRetired') for key in CHECKS))
    native=value['durable']
    require(type(native)is dict and set(native)=={'jobId','executionId','completed','attempts',
            'transportAcked','oneDelivery','oneExecutionLog'}
            and native['jobId']==submission['jobId'] and native['executionId']==submission['executionId']
            and type(native['attempts'])is int and native['attempts']==1
            and all(native[key] is True for key in ('completed','transportAcked','oneDelivery','oneExecutionLog')))
    return dict(scope=value['scope'],businessPassed=True,**verify_recorded_download(value['file'],value['download']),
                singleAttempt=True,transportAcked=True,oneExecutionLog=True,liveProviderTested=False)


def verify_bootstrap_receipt(raw,phase,nonce):
    from memlia_excel.process import pairs,non_json
    require(0<len(raw)<=4096)
    value=json.loads(raw,object_pairs_hook=pairs,parse_constant=non_json)
    require(type(value)is dict and set(value)=={'version','phase','prepared','grantsVerified','transportBusinessRead',
        'runtimeDdl','runtimeDdlScope','database','queueSchema','deploymentId','status'}
        and value['version']=='memlia.database-bootstrap-receipt/v1'
        and value['phase']==phase and value['prepared'] is True
        and type(value['grantsVerified'])is bool and (phase=='prepare' or value['grantsVerified'] is True)
        and value['transportBusinessRead'] is False and value['runtimeDdl'] is False
        and value['database']=='memlia_ui_'+nonce and value['queueSchema']=='memlia_jobs'
        and value['deploymentId']==nonce
        and value['runtimeDdlScope']=='business_roles;transport_owns_queue_schema'
        and value['status']=='PASS')
    return value


def durable_configuration(value):
    require(type(value)is dict and set(value)=={'schemaVersion','sourceCommit','lockSha256','nonce',
            'envFile','bootstrapFile','images','browser'}
            and value['schemaVersion']=='memlia.excel-durable-qualification/v1')
    for key,size in (('sourceCommit',40),('lockSha256',64),('nonce',32)):
        require(type(value[key])is str and re.fullmatch('[a-f0-9]{'+str(size)+'}',value[key]))
    def path(raw):
        require(type(raw)is str and '\x00' not in raw and len(os.fsencode(raw))<=4096
                and Path(raw).is_absolute() and os.path.normpath(raw)==raw)
    for key in ('envFile','bootstrapFile'):path(value[key])
    images=value['images'];apps={'web','realtime','migrations','cron','workflow-worker'}
    require(type(images)is dict and set(images)==apps|{'db','redis'})
    for name,image in images.items():
        require(type(image)is dict and set(image)==({'reference','imageId','sourceCommit','lockSha256'}
                if name in apps else {'reference','imageId'})
                and type(image['imageId'])is str and re.fullmatch(r'sha256:[a-f0-9]{64}',image['imageId']))
        if name in apps:
            require(image['sourceCommit']==value['sourceCommit'] and image['lockSha256']==value['lockSha256']
                    and type(image['reference'])is str and re.fullmatch(
                        r'[a-z0-9][a-z0-9._:/-]*/'+name+r'@sha256:[a-f0-9]{64}',image['reference']))
        else:require(image['reference']==({'db':POSTGRES,'redis':CACHE}[name]))
    browser=value['browser']
    require(type(browser)is dict and set(browser)=={'node','chromium','certutil','ca'})
    for tool in browser.values():
        require(type(tool)is dict and set(tool)=={'path','sha256'}
                and type(tool['sha256'])is str and re.fullmatch('[a-f0-9]{64}',tool['sha256']))
        path(tool['path'])
    return value


def protected_durable_file(path,*,executable=False,limit=65536):
    """Operator configuration/tools, never a path accepted from a workflow payload."""
    from admission import _parents,_view
    path=Path(path);parents=_parents(path,0);before=path.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_uid==0 and before.st_nlink==1
            and not before.st_mode & 0o022 and 0<before.st_size<=limit)
    require((before.st_mode & 0o111)!=0 if executable else stat.S_IMODE(before.st_mode) in (0o400,0o600))
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    result=bytearray()
    with os.fdopen(fd,'rb') as source:
        require(_view(os.fstat(source.fileno()))==_view(before))
        while True:
            chunk=source.read(65536)
            if not chunk:break
            result.extend(chunk);require(len(result)<=limit)
        require(_view(os.fstat(source.fileno()))==_view(before))
    require(_view(path.lstat())==_view(before) and len(result)==before.st_size
            and all(_view(parent.lstat())==view for parent,view in parents))
    return bytes(result)


def verify_durable_image(row,name,config):
    expected=config['images'][name]
    require(row['Id']==expected['imageId'] and row['Os']=='linux' and row['Architecture']=='amd64'
            and expected['reference'] in row.get('RepoDigests',[]))
    if name not in ('db','redis'):
        labels=row['Config'].get('Labels') or {}
        require(labels.get('org.memlia.source')==config['sourceCommit']
                and labels.get('org.memlia.lock')==config['lockSha256'])
    if name=='workflow-worker':
        require(row['Config']['User']=='1001:1001' and row['Config']['WorkingDir']=='/app/apps/sim'
                and not row['Config'].get('Entrypoint')
                and row['Config']['Cmd']==['bun','--no-env-file','--tsconfig-override=tsconfig.json',
                                           'scripts/memlia-workflow-worker.ts'])


def validate_durable_model(model,config,socket):
    spec=importlib.util.spec_from_file_location('excel_compose_preflight',ROOT/'deploy/memlia/preflight.py')
    preflight=importlib.util.module_from_spec(spec);spec.loader.exec_module(preflight)
    require(preflight.validate(model)==[] and model.get('name')=='memlia-excel-durable-'+config['nonce'])
    services=model['services'];worker=services['workflow-worker'];web=services['web']
    require(set(services)==set(config['images']) and all(services[name]['image']==image['reference']
            for name,image in config['images'].items()))
    require(worker.get('user')=='1001:1001' and worker.get('read_only') is True
            and worker.get('working_dir')=='/app/apps/sim' and worker.get('pull_policy')=='never'
            and worker.get('restart')=='no' and worker.get('cap_drop')==['ALL']
            and worker.get('security_opt')==['no-new-privileges:true']
            and worker.get('mem_limit')==4*1024**3 and worker.get('memswap_limit')==4*1024**3
            and float(worker.get('cpus',0))==2 and worker.get('pids_limit')==256
            and not worker.get('command') and not worker.get('entrypoint')
            and not worker.get('privileged') and not worker.get('devices')
            and not worker.get('volumes_from') and not worker.get('ports')
            and not worker.get('pid') and not worker.get('network_mode'))
    env=worker['environment']
    require(env.get('MEMLIA_EXCEL_HOST_SOCKET')=='/run/memlia-excel/host.sock'
            and env.get('MEMLIA_EXCEL_HOST_OPERATOR_UID')=='0'
            and all(env.get(key)=='1' for key in ('MEMLIA_DURABLE_WORKFLOWS_ENABLED','MEMLIA_PG_BOSS_ENABLED'))
            and env.get('TRIGGER_DEV_ENABLED')=='false'
            and all(not env.get(key) for key in ('OPENAI_API_KEY','ANTHROPIC_API_KEY','OLLAMA_URL')))
    require(all(web['environment'].get(key)=='1' for key in
                ('MEMLIA_DURABLE_WORKFLOWS_ENABLED','MEMLIA_PG_BOSS_ENABLED')))
    require(not web['environment'].get('AUTH_TRUSTED_PROXIES'))
    mounts=worker.get('volumes',[])
    require(len(mounts)==2 and {m.get('target') for m in mounts}=={'/app/apps/sim/uploads','/run/memlia-excel'})
    upload=next(m for m in mounts if m['target']=='/app/apps/sim/uploads')
    host=next(m for m in mounts if m['target']=='/run/memlia-excel')
    require(upload.get('type')=='volume' and upload.get('source')=='uploads' and not upload.get('read_only')
            and host.get('type')=='bind' and host.get('source')==str(socket.parent) and host.get('read_only') is True
            and host.get('bind',{}).get('create_host_path') is False)
    require(any(m.get('type')=='volume' and m.get('source')=='uploads'
                and m.get('target')=='/app/apps/sim/uploads' and not m.get('read_only')
                for m in web.get('volumes',[])))
    require(not any(v.get('external') for v in model.get('volumes',{}).values())
            and all(v.get('name')==model['name']+'_'+key for key,v in model.get('volumes',{}).items())
            and not any(n.get('external') for n in model.get('networks',{}).values())
            and all(n.get('name')==model['name']+'_'+key for key,n in model.get('networks',{}).items()))
    origin=web['environment']['BETTER_AUTH_URL']
    require(re.fullmatch(r'https://localhost(?::[1-9][0-9]{0,4})?',origin) and urlsplit(origin).port!=0)
    return origin


def inspect_owned(row,cid,nonce,user,memory,cpu,pids,*,running=None):
    require(row['Id']==cid and row['Config']['Labels'].get('org.memlia.excel.application')==nonce
            and row['Config']['User']==user)
    host=row['HostConfig'];state=row['State']
    require(host['ReadonlyRootfs'] is True and host['Privileged'] is False
            and host['Memory']==memory and host['MemorySwap']==memory
            and host['NanoCpus']==cpu and host['PidsLimit']==pids
            and host['CapDrop']==['ALL'] and host['SecurityOpt']==['no-new-privileges:true'])
    require(state['OOMKilled'] is False)
    if running is not None:require(state['Running'] is running)


def inspect_mounts(row,expected):
    require(type(row.get('Mounts'))is list)
    seen={}
    for mount in row['Mounts']:
        require(type(mount)is dict)
        if mount['Type']=='tmpfs':
            require(mount['Destination'] in row['HostConfig']['Tmpfs'])
            continue
        require(mount['Type']=='bind' and mount['Destination'] not in seen)
        seen[mount['Destination']]=(mount['Source'],mount['RW'])
        require(type(mount['RW'])is bool and mount.get('Propagation')=='rprivate')
    require(seen==expected)


def tree_snapshot(root):
    """Owned cooperative CI tree only; never follows links or deletes a live writer."""
    rows={}
    def visit(path):
        require(len(rows)<4096,'tree_entry_limit')
        info=path.lstat();require(not stat.S_ISLNK(info.st_mode),'tree_symlink')
        require(stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode),'tree_file_kind')
        require(info.st_uid in (os.getuid(),1001) and (stat.S_ISDIR(info.st_mode) or info.st_nlink==1),
                'tree_owner_or_hardlink')
        rows[path.relative_to(root).as_posix()]=(info.st_dev,info.st_ino,info.st_mode,
                                               info.st_size,info.st_mtime_ns,info.st_ctime_ns)
        if stat.S_ISDIR(info.st_mode):
            require(len(rows)<4096,'tree_entry_limit')
            for child in path.iterdir():visit(child)
    visit(root);return rows


def read_closed(path,limit):
    info=path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink==1 and info.st_uid==1001 and info.st_size<=limit)
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    with os.fdopen(fd,'rb') as stream:
        opened=os.fstat(stream.fileno())
        require((opened.st_dev,opened.st_ino,opened.st_size)==(info.st_dev,info.st_ino,info.st_size))
        value=stream.read(limit+1)
        require(len(value)<=limit and (os.fstat(stream.fileno()).st_size,os.fstat(stream.fileno()).st_mtime_ns)==(opened.st_size,opened.st_mtime_ns))
    require((path.lstat().st_dev,path.lstat().st_ino)==(opened.st_dev,opened.st_ino))
    return value


def remove_closed_tree(root,before):
    require(before==tree_snapshot(root),'tree_snapshot_changed')
    for relative in sorted(before,key=lambda name:name.count('/'),reverse=True):
        if relative=='.':continue
        path=root/relative;info=path.lstat()
        if stat.S_ISDIR(info.st_mode):
            # Removing this directory's owned children changes its size and clocks.
            require((info.st_dev,info.st_ino,info.st_mode)==before[relative][:3],'tree_directory_changed')
            path.rmdir()
        else:
            require((info.st_dev,info.st_ino,info.st_mode,info.st_size,info.st_mtime_ns,info.st_ctime_ns)==before[relative],
                    'tree_file_changed')
            path.unlink()
    root.rmdir()


def consume(socket,wire,deadline,cancel,work,record):
    """Use the already-running admitted host. Docker daemon never enters the app container."""
    require(os.getuid()==0 and not work.exists() and not work.is_symlink())
    nonce=secrets.token_hex(16);prefix='memlia-excel-app-'+nonce
    record.update(passed=False,businessPassed=False,readbackPassed=False,cleanupComplete=False,resourcesRetained=True,phase='preflight',
                  nonce=nonce,networkName=prefix,containers=[])
    work.mkdir(mode=0o700);identity=(work.stat().st_dev,work.stat().st_ino)
    tools=Path(os.environ['RUNNER_TEMP'])/'memlia-excel-application/tools'
    require(tools.is_dir() and not tools.is_symlink() and (tools/'bun-linux-x64/bun').is_file())
    scratch=work/'scratch';scratch.mkdir(mode=0o700);os.chown(scratch,1001,1001)
    for name in ('ui','application','tmp'):
        (scratch/name).mkdir(mode=0o700);os.chown(scratch/name,1001,1001)
    fixture=dict(userId=str(uuid.uuid4()),accountId=str(uuid.uuid4()),statsId=str(uuid.uuid4()),
                 email='excel-'+nonce+'@example.invalid',password=secrets.token_urlsafe(24),
                 origin='http://localhost:3000',socketBucketKeys=[])
    def write(path,data,uid=0):
        fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(fd,'wb') as stream:stream.write(data)
        if uid:os.chown(path,uid,uid)
    write(scratch/'ui/credentials.private.json',json.dumps(fixture).encode(),1001)
    write(scratch/'application-input.private.json',wire,1001)
    passwords={name:secrets.token_hex(32) for name in ('admin','migrate','web','realtime')}
    def url(role):return 'postgres://ui_'+role+'_'+nonce+':'+passwords[role]+'@database:5432/memlia_ui_'+nonce
    base=dict(PATH='/tools/bun-linux-x64:/usr/local/bin:/usr/bin:/bin',HOME='/scratch',TMPDIR='/scratch/tmp',
              NODE_ENV='production',RECIPE_NONCE=nonce,CI='true',NEXT_TELEMETRY_DISABLED='1',DO_NOT_TRACK='1')
    shared=dict(base,DATABASE_URL=url('web'),BETTER_AUTH_SECRET=secrets.token_hex(32),
                ENCRYPTION_KEY=secrets.token_hex(32),API_ENCRYPTION_KEY=secrets.token_hex(32),
                INTERNAL_API_SECRET=secrets.token_hex(32),BETTER_AUTH_URL='http://localhost:3000',
                NEXT_PUBLIC_APP_URL='http://localhost:3000',SOCKET_SERVER_URL='http://127.0.0.1:9',
                REDIS_URL='redis://valkey:6379/0',DISABLE_AUTH='false',DISABLE_REGISTRATION='true',
                DISABLE_EMAIL_SIGNUP='true',EMAIL_VERIFICATION_ENABLED='false',BILLING_ENABLED='false',
                NEXT_PUBLIC_BILLING_ENABLED='false',NEXT_PUBLIC_POSTHOG_ENABLED='false',STORAGE_PROVIDER='local',
                SIM_DB_ROLE='web',DB_APP_NAME='memlia-ci-excel',MEMLIA_EXCEL_HOST_SOCKET=str(socket),
                MEMLIA_EXCEL_OPERATOR_UID='0')
    configs={'database':{'POSTGRES_PASSWORD':passwords['admin']},'bootstrap':dict(base,
        RECIPE_ADMIN_URL='postgres://postgres:'+passwords['admin']+'@database:5432/postgres',
        **{'RECIPE_'+name.upper()+'_PASSWORD':passwords[name] for name in ('migrate','web','realtime')}),
        'grants':dict(base,RECIPE_ADMIN_URL='postgres://postgres:'+passwords['admin']+'@database:5432/memlia_ui_'+nonce),
        'migrate':dict(base,DATABASE_URL=url('migrate'),MIGRATION_DATABASE_URL=url('migrate')),
        'metadata':dict(base,MIGRATION_DATABASE_URL=url('migrate')),
        **{name:shared for name in ('baseline','seed','business','cleanup','readback')}}
    for name,env in configs.items():
        require(all('\n' not in v and '\x00' not in v for v in env.values()))
        write(work/(name+'.env'),''.join(k+'='+v+'\n' for k,v in env.items()).encode())
    owned=[];expected_images={};expected_mounts={};network=None;all_closed=True;complete=False
    def command(args,payload=b'',cleanup=False,limit=8*1024**2):
        end=min(time.monotonic()+120,deadline+(20 if cleanup else 0))
        return s._command([*DOCKER,*args],payload,end,None if cleanup else cancel,work,limit)
    def inspect(item,*,running=None):
        cid,user,memory,cpu,pids=item
        row=s._one(command(['container','inspect',cid],cleanup=True))
        inspect_owned(row,cid,nonce,user,memory,cpu,pids,running=running)
        host=row['HostConfig']
        require(row['Config']['Image']==expected_images[cid] and host['NetworkMode']==network
                and not host['PortBindings'] and host['PublishAllPorts'] is False
                and not host['Binds'] and not host['Devices'] and not host['DeviceRequests']
                and not host['VolumesFrom'] and not host['CapAdd']
                and host['PidMode']=='' and host['UTSMode']=='')
        inspect_mounts(row,expected_mounts[cid]);return row
    def create(name,image,user,memory,cpu,pids,extra,argv):
        args=['container','create','--name',prefix+'-'+name,'--platform','linux/amd64',
              '--label','org.memlia.excel.application='+nonce,'--user',user,'--read-only',
              '--cap-drop','ALL','--security-opt','no-new-privileges:true','--memory',str(memory),
              '--memory-swap',str(memory),'--cpus',str(cpu/1_000_000_000),'--pids-limit',str(pids),
              '--network',network,*extra,image,*argv]
        # Record the intended name before create; an unknown acknowledgement retains the namespace.
        record.setdefault('containerNames',[]).append(prefix+'-'+name)
        cid=command(args).decode('ascii').strip();require(s.ID.fullmatch(cid))
        expected_images[cid]=image
        mounts={}
        for index,value in enumerate(extra):
            if value!='--mount':continue
            parts=dict(field.split('=',1) for field in extra[index+1].split(',') if '=' in field)
            require(parts['type']=='bind')
            mounts[parts['dst']]=(parts['src'],'readonly' not in extra[index+1].split(','))
        expected_mounts[cid]=mounts
        item=(cid,user,memory,cpu,pids);owned.append(item)
        record['containers'].append(dict(id=cid,closed=False))
        inspect(item,running=False);return item
    def phase(name):
        record['phase']=name
        if name=='cleanup':record['cleanupExecution']=dict(boundary='create',exitCode=None)
        argv=['bun','--no-env-file','--tsconfig-override','/work/apps/sim/tsconfig.json',
              '/work/scripts/ci/linux-chat-fixture.ts',name]
        if name=='migrate':argv=['bun','--no-env-file','/work/packages/db/scripts/migrate.ts']
        if name=='business':argv=['bun','--no-env-file','--tsconfig-override','/work/apps/sim/tsconfig.json',
                                 '/work/scripts/ci/excel-file-workflow.ts']
        extra=['--env-file',str(work/(name+'.env')),'--workdir',
               '/work/packages/db' if name=='migrate' else '/scratch/application',
               '--mount','type=bind,src='+str(ROOT)+',dst=/work,readonly',
               '--mount','type=bind,src='+str(tools)+',dst=/tools,readonly',
               '--mount','type=bind,src='+str(scratch)+',dst=/scratch',
               '--mount','type=bind,src='+str(socket.parent)+',dst='+str(socket.parent)+',readonly',
               '--tmpfs','/tmp:rw,noexec,nosuid,nodev,size=128m']
        item=create(name,NODE,'1001:1001',4*1024**3,2_000_000_000,256,extra,argv)
        from qualification import build_command
        if name=='cleanup':record['cleanupExecution']['boundary']='execution'
        try:build_command(['container','start','--attach',item[0]],work,deadline,cancel)
        except Exception:
            if name=='cleanup':
                try:
                    record['cleanupFailure']=project_cleanup_failure(read_closed(scratch/'ui/cleanup-failure.private.json',1024))
                except Exception:pass
                try:
                    state=inspect(item,running=False)['State']['ExitCode']
                    if type(state)is int and 0<=state<=255:record['cleanupExecution']['exitCode']=state
                except Exception:pass
            if name=='business':
                try:
                    failure=json.loads(read_closed(scratch/'application-failure.private.json',1024))
                    require(set(failure)=={'status','code','stage'} and failure['status']=='failed'
                            and failure['code']=='excel_application_refused' and failure['stage'] in STAGES)
                    record['failureStage']=failure['stage']
                except Exception:pass
            raise
        if name=='cleanup':record['cleanupExecution']['boundary']='owned_inspection'
        row=inspect(item,running=False)
        if name=='cleanup':
            state=row['State']['ExitCode']
            record['cleanupExecution']=dict(boundary='exit_code',
                exitCode=state if type(state)is int and 0<=state<=255 else None)
        require(row['State']['ExitCode']==0)
        if name=='cleanup':record['cleanupExecution']['boundary']='owned_removal'
        command(['container','rm',item[0]],cleanup=True)
        if name=='cleanup':record['cleanupExecution']['boundary']='owned_absence'
        require(not command(['container','ls','--all','--no-trunc','--quiet','--filter','id='+item[0]],cleanup=True).strip())
        next(row for row in record['containers'] if row['id']==item[0])['closed']=True
        owned.remove(item);record.setdefault('phases',[]).append(name)
        if name=='cleanup':record.pop('cleanupExecution',None)
    try:
        from qualification import build_command
        for image in (NODE,POSTGRES,CACHE):
            build_command(['pull','--platform','linux/amd64',image],work,deadline,cancel)
        network=command(['network','create','--internal','--label','org.memlia.excel.application='+nonce,prefix]).decode().strip()
        require(s.ID.fullmatch(network))
        record['networkId']=network
        n=s._one(command(['network','inspect',network]));require(n['Id']==network and n['Internal'] is True and n['Labels']=={'org.memlia.excel.application':nonce})
        database=create('database',POSTGRES,'999:999',1024**3,1_000_000_000,128,
            ['--network-alias','database','--env-file',str(work/'database.env'),
             '--tmpfs','/var/lib/postgresql/data:rw,nosuid,nodev,size=1g,uid=999,gid=999',
             '--tmpfs','/var/run/postgresql:rw,nosuid,nodev,size=16m,uid=999,gid=999',
             '--tmpfs','/tmp:rw,nosuid,nodev,size=64m'],[])
        cache=create('cache',CACHE,'1000:1000',128*1024**2,500_000_000,64,
            ['--network-alias','valkey','--tmpfs','/data:rw,noexec,nosuid,nodev,size=64m'],
            ['valkey-server','--save','','--appendonly','no'])
        for item in (database,cache):command(['container','start',item[0]]);inspect(item,running=True)
        ready=False
        for _ in range(40):
            try:
                command(['container','exec',database[0],'pg_isready','-h','127.0.0.1','-U','postgres','-t','1'])
                ready=True;break
            except s.IsolationError:
                require(time.monotonic()<deadline and not cancel.wait(.5))
        require(ready)
        for name in ('bootstrap','migrate','grants','metadata','baseline','seed','business'):phase(name)
        record.update(verify_result(read_closed(scratch/'application-result.private.json',MAX_RESULT)))
        record['businessPassed']=True
        for name in ('cleanup','readback'):phase(name)
        record['readbackPassed']=True
        record['phase']='post_readback_inspection'
        for item in (database,cache):inspect(item,running=True)
        complete=True
    except Exception as error:
        remember_failure(work,record,error)
        raise
    finally:
        # No removal of another container, unknown create, a live writer or a foreign tree.
        for item in reversed(owned):
            try:
                record['phase']='container_cleanup'
                row=inspect(item)
                if row['State']['Running']:command(['container','stop','--time','5',item[0]],cleanup=True)
                inspect(item,running=False);command(['container','rm',item[0]],cleanup=True)
                require(not command(['container','ls','--all','--no-trunc','--quiet','--filter','id='+item[0]],cleanup=True).strip())
                next(row for row in record['containers'] if row['id']==item[0])['closed']=True
            except Exception as error:
                remember_failure(work,record,error)
                all_closed=False
        try:
            record['phase']='container_absence'
            remaining=command(['container','ls','--all','--no-trunc','--quiet','--filter','label=org.memlia.excel.application='+nonce],cleanup=True)
            require(not remaining.strip() and all_closed)
            if network:
                record['phase']='network_cleanup'
                n=s._one(command(['network','inspect',network],cleanup=True))
                require(n['Id']==network and n['Internal'] is True and n['Labels']=={'org.memlia.excel.application':nonce} and not n['Containers'])
                command(['network','rm',network],cleanup=True)
            record['phase']='tree_identity'
            require(complete and (work.stat().st_dev,work.stat().st_ino)==identity)
            # Containers are now closed; compare every entry before owned deletion.
            record['phase']='tree_snapshot'
            snapshot=tree_snapshot(work)
            record['phase']='tree_remove'
            remove_closed_tree(work,snapshot)
            record.update(cleanupComplete=True,resourcesRetained=False)
        except Exception as error:
            remember_failure(work,record,error)
            all_closed=False
    require(complete and all_closed and record['cleanupComplete'])
    record.update(passed=True,phase='complete')


def consume_durable(socket,wire,deadline,cancel,work,record,configuration):
    """Explicit synthetic Compose campaign, consuming product images and bootstrap ports.

    No execution row, session or queue message is manufactured here. An unknown
    admission/finalization retains the owned state for reconciliation.
    """
    import shutil
    import ssl
    import urllib.request
    from admission import _json
    require(os.getuid()==0 and not work.exists() and not work.is_symlink())
    raw_config=protected_durable_file(configuration)
    config=durable_configuration(_json(raw_config));nonce=config['nonce']
    project='memlia-excel-durable-'+nonce
    record.update(passed=False,businessPassed=False,drainPassed=False,cleanupComplete=False,
                  resourcesRetained=True,scope='native_durable_compose',phase='durable_preflight',
                  composeFixtureStarted=False,serviceInstalled=False,clientSessions=[])
    env_raw=protected_durable_file(config['envFile'])
    bootstrap_raw=protected_durable_file(config['bootstrapFile']);bootstrap=_json(bootstrap_raw)
    require(bootstrap.get('deploymentId')==nonce and bootstrap.get('database')=='memlia_ui_'+nonce
            and bootstrap.get('stateDirectory')=='/run/memlia-bootstrap/state')
    for role in ('migrate','web','realtime','worker','transport'):
        url=urlsplit(bootstrap.get('urls',{}).get(role,''))
        require(url.scheme in ('postgres','postgresql') and url.hostname=='database' and url.port==5432
                and url.path=='/memlia_ui_'+nonce and url.username=='ui_'+role+'_'+nonce
                and not url.query and not url.fragment)
    require(sha256((ROOT/'bun.lock').read_bytes()).hexdigest()==config['lockSha256'])
    def source_unchanged():
        argv=['/usr/bin/git','-c','safe.directory='+str(ROOT),'-C',str(ROOT)]
        require(subprocess.check_output([*argv,'rev-parse','HEAD'],timeout=5).decode().strip()==config['sourceCommit']
                and not subprocess.check_output([*argv,'status','--porcelain','--untracked-files=no'],timeout=5).strip())
        require(protected_durable_file(configuration)==raw_config
                and protected_durable_file(config['envFile'])==env_raw
                and protected_durable_file(config['bootstrapFile'])==bootstrap_raw)
    source_unchanged()
    browser=config['browser']
    for name,tool in browser.items():
        content=protected_durable_file(tool['path'],executable=name!='ca',limit=512*1024**2 if name!='ca' else 65536)
        require(sha256(content).hexdigest()==tool['sha256'])
    ca=protected_durable_file(browser['ca']['path'])
    ssl_context=ssl.create_default_context(cadata=ca.decode('ascii'))
    work.mkdir(mode=0o700);identity=(work.stat().st_dev,work.stat().st_ino)
    scratch=work/'scratch';scratch.mkdir(mode=0o700);os.chown(scratch,1001,1001)
    for name in ('ui','application','tmp'):
        (scratch/name).mkdir(mode=0o700);os.chown(scratch/name,1001,1001)
    profile=socket.parent/('browser-'+nonce)
    owned={};model=None;complete=False;closed=True;started=False;bootstrap_volume=project+'_bootstrap-state'
    def write(path,data,uid=0):
        with os.fdopen(os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600),'wb') as stream:stream.write(data)
        if uid:os.chown(path,uid,uid)
    write(scratch/'application-input.private.json',wire,1001)
    # The product bootstrap requires a protected immediate parent in-container.
    # Mount this one-file directory, rather than Docker's implicit 0755 parent.
    private_bootstrap=work/'bootstrap';private_bootstrap.mkdir(mode=0o700)
    write(private_bootstrap/'bootstrap.json',bootstrap_raw)
    (private_bootstrap/'bootstrap.json').chmod(0o400)
    override={'services':{
        'db':{'networks':{'backend':{'aliases':['database']}}},
        'redis':{'networks':{'backend':{'aliases':['valkey']}}},
        'workflow-worker':{'volumes':[{'type':'bind','source':str(socket.parent),'target':'/run/memlia-excel',
                                      'read_only':True,'bind':{'create_host_path':False}}]}}}
    for name in config['images']:
        override['services'].setdefault(name,{})['labels']={'org.memlia.excel.application':nonce}
    for kind,names in (('volumes',('uploads','postgres_data','redis_data')),('networks',('backend','egress'))):
        override[kind]={name:dict(labels={'org.memlia.excel.application':nonce}) for name in names}
    write(work/'compose.private.json',json.dumps(override).encode())
    spec=importlib.util.spec_from_file_location('excel_durable_owned_client',ROOT/'scripts/ci/workflow-worker-image.py')
    clients=importlib.util.module_from_spec(spec);spec.loader.exec_module(clients)
    compose=[*DOCKER,'compose','--project-name',project,'--project-directory',str(ROOT/'deploy/memlia'),
             '--env-file',config['envFile'],'-f',str(ROOT/'deploy/memlia/compose.yaml'),
             '-f',str(ROOT/'deploy/memlia/compose.excel.yaml'),'-f',str(work/'compose.private.json')]
    def disk():
        available=min(shutil.disk_usage(work).free,shutil.disk_usage('/var/lib/docker').free)
        record['minimumDiskBytes']=min(available,record.get('minimumDiskBytes',available))
        require(available>=12*1024**3,'durable_disk_refused')
    def raw(args,cleanup=False):
        return s._command([*DOCKER,*args],b'',min(time.monotonic()+30,deadline+(180 if cleanup else 0)),
                          None if cleanup else cancel,work,1024**2)
    def client(argv,*,cleanup=False,cwd=None,capture=False):
        observation={};record['clientSessions'].append(observation)
        if not cleanup:source_unchanged();disk();require(not cancel.is_set())
        # Existing process-session collector owns Compose plugins and Chromium descendants.
        return clients.owned_client(argv,cwd or work,min(time.monotonic()+(170 if cleanup else 150),
            deadline+(180 if cleanup else 0)),__import__('threading').Event() if cleanup else cancel,
            capture=capture,receipt=observation)
    def cmd(args,**kwargs):return client([*DOCKER,*args],**kwargs)
    def image(name):
        expected=config['images'][name]
        row=s._one(raw(['image','inspect',expected['reference']]))
        verify_durable_image(row,name,config)
        return expected['reference']
    def discover():
        ids=raw(['container','ls','-aq','--no-trunc','--filter','label=com.docker.compose.project='+project],cleanup=True).decode().split()
        require(len(ids)<=16 and len(ids)==len(set(ids)) and all(s.ID.fullmatch(cid) for cid in ids))
        for cid in ids:
            row=s._one(raw(['container','inspect',cid],cleanup=True));labels=row['Config'].get('Labels',{})
            service=labels.get('com.docker.compose.service')
            require(row['Id']==cid and labels.get('com.docker.compose.project')==project
                    and labels.get('org.memlia.excel.application')==nonce
                    and service in config['images']|{'fixture':None,'bootstrap':None})
            name='workflow-worker' if service=='fixture' else 'migrations' if service=='bootstrap' else service
            require(row['Image']==config['images'][name]['imageId'] and row['Config']['Image']==config['images'][name]['reference']
                    and row['HostConfig']['Privileged'] is False and row['State']['OOMKilled'] is False)
            if cid in owned:require(owned[cid]==(service,row['Name'],row['Image']))
            else:owned[cid]=(service,row['Name'],row['Image'])
            if service=='workflow-worker':
                require(row['Config']['User']=='1001:1001' and row['Config']['WorkingDir']=='/app/apps/sim'
                        and row['HostConfig']['ReadonlyRootfs'] is True and row['HostConfig']['Memory']==4*1024**3
                        and row['HostConfig']['MemorySwap']==4*1024**3 and row['HostConfig']['NanoCpus']==2_000_000_000
                        and row['HostConfig']['PidsLimit']==256 and row['HostConfig']['CapDrop']==['ALL']
                        and row['HostConfig']['SecurityOpt']==['no-new-privileges:true']
                        and row['Config']['Cmd']==['bun','--no-env-file','--tsconfig-override=tsconfig.json','scripts/memlia-workflow-worker.ts'])
                mounts=row['Mounts']
                volumes=[m for m in mounts if m['Type']=='volume'];binds=[m for m in mounts if m['Type']=='bind']
                require(len(volumes)==1 and volumes[0]['Name']==model['volumes']['uploads']['name']
                        and volumes[0]['Destination']=='/app/apps/sim/uploads' and volumes[0]['RW'] is True
                        and len(binds)==1 and binds[0]['Source']==str(socket.parent)
                        and binds[0]['Destination']=='/run/memlia-excel' and binds[0]['RW'] is False)
                require(all(m['Type'] in ('volume','bind','tmpfs') for m in mounts)
                        and all(m['Destination']=='/tmp' for m in mounts if m['Type']=='tmpfs')
                        and not row['HostConfig'].get('CapAdd') and not row['HostConfig'].get('Devices')
                        and not row['HostConfig'].get('DeviceRequests') and not row['HostConfig'].get('VolumesFrom')
                        and not row['HostConfig'].get('PidMode') and not row['HostConfig'].get('UTSMode'))
        return ids
    def up(*services,wait=False):
        nonlocal started
        if 'workflow-worker' in services:
            require(record.get('browserClosedBeforeWorker') is True
                    and record.get('bootstrapPhases')==['prepare','grants','verify']
                    and record.get('fixturePhases')==['metadata','baseline','seed','durable-prepare','durable-publish']
                    and all(item.get('waited') is True and item.get('groupClosed') is True
                            for item in record['clientSessions']))
        started=True;record['composeFixtureStarted']=True
        client([*compose,'up','--no-build','--pull','never','--no-deps','--detach',
                *(['--wait','--wait-timeout','90'] if wait else []),*services])
        discover()
    def oneoff(name,reference,user,envfile,mounts,argv,cwd):
        args=['container','create','--name',project+'-'+name+'-'+uuid.uuid4().hex,
              '--label','com.docker.compose.project='+project,'--label','com.docker.compose.service='+name,
              '--label','org.memlia.excel.application='+nonce,'--pull','never','--platform','linux/amd64',
              '--user',user,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true',
              '--memory',str(4*1024**3),'--memory-swap',str(4*1024**3),'--cpus','2','--pids-limit','256',
              '--network',model['networks']['backend']['name'],'--workdir',cwd,
              '--tmpfs','/tmp:rw,nosuid,nodev,size=268435456']
        if envfile:args+=['--env-file',str(envfile)]
        for mount in mounts:args+=['--mount',mount]
        args+=[reference,*argv]
        cid=cmd(args,capture=True).decode().strip();require(s.ID.fullmatch(cid));discover()
        before=s._one(raw(['container','inspect',cid]))
        inspect_owned(before,cid,nonce,user,4*1024**3,2_000_000_000,256,running=False)
        require(before['Config']['Cmd']==argv and before['Config']['WorkingDir']==cwd
                and before['HostConfig']['NetworkMode']==model['networks']['backend']['name']
                and not before['HostConfig'].get('Devices') and not before['HostConfig'].get('DeviceRequests')
                and not before['HostConfig'].get('CapAdd') and not before['HostConfig'].get('Binds')
                and not before['HostConfig'].get('VolumesFrom') and not before['HostConfig'].get('PortBindings'))
        answer=cmd(['container','start','--attach',cid],capture=True);row=s._one(raw(['container','inspect',cid]))
        inspect_owned(row,cid,nonce,user,4*1024**3,2_000_000_000,256,running=False)
        require(row['State']['Running'] is False and type(row['State']['ExitCode'])is int and row['State']['ExitCode']==0)
        cmd(['container','rm',cid]);require(not raw(['container','ls','-aq','--no-trunc','--filter','id='+cid]).strip())
        owned.pop(cid)
        return answer
    def bootstrap_phase(phase):
        record['phase']='durable_bootstrap_'+phase
        mounts=['type=bind,src='+str(private_bootstrap)+',dst=/run/memlia,readonly',
                'type=volume,src='+bootstrap_volume+',dst=/run/memlia-bootstrap']
        before=len(record['clientSessions'])
        answer=oneoff('bootstrap',image('migrations'),'0:0',None,mounts,
            ['bun','--no-env-file','/app/deploy/memlia/database-bootstrap.ts','--config','/run/memlia/bootstrap.json','--phase',phase],
            '/app/packages/db')
        verify_bootstrap_receipt(answer,phase,nonce)
        record.setdefault('bootstrapPhases',[]).append(phase)
        require(len(record['clientSessions'])>before)
    def fixture_phase(mode):
        record['phase']='durable_fixture_'+mode
        argv=['bun','--no-env-file','--tsconfig-override','/app/apps/sim/tsconfig.json',
              '/app/scripts/ci/linux-chat-fixture.ts',mode]
        if mode.startswith('durable-'):argv[-2:]=['/app/scripts/ci/excel-file-workflow.ts',mode]
        # Use source and installed dependencies from the exact worker image.
        # Only the two admitted recipe scripts are mounted, never host node_modules.
        mounts=['type=bind,src='+str(ROOT/'scripts/ci'/name)+',dst=/app/scripts/ci/'+name+',readonly'
                for name in ('linux-chat-fixture.ts','excel-file-workflow.ts')]+[
                'type=bind,src='+str(scratch)+',dst=/scratch',
                'type=volume,src='+model['volumes']['uploads']['name']+',dst=/app/apps/sim/uploads']
        oneoff('fixture',image('workflow-worker'),'1001:1001',work/('metadata.env' if mode in ('metadata','metadata-final') else 'fixture.env'),mounts,argv,'/app/apps/sim')
        record.setdefault('fixturePhases',[]).append(mode)
    try:
        disk()
        # Resolved Compose secrets stay in memory, as required by the product preflight.
        model=_json(s._command([*compose,'config','--format','json'],b'',min(deadline,time.monotonic()+30),cancel,work,1024**2))
        origin=validate_durable_model(model,config,socket)
        for name in config['images']:image(name)
        for kind in ('container','network','volume'):
            require(not raw([kind,'ls','-q',*(['--all','--no-trunc'] if kind=='container' else []),
                             '--filter','label=com.docker.compose.project='+project]).strip())
        for name,volume in model['volumes'].items():
            require(not raw(['volume','ls','-q','--filter','name=^'+volume['name']+'$']).strip())
        require(not raw(['volume','ls','-q','--filter','name=^'+bootstrap_volume+'$']).strip())
        fixture=dict(userId=str(uuid.uuid4()),accountId=str(uuid.uuid4()),statsId=str(uuid.uuid4()),
                     email='excel-'+nonce+'@example.invalid',password=secrets.token_urlsafe(24),
                     origin=origin,realtimeOrigin=origin,
                     socketBucketKeys=['route:socket-token-ip:ip:127.0.0.1','route:socket-token-ip:ip:::ffff:127.0.0.1'])
        write(scratch/'ui/credentials.private.json',json.dumps(fixture).encode(),1001)
        env=dict(model['services']['web']['environment'],RECIPE_NONCE=nonce,DISABLE_AUTH='false',
                 HOME='/scratch',TMPDIR='/scratch/tmp',SIM_DB_ROLE='web',MEMLIA_CI_FIXTURE_SOURCE_ROOT='/app')
        for key in ('MEMLIA_EXCEL_HOST_SOCKET','MEMLIA_EXCEL_HOST_OPERATOR_UID'):env.pop(key,None)
        require(env['DATABASE_URL']==bootstrap['urls']['web']
                and env['MEMLIA_PG_BOSS_DATABASE_URL']==bootstrap['urls']['transport']
                and model['services']['workflow-worker']['environment']['DATABASE_URL']==bootstrap['urls']['worker'])
        require(all(type(value)is str and '\n' not in value and '\x00' not in value for value in env.values()))
        write(work/'fixture.env',''.join(key+'='+value+'\n' for key,value in env.items()).encode())
        metadata=dict(RECIPE_NONCE=nonce,MEMLIA_CI_FIXTURE_SOURCE_ROOT='/app',
                      DATABASE_URL=bootstrap['urls']['migrate'],MIGRATION_DATABASE_URL=bootstrap['urls']['migrate'])
        write(work/'metadata.env',''.join(key+'='+value+'\n' for key,value in metadata.items()).encode())
        up('db','redis',wait=True)
        cmd(['volume','create','--label','com.docker.compose.project='+project,
             '--label','org.memlia.excel.application='+nonce,bootstrap_volume])
        bootstrap_phase('prepare')
        record['phase']='durable_migrations';up('migrations')
        migration=next(cid for cid,value in owned.items() if value[0]=='migrations')
        cmd(['container','wait',migration]);m=s._one(raw(['container','inspect',migration]))
        require(m['State']['Running'] is False and m['State']['ExitCode']==0)
        bootstrap_phase('grants');bootstrap_phase('verify')
        for mode in ('metadata','baseline','seed','durable-prepare'):fixture_phase(mode)
        prepared=_json(read_closed(scratch/'durable-browser.private.json',4096))
        up('web','realtime',wait=True)
        # The external reviewed fixture ingress must present this CA and origin.
        with urllib.request.urlopen(origin+'/login',context=ssl_context,timeout=min(10,max(.1,deadline-time.monotonic()))) as response:
            require(response.status==200)
        profile.mkdir(mode=0o700);os.chown(profile,1001,1001)
        for name in ('.pki','.pki/nssdb'):
            (profile/name).mkdir(mode=0o700);os.chown(profile/name,1001,1001)
        write(profile/'ca.pem',ca,1001)
        for name,source in (('credentials.json',scratch/'ui/credentials.private.json'),
                            ('prepared.json',scratch/'durable-browser.private.json')):
            write(profile/name,read_closed(source,4096),1001)
        run_as=['/usr/bin/setpriv','--reuid=1001','--regid=1001','--clear-groups','--']
        for args in (['-N','-d','sql:'+str(profile/'.pki/nssdb'),'--empty-password'],
                     ['-A','-d','sql:'+str(profile/'.pki/nssdb'),'-t','C,,','-n','memlia-qualification-ca','-i',str(profile/'ca.pem')]):
            client([*run_as,browser['certutil']['path'],*args],cwd=profile)
        record['phase']='durable_browser'
        client([*run_as,browser['node']['path'],str(ROOT/'scripts/ci/linux-chat-browser.mjs'),str(ROOT),
                str(profile/'credentials.json'),str(profile/'submission.json'),'--durable',str(profile/'prepared.json'),
                browser['chromium']['path']],cwd=profile)
        submission=verify_durable_submission(read_closed(profile/'submission.json',16384),prepared)
        require(all(item.get('waited') is True and item.get('groupClosed') is True for item in record['clientSessions']))
        record['browserClosedBeforeWorker']=True
        write(scratch/'durable-submission.private.json',json.dumps(submission).encode(),1001)
        fixture_phase('durable-publish')
        record['phase']='durable_worker_start';up('workflow-worker')
        worker=next(cid for cid,value in owned.items() if value[0]=='workflow-worker')
        require(s._one(raw(['container','inspect',worker]))['State']['Running'] is True)
        for path,expected in (('memory.max',str(4*1024**3)),('memory.swap.max','0'),
                              ('cpu.max','200000 100000'),('pids.max','256')):
            require(raw(['container','exec',worker,'cat','/sys/fs/cgroup/'+path]).decode().strip()==expected)
        fixture_phase('durable-readback')
        record.update(verify_durable_result(read_closed(scratch/'application-result.private.json',MAX_RESULT),submission))
        record['phase']='durable_worker_drain'
        client([*compose,'stop','--timeout','160','workflow-worker'],cleanup=True)
        row=s._one(raw(['container','inspect',worker],cleanup=True))
        require(row['State']['Running'] is False and row['State']['Pid']==0
                and row['State']['ExitCode']==0 and row['State']['OOMKilled'] is False)
        record['drainPassed']=True
        fixture_phase('durable-retire')
        require(_json(read_closed(scratch/'durable-retired.private.json',4096))=={'retired':True})
        # Stop web before account erasure so no owned producer can repopulate rows.
        client([*compose,'stop','--timeout','30','web','realtime'],cleanup=True)
        for mode in ('cleanup','readback','metadata-final'):fixture_phase(mode)
        source_unchanged();discover();complete=True
    except Exception as error:
        remember_failure(work,record,error)
        raise
    finally:
        # Never use compose down or a project-name purge after an unknown acknowledgement.
        try:
            if complete:
                require(all(item.get('waited') is True and item.get('groupClosed') is True
                            for item in record['clientSessions']))
            if started:
                ids=discover()
                for cid in reversed(ids):
                    row=s._one(raw(['container','inspect',cid],cleanup=True))
                    if row['State']['Running']:cmd(['container','stop','--time','160' if owned[cid][0]=='workflow-worker' else '10',cid],cleanup=True)
                    require(s._one(raw(['container','inspect',cid],cleanup=True))['State']['Running'] is False)
                    if complete:cmd(['container','rm',cid],cleanup=True)
                if complete:
                    require(not raw(['container','ls','-aq','--filter','label=com.docker.compose.project='+project],cleanup=True).strip())
                    for kind,entries in (('network',model['networks']),('volume',model['volumes']|{'bootstrap-state':{'name':bootstrap_volume}})):
                        for entry in entries.values():
                            name=entry['name'];rows=json.loads(raw([kind,'inspect',name],cleanup=True))
                            require(len(rows)==1 and rows[0]['Name']==name
                                    and rows[0].get('Labels',{}).get('com.docker.compose.project')==project
                                    and rows[0].get('Labels',{}).get('org.memlia.excel.application')==nonce)
                            if kind=='network':require(not rows[0]['Containers'])
                            else:require(rows[0]['Driver']=='local' and not rows[0].get('Options'))
                            cmd([kind,'rm',name],cleanup=True)
                            require(not raw([kind,'ls','-q','--filter','name=^'+name+'$'],cleanup=True).strip())
            require(complete and all(item.get('waited') is True and item.get('groupClosed') is True for item in record['clientSessions']))
            if profile.exists():remove_closed_tree(profile,tree_snapshot(profile))
            require((work.stat().st_dev,work.stat().st_ino)==identity)
            remove_closed_tree(work,tree_snapshot(work))
            record.update(cleanupComplete=True,resourcesRetained=False)
        except Exception as error:
            remember_failure(work,record,error);closed=False
    require(complete and closed and record['cleanupComplete'])
    record.update(passed=True,phase='complete')
