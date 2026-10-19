// Modified by Memlia: bind draft revision attestations to applied client snapshots.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useVariablesStore } from '@/stores/variables/store'
import {
  applyWorkflowStateToStores,
  applyWorkflowVariablesToStore,
  createBatchedUpdater,
} from '@/stores/workflow-diff/utils'
import { useSubBlockStore } from '@/stores/workflows/subblock/store'
import { useWorkflowStore } from '@/stores/workflows/workflow/store'
import type { WorkflowState } from '@/stores/workflows/workflow/types'

describe('applyWorkflowVariablesToStore', () => {
  beforeEach(() => {
    useVariablesStore.setState({
      variables: {},
      isLoading: false,
      error: null,
      isEditing: null,
    })
  })

  it('hydrates variables for the target workflow and preserves other workflows', () => {
    useVariablesStore.setState({
      variables: {
        old: {
          id: 'old',
          workflowId: 'workflow-a',
          name: 'oldValue',
          type: 'plain',
          value: 'stale',
        },
        other: {
          id: 'other',
          workflowId: 'workflow-b',
          name: 'otherValue',
          type: 'plain',
          value: 'kept',
        },
      },
    })

    applyWorkflowVariablesToStore('workflow-a', {
      next: {
        id: 'next',
        name: 'nextValue',
        type: 'number',
        value: 42,
      },
    })

    expect(useVariablesStore.getState().variables).toEqual({
      other: {
        id: 'other',
        workflowId: 'workflow-b',
        name: 'otherValue',
        type: 'plain',
        value: 'kept',
      },
      next: {
        id: 'next',
        workflowId: 'workflow-a',
        name: 'nextValue',
        type: 'number',
        value: 42,
      },
    })
  })

  it('preserves null variable values from persisted workflow state', () => {
    applyWorkflowVariablesToStore('workflow-a', {
      next: {
        id: 'next',
        name: 'nullableValue',
        type: 'object',
        value: null,
      },
    })

    expect(useVariablesStore.getState().variables.next.value).toBeNull()
  })
})

describe('snapshot attestation after dependent state application', () => {
  const attestation = {
    workflowId: 'workflow-a',
    revision: 7,
    versions: { localOperation: 0, remoteApply: 0, remoteUpdate: 0 },
  }
  const graph: WorkflowState = {
    currentWorkflowId: 'workflow-a',
    blocks: {},
    edges: [],
    loops: {},
    parallels: {},
    variables: { v: { id: 'v', name: 'v', type: 'string', value: 'new' } },
  }
  it('does not publish an attestation before the variables and subblocks are applied', () => {
    useWorkflowStore.getState().replaceWorkflowState({ ...graph, variables: {} })
    useVariablesStore.setState({ variables: {} })
    const observations: unknown[] = []
    const stop = useWorkflowStore.subscribe((state) => {
      if (state.draftRevisionAttestation)
        observations.push(useVariablesStore.getState().variables.v?.value)
    })
    try {
      applyWorkflowStateToStores('workflow-a', graph, { draftRevisionAttestation: attestation })
    } finally {
      stop()
    }
    expect(observations).toEqual(['new'])
    expect(useWorkflowStore.getState().draftRevisionAttestation).toEqual(attestation)
  })
  it('owns caller attestation primitives before notifying existing store subscribers', () => {
    useWorkflowStore
      .getState()
      .replaceWorkflowState(graph, { draftRevisionAttestation: attestation })
    const supplied = { ...attestation, revision: 8, versions: { ...attestation.versions } }
    const stop = useWorkflowStore.subscribe((state) => {
      if (!state.draftRevisionAttestation) {
        supplied.revision = 99
        supplied.versions.remoteApply = 99
      }
    })
    try {
      applyWorkflowStateToStores('workflow-a', graph, { draftRevisionAttestation: supplied })
    } finally {
      stop()
    }
    expect(useWorkflowStore.getState().draftRevisionAttestation).toEqual({
      ...attestation,
      revision: 8,
    })
  })
  it('leaves no attestation if a dependent subblock application fails', () => {
    useWorkflowStore
      .getState()
      .replaceWorkflowState({ ...graph, variables: {} }, { draftRevisionAttestation: attestation })
    const setter = vi
      .spyOn(useSubBlockStore.getState(), 'setWorkflowValues')
      .mockImplementationOnce(() => {
        throw new Error('Controlled dependent write failure')
      })
    try {
      expect(() =>
        applyWorkflowStateToStores('workflow-a', graph, {
          draftRevisionAttestation: { ...attestation, revision: 8 },
        })
      ).toThrow('Controlled dependent write failure')
      expect(useWorkflowStore.getState().draftRevisionAttestation).toBeNull()
    } finally {
      setter.mockRestore()
    }
  })
})

