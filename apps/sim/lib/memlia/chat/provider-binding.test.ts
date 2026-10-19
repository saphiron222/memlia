// Copyright (c) 2026 Memlia. All rights reserved.

import { createSessionPrincipal } from '@sim/testing/factories/principal.factory'
import { auditMock, auditMockFns } from '@sim/testing/mocks/audit.mock'
import { blockVisibilityMock } from '@sim/testing/mocks/block-visibility.mock'
import { customBlockOperationsMock } from '@sim/testing/mocks/custom-block-operations.mock'
import { integrationsAvailabilityMock } from '@sim/testing/mocks/integrations-availability.mock'
import { toolsMock, toolsMockFns } from '@sim/testing/mocks/tools.mock'
import {
  workflowContextMock,
  workflowContextMockFns,
} from '@sim/testing/mocks/workflow-context.mock'
import {
  workflowsQueriesMock,
  workflowsQueriesMockFns,
} from '@sim/testing/mocks/workflows-queries.mock'
import { workspaceAuthzMock, workspaceAuthzMockFns } from '@sim/testing/mocks/workspace-authz.mock'
import {
  workspaceContextMock,
  workspaceContextMockFns,
} from '@sim/testing/mocks/workspace-context.mock'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const proposalInfra = vi.hoisted(() => ({ propose: vi.fn() }))
vi.mock('@/lib/memlia/chat/workflow-preview-tools', async (original) => {
  const actual = await original<typeof import('@/lib/memlia/chat/workflow-preview-tools')>()
  return {
    ...actual,
    createWorkflowPreviewTools: (
      options: Parameters<typeof actual.createWorkflowPreviewTools>[0]
    ) => ({
      ...actual.createWorkflowPreviewTools(options),
      propose: (body: unknown, signal: AbortSignal) => proposalInfra.propose(options, body, signal),
    }),
  }
})
const previewInfra = vi.hoisted(() => ({ snapshot: vi.fn(), replace: vi.fn(), ids: vi.fn() }))
vi.mock('@/lib/workflows/persistence/utils', () => ({
  loadWorkflowDraftSnapshot: previewInfra.snapshot,
}))
vi.mock('@/lib/workflows/persistence/replace-normalized-state', async (original) => ({
  ...(await original<typeof import('@/lib/workflows/persistence/replace-normalized-state')>()),
  replaceWorkflowNormalizedState: previewInfra.replace,
  assertWorkflowGraphIdsUnclaimed: previewInfra.ids,
}))
vi.mock('@/lib/permission-groups/config-scope.server', () => ({
  resolvePermissionGroupConfig: async () => null,
}))
vi.mock('@/lib/workflows/deployment-status', () => ({ checkNeedsRedeployment: async () => false }))

// Real provider loops, SSE parsers, argument preparation, catalogue use cases and
// schemas. Only HTTP, database/authz lookups and unrelated tool effects are doubles.
vi.mock('@/providers', () => ({ MAX_TOOL_ITERATIONS: 1 }))
vi.mock('@/tools', () => toolsMock)
vi.mock('@/lib/workspaces/application/context', () => workspaceContextMock)
vi.mock('@/lib/workflows/application/context', () => workflowContextMock)
vi.mock('@/lib/workflows/queries', () => workflowsQueriesMock)
vi.mock('@sim/platform-authz/workspace', () => workspaceAuthzMock)
vi.mock('@sim/audit', () => auditMock)
vi.mock('@/lib/core/config/block-visibility', () => blockVisibilityMock)
vi.mock('@/lib/workflows/custom-blocks/operations', () => customBlockOperationsMock)
vi.mock('@/lib/integrations/availability.server', () => integrationsAvailabilityMock)
vi.mock('@/lib/integrations/principal-scope.server', () => ({
  allowedIntegrationTypes: async () => null,
  principalUserId: (principal: { userId?: string }) => principal.userId,
}))
vi.mock('@/blocks/custom/server-overlay', () => ({
  withCustomBlockOverlay: <T>(_rows: unknown, run: () => T) => run(),
}))
vi.mock('@/blocks/visibility/server-context', () => ({
  withBlockVisibility: <T>(_state: unknown, run: () => T) => run(),
}))

import { afterEach } from 'vitest'
import { OrchestrationError } from '@/lib/core/orchestration/types'
import { getBlock } from '@/blocks/registry'
import { anthropicProvider } from '@/providers/anthropic'
import { clearProviderClientCacheForTests } from '@/providers/client-cache'
import { openaiProvider } from '@/providers/openai'
import {
  beforeProviderModelCall,
  executeProviderTool,
  type ProviderModelAttempt,
  type ProviderModelObservation,
  runWithProviderRuntimeContext,
} from '@/providers/runtime-context'
import { runCatalogProvider } from './provider-binding'

function transportGate() {
  let release!: () => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<void>((resolve, fail) => {
    release = resolve
    reject = fail
  })
  return { promise, release, reject }
}

const principal = createSessionPrincipal({ userId: 'catalog-reader' })
const scope = { principal, workspaceId: 'workspace-1' }
const modelRequest = {
  model: 'gpt-4.1',
  apiKey: 'FICTIVE_MEMLIA_TEST_ONLY',
  messages: [{ role: 'user' as const, content: 'Find the Loop block' }],
}

describe('awaited server transport gate — native loops, HTTP double only', () => {
  it.each([null, false, {}])(
    'refuses a non-callable server gate before any transport: %j',
    (value) => {
      const http = vi.fn()
      vi.stubGlobal('fetch', http)
      expect(() =>
        runCatalogProvider({
          ...scope,
          provider: 'openai',
          request: modelRequest,
          beforeModelTransport: value as never,
        })
      ).toThrow('Invalid server model transport guard.')
      expect(http).not.toHaveBeenCalled()
    }
  )

  it('does not adopt a guard embedded in model request fields', async () => {
    const injected = vi.fn(async () => {
      throw new Error('MODEL_GUARD_NOT_AUTHORITY')
    })
    const http = vi.fn(async () => answer())
    vi.stubGlobal('fetch', http)
    const run = runCatalogProvider({
      ...scope,
      provider: 'openai',
      request: {
        ...modelRequest,
        beforeModelTransport: injected,
      } as never,
    })
    await collect(run.stream)
    expect(injected).not.toHaveBeenCalled()
    expect(http).toHaveBeenCalledOnce()
    expect(JSON.stringify(JSON.parse(http.mock.calls[0][1].body))).not.toContain(
      'beforeModelTransport'
    )
  })

  it.each(['openai', 'anthropic'] as const)(
    'captures the server guard before the first %s wait',
    async (provider) => {
      const gate = transportGate()
      let calls = 0
      const original = vi.fn(async () => {
        if (++calls === 1) await gate.promise
      })
      const replacement = vi.fn(async () => {
        throw new Error('PRIVATE_REPLACEMENT')
      })
      const http = vi
        .fn()
        .mockResolvedValueOnce(
          provider === 'openai' ? sse(response([toolCall()])) : anthropicSse(true)
        )
        .mockResolvedValueOnce(provider === 'openai' ? answer() : anthropicSse())
      vi.stubGlobal('fetch', http)
      const options = {
        ...scope,
        provider,
        request: {
          ...modelRequest,
          model: provider === 'openai' ? 'gpt-4.1' : 'claude-sonnet-4-5',
        },
        beforeModelTransport: original,
      }
      const run = runCatalogProvider(options)
      const drain = collect(run.stream)
      void drain.catch(() => {})
      try {
        await vi.waitFor(() => expect(calls + http.mock.calls.length).toBeGreaterThan(0))
        expect(http).not.toHaveBeenCalled()
        options.beforeModelTransport = replacement
      } finally {
        gate.release()
        await drain.catch(() => {})
      }
      expect(http).toHaveBeenCalledTimes(2)
      expect(original).toHaveBeenCalledTimes(2)
      expect(replacement).not.toHaveBeenCalled()
    }
  )

  it.each(['openai', 'anthropic'] as const)(
    'waits before the first physical %s request',
    async (provider) => {
      const gate = transportGate()
      const beforeModelTransport = vi.fn(() => gate.promise)
      const http = vi.fn(async () => (provider === 'openai' ? answer() : anthropicSse()))
      vi.stubGlobal('fetch', http)
      const run = runCatalogProvider({
        ...scope,
        provider,
        request: {
          ...modelRequest,
          model: provider === 'openai' ? 'gpt-4.1' : 'claude-sonnet-4-5',
        },
        beforeModelTransport,
      })
      const drain = collect(run.stream)
      void drain.catch(() => {})
      try {
        // Baseline can reach HTTP because it ignores the new server option: that
        // observable send, not a missing export/type, is the intended RED witness.
        await vi.waitFor(() =>
          expect(beforeModelTransport.mock.calls.length + http.mock.calls.length).toBeGreaterThan(0)
        )
        expect(http).not.toHaveBeenCalled()
        expect(beforeModelTransport).toHaveBeenCalledOnce()
        expect(run.usage()).toEqual({ modelCalls: 1, toolCalls: 0 })
      } finally {
        gate.release()
        await drain.catch(() => {})
      }
      expect(http).toHaveBeenCalledOnce()
    }
  )

  it.each(['openai', 'anthropic'] as const)(
    'refuses a server gate without leaking its error or retrying %s',
    async (provider) => {
      const beforeModelTransport = vi.fn(async () => {
        throw Object.assign(new Error('PRIVATE_GUARD_CANARY'), { code: 'ECONNRESET' })
      })
      const http = vi.fn(async () => (provider === 'openai' ? answer() : anthropicSse()))
      vi.stubGlobal('fetch', http)
      const run = runCatalogProvider({
        ...scope,
        provider,
        request: {
          ...modelRequest,
          model: provider === 'openai' ? 'gpt-4.1' : 'claude-sonnet-4-5',
        },
        beforeModelTransport,
      })
      const result = await collect(run.stream).then(
        () => null,
        (error: unknown) => error
      )
      expect(result).toMatchObject({ message: 'Server model transport guard refused.' })
      expect(String(result)).not.toContain('PRIVATE_GUARD_CANARY')
      expect(result).not.toHaveProperty('cause')
      expect(http).not.toHaveBeenCalled()
      expect(beforeModelTransport).toHaveBeenCalledOnce()
      expect(run.usage()).toEqual({ modelCalls: 1, toolCalls: 0 })
    }
  )

  it.each(['openai', 'anthropic'] as const)(
    'aborts a pending gate without sending a late %s request',
    async (provider) => {
      const gate = transportGate()
      const beforeModelTransport = vi.fn(() => gate.promise)
      const abort = new AbortController()
      const http = vi.fn(async () => (provider === 'openai' ? answer() : anthropicSse()))
      vi.stubGlobal('fetch', http)
      const run = runCatalogProvider({
        ...scope,
        provider,
        signal: abort.signal,
        request: {
          ...modelRequest,
          model: provider === 'openai' ? 'gpt-4.1' : 'claude-sonnet-4-5',
        },
        beforeModelTransport,
      })
      const drain = collect(run.stream)
      void drain.catch(() => {})
      try {
        await vi.waitFor(() =>
          expect(beforeModelTransport.mock.calls.length + http.mock.calls.length).toBeGreaterThan(0)
        )
        expect(http).not.toHaveBeenCalled()
        abort.abort(new DOMException('Fixture cancelled', 'AbortError'))
        await expect(drain).rejects.toMatchObject({ name: 'AbortError' })
        expect(beforeModelTransport.mock.calls[0][0].aborted).toBe(true)
      } finally {
        abort.abort()
        gate.release()
        await drain.catch(() => {})
      }
      await Promise.resolve()
      expect(http).not.toHaveBeenCalled()
    }
  )

  it.each(['openai', 'anthropic'] as const)(
    'rechecks cancellation when the %s gate resolves',
    async (provider) => {
      const abort = new AbortController()
      const beforeModelTransport = vi.fn(async () => {
        abort.abort(new DOMException('Fixture cancelled', 'AbortError'))
      })
      const http = vi.fn(async () => (provider === 'openai' ? answer() : anthropicSse()))
      vi.stubGlobal('fetch', http)
      const run = runCatalogProvider({
        ...scope,
        provider,
        signal: abort.signal,
        request: {
          ...modelRequest,
          model: provider === 'openai' ? 'gpt-4.1' : 'claude-sonnet-4-5',
        },
        beforeModelTransport,
      })
      await expect(collect(run.stream)).rejects.toMatchObject({ name: 'AbortError' })
      expect(http).not.toHaveBeenCalled()
      expect(beforeModelTransport).toHaveBeenCalledOnce()
    }
  )

  it.each(['openai', 'anthropic'] as const)(
    'waits again before %s synthesis after a real catalogue tool',
    async (provider) => {
      const gate = transportGate()
      let calls = 0
      const beforeModelTransport = vi.fn(async () => {
        if (++calls === 2) await gate.promise
      })
      const http = vi
        .fn()
        .mockResolvedValueOnce(
          provider === 'openai' ? sse(response([toolCall()])) : anthropicSse(true)
        )
        .mockResolvedValueOnce(provider === 'openai' ? answer() : anthropicSse())
      vi.stubGlobal('fetch', http)
      const run = runCatalogProvider({
        ...scope,
        provider,
        request: {
          ...modelRequest,
          model: provider === 'openai' ? 'gpt-4.1' : 'claude-sonnet-4-5',
        },
        beforeModelTransport,
      })
      const drain = collect(run.stream)
      void drain.catch(() => {})
      try {
        await vi.waitFor(() => expect(calls >= 2 || http.mock.calls.length >= 2).toBe(true))
        expect(http).toHaveBeenCalledTimes(1)
        expect(run.usage()).toEqual({ modelCalls: 2, toolCalls: 1 })
      } finally {
        gate.release()
        await drain.catch(() => {})
      }
      expect(http).toHaveBeenCalledTimes(2)
      expect(beforeModelTransport).toHaveBeenCalledTimes(2)
      expect(toolsMockFns.mockExecuteTool).not.toHaveBeenCalled()
    }
  )

  it.each(['retry', 'summary-fallback'] as const)(
    'waits again before an OpenAI %s',
    async (path) => {
      const gate = transportGate()
      let calls = 0
      const beforeModelTransport = vi.fn(async () => {
        if (++calls === 2) await gate.promise
      })
      const first =
        path === 'retry'
          ? new Response('{}', { status: 503, headers: { 'retry-after-ms': '0' } })
          : new Response(
              JSON.stringify({ error: { message: 'reasoning.summary requires verification' } }),
              { status: 400 }
            )
      const http = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(answer())
      vi.stubGlobal('fetch', http)
      const run = runCatalogProvider({
        ...scope,
        provider: 'openai',
        request: {
          ...modelRequest,
          model: path === 'summary-fallback' ? 'gpt-5.5' : modelRequest.model,
        },
        beforeModelTransport,
      })
      const drain = collect(run.stream)
      void drain.catch(() => {})
      try {
        await vi.waitFor(() => expect(calls >= 2 || http.mock.calls.length >= 2).toBe(true))
        expect(http).toHaveBeenCalledTimes(1)
        expect(run.usage()).toEqual({ modelCalls: 2, toolCalls: 0 })
      } finally {
        gate.release()
        await drain.catch(() => {})
      }
      expect(http).toHaveBeenCalledTimes(2)
      expect(beforeModelTransport).toHaveBeenCalledTimes(2)
    }
  )

  it.each([
    { stream: true, maxTokens: 1024 },
    { stream: false, maxTokens: 1024 },
    { stream: false, maxTokens: 30000 },
  ])('awaits the native Anthropic entry $stream/$maxTokens before the SDK', async (shape) => {
    const gate = transportGate()
    const beforeModelTransport = vi.fn(() => gate.promise)
    const reserve = vi.fn()
    const http = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            type: 'error',
            error: { type: 'api_error', message: 'Fixture outage' },
          }),
          { status: 503 }
        )
    )
    vi.stubGlobal('fetch', http)
    const pending = runWithProviderRuntimeContext(
      {
        controlledRun: {
          signal: new AbortController().signal,
          beforeModelCall: reserve,
          beforeModelTransport,
          executeTool: async () => {
            throw new Error('No fixture tool allowed')
          },
        },
      },
      () =>
        anthropicProvider.executeRequest({ ...modelRequest, model: 'claude-sonnet-4-5', ...shape })
    )
    void pending.catch(() => {})
    try {
      await vi.waitFor(() =>
        expect(beforeModelTransport.mock.calls.length + http.mock.calls.length).toBeGreaterThan(0)
      )
      expect(http).not.toHaveBeenCalled()
      expect(reserve).toHaveBeenCalledOnce()
    } finally {
      gate.release()
      await pending.catch(() => {})
    }
    expect(http).toHaveBeenCalledOnce()
    expect(beforeModelTransport).toHaveBeenCalledOnce()
  })
})

