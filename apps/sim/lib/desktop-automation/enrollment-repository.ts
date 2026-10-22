// Copyright (c) 2026 Memlia. All rights reserved.
import { db } from '@sim/db'
import {
  memliaDesktopAgentCertificate as C,
  memliaDesktopAgentEnrollment as E,
  user,
  workspace,
} from '@sim/db/schema'
import {
  permissionSatisfies,
  resolveEffectiveWorkspacePermission,
} from '@sim/platform-authz/workspace'
import { and, eq, getTableColumns, isNull, sql } from 'drizzle-orm'
import { isAccountBlocked } from '@/lib/auth/ban'

export type EnrollmentStatus =
  | 'pending'
  | 'challenged'
  | 'issuing'
  | 'issued'
  | 'issuance_unknown'
  | 'revoked'
export interface EnrollmentRecord {
  id: string
  organizationId: string | null
  workspaceId: string
  ownerUserId: string
  installationId: string
  fqdn: string
  codeHash: string
  createdAt: number
  expiresAt: number
  revision: number
  status: EnrollmentStatus
  revokedAt: number | null
  active: boolean
  csrSha256: string | null
  spkiSha256: string | null
  windowsSid: string | null
  challenge: string | null
  challengeDigest: string | null
  issuanceId: string | null
  agentId: string | null
}
export interface CertificateRecord {
  certificateSerial: string
  certificateSha256: string
  certificatePem: string
  notBefore: number
  notAfter: number
  spkiSha256: string
}
export type NewEnrollment = Pick<
  EnrollmentRecord,
  'id' | 'organizationId' | 'workspaceId' | 'ownerUserId' | 'installationId' | 'fqdn' | 'codeHash'
>
export type ChallengeBinding = Pick<EnrollmentRecord, 'id' | 'codeHash' | 'revision'> & {
  csrSha256: string
  spkiSha256: string
  windowsSid: string
  challenge: string
  challengeDigest: string
}
export interface EnrollmentRepository {
  workspace(id: string): Promise<{
    workspaceId: string
    workspaceOrganizationId: string | null
    allowPersonalApiKeys: boolean
  } | null>
  createPending(value: NewEnrollment): Promise<EnrollmentRecord>
  read(id: string, codeHash: string): Promise<EnrollmentRecord | null>
  bindChallenge(value: ChallengeBinding): Promise<EnrollmentRecord | null>
  beginIssuance(value: {
    id: string
    codeHash: string
    revision: number
    issuanceId: string
    agentId: string
  }): Promise<EnrollmentRecord | null>
  finishIssuance(value: {
    id: string
    issuanceId: string
    certificate: CertificateRecord
  }): Promise<CertificateRecord | null>
  markIssuanceUnknown(id: string, issuanceId: string): Promise<void>
  readCertificate(id: string, issuanceId: string): Promise<CertificateRecord | null>
  revoke(id: string, ownerUserId: string, workspaceId: string): Promise<EnrollmentRecord | null>
}
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
const active = sql<boolean>`${E.revokedAt} IS NULL AND ${E.expiresAt} > clock_timestamp()`
const selection = { ...getTableColumns(E), active }
function snapshot(row: typeof E.$inferSelect & { active: boolean }): EnrollmentRecord {
  if (
    !Number.isSafeInteger(row.revision) ||
    row.revision < 0 ||
    row.revision >= Number.MAX_SAFE_INTEGER
  )
    throw new Error('enrollment_revision_refused')
  return Object.freeze({
    ...row,
    status: row.status as EnrollmentStatus,
    createdAt: row.createdAt.getTime(),
    expiresAt: row.expiresAt.getTime(),
    revokedAt: row.revokedAt?.getTime() ?? null,
  })
}
async function limits(tx: Tx) {
  await tx.execute(sql`SET LOCAL statement_timeout = '5s'`)
  await tx.execute(sql`SET LOCAL lock_timeout = '2s'`)
}
async function currentScope(
  tx: Tx,
  row: Pick<EnrollmentRecord, 'workspaceId' | 'organizationId' | 'ownerUserId'>
) {
  const [owner] = await tx
    .select({ banned: user.banned, banExpires: user.banExpires, suspendedAt: user.suspendedAt })
    .from(user)
    .where(eq(user.id, row.ownerUserId))
    .for('update')
    .limit(1)
  if (!owner || isAccountBlocked(owner)) return false
  const [space] = await tx
    .select({ organizationId: workspace.organizationId, archivedAt: workspace.archivedAt })
    .from(workspace)
    .where(eq(workspace.id, row.workspaceId))
    .for('update')
    .limit(1)
  if (!space || space.archivedAt || space.organizationId !== row.organizationId) return false
  const role = await resolveEffectiveWorkspacePermission(
    row.ownerUserId,
    row.workspaceId,
    row.organizationId,
    tx,
    { forUpdate: true }
  )
  return role !== null && permissionSatisfies(role, 'write')
}
async function locked(tx: Tx, id: string) {
  const [row] = await tx.select(selection).from(E).where(eq(E.id, id)).for('update').limit(1)
  return row ? snapshot(row) : null
}
function writable(row: EnrollmentRecord | null): row is EnrollmentRecord {
  return row?.active === true && row.status !== 'revoked'
}
const nextRevision = sql`${E.revision} + 1`

