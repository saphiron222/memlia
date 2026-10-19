// Modified by Memlia: bind draft revision attestations to applied client snapshots.
/**
 * Focused tests for the registry store's `loadWorkflowState` after the
 * workflow-state cache collapse: it hydrates the shared
 * `workflowKeys.state(id)` entry via `fetchQuery` (always-fresh,
 * `staleTime: 0`) and projects the envelope into the workflow / sub-block /
 * variables / deployment stores, guarding against superseded responses.
 */
import { QueryClient } from '@tanstack/react-query'
import { afterAll, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'

const { sharedQueryClient } = vi.hoisted(() => ({
  sharedQueryClient: { current: null as unknown },
}))

const { replaceWorkflowState, initializeFromWorkflow, setVariablesState, clearError, queueState } =
  vi.hoisted(() => ({
    replaceWorkflowState: vi.fn(),
    initializeFromWorkflow: vi.fn(),
    setVariablesState: vi.fn(),
    clearError: vi.fn(),
    queueState: {
      hasPendingOperations: vi.fn(() => false),
      workflowOperationVersions: {} as Record<string, number>,
      remoteApplyVersions: {} as Record<string, number>,
    },
  }))

vi.mock('@/stores/workflows/workflow/store', () => ({
  useWorkflowStore: {
    getState: () => ({
      replaceWorkflowState,
      invalidateDraftRevisionAttestation: vi.fn(),
      blocks: {},
    }),
    setState: vi.fn(),
  },
}))

vi.mock('@/stores/workflows/subblock/store', () => ({
  useSubBlockStore: {
    getState: () => ({ initializeFromWorkflow }),
    setState: vi.fn(),
  },
}))

vi.mock('@/stores/variables/store', () => ({
  useVariablesStore: {
    getState: () => ({ variables: {} }),
    setState: (updater: unknown) => setVariablesState(updater),
  },
}))

vi.mock('@/stores/operation-queue/store', () => ({
  useOperationQueueStore: {
    getState: () => ({ clearError, ...queueState }),
  },
}))

vi.mock('@/hooks/queries/utils/invalidate-workflow-lists', () => ({
  invalidateWorkflowLists: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/stores/workflows/utils', () => ({
  getUniqueBlockName: vi.fn(),
  regenerateBlockIds: vi.fn(),
}))

vi.mock('@/lib/workflows/autolayout/constants', () => ({
  DEFAULT_DUPLICATE_OFFSET: { x: 0, y: 0 },
}))

vi.mock('@/hooks/queries/deployments', () => ({
  deploymentKeys: {
    infos: () => ['deployments', 'info'],
    info: (workflowId: string | null) => ['deployments', 'info', workflowId ?? ''],
  },
}))

import * as requestModule from '@/lib/api/client/request'
import * as getQueryClientModule from '@/app/_shell/providers/get-query-client'
import { useWorkflowDiffStore } from '@/stores/workflow-diff/store'
import { useWorkflowRegistry } from '@/stores/workflows/registry/store'
import { useSubBlockStore } from '@/stores/workflows/subblock/store'
import { useWorkflowStore } from '@/stores/workflows/workflow/store'

/**
 * Spy on the real module namespaces instead of vi.mock: under `isolate: false`
 * shared consumers (`@/hooks/queries/utils/fetch-workflow-envelope`, the
 * registry store) may be cached across test files, so patching the real
 * namespaces is the only wiring that composes — and vi.mock here would leak
 * this file's fixtures into later files that share those consumers.
 */
let mockRequestJson: MockInstance<typeof requestModule.requestJson>
let getQueryClientSpy: MockInstance<typeof getQueryClientModule.getQueryClient>
beforeEach(() => {
  mockRequestJson = vi.spyOn(requestModule, 'requestJson')
  getQueryClientSpy = vi
    .spyOn(getQueryClientModule, 'getQueryClient')
    .mockImplementation(() => sharedQueryClient.current as QueryClient)
})

afterAll(() => {
  mockRequestJson.mockRestore()
  getQueryClientSpy.mockRestore()
})

function makeEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wf-1',
    draftRevision: 7,
    isDeployed: true,
    deployedAt: new Date('2026-01-01T00:00:00.000Z'),
    isPublicApi: false,
    state: {
      blocks: { b1: { id: 'b1' } },
      edges: [],
      loops: {},
      parallels: {},
    },
    variables: { v1: { id: 'v1', workflowId: 'wf-1', name: 'x' } },
    ...overrides,
  }
}

