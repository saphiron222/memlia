// Copyright 2026 Memlia. All rights reserved.
// Real PostgreSQL, outbox, transport, owned worker process and deterministic Sim engine.
// No runner/authority/persistence mocks. The private preload only refuses unexpected fetch.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { closeSync, openSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { assertDisposableTestDatabaseUrl } from '@sim/db/testing/test-infrastructure'
import { eq } from 'drizzle-orm'
import postgres from 'postgres'

const web = assertDisposableTestDatabaseUrl(process.env.DATABASE_URL)
const queue = assertDisposableTestDatabaseUrl(process.env.MEMLIA_PG_BOSS_DATABASE_URL)
assert.equal(web.pathname, '/memlia_p03_test_14d520e7ae7f')
assert.equal(queue.pathname, web.pathname)
assert.notEqual(web.username, queue.username)
assert.equal(process.env.MIGRATION_DATABASE_URL, undefined)
assert.equal(process.env.MEMLIA_DURABLE_WORKFLOWS_ENABLED, '1')
const config = process.env.MEMLIA_WORKER_TEST_CONFIG
const preload = process.env.MEMLIA_WORKER_TEST_PRELOAD
const outputDirectory = process.env.MEMLIA_WORKER_TEST_OUTPUT
assert.ok(config && preload && outputDirectory)
const { WORKFLOW_EXECUTION_JOB_ID_PREFIX } = await import(
  '@/lib/workflows/executor/execution-job-ids'
)
const { db } = await import('@sim/db')
const {
  asyncJobs,
  outboxEvent,
  user,
  session,
  permissions,
  workflow,
  workflowDeploymentVersion,
  workflowExecutionLogs,
} = await import('@sim/db/schema')
const { insertWorkspaceFixture } = await import('@sim/db/testing/workspace-fixtures')
const { resolveBillingAttribution } = await import('@/lib/billing/core/attribution')
const { preparePgBossWorkflowAdmission, admitPgBossWorkflowAdmission } = await import(
  './pg-boss-workflow-admission'
)
const { readPgBossPublication } = await import('./pg-boss-admission')
const { claimPgBossAttempt } = await import('./pg-boss-claim')
const { getJobQueue } = await import('../config')
const { enqueueOutboxProcessor } = await import('@/lib/core/outbox/enqueue')
const { pgBossClient } = await import('./pg-boss-client')
const transportDb = postgres(process.env.MEMLIA_PG_BOSS_DATABASE_URL!, {
  max: 1,
  onnotice: () => {},
})
const prefix = `worker-${randomUUID()}`
const owned = {
  projects: [] as string[],
  workflows: [] as string[],
  users: [] as string[],
  workspaces: [] as string[],
  jobs: [] as string[],
  events: [] as string[],
}
function saveOwned() {
  writeFileSync(join(outputDirectory!, 'owned.json'), JSON.stringify(owned), { mode: 0o600 })
}
let child: ReturnType<typeof Bun.spawn> | undefined
let childCount = 0

