// Copyright 2026 Memlia. All rights reserved.
import { db } from '@sim/db'
import { user, workflow, workflowBlocks, workspace } from '@sim/db/schema'
import { deleteWorkspaceFixture, insertWorkspaceFixture } from '@sim/db/testing/workspace-fixtures'
import { getPostgresErrorCode } from '@sim/utils/errors'
import { generateId } from '@sim/utils/id'
import {
  loadWorkflowFromNormalizedTablesRaw,
  persistMigratedBlocks,
} from '@sim/workflow-persistence/load'
import {
  advanceWorkflowDraft,
  lockWorkflowDraft,
  type WorkflowDraftTransaction,
  withWorkflowDraftMutation,
} from '@sim/workflow-persistence/revision'
import { saveWorkflowToNormalizedTables as rawSave } from '@sim/workflow-persistence/save'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { clearCredentialRefs } from '@/lib/credentials/deletion'
import { withPermissionGroupScope } from '@/lib/permission-groups/request-scope.server'
import { insertNewWorkflowRow } from '@/lib/workflows/persistence/new-workflow-row'
import { replaceWorkflowNormalizedState } from '@/lib/workflows/persistence/replace-normalized-state'
import { setWorkflowVariables } from '@/lib/workflows/utils'
import { lazyCleanupInputMapping } from '@/executor/utils/lazy-cleanup'
import { applyPreparedCredential } from '../../../../../packages/db/scripts/migrate-slack-custom-bots'

const ownerId = generateId()
const workspaceId = generateId()
const workflowId = generateId()
const blockId = generateId()
const state = (name: string) => ({
  blocks: {
    [blockId]: {
      id: blockId,
      type: 'function',
      name,
      position: { x: 0, y: 0 },
      subBlocks: {},
      outputs: {},
      enabled: true,
    },
  },
  edges: [],
})
const write = (name: string, expectedRevision?: number) =>
  withPermissionGroupScope(() =>
    replaceWorkflowNormalizedState({
      workflowId,
      workspaceId,
      attributedUserId: ownerId,
      subjectUserId: ownerId,
      state: state(name),
      expectedRevision,
    })
  )
const read = async () => ({
  row: (await db.select().from(workflow).where(eq(workflow.id, workflowId)))[0],
  blocks: await db.select().from(workflowBlocks).where(eq(workflowBlocks.workflowId, workflowId)),
})

