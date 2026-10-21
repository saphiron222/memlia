# Adapted from admitted Sim docker/cron.Dockerfile and native entrypoint.
# Explicit arm64/amd64 asset selection; native qualification is separate.
FROM alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6
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
ARG MEMLIA_SOURCE_COMMIT
ARG MEMLIA_LOCK_SHA256
LABEL org.memlia.source=$MEMLIA_SOURCE_COMMIT \
      org.memlia.lock=$MEMLIA_LOCK_SHA256
ARG TARGETARCH
COPY apk /tmp/apk
RUN test "$(cat /tmp/memlia-build/architecture)" = "$TARGETARCH" \
    && case "$TARGETARCH" in arm64|amd64) ;; *) exit 1;; esac \
    && cd /tmp/apk && sha256sum -c SHA256SUMS \
    && apk add --no-cache --no-network ./*.apk \
    && rm -rf /tmp/apk \
    && addgroup -g 1001 -S sim && adduser -u 1001 -S -G sim -H sim
COPY supercronic /usr/local/bin/supercronic
RUN case "$TARGETARCH" in \
      arm64) hash=f1f8585c66de020fef494dd636058f99949d108f569fef00016a1c8b9eb145b3;; \
      amd64) hash=feefa310da569c81b99e1027b86b27b51e6ee9ab647747b49099645120cfc671;; \
      *) exit 1;; esac \
    && echo "$hash  /usr/local/bin/supercronic" | sha256sum -c - \
    && chmod 0755 /usr/local/bin/supercronic
COPY crontab /etc/sim/crontab
COPY cron-entrypoint.sh /usr/local/bin/cron-entrypoint.sh
COPY licenses /usr/share/licenses
COPY context-manifest.json /usr/share/memlia/context-manifest.json
RUN chmod 0755 /usr/local/bin/cron-entrypoint.sh
USER 1001:1001
ENTRYPOINT ["/usr/local/bin/cron-entrypoint.sh"]
