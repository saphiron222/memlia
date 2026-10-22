// Copyright (c) 2026 Memlia. All rights reserved.
import { createHash, randomUUID } from 'node:crypto'
import {
  type AgentCommand,
  type AgentControlRequest,
  AgentControlRequestSchema,
  AGENT_ARTIFACT_CHUNK_BYTES as CHUNK,
  AGENT_ARTIFACT_MAX_BYTES as MAX,
  type RunReceipt,
} from '@memlia/contracts'
import {
  memliaDesktopAgentArtifact as Artifacts,
  memliaDesktopAgentArtifactChunk as Chunks,
} from '@sim/db/schema'
import { and, asc, eq, gte, lte, sql } from 'drizzle-orm'
import type {
  AgentArtifactScope,
  AgentCommandArtifacts,
  AgentTransaction,
} from './agent-command-repository'

type Ref = AgentCommand['bundle']
type ArtifactRow = typeof Artifacts.$inferSelect
type ReadRequest = Extract<AgentControlRequest, { op: 'artifact.read' }>
type PutRequest = Extract<AgentControlRequest, { op: 'artifact.put' }>
const refused = () => new Error('agent_artifact_refused')
function need(value: unknown): asserts value {
  if (!value) throw refused()
}
const digest = (bytes: Uint8Array) => 'sha256:' + createHash('sha256').update(bytes).digest('hex')

function decode(value: string) {
  const bytes = Buffer.from(value, 'base64')
  need(bytes.length <= CHUNK && bytes.toString('base64') === value)
  return bytes
}
function key(scope: AgentArtifactScope, ref: Ref) {
  return and(eq(Artifacts.commandId, scope.commandId), eq(Artifacts.artifactId, ref.artifactId))
}
function chunkKey(scope: AgentArtifactScope, ref: Ref) {
  return and(eq(Chunks.commandId, scope.commandId), eq(Chunks.artifactId, ref.artifactId))
}
async function row(tx: AgentTransaction, scope: AgentArtifactScope, ref: Ref) {
  const [stored] = await tx.select().from(Artifacts).where(key(scope, ref)).for('update').limit(1)
  if (stored) need(stored.sha256 === ref.sha256)
  return stored
}
async function verify(
  tx: AgentTransaction,
  scope: AgentArtifactScope,
  ref: Ref,
  stored: ArtifactRow
) {
  // Fixed-size chunks bound both row count and total allocation. No ZIP is
  // interpreted here and no uploaded procedure becomes executable or ready.
  const chunks = await tx
    .select()
    .from(Chunks)
    .where(chunkKey(scope, ref))
    .orderBy(asc(Chunks.offset))
    .limit(Math.ceil(MAX / CHUNK) + 1)
  const hasher = createHash('sha256')
  let offset = 0
  need(chunks.length === Math.max(1, Math.ceil(stored.totalBytes / CHUNK)))
  for (const part of chunks) {
    const bytes = decode(part.dataBase64)
    need(
      part.offset === offset &&
        bytes.length === part.byteCount &&
        bytes.length === Math.min(CHUNK, stored.totalBytes - offset)
    )
    hasher.update(bytes)
    offset += bytes.length
  }
  need(offset === stored.totalBytes && 'sha256:' + hasher.digest('hex') === ref.sha256)
}
async function insertServerManifest(
  tx: AgentTransaction,
  scope: AgentArtifactScope,
  value: unknown
) {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8')
  need(bytes.length > 0 && bytes.length <= CHUNK)
  const ref = Object.freeze({ artifactId: randomUUID(), sha256: digest(bytes) })
  await tx.insert(Artifacts).values({
    commandId: scope.commandId,
    artifactId: ref.artifactId,
    sha256: ref.sha256,
    origin: 'server',
    totalBytes: bytes.length,
    nextOffset: bytes.length,
    complete: true,
  })
  await tx.insert(Chunks).values({
    commandId: scope.commandId,
    artifactId: ref.artifactId,
    offset: 0,
    byteCount: bytes.length,
    dataBase64: bytes.toString('base64'),
  })
  return ref
}

