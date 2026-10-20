#!/usr/bin/env python3
# Copyright 2026 Memlia. All rights reserved.
"""Explicit provider-double test groups, separate from Next and live services."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time

ROOT=Path(__file__).resolve().parents[2]
GROUPS={
    'contracts':('node','.',('packages/memlia-contracts/tests/contracts.test.ts',)),
    'limiter':('bun','apps/sim',(
        'lib/memlia/chat/model-adapter.test.ts',
        'lib/memlia/ai/chat-pricing-profile.test.ts',
    )),
    'catalogue':('vitest','apps/sim',(
        'lib/memlia/chat/catalog-tools.test.ts',
        'lib/memlia/chat/workflow-read-tools.test.ts',
        'lib/catalog/projection/invariants.test.ts',
        'lib/catalog/projection/function-context.test.ts',
        'tests/memlia/chat-evals/corpus.test.ts',
        'tests/memlia/chat-evals/native-catalog.test.ts',
        'tests/memlia/chat-evals/oracles.test.ts',
    )),
    'chat':('vitest','apps/sim',(
        'lib/memlia/chat/local-driver.server.test.ts',
        'lib/memlia/chat/local-admission.server.test.ts',
        'lib/memlia/chat/authorized-transcript.server.test.ts',
        'lib/memlia/chat/provider-binding.test.ts',
        'lib/memlia/chat/workflow-completion.test.ts',
        'lib/memlia/chat/thinking-policy-native.test.ts',
        'providers/stream-events.test.ts',
        'lib/memlia/ai/chat-policy.server.test.ts',
        'lib/memlia/ai/chat-policy-source.server.test.ts',
        'lib/memlia/ai/budgeted-catalog-provider.server.test.ts',
        'providers/anthropic/controlled-client.test.ts',
        'providers/anthropic/core.test.ts',
        'providers/anthropic/streaming-tool-loop.test.ts',
        'providers/openai-compat/streaming-tool-loop.test.ts',
    )),
    'chat_ui':('vitest','apps/sim',(
        'lib/mothership/chat/completion-notice.test.ts',
        'lib/mothership/request/handlers/handlers.test.ts',
        'app/workspace/[workspaceId]/home/hooks/stream/turn-model.test.ts',
        'app/workspace/[workspaceId]/home/hooks/stream/turn-model-serialize.test.ts',
        'app/workspace/[workspaceId]/home/components/message-content/message-content.test.ts',
    )),
    'authority':('vitest','apps/sim',(
        'lib/core/application/workspace-authorization.test.ts',
        'lib/workflows/application/authorization.test.ts',
        'lib/workflows/application/apply-workflow-operations.test.ts',
        'lib/workflows/editing/operations.test.ts',
        'lib/workflows/editing/validation.test.ts',
        'lib/permission-groups/config-scope.server.test.ts',
        'lib/memlia/chat/workflow-preview-tools.test.ts',
        'lib/memlia/chat/workflow-proposals.server.test.ts',
        'app/api/copilot/confirm/route.test.ts',
    )),
}


def test_environment(inherited):
    # Test credentials and provider policy are doubles defined in the tests, never ambient secrets.
    value={k:v for k,v in inherited.items() if k in ('PATH','HOME','TMPDIR','LANG')}
    value.update(CI='true',NODE_ENV='test',NODE_OPTIONS='--max-old-space-size=3072',
                 NEXT_TELEMETRY_DISABLED='1',DO_NOT_TRACK='1',PYTHONDONTWRITEBYTECODE='1')
    return value


def commands(root,selected,node='node',bun='bun',vitest=None):
    result=[]
    for name in selected:
        runtime,relative,files=GROUPS[name]
        cwd=root/relative
        for file in files:
            path=cwd/file
            if path.is_symlink() or not path.is_file():raise ValueError('selected_test_missing')
        if runtime=='node':
            argv=[node,'--no-addons','--experimental-strip-types','--test','--test-isolation=none','--test-timeout=10000',*files]
        elif runtime=='bun':argv=[bun,'--no-env-file','test','--timeout','10000',*files]
        else:
            assert vitest is not None
            argv=[node,str(vitest),'run','--maxWorkers=1','--no-file-parallelism',*files]
        result.append({'group':name,'files':len(files),'cwd':cwd,'argv':argv})
    return result


def run_plan(commands,environment,report):
    receipt={'status':'passed','groups':[],'nextBuildExecuted':False,
             'liveProviderQualified':False,'databaseQualified':False,'cacheQualified':False}
    with os.fdopen(os.open(report,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'w') as output:
        try:
            for command in commands:
                result={'group':command['group'],'files':command['files'],
                        'status':'not_run','exitCode':None,'reason':None,'seconds':0}
                receipt['groups'].append(result)
                if receipt['status']!='passed':continue
                started=time.monotonic()
                try:
                    completed=subprocess.run(command['argv'],cwd=command['cwd'],env=environment,
                                             timeout=180,check=False)
                    result.update(exitCode=completed.returncode,
                                  status='passed' if completed.returncode==0 else 'failed',
                                  reason=None if completed.returncode==0 else 'test_failed')
                except subprocess.TimeoutExpired:result.update(status='failed',reason='timeout')
                except OSError:result.update(status='failed',reason='tool_unavailable')
                except KeyboardInterrupt:result.update(status='failed',reason='interrupted')
                finally:result['seconds']=round(time.monotonic()-started,3)
                if result['status']!='passed':receipt['status']='failed'
        finally:
            json.dump(receipt,output,separators=(',',':'));output.write('\n')
    return 0 if receipt['status']=='passed' else 1


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--group',choices=['all',*GROUPS],default='all')
    parser.add_argument('--report',required=True,type=Path)
    args=parser.parse_args()
    environment=test_environment(os.environ)
    if os.environ.get('MEMLIA_FAST_CONTAINER')=='1':
        limits=Path('/sys/fs/cgroup')
        assert (limits/'memory.max').read_text().strip()==str(4*1024**3)
        assert (limits/'memory.swap.max').read_text().strip()=='0'
        assert (limits/'cpu.max').read_text().split()==['200000','100000']
        assert (limits/'pids.max').read_text().strip()=='256'
    # Vitest's native setup loads .env files: this lane must start from clean public sources.
    for folder in (ROOT,ROOT/'apps/sim'):
        if any(p.name not in ('.env.example','.env.sample') for p in folder.glob('.env*')):
            raise ValueError('ambient_dotenv_refused')
    for executable,version in (('node','v24.22.0'),('bun','1.4.2')):
        assert subprocess.check_output([executable,'--version'],env=environment,timeout=10,text=True).strip()==version
    # Resolve through the application package; supports hoisted and nested installs.
    script="const r=require('node:module').createRequire(process.argv[1]);const p=r.resolve('vitest/package.json');if(r(p).version!=='5.0.1')throw Error('vitest_version_refused');process.stdout.write(require('node:path').join(require('node:path').dirname(p),'vitest.mjs'))"
    vitest=Path(subprocess.check_output(['node','-e',script,str(ROOT/'apps/sim/package.json')],
                                     env=environment,timeout=10,text=True))
    selected=list(GROUPS) if args.group=='all' else [args.group]
    return run_plan(commands(ROOT,selected,vitest=vitest),environment,args.report)


if __name__=='__main__':
    try:code=main()
    except (AssertionError,ValueError,OSError,subprocess.SubprocessError):
        print('Fast-test precondition refused.');code=1
    raise SystemExit(code)
