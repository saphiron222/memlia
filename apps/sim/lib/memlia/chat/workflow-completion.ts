// Copyright (c) 2026 Memlia. All rights reserved.

import { z } from 'zod'

const count = z.int().min(0).max(Number.MAX_SAFE_INTEGER)
const previewsSchema = z.strictObject({ evaluated: count, refused: count })
const proposalsSchema = z.strictObject({ created: count, applied: count, skipped: count })
const revisionSchema = z
  .strictObject({
    baseRevision: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
    draftRevision: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .refine((value) => value.draftRevision >= value.baseRevision)

export type WorkflowPreparation = Readonly<z.infer<typeof previewsSchema>>

/** Mechanical navigation only: neither validation of code nor permission to apply. */
export const workflowPreviewNextStep = Object.freeze({
  kind: 'review_diagnostics_then_propose_or_clarify' as const,
  proposalTool: 'propose_workflow_operations' as const,
  humanApprovalRequired: true as const,
})

/**
 * Server observations, never model declarations. The transport can finish while
 * the requested edit remains unprepared/unproposed. No semantic classification
 * of text (including clarification), overall task success or code correctness.
 */
export function workflowCompletion(
  previewObservations: WorkflowPreparation,
  proposalObservations: z.infer<typeof proposalsSchema>,
  latestAppliedRevision?: z.infer<typeof revisionSchema>
) {
  const previews = previewsSchema.parse(previewObservations)
  const proposals = proposalsSchema.parse(proposalObservations)
  const latest =
    latestAppliedRevision === undefined ? undefined : revisionSchema.parse(latestAppliedRevision)
  if (
    proposals.created !== proposals.applied + proposals.skipped ||
    proposals.applied > 0 !== (latest !== undefined)
  )
    throw new Error('Workflow completion is unavailable.')
  return Object.freeze({
    version: 1 as const,
    provenance: 'native_port_results' as const,
    stage:
      proposals.applied > 0
        ? ('applied' as const)
        : proposals.created > 0
          ? ('proposal_not_applied' as const)
          : previews.evaluated + previews.refused > 0
            ? ('preparation_only' as const)
            : ('no_preparation' as const),
    previews: Object.freeze(previews),
    proposals: Object.freeze(proposals),
    ...(latest ? { latestAppliedRevision: Object.freeze(latest) } : {}),
    workflowExecutionByThisChatBackend: 'not_performed' as const,
  })
}