async function until<T>(observe: () => Promise<T>, accepted: (value: T) => boolean, limit = 20000) {
  const deadline = performance.now() + limit
  while (performance.now() < deadline) {
    const value = await observe()
    if (accepted(value)) return value
    await Bun.sleep(50)
  }
  throw new Error('fixture_observation_deadline')
}
async function job(id: string) {
  return (await db.select().from(asyncJobs).where(eq(asyncJobs.id, id)))[0]
}
async function deliveries(id: string) {
  return transportDb`select id,state from memlia_jobs.job where name='memlia_native' and data->>'nativeJobId'=${id}`
}
async function logs(workflowId: string) {
  return db
    .select({
      executionId: workflowExecutionLogs.executionId,
      status: workflowExecutionLogs.status,
    })
    .from(workflowExecutionLogs)
    .where(eq(workflowExecutionLogs.workflowId, workflowId))
}
async function startWorker() {
  assert.equal(child, undefined)
  const fd = openSync(join(outputDirectory!, `owned-worker-${++childCount}.log`), 'wx', 0o600)
  try {
    child = Bun.spawn(
      [
        process.execPath,
        '--no-env-file',
        '--tsconfig-override',
        config!,
        '--preload',
        preload!,
        'scripts/memlia-workflow-worker.ts',
      ],
      { cwd: process.cwd(), env: process.env, stdout: fd, stderr: fd }
    )
  } finally {
    closeSync(fd)
  }
  return child
}
async function stopWorker(kill = false) {
  if (!child) return
  const current = child
  if (current.exitCode === null && current.signalCode === null) {
    current.kill(kill ? 'SIGKILL' : 'SIGTERM')
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const settledExit = await Promise.race([
      current.exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('owned_worker_stop_deadline')), 5000)
      }),
    ])
    if (kill) {
      assert.equal(settledExit, 137)
      assert.equal(current.exitCode, null)
      assert.equal(current.signalCode, 'SIGKILL')
    } else {
      assert.equal(settledExit, 0)
      assert.equal(current.exitCode, 0)
    }
    assert.throws(() => process.kill(current.pid, 0), { code: 'ESRCH' })
  } finally {
    clearTimeout(timer)
  }
  child = undefined
}
function block(id: string, type: string, values: Record<string, unknown> = {}) {
  return {
    id,
    type,
    name: id,
    position: { x: 0, y: 0 },
    enabled: true,
    outputs: {},
    subBlocks: Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key, { id: key, type: 'short-input', value }])
    ),
  }
}
async function fixture(label: string, options: { deployed?: boolean; wait?: boolean } = {}) {
  const userId = `${prefix}-${label}-user`,
    workspaceId = `${prefix}-${label}-space`,
    workflowId = `${prefix}-${label}-flow`
  const sessionId = `${prefix}-${label}-session`,
    projectId = `${prefix}-${label}-project`,
    now = new Date()
  owned.users.push(userId)
  owned.workspaces.push(workspaceId)
  owned.projects.push(projectId)
  owned.workflows.push(workflowId)
  saveOwned()
  await db.insert(user).values({
    id: userId,
    name: 'Owned worker fixture',
    email: `${userId}@example.invalid`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  })
  await insertWorkspaceFixture(db, {
    id: workspaceId,
    projectId,
    name: 'Owned worker fixture',
    ownerId: userId,
    billedAccountUserId: userId,
  })
  await db.insert(permissions).values({
    id: randomUUID(),
    userId,
    entityType: 'workspace',
    entityId: workspaceId,
    permissionType: 'admin',
  })
  await db.insert(session).values({
    id: sessionId,
    token: randomUUID(),
    userId,
    expiresAt: new Date(Date.now() + 3600000),
    createdAt: now,
    updatedAt: now,
  })
  await db.insert(workflow).values({
    id: workflowId,
    userId,
    workspaceId,
    name: label,
    lastSynced: now,
    createdAt: now,
    updatedAt: now,
    isDeployed: options.deployed !== false,
    deployedAt: options.deployed === false ? null : now,
  })
  const blocks = {
    start: block('start', 'start_trigger'),
    response: block('response', 'response', {
      dataMode: 'json',
      data: '{"fixture":"native-result"}',
      status: '200',
    }),
    ...(options.wait
      ? { wait: block('wait', 'wait', { timeValue: '20', timeUnit: 'seconds' }) }
      : {}),
  }
  const route = options.wait ? ['start', 'wait', 'response'] : ['start', 'response']
  const edges = route.slice(1).map((target, index) => ({
    id: `edge-${index}`,
    source: route[index],
    target,
    sourceHandle: 'source',
    targetHandle: 'target',
  }))
  await db.insert(workflowDeploymentVersion).values({
    id: randomUUID(),
    workflowId,
    version: 1,
    isActive: true,
    createdBy: userId,
    state: { blocks, edges, loops: {}, parallels: {}, variables: {} },
  })
  const params = {
    requestId: randomUUID(),
    workflowId,
    workspaceId,
    userId,
    principal: { kind: 'session' as const, userId, sessionId },
    billingAttribution: await resolveBillingAttribution({ actorUserId: userId, workspaceId }),
    input: {},
    triggerType: 'manual' as const,
    executionId: randomUUID(),
    executionTimeoutMs: 900000,
    enforceCredentialAccess: true,
    isPublicApiAccess: false,
  }
  return { params, sessionId, workflowId }
}
async function admit(
  f: Awaited<ReturnType<typeof fixture>>,
  submittedAt = new Date().toISOString()
) {
  const handle = preparePgBossWorkflowAdmission(f.params, {
    commandId: randomUUID(),
    submittedAt,
    admissionCompleted: true,
  })
  owned.jobs.push(`${WORKFLOW_EXECUTION_JOB_ID_PREFIX}${f.params.executionId}`)
  saveOwned()
  const receipt = await admitPgBossWorkflowAdmission(handle)
  assert.equal(receipt.jobId, owned.jobs.at(-1))
  owned.events.push(receipt.outboxEventId)
  saveOwned()
  return { ...receipt, handle }
}
async function publish() {
  const result = await enqueueOutboxProcessor()
  assert.equal(result.triggered, true)
  assert.equal(result.backend, 'inline') // Native outbox processor only; never an inline business job.
}

