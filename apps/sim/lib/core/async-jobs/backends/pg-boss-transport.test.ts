// Copyright 2026 Memlia. All rights reserved.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { JobEnvelopeSchema } from '@memlia/contracts'
import { PgBossTransport } from './pg-boss-transport'

// Only pg-boss IO is doubled. These tests do not qualify PostgreSQL durability.
const io = vi.hoisted(() => ({
  send: vi.fn(),
  getJobById: vi.fn(),
  handler: undefined as undefined | ((jobs: unknown[]) => Promise<void>),
}))
vi.mock('pg-boss', () => ({
  PgBoss: class {
    on() {}
    async start() {}
    async createQueue() {}
    send = io.send
    getJobById = io.getJobById
    async work(_name: string, _options: unknown, handler: (jobs: unknown[]) => Promise<void>) {
      io.handler = handler
    }
    async offWork() {}
    async stop() {}
  },
}))
const envelope = JobEnvelopeSchema.parse({
  schemaVersion: 'memlia.job/v1',
  commandId: 'command-fixture',
  runId: 'run-fixture',
  runner: 'workflow-execution',
  inputs: [],
  idempotencyKey: 'idem-fixture',
  submittedAt: '2026-10-19T03:00:00.000Z',
  effectPolicy: { kind: 'no_automatic_retry' },
  authority: {
    schemaVersion: 'memlia.principal/v1',
    organizationId: 'org-fixture',
    workspaceId: 'workspace-fixture',
    actor: {
      version: 1,
      principal: { kind: 'session', userId: 'user-fixture', sessionId: 'session-fixture' },
    },
    subject: { kind: 'user', userId: 'user-fixture' },
    authority: { kind: 'interactive' },
    scopes: ['workflow:read'],
    allowedTools: ['workflows.read'],
  },
})

