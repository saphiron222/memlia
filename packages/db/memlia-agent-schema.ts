// Copyright (c) 2026 Memlia. All rights reserved.
import { sql } from 'drizzle-orm'
import {
  bigint,
  check,
  foreignKey,
  index,
  jsonb,
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

/** Serializes a desktop across certificates/sessions; counters never reset on expiry. */
export const memliaDesktopAgentState = pgTable(
  'memlia_desktop_agent_state',
  {
    agentId: text('agent_id').primaryKey(),
    epoch: bigint('epoch', { mode: 'number' }).notNull().default(0),
    observedCertificateId: text('observed_certificate_id').references(
      () => memliaDesktopAgentCertificate.id
    ),
    observedSessionId: text('observed_session_id'),
    observedWindowsSid: text('observed_windows_sid'),
    observedAt: timestamp('observed_at', { withTimezone: true }),
  },
  (t) => [
    check('memlia_agent_state_epoch', sql`${t.epoch} BETWEEN 0 AND 9007199254740991`),
    check(
      'memlia_agent_presence_complete',
      sql`(${t.observedAt} IS NULL AND ${t.observedCertificateId} IS NULL AND ${t.observedSessionId} IS NULL AND ${t.observedWindowsSid} IS NULL) OR (${t.observedAt} IS NOT NULL AND ${t.observedCertificateId} IS NOT NULL AND ${t.observedSessionId} IS NOT NULL AND ${t.observedWindowsSid} IS NOT NULL)`
    ),
  ]
)

/** Browser-authored intent and immutable claimed command; no certificate can create an intent. */
export const memliaDesktopAgentCommand = pgTable(
  'memlia_desktop_agent_command',
  {
    id: text('id').primaryKey(),
    agentId: text('agent_id')
      .notNull()
      .references(() => memliaDesktopAgentState.agentId),
    certificateId: text('certificate_id')
      .notNull()
      .references(() => memliaDesktopAgentCertificate.id),
    organizationId: text('organization_id').references(() => organization.id),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspace.id),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => user.id),
    sessionId: text('session_id').notNull(),
    windowsSid: text('windows_sid').notNull(),
    runId: text('run_id').notNull(),
    capabilityId: text('capability_id').notNull(),
    requestId: text('request_id'),
    requestDigest: text('request_digest'),
    status: text('status').notNull().default('queued'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    epoch: bigint('epoch', { mode: 'number' }),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    digest: text('digest'),
    intent: jsonb('intent').notNull(),
    command: jsonb('command'),
    capability: jsonb('capability'),
    consentId: text('consent_id'),
    lastSequence: bigint('last_sequence', { mode: 'number' }).notNull().default(-1),
  },
  (t) => [
    check(
      'memlia_agent_request_complete',
      sql`(${t.requestId} IS NULL AND ${t.requestDigest} IS NULL) OR (${t.requestId} IS NOT NULL AND ${t.requestDigest} IS NOT NULL AND ${t.requestId} ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' AND ${t.requestDigest} ~ '^sha256:[0-9a-f]{64}$')`
    ),
    uniqueIndex('memlia_agent_command_request_uq').on(t.ownerUserId, t.workspaceId, t.requestId),
    uniqueIndex('memlia_agent_command_run_uq').on(t.runId),
    uniqueIndex('memlia_agent_command_cap_uq').on(t.capabilityId),
    uniqueIndex('memlia_agent_command_consent_uq').on(t.consentId),
    uniqueIndex('memlia_agent_command_desktop_uq')
      .on(t.agentId)
      .where(sql`${t.status} IN ('claimed','consented','running','hold')`),
    index('memlia_agent_command_queue_idx').on(t.agentId, t.status, t.createdAt),
    check(
      'memlia_agent_command_status',
      sql`${t.status} IN ('queued','claimed','consented','running','hold','terminal')`
    ),
    check(
      'memlia_agent_command_lifetime',
      sql`${t.expiresAt} > ${t.createdAt} AND ${t.expiresAt} <= ${t.createdAt} + interval '30 minutes'`
    ),
    check(
      'memlia_agent_command_counters',
      sql`${t.lastSequence} BETWEEN -1 AND 9007199254740991 AND (${t.epoch} IS NULL OR ${t.epoch} BETWEEN 1 AND 9007199254740991)`
    ),
    check(
      'memlia_agent_command_claimed',
      sql`${t.status} = 'queued' OR (${t.command} IS NOT NULL AND ${t.epoch} IS NOT NULL AND ${t.digest} IS NOT NULL AND ${t.leaseUntil} IS NOT NULL)`
    ),
    check(
      'memlia_agent_command_capability',
      sql`(${t.capability} IS NULL) = (${t.consentId} IS NULL)`
    ),
  ]
)

