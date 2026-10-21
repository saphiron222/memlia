// Copyright 2026 Memlia. All rights reserved.
import { randomUUID } from 'node:crypto'
import type { SessionPrincipal } from '@sim/auth/principal'
import { resolveBillingAttribution } from '@/lib/billing/core/attribution'
import { toDecimal } from '@/lib/billing/utils/decimal'
import { stringifyBoundedJson } from '@/lib/core/utils/bounded-json'
import {
  captureWorkflowProposalBinding,
  runCatalogProvider,
} from '@/lib/memlia/chat/provider-binding'
import { buildAnthropicModelUsage } from '@/providers/anthropic/usage'
import { LIST_PRICE_POLICY, type ModelUsage, priceModelUsage } from '@/providers/cost-policy'
import { getStaticProviderModels } from '@/providers/models'
import { OPENAI_CACHE_WRITE_MULTIPLIER } from '@/providers/openai/utils'
import { getModelPricing } from '@/providers/pricing'
import type { ProviderModelAttempt, ProviderModelObservation } from '@/providers/runtime-context'
import { type ChatPricingProfile, captureChatPricingProfile } from './chat-pricing-profile.server'
import {
  type CommittedCostReference,
  createCommittedChatCostAttempts,
} from './committed-cost-attempt.server'

type NativeOptions = Parameters<typeof runCatalogProvider>[0]
export type BudgetedCatalogProviderOptions = Omit<
  NativeOptions,
  'provider' | 'principal' | 'beforeModelTransport' | 'observeModelAttempt'
> & {
  /** Already authenticated and authorized by the server funnel, not established here. */
  principal: SessionPrincipal
  budget: { windowId: string; windowVersion: number; pricingProfile: ChatPricingProfile }
}
const failure = () => new Error('Budgeted catalogue model is unavailable.')
const validId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!

/** Own JSON and the explicit server proposal callback separately before any await. */
function capture(raw: BudgetedCatalogProviderOptions) {
  try {
    if (!raw || Object.getPrototypeOf(raw) !== Object.prototype) throw failure()
    const descriptors = Object.getOwnPropertyDescriptors(raw)
    const keys = new Set([
      'principal',
      'workspaceId',
      'request',
      'budget',
      'limits',
      'signal',
      'workflow',
      'proposal',
      'anthropicWorkspaceId',
    ])
    if (Reflect.ownKeys(raw).some((key) => typeof key !== 'string' || !keys.has(key)))
      throw failure()
    for (const d of Object.values(descriptors))
      if (!('value' in d) || !d.enumerable) throw failure()
    const signal: AbortSignal | undefined = descriptors.signal?.value
    if (signal !== undefined) signalAborted.call(signal)
    const proposal =
      descriptors.proposal?.value === undefined
        ? undefined
        : captureWorkflowProposalBinding(descriptors.proposal.value)
    const {
      signal: _signalDescriptor,
      proposal: _proposalDescriptor,
      ...jsonDescriptors
    } = descriptors
    const json = stringifyBoundedJson(
      Object.defineProperties({}, jsonDescriptors),
      2 * 1024 * 1024,
      {
        strict: true,
      }
    )
    if (json === undefined) throw failure()
    const input: Omit<BudgetedCatalogProviderOptions, 'signal' | 'proposal'> = JSON.parse(json)
    if (
      input.principal?.kind !== 'session' ||
      !validId(input.principal.userId) ||
      !validId(input.principal.sessionId) ||
      Object.keys(input.principal).sort().join(',') !== 'kind,sessionId,userId' ||
      !validId(input.workspaceId)
    )
      throw failure()
    if (
      !input.budget ||
      Object.keys(input.budget).sort().join(',') !== 'pricingProfile,windowId,windowVersion' ||
      !validId(input.budget.windowId) ||
      !Number.isSafeInteger(input.budget.windowVersion) ||
      input.budget.windowVersion < 1 ||
      input.budget.windowVersion > 2147483647
    )
      throw failure()
    const profile = captureChatPricingProfile(input.budget.pricingProfile)
    if (
      Object.hasOwn(input, 'anthropicWorkspaceId') &&
      (profile.profile.provider !== 'anthropic' ||
        typeof input.anthropicWorkspaceId !== 'string' ||
        !/^wrkspc_[A-Za-z0-9]{8,100}$/.test(input.anthropicWorkspaceId))
    )
      throw failure()
    if (
      input.request?.model !== profile.profile.model ||
      input.request.maxTokens !== profile.profile.bounds.outputTokens
    )
      throw failure()
    return { input, signal, profile, proposal }
  } catch {
    /* Never serialize input, native configuration errors or credentials. */
  }
  throw failure()
}

