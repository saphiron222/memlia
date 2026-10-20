#!/usr/bin/env bash
# Copyright 2026 Memlia. All rights reserved.
# Product validation or full build, dedicated Docker cgroups, bounded metrics and TS locations.
set -euo pipefail
umask 077
scope=build
ui_selected=${MEMLIA_CI_CHAT_UI:-0}
[[ "$ui_selected" == 0 || "$ui_selected" == 1 ]] || exit 2
ui_verified=0; ui_cleanup_failed=0; ui_seeded=0; ui_network_created=0; ui_resources=()
swap_variant=''
if [[ "$#" != 0 ]]; then
  if [[ "$#" == 1 && "$1" == --validation-only ]]; then
    scope=validation
  elif [[ "$#" == 2 && "$1" == --swap ]]; then
    case "$2" in webpack|turbopack|turbopack-zram) swap_variant="$2";;
      *) echo 'Unsupported validation mode' >&2; exit 2;; esac
  else
    echo 'Unsupported validation mode' >&2; exit 2
  fi
fi
[[ "$ui_selected" == 0 || ( "$scope" == build && "$swap_variant" == turbopack ) ]] || exit 2
root="$(git rev-parse --show-toplevel)"
: "${RUNNER_TEMP:?GitHub runner temporary directory required}"
if [[ -n "$swap_variant" && "${MEMLIA_SWAP_HOST_READY:-}" != 1 ]]; then
  exec python3 "$root/scripts/ci/linux-swap-host.py" "$swap_variant"
