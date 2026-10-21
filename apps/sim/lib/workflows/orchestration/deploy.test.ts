// Modified by Memlia: opt-in Excel preparation; historical revert fixture expects the native transaction.
import { sha256Hex } from '@sim/security/hash'
import {
  dbChainMock,
  dbChainMockFns,
  queueTableRows,
  resetDbChainMock,
  schemaMock,
  workflowAuthzMockFns,
} from '@sim/testing'
import { auditMock, auditMockFns } from '@sim/testing/mocks/audit.mock'
import { posthogServerMock } from '@sim/testing/mocks/posthog-server.mock'
import {
  workflowsPersistenceUtilsMock,
  workflowsPersistenceUtilsMockFns,
} from '@sim/testing/mocks/workflows-persistence-utils.mock'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  captureExcelProcedureSnapshot,
  readExcelProcedureSnapshotCapture,
} from '@/lib/memlia/excel/materialize-procedure-snapshot'
import { excelProcedureDraftSchema } from '@/lib/memlia/excel/procedure-capabilities'
import { normalizedStringify } from '@/lib/workflows/comparison/normalize'
import { fixtures } from '../../../../../packages/memlia-contracts/tests/fixtures'

const {
  mockValidateWorkflowSchedules,
  mockValidateTriggerWebhookConfigForDeploy,
  mockEmitWorkflowDeployedEvent,
  mockPrepareWorkflowDeployment,
  mockPrepareWorkflowVersionActivation,
  mockGetWorkflowDeploymentStatus,
  mockGetDeploymentOperation,
  mockEnqueueWorkflowDeploymentPreparation,
  mockProcessWorkflowDeploymentOutboxEvent,
  mockNotifySocketDeploymentChanged,
  mockCaptureWorkflowExcelDeploymentSnapshot,
  mockTx,
} = vi.hoisted(() => ({
  mockValidateWorkflowSchedules: vi.fn(),
  mockValidateTriggerWebhookConfigForDeploy: vi.fn(),
  mockEmitWorkflowDeployedEvent: vi.fn(),
  mockPrepareWorkflowDeployment: vi.fn(),
  mockPrepareWorkflowVersionActivation: vi.fn(),
  mockGetWorkflowDeploymentStatus: vi.fn(),
  mockGetDeploymentOperation: vi.fn(),
  mockEnqueueWorkflowDeploymentPreparation: vi.fn(),
  mockProcessWorkflowDeploymentOutboxEvent: vi.fn(),
  mockNotifySocketDeploymentChanged: vi.fn(),
  mockCaptureWorkflowExcelDeploymentSnapshot: vi.fn(),
  /**
   * Sentinel transaction handle the mocked prepare functions hand to the real
   * onPrepareTransaction callback, which only forwards it into the (mocked)
   * outbox enqueue — identity is asserted, never chained on.
   */
  mockTx: { sentinel: 'tx' },
}))

vi.mock('@sim/audit', () => auditMock)

vi.mock('@/lib/workflows/deployment-outbox', () => ({
  enqueueWorkflowDeploymentPreparation: mockEnqueueWorkflowDeploymentPreparation,
  enqueueWorkflowUndeploySideEffects: vi.fn().mockResolvedValue('outbox-2'),
  notifySocketDeploymentChanged: mockNotifySocketDeploymentChanged,
  processWorkflowDeploymentOutboxEvent: mockProcessWorkflowDeploymentOutboxEvent,
  DEPLOYMENT_READINESS_COMPONENTS: ['webhooks', 'schedules', 'mcp'],
}))

vi.mock('@/lib/workflows/persistence/deployment-operations', () => ({
  getWorkflowDeploymentStatus: mockGetWorkflowDeploymentStatus,
  getDeploymentOperation: mockGetDeploymentOperation,
  prepareWorkflowDeployment: mockPrepareWorkflowDeployment,
  prepareWorkflowVersionActivation: mockPrepareWorkflowVersionActivation,
  setDeploymentTxTimeouts: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/workflows/persistence/excel-deployment-snapshots', () => ({
  captureWorkflowExcelDeploymentSnapshot: mockCaptureWorkflowExcelDeploymentSnapshot,
}))

vi.mock('@/lib/workspace-events/emitter', () => ({
  emitWorkflowDeployedEvent: mockEmitWorkflowDeployedEvent,
  emitWorkflowUndeployedEvent: vi.fn(),
}))

vi.mock('@/lib/posthog/server', () => posthogServerMock)

vi.mock('@/lib/workflows/persistence/utils', () => workflowsPersistenceUtilsMock)

vi.mock('@/lib/webhooks/deploy', () => ({
  validateTriggerWebhookConfigForDeploy: mockValidateTriggerWebhookConfigForDeploy,
}))

vi.mock('@/lib/workflows/schedules', () => ({
  validateWorkflowSchedules: mockValidateWorkflowSchedules,
}))

// Resolves to the global @sim/platform-authz/workflow mock, so instanceof matches.
import { WorkflowLockedError } from '@sim/platform-authz/workflow'
import {
  getWorkflowDeploymentSummary,
  performActivateVersion,
  performFullDeploy,
  performFullUndeploy,
  performRevertToVersion,
  prepareWorkflowSnapshotDeployment,
} from '@/lib/workflows/orchestration/deploy'

