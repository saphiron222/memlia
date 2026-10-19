// Modified by Memlia: bind draft revision attestations to applied client snapshots.

import { createLogger } from '@sim/logger'
import { sortObjectKeysDeep } from '@sim/utils/object'
import type { Edge } from '@xyflow/react'
import { requestJson } from '@/lib/api/client/request'
import {
  putWorkflowNormalizedStateContract,
  type WorkflowStateContractInput,
} from '@/lib/api/contracts/workflows'
import { stripWorkflowDiffMarkers } from '@/lib/workflows/diff'
import { validateWorkflowState } from '@/lib/workflows/sanitization/validation'
import { useOperationQueueStore } from '@/stores/operation-queue/store'
import { useVariablesStore } from '@/stores/variables/store'
import type { Variable } from '@/stores/variables/types'
import { useWorkflowRegistry } from '../workflows/registry/store'
import { useSubBlockStore } from '../workflows/subblock/store'
import { captureDraftVersions } from '../workflows/sync-local-draft'
import { mergeSubblockState } from '../workflows/utils'
import { useWorkflowStore } from '../workflows/workflow/store'
import type { ReplaceWorkflowStateOptions, WorkflowState } from '../workflows/workflow/types'
import { normalizeWorkflowState } from '../workflows/workflow/validation'
import { useWorkflowDiffStore } from './store'
import type { WorkflowDiffState } from './types'

const logger = createLogger('WorkflowDiffStore')
export const WORKFLOW_DIFF_SETTLED_EVENT = 'workflow-diff-settled'

export function cloneWorkflowState(state: WorkflowState): WorkflowState {
  return {
    ...state,
    blocks: structuredClone(state.blocks || {}),
    edges: structuredClone(state.edges || []),
    loops: structuredClone(state.loops || {}),
    parallels: structuredClone(state.parallels || {}),
    ...(Object.hasOwn(state, 'variables') ? { variables: structuredClone(state.variables) } : {}),
  }
}

export function extractSubBlockValues(
  workflowState: WorkflowState
): Record<string, Record<string, any>> {
  const values: Record<string, Record<string, any>> = {}
  Object.entries(workflowState.blocks || {}).forEach(([blockId, block]) => {
    values[blockId] = {}
    Object.entries(block.subBlocks || {}).forEach(([subBlockId, subBlock]) => {
      values[blockId][subBlockId] = subBlock?.value ?? null
    })
  })
  return values
}

export function applyWorkflowStateToStores(
  workflowId: string,
  workflowState: WorkflowState,
  options?: ReplaceWorkflowStateOptions,
  assertOwnership?: () => void
) {
  logger.debug('[applyWorkflowStateToStores] Applying state', {
    workflowId,
    blockCount: Object.keys(workflowState.blocks || {}).length,
    edgeCount: workflowState.edges?.length ?? 0,
    edgePreview: workflowState.edges?.slice(0, 3).map((e) => `${e.source} -> ${e.target}`),
  })
  const supplied = options?.draftRevisionAttestation
  const ownedOptions = {
    ...options,
    ...(supplied
      ? {
          draftRevisionAttestation: {
            workflowId: supplied.workflowId,
            revision: supplied.revision,
            versions: {
              localOperation: supplied.versions.localOperation,
              remoteApply: supplied.versions.remoteApply,
              remoteUpdate: supplied.versions.remoteUpdate,
            },
          },
        }
      : {}),
  }
  const workflowStore = useWorkflowStore.getState()
  const cloned = cloneWorkflowState(workflowState)
  logger.debug('[applyWorkflowStateToStores] Cloned state edges', {
    clonedEdgeCount: cloned.edges?.length ?? 0,
  })
  const subBlockValues = extractSubBlockValues(cloned)
  const hasVariables = Object.hasOwn(workflowState, 'variables')
  const variables = hasVariables ? structuredClone(workflowState.variables) : undefined
  assertOwnership?.()
  workflowStore.invalidateDraftRevisionAttestation()
  assertOwnership?.()
  useSubBlockStore.getState().setWorkflowValues(workflowId, subBlockValues)
  assertOwnership?.()
  if (hasVariables) {
    applyWorkflowVariablesToStore(workflowId, variables)
    assertOwnership?.()
  }
  // Publish the graph and its attestation only after all dependent values succeeded.
  workflowStore.replaceWorkflowState(cloned, ownedOptions)

  // Verify what's in the store after apply
  const afterState = workflowStore.getWorkflowState()
  logger.info('[applyWorkflowStateToStores] Applied workflow state to stores', {
    workflowId,
    afterEdgeCount: afterState.edges?.length ?? 0,
  })
}

