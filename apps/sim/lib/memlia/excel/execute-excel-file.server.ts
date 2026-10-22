// Copyright (c) 2026 Memlia. All rights reserved.
import { createHash } from 'node:crypto'
import { ExcelProcedureSchema } from '@memlia/contracts'
import {
  parsePrincipal,
  requirePrincipalSubjectUserId,
  serializePrincipal,
} from '@sim/auth/principal'
import { z } from 'zod'
import { stringifyBoundedJson } from '@/lib/core/utils/bounded-json'
import { type ExcelHostRuntime, prepareExcelThroughHost } from '@/lib/execution/sandbox/excel-host'
import { createExecutorPrincipalFromExecutionContext } from '@/lib/internal/principals/executor'
import { createInternalToolFileResult } from '@/lib/internal/tool-operations/file-result'
import { bindInternalToolFilePublication } from '@/lib/internal/tool-operations/file-result.server'
import type { InternalToolOperationContext } from '@/lib/internal/tool-operations/types'
import {
  mergeWorkspaceFileSecretProvenance,
  type WorkspaceFileSecretProvenance,
} from '@/lib/uploads/contexts/workspace/file-secret-provenance'
import { resolveActiveWorkflowApplicationContext } from '@/lib/workflows/application/context'
import { WORKSPACE_FILES_DELEGATION_AUDIENCE } from '@/lib/workspace-files/application/authorization'
import { readWorkspaceFileContent } from '@/lib/workspace-files/application/read-workspace-file-content'

const MAX_BYTES = 10_000_000
const text = z.string().min(1).max(128)
const inputSchema = z.strictObject({
  procedure: ExcelProcedureSchema,
  sources: z.record(text, z.strictObject({ fileId: text, sheetName: text })),
  output: z.strictObject({
    sheetName: text,
    fileName: z.string().regex(/^[^\\/\x00-\x1f]{1,120}\.xlsx$/),
  }),
})
function refuse(): never {
  throw new Error('excel_file_refused')
}
function copy<T>(value: T, limit = 512 * 1024): T {
  const encoded = stringifyBoundedJson(value, limit, { strict: true })
  if (encoded === undefined) refuse()
  return JSON.parse(encoded)
}
function hash(bytes: Buffer) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}
function field<T extends object, K extends keyof T>(value: T, key: K): T[K] | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (descriptor && !('value' in descriptor)) refuse()
  return descriptor?.value
}
function scope(context: InternalToolOperationContext) {
  if (field(context, 'copilotToolExecution')) refuse()
  return {
    workspaceId: text.parse(field(context, 'workspaceId')),
    workflowId: text.parse(field(context, 'workflowId')),
    executionId: text.parse(field(context, 'executionId')),
    userId: text.parse(field(context, 'userId')),
  }
}

function captureContext(context: InternalToolOperationContext) {
  const fixed = scope(context)
  const suppliedOrigin = field(context, 'executorDelegationOrigin')
  if (!suppliedOrigin) refuse()
  const principal = field(suppliedOrigin, 'principal')
  const currentWorkflow = field(suppliedOrigin, 'currentWorkflow')
  if (!principal) refuse()
  const origin = {
    workflowId: text.parse(field(suppliedOrigin, 'workflowId')),
    executionId: text.parse(field(suppliedOrigin, 'executionId')),
    ...(field(suppliedOrigin, 'subjectUserId') === undefined
      ? {}
      : { subjectUserId: text.parse(field(suppliedOrigin, 'subjectUserId')) }),
    principal: parsePrincipal(copy(serializePrincipal(principal))),
    ...(currentWorkflow ? { currentWorkflow: copy(currentWorkflow) } : {}),
  }
  if (
    origin.executionId !== fixed.executionId ||
    (!origin.currentWorkflow && origin.workflowId !== fixed.workflowId)
  )
    refuse()
  if (origin.currentWorkflow && origin.currentWorkflow.workflowId !== fixed.workflowId) refuse()
  const trusted: InternalToolOperationContext = { ...fixed, executorDelegationOrigin: origin }
  const identity = JSON.stringify({
    ...fixed,
    origin: { ...origin, principal: serializePrincipal(origin.principal) },
  })
  return { trusted, fixed, identity }
}