fi
metrics="$RUNNER_TEMP/memlia-metrics"
[[ ! -e "$metrics" ]] || { echo 'Metrics directory already exists'; exit 1; }
mkdir "$metrics"
private="$(mktemp -d "$RUNNER_TEMP/memlia-build.XXXXXXXX")"
mkdir "$private/tmp" "$private/tools"
prefix="memlia-build-$(python3 -c 'import secrets; print(secrets.token_hex(6))')"
image='node:24.22.0-bookworm@sha256:14078204b6bb268c107ceff6d3c43f45a888105e5c2b18b14c32b3409d93a1b0'
postgres='pgvector/pgvector:pg17@sha256:ac08538c6f8b9904c33c8224c5e5706dbe760aca29db1d096972b4052c22a75d'
containers=()
network_created=0
completed=0
next_started=0
standalone_verified=0
current_stage=bootstrap
database_ready_exit_code=''
database_init_exit_code=''
cleanup() {
  result=$?
  local -r primary_stage="${current_stage:-bootstrap}"
  trap - EXIT INT TERM
  set +e
  cleanup_ok=1
  receipt_ok=1
  if [[ "${ui_selected:-0}" == 1 ]] && declare -f ui_close > /dev/null; then ui_close || cleanup_ok=0; fi
  for name in "${containers[@]}"; do
    if [[ "$name" == "$prefix-ui-web" || "$name" == "$prefix-ui-realtime" || "$name" == "$prefix-ui-cache" ]] && ! ui_owns "$name"; then cleanup_ok=0; continue; fi
    if docker inspect "$name" > /dev/null 2>&1; then
      docker rm -fv "$name" > /dev/null 2>&1 || cleanup_ok=0
    fi
    remaining="$(docker ps -a --filter "name=^/${name}$" --format '{{.Names}}' 2>/dev/null)"
    [[ $? == 0 && -z "$remaining" ]] || cleanup_ok=0
  done
  if [[ "${ui_network_created:-0}" == 1 ]]; then
    if [[ "$(docker network inspect --format '{{.Id}} {{index .Labels "org.memlia.ci"}}' "$prefix-ui" 2>/dev/null)" == "$(cat "$private/ui-network.log") $prefix" ]]; then
      docker network rm "$prefix-ui" > /dev/null 2>&1 || cleanup_ok=0
    else cleanup_ok=0; fi
  fi
  if [[ "$network_created" == 1 ]]; then
    docker network rm "$prefix" > /dev/null 2>&1 || cleanup_ok=0
  fi
  if [[ "$private" == "$RUNNER_TEMP"/memlia-build.* ]]; then
    rm -rf -- "$private" || cleanup_ok=0
  else
    cleanup_ok=0
  fi
  python3 - "$metrics/result.json" "$result" "$completed" "$cleanup_ok" \
    "$primary_stage" "${database_ready_exit_code:-}" "${database_init_exit_code:-}" \
    "${scope:-build}" "${next_started:-0}" "${standalone_verified:-0}" "${ui_selected:-0}" "${ui_verified:-0}" <<'PY' || receipt_ok=0
import json,sys
from pathlib import Path
def exit_code(value, optional=False):
    if optional and value=='': return None
    if not (value.isascii() and value.isdigit() and len(value)<=3 and int(value)<=255):
        raise ValueError('Invalid bounded command exit code')
    return int(value)
code=exit_code(sys.argv[2]); completed,cleanup=map(int,sys.argv[3:5]); stage=sys.argv[5]
allowed={'bootstrap','host','pull_node','pull_database','download_bun','verify_bun','extract_bun',
         'prepare_database','create_network','start_database','database_readiness','database_initialization',
         'phase_test','phase_install','toolchain','phase_inventory','phase_typegen','phase_typecheck',
         'phase_cli','phase_sandbox','phase_config','phase_next','phase_standalone','completed','validation_completed'}
allowed.update({'ui_browser_install','ui_prepare','ui_services','ui_readiness','ui_browser',*[f'phase_ui-{p}' for p in ('bootstrap','migrate','grants','metadata','baseline','seed','stage','cleanup','readback')]})
allowed.update({'ui_network_create','ui_network_connect','ui_network_identity','ui_cache_pull',
                'ui_cache_start','ui_cache_inspect','ui_realtime','ui_web'})
ui_selected,ui_verified=map(int,sys.argv[11:13]);assert ui_selected in (0,1) and ui_verified in (0,1)
scope=sys.argv[8]; next_started,standalone=map(int,sys.argv[9:11])
assert stage in allowed and completed in (0,1) and cleanup in (0,1), 'Invalid fixed build diagnostic'
assert scope in ('build','validation') and next_started in (0,1) and standalone in (0,1), 'Invalid validation diagnostic'
normal=code==0 and completed and cleanup and (not ui_selected or ui_verified)
validation_passed=normal and scope=='validation' and stage=='validation_completed' and not next_started and not standalone
build_passed=normal and scope=='build' and stage=='completed' and next_started and standalone
status='validation_passed' if validation_passed else 'passed' if build_passed else 'failed'
Path(sys.argv[1]).write_text(json.dumps({'exitCode':code,'stage':stage,
    'databaseReadyExitCode':exit_code(sys.argv[6],True),'databaseInitExitCode':exit_code(sys.argv[7],True),
    'normalCompletion':bool(completed),'cleanup':bool(cleanup),
    'uiSelected':bool(ui_selected),'uiVerified':bool(ui_verified),'scope':scope,'nextStarted':bool(next_started),'standaloneVerified':bool(standalone),
    'buildStatus':'passed' if build_passed else 'not_run' if not next_started else 'failed',
    'status':status},indent=2)+'\n')
if status=='failed': raise SystemExit(1)
PY
  # Only our fixed-schema JSON receipts are shown; no raw build logs/artifacts.
  python3 - "$metrics" <<'PY' || receipt_ok=0
import json,sys
from pathlib import Path
for path in sorted(Path(sys.argv[1]).glob('*.json')):
    if path.name in ('chat-ui.json','ui-readiness.json','ui-service-web.json','ui-service-realtime.json','ui-service-cache.json'):
        import os,stat
        if Path(sys.argv[1]).is_symlink() or path.is_symlink(): raise SystemExit('Invalid UI receipt')
        fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
        with os.fdopen(fd,'rb') as f:
            if not stat.S_ISREG(os.fstat(f.fileno()).st_mode): raise SystemExit('Invalid UI receipt')
            data=f.read(4097)
        if len(data)>4096: raise SystemExit('Invalid UI receipt')
        receipt=json.loads(data)
        if type(receipt)is not dict:raise SystemExit('Invalid UI receipt')
        if path.name=='chat-ui.json':
            flags={'authenticated','socket','workflow','canvas','chatRefused','browserClosed'}
            if set(receipt)!=flags|{'status','reason'}: raise SystemExit('Invalid UI receipt')
            if any(type(receipt[k])is not bool for k in flags): raise SystemExit('Invalid UI receipt')
            if receipt['status'] not in ('passed','failed') or receipt['reason'] not in (None,'cleanup_failed','journey_failed'): raise SystemExit('Invalid UI receipt')
            if (receipt['status']=='passed') != (receipt['reason'] is None and all(receipt[k] for k in flags)): raise SystemExit('Invalid UI receipt')
        elif path.name=='ui-readiness.json':
            if set(receipt)!={'phase','status','service','httpStatus','errorClass'} or receipt['phase']!='ui-readiness':raise SystemExit('Invalid UI receipt')
            if receipt['status'] not in ('passed','failed') or receipt['service'] not in ('realtime','web'):raise SystemExit('Invalid UI receipt')
            if receipt['httpStatus'] is not None and (type(receipt['httpStatus'])is not int or not 100<=receipt['httpStatus']<=599):raise SystemExit('Invalid UI receipt')
            if receipt['errorClass'] not in (None,'timeout','connection','http','os','unexpected'):raise SystemExit('Invalid UI receipt')
            if receipt['status']=='passed' and (receipt['service']!='web' or receipt['httpStatus']!=200 or receipt['errorClass']is not None):raise SystemExit('Invalid UI receipt')
        else:
            if set(receipt)!={'phase','service','running','oomKilled','errorPresent'} or receipt['phase']!='ui-service-state':raise SystemExit('Invalid UI receipt')
            if receipt['service'] not in ('web','realtime','cache') or path.name!='ui-service-'+receipt['service']+'.json':raise SystemExit('Invalid UI receipt')
            if any(type(receipt[k])is not bool for k in ('running','oomKilled','errorPresent')):raise SystemExit('Invalid UI receipt')
    else: receipt=json.loads(path.read_text())
    print(json.dumps(receipt,sort_keys=True))
PY
  [[ "$completed" == 1 && "$cleanup_ok" == 1 && "$receipt_ok" == 1 && "$result" == 0 ]] || exit 1
  exit 0
}
trap cleanup EXIT
trap 'exit 130' INT TERM
current_stage=host
python3 - "$metrics/host.json" "$root" "$swap_variant" <<'PY'
import hashlib,json,os,platform,shutil,subprocess,sys
from pathlib import Path
mem = {k:int(v.split()[0])*1024 for k,v in (x.split(':',1) for x in Path('/proc/meminfo').read_text().splitlines())}
root=Path(sys.argv[2]); disk=shutil.disk_usage(root)
receipt={'sourceCommit':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'lockSha256':hashlib.sha256((root/'bun.lock').read_bytes()).hexdigest(),'architecture':platform.machine(),'kernel':platform.release(),'cpuCount':os.cpu_count(),'hostMemTotalBytes':mem['MemTotal'],'hostMemAvailableBytes':mem['MemAvailable'],'hostSwapTotalBytes':mem['SwapTotal'],'hostSwapUsedBytes':mem['SwapTotal']-mem['SwapFree'],'diskFreeBytes':disk.free,'buildCgroupLimitBytes':13*1024**3,'databaseLimitBytes':512*1024**2,'v8OldSpaceMiB':10240,'nextV8OldSpaceMiB':11264,'bundler':'webpack','webpackCacheProfile':'memory','nextWorkers':2,'runnerImageOS':os.environ.get('ImageOS'),'runnerImageVersion':os.environ.get('ImageVersion')}
if sys.argv[3]:
    variant=sys.argv[3]
    assert variant in ('webpack','turbopack','turbopack-zram')
    import importlib.util
    spec=importlib.util.spec_from_file_location('swap_host',root/'scripts/ci/linux-swap-host.py')
    swap_host=importlib.util.module_from_spec(spec); spec.loader.exec_module(swap_host)
    zram=os.environ.get('MEMLIA_ZRAM_DEVICE')
    assert bool(zram)==(variant=='turbopack-zram')
    swap_host.verify_active_swap(os.environ['RUNNER_TEMP'],os.environ['MEMLIA_SWAP_FILE'],zram)
    receipt.update({'experiment':variant,'nextV8OldSpaceMiB':24576 if variant=='webpack' else 11264,
                    'bundler':'webpack' if variant=='webpack' else 'turbopack',
                    'webpackCacheProfile':'memory' if variant=='webpack' else 'not_applied',
                    'nextSwapLimitBytes':24*1024**3,'nextMemoryAndSwapBytes':37*1024**3,
                    'turbopackNativeMemoryBoundedByV8':False})