/** Registry, bounds and estimate are checked synchronously, without an await between them. */
function assertNativeProfile(captured: ReturnType<typeof captureChatPricingProfile>) {
  const profile = captured.profile
  const model = getStaticProviderModels(profile.provider).find(
    (entry) => entry.id === profile.model
  )
  const output = model?.capabilities?.maxOutputTokens
  if (
    !model ||
    model.contextWindow !== profile.bounds.contextTokens ||
    !Number.isSafeInteger(output) ||
    output! < profile.bounds.outputTokens
  )
    throw failure()
  const pricing = getModelPricing(profile.model)
  if (!pricing || captureChatPricingProfile({ ...profile, pricing }).hash !== captured.hash)
    throw failure()
  // Every interval has nonnegative constant rates. Its upper input endpoint and
  // each extreme cache allocation bound every mix, including a nonmonotone tier.
  // Output uses the enforced request ceiling. Native rounding/pricing is reused.
  const ends = new Set([
    profile.bounds.contextTokens,
    ...(pricing.tiers ?? [])
      .map((t) => t.aboveInputTokens)
      .filter((n) => n <= profile.bounds.contextTokens),
  ])
  for (const tokens of ends) {
    const usages: ModelUsage[] = [
      { input: tokens, output: profile.bounds.outputTokens },
      { input: 0, output: profile.bounds.outputTokens, cacheRead: tokens },
    ]
    if (profile.provider === 'anthropic') {
      usages.push(
        buildAnthropicModelUsage({
          input: 0,
          output: profile.bounds.outputTokens,
          cacheRead: 0,
          cacheWriteFiveMinute: tokens,
          cacheWriteOneHour: 0,
        }),
        buildAnthropicModelUsage({
          input: 0,
          output: profile.bounds.outputTokens,
          cacheRead: 0,
          cacheWriteFiveMinute: 0,
          cacheWriteOneHour: tokens,
        })
      )
    } else {
      usages.push({
        input: 0,
        output: profile.bounds.outputTokens,
        cacheWrites: [{ tokens, inputRateMultiplier: OPENAI_CACHE_WRITE_MULTIPLIER }],
      })
    }
    for (const usage of usages) {
      const amount = priceModelUsage(profile.model, usage, LIST_PRICE_POLICY).total
      if (
        !Number.isFinite(amount) ||
        amount < 0 ||
        toDecimal(amount.toString()).gt(profile.maximumCostUsd)
      )
        throw failure()
    }
  }
}

/**
 * Estimated native-list-price budget only. A session-shaped value is not proof
 * of authentication/permissions; the trusted caller must establish both first.
 * No provider credential is resolved and no route is activated by this helper.
 */
export async function runBudgetedCatalogProvider(raw: BudgetedCatalogProviderOptions) {
  const { input, signal, profile, proposal } = capture(raw)
  try {
    assertNativeProfile(profile)
  } catch {
    throw failure()
  }
  if (signal !== undefined && signalAborted.call(signal)) throw failure()
  let attribution: Awaited<ReturnType<typeof resolveBillingAttribution>>
  try {
    attribution = await resolveBillingAttribution({
      actorUserId: input.principal.userId,
      workspaceId: input.workspaceId,
    })
  } catch {
    throw failure()
  }
  const committed = createCommittedChatCostAttempts()
  const references = new WeakMap<
    ProviderModelAttempt,
    { reference?: CommittedCostReference; closed: boolean }
  >()
  const { budget: _budget, ...binding } = input
  return runCatalogProvider({
    ...binding,
    provider: profile.profile.provider,
    signal,
    ...(proposal ? { proposal } : {}),
    async beforeModelTransport(abort, attempt) {
      if (!attempt || references.has(attempt)) throw failure()
      const owned: { reference?: CommittedCostReference; closed: boolean } = { closed: false }
      references.set(attempt, owned)
      try {
        assertNativeProfile(profile)
      } catch {
        throw failure()
      }
      const result = await committed.reserve(
        {
          windowId: input.budget.windowId,
          windowVersion: input.budget.windowVersion,
          attemptId: randomUUID(),
          attribution,
          maximumCostUsd: profile.profile.maximumCostUsd,
          expectedPricingProfileHash: profile.hash,
        },
        abort
      )
      if (result.kind !== 'reserved_committed') throw failure()
      if (owned.closed) throw failure()
      owned.reference = result.reference
      // A registry change while COMMIT awaited cannot authorize a different tariff.
      // On refusal, the native terminal not_sent observation retains this hold.
      try {
        assertNativeProfile(profile)
      } catch {
        throw failure()
      }
    },
    async observeModelAttempt(attempt, observation: ProviderModelObservation) {
      const owned = references.get(attempt)
      if (!owned || owned.closed) throw failure()
      owned.closed = true
      if (!owned.reference) throw failure()
      let amount: string | undefined
      let invalid = false
      if (observation.kind === 'usage') {
        try {
          assertNativeProfile(profile)
          if (observation.cost.kind !== 'list_price_estimate') throw failure()
          const cost = priceModelUsage(
            profile.profile.model,
            observation.usage,
            LIST_PRICE_POLICY
          ).total
          if (!Number.isFinite(cost) || cost <= 0 || cost !== observation.cost.usd) throw failure()
          amount = toDecimal(cost.toString()).toFixed()
        } catch {
          invalid = true
        }
      }
      // No abort here: known spend remains recordable after stream cancellation.
      const settled = await committed.settle(
        owned.reference,
        amount === undefined ? { kind: 'unknown' } : { kind: 'known', finalCostUsd: amount }
      )
      if (
        invalid ||
        (settled.kind !== 'settled_committed' && settled.kind !== 'retained_committed')
      )
        throw failure()
    },
  })
}
