// Copyright (c) 2026 Memlia. All rights reserved.
import { createHash } from 'node:crypto'
import type { SessionPrincipal } from '@sim/auth/principal'
import { beforeEach, expect, test, vi } from 'vitest'
import { OrchestrationError } from '@/lib/core/orchestration/types'
import type { WorkspaceFileRecord } from '@/lib/uploads/contexts/workspace/file-manager'
import {
  type InboxSnapshotBinding,
  persistInboxSnapshot,
  resumeInboxSnapshot,
} from './inbox-snapshot.server'

// Only infrastructure ports are doubled: no PostgreSQL, filesystem inbox, or job is exercised.
const ports = vi.hoisted(() => ({
  canonical: vi.fn(),
  authorize: vi.fn(),
  create: vi.fn(),
  read: vi.fn(),
}))
vi.mock('@/lib/workflows/application/context', () => ({
  resolveActiveWorkflowDeploymentVersionApplicationContext: ports.canonical,
}))
vi.mock('@/lib/core/application', () => ({ authorizeWorkspaceOperation: ports.authorize }))
vi.mock('@/lib/workspace-files/application/create-workspace-file', () => ({
  createWorkspaceFileFromBuffer: { execute: ports.create },
}))
vi.mock('@/lib/workspace-files/application/read-workspace-file-content', () => ({
  readWorkspaceFileContent: { execute: ports.read },
}))

const principal: SessionPrincipal = {
  kind: 'session',
  userId: 'subject-fixture',
  sessionId: 'session-fixture',
}
function binding(): InboxSnapshotBinding {
  return {
    organizationId: 'organization-fixture',
    workspaceId: 'workspace-fixture',
    workflowId: 'workflow-fixture',
    deployedVersionId: 'deployment-fixture',
    subjectUserId: 'subject-fixture',
    bindingId: 'binding-fixture',
    bindingVersion: 1,
    procedureDigest: `sha256:${'a'.repeat(64)}`,
    role: 'source',
    sheetName: 'Sheet1',
    folderId: null,
  }
}
function snapshot(content = Buffer.from('fictitious snapshot bytes, not a validated workbook')) {
  return {
    name: 'input.xlsx',
    content,
    sha256: `sha256:${createHash('sha256').update(content).digest('hex')}`,
  }
}
function stored(name: string, content: Buffer): WorkspaceFileRecord {
  return {
    id: 'file-fixture',
    workspaceId: 'workspace-fixture',
    name,
    key: 'workspace/workspace-fixture/owned-key',
    path: '/api/files/serve/owned-key',
    size: content.length,
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    uploadedBy: 'subject-fixture',
    folderId: null,
    uploadedAt: new Date('2026-10-20T00:00:00Z'),
    updatedAt: new Date('2026-10-20T00:00:00Z'),
    contentUpdatedAt: new Date('2026-10-20T00:00:00Z'),
    storageContext: 'workspace',
  }
}
beforeEach(() => {
  vi.resetAllMocks()
  ports.canonical.mockResolvedValue({
    workflowId: 'workflow-fixture',
    workspaceId: 'workspace-fixture',
    workspaceOrganizationId: 'organization-fixture',
    deploymentVersionId: 'deployment-fixture',
    billedAccountUserId: 'billing-fixture',
    allowPersonalApiKeys: false,
  })
  ports.authorize.mockResolvedValue(undefined)
  ports.create.mockImplementation(async ({ input }) => {
    const file = stored(input.name, input.content)
    ports.read.mockResolvedValue({
      file,
      content: Buffer.from(input.content),
      secretProvenance: { status: 'unrecorded' },
    })
    return { file }
  })
})

