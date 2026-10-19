// Copyright 2026 Memlia. All rights reserved.
import { createHash } from 'node:crypto'
import { JobEnvelopeSchema } from '@memlia/contracts'
import { parsePrincipal, type SessionPrincipal } from '@sim/auth/principal'
import { db } from '@sim/db'
import { assertBillingAttributionSnapshot } from '@/lib/billing/core/attribution'
import { toTriggerMaxDurationSeconds } from '@/lib/core/execution-limits'
import { WORKFLOW_EXECUTION_JOB_ID_PREFIX } from '@/lib/workflows/executor/execution-job-ids'
import {
  type EnqueueWorkflowExecutionParams,
  prepareWorkflowExecutionPayload,
} from '@/lib/workflows/executor/workflow-execution-payload'
import { CORE_TRIGGER_TYPES } from '@/stores/logs/filters/types'
import { AsyncJobEnqueueError, validateMaxDurationSeconds } from '../types'
import { admitPgBossJob, copyPgBossAdmissionJson, PgBossAdmissionError } from './pg-boss-admission'
import { capturePgBossWorkflowSessionAuthority } from './pg-boss-workflow-session-authority'

export interface PreparedPgBossWorkflowAdmission {
  readonly kind: 'prepared_workflow_admission'
}

interface PreparedState {
  principal: SessionPrincipal
  payload: ReturnType<typeof prepareWorkflowExecutionPayload>['payload']
  metadata: Record<string, unknown>
  commandId: string
  submittedAt: string
  maxDurationSeconds: number
  inFlight: number
  possiblyAccepted: boolean
}
// A structural value is not provenance. Only handles minted here resolve a private snapshot.
// The server caller must still authenticate and complete native preprocessing/reservation.
const prepared = new WeakMap<PreparedPgBossWorkflowAdmission, PreparedState>()

function rejection(acceptance: 'rejected' | 'unknown' = 'rejected') {
  return new AsyncJobEnqueueError('workflow_admission_rejected', { acceptance, retryable: false })
}

const optionalNativeFields = new Set([
  'triggerBlockId',
  'copilotToolCallId',
  'callChain',
  'trustedInitialResolvedSecretTraceProvenance',
])

/**
 * Internal server boundary, NOT authentication or an HTTP DTO. Call once after native
 * preprocessing/slot reservation; retain this handle across persistence attempts.
 * commandId/submittedAt must be stable server values, never regenerated on retry.
 */
