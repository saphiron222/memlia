// Copyright (c) 2026 Memlia. All rights reserved.
/**
 * Contract between POST /api/workflows/[id]/execute in durable mode and the durable browser
 * journey (scripts/ci/linux-chat-browser.mjs). The recipe's exact request goes through the real
 * route, the real durable enqueue caller and the real durable admission preparation; only the
 * queue, authentication, preprocessing/reservation and their infrastructure are doubled. A request
 * the durable admission refuses must fail here before a Linux VM pass (pass 13: 500).
 */

import { asyncJobsMock, asyncJobsMockFns } from '@sim/testing/mocks/async-jobs.mock'
import {
  billingAttributionMock,
  billingAttributionMockFns,
} from '@sim/testing/mocks/billing-attribution.mock'
import {
  billingUsageReservationMock,
  billingUsageReservationMockFns,
} from '@sim/testing/mocks/billing-usage-reservation.mock'
import { resetDbChainMock } from '@sim/testing/mocks/database.mock'
import { resetEnvMock, setEnv } from '@sim/testing/mocks/env.mock'
import {
  executionPreprocessingMock,
  executionPreprocessingMockFns,
} from '@sim/testing/mocks/execution-preprocessing.mock'
import { idMock, idMockFns } from '@sim/testing/mocks/id.mock'
import { getMockLogger } from '@sim/testing/mocks/logger.mock'
import { loggingSessionMock } from '@sim/testing/mocks/logging-session.mock'
import { permissionCheckMock } from '@sim/testing/mocks/permission-check.mock'
import { requestUtilsMockFns } from '@sim/testing/mocks/request.mock'
import { workflowAuthzMockFns } from '@sim/testing/mocks/workflow-authz.mock'
import {
  workflowDeploymentStatusMock,
  workflowDeploymentStatusMockFns,
} from '@sim/testing/mocks/workflow-deployment-status.mock'
import { workflowsPersistenceUtilsMock } from '@sim/testing/mocks/workflows-persistence-utils.mock'
import { workflowsUtilsMock } from '@sim/testing/mocks/workflows-utils.mock'
import { workspacesUtilsMock } from '@sim/testing/mocks/workspaces-utils.mock'
import { NextRequest } from 'next/server'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  durableExecutionRequest,
  durableQueueReceipt,
} from '../../../../../../../scripts/ci/linux-chat-browser.mjs'

const io = vi.hoisted(() => ({
  claim: vi.fn(),
  owner: vi.fn(),
  releaseClaim: vi.fn(),
  runner: vi.fn(),
}))
vi.mock('@/lib/billing/core/attribution', () => billingAttributionMock)
vi.mock('@/lib/billing/calculations/usage-reservation', () => billingUsageReservationMock)
vi.mock('@/lib/workspaces/utils', () => workspacesUtilsMock)
vi.mock('@/lib/permission-groups/permission-check', () => permissionCheckMock)
vi.mock('@/lib/workflows/utils', () => workflowsUtilsMock)
vi.mock('@/lib/execution/preprocessing', () => executionPreprocessingMock)
vi.mock('@/lib/workflows/deployment-status', () => workflowDeploymentStatusMock)
vi.mock('@/lib/workflows/persistence/utils', () => workflowsPersistenceUtilsMock)
vi.mock('@/lib/workflows/executor/execution-id-claim', () => ({
  claimExecutionId: io.claim,
  hasDurableExecutionOwner: io.owner,
  releaseExecutionIdClaim: io.releaseClaim,
}))
vi.mock('@/lib/core/async-jobs', () => asyncJobsMock)
vi.mock('@/lib/logs/execution/logging-session', () => loggingSessionMock)
vi.mock('@/background/workflow-execution', () => ({ executeWorkflowJob: io.runner }))
vi.mock('@sim/utils/id', () => idMock)

import { queueSessionWorkflowContract } from '@/lib/api/contracts/workflows'
import { checkHybridAuth } from '@/lib/auth/hybrid'
import { POST } from './route'

const executionId = 'durable-run-1'
const principal = { kind: 'session', userId: 'session-user-1', sessionId: 'session-1' } as const
const billingAttribution = {
  actorUserId: 'session-user-1',
  workspaceId: 'workspace-1',
  organizationId: null,
  billedAccountUserId: 'session-user-1',
  billingEntity: { type: 'user' as const, id: 'session-user-1' },
  billingPeriod: { start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z' },
  payerSubscription: null,
}
const { mockEnqueue, mockGetJobQueue } = {
  mockEnqueue: asyncJobsMockFns.mockJobQueue.enqueue,
  mockGetJobQueue: asyncJobsMockFns.mockGetJobQueue,
}

const recipeRequest = () => durableExecutionRequest('workflow-1', 'workspace-1', executionId)

/** The recipe's request, byte for byte; `edit` only removes or replaces body fields. */
function submit(edit: (body: Record<string, unknown>) => Record<string, unknown> = (b) => b) {
  const request = recipeRequest()
  return POST(
    new NextRequest(`http://localhost:3000${request.path}`, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(edit(JSON.parse(request.body))),
    }),
    { params: Promise.resolve({ id: 'workflow-1' }) }
  )
}

