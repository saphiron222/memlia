// Copyright (c) 2026 Memlia. All rights reserved.

import {
  v2ApplyWorkflowOperationsBodySchema,
  v2WorkflowSkippedItemTypeSchema,
} from '@/lib/api/contracts/v2/workflows'
import { OrchestrationError } from '@/lib/core/orchestration/types'
import { stringifyBoundedJson } from '@/lib/core/utils/bounded-json'
import { waitWithAbort } from '@/lib/core/utils/concurrency'
import {
  analyzeFunctionCode,
  FUNCTION_ANALYSIS_LIMITS,
} from '@/lib/execution/code-placeholders/analyze-function-code'
import { applyWorkflowOperations } from '@/lib/workflows/application/apply-workflow-operations'
import { WorkflowOperationsNotAppliedError } from '@/lib/workflows/application/operations-error'
import type { WorkflowLintReport } from '@/lib/workflows/editing/lint'
import type { SkippedItem, ValidationError } from '@/lib/workflows/editing/types'
import { MAX_IMPORT_BODY_BYTES } from '@/lib/workflows/operations/import-workflow'
import { normalizeName } from '@/executor/constants'
import { createWorkflowProposal } from './workflow-proposals.server'
import { workflowPreviewNextStep } from './workflow-completion'

type PreviewContext = {
  principal: Parameters<typeof applyWorkflowOperations.execute>[0]['principal']
  workspaceId: string
  workflowId: string
  /** Set only by the local authenticated run owner; never a model argument. */
  proposalRunId?: string
}
export const workflowPreviewInputs = Object.freeze({
  preview_workflow_operations: v2ApplyWorkflowOperationsBodySchema,
})

/** Evaluates an owned batch with the native engine; never authorizes or persists an apply. */
export function createWorkflowPreviewTools({
  principal,
  workspaceId,
  workflowId,
  proposalRunId,
}: PreviewContext) {
  const ownedPrincipal = structuredClone(principal)
  async function evaluate(params: unknown, signal?: AbortSignal) {
    const captured = stringifyBoundedJson(params, MAX_IMPORT_BODY_BYTES, { strict: true })
    if (captured === undefined) return failure('invalid_input')
    const parsed = v2ApplyWorkflowOperationsBodySchema.safeParse(JSON.parse(captured))
    if (!parsed.success) return failure('invalid_input')
    const input = parsed.data
    if (ownedPrincipal.kind === 'delegated' && ownedPrincipal.workspaceId !== workspaceId)
      return failure('forbidden')
    let result: Awaited<ReturnType<typeof applyWorkflowOperations.execute>>
    try {
      result = await applyWorkflowOperations.execute({
        principal: ownedPrincipal,
        input: {
          workflowId,
          assertedWorkspaceId: workspaceId,
          expectedRevision: input.expectedRevision,
          operations: input.operations,
          atomic: input.atomic,
          layout: input.layout,
          blockEnabledChanges: input.setBlockEnabled?.map(({ block_id, enabled }) => ({
            blockId: block_id,
            enabled,
          })),
          dryRun: true,
          checkAborted: () => signal?.throwIfAborted(),
        },
      })
    } catch (error) {
      signal?.throwIfAborted()
      if (error instanceof WorkflowOperationsNotAppliedError)
        return {
          ...failure('atomic_refused'),
          diagnostics: {
            skipped: projectSkipped(error.skipped, input),
            inputValidationErrorCount: error.droppedInputs.length,
            inputValidationErrors: projectInputErrors(error.droppedInputs, input),
          },
        }
      throw error
    }
    signal?.throwIfAborted()
    if (
      result.workflowId !== workflowId ||
      result.workspaceId !== workspaceId ||
      result.dryRun !== true ||
      result.baseRevision !== input.expectedRevision ||
      result.draftRevision !== input.expectedRevision ||
      result.operationCount !== input.operations.length ||
      !Number.isSafeInteger(result.applied) ||
      result.applied < 0 ||
      result.applied > input.operations.length + (input.setBlockEnabled?.length ?? 0) ||
      typeof result.needsRedeployment !== 'boolean'
    )
      return failure('unavailable')
    return {
      ok: true as const,
      data: {
        ...(proposalRunId && ownedPrincipal.kind === 'session'
          ? { nextStep: workflowPreviewNextStep }
          : {}),
        dryRun: true as const,
        persisted: false as const,
        baseRevision: result.baseRevision,
        draftRevision: result.draftRevision,
        operationCount: result.operationCount,
        applied: result.applied,
        skipped: projectSkipped(result.skipped, input, result.previewBlockIds),
        deferred: projectSkipped(result.deferred, input, result.previewBlockIds),
        inputValidationErrorCount: result.inputValidationErrors.length,
        inputValidationErrors: projectInputErrors(
          result.inputValidationErrors,
          input,
          result.previewBlockIds
        ),
        functionCode: projectFunctionCode(result, input),
        lint: projectLint(result.lint, input, result.previewBlockIds),
        ...(result.lint.unresolvedReferences.length > 0
          ? { referenceCorrection: projectReferenceCorrection(result, input) }
          : {}),
        warningCount: result.warnings.length,
        provisionalBlockIdCount: Object.keys(result.previewBlockIds ?? {}).length,
        needsRedeployment: result.needsRedeployment,
      },
    }
  }
  return {
    /** Separate server seam: the existing model-facing preview dispatcher never gains writes. */
    async propose(params: unknown, signal?: AbortSignal) {
      if (!proposalRunId || ownedPrincipal.kind !== 'session') return failure('tool_not_allowed')
      try {
        const proposal = await createWorkflowProposal(
          { principal: ownedPrincipal, runId: proposalRunId, workspaceId, workflowId },
          params,
          signal
        )
        return { ok: true as const, proposal, persisted: false as const }
      } catch {
        return failure(signal?.aborted ? 'cancelled' : 'unavailable')
      }
    },
    async dispatch(toolId: string, params: unknown, signal?: AbortSignal) {
      try {
        signal?.throwIfAborted()
        if (toolId !== 'preview_workflow_operations') return failure('tool_not_allowed')
        const result = await waitWithAbort(evaluate(params, signal), signal)
        signal?.throwIfAborted()
        if (stringifyBoundedJson(result, 256 * 1024, { strict: true }) === undefined)
          return failure('result_too_large')
        return result
      } catch (error) {
        if (signal?.aborted) return failure('cancelled')
        if (error instanceof OrchestrationError) {
          if (error.code === 'forbidden') return failure('forbidden')
          if (error.code === 'not_found') return failure('not_found')
          if (error.code === 'conflict') return failure('revision_conflict')
          if (error.code === 'locked') return failure('locked')
          if (error.code === 'validation') return failure('invalid_input')
        }
        return failure('unavailable')
      }
    },
  }
}

