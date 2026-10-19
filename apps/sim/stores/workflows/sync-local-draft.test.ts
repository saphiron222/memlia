// Modified by Memlia: bind draft revision attestations to applied client snapshots.
import {
  workflowRegistryStoreMock,
  workflowRegistryStoreMockFns,
} from '@sim/testing/mocks/workflow-registry-store.mock'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorkflowStore } from '@/stores/workflows/workflow/store'

const {
  mockFetchQuery,
  mockApplyWorkflowStateToStores,
  mockHasPendingOperations,
  mockGetOperationQueueState,
  mockGetWorkflowDiffState,
} = vi.hoisted(() => ({
  mockFetchQuery: vi.fn(),
  mockApplyWorkflowStateToStores: vi.fn(),
  mockHasPendingOperations: vi.fn(() => false),
  mockGetOperationQueueState: vi.fn(() => ({
    hasPendingOperations: mockHasPendingOperations,
    workflowOperationVersions: {},
    remoteApplyVersions: {},
  })),
  mockGetWorkflowDiffState: vi.fn(() => ({
    hasActiveDiff: false,
    pendingExternalUpdates: {},
    reconcilingWorkflows: {},
    reconciliationErrors: {},
    remoteUpdateVersions: {},
  })),
}))

vi.mock('@/app/_shell/providers/get-query-client', () => ({
  getQueryClient: () => ({ fetchQuery: mockFetchQuery }),
}))

vi.mock('@/hooks/queries/utils/fetch-workflow-envelope', () => ({
  fetchWorkflowEnvelope: vi.fn(),
}))

vi.mock('@/hooks/queries/utils/workflow-keys', () => ({
  workflowKeys: {
    state: (id: string) => ['workflow', 'state', id],
  },
}))

vi.mock('@/stores/workflow-diff/utils', () => ({
  applyWorkflowStateToStores: mockApplyWorkflowStateToStores,
}))

vi.mock('@/stores/workflow-diff/store', () => ({
  useWorkflowDiffStore: {
    getState: mockGetWorkflowDiffState,
  },
}))

vi.mock('@/stores/operation-queue/store', () => ({
  useOperationQueueStore: {
    getState: mockGetOperationQueueState,
  },
}))

vi.mock('@/stores/workflows/registry/store', () => workflowRegistryStoreMock)

import {
  applyRawDraftSnapshot,
  canApplyDraftSnapshot,
  captureDraftVersions,
  getAttestedDraftRevision,
  syncLocalDraftFromServer,
  syncSocketDraftFromSnapshot,
} from '@/stores/workflows/sync-local-draft'

const mockGetRegistryState = workflowRegistryStoreMockFns.mockGetState

function buildEnvelopeState() {
  return {
    blocks: {},
    edges: [],
    loops: {},
    parallels: {},
    lastSaved: 1,
  }
}

