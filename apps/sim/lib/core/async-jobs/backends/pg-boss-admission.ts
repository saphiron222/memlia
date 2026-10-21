// Copyright (c) 2026 Memlia. All rights reserved.
import { createHash } from 'node:crypto'
import { type JobEnvelope, JobEnvelopeSchema } from '@memlia/contracts'
import type { db } from '@sim/db'
import { asyncJobs, outboxEvent } from '@sim/db/schema'
import { eq } from 'drizzle-orm'
import { enqueueOutboxEvent } from '@/lib/core/outbox/service'
import { validateMaxDurationSeconds } from '../types'

export const PG_BOSS_OUTBOX_EVENT = 'memlia.pg-boss.publish'
const ADMISSION_METADATA = 'memliaPgBossAdmission'
const MAX_ADMISSION_BYTES = 1024 * 1024

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Reader = Pick<Transaction, 'select'>
type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export class PgBossAdmissionError extends Error {
  constructor(
    readonly code: string,
    readonly acceptance: 'rejected' | 'unknown' = 'rejected'
  ) {
    super(code)
    this.name = 'PgBossAdmissionError'
  }
}

export interface PgBossAdmissionInput {
  jobId: string
  envelope: unknown
  payload: unknown
  metadata?: Record<string, unknown>
  maxDurationSeconds?: number
  /** Absolute, stable time so a retry cannot move the originally accepted delay. */
  runAt?: string
}

/** Refuse lossy JSON coercions, custom objects, accessors, cycles and excessive depth. */
function jsonCopy(value: unknown, depth = 0, parents = new Set<object>()): Json {
  if (depth > 32) throw new PgBossAdmissionError('admission_invalid_json')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'object' || value === null || parents.has(value)) {
    throw new PgBossAdmissionError('admission_invalid_json')
  }
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  ) {
    throw new PgBossAdmissionError('admission_invalid_json')
  }
  if (Object.getOwnPropertySymbols(value).length)
    throw new PgBossAdmissionError('admission_invalid_json')
  parents.add(value)
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Object.values(descriptors).some((descriptor) => descriptor.get || descriptor.set)) {
      throw new PgBossAdmissionError('admission_invalid_json')
    }
    if (Array.isArray(value)) {
      // Only own, exhaustive indices plus length; never invoke a caller's map method.
      if (
        Object.getPrototypeOf(value) !== Array.prototype ||
        Object.keys(descriptors).length !== value.length + 1
      )
        throw new PgBossAdmissionError('admission_invalid_json')
      const copy: Json[] = []
      for (let index = 0; index < value.length; index++) {
        const descriptor = descriptors[String(index)]
        if (!descriptor?.enumerable) throw new PgBossAdmissionError('admission_invalid_json')
        copy.push(jsonCopy(descriptor.value, depth + 1, parents))
      }
      return copy
    }
    if (Object.values(descriptors).some((descriptor) => !descriptor.enumerable))
      throw new PgBossAdmissionError('admission_invalid_json')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, jsonCopy(descriptors[key].value, depth + 1, parents)])
    )
  } finally {
    parents.delete(value)
  }
}

/** Snapshot caller data before asynchronous authority reads, using admission's lossless JSON boundary. */
export function copyPgBossAdmissionJson<T>(value: T): T {
  const copy = jsonCopy(value)
  if (Buffer.byteLength(JSON.stringify(copy)) > MAX_ADMISSION_BYTES)
    throw new PgBossAdmissionError('admission_too_large')
  return copy as T
}

function canonical(value: unknown): string {
  const encoded = JSON.stringify(jsonCopy(value))
  if (Buffer.byteLength(encoded) > MAX_ADMISSION_BYTES)
    throw new PgBossAdmissionError('admission_too_large')
  return encoded
}

