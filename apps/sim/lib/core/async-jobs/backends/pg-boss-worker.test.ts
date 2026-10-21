// Copyright 2026 Memlia. All rights reserved.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const ports = vi.hoisted(() => ({
  handler: undefined as
    | undefined
    | ((id: string, envelope: unknown, signal: AbortSignal) => Promise<unknown>),
  transaction: vi.fn(),
  claim: vi.fn(),
  guard: vi.fn(),
  finalize: vi.fn(),
  authority: vi.fn(),
  publication: vi.fn(),
  matched: vi.fn(),
  prepare: vi.fn(),
  run: vi.fn(),
  stop: vi.fn(),
  payload: { fixture: 'native-payload' },
  selected: 'pg-boss',
}))
vi.mock('../config', () => ({ getAsyncBackendType: () => ports.selected }))
vi.mock('@sim/db', () => ({ db: { transaction: ports.transaction } }))
vi.mock('./pg-boss-client', () => ({
  pgBossClient: {
    get: async () => ({
      work: async (handler: typeof ports.handler) => {
        ports.handler = handler
      },
    }),
    stop: ports.stop,
  },
}))
vi.mock('./pg-boss-delivery-reference', () => ({ resolvePgBossDeliveryReference: ports.matched }))
vi.mock('./pg-boss-admission', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pg-boss-admission')>()),
  readPgBossPublication: ports.publication,
}))
vi.mock('./pg-boss-claim', () => ({
  claimPgBossAttempt: ports.claim,
  guardPgBossAttempt: ports.guard,
}))
vi.mock('./pg-boss-finalize', () => ({ finalizePgBossAttempt: ports.finalize }))
vi.mock('./pg-boss-registry', () => ({ preparePgBossNativeRunner: ports.prepare }))
vi.mock('./pg-boss-workflow-session-authority', () => ({
  revalidatePgBossWorkflowSessionAuthority: ports.authority,
}))
import { startPgBossWorkflowWorker } from './pg-boss-worker'

function gate<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((a, b) => {
    resolve = a
    reject = b
  })
  return { promise, resolve, reject }
}
const envelope = { runner: 'workflow-execution' }
const reference = { nativeJobId: 'native-id', admissionDigest: 'fixture' }
const attempt = { jobId: 'native-id', token: 'private-attempt' }
const tx = { select: () => ({ from: () => ({ where: async () => [{ payload: ports.payload }] }) }) }
const deliver = (signal = new AbortController().signal) =>
  ports.handler!('native-id', envelope, signal)
