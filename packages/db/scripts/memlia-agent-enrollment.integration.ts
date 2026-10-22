// Copyright (c) 2026 Memlia. All rights reserved.
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { readTestDatabaseUrl } from '@sim/db/testing/test-infrastructure'
import { insertWorkspaceFixture } from '@sim/db/testing/workspace-fixtures'
import { sql } from 'drizzle-orm'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { describe, expect, it } from 'vitest'
import * as schema from '../schema'
import {
  memliaDesktopAgentCertificate as certificates,
  memliaDesktopAgentEnrollment as enrollments,
  user,
} from '../schema'

type Database = PostgresJsDatabase<typeof schema>
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]
type EnrollmentFixture = typeof enrollments.$inferInsert & { createdAt: Date }

/** Exact additive DDL and native workspace fixture, rolled back even after success. */
async function fixture(run: (tx: Transaction, row: EnrollmentFixture) => Promise<void>) {
  const ddl = await readFile(
    new URL('../migrations/0441_memlia_desktop_agent_enrollment.sql', import.meta.url),
    'utf8'
  )
  const client = postgres(readTestDatabaseUrl(), { max: 1, onnotice: () => {} })
  const database = drizzle(client, { schema })
  const rolledBack = new Error('owned_fixture_rollback')
  try {
    await database.transaction(async (tx) => {
      for (const statement of ddl.split('--> statement-breakpoint')) {
        if (statement.trim()) await tx.execute(sql.raw(statement))
      }
      const owner = randomUUID()
      const workspaceId = randomUUID()
      await tx.insert(user).values({
        id: owner,
        name: 'Synthetic agent owner',
        email: `${owner}@example.invalid`,
        emailVerified: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      // Reuses Sim's real Project/workspace fixture, rather than bypassing its membership model.
      await insertWorkspaceFixture(tx, {
        id: workspaceId,
        name: 'Synthetic enrollment workspace',
        ownerId: owner,
        billedAccountUserId: owner,
      })
      const createdAt = new Date()
      await run(tx, {
        id: randomUUID(),
        organizationId: null,
        workspaceId,
        ownerUserId: owner,
        installationId: randomUUID(),
        fqdn: 'https://memlia.example.invalid',
        codeHash: 'a'.repeat(64),
        createdAt,
        expiresAt: new Date(createdAt.getTime() + 300_000),
      })
      throw rolledBack
    })
  } catch (error) {
    if (error !== rolledBack) throw error
  } finally {
    await client.end({ timeout: 2 })
  }
}

async function refuses(
  tx: Transaction,
  code: string,
  mutation: (nested: Transaction) => Promise<unknown>
) {
  try {
    await tx.transaction(mutation)
    expect.fail('The native database accepted an invalid persistence state')
  } catch (error) {
    const native =
      (error as { cause?: { code?: string }; code?: string }).cause ?? (error as { code?: string })
    expect(native.code).toBe(code)
  }
}

function bound(row: typeof enrollments.$inferInsert) {
  return {
    ...row,
    status: 'issuing',
    csrSha256: 'b'.repeat(64),
    spkiSha256: 'c'.repeat(64),
    windowsSid: 'S-1-5-21-101-202-303-1001',
    challenge: 'd'.repeat(43),
    challengeDigest: 'e'.repeat(64),
    issuanceId: randomUUID(),
    agentId: randomUUID(),
  }
}

describe('Agent enrollment additive migration — real PostgreSQL, no CA or mTLS', () => {
  it('persists bounded pending enrollment and keeps code hashes unique', async () => {
    await fixture(async (tx, row) => {
      const [saved] = await tx.insert(enrollments).values(row).returning()
      expect(saved).toMatchObject({ status: 'pending', revision: 0, organizationId: null })
      await refuses(tx, '23505', (nested) =>
        nested.insert(enrollments).values({ ...row, id: randomUUID() })
      )
    })
  })

  it('rejects excessive lifetime, invalid revision and invalid digest', async () => {
    await fixture(async (tx, row) => {
      for (const delta of [
        { expiresAt: new Date(row.createdAt.getTime() + 300_001) },
        { expiresAt: row.createdAt },
        { revision: -1 },
        { revision: 9007199254740992 },
        { codeHash: 'not-a-digest' },
      ])
        await refuses(tx, '23514', (nested) =>
          nested.insert(enrollments).values({ ...row, ...delta })
        )
    })
  })

  it('refuses missing challenge, issuance identity, certificate or revocation timestamp', async () => {
    await fixture(async (tx, row) => {
      for (const value of [
        { ...row, status: 'challenged' },
        { ...bound(row), issuanceId: null },
        { ...bound(row), status: 'issued' },
        { ...row, status: 'revoked' },
        { ...row, revokedAt: new Date() },
        { ...bound(row), windowsSid: 'S-1-5-21-101-202-303-1001\n' },
      ])
        await refuses(tx, '23514', (nested) => nested.insert(enrollments).values(value))
      await refuses(tx, '23503', (nested) =>
        nested.insert(enrollments).values({ ...row, ownerUserId: randomUUID() })
      )
    })
  })

  it('stores public certificate identity only with native references and unique fingerprint', async () => {
    await fixture(async (tx, row) => {
      const enrollment = bound(row)
      await tx.insert(enrollments).values(enrollment)
      const certificate = {
        id: enrollment.issuanceId,
        agentId: enrollment.agentId,
        enrollmentId: row.id,
        organizationId: row.organizationId,
        workspaceId: row.workspaceId,
        ownerUserId: row.ownerUserId,
        installationId: row.installationId,
        fqdn: row.fqdn,
        windowsSid: enrollment.windowsSid,
        csrSha256: enrollment.csrSha256,
        spkiSha256: enrollment.spkiSha256,
        certificateSerial: '123abc',
        certificateSha256: 'f'.repeat(64),
        // Persistence fixture only: cryptographic certificate parsing belongs to the real CA port.
        certificatePem: 'SYNTHETIC_PUBLIC_CERTIFICATE_NOT_A_CRYPTOGRAPHIC_PROOF',
        notBefore: new Date(),
        notAfter: new Date(Date.now() + 60_000),
      }
      const [saved] = await tx.insert(certificates).values(certificate).returning()
      expect(saved.agentId).toBe(enrollment.agentId)
      await refuses(tx, '23503', (nested) =>
        nested.insert(certificates).values({
          ...certificate,
          id: randomUUID(),
          enrollmentId: randomUUID(),
          certificateSerial: '456def',
          certificateSha256: '1'.repeat(64),
        })
      )
      await refuses(tx, '23514', (nested) =>
        nested
          .insert(certificates)
          .values({ ...certificate, id: randomUUID(), notAfter: certificate.notBefore })
      )
      const second = bound({ ...row, id: randomUUID(), codeHash: '2'.repeat(64) })
      await tx.insert(enrollments).values(second)
      await refuses(tx, '23505', (nested) =>
        nested.insert(certificates).values({
          ...certificate,
          id: second.issuanceId,
          enrollmentId: second.id,
          certificateSerial: '456def',
        })
      )
    })
  })
})
