import { sha256Hex } from '@sim/security/hash'
import {
  dbChainMock,
  dbChainMockFns,
  queueTableRows,
  resetDbChainMock,
  schemaMock,
} from '@sim/testing'
import { idMock, idMockFns } from '@sim/testing/mocks/id.mock'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  captureExcelProcedureSnapshot,
  materializeExcelProcedureSnapshot,
} from '@/lib/memlia/excel/materialize-procedure-snapshot'
import { excelProcedureDraftSchema } from '@/lib/memlia/excel/procedure-capabilities'
import { normalizedStringify } from '@/lib/workflows/comparison/normalize'
import { fixtures } from '../../../../../packages/memlia-contracts/tests/fixtures'

vi.mock('@sim/utils/id', () => idMock)

import {
  activateDeploymentOperation,
  getProtectedDeploymentVersionId,
  markDeploymentComponentReadiness,
  markDeploymentOperationFailed,
  prepareWorkflowDeployment,
  prepareWorkflowVersionActivation,
} from '@/lib/workflows/persistence/deployment-operations'

const mockGenerateId = idMockFns.mockGenerateId

const WORKFLOW_ID = 'workflow-1'
const NOW = new Date('2026-07-14T08:00:00.000Z')

function operationRow(
  overrides: Partial<{
    id: string
    workflowId: string
    deploymentVersionId: string
    version: number
    previousActiveVersionId: string | null
    action: 'deploy' | 'activate'
    protocolVersion: number
    generation: number
    status: 'preparing' | 'activating' | 'active' | 'failed' | 'superseded'
    componentReadiness: Record<string, unknown>
    errorCode: string | null
    errorMessage: string | null
    idempotencyKey: string | null
    requestHash: string
    actorId: string
    completedAt: Date | null
    createdAt: Date
    updatedAt: Date
  }> = {}
) {
  return {
    id: 'operation-1',
    workflowId: WORKFLOW_ID,
    deploymentVersionId: 'version-2',
    version: 2,
    previousActiveVersionId: 'version-1',
    action: 'deploy' as const,
    protocolVersion: 2,
    generation: 2,
    status: 'preparing' as const,
    componentReadiness: {},
    errorCode: null,
    errorMessage: null,
    idempotencyKey: null,
    requestHash: 'request-hash',
    actorId: 'user-1',
    completedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function workflowState() {
  return {
    blocks: {},
    edges: [],
    loops: {},
    parallels: {},
    variables: {},
    lastSaved: NOW.getTime(),
  }
}

function scriptPrepare(params: {
  operation: ReturnType<typeof operationRow>
  activeVersionId: string | null
  maxVersion: number
  maxGeneration: number
}) {
  dbChainMockFns.for.mockResolvedValueOnce([{ id: WORKFLOW_ID, archivedAt: null }])
  dbChainMockFns.limit
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce(params.activeVersionId ? [{ id: params.activeVersionId }] : [])
    .mockResolvedValueOnce([{ maxVersion: params.maxVersion }])
    .mockResolvedValueOnce([{ maxGeneration: params.maxGeneration }])
  dbChainMockFns.returning.mockResolvedValueOnce([params.operation])
}

describe('deployment operation persistence', () => {
  beforeEach(() => {
    resetDbChainMock()
    mockGenerateId.mockReset()
  })

  it('creates first-deploy and redeploy snapshots inactive while generations supersede rapidly', async () => {
    const firstOperation = operationRow({
      id: 'operation-1',
      deploymentVersionId: 'version-1',
      version: 1,
      previousActiveVersionId: null,
      generation: 1,
    })
    const secondOperation = operationRow({
      id: 'operation-2',
      deploymentVersionId: 'version-2',
      version: 2,
      previousActiveVersionId: 'version-live',
      generation: 2,
    })
    mockGenerateId
      .mockReturnValueOnce('version-1')
      .mockReturnValueOnce('operation-1')
      .mockReturnValueOnce('version-2')
      .mockReturnValueOnce('operation-2')
    scriptPrepare({
      operation: firstOperation,
      activeVersionId: null,
      maxVersion: 0,
      maxGeneration: 0,
    })
    scriptPrepare({
      operation: secondOperation,
      activeVersionId: 'version-live',
      maxVersion: 1,
      maxGeneration: 1,
    })

    const first = await prepareWorkflowDeployment({
      workflowId: WORKFLOW_ID,
      actorId: 'user-1',
      requestHash: 'hash-1',
      idempotencyKey: 'deploy-1',
      workflowState: workflowState(),
      readinessComponents: ['webhooks'],
    })
    const second = await prepareWorkflowDeployment({
      workflowId: WORKFLOW_ID,
      actorId: 'user-1',
      requestHash: 'hash-2',
      idempotencyKey: 'deploy-2',
      workflowState: workflowState(),
      readinessComponents: ['webhooks'],
    })

    expect(first).toEqual({ success: true, operation: firstOperation, reused: false })
    expect(second).toEqual({ success: true, operation: secondOperation, reused: false })

    const insertedValues = dbChainMockFns.values.mock.calls.map(([values]) => values)
    expect(insertedValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'version-1',
          version: 1,
          isActive: false,
        }),
        expect.objectContaining({
          id: 'operation-1',
          generation: 1,
          previousActiveVersionId: null,
          status: 'preparing',
        }),
        expect.objectContaining({
          id: 'version-2',
          version: 2,
          isActive: false,
        }),
        expect.objectContaining({
          id: 'operation-2',
          generation: 2,
          previousActiveVersionId: 'version-live',
          status: 'preparing',
        }),
      ])
    )
    expect(dbChainMockFns.set).toHaveBeenCalledTimes(2)
    expect(dbChainMockFns.set).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ status: 'superseded' })
    )
    expect(dbChainMockFns.update).not.toHaveBeenCalledWith(schemaMock.workflow)
    expect(dbChainMockFns.update).not.toHaveBeenCalledWith(schemaMock.workflowDeploymentVersion)
  })

  it('rejects reuse of an idempotency key with a different request hash', async () => {
    dbChainMockFns.for.mockResolvedValueOnce([{ id: WORKFLOW_ID, archivedAt: null }])
    dbChainMockFns.limit.mockResolvedValueOnce([
      operationRow({ idempotencyKey: 'deploy-1', requestHash: 'original-hash' }),
    ])

    const result = await prepareWorkflowDeployment({
      workflowId: WORKFLOW_ID,
      actorId: 'user-1',
      requestHash: 'different-hash',
      idempotencyKey: 'deploy-1',
      workflowState: workflowState(),
    })

    expect(result).toEqual({
      success: false,
      reason: 'idempotency_conflict',
      error: 'Idempotency key was already used for a different deployment request',
    })
    expect(dbChainMockFns.insert).not.toHaveBeenCalled()
    expect(dbChainMockFns.update).not.toHaveBeenCalled()
  })

  it('reuses an in-flight operation for a duplicate request', async () => {
    const inFlight = operationRow({
      idempotencyKey: 'deploy-1',
      requestHash: 'hash-1',
      status: 'preparing',
    })
    dbChainMockFns.for.mockResolvedValueOnce([{ id: WORKFLOW_ID, archivedAt: null }])
    dbChainMockFns.limit.mockResolvedValueOnce([inFlight])

    const result = await prepareWorkflowDeployment({
      workflowId: WORKFLOW_ID,
      actorId: 'user-1',
      requestHash: 'hash-1',
      idempotencyKey: 'deploy-1',
      workflowState: workflowState(),
    })

    expect(result).toEqual({ success: true, operation: inFlight, reused: true })
    expect(dbChainMockFns.insert).not.toHaveBeenCalled()
  })

  it('releases a spent idempotency key and admits a fresh attempt after a failed operation', async () => {
    const failed = operationRow({
      id: 'operation-failed',
      idempotencyKey: 'deploy-1',
      requestHash: 'hash-1',
      status: 'failed',
      generation: 2,
    })
    const fresh = operationRow({ id: 'operation-fresh', generation: 3 })
    mockGenerateId.mockReturnValueOnce('version-fresh').mockReturnValueOnce('operation-fresh')
    dbChainMockFns.for.mockResolvedValueOnce([{ id: WORKFLOW_ID, archivedAt: null }])
    dbChainMockFns.limit
      .mockResolvedValueOnce([failed])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ maxVersion: 2 }])
      .mockResolvedValueOnce([{ maxGeneration: 2 }])
    dbChainMockFns.returning.mockResolvedValueOnce([fresh])

    const result = await prepareWorkflowDeployment({
      workflowId: WORKFLOW_ID,
      actorId: 'user-1',
      requestHash: 'hash-1',
      idempotencyKey: 'deploy-1',
      workflowState: workflowState(),
      readinessComponents: ['webhooks'],
    })

    expect(result).toEqual({ success: true, operation: fresh, reused: false })
    expect(dbChainMockFns.set).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: null })
    )
    expect(dbChainMockFns.insert).toHaveBeenCalled()
  })

  it('rejects stale generation callbacks before mutating legacy deployment state', async () => {
    dbChainMockFns.for
      .mockResolvedValueOnce([{ id: WORKFLOW_ID }])
      .mockResolvedValueOnce([
        operationRow({ status: 'activating', generation: 4, componentReadiness: {} }),
      ])
    dbChainMockFns.limit.mockResolvedValueOnce([{ maxGeneration: 5 }])

    const result = await activateDeploymentOperation({
      workflowId: WORKFLOW_ID,
      operationId: 'operation-1',
      generation: 4,
    })

    expect(result).toEqual({
      success: false,
      reason: 'stale_generation',
      error: 'Deployment operation generation is stale',
    })
    expect(dbChainMockFns.update).not.toHaveBeenCalled()
  })

  it('uses operation and generation CAS for component readiness', async () => {
    dbChainMockFns.returning.mockResolvedValueOnce([])

    const result = await markDeploymentComponentReadiness({
      workflowId: WORKFLOW_ID,
      operationId: 'operation-1',
      generation: 1,
      component: 'webhooks',
      status: 'ready',
    })

    expect(result).toEqual({
      success: false,
      reason: 'stale_generation',
      error: 'Deployment operation generation or component state is stale',
    })
    expect(dbChainMockFns.update).toHaveBeenCalledWith(schemaMock.workflowDeploymentOperation)
  })

  it('marks failure without changing the previously active deployment', async () => {
    const failedOperation = operationRow({
      status: 'failed',
      errorCode: 'provider_failed',
      errorMessage: 'authorization=[redacted]',
      completedAt: NOW,
    })
    dbChainMockFns.returning.mockResolvedValueOnce([failedOperation])

    const result = await markDeploymentOperationFailed({
      workflowId: WORKFLOW_ID,
      operationId: 'operation-1',
      generation: 2,
      errorCode: 'provider_failed',
      error: new Error('authorization=secret'),
    })

    expect(result).toEqual({ success: true, operation: failedOperation })
    expect(dbChainMockFns.update).toHaveBeenCalledTimes(1)
    expect(dbChainMockFns.update).toHaveBeenCalledWith(schemaMock.workflowDeploymentOperation)
    expect(dbChainMockFns.update).not.toHaveBeenCalledWith(schemaMock.workflow)
    expect(dbChainMockFns.update).not.toHaveBeenCalledWith(schemaMock.workflowDeploymentVersion)
    expect(dbChainMockFns.set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        errorCode: 'provider_failed',
        errorMessage: 'authorization=[redacted]',
      })
    )
  })

  it('refuses activation while any required component is pending', async () => {
    const operation = operationRow({
      status: 'activating',
      componentReadiness: {
        webhooks: { status: 'ready', updatedAt: NOW.toISOString() },
        schedules: { status: 'pending', updatedAt: NOW.toISOString() },
      },
    })
    dbChainMockFns.for
      .mockResolvedValueOnce([{ id: WORKFLOW_ID }])
      .mockResolvedValueOnce([operation])
    dbChainMockFns.limit.mockResolvedValueOnce([{ maxGeneration: 2 }])

    const result = await activateDeploymentOperation({
      workflowId: WORKFLOW_ID,
      operationId: operation.id,
      generation: operation.generation,
    })

    expect(result).toEqual({
      success: false,
      reason: 'not_ready',
      error: 'Deployment operation components are not all ready',
    })
    expect(dbChainMockFns.update).not.toHaveBeenCalled()
  })

  it('atomically flips compatibility fields only for an all-ready current operation', async () => {
    const operation = operationRow({
      status: 'activating',
      componentReadiness: {
        webhooks: { status: 'ready', updatedAt: NOW.toISOString() },
        schedules: { status: 'ready', updatedAt: NOW.toISOString() },
      },
    })
    dbChainMockFns.for
      .mockResolvedValueOnce([{ id: WORKFLOW_ID }])
      .mockResolvedValueOnce([operation])
    dbChainMockFns.limit
      .mockResolvedValueOnce([{ maxGeneration: 2 }])
      .mockResolvedValueOnce([{ id: 'version-1' }])
      .mockResolvedValueOnce([{ id: 'version-2', preparationKind: null }])
    const onActivateTransaction = vi.fn().mockResolvedValue(undefined)

    const result = await activateDeploymentOperation({
      workflowId: WORKFLOW_ID,
      operationId: operation.id,
      generation: operation.generation,
      onActivateTransaction,
    })

    expect(result.success).toBe(true)
    expect(dbChainMockFns.update.mock.calls.map(([table]) => table)).toEqual([
      schemaMock.workflowDeploymentVersion,
      schemaMock.workflow,
      schemaMock.workflowDeploymentOperation,
    ])
    expect(dbChainMockFns.set).toHaveBeenNthCalledWith(1, {
      isActive: expect.objectContaining({ values: expect.arrayContaining(['version-2']) }),
    })
    expect(dbChainMockFns.set).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ isDeployed: true, deployedAt: expect.any(Date) })
    )
    expect(dbChainMockFns.set).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        status: 'active',
        completedAt: expect.any(Date),
      })
    )
    expect(onActivateTransaction).toHaveBeenCalledTimes(1)
    expect(dbChainMockFns.transaction).toHaveBeenCalledTimes(1)
  })

  it('does not activate after a legacy writer changes the active deployment', async () => {
    const operation = operationRow({
      status: 'activating',
      componentReadiness: {
        webhooks: { status: 'ready', updatedAt: NOW.toISOString() },
      },
    })
    dbChainMockFns.for
      .mockResolvedValueOnce([{ id: WORKFLOW_ID }])
      .mockResolvedValueOnce([operation])
    dbChainMockFns.limit
      .mockResolvedValueOnce([{ maxGeneration: operation.generation }])
      .mockResolvedValueOnce([{ id: 'version-written-by-legacy-pod' }])

    const result = await activateDeploymentOperation({
      workflowId: WORKFLOW_ID,
      operationId: operation.id,
      generation: operation.generation,
    })

    expect(result).toEqual({
      success: false,
      reason: 'stale_generation',
      error: 'Active deployment changed while this operation was preparing',
    })
    expect(dbChainMockFns.update).toHaveBeenCalledTimes(1)
    expect(dbChainMockFns.update).toHaveBeenCalledWith(schemaMock.workflowDeploymentOperation)
    expect(dbChainMockFns.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'superseded', completedAt: expect.any(Date) })
    )
    expect(dbChainMockFns.update).not.toHaveBeenCalledWith(schemaMock.workflowDeploymentVersion)
    expect(dbChainMockFns.update).not.toHaveBeenCalledWith(schemaMock.workflow)
  })
})

