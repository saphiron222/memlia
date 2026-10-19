// Copyright (c) 2026 Memlia. All rights reserved.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { PgBoss } from 'pg-boss'
import { JobEnvelopeSchema } from '@memlia/contracts'
import { PgBossTransport } from './pg-boss-transport.ts'

// Only the explicitly supplied, dedicated development secret is read. Never print it.
const envFile = process.env.MEMLIA_QUEUE_TEST_ENV_FILE
if (!envFile) throw new Error('MEMLIA_QUEUE_TEST_ENV_FILE is required')
const password = readFileSync(envFile, 'utf8').split('\n')
  .find((line) => line.startsWith('POSTGRES_PASSWORD='))?.slice('POSTGRES_PASSWORD='.length)
if (!password) throw new Error('Dedicated PostgreSQL test password missing')
const connectionString = `postgresql://memlia:${encodeURIComponent(password)}@127.0.0.1:15432/memlia_development`
const schema = `queue_${randomUUID().replaceAll('-', '')}`
const queueName = 'memlia-transport'
const notices: string[] = []
const options = { connectionString, schema, queueName, onError: (code: string) => notices.push(code) }
const envelope = JobEnvelopeSchema.parse({
  schemaVersion: 'memlia.job/v1', commandId: 'command-fixture', runId: 'run-fixture',
  runner: 'workflow-execution', inputs: [], idempotencyKey: 'idem-fixture',
  submittedAt: '2026-10-19T03:00:00.000Z', effectPolicy: { kind: 'no_automatic_retry' },
  authority: {
    schemaVersion: 'memlia.principal/v1', organizationId: 'org-fixture', workspaceId: 'workspace-fixture',
    actor: { version: 1, principal: { kind: 'session', userId: 'user-fixture', sessionId: 'session-fixture' } },
    subject: { kind: 'user', userId: 'user-fixture' }, authority: { kind: 'interactive' },
    scopes: ['workflow:read'], allowedTools: ['workflows.read'],
  },
})
const waitUntil = async (check: () => Promise<boolean>, label: string) => {
  const end = Date.now() + 10000
  while (Date.now() < end) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  throw new Error(`Timed out: ${label}`)
}

