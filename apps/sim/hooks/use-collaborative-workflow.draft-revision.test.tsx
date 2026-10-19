/** @vitest-environment jsdom */
// Copyright 2026 Memlia. All rights reserved.

import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useOperationQueueStore } from '@/stores/operation-queue/store'
import { useVariablesStore } from '@/stores/variables/store'
import { useWorkflowDiffStore } from '@/stores/workflow-diff/store'
import { useWorkflowRegistry } from '@/stores/workflows/registry/store'
import { useSubBlockStore } from '@/stores/workflows/subblock/store'
import { getAttestedDraftRevision } from '@/stores/workflows/sync-local-draft'
import { useWorkflowStore } from '@/stores/workflows/workflow/store'
import { useCollaborativeWorkflow } from './use-collaborative-workflow'

const transport = vi.hoisted(() => {
  const handlers: Record<string, (data: any) => void> = {}
  const socket = {
    isConnected: false,
    currentWorkflowId: 'workflow-a',
    emitWorkflowOperation: vi.fn(),
    emitSubblockUpdate: vi.fn(),
    emitVariableUpdate: vi.fn(),
    ...Object.fromEntries(
      [
        'WorkflowOperation',
        'SubblockUpdate',
        'VariableUpdate',
        'WorkflowDeleted',
        'AccessRevoked',
        'WorkflowReverted',
        'WorkflowUpdated',
        'WorkflowDeployed',
        'OperationConfirmed',
        'OperationFailed',
      ].map((name) => [
        `on${name}`,
        (handler: (data: any) => void) => {
          handlers[name] = handler
        },
      ])
    ),
  }
  return { handlers, socket }
})
vi.mock('@/app/workspace/providers/socket-provider', () => ({ useSocket: () => transport.socket }))
vi.mock('@/lib/auth/client', () => ({
  useSession: () => ({ data: { user: { id: 'fixture-reader' } } }),
}))
vi.mock('@/hooks/use-undo-redo', () => ({
  useUndoRedo: () => ({ recordBatchUpdateParent: vi.fn(), recordBatchUpdateSubblocks: vi.fn() }),
}))
vi.mock('@sim/emcn', () => ({ toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }))

// Real hook, Zustand workflow/subblock/queue stores; network, session and undo UI are doubles.
let root: Root | undefined
let api: ReturnType<typeof useCollaborativeWorkflow>
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  function Probe() {
    api = useCollaborativeWorkflow()
    return null
  }
  act(() =>
    root!.render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>
    )
  )
}

