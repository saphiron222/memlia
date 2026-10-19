// Copyright 2026 Memlia. All rights reserved.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { JobEnvelopeSchema } from '@memlia/contracts'
import { eq, inArray } from 'drizzle-orm'

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
const { claimPgBossAttempt } = await import('./pg-boss-claim')
const { finalizePgBossAttempt } = await import('./pg-boss-finalize')
const { createPgBossNativeState } = await import('./pg-boss-native-state')
const state = createPgBossNativeState()
const prefix = `native-state-${randomUUID()}`
const jobIds: string[] = []
const eventIds: string[] = []

async function fixture(
  label: string,
  options: { runner?: string; workspaceId?: string; workflowId?: string; executionId?: string } = {}
) {
  const jobId = `${prefix}:${label}`
  jobIds.push(jobId)
  const workspaceId = options.workspaceId ?? `${prefix}-workspace`
  const executionId = options.executionId ?? `${prefix}-execution`
  const workflowId = options.workflowId ?? `${prefix}-workflow`
  const envelope = JobEnvelopeSchema.parse({
    schemaVersion: 'memlia.job/v1',
    commandId: 'fixture-command',
    runId: executionId,
    runner: options.runner ?? 'workflow-execution',
    inputs: [],
    idempotencyKey: `${prefix}-${label}`,
    submittedAt: '2026-01-01T00:00:00.000Z',
    effectPolicy: { kind: 'no_automatic_retry' },
    authority: {
      schemaVersion: 'memlia.principal/v1',
      organizationId: 'fixture-org',
      workspaceId,
      actor: {
        version: 1,
        principal: {
          kind: 'session',
          userId: 'fixture-user',
          sessionId: 'private-fixture-session',
        },
      },
      subject: { kind: 'user', userId: 'fixture-user' },
      authority: { kind: 'interactive' },
      scopes: ['workflow:read'],
      allowedTools: ['workflows.read'],
    },
  })
  const metadata = {
    workspaceId,
    workflowId,
    executionId,
    userId: 'fixture-user',
    correlation: {
      workflowId,
      executionId,
      source: 'workflow' as const,
      requestId: 'fixture-request',
    },
    custom: { memliaPgBossAdmission: 'ordinary-nested-value', retained: [1, false, null] },
  }
  const input = {
    jobId,
    envelope,
    payload: { fixture: label },
    metadata,
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
async function owned(label: string, options?: Parameters<typeof fixture>[1]) {
  const input = await fixture(label, options)
  const result = await claim(input)
  assert.equal(result.kind, 'claimed')
  if (result.kind !== 'claimed') throw Error('Fixture claim missing')
  return { input, attempt: result.attempt }
}
const returned = (value: unknown) => ({
  kind: 'returned' as const,
  outputJson: JSON.stringify(value),
})

test(
  'native job state projection and cancellations on PostgreSQL',
  { timeout: 30000 },
  async (t) => {
    t.after(async () => {
      if (eventIds.length) await db.delete(outboxEvent).where(inArray(outboxEvent.id, eventIds))
      if (jobIds.length) await db.delete(asyncJobs).where(inArray(asyncJobs.id, jobIds))
      assert.equal(
        (await db.select().from(asyncJobs).where(inArray(asyncJobs.id, jobIds))).length,
        0
      )
      assert.equal(
        (await db.select().from(outboxEvent).where(inArray(outboxEvent.id, eventIds))).length,
        0
      )
    })
    await t.test(
      'hides the reserved root in pending/processing reads, preserves other metadata and the stored identity',
      async () => {
        const input = await fixture('projection')
        for (const processing of [false, true]) {
          if (processing) assert.equal((await claim(input)).kind, 'claimed')
          const before = await row(input.jobId)
          const job = await state.getJob(input.jobId)
          assert.ok(job)
          assert.equal(job.status, processing ? 'processing' : 'pending')
          assert.deepEqual(job.metadata, { ...input.metadata, maxDurationSeconds: 900 })
          assert.equal(Object.hasOwn(job.metadata, 'memliaPgBossAdmission'), false)
          assert.equal(JSON.stringify(job).includes('private-fixture-session'), false)
          if (processing) {
            const internal = before.metadata?.memliaPgBossAdmission as {
              attempt: { token: string }
            }
            assert.equal(JSON.stringify(job).includes(internal.attempt.token), false)
          }
          assert.deepEqual(await row(input.jobId), before)
        }
        assert.equal(await state.getJob(`${prefix}:absent`), null)
        assert.deepEqual(Object.keys(state).sort(), [
          'cancelByExecution',
          'cancelByWorkspace',
          'cancelJob',
          'getJob',
        ])
      }
    )
    await t.test(
      'preserves failed business output with and without an error and successful terminal output',
      async () => {
        for (const [label, output, status] of [
          [
            'failure',
            { success: false, error: 'fixture_refusal', output: { partial: true } },
            'failed',
          ],
          ['failure-no-error', { success: false, output: { partial: [2] } }, 'failed'],
          ['success', { success: true, output: { amount: 42 } }, 'completed'],
        ] as const) {
          const { input, attempt } = await owned(label)
          await db.transaction((tx) => finalizePgBossAttempt(tx, attempt, returned(output)))
          const before = await row(input.jobId)
          const job = await state.getJob(input.jobId)
          assert.equal(job?.status, status)
          assert.deepEqual(job?.output, output)
          assert.deepEqual(job?.completedAt, before.completedAt)
          assert.equal(Object.hasOwn(job!.metadata, 'memliaPgBossAdmission'), false)
          await state.cancelJob(input.jobId)
          assert.deepEqual(await row(input.jobId), before)
        }
      }
    )
    await t.test('keeps the legacy completed-recorded-failure projection unchanged', async () => {
      const input = await fixture('legacy')
      const completedAt = new Date('2026-01-02T00:00:00.000Z')
      await db
        .update(asyncJobs)
        .set({
          status: 'completed',
          completedAt,
          metadata: input.metadata,
          output: { success: false, error: 'legacy_failure' },
        })
        .where(eq(asyncJobs.id, input.jobId))
      const job = await state.getJob(input.jobId)
      assert.equal(job?.status, 'failed')
      assert.equal(job?.error, 'legacy_failure')
      assert.equal(job?.output, null)
      assert.deepEqual(job?.metadata, input.metadata)
      assert.deepEqual(job?.completedAt, completedAt)
    })
    await t.test(
      'pending cancellation is durable and idempotent, prevents claim, and missing IDs are quiet',
      async () => {
        const input = await fixture('cancel-pending')
        await state.cancelJob(input.jobId)
        const cancelled = await row(input.jobId)
        assert.equal(cancelled.status, 'cancelled')
        assert.ok(cancelled.completedAt)
        await state.cancelJob(input.jobId)
        assert.deepEqual(await row(input.jobId), cancelled)
        const result = await claim(input)
        assert.equal(result.kind, 'terminal')
        assert.equal((await state.getJob(input.jobId))?.status, 'cancelled')
        assert.equal(
          Object.hasOwn((await state.getJob(input.jobId))!.metadata, 'memliaPgBossAdmission'),
          false
        )
        await state.cancelJob(`${prefix}:absent`)
      }
    )
    await t.test(
      'native processing cancellation revokes the committed finalization token',
      async () => {
        const { input, attempt } = await owned('cancel-processing')
        await state.cancelJob(input.jobId)
        const cancelled = await row(input.jobId)
        assert.deepEqual(
          await db.transaction((tx) =>
            finalizePgBossAttempt(tx, attempt, returned({ forbidden: true }))
          ),
          { kind: 'reconciliation_required' }
        )
        assert.deepEqual(await row(input.jobId), cancelled)
        assert.equal(cancelled.output, null)
      }
    )
    await t.test(
      'execution cancellation respects workflow identity and standalone/resume scope, excluding carriers',
      async () => {
        const executionId = `${prefix}-scoped-execution`
        const workflowId = `${prefix}-scoped-workflow`
        const exact = await owned('execution-exact', { executionId, workflowId })
        const resume = await fixture('execution-resume', {
          executionId,
          workflowId,
          runner: 'resume-execution',
        })
        const carrier = await fixture('execution-carrier', {
          executionId,
          workflowId,
          runner: 'workflow-group-cell',
        })
        const foreignWorkflow = await fixture('execution-foreign-workflow', {
          executionId,
          workflowId: `${workflowId}-other`,
        })
        const foreignExecution = await fixture('execution-foreign-run', {
          executionId: `${executionId}-other`,
          workflowId,
        })
        const protectedIds = [resume, carrier, foreignWorkflow, foreignExecution].map(
          (input) => input.jobId
        )
        const before = await Promise.all(protectedIds.map(row))
        assert.equal(
          await state.cancelByExecution(
            { executionId, workflowId, rootJobId: foreignWorkflow.jobId },
            'standalone'
          ),
          1
        )
        assert.equal(await state.cancelByExecution({ executionId, workflowId }, 'standalone'), 0)
        assert.equal((await row(exact.input.jobId)).status, 'cancelled')
        assert.deepEqual(await Promise.all(protectedIds.map(row)), before)
        assert.deepEqual(
          await db.transaction((tx) =>
            finalizePgBossAttempt(tx, exact.attempt, returned({ forbidden: true }))
          ),
          { kind: 'reconciliation_required' }
        )
        assert.equal(await state.cancelByExecution({ executionId, workflowId }, 'resume'), 1)
        assert.equal((await row(resume.jobId)).status, 'cancelled')
        assert.equal((await row(carrier.jobId)).status, 'pending')
      }
    )
    await t.test(
      'workspace sweep is bounded, reports remaining work and respects signal, types and foreign workspaces',
      async () => {
        const workspaceId = `${prefix}-sweep-workspace`
        const first = await owned('sweep-first', { workspaceId })
        const second = await fixture('sweep-second', { workspaceId, runner: 'resume-execution' })
        const third = await fixture('sweep-third', { workspaceId, runner: 'workflow-group-cell' })
        const foreign = await fixture('sweep-foreign')
        const cleanup = await fixture('sweep-cleanup', { workspaceId, runner: 'cleanup-logs' })
        const protectedBefore = await Promise.all([foreign.jobId, cleanup.jobId].map(row))
        const before = await Promise.all([first.input.jobId, second.jobId, third.jobId].map(row))
        const controller = new AbortController()
        controller.abort()
        assert.deepEqual(
          await state.cancelByWorkspace(workspaceId, { maxRuns: 10, signal: controller.signal }),
          { cancelledJobs: 0, complete: false }
        )
        assert.deepEqual(
          await Promise.all([first.input.jobId, second.jobId, third.jobId].map(row)),
          before
        )
        assert.deepEqual(await state.cancelByWorkspace(workspaceId, { maxRuns: 1 }), {
          cancelledJobs: 1,
          complete: false,
        })
        assert.deepEqual(await state.cancelByWorkspace(workspaceId, { maxRuns: 10 }), {
          cancelledJobs: 2,
          complete: true,
        })
        assert.deepEqual(await state.cancelByWorkspace(workspaceId, { maxRuns: 10 }), {
          cancelledJobs: 0,
          complete: true,
        })
        for (const id of [first.input.jobId, second.jobId, third.jobId])
          assert.equal((await row(id)).status, 'cancelled')
        assert.deepEqual(
          await Promise.all([foreign.jobId, cleanup.jobId].map(row)),
          protectedBefore
        )
        assert.deepEqual(
          await db.transaction((tx) =>
            finalizePgBossAttempt(tx, first.attempt, returned({ forbidden: true }))
          ),
          { kind: 'reconciliation_required' }
        )
      }
    )
  }
)
