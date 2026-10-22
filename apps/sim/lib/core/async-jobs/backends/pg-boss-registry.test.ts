// Copyright 2026 Memlia. All rights reserved.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { JobEnvelopeSchema } from '@memlia/contracts'
import { serializePrincipal } from '@sim/auth/principal'
const runner = vi.hoisted(() => vi.fn())
vi.mock('@/background/workflow-execution', () => ({ executeWorkflowJob: runner }))
import { prepareWorkflowExecutionPayload } from '@/lib/workflows/executor/workflow-execution-payload'
import { preparePgBossNativeRunner } from './pg-boss-registry'
import { preparePgBossWorkflowAdmission } from './pg-boss-workflow-admission'
const principal = { kind: 'session' as const, userId: 'user-fixture', sessionId: 'session-fixture' }
const envelope = JobEnvelopeSchema.parse({
  schemaVersion: 'memlia.job/v1',
  commandId: 'command-fixture',
  runId: 'execution-fixture',
  runner: 'workflow-execution',
  inputs: [],
  idempotencyKey: 'idem-fixture',
  submittedAt: '2026-10-19T03:00:00.000Z',
  effectPolicy: { kind: 'no_automatic_retry' },
  authority: {
    schemaVersion: 'memlia.principal/v1',
    organizationId: null,
    workspaceId: 'workspace-fixture',
    actor: serializePrincipal(principal),
    subject: { kind: 'user', userId: principal.userId },
    authority: { kind: 'interactive' },
    scopes: [],
    allowedTools: [],
  },
})
function payload() {
  return prepareWorkflowExecutionPayload({
    requestId: 'request-fixture',
    workflowId: 'workflow-fixture',
    principal,
    userId: principal.userId,
    workspaceId: 'workspace-fixture',
    executionId: envelope.runId,
    input: { fixture: 'original' },
    triggerType: 'manual',
    executionTimeoutMs: 900000,
    enforceCredentialAccess: true,
    isPublicApiAccess: false,
    billingAttribution: {
      actorUserId: principal.userId,
      workspaceId: 'workspace-fixture',
      organizationId: null,
      billedAccountUserId: principal.userId,
      billingEntity: { type: 'user', id: principal.userId },
      billingPeriod: { start: '2026-01-01T00:00:00.000Z', end: '2027-01-01T00:00:00.000Z' },
      payerSubscription: null,
    },
  }).payload
}
beforeEach(() => vi.resetAllMocks())
describe('closed native registry, only final business runner doubled', () => {
  it('keeps the native builder payload and captures it before dynamic runner import awaits', async () => {
    const data = payload(),
      expected = structuredClone(data),
      preparing = preparePgBossNativeRunner(envelope, data, 1200)
    data.input = { fixture: 'changed' }
    const execute = await preparing,
      signal = new AbortController().signal
    await execute(signal)
    expect(runner).toHaveBeenCalledExactlyOnceWith(expected, signal)
  })
  it.each([
    ['enforceCredentialAccess', false],
    ['isPublicApiAccess', true],
    ['admissionCompleted', false],
    ['executionMode', 'sync'],
    ['principal', undefined],
    ['executionId', 'foreign'],
    ['workspaceId', 'foreign'],
    ['userId', 'foreign'],
    ['executionTimeoutMs', 900001],
    ['triggerType', 'invented'],
  ])(
    'rejects legacy/foreign %s instead of letting native fallback create context',
    async (key, value) => {
      await expect(
        preparePgBossNativeRunner(envelope, { ...payload(), [key]: value }, 1200)
      ).rejects.toThrow()
      expect(runner).not.toHaveBeenCalled()
    }
  )
  it('rejects another registered kind and does not dispatch any arbitrary callable', async () => {
    await expect(
      preparePgBossNativeRunner({ ...envelope, runner: 'schedule-execution' }, payload(), 1200)
    ).rejects.toThrow('durable_workflow_runner_rejected')
    expect(runner).not.toHaveBeenCalled()
  })
  it('does not invoke payload getters', async () => {
    const data = payload(),
      getter = vi.fn(() => true)
    Object.defineProperty(data, 'enforceCredentialAccess', { enumerable: true, get: getter })
    await expect(preparePgBossNativeRunner(envelope, data, 1200)).rejects.toThrow()
    expect(getter).not.toHaveBeenCalled()
    expect(runner).not.toHaveBeenCalled()
  })
  it('rejects a workflow duration beyond pg-boss native 24h minus grace during synchronous preparation', () => {
    const identity = {
      commandId: 'duration-command',
      submittedAt: envelope.submittedAt,
      admissionCompleted: true as const,
    }
    const data = { ...payload(), principal, executionTimeoutMs: 86_340_000 - 300_000 }
    expect(() => preparePgBossWorkflowAdmission(data, identity)).not.toThrow()
    expect(() =>
      preparePgBossWorkflowAdmission(
        { ...data, executionTimeoutMs: data.executionTimeoutMs + 1 },
        identity
      )
    ).toThrow('workflow_admission_rejected')
    expect(runner).not.toHaveBeenCalled()
  })
})
