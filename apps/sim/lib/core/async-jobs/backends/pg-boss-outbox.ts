// Copyright (c) 2026 Memlia. All rights reserved.
import { db } from '@sim/db'
import type { OutboxHandlerRegistry } from '@/lib/core/outbox/service'
import {
  PG_BOSS_OUTBOX_EVENT,
  PgBossAdmissionError,
  readPgBossPublication,
} from './pg-boss-admission'
import { PgBossClientError, pgBossClient } from './pg-boss-client'
import { PgBossTransportError } from './pg-boss-transport'

/** Native outbox retries transport publication, never workflow/business execution. */
export const pgBossOutboxHandlers: OutboxHandlerRegistry = {
  [PG_BOSS_OUTBOX_EVENT]: async (payload, context) => {
    try {
      context.signal.throwIfAborted()
      const admission = await readPgBossPublication(db, payload)
      if (context.eventId !== admission.outboxEventId)
        throw new PgBossAdmissionError('admission_identity_conflict')
      if (['cancelled', 'failed', 'completed'].includes(admission.status)) return
      if (admission.status !== 'pending')
        throw new PgBossAdmissionError('admission_reconciliation_required')
      const transport = await pgBossClient.get()
      context.signal.throwIfAborted()
      // Unknown acceptance propagates unchanged. Retry uses exactly this ID/envelope.
      await transport.publish(admission.jobId, admission.envelope)
      context.signal.throwIfAborted()
    } catch (error) {
      if (
        error instanceof PgBossAdmissionError ||
        error instanceof PgBossClientError ||
        error instanceof PgBossTransportError
      )
        throw error
      // Native outbox persists the message: never pass a raw driver/abort reason through it.
      throw new PgBossAdmissionError('publication_persistence_unknown', 'unknown')
    }
  },
}
