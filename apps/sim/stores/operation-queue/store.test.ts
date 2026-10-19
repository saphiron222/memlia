// Modified by Memlia: closed full replacement socket and retained-queue regression coverage.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerEmitFunctions, useOperationQueueStore } from '@/stores/operation-queue/store'
import type { QueuedOperation } from '@/stores/operation-queue/types'

describe('operation queue room gating', () => {
  beforeEach(() => {
    useOperationQueueStore.setState({
      operations: [],
      workflowOperationVersions: {},
      isProcessing: false,
      hasOperationError: false,
    })
    registerEmitFunctions(vi.fn(), vi.fn(), vi.fn(), null)
  })

  afterEach(() => {
    useOperationQueueStore.setState({
      operations: [],
      workflowOperationVersions: {},
      isProcessing: false,
      hasOperationError: false,
    })
    registerEmitFunctions(vi.fn(), vi.fn(), vi.fn(), null)
  })

  it('waits until the matching workflow is registered before emitting', () => {
    const workflowEmit = vi.fn()
    registerEmitFunctions(workflowEmit, vi.fn(), vi.fn(), null)

    useOperationQueueStore.getState().addToQueue({
      id: 'op-1',
      workflowId: 'workflow-a',
      userId: 'user-1',
      operation: {
        operation: 'update-name',
        target: 'block',
        payload: { id: 'block-1', name: 'Updated' },
      },
    })

    registerEmitFunctions(workflowEmit, vi.fn(), vi.fn(), 'workflow-b')
    expect(workflowEmit).not.toHaveBeenCalled()

    registerEmitFunctions(workflowEmit, vi.fn(), vi.fn(), 'workflow-a')
    expect(workflowEmit).toHaveBeenCalledWith(
      'workflow-a',
      'update-name',
      'block',
      { id: 'block-1', name: 'Updated' },
      'op-1'
    )

    useOperationQueueStore.getState().confirmOperation('op-1')
  })

  it('reverts the operation to pending without retrying when the emit is skipped', () => {
    const skippingEmit = vi.fn(() => false)
    registerEmitFunctions(skippingEmit, vi.fn(), vi.fn(), 'workflow-a')

    useOperationQueueStore.getState().addToQueue({
      id: 'op-1',
      workflowId: 'workflow-a',
      userId: 'user-1',
      operation: {
        operation: 'update-name',
        target: 'block',
        payload: { id: 'block-1', name: 'Updated' },
      },
    })

    expect(skippingEmit).toHaveBeenCalledTimes(1)

    const state = useOperationQueueStore.getState()
    expect(state.isProcessing).toBe(false)
    expect(state.hasOperationError).toBe(false)
    expect(state.operations).toEqual([
      expect.objectContaining({ id: 'op-1', status: 'pending', retryCount: 0 }),
    ])
  })

  it('emits a previously skipped operation once the room becomes joinable', () => {
    const skippingEmit = vi.fn(() => false)
    registerEmitFunctions(skippingEmit, vi.fn(), vi.fn(), 'workflow-a')

    useOperationQueueStore.getState().addToQueue({
      id: 'op-1',
      workflowId: 'workflow-a',
      userId: 'user-1',
      operation: {
        operation: 'update-name',
        target: 'block',
        payload: { id: 'block-1', name: 'Updated' },
      },
    })

    expect(skippingEmit).toHaveBeenCalledTimes(1)

    const sendingEmit = vi.fn(() => true)
    registerEmitFunctions(sendingEmit, vi.fn(), vi.fn(), 'workflow-a')

    expect(sendingEmit).toHaveBeenCalledWith(
      'workflow-a',
      'update-name',
      'block',
      { id: 'block-1', name: 'Updated' },
      'op-1'
    )
    expect(useOperationQueueStore.getState().operations).toEqual([
      expect.objectContaining({ id: 'op-1', status: 'processing' }),
    ])

    useOperationQueueStore.getState().confirmOperation('op-1')
  })

  it('triggers offline mode for a non-retryable failure and recovers via clearError', () => {
    registerEmitFunctions(
      vi.fn(() => true),
      vi.fn(),
      vi.fn(),
      'workflow-a'
    )

    useOperationQueueStore.getState().addToQueue({
      id: 'op-1',
      workflowId: 'workflow-a',
      userId: 'user-1',
      operation: {
        operation: 'update-name',
        target: 'block',
        payload: { id: 'block-1', name: 'Updated' },
      },
    })

    useOperationQueueStore.getState().failOperation('op-1', false)

    expect(useOperationQueueStore.getState().hasOperationError).toBe(true)
    expect(useOperationQueueStore.getState().operations).toEqual([])

    useOperationQueueStore.getState().clearError()

    expect(useOperationQueueStore.getState().hasOperationError).toBe(false)
  })

  it('coalesces pending subblock updates to the latest value for the same field', () => {
    useOperationQueueStore.getState().addToQueue({
      id: 'op-1',
      workflowId: 'workflow-a',
      userId: 'user-1',
      operation: {
        operation: 'subblock-update',
        target: 'subblock',
        payload: {
          blockId: 'block-1',
          subblockId: 'prompt',
          value: 'old value',
        },
      },
    })
    useOperationQueueStore.getState().addToQueue({
      id: 'op-2',
      workflowId: 'workflow-a',
      userId: 'user-1',
      operation: {
        operation: 'subblock-update',
        target: 'subblock',
        payload: {
          blockId: 'block-1',
          subblockId: 'prompt',
          value: 'new value',
        },
      },
    })

    expect(useOperationQueueStore.getState().operations).toEqual([
      expect.objectContaining({
        id: 'op-2',
        operation: expect.objectContaining({
          payload: expect.objectContaining({ value: 'new value' }),
        }),
      }),
    ])
  })

  it('supersedes pending tool updates with the latest value and canonical modes together', () => {
    const queue = useOperationQueueStore.getState()
    const toolsUpdate = (id: string, operation: string, value: string[]) =>
      queue.addToQueue({
        id,
        workflowId: 'workflow-a',
        userId: 'user-1',
        operation: {
          operation,
          target: 'subblock',
          payload: {
            blockId: 'agent-1',
            subblockId: 'tools',
            value,
            ...(operation === 'subblock-update-with-canonical-modes' && {
              canonicalModes: { [`${value.indexOf('a')}:projectId`]: 'advanced' },
            }),
          },
        },
      })

    toolsUpdate('op-1', 'subblock-update', ['a', 'b'])
    toolsUpdate('op-2', 'subblock-update-with-canonical-modes', ['b', 'a'])
    toolsUpdate('op-3', 'subblock-update-with-canonical-modes', ['a', 'b'])

    expect(useOperationQueueStore.getState().operations).toEqual([
      expect.objectContaining({
        id: 'op-3',
        operation: expect.objectContaining({
          payload: expect.objectContaining({
            value: ['a', 'b'],
            canonicalModes: { '0:projectId': 'advanced' },
          }),
        }),
      }),
    ])

    toolsUpdate('op-4', 'subblock-update', ['a', 'b', 'c'])

    expect(useOperationQueueStore.getState().operations.map((op) => op.id)).toEqual([
      'op-3',
      'op-4',
    ])
  })

  it('does not coalesce matching subblock updates across workflows', () => {
    useOperationQueueStore.getState().addToQueue({
      id: 'op-1',
      workflowId: 'workflow-a',
      userId: 'user-1',
      operation: {
        operation: 'subblock-update',
        target: 'subblock',
        payload: {
          blockId: 'block-1',
          subblockId: 'prompt',
          value: 'workflow a value',
        },
      },
    })
    useOperationQueueStore.getState().addToQueue({
      id: 'op-2',
      workflowId: 'workflow-b',
      userId: 'user-1',
      operation: {
        operation: 'subblock-update',
        target: 'subblock',
        payload: {
          blockId: 'block-1',
          subblockId: 'prompt',
          value: 'workflow b value',
        },
      },
    })

    expect(useOperationQueueStore.getState().operations).toEqual([
      expect.objectContaining({
        id: 'op-1',
        workflowId: 'workflow-a',
      }),
      expect.objectContaining({
        id: 'op-2',
        workflowId: 'workflow-b',
      }),
    ])
  })

  it('coalesces variable field updates without dropping unrelated fields', () => {
    useOperationQueueStore.getState().addToQueue({
      id: 'op-1',
      workflowId: 'workflow-a',
      userId: 'user-1',
      operation: {
        operation: 'variable-update',
        target: 'variable',
        payload: {
          variableId: 'variable-1',
          field: 'value',
          value: 'old value',
        },
      },
    })
    useOperationQueueStore.getState().addToQueue({
      id: 'op-2',
      workflowId: 'workflow-a',
      userId: 'user-1',
      operation: {
        operation: 'variable-update',
        target: 'variable',
        payload: {
          variableId: 'variable-1',
          field: 'name',
          value: 'Variable Name',
        },
      },
    })
    useOperationQueueStore.getState().addToQueue({
      id: 'op-3',
      workflowId: 'workflow-a',
      userId: 'user-1',
      operation: {
        operation: 'variable-update',
        target: 'variable',
        payload: {
          variableId: 'variable-1',
          field: 'value',
          value: 'new value',
        },
      },
    })

    expect(useOperationQueueStore.getState().operations).toEqual([
      expect.objectContaining({
        id: 'op-2',
        operation: expect.objectContaining({
          payload: expect.objectContaining({ field: 'name', value: 'Variable Name' }),
        }),
      }),
      expect.objectContaining({
        id: 'op-3',
        operation: expect.objectContaining({
          payload: expect.objectContaining({ field: 'value', value: 'new value' }),
        }),
      }),
    ])
  })

  it('waits for matching workflow operations to drain', async () => {
    useOperationQueueStore.getState().addToQueue({
      id: 'op-1',
      workflowId: 'workflow-a',
      userId: 'user-1',
      operation: {
        operation: 'update-name',
        target: 'block',
        payload: { id: 'block-1', name: 'Updated' },
      },
    })

    const drained = useOperationQueueStore.getState().waitForWorkflowOperations('workflow-a')
    useOperationQueueStore.getState().confirmOperation('op-1')

    await expect(drained).resolves.toBe('drained')
  })
})

