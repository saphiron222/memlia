// Copyright (c) 2026 Memlia. All rights reserved.
// Native session/write admission and contracts; persistence/resource ports are doubles.
import {
  createPersonalApiKeyPrincipal,
  createSessionPrincipal,
} from '@sim/testing/factories/principal.factory'
import {
  workflowContextMock,
  workflowContextMockFns,
} from '@sim/testing/mocks/workflow-context.mock'
import { workspaceAuthzMock, workspaceAuthzMockFns } from '@sim/testing/mocks/workspace-authz.mock'
import { beforeEach, expect, it, vi } from 'vitest'

const b = vi.hoisted(() => ({
  observation: vi.fn(),
  verify: vi.fn(),
  config: vi.fn(),
  find: vi.fn(),
  version: vi.fn(),
  run: vi.fn(),
  file: vi.fn(),
  authorizeFile: vi.fn(),
}))
vi.mock('@sim/platform-authz/workspace', () => workspaceAuthzMock)
vi.mock('@/lib/workflows/application/context', () => workflowContextMock)
vi.mock('@/lib/permission-groups/config-scope.server', () => ({
  resolvePermissionGroupConfig: b.config,
}))
vi.mock('@/lib/workflows/persistence/excel-test-snapshots', () => ({
  readExcelTestPreparationObservation: b.observation,
  verifyExcelTestSnapshot: b.verify,
}))
vi.mock('@/lib/workflows/persistence/excel-test-results', () => ({
  findExcelTestResultCandidates: b.find,
}))
vi.mock('./read-workflow-version', () => ({ readWorkflowVersion: { execute: b.version } }))
vi.mock('./read-workflow-run', () => ({ readWorkflowRun: { execute: b.run } }))
vi.mock('@/lib/uploads/server/metadata', () => ({ getFileMetadataByKey: b.file }))
vi.mock('./download-workflow-run-file', async (original) => ({
  ...(await original<typeof import('./download-workflow-run-file')>()),
  downloadWorkflowRunFileStream: { authorize: b.authorizeFile },
}))

import { officeProcedureResultSchema } from '@/lib/api/contracts/excel-office-procedures'
import { readExcelTestResultsContract } from '@/lib/api/contracts/excel-test-preparations'
import { readExcelTestResults } from './read-excel-test-results'

