// Copyright (c) 2026 Memlia. All rights reserved.
// Real model limiter, native handlers/permission gate and leased SSE writer.
// Provider/budget boundary and DB/permission decisions are explicit doubles here.

import { resetEnvFlagsMock, setEnvFlags } from '@sim/testing'
import {
  mothershipAsyncRunsMock,
  mothershipAsyncRunsMockFns,
} from '@sim/testing/mocks/mothership-async-runs.mock'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const infra = vi.hoisted(() => ({
  provider: vi.fn(),
  read: vi.fn(),
  execute: vi.fn(),
  wait: vi.fn(),
  generic: vi.fn(),
  append: vi.fn(),
  attribution: vi.fn(),
  worker: vi.fn(),
  unregister: vi.fn(),
  reserve: vi.fn(),
  settle: vi.fn(),
  propose: vi.fn(),
}))
vi.mock('@/lib/billing/core/attribution', async (original) => ({
  ...(await original<typeof import('@/lib/billing/core/attribution')>()),
  resolveBillingAttribution: infra.attribution,
}))
vi.mock('@/lib/memlia/ai/committed-cost-attempt.server', () => ({
  createCommittedChatCostAttempts: () => ({ reserve: infra.reserve, settle: infra.settle }),
}))
vi.mock('@/lib/memlia/ai/budgeted-catalog-provider.server', () => ({
  runBudgetedCatalogProvider: infra.provider,
}))
vi.mock('@/lib/memlia/chat/workflow-proposals.server', async (original) => ({
  ...(await original<typeof import('@/lib/memlia/chat/workflow-proposals.server')>()),
  WORKFLOW_PROPOSAL_TOOL: 'memlia_apply_workflow_proposal',
  WORKFLOW_PROPOSAL_TTL_MS: 600000,
  readWorkflowProposal: infra.read,
  executeWorkflowProposal: infra.execute,
}))
vi.mock('@/lib/memlia/chat/workflow-preview-tools', async (original) => {
  const actual = await original<typeof import('@/lib/memlia/chat/workflow-preview-tools')>()
  return {
    ...actual,
    createWorkflowPreviewTools: (
      options: Parameters<typeof actual.createWorkflowPreviewTools>[0]
    ) => ({ ...actual.createWorkflowPreviewTools(options), propose: infra.propose }),
  }
})
vi.mock('@/lib/mothership/persistence/tool-permission', async (original) => ({
  ...(await original<typeof import('@/lib/mothership/persistence/tool-permission')>()),
  waitForToolPermissionDecision: infra.wait,
}))
vi.mock('@/lib/mothership/request/tools/executor', async (original) => ({
  ...(await original<typeof import('@/lib/mothership/request/tools/executor')>()),
  executeToolAndReport: infra.generic,
}))
vi.mock('@/lib/mothership/request/session/buffer', () => ({ appendEvents: infra.append }))
vi.mock('@/lib/mothership/async-runs/repository', () => mothershipAsyncRunsMock)
vi.mock('@/lib/mothership/persistence/tool-permission/auto-allow', () => ({
  getAutoAllowedTools: async () => new Set(),
}))
vi.mock('@/lib/permission-groups/capability-assertions', () => ({
  isWorkspaceCapabilityWithheld: async () => false,
}))
vi.mock('@/lib/mothership/request/session/abort', () => ({
  getLocalChatStreamLease: () => ({ key: 'fixture-lease', value: 'fixture-owner' }),
}))
vi.mock('@/lib/mothership/request/session/controller-lease', async (original) => ({
  ...(await original<typeof import('@/lib/mothership/request/session/controller-lease')>()),
  assertChatStreamLease: async () => {},
  holdsChatStreamLease: async () => true,
}))
vi.mock('@/lib/mothership/request/session', async (original) => ({
  ...(await original<typeof import('@/lib/mothership/request/session')>()),
  clearFilePreviewSessions: async () => {},
  scheduleBufferCleanup: async () => {},
  scheduleFilePreviewSessionCleanup: async () => {},
  cleanupAbortMarker: async () => {},
  registerActiveStream: () => {},
  unregisterActiveStream: infra.unregister,
  releasePendingChatStream: async () => {},
  startAbortPoller: () => undefined,
}))
vi.mock('@/lib/mothership/request/go/fetch', () => ({ fetchGo: infra.worker }))
vi.mock('@/lib/mothership/chat-status', () => ({ publishChatStatusChanged: async () => {} }))

