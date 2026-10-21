// Copyright (c) 2026 Memlia. All rights reserved.
import { authMock, authMockFns } from '@sim/testing/mocks/auth.mock'
import { rateLimiterMock, rateLimiterMockFns } from '@sim/testing/mocks/rate-limiter.mock'
import { workspaceAuthzMock, workspaceAuthzMockFns } from '@sim/testing/mocks/workspace-authz.mock'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const io = vi.hoisted(() => ({
  workspace: vi.fn(),
  plan: vi.fn(),
  create: vi.fn(),
  read: vi.fn(),
  download: vi.fn(),
}))
vi.mock('@/lib/auth', () => authMock)
vi.mock('@/lib/core/rate-limiter', () => rateLimiterMock)
vi.mock('@sim/platform-authz/workspace', () => workspaceAuthzMock)
vi.mock('@/lib/uploads/contexts/workspace/file-manager', async (original) => ({
  ...(await original<typeof import('@/lib/uploads/contexts/workspace/file-manager')>()),
  loadActiveWorkspaceContext: io.workspace,
  planOfficeBackupFileIdentity: io.plan,
  createOfficeBackupFile: io.create,
  readOfficeBackupFileRecord: io.read,
}))
vi.mock('@/lib/uploads/core/storage-service', () => ({ downloadFile: io.download }))

import {
  MAX_OFFICE_BACKUP_HTTP_BYTES,
  officeBackupBodySchema,
} from '@/lib/api/contracts/excel-office-backups'
import { OfficeBackupStorageUnknownError } from '@/lib/uploads/contexts/workspace/file-manager'
import { POST } from './route'

