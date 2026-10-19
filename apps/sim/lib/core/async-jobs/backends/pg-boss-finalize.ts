// Copyright 2026 Memlia. All rights reserved.
import type { db } from '@sim/db'
import { asyncJobs } from '@sim/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { getRecordedJobFailureError } from '../recorded-failure'
import { PgBossAdmissionError } from './pg-boss-admission'
import { guardPgBossAttempt, type PgBossAttempt, PgBossClaimError } from './pg-boss-claim'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

export type PgBossFinalization =
  | { kind: 'returned'; outputJson: string }
  | { kind: 'failed'; error: string }
  | { kind: 'unknown' }

export type PgBossFinalizationResult =
  | { kind: 'finalized'; status: 'completed' | 'failed' }
  | { kind: 'reconciliation_required' }

export class PgBossFinalizationError extends Error {
  constructor(
    readonly code: string,
    readonly acceptance: 'rejected' | 'unknown' = 'rejected'
  ) {
    super(code)
    this.name = 'PgBossFinalizationError'
  }
}

const MAX_OUTPUT_BYTES = 1024 * 1024
const MAX_ERROR_BYTES = 16 * 1024

function invalid(): never {
  throw new PgBossFinalizationError('finalize_invalid_outcome')
}

/** Input is server-prepared data, never a runner or callback executed under the lock. */
function normalize(outcome: PgBossFinalization) {
  if (!outcome || Object.getPrototypeOf(outcome) !== Object.prototype) invalid()
  const descriptors = Object.getOwnPropertyDescriptors(outcome)
  if (
    Object.getOwnPropertySymbols(outcome).length ||
    Object.values(descriptors).some((d) => !d.enumerable || !Object.hasOwn(d, 'value'))
  )
    invalid()
  const fields: Record<string, unknown> = Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value])
  )
  const keys = Object.keys(fields).sort().join(',')
  if (fields.kind === 'unknown' && keys === 'kind') return { kind: 'unknown' } as const
  if (fields.kind === 'failed' && keys === 'error,kind') {
    if (
      typeof fields.error !== 'string' ||
      !fields.error.length ||
      Buffer.byteLength(fields.error) > MAX_ERROR_BYTES
    )
      invalid()
    return { kind: 'failed', error: fields.error } as const
  }
  if (
    fields.kind !== 'returned' ||
    keys !== 'kind,outputJson' ||
    typeof fields.outputJson !== 'string' ||
    Buffer.byteLength(fields.outputJson) > MAX_OUTPUT_BYTES
  )
    invalid()
  let output: unknown
  try {
    output = JSON.parse(fields.outputJson)
  } catch {
    invalid()
  }
  checkJson(output)
  return { kind: 'returned', output } as const
}

/** JSON.parse creates inert data; bound depth and reject numeric overflow before locking. */
function checkJson(value: unknown, depth = 0): void {
  if (depth > 32 || (typeof value === 'number' && !Number.isFinite(value))) invalid()
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) checkJson(item, depth + 1)
  }
}

/**
 * Persistence only. The trusted caller resolves authority and runs outside this transaction.
 * A returned receipt is tentative until its outer transaction commits; it never implies ACK.
 */
export async function finalizePgBossAttempt(
  tx: Transaction,
  attempt: PgBossAttempt,
  outcome: PgBossFinalization
): Promise<PgBossFinalizationResult> {
  if (typeof tx.rollback !== 'function')
    throw new PgBossFinalizationError('finalize_transaction_required')
  // Parsing/validation precedes the row lock and cannot call output getters or toJSON.
  const prepared = normalize(outcome)
  if (prepared.kind === 'unknown') return { kind: 'reconciliation_required' }
  try {
    // Keep the same private identity for the guard and every subsequent query.
    const owner = { jobId: attempt?.jobId, token: attempt?.token }
    if (!(await guardPgBossAttempt(tx, owner))) return { kind: 'reconciliation_required' }
    const [row] = await tx
      .select({ type: asyncJobs.type })
      .from(asyncJobs)
      .where(eq(asyncJobs.id, owner.jobId))
    if (!row) return { kind: 'reconciliation_required' }
    const output = prepared.kind === 'returned' ? prepared.output : null
    const recordedError = getRecordedJobFailureError(row.type, output)
    const workflowFailed =
      row.type === 'workflow-execution' &&
      output !== null &&
      typeof output === 'object' &&
      !Array.isArray(output) &&
      'success' in output &&
      output.success === false
    const status = prepared.kind === 'failed' || workflowFailed ? 'failed' : 'completed'
    // Native recorded errors may append three bytes after the 16 KiB prefix. Never truncate output.
    const error =
      prepared.kind === 'failed'
        ? prepared.error
        : workflowFailed
          ? recordedError !== undefined && Buffer.byteLength(recordedError) <= MAX_ERROR_BYTES + 3
            ? recordedError
            : 'workflow_execution_failed'
          : null
    const [updated] = await tx
      .update(asyncJobs)
      .set({
        status,
        output,
        error,
        completedAt: sql`timezone('UTC', statement_timestamp())`,
        updatedAt: sql`timezone('UTC', statement_timestamp())`,
      })
      .where(and(eq(asyncJobs.id, owner.jobId), eq(asyncJobs.status, 'processing')))
      .returning({ id: asyncJobs.id })
    return updated ? { kind: 'finalized', status } : { kind: 'reconciliation_required' }
  } catch (error) {
    if (
      error instanceof PgBossFinalizationError ||
      error instanceof PgBossClaimError ||
      error instanceof PgBossAdmissionError
    )
      throw error
    throw new PgBossFinalizationError('finalize_persistence_unknown', 'unknown')
  }
}