import { createStreamingContext } from '@/lib/mothership/request/context/request-context'
import { StreamWriter } from '@/lib/mothership/request/session/writer'
import type { StreamEvent } from '@/lib/mothership/request/types'
import type { AgentStreamEvent } from '@/providers/stream-events'
import { runLocalChat } from './local-driver.server'
import { runModelAdapter } from './model-adapter'

const tool = 'memlia_apply_workflow_proposal'
const proposal = () => ({
  proposalId: 'proposal-a',
  workflowId: 'workflow-a',
  workspaceId: 'workspace-a',
  authorUserId: 'user-a',
  expectedRevision: 7,
  digest: `sha256:${'1'.repeat(64)}`,
  expiresAt: new Date(Date.now() + 600000).toISOString(),
})
const input = () => ({
  principal: { kind: 'session', userId: 'user-a', sessionId: 'PRIVATE_SESSION' },
  workspaceId: 'workspace-a',
  workflow: { workflowId: 'workflow-a', policy: 'sanitized_details', previewOperations: true },
  request: {
    model: 'gpt-5.4',
    apiKey: 'PRIVATE_KEY',
    messages: [{ role: 'user', content: 'Fixture' }],
    maxTokens: 100,
  },
  budget: { windowId: 'budget-a', windowVersion: 1, pricingProfile: {} },
  limits: { maxDurationMs: 1000 },
})
function fixture() {
  const context = createStreamingContext({
    runId: 'run-a',
    toolPermissions: { enabled: true, autoAllowed: new Set([tool]), autoAllowPermitted: true },
  })
  const events: StreamEvent[] = []
  const exec = {
    userId: 'user-a',
    workspaceId: 'workspace-a',
    workflowId: 'workflow-a',
    runId: 'run-a',
  }
  const options = {
    interactive: true,
    onEvent: async (e: StreamEvent) => {
      events.push(structuredClone(e))
    },
  }
  return { context, events, exec, options }
}
function nativeRun(
  options: any,
  work: (o: any, signal: AbortSignal) => Promise<AgentStreamEvent[]>
) {
  return runModelAdapter<AgentStreamEvent, unknown>({
    signal: options.signal,
    limits: options.limits,
    allowedTools: [],
    dispatch: async () => undefined,
    start: (controls) =>
      new ReadableStream({
        async start(c) {
          try {
            controls.beforeModelCall()
            for (const e of await work(options, controls.signal)) c.enqueue(e)
            c.close()
          } catch (e) {
            c.error(e)
          }
        },
      }),
  })
}
beforeEach(() => {
  setEnvFlags({ isHosted: false, isCopilotToolPermissionsEnabled: true })
  mothershipAsyncRunsMockFns.mockCreateRunSegment.mockResolvedValue({ status: 'active' })
  mothershipAsyncRunsMockFns.mockUpdateRunStatus.mockResolvedValue(null)
  infra.worker.mockReset()
  infra.unregister.mockReset()
  infra.provider.mockReset().mockImplementation(async (options) =>
    nativeRun(options, async (o, signal) => {
      await o.proposal.onProposal(proposal(), signal)
      return [
        { type: 'text_delta', text: 'Done.', turn: 'final' },
        { type: 'turn_end', turn: 'final' },
      ]
    })
  )
  infra.read.mockReset().mockImplementation(async () => proposal())
  infra.execute
    .mockReset()
    .mockResolvedValue({ status: 'applied', baseRevision: 7, draftRevision: 8 })
  infra.wait.mockReset().mockResolvedValue({ decision: 'allow' })
  infra.generic.mockReset()
  infra.reserve.mockReset().mockResolvedValue({ kind: 'reserved_committed', reference: {} })
  infra.settle.mockReset().mockResolvedValue({ kind: 'settled_committed' })
  infra.propose.mockReset().mockResolvedValue({ ok: true, proposal: proposal() })
  infra.append.mockReset().mockResolvedValue({ persisted: true })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  resetEnvFlagsMock()
})
it('publishes persisted metadata, waits on the real native gate and returns only the genuine applied receipt', async () => {
  const f = fixture()
  let answer: unknown
  infra.provider.mockImplementation(async (o) =>
    nativeRun(o, async (o, s) => {
      answer = await o.proposal.onProposal(proposal(), s)
      return [
        { type: 'text_delta', text: 'Done.', turn: 'final' },
        { type: 'turn_end', turn: 'final' },
      ]
    })
  )
  await runLocalChat(input(), f.context, f.exec, f.options)
  expect(answer).toEqual({ status: 'applied', baseRevision: 7, draftRevision: 8 })
  expect(f.context.completionStatus).toBe('complete')
  expect(f.context.accumulatedContent).toBe('Done.')
  // The native approval gate updates the same card from awaiting to executing.
  expect(
    new Set(
      f.events.flatMap((e) =>
        e.type === 'tool' && e.payload.phase === 'call' ? [e.payload.toolCallId] : []
      )
    )
  ).toEqual(new Set(['proposal-a']))
  expect(
    f.events.filter(
      (e) =>
        e.type === 'tool' && e.payload.phase === 'call' && e.payload.status === 'awaiting_approval'
    )
  ).toHaveLength(1)
  expect(f.events.find((e) => e.type === 'tool')).toMatchObject({
    payload: {
      toolCallId: 'proposal-a',
      status: 'awaiting_approval',
      arguments: { expectedRevision: 7 },
    },
  })
  expect(f.context.toolCalls.get('proposal-a')?.result?.output).toEqual(answer)
  expect(infra.generic).not.toHaveBeenCalled()
  expect(JSON.stringify(f.events)).not.toMatch(/PRIVATE_SESSION|PRIVATE_KEY|operations|inbandOwned/)
})
it('skip never becomes applied even though the native gate transport returns success', async () => {
  const f = fixture()
  infra.wait.mockResolvedValue({ decision: 'skip' })
  let answer: unknown
  infra.provider.mockImplementation(async (o) =>
    nativeRun(o, async (o, s) => {
      answer = await o.proposal.onProposal(proposal(), s)
      return [{ type: 'turn_end', turn: 'final' }]
    })
  )
  await runLocalChat(input(), f.context, f.exec, f.options)
  expect(answer).toEqual({ status: 'skipped' })
  expect(infra.execute).not.toHaveBeenCalled()
})
it('refused leased publication does not start permission waiting or application', async () => {
  const f = fixture()
  const writer = new StreamWriter({
    streamId: 'stream-a',
    requestId: 'request-a',
    lease: { key: 'lease-a', value: 'owner-a' },
  })
  const stream = new ReadableStream({
    start(c) {
      writer.attach(c)
    },
  })
  infra.append.mockRejectedValue(new Error('PRIVATE_STORAGE_CAUSE'))
  await expect(
    runLocalChat(input(), f.context, f.exec, { ...f.options, onEvent: (e) => writer.publish(e) })
  ).rejects.toThrow('Local Chat is unavailable.')
  expect(infra.wait).not.toHaveBeenCalled()
  expect(infra.execute).not.toHaveBeenCalled()
  await writer.close().catch(() => {})
  await stream.cancel()
})
it('requires a real final boundary, not EOF or an intermediate turn', async () => {
  const f = fixture()
  infra.provider.mockImplementation(async (o) =>
    nativeRun(o, async () => [{ type: 'turn_end', turn: 'intermediate' }])
  )
  await expect(runLocalChat(input(), f.context, f.exec, f.options)).rejects.toThrow(
    'Local Chat is unavailable.'
  )
  expect(f.context.completionStatus).toBeUndefined()
})
it('bounds approval by the model run deadline and cannot apply a late allow', async () => {
  const f = fixture()
  let release!: (v: unknown) => void
  infra.wait.mockImplementation(
    () =>
      new Promise((r) => {
        release = r
      })
  )
  await expect(
    runLocalChat({ ...input(), limits: { maxDurationMs: 25 } }, f.context, f.exec, f.options)
  ).rejects.toThrow('Local Chat is unavailable.')
  release?.({ decision: 'allow' })
  await new Promise((r) => setTimeout(r, 10))
  expect(infra.execute).not.toHaveBeenCalled()
  expect(f.context.completionStatus).toBeUndefined()
})
it('rejects mismatched scope and headless use before budget or provider', async () => {
  const f = fixture()
  await expect(
    runLocalChat(input(), f.context, { ...f.exec, userId: 'other' }, f.options)
  ).rejects.toThrow('Local Chat is unavailable.')
  await expect(
    runLocalChat(input(), f.context, f.exec, { ...f.options, interactive: false })
  ).rejects.toThrow('Local Chat is unavailable.')
  expect(infra.provider).not.toHaveBeenCalled()
})
it('stops without exposing a native budget/provider exception or replaying', async () => {
  const f = fixture()
  infra.provider.mockRejectedValue(new Error('PRIVATE_BUDGET_CAUSE'))
  await expect(runLocalChat(input(), f.context, f.exec, f.options)).rejects.toThrow(
    'Local Chat is unavailable.'
  )
  expect(infra.provider).toHaveBeenCalledOnce()
  expect(f.events).toEqual([])
})

