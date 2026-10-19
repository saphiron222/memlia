// Modified by Memlia: bind draft revision attestations to applied client snapshots.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useOperationQueueStore } from '@/stores/operation-queue/store'
import { useVariablesStore } from '@/stores/variables/store'
import { RESET_DIFF_STATE, useWorkflowDiffStore } from '@/stores/workflow-diff/store'
import {
  applyWorkflowStateToStores,
  applyWorkflowVariablesToStore,
  createBatchedUpdater,
  decodeDiffWorkflowSnapshot,
} from '@/stores/workflow-diff/utils'
import { useWorkflowRegistry } from '@/stores/workflows/registry/store'
import { useSubBlockStore } from '@/stores/workflows/subblock/store'
import {
  applyRawDraftSnapshot,
  captureDraftVersions,
  syncSocketDraftFromSnapshot,
} from '@/stores/workflows/sync-local-draft'
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

describe('publication guards against synchronous subscribers', () => {
  const id = 'workflow-a'
  const target: WorkflowState = {
    currentWorkflowId: id,
    blocks: {},
    edges: [],
    loops: {},
    parallels: {},
    variables: { v: { id: 'v', name: 'v', type: 'plain', value: 'target' } },
  }
  beforeEach(() => {
    useWorkflowStore.getState().replaceWorkflowState(target)
    useWorkflowStore.getState().invalidateDraftRevisionAttestation()
    useSubBlockStore.getState().setWorkflowValues(id, { old: { value: 'source' } })
    useVariablesStore.setState({
      variables: { v: { id: 'v', workflowId: id, name: 'v', type: 'plain', value: 'source' } },
    })
  })
  it.each(['variable', 'graph', 'subblocks'] as const)(
    'preserves a human %s edit during subblock publication',
    (kind) => {
      let entered = false
      const stop = useSubBlockStore.subscribe(() => {
        if (entered) return
        entered = true
        if (kind === 'variable')
          useVariablesStore.setState((s) => ({
            variables: { ...s.variables, v: { ...s.variables.v, value: 'human' } },
          }))
        if (kind === 'graph')
          useWorkflowStore.setState({ edges: [{ id: 'human', source: 'a', target: 'b' }] })
        if (kind === 'subblocks')
          useSubBlockStore.getState().setWorkflowValues(id, { human: { value: 'human' } })
      })
      try {
        expect(() => applyWorkflowStateToStores(id, target)).toThrow('changed during publication')
      } finally {
        stop()
      }
      expect(entered).toBe(true)
      expect(useVariablesStore.getState().variables.v.value).toBe(
        kind === 'variable' ? 'human' : 'source'
      )
      expect(useWorkflowStore.getState().edges).toEqual(
        kind === 'graph' ? [{ id: 'human', source: 'a', target: 'b' }] : []
      )
      if (kind === 'subblocks')
        expect(useSubBlockStore.getState().workflowValues[id]).toEqual({
          human: { value: 'human' },
        })
      expect(useWorkflowStore.getState().draftRevisionAttestation).toBeNull()
    }
  )
  it('does not adopt an in-place variable mutation after its own setter', () => {
    const stop = useVariablesStore.subscribe((s) => {
      s.variables.v.value = 'human'
    })
    try {
      expect(() => applyWorkflowStateToStores(id, target)).toThrow('changed during publication')
    } finally {
      stop()
    }
    expect(useVariablesStore.getState().variables.v.value).toBe('human')
  })
  it('does not adopt an in-place graph mutation after graph publication', () => {
    const stop = useWorkflowStore.subscribe((s) => {
      if (s.draftRevisionAttestation) s.edges.push({ id: 'human', source: 'a', target: 'b' })
    })
    try {
      expect(() =>
        applyWorkflowStateToStores(id, target, {
          draftRevisionAttestation: {
            workflowId: id,
            revision: 8,
            versions: { localOperation: 0, remoteApply: 0, remoteUpdate: 0 },
          },
        })
      ).toThrow('changed during publication')
    } finally {
      stop()
    }
    expect(useWorkflowStore.getState().edges).toEqual([{ id: 'human', source: 'a', target: 'b' }])
    expect(useWorkflowStore.getState().draftRevisionAttestation).toBeNull()
  })
  it('permits edits to another workflow while publishing the owned workflow', () => {
    const stop = useSubBlockStore.subscribe(() =>
      useVariablesStore.setState((s) => ({
        variables: {
          ...s.variables,
          other: {
            id: 'other',
            workflowId: 'workflow-b',
            name: 'other',
            type: 'plain',
            value: 'human',
          },
        },
      }))
    )
    try {
      applyWorkflowStateToStores(id, target)
    } finally {
      stop()
    }
    expect(useVariablesStore.getState().variables.v.value).toBe('target')
    expect(useVariablesStore.getState().variables.other.value).toBe('human')
  })
})

