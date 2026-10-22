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
import { and, eq, isNull, sql } from 'drizzle-orm'
import { isAccountBlocked } from '@/lib/auth/ban'
import type { ActiveAgentCertificate } from './agent-peer'

/** A new observation for EVERY claim/consent/lease/result, not a cached TLS login.
 * Enrollment's five-minute code expiry does not expire an already issued cert.
 */
export type AgentTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

export async function readActiveAgentCertificate(
  fingerprint: string
): Promise<ActiveAgentCertificate | null> {
  return db.transaction((tx) => readActiveAgentCertificateInTransaction(tx, fingerprint))
}

/** Keep authorization locks through the caller's durable mutation. */
export async function readActiveAgentCertificateInTransaction(
  tx: AgentTransaction,
  fingerprint: string
): Promise<ActiveAgentCertificate | null> {
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) return null
  await tx.execute(sql`SET LOCAL statement_timeout = '5s'`)
  await tx.execute(sql`SET LOCAL lock_timeout = '2s'`)
  const [row] = await tx
    .select({
      certificate: C,
      enrollment: E,
      owner: { banned: user.banned, banExpires: user.banExpires, suspendedAt: user.suspendedAt },
      space: { organizationId: workspace.organizationId, archivedAt: workspace.archivedAt },
    })
    .from(C)
    .innerJoin(E, eq(C.enrollmentId, E.id))
    .innerJoin(user, eq(C.ownerUserId, user.id))
    .innerJoin(workspace, eq(C.workspaceId, workspace.id))
    .where(
      and(
        eq(C.certificateSha256, fingerprint),
        isNull(C.revokedAt),
        isNull(E.revokedAt),
        eq(E.status, 'issued'),
        sql`${C.notBefore} <= clock_timestamp() AND ${C.notAfter} > clock_timestamp()`
      )
    )
    .for('share')
    .limit(1)
  if (!row || isAccountBlocked(row.owner) || row.space.archivedAt) return null
  const c = row.certificate
  const e = row.enrollment
  if (
    e.agentId !== c.agentId ||
    e.issuanceId !== c.id ||
    e.ownerUserId !== c.ownerUserId ||
    e.workspaceId !== c.workspaceId ||
    e.organizationId !== c.organizationId ||
    row.space.organizationId !== c.organizationId ||
    e.installationId !== c.installationId ||
    e.fqdn !== c.fqdn ||
    e.windowsSid !== c.windowsSid ||
    e.spkiSha256 !== c.spkiSha256 ||
    e.certificateSerial !== c.certificateSerial ||
    e.certificateSha256 !== c.certificateSha256
  )
    return null
  const permission = await resolveEffectiveWorkspacePermission(
    c.ownerUserId,
    c.workspaceId,
    c.organizationId,
    tx,
    { forUpdate: true }
  )
  if (permission === null || !permissionSatisfies(permission, 'write')) return null
  return Object.freeze({
    certificateId: c.id,
    certificateSha256: c.certificateSha256,
    certificateSerial: c.certificateSerial,
    spkiSha256: c.spkiSha256,
    certificatePem: c.certificatePem,
    notBefore: c.notBefore.getTime(),
    notAfter: c.notAfter.getTime(),
    agentId: c.agentId,
    installationId: c.installationId,
    fqdn: c.fqdn,
    organizationId: c.organizationId,
    workspaceId: c.workspaceId,
    ownerUserId: c.ownerUserId,
    windowsSid: c.windowsSid,
  })
}
