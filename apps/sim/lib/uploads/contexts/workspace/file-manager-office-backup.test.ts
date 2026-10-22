// Copyright (c) 2026 Memlia. All rights reserved.
import { workspaceFiles } from '@sim/db/schema'
import { billingStorageMock, billingStorageMockFns } from '@sim/testing/mocks/billing-storage.mock'
import { dbChainMockFns, queueTableRows, resetDbChainMock } from '@sim/testing/mocks/database.mock'
import { storageServiceMock, storageServiceMockFns } from '@sim/testing/mocks/storage-service.mock'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  instrumentPoolClient,
  isInsideDbTransaction,
} from '../../../../../../packages/db/tx-tripwire'

vi.mock('@/lib/billing/storage', () => billingStorageMock)
vi.mock('@/lib/uploads/core/storage-service', () => storageServiceMock)

import {
  createOfficeBackupFile,
  planOfficeBackupFileIdentity,
  readOfficeBackupFileRecord,
} from './file-manager'

const upload = storageServiceMockFns.mockUploadFile
const remove = storageServiceMockFns.mockDeleteFile
const authorizeBeforeCommit = async () => {}

function row(identity: ReturnType<typeof planOfficeBackupFileIdentity>) {
  return {
    ...identity,
    context: 'office-backup',
    projectId: null,
    organizationId: null,
    chatId: null,
    folderId: null,
    deletedAt: null,
    sizeBytes: 4,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    contentUpdatedAt: new Date(1000),
  }
}

