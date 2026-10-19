// Extracted from Sim stores/workflows/utils.ts; upstream Apache-2.0 notices retained.
// Modified by Memlia in 2026: separate native ID regeneration from client stores.
import { generateId } from '@sim/utils/id'
import { escapeRegExp } from '@sim/utils/string'
import type { Edge } from '@xyflow/react'
import { DEFAULT_DUPLICATE_OFFSET } from '@/lib/workflows/autolayout/constants'
import { remapConditionBlockIds, remapConditionEdgeHandle } from '@/lib/workflows/condition-ids'
import { isDynamicHandleSubblock } from '@/lib/workflows/dynamic-handle-topology'
import { normalizeName } from '@/executor/constants'
import type {
  BlockState,
  Loop,
  Parallel,
  Position,
  SubBlockState,
  WorkflowState,
} from '@/stores/workflows/workflow/types'
import { TRIGGER_RUNTIME_SUBBLOCK_IDS } from '@/triggers/constants'

/** Threshold to detect viewport-based offsets vs small duplicate offsets */
const LARGE_OFFSET_THRESHOLD = 300

export interface RegeneratedState {
  blocks: Record<string, BlockState>
  edges: Edge[]
  loops: Record<string, Loop>
  parallels: Record<string, Parallel>
  idMap: Map<string, string>
}

function updateValueReferences(value: unknown, nameMap: Map<string, string>): unknown {
  if (typeof value === 'string') {
    let updatedValue = value
    nameMap.forEach((newName, oldName) => {
      /**
       * A rename to itself is a no-op, so skip the scan entirely. This is the
       * whole map on the import path (`regenerateWorkflowIds` seeds it with
       * `name -> name`), which turns an O(names x values) rescan of every
       * sub-block string into nothing.
       */
      if (oldName === newName) return

      /**
       * `oldName` is a block name, which reaches this function straight from
       * imported workflow JSON — `normalizeWorkflowBlockName` only lowercases
       * and strips whitespace/dots, so regex metacharacters survive. Without
       * escaping, a name like `a*a*a*a*b` compiles to a catastrophically
       * backtracking pattern that pins the event loop on a sub-kilobyte input.
       */
      const regex = new RegExp(`<${escapeRegExp(oldName)}\\.`, 'g')
      updatedValue = updatedValue.replace(regex, `<${newName}.`)
    })
    return updatedValue
  }
  if (Array.isArray(value)) {
    return value.map((item) => updateValueReferences(item, nameMap))
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value)) {
      result[key] = updateValueReferences(val, nameMap)
    }
    return result
  }
  return value
}

/**
 * Clears a cloned block's `triggerPath` so it derives a fresh webhook URL from its own block id.
 *
 * Before a deploy this field is empty and the URL is DERIVED — `useWebhookManagement` and the canvas
 * both fall back to the block id, which cloning already regenerates. Deploy then registers the
 * webhook at `triggerPath || block.id` and writes that literal path back into the source block, so
 * from then on the URL is STORED and a clone would copy it verbatim and render the source's URL.
 *
 * Clears BOTH the sub-block structure and the sub-block value map. Both are required:
 * `mergeSubblockStateWithValues` treats the value map as authoritative — a `null` there overrides the
 * structure — but only materializes an entry for a structure-less key when the value is non-null. So
 * nulling the map covers the common shape (no trigger declares `triggerPath` as a subblock, so it
 * normally lives only in the store) and clearing the structure covers blocks hydrated from a merge.
 *
 * Deliberately unconditional and limited to `triggerPath`. No block declares `triggerPath` as a
 * subblock, so there is nothing to collide with and no need to classify the block first. The sibling
 * `TRIGGER_RUNTIME_SUBBLOCK_IDS` entries are all left alone on purpose: `triggerConfig`/`triggerId`
 * are user configuration a clone should keep, and `webhookId` is a user-entered action field on the
 * Attio, Vercel, and Discord blocks while being unused as trigger state (deploy mints its own row id
 * and matches existing rows by block id, and `useWebhookManagement` overwrites the field from the
 * server), so clearing it would destroy real config for no benefit.
 *
 * Mutates both arguments in place; both must be clone-owned copies. `subBlockValues` is optional so
 * a caller with no value-map entry passes `undefined` rather than a throwaway object literal whose
 * writes would be silently discarded.
 */
