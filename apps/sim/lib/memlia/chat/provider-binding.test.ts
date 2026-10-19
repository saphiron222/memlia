// Copyright (c) 2026 Memlia. All rights reserved.

import { createSessionPrincipal } from '@sim/testing/factories/principal.factory'
import { auditMock } from '@sim/testing/mocks/audit.mock'
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
  runWithProviderRuntimeContext,
} from '@/providers/runtime-context'
import { runCatalogProvider } from './provider-binding'

const principal = createSessionPrincipal({ userId: 'catalog-reader' })
const scope = { principal, workspaceId: 'workspace-1' }
const modelRequest = {
  model: 'gpt-4.1',
  apiKey: 'FICTIVE_MEMLIA_TEST_ONLY',
  messages: [{ role: 'user' as const, content: 'Find the Loop block' }],
}

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