test('persists owned bytes and yields an explicit file selection only after native readback', async () => {
  const input = snapshot()
  const result = await persistInboxSnapshot(principal, binding(), 'delivery-fixture-1', input)
  expect(result.status).toBe('verified')
  if (result.status !== 'verified') throw new Error('expected verified receipt')
  expect(result.executionAvailable).toBe(false)
  expect(result.durableOccurrenceAdmitted).toBe(false)
  expect(result.sources).toEqual({ source: { fileId: 'file-fixture', sheetName: 'Sheet1' } })
  expect(result.receipt).toMatchObject({
    schemaVersion: 'memlia.inbox-snapshot/v1',
    occurrenceId: 'delivery-fixture-1',
    originalName: 'input.xlsx',
    fileId: 'file-fixture',
    sha256: input.sha256,
    contentVersion: Date.parse('2026-10-20T00:00:00Z'),
    secretProvenance: { status: 'unrecorded' },
  })
  expect(ports.create).toHaveBeenCalledWith({
    principal,
    input: {
      workspaceId: 'workspace-fixture',
      folderId: null,
      name: `inbox-${result.receipt.occurrenceKey.slice(7)}.xlsx`,
      exactName: true,
      content: input.content,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      secretProvenance: { status: 'unrecorded' },
      notifyWorkspaceChange: false,
    },
  })
  expect(ports.read).toHaveBeenCalledWith({
    principal,
    input: {
      fileId: 'file-fixture',
      assertedWorkspaceId: 'workspace-fixture',
      maxBytes: 10_000_000,
      includeSecretProvenance: true,
    },
  })
})

test('resumes only the persisted file id under fresh native authority without creating another copy', async () => {
  const initial = await persistInboxSnapshot(principal, binding(), 'delivery-fixture-1', snapshot())
  if (initial.status !== 'verified') throw new Error('expected initial receipt')
  ports.create.mockClear()
  ports.read.mockClear()
  ports.authorize.mockClear()
  // A serialized receipt survives process restart; there is no in-memory admission handle.
  const result = await resumeInboxSnapshot(
    principal,
    binding(),
    JSON.parse(JSON.stringify(initial.receipt))
  )
  expect(result).toEqual(initial)
  expect(ports.create).not.toHaveBeenCalled()
  expect(ports.read).toHaveBeenCalledTimes(1)
  expect(ports.authorize).toHaveBeenCalledTimes(2)
})

test('denies forged scope before a storage call', async () => {
  const result = await persistInboxSnapshot(
    principal,
    { ...binding(), subjectUserId: 'other' },
    'delivery-fixture-1',
    snapshot()
  )
  expect(result).toEqual({
    status: 'refused',
    code: 'inbox_snapshot_refused',
    stage: 'before_creation',
    fileId: null,
  })
  expect(ports.create).not.toHaveBeenCalled()
})

test('takes the content version from the native readback when the create DTO omits it', async () => {
  ports.create.mockImplementationOnce(async ({ input }) => {
    const file = stored(input.name, input.content)
    ports.read.mockResolvedValue({
      file,
      content: input.content,
      secretProvenance: { status: 'unrecorded' },
    })
    const { contentUpdatedAt: _, ...created } = file
    return { file: created }
  })
  const result = await persistInboxSnapshot(principal, binding(), 'delivery-fixture-1', snapshot())
  expect(result.status).toBe('verified')
  if (result.status !== 'verified') throw new Error('expected readback version')
  expect(result.receipt.contentVersion).toBe(1792454400000)
})

test('accepts the native workspace mapper that omits the optional storageContext discriminator', async () => {
  ports.create.mockImplementationOnce(async ({ input }) => {
    const { storageContext: _, ...file } = stored(input.name, input.content)
    ports.read.mockResolvedValue({
      file,
      content: input.content,
      secretProvenance: { status: 'unrecorded' },
    })
    return { file }
  })
  expect(
    (await persistInboxSnapshot(principal, binding(), 'delivery-fixture-1', snapshot())).status
  ).toBe('verified')
})

