// Copyright (c) 2026 Memlia. All rights reserved.
// Synthetic composition of real API handlers, not an HTTP/Next/browser qualification.
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const CHECKS = ['noKeyDenied', 'wrongKeyDenied', 'authenticated', 'webHasNoDdl', 'uploaded',
  'otherWorkspaceKeyAuthenticated', 'crossWorkspaceDenied', 'graphSaved', 'nativeRunCompleted', 'nativeFileRecorded',
  'downloadNoKeyDenied', 'downloadCrossWorkspaceDenied', 'sameRecordedOutput', 'sourceUnchanged',
  'ownedRunFixtureRetired'] as const
let stage = 'preflight'
function assertRecipe(value: unknown): asserts value {
  if (!value) throw Error('excel_application_refused')
}
export function durableFixtureMode(value: string | undefined) {
  assertRecipe(value === undefined || ['durable-prepare', 'durable-publish', 'durable-readback', 'durable-retire'].includes(value))
  return value
}
export async function durableDraftFromProcedure(value: unknown) {
  const { excelProcedureDraftSchema } = await import('../../apps/sim/lib/memlia/excel/procedure-capabilities')
  assertRecipe(value !== null && typeof value === 'object' && !Array.isArray(value))
  return excelProcedureDraftSchema.parse(Object.fromEntries(Object.entries(value)
    .filter(([key]) => Object.hasOwn(excelProcedureDraftSchema.shape, key))))
}