function response(output: unknown[]) {
  return {
    id: 'resp_test',
    status: 'completed',
    output,
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  }
}
function sse(value: ReturnType<typeof response>) {
  const events = [
    ...(value.output.some((item) => (item as { type: string }).type === 'message')
      ? [{ type: 'response.output_text.delta', delta: 'Loop is available.' }]
      : []),
    { type: 'response.completed', response: value },
  ]
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'Content-Type': 'text/event-stream' },
  })
}
function toolCall(
  name = 'list_blocks',
  args: Record<string, unknown> = { search: 'Loop', limit: 1 }
) {
  return {
    type: 'function_call',
    id: 'fc_1',
    call_id: 'call_1',
    name,
    arguments: JSON.stringify(args),
  }
}
function answer() {
  return sse(
    response([
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Loop is available.' }],
      },
    ])
  )
}
function anthropicSse(tool = false, call?: { name: string; input: Record<string, unknown> }) {
  const events = [
    {
      type: 'message_start',
      message: {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: tool
        ? { type: 'tool_use', id: 'tool_1', name: call?.name ?? 'list_blocks', input: {} }
        : { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: tool
        ? {
            type: 'input_json_delta',
            partial_json: JSON.stringify(call?.input ?? { search: 'Loop', limit: 1 }),
          }
        : { type: 'text_delta', text: 'Loop is available.' },
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
    {
      headers: { 'Content-Type': 'text/event-stream' },
    }
  )
}
async function collect<T>(stream: ReadableStream<T>) {
  return Array.fromAsync(stream)
}

beforeEach(() => {
  workspaceContextMockFns.mockLoadActiveWorkspaceApplicationContext.mockResolvedValue({
    workspaceId: 'workspace-1',
    workspaceOrganizationId: null,
    allowPersonalApiKeys: true,
    billedAccountUserId: 'other-payer',
  })
  workspaceAuthzMockFns.mockResolveEffectiveWorkspacePermission.mockImplementation(
    async (userId, workspaceId) =>
      userId === 'catalog-reader' && workspaceId === 'workspace-1' ? 'read' : null
  )
  workspaceAuthzMockFns.mockResolveEffectiveWorkspacePermission.mockClear()
  workspaceContextMockFns.mockLoadActiveWorkspaceApplicationContext.mockClear()
  toolsMockFns.mockExecuteTool.mockClear()
  clearProviderClientCacheForTests()
})

describe('optional workflow reads — real provider parsers with HTTP and DB lookup doubles', () => {
  const load = workflowsQueriesMockFns.mockLoadWorkflowReadSnapshot
  const resolve = workflowContextMockFns.mockResolveActiveWorkflowApplicationContext
  async function turn(
    provider: 'openai' | 'anthropic',
    input: Record<string, unknown>,
    policy: 'summary_only' | 'sanitized_details' = 'summary_only',
    name = 'read_workflow'
  ) {
    clearProviderClientCacheForTests()
    const http = vi
      .fn()
      .mockResolvedValueOnce(
        provider === 'openai'
          ? sse(response([toolCall(name, input)]))
          : anthropicSse(true, { name, input })
      )
      .mockResolvedValueOnce(provider === 'openai' ? answer() : anthropicSse())
    vi.stubGlobal('fetch', http)
    const run = runCatalogProvider({
      ...scope,
      provider,
      request: { ...modelRequest, model: provider === 'openai' ? 'gpt-4.1' : 'claude-sonnet-4-5' },
      workflow: { workflowId: 'bound-workflow', policy },
    })
    const events = await collect(run.stream)
    const body = JSON.parse(http.mock.calls[1][1].body)
    const output =
      provider === 'openai'
        ? body.input.find((item: { type: string }) => item.type === 'function_call_output').output
        : body.messages
            .flatMap((message: { content: unknown[] }) => message.content)
            .find((item: { type: string }) => item.type === 'tool_result').content
    return { output: JSON.parse(output), body, run, events, http }
  }
  beforeEach(() => {
    resolve.mockReset().mockResolvedValue({
      workflowId: 'bound-workflow',
      workflow: { id: 'bound-workflow', workspaceId: 'workspace-1' },
      workspaceId: 'workspace-1',
      workspaceOrganizationId: null,
      allowPersonalApiKeys: true,
      billedAccountUserId: 'other-payer',
    })
    load.mockReset().mockResolvedValue({
      workflowRecord: {
        id: 'bound-workflow',
        draftRevision: 7,
        variables: {
          v1: {
            id: 'v1',
            name: 'Variable',
            type: 'string',
            value: 'FICTIVE_VARIABLE_NOT_TO_MODEL',
          },
        },
      },
      normalizedData: {
        blocks: {
          b1: {
            id: 'b1',
            type: 'fixture',
            name: 'Fixture',
            enabled: true,
            position: { x: 0, y: 0 },
            subBlocks: {
              password: {
                id: 'password',
                type: 'short-input',
                value: 'FICTIVE_PASSWORD_NOT_TO_MODEL',
              },
              oauth: { id: 'oauth', type: 'oauth-input', value: 'FICTIVE_OAUTH_NOT_TO_MODEL' },
              credentialId: {
                id: 'credentialId',
                type: 'short-input',
                value: 'FICTIVE_BINDING_NOT_TO_MODEL',
              },
              headers: {
                id: 'headers',
                type: 'table',
                value: [{ key: 'Authorization', value: 'FICTIVE_HEADER_NOT_TO_MODEL' }],
              },
              code: { id: 'code', type: 'code', value: 'return "FICTIVE_LITERAL_SECRET_REMAINS"' },
            },
            outputs: {},
          },
        },
        edges: [],
        loops: {},
        parallels: {},
      },
    })
    vi.mocked(getBlock).mockReturnValue({
      name: 'Fixture',
      description: '',
      outputs: {},
      subBlocks: [
        { id: 'password', type: 'short-input', password: true },
        { id: 'oauth', type: 'oauth-input' },
        { id: 'headers', type: 'table' },
        { id: 'code', type: 'code' },
      ],
    } as never)
  })

  it.each(['openai', 'anthropic'] as const)(
    'transmits a nonempty native summary schema and its result through %s',
    async (provider) => {
      const params = { request: { view: 'summary', section: 'blocks' } }
      const http = vi
        .fn()
        .mockResolvedValueOnce(
          provider === 'openai'
            ? sse(response([toolCall('read_workflow', params)]))
            : anthropicSse(true, { name: 'read_workflow', input: params })
        )
        .mockResolvedValueOnce(provider === 'openai' ? answer() : anthropicSse())
      vi.stubGlobal('fetch', http)
      const run = runCatalogProvider({
        ...scope,
        provider,
        request: {
          ...modelRequest,
          model: provider === 'openai' ? 'gpt-4.1' : 'claude-sonnet-4-5',
        },
        workflow: { workflowId: 'bound-workflow', policy: 'summary_only' },
      })
      await collect(run.stream)
      const first = JSON.parse(http.mock.calls[0][1].body)
      expect(first.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([
        'get_block',
        'get_tool',
        'list_blocks',
        'list_tools',
        'read_workflow',
      ])
      const wireTool = first.tools.find((tool: { name: string }) => tool.name === 'read_workflow')
      const schema = provider === 'openai' ? wireTool.parameters : wireTool.input_schema
      expect(schema).toMatchObject({
        required: ['request'],
        properties: {
          request: {
            properties: {
              view: { type: 'string', const: 'summary' },
              section: { enum: ['blocks', 'edges', 'variables', 'loops', 'parallels'] },
            },
          },
        },
      })
      const second = JSON.parse(http.mock.calls[1][1].body)
      const output =
        provider === 'openai'
          ? second.input.find((item: { type: string }) => item.type === 'function_call_output')
              .output
          : second.messages
              .flatMap((message: { content: unknown[] }) => message.content)
              .find((item: { type: string }) => item.type === 'tool_result').content
      expect(JSON.parse(output)).toMatchObject({
        draftRevision: 7,
        section: 'blocks',
        entries: { b1: { id: 'b1', type: 'fixture' } },
      })
      expect(JSON.stringify(second)).not.toContain('FICTIVE_VARIABLE_NOT_TO_MODEL')
      expect(load).toHaveBeenCalledWith('bound-workflow', 'workspace-1')
      expect(run.usage()).toEqual({ modelCalls: 2, toolCalls: 1 })
      expect(toolsMockFns.mockExecuteTool).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['openai', 'read_workflow'],
    ['openai', 'read_workflow_block'],
    ['anthropic', 'read_workflow'],
    ['anthropic', 'read_workflow_block'],
  ] as const)('retains native schemas and sanitized %s/%s results', async (provider, name) => {
    load.mockClear()
    const input =
      name === 'read_workflow'
        ? { view: 'full', expectedRevision: 7 }
        : { blockId: 'b1', expectedRevision: 7 }
    const params = { request: input }
    const http = vi
      .fn()
      .mockResolvedValueOnce(
        provider === 'openai'
          ? sse(response([toolCall(name, params)]))
          : anthropicSse(true, { name, input: params })
      )
      .mockResolvedValueOnce(provider === 'openai' ? answer() : anthropicSse())
    vi.stubGlobal('fetch', http)
    const run = runCatalogProvider({
      ...scope,
      provider,
      request: { ...modelRequest, model: provider === 'openai' ? 'gpt-4.1' : 'claude-sonnet-4-5' },
      workflow: { workflowId: 'bound-workflow', policy: 'sanitized_details' },
    })
    await collect(run.stream)
    const first = JSON.parse(http.mock.calls[0][1].body)
    expect(first.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([
      'get_block',
      'get_tool',
      'list_blocks',
      'list_tools',
      'read_workflow',
      'read_workflow_block',
    ])
    const findSchema = (id: string) => {
      const tool = first.tools.find((tool: { name: string }) => tool.name === id)
      return provider === 'openai' ? tool.parameters : tool.input_schema
    }
    expect(findSchema('read_workflow').properties.request.oneOf).toMatchObject([
      {
        properties: { view: { const: 'full' }, expectedRevision: { type: 'integer', minimum: 0 } },
      },
      {
        properties: {
          view: { const: 'summary' },
          offset: { type: 'integer', minimum: 0 },
          limit: { maximum: 100 },
        },
      },
    ])
    expect(findSchema('read_workflow_block')).toMatchObject({
      required: ['request'],
      properties: {
        request: {
          required: ['blockId'],
          properties: { blockId: { type: 'string', maxLength: 512 } },
        },
      },
    })
    expect(JSON.stringify(first)).not.toContain('bound-workflow')
    const second = JSON.parse(http.mock.calls[1][1].body)
    const output =
      provider === 'openai'
        ? second.input.find((item: { type: string }) => item.type === 'function_call_output').output
        : second.messages
            .flatMap((message: { content: unknown[] }) => message.content)
            .find((item: { type: string }) => item.type === 'tool_result').content
    const result = JSON.parse(output)
    expect(result).toMatchObject({ draftRevision: 7 })
    const node = name === 'read_workflow' ? result.blocks.b1 : result.block
    expect(node.subBlocks).toMatchObject({
      password: { value: null },
      oauth: { value: null },
      credentialId: { value: null },
      headers: { value: null },
      code: { value: 'return "FICTIVE_LITERAL_SECRET_REMAINS"' },
    })
    expect(JSON.stringify(second)).not.toContain('NOT_TO_MODEL')
    expect(load).toHaveBeenCalledTimes(1)
    expect(run.usage()).toEqual({ modelCalls: 2, toolCalls: 1 })
    expect(toolsMockFns.mockExecuteTool).not.toHaveBeenCalled()
  })

  it.each(['openai', 'anthropic'] as const)(
    'refuses detailed views under summary_only before native reads with %s',
    async (provider) => {
      const result = await turn(provider, { request: { view: 'full' } })
      expect(result.output).toEqual({
        ok: false,
        error: { code: 'forbidden', message: 'Workflow read could not complete.' },
      })
      expect(result.events).toContainEqual(
        expect.objectContaining({ type: 'tool_call_end', status: 'error' })
      )
      expect(resolve).not.toHaveBeenCalled()
      expect(load).not.toHaveBeenCalled()
      expect(toolsMockFns.mockExecuteTool).not.toHaveBeenCalled()
    }
  )

  it.each([
    { request: { view: 'summary', section: 'blocks' }, workflowId: 'foreign' },
    { request: { view: 'summary', section: 'blocks' }, policy: 'sanitized_details' },
    { request: { view: 'summary', section: 'blocks' }, _context: { userId: 'owner' } },
    { request: { view: 'full', workflowId: 'foreign' } },
    { request: { view: 'summary', section: 'blocks', principal: { userId: 'owner' } } },
    { request: { view: 'summary', section: 'blocks', policy: 'sanitized_details' } },
    { view: 'summary', section: 'blocks' },
    { request: { view: 'summary', section: 'blocks', offset: 1 } },
  ])(
    'rejects model-owned identity/policy/extra wrapper fields or invalid pages: %j',
    async (input) => {
      const result = await turn('openai', input)
      expect(result.output).toEqual({
        ok: false,
        error: { code: 'invalid_input', message: 'Workflow read could not complete.' },
      })
      expect(resolve).not.toHaveBeenCalled()
      expect(load).not.toHaveBeenCalled()
    }
  )

  it('preserves exact native revisions on pages and returns a fixed conflict on changed revision', async () => {
    const page = await turn('openai', {
      request: { view: 'summary', section: 'blocks', offset: 1, expectedRevision: 7 },
    })
    expect(page.output).toMatchObject({
      draftRevision: 7,
      entries: {},
      page: { total: 1, nextOffset: null },
    })
    const conflict = await turn('openai', {
      request: { view: 'summary', section: 'blocks', offset: 1, expectedRevision: 0 },
    })
    expect(conflict.output).toMatchObject({
      error: { code: 'revision_conflict', message: 'Workflow read could not complete.' },
    })
  })

  it.each(['openai', 'anthropic'] as const)(
    'reauthorizes the workflow and withholds private failures with %s',
    async (provider) => {
      workspaceAuthzMockFns.mockResolveEffectiveWorkspacePermission.mockResolvedValue(null)
      const denied = await turn(provider, { request: { view: 'summary', section: 'blocks' } })
      expect(denied.output).toMatchObject({ error: { code: 'forbidden' } })
      expect(load).not.toHaveBeenCalled()
      expect(
        workspaceAuthzMockFns.mockResolveEffectiveWorkspacePermission.mock.calls.at(-1)?.slice(0, 2)
      ).toEqual(['catalog-reader', 'workspace-1'])
      resolve.mockRejectedValue(
        new OrchestrationError('not_found', 'FICTIVE_PRIVATE_WORKFLOW_NOT_TO_MODEL')
      )
      const missing = await turn(provider, { request: { view: 'summary', section: 'blocks' } })
      expect(missing.output).toMatchObject({
        error: { code: 'not_found', message: 'Workflow read could not complete.' },
      })
      expect(JSON.stringify(missing.body)).not.toContain('NOT_TO_MODEL')
    }
  )

  it.each([
    {},
    { workflowId: 'bound-workflow' },
    { policy: 'summary_only' },
    { workflowId: '', policy: 'summary_only' },
    { workflowId: 'bound-workflow', policy: 'all' },
    { workflowId: 'bound-workflow', policy: 'summary_only', workspaceId: 'foreign' },
    null,
  ])('requires explicit valid server workflow/policy before any model request: %j', (workflow) => {
    const http = vi.fn()
    vi.stubGlobal('fetch', http)
    expect(() =>
      runCatalogProvider({ ...scope, provider: 'openai', request: modelRequest, workflow } as never)
    ).toThrow('Invalid workflow read binding.')
    expect(http).not.toHaveBeenCalled()
    expect(resolve).not.toHaveBeenCalled()
  })

  it.each(['openai', 'anthropic'] as const)(
    'does not expose or execute a block tool under summary_only with %s',
    async (provider) => {
      const result = await turn(
        provider,
        { request: { blockId: 'b1' } },
        'summary_only',
        'read_workflow_block'
      )
      expect(result.events).toContainEqual(
        expect.objectContaining({ type: 'tool_call_end', status: 'error' })
      )
      expect(result.run.usage().toolCalls).toBe(0)
      expect(resolve).not.toHaveBeenCalled()
      expect(load).not.toHaveBeenCalled()
      expect(toolsMockFns.mockExecuteTool).not.toHaveBeenCalled()
    }
  )

  it.each(['openai', 'anthropic'] as const)(
    'preserves native catalogue refusals even with a linked workflow through %s',
    async (provider) => {
      const result = await turn(provider, { workspaceId: 'foreign' }, 'summary_only', 'list_blocks')
      expect(result.output).toEqual({
        error: true,
        message: 'Catalog read could not complete.',
        tool: 'list_blocks',
      })
      expect(result.events).toContainEqual(
        expect.objectContaining({ type: 'tool_call_end', status: 'error' })
      )
      expect(resolve).not.toHaveBeenCalled()
      expect(load).not.toHaveBeenCalled()
    }
  )

  it('copies the explicit server policy before a caller can mutate its object during the run', async () => {
    const workflow: { workflowId: string; policy: 'summary_only' | 'sanitized_details' } = {
      workflowId: 'bound-workflow',
      policy: 'summary_only',
    }
    const http = vi
      .fn()
      .mockResolvedValueOnce(
        sse(response([toolCall('read_workflow', { request: { view: 'full' } })]))
      )
      .mockResolvedValueOnce(answer())
    vi.stubGlobal('fetch', http)
    const run = runCatalogProvider({
      ...scope,
      provider: 'openai',
      request: modelRequest,
      workflow,
    })
    workflow.policy = 'sanitized_details'
    workflow.workflowId = 'foreign-workflow'
    await collect(run.stream)
    const second = JSON.parse(http.mock.calls[1][1].body)
    expect(
      JSON.parse(
        second.input.find((item: { type: string }) => item.type === 'function_call_output').output
      )
    ).toEqual({
      ok: false,
      error: { code: 'forbidden', message: 'Workflow read could not complete.' },
    })
    expect(resolve).not.toHaveBeenCalled()
  })

  it('reauthorizes concurrent workflow reads independently rather than caching an initial grant', async () => {
    workspaceAuthzMockFns.mockResolveEffectiveWorkspacePermission
      .mockResolvedValueOnce('read')
      .mockResolvedValueOnce(null)
    const input = { request: { view: 'summary', section: 'blocks' } }
    const http = vi
      .fn()
      .mockResolvedValueOnce(
        sse(
          response([
            toolCall('read_workflow', input),
            { ...toolCall('read_workflow', input), id: 'fc_2', call_id: 'call_2' },
          ])
        )
      )
      .mockResolvedValueOnce(answer())
    vi.stubGlobal('fetch', http)
    const run = runCatalogProvider({
      ...scope,
      provider: 'openai',
      request: modelRequest,
      workflow: { workflowId: 'bound-workflow', policy: 'summary_only' },
    })
    const events = await collect(run.stream)
    const second = JSON.parse(http.mock.calls[1][1].body)
    const outputs = second.input
      .filter((item: { type: string }) => item.type === 'function_call_output')
      .map((item: { output: string }) => JSON.parse(item.output))
    expect(outputs).toMatchObject([
      { draftRevision: 7 },
      { ok: false, error: { code: 'forbidden' } },
    ])
    expect(load).toHaveBeenCalledTimes(1)
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'tool_call_end', status: 'error' })
    )
    expect(run.usage()).toEqual({ modelCalls: 2, toolCalls: 2 })
  })

  it.each(['openai', 'anthropic'] as const)(
    'preserves model and tool budgets around linked reads with %s',
    async (provider) => {
      for (const boundary of ['model', 'tool']) {
        clearProviderClientCacheForTests()
        load.mockClear()
        resolve.mockClear()
        const input = { request: { view: 'summary', section: 'blocks' } }
        const http = vi
          .fn()
          .mockResolvedValueOnce(
            provider === 'openai'
              ? sse(response([toolCall('read_workflow', input)]))
              : anthropicSse(true, { name: 'read_workflow', input })
          )
        vi.stubGlobal('fetch', http)
        const run = runCatalogProvider({
          ...scope,
          provider,
          request: {
            ...modelRequest,
            model: provider === 'openai' ? 'gpt-4.1' : 'claude-sonnet-4-5',
          },
          workflow: { workflowId: 'bound-workflow', policy: 'summary_only' },
          limits: boundary === 'model' ? { maxModelCalls: 1 } : { maxToolCalls: 0 },
        })
        await expect(collect(run.stream)).rejects.toMatchObject({
          code: boundary === 'model' ? 'model_calls' : 'tool_calls',
        })
        expect(http).toHaveBeenCalledTimes(1)
        expect(run.usage()).toEqual({ modelCalls: 1, toolCalls: boundary === 'model' ? 1 : 0 })
        if (boundary === 'tool') expect(resolve).not.toHaveBeenCalled()
      }
    }
  )

  it.each(['openai', 'anthropic'] as const)(
    'propagates cancellation during a pending workflow read without synthesis with %s',
    async (provider) => {
      const snapshot = await load()
      let finish!: (value: unknown) => void
      load.mockReset().mockImplementation(
        () =>
          new Promise((done) => {
            finish = done
          })
      )
      const input = { request: { view: 'summary', section: 'blocks' } }
      const http = vi
        .fn()
        .mockResolvedValueOnce(
          provider === 'openai'
            ? sse(response([toolCall('read_workflow', input)]))
            : anthropicSse(true, { name: 'read_workflow', input })
        )
      vi.stubGlobal('fetch', http)
      const abort = new AbortController()
      const run = runCatalogProvider({
        ...scope,
        provider,
        signal: abort.signal,
        request: {
          ...modelRequest,
          model: provider === 'openai' ? 'gpt-4.1' : 'claude-sonnet-4-5',
        },
        workflow: { workflowId: 'bound-workflow', policy: 'summary_only' },
      })
      const pending = collect(run.stream)
      try {
        await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1))
        abort.abort(new DOMException('Fictitious cancellation', 'AbortError'))
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
        expect(http).toHaveBeenCalledTimes(1)
        expect(run.usage()).toEqual({ modelCalls: 1, toolCalls: 1 })
      } finally {
        finish?.(snapshot)
      }
    }
  )

  it('returns fixed unavailable and too-large refusals without forwarding raw contents', async () => {
    const snapshot = await load()
    load.mockResolvedValueOnce({
      ...snapshot,
      workflowRecord: { ...snapshot.workflowRecord, draftRevision: -1 },
    })
    const malformed = await turn('openai', { request: { view: 'full' } }, 'sanitized_details')
    expect(malformed.output).toEqual({
      ok: false,
      error: { code: 'unavailable', message: 'Workflow read could not complete.' },
    })
    snapshot.normalizedData.blocks.b1.name = 'é'.repeat(140 * 1024)
    const large = await turn('openai', { request: { view: 'summary', section: 'blocks' } })
    expect(large.output).toEqual({
      ok: false,
      error: { code: 'result_too_large', message: 'Workflow read could not complete.' },
    })
    expect(JSON.stringify(large.body)).not.toContain('é'.repeat(100))
  })

  it.each(['openai', 'anthropic'] as const)(
    'keeps exactly four tools with no workflow binding through %s',
    async (provider) => {
      const http = vi.fn().mockResolvedValueOnce(provider === 'openai' ? answer() : anthropicSse())
      vi.stubGlobal('fetch', http)
      const run = runCatalogProvider({
        ...scope,
        provider,
        request: {
          ...modelRequest,
          model: provider === 'openai' ? 'gpt-4.1' : 'claude-sonnet-4-5',
        },
      })
      await collect(run.stream)
      const first = JSON.parse(http.mock.calls[0][1].body)
      expect(first.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([
        'get_block',
        'get_tool',
        'list_blocks',
        'list_tools',
      ])
      expect(resolve).not.toHaveBeenCalled()
      expect(load).not.toHaveBeenCalled()
    }
  )
})

afterEach(() => vi.unstubAllGlobals())

describe('catalogue provider binding — real loops, local HTTP doubles', () => {
  it('reads the authorized native catalogue then streams final synthesis', async () => {
    const http = vi
      .fn()
      .mockResolvedValueOnce(sse(response([toolCall()])))
      .mockResolvedValueOnce(answer())
    vi.stubGlobal('fetch', http)
    const run = runCatalogProvider({ ...scope, provider: 'openai', request: modelRequest })
    const events = await collect(run.stream)
    expect(run.usage()).toEqual({ modelCalls: 2, toolCalls: 1 })
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'text_delta', text: 'Loop is available.' })
    )
    const second = JSON.parse(http.mock.calls[1][1].body)
    const result = JSON.parse(
      second.input.find((item: { type: string }) => item.type === 'function_call_output').output
    )
    expect(result).toMatchObject({ entries: [{ id: 'loop' }] })
    expect(second.tool_choice).toBe('none')
    expect(toolsMockFns.mockExecuteTool).not.toHaveBeenCalled()
    expect(
      workspaceAuthzMockFns.mockResolveEffectiveWorkspacePermission.mock.calls.at(-1)?.slice(0, 2)
    ).toEqual(['catalog-reader', 'workspace-1'])
  })
  it('uses the actual Anthropic SDK stream and native catalogue loop for tool then synthesis', async () => {
    const http = vi
      .fn()
      .mockResolvedValueOnce(anthropicSse(true))
      .mockResolvedValueOnce(anthropicSse())
    vi.stubGlobal('fetch', http)
    const run = runCatalogProvider({
      ...scope,
      provider: 'anthropic',
      request: { ...modelRequest, model: 'claude-sonnet-4-5' },
    })
    const events = await collect(run.stream)
    expect(run.usage()).toEqual({ modelCalls: 2, toolCalls: 1 })
    expect(http).toHaveBeenCalledTimes(2)
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'text_delta', text: 'Loop is available.' })
    )
    const second = JSON.parse(http.mock.calls[1][1].body)
    const content = second.messages
      .flatMap((item: { content: unknown[] }) => item.content)
      .find((item: { type: string }) => item.type === 'tool_result')
    expect(JSON.parse(content.content)).toMatchObject({ entries: [{ id: 'loop' }] })
    expect(second.tool_choice).toEqual({ type: 'none' })
    expect(toolsMockFns.mockExecuteTool).not.toHaveBeenCalled()
  })

  it.each(['openai', 'anthropic'] as const)(
    'counts synthesis before a second physical %s call',
    async (provider) => {
      const http = vi
        .fn()
        .mockResolvedValueOnce(
          provider === 'openai' ? sse(response([toolCall()])) : anthropicSse(true)
        )
      vi.stubGlobal('fetch', http)
      const run = runCatalogProvider({
        ...scope,
        provider,
        request: {
          ...modelRequest,
          model: provider === 'openai' ? 'gpt-4.1' : 'claude-sonnet-4-5',
        },
        limits: { maxModelCalls: 1 },
      })
      await expect(collect(run.stream)).rejects.toMatchObject({ code: 'model_calls' })
      expect(http).toHaveBeenCalledTimes(1)
      expect(run.usage()).toEqual({ modelCalls: 1, toolCalls: 1 })
    }
  )

  it('counts each raw OpenAI retry before sending it and refuses an over-budget retry', async () => {
    const http = vi
      .fn()
      .mockResolvedValue(new Response('{}', { status: 503, headers: { 'retry-after-ms': '0' } }))
    vi.stubGlobal('fetch', http)
    const run = runCatalogProvider({
      ...scope,
      provider: 'openai',
      request: modelRequest,
      limits: { maxModelCalls: 1 },
    })
    await expect(collect(run.stream)).rejects.toMatchObject({ code: 'model_calls' })
    expect(http).toHaveBeenCalledTimes(1)
    expect(run.usage()).toEqual({ modelCalls: 1, toolCalls: 0 })
  })

  it('counts a permitted OpenAI retry as a second physical call', async () => {
    const http = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('{}', { status: 503, headers: { 'retry-after-ms': '0' } })
      )
      .mockResolvedValueOnce(answer())
    vi.stubGlobal('fetch', http)
    const run = runCatalogProvider({
      ...scope,
      provider: 'openai',
      request: modelRequest,
      limits: { maxModelCalls: 2 },
    })
    await collect(run.stream)
    expect(http).toHaveBeenCalledTimes(2)
    expect(run.usage()).toEqual({ modelCalls: 2, toolCalls: 0 })
  })

  it.each([1, 2])(
    'counts the OpenAI summary-verification fallback within budget%d',
    async (maxModelCalls) => {
      const http = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ error: { message: 'reasoning.summary requires verification' } }),
            { status: 400 }
          )
        )
        .mockResolvedValueOnce(answer())
      vi.stubGlobal('fetch', http)
      const run = runCatalogProvider({
        ...scope,
        provider: 'openai',
        request: { ...modelRequest, model: 'gpt-5.5' },
        limits: { maxModelCalls },
      })
      if (maxModelCalls === 1)
        await expect(collect(run.stream)).rejects.toMatchObject({ code: 'model_calls' })
      else await collect(run.stream)
      expect(http).toHaveBeenCalledTimes(maxModelCalls)
      expect(run.usage().modelCalls).toBe(maxModelCalls)
      if (maxModelCalls === 2)
        expect(JSON.parse(http.mock.calls[1][1].body).reasoning?.summary).toBeUndefined()
    }
  )

  it('disables hidden Anthropic SDK retries only in the controlled run', async () => {
    const http = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            type: 'error',
            error: { type: 'api_error', message: 'Fictitious outage' },
          }),
          { status: 503, headers: { 'retry-after-ms': '0' } }
        )
      )
    )
    vi.stubGlobal('fetch', http)
    const run = runCatalogProvider({
      ...scope,
      provider: 'anthropic',
      request: { ...modelRequest, model: 'claude-sonnet-4-5' },
    })
    await expect(collect(run.stream)).rejects.toBeDefined()
    expect(http).toHaveBeenCalledTimes(1)
    expect(run.usage()).toEqual({ modelCalls: 1, toolCalls: 0 })
  })

  it('preserves the native Anthropic SDK retry policy outside a controlled run', async () => {
    const http = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            type: 'error',
            error: { type: 'api_error', message: 'Fictitious outage' },
          }),
          { status: 503, headers: { 'retry-after-ms': '0' } }
        )
      )
      .mockResolvedValueOnce(anthropicSse())
    vi.stubGlobal('fetch', http)
    const execution = await anthropicProvider.executeRequest({
      ...modelRequest,
      model: 'claude-sonnet-4-5',
      stream: true,
    })
    expect('stream' in execution).toBe(true)
    await collect((execution as { stream: ReadableStream<unknown> }).stream)
    expect(http).toHaveBeenCalledTimes(2)
    expect(beforeProviderModelCall()).toBeUndefined()
  })

  it('preserves the native OpenAI retry policy outside a controlled run', async () => {
    const http = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('{}', { status: 503, headers: { 'retry-after-ms': '0' } })
      )
      .mockResolvedValueOnce(answer())
    vi.stubGlobal('fetch', http)
    const execution = await openaiProvider.executeRequest({ ...modelRequest, stream: true })
    await collect((execution as { stream: ReadableStream<unknown> }).stream)
    expect(http).toHaveBeenCalledTimes(2)
  })

  it('never falls back to a registry tool for unknown model-emitted names', async () => {
    const http = vi
      .fn()
      .mockResolvedValueOnce(sse(response([toolCall('http_request')])))
      .mockResolvedValueOnce(answer())
    vi.stubGlobal('fetch', http)
    const run = runCatalogProvider({ ...scope, provider: 'openai', request: modelRequest })
    const events = await collect(run.stream)
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'tool_call_end', status: 'error' })
    )
    expect(toolsMockFns.mockExecuteTool).not.toHaveBeenCalled()
    expect(run.usage()).toEqual({ modelCalls: 2, toolCalls: 0 })
  })

  it('blocks concurrent catalogue reads before exceeding the tool budget', async () => {
    const http = vi
      .fn()
      .mockResolvedValueOnce(
        sse(response([toolCall(), { ...toolCall(), id: 'fc_2', call_id: 'call_2' }]))
      )
    vi.stubGlobal('fetch', http)
    const run = runCatalogProvider({
      ...scope,
      provider: 'openai',
      request: modelRequest,
      limits: { maxToolCalls: 1 },
    })
    await expect(collect(run.stream)).rejects.toMatchObject({ code: 'tool_calls' })
    expect(run.usage()).toEqual({ modelCalls: 1, toolCalls: 1 })
    expect(workspaceContextMockFns.mockLoadActiveWorkspaceApplicationContext).toHaveBeenCalledTimes(
      1
    )
    expect(toolsMockFns.mockExecuteTool).not.toHaveBeenCalled()
  })

  it('does not let a model choose a different workspace or inherit a workflow replay', async () => {
    const replay = vi.fn()
    const http = vi
      .fn()
      .mockResolvedValueOnce(
        sse(response([toolCall('list_blocks', { workspaceId: 'other' } as never)]))
      )
      .mockResolvedValueOnce(answer())
    vi.stubGlobal('fetch', http)
    const run = runWithProviderRuntimeContext(
      { agentConversation: { getReplayResult: replay } as never },
      () => runCatalogProvider({ ...scope, provider: 'openai', request: modelRequest })
    )
    await collect(run.stream)
    expect(replay).not.toHaveBeenCalled()
    expect(workspaceAuthzMockFns.mockResolveEffectiveWorkspacePermission).not.toHaveBeenCalled()
    expect(toolsMockFns.mockExecuteTool).not.toHaveBeenCalled()
    expect(JSON.stringify(JSON.parse(http.mock.calls[1][1].body).input)).toContain(
      'Catalog read could not complete.'
    )
  })

  it.each([
    { stream: true, maxTokens: 1024 },
    { stream: false, maxTokens: 1024 },
    { stream: false, maxTokens: 30000 },
  ])('bounds every Anthropic SDK entry path $stream/$maxTokens per request', async (shape) => {
    const http = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            type: 'error',
            error: { type: 'api_error', message: 'Fictitious outage' },
          }),
          { status: 503, headers: { 'retry-after-ms': '0' } }
        )
      )
    )
    vi.stubGlobal('fetch', http)
    const reserve = vi.fn()
    await expect(
      runWithProviderRuntimeContext(
        {
          controlledRun: {
            signal: new AbortController().signal,
            beforeModelCall: reserve,
            executeTool: async () => {
              throw new Error('No tool permitted')
            },
          },
        },
        () =>
          anthropicProvider.executeRequest({
            ...modelRequest,
            model: 'claude-sonnet-4-5',
            ...shape,
          })
      )
    ).rejects.toBeDefined()
    expect(http).toHaveBeenCalledTimes(1)
    expect(reserve).toHaveBeenCalledTimes(1)
    // Same cached SDK client still uses its original retry policy outside ALS.
    http
      .mockClear()
      .mockResolvedValueOnce(
        new Response('{}', { status: 503, headers: { 'retry-after-ms': '0' } })
      )
      .mockResolvedValueOnce(anthropicSse())
    const outside = await anthropicProvider.executeRequest({
      ...modelRequest,
      model: 'claude-sonnet-4-5',
      stream: true,
    })
    await collect((outside as { stream: ReadableStream<unknown> }).stream)
    expect(http).toHaveBeenCalledTimes(2)
    expect(reserve).toHaveBeenCalledTimes(1)
  })

  it('dispatches through the server control before native replay, aliases or tool registry', async () => {
    const replay = vi.fn()
    const dispatch = vi.fn().mockRejectedValue(new Error('Server refused unknown tool'))
    const abort = new AbortController()
    await expect(
      runWithProviderRuntimeContext(
        {
          agentConversation: { getReplayResult: replay } as never,
          toolIdByWireId: new Map([['unknown', 'http_request']]),
          controlledRun: { signal: abort.signal, beforeModelCall() {}, executeTool: dispatch },
        },
        () => executeProviderTool('unknown', { _context: { invocationId: 'fictitious' } })
      )
    ).rejects.toThrow('Server refused')
    expect(dispatch).toHaveBeenCalledWith('unknown', { _context: { invocationId: 'fictitious' } })
    expect(replay).not.toHaveBeenCalled()
    expect(toolsMockFns.mockExecuteTool).not.toHaveBeenCalled()
  })

  it('cancels during OpenAI backoff without issuing another physical request', async () => {
    const abort = new AbortController()
    const http = vi
      .fn()
      .mockResolvedValue(new Response('{}', { status: 503, headers: { 'retry-after-ms': '2000' } }))
    vi.stubGlobal('fetch', http)
    const run = runCatalogProvider({
      ...scope,
      provider: 'openai',
      request: modelRequest,
      signal: abort.signal,
    })
    const drain = collect(run.stream)
    await vi.waitFor(() => expect(http).toHaveBeenCalledTimes(1))
    abort.abort(new DOMException('Fictitious cancellation', 'AbortError'))
    await expect(drain).rejects.toMatchObject({ name: 'AbortError' })
    expect(http).toHaveBeenCalledTimes(1)
    expect(run.usage()).toEqual({ modelCalls: 1, toolCalls: 0 })
    expect(http.mock.calls[0][1].signal.aborted).toBe(true)
  })

  it('expires during backoff even when no consumer reads the stream', async () => {
    const http = vi
      .fn()
      .mockResolvedValue(new Response('{}', { status: 503, headers: { 'retry-after-ms': '2000' } }))
    vi.stubGlobal('fetch', http)
    const run = runCatalogProvider({
      ...scope,
      provider: 'openai',
      request: modelRequest,
      limits: { maxDurationMs: 30 },
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    await expect(collect(run.stream)).rejects.toMatchObject({ code: 'duration' })
    expect(http).toHaveBeenCalledTimes(1)
    expect(run.usage()).toEqual({ modelCalls: 1, toolCalls: 0 })
  })

  it.each(['openai', 'anthropic'] as const)(
    'propagates cancellation to a pending %s transport',
    async (provider) => {
      const abort = new AbortController()
      let transportSignal: AbortSignal | undefined
      const http = vi.fn(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            transportSignal = init.signal
            init.signal.addEventListener(
              'abort',
              () => reject(new DOMException('HTTP double cancelled', 'AbortError')),
              { once: true }
            )
          })
      )
      vi.stubGlobal('fetch', http)
      const run = runCatalogProvider({
        ...scope,
        provider,
        request: {
          ...modelRequest,
          model: provider === 'openai' ? 'gpt-4.1' : 'claude-sonnet-4-5',
        },
        signal: abort.signal,
      })
      const drain = collect(run.stream)
      await vi.waitFor(() => expect(http).toHaveBeenCalledTimes(1))
      abort.abort(new DOMException('Fictitious cancellation', 'AbortError'))
      await expect(drain).rejects.toMatchObject({ name: 'AbortError' })
      expect(transportSignal?.aborted).toBe(true)
      expect(run.usage().modelCalls).toBe(1)
    }
  )

  it('has separate controls and catalogue authority for concurrent provider streams', async () => {
    const http = vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return sse(response([toolCall()]))
    })
    vi.stubGlobal('fetch', http)
    const first = runCatalogProvider({
      ...scope,
      provider: 'openai',
      request: modelRequest,
      limits: { maxModelCalls: 1, maxToolCalls: 0 },
    })
    const second = runCatalogProvider({
      ...scope,
      provider: 'openai',
      request: modelRequest,
      limits: { maxModelCalls: 1, maxToolCalls: 1 },
    })
    const results = await Promise.allSettled([collect(first.stream), collect(second.stream)])
    expect(results).toMatchObject([
      { status: 'rejected', reason: { code: 'tool_calls' } },
      { status: 'rejected', reason: { code: 'model_calls' } },
    ])
    expect(first.usage()).toEqual({ modelCalls: 1, toolCalls: 0 })
    expect(second.usage()).toEqual({ modelCalls: 1, toolCalls: 1 })
    expect(workspaceContextMockFns.mockLoadActiveWorkspaceApplicationContext).toHaveBeenCalledTimes(
      1
    )
    expect(beforeProviderModelCall()).toBeUndefined()
  })

  it('refuses unsupported providers and attachments before calling any model', () => {
    const http = vi.fn()
    vi.stubGlobal('fetch', http)
    expect(() =>
      runCatalogProvider({ ...scope, provider: 'google' as never, request: modelRequest })
    ).toThrow('Unsupported')
    expect(() =>
      runCatalogProvider({
        ...scope,
        provider: 'openai',
        request: {
          ...modelRequest,
          messages: [{ role: 'user', content: 'Read', files: [{}] as never }],
        },
      })
    ).toThrow('attachments')
    expect(http).not.toHaveBeenCalled()
  })

  it.each(['openai', 'anthropic'] as const)(
    'does not start an already-cancelled %s run',
    async (provider) => {
      const abort = new AbortController()
      abort.abort(new DOMException('Fictitious cancellation', 'AbortError'))
      const http = vi.fn()
      vi.stubGlobal('fetch', http)
      const run = runCatalogProvider({
        ...scope,
        provider,
        request: modelRequest,
        signal: abort.signal,
      })
      await expect(collect(run.stream)).rejects.toMatchObject({ name: 'AbortError' })
      expect(http).not.toHaveBeenCalled()
      expect(run.usage()).toEqual({ modelCalls: 0, toolCalls: 0 })
    }
  )

  it('propagates consumer cancellation while an OpenAI SSE stream is active', async () => {
    let bodyCancelled = false
    let transportSignal: AbortSignal | undefined
    const http = vi.fn((_url, init) => {
      transportSignal = init.signal
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"type":"response.output_text.delta","delta":"Working"}\n\n'
            )
          )
          // The HTTP double mirrors fetch's stream abortion, not a real remote service.
          init.signal.addEventListener(
            'abort',
            () => {
              bodyCancelled = true
              controller.error(new DOMException('HTTP double cancelled', 'AbortError'))
            },
            { once: true }
          )
        },
        cancel() {
          bodyCancelled = true
        },
      })
      return Promise.resolve(
        new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
      )
    })
    vi.stubGlobal('fetch', http)
    const run = runCatalogProvider({ ...scope, provider: 'openai', request: modelRequest })
    const reader = run.stream.getReader()
    expect((await reader.read()).value).toMatchObject({ type: 'text_delta', text: 'Working' })
    await reader.cancel(new DOMException('Fictitious cancellation', 'AbortError'))
    expect(transportSignal?.aborted).toBe(true)
    await vi.waitFor(() => expect(bodyCancelled).toBe(true))
    expect(run.usage()).toEqual({ modelCalls: 1, toolCalls: 0 })
    expect(http).toHaveBeenCalledTimes(1)
  })

  it('uses only the four server-owned schema definitions despite extra request fields', async () => {
    const http = vi.fn().mockResolvedValueOnce(answer())
    vi.stubGlobal('fetch', http)
    const run = runCatalogProvider({
      ...scope,
      provider: 'openai',
      request: {
        ...modelRequest,
        tools: [{ id: 'http_request' }],
        workflowId: 'other-workflow',
        environmentVariables: { FICTIVE_VALUE: 'PRIVATE_INPUT_NOT_MODEL_DATA' },
      } as never,
    })
    await collect(run.stream)
    const body = JSON.parse(http.mock.calls[0][1].body)
    expect(body.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([
      'get_block',
      'get_tool',
      'list_blocks',
      'list_tools',
    ])
    expect(JSON.stringify(body)).not.toContain('PRIVATE_INPUT_NOT_MODEL_DATA')
    expect(
      body.tools.find((tool: { name: string }) => tool.name === 'get_block').parameters.properties
    ).toHaveProperty('blockId')
    expect(
      body.tools.every(
        (tool: { parameters: { properties: object } }) =>
          !('workspaceId' in tool.parameters.properties)
      )
    ).toBe(true)
  })
})