test(
  'native durable worker composition on an isolated P03 database',
  { timeout: 100000 },
  async (t) => {
    // Fail before fixture writes if a previous campaign left business rows behind.
    assert.equal((await db.select({ id: asyncJobs.id }).from(asyncJobs)).length, 0)
    assert.equal((await db.select({ id: workflow.id }).from(workflow)).length, 0)
    assert.equal((await db.select({ id: outboxEvent.id }).from(outboxEvent)).length, 0)
    t.after(async () => {
      await stopWorker()
      await pgBossClient.stop()
      // The parent performs exact DML cleanup only after every owned process has exited.
      assert.equal(child, undefined)
      await transportDb.end()
      await db.$client.end()
    })
    await t.test(
      'real native engine completes, persists output/log and ACKs once despite duplicate admission',
      async () => {
        const f = await fixture('success'),
          a = await admit(f)
        assert.equal(await (await getJobQueue()).enqueue('workflow-execution', a.handle), a.jobId)
        await publish()
        await startWorker()
        const result = await until(
          () => job(a.jobId),
          (row) => row?.status === 'completed' || row?.status === 'failed'
        )
        assert.equal(result.status, 'completed')
        assert.equal(result.attempts, 1)
        assert.equal((result.output as { success: boolean }).success, true)
        assert.ok(JSON.stringify(result.output).includes('native-result'))
        await until(
          () => deliveries(a.jobId),
          (rows) => rows.length === 1 && rows[0].state === 'completed'
        )
        const history = await logs(f.workflowId)
        assert.equal(history.length, 1)
        assert.equal(history[0].executionId, f.params.executionId)
        assert.equal(history[0].status, 'completed')
        await stopWorker()
      }
    )
    await t.test(
      'native undeployed workflow failure is failed with output, never a successful job',
      async () => {
        const f = await fixture('failed', { deployed: false }),
          a = await admit(f)
        await publish()
        await startWorker()
        const result = await until(
          () => job(a.jobId),
          (row) => row?.status === 'failed' || row?.status === 'completed'
        )
        assert.equal(result.status, 'failed')
        assert.equal((result.output as { success: boolean }).success, false)
        await until(
          () => deliveries(a.jobId),
          (rows) => rows[0]?.state === 'completed'
        )
        await stopWorker()
      }
    )
    await t.test('pending cancellation is observed without starting native execution', async () => {
      const f = await fixture('cancel'),
        a = await admit(f)
      await publish()
      await (await getJobQueue()).cancelJob(a.jobId)
      await startWorker()
      await until(
        () => deliveries(a.jobId),
        (rows) => rows[0]?.state === 'completed'
      )
      assert.equal((await job(a.jobId)).status, 'cancelled')
      assert.equal((await logs(f.workflowId)).length, 0)
      await stopWorker()
    })
    await t.test(
      'revoked session fails delivery before claim and effect without authority fallback',
      async () => {
        const f = await fixture('revoked'),
          a = await admit(f)
        await publish()
        await db
          .update(session)
          .set({ expiresAt: new Date(0) })
          .where(eq(session.id, f.sessionId))
        await startWorker()
        await until(
          () => deliveries(a.jobId),
          (rows) => rows[0]?.state === 'failed'
        )
        assert.equal((await job(a.jobId)).status, 'pending')
        assert.equal((await job(a.jobId)).attempts, 0)
        assert.equal((await logs(f.workflowId)).length, 0)
        await stopWorker()
      }
    )
    await t.test(
      'kill after observed start of a workflow containing wait leaves uncertainty and refuses replay',
      async () => {
        const f = await fixture('kill', { wait: true }),
          a = await admit(f)
        await publish()
        await startWorker()
        await until(
          () => logs(f.workflowId),
          (rows) => rows[0]?.status === 'running'
        )
        assert.equal((await job(a.jobId)).status, 'processing')
        await Bun.sleep(300)
        await stopWorker(true)
        const before = await job(a.jobId)
        assert.equal(before.status, 'processing')
        assert.equal(before.output, null)
        assert.equal(before.completedAt, null)
        const [event] = await db
          .select()
          .from(outboxEvent)
          .where(eq(outboxEvent.id, a.outboxEventId))
        const publication = await readPgBossPublication(db, event.payload)
        assert.deepEqual(
          await db.transaction((tx) => claimPgBossAttempt(tx, a.jobId, publication.envelope)),
          { kind: 'reconciliation_required' }
        )
        await startWorker()
        await Bun.sleep(1000)
        await stopWorker()
        assert.equal((await job(a.jobId)).status, 'processing')
        assert.equal((await job(a.jobId)).attempts, 1)
        assert.equal((await logs(f.workflowId)).length, 1)
      }
    )
  }
)
