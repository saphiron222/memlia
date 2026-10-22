// Copyright (c) 2026 Memlia. All rights reserved.
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { recordAudit } from '@sim/audit'
import { type Principal, parsePrincipal } from '@sim/auth/principal'
import { z } from 'zod'
import { defineAuthorizedWorkspaceUseCase } from '@/lib/core/application/authorized-workspace-use-case'
import { defineWorkspaceOperation } from '@/lib/core/application/workspace-operation'
import { OrchestrationError } from '@/lib/core/orchestration/types'
import {
  type CertificateRecord,
  type EnrollmentRecord,
  type EnrollmentRepository,
  enrollmentRepository,
} from './enrollment-repository'

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const digest = z.string().regex(/^[0-9a-f]{64}$/)
const code = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
const csrPem = z.string().min(1).max(16384)
const createSchema = z.strictObject({ workspaceId: id })
const revokeSchema = createSchema.extend({ enrollmentId: id })
const challengeSchema = z.strictObject({
  enrollmentId: id,
  code,
  csrPem,
  windowsSid: z
    .string()
    .regex(/^S-1-\d+(?:-\d+){1,14}$/)
    .max(184),
})
const completeSchema = z.strictObject({
  enrollmentId: id,
  code,
  csrPem,
  signature: z
    .string()
    .regex(/^[A-Za-z0-9_+/=-]+$/)
    .min(1)
    .max(8192),
})
const certificateSchema = z
  .strictObject({
    certificateSerial: z.string().regex(/^[0-9a-f]{1,40}$/),
    certificateSha256: digest,
    certificatePem: z.string().min(1).max(16384),
    spkiSha256: digest,
    notBefore: z.number().int().min(0).max(8640000000000000),
    notAfter: z.number().int().min(0).max(8640000000000000),
  })
  .refine((c) => c.notBefore < c.notAfter)
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const refused = () => new OrchestrationError('forbidden', 'enrollment_refused')
function parse<S extends z.ZodType>(schema: S, input: unknown): Readonly<z.infer<S>> {
  const result = schema.safeParse(input)
  if (!result.success) throw refused()
  return Object.freeze(result.data)
}

type Binding = Readonly<{
  enrollmentId: string
  organizationId: string | null
  workspaceId: string
  ownerUserId: string
  installationId: string
  fqdn: string
  windowsSid: string
  csrSha256: string
  spkiSha256: string
  challenge: string
  expiresAt: number
}>
export type EnrollmentIssuanceRequest = Binding &
  Readonly<{ issuanceId: string; agentId: string; bindingDigest: string; csrPem: string }>
export type EnrollmentAuthorityResult =
  | Readonly<{ status: 'unknown' }>
  | Readonly<{
      status: 'issued'
      issuanceId: string
      bindingDigest: string
      certificate: CertificateRecord
    }>
/** Server-configured native port. Implementations verify PKCS#10, PoP and CA certificate
 * bindings cryptographically, capture bounded private diagnostics before throwing, and
 * make lookup read-only. issue is never called again for a durable issuance ID. No default CA. */
export interface EnrollmentAuthority {
  verifyCsr(pem: string): Promise<Readonly<{ csrSha256: string; spkiSha256: string }>>
  verifyPossession(
    input: Readonly<{
      csrPem: string
      csrSha256: string
      spkiSha256: string
      challengePayload: string
      signature: string
    }>
  ): Promise<boolean>
  issue(input: EnrollmentIssuanceRequest): Promise<EnrollmentAuthorityResult>
  lookupIssuance(input: EnrollmentIssuanceRequest): Promise<EnrollmentAuthorityResult>
  revokeCertificate(
    input: Readonly<{ issuanceId: string; agentId: string; bindingDigest: string }>
  ): Promise<boolean>
}
export type EnrollmentResult =
  | Readonly<{ status: 'issuance_unknown'; enrollmentId: string }>
  | Readonly<{
      status: 'issued'
      enrollmentId: string
      agentId: string
      issuanceId: string
      bindingDigest: string
      certificate: CertificateRecord
    }>