describe('registry store loadWorkflowState (collapsed cache)', () => {
  beforeEach(() => {
    queueState.hasPendingOperations.mockReturnValue(false)
    queueState.workflowOperationVersions = {}
    queueState.remoteApplyVersions = {}
    getQueryClientSpy.mockImplementation(() => sharedQueryClient.current as QueryClient)
    // The store dispatches an `active-workflow-changed` CustomEvent on the
    // window; provide a minimal stub under the node environment.
    vi.stubGlobal('window', { dispatchEvent: vi.fn() })
    sharedQueryClient.current = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    // Reset store to a clean state with a workspace scope so loadWorkflowState
    // does not bail on the missing-workspace guard.
    useWorkflowRegistry.setState({
      activeWorkflowId: null,
      error: null,
      hydration: {
        phase: 'idle',
        workspaceId: 'ws-1',
        workflowId: null,
        requestId: null,
        error: null,
      },
    })
  })

  it('keeps the local graph and operations when an edit is queued while hydration fetches', async () => {
    mockRequestJson.mockImplementationOnce(async () => {
      queueState.hasPendingOperations.mockReturnValue(true)
      queueState.workflowOperationVersions['wf-1'] = 1
      return { data: makeEnvelope() }
    })
    await useWorkflowRegistry.getState().loadWorkflowState('wf-1')
    expect(replaceWorkflowState).not.toHaveBeenCalled()
    expect(initializeFromWorkflow).not.toHaveBeenCalled()
    expect(useWorkflowRegistry.getState().hydration.phase).not.toBe('ready')
  })

  it('preserves the cached in-flight deployment attempt across envelope hydration', async () => {
    const client = sharedQueryClient.current as QueryClient
    const preparingAttempt = {
      id: 'op-1',
      deploymentVersionId: 'dv-1',
      version: 2,
      action: 'deploy',
      status: 'preparing',
      readiness: { webhooks: 'pending', schedules: 'pending', mcp: 'pending' },
      requestedAt: '2026-07-14T00:00:00.000Z',
      activatedAt: null,
      error: null,
    }
    client.setQueryData(['deployments', 'info', 'wf-1'], {
      isDeployed: false,
      deployedAt: null,
      apiKey: 'Workspace API keys',
      needsRedeployment: true,
      isPublicApi: false,
      warnings: ['Deployment preparation is queued'],
      activeDeployment: null,
      latestDeploymentAttempt: preparingAttempt,
    })
    mockRequestJson.mockResolvedValue({ data: makeEnvelope({ isDeployed: false }) })

    await useWorkflowRegistry.getState().loadWorkflowState('wf-1')

    const deploymentInfo = client.getQueryData(['deployments', 'info', 'wf-1'])
    expect(deploymentInfo).toMatchObject({
      isDeployed: false,
      apiKey: 'Workspace API keys',
      needsRedeployment: true,
      warnings: ['Deployment preparation is queued'],
      latestDeploymentAttempt: { id: 'op-1', status: 'preparing' },
    })
  })

  it('discards a superseded response via the staleness guard', async () => {
    // First load (wf-1) is in-flight; a second load (wf-2) supersedes the
    // hydration workflowId, then wf-1 finally resolves. The guard compares the
    // current hydration workflowId/requestId against the resolving request and
    // must discard the now-stale wf-1 projection.
    let resolveFirst: (value: unknown) => void = () => {}
    const firstPending = new Promise((resolve) => {
      resolveFirst = resolve
    })

    mockRequestJson
      .mockImplementationOnce(() => firstPending)
      .mockImplementationOnce(() =>
        Promise.resolve({ data: makeEnvelope({ id: 'wf-2', draftRevision: 22 }) })
      )

    const firstLoad = useWorkflowRegistry.getState().loadWorkflowState('wf-1')
    const secondLoad = useWorkflowRegistry.getState().loadWorkflowState('wf-2')
    await secondLoad

    expect(useWorkflowRegistry.getState().activeWorkflowId).toBe('wf-2')
    expect(replaceWorkflowState).toHaveBeenLastCalledWith(
      expect.objectContaining({ currentWorkflowId: 'wf-2' }),
      {
        draftRevisionAttestation: {
          workflowId: 'wf-2',
          revision: 22,
          versions: { localOperation: 0, remoteApply: 0, remoteUpdate: 0 },
        },
      }
    )
    const projectionsAfterSecond = replaceWorkflowState.mock.calls.length

    resolveFirst({ data: makeEnvelope({ id: 'wf-1' }) })
    await firstLoad

    // The stale wf-1 result must not project again — hydration is now wf-2.
    expect(replaceWorkflowState.mock.calls.length).toBe(projectionsAfterSecond)
    expect(useWorkflowRegistry.getState().activeWorkflowId).toBe('wf-2')
  })

  it('does not show a stale load error after switching to another workflow', async () => {
    let rejectFirst: (reason: Error) => void = () => {}
    const firstPending = new Promise<never>((_resolve, reject) => {
      rejectFirst = reject
    })
    mockRequestJson
      .mockImplementationOnce(() => firstPending)
      .mockResolvedValueOnce({ data: makeEnvelope({ id: 'wf-2', draftRevision: 22 }) })

    const firstLoad = useWorkflowRegistry.getState().setActiveWorkflow('wf-1')
    await useWorkflowRegistry.getState().setActiveWorkflow('wf-2')
    rejectFirst(new Error('Previous workflow failed to load'))
    await firstLoad

    expect(useWorkflowRegistry.getState().activeWorkflowId).toBe('wf-2')
    expect(useWorkflowRegistry.getState().hydration).toMatchObject({
      phase: 'ready',
      workflowId: 'wf-2',
      error: null,
    })
  })
})

