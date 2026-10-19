// Copyright 2026 Memlia. All rights reserved.
import {
  queueTableRows,
  resetDbChainMock,
  schemaMock,
  V2_OPERATION_RATE_LIMIT_ALLOWED,
  V2_PREAUTH_RATE_LIMIT_ALLOWED,
  v2RateLimiterModuleMock,
  v2RouteMocks,
} from '@sim/testing'
import { auditMock, auditMockFns } from '@sim/testing/mocks/audit.mock'
import {
  billingAttributionMock,
  billingAttributionMockFns,
} from '@sim/testing/mocks/billing-attribution.mock'
import {
  billingSubscriptionMock,
  billingSubscriptionMockFns,
} from '@sim/testing/mocks/billing-subscription.mock'
import { resetEnvFlagsMock, setEnvFlags } from '@sim/testing/mocks/env-flags.mock'
import { realtimeNotifyMock, realtimeNotifyMockFns } from '@sim/testing/mocks/realtime-notify.mock'
import { workspaceAuthzMock, workspaceAuthzMockFns } from '@sim/testing/mocks/workspace-authz.mock'
import {
  workspaceContextMock,
  workspaceContextMockFns,
} from '@sim/testing/mocks/workspace-context.mock'
import { NextRequest } from 'next/server'
import { afterAll, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ copy: vi.fn(), updateLastUsed: vi.fn() }))
vi.mock('@sim/audit', () => auditMock)
vi.mock('@sim/platform-authz/workspace', () => workspaceAuthzMock)
vi.mock('@/lib/workspaces/application/context', () => workspaceContextMock)
vi.mock('@/lib/realtime/notify', () => realtimeNotifyMock)
vi.mock('@/lib/billing/core/attribution', () => billingAttributionMock)
vi.mock('@/lib/billing/core/subscription', () => billingSubscriptionMock)
vi.mock('@/lib/api-key/service', () => ({ updateApiKeyLastUsed: mocks.updateLastUsed }))
vi.mock('@/lib/core/rate-limiter', () => v2RateLimiterModuleMock)
vi.mock('@/lib/memlia/workflows/private-copy-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/memlia/workflows/private-copy-store')>()),
  copyPrivateWorkflowRecord: mocks.copy,
}))

import { NoWorkspaceAccessError } from '@/lib/core/application'
import { OrchestrationError } from '@/lib/core/orchestration/types'
import { POST } from './route'