const mockRecordAudit = auditMockFns.mockRecordAudit

const mockLoadWorkflowDeploymentSnapshot =
  workflowsPersistenceUtilsMockFns.mockLoadWorkflowDeploymentSnapshot
const mockSaveWorkflowToNormalizedTables =
  workflowsPersistenceUtilsMockFns.mockSaveWorkflowToNormalizedTables
const mockUpdateDeploymentVersionMetadata =
  workflowsPersistenceUtilsMockFns.mockUpdateDeploymentVersionMetadata

afterAll(() => {
  resetDbChainMock()
})

describe('performRevertToVersion', () => {
  beforeEach(() => {
    resetDbChainMock()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })))
    mockSaveWorkflowToNormalizedTables.mockResolvedValue({ success: true })
  })

  it('restores variables when the deployment snapshot includes them', async () => {
    queueTableRows(schemaMock.workflowDeploymentVersion, [
      {
        state: {
          blocks: {},
          edges: [],
          loops: {},
          parallels: {},
          variables: {
            variableA: {
              id: 'variableA',
              name: 'API_KEY',
              type: 'plain',
              value: 'deployed-value',
            },
          },
        },
      },
    ])

    const result = await performRevertToVersion({
      workflowId: 'workflow-1',
      version: 3,
      userId: 'user-1',
      workflow: { id: 'workflow-1', name: 'Workflow', workspaceId: 'workspace-1' },
    })

    expect(result.success).toBe(true)
    expect(mockSaveWorkflowToNormalizedTables).toHaveBeenCalledWith(
      'workflow-1',
      expect.objectContaining({
        variables: {
          variableA: {
            id: 'variableA',
            name: 'API_KEY',
            type: 'plain',
            value: 'deployed-value',
          },
        },
      }),
      /** A revert restores a graph the workspace already deployed, so it writes as nobody. */
      { workspaceId: null, subjectUserId: null },
      expect.objectContaining({ ...dbChainMock.db, rollback: expect.any(Function) })
    )
    expect(dbChainMockFns.set).toHaveBeenCalledWith(
      expect.objectContaining({
        variables: {
          variableA: {
            id: 'variableA',
            name: 'API_KEY',
            type: 'plain',
            value: 'deployed-value',
          },
        },
      })
    )
  })

  it('preserves existing variables when reverting a legacy snapshot without variables', async () => {
    queueTableRows(schemaMock.workflowDeploymentVersion, [
      {
        state: {
          blocks: {},
          edges: [],
          loops: {},
          parallels: {},
        },
      },
    ])

    const result = await performRevertToVersion({
      workflowId: 'workflow-1',
      version: 2,
      userId: 'user-1',
      workflow: { id: 'workflow-1', name: 'Workflow', workspaceId: 'workspace-1' },
    })

    expect(result.success).toBe(true)
    const savedState = mockSaveWorkflowToNormalizedTables.mock.calls[0][1]
    expect(Object.hasOwn(savedState, 'variables')).toBe(false)
    const workflowUpdate = dbChainMockFns.set.mock.calls[0][0]
    expect(Object.hasOwn(workflowUpdate, 'variables')).toBe(false)
  })
})

