// Modified by Memlia: preserve native payload/legacy dispatch; durable mode accepts only server-minted admission.
// Modified by Memlia: log durable enqueue refusals with a stable code and safe fields only.
import { randomUUID } from 'node:crypto'
import { createLogger } from '@sim/logger'
import { toError } from '@sim/utils/errors'
import { releaseExecutionSlot } from '@/lib/billing/calculations/usage-reservation'
import { getJobQueue, shouldExecuteInline } from '@/lib/core/async-jobs'
import {
  PgBossWorkflowAdmissionRejection,
  preparePgBossWorkflowAdmission,
} from '@/lib/core/async-jobs/backends/pg-boss-workflow-admission'
import { isAsyncJobEnqueueError } from '@/lib/core/async-jobs/types'
import { toTriggerMaxDurationSeconds } from '@/lib/core/execution-limits'
import { WORKFLOW_EXECUTION_JOB_ID_PREFIX } from '@/lib/workflows/executor/execution-job-ids'
import { executeWorkflowJob } from '@/background/workflow-execution'
import {
  type EnqueueWorkflowExecutionParams,
  prepareWorkflowExecutionPayload,
} from './workflow-execution-payload'

const logger = createLogger('WorkflowEnqueueExecution')

const ASYNC_ENQUEUE_ATTEMPTS = 2

type DurableEnqueueStage = 'admission_preparation' | 'queue_initialization' | 'admission'
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const CORRELATION_ID = /^[A-Za-z0-9_-]{1,128}$/

/** Own data property only: a caller accessor is never run; a malformed value is omitted. */
function ownCorrelationId(params: object, key: 'requestId' | 'workflowId'): string | undefined {
  const value = Object.getOwnPropertyDescriptor(params, key)?.value
  return typeof value === 'string' && CORRELATION_ID.test(value) ? value : undefined
}

/**
 * Server log of a durable refusal, the client response staying unchanged: the admission's bounded
 * refusal code, otherwise only the error class (queue initialization, unclassified errors), never
 * a message, which can carry SQL, parameters or payload.
 */
function logDurableEnqueueRefusal(
  params: object,
  stage: DurableEnqueueStage,
  error: unknown,
  acceptance?: 'rejected' | 'unknown'
): void {
  try {
    const requestId = ownCorrelationId(params, 'requestId')
    const workflowId = ownCorrelationId(params, 'workflowId')
    const reason = error instanceof PgBossWorkflowAdmissionRejection ? error.reason : undefined
    const name = error instanceof Error && ERROR_NAME.test(error.name) ? error.name : undefined
    logger.error(`${requestId ? `[${requestId}] ` : ''}Durable workflow enqueue refused`, {
      code: 'durable_enqueue_refused',
      stage,
      ...(acceptance ? { acceptance } : {}),
      ...(workflowId ? { workflowId } : {}),
      ...(reason ? { reason } : name ? { errorName: name } : {}),
    })
  } catch {
    // Diagnostics never change the refusal returned to the caller.
  }
}

export {
  RESUME_EXECUTION_JOB_ID_PREFIX,
  WORKFLOW_EXECUTION_JOB_ID_PREFIX,
} from '@/lib/workflows/executor/execution-job-ids'
export type { EnqueueWorkflowExecutionParams } from './workflow-execution-payload'

/**
 * Outcome of an async enqueue attempt. Slot/claim semantics are encoded here,
 * not in HTTP statuses (which are ambiguous — a 503 can mean five different
 * things on the execute surface):
 * - `queued`: the job holds the execution slot (`admissionCompleted: true`) and
 *   the execution-id claim must be RETAINED — the worker writes the durable log
 *   row under that id.
 * - `rejected`: the queue definitively refused; the slot was released here and
 *   the claim must be released by the caller.
 * - `ambiguous`: acceptance is unknown — a job may exist, so NEITHER the slot
 *   nor the claim may be released (releasing would double-free under a live
 *   job); the slot leaks to TTL only if the job genuinely never landed.
 */
export type EnqueueWorkflowExecutionResult =
  | { outcome: 'queued'; jobId: string; executionId: string; retainExecutionClaim: true }
  | { outcome: 'rejected'; executionId: string; retainExecutionClaim: false }
  | { outcome: 'ambiguous'; executionId: string; retainExecutionClaim: true }

/**
 * Enqueues an async workflow execution. The caller must have already admitted,
 * claimed the execution id, and reserved the execution slot (via
 * `preprocessExecution`); the enqueued job inherits that reservation.
 * Shared by the v1 and v2 execute routes so retry, acceptance classification,
 * and inline-execution dispatch can never drift between surfaces.
 */
