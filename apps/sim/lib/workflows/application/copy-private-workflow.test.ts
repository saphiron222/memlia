// Copyright 2026 Memlia. All rights reserved.
import { auditMock, auditMockFns } from '@sim/testing/mocks/audit.mock'
import { realtimeNotifyMock, realtimeNotifyMockFns } from '@sim/testing/mocks/realtime-notify.mock'
import { workspaceAuthzMock, workspaceAuthzMockFns } from '@sim/testing/mocks/workspace-authz.mock'
import {
  workspaceContextMock,
  workspaceContextMockFns,
} from '@sim/testing/mocks/workspace-context.mock'
import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ copy: vi.fn() }))
vi.mock('@sim/audit', () => auditMock)
vi.mock('@sim/platform-authz/workspace', () => workspaceAuthzMock)
vi.mock('@/lib/workspaces/application/context', () => workspaceContextMock)
vi.mock('@/lib/realtime/notify', () => realtimeNotifyMock)
vi.mock('@/lib/memlia/workflows/private-copy-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/memlia/workflows/private-copy-store')>()),
  copyPrivateWorkflowRecord: mocks.copy,
}))

import { copyPrivateWorkflow } from './copy-private-workflow'

const principal = { kind: 'session' as const, userId: 'recipient', sessionId: 'session' }
const input = { sourceWorkflowId: 'source', destinationWorkspaceId: 'private', name: 'My copy' }
beforeEach(() => {
  vi.clearAllMocks()
  workspaceAuthzMockFns.mockResolveEffectiveWorkspacePermission.mockResolvedValue('admin')
  workspaceContextMockFns.mockResolveActiveWorkspaceApplicationContext.mockResolvedValue({
    workspaceId: 'private',
    workspaceOrganizationId: null,
    allowPersonalApiKeys: true,
    billedAccountUserId: 'not-the-subject',
  })
  mocks.copy.mockResolvedValue({
    id: 'new-id',
    name: 'My copy',
    workspaceId: 'private',
    configurationRequired: true,
    source: { workflowId: 'source', revision: 'revision' },
  })
})
it('uses the actual subject, audits source reference only and notifies destination only', async () => {
  const result = await copyPrivateWorkflow.execute({ principal, input })
  expect(result.id).toBe('new-id')
  expect(mocks.copy).toHaveBeenCalledWith(principal, input)
  expect(realtimeNotifyMockFns.mockNotifyWorkspaceWorkflowsChanged).toHaveBeenCalledWith('private')
  expect(auditMockFns.mockRecordAudit).toHaveBeenCalledWith(
    expect.objectContaining({
      workspaceId: 'private',
      actorId: 'recipient',
      metadata: expect.objectContaining({ sourceWorkflowId: 'source', sourceRevision: 'revision' }),
    })
  )
})
it('refuses caller graph/credential payload instead of accepting a trusted copy state', async () => {
  await expect(
    copyPrivateWorkflow.execute({
      principal,
      input: { ...input, workflow: { token: 'author' } } as never,
    })
  ).rejects.toMatchObject({ code: 'validation' })
  expect(mocks.copy).not.toHaveBeenCalled()
})
it.each([
  { kind: 'workspace_api_key', workspaceId: 'private', keyId: 'key' },
  { kind: 'system', serviceId: 'schedule', workspaceId: 'private', workflowId: 'source' },
])('refuses actorless $kind before canonical load', async (actor) => {
  await expect(
    copyPrivateWorkflow.execute({ principal: actor as never, input })
  ).rejects.toMatchObject({ code: 'forbidden' })
  expect(
    workspaceContextMockFns.mockResolveActiveWorkspaceApplicationContext
  ).not.toHaveBeenCalled()
  expect(mocks.copy).not.toHaveBeenCalled()
})
it('does not audit or notify when source/destination rights are revoked during admission', async () => {
  mocks.copy.mockRejectedValue(new Error('Access revoked'))
  await expect(copyPrivateWorkflow.execute({ principal, input })).rejects.toThrow('Access revoked')
  expect(auditMockFns.mockRecordAudit).not.toHaveBeenCalled()
  expect(realtimeNotifyMockFns.mockNotifyWorkspaceWorkflowsChanged).not.toHaveBeenCalled()
})
