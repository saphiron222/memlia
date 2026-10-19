// Copyright 2026 Memlia. All rights reserved.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { JobEnvelopeSchema } from '@memlia/contracts'
import {
  assertDisposableTestDatabaseUrl,
  clearInheritedDatabaseUrls,
} from '@sim/db/testing/test-infrastructure'
import { eq, inArray, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

const envFile = process.env.MEMLIA_QUEUE_ADMISSION_TEST_ENV_FILE
assert.ok(envFile, 'Dedicated P03 environment required; no integration skip')
const env = Object.fromEntries(
  readFileSync(envFile, 'utf8')
    .split('\n')
    .filter((line) => line.includes('='))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
)
const runtimeUrl = assertDisposableTestDatabaseUrl(env.TEST_DATABASE_URL)
// Connection-local test bound only; never ALTER ROLE/DATABASE or configure product callbacks.
runtimeUrl.searchParams.set('lock_timeout', '2s')
clearInheritedDatabaseUrls()
process.env.DATABASE_URL = runtimeUrl.toString()
process.env.DB_APP_NAME = `delivery-reference-${randomUUID()}`
const { db } = await import('@sim/db')
const schema = await import('@sim/db/schema')
const { asyncJobs, outboxEvent } = schema
const [{ application_name: applicationName, lock_timeout: lockTimeout }] = await db.execute<{
  application_name: string
  lock_timeout: string
}>(
  sql`select current_setting('application_name') as application_name, current_setting('lock_timeout') as lock_timeout`
)
assert.equal(
  lockTimeout,
  '2s',
  'Run this suite in a fresh process with its connection-local test bound'
)
const lockClient = postgres(env.TEST_DATABASE_URL, { max: 1, onnotice: () => {} })
const blockerDb = drizzle(lockClient, { schema })
const { admitPgBossJob, readPgBossPublication } = await import('./pg-boss-admission')
const { resolvePgBossDeliveryReference: resolve } = await import('./pg-boss-delivery-reference')
const jobs: string[] = []
const events: string[] = []
// Fixture references are not authentication evidence.
function admissionFixture(label: string, organizationId: string | null = null) {
  const suffix = randomUUID()
  const runId = `bridge-${label}-${suffix}`
  return {
    jobId: `workflow-execution:${runId}`,
    envelope: {
      schemaVersion: 'memlia.job/v1',
      commandId: `command-${suffix}`,
      runId,
      runner: 'workflow-execution',
      inputs: [],
      idempotencyKey: `bridge-${suffix}`,
      submittedAt: '2026-10-19T00:00:00.000Z',
      effectPolicy: { kind: 'no_automatic_retry' },
      authority: {
        schemaVersion: 'memlia.principal/v1',
        organizationId,
        workspaceId: `workspace-${suffix}`,
        actor: {
          version: 1,
          principal: { kind: 'session', userId: `user-${suffix}`, sessionId: `session-${suffix}` },
        },
        subject: { kind: 'user', userId: `user-${suffix}` },
        authority: { kind: 'interactive' },
        scopes: [],
        allowedTools: [],
      },
    },
    payload: {
      fixture: label,
      workflowId: `workflow-${suffix}`,
      workspaceId: `workspace-${suffix}`,
      executionId: runId,
      principal: {
        version: 1,
        principal: { kind: 'session', userId: `user-${suffix}`, sessionId: `session-${suffix}` },
      },
    },
    maxDurationSeconds: 1200,
    runAt: '2026-10-19T00:00:00.000Z',
  }
}

function envelopeMutations(envelope: ReturnType<typeof admissionFixture>['envelope']) {
  const mutations: Array<[string, (value: any) => void]> = [
    [
      'command',
      (v) => {
        v.commandId += '-different'
      },
    ],
    [
      'run',
      (v) => {
        v.runId += '-different'
      },
    ],
    [
      'runner',
      (v) => {
        v.runner = 'cleanup-logs'
      },
    ],
    [
      'key',
      (v) => {
        v.idempotencyKey += '-different'
      },
    ],
    [
      'time',
      (v) => {
        v.submittedAt = '2026-10-19T00:00:01.000Z'
      },
    ],
    [
      'inputs',
      (v) => {
        v.inputs = [{ artifactId: 'fixture-artifact', sha256: `sha256:${'0'.repeat(64)}` }]
      },
    ],
    [
      'effect',
      (v) => {
        v.effectPolicy = { kind: 'read_only' }
      },
    ],
    [
      'workspace',
      (v) => {
        v.authority.workspaceId += '-different'
      },
    ],
    [
      'organization',
      (v) => {
        v.authority.organizationId = v.authority.organizationId === null ? 'different-org' : null
      },
    ],
    [
      'session',
      (v) => {
        v.authority.actor.principal.sessionId += '-different'
      },
    ],
    [
      'actor',
      (v) => {
        v.authority.actor.principal.userId += '-different'
      },
    ],
    [
      'subject',
      (v) => {
        v.authority.subject.userId += '-different'
      },
    ],
    [
      'scopes',
      (v) => {
        v.authority.scopes = ['workflow:read']
      },
    ],
    [
      'tools',
      (v) => {
        v.authority.allowedTools = ['workflows.read']
      },
    ],
    [
      'authority',
      (v) => {
        v.authority.authority = { kind: 'delegation', delegationId: 'fixture-delegation' }
      },
    ],
  ]
  return mutations.map(([name, change]) => {
    const value = structuredClone(envelope)
    change(value)
    return { name, value }
  })
}

async function admitted(label: string, org: string | null = null) {
  const fixture = admissionFixture(label, org)
  jobs.push(fixture.jobId)
  const result = await db.transaction((tx) => admitPgBossJob(tx, fixture))
  events.push(result.outboxEventId)
  const [event] = await db
    .select()
    .from(outboxEvent)
    .where(eq(outboxEvent.id, result.outboxEventId))
  return { ...fixture, outboxEventId: result.outboxEventId, reference: event.payload }
}
async function row(jobId: string) {
  return (await db.select().from(asyncJobs).where(eq(asyncJobs.id, jobId)))[0]
}
function bounded(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.equal(error.message, code)
    assert.equal(error.cause, undefined)
    assert.equal('acceptance' in error, false, 'Observation error is not an enqueue outcome')
    assert.equal(JSON.stringify(error).includes('canary'), false)
    return true
  }
}
async function lock(jobId: string, cancel = false) {
  let entered!: () => void
  let release!: () => void
  const ready = new Promise<void>((r) => {
    entered = r
  })
  const gate = new Promise<void>((r) => {
    release = r
  })
  const done = blockerDb.transaction(async (tx) => {
    await tx.select().from(asyncJobs).where(eq(asyncJobs.id, jobId)).for('update')
    if (cancel)
      await tx
        .update(asyncJobs)
        .set({ status: 'cancelled', completedAt: new Date() })
        .where(eq(asyncJobs.id, jobId))
    entered()
    await gate
  })
  await ready
  return { done, release }
}
async function observeWait() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const [result] = await db.execute<{ waiting: boolean }>(
      sql`select exists(select 1 from pg_stat_activity where application_name=${applicationName} and cardinality(pg_blocking_pids(pid))>0) as waiting`
    )
    if (result.waiting) return
    await new Promise((r) => setTimeout(r, 10))
  }
  assert.fail('Real PostgreSQL wait was not observed')
}