describe('common draft revision with real PostgreSQL', () => {
  beforeAll(async () => {
    const [role] = await db.execute<{
      rolsuper: boolean
      rolcreatedb: boolean
      rolbypassrls: boolean
    }>(sql`select rolsuper, rolcreatedb, rolbypassrls from pg_roles where rolname = current_user`)
    expect(role).toMatchObject({ rolsuper: false, rolcreatedb: false, rolbypassrls: false })
    const now = new Date()
    await db.insert(user).values({
      id: ownerId,
      name: 'Revision fixture',
      email: `${ownerId}@revision.test`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })
    await insertWorkspaceFixture(db, {
      id: workspaceId,
      name: 'Revision fixture',
      ownerId,
      billedAccountUserId: ownerId,
      workspaceMode: 'personal',
    })
    await db.transaction((tx) =>
      insertNewWorkflowRow(tx, {
        id: workflowId,
        workspaceId,
        userId: ownerId,
        name: 'Revision fixture',
        folderId: null,
        description: null,
      })
    )
  })
  afterAll(async () => {
    try {
      await db.delete(workflow).where(eq(workflow.id, workflowId))
      await deleteWorkspaceFixture(db, eq(workspace.id, workspaceId))
      await db.delete(user).where(eq(user.id, ownerId))
      expect(await db.select().from(workflow).where(eq(workflow.id, workflowId))).toEqual([])
    } finally {
      await db.$client.end()
    }
  })

  it('rejects an obsolete proposal without changing the human graph or its revision', async () => {
    expect((await read()).row.draftRevision).toBe(0)
    await write('Human edit', 0)
    const before = await read()
    expect(before.row.draftRevision).toBe(1)
    await expect(write('Obsolete proposal', 0)).rejects.toMatchObject({ code: 'conflict' })
    expect(await read()).toEqual(before)
  })
  it('waits for a human transaction and rejects the stale graph after that commit', async () => {
    const base = (await read()).row.draftRevision
    let release!: () => void
    let announce!: (pid: number) => void
    const held = new Promise<number>((resolve) => {
      announce = resolve
    })
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const human = db.transaction(async (tx) =>
      withWorkflowDraftMutation(
        tx,
        workflowId,
        async () => {
          await tx
            .update(workflowBlocks)
            .set({ name: 'Human concurrent edit' })
            .where(eq(workflowBlocks.id, blockId))
          const [{ pid }] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)
          announce(pid)
          await barrier
          return { changed: true, value: null }
        },
        base
      )
    )
    const pid = await held
    const obsolete = write('Stale concurrent proposal', base).then(
      () => ({ accepted: true as const }),
      (error: unknown) => ({ accepted: false as const, error })
    )
    try {
      await expect
        .poll(async () => {
          const [{ blocked }] = await db.execute<{ blocked: boolean }>(
            sql`select exists(select 1 from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))) as blocked`
          )
          return blocked
        })
        .toBe(true)
    } finally {
      release()
    }
    await expect(human).resolves.toMatchObject({ baseRevision: base, draftRevision: base + 1 })
    expect(await obsolete).toMatchObject({ accepted: false, error: { code: 'conflict' } })
    const saved = await read()
    expect(saved.row.draftRevision).toBe(base + 1)
    expect(saved.blocks[0].name).toBe('Human concurrent edit')
  })

  it('rolls back graph writes and revision together when a mutation fails', async () => {
    const before = await read()
    await expect(
      db.transaction(async (tx) =>
        withWorkflowDraftMutation(
          tx,
          workflowId,
          async () => {
            await tx
              .update(workflowBlocks)
              .set({ name: 'Must roll back' })
              .where(eq(workflowBlocks.id, blockId))
            throw new Error('Fixture abort')
          },
          before.row.draftRevision
        )
      )
    ).rejects.toThrow('Fixture abort')
    expect(await read()).toEqual(before)
  })
  it('invalidates proposals when load-time migrations persist and leaves a stale migration inert', async () => {
    const original = await loadWorkflowFromNormalizedTablesRaw(workflowId)
    expect(original).not.toBeNull()
    const changed = {
      ...original!.blocks,
      [blockId]: {
        ...original!.blocks[blockId],
        subBlocks: { code: { id: 'code', type: 'code', value: 'return 3' } },
      },
    }
    await persistMigratedBlocks(
      workflowId,
      original!.blocks,
      changed,
      original!.blockUpdatedAtById,
      original!.draftRevision
    )
    const migrated = await read()
    expect(migrated.row.draftRevision).toBe(original!.draftRevision + 1)
    expect(migrated.blocks[0].subBlocks).toMatchObject({ code: { value: 'return 3' } })
    await write('Human after migration', migrated.row.draftRevision)
    const human = await read()
    await persistMigratedBlocks(
      workflowId,
      original!.blocks,
      changed,
      original!.blockUpdatedAtById,
      original!.draftRevision
    )
    expect(await read()).toEqual(human)
  })

  it('preserves human subBlocks and data when a migration timestamp collides at JS millisecond precision', async () => {
    const timestamp = new Date('2026-10-19T00:00:00.123Z')
    await db
      .update(workflowBlocks)
      .set({ updatedAt: timestamp })
      .where(eq(workflowBlocks.id, blockId))
    const original = await loadWorkflowFromNormalizedTablesRaw(workflowId)
    expect(original).not.toBeNull()
    const changed = {
      ...original!.blocks,
      [blockId]: {
        ...original!.blocks[blockId],
        subBlocks: { code: { id: 'code', type: 'code', value: 'old migration' } },
        data: { count: 1 },
      },
    }
    await db.transaction((tx) =>
      withWorkflowDraftMutation(tx, workflowId, async () => {
        await tx
          .update(workflowBlocks)
          .set({
            subBlocks: { code: { id: 'code', type: 'code', value: 'human edit' } },
            data: { count: 7 },
            updatedAt: timestamp,
          })
          .where(eq(workflowBlocks.id, blockId))
        return { changed: true, value: null }
      })
    )
    const human = await read()
    const current = await loadWorkflowFromNormalizedTablesRaw(workflowId)
    expect(current!.blockUpdatedAtById[blockId]).toBe(original!.blockUpdatedAtById[blockId])
    expect(current!.draftRevision).toBe(original!.draftRevision + 1)
    await persistMigratedBlocks(
      workflowId,
      original!.blocks,
      changed,
      original!.blockUpdatedAtById,
      original!.draftRevision
    )
    expect(await read()).toEqual(human)
    // Runtime invalid input remains fail-closed for old/untyped callers, with the native best-effort error contract.
    await persistMigratedBlocks(
      workflowId,
      current!.blocks,
      changed,
      current!.blockUpdatedAtById,
      undefined as unknown as number
    )
    expect(await read()).toEqual(human)
  })

  it('enforces revision bounds in PostgreSQL and rolls back overflow mutations', async () => {
    const original = await read()
    for (const invalid of [-1, Number.MAX_SAFE_INTEGER + 1]) {
      let caught: unknown
      try {
        await db.update(workflow).set({ draftRevision: invalid }).where(eq(workflow.id, workflowId))
      } catch (error) {
        caught = error
      }
      expect(getPostgresErrorCode(caught)).toBe('23514')
    }
    await db
      .update(workflow)
      .set({ draftRevision: Number.MAX_SAFE_INTEGER })
      .where(eq(workflow.id, workflowId))
    const saturated = await read()
    try {
      await expect(write('Must not wrap', Number.MAX_SAFE_INTEGER)).rejects.toMatchObject({
        code: 'conflict',
      })
      expect(await read()).toEqual(saturated)
    } finally {
      // Exact fixture only. Application code can never lower the revision.
      await db
        .update(workflow)
        .set({ draftRevision: original.row.draftRevision })
        .where(eq(workflow.id, workflowId))
    }
  })

  it('advances the revision for lazy cleanup and preserves a concurrent human input mapping', async () => {
    const child = {
      start: {
        type: 'start_trigger',
        subBlocks: { inputFormat: { value: [{ name: 'keep', type: 'string' }] } },
      },
    }
    const originalMapping = { keep: 'original', obsolete: 'remove' }
    await db.transaction(async (tx) =>
      withWorkflowDraftMutation(tx, workflowId, async () => {
        await tx
          .update(workflowBlocks)
          .set({
            subBlocks: {
              inputMapping: { id: 'inputMapping', type: 'short-input', value: originalMapping },
            },
          })
          .where(eq(workflowBlocks.id, blockId))
        return { changed: true, value: null }
      })
    )
    const base = (await read()).row.draftRevision
    expect(await lazyCleanupInputMapping(workflowId, blockId, originalMapping, child)).toEqual({
      keep: 'original',
    })
    await expect.poll(async () => (await read()).row.draftRevision).toBe(base + 1)
    expect((await read()).blocks[0].subBlocks).toMatchObject({
      inputMapping: { value: { keep: 'original' } },
    })

    let release!: () => void
    let announce!: (pid: number) => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const held = new Promise<number>((resolve) => {
      announce = resolve
    })
    const human = db.transaction(async (tx) =>
      withWorkflowDraftMutation(tx, workflowId, async () => {
        await tx
          .update(workflowBlocks)
          .set({
            subBlocks: {
              inputMapping: {
                id: 'inputMapping',
                type: 'short-input',
                value: { keep: 'human', newField: 'human' },
              },
            },
          })
          .where(eq(workflowBlocks.id, blockId))
        const [{ pid }] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)
        announce(pid)
        await barrier
        return { changed: true, value: null }
      })
    )
    const pid = await held
    await lazyCleanupInputMapping(workflowId, blockId, originalMapping, child)
    try {
      await expect
        .poll(async () => {
          const [{ blocked }] = await db.execute<{ blocked: boolean }>(
            sql`select exists(select 1 from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))) as blocked`
          )
          return blocked
        })
        .toBe(true)
    } finally {
      release()
    }
    await human
    // Queue behind the already-waiting cleanup, so the no-op assertion cannot race its completion.
    await db.transaction((tx) => lockWorkflowDraft(tx, workflowId))
    const after = await read()
    expect(after.row.draftRevision).toBe(base + 2)
    expect(after.blocks[0].subBlocks).toMatchObject({
      inputMapping: { value: { keep: 'human', newField: 'human' } },
    })
  })

  it('invalidates proposals when credential deletion clears current graph references, including archived drafts', async () => {
    const credentialId = generateId()
    await db.transaction((tx) =>
      withWorkflowDraftMutation(tx, workflowId, async () => {
        await tx
          .update(workflowBlocks)
          .set({
            subBlocks: {
              credential: { id: 'credential', type: 'short-input', value: credentialId },
              prompt: { id: 'prompt', type: 'short-input', value: 'Keep human text' },
            },
          })
          .where(eq(workflowBlocks.id, blockId))
        return { changed: true, value: null }
      })
    )
    const base = (await read()).row.draftRevision
    await clearCredentialRefs(credentialId, workspaceId)
    expect((await read()).row.draftRevision).toBe(base + 1)
    expect((await read()).blocks[0].subBlocks).toMatchObject({
      credential: { value: '' },
      prompt: { value: 'Keep human text' },
    })
    await expect(write('Obsolete credential proposal', base)).rejects.toMatchObject({
      code: 'conflict',
    })
    await clearCredentialRefs(credentialId, workspaceId)
    expect((await read()).row.draftRevision).toBe(base + 1)
    await db.transaction((tx) =>
      withWorkflowDraftMutation(tx, workflowId, async () => {
        await tx
          .update(workflowBlocks)
          .set({ subBlocks: { credential: { id: 'credential', value: credentialId } } })
          .where(eq(workflowBlocks.id, blockId))
        return { changed: true, value: null }
      })
    )
    await db.update(workflow).set({ archivedAt: new Date() }).where(eq(workflow.id, workflowId))
    try {
      await clearCredentialRefs(credentialId, workspaceId)
      expect((await read()).row.draftRevision).toBe(base + 3)
      expect((await read()).blocks[0].subBlocks).toMatchObject({ credential: { value: '' } })
    } finally {
      await db.update(workflow).set({ archivedAt: null }).where(eq(workflow.id, workflowId))
    }
  })

  it('stamps Slack migration trigger changes once, skips retries and rolls back at the ceiling', async () => {
    await write('Slack migration fixture')
    const credentialId = generateId()
    const migrate = () =>
      applyPreparedCredential({
        db,
        workspaceId,
        workspaceOwnerId: ownerId,
        memberUserIds: [],
        encryptionKey: '',
        prepared: {
          workflowId,
          workflowName: 'Slack fixture',
          sources: [],
          credentialId,
          insertCredential: false,
          sourceLinks: [
            {
              source: {
                sourceId: `${workflowId}:${blockId}:trigger`,
                kind: 'trigger',
                blockId,
                blockName: 'Trigger',
                workflowId,
                workflowName: 'Slack fixture',
                workflowUserId: ownerId,
              },
              updateTriggerBlock: true,
              legacyWebhookCount: 0,
              webhookIdsToUpdate: [],
            },
          ],
        },
      })
    const base = (await read()).row.draftRevision
    expect(await migrate()).toMatchObject({ triggersLinked: 1 })
    expect((await read()).row.draftRevision).toBe(base + 1)
    expect((await read()).blocks[0].subBlocks).toMatchObject({
      botCredential: { value: credentialId },
    })
    expect(await migrate()).toMatchObject({ triggersLinked: 0 })
    expect((await read()).row.draftRevision).toBe(base + 1)
    await write('Empty trigger')
    const before = await read()
    await db
      .update(workflow)
      .set({ draftRevision: Number.MAX_SAFE_INTEGER })
      .where(eq(workflow.id, workflowId))
    const saturated = await read()
    try {
      await expect(migrate()).rejects.toThrow('revision limit')
      expect(await read()).toEqual(saturated)
    } finally {
      await db
        .update(workflow)
        .set({ draftRevision: before.row.draftRevision })
        .where(eq(workflow.id, workflowId))
    }
  })

  it('invalidates proposals through the legacy variable helper', async () => {
    const base = (await read()).row.draftRevision
    await setWorkflowVariables(workflowId, { fixture: { name: 'fixture', value: 'human' } })
    expect((await read()).row.draftRevision).toBe(base + 1)
    expect((await read()).row.variables).toEqual({ fixture: { name: 'fixture', value: 'human' } })
    await expect(write('Stale helper proposal', base)).rejects.toMatchObject({ code: 'conflict' })
  })
  it('refuses the real autocommit pool at every mutation primitive before any write', async () => {
    const before = await read()
    let called = false
    // @ts-expect-error Deliberate invalid input: the pool is not a native transaction.
    const pool: WorkflowDraftTransaction = db
    await expect(
      withWorkflowDraftMutation(pool, workflowId, async () => {
        called = true
        return { changed: false, value: null }
      })
    ).rejects.toThrow('transaction')
    expect(called).toBe(false)
    await expect(
      rawSave(workflowId, { ...state('Must never be written'), lastSaved: Date.now() }, db)
    ).rejects.toThrow('transaction')
    await expect(lockWorkflowDraft(pool, workflowId)).rejects.toThrow('transaction')
    await expect(advanceWorkflowDraft(pool, workflowId, before.row.draftRevision)).rejects.toThrow(
      'transaction'
    )
    expect(await read()).toEqual(before)
  })
})