const publicationHttp = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('@/app/_shell/providers/get-query-client', () => ({
  getQueryClient: () => ({ fetchQuery: publicationHttp.fetch }),
}))

describe('native sync refuses a partial publication rather than raw retry', () => {
  it.each(['socket-http', 'raw-direct'] as const)(
    'preserves a human edit through %s',
    async (path) => {
      const id = 'workflow-a'
      const state: WorkflowState = {
        currentWorkflowId: id,
        blocks: {},
        edges: [],
        loops: {},
        parallels: {},
      }
      const variables = { v: { id: 'v', name: 'v', type: 'plain' as const, value: 'server' } }
      useOperationQueueStore.getState().reset()
      useWorkflowDiffStore.setState({
        ...RESET_DIFF_STATE,
        detachedDiffs: {},
        pendingExternalUpdates: {},
        remoteUpdateVersions: {},
        reconcilingWorkflows: {},
        reconciliationErrors: {},
      })
      useWorkflowRegistry.setState({ activeWorkflowId: id })
      useWorkflowStore.getState().replaceWorkflowState(state)
      useVariablesStore.setState({
        variables: { v: { ...variables.v, workflowId: id, value: 'source' } },
      })
      publicationHttp.fetch
        .mockReset()
        .mockResolvedValue({ id, state, variables, draftRevision: 7 })
      let entered = false
      const stop = useSubBlockStore.subscribe(() => {
        if (entered) return
        entered = true
        useVariablesStore.setState((s) => ({
          variables: { ...s.variables, v: { ...s.variables.v, value: 'human' } },
        }))
      })
      let result: unknown
      try {
        result =
          path === 'socket-http'
            ? await syncSocketDraftFromSnapshot({ id, state, variables, draftRevision: 7 })
            : applyRawDraftSnapshot(id, { ...state, variables }, 7, captureDraftVersions(id))
      } finally {
        stop()
      }
      expect(entered).toBe(true)
      expect(useVariablesStore.getState().variables.v.value).toBe('human')
      expect(result).toBe(false)
      expect(useWorkflowStore.getState().draftRevisionAttestation).toBeNull()
      expect(publicationHttp.fetch).toHaveBeenCalledTimes(path === 'socket-http' ? 1 : 0)
    }
  )
})