// Losing persistence or defaulting to inline execution makes restart delivery fail.
test('durable transport with real PostgreSQL', { timeout: 30000 }, async (t) => {
  const clients: PgBossTransport[] = []
  const connect = async () => { const client = await PgBossTransport.connect(options); clients.push(client); return client }
  const observer = new PgBoss({ connectionString, schema, schedule: false, supervise: false })
  observer.on('error', () => notices.push('observer_error'))
  t.after(async () => {
    await Promise.all(clients.map((client) => client.stop()))
    await observer.stop()
    // Preserve this uniquely named test schema as evidence; never drop shared resources.
  })
  let first = await connect()
  await observer.start()
  await t.test('published work survives producer shutdown and a new client delivers native ID', async () => {
    const sent = await first.publish('aB3_short-id', envelope)
    await first.stop()
    first = await connect()
    const delivered: string[] = []
    await first.work(async (nativeId, actual, signal) => {
      assert.deepEqual(actual, envelope)
      assert.equal(signal.aborted, false)
      delivered.push(nativeId)
    })
    await waitUntil(async () => (await observer.getJobById(queueName, sent.transportJobId))?.state === 'completed', 'restart delivery')
    assert.deepEqual(delivered, ['aB3_short-id'])
    await first.stop()
  })
  await t.test('concurrent duplicate publications enqueue one delivery; changed data is refused after restart', async () => {
    const a = await connect(), b = await connect()
    const results = await Promise.all([a.publish('workflow:short_42', envelope), b.publish('workflow:short_42', envelope)])
    assert.equal(results[0].transportJobId, results[1].transportJobId)
    assert.equal(results.filter((result) => result.duplicate).length, 1)
    await a.stop()
    let calls = 0
    await b.work(async () => { calls++ })
    await waitUntil(async () => (await observer.getJobById(queueName, results[0].transportJobId))?.state === 'completed', 'deduplicated delivery')
    await b.stop()
    const c = await connect()
    const reordered = Object.fromEntries(Object.entries(envelope).reverse())
    assert.equal((await c.publish('workflow:short_42', reordered)).duplicate, true)
    await assert.rejects(c.publish('workflow:short_42', { ...envelope, runId: 'another-run' }), { code: 'identity_conflict' })
    assert.equal(calls, 1)
    await c.stop()
  })
  await t.test('concurrent different data under one native ID admits one winner', async () => {
    const a = await connect(), b = await connect()
    const outcomes = await Promise.allSettled([
      a.publish('conflicting-race', envelope),
      b.publish('conflicting-race', { ...envelope, runId: 'different-race-run' }),
    ])
    assert.equal(outcomes.filter((item) => item.status === 'fulfilled').length, 1)
    const rejected = outcomes.find((item) => item.status === 'rejected')
    assert.equal(rejected?.status === 'rejected' && rejected.reason.code, 'identity_conflict')
    const winner = outcomes.find((item) => item.status === 'fulfilled')
    assert.equal(winner?.status, 'fulfilled')
    let calls = 0
    await a.work(async () => { calls++ })
    await waitUntil(async () => (await observer.getJobById(queueName, winner!.value.transportJobId))?.state === 'completed', 'conflict winner')
    assert.equal(calls, 1)
    await a.stop(); await b.stop()
  })
  await t.test('stored digest alone cannot hide different payload data', async () => {
    const a = await connect()
    const sent = await a.publish('digest-collision', envelope)
    const row = await observer.getJobById<{ nativeJobId: string; digest: string; envelope: unknown }>(queueName, sent.transportJobId)
    assert.ok(row)
    // Emulate a corrupt row/hash collision using the real queue's update API.
    await observer.update(queueName, { ...row.data, envelope: { ...envelope, runId: 'tampered-run' } }, { id: sent.transportJobId })
    await assert.rejects(a.publish('digest-collision', envelope), { code: 'identity_conflict' })
    let calls = 0
    await a.work(async () => { calls++ })
    await waitUntil(async () => (await observer.getJobById(queueName, sent.transportJobId))?.state === 'failed', 'corrupt delivery refusal')
    assert.equal(calls, 0)
    await a.stop()
  })
  await t.test('a runner error after a possible effect is terminal and its sensitive text is discarded', async () => {
    const a = await connect()
    const sent = await a.publish('unknown-effect', envelope)
    let calls = 0
    await a.work(async () => { calls++; throw new Error('fixture-sensitive-error') })
    await waitUntil(async () => (await observer.getJobById(queueName, sent.transportJobId))?.state === 'failed', 'terminal error')
    await a.stop()
    const b = await connect()
    await b.work(async () => { calls++ })
    const row = await observer.getJobById(queueName, sent.transportJobId)
    assert.equal(row?.retryLimit, 0)
    assert.equal(row?.retryCount, 0)
    assert.equal(JSON.stringify(row?.output).includes('fixture-sensitive-error'), false)
    await new Promise((resolve) => setTimeout(resolve, 1100))
    assert.equal(calls, 1)
    assert.equal((await b.publish('unknown-effect', envelope)).duplicate, true)
    await b.stop()
  })
  await t.test('stop drains the active handler and rejects new publications', async () => {
    const a = await connect()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let started = false, stopped = false
    await a.work(async () => { started = true; await gate })
    const sent = await a.publish('drain-job', envelope)
    await waitUntil(async () => started, 'handler started')
    const stopping = a.stop().then(() => { stopped = true })
    try {
      await assert.rejects(a.publish('after-stop', envelope), { code: 'transport_closed' })
      assert.equal(stopped, false)
    } finally {
      release()
    }
    await stopping
    assert.equal((await observer.getJobById(queueName, sent.transportJobId))?.state, 'completed')
  })
  await t.test('stop preserves publications already in flight and refuses new workers', async () => {
    const queueName = 'publish-during-stop'
    const worker = await PgBossTransport.connect({ ...options, queueName })
    clients.push(worker)
    const publishing = Array.from({ length: 15 }, (_, index) => worker.publish(`in-flight-${index}`, envelope))
    const stopping = worker.stop()
    await assert.rejects(worker.work(async () => {}), { code: 'transport_closed' })
    const published = await Promise.all(publishing)
    await stopping
    assert.equal(new Set(published.map((item) => item.transportJobId)).size, 15)
    for (const sent of published) {
      assert.equal((await observer.getJobById(queueName, sent.transportJobId))?.state, 'created')
    }
  })
  // pg-boss offWork(wait:true) releases its own overrun wait when stopped.
  // Our drain must still wait for the actual handler, whether it resolves or rejects.
  for (const rejects of [false, true]) {
    await t.test(`stop waits for expired handler to ${rejects ? 'reject' : 'resolve'}`, async () => {
      const queueName = rejects ? 'expired-handler-rejects' : 'expired-handler-resolves'
      const bootstrap = await PgBossTransport.connect({ ...options, queueName })
      clients.push(bootstrap)
      await observer.updateQueue(queueName, { expireInSeconds: 1 })
      await bootstrap.stop()
      const worker = await PgBossTransport.connect({ ...options, queueName })
      clients.push(worker)
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      let finished = false, stopped = false, calls = 0
      let signal: AbortSignal | undefined
      let stopping: Promise<void> | undefined
      try {
        const sent = await worker.publish('expired-handler', envelope)
        await worker.work(async (_nativeId, _envelope, abortSignal) => {
          calls++
          signal = abortSignal
          await gate
          finished = true
          if (rejects) throw new Error('fixture-expired-handler-failure')
        })
        await waitUntil(async () => (await observer.getJobById(queueName, sent.transportJobId))?.state === 'failed', 'handler expiration')
        assert.equal(signal?.aborted, true)
        stopping = worker.stop().then(() => { stopped = true })
        // Give the broken offWork-only implementation time to incorrectly resolve.
        await new Promise((resolve) => setTimeout(resolve, 250))
        assert.equal(finished, false)
        assert.equal(stopped, false, 'stop resolved while the expired handler was still running')
        await assert.rejects(worker.publish('after-expiry-stop', envelope), { code: 'transport_closed' })
        release()
        await stopping
        assert.equal(finished, true)
        assert.equal(calls, 1)
        assert.equal((await observer.getJobById(queueName, sent.transportJobId))?.state, 'failed')
      } finally {
        release()
        await stopping
        await worker.stop()
      }
    })
  }
  await t.test('malformed payload is rejected before admission', async () => {
    const a = await connect()
    await assert.rejects(a.publish('invalid', { ...envelope, runner: 'run-data-drain' }), { code: 'invalid_envelope' })
    await assert.rejects(a.publish('', envelope), { code: 'invalid_native_id' })
    await a.stop()
  })
  await t.test('a backend send error remains acceptance-unknown and sanitized', async () => {
    const queueName = 'removed-test-queue'
    const client = await PgBossTransport.connect({ ...options, queueName })
    clients.push(client)
    // This queue belongs only to this random test namespace; other resources remain untouched.
    await observer.deleteQueue(queueName)
    await assert.rejects(client.publish('missing-queue-job', envelope), {
      code: 'acceptance_unknown', acceptance: 'unknown', message: 'acceptance_unknown',
    })
    await client.stop()
  })
  assert.deepEqual(notices, [])
  console.log(JSON.stringify({ schema, queueName, runtime: process.versions.bun ? `Bun ${process.versions.bun}` : process.version, database: 'PostgreSQL 17.11 dedicated development', cases: 11 }))
})
