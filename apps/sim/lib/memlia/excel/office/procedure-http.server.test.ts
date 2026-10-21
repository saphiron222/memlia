// Copyright (c) 2026 Memlia. All rights reserved.
import { createHash } from 'node:crypto'
import {
  createSessionPrincipal,
  createWorkspaceApiKeyPrincipal,
} from '@sim/testing/factories/principal.factory'
import { auditMock } from '@sim/testing/mocks/audit.mock'
import { workspaceAuthzMock, workspaceAuthzMockFns } from '@sim/testing/mocks/workspace-authz.mock'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as XLSX from 'xlsx'
import { OrchestrationError } from '@/lib/core/orchestration/types'
import { normalizedStringify } from '@/lib/workflows/comparison/normalize'
import { fixtures } from '../../../../../../packages/memlia-contracts/tests/fixtures'

const m = vi.hoisted(() => ({
  find: vi.fn(),
  version: vi.fn(),
  run: vi.fn(),
  download: vi.fn(),
  backup: vi.fn(),
  backupRead: vi.fn(),
  context: vi.fn(),
}))
vi.mock('@sim/audit', () => auditMock)
vi.mock('@sim/platform-authz/workspace', () => workspaceAuthzMock)
vi.mock('@/lib/workspaces/application/context', () => ({
  resolveActiveWorkspaceApplicationContext: m.context,
}))
vi.mock('./procedure-repository.server', () => ({ findOfficeProcedureCandidates: m.find }))
vi.mock('@/lib/workflows/application/read-workflow-version', () => ({
  readWorkflowVersion: { execute: m.version },
}))
vi.mock('@/lib/workflows/application/read-workflow-run', () => ({
  readWorkflowRun: { execute: m.run },
}))
vi.mock('@/lib/workflows/application/download-workflow-run-file', () => ({
  downloadWorkflowRunFileStream: { execute: m.download },
}))
vi.mock('@/lib/uploads/contexts/workspace/file-manager', () => ({
  readOfficeBackupFileRecord: m.backup,
}))
vi.mock('@/lib/workspace-files/application/office-backups', async (original) => ({
  ...(await original<typeof import('@/lib/workspace-files/application/office-backups')>()),
  readPrivateOfficeBackup: m.backupRead,
}))

import { listOfficeProcedureResults, prepareOfficeProcedureEdit } from './procedure-http.server'

const p = () => createSessionPrincipal({ userId: 'user-fixture', sessionId: 'session-fixture' })
const digest = (value: unknown) =>
  `sha256:${createHash('sha256').update(normalizedStringify(value)).digest('hex')}`
const source = () => ({
  workflowId: 'workflow-fixture',
  deploymentVersionId: 'version-fixture',
  blockId: 'excel',
  executionId: 'run-fixture',
  resultFileId: 'file_result',
  resultContentVersion: 1000,
  workflowName: 'Procédure',
  procedureName: 'Transformer',
  fileName: 'result.xlsx',
  completedAt: '2026-10-21T10:00:00.000Z',
})
function setup() {
  const full = structuredClone(fixtures.ExcelProcedure)
  full.decimalPolicy.precision = 18
  const { digest: _, ...unsigned } = full
  const procedure = { ...unsigned, digest: digest(unsigned) }
  const state = {
    blocks: {
      excel: {
        id: 'excel',
        type: 'memlia_excel',
        name: 'Transformer',
        enabled: true,
        subBlocks: {
          request: {
            id: 'request',
            type: 'code',
            value: JSON.stringify({ procedure, sources: {}, output: {} }),
          },
        },
      },
    },
  }
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([[8.25, '=1+2']]), 'Résultat')
  const content = XLSX.write(book, {
    type: 'buffer',
    bookType: 'xlsx',
    compression: true,
  }) as Buffer
  const row = {
    workflowId: 'workflow-fixture',
    workflowName: 'Procédure',
    deploymentVersionId: 'version-fixture',
    executionId: 'run-fixture',
    completedAt: new Date(source().completedAt),
    resultFileId: 'file_result',
    key: 'execution/workspace-fixture/workflow-fixture/run-fixture/unique/result.xlsx',
    size: content.length,
    fileName: 'result.xlsx',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    contentUpdatedAt: new Date(1000),
    snapshotDigest: digest(state),
  }
  const file = {
    id: row.resultFileId,
    key: row.key,
    name: row.fileName,
    size: row.size,
    type: row.contentType,
    url: '/api/files/serve/result',
    context: 'execution',
  }
  m.context.mockResolvedValue({
    workspaceId: 'workspace-fixture',
    workspaceOrganizationId: 'org-fixture',
    allowPersonalApiKeys: false,
    billedAccountUserId: 'billing-user',
  })
  workspaceAuthzMockFns.mockResolveEffectiveWorkspacePermission.mockResolvedValue('write')
  m.find.mockResolvedValue([row])
  m.version.mockResolvedValue({ version: { id: 'version-fixture', isActive: true, state } })
  m.run.mockResolvedValue({
    status: 'completed',
    files: [{ id: file.id }],
    blockOutputs: { excel: { files: [file] } },
  })
  m.backup.mockResolvedValue({ id: 'wf_backup', version: 900 })
  m.backupRead.mockResolvedValue({
    file: { id: 'wf_backup', version: 900 },
    content: Buffer.from('native-backup-double'),
  })
  m.download.mockImplementation(async () => ({
    file,
    contentType: row.contentType,
    contentLength: row.size,
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue(content)
        controller.close()
      },
    }),
  }))
  return { row, state, content }
}
const input = () => ({
  workspaceId: 'workspace-fixture',
  source: source(),
  backupFileId: 'wf_backup',
})

