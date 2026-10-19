// Modified by Memlia: invalidate draft attestations before identity reset.
import { terminalConsoleMockFns } from '@sim/testing'
import { QueryClient } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'

const {
  mockGetQueryClient,
  mockMothershipQueueReset,
  mockMothershipDraftsReset,
  mockResetRegisteredUserData,
  mockSubBlockSetState,
} = vi.hoisted(() => ({
  mockGetQueryClient: vi.fn(),
  mockMothershipQueueReset: vi.fn(),
  mockMothershipDraftsReset: vi.fn(),
  mockResetRegisteredUserData: vi.fn(),
  mockSubBlockSetState: vi.fn(),
}))

vi.mock('@/app/_shell/providers/get-query-client', () => ({
  getQueryClient: mockGetQueryClient,
}))
vi.mock('@/stores/user-data-reset-registry', () => ({
  resetRegisteredUserData: mockResetRegisteredUserData,
}))
vi.mock('@/stores/execution', () => ({
  useExecutionStore: { getState: () => ({ reset: vi.fn() }) },
}))
vi.mock('@/stores/mothership-drafts/store', () => ({
  useMothershipDraftsStore: { getState: () => ({ reset: mockMothershipDraftsReset }) },
}))
vi.mock('@/stores/mothership-queue/store', () => ({
  useMothershipQueueStore: { getState: () => ({ reset: mockMothershipQueueReset }) },
}))
vi.mock('@/stores/workflows/subblock/store', () => ({
  useSubBlockStore: { setState: mockSubBlockSetState },
}))

import { useOperationQueueStore } from '@/stores/operation-queue/store'
import { resetAllStores } from '@/stores/reset-all-stores'
import { useWorkflowDiffStore } from '@/stores/workflow-diff/store'
import { useWorkflowRegistry } from '@/stores/workflows/registry/store'
import { getAttestedDraftRevision } from '@/stores/workflows/sync-local-draft'
import { useWorkflowStore } from '@/stores/workflows/workflow/store'

const {
  mockClearAllExecutionPointers,
  mockWaitForConsoleHydration,
  mockConsolePersistence: { persist: mockConsolePersist, reset: mockConsoleReset },
} = terminalConsoleMockFns

const nativeQueueReset = useOperationQueueStore.getState().reset

describe('resetAllStores', () => {
  let queryClient: QueryClient
  let mockRegistrySetState: MockInstance
  let mockWorkflowSetState: MockInstance
  let mockOperationQueueReset: MockInstance

  beforeEach(() => {
    vi.restoreAllMocks()
    useWorkflowStore.getState().invalidateDraftRevisionAttestation()
    useOperationQueueStore.setState({ reset: nativeQueueReset })
    useOperationQueueStore.getState().reset()
    useWorkflowRegistry.setState({ activeWorkflowId: null })
    useWorkflowDiffStore.setState({
      hasActiveDiff: false,
      pendingExternalUpdates: {},
      reconcilingWorkflows: {},
      reconciliationErrors: {},
      remoteUpdateVersions: {},
    })
    mockRegistrySetState = vi.spyOn(useWorkflowRegistry, 'setState')
    mockWorkflowSetState = vi.spyOn(useWorkflowStore, 'setState')
    mockOperationQueueReset = vi.spyOn(useOperationQueueStore.getState(), 'reset')
    queryClient = new QueryClient()
    mockGetQueryClient.mockReturnValue(queryClient)
    mockConsolePersist.mockResolvedValue(undefined)
    mockWaitForConsoleHydration.mockResolvedValue(undefined)
  })

  it('does not revive an obsolete revision while identity reset awaits hydration', async () => {
    useWorkflowRegistry.setState({ activeWorkflowId: 'fixture-workflow' })
    useWorkflowStore.getState().replaceWorkflowState(
      { currentWorkflowId: 'fixture-workflow', blocks: {}, edges: [], loops: {}, parallels: {} },
      {
        draftRevisionAttestation: {
          workflowId: 'fixture-workflow',
          revision: 7,
          versions: { localOperation: 0, remoteApply: 0, remoteUpdate: 0 },
        },
      }
    )
    expect(getAttestedDraftRevision('fixture-workflow')).toBe(7)
    useOperationQueueStore.getState().addToQueue({
      id: 'fixture-op',
      workflowId: 'fixture-workflow',
      userId: 'fixture-reader',
      operation: {
        target: 'block',
        operation: 'update-name',
        payload: { id: 'b', name: 'local' },
      },
    })
    expect(getAttestedDraftRevision('fixture-workflow')).toBeNull()
    let finishHydration!: () => void
    mockWaitForConsoleHydration.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishHydration = resolve
      })
    )
    const resetPromise = resetAllStores()
    try {
      expect(useOperationQueueStore.getState().workflowOperationVersions).toEqual({})
      expect(useWorkflowStore.getState().currentWorkflowId).toBe('fixture-workflow')
      expect(getAttestedDraftRevision('fixture-workflow')).toBeNull()
      expect(useWorkflowStore.getState().draftRevisionAttestation).toBeNull()
    } finally {
      finishHydration()
      await resetPromise
    }
    expect(useWorkflowStore.getState().currentWorkflowId).toBeNull()
    expect(getAttestedDraftRevision('fixture-workflow')).toBeNull()
  })

  it('clears every cached server-state entry at the identity boundary', async () => {
    queryClient.setQueryData(['generalSettings', 'settings'], { theme: 'dark' })
    queryClient.setQueryData(['apiKeys', 'personal'], [{ id: 'key-a' }])
    queryClient.setQueryData(['workflowMcpServers', 'detail', 'workspace-a', 'server-a'], {
      id: 'server-a',
    })

    await resetAllStores()

    expect(queryClient.getQueryCache().getAll()).toHaveLength(0)
  })

  it('removes transient workflow state and replaces persisted console data', async () => {
    await resetAllStores()

    expect(mockRegistrySetState).toHaveBeenCalledWith(
      expect.objectContaining({ clipboard: null, pendingSelection: null })
    )
    expect(mockWorkflowSetState).toHaveBeenCalledWith(
      expect.objectContaining({ currentWorkflowId: null, blocks: {}, edges: [] })
    )
    expect(mockSubBlockSetState).toHaveBeenCalledWith({ workflowValues: {} })
    expect(mockOperationQueueReset).toHaveBeenCalledOnce()
    expect(mockResetRegisteredUserData).toHaveBeenCalledOnce()
    expect(mockConsoleReset).toHaveBeenCalledOnce()
    expect(mockClearAllExecutionPointers).toHaveBeenCalledOnce()
    expect(mockMothershipQueueReset).toHaveBeenCalledOnce()
    expect(mockMothershipDraftsReset).toHaveBeenCalledOnce()
    expect(mockConsolePersist).toHaveBeenCalledWith({ merge: false })
  })

  it('waits for an in-flight console hydration before clearing identity state', async () => {
    let finishHydration: (() => void) | undefined
    mockWaitForConsoleHydration.mockReturnValue(
      new Promise<void>((resolve) => {
        finishHydration = resolve
      })
    )

    const resetPromise = resetAllStores()
    expect(mockOperationQueueReset).toHaveBeenCalledOnce()
    expect(mockResetRegisteredUserData).toHaveBeenCalledOnce()
    await Promise.resolve()
    expect(mockRegistrySetState).not.toHaveBeenCalled()

    finishHydration?.()
    await resetPromise
    expect(mockRegistrySetState).toHaveBeenCalledOnce()
  })
})
