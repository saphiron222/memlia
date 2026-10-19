# Copyright (c) 2026 Memlia. All rights reserved.
# Rendered only by prepare_context.py with an operator-selected immutable digest.
FROM --platform=linux/amd64 @MEMLIA_PYTHON_BASE@ AS builder
WORKDIR /build
COPY source /source
COPY wheels /wheels
RUN --network=none ["python", "-I", "-B", "/source/runtimes/excel/scripts/package.py", "--source", "/source", "--wheelhouse", "/wheels", "--output", "/opt/excel", "--profile", "linux-cp312-x86_64"]

FROM --platform=linux/amd64 @MEMLIA_PYTHON_BASE@ AS runtime
COPY --from=builder --chown=65532:65532 /opt/excel/runtime /opt/excel/runtime
COPY --from=builder --chown=65532:65532 /opt/excel/manifest.json /opt/excel/manifest.json
LABEL org.memlia.excel.profile="v1"
USER 65532:65532
WORKDIR /tmp
ENTRYPOINT ["/usr/bin/env", "-i", "HOME=/tmp", "TMPDIR=/tmp", "PATH=/usr/local/bin:/usr/bin:/bin", "LANG=C.UTF-8", "POLARS_MAX_THREADS=1", "OPENBLAS_NUM_THREADS=1", "OMP_NUM_THREADS=1", "/opt/excel/runtime/bin/python", "-I", "-B", "-m", "memlia_excel.process"]
