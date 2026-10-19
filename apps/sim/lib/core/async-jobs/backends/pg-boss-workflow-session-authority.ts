// Copyright 2026 Memlia. All rights reserved.
import { type Principal, PrincipalSchema } from '@memlia/contracts'
import { parsePrincipal, type SessionPrincipal, serializePrincipal } from '@sim/auth/principal'
import { db } from '@sim/db'
import { asyncJobs, session, user } from '@sim/db/schema'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { getActivelyBannedUserIds } from '@/lib/auth/ban'
import { authorizeWorkspaceOperation } from '@/lib/core/application/workspace-authorization'
import { resolveActiveWorkflowApplicationContext } from '@/lib/workflows/application/context'
import { workflowOperations } from '@/lib/workflows/application/operations'
import { readPgBossPublication } from './pg-boss-admission'

function rejected(): Error {
  // Intentionally excludes raw causes, identity references, email and payload.
  return new Error('workflow_session_authority_rejected')
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw rejected()
  return value as Record<string, unknown>
}

function targetId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) throw rejected()
  return value
}

function sessionPrincipal(value: unknown): SessionPrincipal {
  const principal = parsePrincipal(value)
  if (principal.kind !== 'session') throw rejected()
  return principal
}

async function checkCurrentAuthority(
  principal: SessionPrincipal,
  workflowId: string,
  workspaceId: string,
  expectedOrganization?: { organizationId: string | null }
) {
  // No bearer token is selected. Expiration uses PostgreSQL's current clock.
  const [live] = await db
    .select({ id: session.id })
    .from(session)
    .innerJoin(user, eq(user.id, session.userId))
    .where(
      and(
        eq(session.id, principal.sessionId),
        eq(session.userId, principal.userId),
        sql`${session.expiresAt} > clock_timestamp()`,
        isNull(session.impersonatedBy)
      )
    )
    .limit(1)
  if (!live || (await getActivelyBannedUserIds([principal.userId])).length !== 0) throw rejected()
  const context = await resolveActiveWorkflowApplicationContext({
    workflowId,
    assertedWorkspaceId: workspaceId,
  })
  if (
    expectedOrganization &&
    context.workspaceOrganizationId !== expectedOrganization.organizationId
  )
    throw rejected()
  await authorizeWorkspaceOperation(principal, workflowOperations.execute, context)
  return context
}

/**
 * Internal capture ONLY after server authentication. A SessionPrincipal-shaped
 * value or knowledge of a session ID is not authentication. Never expose this
 * primitive as an endpoint accepting a principal from a client.
 */
export async function capturePgBossWorkflowSessionAuthority(input: {
  authenticatedPrincipal: unknown
  workflowId: string
  workspaceId: string
}): Promise<Principal> {
  try {
    // Native parsing copies primitives before the first await; never retain caller objects.
    const principal = sessionPrincipal({ version: 1, principal: input.authenticatedPrincipal })
    const workflowId = targetId(input.workflowId)
    const workspaceId = targetId(input.workspaceId)
    const context = await checkCurrentAuthority(principal, workflowId, workspaceId)
    // Persistence-only reference. This result includes sessionId, not a session token,
    // and must remain internal just like the reserved admission metadata.
    return PrincipalSchema.parse({
      schemaVersion: 'memlia.principal/v1',
      workspaceId: context.workspaceId,
      organizationId: context.workspaceOrganizationId,
      actor: serializePrincipal(principal),
      subject: { kind: 'user', userId: principal.userId },
      authority: { kind: 'interactive' },
      scopes: [],
      allowedTools: [],
    })
  } catch {
    throw rejected()
  }
}

/** A momentary authorization observation, NOT a claim or permission to dispatch. */
export interface PgBossWorkflowSessionAuthorityCheck {
  kind: 'authority_checked'
  origin: 'persisted_admission'
  userId: string
  workflowId: string
  workspaceId: string
  organizationId: string | null
}

/**
 * Loads provenance itself; never accepts a structurally typed publication as proof.
 * A future consumer must still own its attempt, bind execution flags/results and
 * recheck authority immediately before any effect. No runner/ACK/retry lives here.
 */
export async function revalidatePgBossWorkflowSessionAuthority(
  reference: unknown
): Promise<PgBossWorkflowSessionAuthorityCheck> {
  try {
    const input = record(reference)
    if (Object.keys(input).sort().join(',') !== 'admissionDigest,nativeJobId') throw rejected()
    const nativeJobId = input.nativeJobId
    const admissionDigest = input.admissionDigest
    if (
      typeof nativeJobId !== 'string' ||
      nativeJobId.length === 0 ||
      nativeJobId.length > 512 ||
      typeof admissionDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(admissionDigest)
    )
      throw rejected()

    // Short, read-only snapshot protected from concurrent native job updates.
    // All inputs below are copied primitives; no caller callback/config/network under lock.
    const snapshot = await db.transaction(async (tx) => {
      const [row] = await tx
        .select({ payload: asyncJobs.payload })
        .from(asyncJobs)
        .where(eq(asyncJobs.id, nativeJobId))
        .for('share')
        .limit(1)
      if (!row) throw rejected()
      const publication = await readPgBossPublication(tx, { nativeJobId, admissionDigest })
      if (
        publication.envelope.runner !== 'workflow-execution' ||
        !['pending', 'processing'].includes(publication.status)
      )
        throw rejected()
      const authority = publication.envelope.authority
      if (
        authority.authority.kind !== 'interactive' ||
        authority.subject.kind !== 'user' ||
        authority.scopes.length !== 0 ||
        authority.allowedTools.length !== 0
      )
        throw rejected()
      const principal = sessionPrincipal(authority.actor)
      if (principal.userId !== authority.subject.userId) throw rejected()
      const payload = record(row.payload)
      // The payload locates a target; it never creates a principal or supplies a fallback.
      const payloadPrincipal = sessionPrincipal(payload.principal)
      if (
        payloadPrincipal.userId !== principal.userId ||
        payloadPrincipal.sessionId !== principal.sessionId ||
        payload.workspaceId !== authority.workspaceId ||
        payload.executionId !== publication.envelope.runId
      )
        throw rejected()
      return {
        principal,
        workflowId: targetId(payload.workflowId),
        workspaceId: authority.workspaceId,
        organizationId: authority.organizationId,
      }
    })
    // The lock is released before native policy reads (including cached external config).
    await checkCurrentAuthority(snapshot.principal, snapshot.workflowId, snapshot.workspaceId, {
      organizationId: snapshot.organizationId,
    })
    return {
      kind: 'authority_checked',
      origin: 'persisted_admission',
      userId: snapshot.principal.userId,
      workflowId: snapshot.workflowId,
      workspaceId: snapshot.workspaceId,
      organizationId: snapshot.organizationId,
    }
  } catch {
    throw rejected()
  }
}
