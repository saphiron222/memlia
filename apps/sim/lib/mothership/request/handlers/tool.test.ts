// Copyright (c) 2026 Memlia. All rights reserved.
import { beforeEach, expect, it, vi } from 'vitest'

const infra = vi.hoisted(() => ({
  read: vi.fn(),
  execute: vi.fn(),
  wait: vi.fn(),
  generic: vi.fn(),
}))
vi.mock('@/lib/memlia/chat/workflow-proposals.server', () => ({
  WORKFLOW_PROPOSAL_TOOL: 'memlia_apply_workflow_proposal',
  WORKFLOW_PROPOSAL_TTL_MS: 600000,
  readWorkflowProposal: infra.read,
  executeWorkflowProposal: infra.execute,
}))
vi.mock('@/lib/mothership/persistence/tool-permission', async (original) => ({
  ...(await original<typeof import('@/lib/mothership/persistence/tool-permission')>()),
  waitForToolPermissionDecision: infra.wait,
}))
vi.mock('@/lib/mothership/request/tools/executor', async (original) => ({
  ...(await original<typeof import('@/lib/mothership/request/tools/executor')>()),
  executeToolAndReport: infra.generic,
}))

import { createStreamingContext } from '@/lib/mothership/request/context/request-context'
import type { StreamEvent } from '@/lib/mothership/request/types'
import { handleToolEvent, prePersistClientExecutableToolCall } from './tool'

const tool = 'memlia_apply_workflow_proposal'
const metadata = () => ({
  proposalId: 'proposal-a',
  expectedRevision: 7,
  digest: `sha256:${'1'.repeat(64)}`,
  expiresAt: new Date(Date.now() + 600000).toISOString(),
})
const event = (): StreamEvent => ({
  type: 'tool',
  payload: {
    toolCallId: 'proposal-a',
    toolName: tool,
    arguments: { proposalId: 'proposal-a' },
    executor: 'sim',
    mode: 'async',
    phase: 'call',
  },
})
const context = () => {
  const c = createStreamingContext({ runId: 'run-a' })
  c.toolPermissions = { enabled: true, autoAllowed: new Set([tool]), autoAllowPermitted: true }
  return c
}
beforeEach(() => {
  infra.read.mockReset().mockResolvedValue(metadata())
  infra.execute
    .mockReset()
    .mockResolvedValue({ status: 'applied', baseRevision: 7, draftRevision: 8 })
  infra.wait.mockReset().mockResolvedValue({ decision: 'allow' })
  infra.generic.mockReset().mockResolvedValue({ status: 'success' })
})
it('refuses to show an unpersisted proposal rather than forwarding it after a storage failure', async () => {
  infra.read.mockRejectedValue(new Error('PRIVATE_DB_CAUSE'))
  await expect(
    prePersistClientExecutableToolCall(event(), context(), {}, { userId: 'user-a' })
  ).rejects.toThrow('proposal_unavailable')
})
it('replaces untrusted arguments with the public persisted projection before forwarding', async () => {
  const frame = event()
  if (frame.type === 'tool')
    Object.assign(frame.payload, {
      arguments: { proposalId: 'proposal-a', operations: 'PRIVATE_INJECTED_OPS' },
    })
  await prePersistClientExecutableToolCall(frame, context(), {}, { userId: 'user-a' })
  expect(JSON.stringify(frame)).not.toContain('PRIVATE_INJECTED_OPS')
  expect(frame).toMatchObject({
    payload: { arguments: { expectedRevision: 7 }, status: 'awaiting_approval' },
  })
})
it('dispatches the reserved proposal only through the gated adapter, not the generic registry', async () => {
  const c = context()
  const events: StreamEvent[] = []
  await handleToolEvent(
    event(),
    c,
    { userId: 'user-a' },
    {
      onEvent: (e) => {
        events.push(e)
      },
    },
    'main'
  )
  await Promise.all(c.pendingToolPromises.values())
  expect(infra.execute).toHaveBeenCalledOnce()
  expect(infra.wait).toHaveBeenCalledOnce()
  expect(infra.generic).not.toHaveBeenCalled()
  expect(c.toolCalls.get('proposal-a')).toMatchObject({
    status: 'success',
    result: { success: true, output: { status: 'applied', draftRevision: 8 } },
  })
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'tool',
      payload: expect.objectContaining({ phase: 'result', success: true }),
    })
  )
})
it('does not accept a provider-authored success for the reserved tool', async () => {
  const c = context()
  const frame = event()
  if (frame.type === 'tool')
    Object.assign(frame.payload, { phase: 'result', success: true, output: { status: 'applied' } })
  await expect(handleToolEvent(frame, c, { userId: 'user-a' }, {}, 'main')).rejects.toThrow(
    'proposal_unavailable'
  )
  expect(c.toolCalls.size).toBe(0)
})
it('detects identity mutation while the persisted projection is loading', async () => {
  let release!: (value: unknown) => void
  infra.read.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  const frame = event()
  const pending = prePersistClientExecutableToolCall(frame, context(), {}, { userId: 'user-a' })
  void pending.catch(() => {})
  if (frame.type === 'tool') Object.assign(frame.payload, { toolCallId: 'another-proposal' })
  release?.(metadata())
  await expect(pending).rejects.toThrow('proposal_unavailable')
})
it.each([
  { executor: 'client' },
  { phase: 'result' },
  { partial: true },
  { replay: true },
  { status: 'generating' },
])('refuses a mutated dispatch frame after the authority await: %j', async (mutation) => {
  let release!: (value: unknown) => void
  infra.read.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  const frame = event()
  const pending = prePersistClientExecutableToolCall(frame, context(), {}, { userId: 'user-a' })
  void pending.catch(() => {})
  if (frame.type === 'tool') Object.assign(frame.payload, mutation)
  release(metadata())
  await expect(pending).rejects.toThrow('proposal_unavailable')
  expect(infra.execute).not.toHaveBeenCalled()
})
