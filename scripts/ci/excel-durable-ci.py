# Copyright 2026 Memlia. All rights reserved.
"""Manual public-runner wiring for the existing Excel durable Compose recipe.

No external registry publication, provider, replacement queue or business oracle.
Build inputs must already be admitted. Labels never replace that admission.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import secrets
import shutil
import signal
import socket
import stat
import subprocess
import sys
import threading
import time
import traceback
import uuid
import zipfile

ROOT=Path(__file__).resolve().parents[2]
APPS=('web','realtime','migrations','cron','workflow-worker')
ORIGIN='https://localhost:18443'
REGISTRY='registry:3.0.0@sha256:6c5666b861f3505b116bb9aa9b25175e71210414bd010d92035ff64018f9457e'
TYPE_IMAGE='node:24.22.0-bookworm@sha256:14078204b6bb268c107ceff6d3c43f45a888105e5c2b18b14c32b3409d93a1b0'
PHASES={'preflight','tools','typegen','typecheck','contexts','registry','builder','images','tls','qualification','complete','web-check'}
IMAGE_OPERATIONS=('preflight','build','guard','push','inspect-tag','pull','inspect-digest','verify-digest')
IMAGE_STEPS={'image-'+name+'-'+operation for name in APPS for operation in IMAGE_OPERATIONS}
CLI_STEPS={'buildx-cli-version','buildx-cli-help'}
STEPS=PHASES|{'cron-assets'}|{'context-'+name for name in APPS}|IMAGE_STEPS|CLI_STEPS
DIAGNOSTIC_BYTES=8*1024**2  # Same bound as the existing owned_client capture.
ERROR_CODES={'none','source_refused','file_missing','command_failed','timeout','preparation_refused','unexpected_failure',
             'diagnostic_unknown','diagnostic_unavailable','diagnostic_truncated','command_interrupted','client_ownership_refused',
             'observed_cli_flag_refused','observed_no_space','observed_tls_refused','observed_connection_refused',
             'observed_lockfile_frozen','observed_js_heap_limit','observed_exit_137','observed_process_exit','cli_option_unavailable','cli_call_unavailable',
             # Kept for receipts already published (run 39656212157); no longer produced.
             'diagnostic_unknown_control',
             'diagnostic_unknown_utf8','diagnostic_unknown_bounds',
             'diagnostic_unknown_ambiguous','diagnostic_unknown_no_marker',
             'diagnostic_unknown_control_nul','diagnostic_unknown_control_sgr','diagnostic_unknown_control_escape',
             'diagnostic_unknown_control_escape_csi','diagnostic_unknown_control_sgr_after_prefix',
             'diagnostic_unknown_control_cr','diagnostic_unknown_control_backspace','diagnostic_unknown_control_del',
             'diagnostic_unknown_control_other','diagnostic_unknown_control_mixed'}

def error_code(error):
    # Exact allowlist only: exception text/path/argv never enter the public receipt.
    if isinstance(error,FileNotFoundError):return 'file_missing'
    if isinstance(error,(TimeoutError,subprocess.TimeoutExpired)):return 'timeout'
    if isinstance(error,subprocess.CalledProcessError):return 'command_failed'
    if isinstance(error,ValueError):
        if error.args==('source_refused',):return 'source_refused'
        if error.args==('recipe_build_failed',):return 'command_failed'
        if error.args==('buildx_option_unavailable',):return 'cli_option_unavailable'
        if error.args==('buildx_call_unavailable',):return 'cli_call_unavailable'
        if error.args==('buildx_cli_unknown',):return 'diagnostic_unknown'
        return 'preparation_refused'
    return 'unexpected_failure'


def valid_step(phase,step):
    return step in STEPS and (step==phase or phase=='contexts' and step in {'cron-assets',*('context-'+name for name in APPS)}
                             or phase=='images' and step in IMAGE_STEPS or phase=='tools' and step in CLI_STEPS)


def probe_buildx(execute,step,*,require_call=False):
    # Native capture is closed before interpretation, including nonzero exits.
    # A generic docker --help is not evidence of the buildx build command.
    step('buildx-cli-version');version=execute(['buildx','version'],capture=True,seconds=15)
    step('buildx-cli-help');help_text=execute(['buildx','build','--help'],capture=True,seconds=15)
    require(type(version) is bytes and 0<len(version)<=16384 and type(help_text) is bytes and 0<len(help_text)<=65536,'buildx_cli_unknown')
    try:
        version_text=version.decode('utf-8').removesuffix('\n').removesuffix('\r');text=help_text.decode('utf-8')
    except UnicodeError:raise ValueError('buildx_cli_unknown') from None
    require(re.fullmatch(r'github\.com/docker/buildx v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]{1,80})? [a-f0-9]{7,64}',version_text) is not None,'buildx_cli_unknown')
    require(not any(ord(c)<32 and c not in '\n\r\t' for c in text) and '\x7f' not in text,'buildx_cli_unknown')
    lines=[line.removesuffix('\r') for line in text.split('\n')]
    require(sum(re.fullmatch(r'Usage:[ \t]+docker buildx build \[OPTIONS\] PATH \| URL \| -',line) is not None for line in lines)==1,'buildx_cli_unknown')
    options=[line for line in lines if re.fullmatch(r'[ \t]{2,}--cgroup-parent(?:[ \t]+[^\r\n]*)?',line)]
    require(len(options)<=1,'buildx_cli_unknown')
    require(len(options)==1,'buildx_option_unavailable')
    result={'realUsage':True,'cgroupParentListed':True,'versionBytes':len(version),'helpBytes':len(help_text)}
    if require_call:
        calls=[line for line in lines if re.fullmatch(r'[ \t]{2,}--call(?:[ \t]+[^\r\n]*)?',line)]
        require(len(calls)<=1,'buildx_cli_unknown');require(len(calls)==1,'buildx_call_unavailable')
        result['callListed']=True
    return result


def refused_control_kind(line):
    """Classify only controls already refused; never normalize or return their payload.

    Describes the first refused line only. The caller refuses exactly the lines holding one of
    the single-character tokens below, so the final 'other' for an empty set is unreachable.
    """
    # Only complete SGRs at the edges of the body behind a BuildKit '#N t ' prefix: says whether a
    # separately reviewed edge normalization could clean this line, not that a marker would then be
    # recognized. Computed on a copy; recognition itself is unchanged. Inner SGRs stay 'sgr'.
    body=re.sub(r'^#[0-9]{1,5} (?:[0-9]{1,8}\.[0-9]{1,6} )?','',line)
    if body!=line:
        bare=re.sub(r'(?:\x1b\[[0-9;]{0,32}m)*$','',re.sub(r'^(?:\x1b\[[0-9;]{0,32}m)*','',body))
        if bare!=body and not any(ord(c)<32 and c!='\t' for c in bare) and '\x7f' not in bare:
            return 'diagnostic_unknown_control_sgr_after_prefix'
    kinds=set()
    for match in re.finditer(r'(?P<sgr>\x1b\[[0-9;]{0,32}m)|(?P<csi>\x1b\[[0-9;?]{0,32}[@-~])|[\x00-\x08\x0b-\x1f\x7f]',line):
        token=match[0]
        if match['sgr']:kind='sgr'
        elif match['csi']:kind='escape_csi'
        else:kind={'\0':'nul','\x1b':'escape','\r':'cr','\b':'backspace','\x7f':'del'}.get(token,'other')
        kinds.add(kind)
    return 'diagnostic_unknown_control_'+(next(iter(kinds)) if len(kinds)==1 else 'mixed' if kinds else 'other')


def classify_command_output(raw,*,buildx_client=False):
    """Closed observations from complete captured output, never a proven root cause.

    Build output is untrusted. No substring, argv, path, URL, credential, exit text
    or arbitrary field is returned. Conflicting observations stay unknown. Only a caller
    that declares a `docker buildx build` client may have its final line read after a refusal;
    any other command (bun, apt-get, curl, Python helpers) owns its last line itself.
    """
    if type(raw) is not bytes or not raw:return 'diagnostic_unknown_bounds'
    if len(raw)>DIAGNOSTIC_BYTES:return 'diagnostic_truncated'
    if raw.count(b'\n')>65536:return 'diagnostic_unknown_bounds'
    if b'\0' in raw:return 'diagnostic_unknown_control_nul'
    try:text=raw.decode('utf-8')
    except UnicodeError:return 'diagnostic_unknown_utf8'
    observed=set();process_exit=None;lines=text.split('\n')
    for index,line in enumerate(lines):
        line=line.removesuffix('\r')
        if len(line)>8192:return 'diagnostic_unknown_bounds'
        # SGR only at complete line boundaries. Interior splices, cursor controls,
        # binary output or an unrecognized multiplexed prefix are not normalized.
        line=re.sub(r'^(?:\x1b\[[0-9;]{0,32}m)*','',line)
        line=re.sub(r'(?:\x1b\[[0-9;]{0,32}m)*$','',line)
        if any(ord(c)<32 and c!='\t' for c in line) or '\x7f' in line:
            return buildx_client and final_client_marker(lines[index+1:]) or refused_control_kind(line)
        line=re.sub(r'^#[0-9]{1,5} (?:[0-9]{1,8}\.[0-9]{1,6} )?','',line)
        found,value=line_markers(line);observed|=found
        if value:
            if process_exit is not None and process_exit!=value:return 'diagnostic_unknown_ambiguous'
            process_exit=value
    if len(observed)>1:return 'diagnostic_unknown_ambiguous'
    return next(iter(observed)) if observed else process_exit or 'diagnostic_unknown_no_marker'


def line_markers(line):
    """Closed markers of one admitted line: (observations, process exit). Never returns text."""
    observed=set();process_exit=None
    if line in {'unknown flag: '+flag for flag in ('--cgroup-parent','--load','--builder','--provenance','--sbom','--progress')}:
        observed.add('observed_cli_flag_refused')
    if line=='error: lockfile had changes, but lockfile is frozen':observed.add('observed_lockfile_frozen')
    if line in ('FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
                'FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory'):
        observed.add('observed_js_heap_limit')
    if line.startswith(('ERROR: ','Error response from daemon: ')):
        if line.endswith(': no space left on device'):observed.add('observed_no_space')
        if line.endswith(': x509: certificate signed by unknown authority'):observed.add('observed_tls_refused')
        if line.endswith(': connect: connection refused'):observed.add('observed_connection_refused')
    match=re.fullmatch(r'ERROR: failed to build: failed to solve: process .{1,4096} did not complete successfully: exit code: ([1-9][0-9]{0,2})',line)
    if match and int(match[1])<=255:process_exit='observed_exit_137' if match[1]=='137' else 'observed_process_exit'
    return observed,process_exit


def final_client_marker(rest):
    """After a refused line, read only the client's own final line; None keeps the control class.

    With --progress=plain BuildKit streams child output behind '#N ' and quotes it in its
    '------' summary behind a timestamp, but a partial child line resumed later is quoted there
    bare (progressui printer.go keeps l[logsOffset:]). Only the last non-empty line is the
    client's ('ERROR: %v', buildx cmd/buildx/main.go). So: no prefix stripping and no SGR
    normalization here; the final line must itself be a known marker, and any other distinct
    marker on a clean line after the refusal makes the result ambiguous. Lines seen before the
    refusal are not used. An oversize line keeps today's control answer.

    The 'ERROR: is last' invariant is that of buildx v0.29.1 vendoring buildkit v0.25.0, with
    the Docker Desktop build backend inactive (HOME and DOCKER_CONFIG are private). A future
    version printing a line after 'ERROR:' degrades silently to the control class, never to a
    false observation.
    """
    seen=set();final=set()
    for line in rest:
        line=line.removesuffix('\r')
        if len(line)>8192:return None
        if not line:continue
        final=set()
        if any(ord(c)<32 and c!='\t' for c in line) or '\x7f' in line:continue
        found,value=line_markers(line);final=found|({value} if value else set());seen|=final
    if len(final)!=1:return None
    return next(iter(final)) if seen==final else 'diagnostic_unknown_ambiguous'


def command_failure(error,work,receipt,*,buildx_client=False):
    # ownership/capture state is supplied only by the existing native port, never
    # from the command's output. Do not parse a file while a producer is uncertain.
    if isinstance(error,ValueError) and error.args==('client_ownership_refused',):return 'client_ownership_refused'
    if not (type(receipt.get('pid')) is int and receipt['pid']>0 and receipt.get('waited') is True and receipt.get('groupClosed') is True):return 'diagnostic_unavailable'
    if isinstance(error,ValueError):
        if error.args==('recipe_build_log_limit',):return 'diagnostic_truncated'
        if error.args==('recipe_build_interrupted',):return 'command_interrupted'
        if error.args!=('recipe_build_failed',):return error_code(error)
    elif not isinstance(error,subprocess.CalledProcessError):return error_code(error)
    fd=None
    try:
        parent=work.lstat()
        require(stat.S_ISDIR(parent.st_mode) and parent.st_uid==os.geteuid() and stat.S_IMODE(parent.st_mode)==0o700)
        fd=os.open(work/'build.private.log',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
        before=os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_uid==os.geteuid() and before.st_nlink==1 and stat.S_IMODE(before.st_mode)==0o600)
        if before.st_size>DIAGNOSTIC_BYTES:return 'diagnostic_truncated'
        chunks=[];size=0
        while size<=DIAGNOSTIC_BYTES:
            chunk=os.read(fd,min(65536,DIAGNOSTIC_BYTES+1-size))
            if not chunk:break
            size+=len(chunk);chunks.append(chunk)
        after=os.fstat(fd)
        fields=('st_dev','st_ino','st_uid','st_mode','st_nlink','st_size','st_mtime_ns','st_ctime_ns')
        require(size==before.st_size and all(getattr(before,k)==getattr(after,k) for k in fields))
        current=(work/'build.private.log').lstat()
        require(current.st_dev==before.st_dev and current.st_ino==before.st_ino)
        return classify_command_output(b''.join(chunks),buildx_client=buildx_client)
    except (OSError,ValueError):return 'diagnostic_unavailable'
    finally:
        if fd is not None:os.close(fd)


def owned_command(native,argv,work,deadline,cancel,*,capture=False,receipt,buildx_client=False):
    try:return native.owned_client(argv,work,deadline,cancel,capture=capture,receipt=receipt)
    except Exception as error:
        receipt['failureCode']=command_failure(error,work,receipt,buildx_client=buildx_client)
        raise


def require(ok,code='ci_preparation_refused'):
    if not ok:raise ValueError(code)


def load(path,name):
    spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m


def write_private(path,data):
    if not isinstance(data,bytes):data=(json.dumps(data,sort_keys=True)+'\n').encode()
    with os.fdopen(os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600),'wb') as f:f.write(data)


def prefix(nonce):
    require(type(nonce)is str and re.fullmatch('[a-f0-9]{32}',nonce))
    return '127.0.0.1:15000/c'+nonce


def build_arguments(builder,context,name,source,lock,nonce):
    require(name in APPS and re.fullmatch('[a-f0-9]{40}',source) and re.fullmatch('[a-f0-9]{64}',lock))
    return ['buildx','build','--builder='+builder,'--platform=linux/amd64','--cgroup-parent=/',
            '--load','--provenance=false','--sbom=false','--progress=plain',
            '--build-arg','TARGETARCH=amd64','--build-arg','MEMLIA_SOURCE_COMMIT='+source,
            '--build-arg','MEMLIA_LOCK_SHA256='+lock,'--label','org.memlia.durable-ci='+nonce,
            *(['--build-arg','NEXT_PUBLIC_APP_URL='+ORIGIN] if name=='web' else []),
            '--tag',prefix(nonce)+'/'+name+':candidate','--file',str(context/'Dockerfile'),str(context)]



def web_check_arguments(builder,context,source,lock,nonce):
    # Same admitted Dockerfile/context/build arguments; no output and no RUN.
    args=build_arguments(builder,context,'web',source,lock,nonce)
    args.remove('--load');tag=args.index('--tag');del args[tag:tag+2]
    args.insert(2,'--call=check')
    return args


def check_web_context(prepare,root,private,expected,lock,nonce,builder,*,docker,start_builder,source,disk,record):
    source();disk();record['phase']='contexts';record['step']='context-web'
    prepare.prepare('app',root,root/'deploy/memlia/images',private/'web',source_commit=expected,architecture='amd64')
    source();guard=start_builder()
    record['phase']='web-check';record['step']='web-check'
    docker(web_check_arguments(builder,private/'web',expected,lock,nonce),seconds=180,buildx_client=True)
    guard();source()
    record.update(status='passed',durableQualified=False)


def build_image(name,builder,context,source,lock,nonce,*,docker,one,guard,step):
    require(name in APPS)
    def advance(operation):step('image-'+name+'-'+operation)
    advance('build');docker(build_arguments(builder,context,name,source,lock,nonce),seconds=5400 if name=='web' else 1200,buildx_client=True)
    advance('guard');guard()
    tag=prefix(nonce)+'/'+name+':candidate'
    advance('push');docker(['push',tag],seconds=300)
    advance('inspect-tag');item=image_record(one(['image','inspect',tag]),name,source,lock,nonce)
    advance('pull');docker(['pull','--platform','linux/amd64',item['reference']],seconds=120)
    advance('inspect-digest');row=one(['image','inspect',item['reference']])
    advance('verify-digest');require(image_record(row,name,source,lock,nonce)==item)
    return item


def image_record(row,name,source,lock,nonce):
    require(name in APPS and re.fullmatch('sha256:[a-f0-9]{64}',row['Id'])
            and row['Os']=='linux' and row['Architecture']=='amd64')
    labels=row['Config'].get('Labels') or {}
    require(labels.get('org.memlia.source')==source and labels.get('org.memlia.lock')==lock
            and labels.get('org.memlia.durable-ci')==nonce)
    refs=[r for r in row.get('RepoDigests',[]) if re.fullmatch(re.escape(prefix(nonce)+'/'+name)+'@sha256:[a-f0-9]{64}',r)]
    require(len(refs)==1)
    return {'reference':refs[0],'imageId':row['Id'],'sourceCommit':source,'lockSha256':lock}


def registry_owned(row,cid,name,image,nonce,data):
    require(row['Id']==cid and row['Name']=='/'+name and row['Image']==image
            and row['Config']['Labels'].get('org.memlia.durable-ci')==nonce
            and row['HostConfig']['PortBindings']=={'5000/tcp':[{'HostIp':'127.0.0.1','HostPort':'15000'}]})
    mounts=row['Mounts']
    require(len(mounts)==1 and mounts[0]['Type']=='bind' and mounts[0]['Source']==str(data)
            and mounts[0]['Destination']=='/var/lib/registry' and mounts[0]['RW'] is True)


def configuration_values(private,nonce,images):
    passwords={n:secrets.token_hex(32) for n in ('admin','migrate','web','realtime','worker','transport')}
    urls={n:f'postgres://ui_{n}_{nonce}:{passwords[n]}@database:5432/memlia_ui_{nonce}' for n in passwords if n!='admin'}
    bootstrap={'version':'memlia.database-bootstrap/v1','deploymentId':nonce,'database':'memlia_ui_'+nonce,
               'stateDirectory':'/run/memlia-bootstrap/state','adminUrl':'postgres://postgres:'+passwords['admin']+'@database:5432/postgres','urls':urls}
    env={'MEMLIA_IMAGE_PREFIX':prefix(nonce),'NEXT_PUBLIC_APP_URL':ORIGIN,'TRUSTED_ORIGINS':ORIGIN,
         'AUTH_TRUSTED_PROXIES':'','POSTGRES_PASSWORD':passwords['admin'],'DATABASE_URL':urls['web'],
         'DATABASE_URL_REALTIME':urls['realtime'],'DATABASE_URL_WORKFLOW_WORKER':urls['worker'],
         'MIGRATION_DATABASE_URL':urls['migrate'],'MEMLIA_PG_BOSS_DATABASE_URL':urls['transport'],
         'MEMLIA_CHAT_POLICY_SOURCE':str(private/'chat-policy.json'),
         **{n:secrets.token_hex(32) for n in ('BETTER_AUTH_SECRET','ENCRYPTION_KEY','INTERNAL_API_SECRET','CRON_SECRET')}}
    for name in APPS:env['MEMLIA_'+name.upper().replace('-','_')+'_SHA256']=images[name]['reference'].split('@sha256:')[1]
    return env,bootstrap


def project(record):
    require(type(record.get('images')) is dict and set(record['images'])<=set(APPS))
    require(record['phase'] in PHASES and record['status'] in ('passed','failed') and type(record['cleanup'])is bool)
    if record.get('mode')=='web-check':require(not record['images'] and not record.get('durableQualified',False) and record['phase']!='complete')
    if record['phase']=='web-check':require(not record['images'] and record.get('durableQualified') is False)
    if record['status']=='passed':
        require(record['cleanup'])
        if record['phase']!='web-check':require(record['phase']=='complete' and set(record['images'])==set(APPS) and record.get('durableQualified') is True)
    step=record.get('step',record['phase']);code=record.get('errorCode','none' if record['status']=='passed' else 'unexpected_failure')
    require(step in STEPS and code in ERROR_CODES)
    require(valid_step(record['phase'],step))
    require((code=='none') == (record['status']=='passed'))
    return {'status':record['status'],'phase':record['phase'],'step':step,'errorCode':code,'cleanup':record['cleanup'],
            'imagesBuilt':len(record['images']),'durableQualified':record.get('durableQualified') is True}


def check_types(execute):
    # Complete application graph, never the Dockerfile's ignoreBuildErrors path.
    execute('typegen',['node','../../node_modules/next/dist/bin/next','typegen'])
    execute('typecheck',['node','../../node_modules/typescript/bin/tsc','--noEmit',
                         '--incremental','false','--singleThreaded','--pretty','false'])


def run(expected,output,node,wheelhouse,*,mode='durable'):
    require(mode in ('durable','web-check'))
    if mode=='durable':require(node is not None and wheelhouse is not None)
    require(os.geteuid()==0 and platform.system()=='Linux' and platform.machine()=='x86_64')
    require(re.fullmatch('[a-f0-9]{40}',expected) and output.is_absolute() and not output.exists() and not output.is_symlink())
    # /var/lib is root-owned and never a writable RUNNER_TEMP ancestor.
    require(output.parent==Path('/var/lib') and output.name.startswith('memlia-excel-ci-'))
    os.umask(0o077);output.mkdir(mode=0o755);output.chmod(0o755);private=output/'private';private.mkdir(mode=0o700)
    tools=output/'tools';tools.mkdir(mode=0o755);tools.chmod(0o755)
    native=load(ROOT/'scripts/ci/workflow-worker-image.py','durable_ci_clients')
    swap=load(ROOT/'scripts/ci/linux-swap-host.py','durable_ci_swap')
    prepare=load(ROOT/'deploy/memlia/images/tests/prepare_context.py','durable_ci_context')
    if mode=='durable':
        sys.path.insert(0,str(ROOT/'runtimes/excel/linux'))
        app=load(ROOT/'runtimes/excel/linux/application_qualification.py','durable_ci_application')
    nonce=uuid.uuid4().hex;builder='memlia-excel-build-'+nonce;registry='memlia-excel-registry-'+nonce
    deadline=time.monotonic()+(600 if mode=='web-check' else 9000);cancel=threading.Event();proxy_cancel=threading.Event()
    previous={s:signal.signal(s,lambda *_:cancel.set()) for s in (signal.SIGINT,signal.SIGTERM)}
    record={'status':'failed','phase':'preflight','cleanup':False,'images':{},'sourceCommit':expected,'clientSessions':[],'mode':mode}
    registry_id=builder_id=None;registry_image=None;builder_unknown=registry_unknown=False
    proxy_thread=None;proxy_receipt={};proxy_errors=[];images={};count=0
    owned_swap=None;swap_closing=False;type_containers=[];type_pending=None
    monitor_stop=threading.Event();monitor_errors=[];monitor=None
    (private/'docker-config').mkdir(mode=0o700)
    def disk():
        free=min(shutil.disk_usage(output).free,shutil.disk_usage('/var/lib/docker').free)
        record['minimumDiskBytes']=min(record.get('minimumDiskBytes',free),free)
        require(free>=12*1024**3,'ci_disk_refused')
    def command(argv,*,seconds=120,capture=False,closing=False,buildx_client=False):
        nonlocal count
        count+=1;work=private/('command-%03d'%count);work.mkdir(mode=0o700);write_private(work/'build.private.log',b'')
        item={};record['clientSessions'].append(item)
        if not closing:disk();require(not cancel.is_set())
        try:
            return owned_command(native,argv,work,min(time.monotonic()+seconds,deadline+(240 if closing else 0)),
                threading.Event() if closing else cancel,capture=capture,receipt=item,buildx_client=buildx_client)
        except Exception:
            if not closing:record['errorCode']=item['failureCode']
            raise
    def docker(args,*,buildx_client=False,**kw):
        # Declared by the image/web-check build callers only; never inferred from output.
        require(not buildx_client or args[:2]==['buildx','build'])
        return command(['/usr/bin/env','DOCKER_CONFIG='+str(private/'docker-config'),*native.DOCKER,*args],buildx_client=buildx_client,**kw)
    def swap_command(args,data=None):
        require(data is None,'swap_input_refused')  # Disk-only; no zram tee path.
        return command([shutil.which(args[0]) or args[0],*args[1:]],seconds=30,capture=True,closing=swap_closing).decode().strip()
    swap.command=swap_command  # Preserve native swap ownership; use bounded private transport.
    def one(args,**kw):
        data=docker(args,capture=True,**kw);require(len(data)<=1024**2);rows=json.loads(data);require(type(rows)is list and len(rows)==1);return rows[0]
    def source():
        require(native.git(ROOT,'rev-parse','HEAD').decode().strip()==expected
                and not native.git(ROOT,'status','--porcelain','--untracked-files=no').strip())
        require(hashlib.sha256((ROOT/'bun.lock').read_bytes()).hexdigest()==lock)
    def start_builder():
        nonlocal builder_unknown,builder_id
        record['phase']='builder';record['step']='builder'
        require(not docker(['container','ls','-aq','--filter','name=^/buildx_buildkit_'+builder+'0$'],capture=True).strip()
                and not docker(['volume','ls','-q','--filter','name=^buildx_buildkit_'+builder+'0_state$'],capture=True).strip())
        write_private(private/'buildkit.toml',b'[worker.oci]\n  max-parallelism = 1\n')
        builder_unknown=True
        docker(['buildx','create','--name',builder,'--driver','docker-container','--platform','linux/amd64',
            '--buildkitd-config',str(private/'buildkit.toml'),'--buildkitd-flags=--oci-worker-gc=false',
            '--driver-opt','image='+native.BUILDKIT,'--driver-opt','memory=13g','--driver-opt','memory-swap=37g',
            '--driver-opt','cpu-quota=400000','--driver-opt','cpu-period=100000','--driver-opt','restart-policy=no',
            '--driver-opt','provenance-add-gha=false'])
        docker(['buildx','inspect',builder,'--bootstrap'],seconds=180)
        row=one(['container','inspect','buildx_buildkit_'+builder+'0']);builder_id=row['Id']
        native.verify_builder(row,builder_id,builder)
        builder_volume='buildx_buildkit_'+builder+'0_state'
        require(any(m.get('Type')=='volume' and m.get('Name')==builder_volume and m.get('Destination')=='/var/lib/buildkit' for m in row['Mounts']))
        builder_unknown=False
        docker(['container','update','--pids-limit=512',builder_id])
        row=one(['container','inspect',builder_id]);h=row['HostConfig']
        require(h['Memory']==13*1024**3 and h['MemorySwap']==37*1024**3 and h['CpuQuota']==400000
                and h['CpuPeriod']==100000 and h['PidsLimit']==512 and row['State']['Running'] and not row['State']['OOMKilled'])
        def kernel():
            native.verify_builder(one(['container','inspect',builder_id]),builder_id,builder)
            for path,value in (('memory.max',str(13*1024**3)),('memory.swap.max',str(24*1024**3)),('cpu.max','400000 100000'),('pids.max','512')):
                require(docker(['container','exec',builder_id,'cat','/sys/fs/cgroup/'+path],capture=True).decode().strip()==value)
        kernel()
        return kernel
    lock=hashlib.sha256((ROOT/'bun.lock').read_bytes()).hexdigest();record['lockSha256']=lock
    try:
        source();disk()
        record['swapPreflight']=swap.preflight(private,ROOT)
        swap_dir=private/('memlia-swap.'+nonce);swap_dir.mkdir(mode=0o700)
        owned_swap=swap.OwnedSwap(swap_dir);owned_swap.prepare(False)
        record['swapBefore']=owned_swap.sample()
        def observe_disk():
            try:
                while not monitor_stop.wait(1):
                    disk()
                    record['swapLast']=owned_swap.sample()
            except Exception:
                monitor_errors.append('disk_or_swap_observation_refused');cancel.set()
        monitor=threading.Thread(target=observe_disk);monitor.start()
        for port in (() if mode=='web-check' else (15000,18443,3000,3002)):
            with socket.socket() as probe:probe.bind(('127.0.0.1',port))
        info=json.loads(docker(['info','--format','{{json .}}'],capture=True))
        require(info['OSType']=='linux' and info['Architecture']=='x86_64' and info['CgroupVersion']=='2'
                and info['DockerRootDir']=='/var/lib/docker' and info['MemTotal']>=14*1024**3)
        # No existing UID authority is changed. setpriv and the host peer verify UID1001 natively.
        record['phase']='tools';record['step']='tools'
        record['buildxCli']=probe_buildx(docker,lambda value:record.update(step=value),require_call=mode=='web-check')
        if mode=='web-check':
            check_web_context(prepare,ROOT,private,expected,lock,nonce,builder,docker=docker,start_builder=start_builder,
                              source=source,disk=disk,record=record)
        else:
            record['step']='tools'
            shutil.copyfile(node.resolve(strict=True),tools/'node');(tools/'node').chmod(0o755)
            require(command([str(tools/'node'),'--version'],capture=True).strip()==b'v24.22.0')
            command(['/usr/bin/curl','--fail','--location','--silent','--show-error','--max-time','120',
                     'https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-linux-x64.zip','--output',str(private/'bun.zip')])
            require(hashlib.sha256((private/'bun.zip').read_bytes()).hexdigest()=='36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913')
            with zipfile.ZipFile(private/'bun.zip') as archive:write_private(tools/'bun',archive.read('bun-linux-x64/bun'))
            (tools/'bun').chmod(0o755)
            # Install from the same complete lock only; scripts/native app builds are not run on the host.
            require(not (ROOT/'node_modules').exists() and not (ROOT/'node_modules').is_symlink())
            command([str(tools/'bun'),'install','--cwd',str(ROOT),'--filter','@sim/app','--frozen-lockfile','--ignore-scripts','--linker','hoisted'],seconds=900)
            source()
            cli=command([str(tools/'node'),'--input-type=module','-e',
                "import {createRequire} from 'node:module'; const r=createRequire(process.argv[1]+'/apps/sim/package.json'); if(r('@playwright/test/package.json').version!=='1.61.1')throw Error('version'); process.stdout.write(r.resolve('@playwright/test/cli'));",str(ROOT)],capture=True).decode()
            require(Path(cli).is_absolute() and Path(cli).is_relative_to(ROOT))
            command(['/usr/bin/env','PLAYWRIGHT_BROWSERS_PATH='+str(tools/'browsers'),str(tools/'node'),cli,'install','--with-deps','chromium'],seconds=600)
            chromium=command(['/usr/bin/env','PLAYWRIGHT_BROWSERS_PATH='+str(tools/'browsers'),str(tools/'node'),'--input-type=module','-e',
                "import {createRequire} from 'node:module';process.stdout.write(createRequire(process.argv[1]+'/apps/sim/package.json')('@playwright/test').chromium.executablePath());",str(ROOT)],capture=True).decode()
            require(Path(chromium).is_relative_to(tools/'browsers'))
            # Never start a distribution service. A fresh, exact policy-rc.d is removed
            # after package installation; an existing administrator policy is not replaced.
            policy=Path('/usr/sbin/policy-rc.d');policy_bytes=b'#!/bin/sh\nexit 101\n'
            require(not policy.exists() and not policy.is_symlink())
            write_private(policy,policy_bytes);policy.chmod(0o755);policy_view=policy.stat()
            try:
                command(['/usr/bin/apt-get','update'],seconds=180)
                command(['/usr/bin/apt-get','install','--yes','--no-install-recommends','nginx-core','libnss3-tools'],seconds=300)
            finally:
                after=policy.lstat()
                require(stat.S_ISREG(after.st_mode) and after.st_ino==policy_view.st_ino and after.st_dev==policy_view.st_dev
                        and after.st_uid==0 and after.st_nlink==1 and policy.read_bytes()==policy_bytes)
                policy.unlink()
            # These newly installed non-secret tools/dependencies must be traversable by
            # the existing UID1001 browser. Skip links; never chmod their targets.
            for tree in (ROOT/'node_modules',ROOT/'apps/sim/node_modules',tools/'browsers'):
                for base,dirs,files in os.walk(tree,followlinks=False):
                    path=Path(base);path.chmod(0o755)
                    dirs[:]=[d for d in dirs if not (path/d).is_symlink()]
                    for leaf in files:
                        item=path/leaf
                        if not item.is_symlink():item.chmod(0o755 if item.stat().st_mode&0o111 else 0o644)
            command(['/usr/bin/dpkg-query','--show','nginx-core','libnss3-tools'],capture=True)
            docker(['pull','--platform','linux/amd64',TYPE_IMAGE],seconds=180)
            type_image_id=one(['image','inspect',TYPE_IMAGE])['Id']
            def type_phase(phase,argv):
                nonlocal type_pending
                record['phase']=phase;record['step']=phase;name='memlia-excel-'+phase+'-'+nonce
                work=private/phase;work.mkdir(mode=0o700)
                require(not docker(['container','ls','-aq','--filter','name=^/'+name+'$'],capture=True).strip())
                type_pending=name
                # Native metrics owns the finite cgroup. Raw diagnostics remain in the
                # private mount BEFORE either metrics or this parent interprets exit.
                cid=docker(['container','create','--name',name,'--label','org.memlia.durable-ci='+nonce,
                    '--platform','linux/amd64','--pull','never','--network','none','--read-only',
                    '--cap-drop','ALL','--security-opt','no-new-privileges:true','--user','0:0',
                    '--memory','13g','--memory-swap','37g','--cpus','4','--pids-limit','512',
                    '--mount','type=bind,src='+str(ROOT)+',dst=/work',
                    '--mount','type=bind,src='+str(work)+',dst=/metrics','--tmpfs','/tmp:rw,nosuid,nodev,size=256m',
                    '--env','DOCKER_BUILD=1','--env','NEXT_TELEMETRY_DISABLED=1','--env','HOME=/metrics',
                    '--env','NODE_OPTIONS=--max-old-space-size=10240','--env','GOMAXPROCS=4',
                    '--workdir','/work/apps/sim',TYPE_IMAGE,'python3','/work/scripts/ci/linux-build-metrics.py',
                    '--phase',phase,'--timeout','1800','--report','/metrics/result.json','--',
                    'bash','-c','umask 077; ulimit -f 8192; exec "$@" > /metrics/diagnostic.private.log 2>&1','type-phase',*argv],capture=True).decode().strip()
                require(re.fullmatch('[a-f0-9]{64}',cid));type_containers.append((cid,name,type_image_id));type_pending=None
                row=one(['container','inspect',cid]);h=row['HostConfig']
                require(h['Memory']==13*1024**3 and h['MemorySwap']==37*1024**3 and h['NanoCpus']==4000000000 and h['PidsLimit']==512)
                docker(['container','start','--attach',cid],seconds=1830)
                row=one(['container','inspect',cid]);result=json.loads((work/'result.json').read_bytes())
                require(not row['State']['Running'] and not row['State']['OOMKilled'] and row['State']['ExitCode']==0
                        and result['status']=='passed' and result['normalCompletion'] is True)
                record[phase]=result;source()
            record['phase']='contexts';record['step']='cron-assets'
            command([sys.executable,'-B',str(ROOT/'deploy/memlia/images/tests/fetch_cron_assets.py'),str(private/'assets'),'--architecture','amd64'],seconds=300)
            for name in APPS:
                record['step']='context-'+name
                prepare.prepare('app' if name=='web' else name,ROOT,ROOT/'deploy/memlia/images',private/name,
                                private/'assets' if name=='cron' else None,source_commit=expected,architecture='amd64')
            # Capture admitted source before Next generates ignored next-env.d.ts.
            # Complete type checks still precede every registry/image build operation.
            check_types(type_phase)
            record['phase']='registry';record['step']='registry';(private/'registry').mkdir(mode=0o700)
            require(not docker(['container','ls','-aq','--filter','name=^/'+registry+'$'],capture=True).strip())
            docker(['pull','--platform','linux/amd64',REGISTRY],seconds=180)
            registry_image=one(['image','inspect',REGISTRY])['Id']
            registry_unknown=True
            registry_id=docker(['container','create','--name',registry,'--label','org.memlia.durable-ci='+nonce,
                '--pull','never','--platform','linux/amd64','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true',
                '--memory','512m','--memory-swap','512m','--cpus','1','--pids-limit','128',
                '--publish','127.0.0.1:15000:5000','--env','OTEL_TRACES_EXPORTER=none',
                '--mount','type=bind,src='+str(private/'registry')+',dst=/var/lib/registry',REGISTRY],capture=True).decode().strip()
            require(re.fullmatch('[a-f0-9]{64}',registry_id));registry_unknown=False
            registry_owned(one(['container','inspect',registry_id]),registry_id,registry,registry_image,nonce,private/'registry')
            docker(['container','start',registry_id])
            # Loopback only, not a registry login/publication; no daemon insecure-registry setting is changed.
            kernel=start_builder()
            for name in APPS:
                record['phase']='images';record['step']='image-'+name+'-preflight';source();disk()
                item=build_image(name,builder,private/name,expected,lock,nonce,docker=docker,one=one,guard=kernel,
                                 step=lambda value:record.update(step=value))
                images[name]=item;record['images'][name]=item
            # The builder is stopped before runtime services compete for memory.
            docker(['container','stop','--time','10',builder_id])
            for name,ref in (('db',app.POSTGRES),('redis',app.CACHE)):
                docker(['pull','--platform','linux/amd64',ref],seconds=180)
                row=one(['image','inspect',ref]);images[name]={'reference':ref,'imageId':row['Id']}
            record['phase']='tls';record['step']='tls'
            command(['/usr/bin/openssl','req','-x509','-newkey','rsa:3072','-nodes','-days','1','-subj','/CN=Memlia CI synthetic localhost',
                     '-addext','subjectAltName=DNS:localhost','-addext','basicConstraints=critical,CA:TRUE',
                     '-keyout',str(private/'localhost.key'),'-out',str(private/'localhost.pem')])
            (private/'localhost.key').chmod(0o400);(private/'localhost.pem').chmod(0o400)
            # Reuse the deployment's nginx routing/headers; scoped to this loopback listener and new certificate.
            config=f'''pid {private}/nginx.pid;
error_log stderr warn;
worker_processes 1;
events {{ worker_connections 128; }}
http {{ access_log off; client_max_body_size 16m; client_body_buffer_size 16m; map $http_upgrade $memlia_connection {{ default upgrade; '' close; }}
server {{ listen 127.0.0.1:18443 ssl; server_name localhost;
ssl_certificate {private}/localhost.pem; ssl_certificate_key {private}/localhost.key;
location = /__memlia_ci_ready {{ return 200 "ready"; }}
location /socket.io/ {{ proxy_pass http://127.0.0.1:3002; proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection $memlia_connection;
proxy_set_header Host $http_host; proxy_set_header X-Forwarded-Proto https; proxy_set_header X-Forwarded-For $remote_addr; proxy_read_timeout 950s; }}
location / {{ proxy_pass http://127.0.0.1:3000; proxy_set_header Host $http_host;
proxy_set_header X-Forwarded-Proto https; proxy_set_header X-Forwarded-For $remote_addr; proxy_buffering off; proxy_read_timeout 950s; }}
}} }}\n'''
            write_private(private/'nginx.conf',config.encode());proxywork=private/'proxy';proxywork.mkdir(mode=0o700);write_private(proxywork/'build.private.log',b'')
            def proxy():
                try:native.owned_client(['/usr/sbin/nginx','-p',str(private)+'/', '-c',str(private/'nginx.conf'),'-g','daemon off;'],proxywork,deadline,proxy_cancel,receipt=proxy_receipt)
                except Exception as e:
                    if not (proxy_cancel.is_set() and str(e)=='recipe_build_interrupted'):proxy_errors.append(type(e).__name__)
            proxy_thread=threading.Thread(target=proxy);proxy_thread.start()
            import ssl,urllib.request
            ssl_context=ssl.create_default_context(cafile=str(private/'localhost.pem'));ready=False
            for _ in range(40):
                require(not cancel.is_set() and proxy_thread.is_alive())
                try:
                    with urllib.request.urlopen(ORIGIN+'/__memlia_ci_ready',context=ssl_context,timeout=1) as response:ready=response.status==200 and response.read(6)==b'ready'
                except OSError:pass
                if ready:break
                time.sleep(.25)
            require(ready)
            env,bootstrap=configuration_values(private,nonce,images)
            write_private(private/'compose.env',''.join(k+'='+v+'\n' for k,v in env.items()).encode())
            write_private(private/'bootstrap.json',bootstrap);(private/'bootstrap.json').chmod(0o400)
            write_private(private/'chat-policy.json',{'enabled':False});(private/'chat-policy.json').chmod(0o400)
            browser={name:{'path':str(path),'sha256':hashlib.sha256(path.read_bytes()).hexdigest()} for name,path in
                     (('node',tools/'node'),('chromium',Path(chromium)),('certutil',Path('/usr/bin/certutil')),('ca',private/'localhost.pem'))}
            qualification={'schemaVersion':'memlia.excel-durable-qualification/v1','sourceCommit':expected,'lockSha256':lock,'nonce':nonce,
                           'envFile':str(private/'compose.env'),'bootstrapFile':str(private/'bootstrap.json'),'images':images,'browser':browser}
            app.durable_configuration(qualification)
            for name in images:app.verify_durable_image(one(['image','inspect',images[name]['reference']]),name,qualification)
            write_private(private/'qualification.json',qualification)
            record['phase']='qualification';record['step']='qualification';source()
            command([sys.executable,'-B',str(ROOT/'runtimes/excel/linux/qualification.py'),'--wheelhouse',str(wheelhouse),
                     '--output',str(private/'qualification'),'--exercise-host','--exercise-application',
                     '--durable-compose-config',str(private/'qualification.json')],seconds=2100)
            result=json.loads((private/'qualification/receipt.json').read_bytes())
            require(result['status']=='passed' and result['linuxRecipeCompleted'] is True and result['cleanupComplete'] is True)
            durable=result['hostConsumer']['durableApplication']
            require(durable['passed'] is True and durable['businessPassed'] is True and durable['drainPassed'] is True
                    and durable['browserClosedBeforeWorker'] is True and durable['cleanupComplete'] is True)
            record['durableQualified']=True;record['phase']='complete';record['step']='complete';record['status']='passed'
    except Exception as error:
        write_private(private/'failure.private.log',traceback.format_exc(limit=12).encode()[:32768])
        record['errorCode']=record.get('errorCode',error_code(error))
    finally:
        # Only packaging/proxy resources are retired here. The native recipe owns its
        # DB/volumes; unknown application state remains retained, never compose down.
        try:
            proxy_cancel.set()
            if proxy_thread:
                proxy_thread.join(10);require(not proxy_thread.is_alive() and not proxy_errors
                    and proxy_receipt.get('waited') is True and proxy_receipt.get('groupClosed') is True)
            require(not builder_unknown and not registry_unknown and type_pending is None)
            for cid,name,image_id in type_containers:
                row=one(['container','inspect',cid],closing=True)
                require(row['Id']==cid and row['Name']=='/'+name and row['Image']==image_id
                        and row['Config']['Labels'].get('org.memlia.durable-ci')==nonce)
                if row['State']['Running']:docker(['container','stop','--time','10',cid],closing=True)
                docker(['container','rm',cid],closing=True)
                require(not docker(['container','ls','-aq','--filter','id='+cid],capture=True,closing=True).strip())
            if builder_id:
                row=one(['container','inspect',builder_id],closing=True);native.verify_builder(row,builder_id,builder)
                if row['State']['Running']:docker(['container','stop','--time','10',builder_id],closing=True)
                docker(['container','rm',builder_id],closing=True)
                volume='buildx_buildkit_'+builder+'0_state'
                # Exact absent-before-create volume and its builder mount were captured above.
                docker(['volume','rm',volume],closing=True)
                require(not docker(['container','ls','-aq','--filter','id='+builder_id],capture=True,closing=True).strip())
            if registry_id:
                row=one(['container','inspect',registry_id],closing=True)
                registry_owned(row,registry_id,registry,registry_image,nonce,private/'registry')
                if row['State']['Running']:docker(['container','stop','--time','10',registry_id],closing=True)
                docker(['container','rm',registry_id],closing=True)
                require(not docker(['container','ls','-aq','--filter','id='+registry_id],capture=True,closing=True).strip())
            require(all(r.get('waited') is True and r.get('groupClosed') is True for r in record['clientSessions']))
            record['cleanup']=True
        except Exception:
            write_private(private/'cleanup-failure.private.log',traceback.format_exc(limit=12).encode()[:32768])
        monitor_stop.set()
        if monitor:monitor.join(3)
        record['monitorErrors']=monitor_errors
        if monitor_errors or (monitor and monitor.is_alive()):record['cleanup']=False
        swap_closing=True
        record['swapCleanup']=owned_swap.cleanup() if owned_swap is not None else True
        if not record['swapCleanup']:record['cleanup']=False
        record['proxySession']=proxy_receipt
        if not record['cleanup']:record['status']='failed'
        write_private(private/'receipt.json',record)
        write_private(output/'summary.json',project(record))
        for s,handler in previous.items():signal.signal(s,handler)
    print(json.dumps(project(record),sort_keys=True))
    return 0 if record['status']=='passed' else 1


def arguments(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    mode=parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--check-web-context',dest='mode',action='store_const',const='web-check')
    mode.add_argument('--exercise-durable',dest='mode',action='store_const',const='durable')
    parser.add_argument('--expected-commit',required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--node',type=Path)
    parser.add_argument('--wheelhouse',type=Path)
    args=parser.parse_args(argv)
    if args.mode=='durable' and (args.node is None or args.wheelhouse is None):parser.error('durable tools required')
    return args


if __name__=='__main__':
    args=arguments()
    raise SystemExit(run(args.expected_commit,args.output,args.node,args.wheelhouse,mode=args.mode))
