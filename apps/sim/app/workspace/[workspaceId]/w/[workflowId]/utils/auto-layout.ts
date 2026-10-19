// Modified by Memlia: save an attested layout before applying it, without stale rollback.
import { createLogger } from '@sim/logger'
import { getErrorMessage } from '@sim/utils/errors'
import type { Edge } from '@xyflow/react'
import { ApiClientError } from '@/lib/api/client/errors'
import { requestJson } from '@/lib/api/client/request'
import {
  putWorkflowNormalizedStateContract,
  type WorkflowStateContractInput,
  workflowAutoLayoutContract,
} from '@/lib/api/contracts/workflows'
import {
  DEFAULT_HORIZONTAL_SPACING,
  DEFAULT_LAYOUT_PADDING,
  DEFAULT_VERTICAL_SPACING,
} from '@/lib/workflows/autolayout/constants'
import { useVariablesStore } from '@/stores/variables/store'
import { applyWorkflowStateToStores } from '@/stores/workflow-diff/utils'
import { useSubBlockStore } from '@/stores/workflows/subblock/store'
import {
  canApplyDraftSnapshot,
  captureDraftVersions,
  getAttestedDraftRevision,
} from '@/stores/workflows/sync-local-draft'
import { mergeSubblockState } from '@/stores/workflows/utils'
import { useWorkflowStore } from '@/stores/workflows/workflow/store'
import type { BlockState } from '@/stores/workflows/workflow/types'

const logger = createLogger('AutoLayoutUtils')

/**
 * Auto layout options interface
 */
export interface AutoLayoutOptions {
  spacing?: {
    horizontal?: number
    vertical?: number
  }
  alignment?: 'start' | 'center' | 'end'
  padding?: {
    x?: number
    y?: number
  }
  gridSize?: number
}

/**
 * Apply auto layout and update store
 * Standalone utility for use outside React context (event handlers, tools, etc.)
 */
