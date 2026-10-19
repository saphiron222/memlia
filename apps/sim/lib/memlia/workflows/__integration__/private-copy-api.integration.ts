// Copyright 2026 Memlia. All rights reserved.
import { randomBytes } from 'node:crypto'
import { db } from '@sim/db'
import {
  apiKey,
  auditLog,
  memliaWorkflowCopy,
  permissions,
  rateLimitBucket,
  user,
  workflow,
  workflowDeploymentVersion,
  workflowExecutionLogs,
  workflowSchedule,
  workspace,
} from '@sim/db/schema'
import { deleteWorkspaceFixture, insertWorkspaceFixture } from '@sim/db/testing/workspace-fixtures'
import { normalizeIpAddress } from '@sim/security/ip'
import { generateId } from '@sim/utils/id'
import { loadWorkflowFromNormalizedTablesRaw } from '@sim/workflow-persistence/load'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { NextRequest } from 'next/server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { encryptApiKey, generateApiKey, hashApiKey } from '@/lib/api-key/crypto'
import { insertNewWorkflowRow } from '@/lib/workflows/persistence/new-workflow-row'
import { admitWorkflowState, saveAdmittedWorkflowState } from '@/lib/workflows/persistence/utils'
import { POST } from '@/app/api/v2/workflows/[workflowId]/private-copy/route'
import type { WorkflowState } from '@/stores/workflows/workflow/types'

// Real handler, authentication, authorization, PostgreSQL limiter and copy transaction.
// No Next server/network is exercised. Only the native realtime harness is a local stand-in.
const author = generateId()
const recipient = generateId()
const shared = generateId()
const personal = generateId()
const foreignPersonal = generateId()
const sourceId = generateId()
const readGrant = generateId()
const personalKeyId = generateId()
const workspaceKeyId = generateId()
const personalKey = generateApiKey()
const workspaceKey = generateApiKey()
const privateMarker = `author-private-${generateId()}`
// The fixed leading-zero group makes canonicalization deterministic, with an isolated suffix.
const forwardedIp = `2001:db8:0abc:${randomBytes(10).toString('hex').match(/.{4}/g)!.join(':')}`
const canonicalIp = normalizeIpAddress(forwardedIp)
if (!canonicalIp || canonicalIp === forwardedIp)
  throw new Error('Expected noncanonical IPv6 fixture')
const preauthBucketKey = `v2:preauth:ip:${canonicalIp}`
const fixtureWorkspaces = [shared, personal, foreignPersonal]
const bucketKeys = [
  preauthBucketKey,
  `v2:workflows.create:api-key:${personalKeyId}`,
  `v2:workflows.create:user:${recipient}`,
  `v2:workflows.create:api-key:${workspaceKeyId}`,
  `v2:workflows.create:workspace:${personal}`,
]
const source: WorkflowState = {
  blocks: {
    authorBlock: {
      id: 'authorBlock',
      type: 'gmail',
      name: privateMarker,
      position: { x: 0, y: 0 },
      enabled: true,
      outputs: {},
      subBlocks: {
        credential: { id: 'credential', type: 'oauth-input', value: privateMarker },
        body: { id: 'body', type: 'long-input', value: `${privateMarker} /api/files/view/private` },
      },
    },
  },
  edges: [],
  loops: {},
  parallels: {},
  variables: {
    privateVariable: {
      id: 'privateVariable',
      name: 'Private',
      type: 'string',
      value: privateMarker,
    },
  },
}

async function copy(destinationWorkspaceId = personal, credential: string | null = personalKey) {
  const headers = new Headers({
    'content-type': 'application/json',
    'x-forwarded-for': forwardedIp,
  })
  if (credential) headers.set('x-api-key', credential)
  return POST(
    new NextRequest(`http://localhost/api/v2/workflows/${sourceId}/private-copy`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ destinationWorkspaceId, name: 'HTTP private copy fixture' }),
    }),
    { params: Promise.resolve({ workflowId: sourceId }) }
  )
}

// Compare business rows only: a refused request legitimately consumes rate-limit tokens.
async function businessRows() {
  return {
    workflows: await db
      .select()
      .from(workflow)
      .where(inArray(workflow.workspaceId, fixtureWorkspaces))
      .orderBy(workflow.id),
    provenance: await db
      .select()
      .from(memliaWorkflowCopy)
      .where(eq(memliaWorkflowCopy.sourceWorkflowId, sourceId))
      .orderBy(memliaWorkflowCopy.workflowId),
    audit: await db
      .select()
      .from(auditLog)
      .where(inArray(auditLog.workspaceId, fixtureWorkspaces))
      .orderBy(auditLog.id),
    source: await loadWorkflowFromNormalizedTablesRaw(sourceId),
  }
}

async function refusedWithoutWrites(
  destination: string,
  credential: string | null,
  status: number,
  code: string
) {
  const before = await businessRows()
  const response = await copy(destination, credential)
  expect(response.status).toBe(status)
  expect(await response.json()).toMatchObject({ error: { code } })
  expect(await businessRows()).toEqual(before)
}

