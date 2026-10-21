// Copyright (c) 2026 Memlia. All rights reserved.
import { z } from 'zod'
import { noInputSchema, workspaceIdSchema } from '@/lib/api/contracts/primitives'
import { defineRouteContract } from '@/lib/api/contracts/types'
import { isJsonWithinByteLimit } from '@/lib/core/utils/bounded-json'

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}(?![\s\S])/)
export const officeProcedureResultSchema = z.strictObject({
  workflowId: id,
  deploymentVersionId: id,
  blockId: id,
  executionId: id,
  resultFileId: id,
  resultContentVersion: z.int().min(0).max(8_640_000_000_000_000),
  workflowName: z.string().min(1).max(256),
  procedureName: z.string().min(1).max(256),
  fileName: z.string().min(1).max(256),
  completedAt: z.iso.datetime({ precision: 3 }),
})
export type OfficeProcedureResult = z.infer<typeof officeProcedureResultSchema>

export const MAX_OFFICE_PROCEDURE_CELLS = 10_000
export const MAX_OFFICE_PROCEDURE_JSON_BYTES = 1_048_576
const scalar = z.union([z.string().max(32_767), z.number().finite(), z.boolean(), z.null()])
const matrix = z
  .array(z.array(scalar).min(1).max(MAX_OFFICE_PROCEDURE_CELLS))
  .min(1)
  .max(MAX_OFFICE_PROCEDURE_CELLS)
  .refine(
    (rows) =>
      rows.length > 0 &&
      rows[0].length > 0 &&
      rows.length * rows[0].length <= MAX_OFFICE_PROCEDURE_CELLS &&
      rows.every((row) => row.length === rows[0].length),
    'Rectangular bounded scalar matrix required'
  )

/** Values are a proposal from a past run, never formulas or permission to mutate a workbook. */
export const officeProcedurePreviewSchema = z
  .strictObject({
    status: z.literal('prepared'),
    source: officeProcedureResultSchema,
    backupFileId: id,
    values: matrix,
  })
  .refine(
    (value) => isJsonWithinByteLimit(value, MAX_OFFICE_PROCEDURE_JSON_BYTES),
    'Office proposal response exceeds the transport limit'
  )
export type OfficeProcedurePreview = z.infer<typeof officeProcedurePreviewSchema>

export const listOfficeProcedureResultsContract = defineRouteContract({
  method: 'GET',
  path: '/api/workspaces/[id]/excel/office-procedures',
  params: z.strictObject({ id: workspaceIdSchema }),
  query: noInputSchema,
  response: {
    mode: 'json',
    schema: z.strictObject({
      items: z.array(officeProcedureResultSchema).max(50),
      truncated: z.boolean(),
    }),
  },
})

export const prepareOfficeProcedureEditContract = defineRouteContract({
  method: 'POST',
  path: '/api/workspaces/[id]/excel/office-procedure-preview',
  params: z.strictObject({ id: workspaceIdSchema }),
  body: z.strictObject({ source: officeProcedureResultSchema, backupFileId: id }),
  response: { mode: 'json', schema: officeProcedurePreviewSchema },
})
