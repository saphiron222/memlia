// Copyright (c) 2026 Memlia. All rights reserved.
import { ApiClientError } from '@/lib/api/client/errors'
import { requestJson } from '@/lib/api/client/request'
import {
  MAX_OFFICE_BACKUP_HTTP_COPY_BYTES,
  type OfficeBackupResponse,
  officeBackupBodySchema,
  storeOfficeBackupContract,
} from '@/lib/api/contracts/excel-office-backups'
import { copyOfficeCompressedFile, OfficeCompressedCopyError } from './compressed-copy'
import { type OfficePreflight, preflightOffice, resolveOfficeDocument } from './preflight'
import { type OfficeRangeObservation, readOfficeRange, readSelectedOfficeRange } from './read-scope'

export type OfficeBackupPhase = 'preflight' | 'copy' | 'storing'
export type OfficeBackupClientResult =
  | Extract<OfficeBackupResponse, { status: 'stored' }>
  | {
      status: 'refused'
      code:
        | 'invalid_context'
        | 'copy_refused'
        | 'copy_too_large'
        | 'cancelled'
        | 'storage_refused'
        | 'authentication_required'
      fileId: null
    }
  | {
      status: 'unconfirmed'
      code:
        | 'copy_unconfirmed'
        | 'response_unknown'
        | 'receipt_mismatch'
        | 'storage_unconfirmed'
        | 'selection_changed'
      fileId: string | null
    }

export interface OfficeBackupClientInput {
  office: unknown
  workspaceId: string
  /** Taken from the current Better Auth session; never sent as client authority. */
  expectedUserId: string
  signal?: AbortSignal
  onPhase?: (phase: OfficeBackupPhase) => void
  /** Opt in to a local selection binding; no serialized receipt grants edit authority. */
  editSelection?: { excel: unknown }
}

type EditBinding = Readonly<{
  scope: OfficePreflight
  observation: OfficeRangeObservation
  excel: object
  run: unknown
}>
const editBindings = new WeakMap<object, EditBinding>()

/** Internal capability lookup. A copied receipt has no binding. */
export function resolveOfficeBackupEditBinding(backup: unknown): EditBinding | null {
  if (backup === null || typeof backup !== 'object') return null
  const binding = editBindings.get(backup)
  if (!binding) return null
  try {
    resolveOfficeDocument(binding.scope)
    if (Reflect.get(binding.excel, 'run') !== binding.run) return null
    return binding
  } catch {
    return null
  }
}

function base64(bytes: Uint8Array): string {
  const chunks: string[] = []
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32_768)))
  }
  return btoa(chunks.join(''))
}

/** One explicit capture/upload, with no retry. A receipt grants no Excel mutation authority. */
export async function backupCurrentOfficeWorkbook(
  input: OfficeBackupClientInput
): Promise<OfficeBackupClientResult> {
  const { office, workspaceId, expectedUserId, signal, onPhase } = input
  const selectionRequested = input.editSelection !== undefined
  const excel = input.editSelection?.excel
  let sending = false
  let storedFileId: string | null = null
  try {
    if (
      !storeOfficeBackupContract.params?.safeParse({ id: workspaceId }).success ||
      !/^[A-Za-z0-9_-]{1,128}(?![\s\S])/.test(expectedUserId)
    ) {
      return { status: 'refused', code: 'invalid_context', fileId: null }
    }
    signal?.throwIfAborted()
    onPhase?.('preflight')
    const scope = await preflightOffice(office, signal)
    const observation = selectionRequested
      ? await readSelectedOfficeRange(scope, excel, signal)
      : null
    const run =
      observation && excel !== null && typeof excel === 'object'
        ? Reflect.get(excel, 'run')
        : undefined
    onPhase?.('copy')
    const copy = await copyOfficeCompressedFile(scope, signal)
    if (copy.byteLength > MAX_OFFICE_BACKUP_HTTP_COPY_BYTES) {
      return { status: 'refused', code: 'copy_too_large', fileId: null }
    }
    // Own the bytes throughout hashing and serialization, rather than trust a mutable view.
    const content = new Uint8Array(copy.bytes)
    const hash = await crypto.subtle.digest('SHA-256', content)
    const digest = `sha256:${Array.from(new Uint8Array(hash), (n) => n.toString(16).padStart(2, '0')).join('')}`
    const body = officeBackupBodySchema.parse({ copyVersion: 1, contentBase64: base64(content) })
    signal?.throwIfAborted()
    onPhase?.('storing')
    sending = true
    const result = await requestJson(storeOfficeBackupContract, {
      params: { id: workspaceId },
      query: {},
      body,
      signal,
    })
    if (result.status === 'stored') {
      const receipt = result.receipt
      if (
        receipt.workspaceId !== workspaceId ||
        receipt.ownerUserId !== expectedUserId ||
        receipt.byteLength !== content.length ||
        receipt.sha256 !== digest
      ) {
        return { status: 'unconfirmed', code: 'receipt_mismatch', fileId: receipt.fileId }
      }
      storedFileId = receipt.fileId
      const stored = Object.freeze({ ...result, receipt: Object.freeze({ ...receipt }) })
      if (observation) {
        const { sheetId, startRow, endRow, startColumn, endColumn } = observation.range
        const after = await readOfficeRange(
          scope,
          excel,
          { sheetId, startRow, endRow, startColumn, endColumn },
          signal
        )
        resolveOfficeDocument(scope)
        if (
          JSON.stringify(after) !== JSON.stringify(observation) ||
          excel === null ||
          typeof excel !== 'object' ||
          Reflect.get(excel, 'run') !== run
        ) {
          return { status: 'unconfirmed', code: 'selection_changed', fileId: receipt.fileId }
        }
        editBindings.set(stored, Object.freeze({ scope, observation, excel, run }))
      }
      return stored
    }
    if (
      result.status === 'refused' &&
      result.stage === 'before_creation' &&
      result.fileId === null
    ) {
      return { status: 'refused', code: 'storage_refused', fileId: null }
    }
    return { status: 'unconfirmed', code: 'storage_unconfirmed', fileId: result.fileId }
  } catch (error) {
    if (storedFileId !== null) {
      return { status: 'unconfirmed', code: 'selection_changed', fileId: storedFileId }
    }
    if (sending) {
      // A network/parse/abort failure after dispatch cannot establish whether storage happened.
      if (error instanceof ApiClientError && error.status === 401) {
        return { status: 'refused', code: 'authentication_required', fileId: null }
      }
      return { status: 'unconfirmed', code: 'response_unknown', fileId: null }
    }
    if (
      error instanceof OfficeCompressedCopyError &&
      error.closure !== 'confirmed' &&
      error.closure !== 'not_opened'
    ) {
      return { status: 'unconfirmed', code: 'copy_unconfirmed', fileId: null }
    }
    return { status: 'refused', code: signal?.aborted ? 'cancelled' : 'copy_refused', fileId: null }
  }
}
