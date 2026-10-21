// Copyright 2026 Memlia. All rights reserved.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { captureChatPricingProfile } from './chat-pricing-profile.server'

const fixture = () => ({
  version: 1,
  basis: 'native_list_price_estimate_v1',
  provider: 'openai',
  model: 'gpt-5.4',
  pricing: {
    input: 2.5,
    cachedInput: 0.25,
    output: 15,
    updatedAt: '2026-10-01',
    tiers: [{ aboveInputTokens: 272000, input: 5, output: 22.5 }],
  },
  bounds: { contextTokens: 1000000, outputTokens: 128000 },
  maximumCostUsd: '0.75',
})

test('profile capture is canonical across JSONB key order, frozen and independent', () => {
  const input = fixture()
  const captured = captureChatPricingProfile(input)
  const reordered = JSON.parse(JSON.stringify(input), (_, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).reverse())
      : value
  )
  assert.equal(captureChatPricingProfile(reordered).hash, captured.hash)
  input.pricing.tiers[0]!.input = 100
  assert.equal(captured.profile.pricing.tiers![0]!.input, 5)
  assert.ok(Object.isFrozen(captured.profile.pricing.tiers![0]))
  assert.ok(Object.isFrozen(captured.profile.bounds))
  assert.match(captured.hash, /^[a-f0-9]{64}$/)
})
test('every provenance field changes the deterministic fingerprint', () => {
  const original = captureChatPricingProfile(fixture()).hash
  for (const change of [
    (p: ReturnType<typeof fixture>) => {
      p.model = 'gpt-5.5'
    },
    (p: ReturnType<typeof fixture>) => {
      p.pricing.updatedAt = '2026-10-02'
    },
    (p: ReturnType<typeof fixture>) => {
      p.pricing.tiers[0]!.output = 23
    },
    (p: ReturnType<typeof fixture>) => {
      p.bounds.outputTokens = 100000
    },
    (p: ReturnType<typeof fixture>) => {
      p.maximumCostUsd = '0.8'
    },
  ]) {
    const input = fixture()
    change(input)
    assert.notEqual(captureChatPricingProfile(input).hash, original)
  }
})
test('strict profile refuses getters, lossy JSON, excessive values and unknown fields', () => {
  let getters = 0
  const accessor = fixture()
  Object.defineProperty(accessor.pricing, 'input', {
    get() {
      getters++
      return 2.5
    },
    enumerable: true,
  })
  const hidden = fixture()
  Object.defineProperty(hidden, 'hidden', { value: 'private', enumerable: false })
  const sparse = fixture()
  Reflect.deleteProperty(sparse.pricing.tiers, '0')
  const wrongs: unknown[] = [
    accessor,
    hidden,
    sparse,
    { ...fixture(), extra: 'private' },
    { ...fixture(), provider: 'azure-anthropic' },
    { ...fixture(), version: 2 },
    { ...fixture(), maximumCostUsd: '999999999.000000000001' },
    { ...fixture(), maximumCostUsd: '0' },
    { ...fixture(), maximumCostUsd: '1e-8' },
    { ...fixture(), pricing: { ...fixture().pricing, input: Number.POSITIVE_INFINITY } },
    { ...fixture(), pricing: { ...fixture().pricing, updatedAt: '2026-02-30' } },
    {
      ...fixture(),
      pricing: { ...fixture().pricing, tiers: Array(33).fill(fixture().pricing.tiers[0]) },
    },
    { ...fixture(), bounds: { contextTokens: 10, outputTokens: 11 } },
  ]
  for (const input of wrongs)
    assert.throws(() => captureChatPricingProfile(input), {
      message: 'Chat pricing profile is unavailable.',
    })
  assert.equal(getters, 0)
})

test('native complete pricing snapshot roundtrips without changing rates or tiers', async () => {
  const { getModelPricing } = await import('@/providers/pricing')
  const pricing = getModelPricing('gpt-5.4')
  assert.ok(pricing, 'fixture requires a registered native model')
  const captured = captureChatPricingProfile({ ...fixture(), pricing })
  assert.deepEqual(captured.profile.pricing, pricing)
  assert.notEqual(captured.profile.pricing, pricing)
})

test('keeps the historical OpenAI canonical hash and adds a distinct Anthropic profile', () => {
  assert.equal(
    captureChatPricingProfile(fixture()).hash,
    '9b2d7566a2294300fae8a699ebb8bcb16a7341d4a438d513c986a886886854b1'
  )
  const captured = captureChatPricingProfile({
    ...fixture(),
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    pricing: { input: 1, cachedInput: 0.1, output: 5, updatedAt: '2026-09-04' },
    bounds: { contextTokens: 200000, outputTokens: 100 },
    maximumCostUsd: '1',
  })
  assert.equal(captured.profile.provider, 'anthropic')
  assert.notEqual(captured.hash, captureChatPricingProfile(fixture()).hash)
})