export function applyWorkflowVariablesToStore(
  workflowId: string,
  variables?: WorkflowState['variables'] | null
) {
  const stampedVariables: Record<string, Variable> = {}

  Object.entries(variables || {}).forEach(([id, variable]) => {
    if (!variable?.name) return
    stampedVariables[id] = {
      id: variable.id || id,
      workflowId,
      name: variable.name,
      type: variable.type || 'plain',
      value: Object.hasOwn(variable, 'value') ? variable.value : '',
    }
  })

  useVariablesStore.setState((state) => ({
    variables: {
      ...Object.fromEntries(
        Object.entries(state.variables).filter(([, variable]) => variable.workflowId !== workflowId)
      ),
      ...stampedVariables,
    },
  }))
}

export function captureBaselineSnapshot(workflowId: string): WorkflowState {
  const workflowStore = useWorkflowStore.getState()
  const currentState = workflowStore.getWorkflowState()
  const mergedBlocks = mergeSubblockState(currentState.blocks, workflowId)

  return {
    ...cloneWorkflowState(currentState),
    blocks: structuredClone(mergedBlocks),
    variables: structuredClone(
      Object.fromEntries(
        Object.entries(useVariablesStore.getState().variables).filter(
          ([, variable]) => variable.workflowId === workflowId
        )
      )
    ),
  }
}

export async function persistWorkflowStateToServer(
  workflowId: string,
  workflowState: WorkflowState,
  expectedRevision: number
) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
    throw new Error('Synchronize the workflow before saving a diff.')
  const cleanState = stripWorkflowDiffMarkers(cloneWorkflowState(workflowState))
  const { dragStartPosition: _dropDragStart, ...stateToSave } = cleanState

  type ContractEdgeInput = WorkflowStateContractInput['edges'][number]

  // Mirror `utils/auto-layout` sanitization: schema rejects nullable
  // sourceHandle/targetHandle (input type is `string | undefined`), but the
  // store's Edge type carries `string | null | undefined`. Drop nulls before
  // sending so the contract input parses cleanly.
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
    lastSaved: Date.now(),
  }

  const receipt = await requestJson(putWorkflowNormalizedStateContract, {
    params: { id: workflowId },
    body: { ...cleanedWorkflowState, expectedRevision },
  })

  if (receipt.baseRevision !== expectedRevision || receipt.draftRevision !== expectedRevision + 1) {
    throw new Error('Unconfirmed diff receipt. Synchronize the workflow.')
  }
  return receipt
}

export async function getLatestUserMessageId(): Promise<string | null> {
  return null
}

export function createBatchedUpdater(set: (updates: Partial<WorkflowDiffState>) => void) {
  let updateTimer: NodeJS.Timeout | null = null
  const UPDATE_DEBOUNCE_MS = 16
  let pendingUpdates: Partial<WorkflowDiffState> = {}
  const enqueue = (updates: Partial<WorkflowDiffState>) => {
    Object.assign(pendingUpdates, updates)
    if (updateTimer) {
      clearTimeout(updateTimer)
    }
    updateTimer = setTimeout(() => {
      set(pendingUpdates)
      pendingUpdates = {}
      updateTimer = null
    }, UPDATE_DEBOUNCE_MS)
  }
  return Object.assign(enqueue, {
    cancel: () => {
      if (updateTimer) clearTimeout(updateTimer)
      updateTimer = null
      pendingUpdates = {}
    },
  })
}

/** Captured with the graph; never reconstructed to justify an older payload. */
export function captureDiffObservation(workflowId: string) {
  const versions = captureDraftVersions(workflowId)
  const workflow = useWorkflowStore.getState()
  return {
    workflowId,
    versions,
    pendingGeneration: useWorkflowDiffStore.getState().pendingExternalUpdates[workflowId] ?? 0,
    blocks: workflow.blocks,
    edges: workflow.edges,
    loops: workflow.loops,
    parallels: workflow.parallels,
    subblocks: useSubBlockStore.getState().workflowValues[workflowId],
    variables: useVariablesStore.getState().variables,
    fingerprint: diffSnapshotFingerprint(captureBaselineSnapshot(workflowId)),
  }
}
export type DiffObservation = ReturnType<typeof captureDiffObservation>

