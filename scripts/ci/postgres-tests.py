#!/usr/bin/env python3
# Copyright 2026 Memlia. All rights reserved.
"""Run the native budget-window family against one newly owned PostgreSQL DB."""
import argparse
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import tempfile
import time
from urllib.parse import quote,unquote,urlsplit,urlunsplit

ROOT=Path(__file__).resolve().parents[2]
PHASES=('bootstrap','migrate','grants','baseline','test','readback','cleanup')


def target(raw):
    if type(raw) is not str or not raw.isascii() or any(ord(c)<33 for c in raw):
        raise ValueError('database_target_refused')
    url=urlsplit(raw)
    port=5432 if url.port is None else url.port
    if (url.scheme not in ('postgres','postgresql') or url.hostname not in ('127.0.0.1','localhost','::1')
            or url.path!='/postgres' or url.query or url.fragment or not 1<=port<=65535
            or not re.fullmatch('[a-z_][a-z0-9_]{0,62}',unquote(url.username or ''))):
        raise ValueError('database_target_refused')
    return url


def environment(raw):
    value={k:v for k,v in raw.items() if k in ('PATH','HOME','TMPDIR','LANG')}
    value.update(CI='true',NODE_ENV='test',NO_COLOR='1',NEXT_TELEMETRY_DISABLED='1',
                 DO_NOT_TRACK='1',PYTHONDONTWRITEBYTECODE='1')
    return value


def configuration(admin,nonce):
    url=target(admin)
    if not re.fullmatch('[a-f0-9]{32}',nonce):raise ValueError('nonce_refused')
    result={'MEMLIA_PG_ADMIN_URL':admin,'MEMLIA_PG_NONCE':nonce}
    for kind,letter in (('MIGRATE','m'),('WEB','w')):
        host='['+url.hostname+']' if url.hostname=='::1' else url.hostname
        authority=f'pgwin_{letter}_{nonce}:{quote(secrets.token_hex(32))}@{host}:{url.port or 5432}'
        result['MEMLIA_PG_'+kind+'_URL']=urlunsplit(('postgres',authority,'/memlia_p06_budget_test','',''))
    return result


def command(root,name):
    if name not in PHASES:raise ValueError('phase_refused')
    if name=='migrate':return ['bun','--no-env-file','./scripts/migrate.ts'],root/'packages/db'
    if name=='test':
        return ['bun','--no-env-file','test','--timeout','10000',
                './lib/memlia/ai/chat-budget-window.integration.test.ts'],root/'apps/sim'
    return ['bun','--no-env-file',str(root/'scripts/ci/postgres-fixture.ts'),name],root


def phase_name(argv):
    if argv[-1] in PHASES:return argv[-1]
    return 'test' if 'test' in argv else 'migrate'


def test_summary(raw):
    return (re.search(rb'(?m)^\s*9 pass\s*$',raw) is not None
            and re.search(rb'(?m)^\s*0 fail\s*$',raw) is not None
            and re.search(rb'(?m)^\s*[1-9][0-9]* (?:skip|todo)\b',raw) is None)


def phase(argv,cwd,env,timeout,test=False):
    # No raw driver/migration/test output, DSN, SQL or exception crosses this boundary.
    with tempfile.TemporaryFile() as output:
        try:
            result=subprocess.run(argv,cwd=cwd,env=env,stdin=subprocess.DEVNULL,stdout=output,stderr=subprocess.STDOUT,
                                  timeout=timeout,check=False)
        except subprocess.TimeoutExpired:return 124,None
        except (OSError,KeyboardInterrupt):return 1,None
        if result.returncode:return result.returncode,None
        if output.tell()>8*1024**2:return 1,None
        output.seek(0);raw=output.read(8*1024**2+1)
    name=phase_name(argv)
    if test:return (0,{'phase':'test','passed':True}) if test_summary(raw) else (1,None)
    if name=='migrate':return 0,{'phase':name,'passed':True}
    try:
        value=json.loads(raw)
        if (type(value) is not dict or set(value) not in ({'phase','passed'},{'phase','passed','digest'})
                or value.get('phase')!=name or value.get('passed') is not True):return 1,None
        if name in ('baseline','readback') and not re.fullmatch('[a-f0-9]{64}',value.get('digest','')):return 1,None
        return 0,value
    except (TypeError,ValueError):return 1,None


