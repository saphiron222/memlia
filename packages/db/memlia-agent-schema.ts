// Copyright (c) 2026 Memlia. All rights reserved.
import { sql } from 'drizzle-orm'
import {
  bigint,
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { organization, user, workspace } from './schema'

/** A short-lived association, never a Better Auth session or a desktop command. */
export const memliaDesktopAgentEnrollment = pgTable(
  'memlia_desktop_agent_enrollment',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id'),
    workspaceId: text('workspace_id').notNull(),
    ownerUserId: text('owner_user_id').notNull(),
    installationId: text('installation_id').notNull(),
    fqdn: text('fqdn').notNull(),
    codeHash: text('code_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revision: bigint('revision', { mode: 'number' }).notNull().default(0),
    status: text('status').notNull().default('pending'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    csrSha256: text('csr_sha256'),
    spkiSha256: text('spki_sha256'),
    windowsSid: text('windows_sid'),
    challenge: text('challenge'),
    challengeDigest: text('challenge_digest'),
    issuanceId: text('issuance_id'),
    agentId: text('agent_id'),
    certificateSerial: text('certificate_serial'),
    certificateSha256: text('certificate_sha256'),
    issuedAt: timestamp('issued_at', { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: 'memlia_agent_enroll_workspace_fk',
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'memlia_agent_enroll_owner_fk',
      columns: [t.ownerUserId],
      foreignColumns: [user.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'memlia_agent_enroll_organization_fk',
      columns: [t.organizationId],
      foreignColumns: [organization.id],
    }).onDelete('cascade'),
    uniqueIndex('memlia_agent_enroll_code_uq').on(t.codeHash),
    uniqueIndex('memlia_agent_enroll_issuance_uq').on(t.issuanceId),
    index('memlia_agent_enroll_owner_idx').on(t.workspaceId, t.ownerUserId),
    index('memlia_agent_enroll_expiry_idx').on(t.status, t.expiresAt),
    check(
      'memlia_agent_enroll_lifetime',
      sql`${t.expiresAt} > ${t.createdAt} AND ${t.expiresAt} <= ${t.createdAt} + interval '5 minutes'`
    ),
    check('memlia_agent_enroll_revision', sql`${t.revision} BETWEEN 0 AND 9007199254740991`),
    check(
      'memlia_agent_enroll_hashes',
      sql`${t.codeHash} ~ '^[a-f0-9]{64}$' AND (${t.csrSha256} IS NULL OR ${t.csrSha256} ~ '^[a-f0-9]{64}$') AND (${t.spkiSha256} IS NULL OR ${t.spkiSha256} ~ '^[a-f0-9]{64}$') AND (${t.challengeDigest} IS NULL OR ${t.challengeDigest} ~ '^[a-f0-9]{64}$') AND (${t.certificateSha256} IS NULL OR ${t.certificateSha256} ~ '^[a-f0-9]{64}$')`
    ),
    check(
      'memlia_agent_enroll_state',
      sql`${t.status} IN ('pending','challenged','issuing','issued','issuance_unknown','revoked') AND ((${t.status} = 'revoked') = (${t.revokedAt} IS NOT NULL))`
    ),
    check(
      'memlia_agent_enroll_bound',
      sql`${t.status} NOT IN ('challenged','issuing','issued','issuance_unknown') OR (${t.csrSha256} IS NOT NULL AND ${t.spkiSha256} IS NOT NULL AND ${t.windowsSid} IS NOT NULL AND ${t.challenge} IS NOT NULL AND ${t.challengeDigest} IS NOT NULL)`
    ),
    check(
      'memlia_agent_enroll_issuance',
      sql`${t.status} NOT IN ('issuing','issued','issuance_unknown') OR (${t.issuanceId} IS NOT NULL AND ${t.agentId} IS NOT NULL)`
    ),
    check(
      'memlia_agent_enroll_issued',
      sql`${t.status} <> 'issued' OR (${t.certificateSerial} IS NOT NULL AND ${t.certificateSha256} IS NOT NULL AND ${t.issuedAt} IS NOT NULL)`
    ),
    check(
      'memlia_agent_enroll_input_bounds',
      sql`length(${t.id}) BETWEEN 1 AND 128 AND length(${t.installationId}) BETWEEN 1 AND 128 AND length(${t.fqdn}) BETWEEN 1 AND 2048 AND (${t.challenge} IS NULL OR ${t.challenge} ~ '^[A-Za-z0-9_-]{43}$') AND (${t.windowsSid} IS NULL OR ${t.windowsSid} ~ '^S-1-([0-9]+-){1,14}[0-9]+$')`
    ),
  ]
)

/** Public certificates only. Several certificate identities can belong to one agent. */
export const memliaDesktopAgentCertificate = pgTable(
  'memlia_desktop_agent_certificate',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id').notNull(),
    enrollmentId: text('enrollment_id').notNull(),
    organizationId: text('organization_id'),
    workspaceId: text('workspace_id').notNull(),
    ownerUserId: text('owner_user_id').notNull(),
    installationId: text('installation_id').notNull(),
    fqdn: text('fqdn').notNull(),
    windowsSid: text('windows_sid').notNull(),
    csrSha256: text('csr_sha256').notNull(),
    spkiSha256: text('spki_sha256').notNull(),
    certificateSerial: text('certificate_serial').notNull(),
    certificateSha256: text('certificate_sha256').notNull(),
    certificatePem: text('certificate_pem').notNull(),
    notBefore: timestamp('not_before', { withTimezone: true }).notNull(),
    notAfter: timestamp('not_after', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: 'memlia_agent_cert_enrollment_fk',
      columns: [t.enrollmentId],
      foreignColumns: [memliaDesktopAgentEnrollment.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'memlia_agent_cert_workspace_fk',
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'memlia_agent_cert_owner_fk',
      columns: [t.ownerUserId],
      foreignColumns: [user.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'memlia_agent_cert_organization_fk',
      columns: [t.organizationId],
      foreignColumns: [organization.id],
    }).onDelete('cascade'),
    uniqueIndex('memlia_agent_cert_enrollment_uq').on(t.enrollmentId),
    uniqueIndex('memlia_agent_cert_serial_uq').on(t.certificateSerial),
    uniqueIndex('memlia_agent_cert_fingerprint_uq').on(t.certificateSha256),
    index('memlia_agent_cert_agent_idx').on(t.agentId),
    index('memlia_agent_cert_owner_idx').on(t.workspaceId, t.ownerUserId),
    check('memlia_agent_cert_lifetime', sql`${t.notBefore} < ${t.notAfter}`),
    check(
      'memlia_agent_cert_hashes',
      sql`${t.csrSha256} ~ '^[a-f0-9]{64}$' AND ${t.spkiSha256} ~ '^[a-f0-9]{64}$' AND ${t.certificateSha256} ~ '^[a-f0-9]{64}$'`
    ),
    check(
      'memlia_agent_cert_input_bounds',
      sql`length(${t.id}) BETWEEN 1 AND 128 AND length(${t.agentId}) BETWEEN 1 AND 128 AND length(${t.installationId}) BETWEEN 1 AND 128 AND length(${t.fqdn}) BETWEEN 1 AND 2048 AND ${t.windowsSid} ~ '^S-1-([0-9]+-){1,14}[0-9]+$' AND ${t.certificateSerial} ~ '^[a-f0-9]{1,40}$' AND octet_length(${t.certificatePem}) BETWEEN 1 AND 16384`
    ),
  ]
)
