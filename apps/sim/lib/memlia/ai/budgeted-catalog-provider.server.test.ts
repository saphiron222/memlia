// Copyright 2026 Memlia. All rights reserved.
// Native profile/pricing, COMMIT reference port and provider observation lifecycle.
// SQL/transaction ACK and downstream transport are infrastructure doubles, not PG proof.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const infra = vi.hoisted(() => ({
  transaction: vi.fn(),
  reserve: vi.fn(),
  settle: vi.fn(),
  attribution: vi.fn(),
  binding: vi.fn(),
}))
vi.mock('@sim/db', () => ({ db: { transaction: infra.transaction } }))
vi.mock('./cost-reservation.server', () => ({
  reserveChatCost: infra.reserve,
  settleChatCost: infra.settle,
}))
vi.mock('@/lib/billing/core/attribution', () => ({ resolveBillingAttribution: infra.attribution }))
vi.mock('@/lib/memlia/chat/provider-binding', () => ({
  captureWorkflowProposalBinding: vi.fn(() => {
    throw new Error('No fixture proposal')
  }),
  runCatalogProvider: infra.binding,
}))

import { observeAnthropicUsage } from '@/providers/anthropic/usage'
import { getStaticProviderModels } from '@/providers/models'
import { getModelPricing } from '@/providers/pricing'
import {
  beginProviderModelAttempt,
  completeProviderModelAttempt,
  runWithProviderRuntimeContext,
} from '@/providers/runtime-context'
import {
  type BudgetedCatalogProviderOptions,
  runBudgetedCatalogProvider,
} from './budgeted-catalog-provider.server'