describe('syncLocalDraftFromServer', () => {
  beforeEach(() => {
    mockApplyWorkflowStateToStores.mockReset()
    mockGetRegistryState.mockReturnValue({ activeWorkflowId: 'workflow-a' })
    mockHasPendingOperations.mockReturnValue(false)
    mockGetOperationQueueState.mockImplementation(() => ({
      hasPendingOperations: mockHasPendingOperations,
      workflowOperationVersions: {},
      remoteApplyVersions: {},
    }))
    mockGetWorkflowDiffState.mockReturnValue({
      hasActiveDiff: false,
      pendingExternalUpdates: {},
      reconcilingWorkflows: {},
      reconciliationErrors: {},
      remoteUpdateVersions: {},
    })
  })

  it('does not mutate the shared query-cache envelope when stamping variables', async () => {
    const envelope = {
      id: 'workflow-a',
      draftRevision: 7,
      state: buildEnvelopeState(),
      variables: { 'variable-a': { id: 'variable-a', name: 'X', type: 'plain', value: '1' } },
    }
    mockFetchQuery.mockResolvedValue(envelope)

    await expect(syncLocalDraftFromServer('workflow-a')).resolves.toBe(true)

    expect(Object.hasOwn(envelope.state, 'variables')).toBe(false)
    const appliedState = mockApplyWorkflowStateToStores.mock.calls[0][1]
    expect(appliedState).not.toBe(envelope.state)
  })

  it('does not apply a fetched draft after navigation changes the active workflow', async () => {
    mockGetRegistryState
      .mockReturnValueOnce({ activeWorkflowId: 'workflow-a' })
      .mockReturnValueOnce({ activeWorkflowId: 'workflow-b' })
    mockFetchQuery.mockResolvedValue({
      id: 'workflow-a',
      draftRevision: 7,
      state: buildEnvelopeState(),
      variables: {},
    })

    await expect(syncLocalDraftFromServer('workflow-a')).resolves.toBe(false)

    expect(mockApplyWorkflowStateToStores).not.toHaveBeenCalled()
  })

  it('does not apply a fetched draft over newly queued local operations', async () => {
    mockHasPendingOperations.mockReturnValueOnce(false).mockReturnValueOnce(true)
    mockFetchQuery.mockResolvedValue({
      id: 'workflow-a',
      draftRevision: 7,
      state: buildEnvelopeState(),
      variables: {},
    })

    await expect(syncLocalDraftFromServer('workflow-a')).resolves.toBe(false)

    expect(mockApplyWorkflowStateToStores).not.toHaveBeenCalled()
  })

  it('does not apply a fetched draft when an active diff is showing', async () => {
    mockGetWorkflowDiffState.mockReturnValue({
      hasActiveDiff: true,
      pendingExternalUpdates: {},
      reconcilingWorkflows: {},
      reconciliationErrors: {},
      remoteUpdateVersions: {},
    })
    mockFetchQuery.mockResolvedValue({
      id: 'workflow-a',
      draftRevision: 7,
      state: buildEnvelopeState(),
      variables: {},
    })

    await expect(syncLocalDraftFromServer('workflow-a')).resolves.toBe(false)

    expect(mockApplyWorkflowStateToStores).not.toHaveBeenCalled()
  })

  it('does not apply a fetched draft when a newer remote update arrives during fetch', async () => {
    mockGetWorkflowDiffState
      .mockReturnValueOnce({
        hasActiveDiff: false,
        pendingExternalUpdates: {},
        reconcilingWorkflows: {},
        reconciliationErrors: {},
        remoteUpdateVersions: {},
      })
      .mockReturnValueOnce({
        hasActiveDiff: false,
        pendingExternalUpdates: {},
        reconcilingWorkflows: {},
        reconciliationErrors: {},
        remoteUpdateVersions: { 'workflow-a': 1 },
      })
    mockFetchQuery.mockResolvedValue({
      id: 'workflow-a',
      draftRevision: 7,
      state: buildEnvelopeState(),
      variables: {},
    })

    await expect(syncLocalDraftFromServer('workflow-a')).resolves.toBe(false)

    expect(mockApplyWorkflowStateToStores).not.toHaveBeenCalled()
  })

  it('does not apply a fetched draft when local operations queue and drain during fetch', async () => {
    mockGetOperationQueueState
      .mockReturnValueOnce({
        hasPendingOperations: mockHasPendingOperations,
        workflowOperationVersions: {},
        remoteApplyVersions: {},
      })
      .mockReturnValueOnce({
        hasPendingOperations: mockHasPendingOperations,
        workflowOperationVersions: {},
        remoteApplyVersions: {},
      })
      .mockReturnValueOnce({
        hasPendingOperations: mockHasPendingOperations,
        workflowOperationVersions: {},
        remoteApplyVersions: {},
      })
      .mockReturnValueOnce({
        hasPendingOperations: mockHasPendingOperations,
        workflowOperationVersions: { 'workflow-a': 1 },
        remoteApplyVersions: {},
      })
    mockFetchQuery.mockResolvedValue({
      id: 'workflow-a',
      draftRevision: 7,
      state: buildEnvelopeState(),
      variables: {},
    })

    await expect(syncLocalDraftFromServer('workflow-a')).resolves.toBe(false)

    expect(mockApplyWorkflowStateToStores).not.toHaveBeenCalled()
  })

  it('preserves the applied remote graph when all three refreshes race with remote changes', async () => {
    const queueState = {
      hasPendingOperations: mockHasPendingOperations,
      workflowOperationVersions: {},
      remoteApplyVersions: {} as Record<string, number>,
    }
    mockGetOperationQueueState.mockImplementation(() => queueState)
    let visibleGraph = 'initial'
    mockApplyWorkflowStateToStores.mockImplementation((_id, state) => {
      visibleGraph = state.metadata.name
    })
    mockFetchQuery.mockImplementation(async () => {
      const count = (queueState.remoteApplyVersions['workflow-a'] ?? 0) + 1
      queueState.remoteApplyVersions['workflow-a'] = count
      visibleGraph = `remote-${count}`
      return {
        id: 'workflow-a',
        draftRevision: count,
        state: { ...buildEnvelopeState(), metadata: { name: `older-${count}` } },
      }
    })
    const applied = await syncLocalDraftFromServer('workflow-a')
    expect(visibleGraph).toBe('remote-3')
    expect(applied).toBe(false)
    expect(mockFetchQuery).toHaveBeenCalledTimes(3)
    expect(mockApplyWorkflowStateToStores).not.toHaveBeenCalled()
  })

  it('refetches when a remote op is applied during the fetch, then applies the fresh snapshot', async () => {
    const queueState = {
      hasPendingOperations: mockHasPendingOperations,
      workflowOperationVersions: {} as Record<string, number>,
      remoteApplyVersions: {} as Record<string, number>,
    }
    mockGetOperationQueueState.mockImplementation(() => queueState)

    const staleEnvelope = {
      id: 'workflow-a',
      draftRevision: 7,
      state: buildEnvelopeState(),
      variables: {},
    }
    const freshEnvelope = {
      id: 'workflow-a',
      draftRevision: 8,
      state: { ...buildEnvelopeState(), lastSaved: 2 },
      variables: {},
    }
    mockFetchQuery
      .mockImplementationOnce(async () => {
        queueState.remoteApplyVersions = { 'workflow-a': 1 }
        return staleEnvelope
      })
      .mockResolvedValueOnce(freshEnvelope)

    await expect(syncLocalDraftFromServer('workflow-a')).resolves.toBe(true)

    expect(mockFetchQuery).toHaveBeenCalledTimes(2)
    expect(mockApplyWorkflowStateToStores).toHaveBeenCalledWith(
      'workflow-a',
      expect.objectContaining({ lastSaved: 2 }),
      {
        updateLastSaved: true,
        draftRevisionAttestation: {
          workflowId: 'workflow-a',
          revision: 8,
          versions: { localOperation: 0, remoteApply: 1, remoteUpdate: 0 },
        },
      }
    )
  })
})

