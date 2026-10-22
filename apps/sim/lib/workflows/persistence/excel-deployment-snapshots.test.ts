// Copyright (c) 2026 Memlia. All rights reserved.
import { ExcelProcedureSchema } from '@memlia/contracts'
import type { PrincipalActor } from '@sim/auth/principal'
import { dbChainMockFns, queueTableRows, resetDbChainMock, schemaMock } from '@sim/testing'
import { getMockLogger } from '@sim/testing/mocks/logger.mock'
import {
  permissionGroupScopeMock,
  permissionGroupScopeMockFns,
} from '@sim/testing/mocks/permission-group-scope.mock'
import { DrizzleQueryError } from 'drizzle-orm/errors'
import postgres from 'postgres'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  materializeExcelProcedureSnapshot,
  readExcelProcedureSnapshotCapture,
} from '@/lib/memlia/excel/materialize-procedure-snapshot'
import { excelProcedureDraftSchema } from '@/lib/memlia/excel/procedure-capabilities'
import { fixtures } from '../../../../../packages/memlia-contracts/tests/fixtures'
import { captureWorkflowExcelDeploymentSnapshot } from './excel-deployment-snapshots'

vi.mock('@/lib/permission-groups/config-scope.server', () => permissionGroupScopeMock)

function input(actor: PrincipalActor | undefined = { kind: 'session', userId: 'author' }) {
  return {
    workflowId: 'workflow',
    assertedWorkspaceId: 'space',
    idempotencyKey: 'publish',
    actor,
    requestId: 'request',
  }
}
function expectRefusalCheck(check: string, extra: Record<string, unknown> = {}) {
  expect(getMockLogger('ExcelDeploymentSnapshots').error).toHaveBeenCalledTimes(1)
  expect(getMockLogger('ExcelDeploymentSnapshots').error).toHaveBeenCalledWith(
    '[request] Excel deployment snapshot refused',
    { workflowId: 'workflow', check, ...extra }
  )
}
function queueGraph(
  change: {
    workspaceId?: string
    revision?: number
    storedRevision?: number
    padRequestTo?: number
    archived?: boolean
    workspaceArchived?: boolean
    noExcel?: boolean
    request?: unknown
    requestValue?: string
    name?: string
  } = {}
) {
  const full = structuredClone(fixtures.ExcelProcedure)
  full.decimalPolicy.precision = 18
  const procedure = excelProcedureDraftSchema.parse(
    Object.fromEntries(
      Object.entries(full).filter(([key]) => key in excelProcedureDraftSchema.shape)
    )
  )
  queueTableRows(schemaMock.workflow, [
    {
      workspaceId: 'space',
      draftRevision: change.storedRevision ?? 7,
      variables: {},
      archivedAt: change.archived ? new Date() : null,
    },
  ])
  queueTableRows(schemaMock.workflow, [
    {
      workspaceId: change.workspaceId ?? 'space',
      draftRevision: change.revision ?? change.storedRevision ?? 7,
    },
  ])
  queueTableRows(schemaMock.workspace, [
    { organizationId: null, archivedAt: change.workspaceArchived ? new Date() : null },
  ])
  queueTableRows(schemaMock.workflowBlocks, [
    {
      id: 'excel',
      type: change.noExcel ? 'start_trigger' : 'memlia_excel',
      name: change.name ?? 'Excel',
      enabled: true,
      positionX: 0,
      positionY: 0,
      height: 100,
      outputs: {},
      data: {},
      subBlocks: {
        request: {
          id: 'request',
          type: 'code',
          value: pad(
            change.requestValue ??
              JSON.stringify(
                change.request ?? {
                  procedure,
                  sources: { source: { fileId: 'file-fixture', sheetName: 'Source' } },
                  output: { fileName: 'result.xlsx', sheetName: 'Result' },
                }
              ),
            change.padRequestTo
          ),
        },
      },
    },
  ])
  queueTableRows(schemaMock.workflowEdges, [])
  queueTableRows(schemaMock.workflowSubflows, [])
}
/** Pads with JSON whitespace to an exact UTF-8 byte size, keeping the same parsed request. */
function pad(value: string, bytes?: number) {
  return bytes === undefined ? value : value + ' '.repeat(bytes - Buffer.byteLength(value, 'utf8'))
}
function noPublicationSideEffect() {
  expect(dbChainMockFns.insert).not.toHaveBeenCalled()
  expect(dbChainMockFns.update).not.toHaveBeenCalled()
  expect(dbChainMockFns.delete).not.toHaveBeenCalled()
  expect(dbChainMockFns.from).not.toHaveBeenCalledWith(schemaMock.workflowDeploymentVersion)
}
describe('ordinary Excel publication capture — raw SQL boundary doubled', () => {
  beforeEach(() => resetDbChainMock())

  it('captures the raw draft for native CAS and materializes a fresh ordinary identity', async () => {
    queueGraph()
    const result = await captureWorkflowExcelDeploymentSnapshot(input())
    expect(result).not.toBeNull()
    if (!result) throw new Error('Expected Excel publication capture')
    const identity = readExcelProcedureSnapshotCapture(result.excelProcedureSnapshot)
    expect(identity).toMatchObject({
      expectedRevision: 7,
      scope: { workflowId: 'workflow', workspaceId: 'space', organizationId: null },
    })
    expect(result.workflowState).not.toHaveProperty('lastSaved')
    const materialized = materializeExcelProcedureSnapshot(
      result.excelProcedureSnapshot,
      {
        workflowState: result.workflowState,
        revision: 7,
        scope: identity.scope,
      },
      { id: 'ordinary-version', version: 3 }
    )
    const value = materialized.workflowState.blocks.excel.subBlocks.request.value
    if (typeof value !== 'string') throw new Error('Expected JSON request')
    const request = JSON.parse(value)
    expect(ExcelProcedureSchema.parse(request.procedure)).toMatchObject({
      organizationId: null,
      workspaceId: 'space',
      workflowId: 'workflow',
      deployedVersionId: 'ordinary-version',
      ownerUserId: 'author',
      policyVersion: 'memlia_excel_publication_v1',
      version: 1,
      parentVersion: null,
    })
    expect(request.sources).toEqual({ source: { fileId: 'file-fixture', sheetName: 'Source' } })
    expect(request.output).toEqual({ fileName: 'result.xlsx', sheetName: 'Result' })
    noPublicationSideEffect()
  })

  it.each([undefined, 'foreign'])(
    'refuses absent or divergent authorized workspace %s',
    async (assertedWorkspaceId) => {
      queueGraph()
      await expect(
        captureWorkflowExcelDeploymentSnapshot({ ...input(), assertedWorkspaceId })
      ).rejects.toMatchObject({ code: 'validation' })
      noPublicationSideEffect()
      expectRefusalCheck('asserted_workspace')
    }
  )

  it.each([
    undefined,
    { kind: 'workspace_api_key', keyId: 'key', workspaceId: 'space' } as const,
    { kind: 'delegated', serviceId: 'executor', delegationId: 'delegation' } as const,
    {
      kind: 'system',
      serviceId: 'internal',
      workflowId: 'workflow',
      workspaceId: 'space',
    } as const,
  ])(
    'refuses an absent or actorless author %j without inventing a billing owner',
    async (actor) => {
      queueGraph()
      await expect(
        captureWorkflowExcelDeploymentSnapshot({ ...input(), actor })
      ).rejects.toMatchObject({ code: 'validation' })
      noPublicationSideEffect()
      expectRefusalCheck('author')
    }
  )

  it.each<PrincipalActor>([
    { kind: 'personal_api_key', userId: 'author', keyId: 'personal-key' },
    { kind: 'oauth_access_token', userId: 'author', tokenId: 'token', clientId: 'client' },
    {
      kind: 'delegated',
      subjectUserId: 'author',
      serviceId: 'copilot',
      delegationId: 'delegation',
    },
  ])('retains the named canonical author for $kind', async (actor) => {
    queueGraph()
    const result = await captureWorkflowExcelDeploymentSnapshot(input(actor))
    if (!result) throw new Error('Expected Excel capture')
    const identity = readExcelProcedureSnapshotCapture(result.excelProcedureSnapshot)
    const materialized = materializeExcelProcedureSnapshot(
      result.excelProcedureSnapshot,
      {
        workflowState: result.workflowState,
        revision: 7,
        scope: identity.scope,
      },
      { id: 'ordinary-version', version: 3 }
    )
    expect(
      JSON.parse(String(materialized.workflowState.blocks.excel.subBlocks.request.value)).procedure
        .ownerUserId
    ).toBe('author')
    noPublicationSideEffect()
  })

  it.each([
    { change: { revision: 8 }, check: 'draft_revision' },
    { change: { workspaceId: 'foreign' }, check: 'workflow_row' },
    { change: { archived: true }, check: 'workflow_row' },
    { change: { workspaceArchived: true }, check: 'workspace' },
  ])('refuses a divergent or archived raw snapshot $change', async ({ change, check }) => {
    queueGraph(change)
    await expect(captureWorkflowExcelDeploymentSnapshot(input())).rejects.toMatchObject({
      code: 'validation',
    })
    noPublicationSideEffect()
    expectRefusalCheck(check)
  })

  it.each(['', 'k'.repeat(1025)])('refuses a native operation key of %#', async (key) => {
    queueGraph()
    await expect(
      captureWorkflowExcelDeploymentSnapshot({ ...input(), idempotencyKey: key })
    ).rejects.toMatchObject({ code: 'validation', message: 'Excel deployment snapshot refused' })
    noPublicationSideEffect()
    expectRefusalCheck('idempotency_key')
  })

  it('never runs an accessor-backed requestId, which is correlation only', async () => {
    queueGraph()
    const accessor = vi.fn(() => {
      throw new Error('private accessor detail')
    })
    const { requestId: _requestId, ...rest } = input()
    const forged = Object.defineProperty({ ...rest }, 'requestId', {
      get: accessor,
      enumerable: true,
    }) as ReturnType<typeof input>
    expect(await captureWorkflowExcelDeploymentSnapshot(forged)).not.toBeNull()
    expect(accessor).not.toHaveBeenCalled()
  })

  it('accepts a native operation key of exactly 1024 characters', async () => {
    queueGraph()
    expect(
      await captureWorkflowExcelDeploymentSnapshot({ ...input(), idempotencyKey: 'k'.repeat(1024) })
    ).not.toBeNull()
    expect(getMockLogger('ExcelDeploymentSnapshots').error).not.toHaveBeenCalled()
  })

  it.each([-1, 1.5])('refuses a stored draft revision %s', async (storedRevision) => {
    queueGraph({ storedRevision })
    await expect(captureWorkflowExcelDeploymentSnapshot(input())).rejects.toMatchObject({
      code: 'validation',
    })
    noPublicationSideEffect()
    expectRefusalCheck('draft_revision')
  })

  it('accepts a 512 KiB request and refuses one byte more', async () => {
    queueGraph({ padRequestTo: 512 * 1024 })
    expect(await captureWorkflowExcelDeploymentSnapshot(input())).not.toBeNull()
    expect(getMockLogger('ExcelDeploymentSnapshots').error).not.toHaveBeenCalled()
    resetDbChainMock()
    queueGraph({ padRequestTo: 512 * 1024 + 1 })
    await expect(captureWorkflowExcelDeploymentSnapshot(input())).rejects.toMatchObject({
      code: 'validation',
    })
    noPublicationSideEffect()
    expectRefusalCheck('excel_request')
  })

  it('refuses a raw graph outside the workflow state contract', async () => {
    queueGraph({ name: 42 as unknown as string })
    await expect(captureWorkflowExcelDeploymentSnapshot(input())).rejects.toMatchObject({
      code: 'validation',
      message: 'Excel deployment snapshot refused',
    })
    noPublicationSideEffect()
    expectRefusalCheck('workflow_state')
  })

  it.each(['55P03', '57014'])(
    'refuses a Drizzle-wrapped read failure %s, logging classes and SQLSTATE but never its message',
    async (code) => {
      queueGraph()
      const cause = new postgres.PostgresError({
        message: 'canceling statement for fixture-secret-value',
        code,
      } as never)
      dbChainMockFns.execute.mockRejectedValueOnce(
        new DrizzleQueryError('select set_config($1)', ['fixture-secret-value'], cause)
      )
      await expect(captureWorkflowExcelDeploymentSnapshot(input())).rejects.toMatchObject({
        code: 'validation',
        message: 'Excel deployment snapshot refused',
      })
      noPublicationSideEffect()
      expectRefusalCheck('read_transaction_failed', {
        errorName: 'Error',
        causeName: 'PostgresError',
        sqlState: code,
      })
    }
  )

  it.each([
    { change: { requestValue: '{private-fixture' }, check: 'excel_request' },
    {
      change: { request: { procedure: fixtures.ExcelProcedure, sources: {}, output: {} } },
      check: 'procedure_capture',
    },
  ])(
    'returns a fixed refusal for malformed drafts or client-owned authority envelopes $check',
    async ({ change, check }) => {
      queueGraph(change)
      await expect(captureWorkflowExcelDeploymentSnapshot(input())).rejects.toMatchObject({
        code: 'validation',
        message: 'Excel deployment snapshot refused',
      })
      noPublicationSideEffect()
      expectRefusalCheck(check)
    }
  )

  it('keeps the same capture identity for a replay and creates a new procedure for another native operation', async () => {
    const captures = []
    for (const key of ['publish', 'publish', 'another-publish']) {
      queueGraph()
      const result = await captureWorkflowExcelDeploymentSnapshot({
        ...input(),
        idempotencyKey: key,
      })
      if (!result) throw new Error('Expected Excel capture')
      captures.push(result)
    }
    const identities = captures.map((result) =>
      readExcelProcedureSnapshotCapture(result.excelProcedureSnapshot)
    )
    expect(identities[0].inputDigest).toBe(identities[1].inputDigest)
    expect(identities[0].inputDigest).not.toBe(identities[2].inputDigest)
    noPublicationSideEffect()
  })

  it.each(['graph', 'author'] as const)(
    'creates a distinct procedure ID when the same raw operation key is reused for a different %s',
    async (change) => {
      const procedures = []
      for (const changed of [false, true]) {
        queueGraph(changed && change === 'graph' ? { name: 'Changed Excel graph' } : {})
        const actor = {
          kind: 'session' as const,
          userId: changed && change === 'author' ? 'another-author' : 'author',
        }
        const result = await captureWorkflowExcelDeploymentSnapshot(input(actor))
        if (!result) throw new Error('Expected Excel capture')
        const identity = readExcelProcedureSnapshotCapture(result.excelProcedureSnapshot)
        const materialized = materializeExcelProcedureSnapshot(
          result.excelProcedureSnapshot,
          {
            workflowState: result.workflowState,
            revision: 7,
            scope: identity.scope,
          },
          { id: 'ordinary-version', version: 3 }
        )
        procedures.push(
          ExcelProcedureSchema.parse(
            JSON.parse(String(materialized.workflowState.blocks.excel.subBlocks.request.value))
              .procedure
          )
        )
      }
      expect(procedures[0].procedureId).not.toBe(procedures[1].procedureId)
      expect(procedures.map((procedure) => procedure.version)).toEqual([1, 1])
      noPublicationSideEffect()
    }
  )

  it('retains captured author, workspace and operation before the first await', async () => {
    queueGraph()
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    dbChainMockFns.execute.mockImplementationOnce(async () => {
      await barrier
      return []
    })
    const args = input()
    const pending = captureWorkflowExcelDeploymentSnapshot(args)
    args.assertedWorkspaceId = 'foreign'
    args.idempotencyKey = 'changed'
    args.actor = { kind: 'session', userId: 'foreign' }
    release()
    const result = await pending
    if (!result) throw new Error('Expected Excel capture')
    const identity = readExcelProcedureSnapshotCapture(result.excelProcedureSnapshot)
    const materialized = materializeExcelProcedureSnapshot(
      result.excelProcedureSnapshot,
      {
        workflowState: result.workflowState,
        revision: 7,
        scope: identity.scope,
      },
      { id: 'ordinary-version', version: 3 }
    )
    expect(
      JSON.parse(String(materialized.workflowState.blocks.excel.subBlocks.request.value)).procedure
        .ownerUserId
    ).toBe('author')
    expect(identity.scope.workspaceId).toBe('space')
    noPublicationSideEffect()
  })

  it('leaves non-Excel drafts on the prior loader even without an author or workspace assertion', async () => {
    queueGraph({ noExcel: true })
    expect(
      await captureWorkflowExcelDeploymentSnapshot({
        workflowId: 'workflow',
        idempotencyKey: 'publish',
      })
    ).toBeNull()
    noPublicationSideEffect()
  })

  it('keeps the native block allowlist bound to the authenticated author', async () => {
    queueGraph()
    permissionGroupScopeMockFns.mockResolvePermissionGroupConfig.mockResolvedValueOnce({
      allowedIntegrations: [],
    })
    await expect(captureWorkflowExcelDeploymentSnapshot(input())).rejects.toMatchObject({
      code: 'forbidden',
    })
    expect(permissionGroupScopeMockFns.mockResolvePermissionGroupConfig).toHaveBeenCalledWith(
      'author',
      'space',
      undefined
    )
    noPublicationSideEffect()
  })
})
