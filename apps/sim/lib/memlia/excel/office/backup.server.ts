// Copyright (c) 2026 Memlia. All rights reserved.
import { createHash } from 'node:crypto'
import type { Principal } from '@sim/auth/principal'
import { z } from 'zod'
import { OfficeBackupStorageUnknownError } from '@/lib/uploads/contexts/workspace/file-manager'
import {
  captureOfficeBackupBytes,
  captureOfficeBackupSession,
  createPrivateOfficeBackup,
  readPrivateOfficeBackup,
} from '@/lib/workspace-files/application/office-backups'

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const metadataSchema = z.strictObject({ workspaceId: id, copyVersion: z.literal(1) })
const fileSchema = z.strictObject({
  id,
  workspaceId: id,
  userId: id,
  key: z.string().min(1).max(512),
  version: z.int().min(0).max(8_640_000_000_000_000),
  size: z.int().min(1).max(10_000_000),
})

export interface OfficeCopyStorageInput {
  workspaceId: string
  /** Compressed-copy adapter format, not an Excel document revision. */
  copyVersion: 1
  bytes: Uint8Array
}

export interface OfficeCopyStorageReceipt {
  schemaVersion: 'memlia.office-copy-storage/v1'
  workspaceId: string
  ownerUserId: string
  fileId: string
  contentVersion: number
  byteLength: number
  sha256: string
}

export type OfficeCopyStorageResult =
  | { status: 'stored'; receipt: Readonly<OfficeCopyStorageReceipt> }
  | {
      status: 'refused' | 'unconfirmed'
      code: 'office_backup_refused' | 'office_backup_cancelled' | 'office_backup_storage_unknown'
      stage: 'before_creation' | 'creation_unknown' | 'created_unverified'
      fileId: string | null
    }

function hash(content: Buffer) {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}

function field(value: object, key: string) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor || !('value' in descriptor)) throw new Error('office_backup_refused')
  return descriptor.value
}

function storageFailure(
  stage: 'before_creation' | 'creation_unknown' | 'created_unverified',
  fileId: string | null,
  cancelled: boolean
): OfficeCopyStorageResult {
  return Object.freeze({
    status: stage === 'before_creation' ? 'refused' : 'unconfirmed',
    code: cancelled
      ? 'office_backup_cancelled'
      : stage === 'creation_unknown'
        ? 'office_backup_storage_unknown'
        : 'office_backup_refused',
    stage,
    fileId,
  })
}

/** Storage only. No workbook snapshot, restoration, consent or patch authority is implied. */
export async function persistOfficeCompressedCopy(
  principal: Principal,
  input: OfficeCopyStorageInput,
  signal?: AbortSignal
): Promise<OfficeCopyStorageResult> {
  let stage: 'before_creation' | 'creation_unknown' | 'created_unverified' = 'before_creation'
  let fileId: string | null = null
  try {
    if (signal !== undefined && !(signal instanceof AbortSignal))
      throw new Error('office_backup_refused')
    signal?.throwIfAborted()
    const actor = captureOfficeBackupSession(principal)
    if (!input || typeof input !== 'object' || Reflect.ownKeys(input).length !== 3) {
      throw new Error('office_backup_refused')
    }
    const metadata = metadataSchema.parse({
      workspaceId: field(input, 'workspaceId'),
      copyVersion: field(input, 'copyVersion'),
    })
    const content = captureOfficeBackupBytes(field(input, 'bytes'))
    const digest = hash(content)
    let created: z.infer<typeof fileSchema>
    try {
      const stored = await createPrivateOfficeBackup(
        actor,
        { workspaceId: metadata.workspaceId, content },
        signal
      )
      stage = 'created_unverified'
      created = fileSchema.parse(stored)
    } catch (error) {
      if (error instanceof OfficeBackupStorageUnknownError) {
        stage = 'creation_unknown'
        if (
          error.identity.workspaceId === metadata.workspaceId &&
          error.identity.userId === actor.userId &&
          id.safeParse(error.identity.id).success
        )
          fileId = error.identity.id
      }
      throw error
    }
    fileId = created.id
    signal?.throwIfAborted()
    if (
      created.workspaceId !== metadata.workspaceId ||
      created.userId !== actor.userId ||
      created.key !== `workspace/${metadata.workspaceId}/office-backups/${created.id}.xlsx` ||
      created.size !== content.length
    )
      throw new Error('office_backup_refused')
    const read = await readPrivateOfficeBackup(
      actor,
      {
        workspaceId: metadata.workspaceId,
        fileId: created.id,
        version: created.version,
      },
      signal
    )
    const current = fileSchema.parse(read.file)
    signal?.throwIfAborted()
    if (
      current.id !== created.id ||
      current.workspaceId !== created.workspaceId ||
      current.userId !== created.userId ||
      current.key !== created.key ||
      current.version !== created.version ||
      current.size !== created.size ||
      !Buffer.isBuffer(read.content) ||
      read.content.length !== content.length ||
      hash(read.content) !== digest
    ) {
      throw new Error('office_backup_refused')
    }
    return Object.freeze({
      status: 'stored',
      receipt: Object.freeze({
        schemaVersion: 'memlia.office-copy-storage/v1',
        workspaceId: metadata.workspaceId,
        ownerUserId: actor.userId,
        fileId: created.id,
        contentVersion: current.version,
        byteLength: content.length,
        sha256: digest,
      }),
    })
  } catch {
    return storageFailure(stage, fileId, signal instanceof AbortSignal && signal.aborted)
  }
}
