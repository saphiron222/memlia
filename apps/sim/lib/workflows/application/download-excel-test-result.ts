// Copyright (c) 2026 Memlia. All rights reserved.
import type { Principal } from '@sim/auth/principal'
import { z } from 'zod'
import {
  downloadExcelTestResultContract,
  type ExcelTestResultFile,
  readExcelTestResultsContract,
} from '@/lib/api/contracts/excel-test-preparations'
import {
  OrchestrationError,
  type OrchestrationRequestContext,
} from '@/lib/core/orchestration/types'
import { stringifyBoundedJson } from '@/lib/core/utils/bounded-json'
import { readStreamToBufferWithLimit } from '@/lib/core/utils/stream-limits'
import { getFileMetadataByKey } from '@/lib/uploads/server/metadata'
import { MAX_BUFFERED_TRANSFER_BYTES } from '@/lib/uploads/shared/types'
import { defineAuthorizedWorkflowUseCase } from './authorized-workflow-use-case'
import { downloadWorkflowRunFileStream } from './download-workflow-run-file'
import { workflowOperations } from './operations'
import { resolvePrincipalWorkflowContext } from './principal-scope'
import { readExcelTestResults } from './read-excel-test-results'

const inputSchema = z.strictObject({
  workflowId: downloadExcelTestResultContract.params.shape.id,
  body: downloadExcelTestResultContract.body,
})
type Input = z.infer<typeof inputSchema>
function refused(): never {
  throw new OrchestrationError('conflict', 'excel_test_result_download_refused')
}
const same = (a: ExcelTestResultFile, b: ExcelTestResultFile) =>
  a.resultFileId === b.resultFileId &&
  a.fileName === b.fileName &&
  a.size === b.size &&
  a.contentType === b.contentType &&
  a.resultContentVersion === b.resultContentVersion
const authorizedDownload = defineAuthorizedWorkflowUseCase({
  operation: workflowOperations.runExcelTest,
  resolveContext: ({ principal, input }: { principal: Principal; input: Input }) =>
    resolvePrincipalWorkflowContext({
      principal,
      input: { workflowId: input.workflowId, assertedWorkspaceId: input.body.workspaceId },
    }),
  async execute({ principal, input, context, request }) {
    request?.signal?.throwIfAborted()
    const { expected, ...body } = input.body
    const observe = async () => {
      const result = readExcelTestResultsContract.response.schema.parse(
        await readExcelTestResults.execute({
          principal,
          input: { workflowId: context.workflowId, body },
        })
      )
      const matches = result.items.filter((item) => same(item, expected))
      if (
        result.workflowId !== context.workflowId ||
        result.executionId !== body.executionId ||
        result.deploymentVersionId !== body.prepared.deploymentVersionId ||
        result.snapshotDigest !== body.prepared.snapshotDigest ||
        matches.length !== 1
      )
        refused()
    }
    await observe()
    request?.signal?.throwIfAborted()
    // execute, not authorize: this resolves the recorded key and admits the actual byte delivery.
    const loaded = await downloadWorkflowRunFileStream.execute({
      principal,
      input: {
        workflowId: context.workflowId,
        runId: body.executionId,
        fileId: expected.resultFileId,
      },
    })
    try {
      request?.signal?.throwIfAborted()
      if (
        loaded.file.id !== expected.resultFileId ||
        loaded.file.name !== expected.fileName ||
        loaded.file.size !== expected.size ||
        loaded.file.type !== expected.contentType ||
        loaded.contentLength !== expected.size ||
        loaded.contentType !== expected.contentType ||
        !loaded.file.key.startsWith(
          `execution/${context.workspaceId}/${context.workflowId}/${body.executionId}/`
        )
      )
        refused()
      const current = await getFileMetadataByKey(loaded.file.key, 'execution')
      if (
        !current ||
        current.id !== expected.resultFileId ||
        current.workspaceId !== context.workspaceId ||
        current.userId !== principal.userId ||
        current.context !== 'execution' ||
        current.projectId !== null ||
        current.organizationId !== null ||
        current.deletedAt ||
        current.key !== loaded.file.key ||
        current.originalName !== expected.fileName ||
        current.contentType !== expected.contentType ||
        current.sizeBytes !== expected.size ||
        !(current.contentUpdatedAt instanceof Date) ||
        current.contentUpdatedAt.getTime() !== expected.resultContentVersion
      )
        refused()
      const bytes = await readStreamToBufferWithLimit(loaded.stream, {
        maxBytes: Math.min(expected.size, MAX_BUFFERED_TRANSFER_BYTES),
        label: 'Excel test result',
        signal: request?.signal,
      })
      if (bytes.length !== expected.size) refused()
      await observe()
      request?.signal?.throwIfAborted()
      return { bytes: new Uint8Array(bytes), file: expected }
    } finally {
      // The bounded reader releases its lock even on overflow/abort; cancel an
      // unopened or rejected stream too. No stream survives a refusal here.
      if (!loaded.stream.locked) await loaded.stream.cancel().catch(() => {})
    }
  },
})
export const downloadExcelTestResult = {
  ...authorizedDownload,
  async execute({
    principal,
    input,
    request,
  }: {
    principal: Principal
    input: { workflowId: string; body: unknown }
    request?: OrchestrationRequestContext
  }) {
    const text = stringifyBoundedJson(input, 20000, { strict: true })
    if (text === undefined)
      throw new OrchestrationError('validation', 'excel_test_result_download_invalid')
    const parsed = inputSchema.safeParse(JSON.parse(text))
    if (!parsed.success)
      throw new OrchestrationError('validation', 'excel_test_result_download_invalid')
    return authorizedDownload.execute({
      principal: structuredClone(principal),
      input: parsed.data,
      request,
    })
  },
}
