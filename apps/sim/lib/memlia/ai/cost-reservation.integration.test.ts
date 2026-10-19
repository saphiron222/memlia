// Copyright 2026 Memlia. All rights reserved.
// Requires the root-assigned dedicated DB, migration and an authorized test window.
// No schema creation, DDL, credential file or fallback database in this suite.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, test } from 'node:test'
import {
  assertDisposableTestDatabaseUrl,
  clearInheritedDatabaseUrls,
} from '@sim/db/testing/test-infrastructure'
import { eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import type { ChatCostAttempt, ChatCostReservationPort } from './cost-reservation.server'

const runtimeDsn = process.env.TEST_DATABASE_URL
const ownerDsn = process.env.MEMLIA_CHAT_COST_TEST_OWNER_URL
assert.ok(runtimeDsn && ownerDsn, 'Dedicated cost-reservation test database required')
const runtimeUrl = assertDisposableTestDatabaseUrl(runtimeDsn)
const ownerUrl = assertDisposableTestDatabaseUrl(ownerDsn)
assert.equal(runtimeUrl.pathname, ownerUrl.pathname)
assert.equal(runtimeUrl.pathname, '/memlia_p06_budget_test')
assert.notEqual(runtimeUrl.username, ownerUrl.username)
clearInheritedDatabaseUrls()
process.env.DATABASE_URL = runtimeDsn
const { db } = await import('@sim/db')
const schema = await import('@sim/db/schema')
const { user, workspace, usageLog } = schema
const { insertWorkspaceFixture, deleteWorkspaceFixture } = await import(
  '@sim/db/testing/workspace-fixtures'
)
const { resolveBillingAttribution } = await import('@/lib/billing/core/attribution')
// Real implementation and native ledger, no billing/DB function doubles.
const port: ChatCostReservationPort = await import('./cost-reservation.server')
const ownerConnection = postgres(ownerDsn, { max: 2, onnotice: () => {} })
const owner = drizzle(ownerConnection, { schema })
const prefix = `chat-cost-${randomUUID()}`

async function withFixture(label: string, check: (attempt: ChatCostAttempt) => Promise<void>) {
  const windowId = `${prefix}-${label}`
  const userId = `${windowId}-user`
  const workspaceId = `${windowId}-workspace`
  const now = new Date()
  try {
    await owner.insert(user).values({
      id: userId,
      name: 'Cost fixture',
      email: `${userId}@example.invalid`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })
    await insertWorkspaceFixture(owner, {
      id: workspaceId,
      name: 'Cost fixture',
      ownerId: userId,
      billedAccountUserId: userId,
      organizationId: null,
    })
    // Administrative fixture only; this lab uses native web DML rights, not per-user SQL identities.
    await owner.execute(sql`insert into memlia_chat_cost_window
      (id, version, currency, starts_at, ends_at, limit_usd, state)
      values (${windowId}, 1, 'USD', now() - interval '1 hour', now() + interval '1 hour', 1, 'open')`)
    const attribution = await resolveBillingAttribution({ actorUserId: userId, workspaceId })
    await check({
      windowId,
      windowVersion: 1,
      attemptId: `${windowId}-attempt`,
      attribution,
      maximumCostUsd: '0.75',
    })
  } finally {
    // Only this run's fixtures; no wildcard/global deletion and no business cleanup assertion.
    await owner.execute(sql`delete from memlia_chat_cost_reservation where window_id = ${windowId}`)
    await owner.execute(sql`delete from memlia_chat_cost_window where id = ${windowId}`)
    await owner.delete(usageLog).where(eq(usageLog.userId, userId))
    await deleteWorkspaceFixture(owner, eq(workspace.id, workspaceId))
    await owner.delete(user).where(eq(user.id, userId))
  }
}

const reserve = (input: ChatCostAttempt) => db.transaction((tx) => port.reserveChatCost(tx, input))
const settle = (input: ChatCostAttempt, finalCostUsd: string) =>
  db.transaction((tx) =>
    port.settleChatCost(tx, {
      windowId: input.windowId,
      windowVersion: input.windowVersion,
      attemptId: input.attemptId,
      outcome: { kind: 'known', finalCostUsd },
    })
  )

after(async () => {
  await ownerConnection.end()
})

test('native number serialization mismatch is refused before any SQL boundary', async () => {
  const amount = '131072.000000000116'
  const nativeNumber = Number(amount)
  assert.equal(
    nativeNumber.toFixed(12),
    amount,
    'fixture must expose the old toFixed false assurance'
  )
  assert.equal(nativeNumber.toString(), '131072.00000000012')
  let sqlCalls = 0
  // Explicit boundary double: no DB behavior is simulated and no statement can execute.
  const forbiddenSql = {
    rollback() {
      throw new Error('fixture-no-transaction')
    },
    execute() {
      sqlCalls++
      throw new Error('fixture-sql-forbidden')
    },
  } as unknown as Parameters<typeof port.settleChatCost>[0]
  const result = await port
    .settleChatCost(forbiddenSql, {
      windowId: 'fixture-window',
      windowVersion: 1,
      attemptId: 'fixture-attempt',
      outcome: { kind: 'known', finalCostUsd: amount },
    })
    .catch((error: unknown) => error)
  assert.equal(sqlCalls, 0, 'invalid serialization must be refused before the first SQL call')
  assert.deepEqual(result, { kind: 'refused', reason: 'invalid_input' })
})
test('caller timeouts stricter than the port ceilings are preserved', () =>
  withFixture('strict-timeouts', async (a) => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config(name, case name when 'statement_timeout' then '250ms'
      when 'lock_timeout' then '200ms' when 'transaction_timeout' then '2000ms' else '1000ms' end, true)
      from pg_settings where name in ('statement_timeout','lock_timeout','transaction_timeout','idle_in_transaction_session_timeout')`)
      const before = await tx.execute<{
        name: string
        setting: string
        unit: string
      }>(sql`select name, setting, unit from pg_settings
      where name in ('statement_timeout','lock_timeout','transaction_timeout','idle_in_transaction_session_timeout') order by name`)
      assert.deepEqual(
        await port.reserveChatCost(tx, { ...a, windowId: `${a.windowId}-missing` }),
        { kind: 'refused', reason: 'window_unavailable' }
      )
      const afterSettings = await tx.execute<{
        name: string
        setting: string
        unit: string
      }>(sql`select name, setting, unit from pg_settings
      where name in ('statement_timeout','lock_timeout','transaction_timeout','idle_in_transaction_session_timeout') order by name`)
      assert.deepEqual([...afterSettings], [...before])
    })
  }))
test('disabled or wider caller timeouts are capped using native millisecond settings', () =>
  withFixture('wide-timeouts', async (a) => {
    for (const configured of ['0', '10000ms']) {
      await db.transaction(async (tx) => {
        await tx.execute(sql`select set_config(name, ${configured}, true) from pg_settings
        where name in ('statement_timeout','lock_timeout','transaction_timeout','idle_in_transaction_session_timeout')`)
        assert.deepEqual(
          await port.reserveChatCost(tx, { ...a, windowId: `${a.windowId}-missing` }),
          { kind: 'refused', reason: 'window_unavailable' }
        )
        const settings = await tx.execute<{
          name: string
          setting: string
          unit: string
        }>(sql`select name, setting, unit from pg_settings
        where name in ('statement_timeout','lock_timeout','transaction_timeout','idle_in_transaction_session_timeout')`)
        assert.ok(settings.length >= 3)
        for (const setting of settings) {
          assert.equal(setting.unit, 'ms')
          assert.equal(setting.setting, setting.name === 'lock_timeout' ? '1000' : '5000')
        }
      })
    }
  }))
test('concurrent attempts cannot both reserve the last headroom', () =>
  withFixture('race', async (a) => {
    const b = { ...a, attemptId: `${a.attemptId}-b` }
    const results = await Promise.all([reserve(a), reserve(b)])
    assert.equal(results.filter((r) => r.kind === 'reserved_in_transaction').length, 1)
    assert.equal(
      results.filter((r) => r.kind === 'refused' && r.reason === 'budget_exhausted').length,
      1
    )
  }))
test('DB wall clock after a real lock wait refuses a newly expired window', () =>
  withFixture('expired-wait', async (a) => {
    let announceStarted!: (pid: number) => void
    const started = new Promise<number>((resolve) => {
      announceStarted = resolve
    })
    let pending: Promise<Awaited<ReturnType<typeof reserve>>> | undefined
    let transactionStartedAt: Date | undefined
    let endsAt: Date | undefined
    try {
      await owner.transaction(async (ownerTx) => {
        await ownerTx.execute(
          sql`select id from memlia_chat_cost_window where id = ${a.windowId} for update`
        )
        pending = db.transaction(async (tx) => {
          const [clock] = await tx.execute<{ pid: number; at: Date }>(
            sql`select pg_backend_pid() as pid, transaction_timestamp() as at`
          )
          transactionStartedAt = new Date(clock.at)
          announceStarted(clock.pid)
          return port.reserveChatCost(tx, a)
        })
        // Preserve any rejection for the final assertion, without an unhandled rejection.
        void pending.catch(() => {})
        const pid = await started
        let blocked = false
        for (let index = 0; index < 100 && !blocked; index++) {
          const [waiting] = await ownerTx.execute<{ blocked: boolean }>(
            sql`select cardinality(pg_blocking_pids(${pid})) > 0 as blocked`
          )
          blocked = waiting.blocked
          if (!blocked) await new Promise((resolve) => setTimeout(resolve, 2))
        }
        assert.equal(blocked, true, 'real reservation must be waiting on the fixture window lock')
        const [windowClock] = await ownerTx.execute<{
          ends_at: Date
        }>(sql`update memlia_chat_cost_window
            set ends_at = clock_timestamp() + interval '100 milliseconds' where id = ${a.windowId} returning ends_at`)
        endsAt = new Date(windowClock.ends_at)
        // Deliberately let the native transaction cross the fixture deadline while blocked.
        await ownerTx.execute(sql`select pg_sleep(0.15)`)
      })
      assert.ok(transactionStartedAt && endsAt && transactionStartedAt < endsAt)
      assert.deepEqual(await pending, { kind: 'refused', reason: 'window_unavailable' })
      const [{ count }] = await owner.execute<{ count: number }>(sql`select count(*)::int as count
          from memlia_chat_cost_reservation where window_id = ${a.windowId}`)
      assert.equal(count, 0)
    } finally {
      if (pending) await pending.catch(() => {})
    }
  }))
test('a later canonical-workspace lock cannot admit after the window deadline', () =>
  withFixture('workspace-expiry', async (a) => {
    let announceStarted!: (pid: number) => void
    const started = new Promise<number>((resolve) => {
      announceStarted = resolve
    })
    let pending: Promise<Awaited<ReturnType<typeof reserve>>> | undefined
    try {
      await owner.transaction(async (ownerTx) => {
        await ownerTx.execute(
          sql`select id from workspace where id = ${a.attribution.workspaceId} for update`
        )
        // The deadline is fixed before reservation takes its own window lock.
        await owner.execute(sql`update memlia_chat_cost_window set ends_at = clock_timestamp() + interval '400 milliseconds'
            where id = ${a.windowId}`)
        pending = db.transaction(async (tx) => {
          const [row] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)
          announceStarted(row.pid)
          return port.reserveChatCost(tx, a)
        })
        void pending.catch(() => {})
        const pid = await started
        let blocked = false
        for (let index = 0; index < 100 && !blocked; index++) {
          const [waiting] = await ownerTx.execute<{ blocked: boolean }>(
            sql`select cardinality(pg_blocking_pids(${pid})) > 0 as blocked`
          )
          blocked = waiting.blocked
          if (!blocked) await new Promise((resolve) => setTimeout(resolve, 2))
        }
        assert.equal(blocked, true, 'reservation must reach and wait on the canonical workspace')
        const [clock] = await ownerTx.execute<{
          before: boolean
        }>(sql`select clock_timestamp() < ends_at as before
            from memlia_chat_cost_window where id = ${a.windowId}`)
        assert.equal(clock.before, true, 'controlled wait begins before the fixture deadline')
        await ownerTx.execute(sql`select pg_sleep(greatest(0, extract(epoch from ends_at - clock_timestamp())) + 0.05)
            from memlia_chat_cost_window where id = ${a.windowId}`)
      })
      assert.deepEqual(await pending, { kind: 'refused', reason: 'window_unavailable' })
      const [{ count }] = await owner.execute<{ count: number }>(sql`select count(*)::int as count
          from memlia_chat_cost_reservation where window_id = ${a.windowId}`)
      assert.equal(count, 0)
    } finally {
      if (pending) await pending.catch(() => {})
    }
  }))
test('input and nested attribution remain captured while the window lock is awaited', () =>
  withFixture('capture-wait', async (a) => {
    const mutable = JSON.parse(JSON.stringify(a)) as ChatCostAttempt & {
      attemptId: string
      maximumCostUsd: string
    }
    let announceStarted!: (pid: number) => void
    const started = new Promise<number>((resolve) => {
      announceStarted = resolve
    })
    let pending: Promise<Awaited<ReturnType<typeof reserve>>> | undefined
    try {
      await owner.transaction(async (ownerTx) => {
        await ownerTx.execute(
          sql`select id from memlia_chat_cost_window where id = ${a.windowId} for update`
        )
        pending = db.transaction(async (tx) => {
          const [row] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)
          announceStarted(row.pid)
          return port.reserveChatCost(tx, mutable)
        })
        void pending.catch(() => {})
        const pid = await started
        let blocked = false
        for (let index = 0; index < 100 && !blocked; index++) {
          const [waiting] = await ownerTx.execute<{ blocked: boolean }>(
            sql`select cardinality(pg_blocking_pids(${pid})) > 0 as blocked`
          )
          blocked = waiting.blocked
          if (!blocked) await new Promise((resolve) => setTimeout(resolve, 2))
        }
        assert.equal(blocked, true)
        mutable.attemptId = `${a.attemptId}-mutated`
        mutable.maximumCostUsd = '0.01'
        Object.defineProperty(mutable.attribution, 'workspaceId', {
          value: 'foreign-workspace',
          enumerable: true,
        })
        Object.defineProperty(mutable.attribution.billingPeriod, 'start', {
          value: '2000-01-01T00:00:00.000Z',
          enumerable: true,
        })
      })
      assert.deepEqual(await pending, {
        kind: 'reserved_in_transaction',
        attemptId: a.attemptId,
        created: true,
      })
      const rows = await owner.execute<{
        attempt_id: string
        maximum_cost_usd: string
        attribution: unknown
      }>(sql`select attempt_id, maximum_cost_usd, attribution
          from memlia_chat_cost_reservation where window_id = ${a.windowId}`)
      assert.equal(rows.length, 1)
      assert.equal(rows[0].attempt_id, a.attemptId)
      assert.equal(rows[0].maximum_cost_usd, '0.750000000000')
      assert.deepEqual(rows[0].attribution, a.attribution)
    } finally {
      if (pending) await pending.catch(() => {})
    }
  }))
test('a foreign event committed during native INSERT cannot close the reservation', () =>
  withFixture('event-race', async (a) => {
    await reserve(a)
    const [attempt] = await owner.execute<{
      event_key: string
    }>(sql`select event_key from memlia_chat_cost_reservation
        where attempt_id = ${a.attemptId}`)
    let announceStarted!: (pid: number) => void
    const started = new Promise<number>((resolve) => {
      announceStarted = resolve
    })
    let pending: Promise<unknown> | undefined
    try {
      await owner.transaction(async (ownerTx) => {
        await ownerTx.insert(usageLog).values({
          id: `${a.attemptId}-foreign`,
          userId: a.attribution.actorUserId,
          category: 'model',
          source: 'workspace-chat',
          description: 'Foreign fixture event',
          cost: '0.9',
          eventKey: attempt.event_key,
        })
        pending = db.transaction(async (tx) => {
          const [row] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)
          announceStarted(row.pid)
          return port.settleChatCost(tx, {
            windowId: a.windowId,
            windowVersion: 1,
            attemptId: a.attemptId,
            outcome: { kind: 'known', finalCostUsd: '0.25' },
          })
        })
        void pending.catch(() => {})
        const pid = await started
        let blocked = false
        for (let index = 0; index < 100 && !blocked; index++) {
          const [waiting] = await ownerTx.execute<{ blocked: boolean }>(
            sql`select cardinality(pg_blocking_pids(${pid})) > 0 as blocked`
          )
          blocked = waiting.blocked
          if (!blocked) await new Promise((resolve) => setTimeout(resolve, 2))
        }
        assert.equal(blocked, true, 'native INSERT must wait on the uncommitted unique event')
      })
      await assert.rejects(pending!, { message: 'persistence_unknown' })
      const [row] = await owner.execute<{
        state: string
        ledger_id: string | null
      }>(sql`select state, ledger_id
          from memlia_chat_cost_reservation where attempt_id = ${a.attemptId}`)
      assert.equal(row.state, 'reserved')
      assert.equal(row.ledger_id, null)
      const events = await owner
        .select()
        .from(usageLog)
        .where(eq(usageLog.eventKey, attempt.event_key))
      assert.equal(events.length, 1)
      assert.equal(events[0].description, 'Foreign fixture event')
    } finally {
      if (pending) await pending.catch(() => {})
    }
  }))
test('same attempt is idempotent, changed cost conflicts', () =>
  withFixture('duplicate', async (a) => {
    assert.deepEqual(await reserve(a), {
      kind: 'reserved_in_transaction',
      attemptId: a.attemptId,
      created: true,
    })
    assert.deepEqual(await reserve(a), {
      kind: 'reserved_in_transaction',
      attemptId: a.attemptId,
      created: false,
    })
    assert.deepEqual(await reserve({ ...a, maximumCostUsd: '0.5' }), {
      kind: 'refused',
      reason: 'identity_conflict',
    })
  }))
test('caller rollback removes the provisional reservation', () =>
  withFixture('rollback', async (a) => {
    await assert.rejects(
      db.transaction(async (tx) => {
        assert.equal((await port.reserveChatCost(tx, a)).kind, 'reserved_in_transaction')
        throw new Error('fixture-rollback')
      }),
      /fixture-rollback/
    )
    assert.deepEqual(await reserve(a), {
      kind: 'reserved_in_transaction',
      attemptId: a.attemptId,
      created: true,
    })
  }))
test('settlement and native ledger rollback together', () =>
  withFixture('settle-rollback', async (a) => {
    await reserve(a)
    await assert.rejects(
      db.transaction(async (tx) => {
        assert.equal(
          (
            await port.settleChatCost(tx, {
              windowId: a.windowId,
              windowVersion: 1,
              attemptId: a.attemptId,
              outcome: { kind: 'known', finalCostUsd: '0.25' },
            })
          ).kind,
          'settled_in_transaction'
        )
        throw new Error('fixture-rollback')
      }),
      /fixture-rollback/
    )
    const rows = await owner
      .select()
      .from(usageLog)
      .where(eq(usageLog.userId, a.attribution.actorUserId))
    assert.equal(rows.length, 0)
    assert.deepEqual(await reserve({ ...a, attemptId: `${a.attemptId}-b` }), {
      kind: 'refused',
      reason: 'budget_exhausted',
    })
  }))
test('settlement writes one native ledger event and preserves canonical period', () =>
  withFixture('settle', async (a) => {
    await reserve(a)
    const results = await Promise.all([settle(a, '0.25'), settle(a, '0.25')])
    assert.equal(results.filter((r) => r.kind === 'settled_in_transaction').length, 2)
    const rows = await owner
      .select()
      .from(usageLog)
      .where(eq(usageLog.userId, a.attribution.actorUserId))
    assert.equal(rows.length, 1)
    assert.equal(rows[0].cost, '0.25')
    assert.equal(rows[0].billingPeriodStart?.toISOString(), a.attribution.billingPeriod.start)
    assert.equal(rows[0].billingPeriodEnd?.toISOString(), a.attribution.billingPeriod.end)
    assert.equal(rows[0].source, 'workspace-chat')
    assert.equal(
      (await reserve({ ...a, attemptId: `${a.attemptId}-b` })).kind,
      'reserved_in_transaction'
    )
  }))
test('unknown cost retains the entire commitment', () =>
  withFixture('unknown', async (a) => {
    await reserve(a)
    assert.deepEqual(
      await db.transaction((tx) =>
        port.settleChatCost(tx, {
          windowId: a.windowId,
          windowVersion: 1,
          attemptId: a.attemptId,
          outcome: { kind: 'unknown' },
        })
      ),
      { kind: 'retained_in_transaction', reason: 'unknown_cost' }
    )
    assert.deepEqual(await reserve({ ...a, attemptId: `${a.attemptId}-b` }), {
      kind: 'refused',
      reason: 'budget_exhausted',
    })
  }))
test('known zero does not fabricate a ledger row or release the commitment', () =>
  withFixture('zero', async (a) => {
    await reserve(a)
    assert.deepEqual(await settle(a, '0'), { kind: 'refused', reason: 'reconciliation_required' })
    const rows = await owner
      .select()
      .from(usageLog)
      .where(eq(usageLog.userId, a.attribution.actorUserId))
    assert.equal(rows.length, 0)
    assert.deepEqual(await reserve({ ...a, attemptId: `${a.attemptId}-b` }), {
      kind: 'refused',
      reason: 'budget_exhausted',
    })
  }))
test('known overrun is recorded and blocks new admissions in the same commit', () =>
  withFixture('overrun', async (a) => {
    await reserve(a)
    assert.deepEqual(await settle(a, '0.8'), {
      kind: 'settled_and_blocked_in_transaction',
      attemptId: a.attemptId,
      reason: 'cost_exceeded_reservation',
    })
    const rows = await owner
      .select()
      .from(usageLog)
      .where(eq(usageLog.userId, a.attribution.actorUserId))
    assert.equal(rows.length, 1)
    assert.equal(rows[0].cost, '0.8')
    assert.deepEqual(
      await reserve({ ...a, attemptId: `${a.attemptId}-b`, maximumCostUsd: '0.01' }),
      { kind: 'refused', reason: 'reconciliation_required' }
    )
  }))
test('an overrun blocks new admissions but still records a second previously reserved cost', () =>
  withFixture('blocked-settle', async (a) => {
    const first = { ...a, maximumCostUsd: '0.4' }
    const second = { ...a, attemptId: `${a.attemptId}-b`, maximumCostUsd: '0.4' }
    await reserve(first)
    await reserve(second)
    assert.equal((await settle(first, '0.5')).kind, 'settled_and_blocked_in_transaction')
    assert.equal((await settle(second, '0.3')).kind, 'settled_in_transaction')
    const rows = await owner
      .select()
      .from(usageLog)
      .where(eq(usageLog.userId, a.attribution.actorUserId))
    assert.equal(rows.length, 2)
    const [state] = await owner.execute<{ state: string }>(
      sql`select state from memlia_chat_cost_window where id = ${a.windowId}`
    )
    assert.equal(state.state, 'blocked')
  }))
test('unknown reports retain commitment until one known settlement, and cannot reopen it', () =>
  withFixture('state-order', async (a) => {
    await reserve(a)
    const unknown = () =>
      db.transaction((tx) =>
        port.settleChatCost(tx, {
          windowId: a.windowId,
          windowVersion: 1,
          attemptId: a.attemptId,
          outcome: { kind: 'unknown' },
        })
      )
    assert.equal((await unknown()).kind, 'retained_in_transaction')
    assert.equal((await unknown()).kind, 'retained_in_transaction')
    assert.equal((await settle(a, '0.25')).kind, 'settled_in_transaction')
    assert.deepEqual(await unknown(), { kind: 'refused', reason: 'reconciliation_required' })
    assert.deepEqual(await settle(a, '0.3'), { kind: 'refused', reason: 'reconciliation_required' })
    assert.equal((await settle(a, '0.25')).kind, 'settled_in_transaction')
  }))
test('overrun result remains provisional and caller rollback restores ledger, hold and window', () =>
  withFixture('overrun-rollback', async (a) => {
    await reserve(a)
    await assert.rejects(
      db.transaction(async (tx) => {
        assert.equal(
          (
            await port.settleChatCost(tx, {
              windowId: a.windowId,
              windowVersion: 1,
              attemptId: a.attemptId,
              outcome: { kind: 'known', finalCostUsd: '0.8' },
            })
          ).kind,
          'settled_and_blocked_in_transaction'
        )
        throw new Error('fixture-rollback')
      }),
      /fixture-rollback/
    )
    const rows = await owner
      .select()
      .from(usageLog)
      .where(eq(usageLog.userId, a.attribution.actorUserId))
    assert.equal(rows.length, 0)
    const [state] = await owner.execute<{ state: string }>(
      sql`select state from memlia_chat_cost_window where id = ${a.windowId}`
    )
    assert.equal(state.state, 'open')
    assert.deepEqual(await reserve({ ...a, attemptId: `${a.attemptId}-b` }), {
      kind: 'refused',
      reason: 'budget_exhausted',
    })
  }))
test('pool cannot settle outside a transaction', () =>
  withFixture('settle-pool', async (a) => {
    await reserve(a)
    await assert.rejects(
      () =>
        port.settleChatCost(db as unknown as Parameters<typeof port.settleChatCost>[0], {
          windowId: a.windowId,
          windowVersion: 1,
          attemptId: a.attemptId,
          outcome: { kind: 'known', finalCostUsd: '0.25' },
        }),
      { message: 'transaction_required' }
    )
  }))
test('expiry does not erase a debt, but a changed administrative version requires reconciliation', () =>
  withFixture('settle-window', async (a) => {
    await reserve(a)
    await owner.execute(sql`update memlia_chat_cost_window set ends_at = clock_timestamp() - interval '1 second'
        where id = ${a.windowId}`)
    assert.equal((await settle(a, '0.25')).kind, 'settled_in_transaction')
    await owner.execute(
      sql`update memlia_chat_cost_window set version = 2 where id = ${a.windowId}`
    )
    assert.deepEqual(await settle(a, '0.25'), { kind: 'refused', reason: 'window_changed' })
    const [row] = await owner.execute<{
      state: string
      settled_cost_usd: string
    }>(sql`select state, settled_cost_usd
        from memlia_chat_cost_reservation where attempt_id = ${a.attemptId}`)
    assert.equal(row.state, 'settled')
    assert.equal(row.settled_cost_usd, '0.250000000000')
  }))
test('a duplicate cannot adopt a changed native ledger cost over the settled receipt', () =>
  withFixture('changed-ledger', async (a) => {
    await reserve(a)
    assert.equal((await settle(a, '0.25')).kind, 'settled_in_transaction')
    await owner
      .update(usageLog)
      .set({ cost: '0.5' })
      .where(eq(usageLog.userId, a.attribution.actorUserId))
    assert.deepEqual(await settle(a, '0.5'), { kind: 'refused', reason: 'reconciliation_required' })
  }))
test('native numeric precision outside the port bound is never truncated for a duplicate', () =>
  withFixture('native-precision', async (a) => {
    await reserve(a)
    assert.equal((await settle(a, '0.000000000001')).kind, 'settled_in_transaction')
    await owner
      .update(usageLog)
      .set({ cost: '0.0000000000001' })
      .where(eq(usageLog.userId, a.attribution.actorUserId))
    assert.deepEqual(await settle(a, '0.000000000001'), {
      kind: 'refused',
      reason: 'reconciliation_required',
    })
  }))
test('missing nullable native ledger scope is not ignored by SQL bool_and', () =>
  withFixture('null-ledger', async (a) => {
    await reserve(a)
    await settle(a, '0.25')
    await owner
      .update(usageLog)
      .set({
        billingEntityType: null,
        billingEntityId: null,
        billingPeriodStart: null,
        billingPeriodEnd: null,
      })
      .where(eq(usageLog.userId, a.attribution.actorUserId))
    assert.deepEqual(await reserve({ ...a, attemptId: `${a.attemptId}-b` }), {
      kind: 'refused',
      reason: 'reconciliation_required',
    })
  }))
test('strict input capture refuses getters without invoking them', () =>
  withFixture('getter', async (a) => {
    let invoked = 0
    const hostile = { ...a }
    Object.defineProperty(hostile, 'maximumCostUsd', {
      enumerable: true,
      get() {
        invoked++
        return '0.1'
      },
    })
    assert.deepEqual(await reserve(hostile), { kind: 'refused', reason: 'invalid_input' })
    assert.equal(invoked, 0)
  }))
test('native pool cannot masquerade as an active transaction', () =>
  withFixture('pool', async (a) => {
    await assert.rejects(
      () => port.reserveChatCost(db as unknown as Parameters<typeof port.reserveChatCost>[0], a),
      { message: 'transaction_required' }
    )
  }))
test('technical 12-decimal USD amounts survive the native ledger number boundary exactly', async () => {
  const prices = ['0.000000000001', '0.123456789012', '0.1']
  for (const [index, amount] of prices.entries()) {
    await withFixture(`precision-${index}`, async (a) => {
      await reserve(a)
      assert.equal((await settle(a, amount)).kind, 'settled_in_transaction')
      // Independent PostgreSQL numeric equality, not a copy of the port's decimal parser.
      const rows = await owner.execute<{
        same: boolean
      }>(sql`select cost = ${amount}::numeric as same
            from usage_log where user_id = ${a.attribution.actorUserId}`)
      assert.equal(rows.length, 1)
      assert.equal(rows[0].same, true)
    })
  }
})
test('extra precision or a lossy native number cannot release a commitment', () =>
  withFixture('precision-refused', async (a) => {
    await reserve(a)
    for (const amount of ['0.1234567890123', '999999998.123456789012']) {
      assert.deepEqual(await settle(a, amount), { kind: 'refused', reason: 'invalid_input' })
    }
    const rows = await owner
      .select()
      .from(usageLog)
      .where(eq(usageLog.userId, a.attribution.actorUserId))
    assert.equal(rows.length, 0)
    assert.deepEqual(await reserve({ ...a, attemptId: `${a.attemptId}-b` }), {
      kind: 'refused',
      reason: 'budget_exhausted',
    })
  }))
test('SQL numeric headroom admits the exact final trillionth, but no more', () =>
  withFixture('headroom-precision', async (a) => {
    assert.equal(
      (await reserve({ ...a, maximumCostUsd: '0.999999999999' })).kind,
      'reserved_in_transaction'
    )
    assert.equal(
      (await reserve({ ...a, attemptId: `${a.attemptId}-b`, maximumCostUsd: '0.000000000001' }))
        .kind,
      'reserved_in_transaction'
    )
    assert.deepEqual(
      await reserve({ ...a, attemptId: `${a.attemptId}-c`, maximumCostUsd: '0.000000000001' }),
      { kind: 'refused', reason: 'budget_exhausted' }
    )
  }))
test('real user cascade removing settled ledger never recreates budget', () =>
  withFixture('cascade', async (a) => {
    await reserve(a)
    await settle(a, '0.25')
    // Remove the fixture workspace first, then actual user FK cascade into usage_log.
    await deleteWorkspaceFixture(owner, eq(workspace.id, a.attribution.workspaceId!))
    await owner.delete(user).where(eq(user.id, a.attribution.actorUserId))
    const rows = await owner
      .select()
      .from(usageLog)
      .where(eq(usageLog.userId, a.attribution.actorUserId))
    assert.equal(rows.length, 0)
    // A different, still-canonical actor must also be blocked by the missing ledger.
    await withFixture('cascade-survivor', async (b) => {
      const result = await reserve({ ...b, windowId: a.windowId })
      assert.deepEqual(result, { kind: 'refused', reason: 'reconciliation_required' })
    })
  }))

test('profiled window refuses a legacy reservation without the expected server hash', () =>
  withFixture('profile-missing', async (a) => {
    const profile = {
      version: 1,
      basis: 'native_list_price_estimate_v1',
      provider: 'openai',
      model: 'gpt-5.4',
      pricing: { input: 2.5, output: 15, cachedInput: 0.25, updatedAt: '2026-10-01' },
      bounds: { contextTokens: 1000000, outputTokens: 128000 },
      maximumCostUsd: '0.75',
    }
    await owner
      .update(schema.memliaChatCostWindow)
      .set({ pricingProfile: profile })
      .where(eq(schema.memliaChatCostWindow.id, a.windowId))
    assert.deepEqual(await reserve(a), { kind: 'refused', reason: 'reconciliation_required' })
    const rows = await owner.execute(
      sql`select attempt_id from memlia_chat_cost_reservation where window_id = ${a.windowId}`
    )
    assert.equal(rows.length, 0)
  }))

const { captureChatPricingProfile } = await import('./chat-pricing-profile.server')
const estimateProfile = () =>
  captureChatPricingProfile({
    version: 1,
    basis: 'native_list_price_estimate_v1',
    provider: 'openai',
    model: 'gpt-5.4',
    pricing: {
      input: 2.5,
      output: 15,
      cachedInput: 0.25,
      updatedAt: '2026-10-01',
      tiers: [{ aboveInputTokens: 272000, input: 5, output: 22.5 }],
    },
    bounds: { contextTokens: 1000000, outputTokens: 128000 },
    maximumCostUsd: '0.75',
  })
async function profileWindow(a: ChatCostAttempt) {
  const captured = estimateProfile()
  await owner
    .update(schema.memliaChatCostWindow)
    .set({ pricingProfile: captured.profile })
    .where(eq(schema.memliaChatCostWindow.id, a.windowId))
  return { ...a, expectedPricingProfileHash: captured.hash }
}
const settleProfile = (a: ChatCostAttempt) =>
  db.transaction((tx) =>
    port.settleChatCost(tx, {
      windowId: a.windowId,
      windowVersion: a.windowVersion,
      attemptId: a.attemptId,
      expectedPricingProfileHash: a.expectedPricingProfileHash,
      outcome: { kind: 'known', finalCostUsd: '0.25' },
    })
  )
test('profile snapshot comes from locked window and remains linked through native settlement', () =>
  withFixture('profile-valid', async (a) => {
    const input = await profileWindow(a)
    const result = await reserve(input)
    assert.equal(result.kind, 'reserved_in_transaction')
    const [stored] = await owner
      .select()
      .from(schema.memliaChatCostReservation)
      .where(eq(schema.memliaChatCostReservation.attemptId, a.attemptId))
    assert.deepEqual(stored!.pricingProfile, estimateProfile().profile)
    assert.equal((await reserve(input)).kind, 'reserved_in_transaction')
    assert.equal((await settleProfile(input)).kind, 'settled_in_transaction')
    assert.equal((await settleProfile(input)).kind, 'settled_in_transaction')
  }))
test('profile hash and exact configured ceiling are required without changing legacy semantics', () =>
  withFixture('profile-invalid', async (a) => {
    assert.deepEqual(await reserve({ ...a, expectedPricingProfileHash: '0'.repeat(64) }), {
      kind: 'refused',
      reason: 'reconciliation_required',
    })
    const input = await profileWindow(a)
    assert.deepEqual(await reserve({ ...input, expectedPricingProfileHash: '0'.repeat(64) }), {
      kind: 'refused',
      reason: 'reconciliation_required',
    })
    assert.deepEqual(await reserve({ ...input, maximumCostUsd: '0.7' }), {
      kind: 'refused',
      reason: 'identity_conflict',
    })
    assert.equal((await reserve(input)).kind, 'reserved_in_transaction')
    assert.deepEqual(await settle(a, '0.25'), {
      kind: 'refused',
      reason: 'reconciliation_required',
    })
  }))
test('changed window or reservation profile cannot settle or release the prior hold', () =>
  withFixture('profile-change', async (a) => {
    const input = await profileWindow(a)
    await reserve(input)
    const modified = { ...estimateProfile().profile, model: 'gpt-5.5' }
    await owner
      .update(schema.memliaChatCostWindow)
      .set({ pricingProfile: modified })
      .where(eq(schema.memliaChatCostWindow.id, a.windowId))
    assert.deepEqual(await settleProfile(input), {
      kind: 'refused',
      reason: 'reconciliation_required',
    })
    await owner
      .update(schema.memliaChatCostWindow)
      .set({ pricingProfile: estimateProfile().profile })
      .where(eq(schema.memliaChatCostWindow.id, a.windowId))
    await owner
      .update(schema.memliaChatCostReservation)
      .set({ pricingProfile: modified })
      .where(eq(schema.memliaChatCostReservation.attemptId, a.attemptId))
    assert.deepEqual(await settleProfile(input), {
      kind: 'refused',
      reason: 'reconciliation_required',
    })
    const [row] = await owner
      .select()
      .from(schema.memliaChatCostReservation)
      .where(eq(schema.memliaChatCostReservation.attemptId, a.attemptId))
    assert.equal(row!.state, 'reserved')
    assert.equal(row!.ledgerId, null)
  }))
test('malformed administrative profile fails closed under the window lock', () =>
  withFixture('profile-malformed', async (a) => {
    await owner
      .update(schema.memliaChatCostWindow)
      .set({ pricingProfile: { ...estimateProfile().profile, invoice: true } })
      .where(eq(schema.memliaChatCostWindow.id, a.windowId))
    assert.deepEqual(await reserve({ ...a, expectedPricingProfileHash: estimateProfile().hash }), {
      kind: 'refused',
      reason: 'reconciliation_required',
    })
  }))
test('profile binding is read after a real administrative lock wait', () =>
  withFixture('profile-wait', async (a) => {
    const input = await profileWindow(a)
    let pending: Promise<Awaited<ReturnType<typeof reserve>>> | undefined
    let started!: (pid: number) => void
    const ready = new Promise<number>((resolve) => {
      started = resolve
    })
    try {
      await owner.transaction(async (tx) => {
        await tx.execute(
          sql`select id from memlia_chat_cost_window where id=${a.windowId} for update`
        )
        pending = db.transaction(async (runtime) => {
          const [row] = await runtime.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)
          started(row!.pid)
          return port.reserveChatCost(runtime, input)
        })
        void pending.catch(() => {})
        const pid = await ready
        let blocked = false
        for (let i = 0; i < 100 && !blocked; i++) {
          const [row] = await tx.execute<{ blocked: boolean }>(
            sql`select cardinality(pg_blocking_pids(${pid})) > 0 as blocked`
          )
          blocked = row!.blocked
          if (!blocked) await new Promise((r) => setTimeout(r, 5))
        }
        assert.equal(blocked, true)
        await tx
          .update(schema.memliaChatCostWindow)
          .set({ pricingProfile: { ...estimateProfile().profile, model: 'gpt-5.5' } })
          .where(eq(schema.memliaChatCostWindow.id, a.windowId))
      })
      assert.deepEqual(await pending, { kind: 'refused', reason: 'reconciliation_required' })
    } finally {
      await pending?.catch(() => {})
    }
  }))
