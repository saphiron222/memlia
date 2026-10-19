// Copyright 2026 Memlia. All rights reserved.
import { isDeepStrictEqual } from 'node:util'
import {
  memliaChatCostReservation as reservation,
  memliaChatCostWindow as window,
  usageLog,
  user,
  workspace,
} from '@sim/db/schema'
import { eq, getTableColumns, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  assertBillingAttributionSnapshot,
  type BillingAttributionSnapshot,
} from '@/lib/billing/core/attribution'
import { recordUsage, stableEventKey } from '@/lib/billing/core/usage-log'
import { toDecimal } from '@/lib/billing/utils/decimal'
import { stringifyBoundedJson } from '@/lib/core/utils/bounded-json'
import type { DbTransaction } from '@/lib/db/types'
import { captureChatPricingProfile, type ChatPricingProfile } from './chat-pricing-profile.server'

/** Canonical decimal USD text; runtime validation must precede the first await. */
export type ChatCostUsd = string

export interface ChatCostAttempt {
  readonly windowId: string
  readonly windowVersion: number
  readonly attemptId: string
  /** Resolved by the trusted server; a typed snapshot is not authentication. */
  readonly attribution: BillingAttributionSnapshot
  readonly maximumCostUsd: ChatCostUsd
  readonly expectedPricingProfileHash?: string
}

export type ChatCostRefusal =
  | 'invalid_input'
  | 'window_unavailable'
  | 'window_changed'
  | 'attribution_changed'
  | 'budget_exhausted'
  | 'identity_conflict'
  | 'reconciliation_required'

export type ChatCostReservationResult =
  | Readonly<{
      kind: 'reserved_in_transaction'
      attemptId: string
      created: boolean
      pricingProfile?: ChatPricingProfile
    }>
  | Readonly<{ kind: 'refused'; reason: ChatCostRefusal }>

export interface ChatCostSettlement {
  readonly windowId: string
  readonly windowVersion: number
  readonly attemptId: string
  readonly expectedPricingProfileHash?: string
  /** Missing usage is never represented as known zero. */
  readonly outcome:
    | Readonly<{ kind: 'unknown' }>
    | Readonly<{ kind: 'known'; finalCostUsd: ChatCostUsd }>
}

export type ChatCostSettlementResult =
  | Readonly<{ kind: 'settled_in_transaction'; attemptId: string; duplicate: boolean }>
  | Readonly<{
      kind: 'settled_and_blocked_in_transaction'
      attemptId: string
      reason: 'cost_exceeded_reservation'
    }>
  | Readonly<{ kind: 'retained_in_transaction'; reason: 'unknown_cost' }>
  | Readonly<{ kind: 'refused'; reason: ChatCostRefusal }>

/**
 * Caller must supply a real active native transaction, never the pool.
 * A result before COMMIT is provisional, not authority, ownership or send permission.
 * DB exceptions have fixed messages and remain exceptions so a caller rolls back.
 */
export interface ChatCostReservationPort {
  reserveChatCost(tx: DbTransaction, input: ChatCostAttempt): Promise<ChatCostReservationResult>
  settleChatCost(tx: DbTransaction, input: ChatCostSettlement): Promise<ChatCostSettlementResult>
}

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const usd = z.string().regex(/^(0|[1-9]\d{0,8})(?:\.\d{1,12})?$/)
const attemptSchema = z
  .object({
    windowId: id,
    windowVersion: z.number().int().positive().max(2147483647),
    attemptId: id,
    attribution: z.unknown(),
    maximumCostUsd: usd,
    expectedPricingProfileHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict()
const settlementSchema = z
  .object({
    windowId: id,
    windowVersion: z.number().int().positive().max(2147483647),
    attemptId: id,
    expectedPricingProfileHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    outcome: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('unknown') }).strict(),
      z.object({ kind: z.literal('known'), finalCostUsd: usd }).strict(),
    ]),
  })
  .strict()
