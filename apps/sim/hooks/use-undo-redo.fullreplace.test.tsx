// @vitest-environment jsdom
// Copyright (c) 2026 Memlia. All rights reserved.
import { act, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ApiClientError } from '@/lib/api/client/errors'
import {
  putWorkflowNormalizedStateContract,
  workflowStateResponseSchema,
} from '@/lib/api/contracts/workflows'
import { useOperationQueueStore } from '@/stores/operation-queue/store'
import { resetAllStores } from '@/stores/reset-all-stores'
import { useUndoRedoStore } from '@/stores/undo-redo/store'
import { resetRegisteredUserData } from '@/stores/user-data-reset-registry'
import { useVariablesStore } from '@/stores/variables/store'
import { useWorkflowDiffStore as diff, RESET_DIFF_STATE } from '@/stores/workflow-diff/store'
import { useWorkflowRegistry } from '@/stores/workflows/registry/store'
import { useSubBlockStore } from '@/stores/workflows/subblock/store'
import { getAttestedDraftRevision } from '@/stores/workflows/sync-local-draft'
import { useWorkflowStore } from '@/stores/workflows/workflow/store'
import type { WorkflowState } from '@/stores/workflows/workflow/types'
import { useUndoRedo } from './use-undo-redo'

const io = vi.hoisted(() => ({ request: vi.fn(), toast: vi.fn(), userId: 'user-a' }))
vi.unmock('@/blocks/registry')
vi.mock('@/lib/api/client/request', () => ({ requestJson: io.request }))
vi.mock('@/lib/auth/client', () => ({
  useSession: () => ({ data: { user: { id: io.userId } } }),
  client: { getSession: async () => ({ data: { user: { id: io.userId } } }) },
}))
vi.mock('@sim/emcn', () => ({ toast: io.toast }))
vi.mock('@/app/_shell/providers/get-query-client', () => ({
  getQueryClient: () => ({ clear: vi.fn() }),
}))
const id = 'workflow-a'
let root: Root
let host: HTMLDivElement
let api: ReturnType<typeof useUndoRedo>
function Harness() {
  api = useUndoRedo()
  return null
}
function graph(name: string): WorkflowState {
  return {
    blocks: {
      b: {
        id: 'b',
        type: 'function',
        name,
        position: { x: 0, y: 0 },
        enabled: true,
        subBlocks: { code: { id: 'code', type: 'code', value: `return '${name}'` } },
        outputs: {},
      },
    },
    edges: [],
    loops: {},
    parallels: {},
    variables: { v: { id: 'v', name: 'value', type: 'plain', value: name } },
  }
}
// Wire readbacks are parsed and stamped like the real GET, separately from UI baselines.
function wireSnapshot(state: WorkflowState, draftRevision: number) {
  return workflowStateResponseSchema.parse({
    ...state,
    variables: Object.fromEntries(
      Object.entries(state.variables ?? {}).map(([key, value]) => [
        key,
        { ...value, workflowId: id },
      ])
    ),
    draftRevision,
  })
}
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((a, b) => {
    resolve = a
    reject = b
  })
  return { promise, resolve, reject }
}
function record(type: 'apply' | 'accept' | 'reject') {
  if (type === 'apply') api.recordApplyDiff(graph('Baseline'), graph('Proposed'), {})
  if (type === 'accept')
    api.recordAcceptDiff(graph('Before'), graph('After'), {}, graph('Baseline'))
  if (type === 'reject')
    api.recordRejectDiff(graph('Before'), graph('After'), {}, graph('Baseline'))
}
function sizes() {
  return useUndoRedoStore.getState().getStackSizes(id, io.userId)
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  io.userId = 'user-a'
  io.request.mockReset()
  io.toast.mockReset()
  useUndoRedoStore.setState({ stacks: {}, capacity: 100 })
  useOperationQueueStore.getState().reset()
  diff.setState({
    ...RESET_DIFF_STATE,
    detachedDiffs: {},
    pendingExternalUpdates: {},
    remoteUpdateVersions: {},
    reconcilingWorkflows: {},
    reconciliationErrors: {},
  })
  useWorkflowRegistry.setState({ activeWorkflowId: id })
  useWorkflowStore.getState().replaceWorkflowState(
    { ...graph('Source'), currentWorkflowId: id },
    {
      draftRevisionAttestation: {
        workflowId: id,
        revision: 7,
        versions: { localOperation: 0, remoteApply: 0, remoteUpdate: 0 },
      },
    }
  )
  useSubBlockStore.getState().initializeFromWorkflow(id, graph('Source').blocks)
  useVariablesStore.setState({
    variables: { v: { ...graph('Source').variables!.v, workflowId: id } },
  })
  let saved: any
  io.request.mockImplementation(async (contract, input) => {
    if (contract === putWorkflowNormalizedStateContract) {
      saved = structuredClone(input.body)
      return { success: true, baseRevision: 7, draftRevision: 8, warnings: [] }
    }
    return wireSnapshot(saved, 8)
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<Harness />))
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
const cases = [
  ['apply', 'undo', 'Baseline', false],
  ['apply', 'redo', 'Proposed', true],
  ['accept', 'undo', 'Before', true],
  ['accept', 'redo', 'After', false],
  ['reject', 'undo', 'Before', true],
  ['reject', 'redo', 'After', false],
] as const
it.each(cases)(
  '%s %s uses one CAS and readback before graph or stack movement',
  async (type, direction, target, overlay) => {
    record(type)
    if (direction === 'redo') useUndoRedoStore.getState().undo(id, io.userId)
    const before = sizes()
    const queue = useOperationQueueStore.getState().operations
    const wait = deferred<any>()
    let sent: any
    io.request.mockImplementationOnce((_c, input) => {
      sent = structuredClone(input.body)
      return wait.promise
    })
    io.request.mockImplementationOnce(async () => wireSnapshot(sent, 8))
    let run!: Promise<unknown>
    await act(async () => {
      run = api[direction]()
    })
    try {
      expect(sizes()).toEqual(before)
      expect(useWorkflowStore.getState().blocks.b.name).toBe('Source')
      expect(window.__skipDiffRecording).not.toBe(true)
      await vi.waitFor(() => expect(io.request).toHaveBeenCalledTimes(1))
      expect(sent.expectedRevision).toBe(7)
      expect(sent.variables.v.value).toBe(target)
    } finally {
      await act(async () => {
        wait.resolve({ success: true, baseRevision: 7, draftRevision: 8, warnings: [] })
        await run
      })
    }
    expect(io.request).toHaveBeenCalledTimes(2)
    expect(useWorkflowStore.getState().blocks.b.name).toBe(target)
    expect(useVariablesStore.getState().variables.v.value).toBe(target)
    expect(sizes()).toEqual(
      direction === 'undo' ? { undoSize: 0, redoSize: 1 } : { undoSize: 1, redoSize: 0 }
    )
    expect(useOperationQueueStore.getState().operations).toBe(queue)
    expect(diff.getState().hasActiveDiff).toBe(overlay)
    if (overlay) expect(diff.getState().action?.confirmed?.revision).toBe(8)
    expect(getAttestedDraftRevision(id)).toBeNull()
    expect(io.toast).not.toHaveBeenCalled()
  }
)

function recordHumanMove() {
  api.recordBatchMoveBlocks([{ blockId: 'b', before: { x: 0, y: 0 }, after: { x: 25, y: 0 } }])
}
it.each(['conflict', 'unknown'] as const)(
  'preserves all local data on %s and shows one error without retry',
  async (failure) => {
    record('apply')
    const stacks = useUndoRedoStore.getState().stacks
    const state = useWorkflowStore.getState()
    const subblocks = useSubBlockStore.getState().workflowValues
    const variables = useVariablesStore.getState().variables
    const queue = useOperationQueueStore.getState().operations
    io.request.mockRejectedValueOnce(
      failure === 'conflict'
        ? new ApiClientError({ status: 409, message: 'Workflow draft changed', body: {} })
        : new TypeError('Response lost')
    )
    await act(async () => {
      await api.undo()
    })
    expect(useUndoRedoStore.getState().stacks).toBe(stacks)
    expect(useWorkflowStore.getState().blocks).toBe(state.blocks)
    expect(useSubBlockStore.getState().workflowValues).toBe(subblocks)
    expect(useVariablesStore.getState().variables).toBe(variables)
    expect(useOperationQueueStore.getState().operations).toBe(queue)
    expect(diff.getState().action?.phase).toBe(failure)
    expect(diff.getState().action?.intendedState.variables?.v.value).toBe('Baseline')
    expect(io.toast).toHaveBeenCalledTimes(1)
    expect(io.request).toHaveBeenCalledTimes(1)
  }
)
it.each([
  'new-edit',
  'mutated-entry',
  'clear',
  'navigation',
  'identity-reset',
  'session-change',
] as const)('does not consume history or apply a late success after %s', async (change) => {
  record('apply')
  const wait = deferred<any>()
  let sent: any
  io.request.mockImplementationOnce((_c, input) => {
    sent = structuredClone(input.body)
    return wait.promise
  })
  let run!: Promise<unknown>
  await act(async () => {
    run = api.undo()
  })
  await vi.waitFor(() => expect(io.request).toHaveBeenCalledTimes(1))
  await act(async () => {
    if (change === 'new-edit') {
      recordHumanMove()
      useWorkflowStore.getState().updateBlockName('b', 'Human')
    }
    if (change === 'mutated-entry') {
      const entry = useUndoRedoStore.getState().stacks[`${id}:${io.userId}`].undo[0]
      ;(entry.inverse.data as any).baselineSnapshot.blocks.b.name = 'Mutated history'
    }
    if (change === 'clear') useUndoRedoStore.getState().clear(id, io.userId)
    if (change === 'navigation') {
      diff.getState().detachDiffForNavigation(id, 'workflow-b')
      useWorkflowRegistry.setState({ activeWorkflowId: 'workflow-b' })
      useWorkflowStore
        .getState()
        .replaceWorkflowState({ ...graph('B'), currentWorkflowId: 'workflow-b' })
    }
    if (change === 'identity-reset') resetRegisteredUserData()
    if (change === 'session-change') {
      io.userId = 'user-b'
      root.render(<Harness />)
    }
  })
  const stacks = useUndoRedoStore.getState().stacks
  const blocks = useWorkflowStore.getState().blocks
  const variables = useVariablesStore.getState().variables
  if (change === 'new-edit') expect(sizes()).toEqual({ undoSize: 2, redoSize: 0 })
  expect(sent.blocks.b.name).toBe('Baseline')
  expect(sent.variables.v.value).toBe('Baseline')
  await act(async () => {
    wait.resolve({ success: true, baseRevision: 7, draftRevision: 8, warnings: [] })
    await run
  })
  expect(useUndoRedoStore.getState().stacks).toBe(stacks)
  expect(useWorkflowStore.getState().blocks).toBe(blocks)
  expect(useVariablesStore.getState().variables).toBe(variables)
  expect(io.request).toHaveBeenCalledTimes(1)
  if (change === 'identity-reset') {
    expect(diff.getState().action).toBeNull()
    expect(diff.getState().detachedDiffs).toEqual({})
  }
  if (change === 'navigation') {
    expect(io.toast).not.toHaveBeenCalled()
    expect(diff.getState().detachedDiffs[id].inFlight).toBe(false)
  }
})
it.each([
  'no-revision',
  'incomplete-target',
  'incomplete-baseline',
  'actorless',
  'pending-operation',
  'failed-retained-operation',
] as const)('refuses %s before any HTTP or stack movement', async (problem) => {
  record('accept')
  if (problem === 'no-revision') useWorkflowStore.getState().invalidateDraftRevisionAttestation()
  const entry = useUndoRedoStore.getState().stacks[`${id}:${io.userId}`].undo[0]
  if (problem === 'incomplete-target')
    Reflect.deleteProperty((entry.inverse.data as any).beforeAccept, 'variables')
  if (problem === 'incomplete-baseline')
    Reflect.deleteProperty((entry.inverse.data as any).baselineSnapshot, 'variables')
  if (problem === 'actorless') {
    io.userId = 'unknown'
    await act(async () => root.render(<Harness />))
    useUndoRedoStore.setState({ stacks: { [`${id}:unknown`]: { undo: [entry], redo: [] } } })
  }
  if (problem === 'pending-operation')
    useOperationQueueStore.getState().addToQueue({
      id: 'pending',
      workflowId: id,
      userId: io.userId,
      operation: { operation: 'update', target: 'block', payload: {} },
    })
  if (problem === 'failed-retained-operation')
    useOperationQueueStore.setState({
      operations: [
        {
          id: 'failed',
          workflowId: id,
          userId: io.userId,
          operation: { operation: 'update', target: 'block', payload: {} },
          status: 'failed',
          timestamp: 1,
          retryCount: 1,
        },
      ],
    })
  const stacks = useUndoRedoStore.getState().stacks
  const blocks = useWorkflowStore.getState().blocks
  await act(async () => {
    await api.undo()
  })
  expect(io.request).not.toHaveBeenCalled()
  expect(useUndoRedoStore.getState().stacks).toBe(stacks)
  expect(useWorkflowStore.getState().blocks).toBe(blocks)
  expect(io.toast).toHaveBeenCalledTimes(1)
})
it('owns recorded snapshots instead of retaining the caller mutable payload', async () => {
  const baseline = graph('Baseline')
  const proposed = graph('Proposed')
  api.recordApplyDiff(baseline, proposed, {})
  baseline.blocks.b.name = 'Changed outside history'
  baseline.variables!.v.value = 'Changed outside history'
  await act(async () => {
    await api.undo()
  })
  expect(io.request.mock.calls[0][1].body.blocks.b.name).toBe('Baseline')
  expect(io.request.mock.calls[0][1].body.variables.v.value).toBe('Baseline')
})
it('uses the valid confirmed overlay source, never the historical target as revision evidence', async () => {
  io.request.mockResolvedValueOnce(wireSnapshot(graph('Displayed'), 19))
  await diff.getState().showPersistedChanges(id)
  record('apply')
  let saved: any
  io.request.mockImplementation(async (contract, input) => {
    if (contract === putWorkflowNormalizedStateContract) {
      saved = structuredClone(input.body)
      return { success: true, baseRevision: 19, draftRevision: 20, warnings: [] }
    }
    return wireSnapshot(saved, 20)
  })
  await act(async () => {
    await api.undo()
  })
  expect(saved.expectedRevision).toBe(19)
  expect(useWorkflowStore.getState().blocks.b.name).toBe('Baseline')
  expect(sizes()).toEqual({ undoSize: 0, redoSize: 1 })
  expect(io.toast).not.toHaveBeenCalled()
})
it('restores an overlay whose accept uses the actual confirmed snapshot', async () => {
  record('accept')
  await act(async () => {
    await api.undo()
  })
  expect(diff.getState().action?.confirmed?.revision).toBe(8)
  await act(async () => {
    await diff.getState().acceptChanges({ skipRecording: true })
  })
  expect(diff.getState().hasActiveDiff).toBe(false)
  expect(useWorkflowStore.getState().blocks.b.name).toBe('Before')
  expect(useVariablesStore.getState().variables.v.value).toBe('Before')
  expect(io.request).toHaveBeenCalledTimes(2)
})
it('preserves a reentrant human edit during publication and does not commit its old history ticket', async () => {
  record('apply')
  let entered = false
  const stop = useSubBlockStore.subscribe(() => {
    if (entered) return
    entered = true
    recordHumanMove()
    useWorkflowStore.getState().updateBlockName('b', 'Human during publication')
  })
  try {
    await act(async () => {
      await api.undo()
    })
  } finally {
    stop()
  }
  expect(entered).toBe(true)
  expect(useWorkflowStore.getState().blocks.b.name).toBe('Human during publication')
  expect(useVariablesStore.getState().variables.v.value).toBe('Source')
  expect(sizes()).toEqual({ undoSize: 2, redoSize: 0 })
  expect(diff.getState().action?.phase).toBe('unknown')
  expect(io.toast).toHaveBeenCalledTimes(1)
})

it('preserves a newer remote notification received during canonical readback', async () => {
  record('apply')
  const wait = deferred<any>()
  io.request
    .mockResolvedValueOnce({ success: true, baseRevision: 7, draftRevision: 8, warnings: [] })
    .mockImplementationOnce(() => wait.promise)
  let run!: Promise<unknown>
  await act(async () => {
    run = api.undo()
  })
  await vi.waitFor(() => expect(io.request).toHaveBeenCalledTimes(2))
  const stacks = useUndoRedoStore.getState().stacks
  const blocks = useWorkflowStore.getState().blocks
  diff.getState().markExternalUpdatePending(id)
  await act(async () => {
    wait.resolve(wireSnapshot(graph('Baseline'), 8))
    await run
  })
  expect(useUndoRedoStore.getState().stacks).toBe(stacks)
  expect(useWorkflowStore.getState().blocks).toBe(blocks)
  expect(diff.getState().pendingExternalUpdates[id]).toBe(1)
  expect(diff.getState().remoteUpdateVersions[id]).toBe(1)
  expect(io.toast).toHaveBeenCalledTimes(1)
})
it.each(['subblocks', 'variables', 'stack-commit'] as const)(
  'does not reinstall anything after a native identity reset at %s publication',
  async (boundary) => {
    record('accept')
    let entered = false
    let reset: Promise<void> | undefined
    const enter = () => {
      if (!entered) {
        entered = true
        reset = resetAllStores()
      }
    }
    const stop =
      boundary === 'subblocks'
        ? useSubBlockStore.subscribe(enter)
        : boundary === 'variables'
          ? useVariablesStore.subscribe(enter)
          : useUndoRedoStore.subscribe((state) => {
              if (state.stacks[`${id}:${io.userId}`]?.redo.length) enter()
            })
    const settled = vi.fn()
    const recorded = vi.fn()
    window.addEventListener('workflow-diff-settled', settled)
    window.addEventListener('record-diff-operation', recorded)
    try {
      await act(async () => {
        await api.undo()
        await reset
      })
    } finally {
      stop()
      window.removeEventListener('workflow-diff-settled', settled)
      window.removeEventListener('record-diff-operation', recorded)
    }
    expect(entered).toBe(true)
    expect(useUndoRedoStore.getState().stacks).toEqual({})
    expect(useWorkflowRegistry.getState().activeWorkflowId).toBeNull()
    expect(useWorkflowStore.getState().blocks).toEqual({})
    expect(useWorkflowStore.getState().draftRevisionAttestation).toBeNull()
    expect(useSubBlockStore.getState().workflowValues).toEqual({})
    expect(diff.getState().action).toBeNull()
    expect(diff.getState().baselineWorkflow).toBeNull()
    expect(diff.getState().detachedDiffs).toEqual({})
    expect(diff.getState().reconcilingWorkflows).toEqual({})
    expect(diff.getState().reconciliationErrors).toEqual({})
    expect(settled).not.toHaveBeenCalled()
    expect(recorded).not.toHaveBeenCalled()
  }
)

it('preserves a reentrant variable edit before the publisher reaches variables, without relying on a queued operation', async () => {
  record('apply')
  let entered = false
  const stop = useSubBlockStore.subscribe(() => {
    if (entered) return
    entered = true
    useVariablesStore.setState((state) => ({
      variables: { ...state.variables, v: { ...state.variables.v, value: 'Human variable' } },
    }))
  })
  try {
    await act(async () => {
      await api.undo()
    })
  } finally {
    stop()
  }
  expect(entered).toBe(true)
  expect(useVariablesStore.getState().variables.v.value).toBe('Human variable')
  expect(useWorkflowStore.getState().blocks.b.name).toBe('Source')
  expect(sizes()).toEqual({ undoSize: 1, redoSize: 0 })
  expect(diff.getState().action?.phase).toBe('unknown')
})

it.each(['graph', 'subblocks'] as const)(
  'preserves an unqueued human %s edit reentered during publication',
  async (kind) => {
    record('apply')
    let entered = false
    const stop = useSubBlockStore.subscribe(() => {
      if (entered) return
      entered = true
      if (kind === 'graph') useWorkflowStore.getState().updateBlockName('b', 'Human graph')
      else useSubBlockStore.getState().setWorkflowValues(id, { b: { code: 'Human code' } })
    })
    try {
      await act(async () => {
        await api.undo()
      })
    } finally {
      stop()
    }
    expect(entered).toBe(true)
    expect(useWorkflowStore.getState().blocks.b.name).toBe(
      kind === 'graph' ? 'Human graph' : 'Source'
    )
    if (kind === 'subblocks')
      expect(useSubBlockStore.getState().workflowValues[id].b.code).toBe('Human code')
    expect(useVariablesStore.getState().variables.v.value).toBe('Source')
    expect(sizes()).toEqual({ undoSize: 1, redoSize: 0 })
    expect(diff.getState().action?.phase).toBe('unknown')
    expect(io.toast).toHaveBeenCalledTimes(1)
  }
)

it('supports the native React StrictMode setup-cleanup-setup cycle before undo', async () => {
  await act(async () =>
    root.render(
      <StrictMode>
        <Harness />
      </StrictMode>
    )
  )
  record('apply')
  await act(async () => {
    await api.undo()
  })
  expect(io.request).toHaveBeenCalledTimes(2)
  expect(useWorkflowStore.getState().blocks.b.name).toBe('Baseline')
  expect(sizes()).toEqual({ undoSize: 0, redoSize: 1 })
})
