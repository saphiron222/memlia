// Copyright (c) 2026 Memlia. All rights reserved.
/**
 * Contract between POST /api/workflows/[id]/deploy and the durable browser journey
 * (scripts/ci/linux-chat-browser.mjs). The response comes from the real route,
 * presenter, contract schema, use case and orchestration result builder; only the
 * persisted deployment rows, session and SQL are doubled. A change of the native
 * response form must fail here before a Linux VM pass.
 */

import { authMockFns, queueTableRows, resetDbChainMock, schemaMock } from '@sim/testing'
import { auditMock } from '@sim/testing/mocks/audit.mock'
import { posthogServerMock } from '@sim/testing/mocks/posthog-server.mock'
import {
  workflowContextMock,
  workflowContextMockFns,
} from '@sim/testing/mocks/workflow-context.mock'
import {
  workflowsPersistenceUtilsMock,
  workflowsPersistenceUtilsMockFns,
} from '@sim/testing/mocks/workflows-persistence-utils.mock'
import { workspaceAuthzMock, workspaceAuthzMockFns } from '@sim/testing/mocks/workspace-authz.mock'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { durableDeployReceipt } from '../../../../../../../scripts/ci/linux-chat-browser.mjs'

const io = vi.hoisted(() => ({
  status: vi.fn(),
  operation: vi.fn(),
  prepare: vi.fn(),
  process: vi.fn(),
}))
vi.mock('@sim/audit', () => auditMock)
vi.mock('@/lib/posthog/server', () => posthogServerMock)
vi.mock('@sim/platform-authz/workspace', () => workspaceAuthzMock)
vi.mock('@/lib/workflows/application/context', () => workflowContextMock)
vi.mock('@/lib/workflows/persistence/utils', () => workflowsPersistenceUtilsMock)
vi.mock('@/lib/workflows/deployment-outbox', () => ({
  enqueueWorkflowDeploymentPreparation: vi.fn().mockResolvedValue('prepare-event'),
  enqueueWorkflowUndeploySideEffects: vi.fn(),
  notifySocketDeploymentChanged: vi.fn().mockResolvedValue(undefined),
  processWorkflowDeploymentOutboxEvent: io.process,
  DEPLOYMENT_READINESS_COMPONENTS: ['webhooks', 'schedules', 'mcp'],
}))
vi.mock('@/lib/workflows/persistence/deployment-operations', () => ({
  getWorkflowDeploymentStatus: io.status,
  getDeploymentOperation: io.operation,
  prepareWorkflowDeployment: io.prepare,
  prepareWorkflowVersionActivation: vi.fn(),
  setDeploymentTxTimeouts: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/workflows/persistence/excel-deployment-snapshots', () => ({
  captureWorkflowExcelDeploymentSnapshot: vi.fn().mockResolvedValue(null),
}))
vi.mock('@/lib/webhooks/deploy', () => ({
  validateTriggerWebhookConfigForDeploy: vi.fn().mockResolvedValue({ success: true }),
}))
vi.mock('@/lib/workflows/schedules', () => ({
  validateWorkflowSchedules: vi.fn().mockReturnValue({ isValid: true }),
}))
vi.mock('@/lib/workspace-events/emitter', () => ({
  emitWorkflowDeployedEvent: vi.fn(),
  emitWorkflowUndeployedEvent: vi.fn(),
}))

import { POST } from './route'

