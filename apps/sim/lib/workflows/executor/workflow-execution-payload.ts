// SPDX-License-Identifier: Apache-2.0
// Derived from Sim enqueue-execution.ts (c6cef5f87b6a1d1d01df89e7140bad9e9fd4c2e2).
// Modified by Memlia: extract native preparation; omit absent optional fields.
// No runner is imported at runtime.
import { serializePrincipal, type WorkflowExecutionPrincipal } from '@sim/auth/principal'
import type { BillingAttributionSnapshot } from '@/lib/billing/core/attribution'
import { captureRequestAttribution } from '@/lib/core/utils/request-attribution'
import type { WorkflowExecutionPayload } from '@/background/workflow-execution'
import type { ResolvedSecretTraceProvenanceV1 } from '@/executor/utils/resolved-secret-trace-registry'
import type { CoreTriggerType } from '@/stores/logs/filters/types'

export interface EnqueueWorkflowExecutionParams {
  requestId: string
  workflowId: string
  principal: WorkflowExecutionPrincipal
  userId: string
  billingAttribution: BillingAttributionSnapshot
  workspaceId: string
  input: unknown
  triggerType: CoreTriggerType
  triggerBlockId?: string
  executionId: string
  copilotToolCallId?: string
  callChain?: string[]
  executionTimeoutMs: number
  trustedInitialResolvedSecretTraceProvenance?: ResolvedSecretTraceProvenanceV1
  /** Identity decisions the enqueuing surface made; the worker cannot re-derive them. */
  enforceCredentialAccess?: boolean
  isPublicApiAccess?: boolean
}

export function prepareWorkflowExecutionPayload(params: EnqueueWorkflowExecutionParams) {
  const {
    requestId,
    workflowId,
    principal,
    userId,
    billingAttribution,
    workspaceId,
    input,
    triggerType,
    triggerBlockId,
    executionId,
    copilotToolCallId,
    callChain,
    executionTimeoutMs,
    trustedInitialResolvedSecretTraceProvenance,
    enforceCredentialAccess,
    isPublicApiAccess,
  } = params
  const attribution = captureRequestAttribution()
  const correlation = {
    executionId,
    requestId,
    source: 'workflow' as const,
    workflowId,
    ...(copilotToolCallId ? { copilotToolCallId } : {}),
    triggerType,
  }

  const payload = {
    workflowId,
    principal: serializePrincipal(principal),
    userId,
    billingAttribution,
    workspaceId,
    input,
    triggerType,
    ...(triggerBlockId !== undefined ? { triggerBlockId } : {}),
    executionId,
    requestId,
    correlation,
    ...(callChain !== undefined ? { callChain } : {}),
    ...(attribution !== undefined ? { attribution } : {}),
    ...(enforceCredentialAccess !== undefined ? { enforceCredentialAccess } : {}),
    ...(isPublicApiAccess !== undefined ? { isPublicApiAccess } : {}),
    executionMode: 'async',
    admissionCompleted: true,
    executionTimeoutMs,
    ...(trustedInitialResolvedSecretTraceProvenance !== undefined
      ? { trustedInitialResolvedSecretTraceProvenance }
      : {}),
  } satisfies WorkflowExecutionPayload

  return { payload, correlation }
}
