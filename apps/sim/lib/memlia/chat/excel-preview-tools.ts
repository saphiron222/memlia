// Copyright (c) 2026 Memlia. All rights reserved.

import { ExcelProcedureSchema } from '@memlia/contracts'
import { parsePrincipal, type SessionPrincipal } from '@sim/auth/principal'
import { db } from '@sim/db'
import { z } from 'zod'
import { stringifyBoundedJson } from '@/lib/core/utils/bounded-json'
import { waitWithAbort } from '@/lib/core/utils/concurrency'
import { assertWorkspaceCapability } from '@/lib/permission-groups/capability-assertions'
import { defineAuthorizedWorkflowUseCase } from '@/lib/workflows/application/authorized-workflow-use-case'
import { workflowOperations } from '@/lib/workflows/application/operations'
import { resolvePrincipalWorkflowContext } from '@/lib/workflows/application/principal-scope'
import { inspectSelectedExcelFiles } from '../excel/application/selected-files'
import {
  describeExcelProcedureProfile,
  excelProcedureDraftSchema,
  inspectExcelProcedureDraftCapabilities,
} from '../excel/procedure-capabilities'
import { validateExcelProcedureDraftDataflow } from '../excel/procedure-dataflow'
import { selectedExcelFileIdsSchema } from '../excel/selected-files'

export const excelPreviewInputs = Object.freeze({
  excel_describe_capabilities: z.object({}).strict(),
  excel_preview_procedure: z.object({ request: excelProcedureDraftSchema }).strict(),
  excel_inspect_selected_files: z.object({}).strict(),
})
type Context = {
  principal: SessionPrincipal
  workspaceId: string
  workflowId: string
  excelFileIds?: string[]
}
const scopeSchema = z
  .object({
    principal: z.unknown(),
    workspaceId: ExcelProcedureSchema.shape.workspaceId,
    workflowId: ExcelProcedureSchema.shape.workflowId,
    excelFileIds: selectedExcelFileIdsSchema.optional(),
  })
  .strict()
const failure = (
  code: 'invalid_input' | 'tool_not_allowed' | 'unavailable' | 'cancelled' | 'result_too_large'
) => ({ ok: false as const, error: { code, message: 'Excel analysis is unavailable.' } })
const observation = {
  analysis: 'declarative_draft' as const,
  executionAvailable: false as const,
  persisted: false as const,
}

// No graph/credentials loaded. The native operation resolves the current workflow and role.
const authorizeAnalysis = defineAuthorizedWorkflowUseCase({
  operation: workflowOperations.read,
  resolveContext: resolvePrincipalWorkflowContext<{
    workflowId: string
    assertedWorkspaceId: string
  }>,
  async execute({ principal, input, context }) {
    if (
      principal.kind !== 'session' ||
      context.workflowId !== input.workflowId ||
      context.workspaceId !== input.assertedWorkspaceId
    )
      throw new Error('Excel analysis is unavailable.')
    // Explicit native executor bypasses the request memo on every tool invocation.
    await assertWorkspaceCapability(
      principal.userId,
      context.workspaceId,
      'copilot.use',
      context.workspaceOrganizationId,
      db
    )
  },
})

/** Server-bound observation only; a typed principal is not authentication. */
export function createExcelPreviewTools(raw: Context) {
  const json = stringifyBoundedJson(raw, 4096, { strict: true })
  if (json === undefined) throw new Error('Excel analysis is unavailable.')
  let scope: Context
  try {
    const captured = scopeSchema.parse(JSON.parse(json))
    const principal = parsePrincipal({ version: 1, principal: captured.principal })
    if (principal.kind !== 'session') throw new Error()
    scope = { ...captured, principal }
  } catch {
    throw new Error('Excel analysis is unavailable.')
  }

  return {
    async dispatch(toolId: string, input: unknown, signal?: AbortSignal) {
      try {
        signal?.throwIfAborted()
        if (
          toolId !== 'excel_describe_capabilities' &&
          toolId !== 'excel_preview_procedure' &&
          toolId !== 'excel_inspect_selected_files'
        )
          return failure('tool_not_allowed')
        // Own the complete bounded wrapper before any authorization await. No Zod default/coercion.
        const captured = stringifyBoundedJson(input, 512 * 1024, { strict: true })
        if (captured === undefined) return failure('invalid_input')
        const parsed = excelPreviewInputs[toolId].safeParse(JSON.parse(captured))
        if (!parsed.success) return failure('invalid_input')
        await waitWithAbort(
          authorizeAnalysis.execute({
            principal: scope.principal,
            input: { workflowId: scope.workflowId, assertedWorkspaceId: scope.workspaceId },
          }),
          signal
        )
        signal?.throwIfAborted()
        if (toolId === 'excel_inspect_selected_files') {
          if (!scope.excelFileIds?.length) return failure('unavailable')
          const data = await inspectSelectedExcelFiles(
            {
              principal: scope.principal,
              workspaceId: scope.workspaceId,
              fileIds: scope.excelFileIds,
            },
            signal
          )
          signal?.throwIfAborted()
          return { ok: true as const, data }
        }
        const data =
          'request' in parsed.data
            ? {
                ...observation,
                capabilities: inspectExcelProcedureDraftCapabilities(parsed.data.request),
                dataflow: validateExcelProcedureDraftDataflow(parsed.data.request),
              }
            : {
                ...observation,
                profile: describeExcelProcedureProfile(),
                notVerified: [
                  'input_data',
                  'bindings_and_authority',
                  'business_controls',
                  'publication',
                  'isolated_execution',
                ],
              }
        const output = stringifyBoundedJson(data, 256 * 1024, { strict: true })
        if (output === undefined) return failure('result_too_large')
        signal?.throwIfAborted()
        return { ok: true as const, data }
      } catch {
        return failure(signal?.aborted ? 'cancelled' : 'unavailable')
      }
    },
  }
}
