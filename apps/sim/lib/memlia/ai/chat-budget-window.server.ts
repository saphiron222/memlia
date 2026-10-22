// Copyright 2026 Memlia. All rights reserved.
import { db } from '@sim/db'
import { memliaChatCostWindow as window } from '@sim/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { stringifyBoundedJson } from '@/lib/core/utils/bounded-json'
import { type ChatPricingProfile, captureChatPricingProfile } from './chat-pricing-profile.server'

const selection = z
  .object({
    windowId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    windowVersion: z.number().int().positive().max(2147483647),
    model: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/),
  })
  .strict()

/** Primary metadata observation only, never authorization, reservation or send permission. */
export async function readChatBudgetWindow(raw: unknown): Promise<
  Readonly<{
    windowId: string
    windowVersion: number
    pricingProfile: ChatPricingProfile
  }>
> {
  try {
    // Capture the explicit server selection before the first await; no caller getters.
    const json = stringifyBoundedJson(raw, 1024, { strict: true })
    if (json === undefined) throw new Error()
    const input = selection.parse(JSON.parse(json))
    const [row] = await db
      .select({ pricingProfile: window.pricingProfile })
      .from(window)
      .where(
        and(
          eq(window.id, input.windowId),
          eq(window.version, input.windowVersion),
          eq(window.state, 'open'),
          eq(window.currency, 'USD'),
          sql`${window.startsAt} <= clock_timestamp()`,
          sql`${window.endsAt} > clock_timestamp()`
        )
      )
      .limit(1)
    if (!row) throw new Error()
    const captured = captureChatPricingProfile(row.pricingProfile)
    if (captured.profile.model !== input.model) throw new Error()
    return Object.freeze({
      windowId: input.windowId,
      windowVersion: input.windowVersion,
      pricingProfile: captured.profile,
    })
  } catch {
    // No driver message, SQL, profile value, Zod issue, caller input or cause escapes.
  }
  throw new Error('Chat budget window is unavailable.')
}
