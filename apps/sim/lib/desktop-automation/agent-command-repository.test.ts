// Copyright (c) 2026 Memlia. All rights reserved.
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({ db: null as any }))
vi.mock('@sim/db', async () => {
  const schema = await import('@sim/db/schema')
  return {
    user: schema.user,
    db: {
      transaction: (fn: any) => {
        if (!runtime.db) throw new Error('DB must not be reached')
        return runtime.db.transaction(fn)
      },
    },
  }
})
vi.mock('@/lib/auth/access-control', () => ({
  getAccessControlConfig: () => ({}),
  isEmailBlockedByAccessControl: () => false,
}))

import { createAgentArtifactStore } from './agent-artifact-store'
import {
  type AgentCommandArtifacts,
  createAgentCommandRepository,
} from './agent-command-repository'
import { createAgentControlService } from './agent-control-service'

describe('agent command admission is closed before missing authority/artifact effects', () => {
  it('never creates an intent without the private artifact admission port', async () => {
    const repo = createAgentCommandRepository({ artifacts: null })
    await expect(
      repo.createIntent(
        { kind: 'session', userId: 'owner', sessionId: 'browser' },
        {
          workspaceId: 'space',
          agentId: 'agent',
          requestId: '11111111-1111-4111-8111-111111111111',
          maxDurationSeconds: 10,
          maxBytes: 1024,
        }
      )
    ).rejects.toThrow('agent_command_unavailable')
  })
  it('does not permit a certificate to supply the browser authority or a replay action', async () => {
    const repo = createAgentCommandRepository({ artifacts: null })
    await expect(
      repo.createIntent(
        { kind: 'personal_api_key', userId: 'owner', keyId: 'key' } as never,
        {} as never
      )
    ).rejects.toThrow()
  })
})

