// Copyright (c) 2026 Memlia. All rights reserved.
import { describe, expect, it } from 'vitest'
import {
  type EnqueueWorkflowExecutionParams,
  prepareWorkflowExecutionPayload,
} from './workflow-execution-payload'

const params = (input: unknown): EnqueueWorkflowExecutionParams => ({
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
    billingPeriod: { start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z' },
    payerSubscription: null,
  },
  input,
  triggerType: 'manual',
  executionTimeoutMs: 900000,
})

describe('native workflow execution payload', () => {
  it('omits an absent input instead of carrying an undefined key', () => {
    const { payload } = prepareWorkflowExecutionPayload(params(undefined))
    expect(Object.hasOwn(payload, 'input')).toBe(false)
    expect(Object.values(payload)).not.toContain(undefined)
  })

  it.each([{}, { fixture: true }, null, 0, ''])('keeps a provided input %j as is', (input) => {
    const { payload } = prepareWorkflowExecutionPayload(params(input))
    expect(Object.hasOwn(payload, 'input')).toBe(true)
    expect(payload.input).toBe(input)
  })
})
