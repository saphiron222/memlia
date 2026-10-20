// Copyright (c) 2026 Memlia. All rights reserved.
// Native request/route/auth boundary; only the pre-auth bucket storage is doubled.
import { afterAll, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { NextRequest } from 'next/server'
import type { RateLimitStorageAdapter } from '../../apps/sim/lib/core/rate-limiter/storage/adapter'

// No database/cache service or credential is used by these anonymous requests.
process.env.DATABASE_URL = 'postgres://fixture:fixture@127.0.0.1:9/fixture'
process.env.DATABASE_URL_WEB = process.env.DATABASE_URL
delete process.env.DATABASE_REPLICA_URL
delete process.env.DATABASE_REPLICA_URL_WEB
process.env.SIM_DB_ROLE = 'web'
process.env.DISABLE_AUTH = 'false'
process.env.AUTH_TRUSTED_PROXIES = ''
process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000'
process.env.BETTER_AUTH_URL = 'http://localhost:3000'
process.env.BETTER_AUTH_SECRET = Buffer.alloc(32).toString('hex') // Synthetic, never a service credential.
process.env.NEXT_PUBLIC_POSTHOG_ENABLED = 'false'
process.env.NEXT_TELEMETRY_DISABLED = '1'
delete process.env.REDIS_URL

const calls: string[] = []
const unexpectedStorageCall = async (): Promise<never> => { throw Error('unexpected_storage_call') }
const storage: RateLimitStorageAdapter = {
  async consumeTokens(key, tokens, config) {
    calls.push(key)
    expect(tokens).toBe(1)
    expect(config.maxTokens).toBe(600)
    return { allowed: true, tokensRemaining: 599, resetAt: new Date(0) }
  },
  consumeTokensAtomically: unexpectedStorageCall,
  getCooldownUntil: unexpectedStorageCall,
  setCooldownUntil: unexpectedStorageCall,
  getTokenStatus: unexpectedStorageCall,
  resetBucket: unexpectedStorageCall,
}
const { setStorageAdapter } = await import('../../apps/sim/lib/core/rate-limiter/storage/factory')
setStorageAdapter(storage)
const { dispatchInProcessV2Request, matchV2Route } = await import('../../apps/sim/lib/api/server/routes/in-process-transport')
const { v2GetFileContract } = await import('../../apps/sim/lib/api/contracts/v2/files')
const { NextRequest: NativeRequest } = await import('next/server')

// Evaluate the existing fixture function verbatim, rather than a second request builder.
const source = readFileSync(new URL('./excel-file-workflow.ts', import.meta.url), 'utf8')
const match = source.match(/^    async function request\([\s\S]*?^    }$/m)
if (!match) throw Error('fixture_request_not_found')
const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(match[0])
type Dispatch = (request: NextRequest) => Promise<Response | undefined>
type Request = (path: string, method?: string, body?: unknown, credential?: string | null) => Promise<Response>
function fixtureRequest(dispatch: Dispatch): Request {
  return new Function('NextRequest', 'dispatchInProcessV2Request', 'key', 'assertRecipe',
    code + '\nreturn request;')(NativeRequest, dispatch, null, (value: unknown) => {
      if (!value) throw Error('fixture_response_missing')
    })
}

test('the real anonymous fixture request reaches native authentication and remains 401', async () => {
  calls.length = 0
  const response = await fixtureRequest(dispatchInProcessV2Request)('/api/v2/files', 'POST', {}, null)
  expect(response.status).toBe(401)
  expect(calls).toEqual(['v2:preauth:ip:192.0.2.10'])
})

for (const ip of [null, 'not-an-ip']) {
  test(`native pre-auth still rejects ${ip === null ? 'missing' : 'invalid'} IP before storage`, async () => {
    calls.length = 0
    const response = await fixtureRequest(async request => {
      if (ip === null) request.headers.delete('x-forwarded-for')
      else request.headers.set('x-forwarded-for', ip)
      return dispatchInProcessV2Request(request)
    })('/api/v2/files', 'POST', {}, null)
    expect(response.status).toBe(429)
    expect(calls).toEqual([])
  })
}


test('the fixture source readback selects the native scoped JSON metadata contract', () => {
  // Evaluate the URL expression actually consumed by data(), not a second route builder.
  const readback = source.match(/^    const original = await data\((.+)\)$/m)
  if (!readback) throw Error('fixture_metadata_readback_not_found')
  const uploaded = { id: '00000000-0000-4000-8000-000000000001' }
  const own = { id: '00000000-0000-4000-8000-000000000002' }
  const path = new Function('uploaded', 'own', 'return ' + readback[1])(uploaded, own)
  const url = new URL(path, 'http://localhost:3000')
  const route = matchV2Route(url.pathname)
  expect(route?.pattern).toBe('/api/v2/files/{fileId}/metadata')
  expect(route?.params).toEqual({ fileId: uploaded.id })
  expect(v2GetFileContract.method).toBe('GET')
  expect(v2GetFileContract.response.mode).toBe('json')
  expect(v2GetFileContract.query.parse(Object.fromEntries(url.searchParams))).toEqual({
    workspaceId: own.id, scope: 'active',
  })
  expect(v2GetFileContract.query.safeParse({}).success).toBe(false)
})


test('recipe cleanup disposes the native MCP channels loaded by workspace lifecycle', async () => {
  // REDIS_URL is absent: the native channel uses its synchronous EventEmitter fallback.
  // This verifies disposal, not Redis transport or the historical process exit deadline.
  const { mcpPubSub } = await import('../../apps/sim/lib/mcp/pubsub')
  const { closeApplicationConnections } = await import('./excel-file-workflow')
  if (!mcpPubSub) throw Error('native_mcp_channel_missing')
  let toolsReceived = 0, workflowsReceived = 0
  const unsubscribeTools = mcpPubSub.onToolsChanged(() => { toolsReceived += 1 })
  const unsubscribeWorkflows = mcpPubSub.onWorkflowToolsChanged(() => { workflowsReceived += 1 })
  const toolsEvent = { serverId: 'synthetic-excel-ci', serverName: 'Fixture',
    workspaceId: 'synthetic-excel-ci', timestamp: 0 }
  const workflowsEvent = { serverId: 'synthetic-excel-ci', workspaceId: 'synthetic-excel-ci' }
  try {
    mcpPubSub.publishToolsChanged(toolsEvent)
    mcpPubSub.publishWorkflowToolsChanged(workflowsEvent)
    expect(toolsReceived).toBe(1)
    expect(workflowsReceived).toBe(1)
    await closeApplicationConnections()
    mcpPubSub.publishToolsChanged(toolsEvent)
    mcpPubSub.publishWorkflowToolsChanged(workflowsEvent)
    expect(toolsReceived).toBe(1)
    expect(workflowsReceived).toBe(1)
  } finally { unsubscribeTools(); unsubscribeWorkflows() }
})

afterAll(async () => {
  const { db } = await import('../../packages/db/index')
  await db.$client.end({ timeout: 2 })
})

test('cleanup diagnostics project only a fixed stage, bounded index and SQLSTATE', async () => {
  const { cleanupFailureReceipt } = await import('./linux-chat-fixture')
  const error = Object.assign(Error('PRIVATE_CANARY message'), {
    code: '23503', query: 'PRIVATE_CANARY SQL', detail: 'PRIVATE_CANARY DSN',
  })
  expect(cleanupFailureReceipt('baseline_compare', 182, error)).toEqual({
    status: 'failed', code: 'fixture_cleanup_refused', stage: 'baseline_compare',
    index: 182, sqlstate: '23503',
  })
  for (const code of ['private_canary', '23503\n', '2350', 23503, true, null]) {
    const receipt = cleanupFailureReceipt('PRIVATE_CANARY', true, { code })
    expect(receipt).toEqual({ status: 'failed', code: 'fixture_cleanup_refused',
      stage: 'unknown', index: null, sqlstate: null })
    expect(JSON.stringify(receipt)).not.toContain('PRIVATE_CANARY')
  }
  let read = false
  const accessor = Object.defineProperty({}, 'code', { get() { read = true; return '23503' } })
  expect(cleanupFailureReceipt('native_account_deletion', 0, accessor).sqlstate).toBeNull()
  expect(read).toBe(false)
  for (const index of [-1, 183, 1.5, true, null]) {
    expect(cleanupFailureReceipt('baseline_compare', index, error).index).toBeNull()
  }
  expect(cleanupFailureReceipt('native_account_deletion', 1, error).index).toBeNull()
})

test('the real final catch persists the first closed cleanup failure without raw errors', async () => {
  // Execute the actual catch callback; file/process/console effects alone are doubles.
  const { cleanupFailureReceipt } = await import('./linux-chat-fixture')
  const fixtureSource = readFileSync(new URL('./linux-chat-fixture.ts', import.meta.url), 'utf8')
  const finalCatch = fixtureSource.match(/await main\(\)\.catch\(([\s\S]*)\)\s*$/)
  if (!finalCatch) throw Error('fixture_catch_not_found')
  const callback = new Bun.Transpiler({ loader: 'ts' }).transformSync('const callback = ' + finalCatch[1])
  const writes: unknown[][] = [], messages: unknown[] = []
  const processDouble = { argv: ['bun', 'fixture', 'cleanup'], exitCode: 0 }
  const first = cleanupFailureReceipt('baseline_compare', 12, { code: '23503' })
  const invoke = new Function('process', 'console', 'writeFileSync', 'cleanupFailureReceipt',
    'cleanupStage', 'cleanupIndex', 'cleanupFailure', callback + '\nreturn callback;')(
      processDouble, { error(value: unknown) { messages.push(value) } },
      (...args: unknown[]) => writes.push(args), cleanupFailureReceipt,
      'database_connection_close', null, first)
  invoke(Object.assign(Error('PRIVATE_CANARY'), { code: '08006' }))
  expect(processDouble.exitCode).toBe(1)
  expect(writes).toHaveLength(1)
  expect(writes[0][0]).toBe('/scratch/ui/cleanup-failure.private.json')
  expect(JSON.parse(String(writes[0][1]))).toEqual(first)
  expect(writes[0][2]).toEqual({ mode: 0o600, flag: 'wx' })
  expect(messages).toEqual(['fixture_refused'])
  expect(JSON.stringify([writes, messages])).not.toContain('PRIVATE_CANARY')
  // A pre-existing or unwritable receipt never changes the original refusal to success.
  const blocked = new Function('process', 'console', 'writeFileSync', 'cleanupFailureReceipt',
    'cleanupStage', 'cleanupIndex', 'cleanupFailure', callback + '\nreturn callback;')(
      processDouble, { error() {} }, () => { throw Error('PRIVATE_CANARY') },
      cleanupFailureReceipt, 'preflight', null, undefined)
  expect(() => blocked(Error('PRIVATE_CANARY'))).not.toThrow()
  expect(processDouble.exitCode).toBe(1)
  processDouble.argv[2] = 'seed'
  writes.length = 0
  invoke(Error('PRIVATE_CANARY'))
  expect(writes).toHaveLength(0)
})

test('the real nested connection close preserves its first failure before the database finally', async () => {
  const { cleanupFailureReceipt } = await import('./linux-chat-fixture')
  const fixtureSource = readFileSync(new URL('./linux-chat-fixture.ts', import.meta.url), 'utf8')
  const blocks = [...fixtureSource.matchAll(/^    } finally \{[\s\S]*?^    }$/gm)]
  const closing = blocks.at(-1)?.[0]
  if (!closing?.includes('closeImportedClients')) throw Error('fixture_closing_not_found')
  const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(
    'async function invoke() { try {} ' + closing.replace(/^\s*}/, '') + '\n}')
  for (const secondaryFailure of [false, true]) {
    for (const first of [undefined, cleanupFailureReceipt('baseline_compare', 2, { code: '23514' })]) {
    const expected = Object.assign(Error('PRIVATE_CANARY first'), { code: '08006' })
    const secondary = Object.assign(Error('PRIVATE_CANARY secondary'), { code: '08003' })
    const scope = new Function('process', 'cleanupFailureReceipt', 'closeImportedClients', 'sql',
      'importedDeletion', 'cleanupStage', 'cleanupIndex', 'cleanupFailure',
      code + '\nreturn { invoke, failure: () => cleanupFailure };')(
        { argv: ['bun', 'fixture', 'cleanup'] }, cleanupFailureReceipt,
        async () => { throw expected }, { async end() { if (secondaryFailure) throw secondary } },
        true, 'proof_write', null, first)
    await expect(scope.invoke()).rejects.toBe(secondaryFailure ? secondary : expected)
    expect(scope.failure()).toEqual(first ?? { status: 'failed', code: 'fixture_cleanup_refused',
      stage: 'application_connections_close', index: null, sqlstate: '08006' })
    }
  }
})
