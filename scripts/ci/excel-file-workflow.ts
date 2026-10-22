// Copyright (c) 2026 Memlia. All rights reserved.
// Synthetic composition of real API handlers, not an HTTP/Next/browser qualification.
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import type { ExcelTestExecutionBinding } from '../../apps/sim/lib/api/contracts/excel-test-preparations'

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

type RecordValue = Record<string, unknown>
type InactiveCapture = (name: string, value: unknown) => void
const record = (value: unknown): value is RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value)
async function nativeFixtureDigest(value: unknown) {
  const { normalizedStringify } = await import('../../apps/sim/lib/workflows/comparison/normalize')
  const text = normalizedStringify(value)
  assertRecipe(Buffer.byteLength(text) <= 2 * 1024 ** 2)
  return 'sha256:' + createHash('sha256').update(text).digest('hex')
}
export async function captureInactiveTestSubmission(value: unknown, workflowId: string, workspaceId: string) {
  const text = JSON.stringify(value)
  assertRecipe(typeof text === 'string' && Buffer.byteLength(text) <= 16384)
  const captured: unknown = JSON.parse(text)
  const { excelTestExecutionBindingSchema } = await import('../../apps/sim/lib/api/contracts/excel-test-preparations')
  const fields = ['status', 'scope', 'authenticated', 'preparedForTest', 'queued', 'browserClosed',
    'activationRequested', 'workflowId', 'workspaceId', 'deploymentVersionId', 'executionId', 'snapshotDigest',
    'jobId', 'jobIdSource', 'inactiveTest']
  assertRecipe(record(captured) && Object.keys(captured).length === fields.length
    && fields.every(key => Object.hasOwn(captured, key)) && captured.status === 'passed' && captured.scope === 'native_session_inactive_test_submission'
    && captured.authenticated === true && captured.preparedForTest === true && captured.queued === true
    && captured.browserClosed === true && captured.activationRequested === false && captured.workflowId === workflowId
    && captured.workspaceId === workspaceId && typeof captured.executionId === 'string'
    && /^[A-Za-z0-9_-]{1,128}(?![\s\S])/.test(captured.executionId) && captured.jobId === 'workflow-execution:' + captured.executionId
    && captured.jobIdSource === 'derived_expected')
  const binding = excelTestExecutionBindingSchema.parse(captured.inactiveTest)
  assertRecipe(binding.workspaceId === workspaceId && binding.prepared.workflowId === workflowId
    && binding.prepared.deploymentVersionId === captured.deploymentVersionId
    && binding.prepared.snapshotDigest === captured.snapshotDigest)
  return binding
}
export async function assertInactiveJobPayload(value: unknown, binding: ExcelTestExecutionBinding, executionId: string, userId: string) {
  assertRecipe(record(value) && value.workflowId === binding.prepared.workflowId && value.workspaceId === binding.workspaceId
    && value.executionId === executionId && value.userId === userId && value.executionMode === 'async'
    && value.admissionCompleted === true && value.enforceCredentialAccess === true && value.isPublicApiAccess === false
    && record(value.principal) && record(value.principal.principal) && value.principal.principal.kind === 'session'
    && value.principal.principal.userId === userId && typeof value.principal.principal.sessionId === 'string'
    && value.principal.principal.sessionId.length > 0
    && record(value.excelTestExecution) && await nativeFixtureDigest(value.excelTestExecution) === await nativeFixtureDigest(binding))
}
export async function verifyInactiveVersionObservation(rows: unknown, binding: ExcelTestExecutionBinding, userId: string) {
  assertRecipe(Array.isArray(rows) && rows.length === 1 && record(rows[0]))
  const row = rows[0]
  assertRecipe(row.id === binding.prepared.deploymentVersionId && row.version === binding.prepared.version && row.workflow_id === binding.prepared.workflowId
    && row.workspace_id === binding.workspaceId && row.created_by === userId && row.preparation_kind === 'excel_test_v1'
    && row.is_active === false && row.snapshot_digest === binding.prepared.snapshotDigest
    && await nativeFixtureDigest(row.state) === binding.prepared.snapshotDigest)
}
export async function inactivePreparationIdentity(binding: ExcelTestExecutionBinding, userId: string) {
  assertRecipe(typeof userId === 'string' && /^[A-Za-z0-9_-]{1,128}(?![\s\S])/.test(userId))
  const { excelTestExecutionBindingSchema } = await import('../../apps/sim/lib/api/contracts/excel-test-preparations')
  const owned = excelTestExecutionBindingSchema.parse(binding)
  const scope = { workflowId: owned.prepared.workflowId, workspaceId: owned.workspaceId, organizationId: null }
  const namespace = 'excel-test-preparation:' + await nativeFixtureDigest({ scope, actorId: userId })
  const fingerprint = await nativeFixtureDigest({ scope, actorId: userId, ...owned.preparation,
    policyVersion: 'memlia_excel_test_admission_v1' })
  return { key: namespace + ':' + owned.preparation.operationId, fingerprint,
    result: { status: 'completed', requestFingerprint: fingerprint, result: owned.prepared } }
}

