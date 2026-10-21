// Copyright (c) 2026 Memlia. All rights reserved.
// Real admission + Anthropic core/SDK. File/auth/budget/key and HTTP are doubles;
// no database reservation, secret or live provider/model is qualified here.
import Anthropic from '@anthropic-ai/sdk'
import { createLogger } from '@sim/logger'
import { setEnvFlags } from '@sim/testing/mocks/env-flags.mock'
import { beforeEach, expect, it, vi } from 'vitest'
import { parseChatInstallationPolicy } from '@/lib/memlia/ai/chat-policy.server'
import { executeAnthropicProviderRequest } from '@/providers/anthropic/core'
import { getStaticProviderModels } from '@/providers/models'
import { getModelPricing } from '@/providers/pricing'
import { runWithProviderRuntimeContext } from '@/providers/runtime-context'
import { prepareLocalChatAdmission } from './local-admission.server'
import { runCatalogProvider } from './provider-binding'

const infra = vi.hoisted(() => ({ policy: vi.fn(), window: vi.fn() }))
vi.mock('@/lib/memlia/ai/chat-policy-source.server', () => ({
  readChatInstallationPolicyFile: infra.policy,
}))
vi.mock('@/lib/permission-groups/capability-assertions', () => ({
  assertWorkspaceCapability: async () => {},
}))
vi.mock('@/lib/permission-groups/permission-check', () => ({
  validateModelProvider: async () => {},
}))
vi.mock('./authorized-transcript.server', () => ({
  loadAuthorizedChatTranscript: async () => ({ messages: [{ role: 'user', content: 'Fixture' }] }),
}))
vi.mock('@/lib/memlia/ai/chat-budget-window.server', () => ({ readChatBudgetWindow: infra.window }))
vi.mock('@/lib/core/config/api-keys', () => ({ getRotatingApiKey: () => 'FICTITIOUS_TEST_KEY' }))

beforeEach(() => {
  vi.resetAllMocks()
  setEnvFlags({ isCopilotToolPermissionsEnabled: true })
})

async function admitted(model: string, level?: string) {
  infra.policy.mockReturnValue({
    policy: parseChatInstallationPolicy({
      enabled: true,
      provider: 'anthropic',
      model,
      destination: 'official',
      data: { conversation: true, catalogue: true, workflow: 'sanitized_details' },
      localBackend: {
        kind: 'memlia_local_chat',
        version: 1,
        budgetWindow: { id: 'fixture_window', version: 7 },
        ...(level === undefined ? {} : { thinkingLevel: level }),
      },
    }),
  })
  infra.window.mockResolvedValue({
    windowId: 'fixture_window',
    windowVersion: 7,
    pricingProfile: {
      version: 1,
      basis: 'native_list_price_estimate_v1',
      provider: 'anthropic',
      model,
      pricing: getModelPricing(model),
      maximumCostUsd: '100',
      bounds: {
        contextTokens: getStaticProviderModels('anthropic').find((m) => m.id === model)!
          .contextWindow,
        outputTokens: 1024,
      },
    },
  })
  return prepareLocalChatAdmission({
    principal: { kind: 'session', userId: 'fixture_user', sessionId: 'fixture_session' },
    workspaceId: '00000000-0000-4000-8000-000000000002',
    workflowId: 'fixture_workflow',
    chatId: '00000000-0000-4000-8000-000000000001',
    currentMessage: { id: '00000000-0000-4000-8000-000000000003', content: 'Fixture' },
  })
}

function response(model: string) {
  const events = [
    {
      type: 'message_start',
      message: {
        id: 'msg_fixture',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Fixture' } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 2 },
    },
    { type: 'message_stop' },
  ]
  return new Response(
    events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),
    {
      headers: { 'content-type': 'text/event-stream' },
    }
  )
}

const logger = createLogger('ThinkingPolicyNativeTest')
const tools = [
  {
    id: 'read_fixture',
    name: 'Read fixture',
    params: {},
    parameters: { type: 'object', properties: {} },
  },
]

it.each([
  ['claude-haiku-5-5', 'low', { type: 'adaptive', display: 'summarized' }, 'low'],
  ['claude-haiku-5-5', 'none', { type: 'disabled' }, undefined],
  ['claude-sonnet-5-5', 'none', { type: 'between_tools' }, undefined],
  ['claude-haiku-5-5', undefined, undefined, undefined],
] as const)(
  'sends only admitted %s/%s configuration into the native SDK payload',
  async (model, level, thinking, effort) => {
    const options = await admitted(model, level)
    let wire: Record<string, any> | undefined
    let calls = 0
    vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
      calls++
      wire = JSON.parse(String(init?.body))
      return response(model)
    })
    // Existing binding, controlled client and SDK remain native; HTTP is synthetic.
    const result = runCatalogProvider({
      ...options.localChat,
      provider: 'anthropic',
      limits: { maxModelCalls: 1, maxToolCalls: 0, maxDurationMs: 1000 },
    })
    const reader = result.stream.getReader()
    const events = []
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      events.push(next.value)
    }
    reader.releaseLock()
    expect(calls).toBe(1)
    expect(wire?.thinking).toEqual(thinking)
    expect(wire?.output_config?.effort).toBe(effort)
    expect(wire?.max_tokens).toBe(1024)
    expect(options.localChat.budget.pricingProfile.bounds.outputTokens).toBe(1024)
    expect(options.intent.request).not.toHaveProperty('thinkingLevel')
    expect(events).toContainEqual({ type: 'text_delta', turn: 'pending', text: 'Fixture' })
    expect(events.at(-1)).toMatchObject({ type: 'turn_end', turn: 'final' })
    expect(result.usage()).toEqual({ modelCalls: 1, toolCalls: 0 })
  }
)

it('keeps native output adjustment refusal for a declared manual-thinking level before SDK transport', async () => {
  const options = await admitted('claude-haiku-4-5', 'high')
  const http = vi.fn(async () => response('claude-haiku-4-5'))
  const beforeModelCall = vi.fn()
  const client = new Anthropic({
    apiKey: 'FICTITIOUS_TEST_KEY',
    maxRetries: 0,
    timeout: 1000,
    fetch: http,
  })
  await expect(
    runWithProviderRuntimeContext(
      {
        controlledRun: {
          signal: new AbortController().signal,
          beforeModelCall,
          observeModelAttempt: async () => {},
          executeTool: async () => {
            throw new Error('unexpected_tool')
          },
        },
      },
      () =>
        executeAnthropicProviderRequest(
          { ...options.localChat.request, stream: true, agentEvents: true, tools },
          {
            providerId: 'anthropic',
            providerLabel: 'Anthropic',
            createClient: () => client,
            logger,
          }
        )
    )
  ).rejects.toThrow('Controlled Anthropic output limit is unavailable.')
  expect(http).not.toHaveBeenCalled()
  expect(beforeModelCall).not.toHaveBeenCalled()
  expect(options.localChat.request.maxTokens).toBe(1024)
})