Path(sys.argv[1]).write_text(json.dumps(receipt,indent=2)+'\n')
assert platform.machine()=='x86_64'
assert mem['MemTotal']>=14*1024**3 and mem['MemAvailable']>=13*1024**3
assert disk.free>=8*1024**3
assert not (root/'node_modules').exists() and not (root/'apps/sim/.next').exists() and not (root/'.turbo').exists()
PY
# No cache restore or global cache/SDK deletion on the runner.
# Private inventory from the public commit, never printed or uploaded.
python3 - "$root" "$private/tracked-sources.json" <<'PY'
import importlib.util,sys
from pathlib import Path
module=Path(sys.argv[1])/'scripts/ci/linux-build-metrics.py'
spec=importlib.util.spec_from_file_location('metrics',module)
metrics=importlib.util.module_from_spec(spec); spec.loader.exec_module(metrics)
try:
    metrics.write_tracked_sources(Path(sys.argv[1]),Path(sys.argv[2]))
except Exception:
    raise SystemExit('Tracked source inventory unavailable')
PY
current_stage=pull_node
docker pull --platform linux/amd64 "$image" > "$private/pull-node.log" 2>&1
current_stage=pull_database
docker pull --platform linux/amd64 "$postgres" > "$private/pull-db.log" 2>&1
current_stage=download_bun
curl --fail --location --silent --show-error --retry 2 --max-time 120 \
  https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-linux-x64.zip \
  --output "$private/bun.zip" 2> "$private/download.log"
current_stage=verify_bun
printf '%s  %s\n' '36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913' "$private/bun.zip" | sha256sum --check > "$private/checksum.log"
current_stage=extract_bun
unzip -q "$private/bun.zip" -d "$private/tools"
current_stage=prepare_database
python3 - "$private" "$ui_selected" <<'PY'
from pathlib import Path
import secrets,sys
root=Path(sys.argv[1]); admin=secrets.token_hex(32); password=secrets.token_hex(32)
(root/'postgres.env').write_text(f'POSTGRES_PASSWORD={admin}\nPOSTGRES_DB=memlia_build\n')
values={'DATABASE_URL':f'postgresql://memlia_build:{password}@database:5432/memlia_build','MIGRATION_DATABASE_URL':f'postgresql://memlia_build:{password}@database:5432/memlia_build','BETTER_AUTH_SECRET':secrets.token_hex(32),'ENCRYPTION_KEY':secrets.token_hex(32),'INTERNAL_API_SECRET':secrets.token_hex(32),'BETTER_AUTH_URL':'http://localhost:3000','NEXT_PUBLIC_APP_URL':'http://localhost:3000','NEXT_PUBLIC_SOCKET_URL':'http://localhost:3002','DOCKER_BUILD':'true','MEMLIA_LOCAL_BUILD':'1','NODE_OPTIONS':'--max-old-space-size=10240','NEXT_TELEMETRY_DISABLED':'1','DO_NOT_TRACK':'1','SENTRY_DSN':'','NEXT_PUBLIC_SENTRY_DSN':'','HOME':'/scratch','TMPDIR':'/scratch/tmp','CI':'true'}
if sys.argv[2]=='1': values.update({'NEXT_PUBLIC_BILLING_ENABLED':'false','NEXT_PUBLIC_CHAT_DISABLED':'false','NEXT_PUBLIC_POSTHOG_ENABLED':'false'})
(root/'build.env').write_text(''.join(f'{k}={v}\n' for k,v in values.items()))
(root/'database.sql').write_text(f"CREATE ROLE memlia_build LOGIN PASSWORD '{password}' NOSUPERUSER NOCREATEDB NOCREATEROLE;\nALTER DATABASE memlia_build OWNER TO memlia_build;\nCREATE EXTENSION IF NOT EXISTS vector;\nALTER SCHEMA public OWNER TO memlia_build;\n")
PY
current_stage=create_network
docker network create "$prefix" > "$private/network.log" 2>&1
network_created=1
containers+=("$prefix-database")
current_stage=start_database
docker run -d --name "$prefix-database" --network "$prefix" --network-alias database \
  --memory 512m --memory-swap 512m --cpus 1 --env-file "$private/postgres.env" \
  "$postgres" > "$private/database.log" 2>&1
current_stage=database_readiness
ready=0
for attempt in {1..40}; do
  if docker exec "$prefix-database" pg_isready -h 127.0.0.1 -p 5432 -t 1 -U postgres -d memlia_build > /dev/null 2>&1; then
    database_ready_exit_code=0; ready=1; break
  else
    database_ready_exit_code=$?
  fi
  sleep 1
