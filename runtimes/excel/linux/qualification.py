# Copyright (c) 2026 Memlia. All rights reserved.
"""Explicit CI recipe; optional owned host consumer, never business or model authority."""
import argparse
import ast
import base64
from hashlib import sha256
from io import BytesIO
import json
import os
from pathlib import Path
import platform
import selectors
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import struct

import prepare_context
import supervisor as s

# Verified from Docker Official Images library/python, linux/amd64 manifest.
PYTHON_BASE = 'python@sha256:2ed6491b93cd49272ee6de2b5a38440c3448360322c089fc23e370722d74179d'
PYTHON_CONFIG = 'sha256:4f228bc1cbcfc794e4878312cfc241d368eff55a21c08d1e2bb263116c4ef524'
ROOT = Path(__file__).resolve().parents[3]
DOCKER = ['/usr/bin/docker', '--host', 'unix:///var/run/docker.sock']
MAX_BUILD_LOG = 8*1024**2
MIN_FREE_DISK = 6*1024**3
PROBES = {
    'boundary': ('nonRoot', 'rootReadOnly', 'tmpWritable', 'networkDenied', 'noNewPrivileges'),
    'cpu': ('cpuThrottled',), 'pids': ('pidLimitEnforced',),
    'memory': ('memoryOomEnforced',), 'disk': ('tmpfsLimitEnforced',),
}


def require(ok, code='linux_recipe_refused'):
    if not ok: raise ValueError(code)


def check_disk(path, receipt, phase, *, enforce=True):
    # Closed numerical observation; failed measurement never authorizes work.
    free = None
    try:
        measured = shutil.disk_usage(path).free
        if type(measured) is int and measured >= 0: free = measured
    except OSError:
        pass
    sufficient = free is not None and free >= MIN_FREE_DISK
    receipt['diskObservations'].append(dict(phase=phase, freeBytes=free,
        requiredFreeBytes=MIN_FREE_DISK, sufficient=sufficient))
    if enforce: require(sufficient, 'recipe_disk_refused')


def require_linux():
    require(platform.system() == 'Linux' and platform.machine() == 'x86_64', 'linux_recipe_unavailable')


def refusal_receipt(receipt):
    require(receipt.get('createAcknowledged') is True and receipt.get('cleanupComplete') is True,
            'recipe_cleanup_refused')


def probe_result(name, raw):
    require(name in PROBES and len(raw) <= 1024, 'recipe_probe_refused')
    result = json.loads(raw)
    require(type(result) is dict and set(result) == set(PROBES[name])
            and all(value is True for value in result.values()), 'recipe_probe_refused')
    return result