it('the real budget wrapper owns the callback separately from JSON before attribution awaits', async () => {
  const native = await vi.importActual<
    typeof import('@/lib/memlia/ai/budgeted-catalog-provider.server')
  >('@/lib/memlia/ai/budgeted-catalog-provider.server')
  const binding = await import('./provider-binding')
  const { getStaticProviderModels } = await import('@/providers/models')
  const { getModelPricing } = await import('@/providers/pricing')
  const def = getStaticProviderModels('openai').find((m) => m.id === 'gpt-5.4')!
  const profile = {
    version: 1 as const,
    basis: 'native_list_price_estimate_v1' as const,
    provider: 'openai' as const,
    model: def.id,
    pricing: getModelPricing(def.id)!,
    bounds: { contextTokens: def.contextWindow!, outputTokens: 100 },
    maximumCostUsd: '100',
  }
  const callback = vi.fn()
  const replacement = vi.fn()
  const fakeRun = {
    stream: new ReadableStream({
      start(c) {
        c.close()
      },
    }),
    usage: () => ({ modelCalls: 0, toolCalls: 0 }),
  }
  const call = vi.spyOn(binding, 'runCatalogProvider').mockReturnValue(fakeRun)
  let release!: (value: unknown) => void
  infra.attribution.mockImplementation(
    () =>
      new Promise((r) => {
        release = r
      })
  )
  const raw = {
    ...input(),
    budget: { windowId: 'budget-a', windowVersion: 1, pricingProfile: profile },
    proposal: { runId: 'run-a', onProposal: callback },
  }
  const pending = native.runBudgetedCatalogProvider(raw)
  void pending.catch(() => {})
  await Promise.resolve()
  raw.proposal.onProposal = replacement
  raw.proposal.runId = 'foreign-run'
  release?.({ actorUserId: 'user-a' })
  await expect(pending).resolves.toBe(fakeRun)
  expect(call.mock.calls[0][0].proposal).toEqual({ runId: 'run-a', onProposal: callback })
  expect(call.mock.calls[0][0].beforeModelTransport).toBeTypeOf('function')
  expect(call.mock.calls[0][0].observeModelAttempt).toBeTypeOf('function')
})

