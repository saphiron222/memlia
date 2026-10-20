// Copyright 2026 Memlia. All rights reserved.
import { resetEnvFlagsMock, setEnvFlags } from '@sim/testing/mocks/env-flags.mock'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const infra = vi.hoisted(() => ({
  policy: vi.fn(),
  capability: vi.fn(),
  model: vi.fn(),
  transcript: vi.fn(),
  window: vi.fn(),
  key: vi.fn(),
  calls: [] as string[],
}))
vi.mock('@/lib/memlia/ai/chat-policy-source.server', () => ({
  readChatInstallationPolicyFile: infra.policy,
}))
vi.mock('@/lib/permission-groups/capability-assertions', () => ({
  assertWorkspaceCapability: infra.capability,
}))
vi.mock('@/lib/permission-groups/permission-check', () => ({ validateModelProvider: infra.model }))
vi.mock('./authorized-transcript.server', () => ({
  loadAuthorizedChatTranscript: infra.transcript,
}))
vi.mock('@/lib/memlia/ai/chat-budget-window.server', () => ({ readChatBudgetWindow: infra.window }))
vi.mock('@/lib/core/config/api-keys', () => ({ getRotatingApiKey: infra.key }))

import { parseChatInstallationPolicy } from '@/lib/memlia/ai/chat-policy.server'
import { LocalChatAdmissionSchema } from '@/lib/mothership/request/lifecycle/recovery-config'
import { getStaticProviderModels } from '@/providers/models'
import { getModelPricing } from '@/providers/pricing'
import { prepareLocalChatAdmission } from './local-admission.server'
import { captureLocalChatOptions } from './local-driver.server'

const fixture = () => ({
  principal: { kind: 'session' as const, userId: 'user-1', sessionId: 'session-1' },
  chatId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
  workflowId: 'workflow-1',
  currentMessage: { id: '00000000-0000-4000-8000-000000000003', content: 'Current text' },
})
const configuration = () => ({
  enabled: true,
  provider: 'openai',
  model: 'gpt-5.4',
  destination: 'official',
  data: { conversation: true, catalogue: true, workflow: 'sanitized_details' },
  localBackend: {
    kind: 'memlia_local_chat',
    version: 1,
    budgetWindow: { id: 'window_1', version: 7 },
  },
})
const profile = () => ({
  version: 1,
  basis: 'native_list_price_estimate_v1',
  provider: 'openai',
  model: 'gpt-5.4',
  pricing: getModelPricing('gpt-5.4')!,
  bounds: {
    contextTokens: getStaticProviderModels('openai').find((m) => m.id === 'gpt-5.4')!
      .contextWindow!,
    outputTokens: 100,
  },
  maximumCostUsd: '100',
})
const unavailable = 'Local Chat admission is unavailable.'

beforeEach(() => {
  setEnvFlags({ isCopilotToolPermissionsEnabled: true })
  vi.resetAllMocks()
  infra.calls.length = 0
  infra.policy.mockImplementation(() => {
    infra.calls.push('policy')
    return {
      kind: 'installation_file_observation',
      policy: parseChatInstallationPolicy(configuration()),
    }
  })
  infra.capability.mockImplementation(async () => {
    infra.calls.push('capability')
  })
  infra.model.mockImplementation(async () => {
    infra.calls.push('model')
  })
  infra.transcript.mockImplementation(async () => {
    infra.calls.push('transcript')
    return {
      messages: [
        { role: 'assistant', content: 'Past text' },
        { role: 'user', content: 'Current text' },
      ],
    }
  })
  infra.window.mockImplementation(async () => {
    infra.calls.push('window')
    return { windowId: 'window_1', windowVersion: 7, pricingProfile: profile() }
  })
  infra.key.mockImplementation(() => {
    infra.calls.push('key')
    return 'FICTITIOUS_LOCAL_KEY'
  })
})

