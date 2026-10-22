// Copyright (c) 2026 Memlia. All rights reserved.
import { createHash } from 'node:crypto'
import { beforeEach, expect, test, vi } from 'vitest'
import { captureExcelProcess } from '@/lib/execution/sandbox/excel-process-protocol'
import { presentInternalToolOperationResult } from '@/lib/internal/tool-operations/file-result.server'
import { executeExcelFile } from './execute-excel-file.server'

const mocks = vi.hoisted(() => ({
  bind: vi.fn(),
  canonical: vi.fn(),
  read: vi.fn(),
  host: vi.fn(),
  upload: vi.fn(),
  remove: vi.fn(),
  metadata: vi.fn(),
}))
vi.mock('@/lib/internal/principals/executor', () => ({
  createExecutorPrincipalFromExecutionContext: mocks.bind,
}))
vi.mock('@/lib/workflows/application/context', () => ({
  resolveActiveWorkflowApplicationContext: mocks.canonical,
}))
vi.mock('@/lib/workspace-files/application/read-workspace-file-content', () => ({
  readWorkspaceFileContent: { execute: mocks.read },
}))
vi.mock('@/lib/execution/sandbox/excel-host', () => ({ prepareExcelThroughHost: mocks.host }))
vi.mock('@/lib/uploads/contexts/execution', () => ({ uploadExecutionFile: mocks.upload }))
vi.mock('@/lib/uploads/contexts/copilot', () => ({
  uploadCopilotFile: vi.fn(() => {
    throw new Error('unexpected copilot')
  }),
}))
vi.mock('@/lib/uploads/core/storage-service', () => ({ deleteFile: mocks.remove }))
vi.mock('@/lib/uploads/server/metadata', () => ({ deleteFileMetadata: mocks.metadata }))
const area = { sheetId: 'result-sheet', startRow: 1, endRow: 3, startColumn: 1, endColumn: 3 }
function wireInput() {
  const content = Buffer.from('fictitious transport only')
  return {
    procedure: {
      schemaVersion: 'memlia.excel-procedure/v1',
      organizationId: null,
      workspaceId: 'workspace-fixture',
      procedureId: 'procedure-fixture',
      version: 1,
      parentVersion: null,
      workflowId: 'workflow-fixture',
      deployedVersionId: 'deployed-fixture',
      ownerUserId: 'user-fixture',
      digest: `sha256:${'a'.repeat(64)}`,
      policyVersion: 'policy-fixture',
      inputs: [
        {
          role: 'source',
          bindingId: 'source-binding',
          format: 'xlsx',
          sheetId: 'source-sheet',
          columns: [
            { name: 'id', type: 'string', nullable: false },
            { name: 'debit', type: 'decimal', nullable: true },
            { name: 'credit', type: 'decimal', nullable: true },
          ],
          keyColumns: ['id'],
          cardinality: 'one',
          locale: 'en-US',
          nullPolicy: 'preserve',
        },
      ],
      mappings: [],
      operations: [
        { op: 'select', input: 'source', output: 'selected', columns: ['id', 'debit', 'credit'] },
      ],
      writes: [
        {
          input: 'selected',
          destinationBindingId: 'result-binding',
          range: area,
          columns: [
            { source: 'id', targetColumn: 1 },
            { source: 'debit', targetColumn: 2 },
            { source: 'credit', targetColumn: 3 },
          ],
          mode: 'regenerate_owned_zone',
        },
      ],
      writeScopes: [area],
      protectedScopes: [],
      decimalPolicy: { precision: 18, scale: 2, rounding: 'half_even', allNullAggregate: 'null' },
      formulaPolicy: { externalLinks: 'reject', dataStrings: 'literal', allowedFunctions: [] },
      controls: [
        {
          kind: 'balance',
          input: 'selected',
          debit: 'debit',
          credit: 'credit',
          tolerance: '0.00',
          severity: 'blocking',
        },
      ],
      requiredCapabilities: ['file.xlsx', 'table.select'],
      limits: { maxRows: 100, maxCells: 1000, timeoutSeconds: 1 },
      idempotence: { mode: 'regenerate_owned_zone', businessKeyColumns: ['id'] },
      outputs: [{ role: 'result', bindingId: 'result-binding', format: 'xlsx' }],
    },
    sources: {
      source: {
        bindingId: 'source-binding',
        sheetId: 'source-sheet',
        sheetName: 'Input',
        contentBase64: content.toString('base64'),
        sha256: `sha256:${createHash('sha256').update(content).digest('hex')}`,
      },
    },
    targets: {
      result: { bindingId: 'result-binding', sheetId: 'result-sheet', sheetName: 'Result' },
    },
  }
}

