# Copyright (c) 2026 Memlia. All rights reserved.
"""Manual synthetic native-API composition; never HTTP/Next or durable-job qualification."""
import base64
from hashlib import sha256
import json
import os
from pathlib import Path
import secrets
import stat
import time
import uuid

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


def require(value):
    if not value:raise ValueError('application_recipe_refused')


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
    import openpyxl
    from io import BytesIO
    require(0<len(raw)<=MAX_RESULT)
    value=json.loads(raw,object_pairs_hook=pairs,parse_constant=non_json)
    require(type(value)is dict and set(value)=={'status','scope','checks','file','download'})
    require(value['status']=='passed' and value['scope']=='native_api_in_process')
    require(type(value['checks'])is dict and set(value['checks'])==set(CHECKS)
            and all(v is True for v in value['checks'].values()))
    file,download=value['file'],value['download']
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
    return dict(scope=value['scope'],**value['checks'],outputSha256=file['sha256'],
                outputBytes=len(content),httpQualified=False,nextQualified=False,
                browserQualified=False,durableJobQualified=False,liveProviderTested=False)


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
        require(len(rows)<4096)
        info=path.lstat();require(not stat.S_ISLNK(info.st_mode))
        require(stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode))
        require(info.st_uid in (os.getuid(),1001) and (stat.S_ISDIR(info.st_mode) or info.st_nlink==1))
        rows[path.relative_to(root).as_posix()]=(info.st_dev,info.st_ino,info.st_mode,
                                               info.st_size,info.st_mtime_ns,info.st_ctime_ns)
        if stat.S_ISDIR(info.st_mode):
            require(len(rows)<4096)
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
    require(before==tree_snapshot(root))
    for relative in sorted(before,key=lambda name:name.count('/'),reverse=True):
        if relative=='.':continue
        path=root/relative;info=path.lstat()
        if stat.S_ISDIR(info.st_mode):
            # Removing this directory's owned children changes its size and clocks.
            require((info.st_dev,info.st_ino,info.st_mode)==before[relative][:3])
            path.rmdir()
        else:
            require((info.st_dev,info.st_ino,info.st_mode,info.st_size,info.st_mtime_ns,info.st_ctime_ns)==before[relative])
            path.unlink()
    root.rmdir()


def consume(socket,wire,deadline,cancel,work,record):
    """Use the already-running admitted host. Docker daemon never enters the app container."""
    require(os.getuid()==0 and not work.exists() and not work.is_symlink())
    nonce=secrets.token_hex(16);prefix='memlia-excel-app-'+nonce
    record.update(passed=False,cleanupComplete=False,resourcesRetained=True,phase='preflight',
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
        for name in ('cleanup','readback'):phase(name)
        for item in (database,cache):inspect(item,running=True)
        complete=True
    finally:
        # No removal of another container, unknown create, a live writer or a foreign tree.
        for item in reversed(owned):
            try:
                row=inspect(item)
                if row['State']['Running']:command(['container','stop','--time','5',item[0]],cleanup=True)
                inspect(item,running=False);command(['container','rm',item[0]],cleanup=True)
                require(not command(['container','ls','--all','--no-trunc','--quiet','--filter','id='+item[0]],cleanup=True).strip())
                next(row for row in record['containers'] if row['id']==item[0])['closed']=True
            except Exception:all_closed=False
        try:
            remaining=command(['container','ls','--all','--no-trunc','--quiet','--filter','label=org.memlia.excel.application='+nonce],cleanup=True)
            require(not remaining.strip() and all_closed)
            if network:
                n=s._one(command(['network','inspect',network],cleanup=True))
                require(n['Id']==network and n['Internal'] is True and n['Labels']=={'org.memlia.excel.application':nonce} and not n['Containers'])
                command(['network','rm',network],cleanup=True)
            require(complete and (work.stat().st_dev,work.stat().st_ino)==identity)
            # Containers are now closed; compare every entry before owned deletion.
            remove_closed_tree(work,tree_snapshot(work))
            record.update(cleanupComplete=True,resourcesRetained=False)
        except Exception:all_closed=False
    require(complete and all_closed and record['cleanupComplete'])
    record.update(passed=True,phase='complete')