describe('restriction native des versions Excel de test', () => {
  beforeEach(() => {
    resetDbChainMock()
    mockGenerateId.mockReset()
  })
  it('refuse une promotion de test avant opération ou callback de publication', async () => {
    queueTableRows(schemaMock.workflow, [{ id: WORKFLOW_ID, archivedAt: null }])
    queueTableRows(schemaMock.workflowDeploymentVersion, [])
    queueTableRows(schemaMock.workflowDeploymentVersion, [
      {
        id: 'test-version',
        workflowId: WORKFLOW_ID,
        version: 3,
        isActive: false,
        preparationKind: 'excel_test_v1',
      },
    ])
    queueTableRows(schemaMock.workflowDeploymentOperation, [{ maxGeneration: 2 }])
    dbChainMockFns.returning.mockResolvedValueOnce([operationRow()])
    const callback = vi.fn()
    const result = await prepareWorkflowVersionActivation({
      workflowId: WORKFLOW_ID,
      actorId: 'subject',
      requestHash: 'hash',
      deploymentVersionId: 'test-version',
      onPrepareTransaction: callback,
    })
    expect(result.success).toBe(false)
    expect(dbChainMockFns.insert).not.toHaveBeenCalled()
    expect(dbChainMockFns.update).not.toHaveBeenCalled()
    expect(callback).not.toHaveBeenCalled()
  })
  it.each(['preparing', 'failed', 'superseded'] as const)(
    'refuse la reprise %s d’une activation de test sans toucher la clé ou appeler la publication',
    async (status) => {
      queueTableRows(schemaMock.workflow, [{ id: WORKFLOW_ID, archivedAt: null }])
      queueTableRows(schemaMock.workflowDeploymentOperation, [
        operationRow({
          status,
          action: 'activate',
          requestHash: 'hash',
          idempotencyKey: 'same-key',
        }),
      ])
      queueTableRows(schemaMock.workflowDeploymentVersion, [{ preparationKind: 'excel_test_v1' }])
      const callback = vi.fn()
      const result = await prepareWorkflowVersionActivation({
        workflowId: WORKFLOW_ID,
        actorId: 'subject',
        requestHash: 'hash',
        idempotencyKey: 'same-key',
        deploymentVersionId: 'version-2',
        onPrepareTransaction: callback,
      })
      expect(result.success).toBe(false)
      expect(dbChainMockFns.insert).not.toHaveBeenCalled()
      expect(dbChainMockFns.update).not.toHaveBeenCalled()
      expect(callback).not.toHaveBeenCalled()
    }
  )
  it('préserve la reprise native d’une activation legacy NULL', async () => {
    const existing = operationRow({
      action: 'activate',
      requestHash: 'hash',
      idempotencyKey: 'same-key',
    })
    queueTableRows(schemaMock.workflow, [{ id: WORKFLOW_ID, archivedAt: null }])
    queueTableRows(schemaMock.workflowDeploymentOperation, [existing])
    queueTableRows(schemaMock.workflowDeploymentVersion, [{ preparationKind: null }])
    expect(
      await prepareWorkflowVersionActivation({
        workflowId: WORKFLOW_ID,
        actorId: 'subject',
        requestHash: 'hash',
        idempotencyKey: 'same-key',
        deploymentVersionId: 'version-2',
      })
    ).toEqual({ success: true, operation: existing, reused: true })
    expect(dbChainMockFns.insert).not.toHaveBeenCalled()
    expect(dbChainMockFns.update).not.toHaveBeenCalled()
  })
  it('refuse aussi le cutover d’une opération ancienne ou incohérente visant un test', async () => {
    const operation = operationRow({ status: 'activating' })
    dbChainMockFns.for
      .mockResolvedValueOnce([{ id: WORKFLOW_ID }])
      .mockResolvedValueOnce([operation])
    dbChainMockFns.limit
      .mockResolvedValueOnce([{ maxGeneration: 2 }])
      .mockResolvedValueOnce([{ id: 'version-1' }])
      .mockResolvedValueOnce([{ id: 'version-2', preparationKind: 'excel_test_v1' }])
    const callback = vi.fn()
    const result = await activateDeploymentOperation({
      workflowId: WORKFLOW_ID,
      operationId: operation.id,
      generation: 2,
      onActivateTransaction: callback,
    })
    expect(result.success).toBe(false)
    expect(dbChainMockFns.update).not.toHaveBeenCalled()
    expect(callback).not.toHaveBeenCalled()
  })
})

