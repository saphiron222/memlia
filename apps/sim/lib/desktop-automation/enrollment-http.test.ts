// Copyright (c) 2026 Memlia. All rights reserved.

import { auditMock } from '@sim/testing/mocks/audit.mock'
import { authMock, authMockFns } from '@sim/testing/mocks/auth.mock'
import { networkConfigMock } from '@sim/testing/mocks/network-config.mock'
import { workspaceAuthzMock, workspaceAuthzMockFns } from '@sim/testing/mocks/workspace-authz.mock'
import { NextRequest, NextResponse } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const limits = vi.hoisted(() => ({ user: vi.fn(), ip: vi.fn() }))
vi.mock('@/lib/auth', () => authMock)
vi.mock('@sim/audit', () => auditMock)
vi.mock('@sim/platform-authz/workspace', () => workspaceAuthzMock)
vi.mock('@/lib/core/network/config.server', () => networkConfigMock)
vi.mock('@/lib/core/rate-limiter/route-helpers', () => ({
  enforceUserRateLimit: limits.user,
  enforceIpRateLimit: limits.ip,
}))
vi.mock('./enrollment-repository', () => ({ enrollmentRepository: {} }))

import { ENROLLMENT_ONESHOT_MAX_BODY_BYTES } from '@/lib/api/contracts/desktop-agent-enrollment'
import {
  createEnrollmentService,
  type EnrollmentAuthority,
  type EnrollmentResult,
} from './enrollment'
import { createEnrollmentHttpHandlers } from './enrollment-http'
import type { EnrollmentRecord, EnrollmentRepository } from './enrollment-repository'

