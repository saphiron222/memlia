// Copyright (c) 2026 Memlia. All rights reserved.
import { createHash } from 'node:crypto'
import { JobEnvelopeSchema, type JobEnvelope } from '@memlia/contracts'
import { PgBoss } from 'pg-boss'

export class PgBossTransportError extends Error {
  readonly code: string
  readonly acceptance: 'rejected' | 'unknown'

  constructor(code: string, acceptance: 'rejected' | 'unknown' = 'rejected') {
    // Do not persist/log payloads, credentials, driver errors or runner exceptions.
    super(code)
    this.name = 'PgBossTransportError'
    this.code = code
    this.acceptance = acceptance
  }
}

interface TransportOptions {
  connectionString: string
  schema: string
  queueName: string
  /** Set false when provisioning owns the schema; pg-boss still migrates its tables. */
  createSchema?: boolean
  /** Receives only a fixed diagnostic code, never the underlying driver error. */
  onError: (code: 'transport_background_error') => void
}

// Private storage wrapper, not another domain envelope. The payload contract is
// exclusively @memlia/contracts. Native Sim job IDs need not be UUIDs.
interface StoredDelivery {
  nativeJobId: string
  digest: string
  envelope: JobEnvelope
  schedule?: PgBossDeliverySchedule
  wake?: true
}

// pg-boss 12.38 limits expiration to 24 hours; retain 60 seconds of delivery grace.
export const PG_BOSS_MAX_DURATION_SECONDS = 24 * 60 * 60 - 60

export interface PgBossDeliverySchedule {
  /** Verified native admission time, never a payload-controlled delay. */
  runAt: string
  maxDurationSeconds: number
}
export type PgBossDeliveryResult = void | { kind: 'defer'; runAt: string }
type Handler = (
  nativeJobId: string,
  envelope: JobEnvelope,
  signal: AbortSignal
) => Promise<PgBossDeliveryResult>

function deliverySchedule(value: PgBossDeliverySchedule): PgBossDeliverySchedule {
  const fields = Object.getOwnPropertyDescriptors(value)
  if (
    Object.keys(fields).sort().join(',') !== 'maxDurationSeconds,runAt' ||
    Object.getOwnPropertySymbols(value).length ||
    Object.values(fields).some((field) => !field.enumerable || !Object.hasOwn(field, 'value'))
  ) {
    throw new PgBossTransportError('invalid_delivery_schedule')
  }
  const runAt = fields.runAt.value
  const maxDurationSeconds = fields.maxDurationSeconds.value
  if (
    typeof runAt !== 'string' ||
    !Number.isFinite(Date.parse(runAt)) ||
    new Date(runAt).toISOString() !== runAt ||
    typeof maxDurationSeconds !== 'number' ||
    !Number.isSafeInteger(maxDurationSeconds) ||
    maxDurationSeconds < 5 ||
    maxDurationSeconds > PG_BOSS_MAX_DURATION_SECONDS
  ) {
    throw new PgBossTransportError('invalid_delivery_schedule')
  }
  return { runAt, maxDurationSeconds }
}