// Native PostgreSQL is opt-in, isolated by the existing owned-cluster recipe.
// Artifact completeness is an explicit external port double, never a real storage claim.
describe.skipIf(!process.env.MEMLIA_AGENT_COMMAND_TEST_URL)(
  'native command transaction boundaries',
  () => {
    let client: any
    let schema: typeof import('@sim/db/schema')
    beforeAll(async () => {
      const { default: postgres } = await import('postgres')
      const { drizzle } = await import('drizzle-orm/postgres-js')
      const { withUtcTimestamps } = await import('../../../../packages/db/timestamps')
      const { readFile } = await import('node:fs/promises')
      const { resolve } = await import('node:path')
      client = postgres(
        process.env.MEMLIA_AGENT_COMMAND_TEST_URL!,
        withUtcTimestamps({ connection: {}, max: 8, connect_timeout: 3, prepare: false })
      )
      await client.unsafe(`CREATE TABLE "user" (id text PRIMARY KEY,banned boolean,ban_expires timestamp,suspended_at timestamp);
      CREATE TABLE artifact_effect(id text PRIMARY KEY);
      CREATE TABLE organization(id text PRIMARY KEY);
      CREATE TABLE workspace(id text PRIMARY KEY,organization_id text,archived_at timestamp);
      CREATE TABLE permissions(id text PRIMARY KEY,user_id text,entity_type text,entity_id text,permission_type text);
      CREATE TABLE member(id text PRIMARY KEY,user_id text,organization_id text,role text);
      CREATE TABLE session(id text PRIMARY KEY,user_id text,expires_at timestamp,token text,created_at timestamp,updated_at timestamp,ip_address text,user_agent text,active_organization_id text,impersonated_by text);`)
      for (const name of [
        '0441_memlia_desktop_agent_enrollment.sql',
        '0442_memlia_desktop_agent_commands.sql',
        '0443_memlia_desktop_agent_artifacts.sql',
        '0444_memlia_desktop_agent_presence.sql',
        '0445_memlia_desktop_procedures.sql',
      ]) {
        const raw = await readFile(
          resolve(process.cwd(), '../../packages/db/migrations', name),
          'utf8'
        )
        for (const part of raw.split('--> statement-breakpoint'))
          if (part.trim()) await client.unsafe(part)
      }
      schema = await import('@sim/db/schema')
      runtime.db = drizzle(client, { schema })
    }, 15000)
    afterAll(async () => {
      runtime.db = null
      if (client) await client.end({ timeout: 3 })
    })
    async function fixture(
      artifacts?: AgentCommandArtifacts,
      shared?: {
        principal: { userId: string; sessionId: string }
        input: { workspaceId: string }
      }
    ) {
      const { randomUUID } = await import('node:crypto')
      const id = randomUUID()
      const now = new Date()
      const owner = shared?.principal.userId ?? 'owner-' + id
      const space = shared?.input.workspaceId ?? 'space-' + id
      const certificate = 'cert-' + id
      const agent = 'agent-' + id
      const browser = shared?.principal.sessionId ?? 'browser-' + id
      const digest = id.replaceAll('-', '').repeat(2)
      const sid = 'S-1-5-21-1-2-3-1001'
      if (!shared) {
        await client`INSERT INTO "user"(id,banned) VALUES(${owner},false)`
        await client`INSERT INTO workspace(id) VALUES(${space})`
        await client`INSERT INTO permissions(id,user_id,entity_type,entity_id,permission_type) VALUES(${id},${owner},'workspace',${space},'write')`
        await client`INSERT INTO session(id,user_id,expires_at) VALUES(${browser},${owner},${new Date(now.getTime() + 3600000).toISOString()})`
      }
      await client`INSERT INTO memlia_desktop_agent_enrollment(id,workspace_id,owner_user_id,installation_id,fqdn,code_hash,created_at,expires_at,status,csr_sha256,spki_sha256,windows_sid,challenge,challenge_digest,issuance_id,agent_id,certificate_serial,certificate_sha256,issued_at)
      VALUES(${id},${space},${owner},'installation','https://fixture.test',${digest},${now.toISOString()},${new Date(now.getTime() + 300000).toISOString()},'issued',${digest},${digest},${sid},${'a'.repeat(43)},${digest},${certificate},${agent},${id.replaceAll('-', '')},${digest},${now.toISOString()})`
      await client`INSERT INTO memlia_desktop_agent_certificate(id,agent_id,enrollment_id,workspace_id,owner_user_id,installation_id,fqdn,windows_sid,csr_sha256,spki_sha256,certificate_serial,certificate_sha256,certificate_pem,not_before,not_after)
      VALUES(${certificate},${agent},${id},${space},${owner},'installation','https://fixture.test',${sid},${digest},${digest},${id.replaceAll('-', '')},${digest},'public fixture pem',${new Date(now.getTime() - 1000).toISOString()},${new Date(now.getTime() + 3600000).toISOString()})`
      const peer = {
        certificateId: certificate,
        certificateSha256: digest,
        agentId: agent,
        ownerUserId: owner,
        workspaceId: space,
        organizationId: null,
        installationId: 'installation',
        fqdn: 'https://fixture.test',
        windowsSid: sid,
      }
      let complete = true
      const publications: any[] = []
      const inputs: any[] = []
      const repo = createAgentCommandRepository({
        artifacts: artifacts ?? {
          captureInputs: async (tx, scope) => {
            expect(tx).toBeTruthy()
            inputs.push(scope)
            return {
              bundle: { artifactId: 'bundle-' + id, sha256: 'sha256:' + digest },
              qualification: { artifactId: 'qualification-' + id, sha256: 'sha256:' + digest },
            }
          },
          assertComplete: async (tx, scope, refs, receipt) => {
            expect(tx).toBeTruthy()
            publications.push({ scope, refs, receipt })
            return complete
          },
        },
      })
      const input = {
        workspaceId: space,
        agentId: agent,
        sessionId: 'desktop-' + id,
        requestId: String(id),
        maxDurationSeconds: 10,
        maxBytes: 1024,
      }
      const principal = { kind: 'session' as const, userId: owner, sessionId: browser }
      const envelope = { schemaVersion: 'memlia.agent-control-request/v1' as const, requestId: id }
      const claimRequest = {
        ...envelope,
        op: 'claim' as const,
        session: { sessionId: input.sessionId, windowsSid: sid },
      }
      const browserInput = () => {
        const { sessionId: _session, ...request } = input
        return request
      }
      let observed = false
      const create = async () => {
        if (!observed) {
          await repo.claim(peer, claimRequest)
          observed = true
        }
        return repo.createIntent(principal, browserInput())
      }
      const claim = () => repo.claim(peer, claimRequest)
      const key = (command: any) => ({
        commandId: command.commandId,
        digest: command.digest,
        leaseEpoch: command.leaseEpoch,
      })
      const consent = (command: any, extra: any = {}) =>
        repo.consent(peer, {
          ...envelope,
          op: 'consent',
          command: key(command),
          observation: {
            sessionId: input.sessionId,
            windowsSid: sid,
            consentId: 'consent-' + id,
            commandDigest: command.digest,
            confirmedLocallyAt: new Date().toISOString(),
            ...extra,
          },
        })
      const publish = (
        command: any,
        sequence: number,
        outcome: any,
        capabilityId: string | null,
        artifacts: any[] = []
      ) =>
        repo.publish(peer, {
          ...envelope,
          op: 'publish',
          command: key(command),
          capabilityId,
          artifacts,
          receipt: {
            schemaVersion: 'memlia.run-receipt/v1',
            organizationId: null,
            workspaceId: space,
            runId: command.runId,
            commandId: command.commandId,
            sequence,
            recordedAt: new Date().toISOString(),
            outcome,
          },
        })
      return {
        id,
        peer,
        repo,
        input,
        principal,
        envelope,
        create,
        claim,
        key,
        consent,
        publish,
        publications,
        inputs,
        setComplete: (v: boolean) => (complete = v),
      }
    }
    it('presence selection is native and browser session selection is rejected', async () => {
      const f = await fixture()
      const input = {
        workspaceId: f.input.workspaceId,
        agentId: f.input.agentId,
        requestId: f.id,
        maxDurationSeconds: 10,
        maxBytes: 1024,
      }
      await expect(f.repo.createIntent(f.principal, input)).rejects.toThrow()
      expect(await f.claim()).toBeNull()
      await expect(
        f.repo.createIntent(f.principal, { ...input, sessionId: 'foreign' } as never)
      ).rejects.toThrow()
      const first = await f.repo.createIntent(f.principal, input)
      const [row] =
        await client`SELECT session_id FROM memlia_desktop_agent_command WHERE id=${first.commandId}`
      expect(row.session_id).toBe(f.input.sessionId)
      const listing = await f.repo.listOwned(f.principal, { workspaceId: f.input.workspaceId })
      expect(listing.devices[0].observation).toBe('recent')
      expect(JSON.stringify(listing)).not.toContain(f.peer.windowsSid)
    })
    it('presence request is idempotent under concurrency and stays same after completion', async () => {
      const f = await fixture()
      await f.claim()
      const { sessionId: _s, ...input } = f.input
      const [a, b] = await Promise.all([
        f.repo.createIntent(f.principal, input),
        f.repo.createIntent(f.principal, input),
      ])
      expect(a.commandId).toBe(b.commandId)
      const command = (await f.claim())!
      await f.publish(
        command,
        0,
        { status: 'cancelled_before_start', effect: 'none', evidence: [] },
        null
      )
      expect((await f.repo.createIntent(f.principal, input)).commandId).toBe(a.commandId)
      expect(await f.claim()).toBeNull()
      await expect(f.repo.createIntent(f.principal, { ...input, maxBytes: 2048 })).rejects.toThrow()
    })
    it('presence stale, changed session, revoked certificate and busy commands refuse new effects', async () => {
      const f = await fixture()
      await f.claim()
      const { sessionId: _s, ...input } = f.input
      await client`UPDATE memlia_desktop_agent_state SET observed_at=clock_timestamp()-interval '31 seconds' WHERE agent_id=${f.peer.agentId}`
      await expect(f.repo.createIntent(f.principal, input)).rejects.toThrow()
      expect(
        (await f.repo.listOwned(f.principal, { workspaceId: input.workspaceId })).devices[0]
          .observation
      ).toBe('offline')
      await f.claim()
      const first = await f.repo.createIntent(f.principal, input)
      await expect(
        f.repo.createIntent(f.principal, { ...input, requestId: crypto.randomUUID() })
      ).rejects.toThrow()
      await f.repo.claim(f.peer, {
        ...f.envelope,
        op: 'claim',
        session: { sessionId: 'new-session', windowsSid: f.peer.windowsSid },
      })
      await expect(f.repo.createIntent(f.principal, input)).rejects.toThrow()
      expect(
        await client`SELECT id FROM memlia_desktop_agent_command WHERE agent_id=${f.peer.agentId}`
      ).toHaveLength(1)
      await client`UPDATE memlia_desktop_agent_certificate SET revoked_at=clock_timestamp() WHERE id=${f.peer.certificateId}`
      await expect(f.repo.createIntent(f.principal, input)).rejects.toThrow()
      const list = await f.repo.listOwned(f.principal, { workspaceId: input.workspaceId })
      expect(list.devices[0].observation).toBe('unavailable')
      expect(list.commands[0].commandId).toBe(first.commandId)
    })
    it('presence catalog remains owner-only with revoked access and expired lease shown HOLD', async () => {
      const f = await fixture()
      await f.create()
      const command = (await f.claim())!
      await client`UPDATE memlia_desktop_agent_command SET lease_until=clock_timestamp()-interval '1 second' WHERE id=${command.commandId}`
      const list = await f.repo.listOwned(f.principal, { workspaceId: f.input.workspaceId })
      expect(list.devices[0].busy).toBe('hold')
      expect(list.commands[0].status).toBe('hold')
      expect(list.commands[0].exportStatus).toBe('none')
      const g = await fixture()
      await client`INSERT INTO permissions(id,user_id,entity_type,entity_id,permission_type) VALUES(${crypto.randomUUID()},${g.principal.userId},'workspace',${f.input.workspaceId},'write')`
      const other = await g.repo.listOwned(g.principal, { workspaceId: f.input.workspaceId })
      expect(other.devices).toEqual([])
      expect(other.commands).toEqual([])
      await client`UPDATE "user" SET suspended_at=clock_timestamp() WHERE id=${f.principal.userId}`
      await expect(
        f.repo.listOwned(f.principal, { workspaceId: f.input.workspaceId })
      ).rejects.toThrow()
    })
    it('requires a native browser session, current owner and write permission to enqueue; claim cannot create', async () => {
      const f = await fixture()
      expect(await f.claim()).toBeNull()
      await expect(
        f.repo.createIntent(
          { ...f.principal, sessionId: 'missing' },
          {
            workspaceId: f.input.workspaceId,
            agentId: f.input.agentId,
            requestId: f.id,
            maxDurationSeconds: 10,
            maxBytes: 1024,
          }
        )
      ).rejects.toThrow('agent_command_refused')
      await client`UPDATE permissions SET permission_type='read' WHERE id=${f.id}`
      await expect(f.create()).rejects.toThrow('agent_command_refused')
      await client`UPDATE permissions SET permission_type='write' WHERE id=${f.id}`
      await f.create()
      expect((await f.claim())?.action.kind).toBe('capture.start')
    })
    it('serializes simultaneous claims into one immutable command and strictly increasing future fence', async () => {
      const f = await fixture()
      await f.create()
      await f.create()
      const claims = await Promise.all([f.claim(), f.claim(), f.claim()])
      expect(claims.filter(Boolean)).toHaveLength(1)
      expect(claims.filter((c) => c === null)).toHaveLength(2)
      const command = claims.find(Boolean)!
      expect(
        await f.publish(
          command,
          0,
          { status: 'cancelled_before_start', effect: 'none', evidence: [] },
          null
        )
      ).toBe(true)
      f.input.requestId = crypto.randomUUID()
      await f.create()
      const next = (await f.claim())!
      expect(next.commandId).not.toBe(command.commandId)
      expect(next.leaseEpoch).toBe(command.leaseEpoch + 1)
      expect(next.resourceLocks[0].fence).toBe(next.leaseEpoch)
    })
    it('requires fresh exact local consent and never reuses a consent ID on another command', async () => {
      const f = await fixture()
      await f.create()
      const command = (await f.claim())!
      for (const bad of [
        { sessionId: 'foreign' },
        { windowsSid: 'S-1-5-21-9-9-9-1001' },
        { commandDigest: 'sha256:' + 'f'.repeat(64) },
        { confirmedLocallyAt: new Date(Date.now() - 31000).toISOString() },
        { confirmedLocallyAt: new Date(Date.now() + 6000).toISOString() },
      ])
        await expect(f.consent(command, bad)).rejects.toThrow('agent_command_refused')
      const capability = await f.consent(command)
      expect(capability?.capabilityId).toBe(command.capabilityId)
      await f.publish(
        command,
        0,
        { status: 'failed', effect: 'none', evidence: [], reasonCode: 'fixture' },
        command.capabilityId
      )
      f.input.requestId = crypto.randomUUID()
      await f.create()
      const next = (await f.claim())!
      await expect(f.consent(next)).rejects.toThrow()
    })
    it('commits HOLD on lease loss and never requeues or dispatches the next intent', async () => {
      const f = await fixture()
      await f.create()
      await f.create()
      const command = (await f.claim())!
      await f.consent(command)
      await client`UPDATE memlia_desktop_agent_command SET lease_until=clock_timestamp()-interval '1 second' WHERE id=${command.commandId}`
      expect(
        await f.repo.checkpoint(f.peer, {
          ...f.envelope,
          op: 'checkpoint',
          command: f.key(command),
          capabilityId: command.capabilityId,
        })
      ).toBe(false)
      expect(await f.claim()).toBeNull()
      const [row] =
        await client`SELECT status FROM memlia_desktop_agent_command WHERE id=${command.commandId}`
      expect(row.status).toBe('hold')
    })
    it('enforces receipt CAS, capability, complete scoped artifacts and identical idempotent retry', async () => {
      const f = await fixture()
      await f.create()
      const command = (await f.claim())!
      await expect(
        f.publish(command, 0, { status: 'running', effect: 'none', evidence: [] }, null)
      ).rejects.toThrow('agent_command_refused')
      await f.consent(command)
      f.setComplete(false)
      await expect(
        f.publish(
          command,
          0,
          { status: 'running', effect: 'none', evidence: [] },
          command.capabilityId
        )
      ).rejects.toThrow('agent_command_refused')
      f.setComplete(true)
      const request = {
        ...f.envelope,
        op: 'publish' as const,
        command: f.key(command),
        capabilityId: command.capabilityId,
        artifacts: [],
        receipt: {
          schemaVersion: 'memlia.run-receipt/v1' as const,
          workspaceId: f.peer.workspaceId,
          organizationId: null,
          runId: command.runId,
          commandId: command.commandId,
          sequence: 0,
          recordedAt: new Date().toISOString(),
          outcome: { status: 'running' as const, effect: 'none' as const, evidence: [] },
        },
      }
      expect(await f.repo.publish(f.peer, request)).toBe(true)
      expect(await f.repo.publish(f.peer, request)).toBe(true)
      await expect(
        f.repo.publish(f.peer, {
          ...request,
          receipt: {
            ...request.receipt,
            outcome: { status: 'stop_requested', effect: 'none', evidence: [] },
          },
        })
      ).rejects.toThrow('agent_command_refused')
      await expect(
        f.publish(
          command,
          3,
          { status: 'running', effect: 'none', evidence: [] },
          command.capabilityId
        )
      ).rejects.toThrow('agent_command_refused')
      expect(f.publications[0].scope.commandId).toBe(command.commandId)
      expect(f.publications[0].scope.ownerUserId).toBe(f.peer.ownerUserId)
    })
    it('revalidates certificate, suspended owner and role inside every mutation', async () => {
      const f = await fixture()
      await f.create()
      const command = (await f.claim())!
      const checkpoint = () =>
        f.repo.checkpoint(f.peer, {
          ...f.envelope,
          op: 'checkpoint',
          command: f.key(command),
          capabilityId: null,
        })
      await client`UPDATE "user" SET suspended_at=now() WHERE id=${f.peer.ownerUserId}`
      await expect(checkpoint()).rejects.toThrow('agent_command_refused')
      await client`UPDATE "user" SET suspended_at=NULL WHERE id=${f.peer.ownerUserId}`
      await client`UPDATE permissions SET permission_type='read' WHERE id=${f.id}`
      await expect(checkpoint()).rejects.toThrow('agent_command_refused')
      await client`UPDATE permissions SET permission_type='write' WHERE id=${f.id}`
      await client`UPDATE memlia_desktop_agent_certificate SET revoked_at=now() WHERE id=${f.peer.certificateId}`
      await expect(checkpoint()).rejects.toThrow('agent_command_refused')
    })
    it('carries native intent scope and bounds to admission, denies foreign artifact reads and puts before consent', async () => {
      const f = await fixture()
      await f.create()
      const command = (await f.claim())!
      expect(f.inputs[0]).toMatchObject({
        commandId: command.commandId,
        agentId: f.peer.agentId,
        ownerUserId: f.peer.ownerUserId,
        workspaceId: f.peer.workspaceId,
        sessionId: f.input.sessionId,
        maxDurationSeconds: 10,
        maxBytes: 1024,
      })
      const callback = vi.fn(async () => 'private')
      await expect(
        f.repo.withAuthorizedArtifact(f.peer, f.key(command), null, 'put', command.bundle, callback)
      ).rejects.toThrow('agent_command_refused')
      await expect(
        f.repo.withAuthorizedArtifact(
          f.peer,
          f.key(command),
          null,
          'read',
          { ...command.bundle, artifactId: 'foreign' },
          callback
        )
      ).rejects.toThrow('agent_command_refused')
      expect(callback).not.toHaveBeenCalled()
      expect(
        await f.repo.withAuthorizedArtifact(
          f.peer,
          f.key(command),
          null,
          'read',
          command.bundle,
          async (tx, scope) => {
            expect(tx).toBeTruthy()
            expect(scope.commandId).toBe(command.commandId)
            return 'owned'
          }
        )
      ).toBe('owned')
    })
    it('rolls back a private artifact mutation if the lease expires inside its transaction and commits HOLD', async () => {
      const f = await fixture()
      await f.create()
      const command = (await f.claim())!
      await f.consent(command)
      await client`UPDATE memlia_desktop_agent_command SET lease_until=clock_timestamp()+interval '200 milliseconds' WHERE id=${command.commandId}`
      expect(
        await f.repo.withAuthorizedArtifact(
          f.peer,
          f.key(command),
          command.capabilityId,
          'put',
          command.bundle,
          async (tx) => {
            await tx.execute(sql`INSERT INTO artifact_effect(id) VALUES(${f.id})`)
            await tx.execute(sql`SELECT pg_sleep(0.3)`)
            return 'must_not_commit'
          }
        )
      ).toBeNull()
      expect(await client`SELECT id FROM artifact_effect WHERE id=${f.id}`).toHaveLength(0)
      expect(
        (
          await client`SELECT status FROM memlia_desktop_agent_command WHERE id=${command.commandId}`
        )[0].status
      ).toBe('hold')
    })
    async function privateArtifactFixture(shared?: Parameters<typeof fixture>[1]) {
      const f = await fixture(undefined, shared)
      const service = createAgentControlService()
      const controller = new AbortController()
      const call = (fields: Record<string, unknown>) =>
        service.handle(
          f.peer,
          {
            ...f.envelope,
            ...fields,
          } as never,
          { signal: controller.signal, revalidatePeer: async () => f.peer }
        )
      await f.claim()
      const { sessionId: _s, ...captureInput } = f.input
      const intent = await service.createIntent(f.principal, captureInput)
      const response = await call({
        op: 'claim',
        session: {
          windowsSid: f.peer.windowsSid,
          sessionId: f.input.sessionId,
        },
      })
      expect(response.op).toBe('claim')
      if (response.op !== 'claim' || !response.command) throw new Error('fixture_claim')
      const command = response.command
      const consent = () =>
        call({
          op: 'consent',
          command: f.key(command),
          observation: {
            sessionId: f.input.sessionId,
            windowsSid: f.peer.windowsSid,
            consentId: 'artifact-consent-' + f.id,
            commandDigest: command.digest,
            confirmedLocallyAt: new Date().toISOString(),
          },
        })
      const ref = async (bytes: Uint8Array, suffix = 'output') => {
        const { createHash } = await import('node:crypto')
        return {
          artifactId: suffix + '-' + f.id,
          sha256: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
        }
      }
      const put = (reference: any, bytes: Buffer, totalBytes = bytes.length, offset = 0) =>
        call({
          op: 'artifact.put',
          command: f.key(command),
          capabilityId: command.capabilityId,
          reference,
          totalBytes,
          offset,
          dataBase64: bytes.toString('base64'),
        })
      const publish = (
        sequence: number,
        outcome: any,
        artifacts: any[] = [],
        capabilityId: string | null = command.capabilityId
      ) =>
        call({
          op: 'publish',
          command: f.key(command),
          capabilityId,
          artifacts,
          receipt: {
            schemaVersion: 'memlia.run-receipt/v1',
            organizationId: null,
            workspaceId: f.peer.workspaceId,
            commandId: command.commandId,
            runId: command.runId,
            sequence,
            recordedAt: new Date().toISOString(),
            outcome,
          },
        })
      return { ...f, service, call, consent, ref, put, publish, command, intent, controller }
    }
    async function procedureFixture(shared?: Parameters<typeof fixture>[1]) {
      const f = await privateArtifactFixture(shared)
      await f.consent()
      const bytes = Buffer.from('PRIVATE-PROCEDURE-FIXTURE')
      const reference = await f.ref(bytes)
      await f.put(reference, bytes)
      await f.publish(
        0,
        {
          status: 'succeeded_verified',
          effect: 'known',
          evidence: [reference],
          verifierId: 'memlia_capture_compile_v1',
        },
        [reference]
      )
      const input = {
        workspaceId: f.input.workspaceId,
        requestId: f.id,
        procedureId: null,
        expectedRevision: 0,
        commandId: f.command.commandId,
        name: 'Fixture de procédure',
        description: 'Fictive, à tester',
      }
      return { ...f, reference, bytes, input }
    }
    it('personal procedure versions preserve idempotence, CAS and immutable source history', async () => {
      const f = await procedureFixture()
      const [a, b] = await Promise.all([
        f.service.saveProcedure(f.principal, f.input),
        f.service.saveProcedure(f.principal, f.input),
      ])
      expect(a).toEqual(b)
      expect(a).toMatchObject({
        revision: 1,
        status: 'to_test',
        name: f.input.name,
        description: f.input.description,
      })
      const { randomUUID } = await import('node:crypto')
      const update = {
        ...f.input,
        procedureId: a.procedureId,
        expectedRevision: 1,
        requestId: randomUUID(),
        description: 'Nouvelle description',
      }
      const next = await f.service.saveProcedure(f.principal, update)
      expect(next.revision).toBe(2)
      expect(await f.service.saveProcedure(f.principal, f.input)).toEqual(a)
      await expect(
        f.service.saveProcedure(f.principal, { ...update, name: 'Changed' })
      ).rejects.toThrow()
      const race = await Promise.allSettled(
        [1, 2].map((n) =>
          f.service.saveProcedure(f.principal, {
            ...update,
            expectedRevision: 2,
            requestId: randomUUID(),
            name: 'Concurrent ' + n,
          })
        )
      )
      expect(race.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect(race.find((r) => r.status === 'rejected')).toMatchObject({
        reason: { code: 'conflict', message: 'procedure_revision_conflict' },
      })
      const history = await f.service.listProcedures(f.principal, {
        workspaceId: f.input.workspaceId,
        procedureId: a.procedureId,
      })
      expect(history.versions.map((v) => v.revision)).toEqual([3, 2, 1])
      expect(history.versions[2]).toMatchObject({
        name: f.input.name,
        description: f.input.description,
        commandId: f.command.commandId,
      })
      expect(JSON.stringify(history)).not.toContain(f.reference.artifactId)
      expect(JSON.stringify(history)).not.toContain(f.bytes.toString())
      expect(JSON.stringify(history)).not.toContain(f.peer.windowsSid)
      expect(
        await client`SELECT artifact_id FROM memlia_desktop_agent_artifact WHERE command_id=${f.command.commandId} AND origin='agent'`
      ).toHaveLength(1)
    })
    it('personal test binds a stored version and scopes immutable artifacts to an idempotent command', async () => {
      const f = await procedureFixture()
      const saved = await f.service.saveProcedure(f.principal, f.input)
      const { randomUUID } = await import('node:crypto')
      const input = {
        workspaceId: f.input.workspaceId,
        procedureId: saved.procedureId,
        revision: saved.revision,
        agentId: f.peer.agentId,
        requestId: randomUUID(),
        maxDurationSeconds: 120,
      }
      const [one, two] = await Promise.all([
        f.service.createPersonalTest(f.principal, input),
        f.service.createPersonalTest(f.principal, input),
      ])
      expect(one).toEqual(two)
      await expect(
        f.service.createPersonalTest(f.principal, { ...input, maxDurationSeconds: 121 })
      ).rejects.toThrow()
      const claimed = await f.call({
        op: 'claim',
        session: { windowsSid: f.peer.windowsSid, sessionId: f.command.sessionId },
      })
      expect(claimed.op).toBe('claim')
      const cmd = (claimed as any).command
      expect(cmd.action).toMatchObject({ kind: 'procedure.run', mode: 'test' })
      expect(cmd.commandId).toBe(one.commandId)
      expect(cmd.bundle).not.toEqual(f.reference)
      const read = await f.call({
        op: 'artifact.read',
        command: f.key(cmd),
        capabilityId: null,
        reference: cmd.bundle,
        offset: 0,
        limit: 1024,
      })
      expect(read.op).toBe('artifact.read')
      expect(Buffer.from((read as any).dataBase64, 'base64')).toEqual(f.bytes)
      await expect(
        f.call({
          op: 'artifact.read',
          command: f.key(cmd),
          capabilityId: null,
          reference: f.reference,
          offset: 0,
          limit: 1024,
        })
      ).rejects.toThrow()
      const cap = await f.call({
        op: 'consent',
        command: f.key(cmd),
        observation: {
          sessionId: cmd.sessionId,
          windowsSid: f.peer.windowsSid,
          consentId: 'test-' + randomUUID(),
          commandDigest: cmd.digest,
          confirmedLocallyAt: new Date().toISOString(),
        },
      })
      expect((cap as any).capability.capabilities).toEqual(['desktop.replay'])
      expect(await f.service.createPersonalTest(f.principal, input)).toEqual(
        expect.objectContaining({ commandId: one.commandId })
      )
    })
    it('personal test refuses foreign, changed, incomplete and revoked source before creating an intent', async () => {
      const f = await procedureFixture()
      const saved = await f.service.saveProcedure(f.principal, f.input)
      const g = await procedureFixture()
      const { randomUUID } = await import('node:crypto')
      const input = {
        workspaceId: f.input.workspaceId,
        procedureId: saved.procedureId,
        revision: 1,
        agentId: f.peer.agentId,
        requestId: randomUUID(),
        maxDurationSeconds: 120,
      }
      await expect(g.service.createPersonalTest(g.principal, input)).rejects.toThrow()
      await expect(
        f.service.createPersonalTest(f.principal, { ...input, revision: 2 })
      ).rejects.toThrow()
      await client`UPDATE memlia_desktop_agent_artifact_chunk SET data_base64=${Buffer.alloc(f.bytes.length, 120).toString('base64')} WHERE command_id=${f.command.commandId} AND artifact_id=${f.reference.artifactId}`
      await expect(f.service.createPersonalTest(f.principal, input)).rejects.toThrow()
      await client`UPDATE memlia_desktop_agent_artifact_chunk SET data_base64=${f.bytes.toString('base64')} WHERE command_id=${f.command.commandId} AND artifact_id=${f.reference.artifactId}`
      await client`UPDATE memlia_desktop_agent_certificate SET revoked_at=clock_timestamp() WHERE id=${f.peer.certificateId}`
      await expect(f.service.createPersonalTest(f.principal, input)).rejects.toThrow()
      expect(
        await client`SELECT id FROM memlia_desktop_agent_command WHERE request_id=${input.requestId}`
      ).toHaveLength(0)
    })
    it('personal test revocation between creation and claim or checkpoint prevents source reuse', async () => {
      for (const checkpoint of [false, true]) {
        const f = await procedureFixture()
        const saved = await f.service.saveProcedure(f.principal, f.input)
        const g = await procedureFixture(f)
        const { randomUUID } = await import('node:crypto')
        const created = await g.service.createPersonalTest(g.principal, {
          workspaceId: f.input.workspaceId,
          procedureId: saved.procedureId,
          revision: 1,
          agentId: g.peer.agentId,
          requestId: randomUUID(),
          maxDurationSeconds: 120,
        })
        const claim = () =>
          g.call({
            op: 'claim',
            session: { windowsSid: g.peer.windowsSid, sessionId: g.command.sessionId },
          })
        const cmd = checkpoint ? ((await claim()) as any).command : null
        await client`UPDATE memlia_desktop_agent_certificate SET revoked_at=clock_timestamp() WHERE id=${f.peer.certificateId}`
        if (checkpoint)
          expect(
            await g.call({ op: 'checkpoint', command: g.key(cmd), capabilityId: null })
          ).toMatchObject({ op: 'refused' })
        else await expect(claim()).rejects.toThrow('agent_command_refused')
        const [state] =
          await client`SELECT status FROM memlia_desktop_agent_command WHERE id=${created.commandId}`
        expect(state.status).toBe(checkpoint ? 'hold' : 'queued')
        expect(
          (await g.service.listProcedures(g.principal, { workspaceId: g.input.workspaceId }))
            .procedures.length
        ).toBeGreaterThan(0)
      }
    })
    it('personal test receipt keeps unverified evidence in HOLD without promoting capture or redispatching', async () => {
      const f = await procedureFixture()
      const saved = await f.service.saveProcedure(f.principal, f.input)
      const { randomUUID, createHash } = await import('node:crypto')
      const input = {
        workspaceId: f.input.workspaceId,
        procedureId: saved.procedureId,
        revision: 1,
        agentId: f.peer.agentId,
        requestId: randomUUID(),
        maxDurationSeconds: 120,
      }
      const created = await f.service.createPersonalTest(f.principal, input)
      const cmd = (
        (await f.call({
          op: 'claim',
          session: { windowsSid: f.peer.windowsSid, sessionId: f.command.sessionId },
        })) as any
      ).command
      const publish = (
        sequence: number,
        outcome: any,
        artifacts: any[] = [],
        capabilityId: string | null = null
      ) =>
        f.call({
          op: 'publish',
          command: f.key(cmd),
          capabilityId,
          receipt: {
            schemaVersion: 'memlia.run-receipt/v1',
            organizationId: cmd.organizationId,
            workspaceId: cmd.workspaceId,
            commandId: cmd.commandId,
            runId: cmd.runId,
            sequence,
            recordedAt: new Date().toISOString(),
            outcome,
          },
          artifacts,
        })
      await publish(0, { status: 'awaiting_local_consent', effect: 'none', evidence: [] })
      await f.call({
        op: 'consent',
        command: f.key(cmd),
        observation: {
          windowsSid: cmd.windowsSid,
          sessionId: cmd.sessionId,
          consentId: randomUUID(),
          confirmedLocallyAt: new Date().toISOString(),
          commandDigest: cmd.digest,
        },
      })
      await publish(1, { status: 'running', effect: 'none', evidence: [] }, [], cmd.capabilityId)
      const raw = Buffer.from(
        '{"execution_profile":"demo","transaction_outcome":"COMPLETED_UNVERIFIED","production_eligible":false}'
      )
      const ref = {
        artifactId: randomUUID(),
        sha256: 'sha256:' + createHash('sha256').update(raw).digest('hex'),
      }
      await f.call({
        op: 'artifact.put',
        command: f.key(cmd),
        capabilityId: cmd.capabilityId,
        reference: ref,
        offset: 0,
        totalBytes: raw.length,
        dataBase64: raw.toString('base64'),
      })
      await expect(
        publish(
          2,
          {
            status: 'succeeded_verified',
            effect: 'known',
            evidence: [ref],
            verifierId: 'memlia_capture_compile_v1',
          },
          [ref],
          cmd.capabilityId
        )
      ).rejects.toThrow()
      const outcome = {
        status: 'uncertain',
        effect: 'unknown',
        reconciliationRequired: true,
        evidence: [ref],
      }
      expect(await publish(2, outcome, [ref], cmd.capabilityId)).toMatchObject({
        op: 'publish',
        accepted: true,
      })
      expect(await f.service.createPersonalTest(f.principal, input)).toMatchObject({
        commandId: created.commandId,
        status: 'hold',
        exportStatus: 'none',
      })
      expect(
        await f.call({
          op: 'claim',
          session: { windowsSid: f.peer.windowsSid, sessionId: cmd.sessionId },
        })
      ).toMatchObject({ op: 'claim', command: null })
    })
    it('personal procedure inventory survives revoked source certificates without admitting reuse', async () => {
      const f = await procedureFixture()
      const old = await f.service.saveProcedure(f.principal, f.input)
      const g = await procedureFixture(f)
      const fresh = await g.service.saveProcedure(g.principal, g.input)
      const { randomUUID } = await import('node:crypto')
      const next = await g.service.saveProcedure(g.principal, {
        ...g.input,
        requestId: randomUUID(),
        procedureId: old.procedureId,
        expectedRevision: 1,
      })
      await client`UPDATE memlia_desktop_agent_certificate SET revoked_at=clock_timestamp() WHERE id=${f.peer.certificateId}`
      const catalog = await f.service.listProcedures(f.principal, {
        workspaceId: f.input.workspaceId,
      })
      expect(catalog.procedures.map((v) => v.procedureId).sort()).toEqual(
        [old.procedureId, fresh.procedureId].sort()
      )
      const history = await f.service.listProcedures(f.principal, {
        workspaceId: f.input.workspaceId,
        procedureId: old.procedureId,
      })
      expect(history.versions).toEqual([next, old])
      expect(history.versions.every((v) => v.status === 'to_test')).toBe(true)
      expect(JSON.stringify(history)).not.toContain(f.reference.artifactId)
      expect(JSON.stringify(history)).not.toContain(f.peer.windowsSid)
      await expect(
        f.service.saveProcedure(f.principal, { ...f.input, requestId: randomUUID() })
      ).rejects.toThrow()
      expect(await g.service.saveProcedure(g.principal, g.input)).toEqual(fresh)
    })
    it('personal procedure rolls back when certificate expires during private export verification', async () => {
      const f = await procedureFixture()
      const store = createAgentArtifactStore()
      const repo = createAgentCommandRepository({
        artifacts: {
          ...store,
          assertComplete: async (tx, ...args) => {
            const result = await store.assertComplete(tx, ...args)
            await tx.execute(sql`SELECT pg_sleep(0.3)`)
            return result
          },
        },
      })
      await client`UPDATE memlia_desktop_agent_certificate SET not_after=clock_timestamp()+interval '0.2 seconds' WHERE id=${f.peer.certificateId}`
      await expect(repo.saveProcedure(f.principal, f.input)).rejects.toThrow(
        'agent_command_refused'
      )
      expect(
        await client`SELECT id FROM memlia_desktop_procedure WHERE owner_user_id=${f.peer.ownerUserId}`
      ).toHaveLength(0)
      expect(
        await client`SELECT id FROM memlia_desktop_procedure_version WHERE owner_user_id=${f.peer.ownerUserId}`
      ).toHaveLength(0)
    })
    it('personal procedure refuses incomplete exports and changed bytes without creating a record', async () => {
      const f = await privateArtifactFixture()
      const input = {
        workspaceId: f.input.workspaceId,
        requestId: f.id,
        procedureId: null,
        expectedRevision: 0,
        commandId: f.command.commandId,
        name: 'Incomplete',
        description: '',
      }
      await expect(f.service.saveProcedure(f.principal, input)).rejects.toThrow()
      const g = await procedureFixture()
      await client`UPDATE memlia_desktop_agent_artifact_chunk SET data_base64=${Buffer.alloc(g.bytes.length, 120).toString('base64')} WHERE command_id=${g.command.commandId} AND artifact_id=${g.reference.artifactId}`
      await expect(g.service.saveProcedure(g.principal, g.input)).rejects.toThrow()
      expect(
        await client`SELECT id FROM memlia_desktop_procedure WHERE owner_user_id IN (${f.peer.ownerUserId},${g.peer.ownerUserId})`
      ).toHaveLength(0)
    })
    it('personal procedure rechecks ownership and workspace permission while revoked association blocks saving', async () => {
      const f = await procedureFixture()
      const g = await procedureFixture()
      const saved = await f.service.saveProcedure(f.principal, f.input)
      await expect(
        g.service.saveProcedure(g.principal, { ...g.input, commandId: f.command.commandId })
      ).rejects.toThrow()
      await expect(
        g.service.listProcedures(g.principal, {
          workspaceId: f.input.workspaceId,
          procedureId: saved.procedureId,
        })
      ).rejects.toThrow()
      await client`UPDATE permissions SET permission_type='read' WHERE user_id=${f.principal.userId}`
      await expect(
        f.service.listProcedures(f.principal, { workspaceId: f.input.workspaceId })
      ).rejects.toThrow()
      await client`UPDATE permissions SET permission_type='write' WHERE user_id=${f.principal.userId}`
      await client`UPDATE memlia_desktop_agent_certificate SET revoked_at=clock_timestamp() WHERE id=${f.peer.certificateId}`
      await expect(f.service.saveProcedure(f.principal, f.input)).rejects.toThrow()
      expect(
        (
          await f.service.listProcedures(f.principal, {
            workspaceId: f.input.workspaceId,
            procedureId: saved.procedureId,
          })
        ).versions
      ).toEqual([saved])
    })
    it('presence catalog exposes only stored complete successful exports as to_test', async () => {
      const f = await privateArtifactFixture()
      await f.consent()
      const bytes = Buffer.from('opaque fictitious compiled export')
      const reference = await f.ref(bytes)
      await f.put(reference, bytes)
      expect(
        (await f.repo.listOwned(f.principal, { workspaceId: f.input.workspaceId })).commands[0]
          .exportStatus
      ).toBe('none')
      await f.publish(
        0,
        {
          status: 'succeeded_verified',
          effect: 'known',
          evidence: [reference],
          verifierId: 'memlia_capture_compile_v1',
        },
        [reference]
      )
      const result = await f.repo.listOwned(f.principal, { workspaceId: f.input.workspaceId })
      expect(result.commands[0].exportStatus).toBe('to_test')
      expect(JSON.stringify(result)).not.toContain(bytes.toString())
      expect(JSON.stringify(result)).not.toContain(reference.artifactId)
      expect(
        (
          await f.service.createIntent(
            f.principal,
            (() => {
              const { sessionId: _s, ...v } = f.input
              return v
            })()
          )
        ).commandId
      ).toBe(f.command.commandId)
    })
    it('private artifact composition persists admitted inputs before the deferred command FK and reads bounded exact bytes', async () => {
      const f = await privateArtifactFixture()
      expect(f.intent.commandId).toBe(f.command.commandId)
      expect(
        await client`SELECT artifact_id FROM memlia_desktop_agent_artifact WHERE command_id=${f.command.commandId}`
      ).toHaveLength(2)
      const read = (offset = 0, limit = 262144) =>
        f.call({
          op: 'artifact.read',
          command: f.key(f.command),
          capabilityId: null,
          reference: f.command.bundle,
          offset,
          limit,
        })
      const response = await read()
      expect(response.op).toBe('artifact.read')
      if (response.op !== 'artifact.read') throw new Error('fixture_read')
      const bytes = Buffer.from(response.dataBase64, 'base64')
      expect(await f.ref(bytes)).toMatchObject({ sha256: f.command.bundle.sha256 })
      expect(JSON.parse(bytes.toString())).toMatchObject({
        schemaVersion: 'memlia.capture-input/v1',
        commandId: f.command.commandId,
        maxBytes: f.input.maxBytes,
        audio: false,
        localConsentRequired: true,
      })
      const partial = await read(3, 7)
      expect(partial).toMatchObject({
        op: 'artifact.read',
        offset: 3,
        done: false,
        dataBase64: bytes.subarray(3, 10).toString('base64'),
      })
      await expect(read(bytes.length + 1)).rejects.toThrow('agent_artifact_refused')
      await expect(f.put(f.command.bundle, Buffer.from('tamper'))).rejects.toThrow(
        'agent_command_refused'
      )
    })
    it('private artifact composition completes capture receipts with real SQL chunks hashes and no activation', async () => {
      const f = await privateArtifactFixture()
      expect(
        await f.publish(
          0,
          { status: 'awaiting_local_consent', effect: 'none', evidence: [] },
          [],
          null
        )
      ).toMatchObject({ op: 'publish', accepted: true })
      expect(await f.consent()).toMatchObject({
        op: 'consent',
        capability: { capabilities: ['desktop.capture'] },
      })
      await f.publish(1, { status: 'running', effect: 'none', evidence: [] })
      const bytes = Buffer.alloc(262144 + 9, 97)
      const ref = await f.ref(bytes)
      expect(await f.put(ref, bytes.subarray(0, 262144), bytes.length)).toMatchObject({
        op: 'artifact.put',
        nextOffset: 262144,
        complete: false,
      })
      expect(await f.put(ref, bytes.subarray(262144), bytes.length, 262144)).toMatchObject({
        op: 'artifact.put',
        nextOffset: bytes.length,
        complete: true,
      })
      await expect(
        f.publish(
          2,
          {
            status: 'succeeded_verified',
            effect: 'known',
            evidence: [ref],
            verifierId: 'forged-business-verifier',
          },
          [ref]
        )
      ).rejects.toThrow('agent_artifact_refused')
      expect(
        await f.publish(
          2,
          {
            status: 'succeeded_verified',
            effect: 'known',
            evidence: [ref],
            verifierId: 'memlia_capture_compile_v1',
          },
          [ref]
        )
      ).toMatchObject({ op: 'publish', accepted: true })
      const [row] =
        await client`SELECT status,last_sequence FROM memlia_desktop_agent_command WHERE id=${f.command.commandId}`
      expect(row.status).toBe('terminal')
      expect(Number(row.last_sequence)).toBe(2)
      expect(
        await client`SELECT id FROM memlia_desktop_agent_receipt WHERE command_id=${f.command.commandId}`
      ).toHaveLength(3)
      // Bytes remain opaque and unexecuted; this receipt is not replay qualification.
    })
    it('private artifact composition rejects changed chunks gaps and a wrong final hash atomically', async () => {
      const f = await privateArtifactFixture()
      await f.consent()
      const bytes = Buffer.alloc(262144 + 3, 98)
      const ref = await f.ref(bytes)
      await f.put(ref, bytes.subarray(0, 262144), bytes.length)
      expect(await f.put(ref, bytes.subarray(0, 262144), bytes.length)).toMatchObject({
        op: 'artifact.put',
        nextOffset: 262144,
        complete: false,
      })
      await expect(f.put(ref, Buffer.alloc(262144, 99), bytes.length)).rejects.toThrow(
        'agent_artifact_refused'
      )
      await expect(f.put(ref, Buffer.from('wrong'), bytes.length, 1)).rejects.toThrow(
        'agent_artifact_refused'
      )
      await expect(f.put(ref, Buffer.alloc(3, 99), bytes.length, 262144)).rejects.toThrow(
        'agent_artifact_refused'
      )
      const [stored] =
        await client`SELECT complete,next_offset FROM memlia_desktop_agent_artifact WHERE command_id=${f.command.commandId} AND artifact_id=${ref.artifactId}`
      expect(stored).toMatchObject({ complete: false, next_offset: 262144 })
      expect(
        await client`SELECT "offset" FROM memlia_desktop_agent_artifact_chunk WHERE command_id=${f.command.commandId} AND artifact_id=${ref.artifactId}`
      ).toHaveLength(1)
      await expect(
        f.publish(
          0,
          {
            status: 'succeeded_verified',
            effect: 'known',
            evidence: [ref],
            verifierId: 'memlia_capture_compile_v1',
          },
          [ref]
        )
      ).rejects.toThrow('agent_artifact_refused')
      expect(
        await client`SELECT id FROM memlia_desktop_agent_receipt WHERE command_id=${f.command.commandId}`
      ).toHaveLength(0)
    })
    it('private artifact composition enforces count and byte budgets before private writes', async () => {
      const f = await privateArtifactFixture()
      await f.consent()
      await client`INSERT INTO memlia_desktop_agent_artifact(command_id,artifact_id,sha256,origin,total_bytes)
        SELECT ${f.command.commandId},'fixture-'||n,'sha256:'||repeat('a',64),'agent',1 FROM generate_series(1,128) n`
      await expect(f.put(await f.ref(Buffer.from('x')), Buffer.from('x'))).rejects.toThrow(
        'agent_artifact_refused'
      )
      const g = await privateArtifactFixture()
      await g.consent()
      await client`INSERT INTO memlia_desktop_agent_artifact(command_id,artifact_id,sha256,origin,total_bytes)
        VALUES(${g.command.commandId},'fixture-large','sha256:'||repeat('b',64),'agent',34603008)`
      await expect(g.put(await g.ref(Buffer.from('x')), Buffer.from('x'))).rejects.toThrow(
        'agent_artifact_refused'
      )
      expect(
        await client`SELECT artifact_id FROM memlia_desktop_agent_artifact WHERE command_id=${g.command.commandId} AND origin='agent'`
      ).toHaveLength(1)
    })
    it('private artifact composition admits a generic empty artifact but refuses an empty capture success', async () => {
      const f = await privateArtifactFixture()
      await f.consent()
      const bytes = Buffer.alloc(0)
      const ref = await f.ref(bytes)
      expect(await f.put(ref, bytes)).toMatchObject({
        op: 'artifact.put',
        nextOffset: 0,
        complete: true,
      })
      await expect(
        f.publish(
          0,
          {
            status: 'succeeded_verified',
            effect: 'known',
            evidence: [ref],
            verifierId: 'memlia_capture_compile_v1',
          },
          [ref]
        )
      ).rejects.toThrow('agent_artifact_refused')
      expect(
        await client`SELECT id FROM memlia_desktop_agent_receipt WHERE command_id=${f.command.commandId}`
      ).toHaveLength(0)
    })
    it('private artifact composition cannot commit orphaned server manifests', async () => {
      const f = await privateArtifactFixture()
      const commandId = 'missing-command-' + f.id
      await expect(
        runtime.db.transaction((tx: any) =>
          createAgentArtifactStore().captureInputs(tx, {
            ...f.peer,
            commandId,
            runId: 'orphan-run',
            sessionId: f.input.sessionId,
            capabilityId: 'orphan-capability',
            commandDigest: null,
            leaseEpoch: null,
            maxDurationSeconds: 10,
            maxBytes: 1024,
          })
        )
      ).rejects.toThrow()
      expect(
        await client`SELECT artifact_id FROM memlia_desktop_agent_artifact WHERE command_id=${commandId}`
      ).toHaveLength(0)
    })
    it('private artifact composition refuses foreign command references and interrupted admission without dispatch', async () => {
      const f = await privateArtifactFixture()
      const g = await privateArtifactFixture()
      await expect(
        f.call({
          op: 'artifact.read',
          command: f.key(f.command),
          capabilityId: null,
          reference: g.command.bundle,
          offset: 0,
          limit: 1,
        })
      ).rejects.toThrow('agent_command_refused')
      f.controller.abort()
      await expect(
        f.call({ op: 'checkpoint', command: f.key(f.command), capabilityId: null })
      ).rejects.toThrow()
      const [row] =
        await client`SELECT status,last_sequence FROM memlia_desktop_agent_command WHERE id=${f.command.commandId}`
      expect(row.status).toBe('claimed')
      expect(Number(row.last_sequence)).toBe(-1)
      expect(
        await client`SELECT id FROM memlia_desktop_agent_receipt WHERE command_id=${f.command.commandId}`
      ).toHaveLength(0)
    })
    it('rolls back an artifact mutation when the authorizing certificate expires during the operation', async () => {
      const f = await fixture()
      await f.create()
      const command = (await f.claim())!
      await f.consent(command)
      await client`UPDATE memlia_desktop_agent_certificate SET not_after=clock_timestamp()+interval '200 milliseconds' WHERE id=${f.peer.certificateId}`
      await expect(
        f.repo.withAuthorizedArtifact(
          f.peer,
          f.key(command),
          command.capabilityId,
          'put',
          command.bundle,
          async (tx) => {
            await tx.execute(sql`INSERT INTO artifact_effect(id) VALUES(${f.id})`)
            await tx.execute(sql`SELECT pg_sleep(0.3)`)
            return 'must_not_commit'
          }
        )
      ).rejects.toThrow('agent_command_refused')
      expect(await client`SELECT id FROM artifact_effect WHERE id=${f.id}`).toHaveLength(0)
    })
  }
)
