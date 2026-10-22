# Copyright (c) 2026 Memlia. All rights reserved.
# Adapted from admitted Sim docker/app.Dockerfile; upstream notices retained.
# Source-only Bun entrypoint and Node sandbox from the same admitted source/lock.
# This recipe is not enabled by Compose and is not a qualified release image.
FROM node:24.22.0-bookworm@sha256:14078204b6bb268c107ceff6d3c43f45a888105e5c2b18b14c32b3409d93a1b0 AS base
ARG MEMLIA_SOURCE_COMMIT
ARG MEMLIA_LOCK_SHA256
COPY build-provenance /tmp/memlia-build
COPY bun.lock /tmp/memlia-build/context-bun.lock
# Verify admitted build provenance before installation.
RUN set -eu; \
    test "${#MEMLIA_SOURCE_COMMIT}" -eq 40; test "${#MEMLIA_LOCK_SHA256}" -eq 64; \
    case "$MEMLIA_SOURCE_COMMIT$MEMLIA_LOCK_SHA256" in *[!0-9a-f]*) exit 1;; esac; \
    test "$(cat /tmp/memlia-build/source)" = "$MEMLIA_SOURCE_COMMIT"; \
    test "$(cat /tmp/memlia-build/lock)" = "$MEMLIA_LOCK_SHA256"; \
    printf '%s  /tmp/memlia-build/bun.lock\n' "$MEMLIA_LOCK_SHA256" | sha256sum -c -; \
    printf '%s  /tmp/memlia-build/context-bun.lock\n' "$MEMLIA_LOCK_SHA256" | sha256sum -c -
# End build provenance.
ARG TARGETARCH
RUN test "$TARGETARCH" = amd64 \
    && test "$(node --version)" = v24.22.0 \
    && curl --fail --location --silent --show-error --max-time 120 \
      https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-linux-x64.zip \
      --output /tmp/bun.zip \
    && echo '36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913  /tmp/bun.zip' | sha256sum -c - \
    && python3 -c "from zipfile import ZipFile; from pathlib import Path; Path('/usr/local/bin/bun').write_bytes(ZipFile('/tmp/bun.zip').read('bun-linux-x64/bun'))" \
    && chmod 0755 /usr/local/bin/bun \
    && rm /tmp/bun.zip \
    && test "$(bun --version)" = 1.4.2
COPY deploy/memlia/images/tests/bun-LICENSE.md /usr/share/licenses/bun/LICENSE.md

FROM base AS sources
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY patches ./patches
COPY packages ./packages
COPY apps/sim ./apps/sim

FROM sources AS build
# Lifecycle scripts stay disabled. Never normalize/rewrite the product lock.
RUN sha256sum bun.lock > /tmp/lock.sha256 \
    && bun install --filter @sim/app --frozen-lockfile --ignore-scripts --linker hoisted \
    && sha256sum -c /tmp/lock.sha256
# Reuse the upstream Node ABI build and local locked node-gyp, never npx.
# Official Node headers already in this base prevent a new header download.
RUN node apps/sim/scripts/verify-oracledb-patch.cjs \
    && node apps/sim/scripts/oracledb-patch-self-test.cjs \
    && cd node_modules/isolated-vm \
    && node /app/node_modules/node-gyp/bin/node-gyp.js rebuild --release --jobs=2 --nodedir=/usr/local
WORKDIR /app/apps/sim
RUN bun --no-env-file run build:cli-runtime \
    && bun --no-env-file run build:sandbox-bundles \
    && bun --no-env-file build scripts/memlia-agent-control.ts --target=node --outfile=dist/memlia-agent-control.mjs

FROM sources AS production-deps
RUN sha256sum bun.lock > /tmp/lock.sha256 \
    && bun install --filter @sim/app --production --frozen-lockfile --ignore-scripts --linker hoisted \
    && sha256sum -c /tmp/lock.sha256

FROM base AS runner
ARG MEMLIA_SOURCE_COMMIT
ARG MEMLIA_LOCK_SHA256
LABEL org.memlia.source=$MEMLIA_SOURCE_COMMIT \
      org.memlia.lock=$MEMLIA_LOCK_SHA256
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    VERCEL_TELEMETRY_DISABLED=1 \
    DO_NOT_TRACK=1 \
    SIM_TELEMETRY_DISABLED=1
RUN groupadd --gid 1001 memlia \
    && useradd --uid 1001 --gid memlia --no-create-home --shell /usr/sbin/nologin memlia
COPY --from=production-deps /app/node_modules ./node_modules
COPY --from=build /app/node_modules/isolated-vm ./node_modules/isolated-vm
# Bun consumes the app tsconfig at runtime; this workspace is a devDependency.
COPY --from=build /app/packages/tsconfig ./node_modules/@sim/tsconfig
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/sim ./apps/sim
COPY --from=build /app/package.json /app/bun.lock ./
COPY compliance/upstream /usr/share/licenses/upstream
RUN node apps/sim/scripts/oracledb-patch-self-test.cjs \
      --worker apps/sim/lib/internal/oracledb/oracle-worker.cjs \
    && mkdir -p /app/apps/sim/uploads \
    && chown 1001:1001 /app/apps/sim/uploads
WORKDIR /app/apps/sim
USER 1001:1001
STOPSIGNAL SIGTERM
CMD ["bun", "--no-env-file", "--tsconfig-override=tsconfig.json", "scripts/memlia-workflow-worker.ts"]