done
[[ "$ready" == 1 ]] || exit 1
current_stage=database_initialization
database_init_exit_code=0
docker exec -i "$prefix-database" psql -v ON_ERROR_STOP=1 -U postgres -d memlia_build \
  < "$private/database.sql" > "$private/database-init.log" 2>&1 || database_init_exit_code=$?
[[ "$database_init_exit_code" == 0 ]] || exit "$database_init_exit_code"
phase() {
  local label="$1" cwd="$2"
  current_stage="phase_$label"
  shift 2
  python3 - "$root" <<'PY' || return 1
import shutil,sys
assert shutil.disk_usage(sys.argv[1]).free >= 2*1024**3, 'disk reserve exhausted'
PY
  local name="$prefix-$label"
  containers+=("$name")
  local code=0
  local phase_env="$private/build.env"
  if [[ "$label" == ui-* && "$label" != ui-stage ]]; then phase_env="$private/$label.env"; fi
  local phase_mounts=(--mount "type=bind,source=$private,target=/scratch")
  if [[ "$label" == ui-* ]]; then phase_mounts=(--mount "type=bind,source=$private/ui-runtime,target=/scratch" --mount "type=bind,source=$private/ui,target=/scratch/ui"); fi
  local memory_swap=13g
  local metrics_extra=() env_extra=()
  if [[ -n "${swap_variant:-}" ]]; then
    env_extra+=(--env "MEMLIA_SWAP_VARIANT=$swap_variant")
    if [[ "$label" == next ]]; then
      memory_swap=37g
      metrics_extra+=(--experiment "$swap_variant" --timeout 6000)
    fi
  fi
  local phase_runner=(docker)
  if [[ "$label" == standalone ]]; then metrics_extra+=(--timeout 120); fi
  if [[ "$label" == ui-* ]]; then
    local reserve=150 maximum=120 remaining
    if [[ "$label" == ui-cleanup || "$label" == ui-readback ]]; then reserve=0; maximum=60; fi
    remaining="$(ui_remaining "$maximum" "$reserve")" || return 1
    (( remaining > 5 )) || return 1
    metrics_extra+=(--timeout "$((remaining - 5))")
    phase_runner=(timeout --kill-after=2 "$remaining" docker)
  fi
  local phase_network="$prefix"
  if [[ "$label" == ui-cleanup || "$label" == ui-readback ]] && [[ "$ui_network_created" == 1 ]]; then phase_network="$prefix-ui"; fi
  "${phase_runner[@]}" run --name "$name" --platform linux/amd64 --network "$phase_network" \
    --user "$(id -u):$(id -g)" --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    --memory 13g --memory-swap "$memory_swap" --cpus 4 --pids-limit 512 \
    --env-file "$phase_env" "${env_extra[@]}" --env PATH=/tools/bun-linux-x64:/usr/local/bin:/usr/bin:/bin \
    --mount "type=bind,source=$root,target=/work" \
    "${phase_mounts[@]}" \
    --mount "type=bind,source=$private/tools,target=/tools,readonly" \
    --mount "type=bind,source=$private/tracked-sources.json,target=/scratch/tracked-sources.json,readonly" \
    --mount "type=bind,source=$metrics,target=/metrics" --workdir "$cwd" \
    "$image" python3 /work/scripts/ci/linux-build-metrics.py --phase "$label" \
    --report "/metrics/$label.json" "${metrics_extra[@]}" --tracked-sources /scratch/tracked-sources.json --source-root /work -- "$@" > "$private/$label.log" 2>&1 || code=$?
  if [[ -n "${swap_variant:-}" && "$label" == next ]]; then
    docker inspect --format '{{json .HostConfig}}' "$name" > "$private/limits.json"
    python3 - "$private/limits.json" "$metrics/next-limits.json" <<'PYLIMITS'
import json,sys
from pathlib import Path
raw=json.loads(Path(sys.argv[1]).read_text())
receipt={key:raw[key] for key in ('Memory','MemorySwap','NanoCpus','PidsLimit')}
Path(sys.argv[2]).write_text(json.dumps(receipt,indent=2)+'\n')
assert receipt=={'Memory':13*1024**3,'MemorySwap':37*1024**3,'NanoCpus':4000000000,'PidsLimit':512}
PYLIMITS
  fi
  docker inspect --format '{{json .State}}' "$name" > "$private/state.json"
  python3 - "$metrics/$label-container.json" "$private/state.json" "$code" "$metrics/$label.json" <<'PY'
import json,sys
from pathlib import Path
state=json.loads(Path(sys.argv[2]).read_text())
receipt={'dockerExitCode':int(sys.argv[3]),'containerExitCode':state['ExitCode'],'oomKilled':state['OOMKilled'],'running':state['Running'],'receiptPresent':Path(sys.argv[4]).is_file()}
Path(sys.argv[1]).write_text(json.dumps(receipt,indent=2)+'\n')
assert receipt['dockerExitCode']==0 and receipt['containerExitCode']==0 and not receipt['oomKilled'] and not receipt['running'] and receipt['receiptPresent']
PY
}
phase test /work sh -ec 'python3 scripts/ci/test-linux-build-metrics.py -v; python3 scripts/ci/test-linux-standalone-smoke.py -v'
phase install /work sh -ec 'test "$(node --version)" = v24.22.0; test "$(bun --version)" = 1.4.2; sha256sum bun.lock > /scratch/lock.sha256; bun install --frozen-lockfile --ignore-scripts; sha256sum -c /scratch/lock.sha256'
current_stage=toolchain
docker run --rm --network none --user "$(id -u):$(id -g)" --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --memory 256m --memory-swap 256m \
  --mount "type=bind,source=$root,target=/work,readonly" \
  --mount "type=bind,source=$private/tools,target=/tools,readonly" \
  --mount "type=bind,source=$metrics,target=/metrics" "$image" python3 -c '