describe('optional preview — native providers and edit engine, HTTP/DB doubles', () => {
  const blockId = '11111111-1111-4111-8111-111111111111'
  const workflow = {
    workflowId: 'bound-workflow',
    policy: 'sanitized_details' as const,
    previewOperations: true as const,
  }
  const request = () => ({
    expectedRevision: 7,
    layout: 'none',
    operations: [{ operation_type: 'edit', block_id: blockId, params: { name: 'After' } }],
  })
  const snapshot = () => ({
    draftRevision: 7,
    state: {
      blocks: {
        [blockId]: {
          id: blockId,
          type: 'function',
          name: 'Before',
          enabled: true,
          position: { x: 0, y: 0 },
          outputs: {},
          subBlocks: { code: { id: 'code', type: 'code', value: 'return "PRIVATE_GRAPH_CANARY"' } },
        },
      },
      edges: [],
      loops: {},
      parallels: {},
    },
  })
  beforeEach(async () => {
    const { FunctionBlock } = await import('@/blocks/blocks/function')
    vi.mocked(getBlock).mockReturnValue(FunctionBlock)
    workspaceAuthzMockFns.mockResolveEffectiveWorkspacePermission.mockResolvedValue('write')
    workflowContextMockFns.mockResolveActiveWorkflowApplicationContext
      .mockReset()
      .mockResolvedValue({
        workflowId: 'bound-workflow',
        workflow: { id: 'bound-workflow', workspaceId: scope.workspaceId },
        workspaceId: scope.workspaceId,
        workspaceOrganizationId: null,
        allowPersonalApiKeys: true,
        billedAccountUserId: 'other-payer',
      })
    previewInfra.snapshot.mockReset().mockImplementation(async () => snapshot())
    previewInfra.replace.mockReset().mockRejectedValue(new Error('Preview must not persist'))
    previewInfra.ids.mockReset().mockResolvedValue(undefined)
    auditMockFns.mockRecordAudit.mockClear()
  })
  function start(
    provider: 'openai' | 'anthropic',
    input: Record<string, unknown>,
    overrides: Partial<Parameters<typeof runCatalogProvider>[0]> = {}
  ) {
    const name = 'preview_workflow_operations'
    const http = vi
      .fn()
      .mockResolvedValueOnce(
        provider === 'openai'
          ? sse(response([toolCall(name, input)]))
          : anthropicSse(true, { name, input })
      )
      .mockResolvedValueOnce(provider === 'openai' ? answer() : anthropicSse())
    vi.stubGlobal('fetch', http)
    const run = runCatalogProvider({
      ...scope,
      provider,
      request: { ...modelRequest, model: provider === 'openai' ? 'gpt-4.1' : 'claude-sonnet-4-5' },
      workflow,
      ...overrides,
    })
    return { http, run }
  }
  async function turn(provider: 'openai' | 'anthropic', input: Record<string, unknown>) {
    const { http, run } = start(provider, input)
    const events = await collect(run.stream)
    const body = JSON.parse(http.mock.calls[1][1].body)
    const output =
      provider === 'openai'
        ? body.input.find((x: { type: string }) => x.type === 'function_call_output').output
        : body.messages
            .flatMap((x: { content: unknown[] }) => x.content)
            .find((x: { type: string }) => x.type === 'tool_result').content
    return { http, run, events, body, output: JSON.parse(output) }
  }
  it.each(['openai', 'anthropic'] as const)(
    'announces the exact v2 request and executes a native preview with %s',
    async (provider) => {
      const { v2ApplyWorkflowOperationsBodySchema } = await import(
        '@/lib/api/contracts/v2/workflows'
      )
      const { z } = await import('zod')
      const { $schema: _dialect, ...native } = z.toJSONSchema(v2ApplyWorkflowOperationsBodySchema, {
        io: 'input',
      })
      const result = await turn(provider, { request: request() })
      const first = JSON.parse(result.http.mock.calls[0][1].body)
      const tool = first.tools.find(
        (x: { name: string }) => x.name === 'preview_workflow_operations'
      )
      const schema = provider === 'openai' ? tool.parameters : tool.input_schema
      // Every local JSON pointer must resolve from the actual SDK schema root.
      const pending: unknown[] = [schema]
      let references = 0
      while (pending.length) {
        const node = pending.pop()
        if (!node || typeof node !== 'object') continue
        for (const [key, value] of Object.entries(node)) {
          if (key === '$ref') {
            expect(typeof value).toBe('string')
            const pointer = value as string
            expect(pointer.startsWith('#/')).toBe(true)
            let target: unknown = schema
            for (const part of pointer.slice(2).split('/')) {
              const field = part.replace(/~1/g, '/').replace(/~0/g, '~')
              expect(target).toHaveProperty(field)
              target = (target as Record<string, unknown>)[field]
            }
            references++
          } else pending.push(value)
        }
      }
      expect(references).toBeGreaterThan(0)
      // Only the pointer location changes; all native constraints and $defs survive.
      const originalLocation = JSON.stringify(schema.properties.request).replaceAll(
        '"$ref":"#/properties/request/',
        '"$ref":"#/'
      )
      expect(JSON.parse(originalLocation)).toEqual(native)
      expect(schema.required).toEqual(['request'])
      expect(first.tools).toHaveLength(7)
      expect(JSON.stringify(first.tools)).not.toContain('bound-workflow')
      expect(result.output).toMatchObject({
        dryRun: true,
        persisted: false,
        baseRevision: 7,
        draftRevision: 7,
        applied: 1,
      })
      expect(JSON.stringify(result.body)).not.toMatch(/PRIVATE_GRAPH_CANARY|"graph"/)
      expect(result.run.usage()).toEqual({ modelCalls: 2, toolCalls: 1 })
      expect(previewInfra.replace).not.toHaveBeenCalled()
      expect(auditMockFns.mockRecordAudit).not.toHaveBeenCalled()
    }
  )
  it.each(['openai', 'anthropic'] as const)(
    'keeps atomic refusal diagnostics in model data and raw failure with %s',
    async (provider) => {
      const result = await turn(provider, {
        request: {
          expectedRevision: 7,
          atomic: true,
          layout: 'none',
          operations: [{ operation_type: 'delete', block_id: 'PRIVATE_MISSING_ID' }],
        },
      })
      expect(result.output).toMatchObject({
        ok: false,
        error: { code: 'atomic_refused' },
        diagnostics: { skipped: [{ code: 'block_not_found', operationIndexes: [0] }] },
      })
      // Native conversation history retains the model's own submitted arguments.
      expect(JSON.stringify(result.output)).not.toContain('PRIVATE_MISSING_ID')
      expect(result.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'tool_call_end', status: 'error' }),
        ])
      )
      expect(previewInfra.replace).not.toHaveBeenCalled()
    }
  )
  it.each([
    { workflowId: 'bound-workflow', policy: 'summary_only', previewOperations: true },
    { workflowId: 'bound-workflow', policy: 'sanitized_details', previewOperations: false },
    { workflowId: 'bound-workflow', policy: 'sanitized_details', previewOperations: 'true' },
  ])('refuses invalid opt-in before HTTP: %j', (selection) => {
    const http = vi.fn()
    vi.stubGlobal('fetch', http)
    expect(() =>
      runCatalogProvider({
        ...scope,
        provider: 'openai',
        request: modelRequest,
        workflow: selection,
      } as never)
    ).toThrow('Invalid workflow read binding.')
    expect(http).not.toHaveBeenCalled()
  })
  it.each(['openai', 'anthropic'] as const)(
    'cannot enable preview from model arguments when server opt-in is absent: %s',
    async (provider) => {
      for (const selection of [
        undefined,
        { workflowId: 'bound-workflow', policy: 'summary_only' as const },
        { workflowId: 'bound-workflow', policy: 'sanitized_details' as const },
      ]) {
        clearProviderClientCacheForTests()
        const { http, run } = start(
          provider,
          { request: request(), previewOperations: true },
          { workflow: selection }
        )
        const events = await collect(run.stream)
        expect(events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: 'tool_call_end', status: 'error' }),
          ])
        )
        const first = JSON.parse(http.mock.calls[0][1].body)
        expect(
          first.tools.some((x: { name: string }) => x.name === 'preview_workflow_operations')
        ).toBe(false)
        expect(http).toHaveBeenCalledTimes(2)
        expect(run.usage()).toEqual({ modelCalls: 2, toolCalls: 0 })
        expect(toolsMockFns.mockExecuteTool).not.toHaveBeenCalled()
        expect(previewInfra.snapshot).not.toHaveBeenCalled()
      }
    }
  )
  it.each(['openai', 'anthropic'] as const)(
    'rejects identity and option injections in both request layers: %s',
    async (provider) => {
      for (const input of [
        { request: request(), workspaceId: 'foreign' },
        { request: request(), workflowId: 'foreign' },
        { request: { ...request(), principal: { userId: 'owner' } } },
        { request: { ...request(), dryRun: false } },
        { request: { ...request(), baseGraph: {} } },
        { request: { ...request(), previewOperations: true } },
        { request: { operations: request().operations } },
      ]) {
        clearProviderClientCacheForTests()
        const result = await turn(provider, input)
        expect(result.output).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
        expect(previewInfra.snapshot).not.toHaveBeenCalled()
      }
    }
  )
  it.each(['openai', 'anthropic'] as const)(
    'preserves native revision and permission refusals through %s',
    async (provider) => {
      const conflict = await turn(provider, { request: { ...request(), expectedRevision: 6 } })
      expect(conflict.output).toMatchObject({ ok: false, error: { code: 'revision_conflict' } })
      clearProviderClientCacheForTests()
      previewInfra.snapshot.mockClear()
      workspaceAuthzMockFns.mockResolveEffectiveWorkspacePermission.mockResolvedValue('read')
      const denied = await turn(provider, { request: request() })
      expect(denied.output).toMatchObject({ ok: false, error: { code: 'forbidden' } })
      expect(previewInfra.snapshot).not.toHaveBeenCalled()
      expect(previewInfra.replace).not.toHaveBeenCalled()
    }
  )
  it.each(['openai', 'anthropic'] as const)(
    'withholds an incoherent canonical workspace through %s',
    async (provider) => {
      workflowContextMockFns.mockResolveActiveWorkflowApplicationContext.mockResolvedValue({
        workflowId: 'bound-workflow',
        workflow: { id: 'bound-workflow', workspaceId: 'foreign' },
        workspaceId: 'foreign',
        workspaceOrganizationId: null,
        allowPersonalApiKeys: true,
        billedAccountUserId: 'other-payer',
      })
      const result = await turn(provider, { request: request() })
      expect(result.output).toMatchObject({ ok: false, error: { code: 'unavailable' } })
      expect(previewInfra.replace).not.toHaveBeenCalled()
    }
  )
  it.each(['openai', 'anthropic'] as const)(
    'keeps model/tool budgets and cancellation for preview with %s',
    async (provider) => {
      for (const boundary of ['model', 'tool'] as const) {
        clearProviderClientCacheForTests()
        previewInfra.snapshot.mockClear()
        const { http, run } = start(
          provider,
          { request: request() },
          { limits: boundary === 'model' ? { maxModelCalls: 1 } : { maxToolCalls: 0 } }
        )
        await expect(collect(run.stream)).rejects.toMatchObject({
          code: boundary === 'model' ? 'model_calls' : 'tool_calls',
        })
        expect(http).toHaveBeenCalledTimes(1)
        expect(run.usage()).toEqual({ modelCalls: 1, toolCalls: boundary === 'model' ? 1 : 0 })
        if (boundary === 'tool') expect(previewInfra.snapshot).not.toHaveBeenCalled()
      }
      clearProviderClientCacheForTests()
      let release!: () => void
      const wait = new Promise<void>((resolve) => {
        release = resolve
      })
      previewInfra.snapshot.mockReset().mockImplementation(async () => {
        await wait
        return snapshot()
      })
      previewInfra.ids.mockClear()
      const abort = new AbortController()
      const { http, run } = start(provider, { request: request() }, { signal: abort.signal })
      const pending = collect(run.stream)
      try {
        await vi.waitFor(() => expect(previewInfra.snapshot).toHaveBeenCalledTimes(1))
        abort.abort(new DOMException('Fixture cancellation', 'AbortError'))
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
        expect(http).toHaveBeenCalledTimes(1)
        expect(run.usage()).toEqual({ modelCalls: 1, toolCalls: 1 })
      } finally {
        release()
      }
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(previewInfra.ids).not.toHaveBeenCalled()
      expect(previewInfra.replace).not.toHaveBeenCalled()
    }
  )
  it('captures the server selection and preview principal before awaiting HTTP', async () => {
    const mutablePrincipal = createSessionPrincipal({ userId: 'catalog-reader' })
    const mutableWorkflow = { ...workflow }
    const { run } = start(
      'openai',
      { request: request() },
      { principal: mutablePrincipal, workflow: mutableWorkflow }
    )
    mutablePrincipal.userId = 'different-user'
    mutableWorkflow.workflowId = 'foreign'
    const events = await collect(run.stream)
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'tool_call_end', status: 'success' }),
      ])
    )
    expect(workflowContextMockFns.mockResolveActiveWorkflowApplicationContext).toHaveBeenCalledWith(
      { workflowId: 'bound-workflow', assertedWorkspaceId: 'workspace-1' }
    )
    expect(
      workspaceAuthzMockFns.mockResolveEffectiveWorkspacePermission.mock.calls.at(-1)?.[0]
    ).toBe('catalog-reader')
  })
  it.each([
    'https://invalid.example/schema',
    '#/$defs/missing',
    '#/~2invalid',
    '#/description',
    '#/properties',
  ])('refuses unsupported or dangling generated refs before HTTP: %s', async (reference) => {
    const { z } = await import('zod')
    const { workflowPreviewInputs } = await import('./workflow-preview-tools')
    // Fault injection through the real generator's metadata, restored after the test.
    const schema = workflowPreviewInputs.preview_workflow_operations
    const metadata = z.globalRegistry.get(schema)
    z.globalRegistry.add(schema, { ...metadata, $ref: reference })
    const http = vi.fn()
    vi.stubGlobal('fetch', http)
    try {
      expect(() =>
        runCatalogProvider({ ...scope, provider: 'openai', request: modelRequest, workflow })
      ).toThrow('Unsupported workflow preview schema reference.')
      expect(http).not.toHaveBeenCalled()
    } finally {
      if (metadata) z.globalRegistry.add(schema, metadata)
      else z.globalRegistry.remove(schema)
    }
  })
})

