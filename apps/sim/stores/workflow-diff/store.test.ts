// @vitest-environment jsdom
// Copyright (c) 2026 Memlia. All rights reserved.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '@/lib/api/client/errors'
import {
  getWorkflowNormalizedStateContract,
  putWorkflowNormalizedStateContract,
} from '@/lib/api/contracts/workflows'
import { useOperationQueueStore } from '@/stores/operation-queue/store'
import { resetAllStores } from '@/stores/reset-all-stores'
import { resetRegisteredUserData } from '@/stores/user-data-reset-registry'
import { useVariablesStore } from '@/stores/variables/store'
import { useWorkflowRegistry } from '@/stores/workflows/registry/store'
import { useSubBlockStore } from '@/stores/workflows/subblock/store'
import {
  canApplyHydrationSnapshot,
  captureDraftVersions,
  getAttestedDraftRevision,
} from '@/stores/workflows/sync-local-draft'
import { useWorkflowStore } from '@/stores/workflows/workflow/store'
import type { WorkflowState } from '@/stores/workflows/workflow/types'
import { useWorkflowDiffStore as diff, RESET_DIFF_STATE } from './store'

vi.unmock('@/blocks/registry')
vi.mock('@/app/_shell/providers/get-query-client', () => ({
  getQueryClient: () => ({ clear: vi.fn() }),
}))
vi.mock('@/hooks/queries/utils/invalidate-workflow-lists', () => ({
  invalidateWorkflowLists: vi.fn().mockResolvedValue(undefined),
}))
const transport = vi.hoisted(() => ({ request: vi.fn(), socket: vi.fn() }))
vi.mock('@/lib/api/client/request', () => ({ requestJson: transport.request }))
vi.mock('@/lib/workflows/operations/socket-operations', () => ({
  enqueueReplaceWorkflowState: transport.socket,
}))
const id = 'workflow-a'
function graph(name = 'Original'): WorkflowState {
  return {
    blocks: {
      b: {
        id: 'b',
        type: 'function',
        name,
        enabled: true,
        position: { x: 0, y: 0 },
        subBlocks: { code: { id: 'code', type: 'code', value: 'return 1' } },
        outputs: {},
      },
    },
    edges: [],
    loops: {},
    parallels: {},
    variables: { v: { id: 'v', name: 'threshold', type: 'number', value: 3 } },
  }
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
function setupHttp() {
  transport.request.mockImplementation(async (contract, input) =>
    contract === putWorkflowNormalizedStateContract
      ? {
          success: true,
          baseRevision: input.body.expectedRevision,
          draftRevision: input.body.expectedRevision + 1,
          warnings: [],
        }
      : { ...graph('Proposed'), draftRevision: 8 }
  )
}
function edit() {
  useWorkflowStore.getState().updateBlockName('b', 'Human')
  useOperationQueueStore.getState().markRemoteApplied(id)
}
beforeEach(() => {
  transport.request.mockReset()
  transport.socket.mockReset().mockResolvedValue(undefined)
  useOperationQueueStore.getState().reset()
  useWorkflowRegistry.setState({ activeWorkflowId: id })
  diff.setState({
    ...RESET_DIFF_STATE,
    detachedDiffs: {},
    pendingExternalUpdates: {},
    remoteUpdateVersions: {},
    reconciliationErrors: {},
    reconcilingWorkflows: {},
  })
  useWorkflowStore.getState().replaceWorkflowState(
    { ...graph(), currentWorkflowId: id },
    {
      draftRevisionAttestation: {
        workflowId: id,
        revision: 7,
        versions: { localOperation: 0, remoteApply: 0, remoteUpdate: 0 },
      },
    }
  )
  useSubBlockStore.getState().initializeFromWorkflow(id, graph().blocks)
  useVariablesStore.setState({ variables: { v: { ...graph().variables!.v, workflowId: id } } })
  setupHttp()
})
afterEach(() => vi.restoreAllMocks())
describe('diff CAS with real engine, stores and queue; controlled HTTP/socket', () => {
  it('uses one awaited PUT and the exact canonical readback, never a socket full replacement', async () => {
    const wait = deferred<any>()
    transport.request.mockImplementationOnce(() => wait.promise)
    const run = diff.getState().setProposedChanges(graph('Proposed'))
    void run.catch(() => {})
    await vi.waitFor(() => expect(transport.request).toHaveBeenCalled())
    expect(useWorkflowStore.getState().blocks.b.name).toBe('Original')
    expect(diff.getState().action?.phase).toBe('saving')
    wait.resolve({ success: true, baseRevision: 7, draftRevision: 8, warnings: [] })
    await run
    expect(transport.socket).not.toHaveBeenCalled()
    expect(transport.request.mock.calls.map((c) => c[0])).toEqual([
      putWorkflowNormalizedStateContract,
      getWorkflowNormalizedStateContract,
    ])
    expect(transport.request.mock.calls[0][1].body).toMatchObject({
      expectedRevision: 7,
      variables: { v: { value: 3 } },
    })
    expect(useWorkflowStore.getState().blocks.b.name).toBe('Proposed')
    expect(diff.getState().action?.phase).toBe('confirmed')
    expect(getAttestedDraftRevision(id)).toBeNull()
  })
  it('never writes without an attested source', async () => {
    useWorkflowStore.getState().invalidateDraftRevisionAttestation()
    await expect(diff.getState().setProposedChanges(graph('Proposed'))).rejects.toThrow()
    expect(transport.request).not.toHaveBeenCalled()
    expect(useWorkflowStore.getState().blocks.b.name).toBe('Original')
  })
  it('preserves source and intended baseline on 409 without retry or offline queue clearing', async () => {
    const fail = vi.spyOn(useOperationQueueStore.getState(), 'failOperation')
    transport.request.mockRejectedValueOnce(
      new ApiClientError({ status: 409, message: 'Conflict', body: {} })
    )
    await expect(diff.getState().setProposedChanges(graph('Proposed'))).rejects.toMatchObject({
      status: 409,
    })
    expect(useWorkflowStore.getState().blocks.b.name).toBe('Original')
    expect(diff.getState().baselineWorkflow?.blocks.b.name).toBe('Original')
    expect(diff.getState().action?.phase).toBe('conflict')
    expect(fail).not.toHaveBeenCalled()
    expect(transport.request).toHaveBeenCalledTimes(1)
  })
  it('keeps an unknown write outcome without applying, retrying or attesting its receipt', async () => {
    transport.request.mockRejectedValueOnce(new TypeError('Response lost'))
    await expect(diff.getState().setProposedChanges(graph('Proposed'))).rejects.toThrow(
      'Response lost'
    )
    expect(diff.getState().action?.phase).toBe('unknown')
    expect(useWorkflowStore.getState().blocks.b.name).toBe('Original')
    expect(transport.request).toHaveBeenCalledTimes(1)
  })
  it('does not overwrite a human edit while PUT is awaiting its response', async () => {
    const wait = deferred<any>()
    transport.request.mockImplementationOnce(() => wait.promise)
    const run = diff.getState().setProposedChanges(graph('Proposed'))
    void run.catch(() => {})
    await vi.waitFor(() => expect(transport.request).toHaveBeenCalled())
    edit()
    wait.resolve({ success: true, baseRevision: 7, draftRevision: 8, warnings: [] })
    await expect(run).rejects.toThrow()
    expect(useWorkflowStore.getState().blocks.b.name).toBe('Human')
    expect(transport.request).toHaveBeenCalledTimes(1)
  })
  it('covers an event before readback but preserves an event arriving during readback', async () => {
    const read = deferred<any>()
    transport.request.mockImplementation(async (contract) => {
      if (contract === putWorkflowNormalizedStateContract) {
        diff.getState().markExternalUpdatePending(id)
        return { success: true, baseRevision: 7, draftRevision: 8, warnings: [] }
      }
      return read.promise
    })
    const run = diff.getState().setProposedChanges(graph('Proposed'))
    void run.catch(() => {})
    await vi.waitFor(() => expect(transport.request).toHaveBeenCalledTimes(2))
    diff.getState().markExternalUpdatePending(id)
    read.resolve({ ...graph('Proposed'), draftRevision: 8 })
    await expect(run).rejects.toThrow()
    expect(diff.getState().pendingExternalUpdates[id]).toBe(2)
    expect(useWorkflowStore.getState().blocks.b.name).toBe('Original')
  })
  it('can confirm readback covering exactly the preceding event, without inventing an ACK', async () => {
    transport.request.mockImplementation(async (contract) => {
      if (contract === putWorkflowNormalizedStateContract) {
        diff.getState().markExternalUpdatePending(id)
        return { success: true, baseRevision: 7, draftRevision: 8, warnings: [] }
      }
      return { ...graph('Proposed'), draftRevision: 8 }
    })
    await diff.getState().setProposedChanges(graph('Proposed'))
    expect(diff.getState().pendingExternalUpdates[id]).toBeUndefined()
    expect(diff.getState().remoteUpdateVersions[id]).toBe(1)
    expect(diff.getState().action?.phase).toBe('confirmed')
  })
  it('rejects through a new CAS including baseline variables, applying only after confirmation', async () => {
    await diff.getState().setProposedChanges(graph('Proposed'))
    transport.request.mockReset()
    transport.request
      .mockResolvedValueOnce({ ...graph('Proposed'), draftRevision: 8 })
      .mockResolvedValueOnce({ success: true, baseRevision: 8, draftRevision: 9, warnings: [] })
      .mockResolvedValueOnce({ ...graph(), draftRevision: 9 })
    await diff.getState().rejectChanges()
    expect(transport.request.mock.calls.map((c) => c[0])).toEqual([
      getWorkflowNormalizedStateContract,
      putWorkflowNormalizedStateContract,
      getWorkflowNormalizedStateContract,
    ])
    expect(transport.request.mock.calls[1][1].body).toMatchObject({
      expectedRevision: 8,
      variables: { v: { value: 3 } },
    })
    expect(useWorkflowStore.getState().blocks.b.name).toBe('Original')
    expect(diff.getState().hasActiveDiff).toBe(false)
  })
})

it('uses the native HTTP contracts and keeps canonical IDs from the response', async () => {
  const native = await vi.importActual<typeof import('@/lib/api/client/request')>(
    '@/lib/api/client/request'
  )
  transport.request.mockImplementation(native.requestJson)
  let saved: any
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    if (init?.method === 'PUT') {
      saved = JSON.parse(String(init.body))
      return Response.json({ success: true, baseRevision: 7, draftRevision: 8, warnings: [] })
    }
    return Response.json({
      ...saved,
      variables: Object.fromEntries(
        Object.entries(saved.variables).map(([key, value]) => [
          key,
          { ...(value as object), workflowId: id },
        ])
      ),
      draftRevision: 8,
    })
  })
  await diff.getState().setProposedChanges(graph('Proposed'))
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(saved.expectedRevision).toBe(7)
  expect(Object.keys(useWorkflowStore.getState().blocks)).toEqual(Object.keys(saved.blocks))
  expect(diff.getState().action?.confirmed?.revision).toBe(8)
  expect(getAttestedDraftRevision(id)).toBeNull()
})
it('reads a persisted snapshot for the captured workflow without writing or changing its IDs', async () => {
  await diff.getState().showPersistedChanges(id)
  expect(transport.request.mock.calls.map((c) => c[0])).toEqual([
    getWorkflowNormalizedStateContract,
  ])
  expect(useWorkflowStore.getState().blocks.b.name).toBe('Proposed')
  expect(diff.getState().action?.confirmed?.revision).toBe(8)
})
it('refuses navigation while reading a persisted snapshot', async () => {
  const wait = deferred<any>()
  transport.request.mockImplementationOnce(() => wait.promise)
  const run = diff.getState().showPersistedChanges(id)
  void run.catch(() => {})
  useWorkflowRegistry.setState({ activeWorkflowId: 'workflow-b' })
  wait.resolve({ ...graph('Proposed'), draftRevision: 8 })
  await expect(run).rejects.toThrow()
  expect(useWorkflowStore.getState().blocks.b.name).toBe('Original')
})
it.each(['get', 'engine'] as const)(
  'preserves a human edit during the %s stage of a persisted refresh',
  async (stage) => {
    const wait = deferred<any>()
    if (stage === 'get') transport.request.mockImplementationOnce(() => wait.promise)
    else {
      const { WorkflowDiffEngine } = await import('@/lib/workflows/diff')
      const original = WorkflowDiffEngine.prototype.createDiffFromWorkflowState
      vi.spyOn(WorkflowDiffEngine.prototype, 'createDiffFromWorkflowState').mockImplementationOnce(
        async function (...args) {
          await wait.promise
          return original.apply(this, args)
        }
      )
    }
    const run = diff.getState().showPersistedChanges(id)
    void run.catch(() => {})
    await vi.waitFor(() => expect(transport.request).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))
    edit()
    wait.resolve({ ...graph('Proposed'), draftRevision: 8 })
    await expect(run).rejects.toThrow()
    expect(useWorkflowStore.getState().blocks.b.name).toBe('Human')
  }
)
it('owns the proposed values and baseline options before the asynchronous engine', async () => {
  const { WorkflowDiffEngine } = await import('@/lib/workflows/diff')
  const original = WorkflowDiffEngine.prototype.createDiffFromWorkflowState
  const wait = deferred<void>()
  vi.spyOn(WorkflowDiffEngine.prototype, 'createDiffFromWorkflowState').mockImplementationOnce(
    async function (...args) {
      await wait.promise
      return original.apply(this, args)
    }
  )
  const state = graph('Proposed')
  const options = { baselineWorkflow: graph(), skipRecording: true }
  const run = diff.getState().setProposedChanges(state, undefined, options)
  void run.catch(() => {})
  state.variables!.v.value = 900
  state.blocks.b.subBlocks.code.value = 'caller-mutated'
  options.baselineWorkflow.blocks.b.name = 'caller-mutated'
  wait.resolve()
  await run
  const body = transport.request.mock.calls[0][1].body
  expect(body.variables.v.value).toBe(3)
  expect(
    Object.values(body.blocks).some((b: any) => b.subBlocks.code.value === 'caller-mutated')
  ).toBe(false)
  expect(diff.getState().baselineWorkflow?.blocks.b.name).toBe('Original')
})
it('refuses newer readback revision rather than using it to rebase the proposal', async () => {
  transport.request.mockImplementation(async (contract) =>
    contract === putWorkflowNormalizedStateContract
      ? { success: true, baseRevision: 7, draftRevision: 8, warnings: [] }
      : { ...graph('New collaborator'), draftRevision: 9 }
  )
  await expect(diff.getState().setProposedChanges(graph('Proposed'))).rejects.toThrow()
  expect(useWorkflowStore.getState().blocks.b.name).toBe('Original')
  expect(diff.getState().action?.phase).toBe('unknown')
  expect(transport.request).toHaveBeenCalledTimes(2)
})
it('retains the confirmed candidate and variables on rejection conflict', async () => {
  await diff.getState().showPersistedChanges(id)
  transport.request
    .mockReset()
    .mockResolvedValueOnce({ ...graph('Proposed'), draftRevision: 8 })
    .mockRejectedValueOnce(new ApiClientError({ status: 409, message: 'Conflict', body: {} }))
  await expect(diff.getState().rejectChanges()).rejects.toMatchObject({ status: 409 })
  expect(useWorkflowStore.getState().blocks.b.name).toBe('Proposed')
  expect(useVariablesStore.getState().variables.v.value).toBe(3)
  expect(diff.getState().baselineWorkflow?.blocks.b.name).toBe('Original')
  expect(diff.getState().action?.phase).toBe('conflict')
  expect(transport.request).toHaveBeenCalledTimes(2)
})
it('refuses an inverse if the server revision changed before its preflight', async () => {
  await diff.getState().showPersistedChanges(id)
  transport.request.mockReset().mockResolvedValueOnce({ ...graph('Other'), draftRevision: 9 })
  await expect(diff.getState().rejectChanges()).rejects.toThrow()
  expect(transport.request.mock.calls.map((c) => c[0])).toEqual([
    getWorkflowNormalizedStateContract,
  ])
  expect(useWorkflowStore.getState().blocks.b.name).toBe('Proposed')
})
it('does not accept or reject an unconfirmed write, and preserves queued work', async () => {
  const wait = deferred<any>()
  transport.request.mockImplementationOnce(() => wait.promise)
  const run = diff.getState().setProposedChanges(graph('Proposed'))
  void run.catch(() => {})
  await vi.waitFor(() => expect(transport.request).toHaveBeenCalled())
  await expect(diff.getState().acceptChanges()).rejects.toThrow()
  await expect(diff.getState().rejectChanges()).rejects.toThrow()
  useOperationQueueStore.getState().addToQueue({
    id: 'pending-local',
    workflowId: id,
    userId: 'fictive',
    operation: { operation: 'update', target: 'block', payload: {} },
  })
  wait.resolve({ success: true, baseRevision: 7, draftRevision: 8, warnings: [] })
  await expect(run).rejects.toThrow()
  expect(useOperationQueueStore.getState().operations.some((op) => op.id === 'pending-local')).toBe(
    true
  )
})
it('rejects snapshots requiring destructive normalization without changing the canvas', async () => {
  transport.request.mockResolvedValueOnce({
    ...graph('Proposed'),
    edges: [{ id: 'dangling', source: 'missing', target: 'b' }],
    draftRevision: 8,
  })
  await expect(diff.getState().showPersistedChanges(id)).rejects.toThrow('normalization')
  expect(useWorkflowStore.getState().blocks.b.name).toBe('Original')
  expect(useWorkflowStore.getState().edges).toEqual([])
})
it('accepts confirmed markers without another write and emits one native undo event', async () => {
  const record = vi.fn()
  window.addEventListener('record-diff-operation', record)
  try {
    await diff.getState().showPersistedChanges(id)
    const requests = transport.request.mock.calls.length
    record.mockClear()
    await diff.getState().acceptChanges()
    expect(record).toHaveBeenCalledTimes(1)
    expect(record.mock.calls[0][0].detail.type).toBe('accept-diff')
    expect(transport.request).toHaveBeenCalledTimes(requests)
    expect(diff.getState().hasActiveDiff).toBe(false)
    expect(getAttestedDraftRevision(id)).toBeNull()
  } finally {
    window.removeEventListener('record-diff-operation', record)
  }
})
it('cannot substitute a historical baseline for the attested live source', async () => {
  await expect(
    diff
      .getState()
      .setProposedChanges(graph('Proposed'), undefined, { baselineWorkflow: graph('Historical') })
  ).rejects.toThrow()
  expect(transport.request).not.toHaveBeenCalled()
  expect(useWorkflowStore.getState().blocks.b.name).toBe('Original')
})
it('can display a second persisted edit using the original inverse baseline', async () => {
  await diff.getState().showPersistedChanges(id)
  diff.getState().markExternalUpdatePending(id)
  transport.request.mockResolvedValueOnce({ ...graph('Second'), draftRevision: 9 })
  await diff.getState().showPersistedChanges(id)
  expect(useWorkflowStore.getState().blocks.b.name).toBe('Second')
  expect(diff.getState().baselineWorkflow?.blocks.b.name).toBe('Original')
  expect(diff.getState().action?.confirmed?.revision).toBe(9)
})
it('does not apply a late baseline via clearDiff while a write is pending', async () => {
  const wait = deferred<any>()
  transport.request.mockImplementationOnce(() => wait.promise)
  const run = diff.getState().setProposedChanges(graph('Proposed'))
  void run.catch(() => {})
  await vi.waitFor(() => expect(transport.request).toHaveBeenCalled())
  edit()
  expect(() => diff.getState().clearDiff()).toThrow()
  expect(useWorkflowStore.getState().blocks.b.name).toBe('Human')
  wait.resolve({ success: true, baseRevision: 7, draftRevision: 8, warnings: [] })
  await expect(run).rejects.toThrow()
})
it('keeps an event emitted synchronously during local canonical application pending', async () => {
  const stop = useWorkflowStore.subscribe((state) => {
    if (state.blocks.b?.name === 'Proposed') diff.getState().markExternalUpdatePending(id)
  })
  try {
    await expect(diff.getState().showPersistedChanges(id)).rejects.toThrow()
    expect(diff.getState().pendingExternalUpdates[id]).toBe(1)
    expect(diff.getState().action?.phase).toBe('unknown')
    expect(getAttestedDraftRevision(id)).toBeNull()
  } finally {
    stop()
  }
})
it('does not let an undo-event subscriber mutate the owned inverse baseline', async () => {
  const mutate = (event: Event) => {
    ;(event as CustomEvent).detail.baselineSnapshot.blocks.b.name = 'listener mutation'
  }
  window.addEventListener('record-diff-operation', mutate)
  try {
    await diff.getState().showPersistedChanges(id)
    expect(diff.getState().baselineWorkflow?.blocks.b.name).toBe('Original')
  } finally {
    window.removeEventListener('record-diff-operation', mutate)
  }
})
it('does not stage or record a persisted diff with no semantic changes', async () => {
  transport.request.mockResolvedValueOnce({ ...graph(), draftRevision: 8 })
  const record = vi.fn()
  window.addEventListener('record-diff-operation', record)
  try {
    await diff.getState().showPersistedChanges(id)
    expect(diff.getState().hasActiveDiff).toBe(false)
    expect(diff.getState().action).toBeNull()
    expect(record).not.toHaveBeenCalled()
    expect(useWorkflowStore.getState().blocks.b.name).toBe('Original')
  } finally {
    window.removeEventListener('record-diff-operation', record)
  }
})
it('owns the confirmed source primitives before the inverse preflight awaits', async () => {
  await diff.getState().showPersistedChanges(id)
  const wait = deferred<any>()
  transport.request.mockReset().mockImplementationOnce(() => wait.promise)
  const run = diff.getState().rejectChanges()
  void run.catch(() => {})
  const retained = diff.getState().action!.confirmed!
  retained.state.blocks.b.name = 'mutable-handle'
  retained.observation.versions.remoteUpdate = 99
  transport.request
    .mockResolvedValueOnce({ success: true, baseRevision: 8, draftRevision: 9, warnings: [] })
    .mockResolvedValueOnce({ ...graph(), draftRevision: 9 })
  wait.resolve({ ...graph('Proposed'), draftRevision: 8 })
  await run
  expect(transport.request.mock.calls[1][1].body.expectedRevision).toBe(8)
  expect(useWorkflowStore.getState().blocks.b.name).toBe('Original')
})
it('preserves captured variables when the local proposal omits them', async () => {
  const { variables: _variables, ...state } = graph('Proposed')
  await diff.getState().setProposedChanges(state)
  expect(transport.request.mock.calls[0][1].body.variables.v.value).toBe(3)
})