const schedule = { runAt: '2026-10-19T03:00:00.000Z', maxDurationSeconds: 1200 }
const connect = () =>
  PgBossTransport.connect({
    connectionString: 'fixture',
    schema: 'memlia_jobs',
    queueName: 'memlia_native',
    onError: () => {},
  })
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((a, b) => {
    resolve = a
    reject = b
  })
  return { promise, resolve, reject }
}
beforeEach(() => {
  vi.resetAllMocks()
  io.handler = undefined
  io.send.mockImplementation(async (_name, _data, options) => options.id)
})
describe('durable workflow scheduling, transport IO doubled', () => {
  it('uses immutable native startAfter and a lease longer than the native execution cap', async () => {
    const transport = await connect()
    await transport.publish('native-job', envelope, schedule)
    expect(io.send.mock.calls[0][2]).toMatchObject({
      startAfter: schedule.runAt,
      expireInSeconds: 1260,
      retryLimit: 0,
    })
    await transport.stop()
  })
  it('does not ACK defer until the deterministic replacement is confirmed', async () => {
    const transport = await connect()
    await transport.publish('native-job', envelope, schedule)
    const initial = io.send.mock.calls[0]
    await transport.work(async () => ({ kind: 'defer', runAt: schedule.runAt }))
    const gate = deferred<string>()
    io.send.mockReturnValueOnce(gate.promise)
    let acknowledged = false
    const delivery = io.handler!([
      { id: initial[2].id, data: initial[1], signal: new AbortController().signal },
    ]).then(() => {
      acknowledged = true
    })
    await vi.waitFor(() => expect(io.send).toHaveBeenCalledTimes(2))
    expect(acknowledged).toBe(false)
    const wake = io.send.mock.calls[1]
    expect(wake[2].id).not.toBe(initial[2].id)
    expect(wake[2].startAfter).toBe(schedule.runAt)
    expect(wake[1].envelope).toEqual(envelope)
    gate.resolve(wake[2].id)
    await delivery
    expect(acknowledged).toBe(true)
    await transport.stop()
  })
  it('does not ACK an unknown wake publication and never retries the business handler', async () => {
    const transport = await connect()
    await transport.publish('native-job', envelope, schedule)
    const initial = io.send.mock.calls[0]
    const handler = vi.fn(async () => ({ kind: 'defer' as const, runAt: schedule.runAt }))
    await transport.work(handler)
    io.send.mockRejectedValueOnce(new Error('private-driver-cause'))
    await expect(
      io.handler!([{ id: initial[2].id, data: initial[1], signal: new AbortController().signal }])
    ).rejects.toMatchObject({ code: 'delivery_failed_reconciliation_required' })
    expect(handler).toHaveBeenCalledTimes(1)
    expect(io.send).toHaveBeenCalledTimes(2)
    await transport.stop()
  })
  it('refuses a changed runAt instead of accepting a caller supplied new schedule', async () => {
    const transport = await connect()
    await transport.publish('native-job', envelope, schedule)
    const initial = io.send.mock.calls[0]
    await transport.work(async () => ({ kind: 'defer', runAt: '2027-01-01T00:00:00.000Z' }))
    await expect(
      io.handler!([{ id: initial[2].id, data: initial[1], signal: new AbortController().signal }])
    ).rejects.toMatchObject({ code: 'delivery_failed_reconciliation_required' })
    expect(io.send).toHaveBeenCalledTimes(1)
    await transport.stop()
  })
  it('preserves native unscheduled send options when no schedule is supplied', async () => {
    const transport = await connect()
    await transport.publish('native-job', envelope)
    expect(Object.keys(io.send.mock.calls[0][2]).sort()).toEqual([
      'deleteAfterSeconds',
      'id',
      'retryLimit',
    ])
    await transport.stop()
  })
  it('deduplicates the same durable wake after a lost first ACK', async () => {
    const transport = await connect()
    await transport.publish('native-job', envelope, schedule)
    const initial = io.send.mock.calls[0]
    await transport.work(async () => ({ kind: 'defer', runAt: schedule.runAt }))
    const delivery = () =>
      io.handler!([{ id: initial[2].id, data: initial[1], signal: new AbortController().signal }])
    await delivery()
    const wake = io.send.mock.calls[1]
    io.send.mockResolvedValueOnce(null)
    io.getJobById.mockResolvedValueOnce({ data: wake[1], state: 'created' })
    await delivery()
    expect(io.send.mock.calls[2][2].id).toBe(wake[2].id)
    expect(io.getJobById).toHaveBeenCalledTimes(1)
    await transport.stop()
  })
  it.each(['failed', 'cancelled'])('does not ACK an existing %s wake', async (state) => {
    const transport = await connect()
    await transport.publish('native-job', envelope, schedule)
    const initial = io.send.mock.calls[0]
    await transport.work(async () => ({ kind: 'defer', runAt: schedule.runAt }))
    io.send.mockImplementationOnce(async (_name, data) => {
      io.getJobById.mockResolvedValueOnce({ data, state })
      return null
    })
    await expect(
      io.handler!([{ id: initial[2].id, data: initial[1], signal: new AbortController().signal }])
    ).rejects.toMatchObject({ code: 'delivery_failed_reconciliation_required' })
    await transport.stop()
  })
  it('refuses a premature wake without creating a third delivery', async () => {
    const transport = await connect()
    await transport.publish('native-job', envelope, schedule)
    const initial = io.send.mock.calls[0]
    await transport.work(async () => ({ kind: 'defer', runAt: schedule.runAt }))
    await io.handler!([
      { id: initial[2].id, data: initial[1], signal: new AbortController().signal },
    ])
    const wake = io.send.mock.calls[1]
    await expect(
      io.handler!([{ id: wake[2].id, data: wake[1], signal: new AbortController().signal }])
    ).rejects.toMatchObject({ code: 'delivery_failed_reconciliation_required' })
    expect(io.send).toHaveBeenCalledTimes(2)
    await transport.stop()
  })
  it('does not run an expired delivery or acknowledge abort after the handler returns', async () => {
    const transport = await connect()
    await transport.publish('native-job', envelope, schedule)
    const initial = io.send.mock.calls[0]
    const controller = new AbortController()
    const handler = vi.fn(async () => {
      controller.abort()
    })
    await transport.work(handler)
    const delivery = () =>
      io.handler!([{ id: initial[2].id, data: initial[1], signal: controller.signal }])
    await expect(delivery()).rejects.toMatchObject({
      code: 'delivery_failed_reconciliation_required',
    })
    await expect(delivery()).rejects.toMatchObject({
      code: 'delivery_failed_reconciliation_required',
    })
    expect(handler).toHaveBeenCalledTimes(1)
    await transport.stop()
  })
  it('accepts the exact native 24h expiration boundary including grace', async () => {
    const transport = await connect()
    await transport.publish('native-job', envelope, { ...schedule, maxDurationSeconds: 86_340 })
    expect(io.send.mock.calls[0][2].expireInSeconds).toBe(86_400)
    await transport.stop()
  })
  it.each([0, 4, 1.5, Infinity, 86_341, 2_147_483_588])(
    'rejects invalid cap %s before transport IO',
    async (cap) => {
      const transport = await connect()
      await expect(
        transport.publish('native-job', envelope, { ...schedule, maxDurationSeconds: cap })
      ).rejects.toMatchObject({ code: 'invalid_delivery_schedule' })
      expect(io.send).not.toHaveBeenCalled()
      await transport.stop()
    }
  )
})