test(
  'delivery reference is a read-only native identity observation',
  { timeout: 30000 },
  async (t) => {
    t.after(async () => {
      if (events.length) await db.delete(outboxEvent).where(inArray(outboxEvent.id, events))
      if (jobs.length) await db.delete(asyncJobs).where(inArray(asyncJobs.id, jobs))
      assert.equal((await db.select().from(asyncJobs).where(inArray(asyncJobs.id, jobs))).length, 0)
      assert.equal(
        (await db.select().from(outboxEvent).where(inArray(outboxEvent.id, events))).length,
        0
      )
      await lockClient.end()
    })
    await t.test(
      'personal and organizational identities return only frozen persisted references, without writes',
      async () => {
        for (const org of [null, 'fixture-organization']) {
          const f = await admitted('match', org)
          const before = await row(f.jobId)
          const [eventBefore] = await db
            .select()
            .from(outboxEvent)
            .where(eq(outboxEvent.id, f.outboxEventId))
          const result = await resolve(f.jobId, f.envelope)
          assert.deepEqual(result, {
            kind: 'delivery_admission_matched',
            origin: 'persisted_admission',
            reference: f.reference,
          })
          assert.equal(Object.isFrozen(result), true)
          assert.equal(Object.isFrozen(result.reference), true)
          assert.deepEqual(Object.keys(result.reference).sort(), ['admissionDigest', 'nativeJobId'])
          assert.equal(
            JSON.stringify(result).includes(f.envelope.authority.actor.principal.sessionId),
            false
          )
          assert.deepEqual((await readPgBossPublication(db, result.reference)).envelope, f.envelope)
          assert.deepEqual(await row(f.jobId), before)
          assert.deepEqual(
            (await db.select().from(outboxEvent).where(eq(outboxEvent.id, f.outboxEventId)))[0],
            eventBefore
          )
          // Outbox retention is independent; no new requirement to retain its event forever.
          await db.delete(outboxEvent).where(eq(outboxEvent.id, f.outboxEventId))
          assert.deepEqual((await resolve(f.jobId, f.envelope)).reference, f.reference)
        }
      }
    )
    await t.test(
      'every delivered identity field is bound, while key order alone is irrelevant',
      async () => {
        const f = await admitted('mismatch')
        for (const mutation of envelopeMutations(f.envelope)) {
          assert.equal(JobEnvelopeSchema.safeParse(mutation.value).success, true, mutation.name)
          await assert.rejects(
            () => resolve(f.jobId, mutation.value),
            bounded('delivery_admission_mismatch')
          )
        }
        const reversed = Object.fromEntries(Object.entries(f.envelope).reverse())
        assert.deepEqual((await resolve(f.jobId, reversed)).reference, f.reference)
        const other = await admitted('other')
        await assert.rejects(
          () => resolve(other.jobId, f.envelope),
          bounded('delivery_admission_mismatch')
        )
      }
    )
    await t.test(
      'ordered reference lists stay bound and a matching identity cannot authorize a missing session',
      async () => {
        const base = admissionFixture('ordered')
        const f = {
          ...base,
          envelope: {
            ...base.envelope,
            inputs: [
              { artifactId: 'first', sha256: `sha256:${'0'.repeat(64)}` },
              { artifactId: 'second', sha256: `sha256:${'1'.repeat(64)}` },
            ],
          },
        }
        jobs.push(f.jobId)
        const receipt = await db.transaction((tx) => admitPgBossJob(tx, f))
        events.push(receipt.outboxEventId)
        const result = await resolve(f.jobId, f.envelope)
        await assert.rejects(
          () => resolve(f.jobId, { ...f.envelope, inputs: [...f.envelope.inputs].reverse() }),
          bounded('delivery_admission_mismatch')
        )
        // No session/account fixtures exist: identity success must not turn these references into authority.
        const { revalidatePgBossWorkflowSessionAuthority } = await import(
          './pg-boss-workflow-session-authority'
        )
        await assert.rejects(() => revalidatePgBossWorkflowSessionAuthority(result.reference), {
          message: 'workflow_session_authority_rejected',
        })
        assert.deepEqual(await resolve(f.jobId, f.envelope), result)
      }
    )
    await t.test('invalid or lossy caller data rejects without invoking callbacks', async () => {
      const f = await admitted('shape')
      let getters = 0
      const getter = { ...f.envelope }
      Object.defineProperty(getter, 'commandId', {
        enumerable: true,
        get() {
          getters++
          return 'canary'
        },
      })
      const hidden = { ...f.envelope }
      Object.defineProperty(hidden, 'hidden', { value: 'canary' })
      const symbol = { ...f.envelope, [Symbol('hidden')]: 'canary' }
      const sparse = Array(2)
      sparse[1] = 1
      Object.assign(sparse, { extra: 'canary' })
      const cycle: any = {}
      cycle.self = cycle
      for (const envelope of [
        getter,
        hidden,
        symbol,
        { ...f.envelope, inputs: sparse },
        cycle,
        { ...f.envelope, runner: 'run-data-drain' },
        { ...f.envelope, digest: '0'.repeat(64) },
        { ...f.envelope, admissionDigest: '0'.repeat(64) },
        { ...f.envelope, commandId: 'x'.repeat(1024 * 1024) },
      ])
        await assert.rejects(() => resolve(f.jobId, envelope), bounded('delivery_invalid_input'))
      for (const id of ['', 'x'.repeat(513), null, {}])
        await assert.rejects(
          () => resolve(id as string, f.envelope),
          bounded('delivery_invalid_input')
        )
      assert.equal(getters, 0)
    })
    await t.test('missing, legacy and corrupt persisted admissions fail closed', async () => {
      const f = await admitted('corrupt')
      const before = await row(f.jobId)
      for (const patch of [
        { payload: { canary: 'tampered' } },
        { type: 'cleanup-logs' },
        { runAt: new Date(0) },
        { metadata: sql`'null'::jsonb` },
        { metadata: { maxDurationSeconds: 1200 } },
        { metadata: { ...before.metadata, maxDurationSeconds: 1201 } },
        {
          metadata: {
            ...before.metadata,
            memliaPgBossAdmission: { version: 1, admissionDigest: '0'.repeat(64) },
          },
        },
      ]) {
        await db.update(asyncJobs).set(patch).where(eq(asyncJobs.id, f.jobId))
        await assert.rejects(
          () => resolve(f.jobId, f.envelope),
          bounded('delivery_admission_reconciliation_required')
        )
        await db
          .update(asyncJobs)
          .set({
            payload: before.payload,
            type: before.type,
            runAt: before.runAt,
            metadata: before.metadata,
          })
          .where(eq(asyncJobs.id, f.jobId))
      }
      await db.delete(asyncJobs).where(eq(asyncJobs.id, f.jobId))
      await assert.rejects(
        () => resolve(f.jobId, f.envelope),
        bounded('delivery_admission_reconciliation_required')
      )
      await db
        .insert(asyncJobs)
        .values({ id: f.jobId, type: 'workflow-execution', payload: { legacy: true } })
      await assert.rejects(
        () => resolve(f.jobId, f.envelope),
        bounded('delivery_admission_reconciliation_required')
      )
    })
    await t.test(
      'snapshot survives a deep caller mutation during a real PostgreSQL wait',
      async () => {
        const f = await admitted('mutable')
        const envelope = structuredClone(f.envelope)
        const held = await lock(f.jobId)
        const pending = resolve(f.jobId, envelope)
        try {
          await observeWait()
          envelope.authority.actor.principal.sessionId = 'changed-after-await'
          envelope.commandId = 'changed-after-await'
          envelope.authority.workspaceId = 'changed-after-await'
        } finally {
          held.release()
          await held.done
        }
        assert.deepEqual((await pending).reference, f.reference)
      }
    )
    await t.test(
      'concurrent reads and cancelled, processing, terminal or future jobs never claim or authorize',
      async () => {
        const f = await admitted('states')
        assert.deepEqual(
          await Promise.all([resolve(f.jobId, f.envelope), resolve(f.jobId, f.envelope)]),
          [await resolve(f.jobId, f.envelope), await resolve(f.jobId, f.envelope)]
        )
        const held = await lock(f.jobId, true)
        const pending = resolve(f.jobId, f.envelope)
        try {
          await observeWait()
        } finally {
          held.release()
          await held.done
        }
        assert.deepEqual((await pending).reference, f.reference)
        assert.equal((await row(f.jobId)).status, 'cancelled')
        for (const status of ['completed', 'failed', 'processing']) {
          await db.update(asyncJobs).set({ status }).where(eq(asyncJobs.id, f.jobId))
          const before = await row(f.jobId)
          await resolve(f.jobId, f.envelope)
          assert.deepEqual(await row(f.jobId), before)
        }
        const future = admissionFixture('future')
        future.runAt = '2099-01-01T00:00:00.000Z'
        jobs.push(future.jobId)
        const receipt = await db.transaction((tx) => admitPgBossJob(tx, future))
        events.push(receipt.outboxEventId)
        const before = await row(future.jobId)
        await resolve(future.jobId, future.envelope)
        assert.deepEqual(await row(future.jobId), before)
      }
    )
    await t.test(
      'real connection-local lock timeout yields a bounded observation error',
      async () => {
        const f = await admitted('timeout')
        const held = await lock(f.jobId)
        try {
          await assert.rejects(
            () => resolve(f.jobId, f.envelope),
            bounded('delivery_observation_unavailable')
          )
        } finally {
          held.release()
          await held.done
        }
        assert.deepEqual((await resolve(f.jobId, f.envelope)).reference, f.reference)
      }
    )
  }
)