it('writes explicitly empty variables in the same CAS as the graph', async () => {
  const state = { ...graph('Proposed'), variables: {} }
  transport.request.mockImplementation(async (contract) =>
    contract === putWorkflowNormalizedStateContract
      ? { success: true, baseRevision: 7, draftRevision: 8, warnings: [] }
      : { ...state, draftRevision: 8 }
  )
  await diff.getState().setProposedChanges(state)
  expect(transport.request.mock.calls[0][1].body.variables).toEqual({})
  expect(useVariablesStore.getState().variables).toEqual({})
})

describe('navigation detaches ownership without settling the old intention', () => {
  function navigate(destination: string) {
    diff.getState().detachDiffForNavigation(id, destination)
    useWorkflowRegistry.setState({ activeWorkflowId: destination })
    useWorkflowStore
      .getState()
      .replaceWorkflowState({ ...graph('Destination'), currentWorkflowId: destination })
    useSubBlockStore.getState().initializeFromWorkflow(destination, graph('Destination').blocks)
  }
  it('detaches a confirmed diff without restoring its baseline or losing its intention', async () => {
    await diff.getState().showPersistedChanges(id)
    const before = useWorkflowStore.getState().blocks
    const intention = structuredClone(diff.getState().action!.intendedState)
    expect(() => diff.getState().clearDiff()).toThrow()
    diff.getState().detachDiffForNavigation(id, 'workflow-b')
    expect(useWorkflowStore.getState().blocks).toBe(before)
    expect(diff.getState().action).toBeNull()
    expect(diff.getState().hasActiveDiff).toBe(false)
    expect(diff.getState().detachedDiffs[id].action!.intendedState).toEqual(intention)
  })
  it.each(['PUT', 'GET'])(
    'does not apply a late %s after navigation A to B to A',
    async (phase) => {
      const wait = deferred<any>()
      if (phase === 'GET')
        transport.request.mockResolvedValueOnce({
          success: true,
          baseRevision: 7,
          draftRevision: 8,
          warnings: [],
        })
      transport.request.mockImplementationOnce(() => wait.promise)
      const run = diff.getState().setProposedChanges(graph('Proposed'))
      void run.catch(() => {})
      await vi.waitFor(() =>
        expect(transport.request).toHaveBeenCalledTimes(phase === 'GET' ? 2 : 1)
      )
      const intended = structuredClone(diff.getState().action!.intendedState)
      const record = vi.fn()
      const settled = vi.fn()
      window.addEventListener('record-diff-operation', record)
      window.addEventListener('workflow-diff-settled', settled)
      navigate('workflow-b')
      diff.getState().detachDiffForNavigation('workflow-b', id)
      useWorkflowRegistry.setState({ activeWorkflowId: id })
      useWorkflowStore
        .getState()
        .replaceWorkflowState({ ...graph('New visit'), currentWorkflowId: id })
      const queued = useOperationQueueStore.getState().operations
      await expect(diff.getState().consultDetachedDiff(id)).rejects.toThrow('pending request')
      wait.resolve(
        phase === 'PUT'
          ? { success: true, baseRevision: 7, draftRevision: 8, warnings: [] }
          : { ...graph('Proposed'), draftRevision: 8 }
      )
      await expect(run).rejects.toThrow()
      expect(useWorkflowStore.getState().blocks.b.name).toBe('New visit')
      expect(getAttestedDraftRevision(id)).toBeNull()
      expect(diff.getState().detachedDiffs[id].action!.intendedState).toEqual(intended)
      expect(diff.getState().detachedDiffs[id].inFlight).toBe(false)
      expect(useOperationQueueStore.getState().operations).toBe(queued)
      expect(record).not.toHaveBeenCalled()
      expect(settled).not.toHaveBeenCalled()
      window.removeEventListener('record-diff-operation', record)
      window.removeEventListener('workflow-diff-settled', settled)
    }
  )
  it('requires consultation then explicit abandonment, never attributes an unknown commit', async () => {
    transport.request.mockRejectedValueOnce(new TypeError('Response lost'))
    await expect(diff.getState().setProposedChanges(graph('Intended'))).rejects.toThrow()
    navigate('workflow-b')
    useWorkflowRegistry.setState({ activeWorkflowId: id })
    useWorkflowStore.getState().replaceWorkflowState({ ...graph('Return'), currentWorkflowId: id })
    useSubBlockStore.getState().initializeFromWorkflow(id, graph('Return').blocks)
    expect(() => diff.getState().abandonDetachedDiff(id)).toThrow()
    transport.request.mockResolvedValueOnce({ ...graph('Server'), draftRevision: 11 })
    await diff.getState().consultDetachedDiff(id)
    expect(useWorkflowStore.getState().blocks.b.name).toBe('Return')
    expect(diff.getState().detachedDiffs[id].action!.phase).toBe('unknown')
    expect(diff.getState().detachedDiffs[id].consultation!.revision).toBe(11)
    diff.getState().abandonDetachedDiff(id)
    expect(useWorkflowStore.getState().blocks.b.name).toBe('Server')
    expect(diff.getState().detachedDiffs[id]).toBeUndefined()
    expect(getAttestedDraftRevision(id)).toBeNull()
    expect(
      transport.request.mock.calls.filter((c) => c[0] === putWorkflowNormalizedStateContract)
    ).toHaveLength(1)
  })
  it('rejects consultation made stale by navigation even after returning to the same workflow', async () => {
    await diff.getState().showPersistedChanges(id)
    navigate('workflow-b')
    useWorkflowRegistry.setState({ activeWorkflowId: id })
    useWorkflowStore.getState().replaceWorkflowState({ ...graph('Return'), currentWorkflowId: id })
    const wait = deferred<any>()
    transport.request.mockImplementationOnce(() => wait.promise)
    const run = diff.getState().consultDetachedDiff(id)
    void run.catch(() => {})
    navigate('workflow-b')
    useWorkflowRegistry.setState({ activeWorkflowId: id })
    wait.resolve({ ...graph('Server'), draftRevision: 8 })
    await expect(run).rejects.toThrow()
    expect(diff.getState().detachedDiffs[id].consultation).toBeUndefined()
  })
  it('cancels an old batched overlay update during detachment', async () => {
    await diff.getState().showPersistedChanges(id)
    diff.getState()._batchedStateUpdate({ hasActiveDiff: true, status: 'staged' })
    navigate('workflow-b')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(diff.getState().hasActiveDiff).toBe(false)
    expect(diff.getState().status).toBe('none')
  })
})