it('composes createSSEStream → real lifecycle → handlers/gate → leased native writer with one final verdict', async () => {
  const { createSSEStream } = await import('@/lib/mothership/request/lifecycle/start')
  const f = fixture()
  const body = await new Response(
    createSSEStream({
      requestPayload: { message: 'Fixture', mode: 'agent' },
      userId: 'user-a',
      workspaceId: 'workspace-a',
      streamId: 'stream-a',
      executionId: 'exec-a',
      runId: 'run-a',
      chatId: 'chat-a',
      currentChat: null,
      message: 'Fixture',
      titleModel: 'gpt-5.4',
      requestId: 'request-a',
      orchestrateOptions: {
        userId: 'user-a',
        workspaceId: 'workspace-a',
        workflowId: 'workflow-a',
        chatId: 'chat-a',
        goRoute: '/api/mothership',
        interactive: true,
        executionContext: f.exec,
        localChat: input(),
      },
    })
  ).text()
  const frames = body
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)))
  expect(frames.filter((e) => e.type === 'complete')).toHaveLength(1)
  const { getAllMockLoggers } = await import('@sim/testing/mocks/logger.mock')
  expect(
    frames.find((e) => e.type === 'complete').payload.status,
    JSON.stringify({ frames, logs: getAllMockLoggers().flatMap((l) => l.error.mock.calls) })
  ).toBe('complete')
  expect(
    frames.find((e) => e.type === 'tool' && e.payload.phase === 'result').payload.output
  ).toEqual({ status: 'applied', baseRevision: 7, draftRevision: 8 })
  expect(body).toContain('Done.')
  expect(body).not.toMatch(/PRIVATE_KEY|PRIVATE_SESSION|operations/)
  expect(infra.worker).not.toHaveBeenCalled()
  expect(infra.generic).not.toHaveBeenCalled()
  expect(
    mothershipAsyncRunsMockFns.mockCreateRunSegment.mock.calls[0][0].requestContext.recovery
  ).toBeUndefined()
  expect(
    mothershipAsyncRunsMockFns.mockCreateRunSegment.mock.calls[0][0].organizationId
  ).toBeUndefined()
  expect(mothershipAsyncRunsMockFns.mockUpdateRunStatus).toHaveBeenCalledWith(
    'run-a',
    'complete',
    expect.anything(),
    expect.anything()
  )
  expect(infra.unregister).toHaveBeenCalled()
})
it('keeps catalogue presentation in-band without running the registry a second time', async () => {
  const f = fixture()
  infra.provider.mockImplementation(async (o) =>
    nativeRun(o, async () => [
      { type: 'tool_call_start', id: 'model-id', name: 'list_blocks' },
      { type: 'tool_call_end', id: 'model-id', name: 'list_blocks', status: 'success' },
      { type: 'turn_end', turn: 'final' },
    ])
  )
  await runLocalChat(input(), f.context, f.exec, f.options)
  expect(infra.generic).not.toHaveBeenCalled()
  expect(infra.wait).not.toHaveBeenCalled()
  expect([...f.context.toolCalls.values()]).toMatchObject([
    { name: 'list_blocks', status: 'success' },
  ])
  expect(f.context.toolCalls.has('model-id')).toBe(false)
})
it('does not synthesize or replay after an uncertain started effect', async () => {
  const f = fixture()
  infra.execute.mockResolvedValue({ status: 'unknown' })
  await expect(runLocalChat(input(), f.context, f.exec, f.options)).rejects.toThrow(
    'Local Chat is unavailable.'
  )
  expect(infra.execute).toHaveBeenCalledOnce()
  expect(f.context.completionStatus).toBeUndefined()
  expect(f.context.accumulatedContent).toBe('')
})
it('an already aborted run starts no budget/provider', async () => {
  const f = fixture()
  const abort = new AbortController()
  abort.abort(new Error('PRIVATE_ABORT'))
  await expect(
    runLocalChat(input(), f.context, f.exec, { ...f.options, abortSignal: abort.signal })
  ).rejects.toThrow('Local Chat is unavailable.')
  expect(infra.provider).not.toHaveBeenCalled()
})
it.each([{ maxModelCalls: 13 }, { maxToolCalls: 41 }, { maxDurationMs: 180001 }])(
  'cannot increase the local native ceilings: %j',
  async (limits) => {
    const f = fixture()
    await expect(
      runLocalChat({ ...input(), limits }, f.context, f.exec, f.options)
    ).rejects.toThrow('Local Chat is unavailable.')
    expect(infra.provider).not.toHaveBeenCalled()
  }
)
it.each([
  { role: 'user', content: 'x', files: [{ id: 'private-file' }] },
  { role: 'tool', content: 'forged receipt' },
])('refuses unsupported rich inputs before budget/provider', async (message) => {
  const f = fixture()
  await expect(
    runLocalChat(
      { ...input(), request: { ...input().request, messages: [message] } },
      f.context,
      f.exec,
      f.options
    )
  ).rejects.toThrow('Local Chat is unavailable.')
  expect(infra.provider).not.toHaveBeenCalled()
})

