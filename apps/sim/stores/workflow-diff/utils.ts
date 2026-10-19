// Modified by Memlia: bind draft revision attestations to applied client snapshots.

import { createLogger } from '@sim/logger'
import { isPlainRecord, sortObjectKeysDeep } from '@sim/utils/object'
import type { PrimitiveValueType, SubBlockType } from '@sim/workflow-types/blocks'
import type { Edge } from '@xyflow/react'
import { z } from 'zod'
import { requestJson } from '@/lib/api/client/request'
import {
  putWorkflowNormalizedStateContract,
  type WorkflowStateContractInput,
  workflowStateResponseSchema,
} from '@/lib/api/contracts/workflows'
import { stripWorkflowDiffMarkers } from '@/lib/workflows/diff'
import { validateWorkflowState } from '@/lib/workflows/sanitization/validation'
import { useOperationQueueStore } from '@/stores/operation-queue/store'
import { useVariablesStore } from '@/stores/variables/store'
import type { Variable, VariablesStore } from '@/stores/variables/types'
import { useWorkflowRegistry } from '../workflows/registry/store'
import { useSubBlockStore } from '../workflows/subblock/store'
import type { SubBlockStore } from '../workflows/subblock/types'
import { captureDraftVersions } from '../workflows/sync-local-draft'
import { mergeSubblockState } from '../workflows/utils'
import { useWorkflowStore } from '../workflows/workflow/store'
import type {
  DraftSyncVersions,
  ReplaceWorkflowStateOptions,
  WorkflowState,
} from '../workflows/workflow/types'
import { normalizeWorkflowState } from '../workflows/workflow/validation'
import { useWorkflowDiffStore } from './store'
import type { WorkflowDiffState } from './types'

const logger = createLogger('WorkflowDiffStore')
export const WORKFLOW_DIFF_SETTLED_EVENT = 'workflow-diff-settled'

/** Local publication was interrupted; this is not an HTTP failure eligible for raw fallback. */
export class WorkflowSnapshotPublicationError extends Error {
  constructor() {
    super('The workflow changed during publication. Synchronize before continuing.')
    this.name = 'WorkflowSnapshotPublicationError'
  }
}

// The wire contract is intentionally broader than the editor model. These exhaustive
// maps follow the native type definitions without looking up blocks in the registry.
const editorSubBlockTypes = {
  'short-input': 'short-input',
  'long-input': 'long-input',
  dropdown: 'dropdown',
  combobox: 'combobox',
  slider: 'slider',
  table: 'table',
  code: 'code',
  switch: 'switch',
  'tool-input': 'tool-input',
  'skill-input': 'skill-input',
  'checkbox-list': 'checkbox-list',
  'grouped-checkbox-list': 'grouped-checkbox-list',
  'condition-input': 'condition-input',
  'eval-input': 'eval-input',
  'time-input': 'time-input',
  'oauth-input': 'oauth-input',
  'webhook-config': 'webhook-config',
  'schedule-info': 'schedule-info',
  'file-selector': 'file-selector',
  'sheet-selector': 'sheet-selector',
  'project-selector': 'project-selector',
  'channel-selector': 'channel-selector',
  'user-selector': 'user-selector',
  'folder-selector': 'folder-selector',
  'knowledge-base-selector': 'knowledge-base-selector',
  'knowledge-tag-filters': 'knowledge-tag-filters',
  'document-selector': 'document-selector',
  'document-tag-entry': 'document-tag-entry',
  'mcp-server-selector': 'mcp-server-selector',
  'mcp-tool-selector': 'mcp-tool-selector',
  'mcp-dynamic-args': 'mcp-dynamic-args',
  'input-format': 'input-format',
  'response-format': 'response-format',
  'filter-builder': 'filter-builder',
  'sort-builder': 'sort-builder',
  'file-upload': 'file-upload',
  'input-mapping': 'input-mapping',
  'variables-input': 'variables-input',
  'messages-input': 'messages-input',
  'workflow-selector': 'workflow-selector',
  'workflow-output-selector': 'workflow-output-selector',
  'workflow-input-mapper': 'workflow-input-mapper',
  text: 'text',
  'router-input': 'router-input',
  'table-selector': 'table-selector',
  'model-fallback-list': 'model-fallback-list',
  'column-selector': 'column-selector',
  modal: 'modal',
} satisfies { [Kind in SubBlockType]: Kind }

