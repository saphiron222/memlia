// Copyright 2026 Memlia. All rights reserved.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { allowedOrigin, finalReceipt, graphIds, responseAfterClick } from './linux-chat-browser.mjs'
import { durableQueueReceipt, durableExecutionRequest, pageDurableWrite } from './linux-chat-browser.mjs'
import { inactiveTestRequest, inactiveQueueReceipt, durableJourney, durableDeployReceipt } from './linux-chat-browser.mjs'
import { loginFormHydrated } from './linux-chat-browser.mjs'
const origins = ['http://localhost:3000', 'http://localhost:3002']
// Fictitious values in the exact form POST /api/workflows/[id]/deploy produced on the VM (pass 11).
const deployedAt = '2026-10-22T07:26:31.890Z'
const deployResponse = {
  isDeployed: true, deployedAt, apiKey: 'Workspace API keys',
  activeDeployment: { deploymentVersionId: 'owned-version', version: 1, deployedAt },
  latestDeploymentAttempt: { id: 'owned-operation', deploymentVersionId: 'owned-version', version: 1, action: 'deploy',
    status: 'active', isCurrent: true, readiness: { webhooks: 'ready', schedules: 'ready', mcp: 'ready' },
    requestedAt: '2026-10-22T07:26:31.781Z', activatedAt: deployedAt, error: null },
}
test('deploy receipt follows the native response: active version identity, never a guessed field', () => {
  assert.deepEqual(durableDeployReceipt(200, deployResponse), { deploymentVersionId: 'owned-version', version: 1 })
  assert.deepEqual(durableDeployReceipt(200, { ...deployResponse, warnings: ['Deployment activation completed, and post-activation notifications are queued.'] }),
    { deploymentVersionId: 'owned-version', version: 1 })
  const active = deployResponse.activeDeployment
  const attempt = deployResponse.latestDeploymentAttempt
  for (const [status, body] of [
    [201, deployResponse], [500, deployResponse], [200, null], [200, []],
    [200, { ...deployResponse, isDeployed: false }], [200, { ...deployResponse, activeDeployment: null }],
    [200, { ...deployResponse, activeDeployment: undefined }], [200, { ...deployResponse, latestDeploymentAttempt: null }],
    [200, { ...deployResponse, privateCanary: 'PRIVATE_CANARY' }], [200, { ...deployResponse, warnings: 'queued' }],
    [200, { ...deployResponse, warnings: [1] }], [200, { ...deployResponse, deployedAt: 'yesterday' }],
    // The pass-11 assumption: a summary carrying `id` instead of `deploymentVersionId`.
    [200, { ...deployResponse, activeDeployment: { id: 'owned-version', version: 1, deployedAt } }],
    [200, { ...deployResponse, activeDeployment: { ...active, id: 'owned-version' } }],
    [200, { ...deployResponse, activeDeployment: { ...active, deploymentVersionId: '../foreign' } }],
    [200, { ...deployResponse, activeDeployment: { ...active, deploymentVersionId: 'owned-version\n' } }],
    [200, { ...deployResponse, activeDeployment: { ...active, deploymentVersionId: 7 } }],
    // Same invalid version on both summaries, so only the version check can refuse it.
    ...[0, -1, 1.5, '1', 2 ** 53].map(version => [200, { ...deployResponse, activeDeployment: { ...active, version },
      latestDeploymentAttempt: { ...attempt, version } }] as const),
    [200, { ...deployResponse, activeDeployment: { ...active, deployedAt: 'now' } }],
    [200, { ...deployResponse, latestDeploymentAttempt: { ...attempt, deploymentVersionId: 'previous-version' } }],
    [200, { ...deployResponse, latestDeploymentAttempt: { ...attempt, version: 2 } }],
    [200, { ...deployResponse, latestDeploymentAttempt: { ...attempt, status: 'activating' } }],
    [200, { ...deployResponse, latestDeploymentAttempt: { ...attempt, isCurrent: false } }],
    [200, { ...deployResponse, latestDeploymentAttempt: { ...attempt, action: 'rollback' } }],
  ] as const) assert.throws(() => durableDeployReceipt(status, body), /durable_deploy_refused/)
})
test('durable profile deploys, records the native active version, then enqueues once; a refused deploy never enqueues', async () => {
  type Request = { path: string; body?: string; method?: string; headers?: Record<string, string> }
  const run = async (deployed: unknown, echo = (id: string) => id) => {
    const requests: Request[] = []
    const captured: string[] = []
    const values: Record<string, any> = {}
    const timeline: string[] = []
    const observed: Record<string, unknown> = {}
    const locator = { fill: async () => {}, click: async () => {}, waitFor: async () => {}, elementHandle: async () => ({}) }
    const page = { setDefaultTimeout() {}, goto: async () => {}, locator: () => locator, getByRole: () => locator,
      waitForFunction: async () => {}, waitForURL: async () => {}, waitForResponse: async () => ({ status: () => 200 }),
      evaluate: async (_fn: unknown, request: string | Request) => {
        if (typeof request === 'string') return { data: { user: { id: 'user' } } }
        requests.push(request)
        timeline.push('request:' + request.path.split('/').at(-1))
        if (request.path.endsWith('/deploy')) return { status: 200, raw: JSON.stringify(deployed), overflow: false }
        const id = echo(String(request.headers?.['X-Execution-Id']))
        return { status: 202, overflow: false, raw: JSON.stringify({ success: true, async: true, jobId: 'workflow-execution:' + id,
          executionId: id, message: 'Workflow execution queued', statusUrl: origins[0] + '/api/jobs/workflow-execution:' + id }) }
      } }
    const outcome = await durableJourney(page, { origin: origins[0], userId: 'user', email: 'fictitious@example.invalid', password: 'fictitious' },
      { workflowId: 'flow', workspaceId: 'space' }, observed, (phase: string, value: unknown) => { captured.push(phase); values[phase] = value; timeline.push('capture:' + phase) })
      .then(() => null, (e: Error) => e)
    return { requests, captured, values, timeline, observed, outcome }
  }
  const passed = await run(deployResponse)
  assert.equal(passed.outcome, null)
  assert.deepEqual(passed.requests.map(r => r.path), ['/api/workflows/flow/deploy', '/api/workflows/flow/execute'])
  assert.deepEqual(passed.captured, ['identities', 'deploy', 'enqueue'])
  assert.deepEqual(passed.timeline, ['capture:identities', 'request:deploy', 'capture:deploy', 'request:execute', 'capture:enqueue'])
  // The execution ID is fixed and captured before the deploy mutation, then sent and confirmed.
  const executionId = passed.values.identities.executionId
  assert.deepEqual(passed.values.identities, { workflowId: 'flow', workspaceId: 'space', executionId })
  assert.match(executionId, /^[0-9a-f-]{36}$/)
  assert.deepEqual(passed.requests[1], durableExecutionRequest('flow', 'space', executionId))
  assert.deepEqual(passed.observed, { authenticated: true, deployed: true, deploymentVersionId: 'owned-version',
    admissionMayExist: true, executionId, jobId: 'workflow-execution:' + executionId, queued: true })
  const foreign = await run(deployResponse, () => 'other-run')
  assert.match(String(foreign.outcome?.message), /durable_enqueue_unconfirmed/)
  assert.equal(foreign.observed.queued, undefined)
  assert.equal(foreign.observed.admissionMayExist, true)
  const refused = await run({ ...deployResponse, activeDeployment: { id: 'owned-version', version: 1, deployedAt } })
  assert.match(String(refused.outcome?.message), /durable_deploy_refused/)
  assert.deepEqual(refused.requests.map(r => r.path), ['/api/workflows/flow/deploy'])
  assert.deepEqual(refused.captured, ['identities', 'deploy'])
  assert.equal(refused.observed.deployed, undefined); assert.equal(refused.observed.deploymentVersionId, undefined)
  assert.equal(refused.observed.admissionMayExist, undefined)
})
const inactiveDigest = 'sha256:' + 'a'.repeat(64)
const inactivePreparation = { expectedRevision: 7, expectedStateDigest: inactiveDigest, operationId: 'operation' }
const inactiveVersion = { status: 'prepared_for_test', workflowId: 'flow', deploymentVersionId: 'version', version: 2,
  snapshotDigest: inactiveDigest, activationAvailable: false, executionAvailable: false }
