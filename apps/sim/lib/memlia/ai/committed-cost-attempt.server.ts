// Copyright 2026 Memlia. All rights reserved.
import { db } from '@sim/db'
import { stringifyBoundedJson } from '@/lib/core/utils/bounded-json'
import { captureChatPricingProfile, type ChatPricingProfile } from './chat-pricing-profile.server'
import {
  type ChatCostAttempt,
  type ChatCostRefusal,
  type ChatCostSettlement,
  reserveChatCost,
  settleChatCost,
} from './cost-reservation.server'

declare const committedCostReference: unique symbol
/** Local bookkeeping identity only: never authority or permission to send. */
export interface CommittedCostReference {
  readonly [committedCostReference]: true
}

type Refusal = Readonly<{
  kind: 'refused'
  reason: ChatCostRefusal | 'cancelled' | 'invalid_reference'
}>
type UnknownCommit = Readonly<{ kind: 'commit_unknown' }>
export type CommittedCostReservation =
  | Readonly<{ kind: 'reserved_committed'; reference: CommittedCostReference }>
  | Readonly<{ kind: 'already_reserved' }>
  | Refusal
  | UnknownCommit
export type CommittedCostSettlement =
  | Readonly<{ kind: 'settled_committed'; duplicate: boolean }>
  | Readonly<{ kind: 'settled_and_blocked_committed'; reason: 'cost_exceeded_reservation' }>
  | Readonly<{ kind: 'retained_committed'; reason: 'unknown_cost' }>
  | Refusal
  | UnknownCommit

type Identity = Pick<ChatCostSettlement, 'windowId' | 'windowVersion' | 'attemptId'> & {
  readonly pricingProfile?: ChatPricingProfile
}
const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!
const refusal = (reason: Refusal['reason']): Refusal => Object.freeze({ kind: 'refused', reason })
const uncertain = (): UnknownCommit => Object.freeze({ kind: 'commit_unknown' })

/** Capture without getters/loss; the existing native port remains the schema authority. */
function capture<T>(raw: T): T {
  const json = stringifyBoundedJson(raw, 16_384, { strict: true })
  if (json === undefined) throw new Error('invalid_input')
  return JSON.parse(json)
}

/** Use the native brand/getter, never a caller-overridden aborted property or reason. */
function cancelled(signal: AbortSignal | undefined): boolean {
  return signal === undefined ? false : abortedGetter.call(signal)
}

/**
 * Owns the native transactions. No database/callback injection, network effect,
 * reconciliation scheduler, authority decision or restart recovery is provided.
 */
export function createCommittedChatCostAttempts() {
  const identities = new WeakMap<CommittedCostReference, Readonly<Identity>>()

  return Object.freeze({
    async reserve(raw: ChatCostAttempt, signal?: AbortSignal): Promise<CommittedCostReservation> {
      let input: ChatCostAttempt
      try {
        input = capture(raw)
        if (cancelled(signal)) return refusal('cancelled')
      } catch {
        return refusal('invalid_input')
      }
      try {
        // Only resolution of transaction(), not resolution of its callback,
        // confirms COMMIT. Exceptions cannot distinguish rollback from a lost ACK.
        const result = await db.transaction((tx) => reserveChatCost(tx, input))
        if (cancelled(signal)) return refusal('cancelled')
        if (result.kind === 'refused') return refusal(result.reason)
        if (!result.created) return Object.freeze({ kind: 'already_reserved' })
        const pricingProfile =
          result.pricingProfile === undefined
            ? undefined
            : captureChatPricingProfile(result.pricingProfile)
        if (pricingProfile?.hash !== input.expectedPricingProfileHash) return uncertain()
        const reference = Object.freeze(Object.create(null)) as CommittedCostReference
        identities.set(
          reference,
          Object.freeze({
            windowId: input.windowId,
            windowVersion: input.windowVersion,
            attemptId: result.attemptId,
            ...(pricingProfile ? { pricingProfile: pricingProfile.profile } : {}),
          })
        )
        return Object.freeze({ kind: 'reserved_committed', reference })
      } catch {
        return uncertain()
      }
    },

    async settle(
      reference: unknown,
      rawOutcome: ChatCostSettlement['outcome']
    ): Promise<CommittedCostSettlement> {
      // WeakMap lookup does not inspect properties or execute proxy traps.
      const identity = identities.get(reference as CommittedCostReference)
      if (!identity) return refusal('invalid_reference')
      let outcome: ChatCostSettlement['outcome']
      try {
        outcome = capture(rawOutcome)
      } catch {
        return refusal('invalid_input')
      }
      try {
        // No abort parameter: known spend must remain recordable after stream cancellation.
        const result = await db.transaction((tx) =>
          settleChatCost(tx, {
            windowId: identity.windowId,
            windowVersion: identity.windowVersion,
            attemptId: identity.attemptId,
            ...(identity.pricingProfile
              ? {
                  expectedPricingProfileHash: captureChatPricingProfile(identity.pricingProfile)
                    .hash,
                }
              : {}),
            outcome,
          })
        )
        switch (result.kind) {
          case 'refused':
            return refusal(result.reason)
          case 'settled_in_transaction':
            return Object.freeze({ kind: 'settled_committed', duplicate: result.duplicate })
          case 'settled_and_blocked_in_transaction':
            return Object.freeze({ kind: 'settled_and_blocked_committed', reason: result.reason })
          case 'retained_in_transaction':
            return Object.freeze({ kind: 'retained_committed', reason: result.reason })
        }
      } catch {
        return uncertain()
      }
    },
  })
}
