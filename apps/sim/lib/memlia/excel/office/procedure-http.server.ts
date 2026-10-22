// Copyright (c) 2026 Memlia. All rights reserved.
import { ExcelProcedureSchema } from '@memlia/contracts'
import type { SessionPrincipal } from '@sim/auth/principal'
import { sha256Hex } from '@sim/security/hash'
import {
  type OfficeProcedureResult,
  officeProcedurePreviewSchema,
  officeProcedureResultSchema,
} from '@/lib/api/contracts/excel-office-procedures'
import { OrchestrationError } from '@/lib/core/orchestration/types'
import { stringifyBoundedJson } from '@/lib/core/utils/bounded-json'
import { readStreamToBufferWithLimit } from '@/lib/core/utils/stream-limits'
import { isUserFileDisplayMetadata } from '@/lib/core/utils/user-file'
import { readOfficeBackupFileRecord } from '@/lib/uploads/contexts/workspace/file-manager'
import { defineAuthorizedWorkflowUseCase } from '@/lib/workflows/application/authorized-workflow-use-case'
import { downloadWorkflowRunFileStream } from '@/lib/workflows/application/download-workflow-run-file'
import { workflowOperations } from '@/lib/workflows/application/operations'
import { readWorkflowRun } from '@/lib/workflows/application/read-workflow-run'
import { readWorkflowVersion } from '@/lib/workflows/application/read-workflow-version'
import { normalizedStringify } from '@/lib/workflows/comparison/normalize'
import {
  captureOfficeBackupSession,
  readPrivateOfficeBackup,
} from '@/lib/workspace-files/application/office-backups'
import { resolveActiveWorkspaceApplicationContext } from '@/lib/workspaces/application/context'
import {
  findOfficeProcedureCandidates,
  type OfficeProcedureCandidate,
} from './procedure-repository.server'
import { projectOfficeProcedureWorkbook } from './procedure-result.server'

const MAX_RESULT_BYTES = 7_500_000
const failed = () => new OrchestrationError('not_found', 'Office procedure result not found')
const hash = (value: unknown) => `sha256:${sha256Hex(normalizedStringify(value))}`

/** Display projection removes keys; match only a file explicitly retained in the selected block. */
function outputNamesFile(value: unknown, fileId: string): boolean {
  const queue = [value]
  for (let visited = 0; queue.length && visited < 10_000; visited++) {
    const item = queue.shift()
    if (isUserFileDisplayMetadata(item) && item.id === fileId) return true
    if (item && typeof item === 'object') queue.push(...Object.values(item))
    if (queue.length > 10_000) return false
  }
  return false
}

async function resolveCandidate(
  principal: SessionPrincipal,
  workspaceId: string,
  row: OfficeProcedureCandidate,
  signal?: AbortSignal
): Promise<OfficeProcedureResult> {
  signal?.throwIfAborted()
  if (
    !row.completedAt ||
    !row.size ||
    row.size > MAX_RESULT_BYTES ||
    !row.fileName.toLowerCase().endsWith('.xlsx') ||
    row.contentType !== 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  )
    throw failed()
  const { version } = await readWorkflowVersion.execute({
    principal,
    input: {
      workflowId: row.workflowId,
      assertedWorkspaceId: workspaceId,
      version: 'active',
      expectedDeploymentVersionId: row.deploymentVersionId,
      includeCredentialValues: true,
    },
  })
  // A test-only/inactive preparation never becomes a catalogue entry.
  if (
    !version.isActive ||
    !row.snapshotDigest ||
    stringifyBoundedJson(version.state, 2 * 1024 * 1024, { strict: true }) === undefined ||
    hash(version.state) !== row.snapshotDigest
  )
    throw failed()
  const entries = Object.entries(version.state.blocks ?? {})
  if (entries.length > 2048) throw failed()
  const excel = entries.filter(
    ([, block]) => block.type === 'memlia_excel' && block.enabled !== false
  )
  if (!excel.length || excel.length > 32) throw failed()
  const run = await readWorkflowRun.execute({
    principal,
    input: {
      workflowId: row.workflowId,
      runId: row.executionId,
      includeOutput: true,
      selectedOutputs: excel.map(([blockId]) => blockId),
    },
  })
  if (
    run.status !== 'completed' ||
    !run.files?.some((file) => file.id === row.resultFileId) ||
    !run.blockOutputs
  )
    throw failed()
  const results: OfficeProcedureResult[] = []
  for (const [blockId, block] of excel) {
    if (block.id !== blockId || block.type !== 'memlia_excel' || block.enabled === false) continue
    const request = block.subBlocks?.request
    if (
      request?.id !== 'request' ||
      request.type !== 'code' ||
      typeof request.value !== 'string' ||
      Buffer.byteLength(request.value) > 512 * 1024
    )
      continue
    let procedure: ReturnType<typeof ExcelProcedureSchema.parse>
    try {
      procedure = ExcelProcedureSchema.parse(JSON.parse(request.value).procedure)
    } catch {
      continue
    }
    const { digest, ...unsigned } = procedure
    if (
      procedure.workspaceId !== workspaceId ||
      procedure.workflowId !== row.workflowId ||
      procedure.deployedVersionId !== row.deploymentVersionId ||
      hash(unsigned) !== digest
    )
      continue
    if (!outputNamesFile(run.blockOutputs[blockId], row.resultFileId)) continue
    results.push(
      officeProcedureResultSchema.parse({
        workflowId: row.workflowId,
        workflowName: row.workflowName,
        deploymentVersionId: row.deploymentVersionId,
        blockId,
        executionId: row.executionId,
        resultFileId: row.resultFileId,
        resultContentVersion: row.contentUpdatedAt.getTime(),
        procedureName: block.name,
        fileName: row.fileName,
        completedAt: row.completedAt.toISOString(),
      })
    )
    if (results.length > 1) throw failed()
  }
  signal?.throwIfAborted()
  if (results.length !== 1) throw failed()
  return results[0]
}

