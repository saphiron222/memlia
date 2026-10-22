// Copyright (c) 2026 Memlia. All rights reserved.
import { createHash, randomUUID } from 'node:crypto'
import {
  type AgentCommand,
  AgentCommandSchema,
  type AgentControlRequest,
  AgentControlRequestSchema,
  desktopCommandBytes,
  type RunReceipt,
  RunReceiptSchema,
  SessionCapabilitySchema,
} from '@memlia/contracts'
import { parsePrincipal, type SessionPrincipal } from '@sim/auth/principal'
import { db } from '@sim/db'
import {
  memliaDesktopAgentArtifact as Artifacts,
  memliaDesktopAgentCertificate as Certificates,
  memliaDesktopAgentCommand as Commands,
  memliaDesktopAgentState as Desktops,
  memliaDesktopProcedure as Procedures,
  memliaDesktopProcedureVersion as ProcedureVersions,
  memliaDesktopAgentReceipt as Receipts,
  session as Sessions,
  user as Users,
  workspace as Workspaces,
} from '@sim/db/schema'
import {
  permissionSatisfies,
  resolveEffectiveWorkspacePermission,
} from '@sim/platform-authz/workspace'
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  captureInputSchema,
  captureSummarySchema,
} from '@/lib/api/contracts/desktop-agent-captures'
import {
  listProcedureInputSchema,
  procedureVersionSchema,
  saveProcedureInputSchema,
} from '@/lib/api/contracts/desktop-agent-procedures'
import { isAccountBlocked } from '@/lib/auth/ban'
import { OrchestrationError } from '@/lib/core/orchestration/types'
import type { AgentPeer } from './agent-peer'
import {
  type AgentTransaction,
  readActiveAgentCertificateInTransaction,
} from './agent-peer-repository'

export type { AgentTransaction } from './agent-peer-repository'

export type AgentCaptureInputScope = AgentArtifactScope &
  Readonly<{ maxDurationSeconds: number; maxBytes: number }>

type Row = typeof Commands.$inferSelect
type Ref = AgentCommand['bundle']
type CommandKey = Extract<AgentControlRequest, { op: 'checkpoint' }>['command']
export type AgentArtifactScope = Readonly<
  AgentPeer & {
    commandId: string
    runId: string
    sessionId: string
    capabilityId: string
    commandDigest: string | null
    leaseEpoch: number | null
  }
>
/** Native private-store adapter only. All methods use this transaction, no network/CA/model calls.
 * Inputs are admitted execution manifests, never a fabricated ready procedure. Publication must
 * verify complete bytes/hash, journal scope and ownership for every reference before returning true.
 */
export interface AgentCommandArtifacts {
  captureInputs(
    tx: AgentTransaction,
    scope: AgentCaptureInputScope
  ): Promise<{ bundle: Ref; qualification: Ref }>
  personalTestInputs?(
    tx: AgentTransaction,
    scope: AgentArtifactScope,
    source: {
      scope: AgentArtifactScope
      reference: Ref
      procedureId: string
      revision: number
      maxDurationSeconds: number
    }
  ): Promise<{ bundle: Ref; qualification: Ref; procedure: Ref; parameters: Ref }>
  personalTestVersion?(
    tx: AgentTransaction,
    scope: AgentArtifactScope,
    command: AgentCommand
  ): Promise<{ procedureId: string; revision: number }>
  assertComplete(
    tx: AgentTransaction,
    scope: AgentArtifactScope,
    refs: readonly Ref[],
    receipt: RunReceipt
  ): Promise<boolean>
}
const intentSchema = captureInputSchema.extend({ workspaceId: z.string().min(1).max(128) })
export const personalTestInputSchema = z.strictObject({
  workspaceId: z.string().min(1).max(128),
  procedureId: z.uuid(),
  revision: z.int().min(1).max(Number.MAX_SAFE_INTEGER),
  agentId: z.string().min(1).max(128),
  requestId: z.uuid(),
  maxDurationSeconds: z.int().min(1).max(1800),
})
const listSchema = z.strictObject({
  workspaceId: z.string().min(1).max(128),
  requestId: z.uuid().optional(),
})
const saveProcedureSchema = saveProcedureInputSchema.safeExtend({
  workspaceId: z.string().min(1).max(128),
})
const procedureListSchema = listProcedureInputSchema.extend({
  workspaceId: z.string().min(1).max(128),
})
const refuse = () => new Error('agent_command_refused')
function need(value: unknown): asserts value {
  if (!value) throw refuse()
}
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered)
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, ordered(v)])
    )
  return value
}
function hash(value: unknown) {
  return (
    'sha256:' +
    createHash('sha256')
      .update(JSON.stringify(ordered(value)))
      .digest('hex')
  )
}
function samePeer(a: AgentPeer, b: AgentPeer) {
  return (
    [
      'certificateId',
      'certificateSha256',
      'agentId',
      'installationId',
      'fqdn',
      'organizationId',
      'workspaceId',
      'ownerUserId',
      'windowsSid',
    ] as const
  ).every((k) => a[k] === b[k])
}
async function clock(tx: AgentTransaction) {
  const result = await tx.execute(sql`SELECT clock_timestamp() AS now`)
  const now = new Date((result[0] as { now: string | Date }).now)
  need(Number.isFinite(now.getTime()))
  return now
}
function scope(
  peer: AgentPeer,
  row: Pick<Row, 'id' | 'runId' | 'sessionId' | 'capabilityId' | 'digest' | 'epoch'>
): AgentArtifactScope {
  return Object.freeze({
    ...peer,
    commandId: row.id,
    runId: row.runId,
    sessionId: row.sessionId,
    capabilityId: row.capabilityId,
    commandDigest: row.digest,
    leaseEpoch: row.epoch,
  })
}
function bound(peer: AgentPeer, row: Row) {
  need(
    row.certificateId === peer.certificateId &&
      row.agentId === peer.agentId &&
      row.ownerUserId === peer.ownerUserId &&
      row.workspaceId === peer.workspaceId &&
      row.organizationId === peer.organizationId &&
      row.windowsSid === peer.windowsSid
  )
}
function keyMatches(row: Row, key: CommandKey) {
  need(row.id === key.commandId && row.digest === key.digest && row.epoch === key.leaseEpoch)
}
function capabilityMatches(row: Row, id: string | null) {
  need(id === null ? row.capability === null : row.capability !== null && id === row.capabilityId)
}
function refsEqual(a: Ref, b: Ref) {
  return a.artifactId === b.artifactId && a.sha256 === b.sha256
}

