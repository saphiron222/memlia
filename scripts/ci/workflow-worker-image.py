# Copyright (c) 2026 Memlia. All rights reserved.
"""One explicit Linux AMD64 packaging recipe; no queue/DB/model/release authority.

Only a manually reviewed, admitted source commit may be dispatched. The expected
SHA is an identity check, not admission. BuildKit's privileged driver is limited
to a disposable trusted-source runner; this is not a hostile-build sandbox.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import selectors
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
PROVENANCE_HELPER = ROOT/'deploy/memlia/images/tests/prepare_context.py'
DOCKER = ['/usr/bin/docker', '--host', 'unix:///var/run/docker.sock']
BUILDKIT = 'moby/buildkit@sha256:ca9db05302dc3a4846e3401ecfbd27e349fcc614ab046a7d89a83b0a5c313cee'
BUILDKIT_CONFIG = 'sha256:4a177e10126688bb9608de9661b5c2204222e232d261339ff4c94eb785b211fa'
SAVE_SECONDS = 180  # local export of the BuildKit image, as in excel-durable-ci.py
RECIPE = 'deploy/memlia/images/workflow-worker.Dockerfile'
INPUTS = ('package.json','bun.lock','bunfig.toml','patches','packages','apps/sim',
          'compliance/upstream',RECIPE,RECIPE+'.dockerignore',
          'deploy/memlia/images/tests/bun-LICENSE.md')
MAX_LOG = 8*1024**2
MAX_MEMBER = 16*1024**2
MAX_CONTEXT = 512*1024**2
MIN_DISK = 12*1024**3
ID = re.compile(r'sha256:[a-f0-9]{64}\Z')
CID = re.compile(r'[a-f0-9]{64}\Z')


def require(ok, reason):
    if not ok: raise ValueError(reason)


def load(path, name):
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


# Pinned-image admission shared with runtimes/excel/linux/qualification.py (both stores).
IDENTITY = load(ROOT/'runtimes/excel/linux/image_identity.py','worker_image_identity')


def git(root,*args):
    return subprocess.check_output(['git','-C',str(root),*args],stderr=subprocess.PIPE,
        timeout=60,env={'PATH':os.environ.get('PATH','/usr/bin:/bin'),
                        'GIT_NO_REPLACE_OBJECTS':'1','GIT_NO_LAZY_FETCH':'1'})


def prepare_context(root, destination, expected):
    root,destination=Path(root),Path(destination)
    require(type(expected) is str and re.fullmatch('[a-f0-9]{40}',expected) is not None,
            'source_refused')
    require(git(root,'rev-parse','HEAD').decode().strip()==expected,'source_refused')
    require(not destination.exists() and not destination.is_symlink(),'context_refused')
    # Same path rule and guards as every other image context (prepare_context.py).
    # Loaded directly (not through load()) like the provenance writer it also provides.
    try:
        spec=importlib.util.spec_from_file_location('worker_build_provenance',PROVENANCE_HELPER)
        rule=importlib.util.module_from_spec(spec);spec.loader.exec_module(rule)
        exclusion,tolerated,refused=rule.exclusion,rule.TOLERATED_EXCLUSIONS,rule.refused
        write_provenance,image_modes=rule.write_provenance,rule.image_modes
    except Exception:
        raise ValueError('context_refused') from None
    hashes={}; total=0
    tree=git(root,'ls-tree','-rz',expected,'--',*INPUTS)
    require(len(tree)<=8*1024**2,'context_refused')
    blobs={}
    for record in tree.split(b'\0'):
        if record:
            header,path=record.split(b'\t',1); mode,kind,oid=header.split()
            blobs[path.decode('utf-8')]=(mode,kind,oid.decode('ascii'))
    with tempfile.TemporaryDirectory(dir=destination.parent,prefix='.worker-context-') as temp:
        temp=Path(temp); archive=temp/'snapshot.tar'; staging=temp/'context'; staging.mkdir()
        try:
            subprocess.run(['git','-C',str(root),'archive','--format=tar','--output='+str(archive),
                            expected,'--',*INPUTS],check=True,stderr=subprocess.PIPE,timeout=60,
                           env={'PATH':os.environ.get('PATH','/usr/bin:/bin'),
                                'GIT_NO_REPLACE_OBJECTS':'1','GIT_NO_LAZY_FETCH':'1'})
        except subprocess.SubprocessError:
            raise ValueError('context_refused') from None
        require(archive.stat().st_size<=MAX_CONTEXT+16*1024**2,'context_refused')
        with tarfile.open(archive) as tar:
            for entry in tar:
                path=PurePosixPath(entry.name.rstrip('/'))
                require(not path.is_absolute() and str(path)==entry.name.rstrip('/')
                        and all(p not in ('','.','..') for p in path.parts),'context_refused')
                if exclusion(str(path)) is not None:continue
                if entry.isdir():continue
                require(entry.isfile() and not entry.issym() and not entry.islnk()
                        and 0<=entry.size<=MAX_MEMBER and str(path) not in hashes,'context_refused')
                total+=entry.size; require(total<=MAX_CONTEXT,'context_refused')
                with tar.extractfile(entry) as handle: data=handle.read(MAX_MEMBER+1)
                require(len(data)==entry.size,'context_refused')
                # git archive attributes may omit entries, never rewrite their bytes.
                blob=blobs.get(str(path))
                require(blob is not None and blob[0] in (b'100644',b'100755')
                        and blob[1]==b'blob'
                        and hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest()==blob[2],
                        'context_refused')
                target=staging/str(path); target.parent.mkdir(parents=True,exist_ok=True)
                target.write_bytes(data)  # mode from Git below, never from the archive member
                hashes[str(path)]=hashlib.sha256(data).hexdigest()
        require(all(key in hashes for key in ('package.json','bun.lock','bunfig.toml',RECIPE,
                    RECIPE+'.dockerignore','deploy/memlia/images/tests/bun-LICENSE.md'))
                and any(p.startswith('compliance/upstream/') for p in hashes),'context_refused')
        # Every admitted path is copied or left out for a tolerated reason: export-ignore,
        # gitlinks or a source below a generated-output name never vanish silently.
        for path in sorted(blobs):
            reason=exclusion(path)
            if (path not in hashes) if reason is None else (reason not in tolerated):
                raise refused('context_refused',path,reason)
        # The same metadata writer consumes only Git-verified archive bytes here.
        write_provenance(staging,expected,(staging/'bun.lock').read_bytes())
        # Image-readable modes from the admitted Git modes, whatever the umask (CI: 077).
        image_modes(staging,{p for p in hashes if blobs[p][0]==b'100755'})
        for path in (staging/'build-provenance').iterdir():
            data=path.read_bytes();total+=len(data)
            require(total<=MAX_CONTEXT,'context_refused')
            hashes[path.relative_to(staging).as_posix()]=hashlib.sha256(data).hexdigest()
        staging.rename(destination)
    return {'sourceCommit':expected,'bytes':total,'sha256':hashes}


def require_limits(reading):
    require(reading.get('limitBytes')==4*1024**3 and reading.get('swapLimitBytes')==0
            and reading.get('swapBytes')==0 and reading.get('cpuMax')==[200000,100000]
            and reading.get('pidsLimit')==512
            and {'oom','oom_kill'}<=reading.get('events',{}).keys()
            and not any(reading.get('events',{}).get(k,0) for k in ('oom','oom_kill','oom_group_kill')),
            'limits_refused')


def cgroup_relative(raw):
    require(type(raw) is str and raw.count('\n')==1 and raw.startswith('0::/'),'cgroup_refused')
    value=raw[4:-1]; path=PurePosixPath(value)
    require(value and str(path)==value and not path.is_absolute()
            and all(part not in ('.','..','') for part in path.parts),'cgroup_refused')
    return Path(value)


def build_args(name,context,work,commit,lock):
    require(type(commit) is str and re.fullmatch('[a-f0-9]{40}',commit) is not None
            and type(lock) is str and re.fullmatch('[a-f0-9]{64}',lock) is not None,'source_refused')
    return ['buildx','build','--builder='+name,'--platform=linux/amd64','--cgroup-parent=/',
            '--load','--provenance=false','--sbom=false','--progress=plain',
            '--build-arg','TARGETARCH=amd64',
            '--build-arg','MEMLIA_SOURCE_COMMIT='+commit,'--build-arg','MEMLIA_LOCK_SHA256='+lock,'--label','org.memlia.worker.campaign='+name,
            '--label','org.memlia.worker.source='+commit,'--iidfile',str(work/'image.iid'),
            '--file',str(context/RECIPE),str(context)]


def owned_client(argv,work,deadline,cancel,*,capture=False,receipt=None):
    """Adapt the existing bounded build transport for Docker's plugin process.

    WNOWAIT deliberately keeps the session leader unreaped until group cleanup,
    even if Docker exits before its plugin. Its PID/PGID cannot be recycled.
    Only this newly created session is signalled; no daemon/process-name kill.
    """
    require(all(hasattr(os,k) for k in ('waitid','WNOWAIT','WEXITED','WNOHANG','P_PID')),
            'client_ownership_refused')
    receipt=receipt if receipt is not None else {}
    receipt.update(pid=None,waited=False,groupClosed=False)
    child=None; status=None; returned=bytearray(); path=work/'build.private.log'
    total=path.stat().st_size if path.exists() else 0
    try:
        require(total<=MAX_LOG,'recipe_build_log_limit')
        require(time.monotonic()<deadline and not cancel.is_set(),'recipe_build_interrupted')
        child=subprocess.Popen(argv,cwd=work,env={'PATH':'/usr/bin:/bin','HOME':str(work),
            'DOCKER_CONFIG':str(work),'LANG':'C.UTF-8','DOCKER_BUILDKIT':'1'},
            stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,
            start_new_session=True)
        receipt['pid']=child.pid
        with path.open('ab') as log,selectors.DefaultSelector() as poll:
            os.set_blocking(child.stdout.fileno(),False);poll.register(child.stdout,selectors.EVENT_READ)
            while poll.get_map() or status is None:
                require(time.monotonic()<deadline and not cancel.is_set(),'recipe_build_interrupted')
                status=os.waitid(os.P_PID,child.pid,os.WEXITED|os.WNOHANG|os.WNOWAIT)
                for key,_ in poll.select(.05):
                    data=os.read(key.fileobj.fileno(),65536)
                    if not data:poll.unregister(key.fileobj)
                    else:
                        total+=len(data);require(total<=MAX_LOG,'recipe_build_log_limit');log.write(data)
                        if capture:returned.extend(data)
                if not poll.get_map() and status is None:time.sleep(.01)
            require(status.si_code==os.CLD_EXITED and status.si_status==0,'recipe_build_failed')
            rows=subprocess.check_output(['/bin/ps','-axo','pid=,pgid=,stat='],timeout=2).splitlines()
            require(not any(int(row.split()[0])!=child.pid and int(row.split()[1])==child.pid
                            and not row.split()[2].startswith(b'Z') for row in rows),
                    'client_ownership_refused')
        return bytes(returned)
    finally:
        if child is not None:
            try:
                peek=os.waitid(os.P_PID,child.pid,os.WEXITED|os.WNOHANG|os.WNOWAIT)
                if peek is None:
                    require(os.getpgid(child.pid)==child.pid and os.getsid(child.pid)==child.pid,
                            'client_ownership_refused')
                else:
                    # Darwin no longer exposes a zombie's pgid; WNOWAIT still
                    # reserves its PID. Rechecking the same child proves retention.
                    require(peek.si_pid==child.pid,'client_ownership_refused')
                for signum in (signal.SIGTERM,signal.SIGKILL):
                    try:os.killpg(child.pid,signum)
                    except ProcessLookupError:pass
                    except PermissionError:
                        rows=subprocess.check_output(['/bin/ps','-axo','pgid=,stat='],timeout=2).splitlines()
                        require(not any(int(row.split()[0])==child.pid and not row.split()[1].startswith(b'Z')
                                        for row in rows),'client_ownership_refused')
                    if signum==signal.SIGTERM:time.sleep(.1)
                child.wait(timeout=2);receipt['waited']=True
                rows=subprocess.check_output(['/bin/ps','-axo','pgid=,stat='],timeout=2).splitlines()
                require(not any(int(row.split()[0])==child.pid and not row.split()[1].startswith(b'Z')
                                for row in rows),'client_ownership_refused')
                receipt['groupClosed']=True
            finally:child.stdout.close()


def admit_builder_image(row,save):
    """Inspect Id of the pinned BuildKit image: config (classic) or verified manifest (containerd)."""
    try:return IDENTITY.admit(row,BUILDKIT,BUILDKIT_CONFIG,save)
    except ValueError as error:
        index=error.args==('image_identity_index_refused',)
        raise ValueError('builder_identity_index_refused' if index else 'builder_identity_refused') from None


def verify_builder(row,cid,name,image):
    require(image in (BUILDKIT_CONFIG,BUILDKIT.split('@')[1]) and row.get('Id')==cid
            and row.get('Name')=='/buildx_buildkit_'+name+'0'
            and row.get('Image')==image,'builder_identity_refused')


def verify_image(row,image,name,commit,lock):
    config=row.get('Config',{});labels=config.get('Labels') or {}
    require(row.get('Id')==image and row.get('Architecture')=='amd64'
            and row.get('Os')=='linux' and config.get('User')=='1001:1001'
            and config.get('WorkingDir')=='/app/apps/sim'
            and config.get('Cmd')==['bun','--no-env-file','--tsconfig-override=tsconfig.json',
                                  'scripts/memlia-workflow-worker.ts']
            and labels.get('org.memlia.worker.campaign')==name
            and labels.get('org.memlia.worker.source')==commit
            and labels.get('org.memlia.source')==commit
            and labels.get('org.memlia.lock')==lock,'image_refused')


def run(expected,output):
    require(type(expected) is str and re.fullmatch('[a-f0-9]{40}',expected) is not None,
            'source_refused')
    require(platform.system()=='Linux' and platform.machine()=='x86_64','host_refused')
    output=Path(output); require(not output.exists() and not output.is_symlink(),'output_refused')
    output.mkdir(mode=0o700)
    # Reuse only existing stdlib CI transport/build-log and cgroup observations.
    native=load(ROOT/'runtimes/excel/linux/supervisor.py','worker_native_transport')
    metrics=load(ROOT/'scripts/ci/linux-build-metrics.py','worker_cgroup_metrics')
    deadline=time.monotonic()+1200; cancel=threading.Event(); stopped=threading.Event()
    reasons=[]; identities={}; cid=None; volume=None; image=None; cgroup=None; monitor=None; builder_image=None
    name='memlia-worker-'+uuid.uuid4().hex
    result={'status':'failed','reason':'recipe_refused','sourceCommit':expected,
            'imagePackagingVerified':False,'workerDatabaseQualified':False,
            'composeActivated':False,'cleanup':False,'serverStateUnknown':False,
            'imageStateUnknown':False,
            'buildkitPrivileged':True,'memoryGuardPausedByHuman':False,
            'observedProcessIdentities':[],'clientSessions':[],'peakMemoryBytes':0,'minimumDiskBytes':None}
    old={sig:signal.signal(sig,lambda *_:cancel.set()) for sig in (signal.SIGINT,signal.SIGTERM)}

    def client(args,*,end=None,capture=False):
        observation={};result['clientSessions'].append(observation)
        return owned_client([*DOCKER,*args],output,end or deadline,cancel,
                            capture=capture,receipt=observation)

    def raw(args,*,end=None,limit=1024**2):
        if args[0]=='buildx':
            return client(args,end=min(end or deadline,time.monotonic()+30),capture=True)
        return native._command([*DOCKER,*args],b'',min(end or deadline,time.monotonic()+30),
                               None,output,limit)

    def one(args,**kwargs):return native._one(raw(args,**kwargs))

    def disk(reserve=MIN_DISK):
        free=min(shutil.disk_usage(output).free,shutil.disk_usage('/var/lib/docker').free)
        result['minimumDiskBytes']=min(free,result['minimumDiskBytes'] or free)
        require(free>=reserve,'disk_refused')

    def inspect_builder(end=None):
        row=one(['container','inspect',cid],end=end)
        verify_builder(row,cid,name,builder_image)
        return row

    def reading():
        data=metrics.cgroup_read(cgroup)
        data['pidsLimit']=int((cgroup/'pids.max').read_text())
        require_limits(data)
        result['kernelLastObservation']={k:v for k,v in data.items() if k!='pids'}
        return data

    def observe():
        try:
            while not stopped.is_set():
                current=reading(); disk()
                result['peakMemoryBytes']=max(result['peakMemoryBytes'],current['peakBytes'])
                # The aggregate bounded parent includes nested RUN cgroups. This
                # samples identities, not an assertion of complete PID history.
                for path in [cgroup,*cgroup.rglob('*')]:
                    if path.is_dir() and (path/'cgroup.procs').exists():
                        pids=[int(v) for v in (path/'cgroup.procs').read_text().split()]
                        identities.update(metrics.identities(pids))
                stopped.wait(.25)
        except (OSError,ValueError):reasons.append('observation_refused');cancel.set()

    try:
        # Reserve the maximum bounded archive+staging before extraction.
        disk(MIN_DISK+2*MAX_CONTEXT+16*1024**2)
        require(git(ROOT,'status','--porcelain=v1','--untracked-files=all')==b'','source_refused')
        inventory=prepare_context(ROOT,output/'context',expected)
        (output/'context.private.json').write_text(json.dumps(inventory,sort_keys=True)+'\n')
        result['lockSha256']=inventory['sha256']['bun.lock']
        disk()
        info=json.loads(raw(['info','--format','{{json .}}']))
        require(info['OSType']=='linux' and info['Architecture']=='x86_64'
                and info['CgroupVersion']=='2' and info['DockerRootDir']=='/var/lib/docker',
                'host_refused')
        result['dockerVersion']=json.loads(raw(['version','--format','{{json .Server.Version}}']))
        version=raw(['buildx','version'],limit=4096).decode().strip()
        require(re.fullmatch(r'github.com/docker/buildx v[0-9]+\.[0-9]+\.[0-9]+ [a-f0-9]+',version)
                is not None,'buildx_refused')
        result['buildxVersion']=version
        require(raw(['container','ls','-aq','--filter','name=^/buildx_buildkit_'+name+'0$'])==b''
                and raw(['volume','ls','-q','--filter','name=^buildx_buildkit_'+name+'0_state$'])==b'',
                'builder_identity_refused')
        options=['image='+BUILDKIT,'memory=4g','memory-swap=4g','cpu-quota=200000',
                 'cpu-period=100000','restart-policy=no','provenance-add-gha=false']
        create=['buildx','create','--name',name,'--driver=docker-container',
                '--buildkitd-flags=--oci-worker-gc=false','--platform=linux/amd64']
        for option in options:create+=['--driver-opt',option]
        require(raw(create).decode().strip()==name,'builder_identity_refused')
        result['serverStateUnknown']=True
        client(['buildx','inspect',name,'--bootstrap'])
        archive=output/'buildkit-image.tar'
        def save_builder():
            require(not archive.exists() and not archive.is_symlink(),'builder_identity_refused')
            # Dedicated bound: raw() caps every other call at 30 s.
            native._command([*DOCKER,'image','save','--output',str(archive),BUILDKIT],b'',
                            min(deadline,time.monotonic()+SAVE_SECONDS),None,output,1024**2)
            return archive
        try:builder_image=admit_builder_image(one(['image','inspect',BUILDKIT]),save_builder)
        finally:archive.unlink(missing_ok=True)
        candidate=one(['container','inspect','buildx_buildkit_'+name+'0'])
        require(CID.fullmatch(candidate.get('Id','')) is not None,'builder_identity_refused')
        cid=candidate['Id']; row=inspect_builder()
        mounts=[m for m in row['Mounts'] if m.get('Destination')=='/var/lib/buildkit'
                and m.get('Type')=='volume' and m.get('Name')=='buildx_buildkit_'+name+'0_state']
        require(len(mounts)==1,'builder_identity_refused');volume=mounts[0]['Name']
        result['serverStateUnknown']=False
        # Driver has no PIDs option. Apply the real Engine update by exact ID,
        # then inspect both HostConfig and the kernel before any product build.
        raw(['container','update','--pids-limit=512',cid]); row=inspect_builder()
        host=row['HostConfig']; state=row['State']
        require(host['Memory']==4*1024**3 and host['MemorySwap']==4*1024**3
                and host['CpuQuota']==200000 and host['CpuPeriod']==100000
                and host['PidsLimit']==512 and host['Privileged'] is True
                and state['Running'] is True and state['OOMKilled'] is False,'limits_refused')
        pid=state['Pid']; require(type(pid) is int and pid>1,'cgroup_refused')
        require(os.readlink('/proc/'+str(pid)+'/ns/cgroup')!=os.readlink('/proc/1/ns/cgroup')
                and raw(['container','exec',cid,'cat','/proc/self/cgroup'])==b'0::/\n','cgroup_refused')
        cgroup=Path('/sys/fs/cgroup')/cgroup_relative(Path('/proc/'+str(pid)+'/cgroup').read_text())
        reading();result['kernelBeforeBuild']=result['kernelLastObservation']
        result['serverStateUnknown']=False;result['limitsVerifiedBeforeBuild']=True
        result['builderContainerId']=cid
        monitor=threading.Thread(target=observe);monitor.start()
        result['imageStateUnknown']=True
        client(build_args(name,output/'context',output,expected,result['lockSha256']))
        reading();require(not reasons and not cancel.is_set(),'observation_refused')
        raw_id=(output/'image.iid').read_text().strip();require(ID.fullmatch(raw_id) is not None,'image_refused')
        verify_image(one(['image','inspect',raw_id]),raw_id,name,expected,result['lockSha256'])
        image=raw_id;result['imageId']=image;result['imageStateUnknown']=False
        # Image construction only. Native DB/FunctionBlock/runtime probes are a
        # separate reviewed campaign, never inferred from Docker's successful exit.
        result['imagePackagingVerified']=True;result['reason']=None
    except (ValueError,OSError,subprocess.SubprocessError,KeyError,TypeError) as error:
        allowed={'source_refused','context_refused','host_refused','disk_refused',
                 'builder_identity_refused','builder_identity_index_refused','limits_refused','cgroup_refused','buildx_refused',
                 'image_refused','observation_refused','client_ownership_refused','recipe_build_failed',
                 'recipe_build_interrupted','recipe_build_log_limit'}
        result['reason']=str(error) if str(error) in allowed else 'recipe_refused'
    finally:
        end=min(time.monotonic()+60,deadline+60)
        stopped.set()
        if monitor is not None:monitor.join(timeout=max(0,min(2,end-time.monotonic())))
        try:
            require(not result['serverStateUnknown'],'cleanup_unknown')
            if cid is not None:
                row=inspect_builder(end)
                # Observe running/non-OOM before the intentional stop.
                result['builderRunningBeforeCleanup']=row['State']['Running']
                result['builderOomBeforeCleanup']=row['State']['OOMKilled']
                if row['State']['Running'] is not True or row['State']['OOMKilled'] is not False:
                    result['reason']=result['reason'] or 'builder_state_refused'
                if row['State']['Running']:
                    raw(['container','stop','--time=10',cid],end=end)
                require(inspect_builder(end)['State']['Running'] is False,'cleanup_refused')
                raw(['container','rm',cid],end=end)
                require(raw(['container','ls','-aq','--filter','id='+cid],end=end)==b'','cleanup_refused')
                raw(['volume','rm',volume],end=end)
                require(raw(['volume','ls','-q','--filter','name=^'+volume+'$'],end=end)==b'',
                        'cleanup_refused')
            if image is not None:raw(['image','rm',image],end=end)
            remaining={pid:start for pid,start in identities.items()
                       if metrics.identities([pid]).get(pid)==start}
            require(not remaining and not (monitor and monitor.is_alive())
                    and not result['imageStateUnknown']
                    and all(c.get('waited') is True and c.get('groupClosed') is True
                            for c in result['clientSessions']),'cleanup_refused')
            result['cleanup']=True
        except (ValueError,OSError,subprocess.SubprocessError,KeyError,TypeError):
            result['cleanup']=False
        for sig,previous in old.items():signal.signal(sig,previous)
        result['observedProcessIdentities']=[{'pid':pid,'startTimeTicks':start} for pid,start in identities.items()]
        if result['reason'] is None and not result['cleanup']:result['reason']='cleanup_refused'
        result['status']='passed' if result['reason'] is None and result['cleanup'] else 'failed'
        (output/'result.json').write_text(json.dumps(result,sort_keys=True)+'\n')
        print(json.dumps(result,sort_keys=True))
    return 0 if result['status']=='passed' else 1


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--expected-commit',required=True)
    parser.add_argument('--output',required=True,type=Path)
    args=parser.parse_args()
    try:sys.exit(run(args.expected_commit,args.output))
    except (ValueError,OSError):raise SystemExit('Worker image recipe refused') from None