beforeEach(() => {
  vi.resetAllMocks()
  ports.selected = 'pg-boss'
  ports.handler = undefined
  ports.transaction.mockImplementation(async (fn) => fn(tx))
  ports.matched.mockResolvedValue({ reference })
  ports.publication.mockResolvedValue({ status: 'pending', envelope, maxDurationSeconds: 1200 })
  ports.claim.mockResolvedValue({ kind: 'claimed', attempt })
  ports.guard.mockResolvedValue(true)
  ports.authority.mockResolvedValue({ kind: 'authority_checked' })
  ports.prepare.mockResolvedValue(ports.run)
  ports.run.mockResolvedValue({ success: true })
  ports.finalize.mockResolvedValue({ kind: 'finalized', status: 'completed' })
})
afterEach(() => vi.useRealTimers())
describe('worker composition: all persistence/runner ports doubled, not a PostgreSQL qualification', () => {
  it('waits for claim COMMIT before loading/running and finalization COMMIT before ACK', async () => {
    const claimed = gate<void>(),
      finished = gate<void>()
    let transactions = 0,
      acknowledged = false
    ports.transaction.mockImplementation(async (fn) => {
      const n = ++transactions,
        value = await fn(tx)
      if (n === 1) await claimed.promise
      if (n === 4) await finished.promise
      return value
    })
    const worker = await startPgBossWorkflowWorker()
    const delivery = deliver().then(() => {
      acknowledged = true
    })
    await vi.waitFor(() => expect(ports.claim).toHaveBeenCalledTimes(1))
    expect(ports.prepare).not.toHaveBeenCalled()
    expect(ports.run).not.toHaveBeenCalled()
    claimed.resolve()
    await vi.waitFor(() => expect(ports.finalize).toHaveBeenCalledTimes(1))
    expect(acknowledged).toBe(false)
    expect(ports.finalize.mock.calls[0][2]).toEqual({
      kind: 'returned',
      outputJson: '{"success":true}',
    })
    finished.resolve()
    await delivery
    expect(acknowledged).toBe(true)
    await worker.stop()
  })
  it('accepts the native successful output with absent optional metadata without changing the result', async () => {
    ports.run.mockResolvedValue({ success: true, output: { fixture: 1 }, metadata: undefined })
    const worker = await startPgBossWorkflowWorker()
    await expect(deliver()).resolves.toBeUndefined()
    expect(ports.finalize.mock.calls[0][2]).toEqual({
      kind: 'returned',
      outputJson: '{"output":{"fixture":1},"success":true}',
    })
    await worker.stop()
  })
  it('does not invoke a metadata getter or erase an unrelated undefined field', async () => {
    const getter = vi.fn(() => undefined)
    const output = { success: true }
    Object.defineProperty(output, 'metadata', { enumerable: true, get: getter })
    ports.run
      .mockResolvedValueOnce(output)
      .mockResolvedValueOnce({ success: true, other: undefined })
    const worker = await startPgBossWorkflowWorker()
    await expect(deliver()).rejects.toThrow('durable_workflow_reconciliation_required')
    await expect(deliver()).rejects.toThrow('durable_workflow_reconciliation_required')
    expect(getter).not.toHaveBeenCalled()
    expect(ports.finalize).not.toHaveBeenCalled()
    await worker.stop()
  })
  it('never starts on unknown claim COMMIT', async () => {
    ports.transaction.mockImplementationOnce(async (fn) => {
      await fn(tx)
      throw new Error('private-commit-cause')
    })
    const worker = await startPgBossWorkflowWorker()
    await expect(deliver()).rejects.toThrow()
    expect(ports.run).not.toHaveBeenCalled()
    expect(ports.finalize).not.toHaveBeenCalled()
    await worker.stop()
  })
  it('does not ACK an unknown result COMMIT or replay the effect', async () => {
    let count = 0
    ports.transaction.mockImplementation(async (fn) => {
      const value = await fn(tx)
      if (++count === 4) throw new Error('private-commit-cause')
      return value
    })
    const worker = await startPgBossWorkflowWorker()
    await expect(deliver()).rejects.toThrow('durable_workflow_reconciliation_required')
    expect(ports.run).toHaveBeenCalledTimes(1)
    await worker.stop()
  })
  it.each(['failed', 'completed', 'cancelled'])(
    'ACKs only verified terminal %s without a new authority/effect',
    async (status) => {
      ports.publication.mockResolvedValue({ status, envelope })
      ports.claim.mockResolvedValue({ kind: 'terminal', status })
      const worker = await startPgBossWorkflowWorker()
      await expect(deliver()).resolves.toBeUndefined()
      expect(ports.authority).not.toHaveBeenCalled()
      expect(ports.run).not.toHaveBeenCalled()
      await worker.stop()
    }
  )
  it('returns verified defer and leaves wake durability to transport', async () => {
    ports.claim.mockResolvedValue({ kind: 'defer', runAt: '2026-10-19T03:00:00.000Z' })
    const worker = await startPgBossWorkflowWorker()
    await expect(deliver()).resolves.toEqual({ kind: 'defer', runAt: '2026-10-19T03:00:00.000Z' })
    expect(ports.run).not.toHaveBeenCalled()
    expect(ports.finalize).not.toHaveBeenCalled()
    await worker.stop()
  })
  it('does not replay an already owned/uncertain attempt', async () => {
    ports.claim.mockResolvedValue({ kind: 'reconciliation_required' })
    const worker = await startPgBossWorkflowWorker()
    await expect(deliver()).rejects.toThrow('durable_workflow_reconciliation_required')
    expect(ports.run).not.toHaveBeenCalled()
    await worker.stop()
  })
  it.each([1, 2])('refuses revoked authority at native check %s', async (n) => {
    if (n === 1) ports.authority.mockRejectedValueOnce(new Error('revoked'))
    else ports.authority.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('revoked'))
    const worker = await startPgBossWorkflowWorker()
    await expect(deliver()).rejects.toThrow()
    expect(ports.run).not.toHaveBeenCalled()
    expect(ports.finalize).not.toHaveBeenCalled()
    await worker.stop()
  })
  it('keeps native business failure in returned output rather than inventing success', async () => {
    ports.run.mockResolvedValue({ success: false, error: 'fixture_failure' })
    ports.finalize.mockResolvedValue({ kind: 'finalized', status: 'failed' })
    const worker = await startPgBossWorkflowWorker()
    await deliver()
    expect(ports.finalize.mock.calls[0][2]).toEqual({
      kind: 'returned',
      outputJson: '{"error":"fixture_failure","success":false}',
    })
    await worker.stop()
  })
  it('leaves a thrown effect uncertain, without a failed receipt or retry', async () => {
    ports.run.mockRejectedValue(new Error('private-runner-cause'))
    const worker = await startPgBossWorkflowWorker()
    await expect(deliver()).rejects.toThrow('durable_workflow_reconciliation_required')
    expect(ports.run).toHaveBeenCalledTimes(1)
    expect(ports.finalize).not.toHaveBeenCalled()
    await worker.stop()
  })
  it('propagates cancellation during execution without stale finalization', async () => {
    const started = gate<AbortSignal>(),
      finished = gate<unknown>()
    ports.run.mockImplementation(async (signal) => {
      started.resolve(signal)
      return finished.promise
    })
    const worker = await startPgBossWorkflowWorker(),
      controller = new AbortController()
    const delivery = deliver(controller.signal)
    const outcome = expect(delivery).rejects.toThrow('durable_workflow_reconciliation_required')
    const signal = await started.promise
    controller.abort()
    expect(signal.aborted).toBe(true)
    finished.resolve({ success: true })
    await outcome
    expect(ports.finalize).not.toHaveBeenCalled()
    await worker.stop()
  })
  it('observes a lost native ownership fence and aborts the runner', async () => {
    const started = gate<AbortSignal>(),
      finished = gate<unknown>()
    ports.run.mockImplementation(async (signal) => {
      started.resolve(signal)
      return finished.promise
    })
    ports.guard.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValue(false)
    const worker = await startPgBossWorkflowWorker()
    const delivery = deliver()
    const outcome = expect(delivery).rejects.toThrow('durable_workflow_reconciliation_required')
    const signal = await started.promise
    await vi.waitFor(() => expect(signal.aborted).toBe(true), { timeout: 1000 })
    finished.resolve({ success: true })
    await outcome
    expect(ports.finalize).not.toHaveBeenCalled()
    await worker.stop()
  })
  it('does not activate from the transport flag alone', async () => {
    ports.selected = 'database'
    await expect(startPgBossWorkflowWorker()).rejects.toThrow(
      'durable_workflow_worker_not_selected'
    )
    expect(ports.handler).toBeUndefined()
  })
})
