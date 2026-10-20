// Copyright (c) 2026 Memlia. All rights reserved.
import { ExcelProcedureSchema } from '@memlia/contracts'
import { z } from 'zod'
import {
  type ExcelTestPreparationBody,
  excelTestPreparationBodySchema,
  excelTestPreparationObservationSchema,
  excelTestPreparationReceiptSchema,
} from '@/lib/api/contracts/excel-test-preparations'
import { OrchestrationError } from '@/lib/core/orchestration/types'
import { stringifyBoundedJson } from '@/lib/core/utils/bounded-json'
import { assertNoWithheldBlockType } from '@/lib/workflows/persistence/block-access-guard'
import {
  prepareExcelTestSnapshot,
  readExcelTestPreparationObservation,
} from '@/lib/workflows/persistence/excel-test-snapshots'
import { defineAuthorizedWorkflowUseCase } from './authorized-workflow-use-case'
import type { ActiveWorkflowApplicationContext } from './context'
import { workflowOperations } from './operations'
import { resolvePrincipalWorkflowContext } from './principal-scope'

export interface ObserveExcelTestInput {
  workflowId: string
  assertedWorkspaceId: string
}
export type PrepareExcelTestInput = ObserveExcelTestInput & ExcelTestPreparationBody
const observationInput = z.strictObject({
  workflowId: ExcelProcedureSchema.shape.workflowId,
  assertedWorkspaceId: ExcelProcedureSchema.shape.workspaceId,
})
const preparationInput = observationInput.extend(excelTestPreparationBodySchema.shape)
function capture<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  try {
    const json = stringifyBoundedJson(input, 8192, { strict: true })
    if (json === undefined) throw new Error()
    return schema.parse(JSON.parse(json))
  } catch {
    throw new OrchestrationError('validation', 'excel_test_preparation_invalid')
  }
}
function scope(context: ActiveWorkflowApplicationContext) {
  return {
    workflowId: context.workflowId,
    workspaceId: context.workspaceId,
    organizationId: context.workspaceOrganizationId,
  }
}
async function observe(context: ActiveWorkflowApplicationContext, userId: string) {
  let observed: Awaited<ReturnType<typeof readExcelTestPreparationObservation>>
  try {
    observed = await readExcelTestPreparationObservation(scope(context))
  } catch {
    throw new OrchestrationError('conflict', 'excel_test_preparation_refused')
  }
  try {
    await assertNoWithheldBlockType(
      { workspaceId: context.workspaceId, subjectUserId: userId },
      observed.blockTypes.map((type) => ({ type }))
    )
  } catch {
    throw new OrchestrationError('forbidden', 'excel_test_preparation_forbidden')
  }
  return excelTestPreparationObservationSchema.parse({
    workflowId: context.workflowId,
    workspaceId: context.workspaceId,
    expectedRevision: observed.expectedRevision,
    expectedStateDigest: observed.expectedStateDigest,
  })
}
const observeAuthorized = defineAuthorizedWorkflowUseCase({
  operation: workflowOperations.prepareExcelTest,
  resolveContext: resolvePrincipalWorkflowContext<ObserveExcelTestInput>,
  async execute({ principal, context }) {
    return observe(context, principal.userId)
  },
})
const prepareAuthorized = defineAuthorizedWorkflowUseCase({
  operation: workflowOperations.prepareExcelTest,
  resolveContext: resolvePrincipalWorkflowContext<PrepareExcelTestInput>,
  async execute({ principal, input, context }) {
    const current = await observe(context, principal.userId)
    if (
      current.expectedRevision !== input.expectedRevision ||
      current.expectedStateDigest !== input.expectedStateDigest
    ) {
      throw new OrchestrationError('conflict', 'excel_test_preparation_refused')
    }
    try {
      const result = await prepareExcelTestSnapshot({
        scope: scope(context),
        actorId: principal.userId,
        expectedRevision: input.expectedRevision,
        expectedStateDigest: input.expectedStateDigest,
        operationId: input.operationId,
        ...(input.previousTestVersionId === undefined
          ? {}
          : { previousTestVersionId: input.previousTestVersionId }),
      })
      return excelTestPreparationReceiptSchema.parse(result)
    } catch {
      // An uncertain result is never permission to retry with a new operation id.
      throw new OrchestrationError('conflict', 'excel_test_preparation_refused')
    }
  },
})
// Capture before the native funnel's first await; the caller cannot replace the CAS while
// context/permissions are being resolved. The funnel remains the only authority mechanism.
export const observeExcelTestPreparation = {
  ...observeAuthorized,
  async execute(args: Parameters<typeof observeAuthorized.execute>[0]) {
    return observeAuthorized.execute({
      ...args,
      principal: { ...args.principal },
      input: capture(observationInput, args.input),
    })
  },
  async authorize(args: Parameters<typeof observeAuthorized.authorize>[0]) {
    return observeAuthorized.authorize({
      ...args,
      principal: { ...args.principal },
      input: capture(observationInput, args.input),
    })
  },
}
export const prepareExcelTest = {
  ...prepareAuthorized,
  async execute(args: Parameters<typeof prepareAuthorized.execute>[0]) {
    return prepareAuthorized.execute({
      ...args,
      principal: { ...args.principal },
      input: capture(preparationInput, args.input),
    })
  },
  async authorize(args: Parameters<typeof prepareAuthorized.authorize>[0]) {
    return prepareAuthorized.authorize({
      ...args,
      principal: { ...args.principal },
      input: capture(preparationInput, args.input),
    })
  },
}