describe('performFullDeploy workspace event emission', () => {
  beforeEach(() => {
    resetDbChainMock()
    mockCaptureWorkflowExcelDeploymentSnapshot.mockResolvedValue(null)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })))
    const now = new Date('2026-07-14T08:00:00.000Z')
    const operation = {
      id: 'operation-default',
      workflowId: 'workflow-1',
      deploymentVersionId: 'dv-1',
      version: 4,
      previousActiveVersionId: null,
      action: 'deploy',
      protocolVersion: 2,
      generation: 1,
      status: 'active',
      componentReadiness: {
        webhooks: { status: 'ready', updatedAt: now.toISOString() },
        schedules: { status: 'ready', updatedAt: now.toISOString() },
        mcp: { status: 'ready', updatedAt: now.toISOString() },
      },
      errorCode: null,
      errorMessage: null,
      idempotencyKey: 'request-default',
      requestHash: 'hash',
      actorId: 'user-1',
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    }
    mockProcessWorkflowDeploymentOutboxEvent.mockResolvedValue('completed')
    mockNotifySocketDeploymentChanged.mockResolvedValue(undefined)
    queueTableRows(schemaMock.workflow, [
      { id: 'workflow-1', name: 'My Workflow', workspaceId: 'workspace-1' },
    ])
    mockLoadWorkflowDeploymentSnapshot.mockResolvedValue({
      blocks: {},
      edges: [],
      loops: {},
      parallels: {},
      variables: {},
      lastSaved: now.getTime(),
    })
    mockValidateWorkflowSchedules.mockReturnValue({ isValid: true })
    mockValidateTriggerWebhookConfigForDeploy.mockResolvedValue({ success: true })
    mockUpdateDeploymentVersionMetadata.mockResolvedValue({ name: null, description: null })
    mockEnqueueWorkflowDeploymentPreparation.mockResolvedValue('prepare-event-default')
    mockPrepareWorkflowDeployment.mockImplementation(async (input) => {
      await input.onPrepareTransaction?.(mockTx, operation)
      return { success: true, operation, reused: false }
    })
    const deploymentStatus = {
      activeDeployment: {
        deploymentVersionId: 'dv-1',
        version: 4,
        deployedAt: now,
      },
      latestOperation: operation,
    }
    mockGetWorkflowDeploymentStatus.mockResolvedValue(deploymentStatus)
    mockGetDeploymentOperation.mockResolvedValue(deploymentStatus.latestOperation)
  })

  it('marks the latest active operation historical when no matching version is live', async () => {
    const now = new Date('2026-07-14T08:00:00.000Z')
    mockGetWorkflowDeploymentStatus.mockResolvedValueOnce({
      activeDeployment: null,
      latestOperation: {
        id: 'operation-historical',
        workflowId: 'workflow-1',
        deploymentVersionId: 'dv-old',
        version: 3,
        previousActiveVersionId: null,
        action: 'deploy',
        protocolVersion: 2,
        generation: 1,
        status: 'active',
        componentReadiness: {
          webhooks: { status: 'ready', updatedAt: now.toISOString() },
          schedules: { status: 'ready', updatedAt: now.toISOString() },
          mcp: { status: 'ready', updatedAt: now.toISOString() },
        },
        errorCode: null,
        errorMessage: null,
        idempotencyKey: 'request-historical',
        requestHash: 'hash',
        actorId: 'user-1',
        completedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    })

    const result = await getWorkflowDeploymentSummary('workflow-1')

    expect(result).toMatchObject({
      activeDeployment: null,
      latestDeploymentAttempt: {
        id: 'operation-historical',
        status: 'active',
        isCurrent: false,
        error: null,
      },
      warnings: [expect.stringContaining('historical')],
    })
  })

  it('publishes a fresh Excel draft through the native snapshot deployment and outbox', async () => {
    const actual = await vi.importActual<
      typeof import('@/lib/workflows/persistence/excel-deployment-snapshots')
    >('@/lib/workflows/persistence/excel-deployment-snapshots')
    mockCaptureWorkflowExcelDeploymentSnapshot.mockImplementationOnce(
      actual.captureWorkflowExcelDeploymentSnapshot
    )
    const { plan } = excelDeploymentInput()
    queueTableRows(schemaMock.workflow, [
      { workspaceId: 'space', draftRevision: 7, variables: {}, archivedAt: null },
    ])
    queueTableRows(schemaMock.workflow, [{ workspaceId: 'space', draftRevision: 7 }])
    queueTableRows(schemaMock.workspace, [{ organizationId: null, archivedAt: null }])
    queueTableRows(schemaMock.workflowBlocks, [
      { ...plan.workflowState.blocks.excel, positionX: 0, positionY: 0, height: 100 },
    ])
    queueTableRows(schemaMock.workflowEdges, [])
    queueTableRows(schemaMock.workflowSubflows, [])

    const result = await performFullDeploy({
      workflowId: 'workflow-1',
      userId: 'user-1',
      actor: { kind: 'session', userId: 'author' },
      assertedWorkspaceId: 'space',
      idempotencyKey: 'publish-excel',
      requestId: 'request-excel',
    })

    expect(result).toMatchObject({ success: true, deploymentVersionId: 'dv-1', version: 4 })
    const admitted = mockPrepareWorkflowDeployment.mock.calls[0][0]
    expect(admitted).toHaveProperty('excelProcedureSnapshot')
    expect(readExcelProcedureSnapshotCapture(admitted.excelProcedureSnapshot)).toMatchObject({
      scope: { organizationId: null, workspaceId: 'space', workflowId: 'workflow-1' },
      expectedRevision: 7,
    })
    expect(mockLoadWorkflowDeploymentSnapshot).not.toHaveBeenCalled()
    expect(mockProcessWorkflowDeploymentOutboxEvent).toHaveBeenCalledWith('prepare-event-default')
  })

  it('does not finish or process an Excel deployment refused by the native CAS', async () => {
    const { args } = excelDeploymentInput()
    mockCaptureWorkflowExcelDeploymentSnapshot.mockResolvedValueOnce({
      workflowState: args.workflowState,
      excelProcedureSnapshot: args.excelProcedureSnapshot,
      workspaceId: 'space',
    })
    mockPrepareWorkflowDeployment.mockResolvedValueOnce({
      success: false,
      reason: 'invalid_request',
      error: 'Excel deployment snapshot refused',
    })
    const result = await performFullDeploy({
      workflowId: 'workflow-1',
      userId: 'user-1',
      actor: { kind: 'session', userId: 'author' },
      assertedWorkspaceId: 'space',
    })
    expect(result).toMatchObject({ success: false, errorCode: 'validation' })
    expect(mockLoadWorkflowDeploymentSnapshot).not.toHaveBeenCalled()
    expect(mockProcessWorkflowDeploymentOutboxEvent).not.toHaveBeenCalled()
    expect(mockEnqueueWorkflowDeploymentPreparation).not.toHaveBeenCalled()
  })

  it('refuses an Excel block added between non-Excel observation and the legacy loader', async () => {
    mockLoadWorkflowDeploymentSnapshot.mockResolvedValueOnce(
      excelDeploymentInput().args.workflowState
    )
    const result = await performFullDeploy({ workflowId: 'workflow-1', userId: 'user-1' })
    expect(result).toMatchObject({ success: false, errorCode: 'validation' })
    expect(mockPrepareWorkflowDeployment).not.toHaveBeenCalled()
    expect(mockEnqueueWorkflowDeploymentPreparation).not.toHaveBeenCalled()
  })

  it('does not reuse a correlation request ID as an implicit idempotency key', async () => {
    queueTableRows(schemaMock.workflow, [
      { id: 'workflow-1', name: 'My Workflow', workspaceId: 'workspace-1' },
      { id: 'workflow-1', name: 'My Workflow', workspaceId: 'workspace-1' },
    ])

    const params = { workflowId: 'workflow-1', userId: 'user-1', requestId: 'request-1' }
    await performFullDeploy(params)
    await performFullDeploy(params)

    const firstKey = mockPrepareWorkflowDeployment.mock.calls[0][0].idempotencyKey
    const secondKey = mockPrepareWorkflowDeployment.mock.calls[1][0].idempotencyKey
    expect(firstKey).toEqual(expect.any(String))
    expect(secondKey).toEqual(expect.any(String))
    expect(firstKey).not.toBe('request-1')
    expect(firstKey).not.toBe(secondKey)
  })

  it('keeps retry identity stable across snapshot timestamps, edge order, and label wording', async () => {
    queueTableRows(schemaMock.workflow, [
      { id: 'workflow-1', name: 'My Workflow', workspaceId: 'workspace-1' },
      { id: 'workflow-1', name: 'My Workflow', workspaceId: 'workspace-1' },
    ])
    const baseState = {
      blocks: {},
      edges: [
        { id: 'edge-b', source: 'block-2', target: 'block-3' },
        { id: 'edge-a', source: 'block-1', target: 'block-2' },
      ],
      loops: {},
      parallels: {},
      variables: {},
      lastSaved: 1,
    }
    mockLoadWorkflowDeploymentSnapshot.mockResolvedValueOnce(baseState).mockResolvedValueOnce({
      ...baseState,
      edges: [...baseState.edges].reverse(),
      lastSaved: 2,
    })

    const params = {
      workflowId: 'workflow-1',
      userId: 'user-1',
      idempotencyKey: 'copilot:execution-1:tool-call:call-1',
    }
    await performFullDeploy({
      ...params,
      versionName: 'First wording',
      versionDescription: 'First description',
    })
    await performFullDeploy({
      ...params,
      versionName: 'Retry wording',
      versionDescription: 'Rephrased description',
    })

    expect(mockPrepareWorkflowDeployment.mock.calls[0][0].requestHash).toBe(
      mockPrepareWorkflowDeployment.mock.calls[1][0].requestHash
    )
    const firstRequest = mockPrepareWorkflowDeployment.mock.calls[0][0]
    expect(firstRequest.idempotencyKey).toBe(
      `copilot:execution-1:tool-call:call-1:request:${firstRequest.requestHash}`
    )
  })

  it('keeps a first deploy pending without claiming an active deployment', async () => {
    const now = new Date('2026-07-14T08:00:00.000Z')
    const operation = {
      id: 'operation-1',
      workflowId: 'workflow-1',
      deploymentVersionId: 'dv-candidate',
      version: 1,
      previousActiveVersionId: null,
      action: 'deploy',
      protocolVersion: 2,
      generation: 1,
      status: 'preparing',
      componentReadiness: {
        webhooks: { status: 'pending', updatedAt: now.toISOString() },
        schedules: { status: 'pending', updatedAt: now.toISOString() },
        mcp: { status: 'pending', updatedAt: now.toISOString() },
      },
      errorCode: null,
      errorMessage: null,
      idempotencyKey: 'request-1',
      requestHash: 'hash',
      actorId: 'user-1',
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    }
    mockLoadWorkflowDeploymentSnapshot.mockResolvedValue({
      blocks: {},
      edges: [],
      loops: {},
      parallels: {},
      variables: {},
      lastSaved: now.getTime(),
    })
    mockValidateWorkflowSchedules.mockReturnValue({ isValid: true })
    mockValidateTriggerWebhookConfigForDeploy.mockResolvedValue({ success: true })
    mockEnqueueWorkflowDeploymentPreparation.mockResolvedValue('prepare-event-1')
    mockPrepareWorkflowDeployment.mockImplementation(async (input) => {
      await input.onPrepareTransaction?.(mockTx, operation)
      return { success: true, operation, reused: false }
    })
    mockProcessWorkflowDeploymentOutboxEvent.mockResolvedValue('pending')
    const deploymentStatus = {
      activeDeployment: null,
      latestOperation: operation,
    }
    mockGetWorkflowDeploymentStatus.mockResolvedValue(deploymentStatus)
    mockGetDeploymentOperation.mockResolvedValue(deploymentStatus.latestOperation)

    const result = await performFullDeploy({
      workflowId: 'workflow-1',
      userId: 'user-1',
      requestId: 'request-1',
    })

    expect(result).toMatchObject({
      success: true,
      activeDeployment: null,
      latestDeploymentAttempt: {
        id: 'operation-1',
        status: 'preparing',
        deploymentVersionId: 'dv-candidate',
      },
      warnings: [expect.stringContaining('workflow remains undeployed')],
    })
    expect(result.deployedAt).toBeUndefined()
  })

  it('preserves the old active deployment while a redeploy prepares', async () => {
    const now = new Date('2026-07-14T08:00:00.000Z')
    const operation = {
      id: 'operation-2',
      workflowId: 'workflow-1',
      deploymentVersionId: 'dv-candidate',
      version: 5,
      previousActiveVersionId: 'dv-live',
      action: 'deploy',
      protocolVersion: 2,
      generation: 2,
      status: 'preparing',
      componentReadiness: {
        webhooks: { status: 'ready', updatedAt: now.toISOString() },
        schedules: { status: 'pending', updatedAt: now.toISOString() },
        mcp: { status: 'pending', updatedAt: now.toISOString() },
      },
      errorCode: null,
      errorMessage: null,
      idempotencyKey: 'request-2',
      requestHash: 'hash',
      actorId: 'user-1',
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    }
    mockLoadWorkflowDeploymentSnapshot.mockResolvedValue({
      blocks: {},
      edges: [],
      loops: {},
      parallels: {},
      variables: {},
      lastSaved: now.getTime(),
    })
    mockValidateWorkflowSchedules.mockReturnValue({ isValid: true })
    mockValidateTriggerWebhookConfigForDeploy.mockResolvedValue({ success: true })
    mockEnqueueWorkflowDeploymentPreparation.mockResolvedValue('prepare-event-2')
    mockPrepareWorkflowDeployment.mockImplementation(async (input) => {
      await input.onPrepareTransaction?.(mockTx, operation)
      return { success: true, operation, reused: false }
    })
    mockProcessWorkflowDeploymentOutboxEvent.mockResolvedValue('pending')
    const deploymentStatus = {
      activeDeployment: {
        deploymentVersionId: 'dv-live',
        version: 4,
        deployedAt: now,
      },
      latestOperation: operation,
    }
    mockGetWorkflowDeploymentStatus.mockResolvedValue(deploymentStatus)
    mockGetDeploymentOperation.mockResolvedValue(deploymentStatus.latestOperation)

    const result = await performFullDeploy({
      workflowId: 'workflow-1',
      userId: 'user-1',
      requestId: 'request-2',
    })

    expect(result).toMatchObject({
      success: true,
      /**
       * Top-level version identifies the snapshot this call admitted, while
       * activeDeployment keeps reporting what is actually live during the
       * pending cutover.
       */
      deploymentVersionId: 'dv-candidate',
      version: 5,
      activeDeployment: {
        deploymentVersionId: 'dv-live',
        version: 4,
      },
      latestDeploymentAttempt: {
        deploymentVersionId: 'dv-candidate',
        status: 'preparing',
      },
    })
    expect(mockEmitWorkflowDeployedEvent).not.toHaveBeenCalled()
  })

  it('surfaces v2 admission failure without falling back to legacy activation', async () => {
    mockPrepareWorkflowDeployment.mockResolvedValueOnce({
      success: false,
      reason: 'invalid_request',
      error: 'nope',
    })

    const result = await performFullDeploy({
      workflowId: 'workflow-1',
      userId: 'user-1',
    })

    expect(result.success).toBe(false)
    expect(result.error).toBe('nope')
    expect(mockEmitWorkflowDeployedEvent).not.toHaveBeenCalled()
  })

  it('returns a failure response when this request attempt fails terminally inline', async () => {
    const now = new Date('2026-07-14T08:00:00.000Z')
    const operation = {
      id: 'operation-conflict',
      workflowId: 'workflow-1',
      deploymentVersionId: 'dv-candidate',
      version: 5,
      previousActiveVersionId: null,
      action: 'deploy',
      protocolVersion: 2,
      generation: 2,
      status: 'preparing',
      componentReadiness: {
        webhooks: { status: 'pending', updatedAt: now.toISOString() },
        schedules: { status: 'pending', updatedAt: now.toISOString() },
        mcp: { status: 'pending', updatedAt: now.toISOString() },
      },
      errorCode: null,
      errorMessage: null,
      idempotencyKey: 'request-conflict',
      requestHash: 'hash',
      actorId: 'user-1',
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    }
    mockPrepareWorkflowDeployment.mockImplementation(async (input) => {
      await input.onPrepareTransaction?.(mockTx, operation)
      return { success: true, operation, reused: false }
    })
    mockProcessWorkflowDeploymentOutboxEvent.mockResolvedValue('completed')
    const deploymentStatus = {
      activeDeployment: null,
      latestOperation: {
        ...operation,
        status: 'failed',
        errorCode: 'webhook_path_conflict',
        errorMessage: 'Webhook path "/leads" is already in use. Choose a different path.',
        completedAt: now,
      },
    }
    mockGetWorkflowDeploymentStatus.mockResolvedValue(deploymentStatus)
    mockGetDeploymentOperation.mockResolvedValue(deploymentStatus.latestOperation)

    const result = await performFullDeploy({
      workflowId: 'workflow-1',
      userId: 'user-1',
      requestId: 'request-conflict',
    })

    expect(result).toMatchObject({
      success: false,
      error: 'Webhook path "/leads" is already in use. Choose a different path.',
      errorCode: 'conflict',
    })
  })
})