function binding(row: EnrollmentRecord): Binding {
  if (!row.csrSha256 || !row.spkiSha256 || !row.windowsSid || !row.challenge) throw refused()
  return Object.freeze({
    enrollmentId: row.id,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    ownerUserId: row.ownerUserId,
    installationId: row.installationId,
    fqdn: row.fqdn,
    windowsSid: row.windowsSid,
    csrSha256: row.csrSha256,
    spkiSha256: row.spkiSha256,
    challenge: row.challenge,
    expiresAt: row.expiresAt,
  })
}
function payload(row: EnrollmentRecord) {
  return JSON.stringify({ domain: 'memlia.desktop.enrollment.v1', ...binding(row) })
}
function issuance(row: EnrollmentRecord, pem: string): EnrollmentIssuanceRequest {
  if (!row.issuanceId || !row.agentId || sha(payload(row)) !== row.challengeDigest) throw refused()
  return Object.freeze({
    ...binding(row),
    issuanceId: row.issuanceId,
    agentId: row.agentId,
    csrPem: pem,
    bindingDigest: sha(
      JSON.stringify({
        domain: 'memlia.desktop.certificate.v1',
        ...binding(row),
        issuanceId: row.issuanceId,
        agentId: row.agentId,
      })
    ),
  })
}
function session(principal: Principal) {
  try {
    const captured = parsePrincipal({ version: 1, principal: { ...principal } })
    if (captured.kind !== 'session') throw refused()
    return Object.freeze(captured)
  } catch {
    throw refused()
  }
}

/** Browser create/revoke use the existing session/workspace funnel. Agent challenge and
 * completion have only the one-shot secret plus cryptographic PoP; they mint no principal. */
