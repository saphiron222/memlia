// Copyright (c) 2026 Memlia. All rights reserved.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { AgentCommandSchema, desktopCommandDigest } from '../src/index.ts'
import { fixtures, hash } from './fixtures.ts'

test('v2 replay requires an explicit mode and rejects the ambiguous v1 envelope', () => {
  const value = structuredClone(fixtures.AgentCommand)
  assert.equal(AgentCommandSchema.safeParse(value).success, true)
  assert.equal(AgentCommandSchema.safeParse({ ...value, schemaVersion: 'memlia.desktop-command/v1' }).success, false)
  const { mode: _mode, ...action } = value.action
  assert.equal(AgentCommandSchema.safeParse({ ...value, action }).success, false)
})

test('digest binds exact action, session, lifetime, fence and scope, excluding only digest', async () => {
  const base = fixtures.AgentCommand
  const expected = await desktopCommandDigest(base)
  assert.equal(await desktopCommandDigest({ ...base, digest: `sha256:${'b'.repeat(64)}` }), expected)
  for (const change of [
    { sessionId: 'another-session' }, { ownerUserId: 'another-user' },
    { workspaceId: 'another-workspace' }, { leaseEpoch: 5 },
    { expiresAt: '2026-10-19T03:00:31.000Z' },
    { resourceLocks: [{ ...base.resourceLocks[0], fence: 5 }] },
    { action: { ...base.action, mode: 'production' } },
  ]) assert.notEqual(await desktopCommandDigest({ ...base, ...change }), expected)
  assert.equal(await desktopCommandDigest(Object.fromEntries(Object.entries(base).reverse())), expected)
})

test('TS and generated Python contract consume the same bytes, including integer-valued JSON floats', async () => {
  const command = { ...fixtures.AgentCommand, digest: hash }
  const root = fileURLToPath(new URL('../', import.meta.url))
  const result = spawnSync(process.env.MEMLIA_CONTRACT_PYTHON ?? 'python3', ['-B', '-c',
    'import json,sys; from memlia_contracts import desktop_command_digest; v=json.load(sys.stdin); print(desktop_command_digest(v)); v["leaseEpoch"]=float(v["leaseEpoch"]); print(desktop_command_digest(v))'], {
    input: JSON.stringify(command), encoding: 'utf8', timeout: 10000,
    env: { ...process.env, PYTHONPATH: root + 'python' },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.stdout.trim().split('\n'), [await desktopCommandDigest(command), await desktopCommandDigest(command)])
})