describe('local admission composition; system, permissions, DB and key are doubles', () => {
  it('composes native intent and ephemeral options, with key last and no transcript in intent', async () => {
    const input = fixture()
    const result = await prepareLocalChatAdmission(input)
    expect(infra.calls).toEqual(['policy', 'capability', 'model', 'transcript', 'window', 'key'])
    expect(infra.capability).toHaveBeenCalledWith('user-1', input.workspaceId, 'copilot.use')
    expect(infra.model).toHaveBeenCalledWith('user-1', input.workspaceId, 'gpt-5.4')
    expect(infra.window).toHaveBeenCalledWith({
      windowId: 'window_1',
      windowVersion: 7,
      model: 'gpt-5.4',
    })
    expect(infra.key).toHaveBeenCalledExactlyOnceWith('openai')
    expect(result.intent).toEqual(
      LocalChatAdmissionSchema.parse({
        kind: 'memlia_local_chat',
        version: 1,
        request: {
          userId: 'user-1',
          chatId: input.chatId,
          workspaceId: input.workspaceId,
          workflowId: input.workflowId,
          messageId: input.currentMessage.id,
          message: 'Current text',
          mode: 'agent',
        },
      })
    )
    expect(JSON.stringify(result.intent)).not.toMatch(
      /FICTITIOUS|session-1|Past text|pricing|apiKey|recovery/
    )
    expect(result.localChat).toEqual(captureLocalChatOptions(result.localChat))
    expect(result.localChat.workflow).toEqual({
      workflowId: 'workflow-1',
      policy: 'sanitized_details',
      previewOperations: true,
    })
    expect(result.localChat.request).toEqual({
      model: 'gpt-5.4',
      maxTokens: 100,
      apiKey: 'FICTITIOUS_LOCAL_KEY',
      messages: [
        { role: 'assistant', content: 'Past text' },
        { role: 'user', content: 'Current text' },
      ],
    })
    expect(result.localChat.budget.pricingProfile).toEqual(profile())
  })

  it('captures identity, scopes and current message before the first await', async () => {
    const input = fixture()
    const original = structuredClone(input)
    infra.capability.mockImplementationOnce(async () => {
      input.principal.userId = 'foreign'
      input.principal.sessionId = 'foreign'
      input.chatId = 'foreign'
      input.workspaceId = 'foreign'
      input.workflowId = 'foreign'
      input.currentMessage.id = 'foreign'
      input.currentMessage.content = 'foreign'
    })
    const result = await prepareLocalChatAdmission(input)
    expect(infra.transcript).toHaveBeenCalledWith(original)
    expect(result.localChat.principal).toEqual(original.principal)
    expect(result.intent.request.message).toBe('Current text')
    expect(result.intent.request.workflowId).toBe('workflow-1')
    expect(infra.model).toHaveBeenCalledWith('user-1', original.workspaceId, 'gpt-5.4')
  })

  it('owns transcript before waiting on window, and owns returned options', async () => {
    const messages = [{ role: 'user', content: 'Current text' }]
    const budget = { windowId: 'window_1', windowVersion: 7, pricingProfile: profile() }
    infra.transcript.mockResolvedValue({ messages })
    infra.window.mockImplementation(async () => {
      messages[0]!.content = 'foreign'
      return budget
    })
    const result = await prepareLocalChatAdmission(fixture())
    budget.pricingProfile.bounds.outputTokens = 999
    messages.push({ role: 'user', content: 'later' })
    expect(result.localChat.request.messages).toEqual([{ role: 'user', content: 'Current text' }])
    expect(result.localChat.request.maxTokens).toBe(100)
    expect(result.localChat.budget.pricingProfile.bounds.outputTokens).toBe(100)
  })

  it.each(['policy', 'capability', 'model', 'transcript', 'window', 'key'] as const)(
    'closes %s errors without cause/log/value or next dependency',
    async (phase) => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      infra[phase].mockImplementation(() => {
        throw new Error('PRIVATE_CANARY', { cause: 'PRIVATE_CAUSE' })
      })
      try {
        await expect(prepareLocalChatAdmission(fixture())).rejects.toMatchObject({
          message: unavailable,
        })
        const error = await prepareLocalChatAdmission(fixture()).catch((e) => e)
        expect(error.cause).toBeUndefined()
        expect(JSON.stringify(error)).not.toContain('PRIVATE')
        expect(spy).not.toHaveBeenCalled()
        if (phase !== 'key') expect(infra.key).not.toHaveBeenCalled()
        const phases = ['policy', 'capability', 'model', 'transcript', 'window', 'key'] as const
        for (const later of phases.slice(phases.indexOf(phase) + 1))
          expect(infra[later]).not.toHaveBeenCalled()
      } finally {
        spy.mockRestore()
      }
    }
  )

  it.each([
    undefined,
    null,
    { kind: 'unknown', version: 1 },
    { kind: 'memlia_local_chat', version: 2 },
  ])('refuses absent/invalid local opt-in before key', async (backend) => {
    const config = configuration()
    const { localBackend: _, ...without } = config
    infra.policy.mockImplementation(() => ({
      kind: 'installation_file_observation',
      policy: parseChatInstallationPolicy(
        backend === undefined ? without : { ...without, localBackend: backend }
      ),
    }))
    await expect(prepareLocalChatAdmission(fixture())).rejects.toThrow(unavailable)
    expect(infra.key).not.toHaveBeenCalled()
    expect(infra.capability).not.toHaveBeenCalled()
  })

  it.each(['catalogue_only', 'summary_only'])(
    'refuses insufficient workflow policy %s',
    async (workflow) => {
      infra.policy.mockImplementation(() => ({
        kind: 'installation_file_observation',
        policy: parseChatInstallationPolicy({
          ...configuration(),
          data: { ...configuration().data, workflow },
        }),
      }))
      await expect(prepareLocalChatAdmission(fixture())).rejects.toThrow(unavailable)
      expect(infra.key).not.toHaveBeenCalled()
    }
  )

  it.each([
    { principal: { kind: 'workspace_api_key', workspaceId: 'foreign', keyId: 'x' } },
    { principal: { kind: 'session', userId: '', sessionId: 'x' } },
    { organizationId: 'organization' },
    { request: { apiKey: 'foreign' } },
    { chatId: '' },
    { workflowId: '' },
    { currentMessage: { id: 'bad', content: 'text' } },
    { currentMessage: { id: fixture().currentMessage.id, content: 'x'.repeat(65537) } },
  ])('refuses malformed or extra authority input before any read (%#)', async (patch) => {
    await expect(prepareLocalChatAdmission({ ...fixture(), ...patch } as never)).rejects.toThrow(
      unavailable
    )
    expect(infra.policy).not.toHaveBeenCalled()
    expect(infra.key).not.toHaveBeenCalled()
  })

  it('does not evaluate a getter at capture', async () => {
    const input = fixture()
    const get = vi.fn(() => 'secret')
    Object.defineProperty(input.currentMessage, 'content', { enumerable: true, get })
    await expect(prepareLocalChatAdmission(input)).rejects.toThrow(unavailable)
    expect(get).not.toHaveBeenCalled()
    expect(infra.key).not.toHaveBeenCalled()
  })

  it.each(['id', 'version', 'model', 'profile'] as const)(
    'refuses inconsistent window %s before key',
    async (change) => {
      const budget = { windowId: 'window_1', windowVersion: 7, pricingProfile: profile() }
      if (change === 'id') budget.windowId = 'foreign'
      if (change === 'version') budget.windowVersion = 8
      if (change === 'model') budget.pricingProfile.model = 'foreign'
      if (change === 'profile') budget.pricingProfile.bounds.outputTokens = 0
      infra.window.mockResolvedValue(budget)
      await expect(prepareLocalChatAdmission(fixture())).rejects.toThrow(unavailable)
      expect(infra.key).not.toHaveBeenCalled()
    }
  )

  it('does not permit system or tool messages from a malformed loader result', async () => {
    infra.transcript.mockResolvedValue({ messages: [{ role: 'system', content: 'CANARY_SYSTEM' }] })
    await expect(prepareLocalChatAdmission(fixture())).rejects.toThrow(unavailable)
    expect(infra.key).not.toHaveBeenCalled()
  })

  it('refuses empty key without exposing it or falling back', async () => {
    infra.key.mockReturnValue('')
    await expect(prepareLocalChatAdmission(fixture())).rejects.toThrow(unavailable)
    expect(infra.key).toHaveBeenCalledExactlyOnceWith('openai')
  })
  it.each(['model', 'provider'] as const)(
    'uses the effective native %s denial before key selection',
    async (restriction) => {
      const native = await vi.importActual<
        typeof import('@/lib/permission-groups/permission-check')
      >('@/lib/permission-groups/permission-check')
      const resolve = await import('@/lib/permission-groups/resolve.server')
      const { DEFAULT_PERMISSION_GROUP_CONFIG } = await import('@/lib/permission-groups/fields')
      const lookup = vi.spyOn(resolve, 'getUserPermissionConfig').mockResolvedValue({
        ...DEFAULT_PERMISSION_GROUP_CONFIG,
        ...(restriction === 'model'
          ? { deniedModels: ['gpt-5.4'] }
          : { allowedModelProviders: [] }),
      })
      infra.model.mockImplementation(native.validateModelProvider)
      try {
        await expect(prepareLocalChatAdmission(fixture())).rejects.toThrow(unavailable)
        expect(lookup).toHaveBeenCalledWith('user-1', fixture().workspaceId, undefined)
        expect(infra.transcript).not.toHaveBeenCalled()
        expect(infra.key).not.toHaveBeenCalled()
      } finally {
        lookup.mockRestore()
      }
    }
  )
})