test('captures bytes, principal and configuration before an asynchronous authorization can mutate them', async () => {
  const subject = { ...principal }
  const config = binding()
  const input = snapshot()
  const bytes = Buffer.from(input.content)
  ports.canonical.mockImplementationOnce(async () => {
    subject.userId = 'other'
    config.folderId = 'other-folder'
    config.sheetName = 'Other'
    config.bindingVersion = 2
    input.content.fill(0)
    input.name = 'mutated.xlsx'
    return {
      workflowId: 'workflow-fixture',
      workspaceId: 'workspace-fixture',
      workspaceOrganizationId: 'organization-fixture',
      deploymentVersionId: 'deployment-fixture',
    }
  })
  const result = await persistInboxSnapshot(subject, config, 'delivery-fixture-1', input)
  expect(result.status).toBe('verified')
  if (result.status !== 'verified') throw new Error('expected captured input')
  expect(result.receipt.binding.bindingVersion).toBe(1)
  expect(result.receipt.originalName).toBe('input.xlsx')
  expect(result.sources).toEqual({ source: { fileId: 'file-fixture', sheetName: 'Sheet1' } })
  expect(ports.create.mock.calls[0][0].input.content).toEqual(bytes)
  expect(ports.create.mock.calls[0][0].principal).toEqual(principal)
})

test.each([
  '../input.xlsx',
  'dir/input.xlsx',
  'dir\\input.xlsx',
  'input.xlsx:stream',
  'CON.xlsx',
  'NUL.xlsx',
  'COM1.xlsx',
  'LPT9.xlsx',
  'input.xlsx ',
  'input.xlsx\n',
  'input.csv',
  `${'x'.repeat(256)}.xlsx`,
  '\ud800.xlsx',
])('refuses the source basename %j before any authority or storage I/O', async (name) => {
  const result = await persistInboxSnapshot(principal, binding(), 'delivery-fixture-1', {
    ...snapshot(),
    name,
  })
  expect(result.status).toBe('refused')
  expect(ports.canonical).not.toHaveBeenCalled()
  expect(ports.create).not.toHaveBeenCalled()
})

test.each([Buffer.alloc(0), Buffer.alloc(10_000_001)])(
  'refuses an empty or over-limit buffer before I/O',
  async (content) => {
    expect(
      (await persistInboxSnapshot(principal, binding(), 'delivery-fixture-1', snapshot(content)))
        .status
    ).toBe('refused')
    expect(ports.canonical).not.toHaveBeenCalled()
  }
)

test('refuses the digest mismatch, accessor, extra path and non-Buffer instead of invoking/coercing them', async () => {
  const getter = vi.fn(() => Buffer.from('canary'))
  const accessed = { name: 'input.xlsx', sha256: snapshot().sha256 }
  Object.defineProperty(accessed, 'content', { enumerable: true, get: getter })
  for (const input of [
    { ...snapshot(), sha256: `sha256:${'b'.repeat(64)}` },
    accessed,
    { ...snapshot(), path: '/private/path' },
    { ...snapshot(), content: [1, 2, 3] },
  ])
    expect(
      (await persistInboxSnapshot(principal, binding(), 'delivery-fixture-1', input)).status
    ).toBe('refused')
  expect(getter).not.toHaveBeenCalled()
  expect(ports.create).not.toHaveBeenCalled()
})

test.each(['organizationId', 'workspaceId', 'workflowId', 'deploymentVersionId'])(
  'refuses canonical %s mismatch before creation',
  async (field) => {
    const native = await ports.canonical()
    const key = field === 'organizationId' ? 'workspaceOrganizationId' : field
    ports.canonical.mockResolvedValue({ ...native, [key]: 'other' })
    expect(
      (await persistInboxSnapshot(principal, binding(), 'delivery-fixture-1', snapshot())).status
    ).toBe('refused')
    expect(ports.create).not.toHaveBeenCalled()
  }
)

