// Copyright (c) 2026 Memlia. All rights reserved.
import { auditMock } from '@sim/testing/mocks/audit.mock'
import { authMock, authMockFns } from '@sim/testing/mocks/auth.mock'
import { networkConfigMock } from '@sim/testing/mocks/network-config.mock'
import { workspaceAuthzMock, workspaceAuthzMockFns } from '@sim/testing/mocks/workspace-authz.mock'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ports = vi.hoisted(() => ({ workspace: vi.fn(), limit: vi.fn() }))
vi.mock('@/lib/auth', () => authMock)
vi.mock('@sim/audit', () => auditMock)
vi.mock('@sim/platform-authz/workspace', () => workspaceAuthzMock)
vi.mock('@/lib/core/network/config.server', () => networkConfigMock)
vi.mock('@/lib/core/rate-limiter/route-helpers', () => ({ enforceUserRateLimit: ports.limit }))
vi.mock('./enrollment-repository', () => ({ enrollmentRepository: { workspace: ports.workspace } }))

import { createAgentCaptureHttpHandlers } from './agent-capture-http'

const origin = 'https://memlia.example'
const input = {
  agentId: 'agent',
  requestId: '11111111-1111-4111-8111-111111111111',
  maxDurationSeconds: 60,
  maxBytes: 1024,
}
const ctx = { params: { id: 'space' } }
const summary = {
  commandId: 'command',
  requestId: input.requestId,
  agentId: 'agent',
  status: 'queued',
  outcome: null,
  createdAt: Date.now(),
  exportStatus: 'none',
}
const req = (body: unknown = input, headers: Record<string, string> = {}) =>
  new NextRequest(origin + '/api/workspaces/space/desktop-agent-captures', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
function setup() {
  const service = {
    createIntent: vi.fn(async () => summary),
    listOwned: vi.fn(async () => ({
      observedAt: Date.now(),
      devices: [],
      commands: [],
      truncated: false,
    })),
  }
  const getService = vi.fn(async () => service)
  return {
    service,
    getService,
    handlers: createAgentCaptureHttpHandlers({
      getService: getService as never,
      getOrigin: () => origin,
    }),
  }
}
beforeEach(() => {
  vi.clearAllMocks()
  authMockFns.mockGetSession.mockResolvedValue({
    user: { id: 'owner' },
    session: { id: 'session' },
  })
  workspaceAuthzMockFns.mockResolveEffectiveWorkspacePermission.mockResolvedValue('write')
  ports.workspace.mockResolvedValue({
    workspaceId: 'space',
    workspaceOrganizationId: null,
    allowPersonalApiKeys: false,
  })
  ports.limit.mockResolvedValue(null)
})
describe('capture HTTP native session funnel with explicit repository boundary', () => {
  it('uses native actor and canonical workspace with a stable request id and no consent', async () => {
    const s = setup()
    const r = await s.handlers.POST(req(), ctx)
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual(summary)
    expect(s.service.createIntent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'session', userId: 'owner', sessionId: 'session' }),
      { workspaceId: 'space', ...input }
    )
    expect(r.headers.get('cache-control')).toBe('private, no-store')
  })
  it('refuses foreign origin, desktop session injection and oversized body before repository effects', async () => {
    for (const request of [
      req(input, { origin: 'https://foreign.test' }),
      req({ ...input, sessionId: 'chosen' }),
      req({ ...input, ownerUserId: 'foreign' }),
      req({ ...input, extra: 'x'.repeat(1200) }),
    ]) {
      const s = setup()
      expect((await s.handlers.POST(request, ctx)).status).toBeGreaterThanOrEqual(400)
      expect(s.getService).not.toHaveBeenCalled()
    }
  })
  it('refuses missing session and workspace write permission without constructing service', async () => {
    const s = setup()
    authMockFns.mockGetSession.mockResolvedValue(null)
    expect((await s.handlers.POST(req(), ctx)).status).toBe(401)
    authMockFns.mockGetSession.mockResolvedValue({
      user: { id: 'owner' },
      session: { id: 'session' },
    })
    workspaceAuthzMockFns.mockResolveEffectiveWorkspacePermission.mockResolvedValue('read')
    expect((await s.handlers.POST(req(), ctx)).status).toBe(403)
    expect(s.getService).not.toHaveBeenCalled()
  })
  it('lists only through the same session funnel and forwards the bounded reconciliation key', async () => {
    const s = setup()
    const r = await s.handlers.GET(
      new NextRequest(
        origin + '/api/workspaces/space/desktop-agent-captures?requestId=' + input.requestId
      ),
      ctx
    )
    expect(r.status).toBe(200)
    expect(s.service.listOwned).toHaveBeenCalledWith(expect.objectContaining({ userId: 'owner' }), {
      workspaceId: 'space',
      requestId: input.requestId,
    })
  })
  it('does not expose a repository error or malformed result as success', async () => {
    const s = setup()
    s.service.createIntent.mockRejectedValueOnce(Error('PRIVATE-CANARY'))
    const r = await s.handlers.POST(req(), ctx)
    expect(r.status).toBeGreaterThanOrEqual(400)
    expect(await r.text()).not.toContain('PRIVATE-CANARY')
  })
})