it('revokes identity data, a pending write and timers through the native reset registry', async () => {
  const wait = deferred<any>()
  transport.request.mockImplementationOnce(() => wait.promise)
  const run = diff.getState().setProposedChanges(graph('Private intention'))
  void run.catch(() => {})
  await vi.waitFor(() => expect(transport.request).toHaveBeenCalledOnce())
  diff.getState().detachDiffForNavigation(id, 'b')
  diff.getState()._batchedStateUpdate({ hasActiveDiff: true })
  resetRegisteredUserData()
  expect(diff.getState().detachedDiffs).toEqual({})
  wait.resolve({ success: true, baseRevision: 7, draftRevision: 8, warnings: [] })
  await expect(run).rejects.toThrow()
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(diff.getState().hasActiveDiff).toBe(false)
  expect(diff.getState().action).toBeNull()
  expect(diff.getState().detachedDiffs).toEqual({})
})
it('does not overwrite destination B when a native subblock subscriber navigates during publication', async () => {
  const unsubscribe = useSubBlockStore.subscribe(() => {
    unsubscribe()
    diff.getState().detachDiffForNavigation(id, 'b')
    useWorkflowRegistry.setState({ activeWorkflowId: 'b' })
    useWorkflowStore
      .getState()
      .replaceWorkflowState({ ...graph('Destination B'), currentWorkflowId: 'b' })
  })
  await expect(diff.getState().showPersistedChanges(id)).rejects.toThrow()
  expect(useWorkflowStore.getState().currentWorkflowId).toBe('b')
  expect(useWorkflowStore.getState().blocks.b.name).toBe('Destination B')
})

