// Copyright (c) 2026 Memlia. All rights reserved.
// Native request/route/auth boundary; only the pre-auth bucket storage is doubled.
import { afterAll, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { NextRequest } from 'next/server'
import type { RateLimitStorageAdapter } from '../../apps/sim/lib/core/rate-limiter/storage/adapter'
import { durableDraftFromProcedure, durableFixtureMode, observeDurableCompletion, retireOwnedRun, verifyTransportIsolation } from './excel-file-workflow'
import { fixtures } from '../../packages/memlia-contracts/tests/fixtures'
import { candidateTableNames, fixtureSourceRoot, verifyCandidateCatalog } from './linux-chat-fixture'
import { pgTable, text } from 'drizzle-orm/pg-core'
import { createClientIpResolver } from '../../packages/security/src/ip'

test('transport isolation resolves the business table under web and checks the OID without schema usage', async () => {
  const calls: { side: string; text: string; values: unknown[] }[] = []
  const db = { $client: async (parts: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ side: 'web', text: parts.join('?'), values }); return [{ oid: '1234' }]
  } }
  const queue = async (parts: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ side: 'transport', text: parts.join('?'), values })
    return [{ role: 'owned_transport', ddl: false, business_usage: false, business_read: false }]
  }
  await verifyTransportIsolation(db as never, queue as never, 'owned_transport')
  expect(calls.map(row => row.side)).toEqual(['web', 'transport'])
  expect(calls[0].text).toContain("n.nspname='public'")
  expect(calls[0].text).toContain("c.relname='user'")
  expect(calls[1].text).toContain('has_table_privilege(current_user,?::oid')
  expect(calls[1].text).not.toContain('public.user')
  expect(calls[1].values).toEqual(['1234'])
  expect(calls.some(row => /GRANT|ALTER|CREATE\s+ROLE/.test(row.text))).toBe(false)
})
test('transport isolation refuses a missing table, foreign role or any business access', async () => {
  let queried = false
  await expect(verifyTransportIsolation({ $client: async () => [] } as never,
    (async () => { queried = true }) as never, 'owned_transport')).rejects.toThrow('excel_application_refused')
  expect(queried).toBe(false)
  const db = { $client: async () => [{ oid: '1234' }] }
  for (const delta of [{ role: 'foreign' }, { ddl: true }, { business_usage: true }, { business_read: true }])
    await expect(verifyTransportIsolation(db as never, (async () => [{ role: 'owned_transport', ddl: false,
      business_usage: false, business_read: false, ...delta }]) as never, 'owned_transport'))
      .rejects.toThrow('excel_application_refused')
})

test('durable loopback HTTPS fixture buckets match the native forwarded-address policy', () => {
  const resolver = createClientIpResolver('')
  expect(resolver.resolve(new Headers({ 'x-forwarded-for': '127.0.0.1' }))).toBe('127.0.0.1')
  expect(resolver.resolve(new Headers({ 'x-forwarded-for': '::ffff:127.0.0.1' }))).toBe('127.0.0.1')
  expect(createClientIpResolver('127.0.0.1').resolve(new Headers({ 'x-forwarded-for': '127.0.0.1' }))).toBeNull()
})

test('durable fixture source root is fixed to the image, never a caller-selected module path', () => {
  expect(fixtureSourceRoot(undefined)).toBe('/work')
  expect(fixtureSourceRoot('/app')).toBe('/app')
  for (const root of ['/work', '/app/', '/app\n', '/tmp/foreign', 'file:///app'])
    expect(() => fixtureSourceRoot(root)).toThrow('fixture_source_refused')
})
test('candidate catalog matches all native schema table names and every migration hash', () => {
  const table = pgTable('native_owned', { id: text('id') })
  const names = candidateTableNames({ table, ignored: 'not a table' })
  expect(names).toEqual(['native_owned', 'script_migrations'])
  const migrations = [{ hash: 'a'.repeat(64), folderMillis: 1 }, { hash: 'b'.repeat(64), folderMillis: 2 }]
  const rows = migrations.map(row => ({ hash: row.hash, created_at: String(row.folderMillis) }))
  expect(verifyCandidateCatalog(names, names, migrations, rows)).toBe(true)
  for (const actual of [['native_owned'], [...names, 'foreign_table'], ['foreign_table', 'script_migrations']])
    expect(() => verifyCandidateCatalog(names, actual, migrations, rows)).toThrow('fixture_catalog_refused')
  for (const actual of [rows.slice(1), [...rows, rows[0]], [rows[0], { ...rows[1], hash: 'c'.repeat(64) }],
    [rows[0], { ...rows[1], created_at: '3' }]])
    expect(() => verifyCandidateCatalog(names, names, migrations, actual)).toThrow('fixture_catalog_refused')
  expect(() => candidateTableNames({ table, alias: table })).toThrow('fixture_catalog_refused')
})
test('candidate table oracle agrees with the committed Drizzle snapshot and native script ledger', async () => {
  const schema = await import('../../packages/db/schema')
  const journal = JSON.parse(readFileSync(new URL('../../packages/db/migrations/meta/_journal.json', import.meta.url), 'utf8'))
  const prefix = journal.entries.at(-1).tag.split('_')[0]
  const snapshot = JSON.parse(readFileSync(new URL('../../packages/db/migrations/meta/' + prefix + '_snapshot.json', import.meta.url), 'utf8'))
  const expected = [...Object.keys(snapshot.tables).map(name => name.replace(/^public\./, '')), 'script_migrations'].sort()
  expect(candidateTableNames(schema)).toEqual(expected)
  expect(expected.length).toBeGreaterThanOrEqual(183)
})

