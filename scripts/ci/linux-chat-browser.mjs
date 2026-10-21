// Copyright 2026 Memlia. All rights reserved.
// Owned CI browser only. No session injection, provider credentials or public raw artifacts.
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

export function durableExecutionRequest(workflowId) {
  if (typeof workflowId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}(?![\s\S])/.test(workflowId))
    throw Error('durable_workflow_refused')
  return { path: `/api/workflows/${workflowId}/execute`,
    headers: { 'content-type': 'application/json', 'X-Execution-Mode': 'async' },
    body: JSON.stringify({ input: {}, triggerType: 'manual' }) }
}
export function durableQueueReceipt(status, value) {
  if (status !== 202 || !value || value.success !== true || value.async !== true ||
    Object.keys(value).some(key => !['success', 'async', 'jobId', 'executionId', 'message', 'statusUrl'].includes(key)) ||
    typeof value.executionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}(?![\s\S])/.test(value.executionId) ||
    value.jobId !== 'workflow-execution:' + value.executionId)
    throw Error('durable_enqueue_unconfirmed')
  return { executionId: value.executionId, jobId: value.jobId }
}

// Executes in the authenticated page. Keep the bounded response before parsing;
// the owned host writes it to a private diagnostic file, including on HTTP refusal.
export async function pageDurableWrite(request) {
  const response = await fetch(request.path, { method: 'POST', credentials: 'same-origin',
    redirect: 'error', cache: 'no-store', headers: request.headers, body: request.body })
  if (!response.body) throw Error('durable_response_missing')
  const reader = response.body.getReader()
  const parts = []
  let count = 0
  let overflow = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (count + value.length > 131072) {
        parts.push(value.subarray(0, 131072 - count)); count = 131072
        overflow = true; await reader.cancel(); break
      }
      count += value.length
      parts.push(value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(count)
  let offset = 0
  for (const part of parts) { bytes.set(part, offset); offset += part.length }
  return { status: response.status, raw: new TextDecoder().decode(bytes), overflow }
}

export async function durableJourney(page, fixture, prepared, observed, capture) {
  if (!prepared || Object.keys(prepared).sort().join(',') !== 'workflowId,workspaceId' ||
      typeof prepared.workspaceId !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,128}(?![\s\S])/.test(prepared.workspaceId)) throw Error('durable_fixture_refused')
  const execute = durableExecutionRequest(prepared.workflowId)
  await loginSession(page, fixture)
  observed.authenticated = true
  const deploy = await page.evaluate(pageDurableWrite, {
    path: `/api/workflows/${prepared.workflowId}/deploy`,
    headers: { 'content-type': 'application/json' }, body: '{}' })
  capture('deploy', deploy)
  if (deploy.overflow) throw Error('durable_response_overflow')
  const deployed = JSON.parse(deploy.raw)
  if (deploy.status !== 200 || deployed.isDeployed !== true ||
      typeof deployed.activeDeployment?.id !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,128}(?![\s\S])/.test(deployed.activeDeployment.id)) throw Error('durable_deploy_refused')
  observed.deployed = true
  observed.deploymentVersionId = deployed.activeDeployment.id
  // A failed or lost response may have accepted work. The outer recipe never resubmits.
  observed.admissionMayExist = true
  const queued = await page.evaluate(pageDurableWrite, execute)
  capture('enqueue', queued)
  if (queued.overflow) throw Error('durable_response_overflow')
  Object.assign(observed, durableQueueReceipt(queued.status, JSON.parse(queued.raw)), { queued: true })
}