class RecipeDocker:
    """Same image/creation/inspection/cleanup; fixed exec probes before stdin EOF.

    Ordinary worker case forwards the production attach unchanged. Probe cases
    start detached, inspect again, exec fixed source, then attach the real worker.
    This recipe seam is NOT an alternate production invocation path.
    """
    def __init__(self, raw, image, probe=None):
        require(probe is None or probe in (*PROBES, 'timeout', 'cancel'), 'recipe_probe_refused')
        self.raw, self.image, self.probe = raw, image, probe
        self.name = self.nonce = self.cid = None
        self.observation = None
        self.missing_fields = []
        self.deadline_reached = False
        self.memory_probe_refusal = False

    def inspect(self, deadline):
        require(self.cid is not None and self.name is not None and self.nonce is not None)
        return s._inspect(self, self.cid, self.name, self.nonce, self.image, deadline)

    def __call__(self, args, payload=b'', *, deadline, cancel=None, limit=1024**2):
        if args[:2] == ['container', 'create']:
            self.name = args[args.index('--name')+1]
            self.nonce = next(a.split('=',1)[1] for a in args if a.startswith('org.memlia.excel.nonce='))
            raw = self.raw(args, payload, deadline=deadline, cancel=cancel, limit=limit)
            candidate = raw.decode('ascii').strip()
            if s.ID.fullmatch(candidate): self.cid = candidate
            return raw
        if args[:2] == ['container', 'inspect']:
            raw = self.raw(args, payload, deadline=deadline, cancel=cancel, limit=limit)
            row = s._one(raw)
            # Closed names only; missing metadata still fails in native _inspect.
            required = (*s.HOST, 'CapAdd', 'Binds', 'Devices', 'DeviceRequests', 'VolumesFrom', 'PortBindings', 'Ulimits')
            host = row.get('HostConfig')
            self.missing_fields = sorted('HostConfig.'+key for key in required if type(host) is not dict or key not in host)
            return raw
        if args[:2] != ['container', 'start'] or self.probe is None:
            return self.raw(args, payload, deadline=deadline, cancel=cancel, limit=limit)
        require(args == ['container','start','--attach','--interactive',self.cid])
        require(self.inspect(deadline)['Status'] == 'created')
        self.raw(['container','start',self.cid], deadline=deadline, cancel=cancel)
        require(self.inspect(deadline)['Running'] is True)
        if self.probe in ('timeout', 'cancel'):
            # Worker still waits for EOF. Force a bounded real Docker exec wait;
            # production supervisor must refuse, stop and remove the owned worker.
            end = min(deadline, time.monotonic()+2)
            timer = None
            if self.probe == 'cancel':
                require(cancel is not None)
                timer = threading.Timer(.25, cancel.set)
                timer.start()
            try:
                self.raw(['container','exec', self.cid, '/usr/bin/env', *s.COMMAND[:8],
                          '/opt/excel/runtime/bin/python','-I','-B','-c','import time; time.sleep(10)'],
                         deadline=end, cancel=cancel, limit=1024)
            except s.IsolationError:
                self.deadline_reached = time.monotonic() >= end
                raise
            finally:
                if timer is not None: timer.cancel(); timer.join()
            require(False, 'recipe_timeout_missing')
        source = Path(__file__).with_name('qualification_probe.py').read_text()
        self.inspect(deadline)  # Identity checked immediately before fixed exec.
        raw = self.raw(['container','exec', '--user','65532:65532', self.cid, '/usr/bin/env',
                        *s.COMMAND[:8], '/opt/excel/runtime/bin/python','-I','-B','-c',source,self.probe],
                       deadline=min(deadline,time.monotonic()+30), cancel=cancel, limit=1024)
        self.observation = probe_result(self.probe, raw)
        if self.probe == 'memory':
            # Deliberate OOM probe: never reinterpret a production OOM as success.
            # Its observation is separate; native stop/removal is still mandatory.
            self.memory_probe_refusal = True
            raise s.IsolationError()
        require(self.inspect(deadline)['Running'] is True)
        return self.raw(['container','attach','--sig-proxy=false',self.cid], payload,
                        deadline=deadline, cancel=cancel, limit=limit)


def fixture_wire():
    # Same canonical fixture as installed packaging tests, not a new procedure IR.
    for path in (ROOT/'packages/memlia-contracts/python', ROOT/'runtimes/excel/src'):
        sys.path.insert(0, str(path))
    from copy import deepcopy
    import openpyxl
    from memlia_contracts import validate
    from memlia_excel.procedure import MEMORY_PROFILE, ResolvedXlsx, OutputTarget
    source = (ROOT/'runtimes/excel/tests/test_procedure.py').read_text()
    builders = [node for node in ast.parse(source).body if isinstance(node, ast.FunctionDef) and node.name in ('workbook','fixture')]
    require(len(builders) == 2)
    namespace = dict(deepcopy=deepcopy, openpyxl=openpyxl, BytesIO=BytesIO, sha256=sha256,
                     validate=validate, ResolvedXlsx=ResolvedXlsx, OutputTarget=OutputTarget)
    # Trusted checked-in test functions only, never envelope/model data.
    exec(compile(ast.Module(body=builders, type_ignores=[]), 'canonical-fixture', 'exec'), namespace)
    recipe, sources, targets = namespace['fixture']()
    body = dict(schemaVersion='memlia.excel-process/v1', requestId='linux-image-recipe', profile=MEMORY_PROFILE,
                procedure=recipe, sources={role:dict(bindingId=v.binding_id, sheetId=v.sheet_id,
                    sheetName=v.sheet_name, contentBase64=base64.b64encode(v.content).decode('ascii'), sha256=v.sha256)
                    for role,v in sources.items()}, targets={role:dict(bindingId=v.binding_id,
                    sheetId=v.sheet_id,sheetName=v.sheet_name) for role,v in targets.items()})
    return json.dumps(body,separators=(',',':')).encode()


