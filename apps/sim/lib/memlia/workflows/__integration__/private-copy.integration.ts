// Copyright 2026 Memlia. All rights reserved.
import { db } from '@sim/db'
import {
  auditLog,
  memliaWorkflowCopy,
  permissions,
  user,
  workflow,
  workflowBlocks,
  workflowDeploymentVersion,
  workflowExecutionLogs,
  workflowExecutionSnapshots,
  workflowSchedule,
  workspace,
} from '@sim/db/schema'
import { deleteWorkspaceFixture, insertWorkspaceFixture } from '@sim/db/testing/workspace-fixtures'
import { getPostgresErrorCode } from '@sim/utils/errors'
import { generateId } from '@sim/utils/id'
import { loadWorkflowFromNormalizedTablesRaw } from '@sim/workflow-persistence/load'
import { and, eq, inArray } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { copyPrivateWorkflow } from '@/lib/workflows/application/copy-private-workflow'
import { insertNewWorkflowRow } from '@/lib/workflows/persistence/new-workflow-row'
import { admitWorkflowState, saveAdmittedWorkflowState } from '@/lib/workflows/persistence/utils'
import type { WorkflowState } from '@/stores/workflows/workflow/types'

// Real PostgreSQL and native authorization/persistence. Only the integration harness's realtime
// endpoint is a local stand-in. TEST_DATABASE_URL is guarded by the existing _test_ name policy.
const author = generateId()
const recipient = generateId()
const shared = generateId()
const personal = generateId()
const foreignPersonal = generateId()
const sourceId = generateId()
const readGrant = generateId()
const snapshotId = generateId()
let privateCopyId: string
const principal = { kind: 'session', userId: recipient, sessionId: generateId() } as const
const input = {
  sourceWorkflowId: sourceId,
  destinationWorkspaceId: personal,
  name: 'Private copy fixture',
}
const privateMarker = `author-private-${generateId()}`
const source: WorkflowState = {
  blocks: {
    sourceBlock: {
      id: 'sourceBlock',
      type: 'gmail',
      name: privateMarker,
      position: { x: 0, y: 0 },
      enabled: true,
      outputs: { previousResult: { type: 'string', description: privateMarker } },
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
const countDestination = () =>
  db.select({ id: workflow.id }).from(workflow).where(eq(workflow.workspaceId, personal))

describe('private workflow copy with two real subjects and PostgreSQL', () => {
  beforeAll(async () => {
    const now = new Date()
    await db.insert(user).values(
      [author, recipient].map((id) => ({
        id,
        name: 'Private copy fixture',
        email: `${id}@workflow.test`,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      }))
    )
    await insertWorkspaceFixture(db, [
      {
        id: shared,
        name: 'Shared fixture',
        ownerId: author,
        billedAccountUserId: author,
        workspaceMode: 'grandfathered_shared',
        allowPersonalApiKeys: true,
      },
      {
        id: personal,
        name: 'Personal fixture',
        ownerId: recipient,
        billedAccountUserId: recipient,
        workspaceMode: 'personal',
        allowPersonalApiKeys: true,
      },
      {
        id: foreignPersonal,
        name: 'Foreign personal fixture',
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
        name: 'Shared source fixture',
        description: privateMarker,
        folderId: null,
        variables: source.variables,
      })
      const saved = await saveAdmittedWorkflowState(tx, sourceId, admitted)
      if (!saved.success) throw new Error('Failed to create isolated source fixture')
    })
    await db.insert(workflowDeploymentVersion).values({
      id: generateId(),
      workflowId: sourceId,
      version: 1,
      state: source,
      isActive: false,
      createdBy: author,
    })
    await db.insert(workflowSchedule).values({
      id: generateId(),
      workflowId: sourceId,
      triggerType: 'schedule',
      status: 'disabled',
      sourceUserId: author,
      sourceWorkspaceId: shared,
      prompt: privateMarker,
    })
    await db
      .insert(workflowExecutionSnapshots)
      .values({ id: snapshotId, workflowId: sourceId, stateHash: generateId(), stateData: source })
    await db.insert(workflowExecutionLogs).values({
      id: generateId(),
      workflowId: sourceId,
      workspaceId: shared,
      executionId: generateId(),
      stateSnapshotId: snapshotId,
      level: 'info',
      status: 'completed',
      trigger: 'manual',
      startedAt: new Date(),
      endedAt: new Date(),
      executionData: { privateMarker },
    })
  })
  afterAll(async () => {
    await db
      .delete(auditLog)
      .where(inArray(auditLog.workspaceId, [shared, personal, foreignPersonal]))
    await deleteWorkspaceFixture(db, inArray(workspace.id, [shared, personal, foreignPersonal]))
    await db.delete(workflowExecutionSnapshots).where(eq(workflowExecutionSnapshots.id, snapshotId))
    await db.delete(user).where(inArray(user.id, [author, recipient]))
    await db.$client.end()
  })

  it('creates a fresh private graph without author values, bindings or history and leaves the source intact', async () => {
    const before = await loadWorkflowFromNormalizedTablesRaw(sourceId)
    const result = await copyPrivateWorkflow.execute({ principal, input })
    privateCopyId = result.id
    expect(result.id).not.toBe(sourceId)
    const [provenance] = await db
      .select()
      .from(memliaWorkflowCopy)
      .where(eq(memliaWorkflowCopy.workflowId, result.id))
    expect(provenance).toMatchObject({
      workflowId: result.id,
      sourceWorkflowId: sourceId,
      sourceStateDigest: result.source.revision,
      createdByUserId: recipient,
      createdAt: expect.any(Date),
    })
    expect(result.configurationRequired).toBe(true)
    const [row] = await db.select().from(workflow).where(eq(workflow.id, result.id))
    expect(row).toMatchObject({
      userId: recipient,
      workspaceId: personal,
      variables: {},
      isDeployed: false,
      isPublicApi: false,
      runCount: 0,
      lastRunAt: null,
      description: null,
    })
    const graph = await loadWorkflowFromNormalizedTablesRaw(result.id)
    expect(graph).not.toBeNull()
    expect(
      await db
        .select()
        .from(workflowDeploymentVersion)
        .where(eq(workflowDeploymentVersion.workflowId, result.id))
    ).toEqual([])
    expect(
      await db
        .select()
        .from(workflowExecutionLogs)
        .where(eq(workflowExecutionLogs.workflowId, result.id))
    ).toEqual([])
    expect(
      await db
        .select()
        .from(workflowExecutionSnapshots)
        .where(eq(workflowExecutionSnapshots.workflowId, result.id))
    ).toEqual([])
    expect(
      await db.select().from(workflowSchedule).where(eq(workflowSchedule.workflowId, result.id))
    ).toEqual([])
    expect(Object.keys(graph!.blocks)).not.toContain('sourceBlock')
    expect(JSON.stringify(graph)).not.toContain(privateMarker)
    expect(JSON.stringify(graph)).not.toContain('/api/files/view/private')
    expect(await loadWorkflowFromNormalizedTablesRaw(sourceId)).toEqual(before)
    const [sourceRow] = await db.select().from(workflow).where(eq(workflow.id, sourceId))
    expect(JSON.stringify(sourceRow.variables)).toContain(privateMarker)
    // Native audit is asynchronous; wait only for this fixture's exact record.
    await expect
      .poll(async () =>
        db
          .select()
          .from(auditLog)
          .where(and(eq(auditLog.workspaceId, personal), eq(auditLog.resourceId, result.id)))
      )
      .toMatchObject([
        {
          actorId: recipient,
          metadata: { sourceWorkflowId: sourceId, sourceRevision: result.source.revision },
        },
      ])
  })
  it('refuses another subject personal workspace without writes', async () => {
    const before = await countDestination()
    await expect(
      copyPrivateWorkflow.execute({
        principal,
        input: { ...input, destinationWorkspaceId: foreignPersonal },
      })
    ).rejects.toThrow()
    expect(await countDestination()).toEqual(before)
  })
  it('refuses a revoked source membership instead of borrowing the author identity', async () => {
    const before = await countDestination()
    await db.delete(permissions).where(eq(permissions.id, readGrant))
    try {
      await expect(copyPrivateWorkflow.execute({ principal, input })).rejects.toThrow()
      expect(await countDestination()).toEqual(before)
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
  it('refuses an actorless workspace key and does not infer a subject from its billing owner', async () => {
    const before = await countDestination()
    await expect(
      copyPrivateWorkflow.execute({
        principal: { kind: 'workspace_api_key', workspaceId: personal, keyId: generateId() },
        input,
      })
    ).rejects.toThrow(/authenticated human/)
    expect(await countDestination()).toEqual(before)
  })
  it.each([
    { name: 'short digest', digest: 'a'.repeat(63), actor: recipient, code: '23514' },
    { name: 'nonhex digest', digest: 'g'.repeat(64), actor: recipient, code: '23514' },
    { name: 'unknown creator', digest: 'a'.repeat(64), actor: generateId(), code: '23503' },
    {
      name: 'duplicate provenance',
      digest: 'a'.repeat(64),
      actor: recipient,
      code: '23505',
      duplicate: true,
    },
  ])(
    'rolls back the native graph transaction when $name violates provenance constraints',
    async (fixture) => {
      const id = generateId()
      const state = { ...source, blocks: { [id]: { ...source.blocks.sourceBlock, id } } }
      const admitted = await admitWorkflowState(state, {
        workspaceId: personal,
        subjectUserId: recipient,
      })
      let failure: unknown
      try {
        await db.transaction(async (tx) => {
          await insertNewWorkflowRow(tx, {
            id,
            userId: recipient,
            workspaceId: personal,
            name: `Rollback fixture ${id}`,
            folderId: null,
            description: null,
          })
          expect((await saveAdmittedWorkflowState(tx, id, admitted)).success).toBe(true)
          const provenance = {
            workflowId: id,
            sourceWorkflowId: sourceId,
            sourceStateDigest: fixture.digest,
            createdByUserId: fixture.actor,
          }
          await tx.insert(memliaWorkflowCopy).values(provenance)
          if (fixture.duplicate) await tx.insert(memliaWorkflowCopy).values(provenance)
        })
      } catch (error) {
        failure = error
      }
      expect(getPostgresErrorCode(failure)).toBe(fixture.code)
      expect(await db.select().from(workflow).where(eq(workflow.id, id))).toEqual([])
      expect(
        await db.select().from(workflowBlocks).where(eq(workflowBlocks.workflowId, id))
      ).toEqual([])
      expect(
        await db.select().from(memliaWorkflowCopy).where(eq(memliaWorkflowCopy.workflowId, id))
      ).toEqual([])
    }
  )

  it('keeps historical provenance after creator deletion and cascades it only with its copy', async () => {
    const formerCreator = generateId()
    const id = generateId()
    const historicalSource = generateId()
    const now = new Date()
    await db.insert(user).values({
      id: formerCreator,
      name: 'Former creator fixture',
      email: `${formerCreator}@workflow.test`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })
    try {
      await db.transaction(async (tx) => {
        // Ownership has transferred to the recipient; attribution remains the former creator.
        await insertNewWorkflowRow(tx, {
          id,
          userId: recipient,
          workspaceId: personal,
          name: `Transferred fixture ${id}`,
          folderId: null,
          description: null,
        })
        await tx.insert(memliaWorkflowCopy).values({
          workflowId: id,
          sourceWorkflowId: historicalSource,
          sourceStateDigest: 'a'.repeat(64),
          createdByUserId: formerCreator,
        })
      })
      await db.delete(user).where(eq(user.id, formerCreator))
      expect(
        await db.select().from(memliaWorkflowCopy).where(eq(memliaWorkflowCopy.workflowId, id))
      ).toMatchObject([{ sourceWorkflowId: historicalSource, createdByUserId: null }])
      await db.delete(workflow).where(eq(workflow.id, id))
      expect(
        await db.select().from(memliaWorkflowCopy).where(eq(memliaWorkflowCopy.workflowId, id))
      ).toEqual([])
    } finally {
      await db.delete(user).where(eq(user.id, formerCreator))
    }
  })

  it('preserves the actual private copy when the shared source workflow is deleted', async () => {
    await db.delete(workflow).where(eq(workflow.id, sourceId))
    expect(await db.select().from(workflow).where(eq(workflow.id, privateCopyId))).toHaveLength(1)
    expect(
      await db
        .select()
        .from(memliaWorkflowCopy)
        .where(eq(memliaWorkflowCopy.workflowId, privateCopyId))
    ).toMatchObject([{ sourceWorkflowId: sourceId, createdByUserId: recipient }])
  })
})