type FailureCode =
  | 'invalid_input'
  | 'tool_not_allowed'
  | 'cancelled'
  | 'forbidden'
  | 'not_found'
  | 'revision_conflict'
  | 'locked'
  | 'unavailable'
  | 'atomic_refused'
  | 'result_too_large'
function failure(code: FailureCode) {
  return { ok: false as const, error: { code, message: 'Workflow preview could not complete.' } }
}

type PreviewInput = ReturnType<typeof v2ApplyWorkflowOperationsBodySchema.parse>
function projectSkipped(
  items: SkippedItem[],
  input: PreviewInput,
  previewIds: Record<string, string> = {}
) {
  return items.map((item) => ({
    code: v2WorkflowSkippedItemTypeSchema.parse(item.type),
    operationIndexes: input.operations.flatMap((operation, index) =>
      operation.operation_type === item.operationType &&
      (operation.block_id === item.blockId || previewIds[operation.block_id] === item.blockId)
        ? [index]
        : []
    ),
    enabledChangeIndexes: (input.setBlockEnabled ?? []).flatMap((change, index) =>
      item.operationType === 'set_block_enabled' && change.block_id === item.blockId ? [index] : []
    ),
  }))
}

function indexesForBlock(blockId: string, input: PreviewInput, previewIds: Record<string, string>) {
  return input.operations.flatMap((operation, index) =>
    operation.block_id === blockId || previewIds[operation.block_id] === blockId ? [index] : []
  )
}

/**
 * Corrective metadata only, after native reference lint. Not a graph view or
 * authorization to apply: expose names of evaluated add/edit targets, never
 * provisional IDs, code, values, credentials or arbitrary lint explanations.
 * Output paths must still come from the authorized block catalogue. These
 * hints do not prove a reference's validity or execution; omit empty/ambiguous
 * normalized names, including collisions with untouched blocks.
 * The existing bounded-result check refuses this entire result if too large.
 */