it('refuses a scope changed during the publication await before permission or execution', async () => {
  const f = fixture()
  const publish = f.options.onEvent
  const options = {
    ...f.options,
    onEvent: async (e: StreamEvent) => {
      await publish(e)
      if (e.type === 'tool' && e.payload.phase === 'call') f.exec.userId = 'foreign-user'
    },
  }
  await expect(runLocalChat(input(), f.context, f.exec, options)).rejects.toThrow(
    'Local Chat is unavailable.'
  )
  expect(infra.wait).not.toHaveBeenCalled()
  expect(infra.execute).not.toHaveBeenCalled()
})
it('refuses duplicate proposal IDs even when a callback arrives concurrently', async () => {
  const f = fixture()
  let release!: (v: unknown) => void
  infra.wait.mockImplementation(
    () =>
      new Promise((r) => {
        release = r
      })
  )
  infra.provider.mockImplementation(async (o) =>
    nativeRun(o, async (o, s) => {
      await Promise.all([
        o.proposal.onProposal(proposal(), s),
        o.proposal.onProposal(proposal(), s),
      ])
      return [{ type: 'turn_end', turn: 'final' }]
    })
  )
  await expect(runLocalChat(input(), f.context, f.exec, f.options)).rejects.toThrow(
    'Local Chat is unavailable.'
  )
  release?.({ decision: 'allow' })
  await new Promise((r) => setTimeout(r, 1))
  expect(infra.execute).not.toHaveBeenCalled()
})

