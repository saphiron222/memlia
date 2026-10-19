// Copyright 2026 Memlia. All rights reserved.
import {
  normalizeWorkflowEdgeSourceHandle,
  normalizeWorkflowEdgeTargetHandle,
} from '@sim/workflow-types/workflow'
import { OrchestrationError } from '@/lib/core/orchestration/types'
import { sanitizeWorkflowForSharing } from '@/lib/workflows/credentials/extractor'
import { getBlockRegistry } from '@/blocks/registry'
import { regenerateWorkflowIds } from '@/stores/workflows/utils'
import type { BlockState, WorkflowState } from '@/stores/workflows/workflow/types'

function unsupported(): never {
  throw new OrchestrationError(
    'validation',
    'This workflow cannot be copied privately without explicit reconfiguration'
  )
}

/**
 * A private template copy carries topology, never authored values. The recipient must configure
 * its inputs before running it. Dynamic/container topology needs a separately qualified copier.
 * Neither source labels nor arbitrary data/outputs/edge metadata enter the projection.
 */
export function preparePrivateCopyState(source: WorkflowState) {
  if (Object.keys(source.loops ?? {}).length || Object.keys(source.parallels ?? {}).length)
    unsupported()
  if (!source.blocks || Object.keys(source.blocks).length > 1000) unsupported()
  const sanitized = sanitizeWorkflowForSharing(source, {
    redactOpaqueCredentialInputs: true,
    preserveEnvVars: false,
  })
  const blocks: Record<string, BlockState> = {}
  for (const [id, block] of Object.entries(sanitized.blocks ?? {})) {
    const registry = getBlockRegistry()
    // Never admit authored custom-block definitions through the dynamic overlay.
    const config = Object.hasOwn(registry, block.type) ? registry[block.type] : undefined
    if (
      !config ||
      ['condition', 'router', 'loop', 'parallel'].includes(block.type) ||
      block.data?.parentId
    )
      unsupported()
    if (!Number.isFinite(block.position?.x) || !Number.isFinite(block.position?.y)) unsupported()
    blocks[id] = {
      id,
      type: block.type,
      name: config.name,
      position: { x: block.position.x, y: block.position.y },
      enabled: true,
      outputs: {},
      subBlocks: Object.fromEntries(
        (config.subBlocks ?? []).map((field) => [
          field.id,
          { id: field.id, type: field.type, value: null },
        ])
      ),
    }
  }
  const edges = source.edges.map((edge) => {
    const sourceHandle = normalizeWorkflowEdgeSourceHandle(edge.sourceHandle)
    const targetHandle = normalizeWorkflowEdgeTargetHandle(edge.targetHandle)
    if (
      !blocks[edge.source] ||
      !blocks[edge.target] ||
      (sourceHandle && sourceHandle !== 'source') ||
      (targetHandle && targetHandle !== 'target')
    )
      unsupported()
    return { id: edge.id, source: edge.source, target: edge.target, sourceHandle, targetHandle }
  })
  const { idMap: _, ...state } = regenerateWorkflowIds({
    blocks,
    edges,
    loops: {},
    parallels: {},
    variables: {},
  })
  return { state, configurationRequired: true as const }
}