const editorPrimitiveTypes = {
  string: 'string',
  number: 'number',
  boolean: 'boolean',
  json: 'json',
  array: 'array',
  file: 'file',
  'file[]': 'file[]',
  any: 'any',
} satisfies { [Kind in PrimitiveValueType]: Kind }

const outputScalarSchema = z.union([z.string(), z.number(), z.boolean()])
const outputAndScalarSchema = z.union([outputScalarSchema, z.null(), z.undefined()])
const outputAndSchema = z
  .object({
    field: z.string(),
    value: z.union([outputAndScalarSchema, z.array(outputAndScalarSchema)]),
    not: z.boolean().optional(),
  })
  .passthrough()
  .refine((value) => Object.hasOwn(value, 'value'))
  // The native interface requires the property, but permits its explicit undefined
  // value. Check presence first, then preserve that same value as a required key.
  .transform((value) => ({ ...value, value: value.value }))
const editorOutputSchema = z.union([
  z.enum(editorPrimitiveTypes),
  z
    .object({
      type: z.enum(editorPrimitiveTypes),
      description: z.string().optional(),
      hiddenFromDisplay: z.boolean().optional(),
      condition: z
        .object({
          field: z.string(),
          value: z.union([outputScalarSchema, z.array(outputScalarSchema)]),
          not: z.boolean().optional(),
          allowReference: z.boolean().optional(),
          and: outputAndSchema.optional(),
        })
        .passthrough()
        .optional(),
    })
    .passthrough(),
])
const wireBlockSchema = workflowStateResponseSchema.shape.blocks.valueType
const editorSnapshotSchema = workflowStateResponseSchema.extend({
  blocks: z.record(
    z.string(),
    wireBlockSchema.extend({
      subBlocks: z.record(
        z.string(),
        wireBlockSchema.shape.subBlocks.valueType.extend({
          type: z.enum(editorSubBlockTypes),
          value: z.union([z.string(), z.number(), z.array(z.array(z.string())), z.null()]),
        })
      ),
      outputs: z.record(z.string(), editorOutputSchema),
    })
  ),
  loops: z.record(
    z.string(),
    workflowStateResponseSchema.shape.loops.valueType.extend({
      enabled: z.boolean(),
    })
  ),
  parallels: z.record(
    z.string(),
    workflowStateResponseSchema.shape.parallels.valueType.extend({
      enabled: z.boolean(),
    })
  ),
})

// JSON stringification would erase explicit undefined properties. This comparison
// also refuses a schema transformation or stripped field instead of silently losing it.
function sameSnapshotRepresentation(before: unknown, after: unknown): boolean {
  if (Object.is(before, after)) return true
  if (Array.isArray(before) && Array.isArray(after)) {
    return (
      before.length === after.length &&
      Object.keys(before).length === Object.keys(after).length &&
      Object.keys(before).every(
        (key) =>
          Object.hasOwn(after, key) &&
          sameSnapshotRepresentation(Reflect.get(before, key), Reflect.get(after, key))
      )
    )
  }
  if (isPlainRecord(before) && isPlainRecord(after)) {
    const keys = Object.keys(before)
    return (
      keys.length === Object.keys(after).length &&
      keys.every(
        (key) => Object.hasOwn(after, key) && sameSnapshotRepresentation(before[key], after[key])
      )
    )
  }
  return false
}

