// Modified by Memlia in 2026: re-export native ID utilities without changing client store reads.
import { mergeSubblockStateWithValues } from '@sim/workflow-persistence/subblocks'
import { filterUniqueWorkflowEdges } from '@sim/workflow-types/workflow'
import type { Edge } from '@xyflow/react'
import { normalizeName } from '@/executor/constants'
import { useWorkflowRegistry } from '@/stores/workflows/registry/store'
import { useSubBlockStore } from '@/stores/workflows/subblock/store'
import { validateEdges } from '@/stores/workflows/workflow/edge-validation'
import type { BlockState } from '@/stores/workflows/workflow/types'

/**
 * Filters edges to only include valid ones (target exists and is not a trigger block)
 */
export function filterValidEdges(edges: Edge[], blocks: Record<string, BlockState>): Edge[] {
  return validateEdges(edges, blocks).valid
}

export function filterNewEdges(edgesToAdd: Edge[], currentEdges: Edge[]): Edge[] {
  return filterUniqueWorkflowEdges(edgesToAdd, currentEdges)
}

/**
 * Generates a unique block name by finding the highest number suffix among existing blocks
 * with the same base name and incrementing it
 * @param baseName - The base name for the block (e.g., "API 1", "Agent", "Loop 3")
 * @param existingBlocks - Record of existing blocks to check against
 * @returns A unique block name with an appropriate number suffix
 */
export function getUniqueBlockName(baseName: string, existingBlocks: Record<string, any>): string {
  // Special case: Start blocks should always be named "Start" without numbers
  // This applies to both "Start" and "Starter" base names
  const normalizedBaseName = normalizeName(baseName)
  if (normalizedBaseName === 'start' || normalizedBaseName === 'starter') {
    return 'Start'
  }

  if (normalizedBaseName === 'response') {
    return 'Response'
  }

  const baseNameMatch = baseName.match(/^(.*?)(\s+\d+)?$/)
  const namePrefix = baseNameMatch ? baseNameMatch[1].trim() : baseName

  const normalizedBase = normalizeName(namePrefix)

  /*
   * A bare name counts as the first of its kind, so `Send Email` and
   * `Send Email 2` are consecutive rather than colliding — the same series a
   * legacy `Gmail 1` / `Gmail 2` pair already forms.
   */
  const existingNumbers = Object.values(existingBlocks)
    .filter((block) => {
      const blockNameMatch = block.name?.match(/^(.*?)(\s+\d+)?$/)
      const blockPrefix = blockNameMatch ? blockNameMatch[1].trim() : block.name
      return blockPrefix && normalizeName(blockPrefix) === normalizedBase
    })
    .map((block) => {
      const match = block.name?.match(/(\d+)$/)
      return match ? Number.parseInt(match[1], 10) : 1
    })

  /* The first of a kind carries no suffix — "Send Email", not "Send Email 1". */
  if (existingNumbers.length === 0) return namePrefix

  return `${namePrefix} ${Math.max(...existingNumbers) + 1}`
}

/**
 * Merges workflow block states with the sub-block store's values while maintaining
 * block structure. Resolves the active workflow when no workflowId is given.
 * Value semantics (explicit-null clears, orphaned runtime values such as
 * webhookId/triggerPath, undefined fallbacks) are defined by
 * {@link mergeSubblockStateWithValues}.
 * @param blocks - Block configurations from workflow store
 * @param workflowId - ID of the workflow to merge values for (defaults to the active workflow)
 * @param blockId - Optional specific block ID to merge (merges all if not provided)
 * @returns Merged block states with updated values
 */
export function mergeSubblockState(
  blocks: Record<string, BlockState>,
  workflowId?: string,
  blockId?: string
): Record<string, BlockState> {
  const resolvedWorkflowId = workflowId ?? useWorkflowRegistry.getState().activeWorkflowId
  const workflowSubblockValues = resolvedWorkflowId
    ? useSubBlockStore.getState().workflowValues[resolvedWorkflowId] || {}
    : {}

  return mergeSubblockStateWithValues(blocks, workflowSubblockValues, blockId)
}

export {
  clearClonedWebhookPath,
  regenerateBlockIds,
  regenerateWorkflowIds,
  remapConditionIds,
  type RegeneratedState,
} from '@/lib/workflows/operations/regenerate-ids'