const SCALE = 1_000_000_000_000n
const MAX_UNITS = 999_999_999n * SCALE
const refusal = (reason: ChatCostRefusal) => ({ kind: 'refused', reason }) as const
type Stored = typeof reservation.$inferSelect

export class ChatCostPersistenceError extends Error {
  constructor(readonly code: 'transaction_required' | 'persistence_unknown') {
    super(code)
    this.name = 'ChatCostPersistenceError'
  }
}

function units(value: string): bigint {
  const [whole, fraction = ''] = value.split('.')
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(12, '0'))
}

function snapshot(value: unknown): unknown {
  const captured = stringifyBoundedJson(value, 16_384, { strict: true })
  if (captured === undefined) throw new Error('invalid_input')
  return JSON.parse(captured)
}

function requireTransaction(tx: DbTransaction) {
  if (!tx || typeof tx.rollback !== 'function')
    throw new ChatCostPersistenceError('transaction_required')
}

async function configure(tx: DbTransaction) {
  // pg_settings exposes normalized integer milliseconds, not formatted duration text.
  // Keep any stricter caller-local bound and cap zero (disabled) or larger values.
  const configured = await tx.execute<{ name: string }>(sql`
    SELECT s.name, set_config(s.name,
      (CASE WHEN s.setting::bigint = 0 THEN limits.ceiling_ms
        ELSE LEAST(s.setting::bigint, limits.ceiling_ms) END)::text || 'ms', true)
    FROM pg_settings s JOIN (VALUES
      ('statement_timeout', 5000), ('lock_timeout', 1000),
      ('transaction_timeout', 5000), ('idle_in_transaction_session_timeout', 5000)
    ) AS limits(name, ceiling_ms) ON limits.name = s.name
    WHERE s.unit = 'ms'`)
  for (const required of [
    'statement_timeout',
    'lock_timeout',
    'idle_in_transaction_session_timeout',
  ]) {
    if (!configured.some((setting) => setting.name === required)) {
      throw new ChatCostPersistenceError('persistence_unknown')
    }
  }
}

async function lockWindow(tx: DbTransaction, windowId: string) {
  const [row] = await tx.select().from(window).where(eq(window.id, windowId)).for('update')
  return row
}

/** Lock ledger rows on the server and return one aggregate, never a ledger-sized JS array. */
async function budgetState(tx: DbTransaction, windowId: string, maximumCostUsd: string) {
  const [state] = await tx.execute<{ intact: boolean; fits: boolean }>(sql`
    WITH locked_ledger AS MATERIALIZED (
      SELECT l.* FROM usage_log l
      JOIN memlia_chat_cost_reservation r ON r.ledger_id = l.id
      WHERE r.window_id = ${windowId} AND r.state = 'settled'
      FOR SHARE OF l
    ), totals AS (
      SELECT COALESCE(bool_and(CASE WHEN r.state <> 'settled' THEN true ELSE COALESCE(
        l.id IS NOT NULL AND l.event_key = r.event_key AND l.cost = r.settled_cost_usd
        AND l.user_id = r.actor_user_id AND l.workspace_id = r.workspace_id
        AND l.billing_entity_type = r.billing_entity_type AND l.billing_entity_id = r.billing_entity_id
        AND l.billing_period_start = r.billing_period_start AND l.billing_period_end = r.billing_period_end
        AND l.source = 'workspace-chat' AND l.category = 'model'
        AND l.execution_id = r.attempt_id AND l.workflow_id IS NULL
        AND l.description = 'Memlia Chat cost' AND l.metadata IS NULL, false) END), true) AS intact,
        COALESCE(SUM(CASE WHEN r.state = 'settled' THEN l.cost ELSE r.maximum_cost_usd END), 0) AS committed
      FROM memlia_chat_cost_reservation r LEFT JOIN locked_ledger l ON l.id = r.ledger_id
      WHERE r.window_id = ${windowId}
    ) SELECT intact, committed + ${maximumCostUsd}::numeric <= w.limit_usd AS fits
      FROM totals CROSS JOIN memlia_chat_cost_window w WHERE w.id = ${windowId}`)
  return state
}

