// Copyright 2026 Memlia. All rights reserved.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({
  provider: 'database',
  task: false,
  database: vi.fn(),
  durable: vi.fn(),
}))
vi.mock('@trigger.dev/core/v3', () => ({
  taskContext: {
    get isInsideTask() {
      return state.task
    },
  },
}))
vi.mock('@/lib/core/config/env-capabilities.server', () => ({
  getConfiguredAsyncJobsProvider: () => state.provider,
}))
vi.mock('@/lib/core/async-jobs/backends/database', () => ({
  DatabaseJobQueue: class {
    constructor() {
      state.database()
    }
  },
}))
vi.mock('@/lib/core/async-jobs/backends/pg-boss', () => ({
  PgBossJobQueue: class {
    constructor() {
      state.durable()
    }
  },
}))
import {
  getAsyncBackendType,
  getInlineJobQueue,
  getJobQueue,
  resetJobQueueCache,
  shouldExecuteInline,
} from './config'
beforeEach(() => {
  resetJobQueueCache()
  state.provider = 'database'
  state.task = false
  vi.clearAllMocks()
  vi.stubEnv('MEMLIA_DURABLE_WORKFLOWS_ENABLED', undefined)
})
afterEach(() => vi.unstubAllEnvs())
describe('explicit native backend selection', () => {
  it('preserves database default and native Trigger worker selection', async () => {
    expect(shouldExecuteInline()).toBe(true)
    await getJobQueue()
    expect(state.database).toHaveBeenCalledTimes(1)
    state.task = true
    expect(getAsyncBackendType()).toBe('trigger-dev')
  })
  it('constructs only durable backend and rejects forced inline', async () => {
    vi.stubEnv('MEMLIA_DURABLE_WORKFLOWS_ENABLED', '1')
    state.provider = 'pg-boss'
    expect(shouldExecuteInline()).toBe(false)
    await getJobQueue()
    await expect(getInlineJobQueue()).rejects.toThrow('durable_workflow_inline_unsupported')
    expect(state.durable).toHaveBeenCalledTimes(1)
    expect(state.database).not.toHaveBeenCalled()
  })
  it('does not reuse a cached inline backend after durable selection', async () => {
    await getInlineJobQueue()
    vi.stubEnv('MEMLIA_DURABLE_WORKFLOWS_ENABLED', '1')
    state.provider = 'pg-boss'
    await expect(getInlineJobQueue()).rejects.toThrow('durable_workflow_inline_unsupported')
  })
  it('refuses mixed backend cache and explicit selection within Trigger', async () => {
    await getJobQueue()
    state.provider = 'pg-boss'
    vi.stubEnv('MEMLIA_DURABLE_WORKFLOWS_ENABLED', '1')
    await expect(getJobQueue()).rejects.toThrow('async_backend_configuration_changed')
    state.task = true
    expect(getAsyncBackendType).toThrow('durable_workflow_backend_conflict')
  })
})