/** Native DB-only transitions. No CA/network callback executes while a transaction is held. */
export const enrollmentRepository: EnrollmentRepository = {
  async workspace(id) {
    const [row] = await db
      .select({
        workspaceId: workspace.id,
        workspaceOrganizationId: workspace.organizationId,
        archivedAt: workspace.archivedAt,
      })
      .from(workspace)
      .where(eq(workspace.id, id))
      .limit(1)
    return row && !row.archivedAt
      ? {
          workspaceId: row.workspaceId,
          workspaceOrganizationId: row.workspaceOrganizationId,
          allowPersonalApiKeys: false,
        }
      : null
  },
  async createPending(value) {
    return db.transaction(async (tx) => {
      await limits(tx)
      if (!(await currentScope(tx, value))) throw new Error('enrollment_refused')
      const [row] = await tx
        .insert(E)
        .values({
          ...value,
          createdAt: sql`transaction_timestamp()`,
          expiresAt: sql`transaction_timestamp() + interval '5 minutes'`,
        })
        .returning(selection)
      return snapshot(row)
    })
  },
  async read(id, codeHash) {
    const [row] = await db
      .select(selection)
      .from(E)
      .where(and(eq(E.id, id), eq(E.codeHash, codeHash)))
      .limit(1)
    return row ? snapshot(row) : null
  },
  async bindChallenge(value) {
    return db.transaction(async (tx) => {
      await limits(tx)
      const row = await locked(tx, value.id)
      if (!writable(row) || row.codeHash !== value.codeHash || !(await currentScope(tx, row)))
        return null
      if (
        row.status === 'challenged' &&
        row.csrSha256 === value.csrSha256 &&
        row.spkiSha256 === value.spkiSha256 &&
        row.windowsSid === value.windowsSid
      )
        return row
      if (row.status !== 'pending' || row.revision !== value.revision) return null
      const [updated] = await tx
        .update(E)
        .set({
          csrSha256: value.csrSha256,
          spkiSha256: value.spkiSha256,
          windowsSid: value.windowsSid,
          challenge: value.challenge,
          challengeDigest: value.challengeDigest,
          status: 'challenged',
          revision: nextRevision,
        })
        .where(and(eq(E.id, row.id), eq(E.revision, row.revision), active))
        .returning(selection)
      return updated ? snapshot(updated) : null
    })
  },
  async beginIssuance(value) {
    return db.transaction(async (tx) => {
      await limits(tx)
      const row = await locked(tx, value.id)
      if (
        !writable(row) ||
        row.status !== 'challenged' ||
        row.codeHash !== value.codeHash ||
        row.revision !== value.revision ||
        !(await currentScope(tx, row))
      )
        return null
      const [updated] = await tx
        .update(E)
        .set({
          issuanceId: value.issuanceId,
          agentId: value.agentId,
          status: 'issuing',
          revision: nextRevision,
        })
        .where(and(eq(E.id, row.id), eq(E.revision, row.revision), active))
        .returning(selection)
      return updated ? snapshot(updated) : null
    })
  },
  async finishIssuance(value) {
    return db.transaction(async (tx) => {
      await limits(tx)
      const row = await locked(tx, value.id)
      if (
        !writable(row) ||
        !['issuing', 'issuance_unknown'].includes(row.status) ||
        row.issuanceId !== value.issuanceId ||
        !row.agentId ||
        !row.windowsSid ||
        !row.csrSha256 ||
        row.spkiSha256 !== value.certificate.spkiSha256 ||
        !(await currentScope(tx, row))
      )
        return null
      const cert = value.certificate
      const [updated] = await tx
        .update(E)
        .set({
          status: 'issued',
          revision: nextRevision,
          certificateSerial: cert.certificateSerial,
          certificateSha256: cert.certificateSha256,
          issuedAt: sql`clock_timestamp()`,
        })
        .where(and(eq(E.id, row.id), eq(E.revision, row.revision), active))
        .returning({ id: E.id })
      if (!updated) return null
      // Insert failure rolls the preceding CAS back; no active row can survive independently.
      await tx.insert(C).values({
        id: value.issuanceId,
        agentId: row.agentId,
        enrollmentId: row.id,
        organizationId: row.organizationId,
        workspaceId: row.workspaceId,
        ownerUserId: row.ownerUserId,
        installationId: row.installationId,
        fqdn: row.fqdn,
        windowsSid: row.windowsSid,
        csrSha256: row.csrSha256,
        ...cert,
        notBefore: new Date(cert.notBefore),
        notAfter: new Date(cert.notAfter),
      })
      return Object.freeze({ ...cert })
    })
  },
  async markIssuanceUnknown(id, issuanceId) {
    await db
      .update(E)
      .set({ status: 'issuance_unknown', revision: nextRevision })
      .where(
        and(
          eq(E.id, id),
          eq(E.issuanceId, issuanceId),
          eq(E.status, 'issuing'),
          isNull(E.revokedAt),
          sql`${E.revision} < 9007199254740991`
        )
      )
  },
  async readCertificate(id, issuanceId) {
    return db.transaction(async (tx) => {
      await limits(tx)
      const row = await locked(tx, id)
      if (
        !writable(row) ||
        row.status !== 'issued' ||
        row.issuanceId !== issuanceId ||
        !(await currentScope(tx, row))
      )
        return null
      const [cert] = await tx
        .select(getTableColumns(C))
        .from(C)
        .innerJoin(E, and(eq(E.id, C.enrollmentId), eq(E.issuanceId, C.id)))
        .where(
          and(
            eq(C.id, issuanceId),
            eq(C.enrollmentId, id),
            eq(E.status, 'issued'),
            eq(E.revision, row.revision),
            // Permission locks may have waited past the five-minute enrollment deadline.
            active,
            isNull(C.revokedAt),
            sql`${C.notAfter} > clock_timestamp()`,
            sql`${C.notBefore} <= clock_timestamp()`
          )
        )
        .limit(1)
      return cert
        ? Object.freeze({
            certificateSerial: cert.certificateSerial,
            certificateSha256: cert.certificateSha256,
            certificatePem: cert.certificatePem,
            spkiSha256: cert.spkiSha256,
            notBefore: cert.notBefore.getTime(),
            notAfter: cert.notAfter.getTime(),
          })
        : null
    })
  },
  async revoke(id, ownerUserId, workspaceId) {
    return db.transaction(async (tx) => {
      await limits(tx)
      const row = await locked(tx, id)
      if (
        !row ||
        row.ownerUserId !== ownerUserId ||
        row.workspaceId !== workspaceId ||
        !(await currentScope(tx, row))
      )
        return null
      if (row.status === 'revoked') return row
      const [updated] = await tx
        .update(E)
        .set({ status: 'revoked', revokedAt: sql`clock_timestamp()`, revision: nextRevision })
        .where(and(eq(E.id, id), eq(E.revision, row.revision)))
        .returning(selection)
      await tx
        .update(C)
        .set({ revokedAt: sql`clock_timestamp()` })
        .where(and(eq(C.enrollmentId, id), isNull(C.revokedAt)))
      return updated ? snapshot(updated) : null
    })
  },
}