describe('Office procedure proposal composition (native authorization funnel; native resource ports doubled)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setup()
  })
  it('lists only source descriptors and projects the real XLSX through the existing bounded parser', async () => {
    const listed = await listOfficeProcedureResults.execute({
      principal: p(),
      input: { workspaceId: 'workspace-fixture' },
    })
    expect(listed).toEqual({ items: [source()], truncated: false })
    expect(m.find).toHaveBeenCalledWith('workspace-fixture', 'user-fixture')
    const preview = await prepareOfficeProcedureEdit.execute({ principal: p(), input: input() })
    expect(preview).toEqual({
      status: 'prepared',
      source: source(),
      backupFileId: 'wf_backup',
      values: [[8.25, '=1+2']],
    })
    expect(m.backupRead).toHaveBeenCalledTimes(2)
    expect(m.download).toHaveBeenCalledWith({
      principal: p(),
      input: { workflowId: 'workflow-fixture', runId: 'run-fixture', fileId: 'file_result' },
    })
    expect(m.version).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          assertedWorkspaceId: 'workspace-fixture',
          expectedDeploymentVersionId: 'version-fixture',
        }),
      })
    )
    expect(JSON.stringify(preview)).not.toContain('execution/workspace-')
  })
  it('uses the actual authorization funnel to deny a nonmember before metadata or byte reads', async () => {
    workspaceAuthzMockFns.mockResolveEffectiveWorkspacePermission.mockResolvedValue(null)
    await expect(
      prepareOfficeProcedureEdit.execute({ principal: p(), input: input() })
    ).rejects.toThrow()
    expect(m.find).not.toHaveBeenCalled()
    expect(m.download).not.toHaveBeenCalled()
  })
  it('rejects an actorless key before exposing any catalogue metadata', async () => {
    await expect(
      listOfficeProcedureResults.execute({
        principal: createWorkspaceApiKeyPrincipal(),
        input: { workspaceId: 'workspace-fixture' },
      })
    ).rejects.toThrow()
    expect(m.find).not.toHaveBeenCalled()
  })
  it('does not bypass a withheld trace projection even if the native run file list exists', async () => {
    m.run.mockResolvedValue({
      status: 'completed',
      files: [{ id: 'file_result' }],
      blockOutputs: null,
    })
    expect(
      await listOfficeProcedureResults.execute({
        principal: p(),
        input: { workspaceId: 'workspace-fixture' },
      })
    ).toEqual({ items: [], truncated: false })
    await expect(
      prepareOfficeProcedureEdit.execute({ principal: p(), input: input() })
    ).rejects.toThrow('not found')
    expect(m.download).not.toHaveBeenCalled()
  })
  it('refuses a file from another block even if it appears in the run file list', async () => {
    m.run.mockResolvedValue({
      status: 'completed',
      files: [{ id: 'file_result' }],
      blockOutputs: { excel: { value: 2 } },
    })
    await expect(
      prepareOfficeProcedureEdit.execute({ principal: p(), input: input() })
    ).rejects.toThrow('not found')
    expect(m.download).not.toHaveBeenCalled()
  })
  it('does not turn an inactive test preparation or a changed graph into a published result', async () => {
    m.version.mockResolvedValue({ version: { isActive: false, state: setup().state } })
    await expect(
      prepareOfficeProcedureEdit.execute({ principal: p(), input: input() })
    ).rejects.toThrow('not found')
    expect(m.download).not.toHaveBeenCalled()
  })
  it('refuses changed result version and a forged source label before any byte read', async () => {
    for (const changed of [{ resultContentVersion: 1001 }, { procedureName: 'Forgé' }]) {
      await expect(
        prepareOfficeProcedureEdit.execute({
          principal: p(),
          input: { ...input(), source: { ...source(), ...changed } },
        })
      ).rejects.toThrow('not found')
    }
    expect(m.download).not.toHaveBeenCalled()
  })
  it('requires the native owner-only backup read and propagates its denial without downloading', async () => {
    m.backupRead.mockRejectedValue(new OrchestrationError('not_found', 'Office backup not found'))
    await expect(
      prepareOfficeProcedureEdit.execute({ principal: p(), input: input() })
    ).rejects.toThrow('Office backup not found')
    expect(m.download).not.toHaveBeenCalled()
  })
  it('revalidates canonical deployment/result after download instead of returning a stale proposal', async () => {
    const { row } = setup()
    m.find
      .mockResolvedValueOnce([row])
      .mockResolvedValueOnce([{ ...row, contentUpdatedAt: new Date(1001) }])
    await expect(
      prepareOfficeProcedureEdit.execute({ principal: p(), input: input() })
    ).rejects.toThrow('not found')
    expect(m.download).toHaveBeenCalledTimes(1)
  })
  it('honors an already-aborted request without touching metadata', async () => {
    const abort = new AbortController()
    abort.abort()
    await expect(
      prepareOfficeProcedureEdit.execute({
        principal: p(),
        input: input(),
        request: { headers: new Headers(), signal: abort.signal },
      })
    ).rejects.toThrow()
    expect(m.find).not.toHaveBeenCalled()
  })
})
