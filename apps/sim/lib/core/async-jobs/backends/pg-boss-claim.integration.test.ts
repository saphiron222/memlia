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
const prefix = `claim-${randomUUID()}`
const jobIds: string[] = []
const eventIds: string[] = []

async function fixture(label: string, runAt = '2026-01-01T00:00:00.000Z') {
  const jobId = `${prefix}:${label}`
  jobIds.push(jobId)
  const envelope = JobEnvelopeSchema.parse({
    schemaVersion: 'memlia.job/v1',
    commandId: 'fixture-command',
    runId: 'fixture-run',
    runner: 'workflow-execution',
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
    runAt,
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

test(
  'durable attempt claim and locked ownership guard on native PostgreSQL rows',
  { timeout: 30000 },
  async (t) => {
    t.after(async () => {
      if (eventIds.length) await db.delete(outboxEvent).where(inArray(outboxEvent.id, eventIds))
      if (jobIds.length) await db.delete(asyncJobs).where(inArray(asyncJobs.id, jobIds))
      assert.equal(
        (await db.select({ id: asyncJobs.id }).from(asyncJobs).where(inArray(asyncJobs.id, jobIds)))
          .length,
        0
      )
      assert.equal(
        (
          await db
            .select({ id: outboxEvent.id })
            .from(outboxEvent)
            .where(inArray(outboxEvent.id, eventIds))
        ).length,
        0
      )
    })
    await t.test(
      'two concurrent deliveries claim only once and retain native admission identity',
      async () => {
        const input = await fixture('concurrent')
        const results = await Promise.all([claim(input), claim(input)])
        assert.equal(results.filter((x) => x.kind === 'claimed').length, 1)
        assert.equal(results.filter((x) => x.kind === 'reconciliation_required').length, 1)
        const winner = results.find((x) => x.kind === 'claimed')!
        assert.equal(winner.kind, 'claimed')
        if (winner.kind !== 'claimed') throw Error('Missing winner')
        assert.match(winner.attempt.token, /^[0-9a-f-]{36}$/)
        const stored = await row(input.jobId)
        assert.equal(stored.status, 'processing')
        assert.equal(stored.attempts, 1)
        assert.ok(stored.startedAt)
        assert.equal(stored.completedAt, null)
        assert.deepEqual(stored.payload, input.payload)
        const duplicate = await db.transaction((tx) => admitPgBossJob(tx, input))
        assert.equal(duplicate.duplicate, true)
        assert.equal(await db.transaction((tx) => guardPgBossAttempt(tx, winner.attempt)), true)
      }
    )
    await t.test('caller rollback removes the tentative claim and its token', async () => {
      const input = await fixture('rollback')
      let rolledBackToken = ''
      await assert.rejects(
        db.transaction(async (tx) => {
          const transient = await claimPgBossAttempt(tx, input.jobId, input.envelope)
          assert.equal(transient.kind, 'claimed')
          if (transient.kind === 'claimed') rolledBackToken = transient.attempt.token
          throw Error('fixture-rollback')
        }),
        /fixture-rollback/
      )
      const stored = await row(input.jobId)
      assert.equal(stored.status, 'pending')
      assert.equal(stored.attempts, 0)
      assert.equal(stored.startedAt, null)
      const committed = await claim(input)
      assert.equal(committed.kind, 'claimed')
      if (committed.kind === 'claimed') assert.notEqual(committed.attempt.token, rolledBackToken)
      assert.equal(
        await db.transaction((tx) =>
          guardPgBossAttempt(tx, { jobId: input.jobId, token: rolledBackToken })
        ),
        false
      )
    })
    await t.test('future runAt returns defer without a claim or token', async () => {
      const input = await fixture('future', '2099-01-01T00:00:00.000Z')
      assert.deepEqual(await claim(input), { kind: 'defer', runAt: input.runAt })
      const stored = await row(input.jobId)
      assert.equal(stored.status, 'pending')
      assert.equal(stored.attempts, 0)
      assert.equal(stored.startedAt, null)
    })
    await t.test('database clock controls due time even in a non-UTC session', async () => {
      const [clock] = await db
        .select({
          iso: sql<string>`to_char(timezone('UTC', clock_timestamp()) - interval '1 hour', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
        })
        .from(asyncJobs)
        .limit(1)
      const input = await fixture('db-clock', clock.iso)
      const result = await db.transaction(async (tx) => {
        await tx.execute(sql`set local timezone = 'Pacific/Honolulu'`)
        return claimPgBossAttempt(tx, input.jobId, input.envelope)
      })
      assert.equal(result.kind, 'claimed')
      const [timing] = await db
        .select({
          recent: sql<boolean>`abs(extract(epoch from (${asyncJobs.startedAt} - timezone('UTC', clock_timestamp())))) < 5`,
        })
        .from(asyncJobs)
        .where(eq(asyncJobs.id, input.jobId))
      assert.equal(timing.recent, true)
    })
    await t.test(
      'absent rows and invalid delivery identities cannot acquire ownership',
      async () => {
        const input = await fixture('invalid')
        assert.deepEqual(
          await db.transaction((tx) => claimPgBossAttempt(tx, `${prefix}:missing`, input.envelope)),
          { kind: 'reconciliation_required' }
        )
        await assert.rejects(
          db.transaction((tx) => claimPgBossAttempt(tx, '', input.envelope)),
          { code: 'claim_invalid_job_id' }
        )
        await assert.rejects(
          db.transaction((tx) =>
            claimPgBossAttempt(tx, input.jobId, { ...input.envelope, runner: 'run-data-drain' })
          ),
          { code: 'claim_invalid_envelope' }
        )
        await assert.rejects(
          db.transaction((tx) => guardPgBossAttempt(tx, { jobId: input.jobId, token: 'invalid' })),
          { code: 'claim_invalid_attempt' }
        )
        assert.equal(
          await db.transaction((tx) =>
            guardPgBossAttempt(tx, { jobId: `${prefix}:missing`, token: randomUUID() })
          ),
          false
        )
        assert.equal((await row(input.jobId)).attempts, 0)
      }
    )
    await t.test('terminal states are never started', async () => {
      for (const status of ['cancelled', 'completed', 'failed'] as const) {
        const input = await fixture(status)
        await db
          .update(asyncJobs)
          .set({ status, completedAt: new Date() })
          .where(eq(asyncJobs.id, input.jobId))
        assert.deepEqual(await claim(input), { kind: 'terminal', status })
        assert.equal((await row(input.jobId)).attempts, 0)
      }
    })
    await t.test('a prior attempt or incoherent pending row requires reconciliation', async () => {
      const input = await fixture('reset')
      const claimed = await claim(input)
      assert.equal(claimed.kind, 'claimed')
      await db.update(asyncJobs).set({ status: 'pending' }).where(eq(asyncJobs.id, input.jobId))
      assert.deepEqual(await claim(input), { kind: 'reconciliation_required' })
      const bad = await fixture('bad-pending')
      await db.update(asyncJobs).set({ completedAt: new Date() }).where(eq(asyncJobs.id, bad.jobId))
      assert.deepEqual(await claim(bad), { kind: 'reconciliation_required' })
      for (const status of ['unexpected-status', 'processing', 'completed']) {
        const incoherent = await fixture(`incoherent-${status}`)
        await db.update(asyncJobs).set({ status }).where(eq(asyncJobs.id, incoherent.jobId))
        assert.deepEqual(await claim(incoherent), { kind: 'reconciliation_required' })
      }
    })
    await t.test(
      'delivery identity and native payload corruption are rejected without writes or leaks',
      async () => {
        const input = await fixture('identity')
        await assert.rejects(
          db.transaction((tx) =>
            claimPgBossAttempt(tx, input.jobId, { ...input.envelope, runId: 'foreign-run' })
          ),
          { code: 'claim_identity_conflict' }
        )
        await db
          .update(asyncJobs)
          .set({ payload: { secretFixture: 'not-an-error-message' } })
          .where(eq(asyncJobs.id, input.jobId))
        await assert.rejects(claim(input), (error) => {
          assert.ok(error instanceof Error)
          assert.equal(error.message, 'admission_identity_conflict')
          assert.equal(JSON.stringify(error).includes('not-an-error-message'), false)
          return true
        })
        assert.equal((await row(input.jobId)).attempts, 0)
      }
    )
    await t.test(
      'cancellation, status change, token replacement and forged handle reject stale holders',
      async () => {
        for (const mode of ['cancel', 'status', 'token', 'forged', 'job-id'] as const) {
          const input = await fixture(mode)
          const result = await claim(input)
          if (result.kind !== 'claimed') throw Error('Missing claim')
          if (mode === 'cancel')
            await db
              .update(asyncJobs)
              .set({ status: 'cancelled', completedAt: new Date() })
              .where(eq(asyncJobs.id, input.jobId))
          if (mode === 'status')
            await db
              .update(asyncJobs)
              .set({ status: 'completed', completedAt: new Date() })
              .where(eq(asyncJobs.id, input.jobId))
          if (mode === 'token')
            await db
              .update(asyncJobs)
              .set({
                metadata: sql`jsonb_set(${asyncJobs.metadata}, '{memliaPgBossAdmission,attempt,token}', to_jsonb(${randomUUID()}::text))`,
              })
              .where(eq(asyncJobs.id, input.jobId))
          const handle =
            mode === 'forged'
              ? { ...result.attempt, token: randomUUID() }
              : mode === 'job-id'
                ? { ...result.attempt, jobId: (await fixture('other-id')).jobId }
                : result.attempt
          assert.equal(await db.transaction((tx) => guardPgBossAttempt(tx, handle)), false)
        }
      }
    )
    await t.test(
      'guard refuses a corrupted projection and autocommit cannot retain ownership',
      async () => {
        const input = await fixture('corrupt-guard')
        // @ts-expect-error Runtime regression for accidentally supplying the native autocommit handle.
        await assert.rejects(claimPgBossAttempt(db, input.jobId, input.envelope), {
          code: 'claim_transaction_required',
        })
        const result = await claim(input)
        if (result.kind !== 'claimed') throw Error('Missing claim')
        // @ts-expect-error A successful guard on this handle would not retain its row lock.
        await assert.rejects(guardPgBossAttempt(db, result.attempt), {
          code: 'claim_transaction_required',
        })
        await db
          .update(asyncJobs)
          .set({ payload: { fixture: 'changed' } })
          .where(eq(asyncJobs.id, input.jobId))
        await assert.rejects(
          db.transaction((tx) => guardPgBossAttempt(tx, result.attempt)),
          { code: 'admission_identity_conflict' }
        )
      }
    )
    await t.test(
      'a real database timeout returns bounded unknown without driver details',
      async () => {
        const input = await fixture('lock-timeout')
        let locked!: () => void
        let release!: () => void
        const hasLock = new Promise<void>((resolve) => {
          locked = resolve
        })
        const unlock = new Promise<void>((resolve) => {
          release = resolve
        })
        const holder = db.transaction(async (tx) => {
          await tx.select().from(asyncJobs).where(eq(asyncJobs.id, input.jobId)).for('update')
          locked()
          await unlock
        })
        await hasLock
        try {
          await assert.rejects(
            db.transaction(async (tx) => {
              await tx.execute(sql`set local lock_timeout = '100ms'`)
              return claimPgBossAttempt(tx, input.jobId, input.envelope)
            }),
            (error) => {
              assert.ok(error instanceof Error)
              assert.equal(error.message, 'claim_persistence_unknown')
              assert.deepEqual(Object.keys(error).sort(), ['acceptance', 'code', 'name'])
              assert.equal('acceptance' in error && error.acceptance, 'unknown')
              assert.equal(JSON.stringify(error).includes(input.jobId), false)
              return true
            }
          )
        } finally {
          release()
          await holder
        }
        assert.equal((await row(input.jobId)).status, 'pending')
      }
    )
    await t.test(
      'guard holds the row lock through the caller update and releases on rollback',
      async () => {
        const input = await fixture('locked')
        const result = await claim(input)
        if (result.kind !== 'claimed') throw Error('Missing claim')
        let locked!: () => void
        let release!: () => void
        const hasLock = new Promise<void>((resolve) => {
          locked = resolve
        })
        const unlock = new Promise<void>((resolve) => {
          release = resolve
        })
        const guarded = db.transaction(async (tx) => {
          assert.equal(await guardPgBossAttempt(tx, result.attempt), true)
          locked()
          await unlock
          // Fixture-only write proves the protected boundary; no business finalization is implemented.
          await tx
            .update(asyncJobs)
            .set({ output: { fixture: true } })
            .where(eq(asyncJobs.id, input.jobId))
          throw Error('guard-fixture-rollback')
        })
        const expectedRollback = assert.rejects(guarded, /guard-fixture-rollback/)
        await hasLock
        let cancelled = false
        let backendPid = 0
        let submitted!: () => void
        const submittedQuery = new Promise<void>((resolve) => {
          submitted = resolve
        })
        const cancellation = db
          .transaction(async (tx) => {
            const pid = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)
            backendPid = pid[0].pid
            submitted()
            await tx
              .update(asyncJobs)
              .set({ status: 'cancelled', completedAt: new Date() })
              .where(and(eq(asyncJobs.id, input.jobId), eq(asyncJobs.status, 'processing')))
          })
          .then(() => {
            cancelled = true
          })
        try {
          await submittedQuery
          let blocked = false
          for (let index = 0; index < 100 && !blocked; index++) {
            const activity = await db.execute<{ blocked: boolean }>(
              sql`select wait_event_type = 'Lock' as blocked from pg_stat_activity where pid = ${backendPid}`
            )
            blocked = activity[0]?.blocked === true
            if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10))
          }
          assert.equal(
            blocked,
            true,
            'PostgreSQL observed the concurrent cancellation waiting on the row lock'
          )
          assert.equal(cancelled, false)
        } finally {
          release()
        }
        await expectedRollback
        await cancellation
        assert.equal((await row(input.jobId)).output, null)
        assert.equal(await db.transaction((tx) => guardPgBossAttempt(tx, result.attempt)), false)
      }
    )
  }
)
