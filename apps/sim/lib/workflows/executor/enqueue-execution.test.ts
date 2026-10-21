// Copyright 2026 Memlia. All rights reserved.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnqueueWorkflowExecutionParams } from './workflow-execution-payload'
const ports = vi.hoisted(() => ({
  get: vi.fn(),
  enqueue: vi.fn(),
  prepare: vi.fn(),
  release: vi.fn(),
  runner: vi.fn(),
}))
vi.mock('@/lib/core/async-jobs', () => ({
  getJobQueue: ports.get,
  shouldExecuteInline: () => false,
}))
vi.mock('@/lib/core/async-jobs/backends/pg-boss-workflow-admission', () => ({
  preparePgBossWorkflowAdmission: ports.prepare,
}))
vi.mock('@/lib/billing/calculations/usage-reservation', () => ({
  releaseExecutionSlot: ports.release,
}))
vi.mock('@/background/workflow-execution', () => ({ executeWorkflowJob: ports.runner }))
import { enqueueWorkflowExecution } from './enqueue-execution'
import { AsyncJobEnqueueError } from '@/lib/core/async-jobs/types'
const input = (): EnqueueWorkflowExecutionParams => ({
  requestId: 'request',
  workflowId: 'workflow',
  userId: 'user',
  workspaceId: 'workspace',
  executionId: 'execution',
  principal: { kind: 'session', userId: 'user', sessionId: 'session' },
  billingAttribution: {
    actorUserId: 'user',
    billedAccountUserId: 'user',
    workspaceId: 'workspace',
    organizationId: null,
    billingEntity: { type: 'user', id: 'user' },
    billingPeriod: { start: '2026-01-01T00:00:00.000Z', end: '2027-01-01T00:00:00.000Z' },
    payerSubscription: null,
  },
  input: { fixture: true },
  triggerType: 'api',
  executionTimeoutMs: 900000,
  enforceCredentialAccess: true,
  isPublicApiAccess: false,
})
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv('MEMLIA_DURABLE_WORKFLOWS_ENABLED', '1')
  ports.get.mockResolvedValue({ enqueue: ports.enqueue })
  ports.prepare.mockReturnValue(Object.freeze({ kind: 'prepared_workflow_admission' }))
  ports.enqueue.mockResolvedValue('job')
})
afterEach(() => vi.unstubAllEnvs())
describe('durable native enqueue caller, persistence ports doubled', () => {
  it('prepares the server snapshot before queue initialization awaits and passes no closure/options', async () => {
    let release!: () => void
    ports.get.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ enqueue: ports.enqueue })
        })
    )
    const params = input(),
      pending = enqueueWorkflowExecution(params)
    expect(ports.prepare).toHaveBeenCalledTimes(1)
    expect(ports.prepare.mock.calls[0][1]).toMatchObject({ admissionCompleted: true })
    const handle = ports.prepare.mock.results[0].value
    params.input = { changed: true }
    release()
    await expect(pending).resolves.toEqual({
      outcome: 'queued',
      jobId: 'job',
      executionId: 'execution',
      retainExecutionClaim: true,
    })
    expect(ports.enqueue).toHaveBeenCalledExactlyOnceWith('workflow-execution', handle)
    expect(ports.release).not.toHaveBeenCalled()
    expect(ports.runner).not.toHaveBeenCalled()
  })
  it('releases only a definite pre-admission refusal', async () => {
    ports.prepare.mockImplementation(() => {
      throw new Error('fixed_refusal')
    })
    await expect(enqueueWorkflowExecution(input())).resolves.toMatchObject({
      outcome: 'rejected',
      retainExecutionClaim: false,
    })
    expect(ports.get).not.toHaveBeenCalled()
    expect(ports.enqueue).not.toHaveBeenCalled()
    expect(ports.release).toHaveBeenCalledExactlyOnceWith('execution')
  })
  it('does not fall back when selected durable initialization fails', async () => {
    ports.get.mockRejectedValue(new Error('fixed_configuration_refusal'))
    await expect(enqueueWorkflowExecution(input())).resolves.toMatchObject({ outcome: 'rejected' })
    expect(ports.enqueue).not.toHaveBeenCalled()
    expect(ports.runner).not.toHaveBeenCalled()
  })
  it.each(['unknown', 'rejected'] as const)(
    'preserves acceptance %s without regenerating/retrying a handle',
    async (acceptance) => {
      ports.enqueue.mockRejectedValue(
        new AsyncJobEnqueueError('workflow_admission_rejected', { acceptance, retryable: false })
      )
      await expect(enqueueWorkflowExecution(input())).resolves.toMatchObject({
        outcome: acceptance === 'unknown' ? 'ambiguous' : 'rejected',
        retainExecutionClaim: acceptance === 'unknown',
      })
      expect(ports.prepare).toHaveBeenCalledTimes(1)
      expect(ports.enqueue).toHaveBeenCalledTimes(1)
      expect(ports.release).toHaveBeenCalledTimes(acceptance === 'unknown' ? 0 : 1)
    }
  )
  it('retains ownership on an unclassified post-admission error', async () => {
    ports.enqueue.mockRejectedValue(new Error('private_cause'))
    await expect(enqueueWorkflowExecution(input())).resolves.toMatchObject({
      outcome: 'ambiguous',
      retainExecutionClaim: true,
    })
    expect(ports.release).not.toHaveBeenCalled()
    expect(ports.enqueue).toHaveBeenCalledTimes(1)
  })
})