const identity = Object.freeze({
  id: 'wf_copy',
  key: 'workspace/space/office-backups/wf_copy.xlsx',
  workspaceId: 'space',
  userId: 'subject',
})
const file = Object.freeze({ ...identity, size: 1, version: 1000 })
const body = { copyVersion: 1, contentBase64: 'AA==' }
const context = { params: Promise.resolve({ id: 'space' }) }
function request(value: unknown = body, headers: Record<string, string> = {}, query = '') {
  return new NextRequest(`http://localhost/api/workspaces/space/excel/office-backups${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(value),
  })
}
beforeEach(() => {
  vi.clearAllMocks()
  authMockFns.mockGetSession.mockResolvedValue({
    user: { id: 'subject' },
    session: { id: 'session' },
  })
  rateLimiterMockFns.mockEnforceUserRateLimit.mockResolvedValue(null)
  workspaceAuthzMockFns.mockResolveEffectiveWorkspacePermission.mockResolvedValue('write')
  io.workspace.mockResolvedValue({
    workspaceId: 'space',
    workspaceOrganizationId: null,
    allowPersonalApiKeys: true,
    billedAccountUserId: 'billing',
  })
  io.plan.mockReturnValue(identity)
  io.create.mockResolvedValue(file)
  io.read.mockResolvedValue(file)
  io.download.mockResolvedValue(Buffer.from([0]))
})

describe('Office backup HTTP → native authorization → private storage and readback (I/O doubled)', () => {
  it('returns a validated private storage receipt after binary readback', async () => {
    const response = await POST(request(), context)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(await response.json()).toEqual({
      status: 'stored',
      receipt: {
        schemaVersion: 'memlia.office-copy-storage/v1',
        workspaceId: 'space',
        ownerUserId: 'subject',
        fileId: file.id,
        contentVersion: 1000,
        byteLength: 1,
        sha256: 'sha256:6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d',
      },
    })
    expect(io.create).toHaveBeenCalledWith(
      expect.objectContaining({ identity, content: Buffer.from([0]) })
    )
  })

  it('requires a real session before storage despite identity headers', async () => {
    authMockFns.mockGetSession.mockResolvedValue(null)
    const response = await POST(
      request(body, { 'x-user-id': 'subject', 'x-api-key': 'invented' }),
      context
    )
    expect(response.status).toBe(401)
    expect(io.workspace).not.toHaveBeenCalled()
    expect(io.create).not.toHaveBeenCalled()
  })

  it('refuses a cross-site request before lookup or creation', async () => {
    const response = await POST(request(body, { 'sec-fetch-site': 'cross-site' }), context)
    expect(response.status).toBe(403)
    expect(io.workspace).not.toHaveBeenCalled()
    expect(io.create).not.toHaveBeenCalled()
  })

  it('requires workspace write permission before allocating a backup identity', async () => {
    workspaceAuthzMockFns.mockResolveEffectiveWorkspacePermission.mockResolvedValue('read')
    expect((await POST(request(), context)).status).toBe(403)
    expect(io.plan).not.toHaveBeenCalled()
    expect(io.create).not.toHaveBeenCalled()
  })

  it('conceals an existing workspace from a caller with no access', async () => {
    workspaceAuthzMockFns.mockResolveEffectiveWorkspacePermission.mockResolvedValue(null)
    expect((await POST(request(), context)).status).toBe(404)
    expect(io.plan).not.toHaveBeenCalled()
    expect(io.create).not.toHaveBeenCalled()
  })

  it.each([
    { ...body, contentBase64: 'AP==' },
    { ...body, contentBase64: '' },
    { ...body, ownerUserId: 'other-user' },
    { ...body, copyVersion: 2 },
  ])('refuses malformed or authority-bearing bodies before storage %#', async (value) => {
    expect((await POST(request(value), context)).status).toBe(400)
    expect(io.workspace).not.toHaveBeenCalled()
    expect(io.create).not.toHaveBeenCalled()
  })

  it('refuses unknown query parameters and oversized declared bodies', async () => {
    expect((await POST(request(body, {}, '?owner=other'), context)).status).toBe(400)
    expect(
      (
        await POST(
          request(body, { 'content-length': String(MAX_OFFICE_BACKUP_HTTP_BYTES + 1) }),
          context
        )
      ).status
    ).toBe(413)
    expect(io.create).not.toHaveBeenCalled()
  })

  it('keeps storage uncertainty explicit and does not retry', async () => {
    io.create.mockRejectedValue(new OfficeBackupStorageUnknownError(identity))
    const response = await POST(request(), context)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      status: 'unconfirmed',
      code: 'office_backup_storage_unknown',
      stage: 'creation_unknown',
      fileId: file.id,
    })
    expect(io.create).toHaveBeenCalledTimes(1)
    expect(io.download).not.toHaveBeenCalled()
  })

  it('does not report a persisted backup when the stored bytes differ', async () => {
    io.download.mockResolvedValue(Buffer.from([1]))
    const response = await POST(request(), context)
    expect(await response.json()).toEqual({
      status: 'unconfirmed',
      code: 'office_backup_refused',
      stage: 'created_unverified',
      fileId: file.id,
    })
    expect(io.create).toHaveBeenCalledTimes(1)
  })

  it('stores 7.5 MB through the native HTTP parser and refuses one additional byte', async () => {
    const content = Buffer.alloc(7_500_000)
    const largeFile = { ...file, size: content.length }
    io.create.mockResolvedValue(largeFile)
    io.read.mockResolvedValue(largeFile)
    io.download.mockResolvedValue(content)
    const response = await POST(
      request({ ...body, contentBase64: content.toString('base64') }),
      context
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      status: 'stored',
      receipt: { byteLength: 7_500_000 },
    })
    expect(io.create).toHaveBeenCalledTimes(1)

    const oversized = { ...body, contentBase64: Buffer.alloc(7_500_001).toString('base64') }
    expect(officeBackupBodySchema.safeParse(oversized).success).toBe(false)
    expect((await POST(request(oversized), context)).status).toBe(400)
    expect(io.create).toHaveBeenCalledTimes(1)
  })
})