const context = ({ input }: { input: { workspaceId: string } }) =>
  resolveActiveWorkspaceApplicationContext(input.workspaceId)

export const listOfficeProcedureResults = defineAuthorizedWorkflowUseCase({
  operation: workflowOperations.list,
  resolveContext: context,
  async execute({ principal: supplied, input, request }) {
    const principal = captureOfficeBackupSession(supplied)
    const workspaceId = input.workspaceId
    const rows = await findOfficeProcedureCandidates(workspaceId, principal.userId)
    const items: OfficeProcedureResult[] = []
    for (const row of rows.slice(0, 50)) {
      try {
        items.push(await resolveCandidate(principal, workspaceId, row, request?.signal))
      } catch (error) {
        request?.signal?.throwIfAborted()
        if (error instanceof OrchestrationError && ['not_found', 'forbidden'].includes(error.code))
          continue
        throw error
      }
    }
    return { items, truncated: rows.length > 50 }
  },
})

type PrepareInput = { workspaceId: string; source: OfficeProcedureResult; backupFileId: string }

export const prepareOfficeProcedureEdit = defineAuthorizedWorkflowUseCase({
  operation: workflowOperations.list,
  resolveContext: ({ input }: { input: PrepareInput }) => context({ input }),
  async execute({ principal: supplied, input, request }) {
    const principal = captureOfficeBackupSession(supplied)
    const source = officeProcedureResultSchema.parse(input.source)
    const { workspaceId, backupFileId } = input
    const signal = request?.signal
    signal?.throwIfAborted()
    const resolve = async () => {
      const rows = await findOfficeProcedureCandidates(workspaceId, principal.userId, source)
      if (rows.length !== 1) throw failed()
      const current = await resolveCandidate(principal, workspaceId, rows[0], signal)
      if (JSON.stringify(current) !== JSON.stringify(source)) throw failed()
      return rows[0]
    }
    const row = await resolve()
    // Canonical private receipt selection, followed by the full native private read/authorization.
    const backup = await readOfficeBackupFileRecord({
      id: backupFileId,
      workspaceId: workspaceId,
      userId: principal.userId,
    })
    if (!backup) throw failed()
    await readPrivateOfficeBackup(
      principal,
      { workspaceId: workspaceId, fileId: backup.id, version: backup.version },
      signal
    )
    const loaded = await downloadWorkflowRunFileStream.execute({
      principal,
      input: {
        workflowId: source.workflowId,
        runId: source.executionId,
        fileId: source.resultFileId,
      },
    })
    if (
      loaded.file.key !== row.key ||
      loaded.contentLength !== row.size ||
      loaded.contentType !== row.contentType
    ) {
      await loaded.stream.cancel().catch(() => {})
      throw failed()
    }
    const bytes = await readStreamToBufferWithLimit(loaded.stream, {
      maxBytes: MAX_RESULT_BYTES,
      label: 'Office procedure result',
      signal,
    })
    if (bytes.length !== row.size) throw failed()
    const values = projectOfficeProcedureWorkbook(bytes)
    const current = await resolve()
    if (current.key !== row.key || current.size !== row.size) throw failed()
    await readPrivateOfficeBackup(
      principal,
      { workspaceId: workspaceId, fileId: backup.id, version: backup.version },
      signal
    )
    return officeProcedurePreviewSchema.parse({
      status: 'prepared',
      source,
      backupFileId: backup.id,
      values,
    })
  },
})