test('inactive profile uses the dedicated consented proof and refuses mismatched queued versions', () => {
  const request = inactiveTestRequest('flow', 'space', inactivePreparation, inactiveVersion, 'stable-run')
  assert.equal(request.path, '/api/workflows/flow/excel/test-preparations/run')
  assert.deepEqual(JSON.parse(request.body), { workspaceId: 'space', preparation: inactivePreparation, prepared: inactiveVersion,
    executionId: 'stable-run', acknowledgeEffects: true })
  const receipt = { status: 'queued', workflowId: 'flow', deploymentVersionId: 'version', snapshotDigest: inactiveDigest, executionId: 'stable-run' }
  assert.deepEqual(inactiveQueueReceipt(202, receipt, request), { executionId: 'stable-run', deploymentVersionId: 'version', snapshotDigest: inactiveDigest })
  for (const change of [{ executionId: 'other' }, { deploymentVersionId: 'other' }, { snapshotDigest: 'sha256:' + 'b'.repeat(64) }, { accepted: true }])
    assert.throws(() => inactiveQueueReceipt(202, { ...receipt, ...change }, request))
  assert.throws(() => inactiveQueueReceipt(200, receipt, request))
  for (const change of [{ isActive: true }, { workflowId: 'other' }, { activationAvailable: true }])
    assert.throws(() => inactiveTestRequest('flow', 'space', inactivePreparation, { ...inactiveVersion, ...change }, 'stable-run'))
})
test('login waits for React hydration of email, password and submit before typing', async () => {
  const hydrated = (extra = {}) => ({ ['__reactProps$abc']: {}, textContent: ' Sign in ', ...extra })
  const form = (email: unknown, password: unknown, buttons: unknown[]) => ({
    querySelector: (selector: string) => selector.includes('email') ? email : password, querySelectorAll: () => buttons })
  const saved = (globalThis as { document?: unknown }).document
  try {
    for (const [doc, expected] of [
      [form(hydrated(), hydrated(), [{ textContent: 'Other' }, hydrated()]), true],
      [form({}, hydrated(), [hydrated()]), false], [form(hydrated(), null, [hydrated()]), false],
      [form(hydrated(), hydrated(), [{ textContent: 'Sign in', __reactFiber$abc: {} }]), false],
      [form(hydrated(), hydrated(), [hydrated({ textContent: 'Sign in with SSO' })]), false],
      [form(hydrated(), hydrated(), []), false],
    ] as const) {
      (globalThis as { document?: unknown }).document = doc
      assert.equal(loginFormHydrated(), expected)
    }
  } finally { (globalThis as { document?: unknown }).document = saved }
  const calls: string[] = []
  const locator = (name: string) => ({ fill: async () => { calls.push('fill:' + name) }, click: async () => {}, waitFor: async () => { calls.push('visible:' + name) },
    elementHandle: async () => name })
  const page = { setDefaultTimeout() {}, goto: async () => {}, locator: (selector: string) => locator(selector.includes('email') ? 'email' : 'password'),
    getByRole: () => locator('button'),
    waitForFunction: async (fn: unknown) => { calls.push(fn === loginFormHydrated ? 'hydrated' : 'enabled') },
    waitForURL: async () => {}, waitForResponse: async () => ({ status: () => 200 }),
    evaluate: async (_fn: unknown, request: unknown) => typeof request === 'string' ? { data: { user: { id: 'user' } } }
      : { status: 200, raw: JSON.stringify(deployResponse), overflow: false } }
  await durableJourney(page, { origin: origins[0], userId: 'user', email: 'fictitious@example.invalid', password: 'fictitious' },
    { workflowId: 'flow', workspaceId: 'space' }, {}, () => {}).catch(() => {})
  assert.deepEqual(calls.slice(0, 5), ['visible:button', 'hydrated', 'fill:email', 'fill:password', 'enabled'])
})
test('inactive profile observes and prepares once then queues without deployment, browser interactions doubled', async () => {
  type Request = { path: string; body?: string; method?: string }
  const requests: Request[] = []
  const captured: string[] = []
  const observed: Record<string, unknown> = {}
  const locator = { fill: async () => {}, click: async () => {}, waitFor: async () => {}, elementHandle: async () => ({}) }
  const page = { setDefaultTimeout() {}, goto: async () => {}, locator: () => locator, getByRole: () => locator,
    waitForFunction: async () => {}, waitForURL: async () => {}, waitForResponse: async () => ({ status: () => 200 }),
    evaluate: async (_fn: unknown, request: string | Request) => {
      if (typeof request === 'string') { assert.equal(request, '/api/auth/get-session'); return { data: { user: { id: 'user' } } } }
      requests.push(request)
      const value = request.method === 'GET'
        ? { workflowId: 'flow', workspaceId: 'space', expectedRevision: 7, expectedStateDigest: inactiveDigest }
        : request.path.endsWith('/run') ? { status: 'queued', workflowId: 'flow', deploymentVersionId: 'version', snapshotDigest: inactiveDigest, executionId: JSON.parse(request.body!).executionId }
        : inactiveVersion
      return { status: request.path.endsWith('/run') ? 202 : 200, raw: JSON.stringify(value), overflow: false }
    } }
  await durableJourney(page, { origin: origins[0], userId: 'user', email: 'fictitious@example.invalid', password: 'fictitious' },
    { workflowId: 'flow', workspaceId: 'space' }, observed, (phase: string) => { captured.push(phase) }, true)
  assert.equal(observed.queued, true); assert.equal(observed.deployed, undefined)
  assert.equal(observed.deploymentVersionId, 'version')
  assert.equal(requests.length, 3)
  assert.ok(requests.every(r => !r.path.endsWith('/deploy')))
  assert.deepEqual(captured, ['test-observe', 'test-identities', 'test-prepare', 'test-enqueue'])
  assert.equal(observed.browserClosed, undefined) // caller must close before any worker, never inferred here
})
test('durable write retains bounded native HTTP refusals before JSON parsing, with overflow explicit', async () => {
  const saved = globalThis.fetch
  const calls: unknown[][] = []
  try {
    for (const [body, status, overflow] of [['PRIVATE_CANARY: not JSON', 503, false], ['x'.repeat(131073), 202, true]] as const) {
      globalThis.fetch = async (...args) => { calls.push(args); return new Response(body, { status }) }
      const result = await pageDurableWrite(durableExecutionRequest('owned-flow', 'owned-space', 'owned-run'))
      assert.equal(result.status, status); assert.equal(result.overflow, overflow)
      assert.equal(result.raw, body.slice(0, 131072))
      assert.equal(calls.at(-1)[1].redirect, 'error')
      assert.equal(calls.at(-1)[1].credentials, 'same-origin')
    }
  } finally { globalThis.fetch = saved }
})
test('durable submission uses the native session queue contract without API keys or draft controls', () => {
  const request = durableExecutionRequest('owned-flow', 'owned-space', 'owned-run')
  assert.equal(request.path, '/api/workflows/owned-flow/execute')
  assert.deepEqual(request.headers, { 'content-type': 'application/json', 'X-Execution-Mode': 'async', 'X-Execution-Id': 'owned-run' })
  assert.deepEqual(JSON.parse(request.body), { parentWorkspaceId: 'owned-space', isClientSession: true })
  for (const id of ['', '../foreign', 'x'.repeat(129), 'owned-flow\n', undefined]) {
    assert.throws(() => durableExecutionRequest(id, 'owned-space', 'owned-run'))
    assert.throws(() => durableExecutionRequest('owned-flow', id, 'owned-run'))
    assert.throws(() => durableExecutionRequest('owned-flow', 'owned-space', id))
  }
})
test('durable receipt refuses sync inline, ambiguous acceptance and job/execution mismatch', () => {
  const value = { success: true, async: true, executionId: 'owned-run',
    jobId: 'workflow-execution:owned-run', message: 'Workflow execution queued',
    statusUrl: origins[0] + '/api/jobs/workflow-execution:owned-run' }
  const request = durableExecutionRequest('owned-flow', 'owned-space', 'owned-run')
  assert.deepEqual(durableQueueReceipt(202, value, request), { executionId: 'owned-run', jobId: value.jobId })
  // A 202 for another execution than the one this caller fixed is never this submission.
  assert.throws(() => durableQueueReceipt(202, value, durableExecutionRequest('owned-flow', 'owned-space', 'other-run')),
    /durable_enqueue_unconfirmed/)
  assert.throws(() => durableQueueReceipt(202, value))
  for (const [status, body] of [[200, value], [503, value], [202, { ...value, async: false }],
    [202, { ...value, success: 1 }], [202, { ...value, jobId: 'inline-job' }],
    [202, { ...value, executionId: '../foreign' }], [202, { ...value, apiKey: 'PRIVATE_CANARY' }]] as const)
    assert.throws(() => durableQueueReceipt(status, body, request))
  assert.throws(() => durableQueueReceipt(202, { ...value, executionId: 'owned-run\n', jobId: 'workflow-execution:owned-run\n' }, request))
})
test('two exact loopback origins and their websocket equivalents only', () => {
  for (const url of [
    'http://localhost:3000/login',
    'http://localhost:3002/socket.io/',
    'ws://localhost:3002/socket.io/',
  ])
    assert.equal(allowedOrigin(url, origins), true)
  for (const url of [
    'https://api.openai.com/v1',
    'http://localhost:3003',
    'http://localhost.evil:3000',
    'file:///etc/passwd',
    'data:text/html,x',
    'http://user@localhost:3000',
  ])
    assert.equal(allowedOrigin(url, origins), false)
})
const flags = {
  authenticated: true,
  socket: true,
  workflow: true,
  canvas: true,
  chatRefused: true,
  browserClosed: true,
}
test('success requires every native observation plus closure; projection excludes credentials', () => {
  assert.equal(
    finalReceipt({ ...flags, email: 'CANARY', password: 'CANARY' }, null).status,
    'passed'
  )
  for (const key of Object.keys(flags))
    assert.equal(finalReceipt({ ...flags, [key]: false }, null).status, 'failed')
  assert.equal(
    JSON.stringify(finalReceipt({ ...flags, password: 'CANARY' }, null)).includes('CANARY'),
    false
  )
  assert.equal(finalReceipt(flags, new Error('CANARY')).reason, 'journey_failed')
})
test('abort and cleanup failure cannot be downgraded to success', () => {
  assert.equal(finalReceipt(flags, { name: 'AbortError' }).status, 'failed')
  assert.equal(finalReceipt({ ...flags, browserClosed: false }, null).reason, 'cleanup_failed')
})
test('graph readback must be bounded nonempty revisioned native data', () => {
  assert.deepEqual(graphIds({ blocks: { a: {}, b: {} }, draftRevision: 3 }), ['a', 'b'])
  for (const value of [
    { blocks: {}, draftRevision: 1 },
    { blocks: [], draftRevision: 1 },
    { blocks: { a: {} }, draftRevision: -1 },
    {
      blocks: Object.fromEntries(Array.from({ length: 129 }, (_, i) => ['b' + i, {}])),
      draftRevision: 1,
    },
  ])
    assert.throws(() => graphIds(value))
})
test('response rejection is handled immediately even when the click fails', async () => {
  const unhandled = []
  const onError = (e) => unhandled.push(e)
  process.on('unhandledRejection', onError)
  try {
    const page = { waitForResponse: () => Promise.reject(new Error('CANARY')) }
    await assert.rejects(
      responseAfterClick(
        page,
        () => true,
        async () => {
          await new Promise((r) => setTimeout(r, 5))
          throw new Error('click_failure')
        }
      ),
      /click_failure/
    )
    await new Promise((r) => setTimeout(r, 5))
    assert.deepEqual(unhandled, [])
  } finally {
    process.off('unhandledRejection', onError)
  }
})
test('a real matching response is returned only after native click completes', async () => {
  let clicked = false
  const response = { status: () => 200 }
  const result = await responseAfterClick(
    { waitForResponse: () => Promise.resolve(response) },
    () => true,
    async () => {
      clicked = true
    }
  )
  assert.equal(clicked, true)
  assert.equal(result, response)
})

