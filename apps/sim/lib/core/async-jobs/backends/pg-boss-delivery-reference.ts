// Copyright 2026 Memlia. All rights reserved.
import { isDeepStrictEqual } from 'node:util'
import { type JobEnvelope, JobEnvelopeSchema } from '@memlia/contracts'
import { db } from '@sim/db'
import { asyncJobs } from '@sim/db/schema'
import { eq } from 'drizzle-orm'
import {
  copyPgBossAdmissionJson,
  PgBossAdmissionError,
  readPgBossPublication,
} from './pg-boss-admission'

export class PgBossDeliveryReferenceError extends Error {
  constructor(
    readonly code:
      | 'delivery_invalid_input'
      | 'delivery_admission_mismatch'
      | 'delivery_admission_reconciliation_required'
      | 'delivery_observation_unavailable'
  ) {
    super(code)
    this.name = 'PgBossDeliveryReferenceError'
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * Internal identity observation only. Never authenticates a delivery or grants authority,
 * attempt ownership, permission to dispatch, or permission to acknowledge it.
 * No transport digest is accepted or derived: the admission digest comes from native storage.
 */
export async function resolvePgBossDeliveryReference(
  nativeJobId: string,
  deliveredEnvelope: unknown
) {
  let delivered: JobEnvelope
  try {
    if (typeof nativeJobId !== 'string' || nativeJobId.length === 0 || nativeJobId.length > 512)
      throw new PgBossDeliveryReferenceError('delivery_invalid_input')
    // Reject lossy data and accessors before parsing; detach all caller data before awaiting.
    delivered = JobEnvelopeSchema.parse(copyPgBossAdmissionJson(deliveredEnvelope))
  } catch {
    throw new PgBossDeliveryReferenceError('delivery_invalid_input')
  }

  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .select({ metadata: asyncJobs.metadata })
        .from(asyncJobs)
        .where(eq(asyncJobs.id, nativeJobId))
        .for('share')
      if (!row) throw new PgBossDeliveryReferenceError('delivery_admission_reconciliation_required')
      const admissionDigest = record(record(row.metadata)?.memliaPgBossAdmission)?.admissionDigest
      if (typeof admissionDigest !== 'string')
        throw new PgBossDeliveryReferenceError('delivery_admission_reconciliation_required')
      const reference = { nativeJobId, admissionDigest }
      // Same lock/transaction for discovery and native verification of the complete admission.
      const publication = await readPgBossPublication(tx, reference)
      if (!isDeepStrictEqual(delivered, publication.envelope))
        throw new PgBossDeliveryReferenceError('delivery_admission_mismatch')
      // A terminal, processing or premature job can match identity. Status policy belongs
      // to later authority/claim/reconciliation, never to this read-only bridge.
      return Object.freeze({
        kind: 'delivery_admission_matched' as const,
        origin: 'persisted_admission' as const,
        reference: Object.freeze(reference),
      })
    })
  } catch (error) {
    if (error instanceof PgBossDeliveryReferenceError) throw error
    if (error instanceof PgBossAdmissionError)
      throw new PgBossDeliveryReferenceError('delivery_admission_reconciliation_required')
    // No SQL, driver cause, payload, session reference or caller value is exposed.
    // Failed observation does not establish rejection or absence of a prior execution.
    throw new PgBossDeliveryReferenceError('delivery_observation_unavailable')
  }
}