describe('retained legacy workflow replacement', () => {
  const replacement = {
    operation: 'replace-state',
    target: 'workflow',
    payload: { state: { intent: 'keep' } },
  }
  const delta = {
    operation: 'update-name',
    target: 'block',
    payload: { id: 'block-1', name: 'Updated' },
  }
  const add = (
    id: string,
    workflowId = 'a',
    operation: QueuedOperation['operation'] = replacement
  ) =>
    useOperationQueueStore.getState().addToQueue({ id, workflowId, userId: 'fixture', operation })
  beforeEach(() => {
    vi.useFakeTimers()
    useOperationQueueStore.getState().reset()
  })
  afterEach(() => {
    useOperationQueueStore.getState().reset()
    vi.useRealTimers()
  })

  it('holds pending replacements before emit and lets another workflow drain', async () => {
    const emit = vi.fn(() => true)
    registerEmitFunctions(emit, emit, emit, 'a')
    add('a-replace')
    const held = useOperationQueueStore.getState().operations[0]
    expect(held).toMatchObject({
      status: 'failed',
      failureCode: 'WORKFLOW_REPLACE_REQUIRES_CAS',
      retryCount: 0,
    })
    expect(held.operation).toBe(replacement)
    expect(emit).not.toHaveBeenCalled()
    expect(useOperationQueueStore.getState().hasOperationError).toBe(false)
    await expect(useOperationQueueStore.getState().waitForWorkflowOperations('a')).resolves.toBe(
      'failed'
    )
    add('b-delta', 'b', delta)
    registerEmitFunctions(emit, emit, emit, 'b')
    expect(emit).toHaveBeenCalledTimes(1)
    useOperationQueueStore.getState().confirmOperation('a-replace')
    expect(useOperationQueueStore.getState().isProcessing).toBe(true)
    useOperationQueueStore.getState().confirmOperation('unknown')
    expect(useOperationQueueStore.getState().isProcessing).toBe(true)
    useOperationQueueStore.getState().confirmOperation('b-delta')
    expect(useOperationQueueStore.getState().operations).toEqual([held])
    await expect(useOperationQueueStore.getState().waitForWorkflowOperations('b')).resolves.toBe(
      'drained'
    )
  })

  it.each(['timeout', 'legacy failure', 'register'] as const)(
    'retains inherited processing intent on %s without retry',
    (path) => {
      add('old')
      useOperationQueueStore.setState((s) => ({
        operations: s.operations.map((op) => ({
          ...op,
          status: 'processing',
          failureCode: undefined,
          retryCount: 2,
        })),
        isProcessing: true,
      }))
      if (path === 'timeout') useOperationQueueStore.getState().handleOperationTimeout('old')
      if (path === 'legacy failure') useOperationQueueStore.getState().failOperation('old', false)
      const emit = vi.fn(() => true)
      registerEmitFunctions(emit, emit, emit, 'a')
      vi.advanceTimersByTime(60000)
      expect(emit).not.toHaveBeenCalled()
      expect(useOperationQueueStore.getState().operations).toMatchObject([
        {
          id: 'old',
          status: 'failed',
          retryCount: 2,
          failureCode: 'WORKFLOW_REPLACE_REQUIRES_CAS',
        },
      ])
      expect(useOperationQueueStore.getState().hasOperationError).toBe(false)
    }
  )

  it('preserves all blocked intentions through coalescing, cancellation, offline clear and late messages', () => {
    add('held')
    const edit = {
      operation: 'subblock-update',
      target: 'subblock',
      payload: { blockId: 'block-1', subblockId: 'prompt', value: 'one' },
    }
    add('edit-1', 'a', edit)
    add('edit-2', 'a', { ...edit, payload: { ...edit.payload, value: 'two' } })
    add('edit-3', 'a', edit)
    add('variable', 'a', {
      operation: 'variable-update',
      target: 'variable',
      payload: { variableId: 'v', field: 'value', value: 'x' },
    })
    const retained = useOperationQueueStore.getState().operations
    expect(retained.map((op) => op.id)).toEqual(['held', 'edit-1', 'edit-2', 'edit-3', 'variable'])
    const q = useOperationQueueStore.getState()
    q.cancelOperationsForBlock('block-1')
    q.cancelOperationsForVariable('v')
    q.cancelOperationsForWorkflow('a')
    q.confirmOperation('edit-1')
    q.failOperation('edit-2', false)
    q.handleOperationTimeout('variable')
    q.triggerOfflineMode()
    q.clearError()
    expect(useOperationQueueStore.getState().operations).toEqual(retained)
    q.reset()
    expect(useOperationQueueStore.getState().operations).toEqual([])
  })

  it('holds a late A refusal while B is processing without freeing B or retrying A', () => {
    const emit = vi.fn(() => true)
    add('a-replace')
    add('b-first', 'b', delta)
    add('b-second', 'b', { ...delta, payload: { id: 'block-2', name: 'Second' } })
    registerEmitFunctions(emit, emit, emit, 'b')
    // Simulate an old in-flight A snapshot inherited during B's active turn.
    useOperationQueueStore.setState((s) => ({
      operations: s.operations.map((op) =>
        op.id === 'a-replace'
          ? { ...op, status: 'processing', failureCode: undefined, retryCount: 2 }
          : op
      ),
    }))
    const a = useOperationQueueStore.getState().operations[0]
    const q = useOperationQueueStore.getState()
    expect(q.retainRejectedWorkflowReplacement('a-replace')).toBe('a')
    q.handleOperationTimeout('a-replace')
    q.confirmOperation('a-replace')
    q.cancelOperationsForWorkflow('a')
    registerEmitFunctions(emit, emit, emit, 'a')
    registerEmitFunctions(emit, emit, emit, 'b')
    expect(emit).toHaveBeenCalledTimes(1)
    expect(useOperationQueueStore.getState().isProcessing).toBe(true)
    expect(useOperationQueueStore.getState().operations[0]).toMatchObject({
      ...a,
      status: 'failed',
      failureCode: 'WORKFLOW_REPLACE_REQUIRES_CAS',
    })
    q.confirmOperation('b-first')
    expect(emit).toHaveBeenCalledTimes(2)
    q.failOperation('b-second', false)
    expect(useOperationQueueStore.getState().operations.map((op) => op.id)).toEqual(['a-replace'])
    q.clearError()
    registerEmitFunctions(emit, emit, emit, 'a')
    expect(emit).toHaveBeenCalledTimes(2)
  })

  it('stops timers of frozen processing deltas without fabricating a pending or acknowledged state', () => {
    const emit = vi.fn(() => true)
    registerEmitFunctions(emit, emit, emit, 'a')
    add('a-delta', 'a', delta)
    const inFlight = useOperationQueueStore.getState().operations[0]
    add('a-replace')
    add('b-delta', 'b', delta)
    registerEmitFunctions(emit, emit, emit, 'b')
    useOperationQueueStore.getState().confirmOperation('b-delta')
    vi.advanceTimersByTime(60000)
    expect(useOperationQueueStore.getState().operations[0]).toBe(inFlight)
    expect(inFlight.status).toBe('processing')
    expect(emit).toHaveBeenCalledTimes(2)
    expect(useOperationQueueStore.getState().hasOperationError).toBe(false)
    expect(useOperationQueueStore.getState().isProcessing).toBe(false)
  })

  it('settles an existing drain waiter as failed when the replacement arrives', async () => {
    add('delta', 'a', delta)
    const waiting = useOperationQueueStore.getState().waitForWorkflowOperations('a')
    add('held')
    await expect(waiting).resolves.toBe('failed')
    expect(useOperationQueueStore.getState().hasPendingOperations('a')).toBe(true)
  })

  it('does not correlate a replacement refusal to a different operation', () => {
    add('delta', 'a', delta)
    const original = useOperationQueueStore.getState().operations
    expect(useOperationQueueStore.getState().retainRejectedWorkflowReplacement('delta')).toBeNull()
    expect(
      useOperationQueueStore.getState().retainRejectedWorkflowReplacement('unknown')
    ).toBeNull()
    expect(useOperationQueueStore.getState().operations).toBe(original)
  })
})