export function createAgentCommandRepository(ports: { artifacts: AgentCommandArtifacts | null }) {
  const artifacts = ports.artifacts
  function configured() {
    if (!artifacts) throw new Error('agent_command_unavailable')
    return artifacts
  }
  async function transaction<T>(
    peerInput: AgentPeer,
    body: (tx: AgentTransaction, peer: AgentPeer, now: Date) => Promise<T>
  ) {
    const expected = Object.freeze({ ...peerInput })
    return db.transaction(async (tx) => {
      const active = await readActiveAgentCertificateInTransaction(tx, expected.certificateSha256)
      need(active && samePeer(expected, active))
      // Also serializes first creation and independently enrolled certificates for this agent.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${'memlia-desktop:' + active.agentId},0))`
      )
      const now = await clock(tx)
      need(active.notBefore <= now.getTime() && active.notAfter > now.getTime())
      const result = await body(tx, active, now)
      const finished = await clock(tx)
      need(active.notBefore <= finished.getTime() && active.notAfter > finished.getTime())
      return result
    })
  }
  async function rowFor(tx: AgentTransaction, peer: AgentPeer, key: CommandKey) {
    const [row] = await tx
      .select()
      .from(Commands)
      .where(eq(Commands.id, key.commandId))
      .for('update')
      .limit(1)
    need(row)
    bound(peer, row)
    keyMatches(row, key)
    return row
  }
  async function personalSourceLive(tx: AgentTransaction, row: Row, current: AgentPeer) {
    const command = AgentCommandSchema.parse(row.command ?? row.intent)
    if (command.action.kind !== 'procedure.run') return true
    try {
      need(command.action.mode === 'test' && configured().personalTestVersion)
      const versionKey = await configured().personalTestVersion!(tx, scope(current, row), command)
      const [version] = await tx
        .select()
        .from(ProcedureVersions)
        .where(
          and(
            eq(ProcedureVersions.procedureId, versionKey.procedureId),
            eq(ProcedureVersions.revision, versionKey.revision),
            eq(ProcedureVersions.ownerUserId, row.ownerUserId),
            eq(ProcedureVersions.workspaceId, row.workspaceId)
          )
        )
        .limit(1)
      need(version)
      const source = await procedureSource(tx, row.ownerUserId, row.workspaceId, version.commandId)
      need(
        source.ref.artifactId === version.artifactId &&
          source.ref.sha256 === version.artifactSha256 &&
          source.ref.sha256 === command.bundle.sha256 &&
          source.peer.notAfter > (await clock(tx)).getTime()
      )
      return true
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !['agent_command_refused', 'agent_artifact_refused'].includes(error.message)
      )
        throw error
      if (row.status === 'queued') throw error // No claim/fence or effect has occurred.
      await tx.update(Commands).set({ status: 'hold' }).where(eq(Commands.id, row.id))
      return false
    }
  }
  async function live(tx: AgentTransaction, row: Row, _observed: Date, current: AgentPeer) {
    const now = await clock(tx)
    if (row.status === 'hold' || row.status === 'terminal') return false
    if (!(await personalSourceLive(tx, row, current))) return false
    if (!row.leaseUntil || row.leaseUntil <= now || row.expiresAt <= now) {
      // Commit this HOLD, do not throw and roll it back. No implicit requeue/retry.
      await tx.update(Commands).set({ status: 'hold' }).where(eq(Commands.id, row.id))
      return false
    }
    return true
  }
  async function renew(tx: AgentTransaction, row: Row, now: Date) {
    // A checkpoint renews only the already observed SAME session, never a new desktop binding.
    await tx
      .update(Desktops)
      .set({ observedAt: now })
      .where(
        and(
          eq(Desktops.agentId, row.agentId),
          eq(Desktops.observedCertificateId, row.certificateId),
          eq(Desktops.observedSessionId, row.sessionId),
          eq(Desktops.observedWindowsSid, row.windowsSid)
        )
      )
    await tx
      .update(Commands)
      .set({ leaseUntil: new Date(Math.min(now.getTime() + 30_000, row.expiresAt.getTime())) })
      .where(eq(Commands.id, row.id))
  }
  async function browser(tx: AgentTransaction, principal: SessionPrincipal, workspaceId: string) {
    await tx.execute(sql`SET LOCAL statement_timeout = '5s'`)
    await tx.execute(sql`SET LOCAL lock_timeout = '2s'`)
    const [row] = await tx
      .select({
        session: Sessions,
        owner: {
          banned: Users.banned,
          banExpires: Users.banExpires,
          suspendedAt: Users.suspendedAt,
        },
        space: { organizationId: Workspaces.organizationId, archivedAt: Workspaces.archivedAt },
      })
      .from(Sessions)
      .innerJoin(Users, eq(Users.id, Sessions.userId))
      .innerJoin(Workspaces, eq(Workspaces.id, workspaceId))
      .where(
        and(
          eq(Sessions.id, principal.sessionId),
          eq(Sessions.userId, principal.userId),
          sql`${Sessions.expiresAt}>clock_timestamp()`
        )
      )
      .for('share')
      .limit(1)
    need(row && !isAccountBlocked(row.owner) && !row.space.archivedAt)
    const permission = await resolveEffectiveWorkspacePermission(
      principal.userId,
      workspaceId,
      row.space.organizationId,
      tx,
      { forUpdate: true }
    )
    need(permission && permissionSatisfies(permission, 'write'))
    need(row.session.expiresAt > (await clock(tx)))
    return row.session
  }
  async function summary(tx: AgentTransaction, row: Row, now: Date) {
    const [last] = await tx
      .select()
      .from(Receipts)
      .where(and(eq(Receipts.commandId, row.id), eq(Receipts.sequence, row.lastSequence)))
      .limit(1)
    const receipt = last ? RunReceiptSchema.parse(last.receipt) : null
    let exportStatus: 'none' | 'to_test' = 'none'
    if (row.status === 'terminal' && receipt?.outcome.status === 'succeeded_verified') {
      const refs = last!.artifacts as Ref[]
      const stored = await tx
        .select({
          id: Artifacts.artifactId,
          sha: Artifacts.sha256,
          bytes: Artifacts.totalBytes,
          complete: Artifacts.complete,
          origin: Artifacts.origin,
        })
        .from(Artifacts)
        .where(eq(Artifacts.commandId, row.id))
        .limit(129)
      if (
        refs.length > 0 &&
        refs.length <= 128 &&
        stored.length <= 128 &&
        refs.every((r) =>
          stored.some(
            (a) =>
              a.id === r.artifactId &&
              a.sha === r.sha256 &&
              a.complete &&
              a.origin === 'agent' &&
              a.bytes > 0
          )
        )
      )
        exportStatus = 'to_test'
    }
    const status =
      row.status === 'queued' && row.expiresAt <= now
        ? 'expired'
        : ['claimed', 'consented', 'running'].includes(row.status) &&
            (!row.leaseUntil || row.leaseUntil <= now || row.expiresAt <= now)
          ? 'hold'
          : row.status
    return captureSummarySchema.parse({
      commandId: row.id,
      requestId: row.requestId,
      agentId: row.agentId,
      status,
      outcome: receipt?.outcome.status ?? null,
      createdAt: row.createdAt.getTime(),
      exportStatus,
    })
  }
  function versionSummary(v: typeof ProcedureVersions.$inferSelect) {
    return procedureVersionSchema.parse({
      procedureId: v.procedureId,
      revision: v.revision,
      requestId: v.requestId,
      name: v.name,
      description: v.description,
      commandId: v.commandId,
      createdAt: v.createdAt.getTime(),
      status: 'to_test',
    })
  }
  // Historical inventory remains readable after source certificate expiry or revocation.
  // This validates private provenance only; it never admits reuse or execution.
  async function procedureMetadata(
    tx: AgentTransaction,
    ownerUserId: string,
    workspaceId: string,
    commandId: string
  ) {
    const [row] = await tx
      .select()
      .from(Commands)
      .where(
        and(
          eq(Commands.id, commandId),
          eq(Commands.ownerUserId, ownerUserId),
          eq(Commands.workspaceId, workspaceId)
        )
      )
      .for('share')
      .limit(1)
    need(row && row.status === 'terminal' && row.digest && row.epoch !== null)
    const now = await clock(tx)
    need((await summary(tx, row, now)).exportStatus === 'to_test')
    const [last] = await tx
      .select()
      .from(Receipts)
      .where(and(eq(Receipts.commandId, row.id), eq(Receipts.sequence, row.lastSequence)))
      .limit(1)
    need(last)
    const receipt = RunReceiptSchema.parse(last.receipt)
    const refs = z
      .array(
        z.strictObject({
          artifactId: z.string().min(1).max(128),
          sha256: z.string().regex(/^sha256:[a-f0-9]{64}(?![\s\S])/),
        })
      )
      .length(1)
      .parse(last.artifacts)
    need(
      receipt.commandId === row.id &&
        receipt.runId === row.runId &&
        receipt.workspaceId === row.workspaceId &&
        receipt.organizationId === row.organizationId &&
        receipt.outcome.status === 'succeeded_verified' &&
        receipt.outcome.verifierId === 'memlia_capture_compile_v1' &&
        receipt.outcome.effect === 'known' &&
        receipt.outcome.evidence.length === 1 &&
        refsEqual(receipt.outcome.evidence[0], refs[0])
    )
    return { row, ref: refs[0], receipt }
  }
  async function procedureSource(
    tx: AgentTransaction,
    ownerUserId: string,
    workspaceId: string,
    commandId: string
  ) {
    const [observed] = await tx
      .select()
      .from(Commands)
      .where(
        and(
          eq(Commands.id, commandId),
          eq(Commands.ownerUserId, ownerUserId),
          eq(Commands.workspaceId, workspaceId)
        )
      )
      .limit(1)
    need(observed)
    const [cert] = await tx
      .select()
      .from(Certificates)
      .where(eq(Certificates.id, observed.certificateId))
      .limit(1)
    need(cert)
    const peer = await readActiveAgentCertificateInTransaction(tx, cert.certificateSha256)
    need(peer)
    bound(peer, observed)
    const metadata = await procedureMetadata(tx, ownerUserId, workspaceId, commandId)
    bound(peer, metadata.row)
    const now = await clock(tx)
    need(peer.notBefore <= now.getTime() && peer.notAfter > now.getTime())
    need(
      (await configured().assertComplete(
        tx,
        scope(peer, metadata.row),
        [metadata.ref],
        metadata.receipt
      )) === true
    )
    return { row: metadata.row, ref: metadata.ref, peer }
  }
  async function createRequest(
    principalInput: SessionPrincipal,
    value: z.infer<typeof intentSchema>,
    personal?: z.infer<typeof personalTestInputSchema>
  ) {
    const principal = parsePrincipal({ version: 1, principal: { ...principalInput } })
    need(principal.kind === 'session')
    const store = configured()
    return db.transaction(async (tx) => {
      const session = await browser(tx, principal, value.workspaceId)
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${'memlia-capture-request:' + principal.userId + ':' + value.workspaceId + ':' + value.requestId},0))`
      )
      const [certificate] = await tx
        .select({ certificateSha256: Certificates.certificateSha256 })
        .from(Certificates)
        .innerJoin(
          Desktops,
          and(
            eq(Desktops.agentId, Certificates.agentId),
            eq(Desktops.observedCertificateId, Certificates.id)
          )
        )
        .where(
          and(
            eq(Certificates.agentId, value.agentId),
            eq(Certificates.ownerUserId, principal.userId),
            eq(Certificates.workspaceId, value.workspaceId),
            isNull(Certificates.revokedAt)
          )
        )
        .limit(1)
      need(certificate)
      const peer = await readActiveAgentCertificateInTransaction(tx, certificate.certificateSha256)
      need(peer && peer.ownerUserId === principal.userId && peer.workspaceId === value.workspaceId)
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${'memlia-desktop:' + peer.agentId},0))`
      )
      const now = await clock(tx)
      need(peer.notAfter > now.getTime() && session.expiresAt > now)
      const [presence] = await tx
        .select()
        .from(Desktops)
        .where(eq(Desktops.agentId, peer.agentId))
        .for('update')
        .limit(1)
      need(
        presence &&
          presence.observedCertificateId === peer.certificateId &&
          presence.observedWindowsSid === peer.windowsSid &&
          presence.observedSessionId
      )
      let source: Awaited<ReturnType<typeof procedureSource>> | null = null
      if (personal) {
        const [version] = await tx
          .select()
          .from(ProcedureVersions)
          .where(
            and(
              eq(ProcedureVersions.procedureId, personal.procedureId),
              eq(ProcedureVersions.revision, personal.revision),
              eq(ProcedureVersions.ownerUserId, principal.userId),
              eq(ProcedureVersions.workspaceId, value.workspaceId)
            )
          )
          .limit(1)
        need(version)
        source = await procedureSource(tx, principal.userId, value.workspaceId, version.commandId)
        need(
          source.ref.artifactId === version.artifactId &&
            source.ref.sha256 === version.artifactSha256
        )
      }
      const requestDigest = hash({
        ...value,
        ...(personal ? { personal } : {}),
        ownerUserId: principal.userId,
        sessionId: presence.observedSessionId,
        certificateId: peer.certificateId,
      })
      const [previous] = await tx
        .select()
        .from(Commands)
        .where(
          and(
            eq(Commands.ownerUserId, principal.userId),
            eq(Commands.workspaceId, value.workspaceId),
            eq(Commands.requestId, value.requestId)
          )
        )
        .limit(1)
      if (previous) {
        bound(peer, previous)
        need(previous.requestDigest === requestDigest)
        const result = await summary(tx, previous, now)
        const finished = await clock(tx)
        need(
          peer.notAfter > finished.getTime() &&
            session.expiresAt > finished &&
            (!source || source.peer.notAfter > finished.getTime())
        )
        return result
      }
      need(
        presence.observedAt &&
          presence.observedAt.getTime() <= now.getTime() &&
          presence.observedAt.getTime() > now.getTime() - 30000
      )
      const [busy] = await tx
        .select({ id: Commands.id })
        .from(Commands)
        .where(
          and(
            eq(Commands.agentId, peer.agentId),
            sql`(${Commands.status} IN ('claimed','consented','running','hold') OR (${Commands.status}='queued' AND ${Commands.expiresAt}>clock_timestamp()))`
          )
        )
        .limit(1)
      need(!busy)
      const id = randomUUID()
      const runId = randomUUID()
      const capabilityId = randomUUID()
      const inputScope = scope(peer, {
        id,
        runId,
        sessionId: presence.observedSessionId,
        capabilityId,
        digest: null,
        epoch: null,
      })
      let admitted: { bundle: Ref; qualification: Ref; procedure?: Ref; parameters?: Ref }
      if (personal && source) {
        need(store.personalTestInputs)
        admitted = await store.personalTestInputs(tx, inputScope, {
          scope: scope(source.peer, source.row),
          reference: source.ref,
          procedureId: personal.procedureId,
          revision: personal.revision,
          maxDurationSeconds: value.maxDurationSeconds,
        })
      } else
        admitted = await store.captureInputs(
          tx,
          Object.freeze({
            ...inputScope,
            maxDurationSeconds: value.maxDurationSeconds,
            maxBytes: value.maxBytes,
          })
        )
      // Parse through the real closed command schema to capture references and bounds before insertion.
      const template = AgentCommandSchema.parse({
        schemaVersion: 'memlia.desktop-command/v2',
        organizationId: peer.organizationId,
        workspaceId: peer.workspaceId,
        agentId: peer.agentId,
        ownerUserId: peer.ownerUserId,
        windowsSid: peer.windowsSid,
        sessionId: presence.observedSessionId,
        leaseEpoch: 0,
        issuedAt: now.toISOString(),
        expiresAt: new Date(
          now.getTime() + (personal ? value.maxDurationSeconds * 1000 : 1800_000)
        ).toISOString(),
        resourceLocks: [{ kind: 'desktop', resourceId: peer.agentId, fence: 0 }],
        commandId: id,
        runId,
        capabilityId,
        digest: 'sha256:' + '0'.repeat(64),
        bundle: admitted.bundle,
        qualification: admitted.qualification,
        action: personal
          ? {
              kind: 'procedure.run',
              mode: 'test',
              procedure: admitted.procedure,
              parameters: admitted.parameters,
            }
          : {
              kind: 'capture.start',
              maxDurationSeconds: value.maxDurationSeconds,
              maxBytes: value.maxBytes,
              audio: false,
            },
      })
      const admissionFinished = await clock(tx)
      need(
        (!source || source.peer.notAfter > admissionFinished.getTime()) &&
          peer.notAfter > admissionFinished.getTime() &&
          session.expiresAt > admissionFinished &&
          presence.observedAt &&
          presence.observedAt.getTime() > admissionFinished.getTime() - 30000
      )
      const [created] = await tx
        .insert(Commands)
        .values({
          id,
          requestId: value.requestId,
          requestDigest,
          agentId: peer.agentId,
          certificateId: peer.certificateId,
          organizationId: peer.organizationId,
          workspaceId: peer.workspaceId,
          ownerUserId: peer.ownerUserId,
          windowsSid: peer.windowsSid,
          sessionId: presence.observedSessionId,
          runId,
          capabilityId,
          intent: template,
          createdAt: now,
          expiresAt: new Date(template.expiresAt),
        })
        .returning()
      const result = await summary(tx, created, admissionFinished)
      const finished = await clock(tx)
      need(
        (!source || source.peer.notAfter > finished.getTime()) &&
          peer.notAfter > finished.getTime() &&
          session.expiresAt > finished &&
          presence.observedAt &&
          presence.observedAt.getTime() > finished.getTime() - 30000
      )
      return result
    })
  }
  return {
    async saveProcedure(
      principalInput: SessionPrincipal,
      raw: z.input<typeof saveProcedureSchema>
    ) {
      const principal = parsePrincipal({ version: 1, principal: { ...principalInput } })
      need(principal.kind === 'session')
      const input = saveProcedureSchema.parse(raw)
      configured()
      return db.transaction(async (tx) => {
        const session = await browser(tx, principal, input.workspaceId)
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${'memlia-procedure-request:' + JSON.stringify([principal.userId, input.workspaceId, input.requestId])},0))`
        )
        const digest = hash({ ...input, ownerUserId: principal.userId })
        const source = await procedureSource(
          tx,
          principal.userId,
          input.workspaceId,
          input.commandId
        )
        const [previous] = await tx
          .select()
          .from(ProcedureVersions)
          .where(
            and(
              eq(ProcedureVersions.workspaceId, input.workspaceId),
              eq(ProcedureVersions.ownerUserId, principal.userId),
              eq(ProcedureVersions.requestId, input.requestId)
            )
          )
          .limit(1)
        if (previous) {
          need(
            previous.requestDigest === digest &&
              previous.commandId === source.row.id &&
              previous.artifactId === source.ref.artifactId &&
              previous.artifactSha256 === source.ref.sha256
          )
          const finish = await clock(tx)
          need(session.expiresAt > finish && source.peer.notAfter > finish.getTime())
          return versionSummary(previous)
        }
        const now = await clock(tx)
        const procedureId = input.procedureId ?? randomUUID()
        if (input.procedureId) {
          const [current] = await tx
            .select()
            .from(Procedures)
            .where(
              and(
                eq(Procedures.id, input.procedureId),
                eq(Procedures.workspaceId, input.workspaceId),
                eq(Procedures.ownerUserId, principal.userId)
              )
            )
            .for('update')
            .limit(1)
          need(current)
          if (current.revision !== input.expectedRevision)
            throw new OrchestrationError('conflict', 'procedure_revision_conflict')
          const [updated] = await tx
            .update(Procedures)
            .set({ revision: input.expectedRevision + 1 })
            .where(
              and(eq(Procedures.id, current.id), eq(Procedures.revision, input.expectedRevision))
            )
            .returning()
          need(updated)
        } else
          await tx.insert(Procedures).values({
            id: procedureId,
            workspaceId: input.workspaceId,
            ownerUserId: principal.userId,
            revision: 1,
            createdAt: now,
          })
        const [version] = await tx
          .insert(ProcedureVersions)
          .values({
            id: randomUUID(),
            procedureId,
            workspaceId: input.workspaceId,
            ownerUserId: principal.userId,
            revision: input.expectedRevision + 1,
            requestId: input.requestId,
            requestDigest: digest,
            commandId: source.row.id,
            artifactId: source.ref.artifactId,
            artifactSha256: source.ref.sha256,
            name: input.name,
            description: input.description,
            createdAt: now,
          })
          .returning()
        const finish = await clock(tx)
        need(session.expiresAt > finish && source.peer.notAfter > finish.getTime())
        return versionSummary(version)
      })
    },
    async listProcedures(
      principalInput: SessionPrincipal,
      raw: z.input<typeof procedureListSchema>
    ) {
      const principal = parsePrincipal({ version: 1, principal: { ...principalInput } })
      need(principal.kind === 'session')
      const input = procedureListSchema.parse(raw)
      return db.transaction(async (tx) => {
        const session = await browser(tx, principal, input.workspaceId)
        const owned = and(
          eq(Procedures.workspaceId, input.workspaceId),
          eq(Procedures.ownerUserId, principal.userId)
        )
        const current = await tx
          .select({ version: ProcedureVersions })
          .from(Procedures)
          .innerJoin(
            ProcedureVersions,
            and(
              eq(ProcedureVersions.procedureId, Procedures.id),
              eq(ProcedureVersions.revision, Procedures.revision)
            )
          )
          .where(and(owned, input.procedureId ? eq(Procedures.id, input.procedureId) : undefined))
          .orderBy(desc(Procedures.createdAt), asc(Procedures.id))
          .limit(51)
        if (input.procedureId) need(current.length === 1)
        const history = input.procedureId
          ? await tx
              .select()
              .from(ProcedureVersions)
              .where(
                and(
                  eq(ProcedureVersions.procedureId, input.procedureId),
                  eq(ProcedureVersions.workspaceId, input.workspaceId),
                  eq(ProcedureVersions.ownerUserId, principal.userId)
                )
              )
              .orderBy(desc(ProcedureVersions.revision))
              .limit(51)
          : []
        const sources = new Map<string, Awaited<ReturnType<typeof procedureMetadata>>>()
        const validate = async (v: typeof ProcedureVersions.$inferSelect) => {
          let source = sources.get(v.commandId)
          if (!source) {
            source = await procedureMetadata(tx, principal.userId, input.workspaceId, v.commandId)
            sources.set(v.commandId, source)
          }
          need(v.artifactId === source.ref.artifactId && v.artifactSha256 === source.ref.sha256)
          return versionSummary(v)
        }
        const procedures = []
        const versions = []
        for (const { version } of current.slice(0, 50)) procedures.push(await validate(version))
        for (const version of history.slice(0, 50)) versions.push(await validate(version))
        const finish = await clock(tx)
        need(session.expiresAt > finish)
        return { procedures, versions, truncated: current.length > 50 || history.length > 50 }
      })
    },
    createIntent(principal: SessionPrincipal, input: z.input<typeof intentSchema>) {
      return createRequest(principal, intentSchema.parse(input))
    },
    createPersonalTest(
      principal: SessionPrincipal,
      input: z.input<typeof personalTestInputSchema>
    ) {
      const value = personalTestInputSchema.parse(input)
      return createRequest(
        principal,
        {
          workspaceId: value.workspaceId,
          agentId: value.agentId,
          requestId: value.requestId,
          maxDurationSeconds: value.maxDurationSeconds,
          maxBytes: 32 * 1024 * 1024,
        },
        value
      )
    },
    async listOwned(principalInput: SessionPrincipal, raw: z.input<typeof listSchema>) {
      const principal = parsePrincipal({ version: 1, principal: { ...principalInput } })
      need(principal.kind === 'session')
      const input = listSchema.parse(raw)
      return db.transaction(async (tx) => {
        const session = await browser(tx, principal, input.workspaceId)
        const now = await clock(tx)
        const certificates = await tx
          .select({ certificate: Certificates, presence: Desktops })
          .from(Certificates)
          .innerJoin(
            Desktops,
            and(
              eq(Desktops.agentId, Certificates.agentId),
              eq(Desktops.observedCertificateId, Certificates.id)
            )
          )
          .where(
            and(
              eq(Certificates.ownerUserId, principal.userId),
              eq(Certificates.workspaceId, input.workspaceId)
            )
          )
          .orderBy(asc(Certificates.agentId))
          .limit(21)
        const devices = []
        for (const { certificate: c, presence: p } of certificates.slice(0, 20)) {
          const peer = await readActiveAgentCertificateInTransaction(tx, c.certificateSha256)
          const current = await clock(tx)
          const recent =
            !!peer &&
            peer.notAfter > current.getTime() &&
            p.observedAt !== null &&
            p.observedAt.getTime() <= current.getTime() &&
            p.observedAt.getTime() > current.getTime() - 30000 &&
            p.observedWindowsSid === peer.windowsSid
          const [active] = await tx
            .select()
            .from(Commands)
            .where(
              and(
                eq(Commands.agentId, c.agentId),
                sql`(${Commands.status} IN ('claimed','consented','running','hold') OR (${Commands.status}='queued' AND ${Commands.expiresAt}>clock_timestamp()))`
              )
            )
            .limit(1)
          const hold =
            active &&
            (active.status === 'hold' ||
              (active.status !== 'queued' &&
                (!active.leaseUntil ||
                  active.leaseUntil <= current ||
                  active.expiresAt <= current)))
          devices.push({
            agentId: c.agentId,
            observedAt: p.observedAt?.getTime() ?? null,
            observation: !peer
              ? ('unavailable' as const)
              : recent
                ? ('recent' as const)
                : ('offline' as const),
            busy: hold ? ('hold' as const) : active ? ('busy' as const) : ('idle' as const),
          })
        }
        const rows = await tx
          .select()
          .from(Commands)
          .where(
            and(
              eq(Commands.ownerUserId, principal.userId),
              eq(Commands.workspaceId, input.workspaceId)
            )
          )
          .orderBy(desc(Commands.createdAt), asc(Commands.id))
          .limit(51)
        const selected = rows.slice(0, 50)
        if (input.requestId && !selected.some((r) => r.requestId === input.requestId)) {
          const [requested] = await tx
            .select()
            .from(Commands)
            .where(
              and(
                eq(Commands.ownerUserId, principal.userId),
                eq(Commands.workspaceId, input.workspaceId),
                eq(Commands.requestId, input.requestId)
              )
            )
            .limit(1)
          if (requested) selected.push(requested)
        }
        const commands = []
        for (const row of selected) commands.push(await summary(tx, row, now))
        need(session.expiresAt > (await clock(tx)))
        return {
          observedAt: now.getTime(),
          devices,
          commands,
          truncated: certificates.length > 20 || rows.length > 50,
        }
      })
    },
    async claim(
      peer: AgentPeer,
      raw: Extract<AgentControlRequest, { op: 'claim' }>
    ): Promise<AgentCommand | null> {
      const request = AgentControlRequestSchema.parse(raw)
      need(request.op === 'claim')
      return transaction(peer, async (tx, current, now) => {
        need(request.session.windowsSid === current.windowsSid)
        await tx
          .insert(Desktops)
          .values({
            agentId: current.agentId,
            observedCertificateId: current.certificateId,
            observedSessionId: request.session.sessionId,
            observedWindowsSid: current.windowsSid,
            observedAt: now,
          })
          .onConflictDoUpdate({
            target: Desktops.agentId,
            set: {
              observedCertificateId: current.certificateId,
              observedSessionId: request.session.sessionId,
              observedWindowsSid: current.windowsSid,
              observedAt: now,
            },
          })
        const active = await tx
          .select()
          .from(Commands)
          .where(
            and(
              eq(Commands.agentId, current.agentId),
              sql`${Commands.status} IN ('claimed','consented','running','hold')`
            )
          )
          .for('update')
          .limit(1)
        if (active[0]) {
          const row = active[0]
          bound(current, row)
          await live(tx, row, now, current)
          // A successful claim is a one-shot delivery. Never redispatch after lost ACK/restart.
          return null
        }
        const [row] = await tx
          .select()
          .from(Commands)
          .where(
            and(
              eq(Commands.agentId, current.agentId),
              eq(Commands.certificateId, current.certificateId),
              eq(Commands.sessionId, request.session.sessionId),
              eq(Commands.status, 'queued'),
              sql`${Commands.expiresAt}>clock_timestamp()`
            )
          )
          .orderBy(asc(Commands.createdAt), asc(Commands.id))
          .for('update')
          .limit(1)
        if (!row) return null
        bound(current, row)
        if (!(await personalSourceLive(tx, row, current))) return null
        const [state] = await tx
          .select()
          .from(Desktops)
          .where(eq(Desktops.agentId, current.agentId))
          .for('update')
          .limit(1)
        need(state && Number.isSafeInteger(state.epoch) && state.epoch < Number.MAX_SAFE_INTEGER)
        const epoch = state.epoch + 1
        const template = AgentCommandSchema.parse(row.intent)
        need(
          (template.action.kind === 'capture.start' &&
            template.action.maxBytes <= 32 * 1024 * 1024) ||
            (template.action.kind === 'procedure.run' && template.action.mode === 'test')
        )
        const command = AgentCommandSchema.parse({
          ...template,
          leaseEpoch: epoch,
          issuedAt: now.toISOString(),
          resourceLocks: [{ kind: 'desktop', resourceId: current.agentId, fence: epoch }],
        })
        command.digest =
          'sha256:' + createHash('sha256').update(desktopCommandBytes(command)).digest('hex')
        await tx.update(Desktops).set({ epoch }).where(eq(Desktops.agentId, current.agentId))
        await tx
          .update(Commands)
          .set({
            command,
            digest: command.digest,
            epoch,
            status: 'claimed',
            leaseUntil: new Date(Math.min(now.getTime() + 30_000, row.expiresAt.getTime())),
          })
          .where(eq(Commands.id, row.id))
        return command
      })
    },
    async checkpoint(peer: AgentPeer, raw: Extract<AgentControlRequest, { op: 'checkpoint' }>) {
      const request = AgentControlRequestSchema.parse(raw)
      need(request.op === 'checkpoint')
      return transaction(peer, async (tx, current, now) => {
        const row = await rowFor(tx, current, request.command)
        capabilityMatches(row, request.capabilityId)
        if (!(await live(tx, row, now, current))) return false
        await renew(tx, row, now)
        return true
      })
    },
    async consent(peer: AgentPeer, raw: Extract<AgentControlRequest, { op: 'consent' }>) {
      const request = AgentControlRequestSchema.parse(raw)
      need(request.op === 'consent')
      return transaction(peer, async (tx, current, now) => {
        const row = await rowFor(tx, current, request.command)
        const observation = request.observation
        need(
          observation.sessionId === row.sessionId &&
            observation.windowsSid === row.windowsSid &&
            observation.commandDigest === row.digest
        )
        if (!(await live(tx, row, now, current))) return null
        if (row.capability) {
          const existing = SessionCapabilitySchema.parse(row.capability)
          need(
            hash(existing.consent) ===
              hash({
                consentId: observation.consentId,
                confirmedLocallyAt: observation.confirmedLocallyAt,
                commandDigest: observation.commandDigest,
              })
          )
          return existing
        }
        need(row.status === 'claimed')
        const consentNow = await clock(tx)
        const confirmed = Date.parse(observation.confirmedLocallyAt)
        need(confirmed >= consentNow.getTime() - 30_000 && confirmed <= consentNow.getTime() + 5000)
        const command = AgentCommandSchema.parse(row.command)
        need(confirmed >= Date.parse(command.issuedAt))
        const capability = SessionCapabilitySchema.parse({
          schemaVersion: 'memlia.session-capability/v1',
          organizationId: current.organizationId,
          workspaceId: current.workspaceId,
          agentId: current.agentId,
          ownerUserId: current.ownerUserId,
          windowsSid: row.windowsSid,
          sessionId: row.sessionId,
          leaseEpoch: row.epoch,
          resourceLocks: command.resourceLocks,
          issuedAt: consentNow.toISOString(),
          expiresAt: row.expiresAt.toISOString(),
          capabilityId: row.capabilityId,
          consent: {
            consentId: observation.consentId,
            confirmedLocallyAt: observation.confirmedLocallyAt,
            commandDigest: observation.commandDigest,
          },
          capabilities: [
            command.action.kind === 'capture.start' ? 'desktop.capture' : 'desktop.replay',
          ],
          qualification: command.qualification,
        })
        await tx
          .update(Commands)
          .set({ capability, consentId: observation.consentId, status: 'consented' })
          .where(eq(Commands.id, row.id))
        await renew(tx, row, now)
        return capability
      })
    },
    async publish(peer: AgentPeer, raw: Extract<AgentControlRequest, { op: 'publish' }>) {
      const request = AgentControlRequestSchema.parse(raw)
      need(request.op === 'publish')
      const store = configured()
      return transaction(peer, async (tx, current, now) => {
        const row = await rowFor(tx, current, request.command)
        const receipt = request.receipt
        need(
          receipt.commandId === row.id &&
            receipt.runId === row.runId &&
            receipt.workspaceId === row.workspaceId &&
            receipt.organizationId === row.organizationId
        )
        capabilityMatches(row, request.capabilityId)
        const digest = hash({ receipt, artifacts: request.artifacts })
        const [previous] = await tx
          .select()
          .from(Receipts)
          .where(and(eq(Receipts.commandId, row.id), eq(Receipts.sequence, receipt.sequence)))
          .limit(1)
        if (previous) {
          need(previous.digest === digest)
          return true
        }
        if (!(await live(tx, row, now, current))) return false
        need(receipt.sequence === row.lastSequence + 1 && Number.isSafeInteger(receipt.sequence))
        const status = receipt.outcome.status
        if (AgentCommandSchema.parse(row.command).action.kind !== 'capture.start')
          need(status !== 'succeeded_verified')
        if (!row.capability)
          need(
            ['awaiting_local_consent', 'failed', 'cancelled_before_start'].includes(status) &&
              receipt.outcome.effect === 'none'
          )
        need(
          Date.parse(receipt.recordedAt) >=
            Date.parse(AgentCommandSchema.parse(row.command).issuedAt) &&
            Date.parse(receipt.recordedAt) <= now.getTime() + 5000
        )
        const refs = [...request.artifacts, ...receipt.outcome.evidence]
        need(refs.every((r) => request.artifacts.some((a) => refsEqual(a, r))))
        need(new Set(request.artifacts.map((r) => r.artifactId)).size === request.artifacts.length)
        need(
          (await store.assertComplete(tx, scope(current, row), request.artifacts, receipt)) === true
        )
        if (!(await live(tx, row, now, current))) return false
        await tx.insert(Receipts).values({
          id: randomUUID(),
          commandId: row.id,
          sequence: receipt.sequence,
          digest,
          receipt,
          artifacts: request.artifacts,
        })
        const terminal = [
          'succeeded_verified',
          'failed',
          'stopped',
          'cancelled_before_start',
        ].includes(status)
        const hold = status === 'uncertain' || status === 'awaiting_intervention'
        await tx
          .update(Commands)
          .set({
            lastSequence: receipt.sequence,
            status: hold ? 'hold' : terminal ? 'terminal' : row.capability ? 'running' : 'claimed',
          })
          .where(eq(Commands.id, row.id))
        if (!terminal && !hold) await renew(tx, row, now)
        return true
      })
    },
    async withAuthorizedArtifact<T>(
      peer: AgentPeer,
      key: CommandKey,
      capabilityId: string | null,
      kind: 'read' | 'put',
      reference: Ref,
      operation: (tx: AgentTransaction, scope: AgentArtifactScope) => Promise<T>
    ): Promise<T | null> {
      configured()
      const captured = AgentControlRequestSchema.parse({
        schemaVersion: 'memlia.agent-control-request/v1',
        requestId: 'artifact-admission',
        op: 'artifact.read',
        command: key,
        capabilityId,
        reference,
        offset: 0,
        limit: 1,
      })
      need(captured.op === 'artifact.read' && (kind === 'read' || kind === 'put'))
      return transaction(peer, async (tx, current, now) => {
        const row = await rowFor(tx, current, captured.command)
        capabilityMatches(row, captured.capabilityId)
        if (!(await live(tx, row, now, current))) return null
        if (kind === 'put') need(row.capability && captured.capabilityId === row.capabilityId)
        if (kind === 'read') {
          const command = AgentCommandSchema.parse(row.command)
          need(
            refsEqual(captured.reference, command.bundle) ||
              refsEqual(captured.reference, command.qualification) ||
              (command.action.kind === 'procedure.run' &&
                command.action.mode === 'test' &&
                (refsEqual(captured.reference, command.action.procedure) ||
                  refsEqual(captured.reference, command.action.parameters)))
          )
        }
        const leaseLost = Symbol('lease_lost')
        try {
          return await tx.transaction(async (nested) => {
            const result = await operation(nested, scope(current, row))
            if (!(await live(nested, row, now, current))) throw leaseLost
            return result
          })
        } catch (error) {
          if (error !== leaseLost) throw error
          await tx.update(Commands).set({ status: 'hold' }).where(eq(Commands.id, row.id))
          return null
        }
      })
    },
  }
}
