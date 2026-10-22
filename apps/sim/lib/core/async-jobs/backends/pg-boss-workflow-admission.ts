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
import { PG_BOSS_MAX_DURATION_SECONDS } from './pg-boss-transport'
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

/**
 * One bounded code per refusing check, for the server log only: the error message, acceptance and
 * client response are those of every admission refusal. `admission_*` are the fixed codes of
 * `PgBossAdmissionError` raised by persistence.
 */
export type PgBossWorkflowAdmissionRefusal =
  | 'caller_input_not_strict_json'
  | 'identity_not_strict_json'
  | 'identity_shape'
  | 'credential_enforcement'
  | 'public_api_access'
  | 'command_id_invalid'
  | 'submitted_at_invalid'
  | 'execution_id_invalid'
  | 'correlation_id_invalid'
  | 'principal_invalid'
  | 'principal_not_session'
  | 'actor_mismatch'
  | 'billing_attribution_invalid'
  | 'billing_attribution_mismatch'
  | 'trigger_type_unsupported'
  | 'execution_timeout_invalid'
  | 'max_duration_invalid'
  | 'payload_preparation_failed'
  | 'payload_not_strict_json'
  | 'preparation_unclassified'
  | 'admission_handle_unknown'
  | 'authority_refused'
  | 'authority_organization_mismatch'
  | 'envelope_invalid'
  | 'persistence_unknown'
  | `admission_${string}`

export class PgBossWorkflowAdmissionRejection extends AsyncJobEnqueueError {
  constructor(
    readonly reason: PgBossWorkflowAdmissionRefusal,
    acceptance: 'rejected' | 'unknown' = 'rejected'
  ) {
    super('workflow_admission_rejected', { acceptance, retryable: false })
  }
}

function rejection(
  reason: PgBossWorkflowAdmissionRefusal,
  acceptance: 'rejected' | 'unknown' = 'rejected'
) {
  return new PgBossWorkflowAdmissionRejection(reason, acceptance)
}

/** Runs one native check: any throw, never its message or cause, refuses with that check's code. */
function checked<T>(reason: PgBossWorkflowAdmissionRefusal, run: () => T): T {
  try {
    return run()
  } catch {
    throw rejection(reason)
  }
}

const PERSISTENCE_CODE = /^admission_[a-z_]{1,48}$/

const optionalNativeFields = new Set([
  // A session queue request (queueSessionWorkflowContract) may carry no input at all.
  'input',
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
    const raw = checked('caller_input_not_strict_json', () =>
      copyPgBossAdmissionJson(
        Object.defineProperties(
          Object.create(Object.getPrototypeOf(params)),
          descriptors
        ) as EnqueueWorkflowExecutionParams
      )
    )
    const id = checked('identity_not_strict_json', () => copyPgBossAdmissionJson(identity))
    if (
      Object.keys(id).sort().join(',') !== 'admissionCompleted,commandId,submittedAt' ||
      id.admissionCompleted !== true
    )
      throw rejection('identity_shape')
    if (raw.enforceCredentialAccess !== true) throw rejection('credential_enforcement')
    if (raw.isPublicApiAccess !== false) throw rejection('public_api_access')
    const commandId = checked('command_id_invalid', () =>
      JobEnvelopeSchema.shape.commandId.parse(id.commandId)
    )
    const submittedAt = checked('submitted_at_invalid', () =>
      JobEnvelopeSchema.shape.submittedAt.parse(id.submittedAt)
    )
    checked('execution_id_invalid', () => JobEnvelopeSchema.shape.runId.parse(raw.executionId))
    for (const value of [raw.workflowId, raw.workspaceId, raw.userId, raw.requestId]) {
      if (typeof value !== 'string' || value.length === 0 || value.length > 128)
        throw rejection('correlation_id_invalid')
    }
    const principal = checked('principal_invalid', () =>
      parsePrincipal({ version: 1, principal: raw.principal })
    )
    if (principal.kind !== 'session') throw rejection('principal_not_session')
    if (principal.userId !== raw.userId) throw rejection('actor_mismatch')
    const billingAttribution = checked('billing_attribution_invalid', () =>
      assertBillingAttributionSnapshot(raw.billingAttribution)
    )
    if (
      billingAttribution.actorUserId !== principal.userId ||
      billingAttribution.workspaceId !== raw.workspaceId
    )
      throw rejection('billing_attribution_mismatch')
    if (!CORE_TRIGGER_TYPES.includes(raw.triggerType)) throw rejection('trigger_type_unsupported')
    if (!Number.isFinite(raw.executionTimeoutMs) || raw.executionTimeoutMs <= 0)
      throw rejection('execution_timeout_invalid')
    const maxDurationSeconds = checked('max_duration_invalid', () =>
      validateMaxDurationSeconds(toTriggerMaxDurationSeconds(raw.executionTimeoutMs))
    )
    if (maxDurationSeconds === undefined || maxDurationSeconds > PG_BOSS_MAX_DURATION_SECONDS)
      throw rejection('max_duration_invalid')
    const { payload, correlation } = checked('payload_preparation_failed', () =>
      prepareWorkflowExecutionPayload({
        ...raw,
        principal,
        billingAttribution,
      })
    )
    const snapshot = checked('payload_not_strict_json', () =>
      copyPgBossAdmissionJson({
        payload,
        metadata: {
          workflowId: raw.workflowId,
          workspaceId: raw.workspaceId,
          userId: raw.userId,
          correlation,
        },
      })
    )
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
  } catch (error) {
    throw error instanceof PgBossWorkflowAdmissionRejection
      ? error
      : rejection('preparation_unclassified')
  }
}

/** Owns the top-level commit. No consumer, slot release, business effect, ACK or retry. */
export async function admitPgBossWorkflowAdmission(handle: PreparedPgBossWorkflowAdmission) {
  const state = prepared.get(handle)
  if (!state) throw rejection('admission_handle_unknown')
  // The private snapshot is never returned or passed to caller callbacks.
  const { principal, payload, metadata, commandId, submittedAt, maxDurationSeconds } = state
  let transactionStarted = false
  let step: 'authority' | 'envelope' | 'persistence' = 'authority'
  // Authority reads can pause after observing a live session; that attempt may still commit.
  // Count the entire operation before its first await, independently of DB error classification.
  state.inFlight++
  try {
    const authority = await capturePgBossWorkflowSessionAuthority({
      authenticatedPrincipal: principal,
      workflowId: payload.workflowId,
      workspaceId: payload.workspaceId,
    })
    if (authority.organizationId !== payload.billingAttribution.organizationId)
      throw rejection('authority_organization_mismatch')
    step = 'envelope'
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
    step = 'persistence'
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
    const reason: PgBossWorkflowAdmissionRefusal =
      error instanceof PgBossWorkflowAdmissionRejection
        ? error.reason
        : step === 'authority'
          ? 'authority_refused'
          : step === 'envelope'
            ? 'envelope_invalid'
            : error instanceof PgBossAdmissionError && PERSISTENCE_CODE.test(error.code)
              ? (error.code as `admission_${string}`)
              : 'persistence_unknown'
    throw rejection(reason, state.possiblyAccepted ? 'unknown' : 'rejected')
  } finally {
    state.inFlight--
  }
}