it('honors the real identity reset reentering through a native publication subscriber', async () => {
  let reset!: Promise<void>
  const record = vi.fn()
  const settled = vi.fn()
  window.addEventListener('record-diff-operation', record)
  window.addEventListener('workflow-diff-settled', settled)
  const variables = useVariablesStore.getState().variables
  const unsubscribe = useSubBlockStore.subscribe(() => {
    unsubscribe()
    reset = resetAllStores()
  })
  await expect(diff.getState().showPersistedChanges(id)).rejects.toThrow()
  await reset
  expect(useWorkflowStore.getState().currentWorkflowId).toBeNull()
  expect(useWorkflowStore.getState().blocks).toEqual({})
  expect(useSubBlockStore.getState().workflowValues).toEqual({})
  expect(useVariablesStore.getState().variables).toBe(variables)
  expect(diff.getState().baselineWorkflow).toBeNull()
  expect(diff.getState().action).toBeNull()
  expect(diff.getState().detachedDiffs).toEqual({})
  expect(diff.getState().hasActiveDiff).toBe(false)
  expect(getAttestedDraftRevision(id)).toBeNull()
  expect(record).not.toHaveBeenCalled()
  expect(settled).not.toHaveBeenCalled()
  window.removeEventListener('record-diff-operation', record)
  window.removeEventListener('workflow-diff-settled', settled)
})

