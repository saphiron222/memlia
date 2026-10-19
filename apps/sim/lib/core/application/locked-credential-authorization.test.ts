// Modified by Memlia in 2026. Upstream Apache-2.0 license and notices retained.
import type { OAuthAccessTokenPrincipal } from '@sim/auth/principal'
import { db } from '@sim/db'
import { member, permissions, user, workspace } from '@sim/db/schema'
import {
  createPersonalApiKeyPrincipal,
  createSessionPrincipal,
} from '@sim/testing/factories/principal.factory'
import {
  authorizedWorkspaceUseCaseMock,
  authorizedWorkspaceUseCaseMockFns,
} from '@sim/testing/mocks/authorized-workspace-use-case.mock'
import { queueTableRows, resetDbChainMock } from '@sim/testing/mocks/database.mock'
import {
  organizationMembershipMock,
  organizationMembershipMockFns,
} from '@sim/testing/mocks/organization-membership.mock'
import {
  permissionGroupsResolveMock,
  permissionGroupsResolveMockFns,
} from '@sim/testing/mocks/permission-groups-resolve.mock'
import { workspaceAuthzMock, workspaceAuthzMockFns } from '@sim/testing/mocks/workspace-authz.mock'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@sim/platform-authz/workspace', () => workspaceAuthzMock)
vi.mock('@/lib/permission-groups/resolve.server', () => permissionGroupsResolveMock)
vi.mock('@/lib/billing/organizations/membership', () => organizationMembershipMock)
vi.mock(
  '@/lib/core/application/authorized-workspace-use-case',
  () => authorizedWorkspaceUseCaseMock
)
vi.mock('@/lib/core/network/context.server', () => ({
  runWithOutboundOrganization: (_id: string, execute: () => Promise<unknown>) => execute(),
}))

import { SIM_CLI_CLIENT_ID } from '@/lib/auth/oauth-provider'
import { authorizeOrganizationOperation } from '@/lib/core/application/organization-authorization'
import { defineOrganizationOperation } from '@/lib/core/application/organization-operation'
import { authorizeWorkspaceOperation } from '@/lib/core/application/workspace-authorization'
import { defineWorkspaceOperation } from '@/lib/core/application/workspace-operation'
import { resolvePermissionGroupConfig } from '@/lib/permission-groups/config-scope.server'
import { DEFAULT_PERMISSION_GROUP_CONFIG } from '@/lib/permission-groups/fields'
import { withPermissionGroupScope } from '@/lib/permission-groups/request-scope.server'

const mocks = {
  audit: authorizedWorkspaceUseCaseMockFns.mockRecordProjectedUseCaseAuditEntries,
  workspaceConfig: permissionGroupsResolveMockFns.mockResolveVerifiedUserAccessControlContext,
  organizationConfig: permissionGroupsResolveMockFns.mockGetUserPermissionConfigForOrganization,
  role: workspaceAuthzMockFns.mockResolveEffectiveWorkspacePermission,
  lock: organizationMembershipMockFns.mockAcquireOrganizationMutationLock,
}

const personal = createPersonalApiKeyPrincipal({ userId: 'person', keyId: 'key' })
const oauth: OAuthAccessTokenPrincipal = {
  kind: 'oauth_access_token',
  userId: 'person',
  tokenId: 'token',
  clientId: 'client',
  scopes: ['api:write'],
  expiresAt: new Date('2099-01-01'),
}
const credentialCases = [
  {
    name: 'personal API key',
    principal: personal,
    field: 'disablePersonalApiKeys',
    detailCode: 'PERSONAL_API_KEYS_DISABLED',
  },
  {
    name: 'OAuth personal-key policy',
    principal: oauth,
    field: 'disablePersonalApiKeys',
    detailCode: 'PERSONAL_API_KEYS_DISABLED',
  },
  {
    name: 'OAuth app',
    principal: oauth,
    field: 'disableOAuthAppAccess',
    detailCode: 'PERMISSION_GROUP_CAPABILITY_BLOCKED',
  },
  {
    name: 'CLI',
    principal: { ...oauth, clientId: SIM_CLI_CLIENT_ID },
    field: 'disableCliAccess',
    detailCode: 'PERMISSION_GROUP_CAPABILITY_BLOCKED',
  },
] as const
const context = {
  workspaceId: 'workspace',
  workspaceOrganizationId: 'org',
  allowPersonalApiKeys: true,
}

beforeEach(() => {
  resetDbChainMock()
  mocks.role.mockResolvedValue('admin')
  mocks.workspaceConfig.mockResolvedValue({ config: DEFAULT_PERMISSION_GROUP_CONFIG })
  mocks.organizationConfig.mockResolvedValue(DEFAULT_PERMISSION_GROUP_CONFIG)
})

describe('locked credential reauthorization', () => {

  it('rechecks an operation capability through the locked executor for sessions', async () => {
    const operation = defineWorkspaceOperation({
      id: 'test.tables',
      minimumRole: 'read',
      workspaceApiKey: 'deny',
      principalKinds: ['session'],
      capability: 'tables.use',
    })
    const principal = createSessionPrincipal({ userId: 'person', sessionId: 'session' })
    await withPermissionGroupScope(async () => {
      await authorizeWorkspaceOperation(principal, operation, context)
      mocks.workspaceConfig.mockResolvedValue({
        config: { ...DEFAULT_PERMISSION_GROUP_CONFIG, hideTablesTab: true },
      })
      await expect(
        authorizeWorkspaceOperation(principal, operation, context, {
          executor: db,
          forUpdate: true,
        })
      ).rejects.toMatchObject({ detailCode: 'PERMISSION_GROUP_CAPABILITY_BLOCKED' })
    })
    expect(mocks.workspaceConfig).toHaveBeenLastCalledWith('person', 'workspace', 'org', db)
  })

  it('reads an organization operation capability on the same executor as membership', async () => {
    const operation = defineOrganizationOperation({
      id: 'test.knowledge',
      minimumRole: 'member',
      principalKinds: ['session'],
      capability: 'knowledge.use',
    })
    const principal = createSessionPrincipal({ userId: 'person', sessionId: 'session' })
    queueTableRows(member, [{ role: 'admin' }])
    queueTableRows(member, [{ role: 'admin' }])
    await authorizeOrganizationOperation(principal, operation, { organizationId: 'org' })
    mocks.organizationConfig.mockResolvedValue({
      ...DEFAULT_PERMISSION_GROUP_CONFIG,
      hideKnowledgeBaseTab: true,
    })
    await expect(
      authorizeOrganizationOperation(
        principal,
        operation,
        { organizationId: 'org' },
        { executor: db, forUpdate: true }
      )
    ).rejects.toMatchObject({ detailCode: 'PERMISSION_GROUP_CAPABILITY_BLOCKED' })
    expect(mocks.organizationConfig).toHaveBeenLastCalledWith('org', db)
  })
})
