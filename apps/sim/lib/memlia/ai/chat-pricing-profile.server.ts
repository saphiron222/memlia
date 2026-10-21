// Copyright 2026 Memlia. All rights reserved.
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { stringifyBoundedJson } from '@/lib/core/utils/bounded-json'

const rate = z.number().finite().nonnegative().max(999999999)
const tokens = z.number().int().positive().max(1_000_000_000)
const rates = z.object({ input: rate, cachedInput: rate.optional(), output: rate }).strict()
const tier = rates
  .extend({ aboveInputTokens: z.number().int().nonnegative().max(1_000_000_000) })
  .strict()
const pricing = rates
  .extend({
    updatedAt: z
      .string()
      .min(1)
      .max(64)
      .refine(
        (value) =>
          /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/.test(value) &&
          Number.isFinite(Date.parse(value)) &&
          new Date(value).toISOString().slice(0, 10) === value.slice(0, 10)
      ),
    tiers: z.array(tier).max(32).optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.tiers?.every(
        (t, i, all) => i === 0 || all[i - 1]!.aboveInputTokens < t.aboveInputTokens
      ) ?? true
  )
const schema = z
  .object({
    version: z.literal(1),
    basis: z.literal('native_list_price_estimate_v1'),
    provider: z.enum(['openai', 'anthropic']),
    model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/),
    pricing,
    bounds: z
      .object({ contextTokens: tokens, outputTokens: tokens })
      .strict()
      .refine((value) => value.outputTokens <= value.contextTokens),
    maximumCostUsd: z
      .string()
      .regex(/^(0|[1-9]\d{0,8})(?:\.\d{1,12})?$/)
      .refine((value) => {
        if (!/^(0|[1-9]\d{0,8})(?:\.\d{1,12})?$/.test(value)) return false
        const [whole, fraction = ''] = value.split('.')
        const exact = BigInt(whole!) * 1_000_000_000_000n + BigInt(fraction.padEnd(12, '0'))
        return exact > 0n && exact <= 999_999_999n * 1_000_000_000_000n
      }),
  })
  .strict()

export type ChatPricingProfile = z.infer<typeof schema>

/** Fixed V1 schema order is canonical, including tier order; no caller getters or coercion. */
export function captureChatPricingProfile(raw: unknown): Readonly<{
  profile: ChatPricingProfile
  hash: string
}> {
  try {
    const json = stringifyBoundedJson(raw, 8192, { strict: true })
    if (json === undefined) throw new Error()
    const profile = schema.parse(JSON.parse(json))
    const hash = createHash('sha256').update(JSON.stringify(profile)).digest('hex')
    if (profile.pricing.tiers) {
      for (const value of profile.pricing.tiers) Object.freeze(value)
      Object.freeze(profile.pricing.tiers)
    }
    Object.freeze(profile.pricing)
    Object.freeze(profile.bounds)
    Object.freeze(profile)
    return Object.freeze({ profile, hash })
  } catch {
    // Outside error serialization: no values, Zod issues, cause or caller object.
  }
  throw new Error('Chat pricing profile is unavailable.')
}