function validatedEnvelope(value: unknown): JobEnvelope {
  const parsed = JobEnvelopeSchema.safeParse(value)
  if (!parsed.success) throw new PgBossTransportError('invalid_envelope')
  return parsed.data
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function digest(envelope: JobEnvelope): string {
  return createHash('sha256').update(stableJson(envelope)).digest('hex')
}

export class PgBossTransport {
  private readonly boss: PgBoss
  private readonly queueName: string
  private readonly operations = new Set<Promise<unknown>>()
  private readonly handlers = new Set<Promise<void>>()
  private closing = false
  private stopPromise?: Promise<void>

  private constructor(options: TransportOptions) {
    this.queueName = options.queueName
    this.boss = new PgBoss({
      connectionString: options.connectionString,
      schema: options.schema,
      ...(options.createSchema !== undefined ? { createSchema: options.createSchema } : {}),
      // Sim retains scheduling. pg-boss only supervises delivery/expiration.
      schedule: false,
    })
    this.boss.on('error', () => options.onError('transport_background_error'))
  }

  static async connect(options: TransportOptions): Promise<PgBossTransport> {
    let transport: PgBossTransport | undefined
    try {
      transport = new PgBossTransport(options)
      await transport.boss.start()
      await transport.boss.createQueue(options.queueName, {
        policy: 'standard',
        retryLimit: 0,
        deleteAfterSeconds: 0,
      })
      return transport
    } catch {
      if (transport)
        await transport.boss.stop().catch(() => options.onError('transport_background_error'))
      throw new PgBossTransportError('transport_start_failed')
    }
  }

  private transportId(nativeJobId: string, wakeAt?: string): string {
    // UUID v8: a local, deterministic 122-bit projection. A hash collision is
    // detected by comparing the stored native ID and complete payload below.
    const bytes = createHash('sha256')
      .update(
        JSON.stringify(
          wakeAt === undefined
            ? ['memlia.pg-boss/v1', this.queueName, nativeJobId]
            : ['memlia.pg-boss/wake-v1', this.queueName, nativeJobId, wakeAt]
        )
      )
      .digest()
      .subarray(0, 16)
    bytes[6] = (bytes[6]! & 0x0f) | 0x80
    bytes[8] = (bytes[8]! & 0x3f) | 0x80
    const hex = bytes.toString('hex')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }

  private track<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new PgBossTransportError('transport_closed'))
    const promise = operation()
    this.operations.add(promise)
    const settle = () => {
      this.operations.delete(promise)
    }
    promise.then(settle, settle)
    return promise
  }

  publish(
    nativeJobId: string,
    value: unknown,
    schedule?: PgBossDeliverySchedule
  ): Promise<{ transportJobId: string; duplicate: boolean }> {
    return this.track(async () => {
      if (typeof nativeJobId !== 'string' || nativeJobId.length === 0 || nativeJobId.length > 512) {
        throw new PgBossTransportError('invalid_native_id')
      }
      const envelope = validatedEnvelope(value)
      const data: StoredDelivery = {
        nativeJobId,
        digest: digest(envelope),
        envelope,
        ...(schedule === undefined ? {} : { schedule: deliverySchedule(schedule) }),
      }
      return this.publishDelivery(data)
    })
  }

  private async publishDelivery(
    data: StoredDelivery
  ): Promise<{ transportJobId: string; duplicate: boolean }> {
    const id = this.transportId(data.nativeJobId, data.wake ? data.schedule?.runAt : undefined)
    try {
      const sent = await this.boss.send(this.queueName, data, {
        id,
        retryLimit: 0,
        deleteAfterSeconds: 0,
        ...(data.schedule
          ? {
              startAfter: data.schedule.runAt,
              // Delivery grace is not an extension of the runner's native execution cap.
              expireInSeconds: data.schedule.maxDurationSeconds + 60,
            }
          : {}),
      })
      if (sent) {
        if (sent !== id) throw new PgBossTransportError('acceptance_unknown', 'unknown')
        return { transportJobId: sent, duplicate: false }
      }
      const existing = await this.boss.getJobById<StoredDelivery>(this.queueName, id)
      if (!existing) throw new PgBossTransportError('acceptance_unknown', 'unknown')
      if (
        existing.data.nativeJobId !== data.nativeJobId ||
        existing.data.digest !== data.digest ||
        stableJson(existing.data.envelope) !== stableJson(data.envelope) ||
        stableJson(existing.data.schedule ?? null) !== stableJson(data.schedule ?? null) ||
        existing.data.wake !== data.wake
      ) {
        throw new PgBossTransportError('identity_conflict')
      }
      // Legacy duplicate receipts retain their old meaning. A scheduled failed/cancelled
      // delivery is not proof that a future wake will happen; never ACK on that basis.
      if (data.schedule && !['created', 'retry', 'active', 'completed'].includes(existing.state))
        throw new PgBossTransportError('delivery_reconciliation_required', 'unknown')
      return { transportJobId: id, duplicate: true }
    } catch (error) {
      if (error instanceof PgBossTransportError) throw error
      throw new PgBossTransportError('acceptance_unknown', 'unknown')
    }
  }

  work(handler: Handler): Promise<void> {
    return this.track(async () => {
      try {
        await this.boss.work<StoredDelivery>(
          this.queueName,
          { batchSize: 1, pollingIntervalSeconds: 0.5 },
          async ([job]) => {
            try {
              if (!job || !job.data || typeof job.data.nativeJobId !== 'string') {
                throw new PgBossTransportError('invalid_delivery')
              }
              const envelope = validatedEnvelope(job.data.envelope)
              const schedule =
                job.data.schedule === undefined ? undefined : deliverySchedule(job.data.schedule)
              if (job.data.wake !== undefined && (job.data.wake !== true || !schedule))
                throw new PgBossTransportError('invalid_delivery')
              const nativeJobId = job.data.nativeJobId
              const wake = job.data.wake
              if (
                job.id !== this.transportId(nativeJobId, wake ? schedule?.runAt : undefined) ||
                job.data.digest !== digest(envelope)
              ) {
                throw new PgBossTransportError('invalid_delivery')
              }
              // Track the real handler independently: pg-boss can stop waiting for
              // an expired handler even though that handler is still running.
              const handling = (async () => {
                job.signal.throwIfAborted()
                const result = await handler(nativeJobId, envelope, job.signal)
                job.signal.throwIfAborted()
                if (result === undefined) return
                if (result.kind !== 'defer' || !schedule || result.runAt !== schedule.runAt || wake)
                  throw new PgBossTransportError('delivery_reconciliation_required')
                // This publication remains part of the tracked handler while stop drains it.
                // No business retry and no in-memory sleep: pg-boss persists the single wake.
                await this.publishDelivery({
                  nativeJobId,
                  envelope,
                  digest: digest(envelope),
                  schedule,
                  wake: true,
                })
                job.signal.throwIfAborted()
              })()
              this.handlers.add(handling)
              try {
                await handling
              } finally {
                this.handlers.delete(handling)
              }
            } catch {
              // Queue failure is not a business receipt: an effect may have happened.
              // The owning runner must durably record uncertainty/reconciliation.
              throw new PgBossTransportError('delivery_failed_reconciliation_required')
            }
          }
        )
      } catch {
        throw new PgBossTransportError('worker_start_failed')
      }
    })
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.closing = true
    this.stopPromise = (async () => {
      try {
        await Promise.allSettled([...this.operations])
        // Stop polling and await active handlers/acknowledgements before closing
        // the pool. No forced replay or premature acknowledgement on shutdown.
        await this.boss.offWork(this.queueName, { wait: true })
        // offWork prevents further handler starts, but releases its own overrun
        // wait on stopSignal. Keep the pool open until those handlers settle too.
        await Promise.allSettled([...this.handlers])
        await this.boss.stop({ graceful: true, close: true })
      } catch {
        throw new PgBossTransportError('transport_stop_failed', 'unknown')
      }
    })()
    return this.stopPromise
  }
}