// This imports only validation code; native PostgreSQL is never opened by these tests.
import { validateTarget } from './linux-chat-fixture.ts'
test('fixture role and database are exact; no existing or owner runtime target admitted', () => {
  const n = 'a'.repeat(32)
  const web = `postgres://ui_web_${n}:fictitious@database:5432/memlia_ui_${n}`
  assert.equal(validateTarget(web, n, 'seed').username, 'ui_web_' + n)
  for (const raw of [
    web.replace('database:', 'localhost:'),
    web.replace('ui_web_', 'ui_migrate_'),
    web + '?sslmode=disable',
    web.replace('/memlia_ui_', '/old_'),
  ])
    assert.throws(() => validateTarget(raw, n, 'seed'))
  assert.throws(() => validateTarget(web, n, 'unknown'))
  assert.throws(() => validateTarget(web, '../foreign', 'seed'))
})

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { canvasVisible, readFixture } from './linux-chat-browser.mjs'
test('owned fixture refuses symlink, public permissions and byte overflow', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'memlia-ci-fixture-'))
  try {
    const file = path.join(d, 'fixture.json')
    const value = {
      origin: origins[0],
      realtimeOrigin: origins[1],
      email: 'ci@example.invalid',
      password: 'fictitious-password-only',
      userId: 'a'.repeat(8) + '-aaaa-aaaa-aaaa-' + 'a'.repeat(12),
    }
    fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 })
    assert.equal(readFixture(file).userId, value.userId)
    fs.symlinkSync(file, path.join(d, 'link'))
    assert.throws(() => readFixture(path.join(d, 'link')))
    fs.chmodSync(file, 0o644)
    assert.throws(() => readFixture(file))
    fs.chmodSync(file, 0o600)
    fs.writeFileSync(file, ' '.repeat(4097))
    assert.throws(() => readFixture(file))
  } finally {
    fs.rmSync(d, { recursive: true })
  }
})
test('canvas observation requires rendered native nodes, no spinner and nonzero layout', () => {
  const saved = {
    document: globalThis.document,
    getComputedStyle: globalThis.getComputedStyle,
    CSS: globalThis.CSS,
  }
  let spinner = false
  let width = 30
  let height = 30
  let opacity = '1'
  let missing = false
  const node = { getBoundingClientRect: () => ({ width, height }) }
  const canvas = {
    getBoundingClientRect: () => ({ height }),
    querySelector: (selector) =>
      selector.includes('progressbar') ? (spinner ? {} : null) : missing ? null : node,
  }
  globalThis.document = { querySelector: () => canvas }
  globalThis.getComputedStyle = () => ({ visibility: 'visible', opacity })
  globalThis.CSS = { escape: (x) => x }
  try {
    assert.equal(canvasVisible({ ids: ['native-id'] }), true)
    spinner = true
    assert.equal(canvasVisible({ ids: ['native-id'] }), false)
    spinner = false
    width = 0
    assert.equal(canvasVisible({ ids: ['native-id'] }), false)
    width = 30
    height = 0
    assert.equal(canvasVisible({ ids: ['native-id'] }), false)
    height = 30
    opacity = '0'
    assert.equal(canvasVisible({ ids: ['native-id'] }), false)
    opacity = '1'
    missing = true
    assert.equal(canvasVisible({ ids: ['native-id'] }), false)
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[key]
      else globalThis[key] = value
    }
  }
})

