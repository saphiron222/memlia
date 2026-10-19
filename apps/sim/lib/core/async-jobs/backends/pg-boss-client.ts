// Copyright (c) 2026 Memlia. All rights reserved.
import { createLogger } from '@sim/logger'
import { PgBossTransport } from './pg-boss-transport'

const logger = createLogger('MemliaPgBossClient')
// Fixed server-side namespace; never selected by a job payload.
const SCHEMA = 'memlia_jobs'
const QUEUE = 'memlia_native'

type Configuration = Record<string, string | undefined>

export class PgBossClientError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'PgBossClientError'
  }
}

/** No connection at construction/import. A stopped instance never reopens itself. */
export function createPgBossClient(config: Configuration = process.env) {
  let connecting: Promise<PgBossTransport> | undefined
  let stopping: Promise<void> | undefined
  let closed = false
  return {
    async get(): Promise<PgBossTransport> {
      if (closed) throw new PgBossClientError('pg_boss_client_closed')
      if (config.MEMLIA_PG_BOSS_ENABLED !== '1') throw new PgBossClientError('pg_boss_disabled')
      const connectionString = config.MEMLIA_PG_BOSS_DATABASE_URL
      if (!connectionString) throw new PgBossClientError('pg_boss_database_url_required')
      try {
        const url = new URL(connectionString)
        if (
          !['postgres:', 'postgresql:'].includes(url.protocol) ||
          !url.hostname ||
          url.pathname === '/'
        ) {
          throw new Error()
        }
      } catch {
        throw new PgBossClientError('pg_boss_database_url_invalid')
      }
      if (!connecting) {
        const attempt = PgBossTransport.connect({
          connectionString,
          schema: SCHEMA,
          queueName: QUEUE,
          createSchema: false,
          onError: (code) => logger.error(code),
        })
        connecting = attempt
        // An unavailable server can recover on a later native outbox attempt.
        void attempt.catch(() => {
          if (connecting === attempt) connecting = undefined
        })
      }
      return connecting
    },
    stop(): Promise<void> {
      if (stopping) return stopping
      closed = true
      const current = connecting
      stopping = (async () => {
        // Failed startup has already closed its pool inside PgBossTransport.
        const transport = await current?.catch(() => undefined)
        if (transport) await transport.stop()
      })()
      return stopping
    },
  }
}

export const pgBossClient = createPgBossClient()
