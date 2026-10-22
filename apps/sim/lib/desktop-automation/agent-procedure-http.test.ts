// Copyright (c) 2026 Memlia. All rights reserved.
import { auditMock } from '@sim/testing/mocks/audit.mock'
import { authMock, authMockFns } from '@sim/testing/mocks/auth.mock'
import { networkConfigMock } from '@sim/testing/mocks/network-config.mock'
import { workspaceAuthzMock, workspaceAuthzMockFns } from '@sim/testing/mocks/workspace-authz.mock'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationError } from '@/lib/core/orchestration/types'

const ports = vi.hoisted(() => ({ workspace: vi.fn(), limit: vi.fn() }))
vi.mock('@/lib/auth', () => authMock)
vi.mock('@sim/audit', () => auditMock)
vi.mock('@sim/platform-authz/workspace', () => workspaceAuthzMock)
vi.mock('@/lib/core/network/config.server', () => networkConfigMock)
vi.mock('@/lib/core/rate-limiter/route-helpers', () => ({ enforceUserRateLimit: ports.limit }))
vi.mock('./enrollment-repository', () => ({ enrollmentRepository: { workspace: ports.workspace } }))

import { createAgentProcedureHttpHandlers } from './agent-procedure-http'

const origin = 'https://memlia.example'
const input = {
  requestId: '11111111-1111-4111-8111-111111111111',
  procedureId: null,
  expectedRevision: 0,
  commandId: 'command',
  name: 'Fictive',
  description: 'À tester',
}
const ctx = { params: { id: 'space' } }
const summary = {
  procedureId: '22222222-2222-4222-8222-222222222222',
  revision: 1,
  requestId: input.requestId,
  commandId: 'command',
  name: input.name,
  description: input.description,
  createdAt: Date.now(),
  status: 'to_test',
}
const req = (body: unknown = input, headers: Record<string, string> = {}) =>
  new NextRequest(origin + '/api/workspaces/space/desktop-agent-procedures', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
function setup() {
  const service = {
    saveProcedure: vi.fn(async () => summary),
    listProcedures: vi.fn(async () => ({
      procedures: [],
      versions: [],
      truncated: false,
    })),
    createPersonalTest: vi.fn(async () => ({
      commandId: 'test-command',
      requestId: input.requestId,
      agentId: 'agent',
      status: 'queued',
      outcome: null,
      createdAt: 1000,
      exportStatus: 'none',
    })),
  }
  const getService = vi.fn(async () => service)
  return {
    service,
    getService,
    handlers: createAgentProcedureHttpHandlers({
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

describe('personal procedure test HTTP', () => {
  const body = {
    procedureId: summary.procedureId,
    revision: 1,
    agentId: 'agent',
    requestId: input.requestId,
    maxDurationSeconds: 60,
  }
  const request = (value: unknown = body, headers: Record<string, string> = {}) =>
    new NextRequest(`${origin}/api/workspaces/space/desktop-agent-procedures/test`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(value),
    })
  it('personal test uses the exact immutable version and native session/write funnel', async () => {
    const s = setup()
    const r = await s.handlers.TEST(request(), ctx)
    expect(r.status).toBe(200)
    expect(r.headers.get('cache-control')).toBe('private, no-store')
    expect(await r.json()).toMatchObject({
      requestId: body.requestId,
      status: 'queued',
      exportStatus: 'none',
    })
    expect(s.service.createPersonalTest).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'session', userId: 'owner', sessionId: 'session' }),
      { workspaceId: 'space', ...body }
    )
    expect(authMockFns.mockGetSession).toHaveBeenCalledTimes(1)
  })
  it('personal test rejects browser authority and malformed version/duration before service', async () => {
    for (const change of [
      { mode: 'production' },
      { bundle: 'untrusted' },
      { sessionId: 'desktop' },
      { windowsSid: 'sid' },
      { ownerUserId: 'other' },
      { capabilityId: 'forged' },
      { revision: 0 },
      { revision: 1.5 },
      { revision: Number.MAX_SAFE_INTEGER + 1 },
      { requestId: 'invalid' },
      { maxDurationSeconds: 0 },
      { maxDurationSeconds: 1801 },
      { agentId: 'bad agent' },
    ]) {
      const s = setup()
      expect((await s.handlers.TEST(request({ ...body, ...change }), ctx)).status).toBe(400)
      expect(s.getService).not.toHaveBeenCalled()
    }
  })
  it('personal test refuses origin, query, unauthenticated, read-only and rate-limited requests', async () => {
    const s = setup()
    expect(
      (await s.handlers.TEST(request(body, { origin: 'https://foreign.test' }), ctx)).status
    ).toBe(403)
    expect(
      (await s.handlers.TEST(request(body, { 'sec-fetch-site': 'cross-site' }), ctx)).status
    ).toBe(403)
    const noOrigin = request()
    noOrigin.headers.delete('origin')
    expect((await s.handlers.TEST(noOrigin, ctx)).status).toBe(403)
    const query = new NextRequest(
      `${origin}/api/workspaces/space/desktop-agent-procedures/test?mode=test`,
      {
        method: 'POST',
        headers: { origin },
        body: JSON.stringify(body),
      }
    )
    expect((await s.handlers.TEST(query, ctx)).status).toBe(400)
    authMockFns.mockGetSession.mockResolvedValueOnce(null)
    expect((await s.handlers.TEST(request(), ctx)).status).toBe(401)
    workspaceAuthzMockFns.mockResolveEffectiveWorkspacePermission.mockResolvedValueOnce('read')
    expect((await s.handlers.TEST(request(), ctx)).status).toBe(403)
    ports.limit.mockResolvedValueOnce(Response.json({ error: 'limited' }, { status: 429 }))
    expect((await s.handlers.TEST(request(), ctx)).status).toBe(429)
    expect(s.getService).not.toHaveBeenCalled()
  })
  it('personal test bounds chunked bodies and closes errors without exposing private details', async () => {
    const s = setup()
    const encoded = new TextEncoder().encode(JSON.stringify({ ...body, extra: 'x'.repeat(17000) }))
    const chunked = new NextRequest(
      `${origin}/api/workspaces/space/desktop-agent-procedures/test`,
      {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(encoded)
            controller.close()
          },
        }),
        duplex: 'half',
      }
    )
    expect((await s.handlers.TEST(chunked, ctx)).status).toBe(413)
    expect(s.getService).not.toHaveBeenCalled()
    s.service.createPersonalTest.mockRejectedValueOnce(Error('PRIVATE-CANARY'))
    const r = await s.handlers.TEST(request(), ctx)
    expect(r.status).toBeGreaterThanOrEqual(400)
    expect(await r.text()).not.toContain('PRIVATE-CANARY')
  })
})
describe('personal procedure HTTP native session funnel', () => {
  it('uses native actor and canonical workspace with immutable version intent and no sharing authority', async () => {
    const s = setup()
    const r = await s.handlers.POST(req(), ctx)
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual(summary)
    expect(s.service.saveProcedure).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'session', userId: 'owner', sessionId: 'session' }),
      { workspaceId: 'space', ...input }
    )
    expect(r.headers.get('cache-control')).toBe('private, no-store')
  })
  it('refuses foreign origin, author or sharing injection and oversized body before repository effects', async () => {
    for (const request of [
      req(input, { origin: 'https://foreign.test' }),
      req({ ...input, share: true }),
      req({ ...input, ownerUserId: 'foreign' }),
      req({ ...input, extra: 'x'.repeat(17000) }),
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
        origin + '/api/workspaces/space/desktop-agent-procedures?procedureId=' + summary.procedureId
      ),
      ctx
    )
    expect(r.status).toBe(200)
    expect(s.service.listProcedures).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'owner' }),
      {
        workspaceId: 'space',
        procedureId: summary.procedureId,
      }
    )
  })
  it('personal procedure conflict is closed and malformed Unicode is refused before service', async () => {
    const s = setup()
    const invalid = await s.handlers.POST(req({ ...input, name: 'invalid\ud800' }), ctx)
    expect(invalid.status).toBe(400)
    expect(s.getService).not.toHaveBeenCalled()
    s.service.saveProcedure.mockRejectedValueOnce(
      new OrchestrationError('conflict', 'procedure_revision_conflict')
    )
    const conflict = await s.handlers.POST(req(), ctx)
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ error: 'procedure_revision_conflict' })
  })
  it('does not expose a repository error or malformed result as success', async () => {
    const s = setup()
    s.service.saveProcedure.mockRejectedValueOnce(Error('PRIVATE-CANARY'))
    const r = await s.handlers.POST(req(), ctx)
    expect(r.status).toBeGreaterThanOrEqual(400)
    expect(await r.text()).not.toContain('PRIVATE-CANARY')
  })
})