export function clearClonedWebhookPath(
  subBlocks: Record<string, SubBlockState>,
  subBlockValues: Record<string, unknown> | undefined
): void {
  const subBlock = subBlocks.triggerPath
  if (subBlock) subBlocks.triggerPath = { ...subBlock, value: null }
  if (subBlockValues && 'triggerPath' in subBlockValues) subBlockValues.triggerPath = null
}

function updateBlockReferences(
  blocks: Record<string, BlockState>,
  nameMap: Map<string, string>,
  clearTriggerRuntimeValues = false
): void {
  Object.entries(blocks).forEach(([_, block]) => {
    if (block.subBlocks) {
      Object.entries(block.subBlocks).forEach(([subBlockId, subBlock]) => {
        if (clearTriggerRuntimeValues && TRIGGER_RUNTIME_SUBBLOCK_IDS.includes(subBlockId)) {
          block.subBlocks[subBlockId] = { ...subBlock, value: null }
          return
        }

        if (subBlock.value !== undefined && subBlock.value !== null) {
          const updatedValue = updateValueReferences(
            subBlock.value,
            nameMap
          ) as SubBlockState['value']
          block.subBlocks[subBlockId] = { ...subBlock, value: updatedValue }
        }
      })
    }
  })
}

export function regenerateWorkflowIds(
  workflowState: WorkflowState,
  options: { clearTriggerRuntimeValues?: boolean } = {}
): WorkflowState & { idMap: Map<string, string> } {
  const { clearTriggerRuntimeValues = true } = options
  const blockIdMap = new Map<string, string>()
  const nameMap = new Map<string, string>()
  const newBlocks: Record<string, BlockState> = {}

  // First pass: generate new IDs and remap condition/router IDs in subBlocks
  Object.entries(workflowState.blocks).forEach(([oldId, block]) => {
    const newId = generateId()
    blockIdMap.set(oldId, newId)
    const oldNormalizedName = normalizeName(block.name)
    nameMap.set(oldNormalizedName, oldNormalizedName)
    const newBlock = { ...block, id: newId, subBlocks: structuredClone(block.subBlocks) }
    remapConditionIds(newBlock.subBlocks, {}, block.type, oldId, newId)
    newBlocks[newId] = newBlock
  })

  // Second pass: update parentId references
  Object.values(newBlocks).forEach((block) => {
    if (block.data?.parentId) {
      const newParentId = blockIdMap.get(block.data.parentId)
      if (newParentId) {
        block.data = { ...block.data, parentId: newParentId }
      } else {
        // Parent not in the workflow, clear the relationship
        block.data = { ...block.data, parentId: undefined, extent: undefined }
      }
    }
  })

  const newEdges = workflowState.edges.map((edge) => {
    const newSource = blockIdMap.get(edge.source) || edge.source
    const newSourceHandle =
      edge.sourceHandle && blockIdMap.has(edge.source)
        ? remapConditionEdgeHandle(edge.sourceHandle, edge.source, newSource)
        : edge.sourceHandle

    return {
      ...edge,
      id: generateId(),
      source: newSource,
      target: blockIdMap.get(edge.target) || edge.target,
      sourceHandle: newSourceHandle,
    }
  })

  const newLoops: Record<string, Loop> = {}
  if (workflowState.loops) {
    Object.entries(workflowState.loops).forEach(([oldLoopId, loop]) => {
      const newLoopId = blockIdMap.get(oldLoopId) || oldLoopId
      newLoops[newLoopId] = {
        ...loop,
        id: newLoopId,
        nodes: loop.nodes.map((nodeId) => blockIdMap.get(nodeId) || nodeId),
      }
    })
  }

  const newParallels: Record<string, Parallel> = {}
  if (workflowState.parallels) {
    Object.entries(workflowState.parallels).forEach(([oldParallelId, parallel]) => {
      const newParallelId = blockIdMap.get(oldParallelId) || oldParallelId
      newParallels[newParallelId] = {
        ...parallel,
        id: newParallelId,
        nodes: parallel.nodes.map((nodeId) => blockIdMap.get(nodeId) || nodeId),
      }
    })
  }

  updateBlockReferences(newBlocks, nameMap, clearTriggerRuntimeValues)

  return {
    blocks: newBlocks,
    edges: newEdges,
    loops: newLoops,
    parallels: newParallels,
    metadata: workflowState.metadata,
    variables: workflowState.variables,
    idMap: blockIdMap,
  }
}