describe('getProtectedDeploymentVersionId', () => {
  beforeEach(() => {
    resetDbChainMock()
  })

  it('returns the version the in-flight current operation is preparing', async () => {
    dbChainMockFns.limit.mockResolvedValueOnce([
      { deploymentVersionId: 'version-3', protocolVersion: 2, status: 'preparing' },
    ])

    await expect(getProtectedDeploymentVersionId(WORKFLOW_ID)).resolves.toBe('version-3')
  })

  it('protects nothing once the latest operation is terminal', async () => {
    dbChainMockFns.limit.mockResolvedValueOnce([
      { deploymentVersionId: 'version-3', protocolVersion: 2, status: 'active' },
    ])

    await expect(getProtectedDeploymentVersionId(WORKFLOW_ID)).resolves.toBeNull()
  })
})

// Memlia opt-in must never fall through to a legacy deployment.
describe('Excel snapshot admission', () => {
  beforeEach(() => {
    resetDbChainMock()
    mockGenerateId.mockReset()
  })
  it.each([{}, null, undefined, false])(
    'refuses a forged present capture before any SQL: %j',
    async (capture) => {
      scriptPrepare({
        operation: operationRow(),
        activeVersionId: null,
        maxVersion: 0,
        maxGeneration: 0,
      })
      const result = await prepareWorkflowDeployment({
        workflowId: WORKFLOW_ID,
        actorId: 'user-1',
        requestHash: 'hash',
        idempotencyKey: 'excel-request',
        workflowState: workflowState(),
        excelProcedureSnapshot: capture,
      })
      expect(result.success).toBe(false)
      expect(dbChainMockFns.select).not.toHaveBeenCalled()
      expect(dbChainMockFns.values).not.toHaveBeenCalled()
    }
  )
})

