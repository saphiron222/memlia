// Copyright 2026 Memlia. All rights reserved.
import { auditMock, auditMockFns } from '@sim/testing/mocks/audit.mock'
import { authMock, authMockFns } from '@sim/testing/mocks/auth.mock'
import { rateLimiterMock, rateLimiterMockFns } from '@sim/testing/mocks/rate-limiter.mock'
import { realtimeNotifyMock } from '@sim/testing/mocks/realtime-notify.mock'
import { workspaceAuthzMock, workspaceAuthzMockFns } from '@sim/testing/mocks/workspace-authz.mock'
import {
  workspaceContextMock,
  workspaceContextMockFns,
} from '@sim/testing/mocks/workspace-context.mock'
import { NextRequest, NextResponse } from 'next/server'
import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ copy: vi.fn() }))
vi.mock('@sim/audit', () => auditMock)
vi.mock('@/lib/auth', () => authMock)
vi.mock('@/lib/core/rate-limiter', () => rateLimiterMock)
vi.mock('@sim/platform-authz/workspace', () => workspaceAuthzMock)
vi.mock('@/lib/workspaces/application/context', () => workspaceContextMock)
vi.mock('@/lib/realtime/notify', () => realtimeNotifyMock)
vi.mock('@/lib/memlia/workflows/private-copy-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/memlia/workflows/private-copy-store')>()),
  copyPrivateWorkflowRecord: mocks.copy,
}))

import { NoWorkspaceAccessError } from '@/lib/core/application'
import { OrchestrationError } from '@/lib/core/orchestration/types'
import { POST } from './route'