def run(root,config,report):
    nonce=config['MEMLIA_PG_NONCE']
    if not re.fullmatch('[a-f0-9]{32}',nonce):raise ValueError('nonce_refused')
    receipt={'status':'failed','phases':[],'resourcesRetained':True,
             'nextBuildExecuted':False,'liveProviderTested':False,'cacheTested':False,
             'namespace':{'nonce':nonce,'database':'memlia_p06_budget_test',
                          'roles':['pgwin_m_'+nonce,'pgwin_w_'+nonce]}}
    # Existing receipt refuses before the first DB effect. Failures retain this owned DB for diagnosis.
    with os.fdopen(os.open(report,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'w') as out:
        json.dump(receipt,out,separators=(',',':'));out.write('\n');out.flush();os.fsync(out.fileno())
        baseline=None
        try:
            for name in PHASES:
                env=environment(os.environ)
                if name in ('bootstrap','grants','cleanup'):env.update(config)
                elif name in ('migrate','baseline','readback'):
                    env.update({k:v for k,v in config.items() if k!='MEMLIA_PG_ADMIN_URL'})
                    env['MIGRATION_DATABASE_URL']=config.get('MEMLIA_PG_MIGRATE_URL','')
                else:
                    env.update(TEST_DATABASE_URL=config.get('MEMLIA_PG_WEB_URL',''),
                               MEMLIA_CHAT_COST_TEST_OWNER_URL=config.get('MEMLIA_PG_MIGRATE_URL',''))
                if baseline:env['MEMLIA_PG_BASELINE']=baseline
                argv,cwd=command(root,name);started=time.monotonic()
                code,value=phase(argv,cwd,env,600 if name=='migrate' else 180,test=name=='test')
                passed=code==0 and value is not None
                if name=='baseline' and passed:baseline=value['digest']
                if name=='readback' and passed:passed=value['digest']==baseline
                receipt['phases'].append({'phase':name,'passed':passed,'exitCode':code,
                                          'reason':None if passed else 'phase_failed',
                                          'seconds':round(time.monotonic()-started,3)})
                if not passed:break
            else:receipt.update(status='passed',resourcesRetained=False)
        finally:
            out.seek(0);json.dump(receipt,out,separators=(',',':'));out.write('\n');out.truncate()
            out.flush();os.fsync(out.fileno())
    return 0 if receipt['status']=='passed' else 1


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--report',required=True,type=Path)
    parser.add_argument('--nonce',help='Optional fresh 32-hex run identity; never authorizes reuse')
    args=parser.parse_args()
    if os.environ.get('MEMLIA_POSTGRES_CONTAINER')=='1':
        cgroup=Path('/sys/fs/cgroup')
        assert (cgroup/'memory.max').read_text().strip()==str(4*1024**3)
        assert (cgroup/'memory.swap.max').read_text().strip()=='0'
        assert (cgroup/'cpu.max').read_text().split()==['200000','100000']
        assert (cgroup/'pids.max').read_text().strip()=='256'
    for folder in (ROOT,ROOT/'apps/sim',ROOT/'packages/db'):
        if any(p.name not in ('.env.example','.env.sample') for p in folder.glob('.env*')):
            raise ValueError('ambient_dotenv_refused')
    selected=ROOT/'apps/sim/lib/memlia/ai/chat-budget-window.integration.test.ts'
    if selected.is_symlink() or not selected.is_file():raise ValueError('selected_test_refused')
    env=environment(os.environ)
    if subprocess.check_output(['bun','--version'],env=env,timeout=10,text=True).strip()!='1.4.2':
        raise ValueError('bun_version_refused')
    config=configuration(os.environ['MEMLIA_PG_CI_ADMIN_URL'],args.nonce or secrets.token_hex(16))
    return run(ROOT,config,args.report)


if __name__=='__main__':
    try:code=main()
    except (AssertionError,KeyError,ValueError,OSError,subprocess.SubprocessError):
        print('PostgreSQL-test precondition refused.');code=1
    raise SystemExit(code)