test('durable fixture accepts only preparation and readback phases; it cannot select an inline runner', () => {
  for (const name of ['durable-prepare', 'durable-publish', 'durable-readback', 'durable-retire'])
    expect(durableFixtureMode(name)).toBe(name)
  for (const name of ['inline', 'execute', 'durable', '../foreign'])
    expect(() => durableFixtureMode(name)).toThrow('excel_application_refused')
})
test('native publication draft strips server identity and retains the canonical generic operations', async () => {
  const full = structuredClone(fixtures.ExcelProcedure)
  const draft = await durableDraftFromProcedure(full)
  expect(draft.operations).toEqual(full.operations)
  expect(draft.inputs).toEqual(full.inputs)
  for (const key of ['ownerUserId', 'deployedVersionId', 'digest', 'procedureId', 'version', 'workspaceId'])
    expect(Object.hasOwn(draft, key)).toBe(false)
  await expect(durableDraftFromProcedure({ ownerUserId: 'PRIVATE_CANARY' })).rejects.toThrow()
})

test('retirement locks exact native terminal job and completed outbox before any owned deletion', async () => {
  const statements: { text: string; values: unknown[] }[] = []
  const tx = async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const text = parts.join('?'); statements.push({ text, values })
    if (text.includes('FROM async_jobs j')) return [{ id: 'workflow-execution:run', version: 'j1', digest: 'jd',
      event_id: 'event', event_version: 'e1', event_digest: 'ed' }]
    if (text.includes('SELECT l.id')) return [{ log_id: 'log', log_version: 'l1', log_digest: 'ld',
      snapshot_id: 'snap', snapshot_version: 's1', snapshot_digest: 'sd', claim_key: 'workflow-execution-id:run',
      claim_version: 'k1', claim_digest: 'kd' }]
    return [{ id: 'owned' }]
  }
  const db = { $client: { begin: async (body: (tx: unknown) => Promise<void>) => body(tx) } }
  await retireOwnedRun(db as never, { runId: 'run' }, { id: 'flow' }, { id: 'space' }, 'user', 'workflow-execution:run')
  expect(statements[0].text).toContain("e.status='completed'")
  expect(statements[0].text).toContain('FOR UPDATE OF j,e')
  expect(statements[0].values).toEqual(['workflow-execution:run', 'run', 'flow', 'space', 'user'])
  expect(statements.filter(s => s.text.includes('DELETE FROM')).every(s => s.text.includes('xmin::text'))).toBe(true)
  expect(statements.some(s => /INSERT|UPDATE async_jobs|CREATE/.test(s.text))).toBe(false)
  statements.length = 0
  await expect(retireOwnedRun(db as never, { runId: 'run' }, { id: 'flow' }, { id: 'space' }, 'user', 'foreign'))
    .rejects.toThrow('excel_application_refused')
  expect(statements).toEqual([])
})

// No database/cache service or credential is used by these anonymous requests.
function clearFixtureEnvironment(name: string) {
  if (!Reflect.deleteProperty(process.env, name)) throw new TypeError('fixture_environment_delete_refused')
}
process.env.DATABASE_URL = 'postgres://fixture:fixture@127.0.0.1:9/fixture'
process.env.DATABASE_URL_WEB = process.env.DATABASE_URL
clearFixtureEnvironment('DATABASE_REPLICA_URL')
clearFixtureEnvironment('DATABASE_REPLICA_URL_WEB')
process.env.SIM_DB_ROLE = 'web'
process.env.DISABLE_AUTH = 'false'
process.env.AUTH_TRUSTED_PROXIES = ''
process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000'
process.env.BETTER_AUTH_URL = 'http://localhost:3000'
process.env.BETTER_AUTH_SECRET = Buffer.alloc(32).toString('hex') // Synthetic, never a service credential.
process.env.NEXT_PUBLIC_POSTHOG_ENABLED = 'false'
process.env.NEXT_TELEMETRY_DISABLED = '1'
clearFixtureEnvironment('REDIS_URL')

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
  let toolsReceived = 0
  let workflowsReceived = 0
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
  const writes: unknown[][] = []
  const messages: unknown[] = []
  const processDouble = { argv: ['bun', 'fixture', 'cleanup'], exitCode: 0 }
  const first = cleanupFailureReceipt('baseline_compare', 12, { code: '23503' })
  const invoke = new Function('process', 'console', 'writeFileSync', 'cleanupFailureReceipt',
    'cleanupStage', 'cleanupIndex', 'cleanupFailure', callback + '\nreturn callback;')(
      processDouble, { error(value: unknown) { messages.push(value) } },
      (...args: unknown[]) => writes.push(args), cleanupFailureReceipt,
      'database_connection_close', null, first)
  invoke(Object.assign(Error('PRIVATE_CANARY'), { code: '08006' }))
  expect(processDouble.exitCode).toBe(1)
  expect(writes).toHaveLength(2)
  expect(writes[0][0]).toBe('/scratch/ui/native-failure.private.txt')
  expect(String(writes[0][1])).toContain('PRIVATE_CANARY')
  expect(writes[0][2]).toEqual({ mode: 0o600, flag: 'wx' })
  expect(writes[1][0]).toBe('/scratch/ui/cleanup-failure.private.json')
  expect(JSON.parse(String(writes[1][1]))).toEqual(first)
  expect(writes[1][2]).toEqual({ mode: 0o600, flag: 'wx' })
  expect(messages).toEqual(['fixture_refused'])
  expect(JSON.stringify([writes[1], messages])).not.toContain('PRIVATE_CANARY')
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
  expect(writes).toHaveLength(1)
  expect(writes[0][0]).toBe('/scratch/ui/native-failure.private.txt')
})

