// Copyright (c) 2026 Memlia. All rights reserved.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { AgentControlRequestSchema, AgentControlResponseSchema } from '../src/index.ts'
import { artifact, fixtures, hash } from './fixtures.ts'

const command = { commandId: 'command-fixture', digest: hash, leaseEpoch: 4 }
const req = { schemaVersion: 'memlia.agent-control-request/v1', requestId: 'request-fixture' }
const res = { schemaVersion: 'memlia.agent-control-response/v1', requestId: 'request-fixture' }
const requests = [
  fixtures.AgentControlRequest,
  { ...req, op: 'checkpoint', command, capabilityId: null },
  { ...req, op: 'consent', command, observation: {
    ...fixtures.AgentControlRequest.session, consentId: 'consent-fixture',
    confirmedLocallyAt: '2026-10-19T03:00:00.000Z', commandDigest: hash,
  } },
  { ...req, op: 'artifact.read', command, capabilityId: null, reference: artifact, offset: 0, limit: 262144 },
  { ...req, op: 'artifact.put', command, capabilityId: 'cap-fixture', reference: artifact,
    offset: 0, totalBytes: 1, dataBase64: 'YQ==' },
  { ...req, op: 'publish', command, capabilityId: 'cap-fixture', receipt: fixtures.RunReceipt, artifacts: [artifact] },
]
const responses = [
  { ...res, op: 'claim', command: fixtures.AgentCommand },
  { ...res, op: 'checkpoint', accepted: true },
  { ...res, op: 'consent', capability: fixtures.SessionCapability },
  { ...res, op: 'artifact.read', reference: artifact, offset: 0, totalBytes: 1, dataBase64: 'YQ==', done: true },
  { ...res, op: 'artifact.put', reference: artifact, nextOffset: 1, complete: true },
  { ...res, op: 'publish', accepted: true },
  { ...res, op: 'refused', code: 'control_refused' },
  fixtures.AgentControlResponse,
]

test('control operations remain closed and retain each valid body without coercion', () => {
  for (const value of requests) assert.deepEqual(AgentControlRequestSchema.parse(value), value)
  for (const value of responses) assert.deepEqual(AgentControlResponseSchema.parse(value), value)
  for (const value of requests) {
    assert.equal(AgentControlRequestSchema.safeParse({ ...value, workspaceId: 'forged' }).success, false)
    assert.equal(AgentControlRequestSchema.safeParse({ ...value, schemaVersion: req.schemaVersion + '.future' }).success, false)
  }
  assert.equal(AgentControlResponseSchema.safeParse({ ...res, op: 'refused', code: 'private-database-error' }).success, false)
})

const rejected = [
  { ...requests[0], session: { windowsSid: 'wrong', sessionId: 'session-fixture' } },
  { ...requests[1], capabilityId: undefined },
  { ...requests[2], observation: { commandDigest: hash } },
  { ...requests[3], offset: 34603009 },
  { ...requests[3], limit: 262145 },
  { ...requests[3], reference: { ...artifact, path: '/not-accepted' } },
  { ...requests[4], capabilityId: null },
  { ...requests[4], dataBase64: 'YQ==\n' },
  { ...requests[4], totalBytes: 34603009 },
  { ...requests[4], offset: -1 },
  { ...requests[5], artifacts: Array(129).fill(artifact) },
]
test('control rejects missing authority fields, arbitrary paths and oversized transfers', () => {
  for (const value of rejected) assert.equal(AgentControlRequestSchema.safeParse(value).success, false)
  assert.equal(AgentControlRequestSchema.safeParse({ ...requests[4], dataBase64: 'A'.repeat(349532) }).success, false)
  assert.equal(AgentControlRequestSchema.safeParse({ ...requests[3], offset: 34603008 }).success, true)
})

test('generated Python schemas agree on all operations and negative bodies', () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const samples = [
    ...requests.map(value => ['AgentControlRequest', value, true]),
    ...responses.map(value => ['AgentControlResponse', value, true]),
    ...rejected.map(value => ['AgentControlRequest', value, false]),
  ]
  const result = spawnSync(process.env.MEMLIA_CONTRACT_PYTHON ?? 'python3', ['-B', '-c',
    'import json,sys; from memlia_contracts import validate\nfor name,value,expected in json.load(sys.stdin):\n try: validate(name,value); actual=True\n except Exception: actual=False\n if actual != expected: raise AssertionError(name)\nprint("control_schema_interop_pass")'], {
    input: JSON.stringify(samples), encoding: 'utf8', timeout: 15000,
    env: { ...process.env, PYTHONPATH: root + 'python' },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), 'control_schema_interop_pass')
})