it('permits only one server consultation at a time for a detached intention', async () => {
  await diff.getState().showPersistedChanges(id)
  diff.getState().detachDiffForNavigation(id, id)
  const wait = deferred<any>()
  transport.request.mockImplementationOnce(() => wait.promise)
  const first = diff.getState().consultDetachedDiff(id)
  const count = transport.request.mock.calls.length
  await expect(diff.getState().consultDetachedDiff(id)).rejects.toThrow()
  expect(transport.request).toHaveBeenCalledTimes(count)
  wait.resolve({ ...graph('Consulted'), draftRevision: 9 })
  await first
  expect(diff.getState().detachedDiffs[id].consultation!.revision).toBe(9)
})
it('refuses abandonment if a new human edit occurred after server consultation', async () => {
  await diff.getState().showPersistedChanges(id)
  diff.getState().detachDiffForNavigation(id, id)
  await diff.getState().consultDetachedDiff(id)
  edit()
  const intended = diff.getState().detachedDiffs[id]
  expect(() => diff.getState().abandonDetachedDiff(id)).toThrow()
  expect(useWorkflowStore.getState().blocks.b.name).toBe('Human')
  expect(diff.getState().detachedDiffs[id]).toBe(intended)
})

it.each(['starting', 'failing'])(
  'does not reinstall reconciliation flags after an identity reset while %s',
  async (phase) => {
    if (phase === 'failing') transport.request.mockRejectedValueOnce(new Error('Unknown outcome'))
    const unsubscribe = diff.subscribe((state) => {
      if (state.action?.phase === (phase === 'starting' ? 'saving' : 'unknown')) {
        unsubscribe()
        resetRegisteredUserData()
      }
    })
    await expect(diff.getState().setProposedChanges(graph('Proposed'))).rejects.toThrow()
    expect(diff.getState().action).toBeNull()
    expect(diff.getState().detachedDiffs).toEqual({})
    expect(diff.getState().reconcilingWorkflows).toEqual({})
    expect(diff.getState().reconciliationErrors).toEqual({})
  }
)

