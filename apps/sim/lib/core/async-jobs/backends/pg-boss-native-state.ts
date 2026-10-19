// Copyright 2026 Memlia. All rights reserved.
import type { JobQueueBackend } from '../types'
import { DatabaseJobQueue } from './database'

type NativeState = Pick<
  JobQueueBackend,
  'getJob' | 'cancelJob' | 'cancelByExecution' | 'cancelByWorkspace'
>

/** Persistence projection only: callers authorize access; no worker or admission is activated. */
export function createPgBossNativeState(): NativeState {
  const native = new DatabaseJobQueue()
  return {
    async getJob(id) {
      const job = await native.getJob(id)
      if (!job) return null
      // Never expose the durable envelope or attempt token through the job status surface.
      // Preserve native metadata (including nested application keys), output and legacy projection.
      const { memliaPgBossAdmission: _internal, ...metadata } = job.metadata
      return { ...job, metadata }
    },
    cancelJob: (id) => native.cancelJob(id),
    cancelByExecution: (binding, scope) => native.cancelByExecution(binding, scope),
    cancelByWorkspace: (id, options) => native.cancelByWorkspace(id, options),
  }
}