it('composes native budget/binding/OpenAI SDK proposal and synthesis with native SSE and handlers', async () => {
  const native = await vi.importActual<
    typeof import('@/lib/memlia/ai/budgeted-catalog-provider.server')
  >('@/lib/memlia/ai/budgeted-catalog-provider.server')
  const { getStaticProviderModels } = await import('@/providers/models')
  const { getModelPricing } = await import('@/providers/pricing')
  const { createSSEStream } = await import('@/lib/mothership/request/lifecycle/start')
  const def = getStaticProviderModels('openai').find((m) => m.id === 'gpt-5.4')!
  const profile = {
    version: 1 as const,
    basis: 'native_list_price_estimate_v1' as const,
    provider: 'openai' as const,
    model: def.id,
    pricing: getModelPricing(def.id)!,
    bounds: { contextTokens: def.contextWindow!, outputTokens: 100 },
    maximumCostUsd: '100',
  }
  const intent = {
    request: {
      expectedRevision: 7,
      operations: [{ operation_type: 'remove', block_id: 'block-a' }],
      layout: { mode: 'preserve' },
    },
  }
  function response(output: unknown[], text?: string) {
    return new Response(
      [
        ...(text ? [{ type: 'response.output_text.delta', delta: text }] : []),
        {
          type: 'response.completed',
          response: {
            id: 'fixture-response',
            status: 'completed',
            output,
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ]
        .map((e) => `data: ${JSON.stringify(e)}\n\n`)
        .join(''),
      { headers: { 'Content-Type': 'text/event-stream' } }
    )
  }
  const http = vi
    .fn()
    .mockResolvedValueOnce(
      response([
        {
          type: 'function_call',
          id: 'model-call',
          call_id: 'model-call',
          name: 'propose_workflow_operations',
          arguments: JSON.stringify(intent),
        },
      ])
    )
    .mockResolvedValueOnce(
      response(
        [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Applied.' }],
          },
        ],
        'Applied.'
      )
    )
  vi.stubGlobal('fetch', http)
  infra.attribution.mockResolvedValue({ actorUserId: 'user-a' })
  infra.provider.mockImplementation(native.runBudgetedCatalogProvider)
  const f = fixture()
  const localChat = {
    ...input(),
    budget: { windowId: 'budget-a', windowVersion: 1, pricingProfile: profile },
    limits: { maxDurationMs: 2000 },
  }
  const body = await new Response(
    createSSEStream({
      requestPayload: { message: 'Fixture', mode: 'agent', workflowId: 'workflow-a' },
      userId: 'user-a',
      workspaceId: 'workspace-a',
      streamId: 'stream-a',
      executionId: 'exec-a',
      runId: 'run-a',
      chatId: 'chat-a',
      currentChat: null,
      message: 'Fixture',
      titleModel: 'gpt-5.4',
      requestId: 'request-a',
      orchestrateOptions: {
        userId: 'user-a',
        workspaceId: 'workspace-a',
        workflowId: 'workflow-a',
        chatId: 'chat-a',
        goRoute: '/api/mothership',
        interactive: true,
        executionContext: f.exec,
        localChat,
      },
    })
  ).text()
  const frames = body
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice(6)))
  expect(frames.filter((e) => e.type === 'complete')).toHaveLength(1)
  expect(frames.find((e) => e.type === 'complete').payload.status, JSON.stringify(frames)).toBe(
    'complete'
  )
  expect(body).toContain('Applied.')
  expect(body).not.toMatch(/PRIVATE_KEY|PRIVATE_SESSION|operations|model-call/)
  expect(http).toHaveBeenCalledTimes(2)
  expect(infra.reserve).toHaveBeenCalledTimes(2)
  expect(infra.settle).toHaveBeenCalledTimes(2)
  expect(infra.reserve.mock.invocationCallOrder[0]).toBeLessThan(http.mock.invocationCallOrder[0])
  expect(infra.reserve.mock.invocationCallOrder[1]).toBeLessThan(http.mock.invocationCallOrder[1])
  expect(infra.propose).toHaveBeenCalledWith(intent.request, expect.any(AbortSignal))
  expect(infra.execute).toHaveBeenCalledOnce()
  expect(infra.settle.mock.calls.every(([, result]) => result.kind === 'known')).toBe(true)
  expect(infra.generic).not.toHaveBeenCalled()
  expect(infra.worker).not.toHaveBeenCalled()
  const result = JSON.parse(http.mock.calls[1][1].body).input.find(
    (x: { type: string }) => x.type === 'function_call_output'
  )
  expect(JSON.parse(result.output)).toEqual({
    status: 'applied',
    baseRevision: 7,
    draftRevision: 8,
  })
})