describe('native workspace switching detaches before identities disappear', () => {
  it.each(['saving', 'confirmed', 'conflict', 'unknown'] as const)(
    'preserves the %s intention across workspace A, null, B, and A',
    async (phase) => {
      const wait = deferred<any>()
      let run: Promise<unknown> | undefined
      if (phase === 'confirmed') await diff.getState().showPersistedChanges(id)
      else {
        if (phase === 'saving') transport.request.mockImplementationOnce(() => wait.promise)
        else
          transport.request.mockRejectedValueOnce(
            phase === 'conflict'
              ? new ApiClientError({ status: 409, message: 'Conflict', body: {} })
              : new TypeError('Response lost')
          )
        run = diff.getState().setProposedChanges(graph('Intended'))
        void run.catch(() => {})
        if (phase === 'saving') await vi.waitFor(() => expect(transport.request).toHaveBeenCalled())
        else await expect(run).rejects.toThrow()
      }
      const intended = structuredClone(diff.getState().action!.intendedState)
      expect(() => diff.getState().clearDiff()).toThrow()
      useWorkflowRegistry.getState().switchToWorkspace('workspace-b')
      expect(useWorkflowRegistry.getState().activeWorkflowId).toBeNull()
      expect(useWorkflowStore.getState().currentWorkflowId).toBeNull()
      diff.getState().detachDiffForNavigation(null, 'workflow-b')
      expect(diff.getState().action).toBeNull()
      expect(diff.getState().hasActiveDiff).toBe(false)
      expect(diff.getState().detachedDiffs[id].action).toMatchObject({
        phase,
        intendedState: intended,
      })
      expect(canApplyHydrationSnapshot('workflow-b', captureDraftVersions('workflow-b'))).toBe(true)
      useWorkflowRegistry.setState({ activeWorkflowId: 'workflow-b' })
      useWorkflowStore
        .getState()
        .replaceWorkflowState({ ...graph('B'), currentWorkflowId: 'workflow-b' })
      useWorkflowRegistry.getState().switchToWorkspace('workspace-a')
      diff.getState().detachDiffForNavigation(null, id)
      useWorkflowRegistry.setState({ activeWorkflowId: id })
      useWorkflowStore
        .getState()
        .replaceWorkflowState({ ...graph('Return'), currentWorkflowId: id })
      if (phase === 'saving') {
        wait.resolve({ success: true, baseRevision: 7, draftRevision: 8, warnings: [] })
        await expect(run).rejects.toThrow()
      }
      expect(useWorkflowStore.getState().blocks.b.name).toBe('Return')
      expect(getAttestedDraftRevision(id)).toBeNull()
      expect(diff.getState().detachedDiffs[id].action!.intendedState).toEqual(intended)
      expect(diff.getState().detachedDiffs[id].inFlight).toBe(false)
      expect(() => diff.getState().abandonDetachedDiff(id)).toThrow()
    }
  )

  it.each(['detach', 'graph-reset', 'subblock-reset'] as const)(
    'never overwrites a newer workspace transition reentered at %s',
    async (boundary) => {
      await diff.getState().showPersistedChanges(id)
      let entered = false
      const enter = () => {
        if (entered) return
        entered = true
        useWorkflowRegistry.getState().switchToWorkspace('workspace-c')
        useWorkflowRegistry.setState({ activeWorkflowId: 'workflow-c' })
        useWorkflowStore
          .getState()
          .replaceWorkflowState({ ...graph('C'), currentWorkflowId: 'workflow-c' })
        useSubBlockStore.getState().initializeFromWorkflow('workflow-c', graph('C').blocks)
      }
      const unsubscribe =
        boundary === 'detach'
          ? diff.subscribe((state) => {
              if (state.detachedDiffs[id]) enter()
            })
          : boundary === 'graph-reset'
            ? useWorkflowStore.subscribe((state) => {
                if (state.currentWorkflowId === null) enter()
              })
            : useSubBlockStore.subscribe((state) => {
                if (!Object.keys(state.workflowValues).length) enter()
              })
      try {
        useWorkflowRegistry.getState().switchToWorkspace('workspace-b')
      } finally {
        unsubscribe()
      }
      expect(entered).toBe(true)
      expect(useWorkflowRegistry.getState().hydration.workspaceId).toBe('workspace-c')
      expect(useWorkflowRegistry.getState().activeWorkflowId).toBe('workflow-c')
      expect(useWorkflowStore.getState().blocks.b.name).toBe('C')
      expect(useSubBlockStore.getState().workflowValues['workflow-c']).toBeDefined()
      expect(diff.getState().action).toBeNull()
      expect(diff.getState().detachedDiffs[id].action!.workflowId).toBe(id)
    }
  )

  it.each(['detach', 'graph-reset', 'subblock-reset'] as const)(
    'does not reinstall workspace scope after identity reset during %s',
    async (boundary) => {
      await diff.getState().showPersistedChanges(id)
      let reset: Promise<void> | undefined
      let entered = false
      const enter = () => {
        if (!entered) {
          entered = true
          reset = resetAllStores()
        }
      }
      const stop =
        boundary === 'detach'
          ? diff.subscribe((state) => {
              if (state.detachedDiffs[id]) enter()
            })
          : boundary === 'graph-reset'
            ? useWorkflowStore.subscribe((state) => {
                if (state.currentWorkflowId === null) enter()
              })
            : useSubBlockStore.subscribe((state) => {
                if (!Object.keys(state.workflowValues).length) enter()
              })
      const initialScope = useWorkflowRegistry.getState().hydration
      try {
        useWorkflowRegistry.getState().switchToWorkspace('workspace-b')
      } finally {
        stop()
      }
      expect(entered).toBe(true)
      // The synchronous prefix must already revoke the superseded workspace operation.
      expect(useWorkflowRegistry.getState().hydration).toBe(initialScope)
      expect(diff.getState().detachedDiffs).toEqual({})
      await reset
      expect(useWorkflowRegistry.getState().hydration.workspaceId).toBeNull()
      expect(useWorkflowStore.getState().currentWorkflowId).toBeNull()
      expect(diff.getState().action).toBeNull()
      expect(diff.getState().hasActiveDiff).toBe(false)
    }
  )

  it('does not infer an owner when a caller has already lost its source identity', async () => {
    await diff.getState().showPersistedChanges(id)
    useWorkflowRegistry.setState({ activeWorkflowId: null })
    const before = diff.getState().action
    diff.getState().detachDiffForNavigation(null, 'workflow-b')
    expect(diff.getState().action).toBe(before)
    expect(diff.getState().detachedDiffs).toEqual({})
    expect(canApplyHydrationSnapshot('workflow-b', captureDraftVersions('workflow-b'))).toBe(false)
  })
})
