// Copyright 2026 Memlia. All rights reserved.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { allowedOrigin, finalReceipt, graphIds, responseAfterClick } from './linux-chat-browser.mjs'
const origins = ['http://localhost:3000', 'http://localhost:3002']
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
  const n = 'a'.repeat(32),
    web = `postgres://ui_web_${n}:fictitious@database:5432/memlia_ui_${n}`
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
    const file = path.join(d, 'fixture.json'),
      value = {
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
  let spinner = false,
    width = 30,
    height = 30,
    opacity = '1',
    missing = false
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
  const page = new EventEmitter(),
    connected = observeSocket(page, { origin: origins[0], realtimeOrigin: origins[1] })
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
