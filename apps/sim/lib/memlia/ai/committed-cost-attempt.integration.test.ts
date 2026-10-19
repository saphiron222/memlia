// Copyright 2026 Memlia. All rights reserved.
// Dedicated root-assigned P06 database only; no DDL or credential file access.
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
import type { ChatCostAttempt } from './cost-reservation.server'

const runtimeDsn = process.env.TEST_DATABASE_URL
const ownerDsn = process.env.MEMLIA_CHAT_COST_TEST_OWNER_URL
assert.ok(runtimeDsn && ownerDsn, 'Dedicated cost-reservation test database required')
const runtimeUrl = assertDisposableTestDatabaseUrl(runtimeDsn)
const ownerUrl = assertDisposableTestDatabaseUrl(ownerDsn)
assert.equal(runtimeUrl.pathname, '/memlia_p06_budget_test')
assert.equal(ownerUrl.pathname, runtimeUrl.pathname)
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
const { createCommittedChatCostAttempts } = await import('./committed-cost-attempt.server')
const ownerConnection = postgres(ownerDsn, { max: 2, onnotice: () => {} })
const owner = drizzle(ownerConnection, { schema })
const prefix = `cost-commit-${randomUUID()}`

async function withFixture(label: string, check: (attempt: ChatCostAttempt) => Promise<void>) {
  const windowId = `${prefix}-${label}`
  const userId = `${windowId}-user`
  const workspaceId = `${windowId}-workspace`
  try {
    await owner.insert(user).values({
      id: userId,
      name: 'Commit fixture',
      email: `${userId}@example.invalid`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    await insertWorkspaceFixture(owner, {
      id: workspaceId,
      name: 'Commit fixture',
      ownerId: userId,
      billedAccountUserId: userId,
      organizationId: null,
    })
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
    await owner.execute(sql`delete from memlia_chat_cost_reservation where window_id = ${windowId}`)
    await owner.execute(sql`delete from memlia_chat_cost_window where id = ${windowId}`)
    await owner.delete(usageLog).where(eq(usageLog.userId, userId))
    await deleteWorkspaceFixture(owner, eq(workspace.id, workspaceId))
    await owner.delete(user).where(eq(user.id, userId))
  }
}

async function rows(attempt: ChatCostAttempt) {
  return owner.execute<{
    state: string
    settled_cost_usd: string | null
    ledger_id: string | null
  }>(
    sql`select state, settled_cost_usd, ledger_id from memlia_chat_cost_reservation where attempt_id = ${attempt.attemptId}`
  )
}

after(async () => {
  await ownerConnection.end()
})

test('positive reserve result is already committed on an independent connection', () =>
  withFixture('visible', async (input) => {
    const instance = createCommittedChatCostAttempts()
    const result = await instance.reserve(input)
    assert.equal(result.kind, 'reserved_committed')
    assert.equal((await rows(input)).length, 1)
    if (result.kind !== 'reserved_committed')
      throw new Error('fixture requires committed reference')
    assert.equal(JSON.stringify(result.reference), '{}')
    assert.equal(Object.isFrozen(result.reference), true)
    assert.equal(Object.getOwnPropertyNames(result.reference).length, 0)
  }))

test('same identity concurrently produces one opaque reference and no resend reference', () =>
  withFixture('duplicate', async (input) => {
    const one = createCommittedChatCostAttempts()
    const two = createCommittedChatCostAttempts()
    const results = await Promise.all([one.reserve(input), two.reserve(input)])
    assert.equal(results.filter((result) => result.kind === 'reserved_committed').length, 1)
    assert.equal(results.filter((result) => result.kind === 'already_reserved').length, 1)
    assert.equal((await rows(input)).length, 1)
    assert.deepEqual(await one.reserve(input), { kind: 'already_reserved' })
  }))

test('different concurrent attempts preserve the native window ceiling', () =>
  withFixture('ceiling', async (input) => {
    const instance = createCommittedChatCostAttempts()
    const results = await Promise.all([
      instance.reserve(input),
      instance.reserve({ ...input, attemptId: `${input.attemptId}-other` }),
    ])
    assert.equal(results.filter((result) => result.kind === 'reserved_committed').length, 1)
    assert.deepEqual(
      results.find((result) => result.kind !== 'reserved_committed'),
      {
        kind: 'refused',
        reason: 'budget_exhausted',
      }
    )
  }))

test('settlement commits its native receipt and ledger before returning', () =>
  withFixture('settled', async (input) => {
    const instance = createCommittedChatCostAttempts()
    const abort = new AbortController()
    const result = await instance.reserve(input, abort.signal)
    if (result.kind !== 'reserved_committed')
      throw new Error('fixture requires committed reference')
    abort.abort(new Error('private-stream-finished-canary'))
    assert.deepEqual(
      await instance.settle(result.reference, { kind: 'known', finalCostUsd: '0.25' }),
      {
        kind: 'settled_committed',
        duplicate: false,
      }
    )
    const [receipt] = await rows(input)
    assert.equal(receipt.state, 'settled')
    const [ledger] = await owner.execute<{ cost: string }>(
      sql`select cost from usage_log where id = ${receipt.ledger_id}`
    )
    assert.equal(Number(ledger.cost), 0.25)
    assert.deepEqual(
      await instance.settle(result.reference, { kind: 'known', finalCostUsd: '0.25' }),
      {
        kind: 'settled_committed',
        duplicate: true,
      }
    )
  }))

test('foreign, forged and cloned references cannot select a reservation', () =>
  withFixture('provenance', async (input) => {
    const instance = createCommittedChatCostAttempts()
    const other = createCommittedChatCostAttempts()
    const result = await instance.reserve(input)
    if (result.kind !== 'reserved_committed')
      throw new Error('fixture requires committed reference')
    assert.deepEqual(
      await other.settle(result.reference, { kind: 'known', finalCostUsd: '0.25' }),
      {
        kind: 'refused',
        reason: 'invalid_reference',
      }
    )
    for (const foreign of [
      {},
      { ...result.reference },
      JSON.parse(JSON.stringify(result.reference)),
      null,
    ]) {
      assert.deepEqual(await instance.settle(foreign, { kind: 'known', finalCostUsd: '0.25' }), {
        kind: 'refused',
        reason: 'invalid_reference',
      })
    }
    assert.equal((await rows(input))[0].state, 'reserved')
  }))

test('unknown cost retains debt and positive overrun commits ledger plus blocked window', () =>
  withFixture('unknown', async (input) => {
    const instance = createCommittedChatCostAttempts()
    const result = await instance.reserve(input)
    if (result.kind !== 'reserved_committed')
      throw new Error('fixture requires committed reference')
    assert.deepEqual(await instance.settle(result.reference, { kind: 'unknown' }), {
      kind: 'retained_committed',
      reason: 'unknown_cost',
    })
    assert.equal((await rows(input))[0].state, 'unknown')
    assert.deepEqual(
      await instance.settle(result.reference, { kind: 'known', finalCostUsd: '0.9' }),
      {
        kind: 'settled_and_blocked_committed',
        reason: 'cost_exceeded_reservation',
      }
    )
    const [receipt] = await rows(input)
    assert.equal(receipt.state, 'settled')
    const [ledger] = await owner.execute<{ cost: string }>(
      sql`select cost from usage_log where id = ${receipt.ledger_id}`
    )
    assert.equal(Number(ledger.cost), 0.9)
    const [budget] = await owner.execute<{ state: string }>(
      sql`select state from memlia_chat_cost_window where id = ${input.windowId}`
    )
    assert.equal(budget.state, 'blocked')
  }))

test('abort before reserve does not open a transaction or create debt', () =>
  withFixture('pre-abort', async (input) => {
    const signal = AbortSignal.abort(new Error('private-abort-canary'))
    assert.deepEqual(await createCommittedChatCostAttempts().reserve(input, signal), {
      kind: 'refused',
      reason: 'cancelled',
    })
    assert.equal((await rows(input)).length, 0)
  }))

// Explicit transaction-boundary doubles below: PostgreSQL and native reserve/ledger
// remain real; only response delivery, rollback and controlled waits are injected.
async function transactionBoundary(
  replacement: (native: typeof db.transaction) => typeof db.transaction,
  check: () => Promise<void>
) {
  const original = db.transaction
  db.transaction = replacement(original.bind(db))
  try {
    await check()
  } finally {
    db.transaction = original
  }
}

test('rollback after a native reserve cannot return a committed reference', () =>
  withFixture('rollback', async (input) => {
    await transactionBoundary(
      (native) =>
        (async (callback, ...args) =>
          native(
            async (tx) => {
              await callback(tx)
              throw new Error('private-rollback-canary')
            },
            ...args
          )) as typeof db.transaction,
      async () => {
        assert.deepEqual(await createCommittedChatCostAttempts().reserve(input), {
          kind: 'commit_unknown',
        })
      }
    )
    assert.equal((await rows(input)).length, 0)
  }))

test('lost COMMIT acknowledgement retains the real debt without automatic retry', () =>
  withFixture('lost-ack', async (input) => {
    let transactions = 0
    const instance = createCommittedChatCostAttempts()
    await transactionBoundary(
      (native) =>
        (async (...args) => {
          transactions++
          await native(...args)
          throw new Error('private-commit-ack-canary')
        }) as typeof db.transaction,
      async () => {
        assert.deepEqual(await instance.reserve(input), { kind: 'commit_unknown' })
      }
    )
    assert.equal(transactions, 1)
    assert.equal((await rows(input)).length, 1)
    assert.deepEqual(await instance.reserve(input), { kind: 'already_reserved' })
  }))

test('abort delivered after COMMIT suppresses the reference but retains debt', () =>
  withFixture('post-abort', async (input) => {
    const abort = new AbortController()
    await transactionBoundary(
      (native) =>
        (async (...args) => {
          const result = await native(...args)
          abort.abort(new Error('private-late-abort-canary'))
          return result
        }) as typeof db.transaction,
      async () => {
        assert.deepEqual(await createCommittedChatCostAttempts().reserve(input, abort.signal), {
          kind: 'refused',
          reason: 'cancelled',
        })
      }
    )
    assert.equal((await rows(input)).length, 1)
  }))

test('reserve input is captured before the first transaction wait', () =>
  withFixture('capture', async (input) => {
    const expected = structuredClone(input)
    const mutable = { ...input, attribution: { ...input.attribution } }
    await transactionBoundary(
      (native) =>
        (async (...args) => {
          mutable.attribution.actorUserId = 'mutated-private-subject'
          mutable.attemptId = 'mutated-private-attempt'
          mutable.maximumCostUsd = '0.01'
          return native(...args)
        }) as typeof db.transaction,
      async () => {
        const result = await createCommittedChatCostAttempts().reserve(mutable)
        assert.equal(result.kind, 'reserved_committed')
      }
    )
    assert.equal((await rows(expected)).length, 1)
    assert.equal((await rows(mutable)).length, 0)
  }))

test('settlement outcome is captured before the transaction wait', () =>
  withFixture('outcome-copy', async (input) => {
    const instance = createCommittedChatCostAttempts()
    const result = await instance.reserve(input)
    if (result.kind !== 'reserved_committed')
      throw new Error('fixture requires committed reference')
    const outcome = { kind: 'known' as const, finalCostUsd: '0.25' }
    await transactionBoundary(
      (native) =>
        (async (...args) => {
          outcome.finalCostUsd = '0.99'
          return native(...args)
        }) as typeof db.transaction,
      async () => {
        assert.deepEqual(await instance.settle(result.reference, outcome), {
          kind: 'settled_committed',
          duplicate: false,
        })
      }
    )
    assert.equal(Number((await rows(input))[0].settled_cost_usd), 0.25)
  }))

test('lost settlement acknowledgement never retries or undoes the committed ledger', () =>
  withFixture('settle-ack', async (input) => {
    const instance = createCommittedChatCostAttempts()
    const result = await instance.reserve(input)
    if (result.kind !== 'reserved_committed')
      throw new Error('fixture requires committed reference')
    let transactions = 0
    await transactionBoundary(
      (native) =>
        (async (...args) => {
          transactions++
          await native(...args)
          throw new Error('private-settlement-ack-canary')
        }) as typeof db.transaction,
      async () => {
        assert.deepEqual(
          await instance.settle(result.reference, { kind: 'known', finalCostUsd: '0.25' }),
          { kind: 'commit_unknown' }
        )
      }
    )
    assert.equal(transactions, 1)
    assert.equal((await rows(input))[0].state, 'settled')
    assert.deepEqual(
      await instance.settle(result.reference, { kind: 'known', finalCostUsd: '0.25' }),
      { kind: 'settled_committed', duplicate: true }
    )
  }))

test('strict input copying rejects accessors without invoking caller code', () =>
  withFixture('getter', async (input) => {
    let reads = 0
    Object.defineProperty(input, 'maximumCostUsd', {
      enumerable: true,
      get() {
        reads++
        return '0.01'
      },
    })
    assert.deepEqual(await createCommittedChatCostAttempts().reserve(input), {
      kind: 'refused',
      reason: 'invalid_input',
    })
    assert.equal(reads, 0)
    assert.equal((await rows(input)).length, 0)
  }))

test('native callback completion is not confused with transaction COMMIT', () =>
  withFixture('before-commit', async (input) => {
    let entered!: () => void
    const ready = new Promise<void>((resolve) => {
      entered = resolve
    })
    let resume!: () => void
    const gate = new Promise<void>((resolve) => {
      resume = resolve
    })
    await transactionBoundary(
      (native) =>
        (async (callback, ...args) =>
          native(
            async (tx) => {
              const result = await callback(tx)
              entered()
              await gate
              return result
            },
            ...args
          )) as typeof db.transaction,
      async () => {
        let returned = false
        const pending = createCommittedChatCostAttempts()
          .reserve(input)
          .then((result) => {
            returned = true
            return result
          })
        try {
          await ready
          assert.equal(returned, false)
          assert.equal(
            (await rows(input)).length,
            0,
            'independent connection cannot see the uncommitted hold'
          )
        } finally {
          resume()
        }
        assert.equal((await pending).kind, 'reserved_committed')
        assert.equal((await rows(input)).length, 1)
      }
    )
  }))

test('abort between native reserve and COMMIT does not erase its engagement', () =>
  withFixture('mid-abort', async (input) => {
    const abort = new AbortController()
    await transactionBoundary(
      (native) =>
        (async (callback, ...args) =>
          native(
            async (tx) => {
              const result = await callback(tx)
              abort.abort(new Error('private-mid-abort-canary'))
              return result
            },
            ...args
          )) as typeof db.transaction,
      async () => {
        assert.deepEqual(await createCommittedChatCostAttempts().reserve(input, abort.signal), {
          kind: 'refused',
          reason: 'cancelled',
        })
      }
    )
    assert.equal((await rows(input)).length, 1)
  }))

test('settlement rollback leaves the commitment and no usage event', () =>
  withFixture('settle-rollback', async (input) => {
    const instance = createCommittedChatCostAttempts()
    const result = await instance.reserve(input)
    if (result.kind !== 'reserved_committed')
      throw new Error('fixture requires committed reference')
    await transactionBoundary(
      (native) =>
        (async (callback, ...args) =>
          native(
            async (tx) => {
              await callback(tx)
              throw new Error('private-settlement-rollback-canary')
            },
            ...args
          )) as typeof db.transaction,
      async () => {
        assert.deepEqual(
          await instance.settle(result.reference, { kind: 'known', finalCostUsd: '0.25' }),
          { kind: 'commit_unknown' }
        )
      }
    )
    const [receipt] = await rows(input)
    assert.equal(receipt.state, 'reserved')
    assert.equal(receipt.ledger_id, null)
    const [ledger] = await owner.execute<{ count: number }>(
      sql`select count(*)::int as count from usage_log where user_id = ${input.attribution.actorUserId}`
    )
    assert.equal(ledger.count, 0)
  }))

const { captureChatPricingProfile } = await import('./chat-pricing-profile.server')
async function configureProfile(input: ChatCostAttempt) {
  const captured = captureChatPricingProfile({
    version: 1,
    basis: 'native_list_price_estimate_v1',
    provider: 'openai',
    model: 'gpt-5.4',
    pricing: { input: 2.5, output: 15, updatedAt: '2026-10-01' },
    bounds: { contextTokens: 1000000, outputTokens: 128000 },
    maximumCostUsd: '0.75',
  })
  await owner
    .update(schema.memliaChatCostWindow)
    .set({ pricingProfile: captured.profile })
    .where(eq(schema.memliaChatCostWindow.id, input.windowId))
  return { ...input, expectedPricingProfileHash: captured.hash }
}
test('committed reference retains the captured profile despite caller mutation', () =>
  withFixture('profile-ref', async (a) => {
    const input = await configureProfile(a)
    const instance = createCommittedChatCostAttempts()
    const pending = instance.reserve(input)
    input.expectedPricingProfileHash = '0'.repeat(64)
    const result = await pending
    assert.equal(result.kind, 'reserved_committed')
    if (result.kind !== 'reserved_committed') throw new Error('fixture')
    assert.deepEqual(
      await instance.settle(result.reference, { kind: 'known', finalCostUsd: '0.25' }),
      { kind: 'settled_committed', duplicate: false }
    )
  }))
test('committed profile identity refuses admin replacement and preserves unknown hold', () =>
  withFixture('profile-admin', async (a) => {
    const input = await configureProfile(a)
    const instance = createCommittedChatCostAttempts()
    const result = await instance.reserve(input)
    if (result.kind !== 'reserved_committed') throw new Error('fixture')
    assert.equal(
      (await instance.settle(result.reference, { kind: 'unknown' })).kind,
      'retained_committed'
    )
    await owner
      .update(schema.memliaChatCostWindow)
      .set({ pricingProfile: null })
      .where(eq(schema.memliaChatCostWindow.id, a.windowId))
    assert.deepEqual(
      await instance.settle(result.reference, { kind: 'known', finalCostUsd: '0.25' }),
      { kind: 'refused', reason: 'reconciliation_required' }
    )
    assert.equal((await rows(input))[0]!.state, 'unknown')
    assert.equal((await rows(input))[0]!.ledger_id, null)
  }))
test('profiled COMMIT unknown keeps its durable snapshot and grants no reference', () =>
  withFixture('profile-ack', async (a) => {
    const input = await configureProfile(a)
    const instance = createCommittedChatCostAttempts()
    await transactionBoundary(
      (native) =>
        (async (...args) => {
          await native(...args)
          throw new Error('fixture-lost-ack')
        }) as typeof db.transaction,
      async () => {
        assert.deepEqual(await instance.reserve(input), { kind: 'commit_unknown' })
      }
    )
    const [stored] = await owner
      .select()
      .from(schema.memliaChatCostReservation)
      .where(eq(schema.memliaChatCostReservation.attemptId, a.attemptId))
    assert.equal(
      captureChatPricingProfile(stored!.pricingProfile).hash,
      input.expectedPricingProfileHash
    )
    assert.deepEqual(await instance.reserve(input), { kind: 'already_reserved' })
  }))
test('profiled reserve rollback leaves no profile snapshot or engagement', () =>
  withFixture('profile-rollback', async (a) => {
    const input = await configureProfile(a)
    await transactionBoundary(
      (native) =>
        (async (callback, ...args) =>
          native(
            async (tx) => {
              await callback(tx)
              throw new Error('fixture-rollback')
            },
            ...args
          )) as typeof db.transaction,
      async () => {
        assert.deepEqual(await createCommittedChatCostAttempts().reserve(input), {
          kind: 'commit_unknown',
        })
      }
    )
    assert.equal((await rows(input)).length, 0)
  }))