async function currentAttribution(
  tx: DbTransaction,
  a: BillingAttributionSnapshot
): Promise<boolean> {
  if (a.workspaceId === null) return false
  const [row] = await tx
    .select({
      organizationId: workspace.organizationId,
      billedAccountUserId: workspace.billedAccountUserId,
      archivedAt: workspace.archivedAt,
    })
    .from(workspace)
    .where(eq(workspace.id, a.workspaceId))
    .for('share')
  if (
    !row ||
    row.archivedAt !== null ||
    row.organizationId !== a.organizationId ||
    row.billedAccountUserId !== a.billedAccountUserId
  )
    return false
  const [actor] = await tx
    .select({ id: user.id })
    .from(user)
    .where(eq(user.id, a.actorUserId))
    .for('share')
  return !!actor
}

function matchesProfile(raw: unknown, expected: string | undefined): boolean {
  if (raw === null) return expected === undefined
  if (expected === undefined) return false
  try {
    return captureChatPricingProfile(raw).hash === expected
  } catch {
    return false
  }
}

function sameAttempt(row: Stored, input: ChatCostAttempt): boolean {
  return (
    matchesProfile(row.pricingProfile, input.expectedPricingProfileHash) &&
    row.windowId === input.windowId &&
    row.windowVersion === input.windowVersion &&
    units(row.maximumCostUsd) === units(input.maximumCostUsd) &&
    isDeepStrictEqual(row.attribution, input.attribution)
  )
}

/** Native numeric has no port scale bound: compare it exactly in PostgreSQL, never truncate it. */
async function readLedger(tx: DbTransaction, attempt: Stored, amount: string) {
  const [row] = await tx
    .select({
      ...getTableColumns(usageLog),
      matchesAmount: sql<boolean>`${usageLog.cost} = ${amount}::numeric
      AND (${attempt.state !== 'settled'} OR ${usageLog.cost} = ${attempt.settledCostUsd}::numeric)`,
    })
    .from(usageLog)
    .where(eq(usageLog.eventKey, attempt.eventKey))
    .for('share')
  return row
}

function sameLedger(
  row: NonNullable<Awaited<ReturnType<typeof readLedger>>>,
  attempt: Stored
): boolean {
  return (
    row.id === (attempt.ledgerId ?? row.id) &&
    row.eventKey === attempt.eventKey &&
    row.userId === attempt.actorUserId &&
    row.workspaceId === attempt.workspaceId &&
    row.billingEntityType === attempt.billingEntityType &&
    row.billingEntityId === attempt.billingEntityId &&
    row.billingPeriodStart?.getTime() === attempt.billingPeriodStart.getTime() &&
    row.billingPeriodEnd?.getTime() === attempt.billingPeriodEnd.getTime() &&
    row.matchesAmount === true &&
    row.source === 'workspace-chat' &&
    row.category === 'model' &&
    row.executionId === attempt.attemptId &&
    row.workflowId === null &&
    row.description === 'Memlia Chat cost' &&
    row.metadata === null
  )
}