/**
 * Remaps condition/router block IDs within subBlock values when a block is duplicated.
 * Mutates both `subBlocks` and `subBlockValues` in place (callers must pass cloned data).
 *
 * Gated on the BLOCK type + canonical subblock key (`conditions`/`routes`), not the
 * stored subblock `type`: edge handles remap by string prefix with no type gate, so a
 * drifted stored type would skip the id remap here while the handles still move,
 * orphaning every edge out of the block.
 *
 * The `subBlockValues[id] ?? subBlock.value` fallback is safe here despite the
 * structure copy being generally stale: condition/router subblocks are
 * dynamic-handle types, which dual-write the structure on every edit
 * (syncDynamicHandleSubblockValue), so both sources are current for them.
 */
export function remapConditionIds(
  subBlocks: Record<string, SubBlockState>,
  subBlockValues: Record<string, unknown>,
  blockType: string | undefined,
  oldBlockId: string,
  newBlockId: string
): void {
  for (const [subBlockId, subBlock] of Object.entries(subBlocks)) {
    if (!isDynamicHandleSubblock(blockType, subBlockId)) continue

    const value = subBlockValues[subBlockId] ?? subBlock.value
    if (typeof value !== 'string') continue

    try {
      const parsed = JSON.parse(value)
      if (!Array.isArray(parsed)) continue

      if (remapConditionBlockIds(parsed, oldBlockId, newBlockId)) {
        const newValue = JSON.stringify(parsed)
        subBlock.value = newValue
        subBlockValues[subBlockId] = newValue
      }
    } catch {
      // Not valid JSON, skip
    }
  }
}

