// Copyright (c) 2026 Memlia. All rights reserved.
import type { Principal } from '@sim/auth/principal'
import { z } from 'zod'
import {
  type ExcelTestResultFile,
  readExcelTestResultsBodySchema,
  readExcelTestResultsContract,
} from '@/lib/api/contracts/excel-test-preparations'
import { OrchestrationError } from '@/lib/core/orchestration/types'
import { stringifyBoundedJson } from '@/lib/core/utils/bounded-json'
import { isUserFileDisplayMetadata } from '@/lib/core/utils/user-file'
import { getFileMetadataByKey } from '@/lib/uploads/server/metadata'
import {
  authorizeExcelTestExecution,
  readExcelTestExecutionPermit,
} from '@/lib/workflows/executor/excel-test-admission'
import { findExcelTestResultCandidates } from '@/lib/workflows/persistence/excel-test-results'
import { defineAuthorizedWorkflowUseCase } from './authorized-workflow-use-case'
import { downloadWorkflowRunFileStream } from './download-workflow-run-file'
import { workflowOperations } from './operations'
import { resolvePrincipalWorkflowContext } from './principal-scope'
import { readWorkflowRun } from './read-workflow-run'
import { readWorkflowVersion } from './read-workflow-version'

const inputSchema = z.strictObject({
  workflowId: readExcelTestResultsContract.params.shape.id,
  body: readExcelTestResultsBodySchema,
})
type Input = z.infer<typeof inputSchema>
function refused(): never {
  throw new OrchestrationError('conflict', 'excel_test_results_refused')
}
/** Projected output, not storage keys or model-supplied IDs, establishes block membership. */
function outputFileIds(value: unknown): Set<string> {
  const pending = [value]
  const found = new Set<string>()
  const seen = new WeakSet<object>()
  for (let visited = 0; pending.length && visited < 10_000; visited++) {
    const item = pending.pop()
    if (!item || typeof item !== 'object' || seen.has(item)) continue
    seen.add(item)
    if (isUserFileDisplayMetadata(item) && typeof item.id === 'string') found.add(item.id)
    else {
      const values = Object.values(item)
      if (values.length + pending.length > 10_000) refused()
      pending.push(...values)
    }
  }
  if (pending.length) refused()
  return found
}
const authorizedRead = defineAuthorizedWorkflowUseCase({
  operation: workflowOperations.runExcelTest,
  resolveContext: ({ principal, input }: { principal: Principal; input: Input }) =>
    resolvePrincipalWorkflowContext({
      principal,
      input: { workflowId: input.workflowId, assertedWorkspaceId: input.body.workspaceId },
    }),
  async execute({ principal, input, context }) {
    const body = input.body
    const authorization = {
      principal,
      input: {
        workflowId: input.workflowId,
        assertedWorkspaceId: body.workspaceId,
        binding: {
          workspaceId: body.workspaceId,
          preparation: body.preparation,
          prepared: body.prepared,
        },
      },
    }
    const permit = await authorizeExcelTestExecution(authorization)
    const binding = readExcelTestExecutionPermit(permit, {
      principal,
      userId: principal.userId,
      workflowId: context.workflowId,
      workspaceId: context.workspaceId,
    })
    const { prepared } = binding
    const { version } = await readWorkflowVersion.execute({
      principal,
      input: {
        workflowId: context.workflowId,
        assertedWorkspaceId: context.workspaceId,
        version: prepared.version,
        expectedDeploymentVersionId: prepared.deploymentVersionId,
      },
    })
    if (
      version.id !== prepared.deploymentVersionId ||
      version.version !== prepared.version ||
      version.isActive !== false ||
      version.preparationKind !== 'excel_test_v1' ||
      version.createdBy !== principal.userId ||
      version.snapshotDigest !== prepared.snapshotDigest
    )
      refused()
    const blocks = Object.entries(version.state.blocks ?? {})
    if (blocks.length > 2048) refused()
    const excelIds = blocks
      .filter(
        ([id, block]) => id === block.id && block.type === 'memlia_excel' && block.enabled !== false
      )
      .map(([id]) => id)
    if (excelIds.length < 1 || excelIds.length > 32) refused()
    const run = await readWorkflowRun.execute({
      principal,
      input: {
        workflowId: context.workflowId,
        runId: body.executionId,
        includeOutput: true,
        selectedOutputs: excelIds,
      },
    })
    if (run.status !== 'completed') refused()
    // logs.trace_spans withholding remains authoritative. No metadata discovery in that case.
    const outputIds =
      run.files && run.blockOutputs
        ? outputFileIds(excelIds.map((id) => run.blockOutputs?.[id]))
        : new Set<string>()
    const recordedIds = new Set(run.files?.map((file) => file.id) ?? [])
    const rows =
      run.files && run.blockOutputs
        ? await findExcelTestResultCandidates({
            workspaceId: context.workspaceId,
            userId: principal.userId,
            workflowId: context.workflowId,
            executionId: body.executionId,
            deploymentVersionId: prepared.deploymentVersionId,
            snapshotDigest: prepared.snapshotDigest,
          })
        : []
    if (rows.length > 51 || new Set(rows.map((row) => row.resultFileId)).size !== rows.length)
      refused()
    const items: ExcelTestResultFile[] = []
    const prefix = `execution/${context.workspaceId}/${context.workflowId}/${body.executionId}/`
    for (const row of rows) {
      if (
        row.workflowId !== context.workflowId ||
        row.workspaceId !== context.workspaceId ||
        row.executionId !== body.executionId ||
        row.deploymentVersionId !== prepared.deploymentVersionId ||
        row.snapshotDigest !== prepared.snapshotDigest ||
        !row.key.startsWith(prefix) ||
        !row.completedAt
      )
        refused()
    }
    for (const row of rows.slice(0, 50)) {
      if (!recordedIds.has(row.resultFileId) || !outputIds.has(row.resultFileId)) continue
      if (
        !row.fileName.toLowerCase().endsWith('.xlsx') ||
        row.contentType !== 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      )
        continue
      // Execution files deliberately do not enter the generic Files reader. Resolve
      // the addressed sub-file under the run's own native authorization, then use
      // the canonical execution metadata. Byte admission belongs to the separate
      // download use case, which executes the native run-file reader.
      await downloadWorkflowRunFileStream.authorize({
        principal,
        input: {
          workflowId: context.workflowId,
          runId: body.executionId,
          fileId: row.resultFileId,
        },
      })
      const file = await getFileMetadataByKey(row.key, 'execution')
      if (
        !file ||
        file.id !== row.resultFileId ||
        file.workspaceId !== context.workspaceId ||
        file.userId !== principal.userId ||
        file.context !== 'execution' ||
        file.projectId !== null ||
        file.organizationId !== null ||
        file.deletedAt ||
        file.key !== row.key ||
        file.originalName !== row.fileName ||
        file.sizeBytes !== row.size ||
        file.contentType !== row.contentType ||
        !(file.contentUpdatedAt instanceof Date) ||
        !(row.contentUpdatedAt instanceof Date) ||
        file.contentUpdatedAt.getTime() !== row.contentUpdatedAt.getTime()
      )
        refused()
      items.push({
        resultFileId: row.resultFileId,
        fileName: row.fileName,
        size: row.size,
        contentType: row.contentType,
        resultContentVersion: row.contentUpdatedAt.getTime(),
      })
    }
    // No cached receipt survives a concurrent draft, permission or activation change.
    await authorizeExcelTestExecution(authorization)
    return readExcelTestResultsContract.response.schema.parse({
      status: 'completed',
      workflowId: context.workflowId,
      executionId: body.executionId,
      deploymentVersionId: prepared.deploymentVersionId,
      snapshotDigest: prepared.snapshotDigest,
      items,
      truncated: rows.length > 50,
    })
  },
})
export const readExcelTestResults = {
  ...authorizedRead,
  async execute({
    principal,
    input,
  }: {
    principal: Principal
    input: { workflowId: string; body: unknown }
  }) {
    const text = stringifyBoundedJson(input, 20000, { strict: true })
    if (text === undefined) throw new OrchestrationError('validation', 'excel_test_results_invalid')
    const parsed = inputSchema.safeParse(JSON.parse(text))
    if (!parsed.success) throw new OrchestrationError('validation', 'excel_test_results_invalid')
    return authorizedRead.execute({ principal: structuredClone(principal), input: parsed.data })
  },
}