describe('diff snapshot and CAS transport', () => {
  it('owns the variables of the targeted workflow in a baseline', async () => {
    const { captureBaselineSnapshot, cloneWorkflowState } = await import('./utils')
    useWorkflowStore
      .getState()
      .replaceWorkflowState({ blocks: {}, edges: [], loops: {}, parallels: {} })
    useVariablesStore.setState({
      variables: {
        v: { id: 'v', workflowId: 'workflow-a', name: 'v', type: 'object', value: { n: 1 } },
        other: {
          id: 'other',
          workflowId: 'workflow-b',
          name: 'other',
          type: 'plain',
          value: 'foreign',
        },
      },
    })
    const captured = captureBaselineSnapshot('workflow-a')
    const copy = cloneWorkflowState(captured)
    useVariablesStore.getState().variables.v.value = { n: 2 }
    expect(captured.variables).toEqual({
      v: { id: 'v', workflowId: 'workflow-a', name: 'v', type: 'object', value: { n: 1 } },
    })
    captured.variables!.v.value = { n: 3 }
    expect(copy.variables!.v.value).toEqual({ n: 1 })
  })
  it('sends revision and variables together and returns the native receipt without a late store write', async () => {
    const { persistWorkflowStateToServer } = await import('./utils')
    const http = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({ success: true, baseRevision: 7, draftRevision: 8, warnings: [] }),
          { headers: { 'Content-Type': 'application/json' } }
        )
      )
    useWorkflowStore.setState({ lastSaved: 123 })
    try {
      const result = await persistWorkflowStateToServer(
        'workflow-a',
        { blocks: {}, edges: [], loops: {}, parallels: {}, variables: {} },
        7
      )
      expect(JSON.parse(String(http.mock.calls[0][1]?.body))).toMatchObject({
        expectedRevision: 7,
        variables: {},
      })
      expect(result).toEqual({ success: true, baseRevision: 7, draftRevision: 8, warnings: [] })
      expect(useWorkflowStore.getState().lastSaved).toBe(123)
    } finally {
      http.mockRestore()
    }
  })
  it('preserves HTTP 409 as an error and never retries', async () => {
    const { persistWorkflowStateToServer } = await import('./utils')
    const http = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'Conflict' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      })
    )
    try {
      await expect(
        persistWorkflowStateToServer('workflow-a', { blocks: {}, edges: [], variables: {} }, 7)
      ).rejects.toMatchObject({ status: 409 })
      expect(http).toHaveBeenCalledTimes(1)
    } finally {
      http.mockRestore()
    }
  })
})

it('cancels only the pending batch and permits a fresh display update', () => {
  vi.useFakeTimers()
  try {
    const apply = vi.fn()
    const update = createBatchedUpdater(apply)
    update({ hasActiveDiff: true })
    update.cancel()
    vi.runAllTimers()
    expect(apply).not.toHaveBeenCalled()
    update({ status: 'none' })
    vi.runAllTimers()
    expect(apply).toHaveBeenCalledExactlyOnceWith({ status: 'none' })
  } finally {
    vi.useRealTimers()
  }
})