export function allowedOrigin(raw, origins) {
  try {
    const u = new URL(raw)
    if (u.username || u.password) return false
    if (u.protocol === 'ws:') u.protocol = 'http:'
    if (u.protocol === 'wss:') u.protocol = 'https:'
    return origins.includes(u.origin)
  } catch {
    return false
  }
}
const fields = ['authenticated', 'socket', 'workflow', 'canvas', 'chatRefused', 'browserClosed']
export function finalReceipt(observed, error) {
  const flags = Object.fromEntries(fields.map((k) => [k, observed[k] === true]))
  const passed = !error && Object.values(flags).every(Boolean)
  return {
    status: passed ? 'passed' : 'failed',
    reason: passed ? null : !flags.browserClosed ? 'cleanup_failed' : 'journey_failed',
    ...flags,
  }
}
export function graphIds(value) {
  if (
    !value ||
    !value.blocks ||
    typeof value.blocks !== 'object' ||
    Array.isArray(value.blocks) ||
    !Number.isSafeInteger(value.draftRevision) ||
    value.draftRevision < 0
  )
    throw Error('graph_refused')
  const ids = Object.keys(value.blocks)
  if (ids.length < 1 || ids.length > 128 || ids.some((id) => id.length < 1 || id.length > 128))
    throw Error('graph_refused')
  return ids
}
export async function responseAfterClick(page, predicate, click) {
  // Attach rejection handling before the click; never leave an orphaned rejection.
  const outcome = page.waitForResponse(predicate, { timeout: 60000 }).then(
    (value) => ({ value }),
    () => ({ failed: true })
  )
  await click()
  const result = await outcome
  if (result.failed) throw Error('response_refused')
  return result.value
}
export function canvasVisible({ ids }) {
  const visible = (element) => {
    for (let current = element; current; current = current.parentElement) {
      const style = getComputedStyle(current)
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.visibility === 'collapse' ||
        Number(style.opacity) <= 0
      )
        return false
    }
    return true
  }
  const canvas = document.querySelector('.workflow-container')
  if (!canvas || !visible(canvas) || canvas.getBoundingClientRect().height === 0) return false
  if (canvas.querySelector('[role="progressbar"], .animate-spin')) return false
  return ids.every((id) => {
    const node = canvas.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`)
    return (
      !!node &&
      visible(node) &&
      node.getBoundingClientRect().width > 0 &&
      node.getBoundingClientRect().height > 0
    )
  })
}
// Executed inside the real authenticated page; only bounded parsed data returns to the runner.
async function pageJSON(path) {
  const response = await fetch(path, { cache: 'no-store', redirect: 'error' })
  if (!response.ok || !response.body) throw Error('readback_refused')
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > 2 * 1024 ** 2) {
        await reader.cancel()
        throw Error('readback_overflow')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.length
  }
  return {
    data: JSON.parse(new TextDecoder().decode(bytes)),
    noStore: response.headers.get('cache-control')?.includes('no-store') === true,
  }
}
export function observeSocket(page, fixture) {
  const live = new Set()
  let token = false
  page.on('response', (response) => {
    try {
      const u = new URL(response.url())
      if (
        u.origin === fixture.origin &&
        u.pathname === '/api/auth/socket-token' &&
        response.status() === 200
      )
        token = true
    } catch {}
  })
  page.on('websocket', (socket) => {
    if (!allowedOrigin(socket.url(), [fixture.realtimeOrigin])) return
    socket.on('close', () => live.delete(socket))
    socket.on('framereceived', ({ payload }) => {
      if (typeof payload !== 'string' || payload.length > 1024 || !payload.startsWith('40{')) return
      try {
        const value = JSON.parse(payload.slice(2))
        if (typeof value.sid === 'string' && value.sid.length > 0) live.add(socket)
      } catch {}
    })
  })
  return () => token && live.size > 0
}
async function loginSession(page, fixture) {
  page.setDefaultTimeout(45000)
  await page.goto(fixture.origin + '/login', { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.locator('input[name="email"]').fill(fixture.email)
  await page.locator('input[type="password"]').fill(fixture.password)
  const button = page.getByRole('button', { name: 'Sign in', exact: true })
  await button.waitFor({ state: 'visible' })
  await page.waitForFunction((el) => !el.disabled, await button.elementHandle())
  const response = await responseAfterClick(
    page,
    (r) =>
      new URL(r.url()).pathname === '/api/auth/sign-in/email' && r.request().method() === 'POST',
    () => button.click()
  )
  if (response.status() !== 200) throw Error('auth_refused')
  await page.waitForURL((u) => /^\/workspace\/[^/]+\//.test(u.pathname), { timeout: 90000 })
  const session = await page.evaluate(pageJSON, '/api/auth/get-session')
  if (session.data?.user?.id !== fixture.userId) throw Error('auth_refused')
}
export async function journey(page, fixture, observed) {
  const connected = observeSocket(page, fixture)
  await loginSession(page, fixture)
  observed.authenticated = true
  const workspaceId = new URL(page.url()).pathname.split('/')[2]
  await page.goto(`${fixture.origin}/workspace/${encodeURIComponent(workspaceId)}/w`, {
    waitUntil: 'domcontentloaded',
    timeout: 90000,
  })
  const until = Date.now() + 45000
  while (Date.now() < until && !connected())
    await new Promise((resolve) => setTimeout(resolve, 100))
  if (!connected()) throw Error('socket_refused')
  observed.socket = true
  const create = page.getByRole('button', { name: 'Create workflow', exact: true })
  const add = page.getByRole('button', { name: 'New workflow', exact: true })
  const target = (await create.count()) ? create : add
  await target.waitFor({ state: 'visible' })
  await page.waitForFunction((el) => !el.disabled, await target.elementHandle())
  const made = await responseAfterClick(
    page,
    (r) => new URL(r.url()).pathname === '/api/workflows' && r.request().method() === 'POST',
    () => target.click()
  )
  if (![200, 201].includes(made.status())) throw Error('workflow_refused')
  await page.waitForURL((u) => /^\/workspace\/[^/]+\/w\/[^/]+/.test(u.pathname), { timeout: 90000 })
  const current = new URL(page.url())
  const workflowId = current.pathname.split('/')[4]
  if (current.origin !== fixture.origin || current.pathname.split('/')[2] !== workspaceId)
    throw Error('scope_refused')
  observed.workflow = true
  const graph = await page.evaluate(
    pageJSON,
    `/api/workflows/${encodeURIComponent(workflowId)}/state`
  )
  await page.waitForFunction(canvasVisible, { ids: graphIds(graph.data) }, { timeout: 45000 })
  if (!connected()) throw Error('socket_refused')
  observed.canvas = true
  const profile = await page.evaluate(
    pageJSON,
    `/api/copilot/capabilities?workspaceId=${encodeURIComponent(workspaceId)}&workflowId=${encodeURIComponent(workflowId)}`
  )
  if (profile.data?.backend !== 'unavailable' || !profile.noStore) throw Error('profile_refused')
  const openChat = page.getByRole('button', { name: 'Open chat', exact: true })
  if (await openChat.count()) await openChat.click()
  for (const name of ['Chat', 'Copilot']) {
    const tab = page.getByRole('tab', { name, exact: true })
    if (await tab.count()) {
      await tab.click()
      break
    }
  }
  await page
    .getByText(/Le Chat est indisponible|Les réglages ne correspondent plus à ce workflow/)
    .first()
    .waitFor({ state: 'visible', timeout: 45000 })
  observed.chatRefused = true
}
export function readFixture(file, durable = false) {
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
  )
  try {
    const s = fs.fstatSync(fd)
    if (!s.isFile() || s.size > 4096 || (s.mode & 0o077) !== 0) throw Error('fixture_refused')
    const bytes = Buffer.alloc(4097)
    const count = fs.readSync(fd, bytes, 0, bytes.length, null)
    if (count > 4096) throw Error('fixture_refused')
    const value = JSON.parse(bytes.subarray(0, count))
    if (
      (durable ? !/^https:\/\/localhost(?::[1-9][0-9]{0,4})?$/.test(value.origin) : value.origin !== 'http://localhost:3000') ||
      (durable ? !/^https:\/\/localhost(?::[1-9][0-9]{0,4})?$/.test(value.realtimeOrigin) : value.realtimeOrigin !== 'http://localhost:3002') ||
      !/^.{1,128}@example\.invalid$/.test(value.email) ||
      typeof value.password !== 'string' ||
      value.password.length < 16 ||
      value.password.length > 128 ||
      !/^[-a-f0-9]{36}$/.test(value.userId)
    )
      throw Error('fixture_refused')
    return value
  } finally {
    fs.closeSync(fd)
  }
}
async function main() {
  process.umask(0o077)
  const [source, fixtureFile, report, mode, preparedFile, chromiumExecutable] = process.argv.slice(2)
  const durable = mode === '--durable'
  let browser
  let error
  let interrupted = false
  let timer
  const observed = {}
  let prepared
  const stop = () => {
    interrupted = true
    if (browser) void browser.close().catch(() => {})
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  try {
    if ((!durable && process.argv.length !== 5) || (durable && process.argv.length !== 8) ||
        process.platform !== 'linux') throw Error('invocation_refused')
    const fixture = readFixture(fixtureFile, durable)
    const native = createRequire(source + '/apps/sim/package.json')
    const version = native('@playwright/test/package.json').version
    if (version !== '1.61.1') throw Error('browser_version_refused')
    const { chromium } = native('@playwright/test')
    timer = setTimeout(stop, 900000)
    if (durable) {
      if (process.getuid?.() !== 1001 || !path.isAbsolute(chromiumExecutable) ||
          path.normalize(chromiumExecutable) !== chromiumExecutable) throw Error('browser_identity_refused')
      // The parent imports the reviewed fixture CA into this process HOME's NSS
      // database only. Default certificate validation remains enabled.
      process.env.TMPDIR = path.join(process.cwd(), 'tmp')
      fs.mkdirSync(process.env.TMPDIR, { mode: 0o700 })
      prepared = readFixtureData(preparedFile)
      browser = await chromium.launchPersistentContext(path.join(process.cwd(), 'profile'), {
        headless: true, executablePath: chromiumExecutable, serviceWorkers: 'block',
        args: ['--host-resolver-rules=MAP localhost 127.0.0.1'],
        viewport: { width: 1440, height: 1000 }, downloadsPath: path.join(process.cwd(), 'downloads'),
      })
    } else browser = await chromium.launch({ headless: true })
    if (interrupted) throw Error('interrupted')
    const context = durable ? browser : await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      serviceWorkers: 'block',
    })
    const origins = [fixture.origin, fixture.realtimeOrigin]
    await context.route('**/*', (route) =>
      allowedOrigin(route.request().url(), origins)
        ? route.continue()
        : route.abort('blockedbyclient')
    )
    await context.routeWebSocket('**/*', (ws) =>
      allowedOrigin(ws.url(), origins)
        ? ws.connectToServer()
        : ws.close({ code: 1008, reason: 'blocked' })
    )
    if (durable) await durableJourney(await context.newPage(), fixture, prepared, observed, (phase, value) => {
      fs.writeFileSync(report + '.' + phase + '.private.json', JSON.stringify(value) + '\n',
        { flag: 'wx', mode: 0o600 })
    })
    else await journey(await context.newPage(), fixture, observed)
  } catch (caught) {
    if (durable) {
      try {
        fs.writeFileSync(report + '.failure.private.txt',
          Buffer.from(caught instanceof Error ? caught.stack || caught.message : 'unknown_native_failure').subarray(0, 65536),
          { flag: 'wx', mode: 0o600 })
      } catch { /* Retain an unknown/pre-existing diagnostic, never overwrite it. */ }
    }
    error = caught
  } finally {
    try {
      if (browser) await browser.close()
      observed.browserClosed = true
    } catch {
      observed.browserClosed = false
    }
    clearTimeout(timer)
    process.off('SIGTERM', stop)
    process.off('SIGINT', stop)
  }
  const receipt = durable ? {
    status: !error && !interrupted && ['authenticated', 'deployed', 'queued', 'browserClosed'].every(k => observed[k] === true)
      ? 'passed' : 'failed', scope: 'native_session_durable_submission',
    ...Object.fromEntries(['authenticated', 'deployed', 'queued', 'browserClosed'].map(k => [k, observed[k] === true])),
    workflowId: prepared?.workflowId, workspaceId: prepared?.workspaceId,
    deploymentVersionId: observed.deploymentVersionId, executionId: observed.executionId, jobId: observed.jobId,
  } : finalReceipt(observed, error || interrupted)
  fs.writeFileSync(report, JSON.stringify(receipt) + '\n', { flag: 'wx', mode: 0o600 })
  process.exitCode = receipt.status === 'passed' ? 0 : 1
}
function readFixtureData(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  try {
    const info = fs.fstatSync(fd)
    if (!info.isFile() || info.nlink !== 1 || info.uid !== 1001 || info.size > 4096 ||
        (info.mode & 0o077) !== 0) throw Error('durable_fixture_refused')
    const raw = Buffer.alloc(4097)
    const count = fs.readSync(fd, raw, 0, raw.length, 0)
    const after = fs.fstatSync(fd)
    if (count !== info.size || count > 4096 || after.size !== info.size ||
        after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) throw Error('durable_fixture_refused')
    return JSON.parse(raw.subarray(0, count))
  } finally { fs.closeSync(fd) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main().catch(() => {
    process.exitCode = 1
  })