export function preparePgBossWorkflowAdmission(
  params: EnqueueWorkflowExecutionParams,
  identity: { commandId: string; submittedAt: string; admissionCompleted: true }
): PreparedPgBossWorkflowAdmission {
  try {
    // Remove only known, absent native optionals. Preserve descriptors so JSON validation
    // rejects accessors without invoking them, including top-level caller properties.
    const descriptors = Object.getOwnPropertyDescriptors(params)
    for (const key of optionalNativeFields) {
      if (
        descriptors[key]?.enumerable &&
        'value' in descriptors[key] &&
        descriptors[key].value === undefined
      )
        delete descriptors[key]
    }
    const raw = copyPgBossAdmissionJson(
      Object.defineProperties(
        Object.create(Object.getPrototypeOf(params)),
        descriptors
      ) as EnqueueWorkflowExecutionParams
    )
    const id = copyPgBossAdmissionJson(identity)
    if (
      Object.keys(id).sort().join(',') !== 'admissionCompleted,commandId,submittedAt' ||
      id.admissionCompleted !== true ||
      raw.enforceCredentialAccess !== true ||
      raw.isPublicApiAccess !== false
    )
      throw rejection()
    const commandId = JobEnvelopeSchema.shape.commandId.parse(id.commandId)
    const submittedAt = JobEnvelopeSchema.shape.submittedAt.parse(id.submittedAt)
    JobEnvelopeSchema.shape.runId.parse(raw.executionId)
    for (const value of [raw.workflowId, raw.workspaceId, raw.userId, raw.requestId]) {
      if (typeof value !== 'string' || value.length === 0 || value.length > 128) throw rejection()
    }
    const principal = parsePrincipal({ version: 1, principal: raw.principal })
    if (principal.kind !== 'session' || principal.userId !== raw.userId) throw rejection()
    const billingAttribution = assertBillingAttributionSnapshot(raw.billingAttribution)
    if (
      billingAttribution.actorUserId !== principal.userId ||
      billingAttribution.workspaceId !== raw.workspaceId
    )
      throw rejection()
    if (
      !CORE_TRIGGER_TYPES.includes(raw.triggerType) ||
      !Number.isFinite(raw.executionTimeoutMs) ||
      raw.executionTimeoutMs <= 0
    )
      throw rejection()
    const maxDurationSeconds = validateMaxDurationSeconds(
      toTriggerMaxDurationSeconds(raw.executionTimeoutMs)
    )
    if (maxDurationSeconds === undefined) throw rejection()
    const { payload, correlation } = prepareWorkflowExecutionPayload({
      ...raw,
      principal,
      billingAttribution,
    })
    const snapshot = copyPgBossAdmissionJson({
      payload,
      metadata: {
        workflowId: raw.workflowId,
        workspaceId: raw.workspaceId,
        userId: raw.userId,
        correlation,
      },
    })
    const handle = Object.freeze({ kind: 'prepared_workflow_admission' as const })
    prepared.set(handle, {
      ...snapshot,
      principal,
      commandId,
      submittedAt,
      maxDurationSeconds,
      possiblyAccepted: false,
      inFlight: 0,
    })
    return handle
  } catch {
    throw rejection()
  }
}

/** Owns the top-level commit. No consumer, slot release, business effect, ACK or retry. */
export async function admitPgBossWorkflowAdmission(handle: PreparedPgBossWorkflowAdmission) {
  const state = prepared.get(handle)
  if (!state) throw rejection()
  // The private snapshot is never returned or passed to caller callbacks.
  const { principal, payload, metadata, commandId, submittedAt, maxDurationSeconds } = state
  let transactionStarted = false
  // Authority reads can pause after observing a live session; that attempt may still commit.
  // Count the entire operation before its first await, independently of DB error classification.
  state.inFlight++
  try {
    const authority = await capturePgBossWorkflowSessionAuthority({
      authenticatedPrincipal: principal,
      workflowId: payload.workflowId,
      workspaceId: payload.workspaceId,
    })
    if (authority.organizationId !== payload.billingAttribution.organizationId) throw rejection()
    const envelope = JobEnvelopeSchema.parse({
      schemaVersion: 'memlia.job/v1',
      commandId,
      runId: payload.executionId,
      runner: 'workflow-execution',
      inputs: [],
      authority,
      submittedAt,
      idempotencyKey: createHash('sha256')
        .update(
          JSON.stringify([authority.organizationId, authority.workspaceId, payload.executionId])
        )
        .digest('hex'),
      effectPolicy: { kind: 'no_automatic_retry' },
    })
    transactionStarted = true
    const result = await db.transaction((tx) =>
      admitPgBossJob(tx, {
        jobId: `${WORKFLOW_EXECUTION_JOB_ID_PREFIX}${payload.executionId}`,
        envelope,
        payload,
        metadata,
        maxDurationSeconds,
        runAt: submittedAt,
      })
    )
    state.possiblyAccepted = true
    return { kind: 'admission_committed' as const, ...result }
  } catch (error) {
    if (
      transactionStarted &&
      !(error instanceof PgBossAdmissionError && error.acceptance === 'rejected')
    )
      state.possiblyAccepted = true
    // Preserve uncertainty across retries, including concurrent attempts and later revocation.
    if (state.inFlight > 1) state.possiblyAccepted = true
    throw rejection(state.possiblyAccepted ? 'unknown' : 'rejected')
  } finally {
    state.inFlight--
  }
}
