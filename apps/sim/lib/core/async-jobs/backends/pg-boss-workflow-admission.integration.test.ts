// Copyright 2026 Memlia. All rights reserved.
// Environment contract (private file MEMLIA_QUEUE_ADMISSION_TEST_ENV_FILE, never printed):
// TEST_DATABASE_URL is the native `web` runtime role (business DML, reads public."user");
// MIGRATION_DATABASE_URL is the schema owner of the same `_test_` database, for fixtures only.
// This file is not the one of pg-boss-client.integration.test.ts, whose TEST_DATABASE_URL
// must lack business table rights: run each suite with its own file.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { serializePrincipal } from '@sim/auth/principal'
import {
  assertDisposableTestDatabaseUrl,
  clearInheritedDatabaseUrls,
} from '@sim/db/testing/test-infrastructure'
import { eq, inArray, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { AsyncJobEnqueueError } from '../types'
import { mock } from 'bun:test'

const envFile = process.env.MEMLIA_QUEUE_ADMISSION_TEST_ENV_FILE
assert.ok(envFile, 'Dedicated P03 test environment required; no integration skip')
const env = Object.fromEntries(
  readFileSync(envFile, 'utf8')
    .split('\n')
    .filter((line) => line.includes('='))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
)
const runtimeUrl = assertDisposableTestDatabaseUrl(env.TEST_DATABASE_URL)
const ownerUrl = assertDisposableTestDatabaseUrl(env.MIGRATION_DATABASE_URL)
assert.equal(runtimeUrl.pathname, ownerUrl.pathname)
assert.notEqual(runtimeUrl.username, ownerUrl.username)
clearInheritedDatabaseUrls()
process.env.DATABASE_URL = env.TEST_DATABASE_URL
process.env.DB_APP_NAME = `workflow-admission-test-${randomUUID()}`
const { db } = await import('@sim/db')
// Another suite may already own the cached native pool in the same Bun process.
const [{ application_name: applicationName }] = await db.execute<{ application_name: string }>(
  sql`select current_setting('application_name') as application_name`
)
const schema = await import('@sim/db/schema')
const { user, session, workspace, workflow, organization, permissions, asyncJobs, outboxEvent } =
  schema
const { insertWorkspaceFixture, deleteWorkspaceFixture } = await import(
  '@sim/db/testing/workspace-fixtures'
)
const ownerClient = postgres(env.MIGRATION_DATABASE_URL, { max: 2, onnotice: () => {} })
const owner = drizzle(ownerClient, { schema })

// Only the external access-control configuration and a controlled wait are doubled.
// Session, account, canonical context, permissions, publication and PostgreSQL stay native.
const accessControl = await import('@/lib/auth/access-control')
let configWait: (() => Promise<void>) | undefined
const configFailure = false
const blockedEmails: string[] = []
mock.module('@/lib/auth/access-control', () => ({
  ...accessControl,
  getAccessControlConfig: async () => {
    await configWait?.()
    if (configFailure) throw new Error('private-cause-canary')
    return {
      blockedEmails,
      blockedSignupDomains: [],
      allowedLoginEmails: [],
      allowedLoginDomains: [],
      blockedEmailMxHosts: [],
    }
  },
}))
const { preparePgBossWorkflowAdmission: prepare, admitPgBossWorkflowAdmission: admit } =
  await import('./pg-boss-workflow-admission')
const prefix = `admit-${randomUUID()}`
const ids = {
  users: [] as string[],
  workspaces: [] as string[],
  organizations: [] as string[],
  jobs: [] as string[],
  events: [] as string[],
}
const now = new Date()
async function fixture(label: string, org = false) {
  const id = `${prefix}-${label}`
  const userId = `${id}-user`
  const sessionId = `${id}-session`
  const workspaceId = `${id}-space`
  const workflowId = `${id}-workflow`
  const organizationId = org ? `${id}-org` : null
  ids.users.push(userId)
  ids.workspaces.push(workspaceId)
  await owner.insert(user).values({
    id: userId,
    name: 'Authority fixture',
    email: `${id}@example.invalid`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  })
  if (organizationId) {
    ids.organizations.push(organizationId)
    await owner
      .insert(organization)
      .values({ id: organizationId, name: 'Fixture', slug: organizationId })
  }
  await insertWorkspaceFixture(owner, {
    id: workspaceId,
    name: 'Authority fixture',
    ownerId: userId,
    billedAccountUserId: userId,
    organizationId,
  })
  await owner.insert(workflow).values({
    id: workflowId,
    name: 'Authority fixture',
    userId,
    workspaceId,
    lastSynced: now,
    createdAt: now,
    updatedAt: now,
  })
  await owner.insert(session).values({
    id: sessionId,
    token: randomUUID(),
    userId,
    expiresAt: new Date(Date.now() + 3600000),
    createdAt: now,
    updatedAt: now,
  })
  await owner.insert(permissions).values({
    id: `${id}-permission`,
    userId,
    entityId: workspaceId,
    entityType: 'workspace',
    permissionType: 'read',
  })
  const principal = { kind: 'session' as const, userId, sessionId }
  return {
    userId,
    sessionId,
    workspaceId,
    workflowId,
    organizationId,
    principal,
    input: { authenticatedPrincipal: principal, workflowId, workspaceId },
  }
}

function params(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    requestId: `${prefix}-request`,
    workflowId: f.workflowId,
    principal: { ...f.principal },
    userId: f.userId,
    workspaceId: f.workspaceId,
    input: { value: 'original' },
    billingAttribution: {
      actorUserId: f.userId,
      workspaceId: f.workspaceId,
      organizationId: f.organizationId,
      billedAccountUserId: f.userId,
      billingEntity: {
        type: f.organizationId ? ('organization' as const) : ('user' as const),
        id: f.organizationId ?? f.userId,
      },
      billingPeriod: { start: '2026-01-01T00:00:00.000Z', end: '2027-01-01T00:00:00.000Z' },
      payerSubscription: null,
    },
    triggerType: 'manual' as const,
    executionId: `${prefix}-${randomUUID()}`,
    executionTimeoutMs: 900000,
    enforceCredentialAccess: true,
    isPublicApiAccess: false,
  }
}
function identity() {
  return {
    commandId: randomUUID(),
    submittedAt: now.toISOString(),
    admissionCompleted: true as const,
  }
}
async function save(handle: ReturnType<typeof prepare>) {
  const result = await admit(handle)
  ids.jobs.push(result.jobId)
  ids.events.push(result.outboxEventId)
  return result
}
async function rows(jobId: string) {
  return db.select().from(asyncJobs).where(eq(asyncJobs.id, jobId))
}
function bounded(error: unknown, acceptance: string) {
  assert.ok(error instanceof AsyncJobEnqueueError)
  assert.equal(error.message, 'workflow_admission_rejected')
  assert.equal(error.acceptance, acceptance)
  assert.equal(error.cause, undefined)
  assert.equal(JSON.stringify(error).includes(prefix), false)
  return true
}
test(
  'session workflow admission persists native payload and outbox only',
  { timeout: 30000 },
  async (t) => {
    t.after(async () => {
      configWait = undefined
      if (ids.events.length) await db.delete(outboxEvent).where(inArray(outboxEvent.id, ids.events))
      if (ids.jobs.length) await db.delete(asyncJobs).where(inArray(asyncJobs.id, ids.jobs))
      if (ids.workspaces.length)
        await deleteWorkspaceFixture(owner, inArray(workspace.id, ids.workspaces))
      if (ids.users.length) await owner.delete(user).where(inArray(user.id, ids.users))
      if (ids.organizations.length)
        await owner.delete(organization).where(inArray(organization.id, ids.organizations))
      assert.equal(
        (await db.select().from(asyncJobs).where(inArray(asyncJobs.id, ids.jobs))).length,
        0
      )
      await ownerClient.end()
    })
    await t.test(
      'authority in flight must retain uncertainty across concurrent logout',
      async () => {
        const f = await fixture('review-authority-inflight')
        const p = params(f)
        const handle = prepare(p, identity())
        let entered!: () => void
        let release!: () => void
        const waiting = new Promise<void>((resolve) => {
          entered = resolve
        })
        const gate = new Promise<void>((resolve) => {
          release = resolve
        })
        let configCalls = 0
        configWait = async () => {
          if (++configCalls === 1) {
            entered()
            await gate
          }
        }
        const pending = save(handle)
        try {
          await waiting
          await owner
            .update(session)
            .set({ expiresAt: new Date(0) })
            .where(eq(session.id, f.sessionId))
          let refused: unknown
          try {
            await admit(handle)
          } catch (error) {
            refused = error
          }
          assert.ok(refused instanceof AsyncJobEnqueueError)
          const observedRefusal = refused.acceptance
          release()
          const first = await pending
          const stored = await rows(first.jobId)
          assert.equal(first.kind, 'admission_committed')
          assert.equal(stored.length, 1)
          assert.equal(
            observedRefusal,
            'unknown',
            'A concurrent attempt can still commit after the session read, so rejected is unsafe'
          )
        } finally {
          release()
          await pending
          configWait = undefined
        }
      }
    )
    await t.test('isolated authority refusals release the attempt count exactly once', async () => {
      const f = await fixture('authority-count')
      const handle = prepare(params(f), identity())
      await owner
        .update(session)
        .set({ expiresAt: new Date(0) })
        .where(eq(session.id, f.sessionId))
      for (let attempt = 0; attempt < 3; attempt++)
        await assert.rejects(
          () => admit(handle),
          (error) => bounded(error, 'rejected')
        )
      await owner
        .update(session)
        .set({ expiresAt: new Date(Date.now() + 3600000) })
        .where(eq(session.id, f.sessionId))
      assert.equal((await save(handle)).kind, 'admission_committed')
    })
    await t.test(
      'personal and organization admission use canonical scope and retain native supervision duration',
      async () => {
        for (const org of [false, true]) {
          const f = await fixture(org ? 'org' : 'personal', org)
          const p = params(f)
          const i = identity()
          const handle = prepare(p, i)
          assert.deepEqual(Object.keys(handle), ['kind'])
          assert.equal(Object.isFrozen(handle), true)
          const result = await save(handle)
          assert.equal(result.kind, 'admission_committed')
          const [job] = await rows(result.jobId)
          const payload = job.payload as Record<string, unknown>
          const metadata = job.metadata as any
          assert.equal(job.id, `workflow-execution:${p.executionId}`)
          assert.equal(job.status, 'pending')
          assert.equal(job.maxAttempts, 1)
          assert.equal(metadata.maxDurationSeconds, 1200)
          assert.equal(payload.executionTimeoutMs, 900000)
          assert.equal(payload.admissionCompleted, true)
          assert.equal(payload.executionMode, 'async')
          assert.equal(payload.enforceCredentialAccess, true)
          assert.equal(payload.isPublicApiAccess, false)
          assert.deepEqual(payload.principal, serializePrincipal(f.principal))
          assert.deepEqual(payload.input, p.input)
          for (const key of [
            'callChain',
            'attribution',
            'triggerBlockId',
            'trustedInitialResolvedSecretTraceProvenance',
          ])
            assert.equal(key in payload, false)
          const envelope = metadata.memliaPgBossAdmission.envelope
          assert.equal(envelope.authority.organizationId, f.organizationId)
          assert.deepEqual(envelope.authority.scopes, [])
          assert.deepEqual(envelope.authority.allowedTools, [])
          assert.equal(envelope.commandId, i.commandId)
          assert.equal(envelope.submittedAt, i.submittedAt)
          assert.equal(envelope.effectPolicy.kind, 'no_automatic_retry')
          const [event] = await db
            .select()
            .from(outboxEvent)
            .where(eq(outboxEvent.id, result.outboxEventId))
          assert.deepEqual(Object.keys(event.payload as object).sort(), [
            'admissionDigest',
            'nativeJobId',
          ])
          assert.equal(event.availableAt.toISOString(), i.submittedAt)
        }
      }
    )
    await t.test(
      'explicit profile, principal, billing and lossless JSON reject before any insert',
      async () => {
        const f = await fixture('invalid')
        const p = params(f)
        assert.doesNotThrow(() =>
          prepare({ ...p, executionTimeoutMs: 86_340_000 - 300_000 }, identity())
        )
        // A session queue request may carry no input: omitted, never persisted as an undefined key.
        assert.doesNotThrow(() => prepare({ ...p, input: undefined }, identity()))
        for (const patch of [
          { enforceCredentialAccess: undefined },
          { enforceCredentialAccess: false },
          { isPublicApiAccess: undefined },
          { isPublicApiAccess: true },
          { principal: { kind: 'personal_api_key', userId: f.userId, keyId: 'fixture' } },
          { userId: 'other' },
          { executionTimeoutMs: Number.NaN },
          { executionTimeoutMs: 0 },
          { executionTimeoutMs: Number.POSITIVE_INFINITY },
          { executionTimeoutMs: 86_340_000 - 300_000 + 1 },
          { input: { hidden: undefined } },
          { input: new Date() },
          { input: () => 0 },
          { billingAttribution: { ...p.billingAttribution, workspaceId: 'wrong' } },
        ])
          assert.throws(
            () => prepare({ ...p, ...patch } as any, identity()),
            (e) => bounded(e, 'rejected')
          )
        for (const admissionCompleted of [undefined, false])
          assert.throws(
            () => prepare(p, { ...identity(), admissionCompleted } as any),
            (e) => bounded(e, 'rejected')
          )
        let getterCalls = 0
        const getter = {}
        Object.defineProperty(getter, 'secret', {
          enumerable: true,
          get() {
            getterCalls++
            return 'not-readable'
          },
        })
        const hidden = {}
        Object.defineProperty(hidden, 'secret', { value: 'not-discardable' })
        const sparse = Array(2)
        sparse[1] = 1
        Object.assign(sparse, { extra: 'x' })
        const cycle: any = {}
        cycle.self = cycle
        for (const input of [getter, hidden, sparse, cycle])
          assert.throws(
            () => prepare({ ...p, input }, identity()),
            (e) => bounded(e, 'rejected')
          )
        const outer = { ...p }
        Object.defineProperty(outer, 'input', {
          enumerable: true,
          get() {
            getterCalls++
            return 'never'
          },
        })
        assert.throws(
          () => prepare(outer, identity()),
          (e) => bounded(e, 'rejected')
        )
        const hiddenOptional = { ...p }
        Object.defineProperty(hiddenOptional, 'callChain', { value: undefined })
        assert.throws(
          () => prepare(hiddenOptional, identity()),
          (e) => bounded(e, 'rejected')
        )
        for (const id of [
          { ...identity(), commandId: 'invalid:reference' },
          { ...identity(), submittedAt: 'not-time' },
          { ...identity(), extra: true },
        ])
          assert.throws(
            () => prepare(p, id),
            (e) => bounded(e, 'rejected')
          )
        assert.throws(
          () => prepare({ ...p, input: 'x'.repeat(1024 * 1024) }, identity()),
          (e) => bounded(e, 'rejected')
        )
        assert.equal(getterCalls, 0)
        assert.equal((await rows(`workflow-execution:${p.executionId}`)).length, 0)
        await assert.rejects(
          () => admit({ kind: 'prepared_workflow_admission' } as any),
          (e) => bounded(e, 'rejected')
        )
      }
    )
    await t.test(
      'stable handle supports concurrent duplicate admission and rejects changed command/payload',
      async () => {
        const f = await fixture('concurrent')
        const p = params(f)
        const i = identity()
        const handle = prepare(p, i)
        const both = await Promise.all([save(handle), save(handle)])
        assert.deepEqual(both.map((x) => x.duplicate).sort(), [false, true])
        assert.equal(both[0].jobId, both[1].jobId)
        assert.equal((await rows(both[0].jobId)).length, 1)
        for (const other of [
          prepare({ ...p, input: { value: 'changed' } }, i),
          prepare(p, identity()),
        ])
          await assert.rejects(
            () => admit(other),
            (e) => bounded(e, 'rejected')
          )
        const replay = await save(prepare(p, i))
        assert.equal(replay.duplicate, true)
      }
    )
    await t.test(
      'caller mutation during native authority wait cannot change prepared identity or nested data',
      async () => {
        const f = await fixture('mutable')
        const p = params(f)
        const i = identity()
        const handle = prepare(p, i)
        let entered!: () => void
        let release!: () => void
        const waiting = new Promise<void>((r) => (entered = r))
        const gate = new Promise<void>((r) => (release = r))
        configWait = async () => {
          entered()
          await gate
        }
        const pending = save(handle)
        await waiting
        p.input.value = 'changed'
        p.principal.sessionId = 'changed'
        p.billingAttribution.billingPeriod.end = 'wrong'
        p.executionId = 'changed'
        i.commandId = 'changed'
        i.submittedAt = 'wrong'
        release()
        try {
          const result = await pending
          const [job] = await rows(result.jobId)
          assert.deepEqual((job.payload as any).input, { value: 'original' })
          assert.equal((job.payload as any).principal.principal.sessionId, f.sessionId)
          assert.equal(
            (job.metadata as any).memliaPgBossAdmission.envelope.commandId === 'changed',
            false
          )
        } finally {
          configWait = undefined
        }
      }
    )
    await t.test(
      'revocation and canonical organization mismatch reject; prior committed handle remains possibly accepted',
      async () => {
        const f = await fixture('revoked')
        const p = params(f)
        const handle = prepare(p, identity())
        const result = await save(handle)
        await owner
          .update(session)
          .set({ expiresAt: new Date(0) })
          .where(eq(session.id, f.sessionId))
        await assert.rejects(
          () => admit(handle),
          (e) => bounded(e, 'unknown')
        )
        const fresh = params(f)
        await assert.rejects(
          () => admit(prepare(fresh, identity())),
          (e) => bounded(e, 'rejected')
        )
        assert.equal((await rows(`workflow-execution:${fresh.executionId}`)).length, 0)
        assert.equal((await rows(result.jobId))[0].status, 'pending')
        const org = await fixture('mismatch', true)
        const mismatch = params(org)
        mismatch.billingAttribution = {
          ...mismatch.billingAttribution,
          organizationId: null,
          billingEntity: { type: 'user', id: org.userId },
        }
        await assert.rejects(
          () => admit(prepare(mismatch, identity())),
          (e) => bounded(e, 'rejected')
        )
      }
    )
    await t.test(
      'another in-flight admission makes concurrent revocation acceptance unknown',
      async () => {
        const f = await fixture('inflight')
        const p = params(f)
        const i = identity()
        const original = await save(prepare(p, i))
        const handle = prepare(p, i)
        let locked!: () => void
        let release!: () => void
        const ready = new Promise<void>((r) => (locked = r))
        const gate = new Promise<void>((r) => (release = r))
        const blocker = owner.transaction(async (tx) => {
          await tx
            .select()
            .from(outboxEvent)
            .where(eq(outboxEvent.id, original.outboxEventId))
            .for('update')
          locked()
          await gate
        })
        await ready
        const pending = save(handle)
        try {
          let waiting = false
          for (let n = 0; n < 100; n++) {
            const [row] = await db.execute<{ waiting: boolean }>(
              sql`select exists(select 1 from pg_stat_activity where application_name = ${applicationName} and cardinality(pg_blocking_pids(pid)) > 0) as waiting`
            )
            if (row.waiting) {
              waiting = true
              break
            }
            await new Promise((r) => setTimeout(r, 10))
          }
          assert.equal(waiting, true)
          await owner
            .update(session)
            .set({ expiresAt: new Date(0) })
            .where(eq(session.id, f.sessionId))
          await assert.rejects(
            () => admit(handle),
            (e) => bounded(e, 'unknown')
          )
        } finally {
          release()
          await blocker
          await pending
        }
      }
    )

    await t.test(
      'native savepoint rolls back orphan recreation without changing the outbox',
      async () => {
        const f = await fixture('rollback')
        const p = params(f)
        const i = identity()
        const first = await save(prepare(p, i))
        const [before] = await db
          .select()
          .from(outboxEvent)
          .where(eq(outboxEvent.id, first.outboxEventId))
        await db.delete(asyncJobs).where(eq(asyncJobs.id, first.jobId))
        await assert.rejects(
          () => admit(prepare(p, i)),
          (e) => bounded(e, 'rejected')
        )
        assert.equal((await rows(first.jobId)).length, 0)
        assert.deepEqual(
          (await db.select().from(outboxEvent).where(eq(outboxEvent.id, first.outboxEventId)))[0],
          before
        )
      }
    )
    await t.test(
      'real commit with deliberately lost response is unknown; stable retry finds the native duplicate',
      async () => {
        const f = await fixture('response')
        const p = params(f)
        const handle = prepare(p, identity())
        const original = db.transaction
        let committed: { jobId: string; outboxEventId: string } | undefined
        // Explicit response-loss simulation AFTER an actual database commit, not a network-failure qualification.
        db.transaction = (async (...args: Parameters<typeof original>) => {
          const result = await original.apply(db, args)
          committed = result as typeof committed
          throw new Error('private-commit-response-canary')
        }) as typeof original
        try {
          await assert.rejects(
            () => admit(handle),
            (e) => bounded(e, 'unknown')
          )
        } finally {
          db.transaction = original
        }
        assert.ok(committed)
        ids.jobs.push(committed.jobId)
        ids.events.push(committed.outboxEventId)
        assert.equal((await rows(committed.jobId)).length, 1)
        assert.equal((await save(handle)).duplicate, true)
        await owner
          .update(session)
          .set({ expiresAt: new Date(0) })
          .where(eq(session.id, f.sessionId))
        await assert.rejects(
          () => admit(handle),
          (e) => bounded(e, 'unknown')
        )
      }
    )
    await t.test(
      'native helper preserves payload, inline routing, bounded retries and release classification',
      async () => {
        const f = await fixture('helper')
        const p = params(f)
        const { runWithRequestContext } = await import('@sim/logger')
        const { prepareWorkflowExecutionPayload } = await import(
          '@/lib/workflows/executor/workflow-execution-payload'
        )
        let releaseCount = 0
        let runnerCount = 0
        let inline = false
        let initializationFailure = false
        let calls: { payload: unknown; options: any }[] = []
        let failures: Error[] = []
        // Only the native helper's external queue, runner and reservation effects are doubled.
        // The helper, shared builder and error classes themselves execute unchanged.
        mock.module('@/lib/core/async-jobs', () => ({
          getJobQueue: async () => {
            if (initializationFailure) throw new Error('fixture-init')
            return {
              enqueue: async (type: string, payload: unknown, options: any) => {
                assert.equal(type, 'workflow-execution')
                calls.push({ payload, options })
                if (failures.length) throw failures.shift()
                return options.jobId
              },
            }
          },
          shouldExecuteInline: () => inline,
        }))
        mock.module('@/lib/billing/calculations/usage-reservation', () => ({
          releaseExecutionSlot: async (id: string) => {
            assert.equal(id, p.executionId)
            releaseCount++
          },
        }))
        mock.module('@/background/workflow-execution', () => ({
          executeWorkflowJob: async (payload: unknown) => {
            runnerCount++
            return payload
          },
        }))
        const { enqueueWorkflowExecution } = await import(
          '@/lib/workflows/executor/enqueue-execution'
        )
        const rich = {
          ...p,
          triggerBlockId: 'block',
          copilotToolCallId: 'call',
          callChain: ['parent'],
          trustedInitialResolvedSecretTraceProvenance: {
            version: 1 as const,
            complete: true,
            entries: [],
          },
        }
        const context = { requestId: p.requestId, auth: { kind: 'session' } }
        const expected = structuredClone(
          runWithRequestContext(context, () => prepareWorkflowExecutionPayload(rich))
        )
        assert.deepEqual(expected.payload.attribution, { auth: { kind: 'session' } })
        const handle = runWithRequestContext(context, () => prepare(rich, identity()))
        context.auth.kind = 'mutated-after-preparation'
        const stored = await save(handle)
        assert.deepEqual((await rows(stored.jobId))[0].payload, expected.payload)
        for (const inlineMode of [false, true]) {
          calls = []
          inline = inlineMode
          const result = await runWithRequestContext(
            { requestId: p.requestId, auth: { kind: 'session' } },
            () => enqueueWorkflowExecution(rich)
          )
          assert.equal(result.outcome, 'queued')
          assert.equal(calls.length, 1)
          assert.deepEqual(calls[0].payload, expected.payload)
          assert.equal(calls[0].options.maxDurationSeconds, 1200)
          assert.deepEqual(calls[0].options.metadata, {
            workflowId: p.workflowId,
            workspaceId: p.workspaceId,
            userId: p.userId,
            correlation: expected.correlation,
          })
          assert.equal('runner' in calls[0].options, inlineMode)
          if (inlineMode)
            assert.deepEqual(
              await calls[0].options.runner(null, new AbortController().signal),
              expected.payload
            )
        }
        assert.equal(runnerCount, 1)
        assert.equal(releaseCount, 0)
        for (const scenario of [
          {
            failures: [
              new AsyncJobEnqueueError('fixture', { acceptance: 'rejected', retryable: false }),
            ],
            outcome: 'rejected',
            attempts: 1,
            release: 1,
          },
          {
            failures: [
              new AsyncJobEnqueueError('fixture', { acceptance: 'rejected', retryable: true }),
              new AsyncJobEnqueueError('fixture', { acceptance: 'rejected', retryable: true }),
            ],
            outcome: 'rejected',
            attempts: 2,
            release: 1,
          },
          {
            failures: [
              new Error('unknown'),
              new AsyncJobEnqueueError('fixture', { acceptance: 'rejected', retryable: false }),
            ],
            outcome: 'ambiguous',
            attempts: 2,
            release: 0,
          },
          { failures: [new Error('unknown')], outcome: 'queued', attempts: 2, release: 0 },
        ]) {
          calls = []
          releaseCount = 0
          failures = [...scenario.failures]
          assert.equal((await enqueueWorkflowExecution(p)).outcome, scenario.outcome)
          assert.equal(calls.length, scenario.attempts)
          assert.equal(releaseCount, scenario.release)
          assert.equal(new Set(calls.map((c) => c.options.jobId)).size, 1)
        }
        calls = []
        releaseCount = 0
        initializationFailure = true
        assert.equal((await enqueueWorkflowExecution(p)).outcome, 'rejected')
        assert.equal(calls.length, 0)
        assert.equal(releaseCount, 1)
      }
    )
  }
)