/** Persistence only. Native session/permission/tariff admission belongs to the future caller. */
export async function reserveChatCost(
  tx: DbTransaction,
  raw: ChatCostAttempt
): Promise<ChatCostReservationResult> {
  requireTransaction(tx)
  let input: ChatCostAttempt
  try {
    const parsed = attemptSchema.parse(snapshot(raw))
    const attribution = assertBillingAttributionSnapshot(parsed.attribution)
    if (
      !isDeepStrictEqual(attribution, parsed.attribution) ||
      attribution.workspaceId === null ||
      units(parsed.maximumCostUsd) <= 0n ||
      units(parsed.maximumCostUsd) > MAX_UNITS
    )
      return refusal('invalid_input')
    input = { ...parsed, attribution }
  } catch {
    return refusal('invalid_input')
  }
  try {
    await configure(tx)
    const policy = await lockWindow(tx, input.windowId)
    if (!policy) return refusal('window_unavailable')
    if (policy.version !== input.windowVersion) return refusal('window_changed')
    if (!matchesProfile(policy.pricingProfile, input.expectedPricingProfileHash))
      return refusal('reconciliation_required')
    const pricingProfile =
      policy.pricingProfile === null
        ? undefined
        : captureChatPricingProfile(policy.pricingProfile).profile
    if (pricingProfile && units(pricingProfile.maximumCostUsd) !== units(input.maximumCostUsd))
      return refusal('identity_conflict')
    const budget = await budgetState(tx, input.windowId, input.maximumCostUsd)
    if (!budget?.intact || policy.state === 'blocked') return refusal('reconciliation_required')
    const [existing] = await tx
      .select()
      .from(reservation)
      .where(eq(reservation.attemptId, input.attemptId))
      .for('update')
    if (existing) {
      if (!sameAttempt(existing, input)) return refusal('identity_conflict')
      // Observation only: a duplicate never grants permission to resend a model request.
      return Object.freeze({
        kind: 'reserved_in_transaction',
        attemptId: input.attemptId,
        created: false,
        ...(pricingProfile ? { pricingProfile } : {}),
      })
    }
    if (!(await currentAttribution(tx, input.attribution))) return refusal('attribution_changed')
    // Workspace/user locks may also wait: check wall time only after those validations.
    const [timing] = await tx
      .select({
        active: sql<boolean>`clock_timestamp() >= ${window.startsAt}
      AND clock_timestamp() < ${window.endsAt}`,
      })
      .from(window)
      .where(eq(window.id, input.windowId))
    if (!timing?.active) return refusal('window_unavailable')
    if (!budget.fits) return refusal('budget_exhausted')
    const a = input.attribution
    await tx.insert(reservation).values({
      attemptId: input.attemptId,
      windowId: input.windowId,
      windowVersion: input.windowVersion,
      actorUserId: a.actorUserId,
      workspaceId: a.workspaceId!,
      billedAccountUserId: a.billedAccountUserId,
      organizationId: a.organizationId,
      billingEntityType: a.billingEntity.type,
      billingEntityId: a.billingEntity.id,
      billingPeriodStart: new Date(a.billingPeriod.start),
      billingPeriodEnd: new Date(a.billingPeriod.end),
      attribution: a,
      maximumCostUsd: input.maximumCostUsd,
      pricingProfile: pricingProfile ?? null,
      state: 'reserved',
      eventKey: stableEventKey({ scope: 'memlia_chat_cost_v1', attemptId: input.attemptId }),
    })
    // A profiled identity is returned from its persisted snapshot, not caller data.
    let persistedProfile: ChatPricingProfile | undefined
    if (pricingProfile) {
      const [written] = await tx
        .select()
        .from(reservation)
        .where(eq(reservation.attemptId, input.attemptId))
        .for('update')
      if (!written || !sameAttempt(written, input))
        throw new ChatCostPersistenceError('persistence_unknown')
      persistedProfile = captureChatPricingProfile(written.pricingProfile).profile
    }
    return Object.freeze({
      kind: 'reserved_in_transaction',
      attemptId: input.attemptId,
      created: true,
      ...(persistedProfile ? { pricingProfile: persistedProfile } : {}),
    })
  } catch {
    throw new ChatCostPersistenceError('persistence_unknown')
  }
}

