// Copyright 2026 Memlia. All rights reserved.
import { randomBytes } from 'node:crypto'
import { db } from '@sim/db'
import {
  apiKey,
  auditLog,
  permissions,
  rateLimitBucket,
  user,
  workflow,
  workspace,
} from '@sim/db/schema'
import { deleteWorkspaceFixture, insertWorkspaceFixture } from '@sim/db/testing/workspace-fixtures'
import { normalizeIpAddress } from '@sim/security/ip'
import { generateId } from '@sim/utils/id'
import { loadWorkflowFromNormalizedTablesRaw } from '@sim/workflow-persistence/load'
import { eq, inArray, sql } from 'drizzle-orm'
import { NextRequest } from 'next/server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { encryptApiKey, generateApiKey, hashApiKey } from '@/lib/api-key/crypto'
import { insertNewWorkflowRow } from '@/lib/workflows/persistence/new-workflow-row'
import { admitWorkflowState, saveAdmittedWorkflowState } from '@/lib/workflows/persistence/utils'
import { setWorkflowVariables } from '@/lib/workflows/utils'
import { POST } from '@/app/api/v2/workflows/[workflowId]/operations/route'
import { GET, PUT } from '@/app/api/v2/workflows/[workflowId]/state/route'

// Real HTTP handlers, API-key authentication, limiter, authorization, use cases and PostgreSQL.
// No Next network server: only the native realtime notification harness is a local stand-in.
const ownerId = generateId()
const workspaceId = generateId()
const workflowId = generateId()
const blockId = generateId()
const keyId = generateId()
const credential = generateApiKey()
const forwardedIp = `2001:db8:0abc:${randomBytes(10).toString('hex').match(/.{4}/g)!.join(':')}`
const ip = normalizeIpAddress(forwardedIp)
if (!ip) throw new Error('Invalid isolated test IP')
const bucketKeys = [
  `v2:preauth:ip:${ip}`,
  ...['workflows.read', 'workflows.state.replace', 'workflows.operations.apply'].flatMap(
    (operation) => [`v2:${operation}:api-key:${keyId}`, `v2:${operation}:user:${ownerId}`]
  ),
]
const context = { params: Promise.resolve({ workflowId }) }
function request(method: string, surface: 'state' | 'operations', body?: unknown, dryRun = false) {
  return new NextRequest(
    `http://localhost/api/v2/workflows/${workflowId}/${surface}${dryRun ? '?dryRun=true' : ''}`,
    {
      method,
      headers: {
        'content-type': 'application/json',
        'x-api-key': credential,
        'x-forwarded-for': forwardedIp,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }
  )
}
async function readGraph() {
  const response = await GET(request('GET', 'state'), context)
  expect(response.status).toBe(200)
  expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  return (await response.json()).data
}
async function businessState() {
  return {
    row: await db.select().from(workflow).where(eq(workflow.id, workflowId)),
    graph: await loadWorkflowFromNormalizedTablesRaw(workflowId),
    audit: await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.workspaceId, workspaceId))
      .orderBy(auditLog.id),
  }
}
const deleteOperation = { operation_type: 'delete', block_id: blockId }