describe('OpenAI physical usage observation — native parser, HTTP double', () => {
  function observationOptions() {
    const references: unknown[] = []
    const observations: Array<{ reference: unknown; observation: ProviderModelObservation }> = []
    return {
      references,
      observations,
      beforeModelTransport: async (_signal: AbortSignal, reference?: unknown) => {
        references.push(reference)
      },
      observeModelAttempt: async (
        reference: ProviderModelAttempt,
        observation: ProviderModelObservation
      ) => {
        observations.push({ reference, observation })
      },
    }
  }

  it('binds native terminal usage to the opaque pretransport attempt', async () => {
    const observed = observationOptions()
    const http = vi.fn(async () => answer())
    vi.stubGlobal('fetch', http)
    const run = runCatalogProvider({
      ...scope,
      provider: 'openai',
      request: modelRequest,
      ...observed,
    })
    await collect(run.stream)
    expect(observed.observations).toHaveLength(1)
    expect(observed.observations[0].reference).toBe(observed.references[0])
    expect(Object.keys(observed.references[0] as object)).toEqual([])
    expect(Object.isFrozen(observed.references[0])).toBe(true)
    expect(observed.observations[0].observation).toMatchObject({
      kind: 'usage',
      usage: { input: 1, output: 1 },
      cost: { kind: 'list_price_estimate' },
    })
    expect(run.usage()).toEqual({ modelCalls: 1, toolCalls: 0 })
  })

  it.each(['retry', 'summary'] as const)(
    'keeps %s and the successful response as distinct attempts',
    async (mode) => {
      const observed = observationOptions()
      const first =
        mode === 'retry'
          ? new Response('{}', { status: 503, headers: { 'retry-after-ms': '0' } })
          : new Response(
              JSON.stringify({ error: { message: 'reasoning.summary requires verification' } }),
              { status: 400 }
            )
      const http = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(answer())
      vi.stubGlobal('fetch', http)
      await collect(
        runCatalogProvider({
          ...scope,
          provider: 'openai',
          request: { ...modelRequest, model: mode === 'summary' ? 'o3' : modelRequest.model },
          ...observed,
        }).stream
      )
      expect(observed.observations.map((o) => o.observation.kind)).toEqual(['unknown', 'usage'])
      expect(observed.references).toHaveLength(2)
      expect(observed.references[0]).not.toBe(observed.references[1])
      expect(observed.observations.map((o) => o.reference)).toEqual(observed.references)
      expect(http).toHaveBeenCalledTimes(2)
    }
  )

  it('reports each tool and synthesis response without assigning cumulative tokens', async () => {
    const observed = observationOptions()
    const second = response([])
    second.usage = { input_tokens: 5, output_tokens: 3, total_tokens: 8 }
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(sse(response([toolCall()])))
        .mockResolvedValueOnce(sse(second))
    )
    const run = runCatalogProvider({
      ...scope,
      provider: 'openai',
      request: modelRequest,
      ...observed,
    })
    await collect(run.stream)
    expect(
      observed.observations.map((o) =>
        o.observation.kind === 'usage' ? o.observation.usage : undefined
      )
    ).toEqual([
      expect.objectContaining({ input: 1, output: 1 }),
      expect.objectContaining({ input: 5, output: 3 }),
    ])
    expect(run.usage()).toEqual({ modelCalls: 2, toolCalls: 1 })
  })

  it.each([
    undefined,
    {},
    { input_tokens: 1, output_tokens: -1, total_tokens: 0 },
    { input_tokens: 1, output_tokens: 1.5, total_tokens: 2.5 },
  ])('does not turn missing or malformed native usage into known zero: %j', async (usage) => {
    const observed = observationOptions()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sse({ ...response([]), usage } as never))
    )
    await collect(
      runCatalogProvider({ ...scope, provider: 'openai', request: modelRequest, ...observed })
        .stream
    )
    expect(observed.observations).toHaveLength(1)
    expect(observed.observations[0].observation).toEqual({
      kind: 'unknown',
      reason: 'usage_unavailable',
    })
  })

  it('keeps counters but no known price for an unregistered model', async () => {
    const observed = observationOptions()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => answer())
    )
    await collect(
      runCatalogProvider({
        ...scope,
        provider: 'openai',
        request: { ...modelRequest, model: 'unregistered-test-model' },
        ...observed,
      }).stream
    )
    expect(observed.observations[0]?.observation).toMatchObject({
      kind: 'usage',
      cost: { kind: 'unavailable' },
    })
  })

  it('never retries an observation callback rejection after a response', async () => {
    const observed = observationOptions()
    const http = vi.fn(async () => answer())
    vi.stubGlobal('fetch', http)
    const observer = vi.fn(async () => {
      throw Object.assign(new Error('PRIVATE_OBSERVER'), {
        code: 'ECONNRESET',
        cause: 'PRIVATE_CAUSE',
      })
    })
    const run = runCatalogProvider({
      ...scope,
      provider: 'openai',
      request: modelRequest,
      ...observed,
      observeModelAttempt: observer,
    })
    await expect(collect(run.stream)).rejects.toMatchObject({
      message: 'Server model observation failed.',
    })
    expect(observer).toHaveBeenCalledOnce()
    expect(http).toHaveBeenCalledOnce()
  })

  it('keeps the first known turn and marks the aborted second response unknown', async () => {
    const observed = observationOptions()
    const abort = new AbortController()
    const http = vi
      .fn()
      .mockResolvedValueOnce(sse(response([toolCall()])))
      .mockImplementationOnce(async () => {
        return new Response(
          new ReadableStream({
            start(controller) {
              abort.signal.addEventListener(
                'abort',
                () => controller.error(new DOMException('Aborted', 'AbortError')),
                { once: true }
              )
            },
          })
        )
      })
    vi.stubGlobal('fetch', http)
    const run = runCatalogProvider({
      ...scope,
      provider: 'openai',
      request: modelRequest,
      signal: abort.signal,
      ...observed,
    })
    const drain = collect(run.stream)
    void drain.catch(() => {})
    await vi.waitFor(() => expect(http).toHaveBeenCalledTimes(2))
    abort.abort()
    await expect(drain).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(observed.observations).toHaveLength(2))
    expect(observed.observations.map((o) => o.observation.kind)).toEqual(['usage', 'unknown'])
  })

  it('refuses observation on Anthropic before any transport', () => {
    const http = vi.fn()
    vi.stubGlobal('fetch', http)
    expect(() =>
      runCatalogProvider({
        ...scope,
        provider: 'anthropic',
        request: modelRequest,
        ...observationOptions(),
      })
    ).toThrow('Model observation requires OpenAI streaming.')
    expect(http).not.toHaveBeenCalled()
  })
})

