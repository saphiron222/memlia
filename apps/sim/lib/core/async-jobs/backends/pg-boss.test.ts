// Copyright 2026 Memlia. All rights reserved.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JobType } from '../types'
const native = vi.hoisted(() => ({
  admit: vi.fn(),
  getJob: vi.fn(),
  cancelJob: vi.fn(),
  cancelByExecution: vi.fn(),
  cancelByWorkspace: vi.fn(),
}))
vi.mock('./pg-boss-native-state', () => ({ createPgBossNativeState: () => native }))
vi.mock('./pg-boss-workflow-admission', () => ({ admitPgBossWorkflowAdmission: native.admit }))
import { PgBossJobQueue } from './pg-boss'
beforeEach(() => vi.resetAllMocks())
describe('queue adapter, persistence ports doubled', () => {
  const unsupported: JobType[] = [
    'slack-search',
    'schedule-execution',
    'webhook-execution',
    'quickbooks-webhook-ingress',
    'resume-execution',
    'workflow-group-cell',
    'cleanup-logs',
    'cleanup-soft-deletes',
    'cleanup-table-row-ttl',
    'cleanup-stale-executions',
    'cleanup-tasks',
    'cleanup-file-versions',
    'cleanup-dispatch',
    'knowledge-connector-directory-sync',
    'run-data-drain',
  ]
  it.each(unsupported)('rejects %s before durable admission', async (type) => {
    await expect(new PgBossJobQueue().enqueue(type, {})).rejects.toMatchObject({
      acceptance: 'rejected',
      retryable: false,
    })
    expect(native.admit).not.toHaveBeenCalled()
  })
  it('forwards only the opaque handle to native COMMIT admission', async () => {
    const handle = Object.freeze({ kind: 'prepared_workflow_admission' })
    native.admit.mockResolvedValue({ kind: 'admission_committed', jobId: 'native-id' })
    await expect(new PgBossJobQueue().enqueue('workflow-execution', handle)).resolves.toBe(
      'native-id'
    )
    expect(native.admit).toHaveBeenCalledExactlyOnceWith(handle)
  })
  it('refuses options, closures, batch and unowned native finalization', async () => {
    const queue = new PgBossJobQueue(),
      runner = vi.fn()
    await expect(queue.enqueue('workflow-execution', {}, { runner })).rejects.toThrow('unsupported')
    await expect(queue.batchEnqueue('workflow-execution', [])).rejects.toThrow('unsupported')
    await expect(queue.batchEnqueueAndWait('workflow-execution', [])).rejects.toThrow('unsupported')
    await expect(queue.startJob('id')).rejects.toThrow('unsupported')
    await expect(queue.completeJob('id', {})).rejects.toThrow('unsupported')
    await expect(queue.markJobFailed('id', 'text')).rejects.toThrow('unsupported')
    expect(() => queue.cancelByKey('key')).toThrow('unsupported')
    expect(runner).not.toHaveBeenCalled()
    expect(native.admit).not.toHaveBeenCalled()
  })
  it('reuses native state and cancellation ports without broadening their scope', async () => {
    const queue = new PgBossJobQueue(),
      binding = { workflowId: 'workflow', executionId: 'execution' },
      options = { maxRuns: 10 }
    await queue.getJob('id')
    await queue.cancelJob('id')
    await queue.cancelByExecution(binding, 'standalone')
    await queue.cancelByWorkspace('workspace', options)
    expect(native.getJob).toHaveBeenCalledExactlyOnceWith('id')
    expect(native.cancelJob).toHaveBeenCalledExactlyOnceWith('id')
    expect(native.cancelByExecution).toHaveBeenCalledExactlyOnceWith(binding, 'standalone')
    expect(native.cancelByWorkspace).toHaveBeenCalledExactlyOnceWith('workspace', options)
  })
})