const excelDigest = (value: unknown) => `sha256:${sha256Hex(normalizedStringify(value))}`
function excelFixture() {
  const full = structuredClone(fixtures.ExcelProcedure)
  full.decimalPolicy.precision = 18
  const procedure = excelProcedureDraftSchema.parse(
    Object.fromEntries(
      Object.entries(full).filter(([key]) => key in excelProcedureDraftSchema.shape)
    )
  )
  const request = { procedure, sources: {}, output: {} }
  const block = {
    id: 'excel',
    type: 'memlia_excel',
    name: 'Excel',
    position: { x: 0, y: 0 },
    enabled: true,
    horizontalHandles: true,
    advancedMode: false,
    errorEnabled: false,
    triggerMode: false,
    height: 100,
    subBlocks: {
      request: { id: 'request', type: 'code' as const, value: JSON.stringify(request) },
    },
    outputs: {},
    data: {},
    locked: false,
  }
  const graph = { blocks: { excel: block }, edges: [], loops: {}, parallels: {}, variables: {} }
  const plan = {
    workflowState: graph,
    expectedRevision: 7,
    expectedStateDigest: excelDigest(graph),
    scope: { organizationId: null, workspaceId: 'space', workflowId: WORKFLOW_ID },
    procedures: [
      {
        blockId: 'excel',
        expectedRequestDigest: excelDigest(request),
        procedureId: 'procedure',
        version: 1,
        parentVersion: null,
        ownerUserId: 'author',
        policyVersion: 'policy',
      },
    ],
  }
  const capture = captureExcelProcedureSnapshot(plan)
  const params = {
    workflowId: WORKFLOW_ID,
    actorId: 'executor-not-author',
    requestHash: 'input-hash',
    idempotencyKey: 'stable-excel-key',
    workflowState: graph,
    excelProcedureSnapshot: capture,
  }
  return { graph, plan, capture, params, block }
}
function queueExcelRows(
  f: ReturnType<typeof excelFixture>,
  options: {
    revision?: number
    organizationId?: string | null
    workspaceId?: string
    changedGraph?: boolean
    existing?: unknown
    stored?: unknown
  } = {}
) {
  queueTableRows(schemaMock.workflow, [{ draftRevision: options.revision ?? 7 }])
  queueTableRows(schemaMock.workflow, [
    { workspaceId: options.workspaceId ?? 'space', variables: {} },
  ])
  queueTableRows(schemaMock.workspace, [
    { organizationId: options.organizationId ?? null, archivedAt: null },
  ])
  queueTableRows(schemaMock.workflowBlocks, [
    {
      ...f.block,
      positionX: 0,
      positionY: 0,
      ...(options.changedGraph ? { name: 'Changed after capture' } : {}),
    },
  ])
  queueTableRows(schemaMock.workflowEdges, [])
  queueTableRows(schemaMock.workflowSubflows, [])
  queueTableRows(schemaMock.workflow, [{ workspaceId: 'space', draftRevision: 7 }])
  queueTableRows(schemaMock.workflow, [{ id: WORKFLOW_ID, archivedAt: null }])
  queueTableRows(schemaMock.workflowDeploymentOperation, options.existing ? [options.existing] : [])
  if (options.stored) queueTableRows(schemaMock.workflowDeploymentVersion, [options.stored])
  queueTableRows(schemaMock.workflowDeploymentVersion, [])
  queueTableRows(schemaMock.workflowDeploymentVersion, [{ maxVersion: 2 }])
  queueTableRows(schemaMock.workflowDeploymentOperation, [{ maxGeneration: 4 }])
  dbChainMockFns.returning.mockResolvedValueOnce([
    operationRow({
      deploymentVersionId: 'allocated-version',
      version: 3,
      requestHash: 'input-hash',
    }),
  ])
  mockGenerateId.mockReturnValueOnce('allocated-version').mockReturnValueOnce('allocated-operation')
}