it.each(['disabled', 'absent'])(
  'refuses preparation before transcript, budget and key when native confirmation is %s',
  async (configuration) => {
    if (configuration === 'absent') resetEnvFlagsMock()
    else setEnvFlags({ isCopilotToolPermissionsEnabled: false })
    await expect(prepareLocalChatAdmission(fixture())).rejects.toThrow(unavailable)
    expect(infra.calls).toEqual(['policy', 'capability', 'model'])
    expect(infra.transcript).not.toHaveBeenCalled()
    expect(infra.window).not.toHaveBeenCalled()
    expect(infra.key).not.toHaveBeenCalled()
  }
)

it('admits Anthropic only after native permissions and captures the server API workspace', async () => {
  const anthropic = {
    ...configuration(),
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    anthropicWorkspaceId: 'wrkspc_Fictitious1234',
  }
  infra.policy.mockImplementation(() => ({ policy: parseChatInstallationPolicy(anthropic) }))
  infra.window.mockImplementation(async () => ({
    windowId: 'window_1',
    windowVersion: 7,
    pricingProfile: {
      ...profile(),
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      pricing: getModelPricing('claude-haiku-4-5')!,
      bounds: { contextTokens: 200000, outputTokens: 100 },
    },
  }))
  const result = await prepareLocalChatAdmission(fixture())
  expect(infra.key).toHaveBeenCalledExactlyOnceWith('anthropic')
  expect(result.localChat).toMatchObject({
    anthropicWorkspaceId: 'wrkspc_Fictitious1234',
    request: { model: 'claude-haiku-4-5' },
    budget: { pricingProfile: { provider: 'anthropic' } },
  })
  expect(result.localChat.request).not.toHaveProperty('anthropicWorkspaceId')
  expect(JSON.stringify(result.intent)).not.toContain('wrkspc_')
})