function seed() {
  useVariablesStore.setState({ variables: {} })
  useWorkflowRegistry.setState({ activeWorkflowId: 'workflow-a' })
  useOperationQueueStore.setState({
    operations: [],
    workflowOperationVersions: {},
    remoteApplyVersions: {},
    isProcessing: false,
  })
  useWorkflowDiffStore.setState({
    hasActiveDiff: false,
    isShowingDiff: false,
    pendingExternalUpdates: {},
    reconcilingWorkflows: {},
    reconciliationErrors: {},
    remoteUpdateVersions: {},
  })
  const blocks = {
    b: {
      id: 'b',
      type: 'function',
      name: 'Function',
      position: { x: 0, y: 0 },
      subBlocks: {
        code: { id: 'code', type: 'code' as const, value: 'original' },
        other: { id: 'other', type: 'short-input' as const, value: 'original' },
      },
      outputs: {},
      enabled: true,
    },
  }
  useWorkflowStore.getState().replaceWorkflowState(
    { currentWorkflowId: 'workflow-a', blocks, edges: [], loops: {}, parallels: {} },
    {
      draftRevisionAttestation: {
        workflowId: 'workflow-a',
        revision: 7,
        versions: { localOperation: 0, remoteApply: 0, remoteUpdate: 0 },
      },
    }
  )
  useSubBlockStore.getState().initializeFromWorkflow('workflow-a', blocks)
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  seed()
})
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('revision attestation before remote application', () => {
  it('invalidates before a partially applied batch throws, even though remoteApply cannot advance', () => {
    mount()
    const original = useSubBlockStore.getState().setValue
    vi.spyOn(useSubBlockStore.getState(), 'setValue').mockImplementation(
      (blockId, subblockId, value) => {
        if (subblockId === 'other') throw new Error('Controlled second write failure')
        return original(blockId, subblockId, value)
      }
    )
    act(() =>
      transport.handlers.WorkflowOperation({
        operation: 'subblock-batch-update',
        target: 'subblock',
        userId: 'remote-fixture',
        metadata: { workflowId: 'workflow-a' },
        payload: {
          updates: [
            { blockId: 'b', subblockId: 'code', value: 'remote-value' },
            { blockId: 'b', subblockId: 'other', value: 'rejected-value' },
          ],
        },
      })
    )
    expect(useSubBlockStore.getState().workflowValues['workflow-a'].b.code).toBe('remote-value')
    expect(useSubBlockStore.getState().workflowValues['workflow-a'].b.other).toBe('original')
    expect(useOperationQueueStore.getState().remoteApplyVersions['workflow-a'] ?? 0).toBe(0)
    expect(useWorkflowStore.getState().draftRevisionAttestation).toBeNull()
  })
  it('keeps native queued work and does not rehabilitate its old revision after an unversioned ACK', () => {
    mount()
    expect(getAttestedDraftRevision('workflow-a')).toBe(7)
    act(() =>
      useOperationQueueStore.getState().addToQueue({
        id: 'pending-fixture',
        workflowId: 'workflow-a',
        userId: 'fixture-reader',
        operation: {
          target: 'block',
          operation: 'update-name',
          payload: { id: 'b', name: 'Local name' },
        },
      })
    )
    expect(useOperationQueueStore.getState().operations).toMatchObject([
      { id: 'pending-fixture', status: 'pending' },
    ])
    expect(getAttestedDraftRevision('workflow-a')).toBeNull()
    act(() =>
      transport.handlers.OperationConfirmed({ operationId: 'pending-fixture', serverTimestamp: 1 })
    )
    expect(useOperationQueueStore.getState().operations).toEqual([])
    expect(useOperationQueueStore.getState().workflowOperationVersions['workflow-a']).toBe(1)
    expect(getAttestedDraftRevision('workflow-a')).toBeNull()
  })
  it.each([
    [
      'variable',
      () =>
        api.collaborativeAddVariable({
          name: 'fixture',
          type: 'string',
          value: 'local',
          workflowId: 'workflow-a',
        }),
    ],
    [
      'parent',
      () =>
        api.collaborativeBatchUpdateParent([
          { blockId: 'b', newParentId: null, newPosition: { x: 9, y: 9 }, affectedEdges: [] },
        ]),
    ],
    ['canonical mode', () => api.collaborativeSetBlockCanonicalMode('b', 'fixture', 'advanced')],
    ['subblock', () => api.collaborativeSetSubblockValue('b', 'code', 'local')],
    [
      'subblock and modes',
      () =>
        api.collaborativeSetSubblockValueWithCanonicalModes('b', 'code', 'local', {
          fixture: 'advanced',
        }),
    ],
    [
      'subblock batch',
      () =>
        api.collaborativeBatchSetSubblockValues([
          { blockId: 'b', subblockId: 'code', value: 'local' },
        ]),
    ],
    ['tag', () => api.collaborativeSetTagSelection('b', 'code', 'local')],
  ] as const)(
    'invalidates before synchronous subscribers observe a local %s change preceding queueing',
    (_name, apply) => {
      mount()
      const observed: Array<{ revision: number | null; localVersion: number }> = []
      const observe = () =>
        observed.push({
          revision: getAttestedDraftRevision('workflow-a'),
          localVersion:
            useOperationQueueStore.getState().workflowOperationVersions['workflow-a'] ?? 0,
        })
      const unsubscribes = [
        useVariablesStore.subscribe((state, previous) => {
          if (state.variables !== previous.variables) observe()
        }),
        useWorkflowStore.subscribe((state, previous) => {
          if (state.blocks !== previous.blocks) observe()
        }),
        useSubBlockStore.subscribe((state, previous) => {
          if (state.workflowValues !== previous.workflowValues) observe()
        }),
      ]
      try {
        expect(getAttestedDraftRevision('workflow-a')).toBe(7)
        act(apply)
        expect(observed.length).toBeGreaterThan(0)
        expect(observed[0].localVersion).toBe(0)
        expect(observed.every(({ revision }) => revision === null)).toBe(true)
        expect(useOperationQueueStore.getState().operations.length).toBeGreaterThan(0)
        expect(getAttestedDraftRevision('workflow-a')).toBeNull()
      } finally {
        unsubscribes.forEach((unsubscribe) => unsubscribe())
      }
    }
  )
  it('does not revive a local variable revision after queueing is refused by the native baseline guard', () => {
    useWorkflowDiffStore.setState({ hasActiveDiff: true, isShowingDiff: false })
    mount()
    let id = ''
    act(() => {
      id = api.collaborativeAddVariable({
        name: 'fixture',
        type: 'string',
        value: 'local',
        workflowId: 'workflow-a',
      })
    })
    expect(useVariablesStore.getState().variables[id].value).toBe('local')
    expect(useOperationQueueStore.getState().operations).toEqual([])
    expect(useOperationQueueStore.getState().workflowOperationVersions['workflow-a'] ?? 0).toBe(0)
    act(() => useWorkflowDiffStore.setState({ hasActiveDiff: false }))
    expect(getAttestedDraftRevision('workflow-a')).toBeNull()
    expect(useWorkflowStore.getState().draftRevisionAttestation).toBeNull()
  })
  it('loads the real socket provider with the native sync dependency graph', async () => {
    const provider = await vi.importActual<
      typeof import('@/app/workspace/providers/socket-provider')
    >('@/app/workspace/providers/socket-provider')
    expect(provider.SocketProvider).toBeTypeOf('function')
  })
  it('does not invalidate an unrelated workflow or a position frame not applied by this handler', () => {
    mount()
    act(() =>
      transport.handlers.WorkflowOperation({
        operation: 'subblock-batch-update',
        target: 'subblock',
        metadata: { workflowId: 'workflow-b' },
        payload: { updates: [] },
      })
    )
    act(() =>
      transport.handlers.WorkflowOperation({
        operation: 'update-position',
        target: 'block',
        metadata: { workflowId: 'workflow-a' },
        payload: { id: 'b', position: { x: 9, y: 9 } },
      })
    )
    expect(useWorkflowStore.getState().blocks.b.position).toEqual({ x: 0, y: 0 })
    expect(useWorkflowStore.getState().draftRevisionAttestation?.revision).toBe(7)
  })
})