const fixture = (): BudgetedCatalogProviderOptions => ({
  principal: { kind: 'session', userId: 'fixture-user', sessionId: 'fixture-session' },
  workspaceId: 'fixture-workspace',
  anthropicWorkspaceId: 'wrkspc_fixture123',
  request: { model: 'claude-haiku-4-5', maxTokens: 100, apiKey: 'FICTITIOUS_KEY', messages: [] },
  budget: {
    windowId: 'fixture-window',
    windowVersion: 1,
    pricingProfile: {
      version: 1,
      basis: 'native_list_price_estimate_v1',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      pricing: structuredClone(getModelPricing('claude-haiku-4-5')!),
      bounds: { contextTokens: 200000, outputTokens: 100 },
      maximumCostUsd: '1',
    },
  },
})
const response = () => ({
  stop_reason: 'end_turn',
  usage: {
    input_tokens: 10,
    output_tokens: 20,
    cache_read_input_tokens: 30,
    cache_creation_input_tokens: 50,
    cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 40 },
    service_tier: 'standard',
  },
})
type Binding = Parameters<typeof import('@/lib/memlia/chat/provider-binding').runCatalogProvider>[0]
const sent = vi.fn()
function emulateTurn(options: Binding, message: unknown = response()) {
  return runWithProviderRuntimeContext(
    {
      controlledRun: {
        signal: options.signal ?? new AbortController().signal,
        beforeModelCall() {},
        beforeModelTransport: options.beforeModelTransport,
        observeModelAttempt: options.observeModelAttempt,
        async executeTool() {
          throw new Error('No fixture tool')
        },
      },
    },
    async () => {
      const { reference } = await beginProviderModelAttempt()
      sent()
      await completeProviderModelAttempt(
        reference,
        observeAnthropicUsage(options.request.model, message)
      )
    }
  )
}
beforeEach(() => {
  vi.resetAllMocks()
  infra.attribution.mockResolvedValue({
    actorUserId: 'fixture-user',
    workspaceId: 'fixture-workspace',
    billedAccountUserId: 'fixture-user',
  })
  infra.transaction.mockImplementation(async (callback: (tx: object) => Promise<unknown>) =>
    callback({})
  )
  infra.reserve.mockImplementation(async (_tx: unknown, input: { attemptId: string }) => ({
    kind: 'reserved_in_transaction',
    created: true,
    attemptId: input.attemptId,
    pricingProfile: fixture().budget.pricingProfile,
  }))
  infra.settle.mockResolvedValue({ kind: 'settled_in_transaction', duplicate: false })
  infra.binding.mockImplementation(emulateTurn)
})
describe('Anthropic budget wrapper with native COMMIT and observation ports', () => {
  it('prices disjoint TTL buckets with native tariffs and the committed profile hash', async () => {
    await runBudgetedCatalogProvider(fixture())
    expect(sent).toHaveBeenCalledOnce()
    expect(infra.reserve).toHaveBeenCalledOnce()
    expect(infra.settle).toHaveBeenCalledOnce()
    expect(infra.settle.mock.calls[0][1]).toMatchObject({
      outcome: { kind: 'known', finalCostUsd: '0.0002055' },
      expectedPricingProfileHash: infra.reserve.mock.calls[0][1].expectedPricingProfileHash,
    })
  })
  it('includes the native 2x one-hour cache extreme in the reservation bound before attribution', async () => {
    const input = fixture()
    input.budget.pricingProfile.maximumCostUsd = '0.3'
    await expect(runBudgetedCatalogProvider(input)).rejects.toThrow(
      'Budgeted catalogue model is unavailable.'
    )
    expect(infra.attribution).not.toHaveBeenCalled()
    expect(sent).not.toHaveBeenCalled()
  })
  it('does not send after a transaction callback until its COMMIT acknowledgement', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    infra.transaction.mockImplementationOnce(async (callback: (tx: object) => Promise<unknown>) => {
      const result = await callback({})
      await gate
      return result
    })
    const running = runBudgetedCatalogProvider(fixture())
    await vi.waitFor(() => expect(infra.reserve).toHaveBeenCalledOnce())
    expect(sent).not.toHaveBeenCalled()
    release()
    await running
    expect(sent).toHaveBeenCalledOnce()
  })
  it('retains missing usage as unknown, never zero', async () => {
    infra.binding.mockImplementation((options: Binding) =>
      emulateTurn(options, { stop_reason: 'end_turn', usage: {} })
    )
    infra.settle.mockResolvedValue({ kind: 'retained_in_transaction', reason: 'unknown_cost' })
    await runBudgetedCatalogProvider(fixture())
    expect(infra.settle.mock.calls[0][1].outcome).toEqual({ kind: 'unknown' })
  })
  it.each(['reserve', 'settle'] as const)(
    'never retries a lost %s ACK or exposes its cause',
    async (phase) => {
      const reject = async () => {
        throw Object.assign(new Error('PRIVATE_ACK_CANARY'), { cause: 'PRIVATE_CAUSE' })
      }
      if (phase === 'reserve') infra.transaction.mockImplementationOnce(reject)
      else
        infra.transaction
          .mockImplementationOnce(async (callback: (tx: object) => Promise<unknown>) =>
            callback({})
          )
          .mockImplementationOnce(reject)
      await expect(runBudgetedCatalogProvider(fixture())).rejects.toThrow(
        'Server model observation failed.'
      )
      expect(sent).toHaveBeenCalledTimes(phase === 'reserve' ? 0 : 1)
      expect(infra.transaction).toHaveBeenCalledTimes(phase === 'reserve' ? 1 : 2)
    }
  )
  it('settles known spend even after cancellation, without resetting the signal', async () => {
    const abort = new AbortController()
    infra.binding.mockImplementation((options: Binding) =>
      runWithProviderRuntimeContext(
        {
          controlledRun: {
            signal: abort.signal,
            beforeModelCall() {},
            beforeModelTransport: options.beforeModelTransport,
            observeModelAttempt: options.observeModelAttempt,
            async executeTool() {
              throw new Error('No tool')
            },
          },
        },
        async () => {
          const { reference } = await beginProviderModelAttempt()
          sent()
          abort.abort()
          await completeProviderModelAttempt(
            reference,
            observeAnthropicUsage(options.request.model, response())
          )
        }
      )
    )
    await runBudgetedCatalogProvider({ ...fixture(), signal: abort.signal })
    expect(abort.signal.aborted).toBe(true)
    expect(infra.settle.mock.calls[0][1].outcome.kind).toBe('known')
  })
  it('owns profile and server workspace before the first await', async () => {
    let release!: () => void
    infra.attribution.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ actorUserId: 'fixture-user' })
        })
    )
    const input = fixture()
    const running = runBudgetedCatalogProvider(input)
    input.anthropicWorkspaceId = 'wrkspc_mutated123'
    input.budget.pricingProfile.provider = 'openai'
    input.budget.pricingProfile.pricing.input = 999
    release()
    await running
    expect(infra.binding.mock.calls[0][0]).toMatchObject({
      provider: 'anthropic',
      anthropicWorkspaceId: 'wrkspc_fixture123',
    })
    expect(infra.binding.mock.calls[0][0]).not.toHaveProperty('budget')
  })
  it('rejects registry drift across a COMMIT wait before send and retains the hold', async () => {
    const model = getStaticProviderModels('anthropic').find(
      (entry) => entry.id === 'claude-haiku-4-5'
    )!
    const original = model.contextWindow
    infra.transaction.mockImplementationOnce(async (callback: (tx: object) => Promise<unknown>) => {
      const result = await callback({})
      model.contextWindow = 1
      return result
    })
    infra.settle.mockResolvedValue({ kind: 'retained_in_transaction', reason: 'unknown_cost' })
    try {
      await expect(runBudgetedCatalogProvider(fixture())).rejects.toThrow(
        'Server model transport guard refused.'
      )
      expect(sent).not.toHaveBeenCalled()
      expect(infra.settle.mock.calls[0][1].outcome).toEqual({ kind: 'unknown' })
    } finally {
      model.contextWindow = original
    }
  })
  it('rejects wrong provider/workspace and a request/profile mismatch before any ledger call', async () => {
    for (const input of [
      { ...fixture(), anthropicWorkspaceId: 'PRIVATE_INVALID' },
      { ...fixture(), request: { ...fixture().request, model: 'gpt-5.4' } },
      {
        ...fixture(),
        budget: {
          ...fixture().budget,
          pricingProfile: { ...fixture().budget.pricingProfile, provider: 'openai' as const },
        },
      },
    ])
      await expect(runBudgetedCatalogProvider(input)).rejects.toThrow(
        'Budgeted catalogue model is unavailable.'
      )
    expect(infra.attribution).not.toHaveBeenCalled()
    expect(infra.reserve).not.toHaveBeenCalled()
  })
})