async function main() {
  const durableMode = durableFixtureMode(process.argv[2])
  // Refuse before importing any application module or opening its database pool.
  const nonce = process.env.RECIPE_NONCE ?? ''
  const url = new URL(process.env.DATABASE_URL ?? '')
  assertRecipe(process.platform === 'linux' && process.getuid?.() === 1001 &&
    process.cwd() === (durableMode ? '/app/apps/sim' : '/scratch/application'))
  assertRecipe(/^[a-f0-9]{32}$/.test(nonce) && url.protocol === 'postgres:' && url.hostname === 'database'
    && url.port === '5432' && url.pathname === '/memlia_ui_' + nonce && url.username === 'ui_web_' + nonce
    && !url.search && !url.hash && process.env.DISABLE_AUTH === 'false')
  assertRecipe(readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim() === String(4 * 1024 ** 3)
    && readFileSync('/sys/fs/cgroup/memory.swap.max', 'utf8').trim() === '0'
    && readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim() === '200000 100000'
    && readFileSync('/sys/fs/cgroup/pids.max', 'utf8').trim() === '256')
  const fixture = JSON.parse(readFileSync('/scratch/ui/credentials.private.json', 'utf8'))
  assertRecipe(fixture.email === 'excel-' + nonce + '@example.invalid')
  const inputRaw = readFileSync('/scratch/application-input.private.json')
  assertRecipe(inputRaw.length > 0 && inputRaw.length <= 1024 * 1024)
  const wire = JSON.parse(inputRaw.toString())
  const source = wire.sources?.source
  assertRecipe(wire.requestId === 'linux-image-recipe' && source?.sheetName === 'Input'
    && typeof source.contentBase64 === 'string')
  const sourceBytes = Buffer.from(source.contentBase64, 'base64')
  const digest = (content: Buffer) => 'sha256:' + createHash('sha256').update(content).digest('hex')
  assertRecipe(sourceBytes.length > 0 && sourceBytes.length < 100_000
    && sourceBytes.toString('base64') === source.contentBase64 && digest(sourceBytes) === source.sha256)
  const { db } = await import('../../packages/db/index')
  try {
    stage = 'database_identity'
    const [role] = await db.$client`SELECT current_user AS role,current_database() AS database,
      rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,
      has_schema_privilege(current_user,'public','CREATE') AS ddl FROM pg_roles WHERE rolname=current_user`
    assertRecipe(role.role === url.username && role.database === url.pathname.slice(1)
      && !role.rolsuper && !role.rolcreatedb && !role.rolcreaterole && !role.rolbypassrls && !role.ddl)
    const [seed] = await db.$client`SELECT u.id,s.user_id AS stats_owner FROM "user" u
      JOIN user_stats s ON s.user_id=u.id JOIN account a ON a.user_id=u.id
      WHERE u.id=${fixture.userId} AND u.email=${fixture.email} AND a.provider_id='credential'`
    assertRecipe(seed?.id === fixture.userId && seed.stats_owner === fixture.userId)
    const { performCreatePersonalApiKey, performCreateWorkspaceApiKey } = await import('../../apps/sim/lib/api-key/orchestration')
    stage = 'native_credential'
    // Fixture provisioning uses the native issuer, not a forged principal or session row.
    const prepared = durableMode && durableMode !== 'durable-prepare'
      ? JSON.parse(readFileSync('/scratch/durable-prepared.private.json', 'utf8')) : undefined
    if (durableMode === 'durable-publish') {
      const { enqueueOutboxProcessor } = await import('../../apps/sim/lib/core/outbox/enqueue')
      const { pgBossClient } = await import('../../apps/sim/lib/core/async-jobs/backends/pg-boss-client')
      try {
        const published = await enqueueOutboxProcessor()
        assertRecipe(published.triggered === true && published.backend === 'inline')
      } finally { await pgBossClient.stop() }
      return
    }
    const issued = prepared ? { success: true, key: { id: prepared.keyId, key: prepared.key } } : await performCreatePersonalApiKey({ userId: fixture.userId, name: 'Excel CI ' + nonce,
      source: 'synthetic-ci', actorEmail: fixture.email })
    assertRecipe(issued.success && issued.key?.key)
    const key = issued.key.key
    const { authenticateV2ApiKey } = await import('../../apps/sim/lib/api/server/routes/v2-api-key-auth')
    const authenticated = await authenticateV2ApiKey({ apiKey: key, bearer: null })
    assertRecipe(authenticated.principal.kind === 'personal_api_key'
      && authenticated.principal.userId === fixture.userId && authenticated.principal.keyId === issued.key.id)
    const userId = authenticated.principal.userId
    const { getWorkspaceCreationPolicy } = await import('../../apps/sim/lib/workspaces/policy')
    const { createWorkspace } = await import('../../apps/sim/lib/workspaces/create')
    async function workspace(name: string) {
      const policy = await getWorkspaceCreationPolicy({ userId, activeOrganizationId: null })
      assertRecipe(policy.canCreate && policy.organizationId === null)
      return createWorkspace({ userId, name, skipDefaultWorkflow: true,
        organizationId: policy.organizationId, workspaceMode: policy.workspaceMode,
        billedAccountUserId: policy.billedAccountUserId, observedOrganizationId: policy.observedOrganizationId,
        governingPermissionGroupOrganizationId: policy.governingPermissionGroupOrganizationId })
    }
    stage = 'workspace_preparation'
    const own = prepared ? { id: prepared.workspaceId } : await workspace('Excel API ' + nonce)
    const other = prepared ? { id: prepared.otherWorkspaceId } : await workspace('Other API ' + nonce)
    const otherIssued = prepared ? { success: true, key: { key: prepared.otherKey } } : await performCreateWorkspaceApiKey({ userId: fixture.userId, workspaceId: other.id,
      name: 'Other Excel CI ' + nonce, actorEmail: fixture.email, captureAnalytics: false })
    assertRecipe(otherIssued.success && otherIssued.key?.key)
    const { NextRequest } = await import('next/server')
    const { dispatchInProcessV2Request } = await import('../../apps/sim/lib/api/server/routes/in-process-transport')
    const checks = Object.fromEntries(CHECKS.map(name => [name, false]))
    if (prepared) {
      assertRecipe(prepared.userId === userId && prepared.nonce === nonce && prepared.sourceSha256 === source.sha256)
      for (const name of CHECKS) assertRecipe(typeof prepared.checks?.[name] === 'boolean')
      Object.assign(checks, prepared.checks)
    }
    checks.authenticated = checks.webHasNoDdl = true
    async function request(path: string, method = 'GET', body?: unknown, credential: string | null = key) {
      const response = await dispatchInProcessV2Request(new NextRequest('http://localhost:3000' + path, {
        // Trusted synthetic in-process transport supplies its test client IP, as a proxy would.
        method, headers: { 'x-forwarded-for': '192.0.2.10', ...(credential ? { 'x-api-key': credential } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(90_000),
      }))
      assertRecipe(response)
      return response
    }
    async function data(path: string, method = 'GET', body?: unknown) {
      const response = await request(path, method, body)
      assertRecipe(response.status >= 200 && response.status < 300)
      const value = await response.json()
      assertRecipe(value && typeof value === 'object' && 'data' in value)
      return value.data
    }
    let uploaded: { id: string; name: string }
    let workflow: { id: string }
    let start: string
    if (!prepared) {
    stage = 'authentication_negatives'
    const unauthorizedInput = { workspaceId: own.id, name: 'unauthorized.xlsx', contentType: XLSX,
      content: source.contentBase64, encoding: 'base64' }
    checks.noKeyDenied = (await request('/api/v2/files', 'POST', unauthorizedInput, null)).status === 401
    checks.wrongKeyDenied = (await request('/api/v2/files', 'POST', unauthorizedInput, 'FICTITIOUS_INVALID_EXCEL_CI_KEY')).status === 401
    // Existing, authorized second workspace and a valid scoped key, not an absent ID.
    const otherRead = await request('/api/v2/files?workspaceId=' + other.id, 'GET', undefined, otherIssued.key.key)
    assertRecipe(otherRead.status === 200)
    const otherFiles = await otherRead.json()
    assertRecipe(Array.isArray(otherFiles.data) && otherFiles.data.length === 0)
    checks.otherWorkspaceKeyAuthenticated = true
    stage = 'file_upload'
    uploaded = await data('/api/v2/files', 'POST', { workspaceId: own.id, name: 'input.xlsx',
      contentType: XLSX, content: source.contentBase64, encoding: 'base64' })
    assertRecipe(typeof uploaded.id === 'string' && uploaded.name === 'input.xlsx')
    checks.uploaded = true
    const refused = await request('/api/v2/files', 'POST', { workspaceId: own.id,
      name: 'cross-workspace.xlsx', contentType: XLSX, content: source.contentBase64, encoding: 'base64' }, otherIssued.key.key)
    checks.crossWorkspaceDenied = refused.status === 403 || refused.status === 404
    stage = 'workflow_graph'
    workflow = await data('/api/v2/workflows', 'POST', { workspaceId: own.id, name: 'Excel file ' + nonce })
    const state = await data('/api/v2/workflows/' + workflow.id + '/state')
    start = randomUUID()
    const transform = randomUUID()
    const procedure = durableMode ? await durableDraftFromProcedure(wire.procedure) :
      { ...wire.procedure, workspaceId: own.id, workflowId: workflow.id,
        organizationId: null, ownerUserId: fixture.userId }
    const operations = [
      ...Object.keys(state.blocks).map(block_id => ({ operation_type: 'delete', block_id })),
      { operation_type: 'add', block_id: start, params: { type: 'start_trigger', name: 'Start',
        connections: { source: transform } } },
      { operation_type: 'add', block_id: transform, params: { type: 'memlia_excel', name: 'Transform',
        inputs: { request: JSON.stringify({ procedure, sources: { source: { fileId: uploaded.id, sheetName: 'Input' } },
          output: { sheetName: 'Result', fileName: 'result.xlsx' } }) } } },
    ]
    const edit = await data('/api/v2/workflows/' + workflow.id + '/operations', 'POST', {
      expectedRevision: state.draftRevision, atomic: true, operations, layout: 'none',
    })
    const saved = await data('/api/v2/workflows/' + workflow.id + '/state')
    assertRecipe(edit.skipped.length === 0 && edit.inputValidationErrors.length === 0
      && Object.keys(saved.blocks).length === 2 && saved.blocks[transform].type === 'memlia_excel'
      && saved.edges.length === 1 && saved.edges[0].source === start && saved.edges[0].target === transform)
    checks.graphSaved = true
    if (durableMode === 'durable-prepare') {
      writeFileSync('/scratch/durable-prepared.private.json', JSON.stringify({
        nonce, userId, workflowId: workflow.id, workspaceId: own.id, otherWorkspaceId: other.id,
        uploaded, start, keyId: issued.key.id, key, otherKey: otherIssued.key.key, checks, sourceSha256: source.sha256,
      }) + '\n', { mode: 0o600, flag: 'wx' })
      writeFileSync('/scratch/durable-browser.private.json', JSON.stringify({
        workflowId: workflow.id, workspaceId: own.id,
      }) + '\n', { mode: 0o600, flag: 'wx' })
      return
    }
    } else {
      uploaded = prepared.uploaded; workflow = { id: prepared.workflowId }; start = prepared.start
    }
    const submission = durableMode ? JSON.parse(readFileSync('/scratch/durable-submission.private.json', 'utf8')) : undefined
    if (submission) {
      assertRecipe(submission.status === 'passed' && submission.browserClosed === true && submission.queued === true
        && submission.workflowId === workflow.id && submission.workspaceId === own.id
        && submission.jobId === 'workflow-execution:' + submission.executionId)
      if (durableMode === 'durable-retire') {
        const result = JSON.parse(readFileSync('/scratch/application-result.private.json', 'utf8'))
        assertRecipe(result.scope === 'native_durable_compose' && result.durable?.jobId === submission.jobId
          && result.durable?.completed === true && result.durable?.transportAcked === true)
        await retireOwnedRun(db, { runId: submission.executionId }, workflow, own, userId, submission.jobId)
        writeFileSync('/scratch/durable-retired.private.json', JSON.stringify({ retired: true }) + '\n', { mode: 0o600, flag: 'wx' })
        return
      }
    }
    let run: { status: string; runId: string }
    if (submission) {
      stage = 'native_execution'
      await observeDurableCompletion(db, submission, workflow.id, own.id, userId)
      run = { status: 'completed', runId: submission.executionId }
    } else {
    const { captureExcelToolWorkerRuntime, runWithExcelToolWorkerRuntime } = await import('../../apps/sim/lib/memlia/excel/execute-tool.server')
    const runtime = captureExcelToolWorkerRuntime(process.env.MEMLIA_EXCEL_HOST_SOCKET, process.env.MEMLIA_EXCEL_OPERATOR_UID)
    assertRecipe(runtime)
    // Fixed trusted process composition; user/API input never supplies an executor context.
    stage = 'native_execution'
    run = await runWithExcelToolWorkerRuntime(runtime, () => data('/api/v2/workflows/' + workflow.id + '/execute',
      'POST', { run: { source: 'manual', entry: { type: 'trigger', blockId: start } } }))
    }
    assertRecipe(run.status === 'completed' && typeof run.runId === 'string')
    checks.nativeRunCompleted = true
    stage = 'native_recorded_file'
    const recorded = await data('/api/v2/workflows/' + workflow.id + '/runs/' + run.runId + '?includeOutput=true&includeFileBase64=true&base64MaxBytes=100000')
    assertRecipe(recorded.status === 'completed' && recorded.runId === run.runId
      && Array.isArray(recorded.files) && recorded.files.length === 1)
    const file = recorded.files[0]
    const path = '/api/v2/workflows/' + workflow.id + '/runs/' + run.runId + '/files/' + file.id
    assertRecipe(file.name === 'result.xlsx' && file.type === XLSX && file.downloadPath === path
      && typeof file.base64 === 'string' && file.size > 0 && file.size < 100_000)
    checks.nativeFileRecorded = true
    stage = 'download_authorization'
    checks.downloadNoKeyDenied = (await request(path, 'GET', undefined, null)).status === 401
    const crossDownload = await request(path, 'GET', undefined, otherIssued.key.key)
    checks.downloadCrossWorkspaceDenied = crossDownload.status === 403 || crossDownload.status === 404
    stage = 'same_output_download'
    const download = await request(path)
    assertRecipe(download.status === 200 && download.headers.get('content-type') === XLSX
      && download.headers.get('content-length') === String(file.size))
    const content = Buffer.from(await download.arrayBuffer())
    assertRecipe(content.length === file.size && content.toString('base64') === file.base64)
    checks.sameRecordedOutput = true
    stage = 'source_readback'
    const original = await data('/api/v2/files/' + uploaded.id + '/metadata?workspaceId=' + own.id)
    assertRecipe(original.id === uploaded.id && original.name === 'input.xlsx')
    // Real authenticated native file read, not a local pathname or a second transformation.
    const { readWorkspaceFileContent } = await import('../../apps/sim/lib/workspace-files/application/read-workspace-file-content')
    const sourceAgain = await readWorkspaceFileContent.execute({ principal: authenticated.principal,
      input: { fileId: uploaded.id, assertedWorkspaceId: own.id, maxBytes: 100_000 } })
    assertRecipe(digest(sourceAgain.content) === source.sha256 && sourceAgain.content.equals(sourceBytes))
    checks.sourceUnchanged = true
    // Account erasure cascades logs, but intentionally retains snapshots and ID tombstones.
    // Retire only this completed synthetic run AFTER its real API/file assertions.
    // This is fixture cleanup, never production run creation/finalization or a global sweep.
    stage = 'owned_run_cleanup'
    if (!submission) await retireOwnedRun(db, run, workflow, own, userId)
    checks.ownedRunFixtureRetired = !submission
    assertRecipe(CHECKS.every(name => name === 'ownedRunFixtureRetired' && submission || checks[name] === true))
    writeFileSync('/scratch/application-result.private.json', JSON.stringify({ status: 'passed',
      scope: submission ? 'native_durable_compose' : 'native_api_in_process', checks,
      ...(submission ? { durable: { jobId: submission.jobId, executionId: submission.executionId,
        completed: true, attempts: 1, transportAcked: true, oneDelivery: true, oneExecutionLog: true } } : {}),
      file: { contentBase64: file.base64, sha256: digest(content), size: content.length, contentType: XLSX },
      download: { status: download.status, contentType: download.headers.get('content-type'),
        contentLength: Number(download.headers.get('content-length')), contentBase64: content.toString('base64') },
    }) + '\n', { mode: 0o600, flag: 'wx' })
  } finally {
    await closeApplicationConnections()
  }
}


export async function retireOwnedRun(db: typeof import('../../packages/db/index').db, run: { runId: string },
  workflow: { id: string }, own: { id: string }, userId: string, jobId?: string) {
  assertRecipe(jobId === undefined || jobId === 'workflow-execution:' + run.runId)
  await db.$client.begin(async tx => {
      let jobRow: { id: string; version: string; digest: string; event_id: string; event_version: string; event_digest: string } | undefined
      if (jobId) {
        const rows = await tx<{ id: string; version: string; digest: string; event_id: string; event_version: string; event_digest: string }[]>`SELECT j.id,j.xmin::text AS version,md5(row_to_json(j)::text) AS digest,
          e.id AS event_id,e.xmin::text AS event_version,md5(row_to_json(e)::text) AS event_digest
          FROM async_jobs j JOIN outbox_event e ON e.payload->>'nativeJobId'=j.id
          WHERE j.id=${jobId} AND j.type='workflow-execution' AND j.status='completed' AND j.attempts=1
            AND j.payload->>'executionId'=${run.runId} AND j.payload->>'workflowId'=${workflow.id}
            AND j.payload->>'workspaceId'=${own.id} AND j.payload->>'userId'=${userId}
            AND j.output->>'success'='true' AND e.event_type='memlia.pg-boss.publish' AND e.status='completed'
          LIMIT 2 FOR UPDATE OF j,e`
        assertRecipe(rows.length === 1)
        jobRow = rows[0]
      }
      const owned = await tx`SELECT l.id AS log_id,l.xmin::text AS log_version,
          md5(row_to_json(l)::text) AS log_digest,s.id AS snapshot_id,
          s.xmin::text AS snapshot_version,md5(row_to_json(s)::text) AS snapshot_digest,
          k.key AS claim_key,k.xmin::text AS claim_version,md5(row_to_json(k)::text) AS claim_digest
        FROM workflow_execution_logs l JOIN workflow_execution_snapshots s ON s.id=l.state_snapshot_id
        JOIN workflow w ON w.id=l.workflow_id
        JOIN idempotency_key k ON k.key='workflow-execution-id:'||l.execution_id
        WHERE l.execution_id=${run.runId} AND l.workflow_id=${workflow.id} AND l.workspace_id=${own.id}
          AND l.status='completed' AND s.workflow_id=${workflow.id}
          AND w.user_id=${userId} AND w.workspace_id=${own.id}
          AND k.result->>'status'='claimed' AND k.result->>'executionId'=l.execution_id
        LIMIT 2 FOR UPDATE OF l,s,w,k`
      assertRecipe(owned.length === 1)
      const row = owned[0]
      const logs = await tx`DELETE FROM workflow_execution_logs l
        WHERE l.id=${row.log_id} AND l.execution_id=${run.runId} AND l.workflow_id=${workflow.id}
          AND l.workspace_id=${own.id} AND l.status='completed'
          AND l.xmin::text=${row.log_version} AND md5(row_to_json(l)::text)=${row.log_digest}
        RETURNING l.id`
      assertRecipe(logs.length === 1)
      const snapshots = await tx`DELETE FROM workflow_execution_snapshots s
        WHERE s.id=${row.snapshot_id} AND s.workflow_id=${workflow.id}
          AND s.xmin::text=${row.snapshot_version} AND md5(row_to_json(s)::text)=${row.snapshot_digest}
          AND NOT EXISTS (SELECT 1 FROM workflow_execution_logs l WHERE l.state_snapshot_id=s.id)
        RETURNING s.id`
      assertRecipe(snapshots.length === 1)
      const claims = await tx`DELETE FROM idempotency_key k
        WHERE k.key=${row.claim_key} AND k.key=${'workflow-execution-id:' + run.runId}
          AND k.xmin::text=${row.claim_version} AND md5(row_to_json(k)::text)=${row.claim_digest}
          AND k.result->>'status'='claimed' AND k.result->>'executionId'=${run.runId}
          AND NOT EXISTS (SELECT 1 FROM workflow_execution_logs l WHERE l.execution_id=${run.runId})
        RETURNING k.key`
      assertRecipe(claims.length === 1)
      if (jobId && jobRow) {
        assertRecipe((await tx`DELETE FROM outbox_event e WHERE e.id=${jobRow.event_id}
          AND e.xmin::text=${jobRow.event_version} AND md5(row_to_json(e)::text)=${jobRow.event_digest}
          AND e.payload->>'nativeJobId'=${jobId} AND e.status='completed' RETURNING e.id`).length === 1)
        assertRecipe((await tx`DELETE FROM async_jobs j WHERE j.id=${jobId} AND j.xmin::text=${jobRow.version}
          AND md5(row_to_json(j)::text)=${jobRow.digest} AND j.status='completed' RETURNING j.id`).length === 1)
      }
    })
}

export async function verifyTransportIsolation(db: typeof import('../../packages/db/index').db,
  queue: ReturnType<typeof import('postgres')>, expectedRole: string) {
  // Resolving a qualified table name itself requires schema USAGE. The web
  // role already possesses it; transport must test the OID without gaining it.
  const rows = await db.$client<{ oid: string }[]>`SELECT c.oid::text AS oid FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='user' AND c.relkind='r' LIMIT 2`
  assertRecipe(rows.length === 1 && typeof rows[0].oid === 'string' && /^[1-9][0-9]{0,9}$/.test(rows[0].oid))
  const [privileges] = await queue`SELECT current_user AS role,
    has_schema_privilege(current_user,'public','CREATE') AS ddl,
    has_schema_privilege(current_user,'public','USAGE') AS business_usage,
    has_table_privilege(current_user,${rows[0].oid}::oid,'SELECT') AS business_read`
  assertRecipe(privileges?.role === expectedRole && privileges.ddl === false &&
    privileges.business_usage === false && privileges.business_read === false)
}

async function observeDurableCompletion(db: typeof import('../../packages/db/index').db,
  submission: { jobId: string; executionId: string }, workflowId: string, workspaceId: string, userId: string) {
  const { default: postgres } = await import('postgres')
  const queueUrl = new URL(process.env.MEMLIA_PG_BOSS_DATABASE_URL ?? '')
  const webUrl = new URL(process.env.DATABASE_URL!)
  assertRecipe(queueUrl.username === 'ui_transport_' + process.env.RECIPE_NONCE && queueUrl.hostname === webUrl.hostname
    && queueUrl.pathname === webUrl.pathname && queueUrl.port === webUrl.port && !queueUrl.search && !queueUrl.hash)
  const queue = postgres(queueUrl.href, { max: 1, connect_timeout: 3, idle_timeout: 1, onnotice: () => {} })
  try {
    await verifyTransportIsolation(db, queue, queueUrl.username)
    const deadline = performance.now() + 90_000
    while (performance.now() < deadline) {
      const rows = await db.$client`SELECT id,status,attempts,payload,output FROM async_jobs WHERE id=${submission.jobId}`
      assertRecipe(rows.length === 1)
      const job = rows[0]
      assertRecipe(job.payload.executionId === submission.executionId && job.payload.workflowId === workflowId
        && job.payload.workspaceId === workspaceId && job.payload.userId === userId
        && job.payload.principal?.principal?.kind === 'session')
      const deliveries = await queue`SELECT id,state FROM memlia_jobs.job
        WHERE name='memlia_native' AND data->>'nativeJobId'=${submission.jobId} LIMIT 2`
      assertRecipe(deliveries.length <= 1 && !['failed', 'cancelled'].includes(job.status))
      if (job.status === 'completed' && deliveries[0]?.state === 'completed') {
        assertRecipe(job.attempts === 1 && job.output?.success === true)
        const logs = await db.$client`SELECT execution_id,status FROM workflow_execution_logs
          WHERE workflow_id=${workflowId} AND workspace_id=${workspaceId} LIMIT 2`
        assertRecipe(logs.length === 1 && logs[0].execution_id === submission.executionId && logs[0].status === 'completed')
        return
      }
      await delay(100)
    }
    throw Error('excel_durable_observation_deadline')
  } finally { await queue.end({ timeout: 2 }) }
}

/** The isolated recipe process owns these imported channels and its database pool. */
export async function closeApplicationConnections() {
  try {
    const { closeRedisConnection } = await import('../../apps/sim/lib/core/config/redis')
    const { closeExecutionSignalHub } = await import('../../apps/sim/lib/execution/signal')
    const { chatPubSub } = await import('../../apps/sim/lib/mothership/chat-status')
    const { mcpPubSub } = await import('../../apps/sim/lib/mcp/pubsub')
    chatPubSub?.dispose()
    mcpPubSub?.dispose()
    closeExecutionSignalHub()
    await closeRedisConnection()
  } finally {
    const { db } = await import('../../packages/db/index')
    await db.$client.end({ timeout: 2 })
  }
}

if (import.meta.main) await main().catch((error) => {
  try {
    writeFileSync('/scratch/application-native-failure.private.txt',
      Buffer.from(error instanceof Error ? error.stack || error.message : 'unknown_native_failure').subarray(0, 65536),
      { mode: 0o600, flag: 'wx' })
  } catch { /* A missing diagnostic remains unknown; no retry of the business effect. */ }
  // No credentials, raw errors, file bytes, request bodies or SQL in the public log.
  try {
    writeFileSync('/scratch/application-failure.private.json', JSON.stringify({
      status: 'failed', code: 'excel_application_refused', stage,
    }) + '\n', { mode: 0o600, flag: 'wx' })
  } catch { /* Preserve an unknown/pre-existing receipt; never overwrite it. */ }
  console.error('{"status":"failed","code":"excel_application_refused"}')
  process.exitCode = 1
})