it('owns the policy primitives across native authorization before resolving a key', async () => {
  const config = {
    ...configuration(),
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    anthropicWorkspaceId: 'wrkspc_fixture123',
  }
  const policy = { ...parseChatInstallationPolicy(config) }
  infra.policy.mockReturnValue({ kind: 'installation_file_observation', policy })
  let release!: () => void
  infra.capability.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
  )
  infra.window.mockResolvedValue({
    windowId: 'window_1',
    windowVersion: 7,
    pricingProfile: {
      ...profile(),
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      pricing: getModelPricing('claude-haiku-4-5')!,
      bounds: { contextTokens: 200000, outputTokens: 100 },
    },
  })
  const pending = prepareLocalChatAdmission(fixture())
  // Untrusted mutation of the source object cannot alter the already selected server primitives.
  Object.assign(policy, {
    provider: 'openai',
    model: 'gpt-5.4',
    anthropicWorkspaceId: 'wrkspc_mutated123',
  })
  release()
  const result = await pending
  expect(result.localChat).toMatchObject({
    anthropicWorkspaceId: 'wrkspc_fixture123',
    request: { model: 'claude-haiku-4-5' },
  })
  expect(infra.key).toHaveBeenCalledExactlyOnceWith('anthropic')
})

it.each(['capability', 'model'] as const)(
  'preserves native Anthropic %s refusals before key lookup',
  async (port) => {
    infra.policy.mockReturnValue({
      kind: 'installation_file_observation',
      policy: parseChatInstallationPolicy({
        ...configuration(),
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
      }),
    })
    infra[port].mockRejectedValue(new Error('PRIVATE_PERMISSION_CANARY'))
    await expect(prepareLocalChatAdmission(fixture())).rejects.toThrow(unavailable)
    expect(infra.key).not.toHaveBeenCalled()
    expect(infra.window).not.toHaveBeenCalled()
  }
)
