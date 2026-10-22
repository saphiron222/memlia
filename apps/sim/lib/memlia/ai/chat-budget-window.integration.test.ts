// Copyright 2026 Memlia. All rights reserved.
// Real primary PostgreSQL reads; administrative DML only for this suite's owned fixtures.
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

const runtimeDsn = process.env.TEST_DATABASE_URL
const ownerDsn = process.env.MEMLIA_CHAT_COST_TEST_OWNER_URL
assert.ok(runtimeDsn && ownerDsn, 'Dedicated budget-window test database required')
const runtimeUrl = assertDisposableTestDatabaseUrl(runtimeDsn)
const ownerUrl = assertDisposableTestDatabaseUrl(ownerDsn)
assert.equal(runtimeUrl.pathname, '/memlia_p06_budget_test')
assert.equal(ownerUrl.pathname, runtimeUrl.pathname)
assert.notEqual(runtimeUrl.username, ownerUrl.username)
clearInheritedDatabaseUrls()
process.env.DATABASE_URL = runtimeDsn
const { db } = await import('@sim/db')
const schema = await import('@sim/db/schema')
const { memliaChatCostWindow: window, memliaChatCostReservation: reservation } = schema
const { readChatBudgetWindow } = await import('./chat-budget-window.server')
const ownerConnection = postgres(ownerDsn, { max: 1, onnotice: () => {} })
const owner = drizzle(ownerConnection, { schema })
const prefix = `read-window-${randomUUID()}`
const model = 'memlia_fixture_model'
const profile = {
  version: 1,
  basis: 'native_list_price_estimate_v1',
  provider: 'openai',
  model,
  pricing: { input: 1, output: 2, updatedAt: '2026-10-19' },
  bounds: { contextTokens: 1024, outputTokens: 128 },
  maximumCostUsd: '0.01',
}
const error = new Error('Chat budget window is unavailable.')
async function withWindow(
  label: string,
  override: Partial<typeof window.$inferInsert>,
  check: (input: { windowId: string; windowVersion: number; model: string }) => Promise<void>
) {
  const windowId = `${prefix}-${label}`
  const now = Date.now()
  try {
    await owner
      .insert(window)
      .values({
        id: windowId,
        version: 7,
        currency: 'USD',
        startsAt: new Date(now - 60000),
        endsAt: new Date(now + 60000),
        limitUsd: '1',
        state: 'open',
        pricingProfile: profile,
        ...override,
      })
    await check({ windowId, windowVersion: 7, model })
    const rows = await owner
      .select({ count: sql<number>`count(*)::integer` })
      .from(reservation)
      .where(eq(reservation.windowId, windowId))
    assert.equal(rows[0]?.count, 0, 'a read must never reserve money or grant a transport')
  } finally {
    await owner.delete(window).where(eq(window.id, windowId))
  }
}
after(async () => {
  await ownerConnection.end({ timeout: 5 })
  await db.$client.end({ timeout: 5 })
})

test('reads only the explicitly selected active window and captures its exact profile', async () => {
  await withWindow('selected', {}, async (input) => {
    const pending = readChatBudgetWindow(input)
    const selected = input.windowId
    input.windowId = 'mutated_after_first_await'
    input.windowVersion = 99
    input.model = 'different_model'
    const result = await pending
    assert.deepEqual(result, { windowId: selected, windowVersion: 7, pricingProfile: profile })
    assert.equal(Object.isFrozen(result), true)
    assert.equal(Object.isFrozen(result.pricingProfile), true)
    assert.equal(Object.isFrozen(result.pricingProfile.pricing), true)
  })
})
test('never chooses a different active window or silently updates its version', async () => {
  await withWindow('other', {}, async (input) => {
    await assert.rejects(() => readChatBudgetWindow({ ...input, windowId: 'absent_window' }), error)
    await assert.rejects(() => readChatBudgetWindow({ ...input, windowVersion: 8 }), error)
    await assert.rejects(() => readChatBudgetWindow({ ...input, model: 'another_model' }), error)
  })
})
for (const [label, override] of [
  ['blocked', { state: 'blocked' }],
  ['expired', { startsAt: new Date(0), endsAt: new Date(1) }],
  ['future', { startsAt: new Date('2099-01-01'), endsAt: new Date('2099-02-01') }],
  ['legacy', { pricingProfile: null }],
  ['malformed', { pricingProfile: { model, apiKey: 'FICTITIOUS_PRIVATE_VALUE' } }],
  ['foreign-model', { pricingProfile: { ...profile, model: 'another_model' } }],
] as const) {
  test(`refuses the canonical ${label} window instead of substituting a profile`, async () => {
    await withWindow(label, override, async (input) => {
      await assert.rejects(() => readChatBudgetWindow(input), error)
    })
  })
}
test('refuses caller extras and accessors without evaluating or exposing their values', async () => {
  let reads = 0
  const input = { windowId: 'fixture_window', windowVersion: 1, model }
  Object.defineProperty(input, 'model', {
    enumerable: true,
    get() {
      reads++
      throw new Error('FICTITIOUS_PRIVATE_GETTER')
    },
  })
  await assert.rejects(() => readChatBudgetWindow(input), error)
  assert.equal(reads, 0)
  for (const value of [
    undefined,
    null,
    {},
    { windowId: 'fixture', windowVersion: 0, model },
    { windowId: 'fixture', windowVersion: 1, model, apiKey: 'FICTITIOUS_PRIVATE_KEY' },
  ]) {
    await assert.rejects(() => readChatBudgetWindow(value), error)
  }
})
