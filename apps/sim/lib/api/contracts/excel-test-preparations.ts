// Copyright (c) 2026 Memlia. All rights reserved.
import { ExcelProcedureSchema } from '@memlia/contracts'
import { z } from 'zod'
import { defineRouteContract } from '@/lib/api/contracts/types'

const shape = ExcelProcedureSchema.shape
const revision = z.int().min(0).max(Number.MAX_SAFE_INTEGER)
export const excelTestPreparationBodySchema = z.strictObject({
  expectedRevision: revision,
  expectedStateDigest: shape.digest,
  operationId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+(?![\s\S])/),
  previousTestVersionId: shape.deployedVersionId.optional(),
})
export const excelTestPreparationQuerySchema = z.strictObject({ workspaceId: shape.workspaceId })
export const excelTestPreparationObservationSchema = z.strictObject({
  workflowId: shape.workflowId,
  workspaceId: shape.workspaceId,
  expectedRevision: revision,
  expectedStateDigest: shape.digest,
})
export const excelTestPreparationReceiptSchema = z.strictObject({
  status: z.literal('prepared_for_test'),
  workflowId: shape.workflowId,
  deploymentVersionId: shape.deployedVersionId,
  version: z.int().min(1).max(Number.MAX_SAFE_INTEGER),
  snapshotDigest: shape.digest,
  executionAvailable: z.literal(false),
  activationAvailable: z.literal(false),
})
const params = z.strictObject({ id: shape.workflowId })
export const observeExcelTestPreparationContract = defineRouteContract({
  method: 'GET',
  path: '/api/workflows/[id]/excel/test-preparations',
  params,
  query: excelTestPreparationQuerySchema,
  response: { mode: 'json', schema: excelTestPreparationObservationSchema },
})
export const prepareExcelTestContract = defineRouteContract({
  method: 'POST',
  path: '/api/workflows/[id]/excel/test-preparations',
  params,
  query: excelTestPreparationQuerySchema,
  body: excelTestPreparationBodySchema,
  response: { mode: 'json', schema: excelTestPreparationReceiptSchema },
})
export type ExcelTestPreparationBody = z.infer<typeof excelTestPreparationBodySchema>
export type ExcelTestPreparationObservation = z.infer<typeof excelTestPreparationObservationSchema>
export type ExcelTestPreparationReceipt = z.infer<typeof excelTestPreparationReceiptSchema>
