// Copyright 2026 Memlia. All rights reserved.
// Real PostgreSQL, COMMIT port, binding, OpenAI loop, SSE/usage and pricing.
// HTTP and unrelated catalogue/workflow tool execution are explicit doubles.
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
import { z } from 'zod'
import { mock } from 'bun:test'

mock.module('@/providers', () => ({ MAX_TOOL_ITERATIONS: 1 }))
mock.module('@/tools', () => ({
  executeTool: async () => {
    throw new Error('Unrelated tool transport forbidden')
  },
}))
mock.module('@/lib/memlia/chat/catalog-tools', () => ({
  catalogToolInputs: { list_blocks: z.object({}).strict() },
  createCatalogTools: () => ({ dispatch: async () => ({ ok: true, data: { entries: [] } }) }),
}))
mock.module('@/lib/memlia/chat/workflow-read-tools', () => ({
  workflowReadInputs: { read_workflow: z.object({}), read_workflow_block: z.object({}) },
  createWorkflowReadTools: () => {
    throw new Error('Workflow fixture not enabled')
  },
}))
mock.module('@/lib/memlia/chat/workflow-preview-tools', () => ({
  workflowPreviewInputs: { preview_workflow_operations: z.object({}) },
  createWorkflowPreviewTools: () => {
    throw new Error('Workflow fixture not enabled')
  },
}))

const runtimeDsn = process.env.TEST_DATABASE_URL
const ownerDsn = process.env.MEMLIA_CHAT_COST_TEST_OWNER_URL
assert.ok(runtimeDsn && ownerDsn)
const runtimeUrl = assertDisposableTestDatabaseUrl(runtimeDsn)
const ownerUrl = assertDisposableTestDatabaseUrl(ownerDsn)
assert.equal(runtimeUrl.pathname, '/memlia_p06_budget_test')
assert.equal(ownerUrl.pathname, runtimeUrl.pathname)
assert.notEqual(ownerUrl.username, runtimeUrl.username)
clearInheritedDatabaseUrls()
process.env.DATABASE_URL = runtimeDsn
const { db } = await import('@sim/db')
const schema = await import('@sim/db/schema')
const { user, workspace, usageLog } = schema
const { insertWorkspaceFixture, deleteWorkspaceFixture } = await import(
  '@sim/db/testing/workspace-fixtures'
)
const { getStaticProviderModels } = await import('@/providers/models')
const { getModelPricing } = await import('@/providers/pricing')
// Transparent test recorder: forwards unchanged to the real binding. Only adversarial
// reference/late-observer probes use these otherwise inaccessible server callbacks.
const { runCatalogProvider: nativeBinding, captureWorkflowProposalBinding } = await import(
  '@/lib/memlia/chat/provider-binding'
)
let recordedBinding: Parameters<typeof nativeBinding>[0] | undefined
let begun:
  | Parameters<NonNullable<Parameters<typeof nativeBinding>[0]['beforeModelTransport']>>
  | undefined
const observedReferences: Parameters<
  NonNullable<Parameters<typeof nativeBinding>[0]['observeModelAttempt']>
>[] = []
mock.module('@/lib/memlia/chat/provider-binding', () => ({
  captureWorkflowProposalBinding,
  runCatalogProvider: (input: Parameters<typeof nativeBinding>[0]) => {
    recordedBinding = input
    const observe = input.observeModelAttempt
    const before = input.beforeModelTransport
    return nativeBinding({
      ...input,
      ...(before
        ? {
            beforeModelTransport: async (...args: Parameters<typeof before>) => {
              begun = args
              await before(...args)
            },
          }
        : {}),
      ...(observe
        ? {
            observeModelAttempt: async (...args: Parameters<typeof observe>) => {
              observedReferences.push(args)
              await observe(...args)
            },
          }
        : {}),
    })
  },
}))
const { runBudgetedCatalogProvider } = await import('./budgeted-catalog-provider.server')
const ownerConnection = postgres(ownerDsn, { max: 3, onnotice: () => {} })
const owner = drizzle(ownerConnection, { schema })
const prefix = `budget-binding-${randomUUID()}`
const originalFetch = globalThis.fetch
const definition = getStaticProviderModels('openai').find((model) => model.id === 'gpt-5.4')!
assert.ok(definition.contextWindow && definition.capabilities?.maxOutputTokens)
const profile = () => ({
  version: 1 as const,
  basis: 'native_list_price_estimate_v1' as const,
  provider: 'openai' as const,
  model: definition.id,
  pricing: structuredClone(getModelPricing(definition.id)!),
  bounds: { contextTokens: definition.contextWindow!, outputTokens: 100 },
  maximumCostUsd: '100',
})