/** Trusted worker composition. Procedure metadata and bindings never grant file access. */
export async function executeExcelFile(
  input: unknown,
  context: InternalToolOperationContext,
  runtime: ExcelHostRuntime,
  signal?: AbortSignal
) {
  try {
    const data = inputSchema.parse(copy(input))
    const { trusted, fixed, identity } = captureContext(context)
    const operator = copy(runtime, 8192)
    if (signal !== undefined && !(signal instanceof AbortSignal)) refuse()
    const active = (otherSignal?: AbortSignal) => {
      signal?.throwIfAborted()
      otherSignal?.throwIfAborted()
    }
    active()
    const procedure = data.procedure
    if (procedure.workspaceId !== fixed.workspaceId || procedure.workflowId !== fixed.workflowId)
      refuse()
    if (
      procedure.outputs.length !== 1 ||
      procedure.writes.length !== 1 ||
      procedure.outputs[0].format !== 'xlsx'
    )
      refuse()
    const output = procedure.outputs[0]
    const write = procedure.writes[0]
    if (
      write.mode !== 'regenerate_owned_zone' ||
      write.destinationBindingId !== output.bindingId ||
      procedure.inputs.some((item) => item.bindingId === output.bindingId)
    )
      refuse()
    if (
      Object.keys(data.sources).length !== procedure.inputs.length ||
      new Set(procedure.inputs.map((item) => item.role)).size !== procedure.inputs.length
    )
      refuse()
    for (const item of procedure.inputs) {
      if (
        !Object.hasOwn(data.sources, item.role) ||
        item.format !== 'xlsx' ||
        item.cardinality !== 'one'
      )
        refuse()
    }
    async function authorize() {
      active()
      const principal = await createExecutorPrincipalFromExecutionContext({
        context: trusted,
        audience: WORKSPACE_FILES_DELEGATION_AUDIENCE,
      })
      active()
      if (
        principal.workspaceId !== fixed.workspaceId ||
        requirePrincipalSubjectUserId(principal) !== fixed.userId
      )
        refuse()
      const canonical = await resolveActiveWorkflowApplicationContext({
        workflowId: fixed.workflowId,
        assertedWorkspaceId: fixed.workspaceId,
      })
      active()
      if (
        canonical.workspaceId !== fixed.workspaceId ||
        canonical.workspaceOrganizationId !== procedure.organizationId
      )
        refuse()
      return principal
    }
    async function readSources() {
      const principal = await authorize()
      const sources: Record<
        string,
        {
          bindingId: string
          sheetId: string
          sheetName: string
          contentBase64: string
          sha256: string
        }
      > = {}
      const identities: unknown[] = []
      const classifications: WorkspaceFileSecretProvenance[] = []
      let bytes = 0
      for (const item of procedure.inputs) {
        active()
        const selected = data.sources[item.role]
        const loaded = await readWorkspaceFileContent.execute({
          principal,
          input: {
            fileId: selected.fileId,
            assertedWorkspaceId: fixed.workspaceId,
            maxBytes: MAX_BYTES,
            includeSecretProvenance: true,
          },
        })
        active()
        const file = loaded.file
        if (
          file.id !== selected.fileId ||
          file.workspaceId !== fixed.workspaceId ||
          !(file.contentUpdatedAt instanceof Date) ||
          !Number.isFinite(file.contentUpdatedAt.getTime()) ||
          !Buffer.isBuffer(loaded.content)
        )
          refuse()
        const content = Buffer.from(loaded.content)
        bytes += content.length
        if (!content.length || bytes > MAX_BYTES) refuse()
        const provenance = copy(loaded.secretProvenance)
        if (!provenance || !['exact', 'unrecorded'].includes(provenance.status)) refuse()
        classifications.push(provenance)
        identities.push({
          id: file.id,
          workspaceId: file.workspaceId,
          key: file.key,
          storageContext: file.storageContext ?? 'workspace',
          version: file.contentUpdatedAt.getTime(),
          sha256: hash(content),
          provenance,
        })
        sources[item.role] = {
          bindingId: item.bindingId,
          sheetId: item.sheetId,
          sheetName: selected.sheetName,
          contentBase64: content.toString('base64'),
          sha256: hash(content),
        }
      }
      const provenance = mergeWorkspaceFileSecretProvenance(...classifications)
      if (provenance.status === 'unknown') refuse()
      return { sources, identity: JSON.stringify(identities), provenance }
    }
    const initial = await readSources()
    active()
    const prepared = await prepareExcelThroughHost(
      {
        procedure,
        sources: initial.sources,
        targets: {
          [output.role]: {
            bindingId: output.bindingId,
            sheetId: write.range.sheetId,
            sheetName: data.output.sheetName,
          },
        },
      },
      operator,
      { signal }
    )
    active()
    if (prepared.outputs.length !== 1) refuse()
    const result = prepared.outputs[0]
    if (
      result.role !== output.role ||
      result.bindingId !== output.bindingId ||
      result.sheetId !== write.range.sheetId ||
      !Buffer.isBuffer(result.content) ||
      hash(result.content) !== result.sha256
    )
      refuse()
    const fileResult = createInternalToolFileResult(
      {
        buffer: result.content,
        name: data.output.fileName,
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
      (file) => ({ success: true, output: { file } })
    )
    return bindInternalToolFilePublication(
      fileResult,
      initial.provenance,
      async (publishingContext, publishingSignal) => {
        try {
          active(publishingSignal)
          if (captureContext(publishingContext).identity !== identity) refuse()
          const current = await readSources()
          active(publishingSignal)
          if (current.identity !== initial.identity) refuse()
        } catch {
          refuse()
        }
      }
    )
  } catch {
    refuse()
  }
}
