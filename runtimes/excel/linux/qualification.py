# Copyright (c) 2026 Memlia. All rights reserved.
"""Explicit CI recipe only. No image admission, service, job or model command."""
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
            required = (*s.HOST, 'CapAdd', 'Binds', 'Mounts', 'Devices', 'DeviceRequests', 'VolumesFrom', 'PortBindings', 'Ulimits')
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


def run(wheelhouse, output):
    require_linux()
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
        return subprocess.check_output(['/usr/bin/git', *args], cwd=ROOT, timeout=5, stderr=subprocess.DEVNULL).decode().strip()
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
        receipt['cleanupComplete'] = image_clean and all(c['cleanupComplete'] for c in receipt['cases'].values())
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
    options=parser.parse_args()
    try: result=run(options.wheelhouse,options.output)
    except Exception: print('{"status":"failed","code":"linux_recipe_unavailable"}');result=1
    raise SystemExit(result)
