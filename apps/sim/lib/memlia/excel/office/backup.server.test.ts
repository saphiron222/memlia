// Copyright (c) 2026 Memlia. All rights reserved.
import { createHash } from 'node:crypto'
import { createSessionPrincipal } from '@sim/testing/factories/principal.factory'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ create: vi.fn(), read: vi.fn() }))
vi.mock('@/lib/workspace-files/application/office-backups', async (original) => ({
  ...(await original<typeof import('@/lib/workspace-files/application/office-backups')>()),
  createPrivateOfficeBackup: mocks.create,
  readPrivateOfficeBackup: mocks.read,
}))

import { OfficeBackupStorageUnknownError } from '@/lib/uploads/contexts/workspace/file-manager'
import { persistOfficeCompressedCopy } from './backup.server'

const p = () => createSessionPrincipal({ userId: 'user-1', sessionId: 'session-1' })
const bytes = Buffer.from([0, 255, 128, 42])
const file = Object.freeze({
  id: 'wf_private',
  workspaceId: 'workspace-1',
  userId: 'user-1',
  key: 'workspace/workspace-1/office-backups/wf_private.xlsx',
  size: 4,
  version: 1000,
})
const input = () => ({
  workspaceId: 'workspace-1',
  copyVersion: 1 as const,
  bytes: Buffer.from(bytes),
})

describe('Office copy storage receipt (authorized storage use cases doubled)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.create.mockResolvedValue(file)
    mocks.read.mockResolvedValue({ file, content: Buffer.from(bytes) })
  })

  it('returns a storage-only receipt after exact version, size and hash readback', async () => {
    const result = await persistOfficeCompressedCopy(p(), input())
    expect(result).toEqual({
      status: 'stored',
      receipt: {
        schemaVersion: 'memlia.office-copy-storage/v1',
        workspaceId: 'workspace-1',
        ownerUserId: 'user-1',
        fileId: file.id,
        contentVersion: 1000,
        byteLength: 4,
        sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      },
    })
    expect(mocks.read).toHaveBeenCalledWith(
      p(),
      { workspaceId: 'workspace-1', fileId: file.id, version: 1000 },
      undefined
    )
  })

  it('captures authority and bytes before awaiting creation', async () => {
    const principal = p()
    const supplied = input()
    mocks.create.mockImplementation(async () => {
      principal.userId = 'user-2'
      supplied.workspaceId = 'workspace-2'
      supplied.bytes.fill(5)
      return file
    })
    await expect(persistOfficeCompressedCopy(principal, supplied)).resolves.toMatchObject({
      status: 'stored',
      receipt: { ownerUserId: 'user-1', workspaceId: 'workspace-1' },
    })
    expect(mocks.create.mock.calls[0][1].content).toEqual(bytes)
    expect(mocks.read.mock.calls[0][0].userId).toBe('user-1')
  })

  it('distinguishes unknown creation without retry, readback or deletion', async () => {
    mocks.create.mockRejectedValue(new OfficeBackupStorageUnknownError(file))
    await expect(persistOfficeCompressedCopy(p(), input())).resolves.toEqual({
      status: 'unconfirmed',
      code: 'office_backup_storage_unknown',
      stage: 'creation_unknown',
      fileId: file.id,
    })
    expect(mocks.create).toHaveBeenCalledTimes(1)
    expect(mocks.read).not.toHaveBeenCalled()
  })

  it('never reports no creation when the completed creation returns an invalid version', async () => {
    mocks.create.mockResolvedValue({ ...file, version: Number.NaN })
    await expect(persistOfficeCompressedCopy(p(), input())).resolves.toMatchObject({
      status: 'unconfirmed',
      stage: 'created_unverified',
    })
    expect(mocks.read).not.toHaveBeenCalled()
  })

  it.each([
    { file: { ...file, version: 2000 }, content: bytes },
    { file: { ...file, userId: 'user-2' }, content: bytes },
    { file: { ...file, workspaceId: 'workspace-2' }, content: bytes },
    { file, content: Buffer.from([0, 255, 128, 43]) },
    { file, content: Buffer.from([0, 255]) },
  ])('does not confirm a different readback identity, version, size or digest %#', async (read) => {
    mocks.read.mockResolvedValue(read)
    await expect(persistOfficeCompressedCopy(p(), input())).resolves.toEqual({
      status: 'unconfirmed',
      code: 'office_backup_refused',
      stage: 'created_unverified',
      fileId: file.id,
    })
    expect(mocks.create).toHaveBeenCalledTimes(1)
  })

  it('cancels before creation with no write attempted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(persistOfficeCompressedCopy(p(), input(), controller.signal)).resolves.toEqual({
      status: 'refused',
      code: 'office_backup_cancelled',
      stage: 'before_creation',
      fileId: null,
    })
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('keeps a confirmed creation distinct when cancellation prevents readback', async () => {
    const controller = new AbortController()
    mocks.create.mockImplementation(async () => {
      controller.abort()
      return file
    })
    await expect(persistOfficeCompressedCopy(p(), input(), controller.signal)).resolves.toEqual({
      status: 'unconfirmed',
      code: 'office_backup_cancelled',
      stage: 'created_unverified',
      fileId: file.id,
    })
    expect(mocks.read).not.toHaveBeenCalled()
  })

  it('keeps cancellation and an unknown creation outcome distinct', async () => {
    const controller = new AbortController()
    mocks.create.mockImplementation(async () => {
      controller.abort()
      throw new OfficeBackupStorageUnknownError(file)
    })
    await expect(persistOfficeCompressedCopy(p(), input(), controller.signal)).resolves.toEqual({
      status: 'unconfirmed',
      code: 'office_backup_cancelled',
      stage: 'creation_unknown',
      fileId: file.id,
    })
    expect(mocks.create).toHaveBeenCalledTimes(1)
  })

  it('refuses an unsupported copy format and never reflects private causes', async () => {
    await expect(
      persistOfficeCompressedCopy(p(), { ...input(), copyVersion: 2 as 1 })
    ).resolves.toMatchObject({ status: 'refused', stage: 'before_creation' })
    expect(mocks.create).not.toHaveBeenCalled()
    mocks.create.mockResolvedValue(file)
    mocks.read.mockRejectedValue(new Error('private-cause-never-delivered'))
    const result = await persistOfficeCompressedCopy(p(), input())
    expect(result).toMatchObject({ status: 'unconfirmed', stage: 'created_unverified' })
    expect(JSON.stringify(result)).not.toContain('private-cause')
  })

  it('refuses an accessor input without evaluating it', async () => {
    const supplied = input()
    const read = vi.fn(() => 'workspace-1')
    Object.defineProperty(supplied, 'workspaceId', { get: read })
    await expect(persistOfficeCompressedCopy(p(), supplied)).resolves.toMatchObject({
      status: 'refused',
      stage: 'before_creation',
    })
    expect(read).not.toHaveBeenCalled()
    expect(mocks.create).not.toHaveBeenCalled()
  })
})
