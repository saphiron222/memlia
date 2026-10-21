// Copyright (c) 2026 Memlia. All rights reserved.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  worker: vi.fn(),
  abort: vi.fn(),
  wait: vi.fn(),
  release: vi.fn(),
  settle: vi.fn(),
  sandbox: vi.fn(),
  ring: vi.fn(),
}))
vi.mock('@/lib/core/config/redis', () => ({
  getRedisClient: () => null,
  acquireLock: vi.fn(),
  extendLock: vi.fn(),
  releaseLock: vi.fn(),
}))
vi.mock('@/lib/mothership/request/session/buffer', () => ({
  writeAbortMarker: vi.fn(async () => undefined),
  clearAbortMarker: vi.fn(async () => undefined),
  hasAbortMarker: vi.fn(async () => false),
  refreshBufferTtl: vi.fn(async () => undefined),
}))
vi.mock('@/lib/mothership/request/session/explicit-abort', () => ({
  requestExplicitStreamAbort: mocks.worker,
}))
vi.mock('@/lib/mothership/request/session', () => ({
  abortActiveStream: mocks.abort,
  waitForPendingChatStream: mocks.wait,
  releasePendingChatStream: mocks.release,
}))
vi.mock('@/lib/mothership/async-runs/orphaned-runs', () => ({
  settleStoppedRunWithoutController: mocks.settle,
}))
vi.mock('@/lib/mothership/request/tools/sandbox-recovery', () => ({
  recoverSandboxProcesses: mocks.sandbox,
}))
vi.mock('@/lib/desktop/executor/doorbell', () => ({ ringDesktopInbox: mocks.ring }))

import { deliverRunStop } from './stop-delivery'

const run = { id: 'run', streamId: 'stream', userId: 'user', chatId: 'chat', desktopDeviceId: null }
const work = { clientWorkflowExecutionIds: [], sandboxProcesses: [] }
beforeEach(() => {
  vi.resetAllMocks()
  mocks.worker.mockResolvedValue({ settled: true })
  mocks.abort.mockResolvedValue(true)
  mocks.wait.mockResolvedValue(true)
  mocks.settle.mockResolvedValue(undefined)
})
describe('persistent local stop routing', () => {
  it('preserves historical worker signaling', async () => {
    expect(await deliverRunStop(run, work)).toEqual({ settled: true, workerSettled: true })
    expect(mocks.worker).toHaveBeenCalledOnce()
  })
  it('uses the real native AbortController registry with Redis and buffer persistence doubled', async () => {
    const native = await vi.importActual<typeof import('@/lib/mothership/request/session/abort')>(
      '@/lib/mothership/request/session/abort'
    )
    const buffer = await import('@/lib/mothership/request/session/buffer')
    const controller = new AbortController()
    const streamId = 'owned-local-stop-fixture'
    native.registerActiveStream(streamId, controller)
    mocks.abort.mockImplementation(native.abortActiveStream)
    mocks.wait.mockImplementation(native.waitForPendingChatStream)
    try {
      const result = await deliverRunStop({ ...run, streamId, executionKind: 'local' }, work)
      expect(controller.signal.aborted).toBe(true)
      expect(result.localControllerStopped).toBe(true)
      expect(result.workerSettled).toBe(false)
      expect(mocks.worker).not.toHaveBeenCalled()
      expect(await native.abortActiveStream(streamId)).toBe(false)
    } finally {
      native.unregisterActiveStream(streamId, controller)
      await buffer.clearAbortMarker(streamId)
    }
  })
  it('stops the observed local controller without contacting a worker', async () => {
    expect(await deliverRunStop({ ...run, executionKind: 'local' }, work)).toEqual({
      settled: true,
      workerSettled: false,
      localControllerStopped: true,
    })
    expect(mocks.worker).not.toHaveBeenCalled()
    expect(mocks.abort).toHaveBeenCalledWith('stream')
    expect(mocks.settle).toHaveBeenCalledWith('run')
  })
  it.each([false, undefined])(
    'does not claim the missing local controller cancelled its effect',
    async (fired) => {
      mocks.abort.mockResolvedValue(fired)
      const result = await deliverRunStop({ ...run, executionKind: 'local' }, work)
      expect(result.localControllerStopped).toBe(false)
      expect(result.workerSettled).toBe(false)
      expect(mocks.worker).not.toHaveBeenCalled()
    }
  )
  it('keeps abort failure and unknown marker unconfirmed without worker fallback', async () => {
    mocks.abort.mockRejectedValue(new Error('fixture'))
    const result = await deliverRunStop({ ...run, executionKind: 'unavailable' }, work)
    expect(result.localControllerStopped).toBe(false)
    expect(result.workerSettled).toBe(false)
    expect(mocks.worker).not.toHaveBeenCalled()
    expect(mocks.settle).toHaveBeenCalledWith('run')
  })
  it('does not mistake force-released lock for stopped local controller', async () => {
    mocks.wait.mockResolvedValue(false)
    const result = await deliverRunStop({ ...run, executionKind: 'local' }, work)
    expect(result.settled).toBe(false)
    expect(result.localControllerStopped).toBe(false)
    expect(mocks.release).toHaveBeenCalledWith('chat', 'stream')
    expect(mocks.worker).not.toHaveBeenCalled()
  })
})