async function observeInactiveVersion(db: typeof import('../../packages/db/index').db, binding: ExcelTestExecutionBinding,
  userId: string, capture: InactiveCapture, name: string) {
  const { verifyExcelTestSnapshot } = await import('../../apps/sim/lib/workflows/persistence/excel-test-snapshots')
  await verifyExcelTestSnapshot({ scope: { workflowId: binding.prepared.workflowId, workspaceId: binding.workspaceId,
    organizationId: null }, actorId: userId, ...binding.preparation }, binding.prepared)
  const rows = await db.$client`SELECT v.id,v.version,v.workflow_id,v.created_by,v.preparation_kind,v.is_active,v.snapshot_digest,v.state,
    w.workspace_id FROM workflow_deployment_version v JOIN workflow w ON w.id=v.workflow_id
    WHERE v.id=${binding.prepared.deploymentVersionId} AND v.workflow_id=${binding.prepared.workflowId}
      AND w.workspace_id=${binding.workspaceId} AND w.user_id=${userId} AND w.archived_at IS NULL LIMIT 2`
  capture(name, rows)
  await verifyInactiveVersionObservation(rows, binding, userId)
}

async function main() {
  const durableMode = durableFixtureMode(process.argv[2])
  const inactive = process.env.MEMLIA_CI_EXCEL_JOURNEY === 'inactive-test'
  assertRecipe(process.env.MEMLIA_CI_EXCEL_JOURNEY === undefined || inactive)
  assertRecipe(!inactive || durableMode !== undefined)
  const captureInactive: InactiveCapture = (name, value) => {
    assertRecipe(/^[a-z-]{1,48}$/.test(name))
    const raw = JSON.stringify(value)
    assertRecipe(Buffer.byteLength(raw) <= 4 * 1024 ** 2)
    writeFileSync('/scratch/inactive-' + name + '.private.json', raw + '\n', { mode: 0o600, flag: 'wx' })
  }
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
      if (inactive) {
        assertRecipe(prepared?.nonce === nonce && prepared.userId === fixture.userId && prepared.sourceSha256 === source.sha256)
        const submission = JSON.parse(readFileSync('/scratch/durable-submission.private.json', 'utf8'))
        const binding = await captureInactiveTestSubmission(submission, prepared.workflowId, prepared.workspaceId)
        await observeInactiveVersion(db, binding, fixture.userId, captureInactive, 'publish-version')
      }
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
    const inactiveBinding = inactive && submission ? await captureInactiveTestSubmission(submission, workflow.id, own.id) : undefined
    if (submission) {
      assertRecipe(submission.status === 'passed' && submission.browserClosed === true && submission.queued === true
        && submission.workflowId === workflow.id && submission.workspaceId === own.id
        && submission.jobId === 'workflow-execution:' + submission.executionId)
      if (durableMode === 'durable-retire') {
        const result = JSON.parse(readFileSync('/scratch/application-result.private.json', 'utf8'))
        assertRecipe(result.scope === (inactiveBinding ? 'native_inactive_test_compose' : 'native_durable_compose') && result.durable?.jobId === submission.jobId
          && result.durable?.completed === true && result.durable?.transportAcked === true)
        if (inactiveBinding) {
          assertRecipe(result.inactive?.workflowId === workflow.id && result.inactive.workspaceId === own.id
            && result.inactive.executionId === submission.executionId && result.inactive.deploymentVersionId === inactiveBinding.prepared.deploymentVersionId
            && result.inactive.snapshotDigest === inactiveBinding.prepared.snapshotDigest && result.inactive.versionInactive === true
            && result.inactive.payloadBound === true && result.inactive.journalVersionBound === true && result.inactive.resultFileBound === true)
          await observeInactiveVersion(db, inactiveBinding, userId, captureInactive, 'retire-version')
        }
        await retireOwnedRun(db, { runId: submission.executionId }, workflow, own, userId, submission.jobId,
          inactiveBinding ? { binding: inactiveBinding, capture: captureInactive } : undefined)
        writeFileSync('/scratch/durable-retired.private.json', JSON.stringify({ retired: true, ...(inactiveBinding ? { inactivePreparationRetired: true } : {}) }) + '\n', { mode: 0o600, flag: 'wx' })
        return
      }
    }
    let inactiveProof: { versionInactive: true; payloadBound: true; journalVersionBound: true } | undefined
    let journalVersion: string | undefined
    let run: { status: string; runId: string }
    if (submission) {
      stage = 'native_execution'
      const completion = await observeDurableCompletion(db, submission, workflow.id, own.id, userId, inactiveBinding, captureInactive)
      inactiveProof = completion.inactiveProof
      journalVersion = completion.journalDeploymentVersionId
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
    if (inactiveBinding) {
      const rows = await db.$client`SELECT l.execution_id,l.deployment_version_id,v.snapshot_digest,v.is_active,
        v.preparation_kind,v.created_by,f.id AS file_id,f.key,f.user_id,f.workspace_id,f.original_name,f.size_bytes::integer AS size_bytes,f.content_type
        FROM workflow_execution_logs l JOIN workflow_deployment_version v ON v.id=l.deployment_version_id
        JOIN workspace_files f ON f.workspace_id=l.workspace_id
        WHERE l.workflow_id=${workflow.id} AND l.workspace_id=${own.id} AND l.execution_id=${run.runId}
          AND l.status='completed' AND v.workflow_id=${workflow.id} AND v.id=${inactiveBinding.prepared.deploymentVersionId}
          AND f.id=${file.id} AND f.context='execution' AND f.project_id IS NULL AND f.organization_id IS NULL AND f.deleted_at IS NULL LIMIT 2`
      captureInactive('recorded-file', rows)
      assertRecipe(inactiveProof !== undefined)
      assertRecipe(rows.length === 1 && rows[0].execution_id === run.runId
        && rows[0].deployment_version_id === inactiveBinding.prepared.deploymentVersionId
        && rows[0].snapshot_digest === inactiveBinding.prepared.snapshotDigest && rows[0].is_active === false
        && rows[0].preparation_kind === 'excel_test_v1' && rows[0].created_by === userId && rows[0].user_id === userId
        && rows[0].workspace_id === own.id && rows[0].file_id === file.id && rows[0].original_name === file.name
        && rows[0].size_bytes === content.length && rows[0].content_type === XLSX
        && rows[0].key.startsWith('execution/' + own.id + '/' + workflow.id + '/' + run.runId + '/'))
    }
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
      scope: inactiveBinding ? 'native_inactive_test_compose' : submission ? 'native_durable_compose' : 'native_api_in_process', checks,
      ...(inactiveBinding ? { inactive: { workflowId: workflow.id, workspaceId: own.id, executionId: run.runId,
        deploymentVersionId: inactiveBinding.prepared.deploymentVersionId, snapshotDigest: inactiveBinding.prepared.snapshotDigest,
        ...inactiveProof, resultFileBound: true } } : {}),
      ...(submission ? { durable: { jobId: submission.jobId, executionId: submission.executionId, deploymentVersionId: journalVersion,
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
  workflow: { id: string }, own: { id: string }, userId: string, jobId?: string,
  inactive?: { binding: ExcelTestExecutionBinding; capture: InactiveCapture }) {
  assertRecipe(jobId === undefined || jobId === 'workflow-execution:' + run.runId)
  assertRecipe(!inactive || jobId !== undefined && inactive.binding.workspaceId === own.id
    && inactive.binding.prepared.workflowId === workflow.id)
  await db.$client.begin(async tx => {
      let jobRow: { id: string; version: string; digest: string; event_id: string; event_version: string; event_digest: string; payload?: unknown } | undefined
      if (jobId) {
        const rows = await tx<{ id: string; version: string; digest: string; event_id: string; event_version: string; event_digest: string; payload?: unknown }[]>`SELECT j.id,j.xmin::text AS version,md5(row_to_json(j)::text) AS digest,
          e.id AS event_id,e.xmin::text AS event_version,md5(row_to_json(e)::text) AS event_digest,j.payload
          FROM async_jobs j JOIN outbox_event e ON e.payload->>'nativeJobId'=j.id
          WHERE j.id=${jobId} AND j.type='workflow-execution' AND j.status='completed' AND j.attempts=1
            AND j.payload->>'executionId'=${run.runId} AND j.payload->>'workflowId'=${workflow.id}
            AND j.payload->>'workspaceId'=${own.id} AND j.payload->>'userId'=${userId}
            AND j.output->>'success'='true' AND e.event_type='memlia.pg-boss.publish' AND e.status='completed'
          LIMIT 2 FOR UPDATE OF j,e`
        if (inactive) inactive.capture('retire-job', rows)
        assertRecipe(rows.length === 1)
        if (inactive) await assertInactiveJobPayload(rows[0].payload, inactive.binding, run.runId, userId)
        jobRow = rows[0]
      }
      const owned = await tx`SELECT l.id AS log_id,l.xmin::text AS log_version,l.deployment_version_id,
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
      if (inactive) {
        const binding = inactive.binding
        assertRecipe(row.deployment_version_id === binding.prepared.deploymentVersionId)
        const identity = await inactivePreparationIdentity(binding, userId)
        const rows = await tx`SELECT k.key AS preparation_key,k.xmin::text AS preparation_version,
          md5(row_to_json(k)::text) AS preparation_digest,k.result,v.id,v.version,v.workflow_id,v.created_by,
          v.preparation_kind,v.is_active,v.snapshot_digest,v.state,w.workspace_id
          FROM idempotency_key k JOIN workflow_deployment_version v ON v.id=${binding.prepared.deploymentVersionId}
          JOIN workflow w ON w.id=v.workflow_id
          WHERE k.key=${identity.key} AND k.result=${JSON.stringify(identity.result)}::jsonb
            AND v.workflow_id=${workflow.id} AND v.version=${binding.prepared.version} AND w.workspace_id=${own.id} AND w.user_id=${userId}
            AND w.archived_at IS NULL AND v.created_by=${userId} AND v.preparation_kind='excel_test_v1'
            AND v.is_active=false AND v.snapshot_digest=${binding.prepared.snapshotDigest}
          LIMIT 2 FOR UPDATE OF k,v,w`
        inactive.capture('retire-preparation', rows)
        await verifyInactiveVersionObservation(rows, binding, userId)
        assertRecipe(rows[0].preparation_key === identity.key
          && typeof rows[0].preparation_version === 'string' && typeof rows[0].preparation_digest === 'string'
          && await nativeFixtureDigest(rows[0].result) === await nativeFixtureDigest(identity.result))
        const preparation = rows[0]
        const removed = await tx`DELETE FROM idempotency_key k WHERE k.key=${identity.key}
          AND k.xmin::text=${preparation.preparation_version} AND md5(row_to_json(k)::text)=${preparation.preparation_digest}
          AND k.result=${JSON.stringify(identity.result)}::jsonb RETURNING k.key`
        assertRecipe(removed.length === 1)
      }
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

/** The run the worker completed carries the browser-validated version, and that version is the live one. */
export function verifyActiveVersionBinding(log: unknown, active: unknown, deploymentVersionId: unknown,
  workflowId: string, workspaceId: string) {
  if (typeof deploymentVersionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}(?![\s\S])/.test(deploymentVersionId)
    || !record(log) || log.deployment_version_id !== deploymentVersionId || !Array.isArray(active) || active.length !== 1
    || !record(active[0]) || active[0].id !== deploymentVersionId || active[0].workflow_id !== workflowId
    || active[0].workspace_id !== workspaceId || active[0].is_active !== true) throw Error('excel_durable_version_unbound')
}
export async function observeDurableCompletion(db: typeof import('../../packages/db/index').db,
  submission: { jobId: string; executionId: string; deploymentVersionId?: unknown }, workflowId: string, workspaceId: string, userId: string,
  inactive?: ExcelTestExecutionBinding, capture: InactiveCapture = () => {},
  connect?: (href: string) => ReturnType<typeof import('postgres')>) {
  const queueUrl = new URL(process.env.MEMLIA_PG_BOSS_DATABASE_URL ?? '')
  const webUrl = new URL(process.env.DATABASE_URL!)
  assertRecipe(queueUrl.username === 'ui_transport_' + process.env.RECIPE_NONCE && queueUrl.hostname === webUrl.hostname
    && queueUrl.pathname === webUrl.pathname && queueUrl.port === webUrl.port && !queueUrl.search && !queueUrl.hash)
  const queue = connect ? connect(queueUrl.href) : (await import('postgres')).default(queueUrl.href,
    { max: 1, connect_timeout: 3, idle_timeout: 1, onnotice: () => {} })
  try {
    await verifyTransportIsolation(db, queue, queueUrl.username)
    if (inactive) await observeInactiveVersion(db, inactive, userId, capture, 'readback-version')
    let capturedFirst = false
    const deadline = performance.now() + 90_000
    while (performance.now() < deadline) {
      const rows = await db.$client`SELECT id,status,attempts,payload,output FROM async_jobs WHERE id=${submission.jobId}`
      if (inactive && !capturedFirst) { capture('job-first', rows); capturedFirst = true }
      assertRecipe(rows.length === 1)
      const job = rows[0]
      assertRecipe(job.id === submission.jobId)
      assertRecipe(job.payload.executionId === submission.executionId && job.payload.workflowId === workflowId
        && job.payload.workspaceId === workspaceId && job.payload.userId === userId
        && job.payload.principal?.principal?.kind === 'session')
      if (inactive) await assertInactiveJobPayload(job.payload, inactive, submission.executionId, userId)
      const deliveries = await queue`SELECT id,state FROM memlia_jobs.job
        WHERE name='memlia_native' AND data->>'nativeJobId'=${submission.jobId} LIMIT 2`
      assertRecipe(deliveries.length <= 1 && !['failed', 'cancelled'].includes(job.status))
      if (job.status === 'completed' && deliveries[0]?.state === 'completed') {
        assertRecipe(job.attempts === 1 && job.output?.success === true)
        const logs = await db.$client`SELECT execution_id,status,deployment_version_id FROM workflow_execution_logs
          WHERE workflow_id=${workflowId} AND workspace_id=${workspaceId} LIMIT 2`
        if (inactive) capture('job-completed', { jobs: rows, deliveries, logs })
        assertRecipe(logs.length === 1 && logs[0].execution_id === submission.executionId && logs[0].status === 'completed')
        if (inactive) {
          assertRecipe(logs[0].deployment_version_id === inactive.prepared.deploymentVersionId)
          return { journalDeploymentVersionId: logs[0].deployment_version_id as string,
            inactiveProof: { versionInactive: true as const, payloadBound: true as const, journalVersionBound: true as const } }
        }
        const active = await db.$client`SELECT v.id,v.workflow_id,v.is_active,w.workspace_id FROM workflow_deployment_version v
          JOIN workflow w ON w.id=v.workflow_id WHERE v.workflow_id=${workflowId} AND w.workspace_id=${workspaceId}
            AND v.is_active=true LIMIT 2`
        verifyActiveVersionBinding(logs[0], active, submission.deploymentVersionId, workflowId, workspaceId)
        // Emit the version read from the run journal, not the browser receipt it was checked against.
        return { journalDeploymentVersionId: logs[0].deployment_version_id as string }
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
