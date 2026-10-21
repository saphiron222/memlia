// Copyright (c) 2026 Memlia. All rights reserved.
// Synthetic composition of real API handlers, not an HTTP/Next/browser qualification.
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const CHECKS = ['noKeyDenied', 'wrongKeyDenied', 'authenticated', 'webHasNoDdl', 'uploaded',
  'otherWorkspaceKeyAuthenticated', 'crossWorkspaceDenied', 'graphSaved', 'nativeRunCompleted', 'nativeFileRecorded',
  'downloadNoKeyDenied', 'downloadCrossWorkspaceDenied', 'sameRecordedOutput', 'sourceUnchanged',
  'ownedRunFixtureRetired'] as const
let stage = 'preflight'
function assertRecipe(value: unknown): asserts value {
  if (!value) throw Error('excel_application_refused')
}

async function main() {
  // Refuse before importing any application module or opening its database pool.
  const nonce = process.env.RECIPE_NONCE ?? ''
  const url = new URL(process.env.DATABASE_URL ?? '')
  assertRecipe(process.platform === 'linux' && process.getuid?.() === 1001 && process.cwd() === '/scratch/application')
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
    const issued = await performCreatePersonalApiKey({ userId: fixture.userId, name: 'Excel CI ' + nonce,
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
    const own = await workspace('Excel API ' + nonce)
    const other = await workspace('Other API ' + nonce)
    const otherIssued = await performCreateWorkspaceApiKey({ userId: fixture.userId, workspaceId: other.id,
      name: 'Other Excel CI ' + nonce, actorEmail: fixture.email, captureAnalytics: false })
    assertRecipe(otherIssued.success && otherIssued.key?.key)
    const { NextRequest } = await import('next/server')
    const { dispatchInProcessV2Request } = await import('../../apps/sim/lib/api/server/routes/in-process-transport')
    const checks = Object.fromEntries(CHECKS.map(name => [name, false]))
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
    const uploaded = await data('/api/v2/files', 'POST', { workspaceId: own.id, name: 'input.xlsx',
      contentType: XLSX, content: source.contentBase64, encoding: 'base64' })
    assertRecipe(typeof uploaded.id === 'string' && uploaded.name === 'input.xlsx')
    checks.uploaded = true
    const refused = await request('/api/v2/files', 'POST', { workspaceId: own.id,
      name: 'cross-workspace.xlsx', contentType: XLSX, content: source.contentBase64, encoding: 'base64' }, otherIssued.key.key)
    checks.crossWorkspaceDenied = refused.status === 403 || refused.status === 404
    stage = 'workflow_graph'
    const workflow = await data('/api/v2/workflows', 'POST', { workspaceId: own.id, name: 'Excel file ' + nonce })
    const state = await data('/api/v2/workflows/' + workflow.id + '/state')
    const start = randomUUID(), transform = randomUUID()
    const procedure = { ...wire.procedure, workspaceId: own.id, workflowId: workflow.id,
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
    const { captureExcelToolWorkerRuntime, runWithExcelToolWorkerRuntime } = await import('../../apps/sim/lib/memlia/excel/execute-tool.server')
    const runtime = captureExcelToolWorkerRuntime(process.env.MEMLIA_EXCEL_HOST_SOCKET, process.env.MEMLIA_EXCEL_OPERATOR_UID)
    assertRecipe(runtime)
    // Fixed trusted process composition; user/API input never supplies an executor context.
    stage = 'native_execution'
    const run = await runWithExcelToolWorkerRuntime(runtime, () => data('/api/v2/workflows/' + workflow.id + '/execute',
      'POST', { run: { source: 'manual', entry: { type: 'trigger', blockId: start } } }))
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
    await db.$client.begin(async tx => {
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
    })
    checks.ownedRunFixtureRetired = true
    assertRecipe(CHECKS.every(name => checks[name] === true))
    writeFileSync('/scratch/application-result.private.json', JSON.stringify({ status: 'passed',
      scope: 'native_api_in_process', checks,
      file: { contentBase64: file.base64, sha256: digest(content), size: content.length, contentType: XLSX },
      download: { status: download.status, contentType: download.headers.get('content-type'),
        contentLength: Number(download.headers.get('content-length')), contentBase64: content.toString('base64') },
    }) + '\n', { mode: 0o600, flag: 'wx' })
  } finally {
    await closeApplicationConnections()
  }
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

if (import.meta.main) await main().catch(() => {
  // No credentials, raw errors, file bytes, request bodies or SQL in the public log.
  try {
    writeFileSync('/scratch/application-failure.private.json', JSON.stringify({
      status: 'failed', code: 'excel_application_refused', stage,
    }) + '\n', { mode: 0o600, flag: 'wx' })
  } catch { /* Preserve an unknown/pre-existing receipt; never overwrite it. */ }
  console.error('{"status":"failed","code":"excel_application_refused"}')
  process.exitCode = 1
})