describe('performActivateVersion workspace event emission', () => {
  beforeEach(() => {
    resetDbChainMock()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })))
    const now = new Date('2026-07-14T08:00:00.000Z')
    const operation = {
      id: 'operation-activate-default',
      workflowId: 'workflow-1',
      deploymentVersionId: 'dv-2',
      version: 2,
      previousActiveVersionId: 'dv-1',
      action: 'activate',
      protocolVersion: 2,
      generation: 4,
      status: 'active',
      componentReadiness: {
        webhooks: { status: 'ready', updatedAt: now.toISOString() },
        schedules: { status: 'ready', updatedAt: now.toISOString() },
        mcp: { status: 'ready', updatedAt: now.toISOString() },
      },
      errorCode: null,
      errorMessage: null,
      idempotencyKey: 'request-activate-default',
      requestHash: 'hash',
      actorId: 'user-1',
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    }
    mockProcessWorkflowDeploymentOutboxEvent.mockResolvedValue('completed')
    mockNotifySocketDeploymentChanged.mockResolvedValue(undefined)
    mockValidateWorkflowSchedules.mockReturnValue({ isValid: true })
    mockValidateTriggerWebhookConfigForDeploy.mockResolvedValue({ success: true })
    queueTableRows(schemaMock.workflowDeploymentVersion, [
      { id: 'dv-2', state: { blocks: {} }, isActive: false },
    ])
    mockEnqueueWorkflowDeploymentPreparation.mockResolvedValue('prepare-event-activate-default')
    mockPrepareWorkflowVersionActivation.mockImplementation(async (input) => {
      await input.onPrepareTransaction?.(mockTx, operation)
      return { success: true, operation, reused: false }
    })
    const deploymentStatus = {
      activeDeployment: {
        deploymentVersionId: 'dv-2',
        version: 2,
        deployedAt: now,
      },
      latestOperation: operation,
    }
    mockGetWorkflowDeploymentStatus.mockResolvedValue(deploymentStatus)
    mockGetDeploymentOperation.mockResolvedValue(deploymentStatus.latestOperation)
  })

  it('commits optional metadata inside activation admission before enqueueing work', async () => {
    mockUpdateDeploymentVersionMetadata.mockResolvedValue({
      name: 'Release 2',
      description: 'Ready for production',
    })

    const result = await performActivateVersion({
      workflowId: 'workflow-1',
      version: 2,
      userId: 'user-1',
      name: 'Release 2',
      description: 'Ready for production',
    })

    expect(result).toMatchObject({
      success: true,
      name: 'Release 2',
      description: 'Ready for production',
    })
    expect(mockUpdateDeploymentVersionMetadata).toHaveBeenCalledWith({
      workflowId: 'workflow-1',
      version: 2,
      name: 'Release 2',
      description: 'Ready for production',
      tx: mockTx,
    })
    expect(mockUpdateDeploymentVersionMetadata).toHaveBeenCalledBefore(
      mockEnqueueWorkflowDeploymentPreparation
    )
  })

  it('does not enqueue activation when transactional metadata persistence fails', async () => {
    mockUpdateDeploymentVersionMetadata.mockRejectedValueOnce(new Error('metadata write failed'))

    const result = await performActivateVersion({
      workflowId: 'workflow-1',
      version: 2,
      userId: 'user-1',
      name: 'Release 2',
    })

    expect(result).toMatchObject({ success: false, errorCode: 'internal' })
    expect(mockEnqueueWorkflowDeploymentPreparation).not.toHaveBeenCalled()
  })

  it('reports post-admission activation failure while preserving admitted metadata', async () => {
    const failedAt = new Date('2026-07-14T08:01:00.000Z')
    mockUpdateDeploymentVersionMetadata.mockResolvedValue({
      name: 'Release 2',
      description: null,
    })
    const deploymentStatus = {
      activeDeployment: null,
      latestOperation: {
        id: 'operation-activate-default',
        workflowId: 'workflow-1',
        deploymentVersionId: 'dv-2',
        version: 2,
        previousActiveVersionId: 'dv-1',
        action: 'activate',
        protocolVersion: 2,
        generation: 4,
        status: 'failed',
        componentReadiness: {},
        errorCode: 'webhook_path_conflict',
        errorMessage: 'Webhook path is already in use',
        idempotencyKey: 'request-activate-default',
        requestHash: 'hash',
        actorId: 'user-1',
        completedAt: failedAt,
        createdAt: failedAt,
        updatedAt: failedAt,
      },
    }
    mockGetWorkflowDeploymentStatus.mockResolvedValue(deploymentStatus)
    mockGetDeploymentOperation.mockResolvedValue(deploymentStatus.latestOperation)

    const result = await performActivateVersion({
      workflowId: 'workflow-1',
      version: 2,
      userId: 'user-1',
      name: 'Release 2',
    })

    expect(result).toMatchObject({
      success: false,
      error: 'Webhook path is already in use',
      errorCode: 'conflict',
      name: 'Release 2',
    })
    expect(mockUpdateDeploymentVersionMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Release 2', tx: mockTx })
    )
    expect(mockEnqueueWorkflowDeploymentPreparation).toHaveBeenCalledOnce()
  })

  it('keeps the current version active while version activation prepares', async () => {
    const now = new Date('2026-07-14T08:00:00.000Z')
    const operation = {
      id: 'operation-activate',
      workflowId: 'workflow-1',
      deploymentVersionId: 'dv-2',
      version: 2,
      previousActiveVersionId: 'dv-1',
      action: 'activate',
      protocolVersion: 2,
      generation: 4,
      status: 'preparing',
      componentReadiness: {
        webhooks: { status: 'pending', updatedAt: now.toISOString() },
        schedules: { status: 'pending', updatedAt: now.toISOString() },
        mcp: { status: 'pending', updatedAt: now.toISOString() },
      },
      errorCode: null,
      errorMessage: null,
      idempotencyKey: 'request-activate',
      requestHash: 'hash',
      actorId: 'user-1',
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    }
    mockEnqueueWorkflowDeploymentPreparation.mockResolvedValue('prepare-event-activate')
    mockPrepareWorkflowVersionActivation.mockImplementation(async (input) => {
      await input.onPrepareTransaction?.(mockTx, operation)
      return { success: true, operation, reused: false }
    })
    mockProcessWorkflowDeploymentOutboxEvent.mockResolvedValue('pending')
    const deploymentStatus = {
      activeDeployment: {
        deploymentVersionId: 'dv-1',
        version: 1,
        deployedAt: now,
      },
      latestOperation: operation,
    }
    mockGetWorkflowDeploymentStatus.mockResolvedValue(deploymentStatus)
    mockGetDeploymentOperation.mockResolvedValue(deploymentStatus.latestOperation)

    const result = await performActivateVersion({
      workflowId: 'workflow-1',
      version: 2,
      userId: 'user-1',
      requestId: 'request-activate',
    })

    expect(result).toMatchObject({
      success: true,
      activeDeployment: {
        deploymentVersionId: 'dv-1',
        version: 1,
      },
      latestDeploymentAttempt: {
        id: 'operation-activate',
        deploymentVersionId: 'dv-2',
        status: 'preparing',
      },
      warnings: [expect.stringContaining('prior workflow version remains active')],
    })
    expect(mockEmitWorkflowDeployedEvent).not.toHaveBeenCalled()
  })

  it('does not emit when the version is already active (no-op activation)', async () => {
    /**
     * Per-chain overrides answer the two selects directly (version row, then
     * workflow deployedAt); the default row queued in beforeEach stays
     * unconsumed and is cleared by the next reset.
     */
    dbChainMockFns.limit
      .mockResolvedValueOnce([{ id: 'dv-2', state: { blocks: {} }, isActive: true }])
      .mockResolvedValueOnce([{ deployedAt: new Date() }])

    const result = await performActivateVersion({
      workflowId: 'workflow-1',
      version: 2,
      userId: 'user-1',
    })

    expect(result.success).toBe(true)
    expect(mockEmitWorkflowDeployedEvent).not.toHaveBeenCalled()
  })
})