import hashlib,json,re,subprocess
from pathlib import Path
node=Path("/usr/local/bin/node"); bun=Path("/tools/bun-linux-x64/bun")
r={"node":subprocess.check_output([str(node),"--version"],text=True).strip(),"bun":subprocess.check_output([str(bun),"--version"],text=True).strip(),"nodeSha256":hashlib.sha256(node.read_bytes()).hexdigest(),"bunSha256":hashlib.sha256(bun.read_bytes()).hexdigest()}
for name in ["next","typescript"]: r[name]=json.loads((Path("/work/node_modules")/name/"package.json").read_text())["version"]
manifest=json.loads(Path("/work/apps/sim/package.json").read_text())
overrides=json.loads(Path("/work/package.json").read_text())["overrides"]
expected=manifest["dependencies"]["next"]
assert isinstance(expected,str) and re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+",expected), "Exact Next pin required"
assert overrides["next"]==expected and r["next"]==expected, "Installed Next differs from versioned pin"
r["expectedNext"]=expected
Path("/metrics/toolchain.json").write_text(json.dumps(r,indent=2)+"\n")
assert r["node"]=="v24.22.0" and r["bun"]=="1.4.2" and r["typescript"]=="7.0.2"
' > "$private/toolchain.log" 2>&1
# The UI has a separate 1,200s ceiling, still subordinate to the swap host deadline.
# Reserve 150s for expected service stops, native cleanup and readback.
ui_remaining() {
  local maximum="$1" reserve="$2" left
  left=$((ui_deadline - SECONDS - reserve))
  (( left > 0 )) || return 1
  if (( left < maximum )); then printf '%s\n' "$left"; else printf '%s\n' "$maximum"; fi
}
ui_docker() {
  local maximum=30 reserve=150 remaining
  [[ "$1" != pull ]] || maximum=120
  [[ "${ui_closing:-0}" != 1 ]] || reserve=0
  remaining="$(ui_remaining "$maximum" "$reserve")" || return 1
  timeout --kill-after=5 "$remaining" docker "$@"
}
# Fixed, opt-in synthetic journey. Reuses this build and the owned resource trap.
run_ui_journey() {
  ui_deadline=$((SECONDS + 1200))
  current_stage=ui_browser_install
  [[ "$(node --version)" == v24.22.0 ]] || return 1
  ui_node="$(command -v node)"
  export PLAYWRIGHT_BROWSERS_PATH="$private/chromium"
  local ui_cli
  ui_cli="$("$ui_node" --input-type=module - "$root" <<'JSUI'
import { createRequire } from 'node:module'
const native = createRequire(process.argv[2] + '/apps/sim/package.json')
if (native('@playwright/test/package.json').version !== '1.61.1') throw Error('browser_version_refused')
process.stdout.write(native.resolve('@playwright/test/cli'))
JSUI
)" || return 1
  timeout --kill-after=5 "$(ui_remaining 300 150)" "$ui_node" "$ui_cli" install --with-deps chromium > "$private/browser-install.log" 2>&1
  [[ "$(wc -c < "$private/browser-install.log")" -le 8388608 ]] || return 1
  current_stage=ui_prepare
  python3 - "$private" "$prefix" <<'PYUI'
import json,secrets,sys,uuid
from pathlib import Path
p=Path(sys.argv[1]);nonce=secrets.token_hex(16);d=p/'ui';d.mkdir(mode=0o700);(p/'ui-runtime').mkdir(mode=0o700);(p/'ui-runtime/tmp').mkdir(mode=0o700)
admin=dict(x.split('=',1) for x in (p/'postgres.env').read_text().splitlines())['POSTGRES_PASSWORD']
passwords={role:secrets.token_hex(32) for role in ('migrate','web','realtime')}
database='memlia_ui_'+nonce
url=lambda role: f"postgres://ui_{role}_{nonce}:{passwords[role]}@database:5432/{database}"
base={'PATH':'/tools/bun-linux-x64:/usr/local/bin:/usr/bin:/bin','HOME':'/scratch','TMPDIR':'/scratch/tmp','NODE_ENV':'production','RECIPE_NONCE':nonce,'NEXT_TELEMETRY_DISABLED':'1','DO_NOT_TRACK':'1','CI':'true'}
shared={**base,'DATABASE_URL':url('web'),'BETTER_AUTH_SECRET':secrets.token_hex(32),'ENCRYPTION_KEY':secrets.token_hex(32),'INTERNAL_API_SECRET':secrets.token_hex(32),'BETTER_AUTH_URL':'http://localhost:3000','NEXT_PUBLIC_APP_URL':'http://localhost:3000','NEXT_PUBLIC_SOCKET_URL':'http://localhost:3002','SOCKET_SERVER_URL':'http://realtime:3002','INTERNAL_API_BASE_URL':'http://web:3000','REDIS_URL':'redis://valkey:6379/0','DISABLE_AUTH':'false','DISABLE_REGISTRATION':'true','DISABLE_EMAIL_SIGNUP':'true','EMAIL_VERIFICATION_ENABLED':'false','BILLING_ENABLED':'false','NEXT_PUBLIC_BILLING_ENABLED':'false','NEXT_PUBLIC_CHAT_DISABLED':'false','NEXT_PUBLIC_POSTHOG_ENABLED':'false','COPILOT_TOOL_PERMISSIONS_ENABLED':'true','MEMLIA_CHAT_POLICY_FILE':'/etc/memlia/chat-policy.json','TRUSTED_ORIGINS':'http://localhost:3000','SIM_DB_ROLE':'web','DB_APP_NAME':'memlia-ci-ui','MEMLIA_LOCAL_BUILD':'1','DOCKER_BUILD':'true','HOSTNAME':'0.0.0.0','PORT':'3000'}
def env(name,values):
    assert all('\n' not in v and '\x00' not in v for v in values.values())
    (p/(name+'.env')).write_text(''.join(k+'='+v+'\n' for k,v in values.items()))
