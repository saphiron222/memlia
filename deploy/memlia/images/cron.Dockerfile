# Adapted from admitted Sim docker/cron.Dockerfile and native entrypoint.
# This recipe intentionally qualifies Linux arm64 only.
FROM alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6
ARG TARGETARCH
COPY apk /tmp/apk
RUN test "$TARGETARCH" = arm64 \
    && cd /tmp/apk && sha256sum -c SHA256SUMS \
    && apk add --no-cache --no-network ./*.apk \
    && rm -rf /tmp/apk \
    && addgroup -g 1001 -S sim && adduser -u 1001 -S -G sim -H sim
COPY supercronic /usr/local/bin/supercronic
RUN echo 'f1f8585c66de020fef494dd636058f99949d108f569fef00016a1c8b9eb145b3  /usr/local/bin/supercronic' | sha256sum -c - \
    && chmod 0755 /usr/local/bin/supercronic
COPY crontab /etc/sim/crontab
COPY cron-entrypoint.sh /usr/local/bin/cron-entrypoint.sh
COPY licenses /usr/share/licenses
COPY context-manifest.json /usr/share/memlia/context-manifest.json
RUN chmod 0755 /usr/local/bin/cron-entrypoint.sh
USER 1001:1001
ENTRYPOINT ["/usr/local/bin/cron-entrypoint.sh"]
