# Adapted from admitted Sim docker/db.Dockerfile; upstream notices retained.
FROM oven/bun:1.4.2-alpine@sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f AS base
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
FROM base AS deps
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY patches ./patches
COPY packages/db/package.json ./packages/db/package.json
COPY packages/logger/package.json ./packages/logger/package.json
COPY packages/utils/package.json ./packages/utils/package.json
COPY packages/tsconfig/package.json ./packages/tsconfig/package.json
RUN sha256sum bun.lock > /tmp/lock.sha256 \
    && bun install --filter @sim/db --production --frozen-lockfile --ignore-scripts --linker hoisted \
    && sha256sum -c /tmp/lock.sha256

FROM base AS runner
ARG MEMLIA_SOURCE_COMMIT
ARG MEMLIA_LOCK_SHA256
LABEL org.memlia.source=$MEMLIA_SOURCE_COMMIT \
      org.memlia.lock=$MEMLIA_LOCK_SHA256
WORKDIR /app
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001 -G nodejs
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./package.json
COPY packages ./packages
COPY deploy/memlia/database-bootstrap.ts ./deploy/memlia/database-bootstrap.ts
COPY licenses /usr/share/licenses
COPY context-manifest.json /usr/share/memlia/context-manifest.json
USER 1001:1001
WORKDIR /app/packages/db
# Same native runner as db:migrate, with env supplied only by the container.
CMD ["bun", "--no-env-file", "./scripts/migrate.ts"]