test('refuses non-session authority and unknown binding fields instead of fabricating a user session', async () => {
  for (const candidate of [
    { kind: 'system', service: 'schedule' },
    { kind: 'personal_api_key', userId: principal.userId, keyId: 'key' },
  ]) {
    expect(
      (
        await Reflect.apply(persistInboxSnapshot, undefined, [
          candidate,
          binding(),
          'delivery-fixture-1',
          snapshot(),
        ])
      ).status
    ).toBe('refused')
  }
  expect(
    (
      await persistInboxSnapshot(
        principal,
        { ...binding(), triggerType: 'schedule' },
        'delivery-fixture-1',
        snapshot()
      )
    ).status
  ).toBe('refused')
  expect(ports.canonical).not.toHaveBeenCalled()
})

test('permission refusal contains no raw cause and never reaches storage', async () => {
  ports.authorize.mockRejectedValue(new Error('sensitive-driver-canary'))
  const result = await persistInboxSnapshot(principal, binding(), 'delivery-fixture-1', snapshot())
  expect(result).toEqual({
    status: 'refused',
    code: 'inbox_snapshot_refused',
    stage: 'before_creation',
    fileId: null,
  })
  expect(JSON.stringify(result)).not.toContain('canary')
  expect(ports.create).not.toHaveBeenCalled()
})

test('retains the native case-insensitive XLSX suffix without renaming the source receipt', async () => {
  const result = await persistInboxSnapshot(principal, binding(), 'delivery-fixture-1', {
    ...snapshot(),
    name: 'Input.XLSX',
  })
  expect(result.status).toBe('verified')
  if (result.status !== 'verified') throw new Error('expected native XLSX input')
  expect(result.receipt.originalName).toBe('Input.XLSX')
})

test('a native exact-name conflict is retained without lookup, overwrite, retry or idempotent success', async () => {
  const saved = new Map<string, Buffer>()
  ports.create.mockImplementation(async ({ input }) => {
    if (saved.has(input.name)) throw new OrchestrationError('conflict', 'native-canary')
    saved.set(input.name, Buffer.from(input.content))
    const file = stored(input.name, input.content)
    ports.read.mockResolvedValue({
      file,
      content: input.content,
      secretProvenance: { status: 'unrecorded' },
    })
    return { file }
  })
  const one = await persistInboxSnapshot(principal, binding(), 'delivery-fixture-1', snapshot())
  const two = await persistInboxSnapshot(
    principal,
    binding(),
    'delivery-fixture-1',
    snapshot(Buffer.from('changed content'))
  )
  expect(one.status).toBe('verified')
  expect(two).toEqual({
    status: 'refused',
    code: 'inbox_snapshot_conflict',
    stage: 'creation_unknown',
    fileId: null,
  })
  expect(saved.size).toBe(1)
  expect(ports.create).toHaveBeenCalledTimes(2)
  expect(ports.read).toHaveBeenCalledTimes(1)
  expect([...saved.values()][0]).toEqual(snapshot().content)
})

test('the same filename with a new business occurrence produces another file key', async () => {
  const one = await persistInboxSnapshot(principal, binding(), 'delivery-fixture-1', snapshot())
  const two = await persistInboxSnapshot(
    principal,
    binding(),
    'delivery-fixture-2',
    snapshot(Buffer.from('different'))
  )
  expect(one.status).toBe('verified')
  expect(two.status).toBe('verified')
  if (one.status !== 'verified' || two.status !== 'verified')
    throw new Error('expected distinct selections')
  expect(one.receipt.occurrenceKey).not.toBe(two.receipt.occurrenceKey)
  expect(ports.create.mock.calls[0][0].input.name).not.toBe(
    ports.create.mock.calls[1][0].input.name
  )
})

test('creation and post-creation uncertainty remain distinct and never delete or retry', async () => {
  ports.create.mockRejectedValueOnce(new Error('write-commit-canary'))
  expect(
    await persistInboxSnapshot(principal, binding(), 'delivery-fixture-1', snapshot())
  ).toEqual({
    status: 'refused',
    code: 'inbox_snapshot_refused',
    stage: 'creation_unknown',
    fileId: null,
  })
  ports.create.mockImplementationOnce(async ({ input }) => ({
    file: stored(input.name, input.content),
  }))
  ports.read.mockRejectedValue(new Error('read-canary'))
  expect(
    await persistInboxSnapshot(principal, binding(), 'delivery-fixture-2', snapshot())
  ).toEqual({
    status: 'refused',
    code: 'inbox_snapshot_refused',
    stage: 'created_unverified',
    fileId: 'file-fixture',
  })
  expect(ports.create).toHaveBeenCalledTimes(2)
})

