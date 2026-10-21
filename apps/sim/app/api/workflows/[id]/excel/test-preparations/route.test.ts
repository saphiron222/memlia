// Copyright (c) 2026 Memlia. All rights reserved.
import { authMock, authMockFns } from '@sim/testing/mocks/auth.mock'
import { rateLimiterMock, rateLimiterMockFns } from '@sim/testing/mocks/rate-limiter.mock'
import {
  workflowContextMock,
  workflowContextMockFns,
} from '@sim/testing/mocks/workflow-context.mock'
import { workspaceAuthzMock, workspaceAuthzMockFns } from '@sim/testing/mocks/workspace-authz.mock'
import { NextRequest, NextResponse } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const io = vi.hoisted(() => ({ read: vi.fn(), prepare: vi.fn(), policy: vi.fn() }))
vi.mock('@/lib/auth', () => authMock)
vi.mock('@sim/platform-authz/workspace', () => workspaceAuthzMock)
vi.mock('@/lib/workflows/application/context', () => workflowContextMock)
vi.mock('@/lib/core/rate-limiter', () => rateLimiterMock)
vi.mock('@/lib/permission-groups/config-scope.server', () => ({
  resolvePermissionGroupConfig: io.policy,
}))
vi.mock('@/lib/workflows/persistence/excel-test-snapshots', () => ({
  readExcelTestPreparationObservation: io.read,
  prepareExcelTestSnapshot: io.prepare,
}))

import { GET, POST } from './route'