describe('mutation lock on the orchestration entry points', () => {
  const mockAssertMutable = workflowAuthzMockFns.mockAssertWorkflowMutable

  beforeEach(() => {
    resetDbChainMock()
    mockAssertMutable.mockRejectedValue(new WorkflowLockedError('Workflow is locked'))
  })

  it.each([
    ['performFullDeploy', () => performFullDeploy({ workflowId: 'wf-1', userId: 'user-1' })],
    ['performFullUndeploy', () => performFullUndeploy({ workflowId: 'wf-1', userId: 'user-1' })],
    [
      'performActivateVersion',
      () => performActivateVersion({ workflowId: 'wf-1', version: 2, userId: 'user-1' }),
    ],
  ])('%s returns a lock denial instead of throwing', async (_name, call) => {
    // Callers like performChatDeploy and the copilot deploy tools consume the
    // result object; a throw surfaces as a generic 500 instead of a denial.
    const result = await call()

    expect(result.success).toBe(false)
    expect(result.error).toContain('locked')
    expect(result.errorCode).toBe('locked')
    expect(mockRecordAudit).not.toHaveBeenCalled()
  })
})

function excelDeploymentInput() {
  const full = structuredClone(fixtures.ExcelProcedure)
  full.decimalPolicy.precision = 18
  const procedure = excelProcedureDraftSchema.parse(
    Object.fromEntries(
      Object.entries(full).filter(([key]) => key in excelProcedureDraftSchema.shape)
    )
  )
  const request = { procedure, sources: {}, output: {} }
  const workflowState = {
    blocks: {
      excel: {
        id: 'excel',
        type: 'memlia_excel',
        name: 'Excel',
        enabled: true,
        position: { x: 0, y: 0 },
        subBlocks: {
          request: { id: 'request', type: 'code' as const, value: JSON.stringify(request) },
        },
        outputs: {},
      },
    },
    edges: [],
    loops: {},
    parallels: {},
    variables: {},
  }
  const hash = (value: unknown) => `sha256:${sha256Hex(normalizedStringify(value))}`
  const plan = {
    workflowState,
    expectedRevision: 7,
    expectedStateDigest: hash(workflowState),
    scope: { organizationId: null, workspaceId: 'space', workflowId: 'workflow-1' },
    procedures: [
      {
        blockId: 'excel',
        expectedRequestDigest: hash(request),
        procedureId: 'procedure',
        version: 1,
        parentVersion: null,
        ownerUserId: 'author',
        policyVersion: 'policy',
      },
    ],
  }
  return {
    plan,
    args: {
      params: { workflowId: 'workflow-1', userId: 'user-1', versionName: 'Version' },
      actorId: 'user-1',
      requestId: 'request',
      idempotencyKey: 'logical-deploy',
      workflowState,
      excelProcedureSnapshot: captureExcelProcedureSnapshot(plan),
    },
  }
}
describe('Excel snapshot orchestration (infrastructure doubled)', () => {
  beforeEach(() => {
    mockPrepareWorkflowDeployment.mockReset()
    mockEnqueueWorkflowDeploymentPreparation.mockReset()
    mockValidateWorkflowSchedules.mockReturnValue({ isValid: true })
    mockValidateTriggerWebhookConfigForDeploy.mockReset().mockResolvedValue({ success: true })
    mockPrepareWorkflowDeployment.mockResolvedValue({
      success: true,
      reused: false,
      operation: { id: 'operation', deploymentVersionId: 'version', version: 1 },
    })
  })
  it.each([{}, null, undefined, false])(
    'refuses present invalid handle %j before preparation or outbox',
    async (capture) => {
      const { args } = excelDeploymentInput()
      const result = await prepareWorkflowSnapshotDeployment({
        ...args,
        excelProcedureSnapshot: capture,
      })
      expect(result).toEqual({
        success: false,
        error: 'Excel deployment snapshot refused',
        errorCode: 'validation',
      })
      expect(mockPrepareWorkflowDeployment).not.toHaveBeenCalled()
      expect(mockEnqueueWorkflowDeploymentPreparation).not.toHaveBeenCalled()
    }
  )
  it('captures primitives, graph and handle before native validation awaits', async () => {
    const { args } = excelDeploymentInput()
    const original = structuredClone({ ...args, excelProcedureSnapshot: undefined })
    const handle = args.excelProcedureSnapshot
    let release!: () => void
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    mockValidateTriggerWebhookConfigForDeploy.mockImplementationOnce(async () => {
      await wait
      return { success: true }
    })
    const result = prepareWorkflowSnapshotDeployment(args)
    args.params.workflowId = 'foreign'
    args.params.userId = 'foreign'
    args.actorId = 'foreign'
    args.idempotencyKey = 'foreign'
    args.workflowState.blocks.excel.name = 'Changed'
    args.excelProcedureSnapshot = {}
    release()
    expect((await result).success).toBe(true)
    expect(mockPrepareWorkflowDeployment).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: 'workflow-1',
        actorId: 'user-1',
        workflowState: original.workflowState,
        excelProcedureSnapshot: handle,
      })
    )
    const captured = mockPrepareWorkflowDeployment.mock.calls[0][0]
    expect(captured.idempotencyKey).toBe(`logical-deploy:request:${captured.requestHash}`)
  })
  it('binds stable input digest, not a newly allocated version ID, into native request identity', async () => {
    const first = excelDeploymentInput()
    await prepareWorkflowSnapshotDeployment(first.args)
    await prepareWorkflowSnapshotDeployment(first.args)
    const changed = excelDeploymentInput()
    changed.plan.procedures[0].policyVersion = 'new-policy'
    changed.args.excelProcedureSnapshot = captureExcelProcedureSnapshot(changed.plan)
    await prepareWorkflowSnapshotDeployment(changed.args)
    const calls = mockPrepareWorkflowDeployment.mock.calls.map(([input]) => input)
    expect(calls[0].requestHash).toBe(calls[1].requestHash)
    expect(calls[0].requestHash).not.toBe(calls[2].requestHash)
    const expected = sha256Hex(
      normalizedStringify({
        action: 'deploy',
        workflowId: 'workflow-1',
        userId: 'user-1',
        workflowState: first.args.workflowState,
        excelInputDigest: readExcelProcedureSnapshotCapture(first.args.excelProcedureSnapshot)
          .inputDigest,
      })
    )
    expect(calls[0].requestHash).toBe(expected)
  })
  it('refuses a graph or workflow inconsistent with the capture before SQL preparation', async () => {
    const { args } = excelDeploymentInput()
    args.workflowState.blocks.excel.name = 'Changed'
    expect((await prepareWorkflowSnapshotDeployment(args)).success).toBe(false)
    expect(mockPrepareWorkflowDeployment).not.toHaveBeenCalled()
  })
  it('keeps the real preparation outbox: this opt-in is NOT an inactive test admission', async () => {
    const { args } = excelDeploymentInput()
    const operation = {
      id: 'operation',
      workflowId: 'workflow-1',
      deploymentVersionId: 'version',
      version: 1,
      generation: 1,
      protocolVersion: 2,
    }
    mockPrepareWorkflowDeployment.mockImplementationOnce(async (input) => {
      await input.onPrepareTransaction(mockTx, operation)
      return { success: true, operation, reused: false }
    })
    mockEnqueueWorkflowDeploymentPreparation.mockResolvedValueOnce('outbox')
    expect(await prepareWorkflowSnapshotDeployment(args)).toMatchObject({
      success: true,
      outboxEventId: 'outbox',
    })
    expect(mockEnqueueWorkflowDeploymentPreparation).toHaveBeenCalledWith(
      mockTx,
      expect.objectContaining({
        operationId: 'operation',
        deploymentVersionId: 'version',
        userId: 'user-1',
      })
    )
  })
})