const origin = 'https://memlia.example'
const enrollmentId = '00000000-0000-4000-8000-000000000001'
const challengeBody = {
  enrollmentId,
  code: 'a'.repeat(43),
  csrPem: '-----BEGIN CERTIFICATE REQUEST-----\nfixture\n-----END CERTIFICATE REQUEST-----',
  windowsSid: 'S-1-5-21-1-2-3-1001',
}
const completeBody = {
  enrollmentId,
  code: challengeBody.code,
  csrPem: challengeBody.csrPem,
  signature: 'cHJvb2Y=',
}
const context = { params: { id: 'space', enrollmentId } }
const createContext = { params: { id: 'space' } }
function request(path: string, body: unknown = {}, headers: Record<string, string> = {}) {
  return new NextRequest(`${origin}${path}`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}
const paths = {
  create: '/api/workspaces/space/desktop-agent-enrollments',
  revoke: `/api/workspaces/space/desktop-agent-enrollments/${enrollmentId}/revoke`,
  challenge: '/api/desktop-agent-enrollments/challenge',
  complete: '/api/desktop-agent-enrollments/complete',
}
function setup() {
  const row: EnrollmentRecord = {
    id: enrollmentId,
    organizationId: null,
    workspaceId: 'space',
    ownerUserId: 'owner',
    installationId: 'installation',
    fqdn: origin,
    codeHash: 'a'.repeat(64),
    status: 'pending',
    revision: 0,
    createdAt: 1000,
    expiresAt: 301000,
    revokedAt: null,
    active: true,
    csrSha256: null,
    spkiSha256: null,
    windowsSid: null,
    challenge: null,
    challengeDigest: null,
    issuanceId: null,
    agentId: null,
  }
  const repository = {
    workspace: vi.fn(async () => ({
      workspaceId: 'space',
      workspaceOrganizationId: null,
      allowPersonalApiKeys: false,
    })),
    createPending: vi.fn(async () => row),
    revoke: vi.fn(async () => row),
    read: vi.fn(),
    bindChallenge: vi.fn(),
    beginIssuance: vi.fn(),
    finishIssuance: vi.fn(),
    markIssuanceUnknown: vi.fn(),
    readCertificate: vi.fn(),
  } satisfies EnrollmentRepository
  const authority: EnrollmentAuthority = {
    verifyCsr: vi.fn(),
    verifyPossession: vi.fn(),
    issue: vi.fn(),
    lookupIssuance: vi.fn(),
    revokeCertificate: vi.fn(),
  }
  const native = createEnrollmentService({
    repository,
    authority,
    installation: { id: 'installation', fqdn: origin },
  })
  // Session use cases remain native. Only one-shot domain transitions are doubled here;
  // PG/CA and replay fencing have their own tests and are not qualified by this suite.
  const challenge = vi.fn(async (_input: unknown) => ({
    enrollmentId,
    challengePayload: 'bound-challenge',
    expiresAt: 301000,
  }))
  const complete = vi.fn(
    async (_input: unknown): Promise<EnrollmentResult> => ({
      status: 'issuance_unknown' as const,
      enrollmentId,
    })
  )
  const service = { ...native, challenge, complete }
  const getService = vi.fn(async () => service)
  const getOrigin = vi.fn((): string | null => origin)
  return {
    repository,
    challenge,
    complete,
    service,
    getService,
    getOrigin,
    handlers: createEnrollmentHttpHandlers({ getService, getOrigin }),
  }
}
async function refused(response: Response, status = 403) {
  expect(response.status).toBe(status)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(await response.json()).toMatchObject({ error: 'enrollment_refused' })
}
beforeEach(() => {
  vi.clearAllMocks()
  authMockFns.mockGetSession.mockResolvedValue({
    user: { id: 'owner' },
    session: { id: 'session' },
  })
  workspaceAuthzMockFns.mockResolveEffectiveWorkspacePermission.mockResolvedValue('write')
  limits.user.mockResolvedValue(null)
  limits.ip.mockResolvedValue(null)
})

describe('enrollment HTTP native parsing/session funnel, service/CA boundaries declared', () => {
  it('creates for the native session owner and returns the one-shot code only in a no-store body', async () => {
    const s = setup()
    const response = await s.handlers.create(request(paths.create), createContext)
    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result).toEqual({
      enrollmentId,
      code: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      expiresAt: 301000,
    })
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(s.repository.createPending).toHaveBeenCalledWith(
      expect.objectContaining({ ownerUserId: 'owner', workspaceId: 'space' })
    )
    expect(limits.user).toHaveBeenCalledWith(
      'desktop-agent-enrollment.session',
      'owner',
      expect.any(Object)
    )
    expect(limits.ip).not.toHaveBeenCalled()
    expect(authMockFns.mockGetSession).toHaveBeenCalledTimes(1)
  })
  it('revokes only the native session owner and path scope', async () => {
    const s = setup()
    const response = await s.handlers.revoke(request(paths.revoke), context)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      status: 'revoked',
      enrollmentId,
      certificateRevocation: 'not_issued',
    })
    expect(s.repository.revoke).toHaveBeenCalledWith(enrollmentId, 'owner', 'space')
  })
  it.each(['create', 'revoke'] as const)(
    'requires a session for %s despite identity/API headers',
    async (kind) => {
      const s = setup()
      authMockFns.mockGetSession.mockResolvedValue(null)
      await refused(
        await s.handlers[kind](
          request(paths[kind], {}, { 'x-user-id': 'owner', 'x-api-key': 'fixture' }),
          kind === 'create' ? createContext : context
        ),
        401
      )
      expect(s.repository.workspace).not.toHaveBeenCalled()
      expect(s.getService).not.toHaveBeenCalled()
    }
  )
  it.each(['read', null] as const)(
    'conceals native workspace permission refusal %s',
    async (permission) => {
      const s = setup()
      workspaceAuthzMockFns.mockResolveEffectiveWorkspacePermission.mockResolvedValue(permission)
      await refused(await s.handlers.create(request(paths.create), createContext))
      expect(s.repository.createPending).not.toHaveBeenCalled()
    }
  )
  it.each(['https://foreign.example', 'null', '', `${origin}/`, `${origin}.evil`])(
    'refuses Origin %s before service initialization',
    async (value) => {
      const s = setup()
      await refused(
        await s.handlers.create(request(paths.create, {}, { origin: value }), createContext)
      )
      expect(s.getService).not.toHaveBeenCalled()
    }
  )
  it('refuses a missing Origin and native cross-site indication', async () => {
    const s = setup()
    const req = request(paths.create)
    req.headers.delete('origin')
    await refused(await s.handlers.create(req, createContext))
    await refused(
      await s.handlers.revoke(
        request(paths.revoke, {}, { 'sec-fetch-site': 'cross-site' }),
        context
      )
    )
    expect(s.getService).not.toHaveBeenCalled()
  })
  it.each([{ ownerUserId: 'foreign' }, { userId: 'foreign' }, { workspaceId: 'foreign' }])(
    'rejects client authority fields %#',
    async (body) => {
      const s = setup()
      await refused(await s.handlers.create(request(paths.create, body), createContext), 400)
      expect(s.repository.workspace).not.toHaveBeenCalled()
    }
  )
  it('rejects unknown queries and malformed paths before the native use case', async () => {
    const s = setup()
    await refused(
      await s.handlers.create(request(`${paths.create}?code=never-log`), createContext),
      400
    )
    await refused(
      await s.handlers.revoke(request(paths.revoke), {
        params: { id: 'space', enrollmentId: `${enrollmentId}\n` },
      }),
      400
    )
    expect(s.repository.workspace).not.toHaveBeenCalled()
  })
  it('keeps authenticated and one-shot limits separate, before effects/crypto', async () => {
    const s = setup()
    limits.user.mockResolvedValue(NextResponse.json({ error: 'limit' }, { status: 429 }))
    await refused(await s.handlers.create(request(paths.create), createContext), 429)
    expect(s.repository.workspace).not.toHaveBeenCalled()
    limits.ip.mockResolvedValue(NextResponse.json({ error: 'limit' }, { status: 429 }))
    await refused(await s.handlers.challenge(request(paths.challenge, challengeBody)), 429)
    expect(limits.ip).toHaveBeenCalledWith(
      'desktop-agent-enrollment.oneshot',
      expect.any(NextRequest),
      expect.any(Object)
    )
    expect(s.challenge).not.toHaveBeenCalled()
  })
  it('uses no cookie principal for challenge or complete', async () => {
    const s = setup()
    authMockFns.mockGetSession.mockRejectedValue(new Error('must not read cookie session'))
    expect((await s.handlers.challenge(request(paths.challenge, challengeBody))).status).toBe(200)
    const result = await s.handlers.complete(request(paths.complete, completeBody))
    expect(result.status).toBe(202)
    expect(await result.json()).toEqual({ status: 'issuance_unknown', enrollmentId })
    expect(authMockFns.mockGetSession).not.toHaveBeenCalled()
    expect(s.challenge).toHaveBeenCalledWith(challengeBody)
    expect(s.complete).toHaveBeenCalledWith(completeBody)
  })
  it.each([
    { ...challengeBody, code: `${challengeBody.code}\n` },
    { ...challengeBody, csrPem: 'x'.repeat(16385) },
    { ...challengeBody, windowsSid: 'S-1-5-21\n' },
    { ...challengeBody, ownerUserId: 'foreign' },
  ])('rejects malformed one-shot inputs %#', async (body) => {
    const s = setup()
    await refused(await s.handlers.challenge(request(paths.challenge, body)), 400)
    expect(s.challenge).not.toHaveBeenCalled()
  })
  it('bounds streamed bodies before JSON without Content-Length and ignores raw error messages', async () => {
    const s = setup()
    const req = request(paths.challenge, 'x'.repeat(ENROLLMENT_ONESHOT_MAX_BODY_BYTES))
    expect(req.headers.has('content-length')).toBe(false)
    const json = vi.spyOn(req, 'json')
    await refused(await s.handlers.challenge(req), 413)
    expect(json).not.toHaveBeenCalled()
    const malformed = new NextRequest(`${origin}${paths.complete}`, { method: 'POST', body: '{' })
    await refused(await s.handlers.complete(malformed), 400)
    expect(s.complete).not.toHaveBeenCalled()
  })
  it('refuses missing configuration and rejected initialization without leaking detail', async () => {
    const s = setup()
    const absent = createEnrollmentHttpHandlers({ getOrigin: () => null, getService: s.getService })
    const response = await absent.challenge(request(paths.challenge, challengeBody))
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'enrollment_unavailable' })
    expect(s.getService).not.toHaveBeenCalled()
    const missing = createEnrollmentHttpHandlers({
      getOrigin: () => origin,
      getService: async () => null,
    })
    expect((await missing.complete(request(paths.complete, completeBody))).status).toBe(503)
    const broken = createEnrollmentHttpHandlers({
      getOrigin: () => origin,
      getService: async () => {
        throw new Error(challengeBody.code)
      },
    })
    expect(await (await broken.challenge(request(paths.challenge, challengeBody))).json()).toEqual({
      error: 'enrollment_unavailable',
    })
  })
  it('projects missing, foreign, expired, used codes and CA errors identically, never retries', async () => {
    const s = setup()
    for (const reason of ['missing', 'foreign', 'expired', 'used', challengeBody.code]) {
      s.challenge.mockRejectedValueOnce(new Error(reason))
      await refused(await s.handlers.challenge(request(paths.challenge, challengeBody)))
    }
    expect(s.challenge).toHaveBeenCalledTimes(5)
  })
  it('serves the native Windows one-shot client without an Origin or cookie identity', async () => {
    const s = setup()
    authMockFns.mockGetSession.mockRejectedValue(new Error('cookie is not an agent credential'))
    for (const kind of ['challenge', 'complete'] as const) {
      const req = request(paths[kind], kind === 'challenge' ? challengeBody : completeBody)
      req.headers.delete('origin')
      expect((await s.handlers[kind](req)).status).toBe(kind === 'challenge' ? 200 : 202)
    }
    expect(authMockFns.mockGetSession).not.toHaveBeenCalled()
  })
  it('returns only a contract-valid public certificate and refuses private or unexpected fields', async () => {
    const s = setup()
    const certificate = {
      certificateSerial: '02',
      certificateSha256: 'c'.repeat(64),
      certificatePem: '-----BEGIN CERTIFICATE-----\npublic-fixture\n-----END CERTIFICATE-----',
      spkiSha256: 'b'.repeat(64),
      notBefore: 1000,
      notAfter: 301000,
    }
    const issued = {
      status: 'issued' as const,
      enrollmentId,
      agentId: 'agent',
      issuanceId: 'issuance',
      bindingDigest: 'b'.repeat(64),
      certificate,
    }
    s.complete.mockResolvedValueOnce(issued)
    const response = await s.handlers.complete(request(paths.complete, completeBody))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(await response.json()).toEqual(issued)
    s.complete.mockResolvedValueOnce({
      ...issued,
      certificate: { ...certificate, privateKey: 'must-never-be-rendered' },
    } as unknown as EnrollmentResult)
    await refused(await s.handlers.complete(request(paths.complete, completeBody)))
  })
  it('validates outbound data, hiding unexpected certificate/private fields', async () => {
    const s = setup()
    s.challenge.mockResolvedValueOnce({ enrollmentId, challengePayload: '', expiresAt: 301000 })
    await refused(await s.handlers.challenge(request(paths.challenge, challengeBody)))
  })
  it('detaches one-shot JSON before a service await and keeps origin configuration stable', async () => {
    const s = setup()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    s.getService.mockImplementationOnce(async () => {
      await gate
      return s.service
    })
    const req = request(paths.challenge, challengeBody)
    const pending = s.handlers.challenge(req)
    await vi.waitFor(() => expect(s.getService).toHaveBeenCalled())
    s.getOrigin.mockReturnValue('https://changed.example')
    release()
    expect((await pending).status).toBe(200)
    expect(s.getOrigin).toHaveBeenCalledTimes(1)
    expect(s.challenge.mock.calls[0][0]).not.toBe(challengeBody)
  })
})