const requestedAt = new Date('2026-10-22T07:26:31.781Z')
const activatedAt = new Date('2026-10-22T07:26:31.890Z')
const ready = { status: 'ready', updatedAt: activatedAt.toISOString() }
/** A persisted v2 deploy operation row in the state the VM observed (pass 11). */
function operationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'owned-operation',
    workflowId: 'owned-flow',
    deploymentVersionId: 'owned-version',
    version: 1,
    previousActiveVersionId: null,
    action: 'deploy',
    protocolVersion: 2,
    generation: 1,
    status: 'active',
    componentReadiness: { webhooks: ready, schedules: ready, mcp: ready },
    errorCode: null,
    errorMessage: null,
    idempotencyKey: 'owned-request',
    requestHash: 'hash',
    actorId: 'owned-user',
    completedAt: activatedAt,
    createdAt: requestedAt,
    updatedAt: activatedAt,
    ...overrides,
  }
}
function deploy() {
  return POST(
    new NextRequest('http://localhost/api/workflows/owned-flow/deploy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }),
    { params: Promise.resolve({ id: 'owned-flow' }) }
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  resetDbChainMock()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 200 })))
  authMockFns.mockGetSession.mockResolvedValue({
    user: { id: 'owned-user' },
    session: { id: 'owned-session' },
  })
  workspaceAuthzMockFns.mockResolveEffectiveWorkspacePermission.mockResolvedValue('admin')
  workflowContextMockFns.mockResolveActiveWorkflowApplicationContext.mockResolvedValue({
    workflowId: 'owned-flow',
    workflow: { id: 'owned-flow', workspaceId: 'owned-space' },
    workspaceId: 'owned-space',
    workspaceOrganizationId: null,
    allowPersonalApiKeys: true,
    billedAccountUserId: 'owned-user',
  })
  queueTableRows(schemaMock.workflow, [
    { id: 'owned-flow', name: 'Owned', workspaceId: 'owned-space' },
  ])
  workflowsPersistenceUtilsMockFns.mockLoadWorkflowDeploymentSnapshot.mockResolvedValue({
    blocks: {},
    edges: [],
    loops: {},
    parallels: {},
    variables: {},
    lastSaved: requestedAt.getTime(),
  })
  const operation = operationRow()
  io.prepare.mockImplementation(
    async (input: { onPrepareTransaction?: (tx: unknown, operation: unknown) => unknown }) => {
      await input.onPrepareTransaction?.({ sentinel: 'tx' }, operation)
      return { success: true, operation, reused: false }
    }
  )
  io.process.mockResolvedValue('completed')
  io.operation.mockResolvedValue(operation)
  io.status.mockResolvedValue({
    activeDeployment: { deploymentVersionId: 'owned-version', version: 1, deployedAt: activatedAt },
    latestOperation: operation,
  })
})

describe('deploy response consumed by the durable browser journey', () => {
  it('accepts the native active version, by its published field', async () => {
    const response = await deploy()
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.activeDeployment).toEqual({
      deploymentVersionId: 'owned-version',
      version: 1,
      deployedAt: activatedAt.toISOString(),
    })
    expect(durableDeployReceipt(response.status, body)).toEqual({
      deploymentVersionId: 'owned-version',
      version: 1,
    })
  })

  it('accepts queued post-activation notifications, which never change the active version', async () => {
    io.process.mockResolvedValue('pending')
    const response = await deploy()
    const body = await response.json()
    expect(body.warnings).toHaveLength(1)
    expect(durableDeployReceipt(response.status, body).deploymentVersionId).toBe('owned-version')
  })

  it('refuses a native 200 whose admitted attempt is not yet the active version', async () => {
    const pending = operationRow({ status: 'activating', completedAt: null })
    io.operation.mockResolvedValue(pending)
    io.status.mockResolvedValue({ activeDeployment: null, latestOperation: pending })
    const response = await deploy()
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.isDeployed).toBe(false)
    expect(() => durableDeployReceipt(response.status, body)).toThrow('durable_deploy_refused')
  })

  it('refuses a 200 that still serves a previous version while this attempt activates', async () => {
    const pending = operationRow({
      deploymentVersionId: 'next-version',
      version: 2,
      status: 'activating',
      completedAt: null,
    })
    io.operation.mockResolvedValue(pending)
    io.status.mockResolvedValue({
      activeDeployment: {
        deploymentVersionId: 'owned-version',
        version: 1,
        deployedAt: activatedAt,
      },
      latestOperation: pending,
    })
    const response = await deploy()
    const body = await response.json()
    expect(body.isDeployed).toBe(true)
    expect(() => durableDeployReceipt(response.status, body)).toThrow('durable_deploy_refused')
  })
})