def verify_answer(raw):
    import openpyxl
    require(0 < len(raw) <= s.MAX_WIRE)
    from memlia_excel.process import pairs, non_json
    answer = json.loads(raw, object_pairs_hook=pairs, parse_constant=non_json)
    require(type(answer) is dict and set(answer) == {'schemaVersion','requestId','status','published','outputs','controls'})
    require(answer['schemaVersion'] == 'memlia.excel-process/v1' and answer['requestId'] == 'linux-image-recipe'
            and answer['status'] == 'prepared_in_memory' and answer['published'] is False)
    require(type(answer['outputs']) is list and len(answer['outputs']) == 1)
    output = answer['outputs'][0]
    require(set(output) == {'role','bindingId','sheetId','contentBase64','sha256'})
    require((output['role'],output['bindingId'],output['sheetId']) == ('result','result-binding','result-sheet'))
    content = base64.b64decode(output['contentBase64'],validate=True)
    require(len(content) <= 10_000_000 and base64.b64encode(content).decode() == output['contentBase64'])
    require(output['sha256'] == 'sha256:'+sha256(content).hexdigest())
    require(answer['controls'] == [dict(index=0,kind='balance',severity='blocking',satisfied=True)])
    book = openpyxl.load_workbook(BytesIO(content),read_only=True)
    try: require(list(book.active.values) == [('id','debit','credit'),('a','0.10','0.10'),('b','0.20','0.20')])
    finally: book.close()


