# Modified by Memlia, 2026: mandatory admitted source/lock build provenance.
# ========================================
# Base Stage: Alpine Linux with Bun
# ========================================
FROM oven/bun:1.4.2-alpine AS base
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

RUN apk add --no-cache libc6-compat curl

# ========================================
# Pruner Stage: Emit a minimal monorepo subset that @sim/realtime depends on
# ========================================
FROM base AS pruner
WORKDIR /app

COPY . .

# Turbo needs a comment-free prune input; the admitted lock and notice stay
# byte-identical outside this temporary derivation, as in the app pruner.
RUN bun -e 'const fs=require("node:fs"),p="bun.lock",b=fs.readFileSync(p),o=fs.readFileSync("/tmp/memlia-build/bun.lock"),h=Buffer.from("// Modified by Memlia in 2026. Upstream Apache-2.0 license and notices retained.\n");if(!b.equals(o)||!b.subarray(0,h.length).equals(h)||b[h.length]!==123)throw new Error("prune_lock_refused");fs.writeFileSync(p,b.subarray(h.length));' && \
    TURBO_VERSION="$(bun -e "console.log(require('./package.json').devDependencies.turbo)")" && \
    bunx --bun "turbo@${TURBO_VERSION}" prune @sim/realtime --docker && \
    cp /tmp/memlia-build/bun.lock ./bun.lock

# ========================================
# Dependencies Stage: Install Dependencies
# ========================================
FROM base AS deps
WORKDIR /app

COPY --from=pruner /app/out/json/ ./
COPY --from=pruner /app/out/bun.lock ./bun.lock

RUN --mount=type=cache,id=bun-cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --linker=hoisted --omit=dev --ignore-scripts

# ========================================
# Runner Stage: Run the Socket Server
# ========================================
FROM base AS runner
ARG MEMLIA_SOURCE_COMMIT
ARG MEMLIA_LOCK_SHA256
LABEL org.memlia.source=$MEMLIA_SOURCE_COMMIT \
      org.memlia.lock=$MEMLIA_LOCK_SHA256
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3002 \
    HOSTNAME="0.0.0.0"

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nextjs -u 1001

COPY --from=deps --chown=nextjs:nodejs /app ./
COPY --from=pruner --chown=nextjs:nodejs /app/out/full/ ./

USER nextjs

EXPOSE 3002

CMD ["bun", "apps/realtime/src/bootstrap.ts"]