const body = { destinationWorkspaceId: 'recipient-personal', name: 'My copy' }
const context = { params: Promise.resolve({ workflowId: 'shared-source' }) }
const result = {
  id: 'new-copy',
  workspaceId: 'recipient-personal',
  name: 'My copy',
  configurationRequired: true,
  source: { workflowId: 'shared-source', revision: 'internal-digest' },
}
function request(
  value: unknown = body,
  headers: Record<string, string> = { 'x-api-key': 'fixture-key' },
  query = ''
) {
  return new NextRequest(`http://localhost/api/v2/workflows/shared-source/private-copy${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(value),
  })
}
function key(overrides: Record<string, unknown> = {}) {
  queueTableRows(schemaMock.apiKey, [
    {
      id: 'recipient-key',
      userId: 'recipient',
      type: 'personal',
      workspaceId: null,
      expiresAt: null,
      userBanned: false,
      userSuspendedAt: null,
      ...overrides,
    },
  ])
}
function oauth(scopes: string[], overrides: Record<string, unknown> = {}) {
  queueTableRows(schemaMock.oauthAccessToken, [
    {
      id: 'recipient-token',
      userId: 'recipient',
      clientId: 'fixture-client',
      scopes,
      expiresAt: new Date('2099-01-01'),
      clientDisabled: false,
      userBanned: false,
      userExists: 'recipient',
      ...overrides,
    },
  ])
}
beforeEach(() => {
  vi.clearAllMocks()
  resetDbChainMock()
  setEnvFlags({ isAuthDisabled: false })
  v2RouteMocks.preauthRate.mockResolvedValue(V2_PREAUTH_RATE_LIMIT_ALLOWED)
  v2RouteMocks.operationRate.mockResolvedValue(V2_OPERATION_RATE_LIMIT_ALLOWED)
  billingSubscriptionMockFns.mockGetHighestPrioritySubscription.mockResolvedValue(null)
  billingAttributionMockFns.mockResolveWorkspaceBillingPayer.mockResolvedValue({
    billedAccountUserId: 'unrelated-payer',
    organizationId: null,
    payerSubscription: null,
  })
  workspaceAuthzMockFns.mockResolveEffectiveWorkspacePermission.mockResolvedValue('admin')
  workspaceContextMockFns.mockResolveActiveWorkspaceApplicationContext.mockResolvedValue({
    workspaceId: 'recipient-personal',
    workspaceOrganizationId: null,
    allowPersonalApiKeys: true,
    billedAccountUserId: 'unrelated-payer',
  })
  mocks.copy.mockResolvedValue(result)
})
afterAll(resetEnvFlagsMock)

it('creates a configuration-required copy with the authenticated human and path source', async () => {
  key()
  const response = await POST(request({ ...body, name: '  My copy  ' }), context)
  expect(response.status).toBe(201)
  expect(await response.json()).toEqual({
    data: {
      id: 'new-copy',
      workspaceId: 'recipient-personal',
      name: 'My copy',
      configurationRequired: true,
    },
  })
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(mocks.copy).toHaveBeenCalledWith(
    { kind: 'personal_api_key', userId: 'recipient', keyId: 'recipient-key' },
    { ...body, sourceWorkflowId: 'shared-source' }
  )
  expect(auditMockFns.mockRecordAudit).toHaveBeenCalledWith(
    expect.objectContaining({ actorId: 'recipient', workspaceId: 'recipient-personal' })
  )
  expect(realtimeNotifyMockFns.mockNotifyWorkspaceWorkflowsChanged).toHaveBeenCalledWith(
    'recipient-personal'
  )
})
it('refuses a workspace key without borrowing its creator or billing payer', async () => {
  key({ type: 'workspace', workspaceId: 'recipient-personal', userId: 'creator' })
  const response = await POST(request(), context)
  expect(response.status).toBe(403)
  expect(mocks.copy).not.toHaveBeenCalled()
  expect(
    workspaceContextMockFns.mockResolveActiveWorkspaceApplicationContext
  ).not.toHaveBeenCalled()
})
it('refuses absent credentials and session cookies on the native v2 surface', async () => {
  const response = await POST(request(body, { cookie: 'fixture-session=present' }), context)
  expect(response.status).toBe(401)
  expect(mocks.copy).not.toHaveBeenCalled()
})
it.each([
  ['revoked', null],
  ['expired', { expiresAt: new Date(0) }],
  ['banned', { userBanned: true }],
  ['suspended', { userSuspendedAt: new Date(0) }],
] as const)('refuses a %s personal credential', async (_name, overrides) => {
  if (overrides) key(overrides)
  const response = await POST(request(), context)
  expect(response.status).toBe(401)
  expect(mocks.copy).not.toHaveBeenCalled()
})
it.each([
  'sourceWorkflowId',
  'userId',
  'ownerId',
  'principal',
  'workflow',
  'credentials',
  'variables',
  'configurationRequired',
  'execute',
])('rejects caller-supplied %s instead of trusting copy state', async (field) => {
  key()
  const response = await POST(request({ ...body, [field]: 'untrusted' }), context)
  expect(response.status).toBe(400)
  expect(mocks.copy).not.toHaveBeenCalled()
})
it.each([
  {},
  { ...body, name: ' ' },
  { ...body, name: 'x'.repeat(101) },
  { ...body, destinationWorkspaceId: '' },
  { ...body, destinationWorkspaceId: 'x'.repeat(129) },
])('rejects invalid input %j', async (value) => {
  key()
  const response = await POST(request(value), context)
  expect(response.status).toBe(400)
  expect(mocks.copy).not.toHaveBeenCalled()
})
it('rejects source overrides in query parameters', async () => {
  key()
  expect(
    (await POST(request(body, { 'x-api-key': 'fixture-key' }, '?sourceWorkflowId=other'), context))
      .status
  ).toBe(400)
  expect(mocks.copy).not.toHaveBeenCalled()
})
it('permits an OAuth human with write scope through native token verification', async () => {
  oauth(['api:read', 'api:write'])
  const response = await POST(request(body, { authorization: 'Bearer sim_oat_fixture' }), context)
  expect(response.status).toBe(201)
  expect(mocks.copy).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'oauth_access_token', userId: 'recipient' }),
    expect.objectContaining({ sourceWorkflowId: 'shared-source' })
  )
})
it('refuses a read-only OAuth token before loading the workspace', async () => {
  oauth(['api:read'])
  expect(
    (await POST(request(body, { authorization: 'Bearer sim_oat_fixture' }), context)).status
  ).toBe(403)
  expect(mocks.copy).not.toHaveBeenCalled()
  expect(
    workspaceContextMockFns.mockResolveActiveWorkspaceApplicationContext
  ).not.toHaveBeenCalled()
})
it.each([
  [new NoWorkspaceAccessError(), 404, 'NOT_FOUND'],
  [
    new OrchestrationError('forbidden', 'Destination must be the subject personal workspace'),
    403,
    'FORBIDDEN',
  ],
  [new OrchestrationError('conflict', 'Source changed'), 409, 'CONFLICT'],
  [new OrchestrationError('validation', 'Unsupported source'), 400, 'BAD_REQUEST'],
  [new Error('private internal detail'), 500, 'INTERNAL_ERROR'],
] as const)(
  'projects use-case refusal to HTTP %s / %i without successful audit',
  async (error, status, code) => {
    key()
    mocks.copy.mockRejectedValue(error)
    const response = await POST(request(), context)
    expect(response.status).toBe(status)
    const payload = await response.json()
    expect(payload.error.code).toBe(code)
    expect(JSON.stringify(payload)).not.toContain('private internal detail')
    expect(auditMockFns.mockRecordAudit).not.toHaveBeenCalled()
    expect(realtimeNotifyMockFns.mockNotifyWorkspaceWorkflowsChanged).not.toHaveBeenCalled()
  }
)
it('retains native operation rate limiting', async () => {
  key()
  v2RouteMocks.operationRate.mockResolvedValue({
    ...V2_OPERATION_RATE_LIMIT_ALLOWED,
    allowed: false,
    remaining: 0,
  })
  expect((await POST(request(), context)).status).toBe(429)
  expect(mocks.copy).not.toHaveBeenCalled()
})
it('bounds request bytes before admitting workflow state', async () => {
  key()
  expect((await POST(request({ ...body, name: 'x'.repeat(9000) }), context)).status).toBe(413)
  expect(mocks.copy).not.toHaveBeenCalled()
})
it('refuses a result that would claim readiness', async () => {
  key()
  mocks.copy.mockResolvedValue({ ...result, configurationRequired: false })
  expect((await POST(request(), context)).status).toBe(500)
})

it('returns the server-deduplicated name even when its suffix exceeds the input bound', async () => {
  key()
  const name = `${'x'.repeat(100)} (2)`
  mocks.copy.mockResolvedValue({ ...result, name })
  const response = await POST(request({ ...body, name: 'x'.repeat(100) }), context)
  expect(response.status).toBe(201)
  expect((await response.json()).data.name).toBe(name)
})
it('rejects malformed JSON through the native parser', async () => {
  key()
  const malformed = new NextRequest(
    'http://localhost/api/v2/workflows/shared-source/private-copy',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'fixture-key' },
      body: '{',
    }
  )
  expect((await POST(malformed, context)).status).toBe(400)
  expect(mocks.copy).not.toHaveBeenCalled()
})
it('rejects unsupported media without entering the use case', async () => {
  key()
  const form = new NextRequest('http://localhost/api/v2/workflows/shared-source/private-copy', {
    method: 'POST',
    headers: { 'x-api-key': 'fixture-key', 'content-type': 'application/x-www-form-urlencoded' },
    body: 'name=Copy',
  })
  expect((await POST(form, context)).status).toBe(415)
  expect(mocks.copy).not.toHaveBeenCalled()
})
it('retains pre-authentication rate limiting without inspecting credentials', async () => {
  v2RouteMocks.preauthRate.mockResolvedValue({
    ...V2_PREAUTH_RATE_LIMIT_ALLOWED,
    allowed: false,
    remaining: 0,
  })
  expect((await POST(request(), context)).status).toBe(429)
  expect(mocks.updateLastUsed).not.toHaveBeenCalled()
  expect(mocks.copy).not.toHaveBeenCalled()
})
it('refuses revoked destination membership through the real application guard', async () => {
  key()
  workspaceAuthzMockFns.mockResolveEffectiveWorkspacePermission.mockResolvedValue(null)
  const response = await POST(request(), context)
  expect(response.status).toBe(404)
  expect(mocks.copy).not.toHaveBeenCalled()
  expect(auditMockFns.mockRecordAudit).not.toHaveBeenCalled()
})
it('fails closed if the rate-limit store is unavailable', async () => {
  key()
  v2RouteMocks.operationRate.mockRejectedValue(new Error('private infrastructure detail'))
  const response = await POST(request(), context)
  expect(response.status).toBe(503)
  expect(JSON.stringify(await response.json())).not.toContain('private infrastructure detail')
  expect(mocks.copy).not.toHaveBeenCalled()
})