export function decodeDiffWorkflowSnapshot(input: unknown): WorkflowState {
  const parsed = editorSnapshotSchema.safeParse(input)
  if (!parsed.success || !sameSnapshotRepresentation(input, parsed.data)) {
    throw new Error(
      'The server snapshot is not representable by this editor. Synchronize before continuing.'
    )
  }
  const { draftRevision: _revision, ...state } = parsed.data
  return state
}

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
  // Own all expected values before any setter can synchronously notify subscribers.
  // Comparing with a post-set reference would silently adopt a subscriber's edit.
  const fingerprint = (value: unknown) => JSON.stringify(sortObjectKeysDeep(value))
  const graphOf = (state: WorkflowState) => ({
    currentWorkflowId: state.currentWorkflowId,
    blocks: state.blocks,
    edges: state.edges,
    loops: state.loops,
    parallels: state.parallels,
  })
  const ownedVariables = () =>
    Object.fromEntries(
      Object.entries(useVariablesStore.getState().variables).filter(
        ([, variable]) => variable.workflowId === workflowId
      )
    )
  const normalized = normalizeWorkflowState(cloned).state
  const expectedGraph = fingerprint(
    graphOf({
      ...normalized,
      currentWorkflowId:
        normalized.currentWorkflowId !== undefined
          ? normalized.currentWorkflowId
          : workflowStore.currentWorkflowId,
    })
  )
  let graphFingerprint = fingerprint(graphOf(workflowStore))
  let subblockFingerprint = fingerprint(useSubBlockStore.getState().workflowValues[workflowId])
  let variableFingerprint = fingerprint(ownedVariables())
  const expectedSubblocks = fingerprint(subBlockValues)
  const expectedVariables = fingerprint(stampWorkflowVariables(workflowId, variables))
  const assertComponents = () => {
    if (
      fingerprint(graphOf(useWorkflowStore.getState())) !== graphFingerprint ||
      fingerprint(useSubBlockStore.getState().workflowValues[workflowId]) !== subblockFingerprint ||
      fingerprint(ownedVariables()) !== variableFingerprint
    ) {
      const current = useWorkflowStore.getState()
      if (current.currentWorkflowId === workflowId && current.draftRevisionAttestation)
        current.invalidateDraftRevisionAttestation()
      throw new WorkflowSnapshotPublicationError()
    }
  }
  const assertBeforeGraph = () => {
    assertOwnership?.()
    assertComponents()
  }
  assertBeforeGraph()
  workflowStore.invalidateDraftRevisionAttestation()
  assertBeforeGraph()
  subblockFingerprint = expectedSubblocks
  useSubBlockStore.getState().setWorkflowValues(workflowId, subBlockValues)
  assertBeforeGraph()
  if (hasVariables) {
    variableFingerprint = expectedVariables
    applyWorkflowVariablesToStore(workflowId, variables)
    assertBeforeGraph()
  }
  // The callback's existing contract observes the graph before its replacement.
  // After replacement, compare to the precomputed normalized graph, not a recapture.
  graphFingerprint = expectedGraph
  workflowStore.replaceWorkflowState(cloned, ownedOptions)
  assertComponents()

  // Verify what's in the store after apply
  const afterState = workflowStore.getWorkflowState()
  logger.info('[applyWorkflowStateToStores] Applied workflow state to stores', {
    workflowId,
    afterEdgeCount: afterState.edges?.length ?? 0,
  })
}

function stampWorkflowVariables(workflowId: string, variables?: WorkflowState['variables'] | null) {
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

  return stampedVariables
}

export function applyWorkflowVariablesToStore(
  workflowId: string,
  variables?: WorkflowState['variables'] | null
) {
  const stampedVariables = stampWorkflowVariables(workflowId, variables)

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

/** Concrete boundary: deriving this from a store-reading function creates an inference cycle. */
export interface DiffObservation {
  workflowId: string
  versions: DraftSyncVersions
  pendingGeneration: number
  blocks: WorkflowState['blocks']
  edges: WorkflowState['edges']
  loops: WorkflowState['loops']
  parallels: WorkflowState['parallels']
  subblocks: SubBlockStore['workflowValues'][string] | undefined
  variables: VariablesStore['variables']
  fingerprint: string
}

/** Captured with the graph; never reconstructed to justify an older payload. */
export function captureDiffObservation(workflowId: string): DiffObservation {
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