export async function enqueueWorkflowExecution(
  params: EnqueueWorkflowExecutionParams
): Promise<EnqueueWorkflowExecutionResult> {
  // Capture the complete authenticated server input before queue initialization can await.
  // Presence (including malformed configuration) cannot enter the legacy path.
  if (process.env.MEMLIA_DURABLE_WORKFLOWS_ENABLED !== undefined) {
    const executionId = params.executionId
    let queue: Awaited<ReturnType<typeof getJobQueue>>
    let admission: ReturnType<typeof preparePgBossWorkflowAdmission>
    let stage: DurableEnqueueStage = 'admission_preparation'
    try {
      admission = preparePgBossWorkflowAdmission(params, {
        commandId: randomUUID(),
        submittedAt: new Date().toISOString(),
        admissionCompleted: true,
      })
      stage = 'queue_initialization'
      queue = await getJobQueue()
    } catch (error) {
      logDurableEnqueueRefusal(params, stage, error)
      await releaseExecutionSlot(executionId)
      return { outcome: 'rejected', executionId, retainExecutionClaim: false }
    }
    try {
      const jobId = await queue.enqueue('workflow-execution', admission)
      return { outcome: 'queued', jobId, executionId, retainExecutionClaim: true }
    } catch (error) {
      // The native admission handle retains uncertainty across concurrent/previous attempts.
      // Never retry an unknown commit with a new identity or release its native slot.
      const rejected = isAsyncJobEnqueueError(error) && error.acceptance === 'rejected'
      logDurableEnqueueRefusal(params, 'admission', error, rejected ? 'rejected' : 'unknown')
      if (rejected) {
        await releaseExecutionSlot(executionId)
        return { outcome: 'rejected', executionId, retainExecutionClaim: false }
      }
      return { outcome: 'ambiguous', executionId, retainExecutionClaim: true }
    }
  }
  const { requestId, workflowId, userId, workspaceId, executionId, executionTimeoutMs } = params
  const asyncLogger = logger.withMetadata({
    requestId,
    workflowId,
    workspaceId,
    userId,
    executionId,
  })

  const { payload, correlation } = prepareWorkflowExecutionPayload(params)

  let jobQueue: Awaited<ReturnType<typeof getJobQueue>>
  try {
    jobQueue = await getJobQueue()
  } catch (error) {
    asyncLogger.error('Failed to initialize async execution queue', {
      error: toError(error).message,
    })
    await releaseExecutionSlot(executionId)
    return { outcome: 'rejected', executionId, retainExecutionClaim: false }
  }

  const deterministicJobId = `${WORKFLOW_EXECUTION_JOB_ID_PREFIX}${executionId}`
  const executeInline = shouldExecuteInline()
  const enqueueOptions = {
    jobId: deterministicJobId,
    metadata: { workflowId, workspaceId, userId, correlation },
    maxDurationSeconds: toTriggerMaxDurationSeconds(executionTimeoutMs),
    ...(executeInline
      ? {
          runner: (_queuedPayload: unknown, signal: AbortSignal) =>
            executeWorkflowJob(payload, signal),
        }
      : {}),
  }
  let jobId: string | undefined
  let enqueueError: unknown
  let acceptanceCouldBeUnknown = false

  for (let attempt = 1; attempt <= ASYNC_ENQUEUE_ATTEMPTS; attempt++) {
    try {
      jobId = await jobQueue.enqueue('workflow-execution', payload, enqueueOptions)
      enqueueError = undefined
      break
    } catch (error) {
      enqueueError = error
      const classifiedError = isAsyncJobEnqueueError(error) ? error : undefined
      const attemptAcceptance = classifiedError?.acceptance ?? 'unknown'
      acceptanceCouldBeUnknown ||= attemptAcceptance === 'unknown'
      asyncLogger.warn('Async workflow enqueue attempt failed', {
        acceptance: attemptAcceptance,
        attempt,
        error: toError(error).message,
        jobId: deterministicJobId,
      })
      if (classifiedError?.retryable === false || attempt === ASYNC_ENQUEUE_ATTEMPTS) {
        break
      }
    }
  }

  if (!jobId) {
    const acceptance = acceptanceCouldBeUnknown
      ? 'unknown'
      : isAsyncJobEnqueueError(enqueueError)
        ? enqueueError.acceptance
        : 'unknown'
    asyncLogger.error('Failed to queue async execution', {
      acceptance,
      error: toError(enqueueError).message,
      jobId: deterministicJobId,
    })

    if (acceptance === 'rejected') {
      await releaseExecutionSlot(executionId)
      return { outcome: 'rejected', executionId, retainExecutionClaim: false }
    }

    return { outcome: 'ambiguous', executionId, retainExecutionClaim: true }
  }

  asyncLogger.info('Queued async workflow execution', { jobId })

  return { outcome: 'queued', jobId, executionId, retainExecutionClaim: true }
}