/** Atomically writes one final native usage event and closes its commitment; no external effect. */
export async function settleChatCost(
  tx: DbTransaction,
  raw: ChatCostSettlement
): Promise<ChatCostSettlementResult> {
  requireTransaction(tx)
  let input: z.infer<typeof settlementSchema>
  let amount: string | undefined
  let nativeCost: number | undefined
  try {
    input = settlementSchema.parse(snapshot(raw))
    if (input.outcome.kind === 'known') {
      amount = input.outcome.finalCostUsd
      if (units(amount) > MAX_UNITS) return refusal('invalid_input')
      nativeCost = Number(amount)
      if (!Number.isFinite(nativeCost) || !toDecimal(nativeCost.toString()).eq(toDecimal(amount)))
        return refusal('invalid_input')
    }
  } catch {
    return refusal('invalid_input')
  }
  try {
    await configure(tx)
    const policy = await lockWindow(tx, input.windowId)
    if (!policy) return refusal('window_unavailable')
    if (policy.version !== input.windowVersion) return refusal('window_changed')
    if (!matchesProfile(policy.pricingProfile, input.expectedPricingProfileHash))
      return refusal('reconciliation_required')
    const [attempt] = await tx
      .select()
      .from(reservation)
      .where(eq(reservation.attemptId, input.attemptId))
      .for('update')
    if (!attempt) return refusal('reconciliation_required')
    if (!matchesProfile(attempt.pricingProfile, input.expectedPricingProfileHash))
      return refusal('reconciliation_required')
    if (attempt.windowId !== input.windowId || attempt.windowVersion !== input.windowVersion)
      return refusal('identity_conflict')
    if (amount === undefined) {
      if (attempt.state === 'settled') return refusal('reconciliation_required')
      await tx
        .update(reservation)
        .set({ state: 'unknown' })
        .where(eq(reservation.attemptId, input.attemptId))
      return Object.freeze({ kind: 'retained_in_transaction', reason: 'unknown_cost' })
    }
    // Native recordUsage omits model-cost zero: missing usage must not release the hold.
    if (units(amount) === 0n) return refusal('reconciliation_required')
    const prior = await readLedger(tx, attempt, amount)
    if (attempt.state === 'settled') {
      if (!prior || !sameLedger(prior, attempt)) return refusal('reconciliation_required')
      if (units(amount) > units(attempt.maximumCostUsd)) {
        await tx.update(window).set({ state: 'blocked' }).where(eq(window.id, input.windowId))
        return Object.freeze({
          kind: 'settled_and_blocked_in_transaction',
          attemptId: input.attemptId,
          reason: 'cost_exceeded_reservation',
        })
      }
      return Object.freeze({
        kind: 'settled_in_transaction',
        attemptId: input.attemptId,
        duplicate: true,
      })
    }
    // An uncommitted settlement cannot leave a ledger event behind. Any preexisting row is foreign/uncertain.
    if (prior) return refusal('reconciliation_required')
    await recordUsage({
      tx,
      userId: attempt.actorUserId,
      workspaceId: attempt.workspaceId,
      executionId: attempt.attemptId,
      billingEntity: { type: attempt.billingEntityType, id: attempt.billingEntityId },
      billingPeriod: { start: attempt.billingPeriodStart, end: attempt.billingPeriodEnd },
      entries: [
        {
          category: 'model',
          source: 'workspace-chat',
          description: 'Memlia Chat cost',
          cost: nativeCost!,
          eventKey: attempt.eventKey,
        },
      ],
    })
    const written = await readLedger(tx, attempt, amount)
    if (!written || !sameLedger(written, attempt))
      throw new ChatCostPersistenceError('persistence_unknown')
    await tx
      .update(reservation)
      .set({
        state: 'settled',
        ledgerId: written.id,
        settledCostUsd: amount,
        settledAt: sql`clock_timestamp()`,
      })
      .where(eq(reservation.attemptId, attempt.attemptId))
    if (units(amount) > units(attempt.maximumCostUsd)) {
      await tx.update(window).set({ state: 'blocked' }).where(eq(window.id, input.windowId))
      return Object.freeze({
        kind: 'settled_and_blocked_in_transaction',
        attemptId: input.attemptId,
        reason: 'cost_exceeded_reservation',
      })
    }
    return Object.freeze({
      kind: 'settled_in_transaction',
      attemptId: input.attemptId,
      duplicate: false,
    })
  } catch {
    throw new ChatCostPersistenceError('persistence_unknown')
  }
}