/** Append-only receipt CAS: identical retry succeeds, divergent same sequence never does. */
export const memliaDesktopAgentReceipt = pgTable(
  'memlia_desktop_agent_receipt',
  {
    id: text('id').primaryKey(),
    commandId: text('command_id')
      .notNull()
      .references(() => memliaDesktopAgentCommand.id),
    sequence: bigint('sequence', { mode: 'number' }).notNull(),
    digest: text('digest').notNull(),
    receipt: jsonb('receipt').notNull(),
    artifacts: jsonb('artifacts').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('memlia_agent_receipt_sequence_uq').on(t.commandId, t.sequence),
    check('memlia_agent_receipt_sequence', sql`${t.sequence} BETWEEN 0 AND 9007199254740991`),
    check('memlia_agent_receipt_digest', sql`${t.digest} ~ '^sha256:[a-f0-9]{64}$'`),
  ]
)

/** Personal metadata only. Bytes and native run history remain in the command store. */
export const memliaDesktopProcedure = pgTable(
  'memlia_desktop_procedure',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    revision: bigint('revision', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('memlia_procedure_scope_uq').on(t.id, t.workspaceId, t.ownerUserId),
    index('memlia_procedure_owner_idx').on(t.workspaceId, t.ownerUserId, t.createdAt),
    check('memlia_procedure_revision', sql`${t.revision} BETWEEN 1 AND 9007199254740991`),
  ]
)
/** Application append-only; DB prevents version/key reuse and foreign parent scope. */
export const memliaDesktopProcedureVersion = pgTable(
  'memlia_desktop_procedure_version',
  {
    id: text('id').primaryKey(),
    procedureId: text('procedure_id').notNull(),
    workspaceId: text('workspace_id').notNull(),
    ownerUserId: text('owner_user_id').notNull(),
    revision: bigint('revision', { mode: 'number' }).notNull(),
    requestId: text('request_id').notNull(),
    requestDigest: text('request_digest').notNull(),
    commandId: text('command_id')
      .notNull()
      .references(() => memliaDesktopAgentCommand.id),
    artifactId: text('artifact_id').notNull(),
    artifactSha256: text('artifact_sha256').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'memlia_procedure_version_scope_fk',
      columns: [t.procedureId, t.workspaceId, t.ownerUserId],
      foreignColumns: [
        memliaDesktopProcedure.id,
        memliaDesktopProcedure.workspaceId,
        memliaDesktopProcedure.ownerUserId,
      ],
    }).onDelete('cascade'),
    uniqueIndex('memlia_procedure_version_uq').on(t.procedureId, t.revision),
    uniqueIndex('memlia_procedure_request_uq').on(t.workspaceId, t.ownerUserId, t.requestId),
    check('memlia_procedure_version_revision', sql`${t.revision} BETWEEN 1 AND 9007199254740991`),
    check(
      'memlia_procedure_text_bounds',
      sql`length(${t.name}) BETWEEN 1 AND 120 AND length(${t.description}) <= 2000`
    ),
    check(
      'memlia_procedure_hashes',
      sql`${t.requestDigest} ~ '^sha256:[a-f0-9]{64}$' AND ${t.artifactSha256} ~ '^sha256:[a-f0-9]{64}$'`
    ),
    check(
      'memlia_procedure_request_id',
      sql`${t.requestId} ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'`
    ),
  ]
)
