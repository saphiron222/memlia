// Copyright (c) 2026 Memlia. All rights reserved.
import {
  createSessionPrincipal,
  createWorkspaceApiKeyPrincipal,
} from '@sim/testing/factories/principal.factory'
import { workspaceAuthzMock, workspaceAuthzMockFns } from '@sim/testing/mocks/workspace-authz.mock'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  workspace: vi.fn(),
  plan: vi.fn(),
  create: vi.fn(),
  read: vi.fn(),
  download: vi.fn(),
}))
vi.mock('@sim/platform-authz/workspace', () => workspaceAuthzMock)
vi.mock('@/lib/uploads/contexts/workspace/file-manager', async (original) => ({
  ...(await original<typeof import('@/lib/uploads/contexts/workspace/file-manager')>()),
  loadActiveWorkspaceContext: mocks.workspace,
  planOfficeBackupFileIdentity: mocks.plan,
  createOfficeBackupFile: mocks.create,
  readOfficeBackupFileRecord: mocks.read,
}))
vi.mock('@/lib/uploads/core/storage-service', () => ({ downloadFile: mocks.download }))

import { createPrivateOfficeBackup, readPrivateOfficeBackup } from './office-backups'

const identity = Object.freeze({
  id: 'wf_private',
  key: 'workspace/workspace-1/office-backups/wf_private.xlsx',
  workspaceId: 'workspace-1',
  userId: 'user-1',
})
const file = Object.freeze({ ...identity, size: 3, version: 1000 })
const principal = () => createSessionPrincipal({ userId: 'user-1', sessionId: 'session-1' })
const permission = workspaceAuthzMockFns.mockResolveEffectiveWorkspacePermission
const selection = () => ({ workspaceId: 'workspace-1', fileId: identity.id, version: 1000 })

describe('private Office backup authorized use cases (I/O doubled)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.workspace.mockResolvedValue({
      workspaceId: 'workspace-1',
      workspaceOrganizationId: null,
      allowPersonalApiKeys: true,
      billedAccountUserId: 'billing-owner',
    })
    permission.mockResolvedValue('write')
    mocks.plan.mockReturnValue(identity)
    mocks.create.mockResolvedValue(file)
    mocks.read.mockResolvedValue(file)
    mocks.download.mockResolvedValue(Buffer.from([0, 255, 1]))
  })

  it('captures binary bytes and the authenticated session before an authorization await', async () => {
    const p = principal()
    const input = { workspaceId: 'workspace-1', content: Buffer.from([0, 255, 1]) }
    mocks.workspace.mockImplementation(async () => {
      p.userId = 'user-2'
      input.workspaceId = 'workspace-2'
      input.content.fill(42)
      return {
        workspaceId: 'workspace-1',
        workspaceOrganizationId: null,
        allowPersonalApiKeys: true,
        billedAccountUserId: 'billing-owner',
      }
    })
    await expect(createPrivateOfficeBackup(p, input)).resolves.toEqual(file)
    expect(mocks.plan).toHaveBeenCalledWith('workspace-1', 'user-1')
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ identity, content: Buffer.from([0, 255, 1]) })
    )
  })

  it('refuses a different creator in the same otherwise authorized workspace', async () => {
    mocks.read.mockResolvedValue({ ...file, userId: 'user-2' })
    await expect(readPrivateOfficeBackup(principal(), selection())).rejects.toMatchObject({
      code: 'not_found',
    })
    expect(mocks.download).not.toHaveBeenCalled()
  })

  it('refuses another existing workspace and unsupported workspace-key authority', async () => {
    mocks.read.mockResolvedValue({ ...file, workspaceId: 'workspace-2' })
    await expect(readPrivateOfficeBackup(principal(), selection())).rejects.toMatchObject({
      code: 'not_found',
    })
    await expect(
      createPrivateOfficeBackup(createWorkspaceApiKeyPrincipal(), {
        workspaceId: 'workspace-1',
        content: Buffer.from('x'),
      })
    ).rejects.toMatchObject({ code: 'forbidden' })
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.download).not.toHaveBeenCalled()
  })

  it('reauthorizes current workspace access after bytes load and refuses revoked authority', async () => {
    mocks.download.mockImplementation(async () => {
      permission.mockResolvedValue(null)
      return Buffer.from([0, 255, 1])
    })
    await expect(readPrivateOfficeBackup(principal(), selection())).rejects.toThrow()
    expect(mocks.download).toHaveBeenCalledTimes(1)
  })

  it('reads only the exact private version with the owner and current read permission', async () => {
    permission.mockResolvedValue('read')
    await expect(readPrivateOfficeBackup(principal(), selection())).resolves.toEqual({
      file,
      content: Buffer.from([0, 255, 1]),
    })
    expect(mocks.read).toHaveBeenCalledTimes(2)
    expect(mocks.read).toHaveBeenCalledWith({
      id: file.id,
      workspaceId: file.workspaceId,
      userId: 'user-1',
    })
    expect(mocks.download).toHaveBeenCalledWith(
      expect.objectContaining({ key: file.key, context: 'workspace', maxBytes: 10_000_000 })
    )
  })

  it('requires workspace write access before reserving or creating any private copy', async () => {
    permission.mockResolvedValue('read')
    await expect(
      createPrivateOfficeBackup(principal(), {
        workspaceId: 'workspace-1',
        content: Buffer.from('x'),
      })
    ).rejects.toThrow()
    expect(mocks.plan).not.toHaveBeenCalled()
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('refuses a version changed during the storage read', async () => {
    mocks.read.mockResolvedValueOnce(file).mockResolvedValueOnce({ ...file, version: 2000 })
    await expect(readPrivateOfficeBackup(principal(), selection())).rejects.toMatchObject({
      code: 'not_found',
    })
    expect(mocks.download).toHaveBeenCalledTimes(1)
  })

  it('refuses a storage response whose byte count differs from canonical metadata', async () => {
    mocks.download.mockResolvedValue(Buffer.from('wrong count'))
    await expect(readPrivateOfficeBackup(principal(), selection())).rejects.toMatchObject({
      code: 'conflict',
    })
  })

  it('cancels before authorization without creating a file', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      createPrivateOfficeBackup(
        principal(),
        { workspaceId: 'workspace-1', content: Buffer.from('x') },
        controller.signal
      )
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(mocks.workspace).not.toHaveBeenCalled()
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('does not deliver a read cancelled while storage was pending', async () => {
    const controller = new AbortController()
    mocks.download.mockImplementation(async () => {
      controller.abort()
      return Buffer.from([0, 255, 1])
    })
    await expect(
      readPrivateOfficeBackup(principal(), selection(), controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it.each([Buffer.alloc(0), Buffer.alloc(10_000_001), new Uint8Array(new SharedArrayBuffer(4))])(
    'refuses empty, oversized or shared input before authorization',
    async (content) => {
      await expect(
        createPrivateOfficeBackup(principal(), { workspaceId: 'workspace-1', content })
      ).rejects.toMatchObject({ code: 'validation' })
      expect(mocks.workspace).not.toHaveBeenCalled()
    }
  )
})
