// Copyright (c) 2026 Memlia. All rights reserved.
/** Real PostgreSQL/local storage; synthetic session principals, no HTTP/Office host qualification. */
import { createHash } from 'node:crypto'
import { lstatSync, mkdtempSync, readFileSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { db, dbFor } from '@sim/db'
import {
  permissions,
  project,
  session,
  user,
  userStats,
  workspace,
  workspaceFiles,
} from '@sim/db/schema'
import { assertDisposableTestDatabaseUrl } from '@sim/db/testing/test-infrastructure'
import { deleteWorkspaceFixture, insertWorkspaceFixture } from '@sim/db/testing/workspace-fixtures'
import { createSessionPrincipal } from '@sim/testing/factories/principal.factory'
import { generateId } from '@sim/utils/id'
import { and, eq, inArray, isNull, notExists, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const storage = vi.hoisted(() => ({ root: '' }))
vi.mock('@/lib/uploads/core/setup.server', () => ({
  get UPLOAD_DIR_SERVER() {
    return storage.root
  },
}))

import { createUserStatsIfMissing } from '@/lib/billing/core/usage'
import { persistOfficeCompressedCopy } from '@/lib/memlia/excel/office/backup.server'
import { listAllWorkspaceFiles } from '@/lib/workspace-files/application/list-workspace-files'
import {
  createPrivateOfficeBackup,
  readPrivateOfficeBackup,
} from '@/lib/workspace-files/application/office-backups'
import { readWorkspaceFileContent } from '@/lib/workspace-files/application/read-workspace-file-content'
import { readWorkspaceFileContentByKey } from '@/lib/workspace-files/application/read-workspace-file-content-by-key'
import { updateWorkspaceFileShare } from '@/lib/workspace-files/application/share-workspace-file'
import { verifyFileAccess } from '@/app/api/files/authorization'

describe('private Office copies on real PostgreSQL and local storage', () => {
  const freshIds = {
    alice: generateId(),
    bob: generateId(),
    aliceSession: generateId(),
    bobSession: generateId(),
    workspace: generateId(),
    project: generateId(),
    otherWorkspace: generateId(),
    otherProject: generateId(),
  }
  // Opt-in recovery consumes the previous run's owned receipt; it never reseeds or creates copies.
  const resumePath = process.env.MEMLIA_OFFICE_BACKUP_RESUME_RECEIPT
  let resume: { ids: typeof freshIds; storageRoot: string } | undefined
  if (resumePath) {
    const observed = lstatSync(resumePath)
    if (
      !observed.isFile() ||
      observed.uid !== process.getuid?.() ||
      (observed.mode & 0o777) !== 0o600 ||
      observed.size > 8192
    )
      throw new Error('Office resume receipt refused')
    const raw = readFileSync(resumePath, 'utf8')
    if (Buffer.byteLength(raw) > 8192) throw new Error('Office resume receipt refused')
    const parsed = JSON.parse(raw)
    if (
      parsed.qualification !== 'application_pg_local_storage_only' ||
      Object.keys(parsed).sort().join() !== 'ids,qualification,storageRoot' ||
      !parsed.ids ||
      Object.keys(parsed.ids).sort().join() !== Object.keys(freshIds).sort().join() ||
      !Object.values(parsed.ids).every(
        (id) => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id)
      ) ||
      new Set(Object.values(parsed.ids)).size !== 8 ||
      typeof parsed.storageRoot !== 'string' ||
      path.dirname(parsed.storageRoot) !== tmpdir() ||
      !path.basename(parsed.storageRoot).startsWith('memlia-office-backup-')
    )
      throw new Error('Office resume receipt refused')
    const directory = lstatSync(parsed.storageRoot)
    if (
      !directory.isDirectory() ||
      directory.uid !== process.getuid?.() ||
      (directory.mode & 0o777) !== 0o700
    )
      throw new Error('Office resume storage refused')
    resume = parsed
  }
  const ids = resume?.ids ?? freshIds
  let existing: (typeof workspaceFiles.$inferSelect)[] = []
  const alice = createSessionPrincipal({ userId: ids.alice, sessionId: ids.aliceSession })
  const bob = createSessionPrincipal({ userId: ids.bob, sessionId: ids.bobSession })
  const created: { id: string; key: string; version: number; size: number; sha256: string }[] = []
  let seeded = false
  let completed = false
  const hash = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

  beforeAll(async () => {
    assertDisposableTestDatabaseUrl(process.env.DATABASE_URL ?? '')
    if (resume) {
      storage.root = resume.storageRoot
      const people = await db
        .select()
        .from(user)
        .where(inArray(user.id, [ids.alice, ids.bob]))
      expect(people.map((row) => [row.id, row.email, row.name]).sort()).toEqual(
        [
          [ids.alice, `${ids.alice}@fixture.test`, 'Office Alice fixture'],
          [ids.bob, `${ids.bob}@fixture.test`, 'Office Bob fixture'],
        ].sort()
      )
      const spaces = await db
        .select()
        .from(workspace)
        .where(inArray(workspace.id, [ids.workspace, ids.otherWorkspace]))
      expect(spaces.map((row) => [row.id, row.projectId, row.ownerId]).sort()).toEqual(
        [
          [ids.workspace, ids.project, ids.alice],
          [ids.otherWorkspace, ids.otherProject, ids.alice],
        ].sort()
      )
      existing = await db
        .select()
        .from(workspaceFiles)
        .where(inArray(workspaceFiles.workspaceId, [ids.workspace, ids.otherWorkspace]))
      const sizes = existing.map((row) => {
        if (row.sizeBytes === null) throw new Error('Office resume size refused')
        return row.sizeBytes
      })
      expect(sizes.sort((a, b) => a - b)).toEqual([7, 8])
      for (const row of existing) {
        expect(row).toMatchObject({
          userId: ids.alice,
          workspaceId: ids.workspace,
          context: 'office-backup',
          deletedAt: null,
        })
        expect(row.key).toBe(`workspace/${ids.workspace}/office-backups/${row.id}.xlsx`)
        const expected =
          row.sizeBytes === 7
            ? Buffer.from([0, 255, 128, 42, 0, 10, 13])
            : Buffer.from([255, 0, 128, 1, 2, 3, 250, 251])
        expect(await readFile(path.join(storage.root, row.key))).toEqual(expected)
      }
      seeded = true
      return
    }
    storage.root = mkdtempSync(path.join(tmpdir(), 'memlia-office-backup-'))
    if (process.env.MEMLIA_OFFICE_BACKUP_FIXTURE_RECEIPT) {
      await writeFile(
        process.env.MEMLIA_OFFICE_BACKUP_FIXTURE_RECEIPT,
        JSON.stringify({
          ids,
          storageRoot: storage.root,
          qualification: 'application_pg_local_storage_only',
        }),
        { flag: 'wx', mode: 0o600 }
      )
    }
    const now = new Date()
    await db.transaction(async (tx) => {
      await tx.insert(user).values([
        {
          id: ids.alice,
          name: 'Office Alice fixture',
          email: `${ids.alice}@fixture.test`,
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: ids.bob,
          name: 'Office Bob fixture',
          email: `${ids.bob}@fixture.test`,
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
        },
      ])
      expect(await createUserStatsIfMissing(tx, ids.alice)).toBe(true)
      expect(await createUserStatsIfMissing(tx, ids.bob)).toBe(true)
      await tx.insert(session).values([
        {
          id: ids.aliceSession,
          userId: ids.alice,
          token: generateId(),
          createdAt: now,
          updatedAt: now,
          expiresAt: new Date(now.getTime() + 3_600_000),
        },
        {
          id: ids.bobSession,
          userId: ids.bob,
          token: generateId(),
          createdAt: now,
          updatedAt: now,
          expiresAt: new Date(now.getTime() + 3_600_000),
        },
      ])
    })
    await insertWorkspaceFixture(db, [
      {
        id: ids.workspace,
        projectId: ids.project,
        ownerId: ids.alice,
        billedAccountUserId: ids.alice,
        organizationId: null,
        name: 'Office private fixture',
      },
      {
        id: ids.otherWorkspace,
        projectId: ids.otherProject,
        ownerId: ids.alice,
        billedAccountUserId: ids.alice,
        organizationId: null,
        name: 'Office other fixture',
      },
    ])
    await db.insert(permissions).values([
      {
        id: generateId(),
        userId: ids.alice,
        entityId: ids.workspace,
        entityType: 'workspace',
        permissionType: 'admin',
      },
      {
        id: generateId(),
        userId: ids.bob,
        entityId: ids.workspace,
        entityType: 'workspace',
        permissionType: 'admin',
      },
      {
        id: generateId(),
        userId: ids.alice,
        entityId: ids.otherWorkspace,
        entityType: 'workspace',
        permissionType: 'admin',
      },
    ])
    seeded = true
  })

  afterAll(async () => {
    try {
      // An incomplete/unknown operation is retained, never repaired by broad fixture deletion.
      if (!seeded || !completed)
        throw new Error('Office integration fixture retained for reconciliation')
      const rows = await db
        .select()
        .from(workspaceFiles)
        .where(inArray(workspaceFiles.workspaceId, [ids.workspace, ids.otherWorkspace]))
      expect(rows.map((row) => row.id).sort()).toEqual(created.map((row) => row.id).sort())
      for (const expected of created) {
        const row = rows.find((candidate) => candidate.id === expected.id)
        expect(row).toMatchObject({
          userId: ids.alice,
          workspaceId: ids.workspace,
          context: 'office-backup',
          key: expected.key,
          sizeBytes: expected.size,
          deletedAt: null,
        })
        expect(row?.contentUpdatedAt.getTime()).toBe(expected.version)
        expect(hash(await readFile(path.join(storage.root, expected.key)))).toBe(expected.sha256)
      }
      for (const [workspaceId, projectId] of [
        [ids.workspace, ids.project],
        [ids.otherWorkspace, ids.otherProject],
      ]) {
        const snapshots = await db.execute<{ row: Record<string, unknown> }>(sql`
          SELECT to_jsonb(f) AS row FROM workspace_files f WHERE f.workspace_id = ${workspaceId} ORDER BY f.id`)
        const expected = JSON.stringify(snapshots.map((entry) => entry.row))
        const size =
          workspaceId === ids.workspace ? created.reduce((sum, entry) => sum + entry.size, 0) : 0
        await deleteWorkspaceFixture(
          db,
          and(
            eq(workspace.id, workspaceId),
            eq(workspace.ownerId, ids.alice),
            eq(workspace.projectId, projectId),
            eq(workspace.storageUsedBytes, size),
            sql`
            (SELECT coalesce(jsonb_agg(to_jsonb(f) ORDER BY f.id), '[]'::jsonb)
             FROM workspace_files f WHERE f.workspace_id = ${workspaceId}) = ${expected}::jsonb`
          )
        )
      }
      expect(
        await db
          .select({ id: workspace.id })
          .from(workspace)
          .where(inArray(workspace.id, [ids.workspace, ids.otherWorkspace]))
      ).toEqual([])
      // The native helper's project ownership WeakMap belongs to its creating process.
      // Recovery removes only the two exact, now-empty synthetic projects from the old receipt.
      if (resume) {
        await db
          .delete(project)
          .where(
            and(
              inArray(project.id, [ids.project, ids.otherProject]),
              eq(project.ownerId, ids.alice),
              eq(project.name, 'Fixture project'),
              isNull(project.organizationId),
              notExists(
                db
                  .select({ one: sql`1` })
                  .from(workspace)
                  .where(eq(workspace.projectId, project.id))
              )
            )
          )
      }
      expect(
        await db
          .select({ id: project.id })
          .from(project)
          .where(inArray(project.id, [ids.project, ids.otherProject]))
      ).toEqual([])
      await db
        .delete(user)
        .where(
          and(
            inArray(user.id, [ids.alice, ids.bob]),
            sql`${user.email} = ${user.id} || '@fixture.test'`,
            inArray(user.name, ['Office Alice fixture', 'Office Bob fixture'])
          )
        )
      expect(
        await db
          .select({ id: user.id })
          .from(user)
          .where(inArray(user.id, [ids.alice, ids.bob]))
      ).toEqual([])
      await rm(storage.root, { recursive: true, force: false })
    } finally {
      await Promise.all([db.$client.end(), dbFor('cleanup').$client.end()])
    }
  })

  it('persists exact binary bytes/version/accounting and denies every shared-file path', async () => {
    // Opaque fictional bytes test binary fidelity; this is not an OOXML/Office-host oracle.
    const firstBytes = Buffer.from([0, 255, 128, 42, 0, 10, 13])
    const oldFirst = existing.find((row) => row.sizeBytes === firstBytes.length)
    if (resume && !oldFirst) throw new Error('Office resume identity refused')
    const first = resume
      ? (
          await readPrivateOfficeBackup(alice, {
            workspaceId: ids.workspace,
            fileId: oldFirst?.id ?? '',
            version: oldFirst?.contentUpdatedAt.getTime() ?? 0,
          })
        ).file
      : await createPrivateOfficeBackup(alice, { workspaceId: ids.workspace, content: firstBytes })
    created.push({ ...first, sha256: hash(firstBytes) })
    const read = await readPrivateOfficeBackup(alice, {
      workspaceId: ids.workspace,
      fileId: first.id,
      version: first.version,
    })
    expect(read.content).toEqual(firstBytes)
    expect(read.file).toEqual(first)
    const secondBytes = Buffer.from([255, 0, 128, 1, 2, 3, 250, 251])
    if (resume) {
      const oldSecond = existing.find((row) => row.sizeBytes === secondBytes.length)
      if (!oldSecond) throw new Error('Office resume identity refused')
      const second = await readPrivateOfficeBackup(alice, {
        workspaceId: ids.workspace,
        fileId: oldSecond.id,
        version: oldSecond.contentUpdatedAt.getTime(),
      })
      created.push({ ...second.file, sha256: hash(secondBytes) })
      expect(second.content).toEqual(secondBytes)
    } else {
      const stored = await persistOfficeCompressedCopy(alice, {
        workspaceId: ids.workspace,
        copyVersion: 1,
        bytes: secondBytes,
      })
      expect(stored.status).toBe('stored')
      if (stored.status !== 'stored')
        throw new Error('Office backup did not produce a storage receipt')
      const second = await readPrivateOfficeBackup(alice, {
        workspaceId: ids.workspace,
        fileId: stored.receipt.fileId,
        version: stored.receipt.contentVersion,
      })
      created.push({ ...second.file, sha256: hash(secondBytes) })
      expect(second.content).toEqual(secondBytes)
      expect(stored.receipt).toMatchObject({
        workspaceId: ids.workspace,
        ownerUserId: ids.alice,
        byteLength: secondBytes.length,
        sha256: hash(secondBytes),
      })
    }
    const [canonical] = await db
      .select()
      .from(workspaceFiles)
      .where(eq(workspaceFiles.id, first.id))
    expect(canonical).toMatchObject({
      context: 'office-backup',
      userId: ids.alice,
      workspaceId: ids.workspace,
      sizeBytes: firstBytes.length,
    })
    expect(canonical.contentUpdatedAt.getTime()).toBe(first.version)
    const [usage] = await db
      .select({ size: workspace.storageUsedBytes })
      .from(workspace)
      .where(eq(workspace.id, ids.workspace))
    const [payer] = await db
      .select({ size: userStats.storageUsedBytes })
      .from(userStats)
      .where(eq(userStats.userId, ids.alice))
    expect(usage.size).toBe(firstBytes.length + secondBytes.length)
    expect(payer.size).toBe(usage.size)
    await expect(
      readPrivateOfficeBackup(bob, {
        workspaceId: ids.workspace,
        fileId: first.id,
        version: first.version,
      })
    ).rejects.toMatchObject({ code: 'not_found' })
    await expect(
      readPrivateOfficeBackup(alice, {
        workspaceId: ids.otherWorkspace,
        fileId: first.id,
        version: first.version,
      })
    ).rejects.toMatchObject({ code: 'not_found' })
    await expect(
      readPrivateOfficeBackup(alice, {
        workspaceId: ids.workspace,
        fileId: first.id,
        version: first.version + 1,
      })
    ).rejects.toMatchObject({ code: 'not_found' })
    for (const principal of [alice, bob]) {
      await expect(
        readWorkspaceFileContent.execute({
          principal,
          input: { fileId: first.id, assertedWorkspaceId: ids.workspace },
        })
      ).rejects.toMatchObject({ code: 'not_found' })
      await expect(
        readWorkspaceFileContentByKey.execute({
          principal,
          input: { key: first.key, assertedWorkspaceId: ids.workspace },
        })
      ).rejects.toMatchObject({ code: 'not_found' })
      expect(
        (
          await listAllWorkspaceFiles.execute({
            principal,
            input: { workspaceId: ids.workspace, scope: 'all' },
          })
        ).files
      ).toEqual([])
      expect(await verifyFileAccess(first.key, principal.userId)).toBe(false)
      expect(await verifyFileAccess(first.key, principal.userId, undefined, 'general')).toBe(false)
    }
    await expect(
      updateWorkspaceFileShare.execute({
        principal: alice,
        input: { fileId: first.id, assertedWorkspaceId: ids.workspace, isActive: true },
      })
    ).rejects.toMatchObject({ code: 'not_found' })
    completed = true
  })
})