test('permission revoked during readback retains the created file without publishing a verified receipt', async () => {
  ports.authorize
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error('revoked-canary'))
  expect(
    await persistInboxSnapshot(principal, binding(), 'delivery-fixture-1', snapshot())
  ).toEqual({
    status: 'refused',
    code: 'inbox_snapshot_refused',
    stage: 'created_unverified',
    fileId: 'file-fixture',
  })
})

test('aborts before any I/O and after a completed write without declaring a verified snapshot', async () => {
  const before = new AbortController()
  before.abort('private-canary')
  const result = await persistInboxSnapshot(
    principal,
    binding(),
    'delivery-fixture-1',
    snapshot(),
    before.signal
  )
  expect(result).toEqual({
    status: 'refused',
    code: 'inbox_snapshot_refused',
    stage: 'before_creation',
    fileId: null,
  })
  expect(ports.create).not.toHaveBeenCalled()
  const during = new AbortController()
  ports.create.mockImplementationOnce(async ({ input }) => {
    during.abort('other-canary')
    return { file: stored(input.name, input.content) }
  })
  expect(
    await persistInboxSnapshot(
      principal,
      binding(),
      'delivery-fixture-2',
      snapshot(),
      during.signal
    )
  ).toEqual({
    status: 'refused',
    code: 'inbox_snapshot_refused',
    stage: 'created_unverified',
    fileId: 'file-fixture',
  })
  expect(ports.read).not.toHaveBeenCalled()
})

test.each([
  'id',
  'workspaceId',
  'uploadedBy',
  'folderId',
  'name',
  'key',
  'type',
  'size',
  'contentUpdatedAt',
  'storageContext',
  'deletedAt',
])('refuses resumed file %s drift', async (field) => {
  const initial = await persistInboxSnapshot(principal, binding(), 'delivery-fixture-1', snapshot())
  if (initial.status !== 'verified') throw new Error('expected initial receipt')
  const current = await ports.read()
  const changed = {
    ...current.file,
    [field]: field === 'contentUpdatedAt' ? new Date('2026-10-20T00:00:01Z') : 'other',
  }
  ports.read.mockResolvedValue({ ...current, file: changed })
  expect(await resumeInboxSnapshot(principal, binding(), initial.receipt)).toEqual({
    status: 'refused',
    code: 'inbox_snapshot_refused',
    stage: 'resume_unverified',
    fileId: null,
  })
})

test.each([undefined, { status: 'unknown' }, { status: 'exact', entries: [] }])(
  'does not upgrade or lose secret provenance during resume: %j',
  async (secretProvenance) => {
    const initial = await persistInboxSnapshot(
      principal,
      binding(),
      'delivery-fixture-1',
      snapshot()
    )
    if (initial.status !== 'verified') throw new Error('expected initial receipt')
    const current = await ports.read()
    ports.read.mockResolvedValue({ ...current, secretProvenance })
    expect((await resumeInboxSnapshot(principal, binding(), initial.receipt)).status).toBe(
      'refused'
    )
  }
)

test('resume rejects changed bytes even if the database version was left unchanged', async () => {
  const initial = await persistInboxSnapshot(principal, binding(), 'delivery-fixture-1', snapshot())
  if (initial.status !== 'verified') throw new Error('expected initial receipt')
  const current = await ports.read()
  const content = Buffer.from(current.content)
  content[0] ^= 1
  ports.read.mockResolvedValue({ ...current, content })
  expect((await resumeInboxSnapshot(principal, binding(), initial.receipt)).status).toBe('refused')
})