it('refuses a late new proposal after the local lifecycle already completed', async () => {
  const f = fixture()
  let callback!: (value: ReturnType<typeof proposal>, signal: AbortSignal) => Promise<unknown>
  infra.provider.mockImplementation(async (o) =>
    nativeRun(o, async (o) => {
      callback = o.proposal.onProposal
      return [{ type: 'turn_end', turn: 'final' }]
    })
  )
  await runLocalChat(input(), f.context, f.exec, f.options)
  const before = structuredClone(f.events)
  await expect(callback(proposal(), new AbortController().signal)).rejects.toThrow(
    'Local Chat is unavailable.'
  )
  expect(f.events).toEqual(before)
  expect(infra.wait).not.toHaveBeenCalled()
  expect(infra.execute).not.toHaveBeenCalled()
})
it('refuses an organisation-level execution context rather than treating it as a workspace workflow', async () => {
  const f = fixture()
  await expect(
    runLocalChat(input(), f.context, { ...f.exec, organizationId: 'org-a' }, f.options)
  ).rejects.toThrow('Local Chat is unavailable.')
  expect(infra.provider).not.toHaveBeenCalled()
})

it('a publisher cannot replace the reserved handler frame or turn it into an in-band tool', async () => {
  const f = fixture()
  infra.wait.mockResolvedValue({ decision: 'skip' })
  const publish = f.options.onEvent
  const options = {
    ...f.options,
    onEvent: async (event: StreamEvent) => {
      await publish(event)
      if (event.type === 'tool' && event.payload.phase === 'call') {
        event.payload.toolName = 'list_blocks'
        event.payload.toolCallId = 'publisher-foreign'
        event.payload.ui = { inbandOwned: true }
      }
    },
  }
  await runLocalChat(input(), f.context, f.exec, options)
  expect(infra.wait).toHaveBeenCalledOnce()
  expect(infra.wait.mock.calls[0][0]).toBe('proposal-a')
  expect(infra.generic).not.toHaveBeenCalled()
  expect(infra.execute).not.toHaveBeenCalled()
  expect(f.context.toolCalls.has('publisher-foreign')).toBe(false)
  expect(f.context.toolCalls.get('proposal-a')?.status).toBe('skipped')
})