function projectReferenceCorrection(
  result: Awaited<ReturnType<typeof applyWorkflowOperations.execute>>,
  input: PreviewInput
) {
  const skippedIndexes = new Set(
    projectSkipped(result.skipped, input, result.previewBlockIds).flatMap(
      (item) => item.operationIndexes
    )
  )
  const nameCounts = new Map<string, number>()
  for (const block of Object.values(result.graph.blocks)) {
    if (typeof block.name !== 'string') continue
    const name = normalizeName(block.name)
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1)
  }
  let omittedTargetCount = 0
  const targets = Object.entries(result.graph.blocks).flatMap(([blockId, block]) => {
    const operationIndexes = indexesForBlock(blockId, input, result.previewBlockIds ?? {}).filter(
      (index) =>
        !skippedIndexes.has(index) &&
        ['add', 'edit', 'insert_into_subflow'].includes(input.operations[index].operation_type)
    )
    if (!operationIndexes.length) return []
    const referenceHead = typeof block.name === 'string' ? normalizeName(block.name) : ''
    if (!referenceHead || nameCounts.get(referenceHead) !== 1) {
      omittedTargetCount++
      return []
    }
    return [{ operationIndexes, referenceHead }]
  })
  return {
    scope: 'evaluated_operations' as const,
    completeness: 'best_effort' as const,
    syntax: '<referenceHead.declaredOutputPath>',
    outputPathSource: 'get_block.outputs',
    targets,
    omittedTargetCount,
  }
}
function projectInputErrors(
  items: ValidationError[],
  input: PreviewInput,
  previewIds: Record<string, string> = {}
) {
  return items.map((item) => ({
    code: 'input_rejected' as const,
    operationIndexes: indexesForBlock(item.blockId, input, previewIds),
  }))
}
function projectLint(
  lint: WorkflowLintReport,
  input: PreviewInput,
  previewIds: Record<string, string> = {}
) {
  const diagnostics: { code: string; operationIndexes: number[]; count: number }[] = []
  const add = (code: string, blockId: string, count = 1) => {
    if (count > 0)
      diagnostics.push({
        code,
        operationIndexes: indexesForBlock(blockId, input, previewIds),
        count,
      })
  }
  for (const item of lint.orphanBlocks) add('orphan_block', item.blockId)
  for (const item of lint.emptyOutgoingPorts) add('empty_outgoing_port', item.blockId)
  for (const item of lint.invalidBranchPorts) add('invalid_branch_port', item.blockId)
  for (const item of lint.invalidConnectionTargets)
    add('invalid_connection_target', item.sourceBlockId)
  for (const item of lint.fieldIssues) {
    add('missing_required_fields', item.blockId, item.missingRequiredFields.length)
    add('inactive_mode_values', item.blockId, item.inactiveModeValues.length)
  }
  for (const item of lint.unresolvedReferences) add('unresolved_reference', item.blockId)
  for (const item of lint.tableFieldIssues) add('unknown_table_field', item.blockId)
  return {
    completeness: 'best_effort' as const,
    hasUnresolvedReferences: lint.unresolvedReferences.length > 0,
    diagnostics,
    sourceCount: lint.sources.length,
    sinkCount: lint.sinks.length,
    noteCount: lint.notes.length,
  }
}

/** Scoped, non-authoritative diagnostics; untouched code never becomes a graph gate. */
function projectFunctionCode(
  result: Awaited<ReturnType<typeof applyWorkflowOperations.execute>>,
  input: PreviewInput
) {
  const skipped = new Set(
    projectSkipped(result.skipped, input, result.previewBlockIds).flatMap(
      (item) => item.operationIndexes
    )
  )
  const deadline = performance.now() + FUNCTION_ANALYSIS_LIMITS.milliseconds
  const targets = []
  let omittedTargetCount = 0
  for (const [id, block] of Object.entries(result.graph.blocks)) {
    if (block.type !== 'function') continue
    const operationIndexes = indexesForBlock(id, input, result.previewBlockIds ?? {}).filter(
      (index) =>
        !skipped.has(index) &&
        ['add', 'edit', 'insert_into_subflow'].includes(input.operations[index].operation_type)
    )
    if (!operationIndexes.length) continue
    if (targets.length >= 16) {
      omittedTargetCount++
      continue
    }
    const analysis = block.subBlocks.sandboxId?.value
      ? { status: 'unavailable' as const, reason: 'context' as const }
      : analyzeFunctionCode(
          block.subBlocks.code?.value,
          block.subBlocks.language?.value ?? 'javascript',
          deadline,
          'workflow'
        )
    targets.push({ operationIndexes, ...analysis })
  }
  return {
    scope: 'evaluated_operations' as const,
    completeness: 'best_effort' as const,
    targets,
    omittedTargetCount,
  }
}