export function createEnrollmentService(ports: {
  repository?: EnrollmentRepository
  authority: EnrollmentAuthority | null
  installation: { id: string; fqdn: string }
}) {
  const repository = ports.repository ?? enrollmentRepository
  const installation = Object.freeze({ ...ports.installation })
  const origin = new URL(installation.fqdn)
  if (
    !id.safeParse(installation.id).success ||
    origin.protocol !== 'https:' ||
    origin.origin !== installation.fqdn ||
    origin.username ||
    origin.password
  )
    throw new Error('enrollment_configuration_refused')
  const authority =
    ports.authority &&
    Object.freeze({
      verifyCsr: ports.authority.verifyCsr.bind(ports.authority),
      verifyPossession: ports.authority.verifyPossession.bind(ports.authority),
      issue: ports.authority.issue.bind(ports.authority),
      lookupIssuance: ports.authority.lookupIssuance.bind(ports.authority),
      revokeCertificate: ports.authority.revokeCertificate.bind(ports.authority),
    })
  function configured() {
    if (!authority) throw new OrchestrationError('conflict', 'enrollment_unavailable')
    return authority
  }
  async function context(input: { workspaceId: string }) {
    const resolved = await repository.workspace(input.workspaceId)
    if (!resolved || resolved.workspaceId !== input.workspaceId) throw refused()
    return Object.freeze({ ...resolved })
  }
  function requireRow(
    row: EnrollmentRecord | null,
    hash: string,
    requireActive = true
  ): EnrollmentRecord {
    if (
      !row ||
      row.codeHash !== hash ||
      row.installationId !== installation.id ||
      row.fqdn !== installation.fqdn ||
      row.status === 'revoked' ||
      (requireActive && !row.active)
    )
      throw refused()
    return Object.freeze({ ...row })
  }
  const create = defineAuthorizedWorkspaceUseCase({
    operation: defineWorkspaceOperation({
      id: 'desktop_agent.enrollment.create',
      minimumRole: 'write',
      workspaceApiKey: 'deny',
      principalKinds: ['session'],
      capability: 'none',
    }), // Enrollment grants no replay capability.
    authorizationOptions: {},
    resolveContext: ({ input }: { input: z.infer<typeof createSchema> }) => context(input),
    async execute({ principal, context }) {
      configured()
      const secret = randomBytes(32).toString('base64url')
      const row = await repository.createPending({
        id: randomUUID(),
        organizationId: context.workspaceOrganizationId,
        workspaceId: context.workspaceId,
        ownerUserId: principal.userId,
        installationId: installation.id,
        fqdn: installation.fqdn,
        codeHash: sha(secret),
      })
      return Object.freeze({ enrollmentId: row.id, code: secret, expiresAt: row.expiresAt })
    },
    projectAudit: ({ result }) => ({
      action: 'desktop_agent_enrollment.created',
      resourceType: 'desktop_device',
      resourceId: result.enrollmentId,
    }),
  })
  const revoke = defineAuthorizedWorkspaceUseCase({
    operation: defineWorkspaceOperation({
      id: 'desktop_agent.enrollment.revoke_own',
      minimumRole: 'write',
      workspaceApiKey: 'deny',
      principalKinds: ['session'],
      capability: 'none',
    }),
    authorizationOptions: {},
    resolveContext: ({ input }: { input: z.infer<typeof revokeSchema> }) => context(input),
    async execute({ principal, input }) {
      const row = await repository.revoke(input.enrollmentId, principal.userId, input.workspaceId)
      if (!row) throw refused()
      let certificateRevocation: 'not_issued' | 'confirmed' | 'unknown' = 'not_issued'
      if (row.issuanceId && row.agentId) {
        certificateRevocation = 'unknown'
        if (authority) {
          try {
            const request = issuance(row, '')
            if (
              (await authority.revokeCertificate(
                Object.freeze({
                  issuanceId: request.issuanceId,
                  agentId: request.agentId,
                  bindingDigest: request.bindingDigest,
                })
              )) === true
            )
              certificateRevocation = 'confirmed'
          } catch {
            /* DB revocation remains effective; CA acknowledgement is unknown. */
          }
        }
      }
      return Object.freeze({
        status: 'revoked' as const,
        enrollmentId: row.id,
        certificateRevocation,
      })
    },
    projectAudit: ({ result }) => ({
      action: 'desktop_agent_enrollment.revoked',
      resourceType: 'desktop_device',
      resourceId: result.enrollmentId,
      metadata: { certificateRevocation: result.certificateRevocation },
    }),
  })
  async function unknown(row: EnrollmentRecord): Promise<EnrollmentResult> {
    if (row.issuanceId) {
      try {
        await repository.markIssuanceUnknown(row.id, row.issuanceId)
      } catch {
        /* The durable issuing row also forbids a second issue call. */
      }
    }
    recordAudit({
      workspaceId: row.workspaceId,
      actorId: row.ownerUserId,
      action: 'desktop_agent_enrollment.issuance_unknown',
      resourceType: 'desktop_device',
      resourceId: row.id,
      metadata: { issuanceId: row.issuanceId },
    })
    return Object.freeze({ status: 'issuance_unknown', enrollmentId: row.id })
  }
  return Object.freeze({
    create: {
      ...create,
      execute: (args: Parameters<typeof create.execute>[0]) =>
        create.execute({
          ...args,
          principal: session(args.principal),
          input: parse(createSchema, args.input),
        }),
      authorize: (args: Parameters<typeof create.authorize>[0]) =>
        create.authorize({
          ...args,
          principal: session(args.principal),
          input: parse(createSchema, args.input),
        }),
    },
    revoke: {
      ...revoke,
      execute: (args: Parameters<typeof revoke.execute>[0]) =>
        revoke.execute({
          ...args,
          principal: session(args.principal),
          input: parse(revokeSchema, args.input),
        }),
      authorize: (args: Parameters<typeof revoke.authorize>[0]) =>
        revoke.authorize({
          ...args,
          principal: session(args.principal),
          input: parse(revokeSchema, args.input),
        }),
    },
    async challenge(input: unknown) {
      const ca = configured()
      const parsed = parse(challengeSchema, input)
      const hash = sha(parsed.code)
      const row = requireRow(await repository.read(parsed.enrollmentId, hash), hash)
      if (!['pending', 'challenged'].includes(row.status)) throw refused()
      let key: { csrSha256: string; spkiSha256: string }
      try {
        key = parse(
          z.strictObject({ csrSha256: digest, spkiSha256: digest }),
          await ca.verifyCsr(parsed.csrPem)
        )
      } catch {
        throw refused()
      }
      if (key.csrSha256 !== sha(parsed.csrPem)) throw refused()
      const proposed = {
        ...row,
        ...key,
        windowsSid: parsed.windowsSid,
        challenge: randomBytes(32).toString('base64url'),
      }
      const saved = await repository.bindChallenge({
        id: row.id,
        codeHash: hash,
        revision: row.revision,
        ...key,
        windowsSid: parsed.windowsSid,
        challenge: proposed.challenge,
        challengeDigest: sha(payload(proposed)),
      })
      const bound = requireRow(saved, hash)
      if (
        bound.csrSha256 !== key.csrSha256 ||
        bound.spkiSha256 !== key.spkiSha256 ||
        bound.windowsSid !== parsed.windowsSid ||
        sha(payload(bound)) !== bound.challengeDigest
      )
        throw refused()
      return Object.freeze({
        enrollmentId: bound.id,
        challengePayload: payload(bound),
        expiresAt: bound.expiresAt,
      })
    },
    async complete(input: unknown): Promise<EnrollmentResult> {
      const ca = configured()
      const parsed = parse(completeSchema, input)
      const hash = sha(parsed.code)
      let row = requireRow(await repository.read(parsed.enrollmentId, hash), hash)
      if (
        !['challenged', 'issuing', 'issuance_unknown', 'issued'].includes(row.status) ||
        row.csrSha256 !== sha(parsed.csrPem) ||
        sha(payload(row)) !== row.challengeDigest
      )
        throw refused()
      let proof = false
      try {
        proof = await ca.verifyPossession(
          Object.freeze({
            csrPem: parsed.csrPem,
            csrSha256: row.csrSha256,
            spkiSha256: binding(row).spkiSha256,
            challengePayload: payload(row),
            signature: parsed.signature,
          })
        )
      } catch {
        throw refused()
      }
      if (proof !== true) throw refused()
      if (row.status === 'issued') {
        if (!row.issuanceId || !row.agentId) throw refused()
        const certificate = await repository.readCertificate(row.id, row.issuanceId)
        if (!certificate) throw refused()
        const request = issuance(row, parsed.csrPem)
        return Object.freeze({
          status: 'issued',
          enrollmentId: row.id,
          agentId: row.agentId,
          issuanceId: request.issuanceId,
          bindingDigest: request.bindingDigest,
          certificate: Object.freeze({ ...certificate }),
        })
      }
      let fresh = false
      if (row.status === 'challenged') {
        const started = await repository.beginIssuance({
          id: row.id,
          codeHash: hash,
          revision: row.revision,
          issuanceId: randomUUID(),
          agentId: randomUUID(),
        })
        if (!started) return Object.freeze({ status: 'issuance_unknown', enrollmentId: row.id })
        row = requireRow(started, hash)
        fresh = true
      }
      const request = issuance(row, parsed.csrPem)
      let result: EnrollmentAuthorityResult
      try {
        result = await (fresh ? ca.issue(request) : ca.lookupIssuance(request))
      } catch {
        return unknown(row)
      }
      const receipt = z
        .strictObject({
          status: z.literal('issued'),
          issuanceId: z.string(),
          bindingDigest: digest,
          certificate: certificateSchema,
        })
        .safeParse(result)
      if (
        !receipt.success ||
        receipt.data.issuanceId !== request.issuanceId ||
        receipt.data.bindingDigest !== request.bindingDigest ||
        receipt.data.certificate.spkiSha256 !== row.spkiSha256
      )
        return unknown(row)
      let certificate: CertificateRecord | null
      try {
        certificate = await repository.finishIssuance({
          id: row.id,
          issuanceId: request.issuanceId,
          certificate: Object.freeze(receipt.data.certificate),
        })
      } catch {
        return unknown(row)
      }
      if (!certificate) {
        // A concurrent reconciler may already have committed. Never revoke its certificate.
        const current = await repository.read(row.id, hash)
        if (current?.status === 'issued' && current.issuanceId === request.issuanceId)
          certificate = await repository.readCertificate(row.id, request.issuanceId)
        if (!certificate) {
          if (current?.status === 'revoked' || current?.active === false) {
            try {
              await ca.revokeCertificate(
                Object.freeze({
                  issuanceId: request.issuanceId,
                  agentId: request.agentId,
                  bindingDigest: request.bindingDigest,
                })
              )
            } catch {
              /* No activation; acknowledgement remains unknown. */
            }
          }
          return unknown(row)
        }
      }
      recordAudit({
        workspaceId: row.workspaceId,
        actorId: row.ownerUserId,
        action: 'desktop_agent_enrollment.issued',
        resourceType: 'desktop_device',
        resourceId: row.id,
        metadata: { issuanceId: request.issuanceId, agentId: request.agentId },
      })
      return Object.freeze({
        status: 'issued',
        enrollmentId: row.id,
        agentId: request.agentId,
        issuanceId: request.issuanceId,
        bindingDigest: request.bindingDigest,
        certificate: Object.freeze({ ...certificate }),
      })
    },
  })
}
