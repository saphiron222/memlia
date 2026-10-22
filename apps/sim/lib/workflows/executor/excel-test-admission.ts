// Copyright (c) 2026 Memlia. All rights reserved.
import type { Principal, WorkflowExecutionPrincipal } from '@sim/auth/principal'
import { z } from 'zod'
import {
  excelTestExecutionBindingSchema,
  type ExcelTestExecutionBinding,
} from '@/lib/api/contracts/excel-test-preparations'
import { OrchestrationError } from '@/lib/core/orchestration/types'
import { stringifyBoundedJson } from '@/lib/core/utils/bounded-json'
import { defineAuthorizedWorkflowUseCase } from '@/lib/workflows/application/authorized-workflow-use-case'
import { workflowOperations } from '@/lib/workflows/application/operations'
import { resolvePrincipalWorkflowContext } from '@/lib/workflows/application/principal-scope'
import { assertNoWithheldBlockType } from '@/lib/workflows/persistence/block-access-guard'
import {
  readExcelTestPreparationObservation,
  verifyExcelTestSnapshot,
} from '@/lib/workflows/persistence/excel-test-snapshots'

// Only the native authorization path below mints these handles. Neither an HTTP
// receipt nor serialized worker JSON can be cast into a permit at runtime.
export type ExcelTestExecutionPermit = Readonly<{ readonly kind: 'excel_test_execution_permit' }>
const permits = new WeakMap<
  ExcelTestExecutionPermit,
  Readonly<{
    binding: ExcelTestExecutionBinding
    userId: string
    sessionId: string
  }>
>()
const inputSchema = z.strictObject({
  workflowId: excelTestExecutionBindingSchema.shape.prepared.shape.workflowId,
  assertedWorkspaceId: excelTestExecutionBindingSchema.shape.workspaceId,
  binding: excelTestExecutionBindingSchema,
})
type Input = z.infer<typeof inputSchema>
function refused(): never {
  throw new OrchestrationError('conflict', 'excel_test_execution_refused')
}
const authorized = defineAuthorizedWorkflowUseCase({
  operation: workflowOperations.runExcelTest,
  resolveContext: resolvePrincipalWorkflowContext<Input>,
  async execute({ principal, input, context }): Promise<ExcelTestExecutionPermit> {
    if (
      input.binding.workspaceId !== context.workspaceId ||
      input.binding.prepared.workflowId !== context.workflowId
    )
      refused()
    const scope = {
      workflowId: context.workflowId,
      workspaceId: context.workspaceId,
      organizationId: context.workspaceOrganizationId,
    }
    const observed = await readExcelTestPreparationObservation(scope).catch(refused)
    if (
      observed.expectedRevision !== input.binding.preparation.expectedRevision ||
      observed.expectedStateDigest !== input.binding.preparation.expectedStateDigest
    )
      refused()
    await assertNoWithheldBlockType(
      { workspaceId: context.workspaceId, subjectUserId: principal.userId },
      observed.blockTypes.map((type) => ({ type }))
    )
    await verifyExcelTestSnapshot(
      { scope, actorId: principal.userId, ...input.binding.preparation },
      input.binding.prepared
    ).catch(refused)
    const permit = Object.freeze({ kind: 'excel_test_execution_permit' as const })
    permits.set(permit, {
      binding: input.binding,
      userId: principal.userId,
      sessionId: principal.sessionId,
    })
    return permit
  },
})
export async function authorizeExcelTestExecution(args: {
  principal: Principal
  input: Input
}): Promise<ExcelTestExecutionPermit> {
  let input: Input
  try {
    const text = stringifyBoundedJson(args.input, 16384, { strict: true })
    if (text === undefined) return refused()
    input = inputSchema.parse(JSON.parse(text))
  } catch {
    return refused()
  }
  const principal = structuredClone(args.principal)
  return authorized.execute({ principal, input })
}
export function readExcelTestExecutionPermit(
  permit: ExcelTestExecutionPermit,
  scope: {
    principal: WorkflowExecutionPrincipal
    workflowId: string
    userId: string
    workspaceId?: string
  }
): ExcelTestExecutionBinding {
  const stored = permits.get(permit)
  if (
    !stored ||
    scope.principal.kind !== 'session' ||
    stored.userId !== scope.userId ||
    stored.userId !== scope.principal.userId ||
    stored.sessionId !== scope.principal.sessionId ||
    stored.binding.prepared.workflowId !== scope.workflowId ||
    (scope.workspaceId !== undefined && stored.binding.workspaceId !== scope.workspaceId)
  )
    refused()
  // Never leak the private mutable binding used to authorize future calls.
  return structuredClone(stored.binding)
}