export function assertDiffObservation(observed: DiffObservation, beforeReadback = false): void {
  const { workflowId, versions } = observed
  const current = useWorkflowStore.getState()
  const now = captureDraftVersions(workflowId)
  const pending = useWorkflowDiffStore.getState().pendingExternalUpdates[workflowId] ?? 0
  // Only unapplied full-update notifications may be covered by a NEW GET.
  // Applied remote deltas and local operations are never waived.
  const notificationsOnly =
    beforeReadback &&
    pending >= observed.pendingGeneration &&
    now.remoteUpdate - versions.remoteUpdate === pending - observed.pendingGeneration
  if (
    useWorkflowRegistry.getState().activeWorkflowId !== workflowId ||
    current.currentWorkflowId !== workflowId ||
    useOperationQueueStore.getState().hasPendingOperations(workflowId) ||
    now.localOperation !== versions.localOperation ||
    now.remoteApply !== versions.remoteApply ||
    (!notificationsOnly &&
      (now.remoteUpdate !== versions.remoteUpdate || pending !== observed.pendingGeneration)) ||
    current.blocks !== observed.blocks ||
    current.edges !== observed.edges ||
    current.loops !== observed.loops ||
    current.parallels !== observed.parallels ||
    useSubBlockStore.getState().workflowValues[workflowId] !== observed.subblocks ||
    useVariablesStore.getState().variables !== observed.variables ||
    diffSnapshotFingerprint(captureBaselineSnapshot(workflowId)) !== observed.fingerprint
  )
    throw new Error('The workflow changed. Synchronize before applying this diff.')
}

/** Ignore only local overlay/receipt metadata, never graph order or values. */
export function diffSnapshotFingerprint(state: WorkflowState): string {
  const clean = stripWorkflowDiffMarkers(state)
  const variables = Object.fromEntries(
    Object.entries(clean.variables ?? {}).map(([id, variable]) => {
      const { workflowId: _workflowId, ...value } = variable as Variable
      return [id, value]
    })
  )
  return JSON.stringify(
    sortObjectKeysDeep({
      blocks: clean.blocks,
      edges: clean.edges,
      loops: clean.loops ?? {},
      parallels: clean.parallels ?? {},
      variables,
    })
  )
}

export function assertExactDiffSnapshot(state: WorkflowState): void {
  const normalized = normalizeWorkflowState(state)
  const validation = validateWorkflowState(state, { sanitize: true })
  if (
    !validation.valid ||
    normalized.warnings.length ||
    diffSnapshotFingerprint(normalized.state) !== diffSnapshotFingerprint(state) ||
    (validation.sanitizedState &&
      diffSnapshotFingerprint(validation.sanitizedState) !== diffSnapshotFingerprint(state))
  ) {
    throw new Error(
      'The server snapshot needs normalization. Synchronize before applying this diff.'
    )
  }
}

/** Verify our synchronous application against the original read's counters. */
export function observeAppliedDiff(
  observed: DiffObservation,
  snapshot: WorkflowState,
  pendingGeneration = observed.pendingGeneration
): DiffObservation {
  const current = captureDiffObservation(observed.workflowId)
  if (
    useWorkflowRegistry.getState().activeWorkflowId !== observed.workflowId ||
    useWorkflowStore.getState().currentWorkflowId !== observed.workflowId ||
    useOperationQueueStore.getState().hasPendingOperations(observed.workflowId) ||
    current.versions.localOperation !== observed.versions.localOperation ||
    current.versions.remoteApply !== observed.versions.remoteApply ||
    current.versions.remoteUpdate !== observed.versions.remoteUpdate ||
    current.pendingGeneration !== pendingGeneration ||
    current.fingerprint !== diffSnapshotFingerprint(snapshot)
  ) {
    throw new Error(
      'The workflow changed during snapshot application. Synchronize before resolving this diff.'
    )
  }
  return current
}
