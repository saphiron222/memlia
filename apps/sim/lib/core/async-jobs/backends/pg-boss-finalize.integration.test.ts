// Copyright 2026 Memlia. All rights reserved.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { JobEnvelopeSchema } from '@memlia/contracts'
import { and, eq, inArray, sql } from 'drizzle-orm'

const envFile = process.env.MEMLIA_QUEUE_ADMISSION_TEST_ENV_FILE
assert.ok(envFile, 'Dedicated queue test environment required; no integration skip')
const env = Object.fromEntries(
  readFileSync(envFile, 'utf8')
    .split('\n')
    .filter((line) => line.includes('='))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
)
assert.ok(env.TEST_DATABASE_URL && new URL(env.TEST_DATABASE_URL).pathname.includes('_test_'))
for (const key of Object.keys(process.env)) {
  if (
    key.startsWith('DATABASE_URL') ||
    key.startsWith('DATABASE_REPLICA_URL') ||
    key === 'MIGRATION_DATABASE_URL'
  )
    delete process.env[key]
}
process.env.DATABASE_URL = env.TEST_DATABASE_URL
const { db } = await import('@sim/db')
const { asyncJobs, outboxEvent } = await import('@sim/db/schema')
const { admitPgBossJob } = await import('./pg-boss-admission')
const { claimPgBossAttempt, guardPgBossAttempt } = await import('./pg-boss-claim')
const { finalizePgBossAttempt } = await import('./pg-boss-finalize')
const prefix = `finalize-${randomUUID()}`
const jobIds: string[] = []
const eventIds: string[] = []

async function fixture(label: string, runner = 'workflow-execution') {
  const jobId = `${prefix}:${label}`
  jobIds.push(jobId)
  const envelope = JobEnvelopeSchema.parse({
    schemaVersion: 'memlia.job/v1',
    commandId: 'fixture-command',
    runId: 'fixture-run',
    runner,
    inputs: [],
    idempotencyKey: `${prefix}-${label}`,
    submittedAt: '2026-01-01T00:00:00.000Z',
    effectPolicy: { kind: 'no_automatic_retry' },
    authority: {
      schemaVersion: 'memlia.principal/v1',
      organizationId: 'fixture-org',
      workspaceId: 'fixture-space',
      actor: {
        version: 1,
        principal: { kind: 'session', userId: 'fixture-user', sessionId: 'fixture-session' },
      },
      subject: { kind: 'user', userId: 'fixture-user' },
      authority: { kind: 'interactive' },
      scopes: ['workflow:read'],
      allowedTools: ['workflows.read'],
    },
  })
  const input = {
    jobId,
    envelope,
    payload: { fixture: label },
    metadata: { workspaceId: 'fixture-space' },
    runAt: '2026-01-01T00:00:00.000Z',
  }
  const result = await db.transaction((tx) => admitPgBossJob(tx, input))
  eventIds.push(result.outboxEventId)
  return input
}
async function row(jobId: string) {
  return (await db.select().from(asyncJobs).where(eq(asyncJobs.id, jobId)))[0]
}
async function claim(input: Awaited<ReturnType<typeof fixture>>) {
  return db.transaction((tx) => claimPgBossAttempt(tx, input.jobId, input.envelope))
}