describe('native private Office copy storage (DB and storage doubled)', () => {
  beforeEach(() => {
    resetDbChainMock()
    upload.mockReset()
    remove.mockReset()
    billingStorageMockFns.mockApplyFileStorageDelta.mockClear()
  })

  it('copies binary input and reserves an exclusive server key before the upload await', async () => {
    const identity = planOfficeBackupFileIdentity('workspace-1', 'user-1')
    const bytes = Buffer.from([0, 255, 128, 1])
    upload.mockImplementation(async (options) => {
      bytes.fill(42)
      expect(options.file).toEqual(Buffer.from([0, 255, 128, 1]))
      expect(options).toMatchObject({
        createOnly: true,
        persistMetadata: false,
        context: 'workspace',
        customKey: identity.key,
      })
      throw new Error('private transport detail')
    })
    await expect(
      createOfficeBackupFile({ identity, content: bytes, authorizeBeforeCommit: async () => {} })
    ).rejects.toMatchObject({
      code: 'office_backup_storage_unknown',
      identity,
    })
    expect(identity.key).toBe(`workspace/workspace-1/office-backups/${identity.id}.xlsx`)
    expect(upload).toHaveBeenCalledTimes(1)
    expect(remove).not.toHaveBeenCalled()
    expect(dbChainMockFns.insert).not.toHaveBeenCalled()
  })

  it('does not grant a record through a different creator or workspace', async () => {
    const identity = planOfficeBackupFileIdentity('workspace-1', 'user-1')
    queueTableRows(workspaceFiles, [{ ...identity, userId: 'user-2' }])
    await expect(readOfficeBackupFileRecord(identity)).resolves.toBeNull()
    queueTableRows(workspaceFiles, [{ ...identity, workspaceId: 'workspace-2' }])
    await expect(readOfficeBackupFileRecord(identity)).resolves.toBeNull()
  })

  it('creates the private canonical row and charges exactly its binary size once', async () => {
    const identity = planOfficeBackupFileIdentity('workspace-1', 'user-1')
    upload.mockResolvedValue({ key: identity.key })
    dbChainMockFns.returning.mockResolvedValue([row(identity)])
    await expect(
      createOfficeBackupFile({
        identity,
        content: Buffer.from([0, 255, 128, 1]),
        authorizeBeforeCommit,
      })
    ).resolves.toEqual({ ...identity, size: 4, version: 1000 })
    expect(dbChainMockFns.values).toHaveBeenCalledWith(
      expect.objectContaining({
        context: 'office-backup',
        userId: 'user-1',
        workspaceId: 'workspace-1',
        sizeBytes: 4,
      })
    )
    expect(billingStorageMockFns.mockApplyFileStorageDelta).toHaveBeenCalledExactlyOnceWith(4)
    await expect(
      createOfficeBackupFile({ identity, content: Buffer.from('more'), authorizeBeforeCommit })
    ).rejects.toThrow('office_backup_refused')
    expect(upload).toHaveBeenCalledTimes(1)
    expect(remove).not.toHaveBeenCalled()
  })

  it('retains the owned object when COMMIT acknowledgement is lost', async () => {
    const identity = planOfficeBackupFileIdentity('workspace-1', 'user-1')
    upload.mockResolvedValue({ key: identity.key })
    dbChainMockFns.returning.mockResolvedValue([row(identity)])
    dbChainMockFns.transaction.mockImplementationOnce(async (callback) => {
      const { dbChainMock } = await import('@sim/testing/mocks/database.mock')
      await callback(dbChainMock.db)
      throw new Error('private COMMIT transport detail')
    })
    await expect(
      createOfficeBackupFile({ identity, content: Buffer.from('four'), authorizeBeforeCommit })
    ).rejects.toMatchObject({ code: 'office_backup_storage_unknown', identity })
    expect(remove).not.toHaveBeenCalled()
    expect(upload).toHaveBeenCalledTimes(1)
  })

  it('reauthorizes outside the native transaction tripwire before opening the insert transaction', async () => {
    const { dbChainMock } = await import('@sim/testing/mocks/database.mock')
    const identity = planOfficeBackupFileIdentity('workspace-1', 'user-1')
    const order: string[] = []
    const pool = instrumentPoolClient(
      {
        unsafe(_query: string) {
          order.push('authority')
          return Promise.resolve([])
        },
        async begin(callback: (tx: typeof dbChainMock.db) => Promise<unknown>) {
          order.push('transaction')
          return callback(dbChainMock.db)
        },
      },
      'office-backup-tripwire'
    )
    dbChainMockFns.transaction.mockImplementationOnce((callback) => pool.begin(callback))
    upload.mockImplementation(async () => {
      order.push('upload')
      return { key: identity.key }
    })
    dbChainMockFns.returning.mockResolvedValue([row(identity)])
    const reauthorize = async () => {
      await pool.unsafe('SELECT synthetic_authority')
      expect(isInsideDbTransaction()).toBe(false)
    }
    await expect(
      createOfficeBackupFile({
        identity,
        content: Buffer.from('four'),
        authorizeBeforeCommit: reauthorize,
      })
    ).resolves.toMatchObject({ ...identity, size: 4, version: 1000 })
    expect(order).toEqual(['upload', 'authority', 'transaction'])
    expect(dbChainMockFns.insert).toHaveBeenCalledTimes(1)
  })

  it('retains the staged object if authority is refused before the insert transaction', async () => {
    const identity = planOfficeBackupFileIdentity('workspace-1', 'user-1')
    upload.mockResolvedValue({ key: identity.key })
    await expect(
      createOfficeBackupFile({
        identity,
        content: Buffer.from('four'),
        authorizeBeforeCommit: async () => {
          throw new Error('authority no longer available')
        },
      })
    ).rejects.toMatchObject({ code: 'office_backup_storage_unknown', identity })
    expect(dbChainMockFns.transaction).not.toHaveBeenCalled()
    expect(dbChainMockFns.insert).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    expect(upload).toHaveBeenCalledTimes(1)
  })

  it('cancels before upload without pretending any object was created', async () => {
    const controller = new AbortController()
    controller.abort()
    const identity = planOfficeBackupFileIdentity('workspace-1', 'user-1')
    await expect(
      createOfficeBackupFile({
        identity,
        content: Buffer.from('four'),
        signal: controller.signal,
        authorizeBeforeCommit,
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(upload).not.toHaveBeenCalled()
  })

  it('retains a possible object if cancelled after upload acknowledgement', async () => {
    const controller = new AbortController()
    const identity = planOfficeBackupFileIdentity('workspace-1', 'user-1')
    upload.mockImplementation(async () => {
      controller.abort()
      return { key: identity.key }
    })
    await expect(
      createOfficeBackupFile({
        identity,
        content: Buffer.from('four'),
        signal: controller.signal,
        authorizeBeforeCommit,
      })
    ).rejects.toMatchObject({ code: 'office_backup_storage_unknown', identity })
    expect(remove).not.toHaveBeenCalled()
    expect(dbChainMockFns.insert).not.toHaveBeenCalled()
  })

  it.each(['../outside', 'a/b', '', 'x\\y'])(
    'refuses an ambiguous server namespace segment %s',
    (segment) => {
      expect(() => planOfficeBackupFileIdentity(segment, 'user-1')).toThrow(
        'office_backup_identity_refused'
      )
      expect(upload).not.toHaveBeenCalled()
    }
  )

  it.each([
    { context: 'workspace' },
    { deletedAt: new Date(2000) },
    { chatId: 'some-chat' },
    { key: 'workspace/workspace-1/shared.xlsx' },
    { sizeBytes: 0 },
    { contentUpdatedAt: new Date(Number.NaN) },
  ])('refuses a non-private or unavailable canonical record %j', async (change) => {
    const identity = planOfficeBackupFileIdentity('workspace-1', 'user-1')
    queueTableRows(workspaceFiles, [{ ...row(identity), ...change }])
    await expect(readOfficeBackupFileRecord(identity)).resolves.toBeNull()
  })
})