const runtime = { socketPath: '/run/memlia/excel.sock', operatorUid: 0 }
function context() {
  return {
    workspaceId: 'workspace-fixture',
    workflowId: 'workflow-fixture',
    executionId: 'run-fixture',
    userId: 'executor-fixture',
    executorDelegationOrigin: {
      workflowId: 'workflow-fixture',
      executionId: 'run-fixture',
      subjectUserId: 'executor-fixture',
      principal: {
        kind: 'session' as const,
        userId: 'executor-fixture',
        sessionId: 'session-fixture',
      },
    },
  }
}
function input() {
  return {
    procedure: wireInput().procedure,
    sources: { source: { fileId: 'file-fixture', sheetName: 'Input' } },
    output: { sheetName: 'Result', fileName: 'result.xlsx' },
  }
}
function source() {
  return {
    file: {
      id: 'file-fixture',
      workspaceId: 'workspace-fixture',
      key: 'workspace/file-fixture',
      storageContext: 'workspace',
      contentUpdatedAt: new Date(1000),
      uploadedBy: 'different-author',
    },
    content: Buffer.from('synthetic input bytes'),
    secretProvenance: {
      status: 'exact',
      entries: [{ sourceUserId: 'different-author', encryptedValue: 'ciphertext-fixture' }],
    },
  }
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.bind.mockResolvedValue({
    kind: 'delegated',
    serviceId: 'executor',
    workspaceId: 'workspace-fixture',
    subjectUserId: 'executor-fixture',
  })
  mocks.canonical.mockResolvedValue({
    workspaceId: 'workspace-fixture',
    workspaceOrganizationId: null,
    workflowId: 'workflow-fixture',
  })
  mocks.read.mockImplementation(async () => source())
  mocks.host.mockImplementation(async (input, _runtime, options) => {
    const capture = captureExcelProcess(input, options)
    const request = JSON.parse(capture.body)
    const content = Buffer.from('synthetic output bytes')
    return capture.accept(
      JSON.stringify({
        schemaVersion: 'memlia.excel-process/v1',
        requestId: request.requestId,
        status: 'prepared_in_memory',
        published: false,
        outputs: [
          {
            role: 'result',
            bindingId: 'result-binding',
            sheetId: 'result-sheet',
            contentBase64: content.toString('base64'),
            sha256: 'sha256:' + createHash('sha256').update(content).digest('hex'),
          },
        ],
        controls: [{ index: 0, kind: 'balance', severity: 'blocking', satisfied: true }],
      }) + '\n'
    )
  })
  mocks.upload.mockResolvedValue({
    id: 'stored-fixture',
    key: 'execution/stored-fixture',
    name: 'result.xlsx',
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    size: 22,
    context: 'execution',
    url: 'https://storage.invalid/fictitious',
  })
  mocks.remove.mockResolvedValue(undefined)
  mocks.metadata.mockResolvedValue(true)
})
test('composes authorized reads, host and native file presenter while preserving a shared author classification', async () => {
  const ctx = context()
  const result = await executeExcelFile(input(), ctx, runtime)
  expect(mocks.upload).not.toHaveBeenCalled()
  const response = await presentInternalToolOperationResult(result, ctx)
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    success: true,
    output: { file: { id: 'stored-fixture' } },
  })
  expect(mocks.host).toHaveBeenCalledTimes(1)
  expect(mocks.read).toHaveBeenCalledTimes(3)
  expect(mocks.upload.mock.calls[0]?.[5]).toEqual(source().secretProvenance)
})
test.each([
  'copilot',
  'workflowless',
  'no-origin',
  'no-run',
  'scope',
  'unknown',
  'absent',
  'denied',
  'overwrite',
])('refuses %s before host or storage', async (kind) => {
  const ctx = context()
  const data = input()
  if (kind === 'copilot') Object.assign(ctx, { copilotToolExecution: true })
  if (kind === 'workflowless') ctx.workflowId = ''
  if (kind === 'no-origin') Object.assign(ctx, { executorDelegationOrigin: undefined })
  if (kind === 'no-run') ctx.executionId = ''
  if (kind === 'scope') data.procedure.workspaceId = 'foreign'
  if (kind === 'unknown')
    mocks.read.mockResolvedValue({ ...source(), secretProvenance: { status: 'unknown' } })
  if (kind === 'absent') mocks.read.mockResolvedValue({ ...source(), secretProvenance: undefined })
  if (kind === 'denied') mocks.read.mockRejectedValue(new Error('private-canary'))
  if (kind === 'overwrite') data.procedure.writes[0].mode = 'update_input'
  await expect(executeExcelFile(data, ctx, runtime)).rejects.toThrow('excel_file_refused')
  expect(mocks.host).not.toHaveBeenCalled()
  expect(mocks.upload).not.toHaveBeenCalled()
})
test.each(['version', 'bytes', 'classification', 'permission', 'run'])(
  'revalidates %s before upload',
  async (kind) => {
    const ctx = context()
    const result = await executeExcelFile(input(), ctx, runtime)
    if (kind === 'version')
      mocks.read.mockResolvedValue({
        ...source(),
        file: { ...source().file, contentUpdatedAt: new Date(2000) },
      })
    if (kind === 'bytes')
      mocks.read.mockResolvedValue({ ...source(), content: Buffer.from('changed') })
    if (kind === 'classification')
      mocks.read.mockResolvedValue({ ...source(), secretProvenance: { status: 'unrecorded' } })
    if (kind === 'permission') mocks.read.mockRejectedValue(new Error('private-canary'))
    if (kind === 'run') ctx.executionId = 'foreign'
    await expect(presentInternalToolOperationResult(result, ctx)).rejects.toThrow(
      'excel_file_refused'
    )
    expect(mocks.upload).not.toHaveBeenCalled()
  }
)
test('rolls back newly stored file when rights change before presentation', async () => {
  const ctx = context()
  const result = await executeExcelFile(input(), ctx, runtime)
  mocks.upload.mockImplementationOnce(async () => {
    mocks.read.mockRejectedValue(new Error('private-canary'))
    return { key: 'execution/new-owned', id: 'new-owned' }
  })
  await expect(presentInternalToolOperationResult(result, ctx)).rejects.toThrow(
    'excel_file_refused'
  )
  expect(mocks.remove).toHaveBeenCalledWith({ key: 'execution/new-owned', context: 'execution' })
})
test('captures procedure, source selection, runtime and execution origin before await', async () => {
  let release!: () => void
  const wait = new Promise<void>((r) => {
    release = r
  })
  mocks.bind.mockImplementationOnce(async () => {
    await wait
    return {
      kind: 'delegated',
      serviceId: 'executor',
      workspaceId: 'workspace-fixture',
      subjectUserId: 'executor-fixture',
    }
  })
  const ctx = context()
  const data = input()
  const rt = { ...runtime }
  const work = executeExcelFile(data, ctx, rt)
  data.sources.source.fileId = 'foreign'
  data.procedure.inputs[0].role = 'foreign'
  ctx.executorDelegationOrigin.principal.userId = 'foreign'
  rt.socketPath = '/foreign'
  release()
  await work
  expect(mocks.read.mock.calls[0][0].input.fileId).toBe('file-fixture')
  expect(mocks.host.mock.calls[0][1]).toEqual(runtime)
  expect(mocks.bind.mock.calls[0][0].context.executorDelegationOrigin.principal.userId).toBe(
    'executor-fixture'
  )
})
test('broken publication binding cannot upload via copied result or copied protected file', async () => {
  const ctx = context()
  const result = await executeExcelFile(input(), ctx, runtime)
  await expect(presentInternalToolOperationResult({ ...result }, ctx)).rejects.toThrow()
  await expect(
    presentInternalToolOperationResult(
      { kind: 'file-output', files: [...result.files], present: result.present },
      ctx
    )
  ).rejects.toThrow()
  expect(mocks.upload).not.toHaveBeenCalled()
})

