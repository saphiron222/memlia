// Copyright 2026 Memlia. All rights reserved.
import { db } from '@sim/db'
import { permissions, user, workflow, workflowBlocks, workspace } from '@sim/db/schema'
import { deleteWorkspaceFixture, insertWorkspaceFixture } from '@sim/db/testing/workspace-fixtures'
import { BLOCK_OPERATIONS, OPERATION_TARGETS } from '@sim/realtime-protocol/constants'
import { generateId } from '@sim/utils/id'
import { saveWorkflowToNormalizedTables } from '@sim/workflow-persistence/save'
import { and, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const checkpoint = vi.hoisted(() => ({ beforeRaw: undefined as (() => Promise<void>) | undefined }))
vi.hoisted(() => {
  process.env.BETTER_AUTH_URL = 'http://localhost:3000'
})
vi.mock('@sim/workflow-persistence/load', async (importOriginal) => {
  const original = await importOriginal<typeof import('@sim/workflow-persistence/load')>()
  return {
    ...original,
    async loadWorkflowFromNormalizedTablesRaw(
      ...args: Parameters<typeof original.loadWorkflowFromNormalizedTablesRaw>
    ) {
      const barrier = checkpoint.beforeRaw
      checkpoint.beforeRaw = undefined
      await barrier?.()
      return original.loadWorkflowFromNormalizedTablesRaw(...args)
    },
  }
})

import { getWorkflowState, persistWorkflowOperation } from './operations'

// The checkpoint schedules a real concurrent writer; every read/write below uses PostgreSQL.
// Socket membership, transport and authentication are outside this database-reader test.
const ownerId = generateId()
const workspaceId = generateId()
const workflowId = generateId()
const blockId = generateId()

describe('realtime workflow snapshot on PostgreSQL', () => {
  beforeAll(async () => {
    const [role] = await db.execute<{ rolsuper: boolean; rolbypassrls: boolean }>(
      sql`select rolsuper, rolbypassrls from pg_roles where rolname=current_user`
    )
    expect(role).toMatchObject({ rolsuper: false, rolbypassrls: false })
    const now = new Date()
    await db.insert(user).values({
      id: ownerId,
      name: 'Snapshot fixture',
      email: `${ownerId}@snapshot.test`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })
    await insertWorkspaceFixture(db, {
      id: workspaceId,
      name: 'Snapshot fixture',
      ownerId,
      billedAccountUserId: ownerId,
      workspaceMode: 'personal',
    })
    await db.insert(permissions).values({
      id: generateId(),
      userId: ownerId,
      entityType: 'workspace',
      entityId: workspaceId,
      permissionType: 'admin',
    })
    await db.insert(workflow).values({
      id: workflowId,
      workspaceId,
      userId: ownerId,
      name: 'Snapshot fixture',
      lastSynced: now,
      createdAt: now,
      updatedAt: now,
      variables: { threshold: { id: 'threshold', name: 'threshold', type: 'number', value: 1 } },
    })
    expect(
      await saveWorkflowToNormalizedTables(workflowId, {
        blocks: {
          [blockId]: {
            id: blockId,
            type: 'function',
            name: 'Before concurrent write',
            position: { x: 0, y: 0 },
            subBlocks: {},
            outputs: {},
            enabled: true,
          },
        },
        edges: [],
        loops: {},
        parallels: {},
      })
    ).toMatchObject({ success: true, draftRevision: 1 })
  })
  afterAll(async () => {
    checkpoint.beforeRaw = undefined
    try {
      await db
        .delete(permissions)
        .where(and(eq(permissions.entityType, 'workspace'), eq(permissions.entityId, workspaceId)))
      await db.delete(workflow).where(eq(workflow.id, workflowId))
      await deleteWorkspaceFixture(db, eq(workspace.id, workspaceId))
      await db.delete(user).where(eq(user.id, ownerId))
      expect(await db.select().from(workflow).where(eq(workflow.id, workflowId))).toEqual([])
    } finally {
      await db.$client.end()
    }
  })
  it('returns the graph that belongs to its revision when another pool commits between reads', async () => {
    let releaseWriter!: () => void
    const startWriter = new Promise<void>((resolve) => {
      releaseWriter = resolve
    })
    // Start outside the reader's transaction context, as a different request would.
    const writer = (async () => {
      await startWriter
      await persistWorkflowOperation(workflowId, {
        target: OPERATION_TARGETS.BLOCK,
        operation: BLOCK_OPERATIONS.UPDATE_NAME,
        payload: { id: blockId, name: 'After concurrent write' },
        timestamp: Date.now(),
        userId: ownerId,
      })
    })()
    checkpoint.beforeRaw = async () => {
      releaseWriter()
      await writer
    }
    const snapshot = await getWorkflowState(workflowId).finally(async () => {
      releaseWriter()
      await writer
    })
    expect(snapshot).toMatchObject({
      draftRevision: 1,
      variables: { threshold: { value: 1 } },
      state: { blocks: { [blockId]: { name: 'Before concurrent write' } } },
    })
    const [current] = await db.select().from(workflow).where(eq(workflow.id, workflowId))
    expect(current.draftRevision).toBe(2)
    expect(
      (await db.select().from(workflowBlocks).where(eq(workflowBlocks.id, blockId)))[0].name
    ).toBe('After concurrent write')
    const refreshed = await getWorkflowState(workflowId)
    expect(refreshed).toMatchObject({
      draftRevision: 2,
      state: { blocks: { [blockId]: { name: 'After concurrent write' } } },
    })
  })
  it('keeps the existing missing and archived workflow refusal', async () => {
    await expect(getWorkflowState(generateId())).rejects.toThrow('not found')
    await db.update(workflow).set({ archivedAt: new Date() }).where(eq(workflow.id, workflowId))
    try {
      await expect(getWorkflowState(workflowId)).rejects.toThrow('not found')
    } finally {
      await db.update(workflow).set({ archivedAt: null }).where(eq(workflow.id, workflowId))
    }
  })
  it('propagates a failed graph read and leaves a later read available', async () => {
    const before = await getWorkflowState(workflowId)
    checkpoint.beforeRaw = async () => {
      throw new Error('Controlled read failure')
    }
    await expect(getWorkflowState(workflowId)).rejects.toThrow('Controlled read failure')
    expect(await getWorkflowState(workflowId)).toMatchObject({
      id: workflowId,
      draftRevision: before.draftRevision,
    })
  })
})
