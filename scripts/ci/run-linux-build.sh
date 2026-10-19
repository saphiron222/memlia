#!/usr/bin/env bash
# Copyright 2026 Memlia. All rights reserved.
# Real product build, dedicated Docker cgroups, quantitative output only.
set -euo pipefail
umask 077
root="$(git rev-parse --show-toplevel)"
: "${RUNNER_TEMP:?GitHub runner temporary directory required}"
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
current_stage=bootstrap
database_ready_exit_code=''
database_init_exit_code=''
cleanup() {
  result=$?
  trap - EXIT INT TERM
  set +e
  cleanup_ok=1
  receipt_ok=1
  for name in "${containers[@]}"; do
    if docker inspect "$name" > /dev/null 2>&1; then
      docker rm -fv "$name" > /dev/null 2>&1 || cleanup_ok=0
    fi
    remaining="$(docker ps -a --filter "name=^/${name}$" --format '{{.Names}}' 2>/dev/null)"
    [[ $? == 0 && -z "$remaining" ]] || cleanup_ok=0
  done
  if [[ "$network_created" == 1 ]]; then
    docker network rm "$prefix" > /dev/null 2>&1 || cleanup_ok=0
  fi
  if [[ "$private" == "$RUNNER_TEMP"/memlia-build.* ]]; then
    rm -rf -- "$private" || cleanup_ok=0
  else
    cleanup_ok=0
  fi
  python3 - "$metrics/result.json" "$result" "$completed" "$cleanup_ok" \
    "${current_stage:-bootstrap}" "${database_ready_exit_code:-}" "${database_init_exit_code:-}" <<'PY' || receipt_ok=0
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
         'phase_cli','phase_sandbox','phase_next','phase_standalone','completed'}
assert stage in allowed and completed in (0,1) and cleanup in (0,1), 'Invalid fixed build diagnostic'
Path(sys.argv[1]).write_text(json.dumps({'exitCode':code,'stage':stage,
    'databaseReadyExitCode':exit_code(sys.argv[6],True),'databaseInitExitCode':exit_code(sys.argv[7],True),
    'normalCompletion':bool(completed),'cleanup':bool(cleanup),
    'status':'passed' if code==0 and completed and cleanup else 'failed'},indent=2)+'\n')
PY
  # Only our fixed-schema JSON receipts are shown; no raw build logs/artifacts.
  python3 - "$metrics" <<'PY' || receipt_ok=0
import json,sys
from pathlib import Path
receipts = [json.loads(path.read_text()) for path in sorted(Path(sys.argv[1]).glob('*.json'))]
for receipt in receipts:
    print(json.dumps(receipt,sort_keys=True))
PY
  [[ "$completed" == 1 && "$cleanup_ok" == 1 && "$receipt_ok" == 1 && "$result" == 0 ]] || exit 1
  exit 0
}
trap cleanup EXIT
trap 'exit 130' INT TERM
current_stage=host
python3 - "$metrics/host.json" "$root" <<'PY'
import hashlib,json,os,platform,shutil,subprocess,sys
from pathlib import Path
mem = {k:int(v.split()[0])*1024 for k,v in (x.split(':',1) for x in Path('/proc/meminfo').read_text().splitlines())}
root=Path(sys.argv[2]); disk=shutil.disk_usage(root)
receipt={'sourceCommit':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'lockSha256':hashlib.sha256((root/'bun.lock').read_bytes()).hexdigest(),'architecture':platform.machine(),'kernel':platform.release(),'cpuCount':os.cpu_count(),'hostMemTotalBytes':mem['MemTotal'],'hostMemAvailableBytes':mem['MemAvailable'],'hostSwapTotalBytes':mem['SwapTotal'],'hostSwapUsedBytes':mem['SwapTotal']-mem['SwapFree'],'diskFreeBytes':disk.free,'buildCgroupLimitBytes':13*1024**3,'databaseLimitBytes':512*1024**2,'v8OldSpaceMiB':10240,'bundler':'webpack','webpackCacheProfile':'memory','nextWorkers':2,'runnerImageOS':os.environ.get('ImageOS'),'runnerImageVersion':os.environ.get('ImageVersion')}
Path(sys.argv[1]).write_text(json.dumps(receipt,indent=2)+'\n')
assert platform.machine()=='x86_64'
assert mem['MemTotal']>=14*1024**3 and mem['MemAvailable']>=13*1024**3
assert disk.free>=8*1024**3
assert not (root/'node_modules').exists() and not (root/'apps/sim/.next').exists() and not (root/'.turbo').exists()
PY
# No cache restore or global cache/SDK deletion on the runner.
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
python3 - "$private" <<'PY'
from pathlib import Path
import secrets,sys
root=Path(sys.argv[1]); admin=secrets.token_hex(32); password=secrets.token_hex(32)
(root/'postgres.env').write_text(f'POSTGRES_PASSWORD={admin}\nPOSTGRES_DB=memlia_build\n')
values={'DATABASE_URL':f'postgresql://memlia_build:{password}@database:5432/memlia_build','MIGRATION_DATABASE_URL':f'postgresql://memlia_build:{password}@database:5432/memlia_build','BETTER_AUTH_SECRET':secrets.token_hex(32),'ENCRYPTION_KEY':secrets.token_hex(32),'INTERNAL_API_SECRET':secrets.token_hex(32),'BETTER_AUTH_URL':'http://localhost:3000','NEXT_PUBLIC_APP_URL':'http://localhost:3000','NEXT_PUBLIC_SOCKET_URL':'http://localhost:3002','DOCKER_BUILD':'true','MEMLIA_LOCAL_BUILD':'1','NODE_OPTIONS':'--max-old-space-size=10240','NEXT_TELEMETRY_DISABLED':'1','DO_NOT_TRACK':'1','SENTRY_DSN':'','NEXT_PUBLIC_SENTRY_DSN':'','HOME':'/scratch','TMPDIR':'/scratch/tmp','CI':'true'}
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
  python3 - "$root" <<'PY'