env('ui-bootstrap',{**base,'RECIPE_ADMIN_URL':f'postgres://postgres:{admin}@database:5432/postgres',**{'RECIPE_'+k.upper()+'_PASSWORD':v for k,v in passwords.items()}})
env('ui-grants',{**base,'RECIPE_ADMIN_URL':f'postgres://postgres:{admin}@database:5432/{database}'})
env('ui-migrate',{**base,'DATABASE_URL':url('migrate'),'MIGRATION_DATABASE_URL':url('migrate')})
env('ui-metadata',{**base,'MIGRATION_DATABASE_URL':url('migrate')})
for name in ('ui-baseline','ui-readback','ui-seed','ui-cleanup','ui-web'):env(name,shared)
env('ui-realtime',{**base,'DATABASE_URL':url('realtime'),'DATABASE_URL_REALTIME':url('realtime'),'SIM_DB_ROLE':'realtime','BETTER_AUTH_SECRET':shared['BETTER_AUTH_SECRET'],'INTERNAL_API_SECRET':shared['INTERNAL_API_SECRET'],'BETTER_AUTH_URL':shared['BETTER_AUTH_URL'],'NEXT_PUBLIC_APP_URL':'http://web:3000','ALLOWED_ORIGINS':'http://localhost:3000','DISABLE_AUTH':'false','REDIS_URL':shared['REDIS_URL'],'PORT':'3002','REALTIME_HOST':'0.0.0.0'})
fixture={'userId':str(uuid.uuid4()),'accountId':str(uuid.uuid4()),'statsId':str(uuid.uuid4()),'email':'ci-'+uuid.uuid4().hex+'@example.invalid','password':secrets.token_urlsafe(24),'origin':'http://localhost:3000','realtimeOrigin':'http://localhost:3002','socketBucketKeys':[]}
(d/'credentials.private.json').write_text(json.dumps(fixture)+'\n')
(p/'ui-policy.json').write_text('{}\n')
PYUI
  sudo chown 0:0 "$private/ui-policy.json"
  sudo chmod 444 "$private/ui-policy.json"
  # Role-specific environments never reach the browser; the runtime has no owner DSN.
  phase ui-bootstrap /work/packages/db bun --no-env-file /work/scripts/ci/linux-chat-fixture.ts bootstrap
  phase ui-migrate /work/packages/db bun --no-env-file ./scripts/migrate.ts
  phase ui-grants /work/packages/db bun --no-env-file /work/scripts/ci/linux-chat-fixture.ts grants
  phase ui-metadata /work/packages/db bun --no-env-file /work/scripts/ci/linux-chat-fixture.ts metadata
  phase ui-baseline /work/packages/db bun --no-env-file /work/scripts/ci/linux-chat-fixture.ts baseline
  ui_seeded=1 # cleanup must run even if seed partially succeeds then reports failure.
  phase ui-seed /work/apps/sim bun --no-env-file --tsconfig-override /work/apps/sim/tsconfig.json /work/scripts/ci/linux-chat-fixture.ts seed
  phase ui-stage /work/apps/sim python3 -c '
import importlib.util
from pathlib import Path
s=importlib.util.spec_from_file_location("smoke","/work/scripts/ci/linux-standalone-smoke.py");m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
a=Path("/work/apps/sim");m.verify_artifacts(a,True);p=Path("/scratch/ui-stage");p.mkdir();m.stage_artifacts(a,p)
'
  current_stage=ui_network_create
  ui_docker network create --internal --label "org.memlia.ci=$prefix" "$prefix-ui" > "$private/ui-network.log" 2>&1
  ui_network_created=1
  current_stage=ui_network_connect
  ui_docker network connect --alias database "$prefix-ui" "$prefix-database" > "$private/ui-network-connect.log" 2>&1
  current_stage=ui_network_identity
  python3 - "$private" "$prefix-ui" <<'PYUI'
import json,subprocess,sys
from pathlib import Path
p=Path(sys.argv[1]);raw=json.loads(subprocess.check_output(['docker','network','inspect',sys.argv[2]],timeout=10))[0]
assert raw['Internal'] and raw['Labels']=={'org.memlia.ci':sys.argv[2].removesuffix('-ui')}
gateway=raw['IPAM']['Config'][0]['Gateway']
assert all(c in '0123456789.' for c in gateway)
f=p/'ui/credentials.private.json';value=json.loads(f.read_text());value['socketBucketKeys']=['route:socket-token-ip:ip:'+gateway,'route:socket-token-ip:ip:::ffff:'+gateway];f.write_text(json.dumps(value)+'\n')
PYUI
  local cache_image='valkey/valkey:8.1.10-alpine@sha256:081c2f5cb575efc901aa80ff9cdbd1ec6a301682fd35e1ebb4b0990a4a4a8507'
  current_stage=ui_cache_pull
  ui_docker pull --platform linux/amd64 "$cache_image" > "$private/ui-cache-pull.log" 2>&1
  current_stage=ui_cache_start
  containers+=("$prefix-ui-cache"); ui_cache_started=1
  ui_docker run -d --name "$prefix-ui-cache" --label "org.memlia.ci=$prefix" --network "$prefix-ui" --network-alias valkey --memory 128m --memory-swap 128m --cpus .5 --pids-limit 64 --read-only --tmpfs /data:rw,noexec,nosuid,nodev,size=64m --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges:true "$cache_image" valkey-server --save '' --appendonly no > "$private/ui-cache-start.log" 2> "$private/ui-cache-start-error.log"
  current_stage=ui_cache_inspect
  ui_owns "$prefix-ui-cache"
  ui_inspect cache 134217728 500000000 64 1000:1000
  current_stage=ui_realtime
  ui_service realtime 256m .5 96 /work/apps/realtime 3002 bun --no-env-file --tsconfig-override /work/apps/realtime/tsconfig.json src/index.ts
  current_stage=ui_web
  ui_service web 5g 2 256 /scratch/ui-stage/apps/sim 3000 node server.js
  current_stage=ui_readiness
  local readiness_seconds
  readiness_seconds="$(ui_remaining 180 150)" || return 1
  python3 - "$readiness_seconds" "$metrics/ui-readiness.json" <<'PYUI'