export async function applyAutoLayoutAndUpdateStore(
  workflowId: string,
  options: AutoLayoutOptions = {}
): Promise<{
  success: boolean
  error?: string
}> {
  try {
    const expectedRevision = getAttestedDraftRevision(workflowId)
    if (expectedRevision === null) {
      return { success: false, error: 'Synchronize the workflow before applying auto-layout.' }
    }
    const versions = captureDraftVersions(workflowId)
    const workflowStore = useWorkflowStore.getState()
    const subblocks = useSubBlockStore.getState().workflowValues[workflowId]
    const variables = useVariablesStore.getState().variables
    const capturedState = structuredClone({
      ...workflowStore.getWorkflowState(),
      blocks: mergeSubblockState(workflowStore.blocks, workflowId),
      variables: Object.fromEntries(
        Object.entries(variables).filter(([, variable]) => variable.workflowId === workflowId)
      ),
    })
    const isCurrent = () => {
      const current = useWorkflowStore.getState()
      return (
        getAttestedDraftRevision(workflowId) === expectedRevision &&
        canApplyDraftSnapshot(workflowId, versions) &&
        current.blocks === workflowStore.blocks &&
        current.edges === workflowStore.edges &&
        current.loops === workflowStore.loops &&
        current.parallels === workflowStore.parallels &&
        useSubBlockStore.getState().workflowValues[workflowId] === subblocks &&
        useVariablesStore.getState().variables === variables
      )
    }
    const invalidateCapturedRevision = () => {
      const current = useWorkflowStore.getState()
      if (
        current.draftRevisionAttestation?.workflowId === workflowId &&
        current.draftRevisionAttestation.revision === expectedRevision
      ) {
        current.invalidateDraftRevisionAttestation()
      }
    }
    const { blocks, edges, loops = {}, parallels = {} } = capturedState

    logger.info('Auto layout store data:', {
      workflowId,
      blockCount: Object.keys(blocks).length,
      edgeCount: edges.length,
      loopCount: Object.keys(loops).length,
      parallelCount: Object.keys(parallels).length,
    })

    if (Object.keys(blocks).length === 0) {
      logger.warn('No blocks to layout', { workflowId })
      return { success: false, error: 'No blocks to layout' }
    }

    // Check for locked blocks - auto-layout is disabled when blocks are locked
    const hasLockedBlocks = Object.values(blocks).some((block) => block.locked)
    if (hasLockedBlocks) {
      logger.info('Auto layout skipped: workflow contains locked blocks', { workflowId })
      return {
        success: false,
        error: 'Auto-layout is disabled when blocks are locked. Unlock blocks to use auto-layout.',
      }
    }

    // Merge with default options
    const layoutOptions = {
      spacing: {
        horizontal: options.spacing?.horizontal ?? DEFAULT_HORIZONTAL_SPACING,
        vertical: options.spacing?.vertical ?? DEFAULT_VERTICAL_SPACING,
      },
      alignment: options.alignment ?? 'center',
      padding: {
        x: options.padding?.x ?? DEFAULT_LAYOUT_PADDING.x,
        y: options.padding?.y ?? DEFAULT_LAYOUT_PADDING.y,
      },
      gridSize: options.gridSize,
    }

    let result: Awaited<ReturnType<typeof requestJson<typeof workflowAutoLayoutContract>>>
    try {
      result = await requestJson(workflowAutoLayoutContract, {
        params: { id: workflowId },
        body: {
          ...layoutOptions,
          blocks,
          edges,
          loops,
          parallels,
        },
      })
    } catch (error) {
      const errorMessage = getErrorMessage(error, 'Auto layout failed')
      logger.error('Auto layout API call failed:', { error: errorMessage })
      return { success: false, error: errorMessage }
    }

    // The contract's `workflowBlockStateSchema` and the store's `BlockState`
    // describe the same runtime shape but TS sees the contract's
    // `SubBlockState.value` as `unknown` (zod default) while the store
    // narrows it to the editor's per-input value union. The contract's
    // shape is structurally a supertype of the store's, so this is a
    // single safe widening cast (store -> wire) on the way back in.
    const layoutedBlocks: Record<string, BlockState> = structuredClone(
      (result.data.layoutedBlocks as Record<string, BlockState>) || blocks
    )
    if (!isCurrent()) {
      return {
        success: false,
        error: 'Workflow changed during auto-layout. Synchronize before retrying.',
      }
    }
    const newWorkflowState = { ...capturedState, blocks: layoutedBlocks, lastSaved: Date.now() }

    try {
      const { dragStartPosition, ...stateToSave } = newWorkflowState

      type ContractEdgeInput = WorkflowStateContractInput['edges'][number]

      // Mirror the diff store's sanitization: schema rejects nullable
      // sourceHandle/targetHandle (input type is `string | undefined`),
      // but the store's reactflow `Edge` type carries `string | null |
      // undefined`. Drop nulls before sending so the contract input
      // parses cleanly.
      const sanitizedEdges: ContractEdgeInput[] = (stateToSave.edges || []).map((edge: Edge) => {
        const { sourceHandle, targetHandle, ...rest } = edge
        const sanitized: ContractEdgeInput = { ...rest } as ContractEdgeInput
        if (typeof sourceHandle === 'string' && sourceHandle.length > 0) {
          sanitized.sourceHandle = sourceHandle
        }
        if (typeof targetHandle === 'string' && targetHandle.length > 0) {
          sanitized.targetHandle = targetHandle
        }
        return sanitized
      })

      const cleanedWorkflowState: WorkflowStateContractInput = {
        ...stateToSave,
        loops: stateToSave.loops || {},
        parallels: stateToSave.parallels || {},
        edges: sanitizedEdges,
      }

      await requestJson(putWorkflowNormalizedStateContract, {
        params: { id: workflowId },
        body: { ...cleanedWorkflowState, expectedRevision },
      })

      // A receipt alone does not attest a client graph. Preserve any intervening local edit.
      if (!isCurrent()) {
        invalidateCapturedRevision()
        return {
          success: false,
          error: 'Layout was saved, but the workflow changed locally. Synchronize before retrying.',
        }
      }
      applyWorkflowStateToStores(workflowId, newWorkflowState)
      logger.info('Auto layout successfully persisted and applied', { workflowId })
      return { success: true }
    } catch (saveError) {
      if (saveError instanceof ApiClientError && saveError.status === 409) {
        invalidateCapturedRevision()
        return {
          success: false,
          error: 'Workflow changed on the server. Synchronize before retrying auto-layout.',
        }
      }
      logger.error('Failed to save auto layout; local workflow preserved', {
        workflowId,
        error: saveError,
      })
      return {
        success: false,
        error: `Failed to save positions: ${getErrorMessage(saveError, 'Unknown error')}`,
      }
    }
  } catch (error) {
    const errorMessage = getErrorMessage(error, 'Unknown store update error')
    logger.error('Failed to update store with auto layout:', { workflowId, error: errorMessage })

    return {
      success: false,
      error: errorMessage,
    }
  }
}
