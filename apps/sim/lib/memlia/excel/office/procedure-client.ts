// Copyright (c) 2026 Memlia. All rights reserved.
import { requestJson } from '@/lib/api/client/request'
import {
  listOfficeProcedureResultsContract,
  type OfficeProcedureResult,
  officeProcedureResultSchema,
  prepareOfficeProcedureEditContract,
} from '@/lib/api/contracts/excel-office-procedures'
import { type OfficeBackupClientResult, resolveOfficeBackupEditBinding } from './backup-client'
import { OfficeEditError, type OfficeEditPreview, prepareOfficeEdit } from './edit-session'

export type { OfficeProcedureResult } from '@/lib/api/contracts/excel-office-procedures'
export class OfficeProcedureError extends Error {
  constructor(
    readonly code:
      | 'invalid_context'
      | 'result_unavailable'
      | 'proposal_mismatch'
      | 'selection_mismatch'
      | 'cancelled'
      | 'timeout'
  ) {
    super(code)
    this.name = 'OfficeProcedureError'
  }
}

/** The read-only HTTP phase owns its deadline; it never opens an Excel operation. */
async function read<T>(
  work: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let rejectStop!: (error: OfficeProcedureError) => void
  const stopped = new Promise<never>((_, reject) => {
    rejectStop = reject
  })
  const stop = (code: 'cancelled' | 'timeout') => {
    controller.abort()
    rejectStop(new OfficeProcedureError(code))
  }
  const abort = () => stop('cancelled')
  try {
    if (signal?.aborted) throw new OfficeProcedureError('cancelled')
    signal?.addEventListener('abort', abort, { once: true })
    timer = setTimeout(() => stop('timeout'), 10_000)
    const result = await Promise.race([work(controller.signal), stopped])
    if (signal?.aborted) throw new OfficeProcedureError('cancelled')
    return result
  } catch (error) {
    if (error instanceof OfficeProcedureError) throw error
    throw new OfficeProcedureError('result_unavailable')
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}

/** Only native, session-authorized past-run descriptors are offered; never draft recipes. */
export async function listOfficeProcedureResults(workspaceId: string, signal?: AbortSignal) {
  return read(
    (ownedSignal) =>
      requestJson(listOfficeProcedureResultsContract, {
        params: { id: workspaceId },
        query: {},
        signal: ownedSignal,
      }),
    signal
  )
}

/** A server proposal grants no local edit authority; the genuine backup remains mandatory. */
export async function prepareOfficeProcedureEdit(input: {
  backup: Extract<OfficeBackupClientResult, { status: 'stored' }>
  result: OfficeProcedureResult
  excel: unknown
  exclusiveLocalCopyConfirmed: boolean
  signal?: AbortSignal
}): Promise<OfficeEditPreview> {
  const { backup, excel, signal, exclusiveLocalCopyConfirmed } = input
  if (!exclusiveLocalCopyConfirmed) throw new OfficeEditError('exclusive_copy_required')
  const binding = resolveOfficeBackupEditBinding(backup)
  if (!binding || binding.excel !== excel) throw new OfficeProcedureError('invalid_context')
  const parsed = officeProcedureResultSchema.safeParse(input.result)
  if (!parsed.success) throw new OfficeProcedureError('invalid_context')
  const result = parsed.data
  const proposal = await read(
    (ownedSignal) =>
      requestJson(prepareOfficeProcedureEditContract, {
        params: { id: backup.receipt.workspaceId },
        body: { source: result, backupFileId: backup.receipt.fileId },
        signal: ownedSignal,
      }),
    signal
  )
  if (
    proposal.backupFileId !== backup.receipt.fileId ||
    JSON.stringify(proposal.source) !== JSON.stringify(result)
  )
    throw new OfficeProcedureError('proposal_mismatch')
  if (
    proposal.values.length !== binding.observation.values.length ||
    proposal.values.some((row) => row.length !== binding.observation.values[0].length)
  )
    throw new OfficeProcedureError('selection_mismatch')
  if (resolveOfficeBackupEditBinding(backup) !== binding || signal?.aborted)
    throw new OfficeProcedureError(signal?.aborted ? 'cancelled' : 'invalid_context')
  return prepareOfficeEdit({
    backup,
    excel,
    values: proposal.values,
    exclusiveLocalCopyConfirmed,
    signal,
  })
}