describe('OpenAI simple stream observation — native provider and HTTP double', () => {
  async function nativeRun(observe?: (reference: unknown, outcome: unknown) => Promise<void>) {
    const result = await runWithProviderRuntimeContext(
      {
        controlledRun: {
          signal: new AbortController().signal,
          beforeModelCall() {},
          observeModelAttempt: observe,
          executeTool: async () => {
            throw new Error('unused')
          },
        },
      },
      () => openaiProvider.executeRequest({ ...modelRequest, stream: true })
    )
    if (!('stream' in result)) throw new Error('Expected native streaming result')
    return result
  }
  it('preserves native aggregate output and events with observation enabled', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => answer())
    )
    const baseline = await nativeRun()
    const oldEvents = await collect(baseline.stream)
    const observer = vi.fn(async () => {})
    const observed = await nativeRun(observer)
    expect(await collect(observed.stream)).toEqual(oldEvents)
    expect(observed.execution.output.tokens).toEqual(baseline.execution.output.tokens)
    expect(observed.execution.output.cost).toEqual(baseline.execution.output.cost)
    expect(observer).toHaveBeenCalledOnce()
    expect(observer.mock.calls[0][1]).toMatchObject({ kind: 'usage' })
  })
  it('observes a truncated simple stream as unknown without another fetch', async () => {
    const http = vi.fn(
      async () =>
        new Response('data: {"type":"response.output_text.delta","delta":"partial"}\n\n', {
          headers: { 'Content-Type': 'text/event-stream' },
        })
    )
    vi.stubGlobal('fetch', http)
    const observer = vi.fn(async () => {})
    const observed = await nativeRun(observer)
    await expect(collect(observed.stream)).rejects.toThrow('without a completed response')
    expect(observer.mock.calls[0][1]).toEqual({ kind: 'unknown', reason: 'incomplete' })
    expect(http).toHaveBeenCalledOnce()
  })
  it('does not retry a refused observer on HTTP503 before native retry', async () => {
    const http = vi.fn(
      async () => new Response('{}', { status: 503, headers: { 'retry-after-ms': '0' } })
    )
    vi.stubGlobal('fetch', http)
    const observer = vi.fn(async () => {
      throw Object.assign(new Error('PRIVATE_OBSERVER'), { code: 'ECONNRESET' })
    })
    await expect(nativeRun(observer)).rejects.toMatchObject({
      message: 'Server model observation failed.',
    })
    expect(observer).toHaveBeenCalledOnce()
    expect(http).toHaveBeenCalledOnce()
  })
  it('never exposes the server observer or opaque reference in the SDK body', async () => {
    const observer = vi.fn(async () => {})
    const http = vi.fn().mockImplementation(async () => answer())
    vi.stubGlobal('fetch', http)
    const observed = await nativeRun(observer)
    await collect(observed.stream)
    const body = JSON.parse(http.mock.calls[0][1].body)
    expect(body).not.toHaveProperty('observeModelAttempt')
    expect(body).not.toHaveProperty('beforeModelTransport')
    expect(body).not.toHaveProperty('reference')
    expect(observer).toHaveBeenCalledOnce()
  })
})