import shutil,sys
assert shutil.disk_usage(sys.argv[1]).free >= 2*1024**3, 'disk reserve exhausted'
PY
  local name="$prefix-$label"
  containers+=("$name")
  local code=0
  docker run --name "$name" --platform linux/amd64 --network "$prefix" \
    --user "$(id -u):$(id -g)" --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    --memory 13g --memory-swap 13g --cpus 4 --pids-limit 512 \
    --env-file "$private/build.env" --env PATH=/tools/bun-linux-x64:/usr/local/bin:/usr/bin:/bin \
    --mount "type=bind,source=$root,target=/work" \
    --mount "type=bind,source=$private,target=/scratch" \
    --mount "type=bind,source=$private/tools,target=/tools,readonly" \
    --mount "type=bind,source=$metrics,target=/metrics" --workdir "$cwd" \
    "$image" python3 /work/scripts/ci/linux-build-metrics.py --phase "$label" \
    --report "/metrics/$label.json" -- "$@" > "$private/$label.log" 2>&1 || code=$?
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
phase test /work python3 scripts/ci/test-linux-build-metrics.py -v
phase install /work sh -ec 'test "$(node --version)" = v24.22.0; test "$(bun --version)" = 1.4.2; sha256sum bun.lock > /scratch/lock.sha256; bun install --frozen-lockfile --ignore-scripts; sha256sum -c /scratch/lock.sha256'
current_stage=toolchain
docker run --rm --network none --user "$(id -u):$(id -g)" --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --memory 256m --memory-swap 256m \
  --mount "type=bind,source=$root,target=/work,readonly" \
  --mount "type=bind,source=$private/tools,target=/tools,readonly" \
  --mount "type=bind,source=$metrics,target=/metrics" "$image" python3 -c '
import hashlib,json,subprocess
from pathlib import Path
node=Path("/usr/local/bin/node"); bun=Path("/tools/bun-linux-x64/bun")
r={"node":subprocess.check_output([str(node),"--version"],text=True).strip(),"bun":subprocess.check_output([str(bun),"--version"],text=True).strip(),"nodeSha256":hashlib.sha256(node.read_bytes()).hexdigest(),"bunSha256":hashlib.sha256(bun.read_bytes()).hexdigest()}
for name in ["next","typescript"]: r[name]=json.loads((Path("/work/node_modules")/name/"package.json").read_text())["version"]
Path("/metrics/toolchain.json").write_text(json.dumps(r,indent=2)+"\n")
assert r["node"]=="v24.22.0" and r["bun"]=="1.4.2" and r["next"]=="16.4.0" and r["typescript"]=="7.0.2"
' > "$private/toolchain.log" 2>&1
phase inventory /work/apps/sim bun run ../../packages/sim-cli/scripts/print-command-inventory.ts
phase typegen /work/apps/sim node ../../node_modules/next/dist/bin/next typegen --webpack
# The installed TypeScript launcher selects the Linux native compiler via execve.
phase typecheck /work/apps/sim node ../../node_modules/typescript/bin/tsc --noEmit --singleThreaded
phase cli /work/apps/sim bun run build:cli-runtime
phase sandbox /work/apps/sim bun run build:sandbox-bundles
# Preserve the controlled heap and worker; measure the documented memory cache profile.
phase next /work/apps/sim node ../../node_modules/next/dist/bin/next build --webpack
phase standalone /work/apps/sim python3 -c '
from pathlib import Path
import json
root=Path(".next")
assert (root/"BUILD_ID").read_text().strip()
assert (root/"standalone/apps/sim/server.js").is_file()
assert (root/"routes-manifest.json").is_file()
assert (root/"prerender-manifest.json").is_file()
assert (root/"static").is_dir()
assert (root/"required-server-files.json").is_file()
assert json.loads((root/"required-server-files.json").read_text())["config"]["output"]=="standalone"
'
current_stage=completed
completed=1
