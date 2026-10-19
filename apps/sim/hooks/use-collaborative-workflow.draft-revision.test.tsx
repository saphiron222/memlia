/** @vitest-environment jsdom */
// Copyright 2026 Memlia. All rights reserved.

import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerEmitFunctions, useOperationQueueStore } from '@/stores/operation-queue/store'
import { resetAllStores } from '@/stores/reset-all-stores'
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
  return { handlers, socket, subject: 'fixture-reader' }
})
vi.mock('@/app/workspace/providers/socket-provider', () => ({ useSocket: () => transport.socket }))
vi.mock('@/lib/auth/client', () => ({
  useSession: () => ({ data: { user: { id: transport.subject } } }),
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
  useOperationQueueStore.getState().reset()
  transport.subject = 'fixture-reader'
  seed()
})
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  useOperationQueueStore.getState().reset()
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

describe('legacy full replacement refusal', () => {
  function inheritedReplacement() {
    useOperationQueueStore.setState({
      operations: [
        {
          id: 'legacy',
          workflowId: 'workflow-a',
          userId: 'fixture-reader',
          timestamp: 1,
          retryCount: 2,
          status: 'processing',
          operation: {
            operation: 'replace-state',
            target: 'workflow',
            payload: { state: { blocks: {}, edges: [] } },
          },
        },
      ],
      isProcessing: true,
      hasOperationError: false,
    })
  }
  it.each([undefined, 'WORKFLOW_REPLACE_REQUIRES_CAS'])(
    'retains correlated intent with code %s and shows only a fixed workflow error',
    (code) => {
      mount()
      inheritedReplacement()
      act(() =>
        transport.handlers.OperationFailed({
          operationId: 'legacy',
          error: 'PRIVATE CANARY',
          retryable: false,
          code,
        })
      )
      expect(useOperationQueueStore.getState().operations).toMatchObject([
        {
          id: 'legacy',
          retryCount: 2,
          status: 'failed',
          failureCode: 'WORKFLOW_REPLACE_REQUIRES_CAS',
        },
      ])
      expect(useOperationQueueStore.getState().hasOperationError).toBe(false)
      expect(useWorkflowDiffStore.getState().reconciliationErrors['workflow-a']).toBe(
        'Workflow replacement requires revision-checked persistence.'
      )
      act(() => transport.handlers.OperationConfirmed({ operationId: 'legacy' }))
      expect(useOperationQueueStore.getState().operations).toHaveLength(1)
    }
  )
  it('ignores an uncorrelated coded refusal', () => {
    mount()
    inheritedReplacement()
    const original = useOperationQueueStore.getState().operations
    act(() =>
      transport.handlers.OperationFailed({
        operationId: 'foreign',
        retryable: false,
        code: 'WORKFLOW_REPLACE_REQUIRES_CAS',
      })
    )
    expect(useOperationQueueStore.getState().operations).toBe(original)
    expect(useWorkflowDiffStore.getState().reconciliationErrors).toEqual({})
  })
  it.each([undefined, 'workflow-b', 'workflow-a'])(
    'never applies a legacy broadcast payload with workflow %s',
    async (workflowId) => {
      mount()
      inheritedReplacement()
      const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No fetch expected'))
      const before = useWorkflowStore.getState().blocks
      await act(async () =>
        transport.handlers.WorkflowOperation({
          operation: 'replace-state',
          target: 'workflow',
          metadata: workflowId ? { workflowId } : undefined,
          payload: { state: { blocks: {}, edges: [], loops: {}, parallels: {} } },
        })
      )
      expect(useWorkflowStore.getState().blocks).toBe(before)
      expect(useSubBlockStore.getState().workflowValues['workflow-a'].b.code).toBe('original')
      expect(fetch).not.toHaveBeenCalled()
    }
  )
})

it('defers a legacy broadcast behind an overlay without reading or applying its graph', async () => {
  mount()
  act(() => useWorkflowDiffStore.setState({ hasActiveDiff: true, isShowingDiff: true }))
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No fetch expected'))
  const before = useWorkflowStore.getState().blocks
  await act(async () =>
    transport.handlers.WorkflowOperation({
      operation: 'replace-state',
      target: 'workflow',
      metadata: { workflowId: 'workflow-a' },
      payload: { state: { blocks: {} } },
    })
  )
  expect(useWorkflowStore.getState().blocks).toBe(before)
  expect(fetch).not.toHaveBeenCalled()
  expect(useWorkflowDiffStore.getState().pendingExternalUpdates['workflow-a']).toBeGreaterThan(0)
})

it('cannot use a coded replacement refusal to fail a local delta', () => {
  mount()
  act(() =>
    useOperationQueueStore.getState().addToQueue({
      id: 'delta',
      workflowId: 'workflow-a',
      userId: 'fixture',
      operation: {
        operation: 'update-name',
        target: 'block',
        payload: { id: 'b', name: 'Pending' },
      },
    })
  )
  const before = useOperationQueueStore.getState().operations
  act(() =>
    transport.handlers.OperationFailed({
      operationId: 'delta',
      error: 'PRIVATE CANARY',
      retryable: false,
      code: 'WORKFLOW_REPLACE_REQUIRES_CAS',
    })
  )
  expect(useOperationQueueStore.getState().operations).toBe(before)
  expect(useOperationQueueStore.getState().hasOperationError).toBe(false)
  expect(useWorkflowDiffStore.getState().reconciliationErrors).toEqual({})
})

it.each(['navigation', 'new held intent'])(
  'does not apply a broadcast-triggered read after %s',
  async (interruption) => {
    mount()
    let finish!: (response: Response) => void
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const before = useWorkflowStore.getState().blocks
    await act(async () =>
      transport.handlers.WorkflowOperation({
        operation: 'replace-state',
        target: 'workflow',
        metadata: { workflowId: 'workflow-a' },
        payload: { state: { blocks: { injected: {} } } },
      })
    )
    expect(fetch).toHaveBeenCalledTimes(1)
    await act(async () => {
      if (interruption === 'navigation')
        useWorkflowRegistry.setState({ activeWorkflowId: 'workflow-b' })
      else
        useOperationQueueStore.getState().addToQueue({
          id: 'held-during-read',
          workflowId: 'workflow-a',
          userId: 'fixture',
          operation: {
            operation: 'replace-state',
            target: 'workflow',
            payload: { state: { intent: 'kept' } },
          },
        })
      finish(
        Response.json({
          data: {
            id: 'workflow-a',
            draftRevision: 999,
            userId: 'fixture',
            workspaceId: null,
            folderId: null,
            sortOrder: 0,
            name: 'Server',
            description: null,
            lastSynced: 0,
            createdAt: 0,
            updatedAt: 0,
            isDeployed: false,
            deployedAt: null,
            isPublicApi: false,
            locked: false,
            runCount: 0,
            lastRunAt: null,
            archivedAt: null,
            state: { blocks: {}, edges: [], loops: {}, parallels: {} },
          },
        })
      )
    })
    expect(useWorkflowStore.getState().blocks).toBe(before)
    expect(getAttestedDraftRevision('workflow-a')).not.toBe(999)
    if (interruption === 'new held intent')
      expect(useOperationQueueStore.getState().operations).toMatchObject([
        { id: 'held-during-read', status: 'failed' },
      ])
  }
)

it('shows a local pre-emit refusal without a server response while another workflow continues', () => {
  mount()
  const payload = { state: { intent: 'Retained' } }
  act(() =>
    useOperationQueueStore.getState().addToQueue({
      id: 'local-held',
      workflowId: 'workflow-a',
      userId: 'fixture-reader',
      operation: { operation: 'replace-state', target: 'workflow', payload },
    })
  )
  expect(transport.socket.emitWorkflowOperation).not.toHaveBeenCalled()
  expect(useOperationQueueStore.getState().operations).toMatchObject([
    { id: 'local-held', status: 'failed', failureCode: 'WORKFLOW_REPLACE_REQUIRES_CAS' },
  ])
  const emit = vi.fn(() => true)
  act(() => {
    useOperationQueueStore.getState().addToQueue({
      id: 'b-delta',
      workflowId: 'workflow-b',
      userId: 'fixture-reader',
      operation: { operation: 'update-name', target: 'block', payload: { id: 'b', name: 'B' } },
    })
    registerEmitFunctions(emit, emit, emit, 'workflow-b')
    useOperationQueueStore.getState().confirmOperation('b-delta')
  })
  expect(emit).toHaveBeenCalledTimes(1)
  expect(useOperationQueueStore.getState().operations[0].operation.payload).toBe(payload)
  expect(useOperationQueueStore.getState().hasOperationError).toBe(false)
  expect(useWorkflowDiffStore.getState().reconciliationErrors).toEqual({
    'workflow-a': 'Workflow replacement requires revision-checked persistence.',
  })
})

it('restores the held error on return to A without touching B or attesting a revision', () => {
  mount()
  act(() =>
    useOperationQueueStore.getState().addToQueue({
      id: 'roundtrip-held',
      workflowId: 'workflow-a',
      userId: 'fixture-reader',
      operation: { operation: 'replace-state', target: 'workflow', payload: { state: {} } },
    })
  )
  const held = useOperationQueueStore.getState().operations[0]
  act(() => {
    useWorkflowDiffStore.getState().detachDiffForNavigation('workflow-a', 'workflow-b')
    useWorkflowRegistry.setState({ activeWorkflowId: 'workflow-b' })
    useWorkflowStore.getState().replaceWorkflowState({
      currentWorkflowId: 'workflow-b',
      blocks: {},
      edges: [],
      loops: {},
      parallels: {},
    })
    useWorkflowDiffStore.getState().setWorkflowReconciliationError('workflow-a', null)
    useWorkflowDiffStore.getState().setWorkflowReconciliationError('workflow-b', 'B diagnostic')
  })
  expect(useWorkflowDiffStore.getState().reconciliationErrors).toEqual({
    'workflow-b': 'B diagnostic',
  })
  act(() => {
    useWorkflowDiffStore.getState().detachDiffForNavigation('workflow-b', 'workflow-a')
    useWorkflowRegistry.setState({ activeWorkflowId: 'workflow-a' })
    useWorkflowStore.getState().replaceWorkflowState({
      currentWorkflowId: 'workflow-a',
      blocks: {},
      edges: [],
      loops: {},
      parallels: {},
    })
  })
  expect(useWorkflowDiffStore.getState().reconciliationErrors).toEqual({
    'workflow-a': 'Workflow replacement requires revision-checked persistence.',
    'workflow-b': 'B diagnostic',
  })
  expect(useOperationQueueStore.getState().operations[0]).toBe(held)
  expect(getAttestedDraftRevision('workflow-a')).toBeNull()
})

it.each(['foreign user', 'foreign workflow', 'foreign operation'])(
  'does not display a local refusal for a %s',
  (kind) => {
    mount()
    act(() =>
      useOperationQueueStore.setState({
        operations: [
          {
            id: 'foreign',
            workflowId: kind === 'foreign workflow' ? 'workflow-b' : 'workflow-a',
            userId: kind === 'foreign user' ? 'other-user' : 'fixture-reader',
            timestamp: 1,
            retryCount: 0,
            status: 'failed',
            failureCode: 'WORKFLOW_REPLACE_REQUIRES_CAS',
            operation: {
              target: kind === 'foreign operation' ? 'block' : 'workflow',
              operation: kind === 'foreign operation' ? 'update-name' : 'replace-state',
              payload: {},
            },
          },
        ],
      })
    )
    expect(useWorkflowDiffStore.getState().reconciliationErrors).toEqual({})
  }
)

it('does not reinstall the held error after the native identity reset', async () => {
  mount()
  act(() =>
    useOperationQueueStore.getState().addToQueue({
      id: 'reset-held',
      workflowId: 'workflow-a',
      userId: 'fixture-reader',
      operation: { operation: 'replace-state', target: 'workflow', payload: { state: {} } },
    })
  )
  expect(useWorkflowDiffStore.getState().reconciliationErrors['workflow-a']).toBeTruthy()
  await act(async () => resetAllStores())
  act(() => useOperationQueueStore.getState().clearError())
  expect(useOperationQueueStore.getState().operations).toEqual([])
  expect(useWorkflowDiffStore.getState().reconciliationErrors).toEqual({})
})