test('the real nested connection close preserves its first failure before the database finally', async () => {
  const { cleanupFailureReceipt } = await import('./linux-chat-fixture')
  const fixtureSource = readFileSync(new URL('./linux-chat-fixture.ts', import.meta.url), 'utf8')
  const blocks = [...fixtureSource.matchAll(/^    } finally \{[\s\S]*?^    }$/gm)]
  const closing = blocks.at(-1)?.[0]
  const helper = fixtureSource.match(/^ {4}async function closeOwnedConnections\(\) \{[\s\S]*?^ {4}}$/m)?.[0]
  if (!closing?.includes('await closeOwnedConnections()') || !helper?.includes('closeImportedClients'))
    throw Error('fixture_closing_not_found')
  const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(
    helper + '\nasync function invoke() { try {} ' + closing.replace(/^\s*}/, '') + '\n}')
  for (const secondaryFailure of [false, true]) {
    for (const first of [undefined, cleanupFailureReceipt('baseline_compare', 2, { code: '23514' })]) {
    const expected = Object.assign(Error('PRIVATE_CANARY first'), { code: '08006' })
    const secondary = Object.assign(Error('PRIVATE_CANARY secondary'), { code: '08003' })
    const scope = new Function('process', 'cleanupFailureReceipt', 'closeImportedClients', 'sql',
      'importedDeletion', 'cleanupStage', 'cleanupIndex', 'cleanupFailure', 'cleanupTableCount',
      code + '\nreturn { invoke, failure: () => cleanupFailure };')(
        { argv: ['bun', 'fixture', 'cleanup'] }, cleanupFailureReceipt,
        async () => { throw expected }, { async end() { if (secondaryFailure) throw secondary } },
        true, 'proof_write', null, first, 183)
    await expect(scope.invoke()).rejects.toBe(secondaryFailure ? secondary : expected)
    expect(scope.failure()).toEqual(first ?? { status: 'failed', code: 'fixture_cleanup_refused',
      stage: 'application_connections_close', index: null, sqlstate: '08006' })
    }
  }
})

function ownedSearchQueueFragments() {
  const text = readFileSync(new URL('./linux-chat-fixture.ts', import.meta.url), 'utf8')
  const captureStart = text.indexOf('        const searchQueue =')
  const captureEnd = text.indexOf('        const audit =', captureStart)
  const purgeStart = text.indexOf('          for (const row of searchQueue) {')
  const purgeEnd = text.indexOf("          cleanupStage = 'baseline_compare'", purgeStart)
  if (captureStart < 0 || captureEnd < 0 || purgeStart < 0 || purgeEnd < 0)
    throw Error('owned_search_queue_fragments_missing')
  const transpiler = new Bun.Transpiler({ loader: 'ts' })
  const capture = transpiler.transformSync('async function invoke() {\n' +
    text.slice(captureStart, captureEnd) + '\nreturn searchQueue;\n}')
  const purge = transpiler.transformSync('async function invoke() { let deleted = 0;\n' +
    text.slice(purgeStart, purgeEnd) + '\nreturn deleted;\n}')
  const assertRecipe = (value: unknown) => { if (!value) throw Error('owned_fixture_cleanup_refused') }
  return { capture, purge, assertRecipe }
}

test('owned search queue capture accepts only fresh undispatched rows of the captured fixture scopes', async () => {
  // Execute the fixture fragments verbatim. The SQL boundary is doubled here;
  // these tests do not qualify PostgreSQL triggers, ownership or CAS execution.
  const { capture, assertRecipe } = ownedSearchQueueFragments()
  const workspaceIds = ['owned-workspace']
  const projectIds = ['owned-project']
  const row = { entityType: 'workspace', entityId: workspaceIds[0], digest: 'a'.repeat(32),
    version: '42', fresh: true, undispatched: true, ownerAbsent: true }
  const execute = (rows: unknown[]) => new Function('sql', 'workspaceIds', 'projectIds', 'start',
    'assertRecipe', capture + '\nreturn invoke();')(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const query = strings.join('?')
        expect(query).toContain('FROM file_search_dispatch_queue t')
        expect(query).toContain("t.entity_type='workspace' AND t.entity_id=ANY(")
        expect(query).toContain("t.entity_type='project' AND t.entity_id=ANY(")
        expect(query).toContain('t.last_dispatched_at IS NULL')
        expect(query).toContain('t.enqueued_at>=')
        expect(query).toContain('t.updated_at>=')
        expect(query).toContain('clock_timestamp()')
        expect(query).toContain('NOT EXISTS')
        expect(query).toContain('LIMIT 17')
        expect(values).toContain(workspaceIds)
        expect(values).toContain(projectIds)
        return rows
      }, workspaceIds, projectIds, '2026-10-20T00:00:00Z', assertRecipe)
  await expect(execute([])).resolves.toEqual([])
  await expect(execute([row, { ...row, entityType: 'project', entityId: projectIds[0] }]))
    .resolves.toHaveLength(2)
  for (const change of [
    { entityType: 'other' }, { entityType: 'project' }, { entityId: 'unowned-workspace' },
    { fresh: false }, { undispatched: false }, { ownerAbsent: false },
    { digest: 'not-a-digest' }, { version: '42 OR true' },
  ]) await expect(execute([{ ...row, ...change }])).rejects.toThrow('owned_fixture_cleanup_refused')
  await expect(execute([row, row])).rejects.toThrow('owned_fixture_cleanup_refused')
  await expect(execute(Array(17).fill(row))).rejects.toThrow('owned_fixture_cleanup_refused')
})