import { EventEmitter } from 'node:events'
import { observeSocket } from './linux-chat-browser.mjs'
test('socket evidence belongs to an exact live connection, not an earlier closed socket', () => {
  const page = new EventEmitter()
  const connected = observeSocket(page, { origin: origins[0], realtimeOrigin: origins[1] })
  const socket = new EventEmitter()
  socket.url = () => 'ws://localhost:3002/socket.io/'
  page.emit('websocket', socket)
  socket.emit('framereceived', { payload: '40{"sid":"synthetic"}' })
  assert.equal(connected(), false)
  page.emit('response', { url: () => origins[0] + '/api/auth/socket-token', status: () => 200 })
  assert.equal(connected(), true)
  socket.emit('close')
  assert.equal(connected(), false)
  const foreign = new EventEmitter()
  foreign.url = () => 'ws://localhost:3003/socket.io/'
  page.emit('websocket', foreign)
  foreign.emit('framereceived', { payload: '40{"sid":"synthetic"}' })
  assert.equal(connected(), false)
})

test('canvas refuses hidden nodes or ancestors despite positive layout', () => {
  const saved = {
    document: globalThis.document,
    getComputedStyle: globalThis.getComputedStyle,
    CSS: globalThis.CSS,
  }
  const ancestors = [{}, {}, {}]
  const node = {
    parentElement: ancestors[0],
    getBoundingClientRect: () => ({ width: 30, height: 30 }),
  }
  ancestors[0].parentElement = ancestors[1]
  ancestors[1].parentElement = ancestors[2]
  const canvas = {
    parentElement: ancestors[2],
    getBoundingClientRect: () => ({ height: 30 }),
    querySelector: (s) => (s.includes('progressbar') ? null : node),
  }
  const styles = new Map()
  globalThis.document = { querySelector: () => canvas }
  globalThis.CSS = { escape: (x) => x }
  globalThis.getComputedStyle = (element) => ({
    display: 'block',
    visibility: 'visible',
    opacity: '1',
    ...styles.get(element),
  })
  try {
    assert.equal(canvasVisible({ ids: ['native-id'] }), true)
    for (const element of [node, ...ancestors, canvas]) {
      for (const style of [
        { visibility: 'hidden' },
        { visibility: 'collapse' },
        { opacity: '0' },
        { display: 'none' },
      ]) {
        styles.set(element, style)
        assert.equal(canvasVisible({ ids: ['native-id'] }), false)
        styles.clear()
      }
    }
    assert.equal(canvasVisible({ ids: ['native-id'] }), true)
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[key]
      else globalThis[key] = value
    }
  }
})
