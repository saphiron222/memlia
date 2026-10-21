// Copyright (c) 2026 Memlia. All rights reserved.
import { createHash } from 'node:crypto'
import { createSessionPrincipal } from '@sim/testing/factories/principal.factory'
import { auditMock, auditMockFns } from '@sim/testing/mocks/audit.mock'
import { networkConfigMock } from '@sim/testing/mocks/network-config.mock'
import { workspaceAuthzMock, workspaceAuthzMockFns } from '@sim/testing/mocks/workspace-authz.mock'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@sim/platform-authz/workspace', () => workspaceAuthzMock)
vi.mock('@/lib/core/network/config.server', () => networkConfigMock)
vi.mock('@sim/audit', () => auditMock)
vi.mock('./enrollment-repository', () => ({ enrollmentRepository: {} }))

import { createEnrollmentService } from './enrollment'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const csr = '-----BEGIN CERTIFICATE REQUEST-----\nZmFrZQ==\n-----END CERTIFICATE REQUEST-----\n'
const sid = 'S-1-5-21-123-456-789-1001'
const principal = createSessionPrincipal({ userId: 'owner' })
// Boundary DB double: atomic CAS and clock controlled. No native PG/CA claim.
function setup(authorityConfigured = true) {
  let now = 1_800_000_000_000
  let row: any = null
  let cert: any = null
  let issueCalls = 0
  let lookupCalls = 0
  const active = () => row && !row.revokedAt && row.expiresAt > now
  const repository = {
    workspace: async (id: string) =>
      id === 'space'
        ? { workspaceId: id, workspaceOrganizationId: 'org', allowPersonalApiKeys: false }
        : null,
    createPending: async (value: any) =>
      (row = {
        ...value,
        status: 'pending',
        revision: 0,
        createdAt: now,
        expiresAt: now + 300_000,
        revokedAt: null,
        active: true,
      }),
    read: async (id: string, codeHash: string) =>
      row?.id === id && row.codeHash === codeHash
        ? structuredClone({ ...row, active: active() })
        : null,
    bindChallenge: async (value: any) => {
      if (!active() || row.id !== value.id || row.codeHash !== value.codeHash) return null
      if (
        row.status === 'challenged' &&
        row.csrSha256 === value.csrSha256 &&
        row.spkiSha256 === value.spkiSha256 &&
        row.windowsSid === value.windowsSid
      )
        return structuredClone(row)
      if (row.status !== 'pending' || row.revision !== value.revision) return null
      row = { ...row, ...value, status: 'challenged', revision: row.revision + 1 }
      return structuredClone(row)
    },
    beginIssuance: async (value: any) => {
      if (
        !active() ||
        row.status !== 'challenged' ||
        row.id !== value.id ||
        row.codeHash !== value.codeHash ||
        row.revision !== value.revision
      )
        return null
      row = { ...row, ...value, status: 'issuing', revision: row.revision + 1 }
      return structuredClone(row)
    },
    finishIssuance: async (value: any) => {
      if (
        !active() ||
        !['issuing', 'issuance_unknown'].includes(row.status) ||
        row.issuanceId !== value.issuanceId
      )
        return null
      cert = structuredClone(value.certificate)
      row = { ...row, status: 'issued', revision: row.revision + 1 }
      return cert
    },
    markIssuanceUnknown: async (id: string, issuanceId: string) => {
      if (row.id === id && row.issuanceId === issuanceId && row.status === 'issuing')
        row.status = 'issuance_unknown'
    },
    readCertificate: async () =>
      active() && row.status === 'issued' && cert ? structuredClone(cert) : null,
    revoke: async (id: string, owner: string, workspaceId: string) => {
      if (row?.id !== id || row.ownerUserId !== owner || row.workspaceId !== workspaceId)
        return null
      row.revokedAt = now
      row.status = 'revoked'
      return structuredClone(row)
    },
  }
  let issue = async (input: any): Promise<any> => ({
    status: 'issued',
    issuanceId: input.issuanceId,
    bindingDigest: input.bindingDigest,
    certificate: {
      certificateSerial: '01ab',
      certificateSha256: 'c'.repeat(64),
      certificatePem: '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n',
      notBefore: now - 1000,
      notAfter: now + 86400000,
      spkiSha256: input.spkiSha256,
    },
  })
  let lookup = async (_input: any): Promise<any> => ({ status: 'unknown' })
  let verify = true
  const argumentsSeen: any[] = []
  const authority = {
    verifyCsr: async (pem: string) => ({ csrSha256: sha(pem), spkiSha256: 'b'.repeat(64) }),
    verifyPossession: async (input: any) => {
      argumentsSeen.push(input)
      return verify
    },
    issue: async (input: any) => {
      issueCalls++
      argumentsSeen.push(input)
      return issue(input)
    },
    lookupIssuance: async (input: any) => {
      lookupCalls++
      return lookup(input)
    },
    revokeCertificate: async () => true,
  }
  const service = createEnrollmentService({
    repository,
    authority: authorityConfigured ? authority : null,
    installation: { id: 'install', fqdn: 'https://memlia.example' },
  })
  const create = () => service.create.execute({ principal, input: { workspaceId: 'space' } })
  const challenge = (created: any, override = {}) =>
    service.challenge({
      enrollmentId: created.enrollmentId,
      code: created.code,
      csrPem: csr,
      windowsSid: sid,
      ...override,
    })
  const complete = (created: any, override = {}) =>
    service.complete({
      enrollmentId: created.enrollmentId,
      code: created.code,
      csrPem: csr,
      signature: 'c2lnbmF0dXJl',
      ...override,
    })
  return {
    service,
    create,
    challenge,
    complete,
    repository,
    authority,
    argumentsSeen,
    get row() {
      return row
    },
    get cert() {
      return cert
    },
    get issueCalls() {
      return issueCalls
    },
    get lookupCalls() {
      return lookupCalls
    },
    advance: (ms: number) => {
      now += ms
    },
    setIssue: (f: typeof issue) => {
      issue = f
    },
    setLookup: (f: typeof lookup) => {
      lookup = f
    },
    invalidProof: () => {
      verify = false
    },
  }
}
beforeEach(() => {
  vi.clearAllMocks()
  workspaceAuthzMockFns.mockResolveEffectiveWorkspacePermission.mockResolvedValue('write')
})
describe('agent enrollment native orchestration with DB/CA boundary doubles', () => {
  it('returns the same public binding after read-only issuance reconciliation', async () => {
    const s = setup()
    let receipt: any
    s.setIssue(async (request) => {
      receipt = {
        status: 'issued',
        issuanceId: request.issuanceId,
        bindingDigest: request.bindingDigest,
        certificate: {
          certificateSerial: '01ab',
          certificateSha256: 'c'.repeat(64),
          certificatePem: 'public-fixture',
          spkiSha256: request.spkiSha256,
          notBefore: 1_800_000_000_000 - 1000,
          notAfter: 1_800_000_000_000 + 86400000,
        },
      }
      return { status: 'unknown' }
    })
    const created = await s.create()
    await s.challenge(created)
    expect(await s.complete(created)).toEqual({
      status: 'issuance_unknown',
      enrollmentId: created.enrollmentId,
    })
    s.setLookup(async () => receipt)
    const result = await s.complete(created)
    expect(result).toMatchObject({
      status: 'issued',
      issuanceId: receipt.issuanceId,
      bindingDigest: receipt.bindingDigest,
    })
    expect(s.issueCalls).toBe(1)
    expect(s.lookupCalls).toBe(1)
  })
  it('returns verifiable issuance binding on fresh and already-issued completion', async () => {
    const s = setup()
    const created = await s.create()
    await s.challenge(created)
    const first = await s.complete(created)
    const repeated = await s.complete(created)
    expect(first).toMatchObject({
      status: 'issued',
      issuanceId: s.row.issuanceId,
      bindingDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(repeated).toEqual(first)
    expect(s.issueCalls).toBe(1)
  })
  it('creates a random secret once, stores only its hash and binds canonical owner/scope', async () => {
    const s = setup()
    const result = await s.create()
    expect(result.code).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(s.row.codeHash).toBe(sha(result.code))
    expect(s.row).not.toHaveProperty('code')
    expect(s.row).toMatchObject({
      ownerUserId: 'owner',
      workspaceId: 'space',
      organizationId: 'org',
      installationId: 'install',
      fqdn: 'https://memlia.example',
    })
    expect(result.expiresAt - s.row.createdAt).toBe(300000)
  })
  it('refuses an unconfigured CA before creating or consuming a code', async () => {
    const s = setup(false)
    await expect(s.create()).rejects.toThrow('enrollment_unavailable')
    expect(s.row).toBeNull()
  })
  it('binds CSR/key/SID/scope in the signed challenge and never returns the code', async () => {
    const s = setup()
    const created = await s.create()
    const bound = await s.challenge(created)
    expect(JSON.stringify(bound)).not.toContain(created.code)
    const payload = JSON.parse(bound.challengePayload)
    expect(payload).toMatchObject({
      enrollmentId: created.enrollmentId,
      ownerUserId: 'owner',
      workspaceId: 'space',
      organizationId: 'org',
      installationId: 'install',
      fqdn: 'https://memlia.example',
      windowsSid: sid,
      csrSha256: sha(csr),
      spkiSha256: 'b'.repeat(64),
    })
    expect(payload.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const result = await s.complete(created)
    expect(result.status).toBe('issued')
    expect(s.issueCalls).toBe(1)
    expect(s.argumentsSeen[0].challengePayload).toBe(bound.challengePayload)
  })
  it.each(['code', 'csr', 'sid', 'scope', 'expiry', 'proof'])(
    'refuses %s divergence before issuance',
    async (kind) => {
      const s = setup()
      const c = await s.create()
      await s.challenge(c)
      if (kind === 'expiry') s.advance(300001)
      if (kind === 'proof') s.invalidProof()
      if (kind === 'sid')
        await expect(s.challenge(c, { windowsSid: 'S-1-5-21-1002' })).rejects.toThrow()
      else
        await expect(
          s.complete(
            c,
            kind === 'code'
              ? { code: 'A'.repeat(43) }
              : kind === 'csr'
                ? { csrPem: csr.replace('ZmFrZQ', 'b3RoZXI') }
                : kind === 'scope'
                  ? { workspaceId: 'foreign' }
                  : {}
          )
        ).rejects.toThrow()
      expect(s.issueCalls).toBe(0)
    }
  )
  it('issues once when two valid completions race, exact retry only reads the existing outcome', async () => {
    const s = setup()
    const c = await s.create()
    await s.challenge(c)
    await Promise.allSettled([s.complete(c), s.complete(c)])
    expect(s.issueCalls).toBe(1)
    const result = await s.complete(c)
    expect(result.status).toBe('issued')
    expect(s.issueCalls).toBe(1)
  })
  it('reconciles unknown issuance with lookup only, retaining the durable issuance ID', async () => {
    const s = setup()
    const c = await s.create()
    await s.challenge(c)
    s.setIssue(async () => {
      throw new Error('PRIVATE_CA_CANARY')
    })
    expect(await s.complete(c)).toEqual({
      status: 'issuance_unknown',
      enrollmentId: c.enrollmentId,
    })
    const issuanceId = s.row.issuanceId
    expect(await s.complete(c)).toEqual({
      status: 'issuance_unknown',
      enrollmentId: c.enrollmentId,
    })
    expect(s.row.issuanceId).toBe(issuanceId)
    expect(s.issueCalls).toBe(1)
    expect(s.lookupCalls).toBe(1)
  })
  it('never activates a certificate if revocation wins while CA is issuing', async () => {
    const s = setup()
    const c = await s.create()
    await s.challenge(c)
    s.setIssue(async (input) => {
      await s.service.revoke.execute({
        principal,
        input: { workspaceId: 'space', enrollmentId: c.enrollmentId },
      })
      return {
        status: 'issued',
        issuanceId: input.issuanceId,
        bindingDigest: input.bindingDigest,
        certificate: {
          certificateSerial: '01ab',
          certificateSha256: 'c'.repeat(64),
          certificatePem: '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----\n',
          notBefore: 0,
          notAfter: 2000000000000,
          spkiSha256: input.spkiSha256,
        },
      }
    })
    expect((await s.complete(c)).status).not.toBe('issued')
    expect(s.cert).toBeNull()
    expect(s.row.status).toBe('revoked')
  })
  it('refuses another owner revocation and a read-only browser', async () => {
    const s = setup()
    const c = await s.create()
    await expect(
      s.service.revoke.execute({
        principal: createSessionPrincipal({ userId: 'foreign' }),
        input: { workspaceId: 'space', enrollmentId: c.enrollmentId },
      })
    ).rejects.toThrow()
    workspaceAuthzMockFns.mockResolveEffectiveWorkspacePermission.mockResolvedValue('read')
    await expect(s.create()).rejects.toThrow()
  })
})

describe('enrollment boundary failures and immutable authority', () => {
  it('rejects reassociation after issuance and preserves the first challenge on exact replay', async () => {
    const s = setup()
    const c = await s.create()
    const first = await s.challenge(c)
    expect(await s.challenge(c)).toEqual(first)
    await s.complete(c)
    await expect(s.challenge(c)).rejects.toThrow('enrollment_refused')
    expect(s.issueCalls).toBe(1)
  })
  it('captures browser owner/scope and agent input before their first await', async () => {
    const s = setup()
    const p = createSessionPrincipal({ userId: 'owner' })
    const input = { workspaceId: 'space' }
    const pending = s.service.create.execute({ principal: p, input })
    p.userId = 'foreign'
    input.workspaceId = 'foreign'
    const c = await pending
    expect(s.row.ownerUserId).toBe('owner')
    expect(s.row.workspaceId).toBe('space')
    const agent = { enrollmentId: c.enrollmentId, code: c.code, csrPem: csr, windowsSid: sid }
    const bound = s.service.challenge(agent)
    agent.windowsSid = 'S-1-5-21-999'
    agent.csrPem = 'foreign'
    await bound
    expect(s.row.windowsSid).toBe(sid)
    expect(s.row.csrSha256).toBe(sha(csr))
  })
  it('keeps CA requests immutable and excludes the secret from all audit events', async () => {
    const s = setup()
    const c = await s.create()
    await s.challenge(c)
    await s.complete(c)
    expect(s.argumentsSeen.every(Object.isFrozen)).toBe(true)
    expect(JSON.stringify(s.argumentsSeen)).not.toContain(c.code)
    expect(JSON.stringify(auditMockFns.mockRecordAudit.mock.calls)).not.toContain(c.code)
    expect(auditMockFns.mockRecordAudit.mock.calls.map((x) => x[0].action)).toContain(
      'desktop_agent_enrollment.issued'
    )
  })
  it.each(['issuanceId', 'bindingDigest', 'spkiSha256'])(
    'retains unknown on mismatched CA %s without activation or another issue',
    async (key) => {
      const s = setup()
      const c = await s.create()
      await s.challenge(c)
      s.setIssue(async (request) => ({
        status: 'issued',
        issuanceId: key === 'issuanceId' ? 'foreign' : request.issuanceId,
        bindingDigest: key === 'bindingDigest' ? '0'.repeat(64) : request.bindingDigest,
        certificate: {
          certificateSerial: '01ab',
          certificateSha256: 'c'.repeat(64),
          certificatePem: 'public-fixture',
          notBefore: 1,
          notAfter: 2000000000000,
          spkiSha256: key === 'spkiSha256' ? '0'.repeat(64) : request.spkiSha256,
        },
      }))
      expect((await s.complete(c)).status).toBe('issuance_unknown')
      expect(s.cert).toBeNull()
      await s.complete(c)
      expect(s.issueCalls).toBe(1)
      expect(s.lookupCalls).toBe(1)
    }
  )
  it('reconciles a closed CA result by durable lookup after issue threw', async () => {
    const s = setup()
    const c = await s.create()
    await s.challenge(c)
    let issued: any
    s.setIssue(async (request) => {
      issued = {
        status: 'issued',
        issuanceId: request.issuanceId,
        bindingDigest: request.bindingDigest,
        certificate: {
          certificateSerial: '01ab',
          certificateSha256: 'c'.repeat(64),
          certificatePem: 'public-fixture',
          notBefore: 1,
          notAfter: 2000000000000,
          spkiSha256: request.spkiSha256,
        },
      }
      throw Error('PRIVATE_CA_CANARY')
    })
    expect((await s.complete(c)).status).toBe('issuance_unknown')
    s.setLookup(async (request) => {
      expect(request.issuanceId).toBe(issued.issuanceId)
      return issued
    })
    expect((await s.complete(c)).status).toBe('issued')
    expect(s.issueCalls).toBe(1)
    expect(s.lookupCalls).toBe(1)
  })
  it('retains unknown if the DB commit acknowledgement is lost, retry reads the committed certificate', async () => {
    const s = setup()
    const c = await s.create()
    await s.challenge(c)
    const finish = s.repository.finishIssuance
    s.repository.finishIssuance = async (value) => {
      await finish(value)
      throw Error('PRIVATE_DB_CANARY')
    }
    expect((await s.complete(c)).status).toBe('issuance_unknown')
    expect(s.row.status).toBe('issued')
    expect((await s.complete(c)).status).toBe('issued')
    expect(s.issueCalls).toBe(1)
    expect(s.lookupCalls).toBe(0)
  })
  it('refuses expired binding after PoP without invoking the signer', async () => {
    const s = setup()
    const c = await s.create()
    await s.challenge(c)
    const begin = s.repository.beginIssuance
    s.repository.beginIssuance = async (value) => {
      s.advance(300001)
      return begin(value)
    }
    expect((await s.complete(c)).status).toBe('issuance_unknown')
    expect(s.issueCalls).toBe(0)
  })
})

describe('certificate read after permission lock wait', () => {
  it.each([false, true])(
    'checks the final SQL clock after expiryDuringScope=%s',
    async (expiresDuringScope) => {
      // Native Drizzle builds the final query; only the driver/lock clock is doubled.
      vi.doMock('drizzle-orm', () => vi.importActual('drizzle-orm'))
      const { pgTable, text, timestamp, integer } = await import('drizzle-orm/pg-core')
      const { drizzle } = await import('drizzle-orm/pg-proxy')
      const E = pgTable('memlia_desktop_agent_enrollment', {
        id: text('id'),
        revision: integer('revision'),
        status: text('status'),
        issuanceId: text('issuance_id'),
        revokedAt: timestamp('revoked_at'),
        expiresAt: timestamp('expires_at'),
      })
      const C = pgTable('memlia_desktop_agent_certificate', {
        id: text('id'),
        enrollmentId: text('enrollment_id'),
        revokedAt: timestamp('revoked_at'),
        certificateSerial: text('certificate_serial'),
        certificateSha256: text('certificate_sha256'),
        certificatePem: text('certificate_pem'),
        spkiSha256: text('spki_sha256'),
        notBefore: timestamp('not_before'),
        notAfter: timestamp('not_after'),
      })
      const U = pgTable('user', {
        id: text('id'),
        banned: text('banned'),
        banExpires: timestamp('ban_expires'),
        suspendedAt: timestamp('suspended_at'),
      })
      const W = pgTable('workspace', {
        id: text('id'),
        organizationId: text('organization_id'),
        archivedAt: timestamp('archived_at'),
      })
      let expired = false
      let finalSql = ''
      const native = drizzle(async (query) => {
        finalSql = query
        const checksFreshClock = query.includes(
          '"memlia_desktop_agent_enrollment"."expires_at" > clock_timestamp()'
        )
        return {
          rows:
            expired && checksFreshClock
              ? []
              : [
                  [
                    'issuance',
                    'enrollment',
                    null,
                    '01',
                    'c'.repeat(64),
                    'public-certificate',
                    'b'.repeat(64),
                    '2026-01-01 00:00:00',
                    '2027-01-01 00:00:00',
                  ],
                ],
        }
      })
      let selects = 0
      const tx = {
        execute: async () => undefined,
        select: (fields?: any) => {
          selects++
          if (selects === 4) return native.select(fields)
          const index = selects
          const chain: any = {
            from: () => chain,
            where: () => chain,
            for: () => chain,
            limit: async () =>
              index === 1
                ? [
                    {
                      id: 'enrollment',
                      issuanceId: 'issuance',
                      status: 'issued',
                      revision: 2,
                      active: true,
                      createdAt: new Date(),
                      expiresAt: new Date(),
                      revokedAt: null,
                      ownerUserId: 'owner',
                      workspaceId: 'space',
                      organizationId: 'org',
                    },
                  ]
                : index === 2
                  ? [{ banned: false, banExpires: null, suspendedAt: null }]
                  : [{ organizationId: 'org', archivedAt: null }],
          }
          return chain
        },
      }
      vi.doMock('@sim/db', () => ({ db: { transaction: async (fn: any) => fn(tx) }, user: U }))
      vi.doMock('@sim/db/schema', () => ({
        memliaDesktopAgentEnrollment: E,
        memliaDesktopAgentCertificate: C,
        user: U,
        workspace: W,
      }))
      vi.doMock('@sim/platform-authz/workspace', () => ({
        permissionSatisfies: () => true,
        resolveEffectiveWorkspacePermission: async () => {
          expired = expiresDuringScope
          return 'write'
        },
      }))
      try {
        const { enrollmentRepository } =
          await vi.importActual<typeof import('./enrollment-repository')>('./enrollment-repository')
        const result = await enrollmentRepository.readCertificate('enrollment', 'issuance')
        expect(selects).toBe(4)
        expect(finalSql).toContain('clock_timestamp()')
        if (expiresDuringScope) expect(result).toBeNull()
        else expect(result?.certificatePem).toBe('public-certificate')
      } finally {
        vi.doUnmock('drizzle-orm')
        vi.doUnmock('@sim/db')
        vi.doUnmock('@sim/db/schema')
        vi.doUnmock('@sim/platform-authz/workspace')
        vi.resetModules()
      }
    }
  )
})

type OwnerState =
  | 'missing'
  | 'suspended'
  | 'permanent-ban'
  | 'temporary-ban'
  | 'active'
  | 'expired-ban'
type OwnerOperation =
  | 'createPending'
  | 'bindChallenge'
  | 'beginIssuance'
  | 'finishIssuance'
  | 'readCertificate'
  | 'revoke'
const ownerOperations: OwnerOperation[] = [
  'createPending',
  'bindChallenge',
  'beginIssuance',
  'finishIssuance',
  'readCertificate',
  'revoke',
]

/** Real repository/native Drizzle/ban predicate; only SQL driver/permissions are doubled. */
async function ownerFixture(state: OwnerState, operation: OwnerOperation) {
  vi.resetModules()
  vi.doMock('drizzle-orm', () => vi.importActual('drizzle-orm'))
  const schema = await vi.importActual<typeof import('@sim/db/schema')>('@sim/db/schema')
  const { getTableColumns } = await import('drizzle-orm')
  const { drizzle } = await import('drizzle-orm/pg-proxy')
  const now = new Date('2026-10-21T12:00:00.000Z')
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now.getTime())
  const calls: string[] = []
  let writes = 0
  let permissionCalls = 0
  const row = {
    id: 'enrollment',
    organizationId: 'org',
    workspaceId: 'space',
    ownerUserId: 'owner',
    installationId: 'install',
    fqdn: 'https://memlia.example',
    codeHash: 'a'.repeat(64),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 300000).toISOString(),
    revision: 2,
    status:
      operation === 'bindChallenge'
        ? 'pending'
        : operation === 'beginIssuance'
          ? 'challenged'
          : operation === 'finishIssuance'
            ? 'issuing'
            : 'issued',
    revokedAt: null,
    csrSha256: 'b'.repeat(64),
    spkiSha256: 'c'.repeat(64),
    windowsSid: sid,
    challenge: 'd'.repeat(43),
    challengeDigest: 'e'.repeat(64),
    issuanceId: 'issuance',
    agentId: 'agent',
    certificateSerial: '01',
    certificateSha256: 'f'.repeat(64),
    issuedAt: now.toISOString(),
  }
  const certificate = {
    certificateSerial: '01',
    certificateSha256: 'f'.repeat(64),
    certificatePem: 'public-fixture',
    spkiSha256: 'c'.repeat(64),
    notBefore: now.getTime() - 1000,
    notAfter: now.getTime() + 60000,
  }
  const certRow = {
    ...row,
    ...certificate,
    id: 'issuance',
    enrollmentId: 'enrollment',
    notBefore: new Date(certificate.notBefore).toISOString(),
    notAfter: new Date(certificate.notAfter).toISOString(),
  }
  const values = (
    table: typeof schema.memliaDesktopAgentEnrollment | typeof schema.memliaDesktopAgentCertificate,
    value: Record<string, unknown>
  ) => Object.keys(getTableColumns(table)).map((key) => value[key])
  const native = drizzle(async (query, params) => {
    calls.push(query)
    if (query.startsWith('SET LOCAL ')) return { rows: [] }
    if (query.startsWith('select ') && query.includes(' from "user"')) {
      expect(params).toContain('owner')
      expect(query).toContain('for update')
      if (state === 'missing') return { rows: [] }
      return {
        rows: [
          [
            state === 'permanent-ban' || state === 'temporary-ban' || state === 'expired-ban',
            state === 'temporary-ban'
              ? '2026-10-21 12:01:00'
              : state === 'expired-ban'
                ? '2026-10-21 11:59:59'
                : null,
            state === 'suspended' ? '2026-10-21 12:00:00' : null,
          ],
        ],
      }
    }
    if (query.startsWith('select ') && query.includes(' from "workspace"'))
      return { rows: [['org', null]] }
    if (query.startsWith('select ') && query.includes(' from "memlia_desktop_agent_certificate"'))
      return { rows: [values(schema.memliaDesktopAgentCertificate, certRow)] }
    if (query.startsWith('select ') && query.includes(' from "memlia_desktop_agent_enrollment"'))
      return { rows: [[...values(schema.memliaDesktopAgentEnrollment, row), true]] }
    if (query.startsWith('insert into "memlia_desktop_agent_certificate"')) {
      writes++
      return { rows: [] }
    }
    if (query.startsWith('update "memlia_desktop_agent_certificate"')) {
      writes++
      return { rows: [] }
    }
    if (
      query.startsWith('insert into "memlia_desktop_agent_enrollment"') ||
      query.startsWith('update "memlia_desktop_agent_enrollment"')
    ) {
      writes++
      return {
        rows: [
          operation === 'finishIssuance'
            ? ['enrollment']
            : [...values(schema.memliaDesktopAgentEnrollment, row), true],
        ],
      }
    }
    throw new Error('unexpected fixture SQL')
  })
  vi.doMock('@sim/db', () => ({
    db: { transaction: async (fn: (tx: typeof native) => Promise<unknown>) => fn(native) },
    user: schema.user,
  }))
  vi.doMock('@sim/db/schema', () => schema)
  vi.doMock('@sim/platform-authz/workspace', () => ({
    permissionSatisfies: () => true,
    resolveEffectiveWorkspacePermission: async (
      userId: string,
      workspaceId: string,
      organizationId: string,
      tx: unknown,
      options: unknown
    ) => {
      permissionCalls++
      expect(userId).toBe('owner')
      expect(workspaceId).toBe('space')
      expect(organizationId).toBe('org')
      expect(tx).toBe(native)
      expect(options).toEqual({ forUpdate: true })
      return 'write'
    },
  }))
  vi.doMock('@/lib/auth/access-control', () => ({
    getAccessControlConfig: () => {
      throw Error('appconfig is outside account-state fixture')
    },
    isEmailBlockedByAccessControl: () => {
      throw Error('email policy is outside account-state fixture')
    },
  }))
  try {
    const { enrollmentRepository: repository } =
      await vi.importActual<typeof import('./enrollment-repository')>('./enrollment-repository')
    let result: unknown
    let refused = false
    try {
      switch (operation) {
        case 'createPending':
          result = await repository.createPending({
            id: row.id,
            organizationId: row.organizationId,
            workspaceId: row.workspaceId,
            ownerUserId: row.ownerUserId,
            installationId: row.installationId,
            fqdn: row.fqdn,
            codeHash: row.codeHash,
          })
          break
        case 'bindChallenge':
          result = await repository.bindChallenge(row)
          break
        case 'beginIssuance':
          result = await repository.beginIssuance(row)
          break
        case 'finishIssuance':
          result = await repository.finishIssuance({
            id: row.id,
            issuanceId: 'issuance',
            certificate,
          })
          break
        case 'readCertificate':
          result = await repository.readCertificate(row.id, 'issuance')
          break
        case 'revoke':
          result = await repository.revoke(row.id, 'owner', 'space')
          break
      }
    } catch (error) {
      if (operation !== 'createPending') throw error
      refused = true
    }
    return { result, refused, calls, writes, permissionCalls }
  } finally {
    clock.mockRestore()
    for (const name of [
      'drizzle-orm',
      '@sim/db',
      '@sim/db/schema',
      '@sim/platform-authz/workspace',
      '@/lib/auth/access-control',
    ])
      vi.doUnmock(name)
    vi.resetModules()
  }
}

describe('enrollment owner account-state transaction gate', () => {
  it.each(
    ownerOperations.flatMap((operation) =>
      (['missing', 'suspended', 'permanent-ban', 'temporary-ban'] as OwnerState[]).map((state) => ({
        operation,
        state,
      }))
    )
  )('refuses $operation with $state owner before any transition', async ({ operation, state }) => {
    const observed = await ownerFixture(state, operation)
    expect(
      observed.calls.some((query) => query.includes(' from "user"') && query.includes('for update'))
    ).toBe(true)
    expect(observed.permissionCalls).toBe(0)
    expect(observed.writes).toBe(0)
    if (operation === 'createPending') expect(observed.refused).toBe(true)
    else expect(observed.result).toBeNull()
  })
  it.each(
    ownerOperations.flatMap((operation) =>
      (['active', 'expired-ban'] as OwnerState[]).map((state) => ({ operation, state }))
    )
  )('admits $operation with $state owner using native ban policy', async ({ operation, state }) => {
    const observed = await ownerFixture(state, operation)
    const ownerIndex = observed.calls.findIndex((query) => query.includes(' from "user"'))
    const workspaceIndex = observed.calls.findIndex((query) => query.includes(' from "workspace"'))
    expect(ownerIndex).toBeGreaterThanOrEqual(0)
    expect(workspaceIndex).toBeGreaterThan(ownerIndex)
    expect(observed.permissionCalls).toBe(1)
    expect(observed.refused).toBe(false)
    expect(observed.result).not.toBeNull()
  })
})