test('owned search queue purge requires the exact composite identity and version before the unchanged baseline', async () => {
  const { purge, assertRecipe } = ownedSearchQueueFragments()
  const row = { entityType: 'workspace', entityId: 'owned-workspace', digest: 'a'.repeat(32), version: '42' }
  const start = '2026-10-20T00:00:00Z'
  const execute = (returned: unknown[]) => new Function('tx', 'searchQueue', 'start',
    'assertRecipe', purge + '\nreturn invoke();')(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const query = strings.join('?')
        expect(query).toContain('DELETE FROM file_search_dispatch_queue t')
        expect(query).toContain('t.entity_type=')
        expect(query).toContain('t.entity_id=')
        expect(query).toContain('md5(row_to_json(t)::text)=')
        expect(query).toContain('t.xmin::text=')
        expect(query).toContain('t.last_dispatched_at IS NULL')
        expect(query).toContain('t.enqueued_at>=')
        expect(query).toContain('t.updated_at>=')
        expect(query).toContain('NOT EXISTS')
        expect(query).toContain('FROM workspace')
        expect(query).toContain('FROM project')
        expect(values).toEqual([row.entityType, row.entityId, row.digest, row.version, start, start])
        return returned
      }, [row], start, assertRecipe)
  await expect(execute([{ entity_id: row.entityId }])).resolves.toBe(1)
  // Changed/missing/consumed rows refuse the whole cleanup transaction; never skip.
  await expect(execute([])).rejects.toThrow('owned_fixture_cleanup_refused')
  await expect(execute([{ entity_id: row.entityId }, { entity_id: row.entityId }]))
    .rejects.toThrow('owned_fixture_cleanup_refused')
})

test('inactive fixture binds the raw preparation and derives only an expected queue identity', async () => {
  const { captureInactiveTestSubmission } = await import('./excel-file-workflow')
  const binding = { workspaceId: 'space', preparation: { expectedRevision: 7, expectedStateDigest: 'sha256:' + 'a'.repeat(64), operationId: 'owned-op' }, prepared: { status: 'prepared_for_test', workflowId: 'flow', deploymentVersionId: 'inactive', version: 1, snapshotDigest: 'sha256:' + 'b'.repeat(64), executionAvailable: false, activationAvailable: false } }
  const value = { status: 'passed', scope: 'native_session_inactive_test_submission', authenticated: true, preparedForTest: true, queued: true, browserClosed: true, activationRequested: false, workflowId: 'flow', workspaceId: 'space', deploymentVersionId: 'inactive', executionId: 'run', snapshotDigest: binding.prepared.snapshotDigest, jobId: 'workflow-execution:run', jobIdSource: 'derived_expected', inactiveTest: binding }
  expect(await captureInactiveTestSubmission(value, 'flow', 'space')).toEqual(binding)
  for (const delta of [{ jobIdSource: 'observed' }, { jobId: 'foreign' }, { activationRequested: true }, { deploymentVersionId: 'foreign' }, { workspaceId: 'foreign' }, { deployed: true }, { executionId: 'run\n', jobId: 'workflow-execution:run\n' }])
    await expect(captureInactiveTestSubmission({ ...value, ...delta }, 'flow', 'space')).rejects.toThrow('excel_application_refused')
})

test('inactive observation requires exact human payload, snapshot digest, inactive version and journal pin', async () => {
  const { assertInactiveJobPayload, verifyInactiveVersionObservation } = await import('./excel-file-workflow')
  const { normalizedStringify } = await import('../../apps/sim/lib/workflows/comparison/normalize')
  const { createHash } = await import('node:crypto')
  const state = { blocks: { excel: { id: 'excel', type: 'memlia_excel' } }, edges: [], variables: {} }
  const hash = 'sha256:' + createHash('sha256').update(normalizedStringify(state)).digest('hex')
  const binding = { workspaceId: 'space', preparation: { expectedRevision: 7, expectedStateDigest: 'sha256:' + 'a'.repeat(64), operationId: 'owned-op' }, prepared: { status: 'prepared_for_test' as const, workflowId: 'flow', deploymentVersionId: 'inactive', version: 1, snapshotDigest: hash, executionAvailable: false as const, activationAvailable: false as const } }
  const payload = { workflowId: 'flow', workspaceId: 'space', executionId: 'run', userId: 'user', principal: { principal: { kind: 'session', userId: 'user', sessionId: 'session' } }, executionMode: 'async', admissionCompleted: true, enforceCredentialAccess: true, isPublicApiAccess: false, excelTestExecution: binding }
  await assertInactiveJobPayload(payload, binding, 'run', 'user')
  for (const delta of [{ userId: 'foreign' }, { executionId: 'foreign' }, { excelTestExecution: { ...binding, workspaceId: 'foreign' } }, { enforceCredentialAccess: false }, { isPublicApiAccess: true }, { excelTestExecution: undefined }])
    await expect(assertInactiveJobPayload({ ...payload, ...delta }, binding, 'run', 'user')).rejects.toThrow('excel_application_refused')
  const row = { id: 'inactive', version: 1, workflow_id: 'flow', workspace_id: 'space', created_by: 'user', preparation_kind: 'excel_test_v1', is_active: false, snapshot_digest: hash, state }
  await verifyInactiveVersionObservation([row], binding, 'user')
  for (const delta of [{ is_active: true }, { version: 2 }, { created_by: 'foreign' }, { snapshot_digest: 'sha256:' + 'c'.repeat(64) }, { state: { blocks: {} } }, { preparation_kind: null }])
    await expect(verifyInactiveVersionObservation([{ ...row, ...delta }], binding, 'user')).rejects.toThrow('excel_application_refused')
})

