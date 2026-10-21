// Copyright 2026 Memlia. All rights reserved.
import {
  AsyncJobEnqueueError,
  type EnqueueOptions,
  type ExecutionJobBinding,
  type ExecutionJobCancellationScope,
  type JobQueueBackend,
  type JobType,
  type WorkspaceJobCancellationOptions,
} from '../types'
import { createPgBossNativeState } from './pg-boss-native-state'
import {
  admitPgBossWorkflowAdmission,
  type PreparedPgBossWorkflowAdmission,
} from './pg-boss-workflow-admission'

function unsupported(): never {
  throw new AsyncJobEnqueueError('durable_workflow_operation_unsupported', {
    acceptance: 'rejected',
    retryable: false,
  })
}

/** No connection, closure or inline runner. Only the server-minted admission handle is accepted. */
export class PgBossJobQueue implements JobQueueBackend {
  private readonly state = createPgBossNativeState()

  async enqueue<TPayload>(
    type: JobType,
    payload: TPayload,
    options?: EnqueueOptions
  ): Promise<string> {
    if (type !== 'workflow-execution' || options !== undefined) unsupported()
    // This cast grants nothing: the native admission port checks its private WeakMap.
    // A payload-shaped object, copied handle or foreign instance is rejected before DB access.
    const result = await admitPgBossWorkflowAdmission(payload as PreparedPgBossWorkflowAdmission)
    return result.jobId
  }
  async batchEnqueue<TPayload>(
    _type: JobType,
    _items: Array<{ payload: TPayload; options?: EnqueueOptions }>
  ): Promise<string[]> {
    return unsupported()
  }
  async batchEnqueueAndWait<TPayload>(
    _type: JobType,
    _items: Array<{ payload: TPayload; options?: EnqueueOptions }>
  ): Promise<string[]> {
    return unsupported()
  }
  async startJob(_id: string): Promise<boolean> {
    return unsupported()
  }
  async completeJob(_id: string, _output: unknown): Promise<void> {
    return unsupported()
  }
  async markJobFailed(_id: string, _error: string): Promise<void> {
    return unsupported()
  }
  cancelByKey(_key: string): boolean {
    return unsupported()
  }
  getJob(id: string) {
    return this.state.getJob(id)
  }
  cancelJob(id: string) {
    return this.state.cancelJob(id)
  }
  cancelByExecution(binding: ExecutionJobBinding, scope: ExecutionJobCancellationScope) {
    return this.state.cancelByExecution(binding, scope)
  }
  cancelByWorkspace(id: string, options: WorkspaceJobCancellationOptions) {
    return this.state.cancelByWorkspace(id, options)
  }
}
