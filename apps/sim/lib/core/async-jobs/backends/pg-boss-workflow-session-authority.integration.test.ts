// Copyright 2026 Memlia. All rights reserved.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { JobEnvelopeSchema } from '@memlia/contracts'
import { serializePrincipal } from '@sim/auth/principal'
import {
  assertDisposableTestDatabaseUrl,
  clearInheritedDatabaseUrls,
} from '@sim/db/testing/test-infrastructure'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
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
const applicationName = `authority-test-${randomUUID()}`
process.env.DB_APP_NAME = applicationName
const { db } = await import('@sim/db')
const schema = await import('@sim/db/schema')
const {
  user,
  session,
  workspace,
  workflow,
  organization,
  member,
  permissions,
  asyncJobs,
  outboxEvent,
} = schema
const { insertWorkspaceFixture, deleteWorkspaceFixture } = await import(
  '@sim/db/testing/workspace-fixtures'
)
const ownerClient = postgres(env.MIGRATION_DATABASE_URL, { max: 2, onnotice: () => {} })
const owner = drizzle(ownerClient, { schema })

// Only the external access-control configuration and a controlled wait are doubled.
// Session, account, canonical context, permissions, publication and PostgreSQL stay native.
const accessControl = await import('@/lib/auth/access-control')
let configWait: (() => Promise<void>) | undefined
let configFailure = false
let blockedEmails: string[] = []
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
const {
  capturePgBossWorkflowSessionAuthority: capture,
  revalidatePgBossWorkflowSessionAuthority: revalidate,
} = await import('./pg-boss-workflow-session-authority')
const { admitPgBossJob } = await import('./pg-boss-admission')
const prefix = `authority-${randomUUID()}`
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
async function publication(
  f: Awaited<ReturnType<typeof fixture>>,
  changes: { authority?: unknown; payload?: Record<string, unknown>; runner?: string } = {}
) {
  const jobId = `${prefix}-${randomUUID()}`
  ids.jobs.push(jobId)
  const authority = changes.authority ?? (await capture(f.input))
  const envelope = JobEnvelopeSchema.parse({
    schemaVersion: 'memlia.job/v1',
    commandId: 'fixture-command',
    runId: `${jobId}-run`,
    runner: changes.runner ?? 'workflow-execution',
    inputs: [],
    idempotencyKey: jobId,
    submittedAt: new Date().toISOString(),
    effectPolicy: { kind: 'no_automatic_retry' },
    authority,
  })
  const payload = {
    workflowId: f.workflowId,
    workspaceId: f.workspaceId,
    executionId: envelope.runId,
    principal: serializePrincipal(f.principal),
    ...changes.payload,
  }
  const admitted = await db.transaction((tx) => admitPgBossJob(tx, { jobId, envelope, payload }))
  ids.events.push(admitted.outboxEventId)
  const [event] = await db
    .select()
    .from(outboxEvent)
    .where(eq(outboxEvent.id, admitted.outboxEventId))
  return { reference: event.payload, jobId, envelope }
}
async function denied(action: () => Promise<unknown>) {
  await assert.rejects(action, (error) => {
    assert.ok(error instanceof Error)
    assert.equal(error.message, 'workflow_session_authority_rejected')
    assert.equal('cause' in error, false)
    assert.equal(JSON.stringify(error).includes(prefix), false)
    return true
  })
}