async function inactiveRetirementFixture() {
  const { createHash } = await import('node:crypto')
  const { normalizedStringify } = await import('../../apps/sim/lib/workflows/comparison/normalize')
  const hash = (value: unknown) => 'sha256:' + createHash('sha256').update(normalizedStringify(value)).digest('hex')
  const state = { blocks: { excel: { id: 'excel', type: 'memlia_excel' } }, edges: [] }
  const binding = { workspaceId: 'space', preparation: { expectedRevision: 7, expectedStateDigest: 'sha256:' + 'a'.repeat(64), operationId: 'owned-op' }, prepared: { status: 'prepared_for_test' as const, workflowId: 'flow', deploymentVersionId: 'inactive', version: 1, snapshotDigest: hash(state), executionAvailable: false as const, activationAvailable: false as const } }
  const scope = { workflowId: 'flow', workspaceId: 'space', organizationId: null }
  const key = 'excel-test-preparation:' + hash({ scope, actorId: 'user' }) + ':owned-op'
  const fingerprint = hash({ scope, actorId: 'user', ...binding.preparation, policyVersion: 'memlia_excel_test_admission_v1' })
  const result = { status: 'completed', requestFingerprint: fingerprint, result: binding.prepared }
  const payload = { workflowId: 'flow', workspaceId: 'space', executionId: 'run', userId: 'user', principal: { principal: { kind: 'session', userId: 'user', sessionId: 'session' } }, executionMode: 'async', admissionCompleted: true, enforceCredentialAccess: true, isPublicApiAccess: false, excelTestExecution: binding }
  return { binding, key, fingerprint, result, payload, preparationRow: { id: 'inactive', version: 1, workflow_id: 'flow', workspace_id: 'space', created_by: 'user', preparation_kind: 'excel_test_v1', is_active: false, snapshot_digest: hash(state), state, preparation_key: key, preparation_version: 'p1', preparation_digest: 'pd', result } }
}
test('inactive retirement derives the native namespace and fingerprint for only this actor and operation', async () => {
  const { inactivePreparationIdentity } = await import('./excel-file-workflow')
  const f = await inactiveRetirementFixture()
  expect(await inactivePreparationIdentity(f.binding, 'user')).toEqual({ key: f.key, fingerprint: f.fingerprint, result: f.result })
  expect((await inactivePreparationIdentity(f.binding, 'foreign')).key).not.toBe(f.key)
  expect((await inactivePreparationIdentity({ ...f.binding, preparation: { ...f.binding.preparation, operationId: 'other' } }, 'user')).key).not.toBe(f.key)
})
test('inactive retirement locks completed exact preparation/version and CAS-deletes its one key in the same transaction', async () => {
  const f = await inactiveRetirementFixture()
  const statements: { text: string; values: unknown[] }[] = []
  const captures: string[] = []
  const tx = async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const text = parts.join('?'); statements.push({ text, values })
    if (text.includes('FROM async_jobs j')) return [{ id: 'workflow-execution:run', version: 'j1', digest: 'jd', event_id: 'event', event_version: 'e1', event_digest: 'ed', payload: f.payload }]
    if (text.includes('SELECT l.id')) return [{ log_id: 'log', log_version: 'l1', log_digest: 'ld', snapshot_id: 'snap', snapshot_version: 's1', snapshot_digest: 'sd', claim_key: 'workflow-execution-id:run', claim_version: 'k1', claim_digest: 'kd', deployment_version_id: 'inactive' }]
    if (text.includes('SELECT k.key AS preparation_key')) return [f.preparationRow]
    return [{ key: f.key, id: 'owned' }]
  }
  const db = { $client: { begin: async (body: (sql: unknown) => Promise<void>) => body(tx) } }
  await retireOwnedRun(db as never, { runId: 'run' }, { id: 'flow' }, { id: 'space' }, 'user', 'workflow-execution:run', { binding: f.binding, capture: (name: string) => captures.push(name) })
  const locked = statements.find(s => s.text.includes('SELECT k.key AS preparation_key'))!
  expect(locked.text).toContain('FOR UPDATE OF k,v,w')
  expect(locked.text).toContain("v.preparation_kind='excel_test_v1'")
  expect(locked.text).toContain('v.is_active=false')
  expect(locked.values).toContain(f.key)
  expect(locked.values).toContain(JSON.stringify(f.result))
  const deleted = statements.find(s => s.text.includes('DELETE FROM idempotency_key k') && s.values.includes(f.key))!
  expect(deleted.text).toContain('k.xmin::text=')
  expect(deleted.text).toContain('md5(row_to_json(k)::text)=')
  expect(deleted.values).toContain('p1')
  expect(deleted.values).toContain('pd')
  expect(deleted.text).not.toMatch(/LIKE|starts_with|left\(/)
  expect(captures).toEqual(['retire-job', 'retire-preparation'])
})
test('inactive retirement refuses ambiguous, stale or foreign preparation before any fixture deletion', async () => {
  const f = await inactiveRetirementFixture()
  for (const delta of [null, { result: { ...f.result, status: 'pending' } }, { result: { ...f.result, requestFingerprint: 'foreign' } }, { created_by: 'foreign' }, { version: 2 }, { is_active: true }, { state: {} }, { preparation_key: 'foreign' }]) {
    let deleted = false
    const tx = async (parts: TemplateStringsArray) => {
      const text = parts.join('?')
      if (text.includes('FROM async_jobs j')) return [{ id: 'workflow-execution:run', version: 'j1', digest: 'jd', event_id: 'event', event_version: 'e1', event_digest: 'ed', payload: f.payload }]
      if (text.includes('SELECT l.id')) return [{ deployment_version_id: 'inactive' }]
      if (text.includes('SELECT k.key AS preparation_key')) return delta === null ? [] : [{ ...f.preparationRow, ...delta }]
      if (text.includes('DELETE FROM')) deleted = true
      return [{ id: 'owned' }]
    }
    const db = { $client: { begin: async (body: (sql: unknown) => Promise<void>) => body(tx) } }
    await expect(retireOwnedRun(db as never, { runId: 'run' }, { id: 'flow' }, { id: 'space' }, 'user', 'workflow-execution:run', { binding: f.binding, capture: () => {} })).rejects.toThrow('excel_application_refused')
    expect(deleted).toBe(false)
  }
})