test('preserves unrecorded provenance without inventing empty exact classification', async () => {
  mocks.read.mockResolvedValue({ ...source(), secretProvenance: { status: 'unrecorded' } })
  const ctx = context()
  const result = await executeExcelFile(input(), ctx, runtime)
  await presentInternalToolOperationResult(result, ctx)
  expect(mocks.upload.mock.calls[0][5]).toEqual({ status: 'unrecorded' })
})
test.each(['before', 'during-host', 'after-prepare'])('abort %s never uploads', async (stage) => {
  const abort = new AbortController()
  const ctx = context()
  if (stage === 'before') abort.abort()
  if (stage === 'during-host')
    mocks.host.mockImplementationOnce(async () => {
      abort.abort()
      throw new Error('private-canary')
    })
  if (stage === 'after-prepare') {
    const result = await executeExcelFile(input(), ctx, runtime, abort.signal)
    abort.abort()
    await expect(presentInternalToolOperationResult(result, ctx)).rejects.toThrow(
      'excel_file_refused'
    )
  } else
    await expect(executeExcelFile(input(), ctx, runtime, abort.signal)).rejects.toThrow(
      'excel_file_refused'
    )
  expect(mocks.upload).not.toHaveBeenCalled()
  if (stage === 'before') expect(mocks.bind).not.toHaveBeenCalled()
})
test.each([
  'workspace',
  'organization',
  'principal',
  'missing-version',
  'oversize',
  'malformed-classification',
  'extra-source',
  'runtime-in-input',
  'getter',
])('refuses %s without transport', async (kind) => {
  const data = input()
  const ctx = context()
  if (kind === 'workspace')
    mocks.canonical.mockResolvedValue({ workspaceId: 'foreign', workspaceOrganizationId: null })
  if (kind === 'organization')
    mocks.canonical.mockResolvedValue({
      workspaceId: ctx.workspaceId,
      workspaceOrganizationId: 'foreign',
    })
  if (kind === 'principal')
    mocks.bind.mockResolvedValue({
      kind: 'delegated',
      serviceId: 'executor',
      workspaceId: ctx.workspaceId,
      subjectUserId: 'foreign',
    })
  if (kind === 'missing-version')
    mocks.read.mockResolvedValue({
      ...source(),
      file: { ...source().file, contentUpdatedAt: undefined },
    })
  if (kind === 'oversize')
    mocks.read.mockResolvedValue({ ...source(), content: Buffer.alloc(10_000_001) })
  if (kind === 'malformed-classification')
    mocks.read.mockResolvedValue({ ...source(), secretProvenance: { status: 'empty' } })
  if (kind === 'extra-source')
    Object.assign(data.sources, { foreign: { fileId: 'foreign', sheetName: 'Input' } })
  if (kind === 'runtime-in-input') Object.assign(data, { socketPath: '/foreign' })
  if (kind === 'getter')
    Object.defineProperty(data.sources.source, 'fileId', {
      get() {
        throw new Error('getter-canary')
      },
    })
  await expect(executeExcelFile(data, ctx, runtime)).rejects.toThrow('excel_file_refused')
  expect(mocks.host).not.toHaveBeenCalled()
  expect(mocks.upload).not.toHaveBeenCalled()
})
test('mutation of protected result bytes refuses rather than publishing a different file', async () => {
  const ctx = context()
  const result = await executeExcelFile(input(), ctx, runtime)
  result.files[0].buffer[0] ^= 1
  await expect(presentInternalToolOperationResult(result, ctx)).rejects.toThrow(
    'Tool file publication binding changed'
  )
  expect(mocks.upload).not.toHaveBeenCalled()
})
test('the same guarded result cannot be presented concurrently or reused', async () => {
  const ctx = context()
  const result = await executeExcelFile(input(), ctx, runtime)
  const first = presentInternalToolOperationResult(result, ctx)
  await expect(presentInternalToolOperationResult(result, ctx)).rejects.toThrow()
  await first
  expect(mocks.upload).toHaveBeenCalledTimes(1)
})

test('publication rejects a different principal even when run identifiers match', async () => {
  const ctx = context()
  const result = await executeExcelFile(input(), ctx, runtime)
  ctx.executorDelegationOrigin.principal.sessionId = 'different-session'
  await expect(presentInternalToolOperationResult(result, ctx)).rejects.toThrow(
    'excel_file_refused'
  )
  expect(mocks.upload).not.toHaveBeenCalled()
})

test('refuses an execution-origin accessor without invoking caller code', async () => {
  const ctx = context()
  const getter = vi.fn(() => ({
    kind: 'session',
    userId: 'executor-fixture',
    sessionId: 'session-fixture',
  }))
  Object.defineProperty(ctx.executorDelegationOrigin, 'principal', { get: getter })
  await expect(executeExcelFile(input(), ctx, runtime)).rejects.toThrow('excel_file_refused')
  expect(getter).not.toHaveBeenCalled()
  expect(mocks.bind).not.toHaveBeenCalled()
})