test(
  'workflow session authority uses native PostgreSQL reads and authorization',
  { timeout: 30000 },
  async (t) => {
    t.after(async () => {
      configWait = undefined
      configFailure = false
      blockedEmails = []
      if (ids.events.length) await db.delete(outboxEvent).where(inArray(outboxEvent.id, ids.events))
      if (ids.jobs.length) await db.delete(asyncJobs).where(inArray(asyncJobs.id, ids.jobs))
      if (ids.workspaces.length)
        await deleteWorkspaceFixture(owner, inArray(workspace.id, ids.workspaces))
      if (ids.users.length) await owner.delete(user).where(inArray(user.id, ids.users))
      if (ids.organizations.length)
        await owner.delete(organization).where(inArray(organization.id, ids.organizations))
      assert.equal(
        (await owner.select({ id: user.id }).from(user).where(inArray(user.id, ids.users))).length,
        0
      )
      assert.equal(
        (await db.select().from(asyncJobs).where(inArray(asyncJobs.id, ids.jobs))).length,
        0
      )
      await ownerClient.end()
    })
    await t.test(
      'personal null and organizational scopes; internal capture is distinct from persisted provenance',
      async () => {
        for (const org of [false, true]) {
          const f = await fixture(org ? 'organization' : 'personal', org)
          const authority = await capture(f.input)
          assert.equal(authority.organizationId, f.organizationId)
          assert.deepEqual(authority.scopes, [])
          assert.deepEqual(authority.allowedTools, [])
          assert.deepEqual(authority.actor, serializePrincipal(f.principal))
          const p = await publication(f)
          const result = await revalidate(p.reference)
          assert.deepEqual(result, {
            kind: 'authority_checked',
            origin: 'persisted_admission',
            userId: f.userId,
            workflowId: f.workflowId,
            workspaceId: f.workspaceId,
            organizationId: f.organizationId,
          })
          assert.equal(JSON.stringify(result).includes(f.sessionId), false)
          await denied(() => revalidate(p.envelope))
          await denied(() => revalidate({ jobId: p.jobId, envelope: p.envelope }))
        }
      }
    )
    await t.test(
      'sessions must exist, match the subject, remain live, and not impersonate',
      async () => {
        const f = await fixture('sessions')
        const p = await publication(f)
        await denied(() =>
          capture({ ...f.input, authenticatedPrincipal: { ...f.principal, userId: 'absent' } })
        )
        await owner
          .update(session)
          .set({ expiresAt: new Date(0) })
          .where(eq(session.id, f.sessionId))
        await denied(() => revalidate(p.reference))
        await owner
          .update(session)
          .set({ expiresAt: new Date(Date.now() + 3600000), impersonatedBy: f.userId })
          .where(eq(session.id, f.sessionId))
        await denied(() => capture(f.input))
        await owner.delete(session).where(eq(session.id, f.sessionId))
        await denied(() => revalidate(p.reference))
        await denied(() =>
          capture({ ...f.input, authenticatedPrincipal: { ...f.principal, sessionId: 'missing' } })
        )
      }
    )
    await t.test(
      'native bans, suspensions, expired bans and configured email refusal',
      async () => {
        const f = await fixture('accounts')
        const p = await publication(f)
        for (const patch of [{ banned: true }, { banned: false, suspendedAt: now }]) {
          await owner.update(user).set(patch).where(eq(user.id, f.userId))
          await denied(() => revalidate(p.reference))
        }
        await owner
          .update(user)
          .set({ banned: true, banExpires: new Date(0), suspendedAt: null })
          .where(eq(user.id, f.userId))
        assert.equal((await revalidate(p.reference)).kind, 'authority_checked')
        blockedEmails = [`${prefix}-accounts@example.invalid`]
        await denied(() => revalidate(p.reference))
        blockedEmails = []
        configFailure = true
        try {
          await denied(() => revalidate(p.reference))
        } finally {
          configFailure = false
        }
      }
    )
    await t.test(
      'current permissions, organization scope and active canonical resources are required',
      async () => {
        const f = await fixture('scope', true)
        const p = await publication(f)
        await owner
          .delete(permissions)
          .where(and(eq(permissions.userId, f.userId), eq(permissions.entityId, f.workspaceId)))
        await denied(() => revalidate(p.reference)) // Being workspace/workflow owner does not grant permission.
        await owner.insert(member).values({
          id: `${prefix}-member`,
          userId: f.userId,
          organizationId: f.organizationId!,
          role: 'admin',
        })
        assert.equal((await revalidate(p.reference)).kind, 'authority_checked')
        await owner.delete(member).where(eq(member.userId, f.userId))
        await owner.insert(permissions).values({
          id: `${prefix}-restored`,
          userId: f.userId,
          entityId: f.workspaceId,
          entityType: 'workspace',
          permissionType: 'read',
        })
        const authority = await capture(f.input)
        for (const organizationId of [null, `${prefix}-other`]) {
          const mismatch = await publication(f, { authority: { ...authority, organizationId } })
          await denied(() => revalidate(mismatch.reference))
        }
        await owner.update(workflow).set({ archivedAt: now }).where(eq(workflow.id, f.workflowId))
        await denied(() => revalidate(p.reference))
        await owner.update(workflow).set({ archivedAt: null }).where(eq(workflow.id, f.workflowId))
        await owner
          .update(workspace)
          .set({ archivedAt: now })
          .where(eq(workspace.id, f.workspaceId))
        await denied(() => revalidate(p.reference))
      }
    )
    await t.test(
      'unsupported authorities, grants, legacy payloads and mismatched identities never fall back',
      async () => {
        const f = await fixture('binding')
        for (const principal of [
          undefined,
          {
            kind: 'system',
            serviceId: 'internal',
            workspaceId: f.workspaceId,
            workflowId: f.workflowId,
          },
          { kind: 'personal_api_key', userId: f.userId, keyId: 'key' },
          {
            kind: 'oauth_access_token',
            userId: f.userId,
            tokenId: 'token',
            clientId: 'client',
            scopes: [],
            expiresAt: new Date(),
          },
        ]) {
          await denied(() => capture({ ...f.input, authenticatedPrincipal: principal }))
        }
        const authority = await capture(f.input)
        for (const change of [
          { scopes: ['workflow:read'] },
          { allowedTools: ['workflows.read'] },
          { subject: { kind: 'user', userId: 'other' } },
          { authority: { kind: 'delegation', delegationId: 'grant' } },
        ]) {
          const p = await publication(f, { authority: { ...authority, ...change } })
          await denied(() => revalidate(p.reference))
        }
        for (const payload of [
          { principal: null },
          { principal: serializePrincipal({ ...f.principal, sessionId: 'other' }) },
          { workflowId: 'missing' },
          { workspaceId: 'other' },
          { executionId: 'other' },
        ]) {
          const p = await publication(f, { payload })
          await denied(() => revalidate(p.reference))
        }
        const wrongRunner = await publication(f, { runner: 'cleanup-logs' })
        await denied(() => revalidate(wrongRunner.reference))
        const p = await publication(f)
        await denied(() => revalidate({ nativeJobId: p.jobId, admissionDigest: '0'.repeat(64) }))
        await denied(() => revalidate({ nativeJobId: 'missing', admissionDigest: '0'.repeat(64) }))
        await db.update(asyncJobs).set({ status: 'cancelled' }).where(eq(asyncJobs.id, p.jobId))
        await denied(() => revalidate(p.reference))
      }
    )
    await t.test(
      'caller primitives stay captured across a controlled configuration wait',
      async () => {
        const f = await fixture('mutation')
        let entered!: () => void
        let release!: () => void
        const waiting = new Promise<void>((resolve) => {
          entered = resolve
        })
        const gate = new Promise<void>((resolve) => {
          release = resolve
        })
        configWait = async () => {
          entered()
          await gate
        }
        const input = { ...f.input, authenticatedPrincipal: { ...f.principal } }
        const pending = capture(input)
        await waiting
        input.authenticatedPrincipal.userId = 'wrong-after-await'
        input.authenticatedPrincipal.sessionId = 'wrong-after-await'
        input.workspaceId = 'wrong-after-await'
        input.workflowId = 'wrong-after-await'
        release()
        try {
          const authority = await pending
          assert.ok(authority.subject.kind === 'user')
          assert.equal(authority.subject.userId, f.userId)
          assert.equal(authority.workspaceId, f.workspaceId)
          assert.deepEqual(authority.actor, serializePrincipal(f.principal))
        } finally {
          configWait = undefined
        }
      }
    )
    await t.test(
      'publication reference cannot switch jobs while PostgreSQL blocks its snapshot',
      async () => {
        const a = await fixture('reference-a')
        const b = await fixture('reference-b')
        const pa = await publication(a)
        const pb = await publication(b)
        const reference = { ...(pa.reference as { nativeJobId: string; admissionDigest: string }) }
        let locked!: () => void
        let release!: () => void
        const ready = new Promise<void>((resolve) => {
          locked = resolve
        })
        const gate = new Promise<void>((resolve) => {
          release = resolve
        })
        const blocker = owner.transaction(async (tx) => {
          await tx
            .select({ id: asyncJobs.id })
            .from(asyncJobs)
            .where(eq(asyncJobs.id, pa.jobId))
            .for('update')
          locked()
          await gate
        })
        await ready
        const pending = revalidate(reference)
        try {
          let observed = false
          for (let index = 0; index < 100; index++) {
            const [row] = await db.execute<{ waiting: boolean }>(
              sql`select exists(select 1 from pg_stat_activity where application_name = ${applicationName} and cardinality(pg_blocking_pids(pid)) > 0) as waiting`
            )
            if (row.waiting) {
              observed = true
              break
            }
            await new Promise((resolve) => setTimeout(resolve, 10))
          }
          assert.equal(observed, true, 'Real PostgreSQL wait must precede caller mutation')
          Object.assign(reference, pb.reference)
        } finally {
          release()
          await blocker
        }
        const result = await pending
        assert.equal(result.workflowId, a.workflowId)
        assert.equal(result.userId, a.userId)
        assert.equal(result.workspaceId, a.workspaceId)
      }
    )
    await t.test(
      'workflow moves, deletion, missing accounts and payload tampering remain refused',
      async () => {
        const a = await fixture('move-a')
        const b = await fixture('move-b')
        const p = await publication(a)
        await owner
          .update(workflow)
          .set({ workspaceId: b.workspaceId, name: 'Moved fixture' })
          .where(eq(workflow.id, a.workflowId))
        await denied(() => revalidate(p.reference))
        await owner.delete(workflow).where(eq(workflow.id, a.workflowId))
        await denied(() => revalidate(p.reference))
        await denied(() =>
          capture({
            ...b.input,
            authenticatedPrincipal: {
              kind: 'session',
              userId: 'absent-account',
              sessionId: 'absent-session',
            },
          })
        )
        const intact = await publication(b)
        const [before] = await db.select().from(asyncJobs).where(eq(asyncJobs.id, intact.jobId))
        await revalidate(intact.reference)
        assert.deepEqual(
          (await db.select().from(asyncJobs).where(eq(asyncJobs.id, intact.jobId)))[0],
          before
        )
        assert.ok(before.payload !== null && typeof before.payload === 'object')
        await db
          .update(asyncJobs)
          .set({ payload: { ...before.payload, workflowId: a.workflowId } })
          .where(eq(asyncJobs.id, intact.jobId))
        await denied(() => revalidate(intact.reference))
      }
    )
    await t.test('runtime cannot read session tokens or mutate authority tables', async () => {
      for (const statement of [
        sql`select token from session limit 0`,
        sql`update "user" set banned = true where false`,
        sql`delete from session where false`,
      ]) {
        await assert.rejects(
          () => db.execute(statement),
          (error) => {
            const cause = (error as { cause?: { code?: string } }).cause
            assert.equal(cause?.code ?? (error as { code?: string }).code, '42501')
            return true
          }
        )
      }
    })
  }
)