test('inactive retirement holds the owned run when the preparation CAS no longer matches', async () => {
  const f = await inactiveRetirementFixture()
  const deletes: string[] = []
  const tx = async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const text = parts.join('?')
    if (text.includes('FROM async_jobs j')) return [{ id: 'workflow-execution:run', version: 'j1', digest: 'jd', event_id: 'event', event_version: 'e1', event_digest: 'ed', payload: f.payload }]
    if (text.includes('SELECT l.id')) return [{ deployment_version_id: 'inactive' }]
    if (text.includes('SELECT k.key AS preparation_key')) return [f.preparationRow]
    if (text.includes('DELETE FROM')) { deletes.push(text); expect(values).toContain(f.key); return [] }
    return []
  }
  const db = { $client: { begin: async (body: (sql: unknown) => Promise<void>) => body(tx) } }
  await expect(retireOwnedRun(db as never, { runId: 'run' }, { id: 'flow' }, { id: 'space' }, 'user', 'workflow-execution:run', { binding: f.binding, capture: () => {} })).rejects.toThrow('excel_application_refused')
  expect(deletes).toHaveLength(1)
  expect(deletes[0]).toContain('DELETE FROM idempotency_key k')
  expect(deletes.some(text => text.includes('DELETE FROM workflow_execution_logs'))).toBe(false)
  // The SQL port is doubled: native PostgreSQL transactional rollback remains unqualified.
})

test('active readback binds the completed run to the browser-validated version, which must be the live one', async () => {
  const nonce = 'a'.repeat(32)
  const saved = { web: process.env.DATABASE_URL, queue: process.env.MEMLIA_PG_BOSS_DATABASE_URL, nonce: process.env.RECIPE_NONCE }
  process.env.DATABASE_URL = 'postgres://ui_web_' + nonce + ':x@database:5432/memlia_ui_' + nonce
  process.env.MEMLIA_PG_BOSS_DATABASE_URL = 'postgres://ui_transport_' + nonce + ':x@database:5432/memlia_ui_' + nonce
  process.env.RECIPE_NONCE = nonce
  const submission = { jobId: 'workflow-execution:run', executionId: 'run', deploymentVersionId: 'live-version' }
  const observe = async (logVersion: unknown, active: unknown[], value: Record<string, unknown> = submission) => {
    const versionReads: unknown[][] = []
    const db = { $client: async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const text = parts.join('?')
      if (text.includes('pg_catalog.pg_class')) return [{ oid: '1234' }]
      if (text.includes('FROM async_jobs')) return [{ id: submission.jobId, status: 'completed', attempts: 1, output: { success: true },
        payload: { executionId: 'run', workflowId: 'flow', workspaceId: 'space', userId: 'user', principal: { principal: { kind: 'session' } } } }]
      if (text.includes('FROM workflow_execution_logs')) return [{ execution_id: 'run', status: 'completed', deployment_version_id: logVersion }]
      if (text.includes('FROM workflow_deployment_version')) {
        expect(text).toContain('JOIN workflow w ON w.id=v.workflow_id')
        expect(text).toContain('w.workspace_id=?')
        expect(text).toContain('v.is_active=true')
        versionReads.push(values); return active
      }
      throw Error('unexpected ' + text)
    } }
    const queue = Object.assign(async (parts: TemplateStringsArray) => parts.join('?').includes('memlia_jobs.job')
      ? [{ id: 'delivery', state: 'completed' }]
      : [{ role: 'ui_transport_' + nonce, ddl: false, business_usage: false, business_read: false }], { end: async () => {} })
    const completion = await observeDurableCompletion(db as never, value as never, 'flow', 'space', 'user', undefined, () => {}, () => queue as never)
    expect(completion).toEqual({ journalDeploymentVersionId: logVersion })
    return versionReads
  }
  try {
    const live = { id: 'live-version', workflow_id: 'flow', workspace_id: 'space', is_active: true }
    expect(await observe('live-version', [live])).toEqual([['flow', 'space']])
    for (const [logVersion, active, value] of [
      ['other-version', [live], submission], [null, [live], submission],
      ['live-version', [], submission], ['live-version', [{ ...live, id: 'other-version' }], submission],
      ['live-version', [live, { ...live, id: 'second-live' }], submission], ['live-version', [{ ...live, is_active: false }], submission],
      ['live-version', [{ ...live, workspace_id: 'foreign' }], submission], ['live-version', [{ ...live, workflow_id: 'foreign' }], submission],
      ['live-version', [live], { ...submission, deploymentVersionId: undefined }], ['live-version', [live], { ...submission, deploymentVersionId: 'live-version\n' }],
    ] as const) await expect(observe(logVersion, [...active], value)).rejects.toThrow('excel_durable_version_unbound')
  } finally {
    for (const [key, value] of [['DATABASE_URL', saved.web], ['MEMLIA_PG_BOSS_DATABASE_URL', saved.queue], ['RECIPE_NONCE', saved.nonce]] as const)
      if (value === undefined) delete process.env[key]; else process.env[key] = value
  }
})