const body = { destinationWorkspaceId: 'recipient-personal', name: 'My copy' }
const context = { params: Promise.resolve({ id: 'shared-source' }) }
const result = {
  id: 'new-copy',
  workspaceId: 'recipient-personal',
  name: 'My copy',
  configurationRequired: true,
  source: { workflowId: 'shared-source', revision: 'internal-digest' },
}
function request(value: unknown = body, headers: Record<string, string> = {}, query = '') {
  return new NextRequest(`http://localhost/api/workflows/shared-source/private-copy${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...headers },
    body: JSON.stringify(value),
  })
}
beforeEach(() => {
  vi.clearAllMocks()
  authMockFns.mockGetSession.mockResolvedValue({
    user: { id: 'recipient' },
    session: { id: 'recipient-session' },
  })
  rateLimiterMockFns.mockEnforceUserRateLimit.mockResolvedValue(null)
  workspaceAuthzMockFns.mockResolveEffectiveWorkspacePermission.mockResolvedValue('admin')
  workspaceContextMockFns.mockResolveActiveWorkspaceApplicationContext.mockResolvedValue({
    workspaceId: 'recipient-personal',
    workspaceOrganizationId: null,
    allowPersonalApiKeys: true,
    billedAccountUserId: 'unrelated-payer',
  })
  mocks.copy.mockResolvedValue(result)
})

it('creates a configuration-required copy using only the native session subject and path source', async () => {
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
    { kind: 'session', userId: 'recipient', sessionId: 'recipient-session' },
    { ...body, sourceWorkflowId: 'shared-source' }
  )
  expect(rateLimiterMockFns.mockEnforceUserRateLimit).toHaveBeenCalledWith(
    'workflows.private-copy',
    'recipient',
    undefined
  )
  expect(auditMockFns.mockRecordAudit).toHaveBeenCalledWith(
    expect.objectContaining({ actorId: 'recipient', workspaceId: 'recipient-personal' })
  )
})
it('refuses a cross-site browser request before loading or copying workspace state', async () => {
  const response = await POST(request(body, { 'sec-fetch-site': 'cross-site' }), context)
  expect(response.status).toBe(403)
  expect(mocks.copy).not.toHaveBeenCalled()
  expect(
    workspaceContextMockFns.mockResolveActiveWorkspaceApplicationContext
  ).not.toHaveBeenCalled()
  expect(auditMockFns.mockRecordAudit).not.toHaveBeenCalled()
})
it.each([
  {},
  { 'x-api-key': 'fixture-key', 'x-user-id': 'author' },
  { authorization: 'Bearer fixture-internal-delegation', 'x-internal-api-key': 'fixture-internal' },
])('requires a session even when non-session credentials are supplied: %j', async (headers) => {
  authMockFns.mockGetSession.mockResolvedValue(null)
  const response = await POST(request(body, headers), context)
  expect(response.status).toBe(401)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(rateLimiterMockFns.mockEnforceUserRateLimit).not.toHaveBeenCalled()
  expect(mocks.copy).not.toHaveBeenCalled()
})
it('ignores forged identity/credential headers when a valid session exists', async () => {
  const response = await POST(
    request(body, {
      'x-user-id': 'author',
      'x-api-key': 'fixture-key',
      authorization: 'Bearer fixture-internal-delegation',
    }),
    context
  )
  expect(response.status).toBe(201)
  expect(mocks.copy).toHaveBeenCalledWith(
    { kind: 'session', userId: 'recipient', sessionId: 'recipient-session' },
    expect.anything()
  )
})
it.each(['same-origin', 'same-site', 'none'])(
  'preserves native %s browser requests',
  async (site) => {
    expect((await POST(request(body, { 'sec-fetch-site': site }), context)).status).toBe(201)
  }
)
it('preserves the native policy for an absent fetch-metadata header', async () => {
  const incoming = request()
  incoming.headers.delete('sec-fetch-site')
  expect((await POST(incoming, context)).status).toBe(201)
})
it('rejects cross-site before parsing an invalid body', async () => {
  expect(
    (await POST(request({ unexpected: true }, { 'sec-fetch-site': 'cross-site' }), context)).status
  ).toBe(403)
  expect(mocks.copy).not.toHaveBeenCalled()
})
it.each([
  'sourceWorkflowId',
  'userId',
  'ownerId',
  'principal',
  'credentials',
  'workflow',
  'execute',
])('rejects caller-supplied %s', async (field) => {
  expect((await POST(request({ ...body, [field]: 'untrusted' }), context)).status).toBe(400)
  expect(mocks.copy).not.toHaveBeenCalled()
})
it.each([
  {},
  { ...body, name: ' ' },
  { ...body, name: 'x'.repeat(101) },
  { ...body, destinationWorkspaceId: '' },
  { ...body, destinationWorkspaceId: 'x'.repeat(129) },
])('rejects invalid copy input %j', async (value) => {
  expect((await POST(request(value), context)).status).toBe(400)
  expect(mocks.copy).not.toHaveBeenCalled()
})
it('rejects query overrides and oversized bodies', async () => {
  expect((await POST(request(body, {}, '?sourceWorkflowId=other'), context)).status).toBe(400)
  expect((await POST(request({ ...body, name: 'x'.repeat(9000) }), context)).status).toBe(413)
  expect(mocks.copy).not.toHaveBeenCalled()
})
it('conceals revoked destination membership using the real application guard', async () => {
  workspaceAuthzMockFns.mockResolveEffectiveWorkspacePermission.mockResolvedValue(null)
  const response = await POST(request(), context)
  expect(response.status).toBe(404)
  expect(await response.json()).toMatchObject({ error: 'Workflow not found' })
  expect(mocks.copy).not.toHaveBeenCalled()
})
it.each([
  [new NoWorkspaceAccessError(), 404, 'Workflow not found'],
  [
    new OrchestrationError('forbidden', 'Destination must be the subject personal workspace'),
    403,
    'Destination must be the subject personal workspace',
  ],
  [new OrchestrationError('conflict', 'Source changed'), 409, 'Source changed'],
  [new Error('private database detail'), 500, 'Internal server error'],
] as const)('projects native use-case refusal %s to %i', async (error, status, message) => {
  mocks.copy.mockRejectedValue(error)
  const response = await POST(request(), context)
  expect(response.status).toBe(status)
  expect(await response.json()).toMatchObject({ error: message })
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(auditMockFns.mockRecordAudit).not.toHaveBeenCalled()
})
it('retains the native user quota and Retry-After response', async () => {
  rateLimiterMockFns.mockEnforceUserRateLimit.mockResolvedValue(
    NextResponse.json(
      { error: 'Rate limit exceeded' },
      { status: 429, headers: { 'Retry-After': '60' } }
    )
  )
  const response = await POST(request(), context)
  expect(response.status).toBe(429)
  expect(response.headers.get('retry-after')).toBe('60')
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(mocks.copy).not.toHaveBeenCalled()
})
it('does not invent an identity if the authenticated session lacks its session ID', async () => {
  authMockFns.mockGetSession.mockResolvedValue({ user: { id: 'recipient' } })
  expect((await POST(request(), context)).status).toBe(500)
  expect(mocks.copy).not.toHaveBeenCalled()
})
it('fails closed on a session backend failure without exposing its details', async () => {
  authMockFns.mockGetSession.mockRejectedValue(new Error('private session backend detail'))
  const response = await POST(request(), context)
  expect(response.status).toBe(500)
  expect(await response.json()).toMatchObject({ error: 'Internal server error' })
  expect(mocks.copy).not.toHaveBeenCalled()
})
it('returns the server-deduplicated name and refuses a response claiming readiness', async () => {
  mocks.copy.mockResolvedValue({ ...result, name: `${'x'.repeat(100)} (2)` })
  expect((await POST(request({ ...body, name: 'x'.repeat(100) }), context)).status).toBe(201)
  mocks.copy.mockResolvedValue({ ...result, configurationRequired: false })
  expect((await POST(request(), context)).status).toBe(500)
})
