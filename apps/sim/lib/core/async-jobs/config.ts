// Modified by Memlia: explicit durable selection rejects inline and mixed backend caches.
import { createLogger } from '@sim/logger'
import { taskContext } from '@trigger.dev/core/v3'
import {
  AsyncJobEnqueueError,
  type AsyncBackendType,
  type JobQueueBackend,
} from '@/lib/core/async-jobs/types'
import { getConfiguredAsyncJobsProvider } from '@/lib/core/config/env-capabilities.server'

const logger = createLogger('AsyncJobsConfig')

let cachedBackend: JobQueueBackend | null = null
let cachedBackendType: AsyncBackendType | null = null
let cachedInlineBackend: JobQueueBackend | null = null

/**
 * Determines which async backend to use based on environment configuration.
 * Falls back to the database backend when trigger.dev isn't enabled — except
 * when this process IS a trigger.dev worker (`taskContext.isInsideTask`), in
 * which case the SDK runtime is available regardless of env vars and we
 * always want to enqueue back through trigger.dev. Without this carve-out, a
 * worker pod missing `TRIGGER_DEV_ENABLED=true` silently routes cell jobs to
 * the database backend that nothing's draining.
 */
export function getAsyncBackendType(): AsyncBackendType {
  if (taskContext.isInsideTask) {
    // Preserve native task selection unless durable mode was explicitly requested.
    if (process.env.MEMLIA_DURABLE_WORKFLOWS_ENABLED !== undefined)
      throw new AsyncJobEnqueueError('durable_workflow_backend_conflict', {
        acceptance: 'rejected',
        retryable: false,
      })
    return 'trigger-dev'
  }
  return getConfiguredAsyncJobsProvider()
}

/**
 * Gets the job queue backend singleton.
 * Creates the appropriate backend based on environment configuration.
 */
export async function getJobQueue(): Promise<JobQueueBackend> {
  // Keep the native legacy cache path unchanged when durable selection is absent.
  if (
    cachedBackend &&
    cachedBackendType !== 'pg-boss' &&
    process.env.MEMLIA_DURABLE_WORKFLOWS_ENABLED === undefined
  )
    return cachedBackend
  const type = getAsyncBackendType()
  if (cachedBackend) {
    if (cachedBackendType !== type)
      throw new AsyncJobEnqueueError('async_backend_configuration_changed', {
        acceptance: 'rejected',
        retryable: false,
      })
    return cachedBackend
  }

  switch (type) {
    case 'pg-boss': {
      const { PgBossJobQueue } = await import('@/lib/core/async-jobs/backends/pg-boss')
      cachedBackend = new PgBossJobQueue()
      break
    }
    case 'trigger-dev': {
      const { TriggerDevJobQueue } = await import('@/lib/core/async-jobs/backends/trigger-dev')
      cachedBackend = new TriggerDevJobQueue()
      break
    }
    case 'database': {
      const { DatabaseJobQueue } = await import('@/lib/core/async-jobs/backends/database')
      cachedBackend = new DatabaseJobQueue()
      break
    }
  }

  cachedBackendType = type
  logger.info(`Async job backend initialized: ${type}`)

  if (!cachedBackend) {
    throw new Error(`Failed to initialize async backend: ${type}`)
  }

  return cachedBackend
}

/**
 * Gets the current backend type (for logging/debugging)
 */
export function getCurrentBackendType(): AsyncBackendType | null {
  return cachedBackendType
}

/**
 * Gets a job queue backend that bypasses Trigger.dev (Database only).
 * Used for execution paths that must avoid Trigger.dev cold starts.
 */
export async function getInlineJobQueue(): Promise<JobQueueBackend> {
  if (
    process.env.MEMLIA_DURABLE_WORKFLOWS_ENABLED !== undefined ||
    cachedBackendType === 'pg-boss'
  ) {
    getAsyncBackendType() // Malformed presence is also a refusal, never an inline fallback.
    throw new AsyncJobEnqueueError('durable_workflow_inline_unsupported', {
      acceptance: 'rejected',
      retryable: false,
    })
  }
  if (cachedInlineBackend) {
    return cachedInlineBackend
  }

  const { DatabaseJobQueue } = await import('@/lib/core/async-jobs/backends/database')
  cachedInlineBackend = new DatabaseJobQueue()

  logger.info('Inline job backend initialized: database')
  return cachedInlineBackend
}

/**
 * Checks if jobs should be executed inline in-process.
 * Database fallback is the only mode that still relies on inline execution.
 */
export function shouldExecuteInline(): boolean {
  return getAsyncBackendType() === 'database'
}

/**
 * Resets the cached backend (useful for testing)
 */
export function resetJobQueueCache(): void {
  cachedBackend = null
  cachedBackendType = null
  cachedInlineBackend = null
}