describe('draft CAS through real HTTP handlers and PostgreSQL', () => {
  beforeAll(async () => {
    const [role] = await db.execute(
      sql`select rolsuper, rolcreatedb, rolbypassrls from pg_roles where rolname = current_user`
    )
    expect(role).toMatchObject({ rolsuper: false, rolcreatedb: false, rolbypassrls: false })
    const now = new Date()
    await db.insert(user).values({
      id: ownerId,
      name: 'HTTP revision fixture',
      email: `${ownerId}@revision.test`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })
    await insertWorkspaceFixture(db, {
      id: workspaceId,
      ownerId,
      billedAccountUserId: ownerId,
      name: 'HTTP revision fixture',
      workspaceMode: 'personal',
      allowPersonalApiKeys: true,
    })
    await db.insert(permissions).values({
      id: generateId(),
      userId: ownerId,
      entityType: 'workspace',
      entityId: workspaceId,
      permissionType: 'admin',
    })
    const admitted = await admitWorkflowState(
      {
        blocks: {
          [blockId]: {
            id: blockId,
            type: 'function',
            name: 'Original function',
            position: { x: 0, y: 0 },
            subBlocks: {},
            outputs: {},
            enabled: true,
          },
        },
        edges: [],
        loops: {},
        parallels: {},
      },
      { workspaceId, subjectUserId: ownerId }
    )
    await db.transaction(async (tx) => {
      await insertNewWorkflowRow(tx, {
        id: workflowId,
        workspaceId,
        userId: ownerId,
        name: 'HTTP revision fixture',
        folderId: null,
        description: null,
      })
      if (!(await saveAdmittedWorkflowState(tx, workflowId, admitted)).success)
        throw new Error('Unable to seed isolated graph')
    })
    const encrypted = await encryptApiKey(credential)
    await db.insert(apiKey).values({
      id: keyId,
      userId: ownerId,
      workspaceId: null,
      name: 'Ephemeral revision fixture',
      type: 'personal',
      key: encrypted.encrypted,
      keyHash: hashApiKey(credential),
    })
  })
  afterAll(async () => {
    try {
      await db.delete(apiKey).where(eq(apiKey.id, keyId))
      await db.delete(auditLog).where(eq(auditLog.workspaceId, workspaceId))
      await deleteWorkspaceFixture(db, eq(workspace.id, workspaceId))
      await db.delete(user).where(eq(user.id, ownerId))
      await db.delete(rateLimitBucket).where(inArray(rateLimitBucket.key, bucketKeys))
      expect(await db.select().from(workflow).where(eq(workflow.id, workflowId))).toEqual([])
      expect(
        await db.select().from(rateLimitBucket).where(inArray(rateLimitBucket.key, bucketKeys))
      ).toEqual([])
      expect(await db.select().from(auditLog).where(eq(auditLog.workspaceId, workspaceId))).toEqual(
        []
      )
      expect(await db.select().from(apiKey).where(eq(apiKey.id, keyId))).toEqual([])
      expect(await db.select().from(user).where(eq(user.id, ownerId))).toEqual([])
    } finally {
      await db.$client.end()
    }
  })

  it('reads the seeded graph and its common revision together', async () => {
    const graph = await readGraph()
    expect(graph.draftRevision).toBe(1)
    expect(graph.blocks[blockId].name).toBe('Original function')
  })
  it.each(['state', 'operations'] as const)(
    'rejects an unversioned %s write without changing business rows',
    async (surface) => {
      const before = await businessState()
      const response =
        surface === 'state'
          ? await PUT(request('PUT', surface, { blocks: {}, edges: [] }), context)
          : await POST(request('POST', surface, { operations: [deleteOperation] }), context)
      expect(response.status).toBe(400)
      expect(await businessState()).toEqual(before)
    }
  )
  it.each(['state', 'operations'] as const)(
    'rejects stale %s after a native variable writer, preserving graph and revision',
    async (surface) => {
      const oldGraph = await readGraph()
      // Intervening legacy writer uses the same native transaction/revision, without a transport CAS.
      await setWorkflowVariables(workflowId, {
        region: { id: 'region', name: 'region', type: 'string', value: surface },
      })
      const before = await businessState()
      const response =
        surface === 'state'
          ? await PUT(
              request('PUT', surface, {
                blocks: {},
                edges: [],
                variables: {},
                expectedRevision: oldGraph.draftRevision,
              }),
              context
            )
          : await POST(
              request('POST', surface, {
                operations: [deleteOperation],
                expectedRevision: oldGraph.draftRevision,
              }),
              context
            )
      expect(response.status).toBe(409)
      expect((await response.json()).error.code).toBe('CONFLICT')
      expect(response.headers.get('Cache-Control')).toBe('private, no-store')
      expect(await businessState()).toEqual(before)
    }
  )
  it.each(['state', 'operations'] as const)(
    'dry-runs a current %s revision without advancing or mutating business rows',
    async (surface) => {
      const { draftRevision, ...graph } = await readGraph()
      const before = await businessState()
      const response =
        surface === 'state'
          ? await PUT(
              request('PUT', surface, { ...graph, expectedRevision: draftRevision }, true),
              context
            )
          : await POST(
              request(
                'POST',
                surface,
                { operations: [deleteOperation], expectedRevision: draftRevision },
                true
              ),
              context
            )
      expect(response.status).toBe(200)
      expect((await response.json()).data).toMatchObject({
        baseRevision: draftRevision,
        draftRevision,
        dryRun: true,
      })
      expect(await businessState()).toEqual(before)
    }
  )
  it('commits a current replacement and returns the exact receipt', async () => {
    const { draftRevision, ...graph } = await readGraph()
    graph.blocks[blockId].name = 'HTTP committed name'
    const response = await PUT(
      request('PUT', 'state', { ...graph, expectedRevision: draftRevision }),
      context
    )
    expect(response.status).toBe(200)
    expect((await response.json()).data).toMatchObject({
      baseRevision: draftRevision,
      draftRevision: draftRevision + 1,
      dryRun: false,
    })
    const after = await readGraph()
    expect(after.draftRevision).toBe(draftRevision + 1)
    expect(after.blocks[blockId].name).toBe('HTTP committed name')
  })
  it('commits a current operations batch and exposes its revision to the next reader', async () => {
    const before = await readGraph()
    const response = await POST(
      request('POST', 'operations', {
        operations: [deleteOperation],
        expectedRevision: before.draftRevision,
      }),
      context
    )
    expect(response.status).toBe(200)
    expect((await response.json()).data).toMatchObject({
      baseRevision: before.draftRevision,
      draftRevision: before.draftRevision + 1,
      dryRun: false,
    })
    const after = await readGraph()
    expect(after.draftRevision).toBe(before.draftRevision + 1)
    expect(after.blocks).toEqual({})
    expect(after.variables).toEqual(before.variables)
  })
})