def build_command(args, work, deadline, cancel):
    """Build/pull only: bound merged log privately, no output printed/uploaded."""
    child = None
    log_path = work/'build.private.log'
    total = log_path.stat().st_size if log_path.exists() else 0
    try:
        require(total <= MAX_BUILD_LOG, 'recipe_build_log_limit')
        require(time.monotonic() < deadline and not cancel.is_set(), 'recipe_build_interrupted')
        child = subprocess.Popen([*DOCKER,*args],cwd=work,env={'PATH':'/usr/bin:/bin','HOME':str(work),
            'DOCKER_CONFIG':str(work),'LANG':'C.UTF-8','DOCKER_BUILDKIT':'1'},stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
        with (work/'build.private.log').open('ab') as log, selectors.DefaultSelector() as poll:
            os.set_blocking(child.stdout.fileno(),False)
            poll.register(child.stdout,selectors.EVENT_READ)
            while poll.get_map():
                require(time.monotonic()<deadline and not cancel.is_set(),'recipe_build_interrupted')
                for key,_ in poll.select(.05):
                    data=os.read(key.fileobj.fileno(),65536)
                    if not data: poll.unregister(key.fileobj)
                    else:
                        total+=len(data); require(total<=MAX_BUILD_LOG,'recipe_build_log_limit'); log.write(data)
            require(child.wait(timeout=max(.01,deadline-time.monotonic()))==0,'recipe_build_failed')
    finally:
        if child is not None:
            if child.poll() is None:
                child.terminate()
                try: child.wait(timeout=2)
                except subprocess.TimeoutExpired: child.kill(); child.wait(timeout=2)
            child.stdout.close()


def run_case(docker, image, wire, probe, cancel, cases):
    case = probe or 'worker'
    adapter = RecipeDocker(docker, image, probe)
    local_cancel = cancel if probe != 'cancel' else threading.Event()
    owned = {}
    record = cases[case] = {'passed': False, 'cleanupComplete': False, 'missingInspectFields': []}
    started = time.monotonic()
    try:
        failed = False
        try:
            result = s._run_owned(adapter, image, wire, local_cancel, _receipt=owned)
        except s.IsolationError:
            failed = True
        refusal_receipt(owned)
        require(not cancel.is_set(), 'recipe_interrupted')
        if probe == 'memory':
            require(failed and adapter.memory_probe_refusal and adapter.observation is not None)
            record['observed'] = adapter.observation
            record['workerCompletionAfterOomQualified'] = False
        elif probe in ('timeout', 'cancel'):
            require(failed and (adapter.deadline_reached if probe == 'timeout' else local_cancel.is_set()))
        else:
            require(not failed)
            verify_answer(result)
            if probe:
                require(adapter.observation is not None)
                record['observed'] = adapter.observation
        record['passed'] = True
    finally:
        record['durationSeconds'] = round(time.monotonic()-started, 3)
        record['cleanupComplete'] = owned.get('cleanupComplete') is True
        record['containerId'] = owned.get('containerId')
        record['nonce'] = owned.get('nonce')
        record['missingInspectFields'] = adapter.missing_fields


def qualification_proof(receipt):
    """Container cleanup is proven; image cleanup is still pending during consumption."""
    proof = {'schemaVersion': 'memlia.excel-isolation-proof/v1',
             **{key: receipt[key] for key in ('imageId', 'sourceCommit', 'lockSha256', 'contextSha256')},
             'supervisorSha256': s.SOURCE_SHA256, 'imageHeld': True,
             'cases': {name: {key: result[key] for key in ('passed', 'cleanupComplete')}
                       for name, result in receipt['cases'].items()}}
    return s.admission.validate_proof(proof)


def consume_through_host(proof, wire, deadline, cancel, record, *, application_work=None):
    """Explicit root-owned CI consumer; real Unix peer + public execute, no Sim authority."""
    require(os.getuid() == 0 and time.monotonic() < deadline and not cancel.is_set())
    s.admission.validate_proof(proof)
    nonce = uuid.uuid4().hex
    root = Path('/run') / ('memlia-excel-host-'+nonce)
    record.update(passed=False, cleanupComplete=False, expectedPeerUid=1001, expectedRefusedUid=1002,
                  hostNonce=nonce,
                  resourcesRetained=True, simWorkflowQualified=False, stage='operator_files')
    root.mkdir(mode=0o755)  # Exclusive; peers may traverse, never write operator configuration.
    root.chmod(0o755)  # The recipe's umask 077 must not prevent socket traversal.
    require(root.stat().st_uid==0 and root.stat().st_mode & 0o777 == 0o755)
    identity = (root.stat().st_dev, root.stat().st_ino)
    process = None
    code = root / 'code'
    code.mkdir(mode=0o755)
    names = ('admission.py', 'supervisor.py', 'host.py')
    try:
        for name in names:
            raw = Path(__file__).with_name(name).read_bytes()
            with os.fdopen(os.open(code/name, os.O_CREAT|os.O_EXCL|os.O_WRONLY, 0o400), 'wb') as out:
                out.write(raw)
        raw = json.dumps(proof, separators=(',', ':')).encode()
        operator = s.admission.describe(raw)  # Only this explicit operator mode installs it.
        for name, data in (('proof.json', raw), ('admission.json', json.dumps(operator).encode())):
            with os.fdopen(os.open(root/name, os.O_CREAT|os.O_EXCL|os.O_WRONLY, 0o400), 'wb') as out:
                out.write(data)
        socket_path = root/'host.sock'
        record['stage']='host_start'
        process = subprocess.Popen([sys.executable, '-I', '-B', str(code/'host.py'),
            str(socket_path), proof['imageId'], '1001', '1001', '--admission-file', str(root/'admission.json')],
            cwd=root, env={'PATH':'/usr/bin:/bin','HOME':str(root),'LANG':'C.UTF-8',
                           'PYTHONDONTWRITEBYTECODE':'1'}, stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        ready = min(deadline, time.monotonic()+5)
        while not socket_path.exists():
            require(process.poll() is None and time.monotonic()<ready and not cancel.is_set())
            time.sleep(.025)
        # Fixed stdlib peer fixture: drop groups/GID/UID before reading any frame.
        client = ("import socket,sys,struct,os\n"
                  "uid=int(sys.argv[2]);assert uid in (1001,1002);os.setgroups([]);os.setgid(1001);os.setuid(uid);assert os.getuid()==os.geteuid()==uid\n"
                  "wire=sys.stdin.buffer.read(14*1024**2+1);assert 0<len(wire)<=14*1024**2\n"
                  "with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as c:\n"
                  " c.settimeout(125);c.connect(sys.argv[1]);out=bytearray()\n"
                  " if sys.argv[3]=='allow':c.sendall(struct.pack('!I',len(wire))+wire)\n"
                  " else:assert sys.argv[3]=='deny'\n"
                  " while True:\n"
                  "  part=c.recv(65536)\n"
                  "  if not part:break\n"
                  "  out.extend(part);assert len(out)<=14*1024**2+5\n"
                  " sys.stdout.buffer.write(out)\n")
        def peer(uid):
            return s._command(['/usr/bin/python3', '-I', '-S', '-B', '-c', client, str(socket_path), str(uid),
                'allow' if uid==1001 else 'deny'],
                wire, min(deadline,time.monotonic()+120), cancel, root, s.MAX_WIRE+5)
        record['stage']='refused_peer'
        require(peer(1002) == b'\x01\0\0\0\0', 'host_peer_refusal_missing')
        record['otherUidRefused']=True
        record['stage']='accepted_peer'
        answer = peer(1001)
        require(len(answer)>5 and answer[0]==0 and struct.unpack('!I',answer[1:5])[0]==len(answer)-5)
        record['stage']='native_readback'
        verify_answer(answer[5:])
        record.update(peerAccepted=True, otherUidRefused=True, sameQualifiedImage=True)
        if application_work is not None:
            import application_qualification
            record['stage']='native_application'
            record['application']={}
            application_qualification.consume(socket_path,wire,deadline,cancel,
                                              application_work,record['application'])
    finally:
        closed = process is None
        if process is not None:
            if process.poll() is None: process.terminate()  # Known Popen only; host drains its owned work.
            try:
                closed = process.wait(timeout=max(.01,min(140,deadline+20-time.monotonic()))) == 0
            except subprocess.TimeoutExpired:
                closed = False  # No blind SIGKILL or removal while native cleanup is unknown.
        record['hostStopped']=closed
        record['hostExitCode']=None if process is None else process.returncode
        if closed:
            try:
                info=root.lstat()
                require((info.st_dev,info.st_ino)==identity and not root.is_symlink())
                require({p.name for p in root.iterdir()}=={'code','proof.json','admission.json'})
                require({p.name for p in code.iterdir()}==set(names))
                for path in [*(code/name for name in names), root/'proof.json',root/'admission.json']:
                    info=path.lstat()
                    require(info.st_uid==0 and info.st_nlink==1 and path.is_file() and not path.is_symlink())
                for path in [*(code/name for name in names), root/'proof.json',root/'admission.json']: path.unlink()
                code.rmdir();root.rmdir()
                record.update(cleanupComplete=True, resourcesRetained=False)
            except (OSError,ValueError): closed=False
        require(closed and record['cleanupComplete'], 'host_cleanup_refused')
    record.update(passed=True,stage='complete')


def run(wheelhouse, output, *, exercise_host=False, exercise_application=False):
    require_linux()
    require(not exercise_application or exercise_host, 'application_host_required')
    require(not exercise_host or os.getuid()==0, 'host_operator_required')
    require(not output.exists() and not output.is_symlink())
    output.mkdir(mode=0o700)
    cancel = threading.Event()
    old = {n: signal.signal(n, lambda *_: cancel.set()) for n in (signal.SIGTERM, signal.SIGINT)}
    receipt = {'status': 'failed', 'phase': 'context', 'runtimeActivated': False,
               'linuxRecipeCompleted': False, 'cases': {}, 'cleanupComplete': False, 'diskObservations': [],
               'buildCacheRemoved': False, 'hostDescendantsQualified': False, 'pythonBase': PYTHON_BASE}
    image, build_attempted = None, False
    nonce = uuid.uuid4().hex
    tag = 'memlia-excel-recipe:'+nonce
    deadline = global_deadline = time.monotonic()+600
    def docker(args, payload=b'', *, deadline, cancel=None, limit=1024**2):
        # Clamp operations, not native cleanup, to the recipe's global deadline.
        cleanup = args[:2] in (['container','inspect'], ['container','stop'], ['container','rm'],
                              ['container','ls'], ['image','inspect'], ['image','rm'], ['image','ls'])
        end = min(deadline, global_deadline + (20 if cleanup else 0))
        return s._command([*DOCKER, *args], payload, end, cancel, output, limit)
    def git(*args):
        # Per-command trust for the admitted checkout under the explicit root CI mode.
        trust = ['-c','safe.directory='+str(ROOT)] if exercise_host else []
        return subprocess.check_output(['/usr/bin/git', *trust, *args], cwd=ROOT, timeout=5, stderr=subprocess.DEVNULL).decode().strip()
    try:
        check_disk(output, receipt, 'context')
        require(s.QUALIFIED_IMAGES == frozenset())
        require(not git('status', '--porcelain', '--untracked-files=no'))
        context = prepare_context.prepare(ROOT, wheelhouse, output/'context', PYTHON_BASE)
        receipt['sourceCommit'] = git('rev-parse', 'HEAD')
        require(len(receipt['sourceCommit']) == 40 and all(c in '0123456789abcdef' for c in receipt['sourceCommit']))
        receipt['lockSha256'] = context['lockSha256']
        receipt['contextSha256'] = sha256((output/'context/context.json').read_bytes()).hexdigest()
        receipt['phase'] = 'base_pull'
        check_disk(output, receipt, receipt['phase'])
        build_command(['pull', '--platform', 'linux/amd64', PYTHON_BASE], output, deadline, cancel)
        base = s._one(docker(['image', 'inspect', PYTHON_BASE], deadline=deadline))
        require(base['Id'] == PYTHON_CONFIG and base['Os'] == 'linux' and base['Architecture'] == 'amd64')
        receipt['phase'] = 'image_build'
        check_disk(output, receipt, receipt['phase'])
        build_attempted = True
        build_command(['build', '--pull=false', '--network=none', '--platform', 'linux/amd64', '--label',
            'org.memlia.excel.recipe='+nonce, '--iidfile', str(output/'image.id'), '-t', tag, str(output/'context')],
            output, deadline, cancel)
        image = (output/'image.id').read_text().strip()
        require(s.IMAGE.fullmatch(image))
        receipt['imageId'] = image
        wire = fixture_wire()
        for probe in (None, *PROBES, 'timeout', 'cancel'):
            require(time.monotonic() < deadline and not cancel.is_set(), 'recipe_interrupted')
            receipt['phase'] = probe or 'worker'
            check_disk(output, receipt, receipt['phase'])
            run_case(docker, image, wire, probe, cancel, receipt['cases'])
        require(not git('status', '--porcelain', '--untracked-files=no') and git('rev-parse', 'HEAD') == receipt['sourceCommit'])
        require(sha256((ROOT/'runtimes/excel/requirements.lock').read_bytes()).hexdigest() == receipt['lockSha256'])
        require(set(receipt['cases']) == {'worker', *PROBES, 'timeout', 'cancel'})
        if exercise_host:
            receipt['phase']='host_consumer'
            receipt['hostConsumer']={}
            check_disk(output, receipt, receipt['phase'])
            held=s._one(docker(['image','inspect',image],deadline=deadline))
            require(held['Id']==image and held['Config']['Labels']['org.memlia.excel.recipe']==nonce)
            if exercise_application:
                consume_through_host(qualification_proof(receipt),wire,deadline,cancel,
                                     receipt['hostConsumer'],application_work=output/'application')
            else:
                consume_through_host(qualification_proof(receipt),wire,deadline,cancel,receipt['hostConsumer'])
        receipt['status'] = 'passed'
        receipt['linuxRecipeCompleted'] = True
    except Exception:
        receipt['code'] = 'linux_recipe_refused'
    finally:
        check_disk(output, receipt, 'cleanup_before', enforce=False)
        # Only this image's exact ID + build nonce. No global prune/cache deletion.
        image_clean = not build_attempted
        try:
            if image is None and (output/'image.id').is_file():
                image = (output/'image.id').read_text().strip()
            if image:
                require(s.IMAGE.fullmatch(image))
                row = s._one(docker(['image', 'inspect', image], deadline=time.monotonic()+10))
                require(row['Id'] == image and row['Config']['Labels']['org.memlia.excel.recipe'] == nonce)
                docker(['image', 'rm', image], deadline=time.monotonic()+10)
                remaining = docker(['image', 'ls', '--no-trunc', '--quiet', '--filter',
                    'label=org.memlia.excel.recipe='+nonce], deadline=time.monotonic()+10)
                require(not remaining.strip())
                image_clean = True
        except Exception:
            image_clean = False
        check_disk(output, receipt, 'cleanup_after', enforce=False)
        if not all(row['sufficient'] for row in receipt['diskObservations']):
            receipt.update(status='failed', linuxRecipeCompleted=False, code='recipe_disk_refused')
        host_clean = 'hostConsumer' not in receipt or receipt['hostConsumer'].get('cleanupComplete') is True
        application = receipt.get('hostConsumer',{}).get('application')
        if application is not None:
            host_clean = host_clean and application.get('cleanupComplete') is True
        receipt['cleanupComplete'] = image_clean and host_clean and all(c['cleanupComplete'] for c in receipt['cases'].values())
        if not receipt['cleanupComplete']:
            receipt.update(status='failed', linuxRecipeCompleted=False, code='recipe_cleanup_refused')
        for n, handler in old.items():
            signal.signal(n, handler)
        if cancel.is_set():
            receipt.update(status='failed', linuxRecipeCompleted=False, code='recipe_interrupted')
        # Closed receipt only. No logs, workbooks, arbitrary errors or inspect JSON.
        (output/'receipt.json').write_text(json.dumps(receipt, indent=2)+'\n')
        print(json.dumps(receipt, separators=(',', ':')))
    return 0 if receipt['status'] == 'passed' and receipt['cleanupComplete'] else 1


if __name__ == '__main__':
    os.umask(0o077)
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--wheelhouse',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--exercise-host',action='store_true',
                        help='Explicit operator CI mode: same-image host/UID qualification before cleanup')
    parser.add_argument('--exercise-application',action='store_true',
                        help='Manual native API/file composition using that same host; requires --exercise-host')
    options=parser.parse_args()
    try: result=run(options.wheelhouse,options.output,exercise_host=options.exercise_host,
                   exercise_application=options.exercise_application)
    except Exception: print('{"status":"failed","code":"linux_recipe_unavailable"}');result=1
    raise SystemExit(result)