describe('canApplyDraftSnapshot', () => {
  beforeEach(() => {
    mockGetRegistryState.mockReturnValue({ activeWorkflowId: 'workflow-a' })
    mockHasPendingOperations.mockReturnValue(false)
    mockGetOperationQueueState.mockImplementation(() => ({
      hasPendingOperations: mockHasPendingOperations,
      workflowOperationVersions: {},
      remoteApplyVersions: {},
    }))
    mockGetWorkflowDiffState.mockReturnValue({
      hasActiveDiff: false,
      pendingExternalUpdates: {},
      reconcilingWorkflows: {},
      reconciliationErrors: {},
      remoteUpdateVersions: {},
    })
  })

  it('refuses when an external full reload (workflow-updated) landed since capture', () => {
    const versions = captureDraftVersions('workflow-a')
    mockGetWorkflowDiffState.mockReturnValue({
      hasActiveDiff: false,
      pendingExternalUpdates: {},
      reconcilingWorkflows: {},
      reconciliationErrors: {},
      remoteUpdateVersions: { 'workflow-a': 1 },
    })

    expect(canApplyDraftSnapshot('workflow-a', versions)).toBe(false)
  })

  it('refuses when a remote collaborator op was applied since capture', () => {
    const versions = captureDraftVersions('workflow-a')
    mockGetOperationQueueState.mockImplementation(() => ({
      hasPendingOperations: mockHasPendingOperations,
      workflowOperationVersions: {},
      remoteApplyVersions: { 'workflow-a': 1 },
    }))

    expect(canApplyDraftSnapshot('workflow-a', versions)).toBe(false)
  })
})

