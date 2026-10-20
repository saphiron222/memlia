// Copyright (c) 2026 Memlia. All rights reserved.
// Real model limiter, native handlers/permission gate and leased SSE writer.
// Provider/budget boundary and DB/permission decisions are explicit doubles here.

import { resetEnvFlagsMock, setEnvFlags } from '@sim/testing'
import {
  workflowContextMock,
  workflowContextMockFns,
} from '@sim/testing/mocks/workflow-context.mock'
import { workspaceAuthzMock, workspaceAuthzMockFns } from '@sim/testing/mocks/workspace-authz.mock'
import { fixtures as excelFixtures } from '../../../../../packages/memlia-contracts/tests/fixtures'

vi.mock('@/lib/workflows/application/context', () => workflowContextMock)
vi.mock('@sim/platform-authz/workspace', () => workspaceAuthzMock)
vi.mock('@/lib/permission-groups/config-scope.server', () => ({
  resolvePermissionGroupConfig: async () => null,
}))

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
vi.mock('@/lib/permission-groups/capability-assertions', async (original) => ({
  ...(await original<typeof import('@/lib/permission-groups/capability-assertions')>()),
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
import { ModelAdapterStop, runModelAdapter } from './model-adapter'

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
  const run = runModelAdapter<AgentStreamEvent, unknown>({
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
  return { ...run, workflowPreparation: () => Object.freeze({ evaluated: 0, refused: 0 }) }
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

it.each(['openai', 'anthropic'] as const)(
  'composes native budget/binding/%s SDK proposal and synthesis with native SSE and handlers',
  async (provider) => {
    const native = await vi.importActual<
      typeof import('@/lib/memlia/ai/budgeted-catalog-provider.server')
    >('@/lib/memlia/ai/budgeted-catalog-provider.server')
    const { getStaticProviderModels } = await import('@/providers/models')
    const { getModelPricing } = await import('@/providers/pricing')
    const { createSSEStream } = await import('@/lib/mothership/request/lifecycle/start')
    const def = getStaticProviderModels(provider).find(
      (m) => m.id === (provider === 'openai' ? 'gpt-5.4' : 'claude-haiku-4-5')
    )!
    const profile = {
      version: 1 as const,
      basis: 'native_list_price_estimate_v1' as const,
      provider,
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
    function anthropicResponse(tool: boolean) {
      const events = [
        {
          type: 'message_start',
          message: {
            id: 'msg_fixture',
            type: 'message',
            role: 'assistant',
            model: def.id,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: 1,
              output_tokens: 0,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_creation: null,
              service_tier: 'standard',
            },
          },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: tool
            ? { type: 'tool_use', id: 'model-call', name: 'propose_workflow_operations', input: {} }
            : { type: 'text', text: '' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: tool
            ? { type: 'input_json_delta', partial_json: JSON.stringify(intent) }
            : { type: 'text_delta', text: 'Applied.' },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null },
          usage: { output_tokens: 1 },
        },
        { type: 'message_stop' },
      ]
      return new Response(
        events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
        { headers: { 'Content-Type': 'text/event-stream' } }
      )
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
        provider === 'anthropic'
          ? anthropicResponse(true)
          : response([
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
        provider === 'anthropic'
          ? anthropicResponse(false)
          : response(
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
      request: { ...input().request, model: def.id },
      ...(provider === 'anthropic' ? { anthropicWorkspaceId: 'wrkspc_fixture123' } : {}),
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
    const wire = JSON.parse(http.mock.calls[1][1].body)
    const result =
      provider === 'openai'
        ? wire.input.find((x: { type: string }) => x.type === 'function_call_output').output
        : wire.messages
            .flatMap((m: { content: unknown[] }) => m.content)
            .find((x: { type: string }) => x.type === 'tool_result').content
    expect(JSON.parse(result)).toEqual({
      status: 'applied',
      baseRevision: 7,
      draftRevision: 8,
    })
  }
)

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

it.each(['excel_describe_capabilities', 'excel_preview_procedure'])(
  'P11 presents already analyzed %s without second dispatch or consent',
  async (name) => {
    const f = fixture()
    infra.provider.mockImplementation(async (o) =>
      nativeRun(o, async () => [
        { type: 'tool_call_start', id: 'excel-model-id', name },
        { type: 'tool_call_end', id: 'excel-model-id', name, status: 'success' },
        { type: 'turn_end', turn: 'final' },
      ])
    )
    await runLocalChat(input(), f.context, f.exec, f.options)
    expect(infra.generic).not.toHaveBeenCalled()
    expect(infra.wait).not.toHaveBeenCalled()
    expect(infra.execute).not.toHaveBeenCalled()
    expect([...f.context.toolCalls.values()]).toMatchObject([{ name, status: 'success' }])
    expect(f.context.toolCalls.has('excel-model-id')).toBe(false)
    expect(JSON.stringify(f.events)).not.toContain('PRIVATE_SESSION')
  }
)

it('P11 composes Excel analysis through native budget/provider, lifecycle SSE and handlers', async () => {
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
  const {
    schemaVersion,
    organizationId,
    workspaceId,
    procedureId,
    version,
    parentVersion,
    workflowId,
    deployedVersionId,
    ownerUserId,
    digest,
    policyVersion,
    ...draft
  } = structuredClone(excelFixtures.ExcelProcedure)
  draft.decimalPolicy.precision = 18
  const intent = { request: draft }
  workflowContextMockFns.mockResolveActiveWorkflowApplicationContext.mockResolvedValue({
    workflowId: 'workflow-a',
    workflow: { id: 'workflow-a', workspaceId: 'workspace-a' },
    workspaceId: 'workspace-a',
    workspaceOrganizationId: null,
    allowPersonalApiKeys: true,
    billedAccountUserId: 'not-authority',
  })
  workspaceAuthzMockFns.mockResolveEffectiveWorkspacePermission.mockResolvedValue('read')
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
          name: 'excel_preview_procedure',
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
            content: [{ type: 'output_text', text: 'Declarations analyzed; no calculation.' }],
          },
        ],
        'Declarations analyzed; no calculation.'
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
  expect(body).toContain('Declarations analyzed; no calculation.')
  expect(body).not.toMatch(/PRIVATE_KEY|PRIVATE_SESSION|operations|model-call/)
  expect(http).toHaveBeenCalledTimes(2)
  expect(infra.reserve).toHaveBeenCalledTimes(2)
  expect(infra.settle).toHaveBeenCalledTimes(2)
  expect(infra.reserve.mock.invocationCallOrder[0]).toBeLessThan(http.mock.invocationCallOrder[0])
  expect(infra.reserve.mock.invocationCallOrder[1]).toBeLessThan(http.mock.invocationCallOrder[1])
  expect(infra.propose).not.toHaveBeenCalled()
  expect(infra.execute).not.toHaveBeenCalled()
  expect(infra.wait).not.toHaveBeenCalled()
  expect(infra.settle.mock.calls.every(([, result]) => result.kind === 'known')).toBe(true)
  expect(infra.generic).not.toHaveBeenCalled()
  expect(infra.worker).not.toHaveBeenCalled()
  const result = JSON.parse(http.mock.calls[1][1].body).input.find(
    (x: { type: string }) => x.type === 'function_call_output'
  )
  expect(JSON.parse(result.output)).toMatchObject({
    analysis: 'declarative_draft',
    executionAvailable: false,
    persisted: false,
    dataflow: { declaredDataflowValid: true },
    capabilities: { primitiveOptionsCompatible: true },
  })
})

function exhaustedProposalProvider(
  after: 'none' | 'later_tool' | 'parallel_tool' | 'rejected_tool' | 'active_tool' | 'second_proposal' = 'none',
  hooks: { before?: () => void; after?: () => void; skipProposal?: boolean } = {}
) {
  return async (o: any) => {
    let releaseOther!: () => void
    const other = new Promise<void>((resolve) => { releaseOther = resolve })
    const run = runModelAdapter<AgentStreamEvent, unknown>({
      limits: { maxModelCalls: 1 }, signal: o.signal,
      allowedTools: ['propose_workflow_operations', 'read_workflow'],
      dispatch: async (name, _params, signal) => {
        if (name === 'propose_workflow_operations') return o.proposal.onProposal(proposal(), signal)
        if (after === 'rejected_tool') throw new Error('PRIVATE_TOOL_ERROR')
        if (after === 'parallel_tool' || after === 'active_tool') await other
        return { ok: true }
      },
      start: (controls) => new ReadableStream({
        async start(controller) {
          try {
            controls.beforeModelCall()
            // Model transport is asynchronous; dispatch occurs after the run is returned.
            await new Promise<void>((resolve) => setImmediate(resolve))
            const parallel = after === 'parallel_tool'
              ? controls.executeTool('read_workflow', {}) : undefined
            hooks.before?.()
            if (!hooks.skipProposal) await controls.executeTool('propose_workflow_operations', {})
            hooks.after?.()
            if (after === 'later_tool' || after === 'rejected_tool') await controls.executeTool('read_workflow', {})
            if (after === 'second_proposal') await controls.executeTool('propose_workflow_operations', {})
            if (after === 'active_tool') void controls.executeTool('read_workflow', {}).catch(() => {})
            if (after !== 'active_tool') releaseOther()
            await parallel
            controls.beforeModelCall()
            controller.enqueue({ type: 'turn_end', turn: 'final' })
            controller.close()
          } catch (error) { controller.error(error) } finally { releaseOther() }
        },
      }),
    })
    return { ...run, workflowPreparation: () => Object.freeze({ evaluated: 0, refused: 0 }) }
  }
}

it('v6 diagnosis — exact applied receipt at exhaustion reports only the certain edit', async () => {
  const f = fixture()
  infra.provider.mockImplementation(exhaustedProposalProvider())
  await runLocalChat(input(), f.context, f.exec, f.options)
  expect(infra.execute).toHaveBeenCalledOnce()
  expect(f.context.toolCalls.get('proposal-a')?.result?.output).toEqual({
    status: 'applied', baseRevision: 7, draftRevision: 8,
  })
  expect(f.context.completionStatus).toBe('complete')
  expect(f.context.accumulatedContent).toBe(
    'Modification appliquée, révision 8. Limite d’appels atteinte ; test non effectué.'
  )
})

it.each(['later_tool', 'parallel_tool', 'rejected_tool', 'active_tool', 'second_proposal'] as const)(
  'v6 diagnosis — an unconsumed %s cannot turn an older applied effect into final success',
  async (after) => {
    const f = fixture()
    infra.provider.mockImplementation(exhaustedProposalProvider(after))
    await expect(runLocalChat(input(), f.context, f.exec, f.options)).rejects.toThrow(
      'Local Chat is unavailable.'
    )
    expect(infra.execute).toHaveBeenCalledOnce()
    expect(f.context.completionStatus).not.toBe('complete')
  }
)


it.each(['skip', 'unknown', 'scope', 'abort', 'duration', 'pending', 'fake_stop', 'before_proposal', 'revision'] as const)(
  'v6 diagnosis — %s never receives the deterministic applied terminal',
  async (scenario) => {
    const f = fixture()
    const abort = new AbortController()
    if (scenario === 'skip') infra.wait.mockResolvedValue({ decision: 'skip' })
    if (scenario === 'unknown') infra.execute.mockResolvedValue({ status: 'unknown' })
    if (scenario === 'revision') infra.execute.mockResolvedValue({ status: 'applied', baseRevision: 7, draftRevision: 7 })
    infra.provider.mockImplementation(exhaustedProposalProvider('none', {
      skipProposal: scenario === 'before_proposal',
      after() {
        if (scenario === 'scope') f.exec.workflowId = 'foreign'
        if (scenario === 'abort') abort.abort()
        if (scenario === 'duration') throw new ModelAdapterStop('duration')
        if (scenario === 'fake_stop') throw Object.assign(new Error('PRIVATE'), { code: 'model_calls' })
        if (scenario === 'pending') f.context.pendingToolPromises.set('other', new Promise(() => {}))
      },
    }))
    await expect(runLocalChat(input(), f.context, f.exec, { ...f.options, abortSignal: abort.signal }))
      .rejects.toThrow('Local Chat is unavailable.')
    expect(f.context.completionStatus).not.toBe('complete')
    expect(f.context.accumulatedContent).not.toContain('Limite d’appels atteinte')
    expect(JSON.stringify(f.events)).not.toMatch(/PRIVATE|model_calls/)
  }
)

it.each(['Aperçu terminé. Confirmez-vous ?', 'Quel taux souhaitez-vous utiliser ?'])(
  'completion protocol — preview followed by text remains preparation only: %s',
  async (text) => {
    const f = fixture()
    infra.provider.mockImplementation(async (o) => ({
      ...nativeRun(o, async () => [
        { type: 'text_delta', text, turn: 'final' },
        { type: 'turn_end', turn: 'final' },
      ]),
      workflowPreparation: () => Object.freeze({ evaluated: 1, refused: 0 }),
    }))
    await runLocalChat(input(), f.context, f.exec, f.options)
    expect(f.events.at(-1)).toMatchObject({
      type: 'complete',
      payload: {
        status: 'complete',
        response: {
          workflow: {
            stage: 'preparation_only',
            previews: { evaluated: 1, refused: 0 },
            proposals: { created: 0, applied: 0, skipped: 0 },
            workflowExecutionByThisChatBackend: 'not_performed',
          },
        },
      },
    })
    expect(f.context.accumulatedContent).toBe(text)
    expect(infra.execute).not.toHaveBeenCalled()
    expect(infra.wait).not.toHaveBeenCalled()
  }
)

it.each(['Comment souhaitez-vous nommer le bloc ?', 'Ce bloc transforme une liste.'])(
  'completion protocol — descriptive or clarification text is not a workflow effect: %s',
  async (text) => {
    const f = fixture()
    infra.provider.mockImplementation(async (o) => ({
      ...nativeRun(o, async () => [
        { type: 'text_delta', text, turn: 'final' },
        { type: 'turn_end', turn: 'final' },
      ]),
      workflowPreparation: () => Object.freeze({ evaluated: 0, refused: 0 }),
    }))
    await runLocalChat(input(), f.context, f.exec, f.options)
    expect(f.events.at(-1)).toMatchObject({
      payload: {
        status: 'complete',
        response: {
          workflow: { stage: 'no_preparation', proposals: { created: 0, applied: 0, skipped: 0 } },
        },
      },
    })
    expect(f.context.accumulatedContent).toBe(text)
    expect(infra.execute).not.toHaveBeenCalled()
  }
)

it.each(['allow', 'skip'] as const)(
  'completion protocol — only native %s receipts determine the effect',
  async (decision) => {
    const f = fixture()
    infra.wait.mockResolvedValue({ decision })
    await runLocalChat(input(), f.context, f.exec, f.options)
    expect(f.events.at(-1)).toMatchObject({
      payload: {
        response: {
          workflow: {
            stage: decision === 'allow' ? 'applied' : 'proposal_not_applied',
            proposals: {
              created: 1,
              applied: decision === 'allow' ? 1 : 0,
              skipped: decision === 'skip' ? 1 : 0,
            },
            ...(decision === 'allow'
              ? { latestAppliedRevision: { baseRevision: 7, draftRevision: 8 } }
              : {}),
            workflowExecutionByThisChatBackend: 'not_performed',
          },
        },
      },
    })
  }
)

it('completion protocol — publisher mutation cannot modify the native receipt or grant effects', async () => {
  const f = fixture()
  infra.wait.mockResolvedValue({ decision: 'skip' })
  await runLocalChat(input(), f.context, f.exec, {
    ...f.options,
    onEvent: async (e) => {
      await f.options.onEvent(e)
      if (e.type === 'complete')
        e.payload.response = { workflow: { stage: 'applied', private: 'CANARY' } }
    },
  })
  expect(f.events.at(-1)).toMatchObject({
    payload: { response: { workflow: { stage: 'proposal_not_applied' } } },
  })
  expect(infra.execute).not.toHaveBeenCalled()
  expect(JSON.stringify(f.events)).not.toContain('CANARY')
})

it('completion protocol — leased native SSE persists preparation metadata without creating approval', async () => {
  const f = fixture()
  infra.provider.mockImplementation(async (o) => ({
    ...nativeRun(o, async () => [
      { type: 'text_delta', text: 'Confirmez-vous ?', turn: 'final' },
      { type: 'turn_end', turn: 'final' },
    ]),
    workflowPreparation: () => Object.freeze({ evaluated: 1, refused: 0 }),
  }))
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
  const body = new Response(stream).text()
  await runLocalChat(input(), f.context, f.exec, {
    ...f.options,
    onEvent: (e) => writer.publish(e),
  })
  await writer.close()
  const text = await body
  const frames = text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)))
  expect(frames.filter((e) => e.type === 'complete')).toHaveLength(1)
  expect(frames.find((e) => e.type === 'complete')).toMatchObject({
    payload: {
      status: 'complete',
      response: {
        workflow: { stage: 'preparation_only', proposals: { created: 0, applied: 0, skipped: 0 } },
      },
    },
  })
  expect(JSON.stringify(infra.append.mock.calls)).toContain('preparation_only')
  expect(text).not.toMatch(/PRIVATE_|operations|approval/)
  expect(infra.execute).not.toHaveBeenCalled()
  expect(infra.wait).not.toHaveBeenCalled()
})

it('completion protocol — a late native dispatch cannot be attested as no preparation', async () => {
  const f = fixture()
  let release!: () => void
  const hold = new Promise<void>(resolve => { release = resolve })
  let pending: Promise<unknown> | undefined
  let settled = false
  infra.provider.mockImplementation(async options => {
    const run = runModelAdapter<AgentStreamEvent, unknown>({
      signal: options.signal,
      allowedTools: ['preview_workflow_operations'],
      dispatch: async () => { await hold; settled = true; return {} },
      start: controls => new ReadableStream({ start(controller) {
        controls.beforeModelCall()
        pending = controls.executeTool('preview_workflow_operations', {})
        void pending.catch(() => {})
        controller.enqueue({ type: 'turn_end', turn: 'final' })
        controller.close()
      } }),
    })
    return { ...run, workflowPreparation: () => Object.freeze({ evaluated: settled ? 1 : 0, refused: 0 }) }
  })
  try {
    await expect(runLocalChat(input(), f.context, f.exec, f.options)).rejects.toThrow('Local Chat is unavailable.')
    expect(settled).toBe(false)
    expect(f.events.some(e => e.type === 'complete')).toBe(false)
    expect(infra.execute).not.toHaveBeenCalled()
  } finally {
    release()
    await pending?.catch(() => {})
  }
})

it('completion protocol — missing native activity observation cannot attest a terminal outcome', async () => {
  const f = fixture()
  infra.provider.mockImplementation(async o => ({
    ...nativeRun(o, async () => [{ type: 'turn_end', turn: 'final' }]),
    toolActivity: undefined,
  }))
  await expect(runLocalChat(input(), f.context, f.exec, f.options)).rejects.toThrow('Local Chat is unavailable.')
  expect(f.events.some(e => e.type === 'complete')).toBe(false)
})

it.each(['end_turn', 'stop_sequence', 'max_tokens', undefined] as const)(
  'finish reason — empty final %s is observable without inventing preparation',
  async (finishReason) => {
    const f = fixture()
    infra.provider.mockImplementation(async (o) =>
      nativeRun(o, async () => [
        { type: 'turn_end', turn: 'intermediate', finishReason: 'tool_use' },
        { type: 'turn_end', turn: 'final', ...(finishReason ? { finishReason } : {}) },
      ])
    )
    await runLocalChat(input(), f.context, f.exec, f.options)
    expect(f.events.at(-1)).toMatchObject({
      type: 'complete',
      payload: {
        status: 'complete',
        response: {
          modelTurn: { finishReason: finishReason ?? 'not_observed' },
          workflow: {
            stage: 'no_preparation',
            workflowExecutionByThisChatBackend: 'not_performed',
          },
        },
      },
    })
    expect(f.context.accumulatedContent).toBe('')
    expect(infra.execute).not.toHaveBeenCalled()
  }
)

it('finish reason — output limit after a certain application preserves it exactly once', async () => {
  const f = fixture()
  infra.provider.mockImplementation(async (o) =>
    nativeRun(o, async (o, signal) => {
      await o.proposal.onProposal(proposal(), signal)
      return [
        { type: 'text_delta', text: 'Partial', turn: 'pending' },
        { type: 'turn_end', turn: 'final', finishReason: 'max_tokens' },
      ]
    })
  )
  await runLocalChat(input(), f.context, f.exec, f.options)
  expect(infra.execute).toHaveBeenCalledOnce()
  expect(f.events.at(-1)).toMatchObject({
    payload: {
      response: {
        modelTurn: { finishReason: 'max_tokens' },
        workflow: {
          stage: 'applied',
          latestAppliedRevision: { baseRevision: 7, draftRevision: 8 },
          workflowExecutionByThisChatBackend: 'not_performed',
        },
      },
    },
  })
  expect(f.context.accumulatedContent).toBe('Partial')
})

it.each(['PRIVATE_RAW_REASON', 'tool_use'])(
  'finish reason — invalid final reason refuses without leaking %s',
  async (finishReason) => {
    const f = fixture()
    infra.provider.mockImplementation(async (o) =>
      nativeRun(o, async () => [
        { type: 'turn_end', turn: 'final', finishReason } as unknown as AgentStreamEvent,
      ])
    )
    await expect(runLocalChat(input(), f.context, f.exec, f.options)).rejects.toThrow()
    expect(f.events.some((e) => e.type === 'complete')).toBe(false)
    expect(JSON.stringify(f.events)).not.toContain('PRIVATE_RAW_REASON')
  }
)

it('finish reason — the certain model-call-limit terminal has no provider final reason', async () => {
  const f = fixture()
  infra.provider.mockImplementation(exhaustedProposalProvider())
  await runLocalChat(input(), f.context, f.exec, f.options)
  expect(f.events.at(-1)).toMatchObject({
    payload: {
      response: {
        modelTurn: { finishReason: 'not_observed' },
        workflow: { stage: 'applied' },
      },
    },
  })
  expect(infra.execute).toHaveBeenCalledOnce()
})