async function owned(label: string, runner?: string) {
  const input = await fixture(label, runner)
  const claimed = await claim(input)
  assert.equal(claimed.kind, 'claimed')
  if (claimed.kind !== 'claimed') throw Error('Fixture claim missing')
  return { input, attempt: claimed.attempt }
}
async function blocked(pid: number) {
  for (let index = 0; index < 100; index++) {
    const [activity] = await db.execute<{ blocked: boolean }>(
      sql`select cardinality(pg_blocking_pids(${pid})) > 0 as blocked`
    )
    if (activity.blocked) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail('PostgreSQL did not observe the contender waiting on the row lock')
}
const returned = (value: unknown) => ({
  kind: 'returned' as const,
  outputJson: JSON.stringify(value),
})

test('native finalization under a real PostgreSQL attempt lock', { timeout: 30000 }, async (t) => {
  t.after(async () => {
    if (eventIds.length) await db.delete(outboxEvent).where(inArray(outboxEvent.id, eventIds))
    if (jobIds.length) await db.delete(asyncJobs).where(inArray(asyncJobs.id, jobIds))
    assert.equal((await db.select().from(asyncJobs).where(inArray(asyncJobs.id, jobIds))).length, 0)
    assert.equal(
      (await db.select().from(outboxEvent).where(inArray(outboxEvent.id, eventIds))).length,
      0
    )
  })
  await t.test(
    'persists the complete native result with UTC database timestamps and unchanged admission',
    async () => {
      const { input, attempt } = await owned('returned')
      const before = await row(input.jobId)
      const output = {
        success: true,
        workflowId: 'fixture-workflow',
        output: { amount: 12, rows: [1, null, 'é'] },
      }
      const result = await db.transaction(async (tx) => {
        await tx.execute(sql`set local timezone = 'Pacific/Honolulu'`)
        const [start] = await tx.execute<{ time: string }>(
          sql`select timezone('UTC', clock_timestamp())::text as time`
        )
        const receipt = await finalizePgBossAttempt(tx, attempt, returned(output))
        const [stored] = await tx.select().from(asyncJobs).where(eq(asyncJobs.id, input.jobId))
        const [end] = await tx.execute<{ time: string }>(
          sql`select timezone('UTC', clock_timestamp())::text as time`
        )
        const lower = new Date(`${start.time.replace(' ', 'T')}Z`).getTime()
        const upper = new Date(`${end.time.replace(' ', 'T')}Z`).getTime()
        assert.ok(
          stored.completedAt &&
            stored.completedAt.getTime() >= lower &&
            stored.completedAt.getTime() <= upper
        )
        assert.equal(stored.updatedAt.getTime(), stored.completedAt.getTime())
        return receipt
      })
      assert.deepEqual(result, { kind: 'finalized', status: 'completed' })
      const after = await row(input.jobId)
      assert.equal(after.status, 'completed')
      assert.deepEqual(after.output, output)
      assert.equal(after.error, null)
      assert.deepEqual(after.metadata, before.metadata)
      assert.deepEqual(after.payload, before.payload)
      assert.equal(after.attempts, 1)
      assert.deepEqual(after.startedAt, before.startedAt)
    }
  )
  await t.test(
    'keeps workflow failures with and without error, never converting a return into business success',
    async () => {
      for (const [label, output, error] of [
        [
          'recorded',
          {
            success: false,
            workflowId: 'wf',
            executionId: 'exec',
            error: 'Fictitious business refusal',
            executedAt: '2026-01-01T00:00:00.000Z',
          },
          'Fictitious business refusal',
        ],
        [
          'without-error',
          { success: false, workflowId: 'wf', executionId: 'exec', output: { partial: true } },
          'workflow_execution_failed',
        ],
        ['large-error', { success: false, error: 'é'.repeat(9000) }, 'workflow_execution_failed'],
      ] as const) {
        const { input, attempt } = await owned(label)
        assert.deepEqual(
          await db.transaction((tx) => finalizePgBossAttempt(tx, attempt, returned(output))),
          { kind: 'finalized', status: 'failed' }
        )
        const stored = await row(input.jobId)
        assert.equal(stored.status, 'failed')
        assert.equal(stored.error, error)
        assert.deepEqual(stored.output, output)
      }
      const { input, attempt } = await owned('other-runner', 'cleanup-logs')
      const output = { success: false, note: 'Opaque runner-specific value' }
      assert.deepEqual(
        await db.transaction((tx) => finalizePgBossAttempt(tx, attempt, returned(output))),
        { kind: 'finalized', status: 'completed' }
      )
      assert.deepEqual((await row(input.jobId)).output, output)
    }
  )
  await t.test(
    'persists a definite server-prepared failure, but an unknown outcome changes nothing',
    async () => {
      const { input, attempt } = await owned('unknown')
      const before = await row(input.jobId)
      assert.deepEqual(
        await db.transaction((tx) => finalizePgBossAttempt(tx, attempt, { kind: 'unknown' })),
        { kind: 'reconciliation_required' }
      )
      assert.deepEqual(await row(input.jobId), before)
      assert.deepEqual(
        await db.transaction((tx) =>
          finalizePgBossAttempt(tx, attempt, { kind: 'failed', error: 'fixture_known_failure' })
        ),
        { kind: 'finalized', status: 'failed' }
      )
      const stored = await row(input.jobId)
      assert.equal(stored.error, 'fixture_known_failure')
      assert.equal(stored.output, null)
      assert.ok(stored.completedAt)
      const terminal = await row(input.jobId)
      assert.deepEqual(
        await db.transaction((tx) =>
          finalizePgBossAttempt(tx, attempt, returned({ overwritten: true }))
        ),
        { kind: 'reconciliation_required' }
      )
      assert.deepEqual(await row(input.jobId), terminal)
    }
  )
  await t.test('caller rollback restores processing, result and timestamps together', async () => {
    const { input, attempt } = await owned('rollback')
    const before = await row(input.jobId)
    await assert.rejects(
      db.transaction(async (tx) => {
        assert.deepEqual(await finalizePgBossAttempt(tx, attempt, returned({ success: true })), {
          kind: 'finalized',
          status: 'completed',
        })
        throw Error('fixture_outer_rollback')
      }),
      /fixture_outer_rollback/
    )
    assert.deepEqual(await row(input.jobId), before)
    assert.deepEqual(
      await db.transaction((tx) => finalizePgBossAttempt(tx, attempt, returned(null))),
      { kind: 'finalized', status: 'completed' }
    )
    assert.equal((await row(input.jobId)).output, null)
  })
  await t.test(
    'stale token, cancellation, pending, missing row and changed admission cannot finish',
    async () => {
      for (const state of ['token', 'cancelled', 'pending', 'missing', 'identity']) {
        const { input, attempt } = await owned(state)
        if (state === 'token') {
          await db
            .update(asyncJobs)
            .set({
              metadata: sql`jsonb_set(${asyncJobs.metadata}, '{memliaPgBossAdmission,attempt,token}', ${JSON.stringify(randomUUID())}::jsonb)`,
            })
            .where(eq(asyncJobs.id, input.jobId))
        } else if (state === 'missing') {
          await db.delete(asyncJobs).where(eq(asyncJobs.id, input.jobId))
        } else if (state === 'identity') {
          await db
            .update(asyncJobs)
            .set({ payload: { tampered: true } })
            .where(eq(asyncJobs.id, input.jobId))
        } else {
          await db
            .update(asyncJobs)
            .set({ status: state, completedAt: state === 'cancelled' ? new Date() : null })
            .where(eq(asyncJobs.id, input.jobId))
        }
        const before = await row(input.jobId)
        const finish = db.transaction((tx) =>
          finalizePgBossAttempt(tx, attempt, returned({ forbidden: true }))
        )
        if (state === 'identity')
          await assert.rejects(finish, { code: 'admission_identity_conflict' })
        else assert.deepEqual(await finish, { kind: 'reconciliation_required' })
        assert.deepEqual(await row(input.jobId), before)
      }
    }
  )
  await t.test(
    'two finalizers serialize and the loser cannot overwrite the committed result',
    async () => {
      const { input, attempt } = await owned('duel')
      let announce!: () => void
      let release!: () => void
      const held = new Promise<void>((r) => {
        announce = r
      })
      const gate = new Promise<void>((r) => {
        release = r
      })
      const first = db.transaction(async (tx) => {
        const result = await finalizePgBossAttempt(tx, attempt, returned({ winner: 'first' }))
        announce()
        await gate
        return result
      })
      await held
      let pid = 0
      let submitted!: () => void
      const waiting = new Promise<void>((r) => {
        submitted = r
      })
      const second = db.transaction(async (tx) => {
        const [backend] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)
        pid = backend.pid
        submitted()
        return finalizePgBossAttempt(tx, attempt, { kind: 'failed', error: 'loser' })
      })
      try {
        await waiting
        await blocked(pid)
      } finally {
        release()
      }
      assert.deepEqual(await first, { kind: 'finalized', status: 'completed' })
      assert.deepEqual(await second, { kind: 'reconciliation_required' })
      assert.deepEqual((await row(input.jobId)).output, { winner: 'first' })
    }
  )
  await t.test('a cancellation holding the row lock wins before a waiting finalizer', async () => {
    const { input, attempt } = await owned('cancel-race')
    let announce!: () => void
    let release!: () => void
    const held = new Promise<void>((r) => {
      announce = r
    })
    const gate = new Promise<void>((r) => {
      release = r
    })
    const cancel = db.transaction(async (tx) => {
      await tx
        .update(asyncJobs)
        .set({ status: 'cancelled', error: 'Cancelled', completedAt: new Date() })
        .where(and(eq(asyncJobs.id, input.jobId), eq(asyncJobs.status, 'processing')))
      announce()
      await gate
    })
    await held
    let pid = 0
    let submitted!: () => void
    const waiting = new Promise<void>((r) => {
      submitted = r
    })
    const finish = db.transaction(async (tx) => {
      const [backend] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)
      pid = backend.pid
      submitted()
      return finalizePgBossAttempt(tx, attempt, returned({ forbidden: true }))
    })
    try {
      await waiting
      await blocked(pid)
    } finally {
      release()
    }
    await cancel
    assert.deepEqual(await finish, { kind: 'reconciliation_required' })
    const stored = await row(input.jobId)
    assert.equal(stored.status, 'cancelled')
    assert.equal(stored.output, null)
    assert.equal(stored.error, 'Cancelled')
  })
  await t.test(
    'rejects malformed/oversized output and error without touching the processing row',
    async () => {
      const { input, attempt } = await owned('invalid')
      const before = await row(input.jobId)
      let invoked = false
      const accessor = Object.defineProperty({ kind: 'returned' }, 'outputJson', {
        enumerable: true,
        get() {
          invoked = true
          return '{}'
        },
      })
      const invalid: unknown[] = [
        { kind: 'returned', outputJson: '{' },
        { kind: 'returned', outputJson: '1e400' },
        { kind: 'returned', outputJson: `${'['.repeat(34)}0${']'.repeat(34)}` },
        { kind: 'returned', outputJson: JSON.stringify('x'.repeat(1024 * 1024)) },
        { kind: 'returned', outputJson: '{}', metadata: { memliaPgBossAdmission: {} } },
        { kind: 'failed', error: '' },
        { kind: 'failed', error: 'é'.repeat(9000) },
        { kind: 'returned', outputJson: undefined },
        { kind: 'unknown', error: 'surplus' },
        accessor,
      ]
      for (const outcome of invalid) {
        // @ts-expect-error Intentionally adversarial runtime values.
        await assert.rejects(
          db.transaction((tx) => finalizePgBossAttempt(tx, attempt, outcome)),
          { code: 'finalize_invalid_outcome' }
        )
        assert.deepEqual(await row(input.jobId), before)
      }
      assert.equal(invoked, false)
      // @ts-expect-error The autocommit pool cannot hold the attempt guard through the write.
      await assert.rejects(finalizePgBossAttempt(db, attempt, returned({})), {
        code: 'finalize_transaction_required',
      })
      await assert.rejects(
        db.transaction((tx) =>
          finalizePgBossAttempt(tx, { ...attempt, token: 'invalid' }, returned({}))
        ),
        { code: 'claim_invalid_attempt' }
      )
      assert.deepEqual(await row(input.jobId), before)
    }
  )
  await t.test('a real lock timeout exposes only a bounded unknown error', async () => {
    const { input, attempt } = await owned('timeout')
    const before = await row(input.jobId)
    let announce!: () => void
    let release!: () => void
    const held = new Promise<void>((r) => {
      announce = r
    })
    const gate = new Promise<void>((r) => {
      release = r
    })
    const holder = db.transaction(async (tx) => {
      await tx.select().from(asyncJobs).where(eq(asyncJobs.id, input.jobId)).for('update')
      announce()
      await gate
    })
    await held
    try {
      // Validation must finish before touching the row already locked by another transaction.
      await assert.rejects(
        db.transaction(async (tx) => {
          await tx.execute(sql`set local lock_timeout = '100ms'`)
          return finalizePgBossAttempt(tx, attempt, { kind: 'returned', outputJson: '{' })
        }),
        { code: 'finalize_invalid_outcome' }
      )
      await assert.rejects(
        db.transaction(async (tx) => {
          await tx.execute(sql`set local lock_timeout = '100ms'`)
          return finalizePgBossAttempt(tx, attempt, returned({}))
        }),
        (error) => {
          assert.ok(error instanceof Error)
          assert.equal(error.message, 'claim_persistence_unknown')
          assert.deepEqual(Object.keys(error).sort(), ['acceptance', 'code', 'name'])
          assert.equal('acceptance' in error && error.acceptance, 'unknown')
          assert.equal(JSON.stringify(error).includes(input.jobId), false)
          assert.equal(JSON.stringify(error).includes(attempt.token), false)
          return true
        }
      )
    } finally {
      release()
      await holder
    }
    assert.deepEqual(await row(input.jobId), before)
  })
  await t.test(
    'checks the original token even if the caller changes its handle while waiting',
    async () => {
      const { input, attempt } = await owned('guard-original-token')
      const before = await row(input.jobId)
      const mutable = { ...attempt, token: randomUUID() }
      assert.notEqual(mutable.token, attempt.token)
      let announce!: () => void
      let release!: () => void
      const held = new Promise<void>((resolve) => {
        announce = resolve
      })
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const holder = db.transaction(async (tx) => {
        await tx.select().from(asyncJobs).where(eq(asyncJobs.id, input.jobId)).for('update')
        announce()
        await gate
      })
      await held
      let pid = 0
      let submitted!: () => void
      const waiting = new Promise<void>((resolve) => {
        submitted = resolve
      })
      const guarded = db.transaction(async (tx) => {
        const [backend] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)
        pid = backend.pid
        submitted()
        return guardPgBossAttempt(tx, mutable)
      })
      try {
        await waiting
        await blocked(pid)
        mutable.token = attempt.token
      } finally {
        release()
        await holder
      }
      assert.equal(await guarded, false)
      assert.deepEqual(await row(input.jobId), before)
    }
  )
  await t.test(
    'snapshots the attempt handle before waiting so caller mutation cannot retarget the write',
    async () => {
      const first = await owned('mutable-owner')
      const other = await owned('mutable-other')
      const otherBefore = await row(other.input.jobId)
      const mutable = { ...first.attempt }
      let announce!: () => void
      let release!: () => void
      const held = new Promise<void>((resolve) => {
        announce = resolve
      })
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const holder = db.transaction(async (tx) => {
        await tx.select().from(asyncJobs).where(eq(asyncJobs.id, first.input.jobId)).for('update')
        announce()
        await gate
      })
      await held
      let pid = 0
      let submitted!: () => void
      const waiting = new Promise<void>((resolve) => {
        submitted = resolve
      })
      const finish = db.transaction(async (tx) => {
        const [backend] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)
        pid = backend.pid
        submitted()
        return finalizePgBossAttempt(tx, mutable, returned({ owner: 'first' }))
      })
      try {
        await waiting
        await blocked(pid)
        mutable.jobId = other.input.jobId
      } finally {
        release()
        await holder
      }
      assert.deepEqual(await finish, { kind: 'finalized', status: 'completed' })
      const firstAfter = await row(first.input.jobId)
      const otherAfter = await row(other.input.jobId)
      assert.deepEqual(
        {
          firstStatus: firstAfter.status,
          firstOutput: firstAfter.output,
          otherStatus: otherAfter.status,
          otherOutput: otherAfter.output,
        },
        {
          firstStatus: 'completed',
          firstOutput: { owner: 'first' },
          otherStatus: 'processing',
          otherOutput: null,
        }
      )
      assert.deepEqual(otherAfter, otherBefore)
    }
  )
  await t.test(
    'a PostgreSQL JSONB rejection after the guard exposes no raw driver details',
    async () => {
      const { input, attempt } = await owned('storage-error')
      const before = await row(input.jobId)
      // Valid JSON text but PostgreSQL JSONB cannot store U+0000. No schema mutation or DB double.
      await assert.rejects(
        db.transaction((tx) => finalizePgBossAttempt(tx, attempt, returned({ value: '\u0000' }))),
        (error) => {
          assert.ok(error instanceof Error)
          assert.equal(error.message, 'finalize_persistence_unknown')
          assert.deepEqual(Object.keys(error).sort(), ['acceptance', 'code', 'name'])
          assert.equal('acceptance' in error && error.acceptance, 'unknown')
          assert.equal(JSON.stringify(error).includes(input.jobId), false)
          assert.equal(JSON.stringify(error).includes(attempt.token), false)
          return true
        }
      )
      assert.deepEqual(await row(input.jobId), before)
    }
  )
})
