// Copyright (c) 2026 Memlia. All rights reserved.
import {
  createPersonalApiKeyPrincipal,
  createSessionPrincipal,
  createWorkspaceApiKeyPrincipal,
} from '@sim/testing/factories/principal.factory'
import {
  workflowContextMock,
  workflowContextMockFns,
} from '@sim/testing/mocks/workflow-context.mock'
import { workspaceAuthzMock, workspaceAuthzMockFns } from '@sim/testing/mocks/workspace-authz.mock'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const boundary = vi.hoisted(() => ({ read: vi.fn(), prepare: vi.fn(), config: vi.fn() }))
vi.mock('@sim/platform-authz/workspace', () => workspaceAuthzMock)
vi.mock('@/lib/workflows/application/context', () => workflowContextMock)
vi.mock('@/lib/workflows/persistence/excel-test-snapshots', () => ({
  readExcelTestPreparationObservation: boundary.read,
  prepareExcelTestSnapshot: boundary.prepare,
}))
vi.mock('@/lib/permission-groups/config-scope.server', () => ({
  resolvePermissionGroupConfig: boundary.config,
}))

import { observeExcelTestPreparation, prepareExcelTest } from './prepare-excel-test'

const digest = `sha256:${'a'.repeat(64)}`
const input = {
  workflowId: 'workflow',
  assertedWorkspaceId: 'space',
  expectedRevision: 7,
  expectedStateDigest: digest,
  operationId: 'owned-op',
}
const receipt = {
  status: 'prepared_for_test',
  workflowId: 'workflow',
  deploymentVersionId: 'version',
  version: 1,
  snapshotDigest: digest,
  activationAvailable: false,
  executionAvailable: false,
}
const context = {
  workflowId: 'workflow',
  workflow: { id: 'workflow', workspaceId: 'space' },
  workspaceId: 'space',
  workspaceOrganizationId: null,
  allowPersonalApiKeys: true,
  billedAccountUserId: 'billing',
}
const principal = () => createSessionPrincipal({ userId: 'subject' })
beforeEach(() => {
  vi.clearAllMocks()
  workflowContextMockFns.mockResolveActiveWorkflowApplicationContext.mockResolvedValue(context)
  workspaceAuthzMockFns.mockResolveEffectiveWorkspacePermission.mockResolvedValue('write')
  boundary.config.mockResolvedValue(null)
  boundary.read.mockResolvedValue({
    expectedRevision: 7,
    expectedStateDigest: digest,
    blockTypes: ['memlia_excel'],
  })
  boundary.prepare.mockResolvedValue(receipt)
})
describe('préparation Excel — funnel/permissions natifs, lecture SQL et écriture doublées', () => {
  it('observe sans exposer types ou graphe et prépare sous sujet/portée autorisés', async () => {
    const observed = await observeExcelTestPreparation.execute({
      principal: principal(),
      input: { workflowId: 'workflow', assertedWorkspaceId: 'space' },
    })
    expect(observed).toEqual({
      workflowId: 'workflow',
      workspaceId: 'space',
      expectedRevision: 7,
      expectedStateDigest: digest,
    })
    expect(boundary.prepare).not.toHaveBeenCalled()
    expect(await prepareExcelTest.execute({ principal: principal(), input })).toEqual(receipt)
    expect(boundary.prepare).toHaveBeenCalledWith({
      scope: { workflowId: 'workflow', workspaceId: 'space', organizationId: null },
      actorId: 'subject',
      expectedRevision: 7,
      expectedStateDigest: digest,
      operationId: 'owned-op',
    })
    expect(workflowContextMockFns.mockResolveActiveWorkflowApplicationContext).toHaveBeenCalledWith(
      { workflowId: 'workflow', assertedWorkspaceId: 'space' }
    )
  })
  it.each([
    createPersonalApiKeyPrincipal(),
    createWorkspaceApiKeyPrincipal(),
    {
      kind: 'delegated',
      serviceId: 'copilot',
      subjectUserId: 'subject',
      workspaceId: 'space',
      delegationId: 'd',
      audience: 'sim:workflows',
      issuedAt: new Date(),
      expiresAt: new Date('2999-01-01'),
    },
  ])('refuse le principal $kind avant lecture', async (principal) => {
    await expect(prepareExcelTest.execute({ principal, input })).rejects.toMatchObject({
      code: 'forbidden',
    })
    expect(
      workflowContextMockFns.mockResolveActiveWorkflowApplicationContext
    ).not.toHaveBeenCalled()
    expect(boundary.read).not.toHaveBeenCalled()
    expect(boundary.prepare).not.toHaveBeenCalled()
  })
  it.each(['read', null])('refuse le rôle %j avant observation', async (role) => {
    workspaceAuthzMockFns.mockResolveEffectiveWorkspacePermission.mockResolvedValue(role)
    await expect(
      observeExcelTestPreparation.execute({
        principal: principal(),
        input: { workflowId: 'workflow', assertedWorkspaceId: 'space' },
      })
    ).rejects.toMatchObject({ code: expect.any(String) })
    expect(boundary.read).not.toHaveBeenCalled()
  })
  it.each([{ expectedRevision: 8 }, { expectedStateDigest: `sha256:${'b'.repeat(64)}` }])(
    'refuse un brouillon devenu différent sans recalculer le CAS reçu %j',
    async (change) => {
      boundary.read.mockResolvedValue({
        expectedRevision: 7,
        expectedStateDigest: digest,
        blockTypes: ['memlia_excel'],
        ...change,
      })
      await expect(
        prepareExcelTest.execute({ principal: principal(), input })
      ).rejects.toMatchObject({ code: 'conflict' })
      expect(boundary.prepare).not.toHaveBeenCalled()
    }
  )
  it('applique la vraie allowlist de blocs avant toute préparation', async () => {
    boundary.config.mockResolvedValue({ allowedIntegrations: [] })
    await expect(prepareExcelTest.execute({ principal: principal(), input })).rejects.toMatchObject(
      { code: 'forbidden' }
    )
    expect(boundary.prepare).not.toHaveBeenCalled()
  })
  it('ferme les erreurs SQL sans cause ni message arbitraire', async () => {
    boundary.prepare.mockRejectedValue(new Error('private-value'))
    const error = await prepareExcelTest
      .execute({ principal: principal(), input })
      .catch((error) => error)
    expect(error).toMatchObject({ code: 'conflict' })
    expect(error.message).toBe('excel_test_preparation_refused')
    expect(error.cause).toBeUndefined()
  })
  it('capture l’entrée avant le lookup asynchrone, y compris la lignée', async () => {
    const owned = { ...input, previousTestVersionId: 'previous' }
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    workflowContextMockFns.mockResolveActiveWorkflowApplicationContext.mockImplementationOnce(
      async () => {
        await barrier
        return context
      }
    )
    const pending = prepareExcelTest.execute({ principal: principal(), input: owned })
    owned.workflowId = 'foreign'
    owned.operationId = 'foreign'
    owned.previousTestVersionId = 'foreign'
    release()
    await pending
    expect(boundary.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: 'owned-op',
        previousTestVersionId: 'previous',
        scope: expect.objectContaining({ workflowId: 'workflow' }),
      })
    )
  })
})