describe('usable revision and guarded raw snapshots', () => {
  let queue: {
    hasPendingOperations: typeof mockHasPendingOperations
    workflowOperationVersions: Record<string, number>
    remoteApplyVersions: Record<string, number>
  }
  let diff: {
    hasActiveDiff: boolean
    pendingExternalUpdates: Record<string, number>
    reconcilingWorkflows: Record<string, boolean>
    reconciliationErrors: Record<string, string>
    remoteUpdateVersions: Record<string, number>
  }
  const graph = {
    currentWorkflowId: 'workflow-a',
    blocks: {},
    edges: [],
    loops: {},
    parallels: {},
    variables: {},
  }
  beforeEach(() => {
    mockApplyWorkflowStateToStores.mockReset()
    mockGetRegistryState.mockReturnValue({ activeWorkflowId: 'workflow-a' })
    mockHasPendingOperations.mockReturnValue(false)
    queue = {
      hasPendingOperations: mockHasPendingOperations,
      workflowOperationVersions: {},
      remoteApplyVersions: {},
    }
    diff = {
      hasActiveDiff: false,
      pendingExternalUpdates: {},
      reconcilingWorkflows: {},
      reconciliationErrors: {},
      remoteUpdateVersions: {},
    }
    mockGetOperationQueueState.mockImplementation(() => queue)
    mockGetWorkflowDiffState.mockImplementation(() => diff)
    useWorkflowStore.getState().replaceWorkflowState(graph, {
      draftRevisionAttestation: {
        workflowId: 'workflow-a',
        revision: 7,
        versions: captureDraftVersions('workflow-a'),
      },
    })
  })
  it('returns the attested server revision only for the active snapshot identity', () => {
    expect(getAttestedDraftRevision('workflow-a')).toBe(7)
    expect(getAttestedDraftRevision('workflow-b')).toBeNull()
    mockGetRegistryState.mockReturnValue({ activeWorkflowId: 'workflow-b' })
    expect(getAttestedDraftRevision('workflow-a')).toBeNull()
  })
  it.each(['localOperation', 'remoteApply', 'remoteUpdate'] as const)(
    'invalidates a missing %s transition without guessing a newer revision',
    (field) => {
      if (field === 'localOperation') queue.workflowOperationVersions['workflow-a'] = 1
      else if (field === 'remoteApply') queue.remoteApplyVersions['workflow-a'] = 1
      else diff.remoteUpdateVersions['workflow-a'] = 1
      expect(getAttestedDraftRevision('workflow-a')).toBeNull()
    }
  )
  it('does not recover an old attestation when an unversioned ACK drains pending operations', () => {
    mockHasPendingOperations.mockReturnValue(true)
    queue.workflowOperationVersions['workflow-a'] = 1
    expect(getAttestedDraftRevision('workflow-a')).toBeNull()
    mockHasPendingOperations.mockReturnValue(false)
    expect(getAttestedDraftRevision('workflow-a')).toBeNull()
  })
  it.each(['diff', 'pending', 'reconciling', 'error'] as const)(
    'blocks attestation during %s',
    (kind) => {
      if (kind === 'diff') diff.hasActiveDiff = true
      if (kind === 'pending') mockHasPendingOperations.mockReturnValue(true)
      if (kind === 'reconciling') diff.reconcilingWorkflows['workflow-a'] = true
      if (kind === 'error') diff.reconciliationErrors['workflow-a'] = 'needs resynchronization'
      expect(getAttestedDraftRevision('workflow-a')).toBeNull()
    }
  )
  it('rejects an old raw snapshot using its original vector after HTTP failure', () => {
    const captured = captureDraftVersions('workflow-a')
    queue.remoteApplyVersions['workflow-a'] = 1
    expect(applyRawDraftSnapshot('workflow-a', graph, 7, captured)).toBe(false)
    expect(mockApplyWorkflowStateToStores).not.toHaveBeenCalled()
  })
  it('owns the join payload primitives and graph before a failing HTTP await', async () => {
    let rejectFetch: (error: Error) => void = () => {}
    mockFetchQuery.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectFetch = reject
        })
    )
    const payload = {
      id: 'workflow-a',
      draftRevision: 7,
      state: { ...graph, metadata: { name: 'captured' } },
      variables: { v: { id: 'v', name: 'v', type: 'string' as const, value: 'captured-value' } },
    }
    const result = syncSocketDraftFromSnapshot(payload)
    payload.id = 'workflow-b'
    payload.draftRevision = 99
    payload.state.metadata.name = 'mutated'
    payload.variables.v.value = 'mutated-value'
    rejectFetch(new Error('Controlled HTTP failure'))
    expect(await result).toBe(true)
    expect(mockApplyWorkflowStateToStores).toHaveBeenCalledWith(
      'workflow-a',
      expect.objectContaining({
        currentWorkflowId: 'workflow-a',
        metadata: { name: 'captured' },
        variables: { v: { id: 'v', name: 'v', type: 'string' as const, value: 'captured-value' } },
      }),
      {
        draftRevisionAttestation: {
          workflowId: 'workflow-a',
          revision: 7,
          versions: { localOperation: 0, remoteApply: 0, remoteUpdate: 0 },
        },
      }
    )
  })
  it('does not attest raw graph-only envelopes whose variables are missing', async () => {
    mockFetchQuery.mockRejectedValueOnce(new Error('Controlled HTTP failure'))
    expect(
      await syncSocketDraftFromSnapshot({ id: 'workflow-a', draftRevision: 7, state: graph })
    ).toBe(false)
    expect(mockApplyWorkflowStateToStores).not.toHaveBeenCalled()
  })
  it('does not recapture a newer vector after HTTP rejects to justify the old raw payload', async () => {
    let rejectFetch: (error: Error) => void = () => {}
    mockFetchQuery.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectFetch = reject
        })
    )
    const result = syncSocketDraftFromSnapshot({
      id: 'workflow-a',
      draftRevision: 7,
      state: graph,
      variables: {},
    })
    queue.remoteApplyVersions['workflow-a'] = 1
    rejectFetch(new Error('Controlled HTTP failure'))
    expect(await result).toBe(false)
    expect(mockApplyWorkflowStateToStores).not.toHaveBeenCalled()
  })
  it('applies a valid raw snapshot and its own revision in one call', () => {
    const captured = captureDraftVersions('workflow-a')
    expect(applyRawDraftSnapshot('workflow-a', graph, 0, captured)).toBe(true)
    expect(mockApplyWorkflowStateToStores).toHaveBeenCalledWith('workflow-a', graph, {
      draftRevisionAttestation: { workflowId: 'workflow-a', revision: 0, versions: captured },
    })
  })
  it.each([undefined, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '7'])(
    'rejects unattestable raw revision %s',
    (revision) => {
      expect(
        applyRawDraftSnapshot('workflow-a', graph, revision, captureDraftVersions('workflow-a'))
      ).toBe(false)
      expect(mockApplyWorkflowStateToStores).not.toHaveBeenCalled()
    }
  )
})