describe('server-owned proposal callback with real OpenAI loop and fake storage/HTTP', () => {
  const intention = {
    request: {
      expectedRevision: 7,
      operations: [{ operation_type: 'remove', block_id: 'b1' }],
      layout: { mode: 'preserve' },
    },
  }
  const selection = {
    workflowId: 'bound-workflow',
    policy: 'sanitized_details' as const,
    previewOperations: true as const,
  }
  beforeEach(() =>
    proposalInfra.propose.mockReset().mockResolvedValue({
      ok: true,
      proposal: { proposalId: 'server-proposal', expectedRevision: 7 },
      persisted: false,
    })
  )
  it('announces the native intent schema and awaits the server callback before synthesis', async () => {
    const hold = transportGate()
    const callback = vi.fn(async () => {
      await hold.promise
      return { status: 'skipped' as const }
    })
    const http = vi
      .fn()
      .mockResolvedValueOnce(sse(response([toolCall('propose_workflow_operations', intention)])))
      .mockResolvedValueOnce(answer())
    vi.stubGlobal('fetch', http)
    const options = {
      ...scope,
      provider: 'openai' as const,
      request: modelRequest,
      workflow: selection,
      proposal: { runId: 'run-a', onProposal: callback },
    }
    const run = runCatalogProvider(options)
    const pending = collect(run.stream)
    await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce())
    expect(http).toHaveBeenCalledOnce()
    expect(proposalInfra.propose.mock.calls[0][0]).toMatchObject({
      proposalRunId: 'run-a',
      workflowId: 'bound-workflow',
      principal,
    })
    const tools = JSON.parse(http.mock.calls[0][1].body).tools
    const schema = tools.find((t: { name: string }) => t.name === 'propose_workflow_operations')
    expect(schema.parameters.properties.request.required).toContain('expectedRevision')
    expect(JSON.stringify(schema)).not.toMatch(/onProposal|sessionId|run-a|server-proposal/)
    hold.release()
    await pending
    const out = JSON.parse(http.mock.calls[1][1].body).input.find(
      (i: { type: string }) => i.type === 'function_call_output'
    )
    expect(JSON.parse(out.output)).toEqual({ status: 'skipped' })
    expect(toolsMockFns.mockExecuteTool).not.toHaveBeenCalled()
  })
  it.each([
    { principal: { userId: 'model-owner' } },
    { runId: 'model-run' },
    { toolCallId: 'forged' },
  ])('refuses model authority fields before creating a proposal: %j', async (extra) => {
    const callback = vi.fn()
    const http = vi
      .fn()
      .mockResolvedValueOnce(
        sse(response([toolCall('propose_workflow_operations', { ...intention, ...extra })]))
      )
      .mockResolvedValueOnce(answer())
    vi.stubGlobal('fetch', http)
    await collect(
      runCatalogProvider({
        ...scope,
        provider: 'openai',
        request: modelRequest,
        workflow: selection,
        proposal: { runId: 'run-a', onProposal: callback },
      }).stream
    )
    expect(proposalInfra.propose).not.toHaveBeenCalled()
    expect(callback).not.toHaveBeenCalled()
    expect(JSON.stringify(JSON.parse(http.mock.calls[1][1].body))).toContain('invalid_input')
  })
  it('rejects a proposal option without its explicit preview scope before transport', () => {
    const http = vi.fn()
    vi.stubGlobal('fetch', http)
    expect(() =>
      runCatalogProvider({
        ...scope,
        provider: 'openai',
        request: modelRequest,
        proposal: { runId: 'run-a', onProposal: vi.fn() },
      })
    ).toThrow()
    expect(http).not.toHaveBeenCalled()
  })
})

it('controlled native provider failures do not expose a fictive transport canary in logger calls', async () => {
  const { getAllMockLoggers } = await import('@sim/testing/mocks/logger.mock')
  const { inspect } = await import('node:util')
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: { message: 'FICTIVE_NATIVE_LOG_CANARY', type: 'invalid_request_error' },
          }),
          { status: 400, headers: { 'content-type': 'application/json' } }
        )
    )
  )
  await collect(
    runCatalogProvider({ ...scope, provider: 'openai', request: modelRequest }).stream
  ).catch(() => {})
  const calls = getAllMockLoggers().flatMap((l) => [...l.error.mock.calls, ...l.warn.mock.calls])
  expect(inspect(calls, { depth: 8 })).not.toContain('FICTIVE_NATIVE_LOG_CANARY')
})
