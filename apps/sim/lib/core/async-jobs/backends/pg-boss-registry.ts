// Copyright 2026 Memlia. All rights reserved.
import { isDeepStrictEqual } from 'node:util'
import type { JobEnvelope } from '@memlia/contracts'
import { parsePrincipal } from '@sim/auth/principal'
import { assertBillingAttributionSnapshot } from '@/lib/billing/core/attribution'
import { toTriggerMaxDurationSeconds } from '@/lib/core/execution-limits'
import type { WorkflowExecutionPayload } from '@/background/workflow-execution'
import { CORE_TRIGGER_TYPES } from '@/stores/logs/filters/types'
import { copyPgBossAdmissionJson } from './pg-boss-admission'

function refused(): never {
  throw new Error('durable_workflow_runner_rejected')
}

/** Closed native registry. Stored data selects a known runner, never executable code. */
export async function preparePgBossNativeRunner(
  envelope: JobEnvelope,
  value: unknown,
  maxDurationSeconds: number
): Promise<(signal: AbortSignal) => Promise<unknown>> {
  if (envelope.runner !== 'workflow-execution') refused()
  // Input is already admitted and integrity checked under the attempt lock. This check
  // prevents the native runner's legacy-principal/default-flag branches from being used.
  const copy = copyPgBossAdmissionJson(value)
  if (!copy || typeof copy !== 'object' || Array.isArray(copy)) refused()
  const payload = copy as Record<string, unknown>
  const principal = parsePrincipal(payload.principal)
  const billing = assertBillingAttributionSnapshot(payload.billingAttribution)
  if (
    principal.kind !== 'session' ||
    !isDeepStrictEqual(payload.principal, envelope.authority.actor) ||
    payload.userId !== principal.userId ||
    payload.workspaceId !== envelope.authority.workspaceId ||
    billing.actorUserId !== principal.userId ||
    billing.workspaceId !== payload.workspaceId ||
    billing.organizationId !== envelope.authority.organizationId ||
    payload.executionId !== envelope.runId ||
    payload.executionMode !== 'async' ||
    payload.admissionCompleted !== true ||
    payload.enforceCredentialAccess !== true ||
    payload.isPublicApiAccess !== false ||
    typeof payload.workflowId !== 'string' ||
    !payload.workflowId ||
    typeof payload.requestId !== 'string' ||
    !payload.requestId ||
    typeof payload.executionTimeoutMs !== 'number' ||
    !Number.isFinite(payload.executionTimeoutMs) ||
    payload.executionTimeoutMs <= 0 ||
    toTriggerMaxDurationSeconds(payload.executionTimeoutMs) !== maxDurationSeconds ||
    !CORE_TRIGGER_TYPES.some((type) => type === payload.triggerType)
  )
    refused()
  // The private detached value is the native payload minted at admission, not a new DTO.
  const native = copy as WorkflowExecutionPayload
  const { executeWorkflowJob } = await import('@/background/workflow-execution')
  return (signal) => executeWorkflowJob(native, signal)
}