describe('workspace transition ownership', () => {
  it('captures the real workflow identity and refuses a revoked detach before resetting stores', () => {
    useWorkflowRegistry.setState({ activeWorkflowId: 'source-workflow' })
    const before = useWorkflowRegistry.getState()
    const resetCalls = vi.mocked(useWorkflowStore.setState).mock.calls.length
    const detach = vi
      .spyOn(useWorkflowDiffStore.getState(), 'detachDiffForWorkspaceChange')
      .mockReturnValue(() => false)
    try {
      useWorkflowRegistry.getState().switchToWorkspace('destination-workspace')
      expect(detach).toHaveBeenCalledWith('source-workflow', 'destination-workspace')
      expect(vi.mocked(useWorkflowStore.setState).mock.calls.length).toBe(resetCalls)
      expect(useWorkflowRegistry.getState()).toBe(before)
    } finally {
      detach.mockRestore()
    }
  })
})

it('stops a workspace reset if the registry source changes without a new diff epoch', () => {
  useWorkflowRegistry.setState({ activeWorkflowId: 'source-workflow' })
  const beforeSubblockCalls = vi.mocked(useSubBlockStore.setState).mock.calls.length
  const detach = vi
    .spyOn(useWorkflowDiffStore.getState(), 'detachDiffForWorkspaceChange')
    .mockReturnValue(() => true)
  vi.mocked(useWorkflowStore.setState).mockImplementationOnce(() => {
    useWorkflowRegistry.setState({ activeWorkflowId: 'newer-workflow' })
  })
  try {
    useWorkflowRegistry.getState().switchToWorkspace('stale-workspace')
    expect(useWorkflowRegistry.getState().activeWorkflowId).toBe('newer-workflow')
    expect(useWorkflowRegistry.getState().hydration.workspaceId).not.toBe('stale-workspace')
    expect(vi.mocked(useSubBlockStore.setState).mock.calls.length).toBe(beforeSubblockCalls)
  } finally {
    detach.mockRestore()
  }
})
