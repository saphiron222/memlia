import { describe, expect, it, vi } from 'vitest'
import {
  addAnthropicUsage,
  buildAnthropicUsageCost,
  buildAnthropicUsageTokens,
  createAnthropicUsageAccumulator,
  observeAnthropicUsage,
  toAnthropicModelUsage,
} from '@/providers/anthropic/usage'

const MODEL = 'claude-sonnet-4-5'

describe('Anthropic usage aggregation', () => {
  it('captures one model turn with separate cache tiers and uncached input', () => {
    expect(
      toAnthropicModelUsage({
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 50,
        cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 40 },
      })
    ).toEqual({
      input: 10,
      output: 20,
      cacheRead: 30,
      cacheWrites: [
        { tokens: 10, inputRateMultiplier: 1.25 },
        { tokens: 40, inputRateMultiplier: 2 },
      ],
    })
  })

  it('prices uncached input and output normally', () => {
    const usage = createAnthropicUsageAccumulator()
    addAnthropicUsage(usage, { input_tokens: 1_000_000, output_tokens: 1_000_000 })

    expect(buildAnthropicUsageTokens(usage)).toEqual({
      input: 1_000_000,
      output: 1_000_000,
      total: 2_000_000,
      cacheRead: 0,
      cacheWrite: 0,
    })
    expect(buildAnthropicUsageCost(MODEL, usage)).toMatchObject({
      input: 3,
      output: 15,
      total: 18,
    })
  })

  it('prices cache reads at cached-input rates without discounting uncached input', () => {
    const usage = createAnthropicUsageAccumulator()
    addAnthropicUsage(usage, {
      input_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
      output_tokens: 0,
    })

    expect(buildAnthropicUsageCost(MODEL, usage)).toMatchObject({
      input: 3.3,
      output: 0,
      total: 3.3,
    })
  })

  it('prices cache writes without details at the default five-minute tier', () => {
    const usage = createAnthropicUsageAccumulator()
    addAnthropicUsage(usage, {
      input_tokens: 0,
      cache_creation_input_tokens: 1_000_000,
      output_tokens: 0,
    })

    expect(buildAnthropicUsageCost(MODEL, usage)).toMatchObject({
      input: 3.75,
      total: 3.75,
    })
  })

  it('prices one-hour cache writes at twice the normal input rate', () => {
    const usage = createAnthropicUsageAccumulator()
    addAnthropicUsage(usage, {
      input_tokens: 0,
      cache_creation_input_tokens: 1_000_000,
      cache_creation: {
        ephemeral_5m_input_tokens: 0,
        ephemeral_1h_input_tokens: 1_000_000,
      },
      output_tokens: 0,
    })

    expect(buildAnthropicUsageCost(MODEL, usage)).toMatchObject({
      input: 6,
      total: 6,
    })
  })

  it('aggregates mixed uncached, read, five-minute, one-hour, and output usage', () => {
    const usage = createAnthropicUsageAccumulator()
    addAnthropicUsage(usage, {
      input_tokens: 100_000,
      cache_read_input_tokens: 200_000,
      cache_creation_input_tokens: 300_000,
      cache_creation: {
        ephemeral_5m_input_tokens: 100_000,
        ephemeral_1h_input_tokens: 200_000,
      },
      output_tokens: 400_000,
    })

    expect(buildAnthropicUsageTokens(usage)).toEqual({
      input: 100_000,
      output: 400_000,
      total: 1_000_000,
      cacheRead: 200_000,
      cacheWrite: 300_000,
    })
    expect(buildAnthropicUsageCost(MODEL, usage)).toMatchObject({
      input: 1.935,
      output: 6,
      total: 7.935,
    })
  })

  it('accumulates each stream turn exactly once', () => {
    const usage = createAnthropicUsageAccumulator()
    addAnthropicUsage(usage, {
      input_tokens: 10,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 30,
      output_tokens: 40,
    })
    addAnthropicUsage(usage, {
      input_tokens: 1,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 3,
      output_tokens: 4,
    })

    expect(buildAnthropicUsageTokens(usage)).toEqual({
      input: 11,
      output: 44,
      total: 110,
      cacheRead: 22,
      cacheWrite: 33,
    })
  })
})

describe('strict controlled Anthropic usage observation', () => {
  const complete = () => ({
    stop_reason: 'end_turn',
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 50,
      cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 40 },
      service_tier: 'standard',
      server_tool_use: null,
    },
  })
  it('prices disjoint native 5m/1h cache buckets at standard list price', () => {
    expect(observeAnthropicUsage('claude-haiku-4-5', complete())).toEqual({
      kind: 'usage',
      usage: {
        input: 10,
        output: 20,
        cacheRead: 30,
        cacheWrites: [
          { tokens: 10, inputRateMultiplier: 1.25 },
          { tokens: 40, inputRateMultiplier: 2 },
        ],
      },
      cost: { kind: 'list_price_estimate', usd: 0.0002055 },
    })
  })
  it.each([
    'input_tokens',
    'output_tokens',
    'cache_read_input_tokens',
    'cache_creation_input_tokens',
  ])('never converts an absent or invalid %s into zero-cost evidence', (field) => {
    for (const invalid of [
      undefined,
      null,
      -1,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '1',
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      const message = complete()
      Reflect.set(message.usage, field, invalid)
      expect(observeAnthropicUsage('claude-haiku-4-5', message)).toEqual({
        kind: 'unknown',
        reason: 'usage_unavailable',
      })
    }
  })
  it.each([
    null,
    undefined,
    {},
    { ephemeral_5m_input_tokens: 50 },
    { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 39 },
    { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 40, foreign: 1 },
    { ephemeral_5m_input_tokens: -1, ephemeral_1h_input_tokens: 51 },
  ])('retains unknown cost for missing, contradictory or malformed cache TTLs (%#)', (cache) => {
    const message = complete()
    Reflect.set(message.usage, 'cache_creation', cache)
    expect(observeAnthropicUsage('claude-haiku-4-5', message)).toEqual({
      kind: 'unknown',
      reason: 'usage_unavailable',
    })
  })
  it.each(['priority', 'batch', null, undefined])(
    'refuses non-standard or missing service tier %s',
    (tier) => {
      const message = complete()
      Reflect.set(message.usage, 'service_tier', tier)
      expect(observeAnthropicUsage('claude-haiku-4-5', message)).toEqual({
        kind: 'unknown',
        reason: 'usage_unavailable',
      })
    }
  )
  it('does not coerce an unknown stop reason or accept unpriced server tools', () => {
    const message = complete()
    const coerceStop = vi.fn(() => 'end_turn')
    Reflect.set(message, 'stop_reason', { toString: coerceStop })
    expect(observeAnthropicUsage('claude-haiku-4-5', message).kind).toBe('unknown')
    expect(coerceStop).not.toHaveBeenCalled()
    Reflect.set(message, 'stop_reason', 'end_turn')
    Reflect.set(message.usage, 'server_tool_use', { web_search_requests: 1, web_fetch_requests: 0 })
    expect(observeAnthropicUsage('claude-haiku-4-5', message).kind).toBe('unknown')
  })
  it('reports missing native pricing without inventing an invoice or fallback rate', () => {
    expect(observeAnthropicUsage('not-a-native-model', complete())).toMatchObject({
      kind: 'usage',
      cost: { kind: 'unavailable' },
    })
  })
})