const digest = `sha256:${'a'.repeat(64)}`
const prepared = {
  status: 'prepared_for_test' as const,
  workflowId: 'workflow',
  deploymentVersionId: 'inactive-version',
  version: 2,
  snapshotDigest: digest,
  executionAvailable: false as const,
  activationAvailable: false as const,
}
const binding = () => ({
  workspaceId: 'space',
  preparation: { expectedRevision: 7, expectedStateDigest: digest, operationId: 'owned-op' },
  prepared: { ...prepared },
})
const input = () => ({ workflowId: 'workflow', body: { ...binding(), executionId: 'test-run' } })
const principal = () => createSessionPrincipal({ userId: 'subject', sessionId: 'session' })
const type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
function candidate(n = 0) {
  return {
    workflowId: 'workflow',
    workspaceId: 'space',
    deploymentVersionId: 'inactive-version',
    snapshotDigest: digest,
    executionId: 'test-run',
    resultFileId: `file-${n}`,
    key: `execution/space/workflow/test-run/${n}/result.xlsx`,
    size: 100,
    fileName: `result-${n}.xlsx`,
    contentType: type,
    contentUpdatedAt: new Date(1000),
    completedAt: new Date('2026-10-21T10:00:00.000Z'),
  }
}
function resources(rows = [candidate()]) {
  b.find.mockResolvedValue(rows)
  b.run.mockResolvedValue({
    status: 'completed',
    files: rows.map((r) => ({
      id: r.resultFileId,
      name: r.fileName,
      size: r.size,
      type: r.contentType,
    })),
    blockOutputs: {
      excel: {
        files: rows.map((r) => ({
          id: r.resultFileId,
          name: r.fileName,
          size: r.size,
          type: r.contentType,
          url: '/api/files/serve/result',
        })),
      },
    },
  })
  b.file.mockImplementation(async (key: string) => {
    const row = rows.find((r) => r.key === key)!
    return {
      id: row.resultFileId,
      workspaceId: 'space',
      userId: 'subject',
      context: 'execution',
      projectId: null,
      organizationId: null,
      key: row.key,
      originalName: row.fileName,
      sizeBytes: row.size,
      contentType: row.contentType,
      contentUpdatedAt: row.contentUpdatedAt,
    }
  })
}
beforeEach(() => {
  vi.clearAllMocks()
  workflowContextMockFns.mockResolveActiveWorkflowApplicationContext.mockResolvedValue({
    workflowId: 'workflow',
    workflow: { id: 'workflow', workspaceId: 'space' },
    workspaceId: 'space',
    workspaceOrganizationId: null,
    allowPersonalApiKeys: true,
    billedAccountUserId: 'billing',
  })
  workspaceAuthzMockFns.mockResolveEffectiveWorkspacePermission.mockResolvedValue('write')
  b.config.mockResolvedValue(null)
  b.authorizeFile.mockResolvedValue(undefined)
  b.observation.mockResolvedValue({ ...binding().preparation, blockTypes: ['memlia_excel'] })
  b.verify.mockResolvedValue(prepared)
  b.version.mockResolvedValue({
    version: {
      id: prepared.deploymentVersionId,
      version: prepared.version,
      isActive: false,
      preparationKind: 'excel_test_v1',
      createdBy: 'subject',
      snapshotDigest: digest,
      state: {
        blocks: {
          excel: { id: 'excel', type: 'memlia_excel', enabled: true },
          other: { id: 'other', type: 'http' },
        },
      },
    },
  })
  resources()
})
it('returns read-only results of the exact inactive test under current native preparation and file permissions', async () => {
  const result = await readExcelTestResults.execute({ principal: principal(), input: input() })
  expect(result).toEqual({
    status: 'completed',
    workflowId: 'workflow',
    executionId: 'test-run',
    deploymentVersionId: 'inactive-version',
    snapshotDigest: digest,
    items: [
      {
        resultFileId: 'file-0',
        fileName: 'result-0.xlsx',
        size: 100,
        contentType: type,
        resultContentVersion: 1000,
      },
    ],
    truncated: false,
  })
  expect(b.find).toHaveBeenCalledWith({
    workspaceId: 'space',
    userId: 'subject',
    workflowId: 'workflow',
    executionId: 'test-run',
    deploymentVersionId: 'inactive-version',
    snapshotDigest: digest,
  })
  expect(b.verify).toHaveBeenCalledTimes(2)
  expect(b.version).toHaveBeenCalledWith({
    principal: principal(),
    input: {
      workflowId: 'workflow',
      assertedWorkspaceId: 'space',
      version: 2,
      expectedDeploymentVersionId: 'inactive-version',
    },
  })
  expect(b.run).toHaveBeenCalledWith({
    principal: principal(),
    input: {
      workflowId: 'workflow',
      runId: 'test-run',
      includeOutput: true,
      selectedOutputs: ['excel'],
    },
  })
  expect(b.authorizeFile).toHaveBeenCalledExactlyOnceWith({
    principal: principal(),
    input: { workflowId: 'workflow', runId: 'test-run', fileId: 'file-0' },
  })
  expect(b.file).toHaveBeenCalledExactlyOnceWith(candidate().key, 'execution')
  expect(officeProcedureResultSchema.safeParse(result.items[0]).success).toBe(false)
})
it('denies a non-session principal, lost write, stale preparation and foreign workspace before discovery', async () => {
  await expect(
    readExcelTestResults.execute({ principal: createPersonalApiKeyPrincipal(), input: input() })
  ).rejects.toMatchObject({ code: 'forbidden' })
  workspaceAuthzMockFns.mockResolveEffectiveWorkspacePermission.mockResolvedValueOnce('read')
  await expect(
    readExcelTestResults.execute({ principal: principal(), input: input() })
  ).rejects.toMatchObject({ code: 'forbidden' })
  b.observation.mockResolvedValueOnce({
    ...binding().preparation,
    expectedRevision: 8,
    blockTypes: ['memlia_excel'],
  })
  await expect(
    readExcelTestResults.execute({ principal: principal(), input: input() })
  ).rejects.toMatchObject({ code: 'conflict' })
  const foreign = input()
  foreign.body.workspaceId = 'foreign'
  await expect(
    readExcelTestResults.execute({ principal: principal(), input: foreign })
  ).rejects.toThrow()
  expect(b.find).not.toHaveBeenCalled()
})
it.each(['active', 'owner', 'digest', 'kind', 'pin'])(
  'refuses changed native version %s without returning metadata',
  async (kind) => {
    const v = (await b.version.getMockImplementation()!()).version
    if (kind === 'active') v.isActive = true
    if (kind === 'owner') v.createdBy = 'foreign'
    if (kind === 'digest') v.snapshotDigest = `sha256:${'b'.repeat(64)}`
    if (kind === 'kind') v.preparationKind = null
    if (kind === 'pin') v.id = 'foreign'
    b.version.mockResolvedValueOnce({ version: v })
    await expect(
      readExcelTestResults.execute({ principal: principal(), input: input() })
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(b.find).not.toHaveBeenCalled()
  }
)
it.each(['version', 'execution', 'workspace', 'key', 'duplicate'])(
  'refuses ambiguous or foreign result metadata %s',
  async (kind) => {
    const row = candidate()
    if (kind === 'version') row.deploymentVersionId = 'foreign'
    if (kind === 'execution') row.executionId = 'foreign'
    if (kind === 'workspace') row.workspaceId = 'foreign'
    if (kind === 'key') row.key = 'workspace/space/private/secret.xlsx'
    resources(kind === 'duplicate' ? [row, row] : [row])
    await expect(
      readExcelTestResults.execute({ principal: principal(), input: input() })
    ).rejects.toMatchObject({ code: 'conflict' })
  }
)
it('withheld trace outputs or a file from another block never unlock result review', async () => {
  b.run.mockResolvedValueOnce({ status: 'completed', files: null, blockOutputs: null })
  expect(
    (await readExcelTestResults.execute({ principal: principal(), input: input() })).items
  ).toEqual([])
  b.run.mockResolvedValueOnce({
    status: 'completed',
    files: [{ id: 'file-0' }],
    blockOutputs: {
      other: {
        files: [
          { id: 'file-0', name: 'result-0.xlsx', size: 100, type, url: '/api/files/serve/result' },
        ],
      },
    },
  })
  expect(
    (await readExcelTestResults.execute({ principal: principal(), input: input() })).items
  ).toEqual([])
  expect(b.file).not.toHaveBeenCalled()
})
it('denies revoked file permission and changed bytes metadata instead of reusing a stale descriptor', async () => {
  b.authorizeFile.mockRejectedValueOnce({ code: 'forbidden' })
  await expect(
    readExcelTestResults.execute({ principal: principal(), input: input() })
  ).rejects.toMatchObject({ code: 'forbidden' })
  b.file.mockResolvedValueOnce({
    id: 'file-0',
    workspaceId: 'space',
    userId: 'subject',
    context: 'execution',
    projectId: null,
    organizationId: null,
    key: candidate().key,
    originalName: candidate().fileName,
    sizeBytes: 101,
    contentType: type,
    contentUpdatedAt: new Date(1001),
  })
  await expect(
    readExcelTestResults.execute({ principal: principal(), input: input() })
  ).rejects.toMatchObject({ code: 'conflict' })
})
it('rechecks preparation after asynchronous reads and never returns results if activation or graph changed', async () => {
  b.verify.mockResolvedValueOnce(prepared).mockRejectedValueOnce(new Error('private DB diagnostic'))
  await expect(
    readExcelTestResults.execute({ principal: principal(), input: input() })
  ).rejects.toMatchObject({ code: 'conflict', message: 'excel_test_execution_refused' })
})
it('returns at most 50 unique files, with an explicit truncated indicator', async () => {
  resources(Array.from({ length: 51 }, (_, n) => candidate(n)))
  const result = await readExcelTestResults.execute({ principal: principal(), input: input() })
  expect(result.items).toHaveLength(50)
  expect(result.truncated).toBe(true)
  expect(b.file).toHaveBeenCalledTimes(50)
  expect(
    readExcelTestResultsContract.response.schema.safeParse({
      ...result,
      items: [result.items[0], result.items[0]],
    }).success
  ).toBe(false)
  expect(
    readExcelTestResultsContract.response.schema.safeParse({ ...result, activate: true }).success
  ).toBe(false)
  expect(
    readExcelTestResultsContract.response.schema.safeParse({
      ...result,
      items: [{ ...result.items[0], downloadPath: 'https://external.invalid/result' }],
    }).success
  ).toBe(false)
  expect(
    readExcelTestResultsContract.body.safeParse({ ...input().body, source: 'untrusted' }).success
  ).toBe(false)
})

it('refuses native run-file authorization denial and a foreign or changed canonical file record', async () => {
  b.authorizeFile.mockRejectedValueOnce({ code: 'forbidden' })
  await expect(
    readExcelTestResults.execute({ principal: principal(), input: input() })
  ).rejects.toMatchObject({ code: 'forbidden' })
  expect(b.file).not.toHaveBeenCalled()
  const file = await b.file.getMockImplementation()!(candidate().key)
  for (const change of [
    { userId: 'foreign' },
    { workspaceId: 'foreign' },
    { context: 'office-backup' },
    { projectId: 'foreign' },
    { contentUpdatedAt: new Date(2000) },
  ]) {
    b.file.mockResolvedValueOnce({ ...file, ...change })
    await expect(
      readExcelTestResults.execute({ principal: principal(), input: input() })
    ).rejects.toMatchObject({ code: 'conflict' })
  }
})