describe('GET snapshot representation boundary', () => {
  const source = () => ({
    draftRevision: 7,
    blocks: {
      legacy: {
        id: 'legacy',
        type: 'retired-but-preserved',
        name: 'Legacy',
        position: { x: 1, y: 2 },
        enabled: true,
        subBlocks: {
          text: { id: 'text', type: 'short-input', value: 'keep' },
          matrix: { id: 'matrix', type: 'table', value: [['b', 'a'], ['c']] },
        },
        outputs: {
          plain: 'string',
          structured: {
            type: 'json',
            description: 'keep',
            hiddenFromDisplay: false,
            extension: { ordered: [3, 1, 2] },
            condition: {
              field: 'mode',
              value: ['x', false, 2],
              not: false,
              allowReference: true,
              extension: 'keep',
              and: { field: 'other', value: [null, 'a', true], extension: { keep: true } },
            },
          },
        },
      },
    },
    edges: [],
    loops: {
      loop: {
        id: 'loop',
        nodes: ['legacy'],
        iterations: 3,
        loopType: 'for',
        enabled: false,
        locked: false,
      },
    },
    parallels: {
      parallel: {
        id: 'parallel',
        nodes: ['legacy'],
        parallelType: 'count',
        count: 0,
        enabled: true,
      },
    },
    variables: {
      v: {
        id: 'v',
        workflowId: 'workflow-a',
        name: 'v',
        type: 'object',
        value: { ordered: [false, 1, null] },
      },
    },
  })
  it('preserves the exact represented graph, legacy blocks, output extensions, variables and array order, removing only R', () => {
    const input = source()
    const original = structuredClone(input)
    const { draftRevision: _revision, ...expected } = original
    expect(decodeDiffWorkflowSnapshot(input)).toEqual(expected)
    expect(input).toEqual(original)
  })
  it.each([
    'boolean-value',
    'object-value',
    'missing-enabled',
    'unknown-type',
    'invalid-output',
    'missing-and-value',
  ] as const)('refuses %s with a fixed error instead of coercing or dropping it', (kind) => {
    const input = source()
    if (kind === 'boolean-value') Reflect.set(input.blocks.legacy.subBlocks.text, 'value', true)
    if (kind === 'object-value')
      Reflect.set(input.blocks.legacy.subBlocks.text, 'value', { secret: 'fictional' })
    if (kind === 'missing-enabled') Reflect.deleteProperty(input.loops.loop, 'enabled')
    if (kind === 'unknown-type') input.blocks.legacy.subBlocks.text.type = 'future-unknown-kind'
    if (kind === 'invalid-output')
      Reflect.set(input.blocks.legacy.outputs.structured.condition, 'value', { bad: true })
    if (kind === 'missing-and-value')
      Reflect.deleteProperty(input.blocks.legacy.outputs.structured.condition.and, 'value')
    const original = structuredClone(input)
    expect(() => decodeDiffWorkflowSnapshot(input)).toThrow(
      'The server snapshot is not representable by this editor. Synchronize before continuing.'
    )
    expect(input).toEqual(original)
  })
  it('preserves explicit undefined allowed by the native output condition without inventing a missing property', () => {
    const input = source()
    Reflect.set(input.blocks.legacy.outputs.structured.condition.and, 'value', undefined)
    const { draftRevision: _revision, ...expected } = input
    expect(decodeDiffWorkflowSnapshot(input)).toEqual(expected)
    const output = decodeDiffWorkflowSnapshot(input).blocks.legacy.outputs.structured
    if (typeof output === 'string' || !output.condition?.and)
      throw new Error('Expected structured output')
    expect(Object.hasOwn(output.condition.and, 'value')).toBe(true)
  })
  it('refuses silently stripped fields and explicit null handles instead of normalizing them', () => {
    const extra = source()
    Reflect.set(extra.blocks.legacy, 'unparsedExtension', { keep: true })
    expect(() => decodeDiffWorkflowSnapshot(extra)).toThrow('not representable')
    const edge = {
      id: 'e',
      source: 'legacy',
      target: 'legacy',
      sourceHandle: null,
      targetHandle: null,
    }
    expect(() => decodeDiffWorkflowSnapshot({ ...source(), edges: [edge] })).toThrow(
      'not representable'
    )
  })
  it('preserves the edge representation already validated by the actual GET contract', async () => {
    const { workflowStateResponseSchema } = await import('@/lib/api/contracts/workflows')
    const response = workflowStateResponseSchema.parse({
      ...source(),
      edges: [
        {
          id: 'second',
          source: 'legacy',
          target: 'legacy',
          sourceHandle: null,
          targetHandle: null,
          data: { order: [2, 1] },
        },
        { id: 'first', source: 'legacy', target: 'legacy', sourceHandle: 'x', targetHandle: 'y' },
      ],
    })
    const { draftRevision: _revision, ...expected } = response
    expect(decodeDiffWorkflowSnapshot(response)).toEqual(expected)
  })
})