test('resume refuses binding, occurrence and hash tampering before reading the selected file', async () => {
  const initial = await persistInboxSnapshot(principal, binding(), 'delivery-fixture-1', snapshot())
  if (initial.status !== 'verified') throw new Error('expected initial receipt')
  ports.read.mockClear()
  for (const receipt of [
    { ...initial.receipt, occurrenceId: 'other' },
    { ...initial.receipt, binding: { ...binding(), bindingVersion: 2 } },
    { ...initial.receipt, occurrenceKey: `sha256:${'b'.repeat(64)}` },
  ])
    expect((await resumeInboxSnapshot(principal, binding(), receipt)).status).toBe('refused')
  expect(ports.read).not.toHaveBeenCalled()
})

test('reimports the adapter and resumes a serialized file receipt without a volatile admission registry', async () => {
  const initial = await persistInboxSnapshot(principal, binding(), 'delivery-fixture-1', snapshot())
  if (initial.status !== 'verified') throw new Error('expected initial receipt')
  const persisted = JSON.stringify(initial.receipt)
  vi.resetModules()
  const fresh = await import('./inbox-snapshot.server')
  ports.create.mockClear()
  expect(
    await fresh.resumeInboxSnapshot(
      { ...principal, sessionId: 'fresh-authenticated-session' },
      binding(),
      JSON.parse(persisted)
    )
  ).toEqual(initial)
  expect(ports.create).not.toHaveBeenCalled()
})

test.each([
  { bindingVersion: 2 },
  { bindingId: 'other-binding' },
  { procedureDigest: `sha256:${'c'.repeat(64)}` },
  { deployedVersionId: 'other-deployment' },
])('separates business occurrence namespaces when binding context changes: %j', async (change) => {
  const one = await persistInboxSnapshot(principal, binding(), 'delivery-fixture-1', snapshot())
  const config = { ...binding(), ...change }
  ports.canonical.mockResolvedValue({
    workflowId: config.workflowId,
    workspaceId: config.workspaceId,
    workspaceOrganizationId: config.organizationId,
    deploymentVersionId: config.deployedVersionId,
  })
  const two = await persistInboxSnapshot(principal, config, 'delivery-fixture-1', snapshot())
  if (one.status !== 'verified' || two.status !== 'verified')
    throw new Error('expected verified files')
  expect(two.receipt.occurrenceKey).not.toBe(one.receipt.occurrenceKey)
})

test('does not convert a late abort in the final authorization into a verified receipt', async () => {
  const signal = new AbortController()
  ports.authorize.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
    signal.abort('late-canary')
  })
  const result = await persistInboxSnapshot(
    principal,
    binding(),
    'delivery-fixture-1',
    snapshot(),
    signal.signal
  )
  expect(result).toEqual({
    status: 'refused',
    code: 'inbox_snapshot_refused',
    stage: 'created_unverified',
    fileId: 'file-fixture',
  })
})

test('checks an abort queued between the final authority completion and receipt delivery', async () => {
  const controller = new AbortController()
  ports.authorize.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
    queueMicrotask(() => queueMicrotask(() => controller.abort('delivery-canary')))
  })
  expect(
    await persistInboxSnapshot(
      principal,
      binding(),
      'delivery-fixture-1',
      snapshot(),
      controller.signal
    )
  ).toEqual({
    status: 'refused',
    code: 'inbox_snapshot_refused',
    stage: 'created_unverified',
    fileId: 'file-fixture',
  })
})

test('resume rechecks native file permission and returns no persisted metadata when it is denied', async () => {
  const initial = await persistInboxSnapshot(principal, binding(), 'delivery-fixture-1', snapshot())
  if (initial.status !== 'verified') throw new Error('expected initial receipt')
  ports.read.mockRejectedValueOnce(new OrchestrationError('forbidden', 'permission-canary'))
  expect(await resumeInboxSnapshot(principal, binding(), initial.receipt)).toEqual({
    status: 'refused',
    code: 'inbox_snapshot_refused',
    stage: 'resume_unverified',
    fileId: null,
  })
})
