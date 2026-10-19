// Modified by Memlia: bind draft revision attestations to applied client snapshots.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useVariablesStore } from '@/stores/variables/store'
import {
  applyWorkflowStateToStores,
  applyWorkflowVariablesToStore,
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