const OWNED_OUTBOX_SCOPE = {
  workspaceIds: ['owned-workspace'], projectIds: ['owned-project'], userId: 'owned-user',
  deployments: [{ operationId: 'owned-operation', workflowId: 'owned-workflow', deploymentVersionId: 'owned-version', generation: '1' }],
}
function preparationEvent(change: Record<string, unknown> = {}) {
  return { id: 'event-preparation', eventType: 'workflow.deployment.prepare.v2', status: 'completed', attempts: 0,
    unlocked: true, unprocessed: false, noError: true, fresh: true, processedInOrder: true,
    projectId: null, workspaceId: null, workflowId: 'owned-workflow', deploymentVersionId: 'owned-version',
    operationId: 'owned-operation', generation: '1', userId: 'owned-user', digest: 'b'.repeat(32), version: '7', ...change }
}
function erasureEvent(eventType: string, change: Record<string, unknown> = {}) {
  return { id: 'event-' + eventType, eventType, status: 'pending', attempts: 0, unlocked: true, unprocessed: true,
    noError: true, fresh: true, processedInOrder: null, projectId: eventType.startsWith('project-file') ? 'owned-project' : null,
    workspaceId: eventType.startsWith('project-file') ? null : 'owned-workspace', workflowId: null, deploymentVersionId: null,
    operationId: null, generation: null, userId: null, digest: 'c'.repeat(32), version: '8', ...change }
}
const ERASURE_TYPES = ['project-file.storage.prefix-cleanup', 'account-deletion.storage.workspace-sweep', 'execution.removal-stop']

test('owned outbox census keeps erasure events and the completed preparation of a captured deployment', async () => {
  const { ownedOutboxResidue } = await import('./linux-chat-fixture')
  expect(ownedOutboxResidue([], OWNED_OUTBOX_SCOPE)).toEqual([])
  const rows = [preparationEvent(), ...ERASURE_TYPES.map(type => erasureEvent(type)), erasureEvent(ERASURE_TYPES[0], { id: 'event-delayed' })]
  expect(ownedOutboxResidue(rows, OWNED_OUTBOX_SCOPE)).toEqual(rows.map(row => ({ id: row.id, digest: row.digest, version: row.version })))
})

test('owned outbox census refuses by name a foreign, non-terminal, unexpected or surplus event', async () => {
  const { ownedOutboxResidue } = await import('./linux-chat-fixture')
  const refused = (rows: unknown[], reason: string) =>
    expect(() => ownedOutboxResidue(rows as never, OWNED_OUTBOX_SCOPE)).toThrow('fixture_outbox_residue_refused:' + reason)
  // A type-only selection would accept these: each names another workflow, version, operation or actor.
  for (const change of [{ workflowId: 'foreign-workflow' }, { deploymentVersionId: 'foreign-version' },
    { operationId: 'foreign-operation' }, { userId: 'foreign-user' }, { generation: '2' }, { workflowId: null }])
    refused([preparationEvent(change)], 'unowned')
  for (const change of [{ status: 'pending' }, { status: 'dead_letter' }, { unlocked: false }, { unprocessed: true },
    { attempts: 1 }, { noError: false }, { processedInOrder: false }, { processedInOrder: null }])
    refused([preparationEvent(change)], 'unexpected_state')
  for (const type of ERASURE_TYPES) {
    refused([erasureEvent(type, { projectId: 'foreign-project', workspaceId: 'foreign-workspace' })], 'unowned')
    for (const change of [{ status: 'completed' }, { attempts: 1 }, { unlocked: false }, { unprocessed: false }])
      refused([erasureEvent(type, change)], 'unexpected_state')
  }
  for (const eventType of ['workflow.deployment.cleanup-undeployed-side-effects', 'workflow.deployment.sync-active-side-effects', 'other'])
    refused([preparationEvent({ eventType })], 'unexpected_type')
  refused([preparationEvent({ fresh: false })], 'stale')
  refused([erasureEvent(ERASURE_TYPES[1], { fresh: null })], 'stale')
  for (const change of [{ digest: 'not-a-digest' }, { version: '7 OR true' }, { id: 7 }])
    refused([preparationEvent(change)], 'malformed')
  refused([preparationEvent(), preparationEvent({ id: 'event-replayed' })], 'surplus')
  refused(Array(33).fill(erasureEvent(ERASURE_TYPES[1])), 'surplus')
  // One refused row refuses the whole census, never a partial deletion list.
  refused([preparationEvent(), erasureEvent(ERASURE_TYPES[2], { workspaceId: 'foreign-workspace' })], 'unowned')
})

function cleanupFragment(start: string, end: string, prefix: string, suffix: string) {
  const text = readFileSync(new URL('./linux-chat-fixture.ts', import.meta.url), 'utf8')
  const from = text.indexOf(start)
  const to = text.indexOf(end, from)
  if (from < 0 || to < 0) throw Error('cleanup_fragment_missing')
  return new Bun.Transpiler({ loader: 'ts' }).transformSync(prefix + text.slice(from, to) + suffix)
}