describe('Excel native raw graph and deployment lock composition (DB chains doubled)', () => {
  beforeEach(() => {
    resetDbChainMock()
    mockGenerateId.mockReset()
  })
  it('materializes only after native lock/read with real allocated identity, final digest and unchanged input idempotence', async () => {
    const f = excelFixture()
    queueExcelRows(f)
    const callback = vi.fn()
    const result = await prepareWorkflowDeployment({ ...f.params, onPrepareTransaction: callback })
    expect(result.success).toBe(true)
    const values = dbChainMockFns.values.mock.calls.map(([v]) => v)
    const stored = values[0] as {
      state: typeof f.graph
      snapshotDigest: string
      id: string
      version: number
      isActive: boolean
    }
    const expected = materializeExcelProcedureSnapshot(
      f.capture,
      { workflowState: f.graph, revision: 7, scope: f.plan.scope },
      { id: 'allocated-version', version: 3 }
    )
    expect(stored.state).toEqual(expected.workflowState)
    expect(stored.snapshotDigest).toBe(excelDigest(stored.state))
    expect(stored.snapshotDigest).not.toBe(f.plan.expectedStateDigest)
    expect(stored.isActive).toBe(false)
    expect(
      JSON.parse(stored.state.blocks.excel.subBlocks.request.value).procedure.ownerUserId
    ).toBe('author')
    expect(values[1]).toMatchObject({
      requestHash: 'input-hash',
      idempotencyKey: 'stable-excel-key',
      actorId: 'executor-not-author',
    })
    expect(dbChainMockFns.for.mock.calls.slice(0, 3)).toEqual([['update'], ['share'], ['update']])
    expect(callback).toHaveBeenCalledOnce()
  })
  it.each([
    { revision: 8 },
    { organizationId: 'other' },
    { workspaceId: 'other' },
    { changedGraph: true },
  ])('refuses drift %j without INSERT or callback', async (options) => {
    const f = excelFixture()
    queueExcelRows(f, options)
    const callback = vi.fn()
    expect(
      (await prepareWorkflowDeployment({ ...f.params, onPrepareTransaction: callback })).success
    ).toBe(false)
    expect(dbChainMockFns.values).not.toHaveBeenCalled()
    expect(callback).not.toHaveBeenCalled()
  })
  it('refuses a global pool in place of a business transaction', async () => {
    const f = excelFixture()
    await expect(prepareWorkflowDeployment({ ...f.params, tx: dbChainMock.db })).rejects.toThrow(
      'transaction'
    )
    expect(dbChainMockFns.select).not.toHaveBeenCalled()
  })
  it('refuses a different supplied graph before SQL even with a real handle', async () => {
    const f = excelFixture()
    f.params.workflowState.blocks.excel.name = 'Changed'
    expect((await prepareWorkflowDeployment(f.params)).success).toBe(false)
    expect(dbChainMockFns.select).not.toHaveBeenCalled()
  })
  it('reuses only the exact final snapshot associated with the captured input', async () => {
    const f = excelFixture()
    const expected = materializeExcelProcedureSnapshot(
      f.capture,
      { workflowState: f.graph, revision: 7, scope: f.plan.scope },
      { id: 'existing-version', version: 2 }
    )
    const existing = operationRow({
      deploymentVersionId: 'existing-version',
      requestHash: 'input-hash',
    })
    queueExcelRows(f, {
      existing,
      stored: {
        id: 'existing-version',
        version: 2,
        state: expected.workflowState,
        snapshotDigest: expected.snapshotDigest,
      },
    })
    expect(await prepareWorkflowDeployment(f.params)).toEqual({
      success: true,
      reused: true,
      operation: existing,
    })
    expect(dbChainMockFns.values).not.toHaveBeenCalled()
    expect(mockGenerateId).not.toHaveBeenCalled()
  })
  it.each(['digest', 'state', 'missing'])(
    'refuses an existing operation whose stored %s is inconsistent',
    async (kind) => {
      const f = excelFixture()
      const expected = materializeExcelProcedureSnapshot(
        f.capture,
        { workflowState: f.graph, revision: 7, scope: f.plan.scope },
        { id: 'existing-version', version: 2 }
      )
      queueExcelRows(f, {
        existing: operationRow({
          deploymentVersionId: 'existing-version',
          requestHash: 'input-hash',
        }),
        stored:
          kind === 'missing'
            ? undefined
            : {
                id: 'existing-version',
                version: 2,
                state: kind === 'state' ? f.graph : expected.workflowState,
                snapshotDigest:
                  kind === 'digest' ? f.plan.expectedStateDigest : expected.snapshotDigest,
              },
      })
      expect((await prepareWorkflowDeployment(f.params)).success).toBe(false)
      expect(dbChainMockFns.values).not.toHaveBeenCalled()
    }
  )
  it('captures caller primitives and handle before waiting for the native lock', async () => {
    const f = excelFixture()
    queueExcelRows(f)
    let release!: () => void
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    dbChainMockFns.execute.mockImplementationOnce(async () => {
      await wait
      return []
    })
    const result = prepareWorkflowDeployment(f.params)
    f.params.actorId = 'mutated'
    f.params.requestHash = 'mutated'
    f.params.excelProcedureSnapshot = {}
    f.graph.blocks.excel.name = 'Mutated'
    release()
    expect((await result).success).toBe(true)
    expect(dbChainMockFns.values.mock.calls[1][0]).toMatchObject({
      actorId: 'executor-not-author',
      requestHash: 'input-hash',
    })
  })
})
