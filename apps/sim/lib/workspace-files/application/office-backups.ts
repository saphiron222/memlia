// Copyright (c) 2026 Memlia. All rights reserved.
import { type Principal, parsePrincipal, type SessionPrincipal } from '@sim/auth/principal'
import { z } from 'zod'
import { admitContent } from '@/lib/core/application'
import { OrchestrationError } from '@/lib/core/orchestration/types'
import { stringifyBoundedJson } from '@/lib/core/utils/bounded-json'
import {
  createOfficeBackupFile,
  loadActiveWorkspaceContext,
  MAX_OFFICE_BACKUP_BYTES,
  type OfficeBackupFileRecord,
  OfficeBackupStorageUnknownError,
  planOfficeBackupFileIdentity,
  readOfficeBackupFileRecord,
} from '@/lib/uploads/contexts/workspace/file-manager'
import { downloadFile } from '@/lib/uploads/core/storage-service'
import { defineAuthorizedWorkspaceFileUseCase } from './authorized-workspace-file-use-case'
import { fileOperations } from './operations'

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const workspaceSchema = z.strictObject({ workspaceId: id })
const readSchema = workspaceSchema.extend({
  fileId: id,
  version: z.int().min(0).max(8_640_000_000_000_000),
})
type ReadInput = z.infer<typeof readSchema>
type CreateInput = { workspaceId: string; content: Buffer; signal?: AbortSignal }

function closedJson(value: unknown) {
  const encoded = stringifyBoundedJson(value, 8192, { strict: true })
  if (encoded === undefined)
    throw new OrchestrationError('validation', 'Office backup input refused')
  return JSON.parse(encoded)
}

/** A copy of authenticated authority; shape validation never authenticates a caller. */
export function captureOfficeBackupSession(principal: Principal): SessionPrincipal {
  try {
    const captured = parsePrincipal({ version: 1, principal: closedJson(principal) })
    if (captured.kind !== 'session') throw new Error('unsupported')
    return Object.freeze(captured)
  } catch {
    throw new OrchestrationError('forbidden', 'Office backup requires a user session')
  }
}

export function captureOfficeBackupBytes(value: unknown): Buffer {
  if (
    !(value instanceof Uint8Array) ||
    !(value.buffer instanceof ArrayBuffer) ||
    !Number.isSafeInteger(value.byteLength) ||
    value.byteLength < 1 ||
    value.byteLength > MAX_OFFICE_BACKUP_BYTES
  ) {
    throw new OrchestrationError('validation', 'Office backup bytes refused')
  }
  return Buffer.from(value)
}

function active(signal?: AbortSignal) {
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new OrchestrationError('validation', 'Office backup signal refused')
  }
  signal?.throwIfAborted()
}

async function workspaceContext(workspaceId: string) {
  const context = await loadActiveWorkspaceContext(workspaceId)
  if (!context || context.workspaceId !== workspaceId) {
    throw new OrchestrationError('not_found', 'Workspace not found')
  }
  return context
}

function requireRecord(
  record: OfficeBackupFileRecord | null,
  principal: SessionPrincipal,
  workspaceId: string,
  fileId: string,
  version?: number
): OfficeBackupFileRecord {
  if (
    !record ||
    record.userId !== principal.userId ||
    record.workspaceId !== workspaceId ||
    record.id !== fileId ||
    record.key !== `workspace/${workspaceId}/office-backups/${fileId}.xlsx` ||
    !Number.isSafeInteger(record.version) ||
    record.version < 0 ||
    (version !== undefined && record.version !== version) ||
    !Number.isSafeInteger(record.size) ||
    record.size < 1 ||
    record.size > MAX_OFFICE_BACKUP_BYTES
  ) {
    throw new OrchestrationError('not_found', 'Office backup not found')
  }
  return Object.freeze({ ...record })
}

const create = defineAuthorizedWorkspaceFileUseCase({
  operation: fileOperations.create,
  resolveContext: ({ input }: { input: CreateInput }) => workspaceContext(input.workspaceId),
  async execute({ principal, input }): Promise<OfficeBackupFileRecord> {
    if (principal.kind !== 'session')
      throw new OrchestrationError('forbidden', 'Office backup requires a user session')
    active(input.signal)
    const identity = planOfficeBackupFileIdentity(input.workspaceId, principal.userId)
    const record = await createOfficeBackupFile({
      identity,
      content: input.content,
      signal: input.signal,
      authorizeBeforeCommit: () => create.authorize({ principal, input }),
    })
    try {
      return requireRecord(record, principal, input.workspaceId, identity.id)
    } catch {
      throw new OfficeBackupStorageUnknownError(identity)
    }
  },
})

const read = defineAuthorizedWorkspaceFileUseCase({
  operation: fileOperations.readContent,
  resolveContext: ({ input }: { input: ReadInput & { signal?: AbortSignal } }) =>
    workspaceContext(input.workspaceId),
  async execute({ principal, input }): Promise<{ file: OfficeBackupFileRecord; content: Buffer }> {
    if (principal.kind !== 'session')
      throw new OrchestrationError('forbidden', 'Office backup requires a user session')
    active(input.signal)
    const selector = { id: input.fileId, workspaceId: input.workspaceId, userId: principal.userId }
    const file = requireRecord(
      await readOfficeBackupFileRecord(selector),
      principal,
      input.workspaceId,
      input.fileId,
      input.version
    )
    await admitContent(principal, [])
    active(input.signal)
    const loaded = await downloadFile({
      key: file.key,
      context: 'workspace',
      maxBytes: MAX_OFFICE_BACKUP_BYTES,
      signal: input.signal,
    })
    if (!Buffer.isBuffer(loaded) || loaded.length !== file.size) {
      throw new OrchestrationError('conflict', 'Office backup changed')
    }
    const content = Buffer.from(loaded)
    active(input.signal)
    await read.authorize({ principal, input })
    const current = requireRecord(
      await readOfficeBackupFileRecord(selector),
      principal,
      input.workspaceId,
      input.fileId,
      file.version
    )
    active(input.signal)
    if (current.key !== file.key || current.size !== file.size) {
      throw new OrchestrationError('conflict', 'Office backup changed')
    }
    return { file, content }
  },
})

/** Session and bytes are detached before the native authorization's first await. */
export async function createPrivateOfficeBackup(
  principal: Principal,
  input: { workspaceId: string; content: Uint8Array },
  signal?: AbortSignal
): Promise<OfficeBackupFileRecord> {
  const captured = captureOfficeBackupSession(principal)
  const workspace = workspaceSchema.parse(closedJson({ workspaceId: input.workspaceId }))
  const content = captureOfficeBackupBytes(input.content)
  active(signal)
  return create.execute({ principal: captured, input: { ...workspace, content, signal } })
}

/** Dedicated private read; no generic ID/key/serve/VFS route is enabled. */
export async function readPrivateOfficeBackup(
  principal: Principal,
  input: ReadInput,
  signal?: AbortSignal
): Promise<{ file: OfficeBackupFileRecord; content: Buffer }> {
  const captured = captureOfficeBackupSession(principal)
  const fixed = readSchema.parse(closedJson(input))
  active(signal)
  return read.execute({ principal: captured, input: { ...fixed, signal } })
}