test('owned deployment capture binds only active operations of the captured workspaces before erasure', async () => {
  const code = cleanupFragment('        const deployments =', '        // The native one-time-token plugin',
    'async function invoke() {\n', '\nreturn deployments;\n}')
  const assertRecipe = (value: unknown) => { if (!value) throw Error('owned_fixture_cleanup_refused') }
  const workspaceIds = ['owned-workspace']
  const fixture = { userId: 'owned-user' }
  const execute = (rows: unknown[]) => new Function('sql', 'workspaceIds', 'fixture', 'assertRecipe', code + '\nreturn invoke();')(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join('?')
      expect(query).toContain('FROM workflow_deployment_operation o JOIN workflow w ON w.id=o.workflow_id')
      expect(query).toContain('v.id=o.deployment_version_id AND v.workflow_id=o.workflow_id')
      expect(query).toContain('w.workspace_id=ANY(')
      expect(query).toContain('o.actor_id=')
      expect(query).toContain("o.status='active'")
      expect(query).toContain('LIMIT 17')
      expect(values).toEqual([workspaceIds, fixture.userId])
      return rows
    }, workspaceIds, fixture, assertRecipe)
  await expect(execute([])).resolves.toEqual([])
  await expect(execute([OWNED_OUTBOX_SCOPE.deployments[0]])).resolves.toEqual(OWNED_OUTBOX_SCOPE.deployments)
  await expect(execute(Array(17).fill(OWNED_OUTBOX_SCOPE.deployments[0]))).rejects.toThrow('owned_fixture_cleanup_refused')
})

test('outbox residue is a census of every row classified by the owned binding', async () => {
  const { ownedOutboxResidue } = await import('./linux-chat-fixture')
  const code = cleanupFragment('        const outboxCensus =', '        // Fresh dedicated database;',
    'async function invoke() {\n', '\nreturn outbox;\n}')
  const start = '2026-10-20T00:00:00Z'
  const execute = (rows: unknown[]) => new Function('sql', 'start', 'workspaceIds', 'projectIds', 'deployments', 'fixture',
    'ownedOutboxResidue', code + '\nreturn invoke();')(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join('?')
      expect(query).toContain('FROM outbox_event t ORDER BY t.id LIMIT 33')
      // A census: no type, status or payload predicate may hide a row from the classifier.
      expect(query).not.toMatch(/WHERE/i)
      for (const field of ['projectId', 'workspaceId', 'workflowId', 'deploymentVersionId', 'operationId', 'generation', 'userId'])
        expect(query).toContain("t.payload->>'" + field + "'")
      expect(query).toContain('md5(row_to_json(t)::text) AS digest')
      expect(query).toContain('t.xmin::text AS version')
      expect(values).toEqual([start])
      return rows
    }, start, OWNED_OUTBOX_SCOPE.workspaceIds, OWNED_OUTBOX_SCOPE.projectIds, OWNED_OUTBOX_SCOPE.deployments,
    { userId: OWNED_OUTBOX_SCOPE.userId }, ownedOutboxResidue)
  await expect(execute([preparationEvent()])).resolves.toEqual([{ id: 'event-preparation', digest: 'b'.repeat(32), version: '7' }])
  await expect(execute([preparationEvent({ workflowId: 'foreign-workflow' })])).rejects.toThrow('fixture_outbox_residue_refused:unowned')
})

test('baseline compare checks every table and names all mismatches privately before refusing at the first', async () => {
  const code = cleanupFragment("          cleanupStage = 'baseline_compare'", "        })\n        cleanupStage = 'proof_write'",
    'let cleanupStage = "residue_delete"; let cleanupIndex = null;\nasync function invoke() {\n',
    '\n}\nreturn { invoke, index: () => cleanupIndex, stage: () => cleanupStage };')
  const assertRecipe = (value: unknown) => { if (!value) throw Error('owned_fixture_cleanup_refused') }
  const baseline = ['a_table', 'b_table', 'c_table', 'd_table'].map(table => ({ table, count: 1, digest: 'd'.repeat(32) }))
  const run = async (actual: Record<string, { n: number; digest: string }>, write = (..._: unknown[]) => {}) => {
    const queried: string[] = []
    const scope = new Function('tx', 'baseline', 'assertRecipe', 'writeFileSync', 'join', 'directory', code)(
      { unsafe: async (query: string) => { const table = query.match(/public\."([a-z_]+)"/)![1]; queried.push(table)
        return [actual[table] ?? { n: 1, digest: 'd'.repeat(32) }] } },
      baseline, assertRecipe, write, (...parts: string[]) => parts.join('/'), '/scratch/ui')
    return { scope, queried, result: scope.invoke() }
  }
  const clean = await run({})
  await expect(clean.result).resolves.toBeUndefined()
  expect(clean.queried).toEqual(baseline.map(item => item.table))
  const writes: unknown[][] = []
  const dirty = await run({ b_table: { n: 2, digest: 'e'.repeat(32) }, d_table: { n: 1, digest: 'f'.repeat(32) } },
    (...args: unknown[]) => writes.push(args))
  await expect(dirty.result).rejects.toThrow('owned_fixture_cleanup_refused')
  expect(dirty.queried).toEqual(baseline.map(item => item.table))
  expect(dirty.scope.stage()).toBe('baseline_compare')
  expect(dirty.scope.index()).toBe(1)
  expect(writes).toHaveLength(1)
  expect(writes[0][0]).toBe('/scratch/ui/baseline-mismatches.private.json')
  expect(JSON.parse(String(writes[0][1]))).toEqual([
    { index: 1, table: 'b_table', baselineCount: 1, count: 2 }, { index: 3, table: 'd_table', baselineCount: 1, count: 1 }])
  expect(writes[0][2]).toEqual({ mode: 0o600, flag: 'wx' })
  // Unwritable or pre-existing evidence never turns the refusal into success.
  const blocked = await run({ c_table: { n: 0, digest: 'e'.repeat(32) } }, () => { throw Error('EEXIST') })
  await expect(blocked.result).rejects.toThrow('owned_fixture_cleanup_refused')
  expect(blocked.scope.index()).toBe(2)
})