export function regenerateBlockIds(
  blocks: Record<string, BlockState>,
  edges: Edge[],
  loops: Record<string, Loop>,
  parallels: Record<string, Parallel>,
  subBlockValues: Record<string, Record<string, unknown>>,
  positionOffset: { x: number; y: number },
  existingBlockNames: Record<string, BlockState>,
  uniqueNameFn: (name: string, blocks: Record<string, BlockState>) => string
): RegeneratedState & { subBlockValues: Record<string, Record<string, unknown>> } {
  const blockIdMap = new Map<string, string>()
  const nameMap = new Map<string, string>()
  const newBlocks: Record<string, BlockState> = {}
  const newSubBlockValues: Record<string, Record<string, unknown>> = {}

  // Track all blocks for name uniqueness (existing + newly processed)
  const allBlocksForNaming = { ...existingBlockNames }

  // First pass: generate new IDs and names for all blocks
  Object.entries(blocks).forEach(([oldId, block]) => {
    const newId = generateId()
    blockIdMap.set(oldId, newId)

    const oldNormalizedName = normalizeName(block.name)
    const nameConflicts = Object.values(allBlocksForNaming).some(
      (existing) => normalizeName(existing.name) === oldNormalizedName
    )
    const newName = nameConflicts ? uniqueNameFn(block.name, allBlocksForNaming) : block.name
    const newNormalizedName = normalizeName(newName)
    nameMap.set(oldNormalizedName, newNormalizedName)

    // Determine position offset based on parent relationship:
    // 1. Parent also being copied: keep exact relative position (parent itself will be offset)
    // 2. Parent exists in existing workflow: use provided offset, but cap large viewport-based
    //    offsets since they don't make sense for relative positions
    // 3. Top-level block (no parent): apply full paste offset
    const hasParentInPasteSet = block.data?.parentId && blocks[block.data.parentId]
    const hasParentInExistingWorkflow =
      block.data?.parentId && existingBlockNames[block.data.parentId]

    let newPosition: Position
    if (hasParentInPasteSet) {
      // Parent also being copied - keep exact relative position
      newPosition = { x: block.position.x, y: block.position.y }
    } else if (hasParentInExistingWorkflow) {
      // Block stays in existing subflow - use provided offset unless it's viewport-based (large)
      const isLargeOffset =
        Math.abs(positionOffset.x) > LARGE_OFFSET_THRESHOLD ||
        Math.abs(positionOffset.y) > LARGE_OFFSET_THRESHOLD
      const effectiveOffset = isLargeOffset ? DEFAULT_DUPLICATE_OFFSET : positionOffset
      newPosition = {
        x: block.position.x + effectiveOffset.x,
        y: block.position.y + effectiveOffset.y,
      }
    } else {
      // Top-level block - apply full paste offset
      newPosition = {
        x: block.position.x + positionOffset.x,
        y: block.position.y + positionOffset.y,
      }
    }

    // Placeholder block - we'll update parentId in second pass
    const newBlock: BlockState = {
      ...block,
      id: newId,
      name: newName,
      position: newPosition,
      subBlocks: structuredClone(block.subBlocks),
      // Temporarily keep data as-is, we'll fix parentId in second pass
      data: block.data ? { ...block.data } : block.data,
      // Duplicated blocks are always unlocked so users can edit them
      locked: false,
    }

    newBlocks[newId] = newBlock
    // Add to tracking so next block gets unique name
    allBlocksForNaming[newId] = newBlock

    if (subBlockValues[oldId]) {
      newSubBlockValues[newId] = structuredClone(subBlockValues[oldId])
    }

    // Remap condition/router IDs in the duplicated block
    remapConditionIds(newBlock.subBlocks, newSubBlockValues[newId] || {}, block.type, oldId, newId)
  })

  // Second pass: update parentId references for nested blocks
  // If a block's parent is also being pasted, map to new parentId
  // If parent exists in existing workflow, keep the original parentId (block stays in same subflow)
  // Otherwise clear the parentId
  Object.entries(newBlocks).forEach(([, block]) => {
    if (block.data?.parentId) {
      const oldParentId = block.data.parentId
      const newParentId = blockIdMap.get(oldParentId)

      if (newParentId) {
        // Parent is being pasted - map to new parent ID
        block.data = {
          ...block.data,
          parentId: newParentId,
          extent: 'parent',
        }
      } else if (existingBlockNames[oldParentId] && !existingBlockNames[oldParentId].locked) {
        // Parent exists in existing workflow and is not locked - keep original parentId
        block.data = {
          ...block.data,
          parentId: oldParentId,
          extent: 'parent',
        }
      } else {
        // Parent doesn't exist anywhere OR parent is locked - clear the relationship
        block.data = { ...block.data, parentId: undefined, extent: undefined }
      }
    }
  })

  const newEdges = edges.map((edge) => {
    const newSource = blockIdMap.get(edge.source) || edge.source
    const newSourceHandle =
      edge.sourceHandle && blockIdMap.has(edge.source)
        ? remapConditionEdgeHandle(edge.sourceHandle, edge.source, newSource)
        : edge.sourceHandle

    return {
      ...edge,
      id: generateId(),
      source: newSource,
      target: blockIdMap.get(edge.target) || edge.target,
      sourceHandle: newSourceHandle,
    }
  })

  const newLoops: Record<string, Loop> = {}
  Object.entries(loops).forEach(([oldLoopId, loop]) => {
    const newLoopId = blockIdMap.get(oldLoopId) || oldLoopId
    newLoops[newLoopId] = {
      ...loop,
      id: newLoopId,
      nodes: loop.nodes.map((nodeId) => blockIdMap.get(nodeId) || nodeId),
    }
  })

  const newParallels: Record<string, Parallel> = {}
  Object.entries(parallels).forEach(([oldParallelId, parallel]) => {
    const newParallelId = blockIdMap.get(oldParallelId) || oldParallelId
    newParallels[newParallelId] = {
      ...parallel,
      id: newParallelId,
      nodes: parallel.nodes.map((nodeId) => blockIdMap.get(nodeId) || nodeId),
    }
  })

  updateBlockReferences(newBlocks, nameMap, false)

  Object.entries(newSubBlockValues).forEach(([_, blockValues]) => {
    Object.keys(blockValues).forEach((subBlockId) => {
      blockValues[subBlockId] = updateValueReferences(blockValues[subBlockId], nameMap)
    })
  })

  Object.entries(newBlocks).forEach(([blockId, block]) => {
    clearClonedWebhookPath(block.subBlocks, newSubBlockValues[blockId])
  })

  return {
    blocks: newBlocks,
    edges: newEdges,
    loops: newLoops,
    parallels: newParallels,
    subBlockValues: newSubBlockValues,
    idMap: blockIdMap,
  }
}
