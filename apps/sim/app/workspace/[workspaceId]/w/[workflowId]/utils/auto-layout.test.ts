// Copyright 2026 Memlia. All rights reserved.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '@/lib/api/client/errors'
import {
  putWorkflowNormalizedStateContract,
  workflowAutoLayoutContract,
} from '@/lib/api/contracts/workflows'
import { useOperationQueueStore } from '@/stores/operation-queue/store'
import { useVariablesStore } from '@/stores/variables/store'
import { useWorkflowDiffStore } from '@/stores/workflow-diff/store'
import { useWorkflowRegistry } from '@/stores/workflows/registry/store'
import { useSubBlockStore } from '@/stores/workflows/subblock/store'
import { getAttestedDraftRevision } from '@/stores/workflows/sync-local-draft'
import { useWorkflowStore } from '@/stores/workflows/workflow/store'
import { applyAutoLayoutAndUpdateStore } from './auto-layout'

const http = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('@/lib/api/client/request', () => ({ requestJson: http.request }))
const id = 'workflow-a'
const block = () => ({
  id: 'b',
  type: 'function',
  name: 'Function',
  position: { x: 0, y: 0 },
  subBlocks: { code: { id: 'code', type: 'code' as const, value: 'original' } },
  outputs: {},
  enabled: true,
})
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function layout() {
  return { data: { layoutedBlocks: { b: { ...block(), position: { x: 100, y: 200 } } } } }
}
function edit() {
  useOperationQueueStore.getState().markRemoteApplied(id)
  useWorkflowStore.getState().updateBlockName('b', 'Human')
}
beforeEach(() => {
  http.request.mockReset()
  useOperationQueueStore.getState().reset()
  useWorkflowRegistry.setState({ activeWorkflowId: id })
  useWorkflowDiffStore.setState({
    hasActiveDiff: false,
    pendingExternalUpdates: {},
    reconcilingWorkflows: {},
    reconciliationErrors: {},
    remoteUpdateVersions: {},
  })
  useVariablesStore.setState({
    variables: { v: { id: 'v', workflowId: id, name: 'threshold', type: 'number', value: 3 } },
  })
  useWorkflowStore.getState().replaceWorkflowState(
    { currentWorkflowId: id, blocks: { b: block() }, edges: [], loops: {}, parallels: {} },
    {
      draftRevisionAttestation: {
        workflowId: id,
        revision: 7,
        versions: { localOperation: 0, remoteApply: 0, remoteUpdate: 0 },
      },
    }
  )
  useSubBlockStore.getState().initializeFromWorkflow(id, { b: block() })
  http.request
    .mockResolvedValueOnce(layout())
    .mockResolvedValue({ success: true, warnings: [], baseRevision: 7, draftRevision: 8 })
})
describe('attested auto-layout with real stores and controlled HTTP', () => {
  it('serializes the captured revision through the native JSON client and validates both responses', async () => {
    const native = await vi.importActual<typeof import('@/lib/api/client/request')>(
      '@/lib/api/client/request'
    )
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(
      Response.json({
        success: true,
        message: 'Layout computed',
        data: { ...layout().data, blockCount: 1, elapsed: '1ms' },
      })
    )
    fetchMock.mockResolvedValueOnce(
      Response.json({ success: true, warnings: [], baseRevision: 7, draftRevision: 8 })
    )
    http.request.mockReset().mockImplementation(native.requestJson)
    try {
      expect((await applyAutoLayoutAndUpdateStore(id)).success).toBe(true)
      expect(fetchMock).toHaveBeenCalledTimes(2)
      const request = fetchMock.mock.calls[1][1]
      expect(request?.method).toBe('PUT')
      expect(JSON.parse(request?.body as string)).toMatchObject({
        expectedRevision: 7,
        variables: { v: { value: 3 } },
      })
      expect(getAttestedDraftRevision(id)).toBeNull()
    } finally {
      fetchMock.mockRestore()
    }
  })
  it('refuses absent attestation without computing or sending a legacy PUT', async () => {
    useWorkflowStore.getState().invalidateDraftRevisionAttestation()
    expect((await applyAutoLayoutAndUpdateStore(id)).success).toBe(false)
    expect(http.request).not.toHaveBeenCalled()
  })
  it('saves captured graph values and variables at R7 before changing local state, without attesting the receipt', async () => {
    const save = deferred<unknown>()
    http.request.mockReset().mockResolvedValueOnce(layout()).mockReturnValueOnce(save.promise)
    const result = applyAutoLayoutAndUpdateStore(id)
    await vi.waitFor(() => expect(http.request).toHaveBeenCalledTimes(2))
    expect(http.request.mock.calls[0][0]).toBe(workflowAutoLayoutContract)
    expect(http.request.mock.calls[1][0]).toBe(putWorkflowNormalizedStateContract)
    expect(http.request.mock.calls[1][1].body).toMatchObject({
      expectedRevision: 7,
      variables: { v: { value: 3 } },
      blocks: { b: { subBlocks: { code: { value: 'original' } } } },
    })
    expect(useWorkflowStore.getState().blocks.b.position).toEqual({ x: 0, y: 0 })
    save.resolve({ success: true, warnings: [], baseRevision: 7, draftRevision: 8 })
    expect((await result).success).toBe(true)
    expect(useWorkflowStore.getState().blocks.b.position).toEqual({ x: 100, y: 200 })
    expect(getAttestedDraftRevision(id)).toBeNull()
  })
  it.each(['edit', 'navigation', 'variables', 'subblocks'])(
    'refuses a stale layout after %s during calculation without PUT',
    async (change) => {
      const compute = deferred<unknown>()
      http.request.mockReset().mockReturnValueOnce(compute.promise)
      const result = applyAutoLayoutAndUpdateStore(id)
      if (change === 'edit') edit()
      if (change === 'navigation') useWorkflowRegistry.setState({ activeWorkflowId: 'workflow-b' })
      if (change === 'variables') useVariablesStore.getState().updateVariable('v', { value: 4 })
      if (change === 'subblocks') useSubBlockStore.getState().setValue('b', 'code', 'human')
      compute.resolve(layout())
      expect((await result).success).toBe(false)
      expect(http.request).toHaveBeenCalledTimes(1)
      expect(useWorkflowStore.getState().blocks.b.position).toEqual({ x: 0, y: 0 })
    }
  )
  it('preserves a human edit during PUT success and never applies the late layout', async () => {
    const save = deferred<unknown>()
    http.request.mockReset().mockResolvedValueOnce(layout()).mockReturnValueOnce(save.promise)
    const result = applyAutoLayoutAndUpdateStore(id)
    await vi.waitFor(() => expect(http.request).toHaveBeenCalledTimes(2))
    edit()
    save.resolve({ success: true, warnings: [], baseRevision: 7, draftRevision: 8 })
    expect((await result).success).toBe(false)
    expect(useWorkflowStore.getState().blocks.b.name).toBe('Human')
    expect(useWorkflowStore.getState().blocks.b.position).toEqual({ x: 0, y: 0 })
  })
  it('owns the computed layout before awaiting persistence', async () => {
    const computed = layout()
    const save = deferred<unknown>()
    http.request.mockReset().mockResolvedValueOnce(computed).mockReturnValueOnce(save.promise)
    const result = applyAutoLayoutAndUpdateStore(id)
    await vi.waitFor(() => expect(http.request).toHaveBeenCalledTimes(2))
    computed.data.layoutedBlocks.b.position.x = 999
    save.resolve({ success: true, warnings: [], baseRevision: 7, draftRevision: 8 })
    expect((await result).success).toBe(true)
    expect(useWorkflowStore.getState().blocks.b.position).toEqual({ x: 100, y: 200 })
  })
  it('invalidates stale revision after409 while preserving graph and variables without retry', async () => {
    const before = structuredClone(useWorkflowStore.getState().getWorkflowState())
    const variables = structuredClone(useVariablesStore.getState().variables)
    http.request
      .mockReset()
      .mockResolvedValueOnce(layout())
      .mockRejectedValueOnce(
        new ApiClientError({ status: 409, message: 'stale', body: { error: 'stale' } })
      )
    expect((await applyAutoLayoutAndUpdateStore(id)).success).toBe(false)
    expect(useWorkflowStore.getState().getWorkflowState()).toEqual(before)
    expect(useVariablesStore.getState().variables).toEqual(variables)
    expect(getAttestedDraftRevision(id)).toBeNull()
    expect(http.request).toHaveBeenCalledTimes(2)
  })
  it('does not roll back human edits or retry with a new revision after409', async () => {
    const save = deferred<unknown>()
    http.request.mockReset().mockResolvedValueOnce(layout()).mockReturnValueOnce(save.promise)
    const result = applyAutoLayoutAndUpdateStore(id)
    await vi.waitFor(() => expect(http.request).toHaveBeenCalledTimes(2))
    edit()
    save.reject(new ApiClientError({ status: 409, message: 'stale', body: { error: 'stale' } }))
    const response = await result
    expect(response.success).toBe(false)
    expect(response.error).toMatch(/changed|sync|refresh/i)
    expect(useWorkflowStore.getState().blocks.b.name).toBe('Human')
    expect(useWorkflowStore.getState().blocks.b.position).toEqual({ x: 0, y: 0 })
    expect(http.request).toHaveBeenCalledTimes(2)
  })
})