describe('private-copy POST through native authentication and real PostgreSQL', () => {
  beforeAll(async () => {
    const role = await db.execute(sql`select rolsuper from pg_roles where rolname = current_user`)
    expect(role[0]?.rolsuper).toBe(false)
    const now = new Date()
    await db.insert(user).values(
      [author, recipient].map((id) => ({
        id,
        name: 'HTTP copy fixture',
        email: `${id}@workflow.test`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      }))
    )
    await insertWorkspaceFixture(db, [
      {
        id: shared,
        name: 'Shared HTTP fixture',
        ownerId: author,
        billedAccountUserId: author,
        workspaceMode: 'grandfathered_shared',
        allowPersonalApiKeys: true,
      },
      {
        id: personal,
        name: 'Personal HTTP fixture',
        ownerId: recipient,
        billedAccountUserId: recipient,
        workspaceMode: 'personal',
        allowPersonalApiKeys: true,
      },
      {
        id: foreignPersonal,
        name: 'Foreign HTTP fixture',
        ownerId: author,
        billedAccountUserId: author,
        workspaceMode: 'personal',
        allowPersonalApiKeys: true,
      },
    ])
    await db.insert(permissions).values([
      {
        id: generateId(),
        userId: author,
        entityType: 'workspace',
        entityId: shared,
        permissionType: 'admin',
      },
      {
        id: readGrant,
        userId: recipient,
        entityType: 'workspace',
        entityId: shared,
        permissionType: 'read',
      },
      {
        id: generateId(),
        userId: recipient,
        entityType: 'workspace',
        entityId: personal,
        permissionType: 'admin',
      },
      {
        id: generateId(),
        userId: author,
        entityType: 'workspace',
        entityId: foreignPersonal,
        permissionType: 'admin',
      },
    ])
    const admitted = await admitWorkflowState(source, {
      workspaceId: shared,
      subjectUserId: author,
    })
    await db.transaction(async (tx) => {
      await insertNewWorkflowRow(tx, {
        id: sourceId,
        userId: author,
        workspaceId: shared,
        name: 'Shared HTTP source',
        description: privateMarker,
        folderId: null,
        variables: source.variables,
      })
      if (!(await saveAdmittedWorkflowState(tx, sourceId, admitted)).success)
        throw new Error('Unable to seed isolated workflow')
    })
    for (const fixture of [
      { id: personalKeyId, value: personalKey, type: 'personal', workspaceId: null },
      { id: workspaceKeyId, value: workspaceKey, type: 'workspace', workspaceId: personal },
    ]) {
      const encrypted = await encryptApiKey(fixture.value)
      await db.insert(apiKey).values({
        id: fixture.id,
        userId: recipient,
        workspaceId: fixture.workspaceId,
        name: 'Ephemeral HTTP copy fixture',
        key: encrypted.encrypted,
        keyHash: hashApiKey(fixture.value),
        type: fixture.type,
      })
    }
  })

  afterAll(async () => {
    try {
      await db.delete(apiKey).where(inArray(apiKey.id, [personalKeyId, workspaceKeyId]))
      await db.delete(auditLog).where(inArray(auditLog.workspaceId, fixtureWorkspaces))
      await deleteWorkspaceFixture(db, inArray(workspace.id, fixtureWorkspaces))
      await db.delete(user).where(inArray(user.id, [author, recipient]))
      await db.delete(rateLimitBucket).where(inArray(rateLimitBucket.key, bucketKeys))
      expect(
        await db
          .select({ id: workflow.id })
          .from(workflow)
          .where(inArray(workflow.workspaceId, fixtureWorkspaces))
      ).toEqual([])
      expect(
        await db
          .select()
          .from(memliaWorkflowCopy)
          .where(eq(memliaWorkflowCopy.sourceWorkflowId, sourceId))
      ).toEqual([])
      expect(
        await db
          .select({ id: apiKey.id })
          .from(apiKey)
          .where(inArray(apiKey.id, [personalKeyId, workspaceKeyId]))
      ).toEqual([])
      expect(
        await db.select().from(rateLimitBucket).where(inArray(rateLimitBucket.key, bucketKeys))
      ).toEqual([])
      expect(
        await db
          .select({ id: workspace.id })
          .from(workspace)
          .where(inArray(workspace.id, fixtureWorkspaces))
      ).toEqual([])
      expect(
        await db
          .select({ id: user.id })
          .from(user)
          .where(inArray(user.id, [author, recipient]))
      ).toEqual([])
      expect(
        await db
          .select({ id: auditLog.id })
          .from(auditLog)
          .where(inArray(auditLog.workspaceId, fixtureWorkspaces))
      ).toEqual([])
      expect(
        await db
          .select({ id: permissions.id })
          .from(permissions)
          .where(inArray(permissions.entityId, fixtureWorkspaces))
      ).toEqual([])
    } finally {
      await db.$client.end()
    }
  })

  it('returns 201 with a new sanitized private graph and durable provenance, leaving the source untouched', async () => {
    const before = await businessRows()
    const response = await copy()
    expect(response.status).toBe(201)
    const payload = await response.json()
    expect(payload).toEqual({
      data: {
        id: expect.any(String),
        workspaceId: personal,
        name: 'HTTP private copy fixture',
        configurationRequired: true,
      },
    })
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    const id = payload.data.id as string
    expect(id).not.toBe(sourceId)
    const [record] = await db.select().from(workflow).where(eq(workflow.id, id))
    expect(record).toMatchObject({
      userId: recipient,
      workspaceId: personal,
      variables: {},
      description: null,
      isDeployed: false,
      isPublicApi: false,
      runCount: 0,
      lastRunAt: null,
    })
    const graph = await loadWorkflowFromNormalizedTablesRaw(id)
    expect(graph).not.toBeNull()
    expect(Object.keys(graph!.blocks)).not.toContain('authorBlock')
    expect(Object.values(graph!.blocks)[0].subBlocks.credential.value).toBeNull()
    expect(JSON.stringify({ record, graph, payload })).not.toContain(privateMarker)
    expect(JSON.stringify(graph)).not.toContain('/api/files/view/private')
    const [provenance] = await db
      .select()
      .from(memliaWorkflowCopy)
      .where(eq(memliaWorkflowCopy.workflowId, id))
    expect(provenance).toMatchObject({
      workflowId: id,
      sourceWorkflowId: sourceId,
      createdByUserId: recipient,
      sourceStateDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      createdAt: expect.any(Date),
    })
    expect(await loadWorkflowFromNormalizedTablesRaw(sourceId)).toEqual(before.source)
    expect(await db.select().from(workflow).where(eq(workflow.id, sourceId))).toEqual(
      before.workflows.filter((row) => row.id === sourceId)
    )
    expect(
      await db.select().from(workflowSchedule).where(eq(workflowSchedule.workflowId, id))
    ).toEqual([])
    expect(
      await db.select().from(workflowExecutionLogs).where(eq(workflowExecutionLogs.workflowId, id))
    ).toEqual([])
    expect(
      await db
        .select()
        .from(workflowDeploymentVersion)
        .where(eq(workflowDeploymentVersion.workflowId, id))
    ).toEqual([])
    await expect
      .poll(async () =>
        db
          .select()
          .from(auditLog)
          .where(and(eq(auditLog.workspaceId, personal), eq(auditLog.resourceId, id)))
      )
      .toMatchObject([
        {
          actorId: recipient,
          metadata: { sourceWorkflowId: sourceId, sourceRevision: provenance.sourceStateDigest },
        },
      ])
    // Assert the real PostgreSQL limiter and native key touch ran, rather than bypassing auth.
    expect(
      await db.select().from(rateLimitBucket).where(inArray(rateLimitBucket.key, bucketKeys))
    ).toHaveLength(3)
    expect(
      await db
        .select({ key: rateLimitBucket.key })
        .from(rateLimitBucket)
        .where(eq(rateLimitBucket.key, preauthBucketKey))
    ).toEqual([{ key: preauthBucketKey }])
    expect(
      await db
        .select({ key: rateLimitBucket.key })
        .from(rateLimitBucket)
        .where(eq(rateLimitBucket.key, `v2:preauth:ip:${forwardedIp}`))
    ).toEqual([])
    await expect
      .poll(
        async () =>
          (
            await db
              .select({ lastUsed: apiKey.lastUsed })
              .from(apiKey)
              .where(eq(apiKey.id, personalKeyId))
          )[0]?.lastUsed
      )
      .toBeInstanceOf(Date)
  })

  it('refuses missing credentials without business writes', () =>
    refusedWithoutWrites(personal, null, 401, 'UNAUTHORIZED'))
  it('refuses an unknown ephemeral key without business writes', () =>
    refusedWithoutWrites(personal, generateApiKey(), 401, 'UNAUTHORIZED'))
  it('conceals another subject personal workspace without business writes', () =>
    refusedWithoutWrites(foreignPersonal, personalKey, 404, 'NOT_FOUND'))
  it('refuses an actorless workspace key despite a real creator and payer', () =>
    refusedWithoutWrites(personal, workspaceKey, 403, 'FORBIDDEN'))

  it('refuses a source membership revoked in PostgreSQL without falling back to the author', async () => {
    await db.delete(permissions).where(eq(permissions.id, readGrant))
    try {
      await refusedWithoutWrites(personal, personalKey, 404, 'NOT_FOUND')
    } finally {
      await db.insert(permissions).values({
        id: readGrant,
        userId: recipient,
        entityType: 'workspace',
        entityId: shared,
        permissionType: 'read',
      })
    }
  })
  it('refuses a key revoked in PostgreSQL without business writes', async () => {
    await db.delete(apiKey).where(eq(apiKey.id, personalKeyId))
    await refusedWithoutWrites(personal, personalKey, 401, 'UNAUTHORIZED')
  })
})
