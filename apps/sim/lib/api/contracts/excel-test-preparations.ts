// Copyright (c) 2026 Memlia. All rights reserved.
import { ExcelProcedureSchema } from '@memlia/contracts'
import { z } from 'zod'
import { defineRouteContract } from '@/lib/api/contracts/types'
import { executionIdSchema } from '@/lib/api/contracts/workflows'
import { MAX_BUFFERED_TRANSFER_BYTES } from '@/lib/uploads/shared/types'

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
// Neither this proof nor the receipt is execution authority. The native use case
// reauthorizes the session and resolves the committed operation and exact version.
export const excelTestExecutionBindingSchema = z.strictObject({
  workspaceId: shape.workspaceId,
  preparation: excelTestPreparationBodySchema,
  prepared: excelTestPreparationReceiptSchema,
})
export const runExcelTestBodySchema = excelTestExecutionBindingSchema.extend({
  executionId: executionIdSchema,
  acknowledgeEffects: z.literal(true),
})
export const runExcelTestContract = defineRouteContract({
  method: 'POST',
  path: '/api/workflows/[id]/excel/test-preparations/run',
  params,
  body: runExcelTestBodySchema,
  response: {
    mode: 'json',
    status: 202,
    schema: z.strictObject({
      status: z.literal('queued'),
      executionId: executionIdSchema,
      workflowId: shape.workflowId,
      deploymentVersionId: shape.deployedVersionId,
      snapshotDigest: shape.digest,
    }),
  },
})
export type ExcelTestExecutionBinding = z.infer<typeof excelTestExecutionBindingSchema>
export type ExcelTestPreparationBody = z.infer<typeof excelTestPreparationBodySchema>
export type ExcelTestPreparationObservation = z.infer<typeof excelTestPreparationObservationSchema>
export type ExcelTestPreparationReceipt = z.infer<typeof excelTestPreparationReceiptSchema>

// Read-only test results deliberately are not Office procedure sources/capabilities.
export const readExcelTestResultsBodySchema = excelTestExecutionBindingSchema.extend({
  executionId: executionIdSchema,
})
const excelTestResultFileSchema = z.strictObject({
  resultFileId: z.string().regex(/^[A-Za-z0-9_-]{1,128}(?![\s\S])/),
  fileName: z.string().min(1).max(256),
  size: z.int().min(1).max(MAX_BUFFERED_TRANSFER_BYTES),
  contentType: z.literal('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
  resultContentVersion: z.int().min(0).max(8_640_000_000_000_000),
})
export const readExcelTestResultsContract = defineRouteContract({
  method: 'POST',
  path: '/api/workflows/[id]/excel/test-preparations/results',
  params,
  body: readExcelTestResultsBodySchema,
  response: {
    mode: 'json',
    schema: z.strictObject({
      status: z.literal('completed'),
      workflowId: shape.workflowId,
      executionId: executionIdSchema,
      deploymentVersionId: shape.deployedVersionId,
      snapshotDigest: shape.digest,
      items: z
        .array(excelTestResultFileSchema)
        .max(50)
        .refine(
          (items) => new Set(items.map((item) => item.resultFileId)).size === items.length,
          'Unique result files required'
        ),
      truncated: z.boolean(),
    }),
  },
})
export type ExcelTestResultFile = z.infer<typeof excelTestResultFileSchema>

export const downloadExcelTestResultContract = defineRouteContract({
  method: 'POST',
  path: '/api/workflows/[id]/excel/test-preparations/results/download',
  params,
  body: readExcelTestResultsBodySchema.extend({ expected: excelTestResultFileSchema }),
  response: { mode: 'binary' },
})