async function fixture(
  label: string,
  check: (options: any, rows: () => Promise<any[]>) => Promise<void>,
  limit = '1000'
) {
  const windowId = `${prefix}-${label}`
  const userId = `${windowId}-user`
  const workspaceId = `${windowId}-ws`
  const pricing = profile()
  try {
    await owner.insert(user).values({
      id: userId,
      name: 'Budget fixture',
      email: `${userId}@example.invalid`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    await insertWorkspaceFixture(owner, {
      id: workspaceId,
      name: 'Budget fixture',
      ownerId: userId,
      billedAccountUserId: userId,
      organizationId: null,
    })
    await owner.execute(
      sql`insert into memlia_chat_cost_window (id,version,currency,starts_at,ends_at,limit_usd,state,pricing_profile) values (${windowId},1,'USD',now()-interval '1 hour',now()+interval '1 hour',${limit},'open',${JSON.stringify(pricing)}::jsonb)`
    )
    await check(
      {
        principal: { kind: 'session', userId, sessionId: 'fixture-session' },
        workspaceId,
        request: {
          model: definition.id,
          apiKey: 'fixture-not-a-provider-key',
          messages: [{ role: 'user', content: 'Fixture' }],
          maxTokens: 100,
        },
        budget: { windowId, windowVersion: 1, pricingProfile: pricing },
        limits: { maxModelCalls: 4, maxToolCalls: 4, maxDurationMs: 5000 },
      },
      () =>
        owner.execute(
          sql`select * from memlia_chat_cost_reservation where window_id=${windowId} order by created_at,attempt_id`
        )
    )
  } finally {
    globalThis.fetch = originalFetch
    await owner.execute(sql`delete from memlia_chat_cost_reservation where window_id=${windowId}`)
    await owner.execute(sql`delete from memlia_chat_cost_window where id=${windowId}`)
    await owner.delete(usageLog).where(eq(usageLog.userId, userId))
    await deleteWorkspaceFixture(owner, eq(workspace.id, workspaceId))
    await owner.delete(user).where(eq(user.id, userId))
  }
}
function response(
  output: unknown[] = [],
  usage: unknown = { input_tokens: 100, output_tokens: 10, total_tokens: 110 }
) {
  const terminal = { id: 'fixture-response', status: 'completed', output, usage }
  return new Response(
    `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: terminal })}\n\n`,
    { headers: { 'Content-Type': 'text/event-stream' } }
  )
}
async function drain(options: any) {
  const run = await runBudgetedCatalogProvider(options)
  const reader = run.stream.getReader()
  try {
    while (!(await reader.read()).done) {}
  } finally {
    reader.releaseLock()
  }
  return run
}
after(async () => {
  globalThis.fetch = originalFetch
  try {
    const [left] = await owner.execute(sql`select
      (select count(*) from memlia_chat_cost_reservation where window_id like ${`${prefix}%`}) +
      (select count(*) from memlia_chat_cost_window where id like ${`${prefix}%`}) +
      (select count(*) from usage_log where user_id like ${`${prefix}%`}) +
      (select count(*) from workspace where id like ${`${prefix}%`}) +
      (select count(*) from "user" where id like ${`${prefix}%`}) as remaining`)
    assert.equal(Number(left.remaining), 0)
    console.log(JSON.stringify({ ownedFixtureRowsRemaining: 0 }))
  } finally {
    await ownerConnection.end()
  }
})

test('exhausted committed window prevents the physical HTTP request', () =>
  fixture(
    'exhausted',
    async (options, rows) => {
      let calls = 0
      globalThis.fetch = async () => {
        calls++
        return response()
      }
      let failed = false
      try {
        await drain(options)
      } catch {
        failed = true
      }
      assert.equal(calls, 0, 'No physical request may precede a new committed reservation')
      assert.equal(failed, true)
      assert.equal((await rows()).length, 0)
    },
    '1'
  ))

test('HTTP observes the committed reservation and native settlement persists profile and ledger', () =>
  fixture('visible', async (options, rows) => {
    let calls = 0
    globalThis.fetch = async (_url, init) => {
      calls++
      const current = await rows()
      assert.equal(current.length, 1)
      assert.equal(current[0].state, 'reserved')
      assert.deepEqual(current[0].pricing_profile, options.budget.pricingProfile)
      assert.equal(JSON.parse(String(init?.body)).max_output_tokens, 100)
      assert.equal(init?.redirect, 'error')
      return response()
    }
    await drain(options)
    assert.equal(calls, 1)
    const [row] = await rows()
    assert.equal(row.state, 'settled')
    const [ledger] = await owner.execute(sql`select cost from usage_log where id=${row.ledger_id}`)
    assert.equal(Number(ledger.cost), Number(row.settled_cost_usd))
    assert.ok(Number(ledger.cost) > 0)
  }))

for (const mode of ['retry', 'summary'] as const)
  test(`${mode} reserves a distinct physical attempt and retains first unknown`, () =>
    fixture(mode, async (options, rows) => {
      let calls = 0
      globalThis.fetch = async (_url, init) => {
        assert.equal(JSON.parse(String(init?.body)).max_output_tokens, 100)
        calls++
        if (calls === 1)
          return mode === 'retry'
            ? new Response('{}', { status: 503, headers: { 'retry-after-ms': '0' } })
            : new Response(
                JSON.stringify({ error: { message: 'reasoning.summary requires verification' } }),
                { status: 400 }
              )
        return response()
      }
      await drain(options)
      assert.equal(calls, 2)
      const records = await rows()
      assert.equal(records.length, 2)
      assert.equal(new Set(records.map((r) => r.attempt_id)).size, 2)
      assert.deepEqual(records.map((r) => r.state).sort(), ['settled', 'unknown'])
    }))

test('tool turn and final synthesis each retain output limit and settle their own native usage', () =>
  fixture('synthesis', async (options, rows) => {
    const bodies: any[] = []
    globalThis.fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      return bodies.length === 1
        ? response([
            {
              type: 'function_call',
              call_id: 'fixture-call',
              id: 'fixture-call',
              name: 'list_blocks',
              arguments: '{}',
              status: 'completed',
            },
          ])
        : response([], { input_tokens: 200, output_tokens: 20, total_tokens: 220 })
    }
    const run = await drain(options)
    assert.equal(bodies.length, 2)
    assert.ok(bodies.every((b) => b.max_output_tokens === 100))
    assert.equal(bodies[1].tool_choice, 'none')
    assert.equal(bodies[1].tools, undefined)
    assert.deepEqual(run.usage(), { modelCalls: 2, toolCalls: 1 })
    const records = await rows()
    assert.equal(records.length, 2)
    assert.ok(records.every((r) => r.state === 'settled'))
    const costs = records.map((r) => Number(r.settled_cost_usd)).sort((a, b) => a - b)
    assert.equal(costs[1], 2 * costs[0])
  }))

for (const mode of ['missing', 'malformed', 'zero'] as const)
  test(`${mode} usage never releases the commitment as known zero`, () =>
    fixture(mode, async (options, rows) => {
      globalThis.fetch = async () =>
        response(
          [],
          mode === 'missing'
            ? undefined
            : mode === 'zero'
              ? { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
              : {
                  input_tokens: 100,
                  output_tokens: 10,
                  total_tokens: 110,
                  input_tokens_details: { cached_tokens: -1 },
                }
        )
      // Explicitly missing usage cannot use the response fixture's default argument.
      if (mode === 'missing') globalThis.fetch = async () => response([], null)
      try {
        await drain(options)
      } catch {
        assert.equal(mode, 'zero')
      }
      const [row] = await rows()
      assert.equal(row.state, 'unknown')
      assert.equal(row.ledger_id, null)
    }))

for (const change of [
  'no-output',
  'wrong-model',
  'small-context',
  'excess-output',
  'small-ceiling',
  'wrong-rate',
  'unknown-field',
  'getter',
] as const)
  test(`invalid server configuration ${change} refuses before reserve and HTTP`, () =>
    fixture(`invalid-${change}`, async (options, rows) => {
      let calls = 0
      let getters = 0
      globalThis.fetch = async () => {
        calls++
        return response()
      }
      switch (change) {
        case 'no-output':
          Reflect.deleteProperty(options.request, 'maxTokens')
          break
        case 'wrong-model':
          options.request.model = 'gpt-5.4-alias'
          break
        case 'small-context':
          options.budget.pricingProfile.bounds.contextTokens = 100
          break
        case 'excess-output':
          options.request.maxTokens = options.budget.pricingProfile.bounds.outputTokens =
            definition.capabilities!.maxOutputTokens! + 1
          break
        case 'small-ceiling':
          options.budget.pricingProfile.maximumCostUsd = '0.00000001'
          break
        case 'wrong-rate':
          options.budget.pricingProfile.pricing.input += 1
          break
        case 'unknown-field':
          options.beforeModelTransport = () => {
            throw new Error('Caller callback forbidden')
          }
          break
        case 'getter':
          Object.defineProperty(options.request, 'model', {
            enumerable: true,
            get() {
              getters++
              return 'gpt-5.4'
            },
          })
          break
      }
      await assert.rejects(() => drain(options), {
        message: 'Budgeted catalogue model is unavailable.',
      })
      assert.equal(calls, 0)
      assert.equal(getters, 0)
      assert.equal((await rows()).length, 0)
    }))

function barrier() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

test('new COMMIT acknowledgement gates HTTP and input mutation cannot change captured binding', () =>
  fixture('ack-wait', async (options, rows) => {
    const reached = barrier()
    const release = barrier()
    const original = db.transaction.bind(db)
    let transactions = 0
    let calls = 0
    // Real PG transaction, explicit post-COMMIT acknowledgement barrier only.
    db.transaction = async (transaction, config) => {
      const result = await original(transaction, config)
      if (++transactions === 1) {
        reached.resolve()
        await release.promise
      }
      return result
    }
    globalThis.fetch = async (_url, init) => {
      calls++
      assert.equal(JSON.parse(String(init?.body)).max_output_tokens, 100)
      return response()
    }
    try {
      const pending = drain(options)
      await reached.promise
      assert.equal((await rows()).length, 1)
      assert.equal(calls, 0)
      options.request.model = 'foreign'
      options.request.maxTokens = 999
      options.principal.userId = 'foreign'
      options.budget.pricingProfile.pricing.input = 999
      release.resolve()
      await pending
      assert.equal(calls, 1)
      assert.equal((await rows())[0].state, 'settled')
    } finally {
      release.resolve()
      db.transaction = original
    }
  }))

for (const mode of ['ack-lost', 'abort', 'registry-change'] as const)
  test(`${mode} after real COMMIT never sends and keeps debt`, () =>
    fixture(mode, async (options, rows) => {
      const original = db.transaction.bind(db)
      const abort = new AbortController()
      const pricing = getModelPricing(definition.id)!
      const oldRate = pricing.input
      let transactions = 0
      let calls = 0
      options.signal = abort.signal
      db.transaction = async (transaction, config) => {
        const result = await original(transaction, config)
        if (++transactions === 1) {
          if (mode === 'ack-lost') throw new Error('private-ack-canary')
          if (mode === 'abort') abort.abort(new Error('private-cancel-canary'))
          if (mode === 'registry-change') pricing.input = oldRate + 1
        }
        return result
      }
      globalThis.fetch = async () => {
        calls++
        return response()
      }
      try {
        await assert.rejects(() => drain(options))
        assert.equal(calls, 0)
        const [row] = await rows()
        assert.ok(row)
        assert.ok(['reserved', 'unknown'].includes(row.state))
        assert.equal(row.ledger_id, null)
      } finally {
        pricing.input = oldRate
        db.transaction = original
      }
    }))

for (const status of [200, 503])
  test(`ledger transaction error after HTTP ${status} remains fixed and does not replay`, () =>
    fixture(`ledger-error-${status}`, async (options, rows) => {
      const original = db.transaction.bind(db)
      let transactions = 0
      let calls = 0
      db.transaction = async (transaction, config) => {
        if (++transactions === 2)
          throw Object.assign(new Error('private-ledger-canary'), { cause: { code: 'ECONNRESET' } })
        return original(transaction, config)
      }
      globalThis.fetch = async () => {
        calls++
        return status === 200 ? response() : new Response('unavailable', { status })
      }
      try {
        let error: unknown
        try {
          await drain(options)
        } catch (caught) {
          error = caught
        }
        assert.ok(error)
        assert.doesNotMatch(String(error), /private-ledger|ECONNRESET/)
        assert.equal(calls, 1)
        assert.equal((await rows())[0].state, 'reserved')
      } finally {
        db.transaction = original
      }
    }))

test('two concurrent runs cannot exceed the installation commitment', () =>
  fixture(
    'concurrent',
    async (options, rows) => {
      const release = barrier()
      const sent = barrier()
      let calls = 0
      globalThis.fetch = async () => {
        calls++
        sent.resolve()
        await release.promise
        return response()
      }
      const one = drain(options)
      try {
        await sent.promise
        await assert.rejects(() => drain(options))
        assert.equal(calls, 1)
        assert.equal((await rows()).length, 1)
      } finally {
        release.resolve()
        await one
      }
    },
    '100'
  ))

test('known excess spend is recorded and blocks the window without a retry', () =>
  fixture('overrun', async (options, rows) => {
    let calls = 0
    globalThis.fetch = async () => {
      calls++
      return response([], { input_tokens: 100000000, output_tokens: 10, total_tokens: 100000010 })
    }
    await assert.rejects(() => drain(options))
    const [row] = await rows()
    assert.equal(row.state, 'settled')
    assert.ok(Number(row.settled_cost_usd) > 100)
    assert.ok(row.ledger_id)
    const [window] = await owner.execute(
      sql`select state from memlia_chat_cost_window where id=${options.budget.windowId}`
    )
    assert.equal(window.state, 'blocked')
    assert.equal(calls, 1)
  }))

test('native cache rates and open-ended tier settlement retain exact estimated USD', () =>
  fixture('cache-tier', async (options, rows) => {
    globalThis.fetch = async () =>
      response([], {
        input_tokens: 300000,
        output_tokens: 10,
        total_tokens: 300010,
        input_tokens_details: { cached_tokens: 100000, cache_write_tokens: 100000 },
      })
    await drain(options)
    const [row] = await rows()
    assert.equal(row.state, 'settled')
    // Native gpt-5.4 upper tier: input5/read0.5/output22.5 per million,
    // 100k uncached +100k read +100k write at native1.25; no cumulative allocation.
    assert.equal(Number(row.settled_cost_usd), 1.175225)
  }))

test('lower tier extreme and optional cache rate cannot evade the conservative ceiling', async () => {
  const pricing = getModelPricing(definition.id)!
  const old = structuredClone(pricing)
  try {
    pricing.input = 100000
    pricing.output = 1
    Reflect.deleteProperty(pricing, 'cachedInput')
    pricing.tiers = [{ aboveInputTokens: 100000, input: 1, output: 1 }]
    await fixture('nonmonotone', async (options, rows) => {
      let calls = 0
      globalThis.fetch = async () => {
        calls++
        return response()
      }
      await assert.rejects(() => drain(options))
      assert.equal(calls, 0)
      assert.equal((await rows()).length, 0)
    })
  } finally {
    for (const key of Object.keys(pricing)) Reflect.deleteProperty(pricing, key)
    Object.assign(pricing, old)
  }
})

test('larger cache-read rate and missing explicit native output bound fail closed', async () => {
  const pricing = getModelPricing(definition.id)!
  const old = structuredClone(pricing)
  const capabilities = definition.capabilities!
  const output = capabilities.maxOutputTokens
  try {
    pricing.cachedInput = 1000
    Reflect.deleteProperty(pricing, 'tiers')
    await fixture('cache-bound', async (options, rows) => {
      let calls = 0
      globalThis.fetch = async () => {
        calls++
        return response()
      }
      await assert.rejects(() => drain(options))
      assert.equal(calls, 0)
      assert.equal((await rows()).length, 0)
    })
    Object.assign(pricing, old)
    Reflect.deleteProperty(capabilities, 'maxOutputTokens')
    await fixture('no-native-bound', async (options, rows) => {
      globalThis.fetch = async () => {
        throw new Error('HTTP must not run')
      }
      await assert.rejects(() => drain(options))
      assert.equal((await rows()).length, 0)
    })
  } finally {
    for (const key of Object.keys(pricing)) Reflect.deleteProperty(pricing, key)
    Object.assign(pricing, old)
    capabilities.maxOutputTokens = output
  }
})

test('first known tool turn settles while the truncated second turn keeps its own hold', () =>
  fixture('partial-turn', async (options, rows) => {
    let calls = 0
    globalThis.fetch = async () =>
      ++calls === 1
        ? response([
            {
              type: 'function_call',
              call_id: 'fixture-call',
              id: 'fixture-call',
              name: 'list_blocks',
              arguments: '{}',
              status: 'completed',
            },
          ])
        : new Response(
            'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"unfinished"}\n\n',
            { headers: { 'Content-Type': 'text/event-stream' } }
          )
    await assert.rejects(() => drain(options))
    assert.equal(calls, 2)
    assert.deepEqual((await rows()).map((r) => r.state).sort(), ['settled', 'unknown'])
  }))

test('known terminal usage still commits after cancellation during settlement', () =>
  fixture('settle-abort', async (options, rows) => {
    const abort = new AbortController()
    const finished = barrier()
    const original = db.transaction.bind(db)
    let transactions = 0
    let calls = 0
    options.signal = abort.signal
    db.transaction = async (transaction, config) => {
      const which = ++transactions
      if (which === 2) abort.abort(new Error('private-abort-after-known'))
      try {
        return await original(transaction, config)
      } finally {
        if (which === 2) finished.resolve()
      }
    }
    globalThis.fetch = async () => {
      calls++
      return response()
    }
    try {
      await assert.rejects(() => drain(options))
      await finished.promise
      const [row] = await rows()
      assert.equal(row.state, 'settled')
      assert.ok(row.ledger_id)
      assert.equal(calls, 1)
    } finally {
      db.transaction = original
    }
  }))

test('registry change after physical response retains uncertainty and does not retry', () =>
  fixture('response-rate', async (options, rows) => {
    const pricing = getModelPricing(definition.id)!
    const old = pricing.input
    let calls = 0
    globalThis.fetch = async () => {
      calls++
      pricing.input = old + 1
      return response()
    }
    try {
      await assert.rejects(() => drain(options))
      assert.equal(calls, 1)
      assert.equal((await rows())[0].state, 'unknown')
    } finally {
      pricing.input = old
    }
  }))

test('foreign observation and replayed callback cannot settle or send again', () =>
  fixture('foreign', async (options, rows) => {
    const { getProviderRuntimeContext } = await import('@/providers/runtime-context')
    let calls = 0
    globalThis.fetch = async () => {
      calls++
      return response()
    }
    const run = await runBudgetedCatalogProvider(options)
    const recorded = recordedBinding!
    const original = recorded.observeModelAttempt!
    const reader = run.stream.getReader()
    while (!(await reader.read()).done) {}
    reader.releaseLock()
    const before = JSON.stringify(await rows())
    await assert.rejects(
      () => original(Object.freeze({}) as any, { kind: 'unknown', reason: 'incomplete' }),
      { message: 'Budgeted catalogue model is unavailable.' }
    )
    const [reference, observation] = observedReferences.at(-1)!
    await assert.rejects(() => original(reference, observation), {
      message: 'Budgeted catalogue model is unavailable.',
    })
    assert.equal(JSON.stringify(await rows()), before)
    assert.equal(calls, 1)
    assert.equal(getProviderRuntimeContext(), undefined)
  }))

test('pre-cancelled run cannot reserve or send', () =>
  fixture('pre-cancel', async (options, rows) => {
    const abort = new AbortController()
    abort.abort()
    options.signal = abort.signal
    let calls = 0
    globalThis.fetch = async () => {
      calls++
      return response()
    }
    await assert.rejects(() => drain(options))
    assert.equal(calls, 0)
    assert.equal((await rows()).length, 0)
  }))

test('abort while real PostgreSQL reserve waits cannot create a late HTTP request', () =>
  fixture('lock-abort', async (options, rows) => {
    const locked = barrier()
    const release = barrier()
    const entered = barrier()
    const finished = barrier()
    const original = db.transaction.bind(db)
    const abort = new AbortController()
    options.signal = abort.signal
    const blocking = owner.transaction(async (tx) => {
      await tx.execute(
        sql`select id from memlia_chat_cost_window where id=${options.budget.windowId} for update`
      )
      locked.resolve()
      await release.promise
    })
    await locked.promise
    db.transaction = async (transaction, config) => {
      entered.resolve()
      try {
        return await original(transaction, config)
      } finally {
        finished.resolve()
      }
    }
    let calls = 0
    globalThis.fetch = async () => {
      calls++
      return response()
    }
    try {
      const pending = drain(options)
      await entered.promise
      abort.abort()
      await assert.rejects(() => pending)
      release.resolve()
      await blocking
      await finished.promise
      assert.equal(calls, 0)
      const [row] = await rows()
      assert.ok(row)
      assert.equal(row.ledger_id, null)
    } finally {
      release.resolve()
      await blocking
      db.transaction = original
    }
  }))

test('profile mismatch under the native window lock refuses without HTTP', () =>
  fixture('profile-mismatch', async (options, rows) => {
    await owner.execute(
      sql`update memlia_chat_cost_window set pricing_profile=null where id=${options.budget.windowId}`
    )
    let calls = 0
    globalThis.fetch = async () => {
      calls++
      return response()
    }
    await assert.rejects(() => drain(options))
    assert.equal(calls, 0)
    assert.equal((await rows()).length, 0)
  }))

test('malformed subject cannot rely on regexp coercion or trigger attribution SQL', () =>
  fixture('subject-shape', async (options, rows) => {
    Reflect.deleteProperty(options.principal, 'userId')
    options.principal.extra = 'not-a-subject'
    const original = db.select
    let reads = 0
    db.select = (...args: Parameters<typeof db.select>) => {
      reads++
      return original.apply(db, args)
    }
    try {
      await assert.rejects(() => drain(options))
      assert.equal(reads, 0)
      assert.equal((await rows()).length, 0)
    } finally {
      db.select = original
    }
  }))

test('duplicate server gate while first COMMIT acknowledgement waits cannot reserve twice', () =>
  fixture('duplicate-wait', async (options, rows) => {
    const reached = barrier()
    const release = barrier()
    const original = db.transaction.bind(db)
    let transactions = 0
    let calls = 0
    db.transaction = async (transaction, config) => {
      const value = await original(transaction, config)
      if (++transactions === 1) {
        reached.resolve()
        await release.promise
      }
      return value
    }
    globalThis.fetch = async () => {
      calls++
      return response()
    }
    const pending = drain(options)
    try {
      await reached.promise
      await assert.rejects(() => recordedBinding!.beforeModelTransport!(...begun!), {
        message: 'Budgeted catalogue model is unavailable.',
      })
      assert.equal((await rows()).length, 1)
    } finally {
      release.resolve()
      await pending
      db.transaction = original
    }
    assert.equal(calls, 1)
  }))
