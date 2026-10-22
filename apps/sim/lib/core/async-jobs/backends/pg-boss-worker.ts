// Copyright 2026 Memlia. All rights reserved.
import { db } from '@sim/db'
import { asyncJobs } from '@sim/db/schema'
import { eq } from 'drizzle-orm'
import { getAsyncBackendType } from '../config'
import { copyPgBossAdmissionJson, readPgBossPublication } from './pg-boss-admission'
import { claimPgBossAttempt, guardPgBossAttempt } from './pg-boss-claim'
import { pgBossClient } from './pg-boss-client'
import { resolvePgBossDeliveryReference } from './pg-boss-delivery-reference'
import { finalizePgBossAttempt } from './pg-boss-finalize'
import { preparePgBossNativeRunner } from './pg-boss-registry'
import type { PgBossDeliveryResult } from './pg-boss-transport'
import { revalidatePgBossWorkflowSessionAuthority } from './pg-boss-workflow-session-authority'

function uncertain(): never {
  throw new Error('durable_workflow_reconciliation_required')
}

function nativeOutputJson(output: unknown): string {
  // executeWorkflowJob returns this optional own field even when no metadata exists.
  // Omit only that native absence; reject every other lossy value/accessor as before.
  if (output !== null && typeof output === 'object' && !Array.isArray(output)) {
    const descriptors = Object.getOwnPropertyDescriptors(output)
    const metadata = descriptors.metadata
    if (metadata?.enumerable && 'value' in metadata && metadata.value === undefined) {
      delete descriptors.metadata
      output = Object.defineProperties(Object.create(Object.getPrototypeOf(output)), descriptors)
    }
  }
  return JSON.stringify(copyPgBossAdmissionJson(output))
}

/** Owned process boundary. No business replay, external effect under lock, or implicit activation. */
export async function startPgBossWorkflowWorker() {
  if (getAsyncBackendType() !== 'pg-boss') throw new Error('durable_workflow_worker_not_selected')
  const shutdown = new AbortController()
  const transport = await pgBossClient.get()
  try {
    await transport.work(async (jobId, envelope, deliverySignal): Promise<PgBossDeliveryResult> => {
      const signal = AbortSignal.any([shutdown.signal, deliverySignal])
      signal.throwIfAborted()
      const matched = await resolvePgBossDeliveryReference(jobId, envelope)
      const publication = await readPgBossPublication(db, matched.reference)
      if (publication.envelope.runner !== 'workflow-execution') uncertain()
      if (['completed', 'failed', 'cancelled'].includes(publication.status)) {
        // Verify coherent native terminal state; it does not require resurrecting expired authority.
        const terminal = await db.transaction((tx) => claimPgBossAttempt(tx, jobId, envelope))
        if (terminal.kind !== 'terminal') uncertain()
        signal.throwIfAborted()
        return
      }
      await revalidatePgBossWorkflowSessionAuthority(matched.reference)
      signal.throwIfAborted()
      const claimed = await db.transaction((tx) => claimPgBossAttempt(tx, jobId, envelope))
      signal.throwIfAborted()
      if (claimed.kind === 'defer') return claimed
      if (claimed.kind === 'terminal') return
      if (claimed.kind !== 'claimed') uncertain()
      // No runner can start until the transaction above has confirmed COMMIT.
      const payload = await db.transaction(async (tx) => {
        if (!(await guardPgBossAttempt(tx, claimed.attempt))) uncertain()
        const [row] = await tx
          .select({ payload: asyncJobs.payload })
          .from(asyncJobs)
          .where(eq(asyncJobs.id, jobId))
        if (!row) uncertain()
        return copyPgBossAdmissionJson(row.payload)
      })
      const run = await preparePgBossNativeRunner(envelope, payload, publication.maxDurationSeconds)
      await revalidatePgBossWorkflowSessionAuthority(matched.reference)
      if (!(await db.transaction((tx) => guardPgBossAttempt(tx, claimed.attempt)))) uncertain()
      signal.throwIfAborted()
      const ownership = new AbortController()
      const runSignal = AbortSignal.any([signal, ownership.signal])
      let checking: Promise<void> | undefined
      // Cancellation observation only: never renews a lease, resets a job or schedules work.
      const monitor = setInterval(() => {
        if (checking) return
        const current = db
          .transaction((tx) => guardPgBossAttempt(tx, claimed.attempt))
          .then(
            (valid) => {
              if (!valid) ownership.abort()
            },
            () => ownership.abort()
          )
        checking = current
        void current.finally(() => {
          if (checking === current) checking = undefined
        })
      }, 250)
      try {
        const output = await run(runSignal)
        clearInterval(monitor)
        await checking
        runSignal.throwIfAborted()
        const outputJson = nativeOutputJson(output)
        const receipt = await db.transaction((tx) =>
          finalizePgBossAttempt(tx, claimed.attempt, { kind: 'returned', outputJson })
        )
        // Only a completed COMMIT and the native business result permit a transport ACK.
        if (receipt.kind !== 'finalized') uncertain()
        runSignal.throwIfAborted()
      } catch {
        // An exception after dispatch is not evidence of no effect. Keep the attempt;
        // no reset/retry and no invented failure/success receipt or slot release here.
        uncertain()
      } finally {
        clearInterval(monitor)
        await checking
      }
    })
  } catch {
    shutdown.abort()
    await pgBossClient.stop()
    throw new Error('durable_workflow_worker_start_failed')
  }
  let stopping: Promise<void> | undefined
  return Object.freeze({
    stop(): Promise<void> {
      if (!stopping) {
        shutdown.abort()
        stopping = pgBossClient.stop()
      }
      return stopping
    },
  })
}