afterAll(() => resetEnvMock())
afterEach(() => vi.unstubAllEnvs())
beforeEach(() => {
  vi.clearAllMocks()
  resetDbChainMock()
  setEnv({ NEXT_PUBLIC_APP_URL: 'http://localhost:3000' })
  vi.stubEnv('MEMLIA_DURABLE_WORKFLOWS_ENABLED', '1')
  // The route must keep the caller's X-Execution-Id, never mint its own for this request.
  idMockFns.mockGenerateId.mockReset().mockReturnValue('server-minted-id')
  requestUtilsMockFns.mockGenerateRequestId.mockReturnValue('req-12345678')
  io.claim.mockImplementation(async (id: string) => ({ key: `claim:${id}`, token: 'token' }))
  io.owner.mockResolvedValue(false)
  workflowDeploymentStatusMockFns.mockCheckNeedsRedeployment.mockResolvedValue(false)
  billingAttributionMockFns.mockAssertBillingAttributionSnapshot.mockImplementation(
    <T>(value: T): T => value
  )
  billingAttributionMockFns.mockRequireBillingAttributionHeader.mockReturnValue(undefined)
  asyncJobsMockFns.mockShouldExecuteInline.mockReturnValue(false)
  mockGetJobQueue.mockResolvedValue(asyncJobsMockFns.mockJobQueue)
  mockEnqueue.mockResolvedValue(`workflow-execution:${executionId}`)
  vi.mocked(checkHybridAuth).mockResolvedValue({
    success: true,
    userId: 'session-user-1',
    authType: 'session',
    principal,
  })
  workflowAuthzMockFns.mockAuthorizeWorkflowByWorkspacePermission.mockResolvedValue({
    allowed: true,
    workflow: { id: 'workflow-1', userId: 'session-user-1', workspaceId: 'workspace-1' },
  })
  executionPreprocessingMockFns.mockPreprocessExecution.mockResolvedValue({
    success: true,
    actorUserId: 'session-user-1',
    workflowRecord: { id: 'workflow-1', userId: 'session-user-1', workspaceId: 'workspace-1' },
    billingAttribution,
    executionTimeout: { sync: 900_000, async: 900_000 },
  })
})

describe('durable execute request submitted by the browser journey', () => {
  it('is exactly the request queueSessionWorkflowContract declares', () => {
    const { 'content-type': contentType, ...headers } = recipeRequest().headers
    expect(contentType).toBe('application/json')
    expect(queueSessionWorkflowContract.headers.parse(headers)).toEqual(headers)
    const body = JSON.parse(recipeRequest().body)
    expect(queueSessionWorkflowContract.body.parse(body)).toEqual(body)
  })

  it('is admitted by the native durable preparation and queued as one server-minted handle', async () => {
    const response = await submit()
    const body = await response.json()
    expect(response.status).toBe(202)
    expect(queueSessionWorkflowContract.response.schema.parse(body)).toEqual(body)
    expect(durableQueueReceipt(response.status, body, recipeRequest())).toEqual({
      executionId,
      jobId: `workflow-execution:${executionId}`,
    })
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
    const [type, handle, options] = mockEnqueue.mock.calls[0]
    expect(type).toBe('workflow-execution')
    expect(handle).toEqual({ kind: 'prepared_workflow_admission' })
    expect(Object.isFrozen(handle)).toBe(true)
    expect(options).toBeUndefined()
    expect(billingUsageReservationMockFns.mockReleaseExecutionSlot).not.toHaveBeenCalled()
    expect(getMockLogger('WorkflowEnqueueExecution').error).not.toHaveBeenCalled()
  })

  it('admits the same session request with an explicit empty input', async () => {
    const response = await submit((body) => ({ ...body, input: {} }))
    expect(response.status).toBe(202)
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
  })

  it('refuses, before the queue and with its logged reason, a session run whose actor is not the interactive user', async () => {
    const response = await submit(({ isClientSession: _omitted, ...body }) => body)
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Failed to queue async execution' })
    expect(mockGetJobQueue).not.toHaveBeenCalled()
    expect(mockEnqueue).not.toHaveBeenCalled()
    expect(billingUsageReservationMockFns.mockReleaseExecutionSlot).toHaveBeenCalledWith(
      executionId
    )
    expect(getMockLogger('WorkflowEnqueueExecution').error).toHaveBeenCalledExactlyOnceWith(
      '[req-12345678] Durable workflow enqueue refused',
      {
        code: 'durable_enqueue_refused',
        stage: 'admission_preparation',
        workflowId: 'workflow-1',
        reason: 'credential_enforcement',
      }
    )
  })
})
