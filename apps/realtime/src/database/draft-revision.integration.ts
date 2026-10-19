// Copyright 2026 Memlia. All rights reserved.
import { db } from '@sim/db'
import { auditLog, permissions, user, workflow, workflowBlocks, workspace } from '@sim/db/schema'
import { deleteWorkspaceFixture, insertWorkspaceFixture } from '@sim/db/testing/workspace-fixtures'
import {
  BLOCK_OPERATIONS,
  OPERATION_TARGETS,
  SUBBLOCK_OPERATIONS,
  VARIABLE_OPERATIONS,
} from '@sim/realtime-protocol/constants'
import { generateId } from '@sim/utils/id'
import { withWorkflowDraftMutation } from '@sim/workflow-persistence/revision'
import { saveWorkflowToNormalizedTables } from '@sim/workflow-persistence/save'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.BETTER_AUTH_URL = 'http://localhost:3000'
})

import { setupSubblocksHandlers } from '../handlers/subblocks'
import { setupVariablesHandlers } from '../handlers/variables'
import { persistWorkflowOperation } from './operations'

// Real writer and independent PostgreSQL pools; socket authentication/authorization is NOT tested.
const ownerId = generateId()
const workspaceId = generateId()
const workflowId = generateId()
const blockId = generateId()
const variableId = generateId()
const read = async () => ({
  row: (await db.select().from(workflow).where(eq(workflow.id, workflowId)))[0],
  blocks: await db.select().from(workflowBlocks).where(eq(workflowBlocks.workflowId, workflowId)),
})

describe('realtime draft writers against PostgreSQL', () => {
  beforeAll(async () => {
    const now = new Date()
    await db.insert(user).values({
      id: ownerId,
      name: 'Realtime revision fixture',
      email: `${ownerId}@revision.test`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })
    await insertWorkspaceFixture(db, {
      id: workspaceId,
      name: 'Realtime revision fixture',
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
      name: 'Realtime revision fixture',
      lastSynced: now,
      createdAt: now,
      updatedAt: now,
    })
    const saved = await saveWorkflowToNormalizedTables(workflowId, {
      blocks: {
        [blockId]: {
          id: blockId,
          type: 'function',
          name: 'Initial',
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
    expect(saved).toMatchObject({ success: true, baseRevision: 0, draftRevision: 1 })
  })
  afterAll(async () => {
    try {
      await db.delete(auditLog).where(eq(auditLog.workspaceId, workspaceId))
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

  it.each([
    [OPERATION_TARGETS.BLOCK, BLOCK_OPERATIONS.UPDATE_NAME, { id: blockId, name: 'Human name' }],
    [
      OPERATION_TARGETS.SUBBLOCK,
      SUBBLOCK_OPERATIONS.BATCH_UPDATE,
      { updates: [{ blockId, subblockId: 'code', value: 'return 2' }] },
    ],
    [
      OPERATION_TARGETS.VARIABLE,
      VARIABLE_OPERATIONS.ADD,
      { id: variableId, name: 'threshold', type: 'number', value: 2 },
    ],
  ])(
    'invalidates a proposal after the real %s writer commits',
    async (target, operation, payload) => {
      const before = await read()
      await persistWorkflowOperation(workflowId, {
        target,
        operation,
        payload,
        timestamp: Date.now(),
        userId: ownerId,
      })
      const after = await read()
      expect(after.row.draftRevision).toBe(before.row.draftRevision + 1)
      await expect(
        db.transaction((tx) =>
          withWorkflowDraftMutation(
            tx,
            workflowId,
            async () => {
              await tx
                .update(workflowBlocks)
                .set({ name: 'Obsolete' })
                .where(eq(workflowBlocks.id, blockId))
              return { changed: true, value: null }
            },
            before.row.draftRevision
          )
        )
      ).rejects.toMatchObject({ code: 'conflict' })
      expect(await read()).toEqual(after)
    }
  )

  it('rolls back the timestamp and revision when a native operation is rejected', async () => {
    const before = await read()
    await expect(
      persistWorkflowOperation(workflowId, {
        target: OPERATION_TARGETS.SUBBLOCK,
        operation: SUBBLOCK_OPERATIONS.BATCH_UPDATE,
        payload: {
          updates: [{ blockId, subblockId: 'code', value: 'stale', expectedValue: 'wrong value' }],
        },
        timestamp: Date.now(),
      })
    ).rejects.toThrow('changed since replacement was planned')
    expect(await read()).toEqual(before)
  })
  it.each(['subblock-update', 'variable-update'] as const)(
    'invalidates proposals through the real %s debounce handler',
    async (event) => {
      // Transport/session presence is a local double; the native DB authorization and writes run.
      const socketId = generateId()
      const operationId = generateId()
      const handlers = new Map<string, (payload: Record<string, unknown>) => Promise<void>>()
      const emitted: Array<{ event: string; data: Record<string, unknown> }> = []
      const channel = {
        except: () => channel,
        emit: (event: string, data: Record<string, unknown>) => emitted.push({ event, data }),
      }
      const socket = {
        id: socketId,
        on: (name: string, handler: (payload: Record<string, unknown>) => Promise<void>) =>
          handlers.set(name, handler),
        emit: channel.emit,
      }
      const rooms = {
        io: { to: () => channel },
        isReady: () => true,
        getRoomForSocket: async () => ({ id: workflowId }),
        getUserSession: async () => ({ userId: ownerId }),
        hasRoom: async () => true,
        getRoomUsers: async () => [{ socketId, userId: ownerId, role: 'admin' }],
        updateUserActivity: async () => {},
      }
      setupSubblocksHandlers(
        socket as unknown as Parameters<typeof setupSubblocksHandlers>[0],
        rooms as unknown as Parameters<typeof setupSubblocksHandlers>[1]
      )
      setupVariablesHandlers(
        socket as unknown as Parameters<typeof setupVariablesHandlers>[0],
        rooms as unknown as Parameters<typeof setupVariablesHandlers>[1]
      )
      const before = await read()
      await handlers.get(event)!({
        workflowId,
        operationId,
        timestamp: Date.now(),
        ...(event === 'subblock-update'
          ? { blockId, subblockId: 'code', value: 'return 4' }
          : { variableId, field: 'value', value: 4 }),
      })
      await expect
        .poll(() =>
          emitted.some(
            (item) => item.event === 'operation-confirmed' && item.data.operationId === operationId
          )
        )
        .toBe(true)
      const after = await read()
      expect(after.row.draftRevision).toBe(before.row.draftRevision + 1)
      if (event === 'subblock-update')
        expect(after.blocks[0].subBlocks).toMatchObject({ code: { value: 'return 4' } })
      else {
        expect(after.row.variables).toMatchObject({ [variableId]: { value: 4 } })
        await expect
          .poll(
            async () =>
              (await db.select().from(auditLog).where(eq(auditLog.workspaceId, workspaceId))).length
          )
          .toBe(1)
      }
    }
  )
})