/** Only called INSIDE createAgentCommandRepository's authorized transaction.
 * That repository locks the live command and rechecks its certificate, owner,
 * permission, session, capability and fence. This adapter is not a public API.
 * PostgreSQL private storage keeps command/chunks/publication atomic and in the
 * existing cold backup. Encryption at rest belongs to the cabinet's VM volume.
 */
export function createAgentArtifactStore(): AgentCommandArtifacts & {
  read(
    tx: AgentTransaction,
    scope: AgentArtifactScope,
    request: ReadRequest
  ): Promise<{
    reference: Ref
    offset: number
    totalBytes: number
    dataBase64: string
    done: boolean
  }>
  put(
    tx: AgentTransaction,
    scope: AgentArtifactScope,
    request: PutRequest
  ): Promise<{
    reference: Ref
    nextOffset: number
    complete: boolean
  }>
} {
  return {
    async captureInputs(tx, scope) {
      const binding = {
        commandId: scope.commandId,
        runId: scope.runId,
        agentId: scope.agentId,
        organizationId: scope.organizationId,
        workspaceId: scope.workspaceId,
        ownerUserId: scope.ownerUserId,
        windowsSid: scope.windowsSid,
        sessionId: scope.sessionId,
      }
      const bundle = await insertServerManifest(tx, scope, {
        schemaVersion: 'memlia.capture-input/v1',
        ...binding,
        maxDurationSeconds: scope.maxDurationSeconds,
        maxBytes: scope.maxBytes,
        audio: false,
        localConsentRequired: true,
      })
      const qualification = await insertServerManifest(tx, scope, {
        schemaVersion: 'memlia.capture-policy/v1',
        ...binding,
        purpose: 'capture_only',
        replayAdmitted: false,
        nextState: 'to_test',
      })
      return { bundle, qualification }
    },
    async personalTestInputs(tx, scope, source) {
      // The repository has already locked/revalidated the owner, immutable version and
      // successful source receipt in this transaction. Never accept a browser artifact ID.
      need(
        source.scope.ownerUserId === scope.ownerUserId &&
          source.scope.workspaceId === scope.workspaceId &&
          source.scope.organizationId === scope.organizationId
      )
      const stored = await row(tx, source.scope, source.reference)
      need(
        stored?.complete &&
          stored.origin === 'agent' &&
          stored.totalBytes > 0 &&
          stored.totalBytes <= MAX &&
          stored.nextOffset === stored.totalBytes
      )
      await verify(tx, source.scope, source.reference, stored)
      const bundle = { artifactId: randomUUID(), sha256: source.reference.sha256 }
      await tx.insert(Artifacts).values({
        commandId: scope.commandId,
        artifactId: bundle.artifactId,
        sha256: bundle.sha256,
        origin: 'server',
        totalBytes: stored.totalBytes,
        nextOffset: stored.totalBytes,
        complete: true,
      })
      const chunks = await tx
        .select()
        .from(Chunks)
        .where(chunkKey(source.scope, source.reference))
        .orderBy(asc(Chunks.offset))
        .limit(Math.ceil(MAX / CHUNK) + 1)
      for (const part of chunks)
        await tx.insert(Chunks).values({
          commandId: scope.commandId,
          artifactId: bundle.artifactId,
          offset: part.offset,
          byteCount: part.byteCount,
          dataBase64: part.dataBase64,
        })
      const procedure = await insertServerManifest(tx, scope, {
        backend: { kind: 'windows' },
        runtime: {
          profile: 'demo',
          allow_model_grounding: false,
          grounding_model: { enabled: false },
        },
        effects: { kind: 'none' },
      })
      const parameters = await insertServerManifest(tx, scope, {})
      const qualification = await insertServerManifest(tx, scope, {
        schemaVersion: 'memlia.personal-test-admission/v1',
        purpose: 'personal_test',
        productionAdmitted: false,
        commandId: scope.commandId,
        runId: scope.runId,
        agentId: scope.agentId,
        organizationId: scope.organizationId,
        workspaceId: scope.workspaceId,
        ownerUserId: scope.ownerUserId,
        windowsSid: scope.windowsSid,
        sessionId: scope.sessionId,
        procedureId: source.procedureId,
        revision: source.revision,
        maxDurationSeconds: source.maxDurationSeconds,
        bundle,
        procedure,
        parameters,
        localConsentRequired: true,
      })
      return { bundle, procedure, parameters, qualification }
    },
    async personalTestVersion(tx, scope, command) {
      const ref = command.qualification
      const stored = await row(tx, scope, ref)
      need(
        stored?.complete &&
          stored.origin === 'server' &&
          stored.totalBytes > 0 &&
          stored.totalBytes <= 65536
      )
      await verify(tx, scope, ref, stored)
      const [part] = await tx.select().from(Chunks).where(chunkKey(scope, ref)).limit(1)
      need(part && part.offset === 0)
      const manifest = JSON.parse(decode(part.dataBase64).toString('utf8'))
      need(
        command.action.kind === 'procedure.run' &&
          command.action.mode === 'test' &&
          manifest.schemaVersion === 'memlia.personal-test-admission/v1' &&
          manifest.purpose === 'personal_test' &&
          manifest.productionAdmitted === false &&
          manifest.localConsentRequired === true &&
          typeof manifest.procedureId === 'string' &&
          /^[0-9a-f-]{36}$/.test(manifest.procedureId) &&
          Number.isSafeInteger(manifest.revision) &&
          manifest.revision >= 1 &&
          [
            'commandId',
            'runId',
            'agentId',
            'organizationId',
            'workspaceId',
            'ownerUserId',
            'windowsSid',
            'sessionId',
          ].every((key) => manifest[key] === (scope as unknown as Record<string, unknown>)[key]) &&
          manifest.bundle.artifactId === command.bundle.artifactId &&
          manifest.bundle.sha256 === command.bundle.sha256 &&
          manifest.procedure.artifactId === command.action.procedure.artifactId &&
          manifest.procedure.sha256 === command.action.procedure.sha256 &&
          manifest.parameters.artifactId === command.action.parameters.artifactId &&
          manifest.parameters.sha256 === command.action.parameters.sha256
      )
      return { procedureId: manifest.procedureId, revision: manifest.revision }
    },
    async put(tx, scope, raw) {
      const request = AgentControlRequestSchema.parse(raw)
      need(
        request.op === 'artifact.put' &&
          request.command.commandId === scope.commandId &&
          request.command.digest === scope.commandDigest &&
          request.command.leaseEpoch === scope.leaseEpoch &&
          request.capabilityId === scope.capabilityId
      )
      const { reference, totalBytes, offset } = request
      const bytes = decode(request.dataBase64)
      need(
        offset % CHUNK === 0 &&
          offset <= totalBytes &&
          bytes.length === Math.min(CHUNK, totalBytes - offset) &&
          (bytes.length > 0 || totalBytes === 0)
      )
      let stored = await row(tx, scope, reference)
      if (!stored) {
        need(offset === 0)
        const [budget] = await tx
          .select({
            count: sql<number>`count(*)::integer`,
            bytes: sql<number>`coalesce(sum(${Artifacts.totalBytes}),0)::integer`,
          })
          .from(Artifacts)
          .where(and(eq(Artifacts.commandId, scope.commandId), eq(Artifacts.origin, 'agent')))
        need(budget && budget.count < 128 && budget.bytes + totalBytes <= MAX)
        if (totalBytes === 0) need(reference.sha256 === digest(bytes))
        const [created] = await tx
          .insert(Artifacts)
          .values({
            commandId: scope.commandId,
            artifactId: reference.artifactId,
            sha256: reference.sha256,
            origin: 'agent',
            totalBytes,
            complete: totalBytes === 0,
          })
          .returning()
        stored = created
      }
      need(stored.origin === 'agent' && stored.totalBytes === totalBytes)
      const [previous] = await tx
        .select()
        .from(Chunks)
        .where(and(chunkKey(scope, reference), eq(Chunks.offset, offset)))
        .limit(1)
      const nextOffset = offset + bytes.length
      if (previous) {
        need(
          previous.byteCount === bytes.length &&
            previous.dataBase64 === request.dataBase64 &&
            stored.nextOffset >= nextOffset
        )
        return { reference, nextOffset, complete: nextOffset === totalBytes }
      }
      need(stored.nextOffset === offset && (!stored.complete || totalBytes === 0))
      await tx.insert(Chunks).values({
        commandId: scope.commandId,
        artifactId: reference.artifactId,
        offset,
        byteCount: bytes.length,
        dataBase64: request.dataBase64,
      })
      const complete = nextOffset === totalBytes
      if (complete) await verify(tx, scope, reference, stored)
      const changed = await tx
        .update(Artifacts)
        .set({ nextOffset, complete })
        .where(and(key(scope, reference), eq(Artifacts.nextOffset, offset)))
        .returning({ id: Artifacts.artifactId })
      need(changed.length === 1)
      return { reference, nextOffset, complete }
    },
    async read(tx, scope, raw) {
      const request = AgentControlRequestSchema.parse(raw)
      need(
        request.op === 'artifact.read' &&
          request.command.commandId === scope.commandId &&
          request.command.digest === scope.commandDigest &&
          request.command.leaseEpoch === scope.leaseEpoch
      )
      const { reference, offset, limit } = request
      const stored = await row(tx, scope, reference)
      need(
        stored?.complete && stored.nextOffset === stored.totalBytes && offset <= stored.totalBytes
      )
      const end = Math.min(stored.totalBytes, offset + limit)
      const first = Math.floor(offset / CHUNK) * CHUNK
      const chunks = await tx
        .select()
        .from(Chunks)
        .where(
          and(
            chunkKey(scope, reference),
            gte(Chunks.offset, first),
            lte(Chunks.offset, Math.max(first, end - 1))
          )
        )
        .orderBy(asc(Chunks.offset))
        .limit(2)
      const parts: Buffer[] = []
      let at = first
      for (const part of chunks) {
        const bytes = decode(part.dataBase64)
        need(
          part.offset === at &&
            part.byteCount === bytes.length &&
            bytes.length === Math.min(CHUNK, stored.totalBytes - at)
        )
        parts.push(bytes)
        at += bytes.length
      }
      need(at >= end)
      const result = Buffer.concat(parts).subarray(offset - first, end - first)
      need(result.length === end - offset)
      return {
        reference,
        offset,
        totalBytes: stored.totalBytes,
        dataBase64: result.toString('base64'),
        done: end === stored.totalBytes,
      }
    },
    async assertComplete(tx, scope, refs, receipt: RunReceipt) {
      need(refs.length <= 128 && new Set(refs.map((r) => r.artifactId)).size === refs.length)
      let total = 0
      for (const ref of refs) {
        const stored = await row(tx, scope, ref)
        need(
          stored?.complete && stored.origin === 'agent' && stored.nextOffset === stored.totalBytes
        )
        total += stored.totalBytes
        need(total <= MAX)
        await verify(tx, scope, ref, stored)
      }
      if (receipt.outcome.status === 'succeeded_verified') {
        // This verifier proves only capture/compilation export, not business
        // correctness, replay admission, or a ready procedure.
        need(
          total > 0 &&
            receipt.outcome.verifierId === 'memlia_capture_compile_v1' &&
            refs.length === 1 &&
            receipt.outcome.evidence.length === 1 &&
            receipt.outcome.effect === 'known' &&
            receipt.outcome.evidence[0].artifactId === refs[0].artifactId &&
            receipt.outcome.evidence[0].sha256 === refs[0].sha256
        )
      }
      return true
    },
  }
}