import http.client,json,time,sys
from pathlib import Path
end=time.monotonic()+int(sys.argv[1])
receipt={'phase':'ui-readiness','status':'failed','service':'realtime','httpStatus':None,'errorClass':None}
def error_class(error):
    if isinstance(error,TimeoutError):return 'timeout'
    if isinstance(error,ConnectionError):return 'connection'
    if isinstance(error,http.client.HTTPException):return 'http'
    if isinstance(error,OSError):return 'os'
    return 'unexpected'
try:
    for service,port,path in (('realtime',3002,'/health'),('web',3000,'/login')):
        receipt.update(service=service,httpStatus=None,errorClass=None)
        while True:
            if time.monotonic()>=end: raise SystemExit(1)
            c=http.client.HTTPConnection('localhost',port,timeout=min(2,end-time.monotonic()))
            try:
                c.request('GET',path);r=c.getresponse()
                if type(r.status)is not int or not 100<=r.status<=599:raise http.client.HTTPException()
                receipt.update(httpStatus=r.status,errorClass=None)
                if r.status==200:break
            except (OSError,TimeoutError) as error:receipt['errorClass']=error_class(error)
            finally:c.close()
            time.sleep(.5)
    receipt['status']='passed'
except Exception as error:
    receipt['errorClass']=error_class(error)
    raise SystemExit(1) from None
finally:
    Path(sys.argv[2]).write_text(json.dumps(receipt,sort_keys=True)+'\n')
PYUI
  current_stage=ui_browser
  # No inherited app environment, keys or DSNs in the host browser process.
  local code=0
  timeout --kill-after=5 "$(ui_remaining 900 150)" env -i PATH=/usr/bin:/bin HOME="$private" TMPDIR="$private/tmp" PLAYWRIGHT_BROWSERS_PATH="$private/chromium" \
    "$ui_node" "$root/scripts/ci/linux-chat-browser.mjs" "$root" "$private/ui/credentials.private.json" "$metrics/chat-ui.json" > "$private/ui-browser.log" 2>&1 || code=$?
  [[ "$(wc -c < "$private/ui-browser.log")" -le 8388608 && "$code" == 0 ]] || return 1
  ui_close || return 1
  (( SECONDS <= ui_deadline )) || return 1
  ui_verified=1
}
ui_service() {
  local mode="$1" memory="$2" cpu="$3" pids="$4" cwd="$5" port="$6"; shift 6
  local name="$prefix-ui-$mode"; containers+=("$name"); ui_resources+=("$name")
  ui_docker run -d --name "$name" --label "org.memlia.ci=$prefix" --platform linux/amd64 --network "$prefix-ui" --network-alias "$mode" \
    --publish "127.0.0.1:$port:$port" --init --user "$(id -u):$(id -g)" --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    --memory "$memory" --memory-swap "$memory" --cpus "$cpu" --pids-limit "$pids" \
    --env-file "$private/ui-$mode.env" --mount "type=bind,src=$root,dst=/work,readonly" --mount "type=bind,src=$private/ui-runtime,dst=/scratch" --mount "type=bind,src=$private/ui-policy.json,dst=/etc/memlia/chat-policy.json,readonly" \
    --mount "type=bind,src=$private/tools,dst=/tools,readonly" --workdir "$cwd" "$image" "$@" > "$private/ui-$mode-start.log" 2> "$private/ui-$mode-start-error.log"
  ui_owns "$name"
  if [[ "$mode" == web ]]; then ui_inspect web 5368709120 2000000000 256 "$(id -u):$(id -g)";
  else ui_inspect realtime 268435456 500000000 96 "$(id -u):$(id -g)"; fi
}
ui_inspect() {
  local mode="$1"; shift
  ui_owns "$prefix-ui-$mode" || return 1
  ui_docker inspect "$prefix-ui-$mode" > "$private/ui-$mode-inspect.json"
  python3 - "$private/ui-$mode-inspect.json" "$prefix" "$mode" "$@" <<'PYUI'
import json,sys
raw=json.load(open(sys.argv[1]))[0];h=raw['HostConfig'];mode=sys.argv[3]
assert raw['State']['Running'] and not raw['State']['OOMKilled']
assert raw['Config']['User']==sys.argv[7] and raw['Config']['Labels']['org.memlia.ci']==sys.argv[2]
assert h['ReadonlyRootfs'] and 'ALL' in h['CapDrop'] and 'no-new-privileges:true' in h['SecurityOpt']
assert (h['Memory'],h['MemorySwap'],h['NanoCpus'],h['PidsLimit'])==(int(sys.argv[4]),int(sys.argv[4]),int(sys.argv[5]),int(sys.argv[6]))
assert set(raw['NetworkSettings']['Networks'])=={sys.argv[2]+'-ui'}
ports=h['PortBindings'] or {}
if mode=='cache': assert not ports
else:
    port='3000' if mode=='web' else '3002'
    assert ports=={port+'/tcp':[{'HostIp':'127.0.0.1','HostPort':port}]} and h['Init'] is True
PYUI
}
ui_owns() {
  local name="$1" mode="${1#"$prefix-ui-"}" expected
  [[ "$mode" == web || "$mode" == realtime || "$mode" == cache ]] || return 1
  expected="$(cat "$private/ui-$mode-start.log")"
  [[ "$expected" =~ ^[a-f0-9]{64}$ ]] || return 1
  [[ "$(ui_docker inspect --format '{{.Id}} {{index .Config.Labels "org.memlia.ci"}}' "$name" 2>/dev/null)" == "$expected $prefix" ]]
}
ui_close() {
  local ok=1 name
  ui_closing=1
  [[ -n "${ui_deadline:-}" ]] || return 0
  for name in "${ui_resources[@]}"; do
    ui_stop_owned "$name" || ok=0
  done
  ui_resources=()
  if [[ "$ui_seeded" == 1 ]]; then
    ui_seeded=0 # Native deletion is attempted once, including refusal paths.
    phase ui-cleanup /work/apps/sim bun --no-env-file --tsconfig-override /work/apps/sim/tsconfig.json /work/scripts/ci/linux-chat-fixture.ts cleanup || ok=0
    phase ui-readback /work/packages/db bun --no-env-file /work/scripts/ci/linux-chat-fixture.ts readback || ok=0
  fi
  if [[ "${ui_cache_started:-0}" == 1 ]]; then
    # Keep Redis alive for native fixture cleanup; inspect it before expected stop.
    ui_cache_started=0
    ui_stop_owned "$prefix-ui-cache" || ok=0
  fi
  [[ "$ok" == 1 ]] || ui_cleanup_failed=1
  [[ "$ok" == 1 && "${ui_cleanup_failed:-0}" == 0 ]]
}

