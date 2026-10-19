// Copyright (c) 2026 Memlia. All rights reserved.
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { JobEnvelopeSchema } from '@memlia/contracts'
import type { db } from '@sim/db'
import { asyncJobs } from '@sim/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { PgBossAdmissionError, readPgBossPublication } from './pg-boss-admission'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type NativeJob = typeof asyncJobs.$inferSelect

export interface PgBossAttempt {
  readonly jobId: string
  readonly token: string
}

export type PgBossClaimResult =
  | { kind: 'claimed'; attempt: PgBossAttempt }
  | { kind: 'defer'; runAt: string }
  | { kind: 'terminal'; status: 'completed' | 'failed' | 'cancelled' }
  | { kind: 'reconciliation_required' }

export class PgBossClaimError extends Error {
  constructor(
    readonly code: string,
    readonly acceptance: 'rejected' | 'unknown' = 'rejected'
  ) {
    super(code)
    this.name = 'PgBossClaimError'
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function admission(row: NativeJob) {
  return record(record(row.metadata)?.memliaPgBossAdmission)
}

function requireTransaction(tx: Transaction) {
  // A db/autocommit handle would release the lock before the caller's protected write.
  if (typeof tx.rollback !== 'function') throw new PgBossClaimError('claim_transaction_required')
}

function validJobId(jobId: unknown): jobId is string {
  return typeof jobId === 'string' && jobId.length > 0 && jobId.length <= 512
}

async function publication(tx: Transaction, row: NativeJob) {
  return readPgBossPublication(tx, {
    nativeJobId: row.id,
    admissionDigest: admission(row)?.admissionDigest,
  })
}

function persistenceError(error: unknown): never {
  if (error instanceof PgBossClaimError || error instanceof PgBossAdmissionError) throw error
  // No driver cause/message, SQL, envelope or attempt token crosses this boundary.
  throw new PgBossClaimError('claim_persistence_unknown', 'unknown')
}

/**
 * Persistence only, after the future trusted caller resolves and rechecks authority.
 * No effect/runner runs here. The claim is durable only after the caller commits.
 */
export async function claimPgBossAttempt(
  tx: Transaction,
  nativeJobId: string,
  deliveredEnvelope: unknown
): Promise<PgBossClaimResult> {
  requireTransaction(tx)
  if (!validJobId(nativeJobId)) throw new PgBossClaimError('claim_invalid_job_id')
  const delivered = JobEnvelopeSchema.safeParse(deliveredEnvelope)
  if (!delivered.success) throw new PgBossClaimError('claim_invalid_envelope')
  try {
    const [row] = await tx
      .select()
      .from(asyncJobs)
      .where(eq(asyncJobs.id, nativeJobId))
      .for('update')
    if (!row) return { kind: 'reconciliation_required' }
    const stored = await publication(tx, row)
    if (!isDeepStrictEqual(delivered.data, stored.envelope)) {
      throw new PgBossClaimError('claim_identity_conflict')
    }
    if (row.status === 'completed' || row.status === 'failed' || row.status === 'cancelled') {
      return row.completedAt
        ? { kind: 'terminal', status: row.status }
        : { kind: 'reconciliation_required' }
    }
    if (
      row.status !== 'pending' ||
      row.attempts !== 0 ||
      row.maxAttempts !== 1 ||
      row.startedAt !== null ||
      row.completedAt !== null ||
      row.error !== null ||
      row.output !== null ||
      Object.hasOwn(admission(row) ?? {}, 'attempt')
    )
      return { kind: 'reconciliation_required' }

    // Evaluate after taking the lock; native timestamps store UTC without a timezone.
    const [timing] = await tx
      .select({
        due: sql<boolean>`${asyncJobs.runAt} <= timezone('UTC', clock_timestamp())`,
      })
      .from(asyncJobs)
      .where(eq(asyncJobs.id, nativeJobId))
    if (!timing?.due) {
      if (!row.runAt) return { kind: 'reconciliation_required' }
      return { kind: 'defer', runAt: row.runAt.toISOString() }
    }
    const token = randomUUID()
    const [claimed] = await tx
      .update(asyncJobs)
      .set({
        status: 'processing',
        attempts: 1,
        startedAt: sql`timezone('UTC', statement_timestamp())`,
        updatedAt: sql`timezone('UTC', statement_timestamp())`,
        metadata: sql`jsonb_set(${asyncJobs.metadata}, '{memliaPgBossAdmission,attempt}', ${JSON.stringify({ version: 1, token })}::jsonb)`,
      })
      .where(
        and(
          eq(asyncJobs.id, nativeJobId),
          eq(asyncJobs.status, 'pending'),
          eq(asyncJobs.attempts, 0)
        )
      )
      .returning({ id: asyncJobs.id })
    if (!claimed) return { kind: 'reconciliation_required' }
    return { kind: 'claimed', attempt: { jobId: nativeJobId, token } }
  } catch (error) {
    return persistenceError(error)
  }
}

/**
 * Locks and checks ownership in the caller's transaction, immediately before its
 * future native finalization write. No external work/callback may run under this lock.
 * Does not terminalize, acknowledge, authenticate or authorize anything.
 */
export async function guardPgBossAttempt(
  tx: Transaction,
  attempt: PgBossAttempt
): Promise<boolean> {
  requireTransaction(tx)
  // Capture primitive identity before waiting; readonly does not freeze a caller's object.
  const jobId = attempt?.jobId
  const token = attempt?.token
  if (
    !attempt ||
    !validJobId(jobId) ||
    typeof token !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(token)
  ) {
    throw new PgBossClaimError('claim_invalid_attempt')
  }
  try {
    const [row] = await tx.select().from(asyncJobs).where(eq(asyncJobs.id, jobId)).for('update')
    if (
      !row ||
      row.status !== 'processing' ||
      row.attempts !== 1 ||
      row.maxAttempts !== 1 ||
      row.startedAt === null ||
      row.completedAt !== null ||
      row.error !== null ||
      row.output !== null
    )
      return false
    const owner = record(admission(row)?.attempt)
    if (owner?.version !== 1 || owner.token !== token) return false
    await publication(tx, row)
    return true
  } catch (error) {
    return persistenceError(error)
  }
}