function normalize(input: PgBossAdmissionInput) {
  if (typeof input.jobId !== 'string' || input.jobId.length === 0 || input.jobId.length > 512) {
    throw new PgBossAdmissionError('admission_invalid_job_id')
  }
  const parsed = JobEnvelopeSchema.safeParse(input.envelope)
  if (!parsed.success) throw new PgBossAdmissionError('admission_invalid_envelope')
  const envelope = parsed.data
  const payload = jsonCopy(input.payload)
  const metadata = jsonCopy(input.metadata ?? {})
  if (
    metadata === null ||
    Array.isArray(metadata) ||
    typeof metadata !== 'object' ||
    ADMISSION_METADATA in metadata ||
    'maxDurationSeconds' in metadata
  ) {
    throw new PgBossAdmissionError('admission_invalid_metadata')
  }
  if (
    (metadata.workspaceId !== undefined &&
      metadata.workspaceId !== envelope.authority.workspaceId) ||
    (metadata.executionId !== undefined && metadata.executionId !== envelope.runId)
  ) {
    throw new PgBossAdmissionError('admission_scope_mismatch')
  }
  let maxDurationSeconds: number
  try {
    maxDurationSeconds = validateMaxDurationSeconds(input.maxDurationSeconds ?? 900)!
  } catch {
    throw new PgBossAdmissionError('admission_invalid_duration')
  }
  const runAt = input.runAt ?? envelope.submittedAt
  if (
    typeof runAt !== 'string' ||
    !Number.isFinite(Date.parse(runAt)) ||
    new Date(runAt).toISOString() !== runAt
  ) {
    throw new PgBossAdmissionError('admission_invalid_run_at')
  }
  const request = { jobId: input.jobId, envelope, payload, metadata, maxDurationSeconds, runAt }
  const serialized = canonical(request)
  const admissionDigest = createHash('sha256').update(serialized).digest('hex')
  const identity = [
    envelope.authority.organizationId,
    envelope.authority.workspaceId,
    envelope.runner,
    envelope.idempotencyKey,
  ]
  const outboxEventId = `memlia-pg-boss:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`
  return { ...request, serialized, admissionDigest, outboxEventId }
}

function verifyStored(row: typeof asyncJobs.$inferSelect, expectedDigest: string) {
  const metadata = row.metadata as Record<string, unknown>
  const stored = metadata?.[ADMISSION_METADATA]
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    throw new PgBossAdmissionError('admission_reconciliation_required')
  }
  const record = stored as Record<string, unknown>
  if (record.version !== 1) throw new PgBossAdmissionError('admission_reconciliation_required')
  const parsed = normalize({
    jobId: row.id,
    envelope: record.envelope,
    payload: row.payload,
    metadata: record.metadata as Record<string, unknown>,
    maxDurationSeconds: record.maxDurationSeconds as number,
    runAt: record.runAt as string,
  })
  if (
    parsed.admissionDigest !== expectedDigest ||
    record.admissionDigest !== expectedDigest ||
    row.type !== parsed.envelope.runner ||
    row.runAt?.toISOString() !== parsed.runAt ||
    metadata.maxDurationSeconds !== parsed.maxDurationSeconds ||
    Object.entries(parsed.metadata).some(
      ([key, value]) => canonical(metadata[key]) !== canonical(value)
    )
  ) {
    throw new PgBossAdmissionError('admission_identity_conflict')
  }
  return parsed
}

/**
 * Persistence only: the future caller must resolve/recheck authority BEFORE this call.
 * Requires the caller's native transaction. No transport, runner or authorization runs here.
 * The return becomes durable only when the caller commits the surrounding transaction.
 */
