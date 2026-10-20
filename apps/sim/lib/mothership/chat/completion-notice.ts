// Copyright (c) 2026 Memlia. All rights reserved.

import { z } from 'zod'

const count = z.int().min(0).max(Number.MAX_SAFE_INTEGER)
const workflowSchema = z
  .strictObject({
    version: z.literal(1),
    provenance: z.literal('native_port_results'),
    stage: z.enum(['no_preparation', 'preparation_only', 'proposal_not_applied', 'applied']),
    previews: z.strictObject({ evaluated: count, refused: count }),
    proposals: z.strictObject({ created: count, applied: count, skipped: count }),
    latestAppliedRevision: z.strictObject({ baseRevision: count, draftRevision: count }).optional(),
    workflowExecutionByThisChatBackend: z.literal('not_performed'),
  })
  .refine((value) => {
    const { proposals, previews, latestAppliedRevision: revision } = value
    const stage =
      proposals.applied > 0
        ? 'applied'
        : proposals.created > 0
          ? 'proposal_not_applied'
          : previews.evaluated + previews.refused > 0
            ? 'preparation_only'
            : 'no_preparation'
    return (
      value.stage === stage &&
      proposals.created === proposals.applied + proposals.skipped &&
      proposals.applied > 0 === (revision !== undefined) &&
      (!revision || revision.draftRevision >= revision.baseRevision)
    )
  })
const responseSchema = z.strictObject({
  modelTurn: z.strictObject({
    finishReason: z.enum(['end_turn', 'stop_sequence', 'max_tokens', 'not_observed']),
  }),
  workflow: workflowSchema,
})

const WORKFLOW_NOTICES: Record<z.infer<typeof workflowSchema>['stage'], string> = {
  no_preparation: 'Pour ce tour, le serveur ne signale ni préparation ni modification du workflow.',
  preparation_only: 'Une préparation du workflow est signalée, sans modification appliquée.',
  proposal_not_applied: 'Une proposition est signalée, sans modification appliquée.',
  applied:
    'Une modification du workflow est signalée comme appliquée. Cela ne valide ni l’ensemble de la demande ni le résultat du workflow.',
}

/**
 * Display-only projection of the closed local-backend observation. Never renders
 * provider text/IDs/counts as markup, authorizes an action, or changes a verdict.
 * Ordinary/legacy completions keep their existing presentation.
 */
export function buildCompletionNotice(payload: {
  status?: unknown
  response?: unknown
}): string | undefined {
  if (payload.status !== 'complete') return undefined
  const parsed = responseSchema.safeParse(payload.response)
  if (!parsed.success || parsed.data.modelTurn.finishReason !== 'max_tokens') return undefined
  return (
    '\n\n> **Réponse limitée** — Le modèle a atteint sa limite de sortie. La réponse peut être vide ou incomplète.' +
    '\n>\n> **Workflow** — ' +
    WORKFLOW_NOTICES[parsed.data.workflow.stage] +
    '\n>\n> Aucune exécution du workflow par ce Chat n’est signalée.'
  )
}