const digest = `sha256:${'a'.repeat(64)}`
const input = { expectedRevision: 7, expectedStateDigest: digest, operationId: 'owned-operation' }
const receipt = {
  status: 'prepared_for_test',
  workflowId: 'workflow',
  deploymentVersionId: 'version',
  version: 1,
  snapshotDigest: digest,
  activationAvailable: false,
  executionAvailable: false,
}
const routeContext = { params: Promise.resolve({ id: 'workflow' }) }
function request(
  method = 'POST',
  body: unknown = input,
  query = '?workspaceId=space',
  headers: Record<string, string> = {}
) {
  return new NextRequest(
    `http://localhost/api/workflows/workflow/excel/test-preparations${query}`,
    {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
    }
  )
}
beforeEach(() => {
  vi.clearAllMocks()
  authMockFns.mockGetSession.mockResolvedValue({
    user: { id: 'subject' },
    session: { id: 'session' },
  })
  rateLimiterMockFns.mockEnforceUserRateLimit.mockResolvedValue(null)
  workspaceAuthzMockFns.mockResolveEffectiveWorkspacePermission.mockResolvedValue('write')
  workflowContextMockFns.mockResolveActiveWorkflowApplicationContext.mockResolvedValue({
    workflowId: 'workflow',
    workflow: { id: 'workflow', workspaceId: 'space' },
    workspaceId: 'space',
    workspaceOrganizationId: null,
    allowPersonalApiKeys: true,
    billedAccountUserId: 'billing',
  })
  io.read.mockResolvedValue({
    expectedRevision: 7,
    expectedStateDigest: digest,
    blockTypes: ['memlia_excel'],
  })
  io.policy.mockResolvedValue(null)
  io.prepare.mockResolvedValue(receipt)
})
describe('GET/POST préparation — factory/auth/funnel natifs, session/rate/SQL doublés', () => {
  it('observe sans effet puis renvoie le reçu inactif validé et no-store', async () => {
    const observed = await GET(request('GET'), routeContext)
    expect(observed.status).toBe(200)
    expect(await observed.json()).toEqual({
      workflowId: 'workflow',
      workspaceId: 'space',
      expectedRevision: 7,
      expectedStateDigest: digest,
    })
    expect(io.prepare).not.toHaveBeenCalled()
    expect(observed.headers.get('cache-control')).toBe('private, no-store')
    const prepared = await POST(request(), routeContext)
    expect(prepared.status).toBe(200)
    expect(await prepared.json()).toEqual(receipt)
    expect(prepared.headers.get('cache-control')).toBe('private, no-store')
    expect(io.prepare).toHaveBeenCalledWith({
      ...input,
      actorId: 'subject',
      scope: { workflowId: 'workflow', workspaceId: 'space', organizationId: null },
    })
  })
  it('refuse sans session avant toute lecture, malgré des headers d’identité', async () => {
    authMockFns.mockGetSession.mockResolvedValue(null)
    const response = await POST(
      request('POST', input, '?workspaceId=space', { 'x-api-key': 'fake', 'x-user-id': 'subject' }),
      routeContext
    )
    expect(response.status).toBe(401)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(io.read).not.toHaveBeenCalled()
  })
  it('refuse cross-site avant consommation du corps et lookup', async () => {
    const req = request('POST', input, '?workspaceId=space', { 'sec-fetch-site': 'cross-site' })
    const response = await POST(req, routeContext)
    expect(response.status).toBe(403)
    expect(req.bodyUsed).toBe(false)
    expect(io.read).not.toHaveBeenCalled()
    expect(io.prepare).not.toHaveBeenCalled()
  })
  it.each([
    '',
    '?workspaceId=',
    '?workspaceId=space&workspaceId=space',
    '?workspaceId=space&actorId=subject',
  ])('refuse la query %s sans effet', async (query) => {
    expect((await POST(request('POST', input, query), routeContext)).status).toBe(400)
    expect(io.read).not.toHaveBeenCalled()
    expect(io.prepare).not.toHaveBeenCalled()
  })
  it.each(['actorId', 'scope', 'policyVersion', 'workflowState', 'activationAvailable'])(
    'refuse le champ %s sans effet',
    async (key) => {
      expect(
        (await POST(request('POST', { ...input, [key]: 'untrusted' }), routeContext)).status
      ).toBe(400)
      expect(io.read).not.toHaveBeenCalled()
    }
  )
  it('applique le rate-limit natif avant toute lecture du workflow', async () => {
    rateLimiterMockFns.mockEnforceUserRateLimit.mockResolvedValue(
      NextResponse.json({ error: 'limited' }, { status: 429 })
    )
    const response = await POST(request(), routeContext)
    expect(response.status).toBe(429)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(io.read).not.toHaveBeenCalled()
  })
  it('refuse Content-Length excessif sans consommer un petit corps', async () => {
    const req = request('POST', input, '?workspaceId=space', { 'content-length': '9000' })
    expect((await POST(req, routeContext)).status).toBe(413)
    expect(req.bodyUsed).toBe(false)
    expect(io.prepare).not.toHaveBeenCalled()
  })
  it('annule le flux chunked au-delà de la borne, sans préparation', async () => {
    let pulls = 0
    let cancelled = false
    const stream = new ReadableStream({
      pull(controller) {
        pulls++
        controller.enqueue(new Uint8Array(2048).fill(32))
        if (pulls === 20) controller.close()
      },
      cancel() {
        cancelled = true
      },
    })
    const req = new NextRequest(
      'http://localhost/api/workflows/workflow/excel/test-preparations?workspaceId=space',
      { method: 'POST', body: stream, duplex: 'half' } as RequestInit
    )
    expect((await POST(req, routeContext)).status).toBe(413)
    expect(pulls).toBeLessThan(20)
    expect(cancelled).toBe(true)
    expect(io.prepare).not.toHaveBeenCalled()
  })
  it('refuse le rôle read avant observation', async () => {
    workspaceAuthzMockFns.mockResolveEffectiveWorkspacePermission.mockResolvedValue('read')
    expect((await POST(request(), routeContext)).status).toBe(403)
    expect(io.read).not.toHaveBeenCalled()
  })
  it('renvoie un conflit fixe sans remplacer les préconditions', async () => {
    io.read.mockResolvedValue({
      expectedRevision: 8,
      expectedStateDigest: digest,
      blockTypes: ['memlia_excel'],
    })
    const response = await POST(request(), routeContext)
    expect(response.status).toBe(409)
    expect(JSON.stringify(await response.json())).not.toContain(digest)
    expect(io.prepare).not.toHaveBeenCalled()
  })
})