export async function admitPgBossJob(tx: Transaction, input: PgBossAdmissionInput) {
  const request = normalize(input)
  try {
    // Savepoint prevents partial admission even if the caller catches our rejection.
    return await tx.transaction(async (savepoint) => {
      const now = new Date()
      const inserted = await savepoint
        .insert(asyncJobs)
        .values({
          id: request.jobId,
          type: request.envelope.runner,
          payload: request.payload,
          status: 'pending',
          attempts: 0,
          maxAttempts: 1,
          createdAt: now,
          updatedAt: now,
          runAt: new Date(request.runAt),
          metadata: {
            ...request.metadata,
            maxDurationSeconds: request.maxDurationSeconds,
            [ADMISSION_METADATA]: {
              version: 1,
              envelope: request.envelope,
              metadata: request.metadata,
              runAt: request.runAt,
              maxDurationSeconds: request.maxDurationSeconds,
              admissionDigest: request.admissionDigest,
            },
          },
        })
        .onConflictDoNothing({ target: asyncJobs.id })
        .returning({ id: asyncJobs.id })
      const [event] = await savepoint
        .select()
        .from(outboxEvent)
        .where(eq(outboxEvent.id, request.outboxEventId))
        .limit(1)
        .for('update')
      if (inserted.length === 0) {
        const [existing] = await savepoint
          .select()
          .from(asyncJobs)
          .where(eq(asyncJobs.id, request.jobId))
          .limit(1)
          .for('update')
        if (!existing || !event) throw new PgBossAdmissionError('admission_reconciliation_required')
        const original = verifyStored(existing, request.admissionDigest)
        if (
          original.serialized !== request.serialized ||
          event.eventType !== PG_BOSS_OUTBOX_EVENT ||
          canonical(event.payload) !==
            canonical({ nativeJobId: request.jobId, admissionDigest: request.admissionDigest })
        ) {
          throw new PgBossAdmissionError('admission_identity_conflict')
        }
        return { jobId: request.jobId, outboxEventId: request.outboxEventId, duplicate: true }
      }
      // Includes an orphan after native async_jobs retention; never recreate its delivery.
      if (event) {
        const reference = event.payload as { nativeJobId?: unknown }
        throw new PgBossAdmissionError(
          reference?.nativeJobId === request.jobId
            ? 'admission_reconciliation_required'
            : 'admission_identity_conflict'
        )
      }
      await enqueueOutboxEvent(
        savepoint,
        PG_BOSS_OUTBOX_EVENT,
        {
          nativeJobId: request.jobId,
          admissionDigest: request.admissionDigest,
        },
        { id: request.outboxEventId, availableAt: new Date(request.runAt) }
      )
      return { jobId: request.jobId, outboxEventId: request.outboxEventId, duplicate: false }
    })
  } catch (error) {
    if (error instanceof PgBossAdmissionError) throw error
    const cause = error instanceof Error && error.cause ? error.cause : error
    if (
      cause &&
      typeof cause === 'object' &&
      'code' in cause &&
      cause.code === '23505' &&
      'constraint_name' in cause &&
      cause.constraint_name === 'outbox_event_pkey'
    ) {
      // The savepoint rolled back our row: another native ID owns this scoped key.
      throw new PgBossAdmissionError('admission_identity_conflict')
    }
    // A lost DB response does not establish rejection. Preserve the stable identity.
    throw new PgBossAdmissionError('admission_persistence_unknown', 'unknown')
  }
}

/** Reads the immutable admission, never reconstructing authority from the native payload. */
export async function readPgBossPublication(
  reader: Reader,
  payload: unknown
): Promise<{
  jobId: string
  outboxEventId: string
  envelope: JobEnvelope
  status: string
  runAt: string
  maxDurationSeconds: number
}> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    throw new PgBossAdmissionError('admission_invalid_reference')
  const reference = payload as Record<string, unknown>
  if (
    Object.keys(reference).sort().join(',') !== 'admissionDigest,nativeJobId' ||
    typeof reference.nativeJobId !== 'string' ||
    typeof reference.admissionDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(reference.admissionDigest)
  )
    throw new PgBossAdmissionError('admission_invalid_reference')
  const [row] = await reader
    .select()
    .from(asyncJobs)
    .where(eq(asyncJobs.id, reference.nativeJobId))
    .limit(1)
  if (!row) throw new PgBossAdmissionError('admission_reconciliation_required')
  const request = verifyStored(row, reference.admissionDigest)
  return {
    jobId: row.id,
    outboxEventId: request.outboxEventId,
    envelope: request.envelope,
    status: row.status,
    runAt: request.runAt,
    maxDurationSeconds: request.maxDurationSeconds,
  }
}