ui_stop_owned() {
  local name="$1" ok=1
  ui_owns "$name" || return 1
  # An owned service that already died/OOMed cannot become a successful journey.
  ui_docker inspect --format '{{json .State}}' "$name" > "$private/ui-state.json" || ok=0
  local mode="${name#"$prefix-ui-"}"
  python3 - "$private/ui-state.json" "$mode" "$metrics/ui-service-$mode.json" <<'PYUI' || ok=0
import json,sys
from pathlib import Path
s=json.load(open(sys.argv[1]));mode=sys.argv[2]
assert mode in ('web','realtime','cache') and type(s['Running'])is bool and type(s['OOMKilled'])is bool and type(s['Error'])is str
Path(sys.argv[3]).write_text(json.dumps({'phase':'ui-service-state','service':mode,'running':s['Running'],
    'oomKilled':s['OOMKilled'],'errorPresent':bool(s['Error'])},sort_keys=True)+'\n')
assert s['Running'] and not s['OOMKilled'] and not s['Error']
PYUI
  ui_docker stop --time 5 "$name" > /dev/null 2>&1 || ok=0
  [[ "$ok" == 1 ]]
}

run_product_phases() {
phase inventory /work/apps/sim bun run ../../packages/sim-cli/scripts/print-command-inventory.ts
if [[ "${swap_variant:-}" == turbopack* ]]; then
  phase typegen /work/apps/sim node ../../node_modules/next/dist/bin/next typegen
else
  phase typegen /work/apps/sim node ../../node_modules/next/dist/bin/next typegen --webpack
fi
# The installed TypeScript launcher selects the Linux native compiler via execve.
phase typecheck /work/apps/sim node ../../node_modules/typescript/bin/tsc --noEmit --singleThreaded --pretty false
phase cli /work/apps/sim bun run build:cli-runtime
phase sandbox /work/apps/sim bun run build:sandbox-bundles
if [[ "$scope" == validation ]]; then
  current_stage=validation_completed
  completed=1
  return
fi
# One bounded Next-only heap experiment; the container and other phases stay unchanged.
next_started=1
if [[ -n "${swap_variant:-}" ]]; then
  phase config /work/apps/sim node -e '
const fs=require("node:fs"); const load=require("next/dist/server/config").default;
const bundler=process.env.MEMLIA_SWAP_VARIANT==="webpack"?"webpack":"turbopack";
require("next/dist/lib/bundler").parseBundlerArgs(bundler==="webpack"?{webpack:true}:{turbopack:true});
load(require("next/constants").PHASE_PRODUCTION_BUILD,process.cwd()).then(c=>{
const r={bundler,productionBrowserSourceMaps:c.productionBrowserSourceMaps,serverSourceMaps:c.experimental.serverSourceMaps,
 enablePrerenderSourceMaps:c.enablePrerenderSourceMaps,cpus:c.experimental.cpus,output:c.output,
 webpackCallbackApplicable:process.env.MEMLIA_SWAP_VARIANT==="webpack"};
fs.writeFileSync("/metrics/next-config.json",JSON.stringify(r)+"\n");
if(r.productionBrowserSourceMaps!==false||r.serverSourceMaps!==false||r.enablePrerenderSourceMaps!==false||r.cpus!==2||r.output!=="standalone")process.exitCode=1;
}).catch(()=>{process.exitCode=1});'
  if [[ "$swap_variant" == webpack ]]; then
    phase next /work/apps/sim env DEBUG=next:build:webpack-build DEBUG_COLORS=0 NODE_OPTIONS=--max-old-space-size=24576 node ../../node_modules/next/dist/bin/next build --webpack
  else
    phase next /work/apps/sim env NODE_OPTIONS=--max-old-space-size=11264 node ../../node_modules/next/dist/bin/next build --turbopack
  fi
else
  phase next /work/apps/sim env DEBUG=next:build:webpack-build DEBUG_COLORS=0 NODE_OPTIONS=--max-old-space-size=11264 node ../../node_modules/next/dist/bin/next build --webpack
fi
phase standalone /work/apps/sim python3 /work/scripts/ci/linux-standalone-smoke.py /work/apps/sim /scratch /metrics/standalone-http.json
standalone_verified=1
if [[ "${ui_selected:-0}" == 1 ]]; then run_ui_journey; fi
current_stage=completed
completed=1
}
run_product_phases
