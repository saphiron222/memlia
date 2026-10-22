// Copyright (c) 2026 Memlia. All rights reserved.
import { z } from 'zod'
import type { Principal } from '@sim/auth/principal'
import {
  runExcelTestBodySchema,
  runExcelTestContract,
} from '@/lib/api/contracts/excel-test-preparations'
import { env } from '@/lib/core/config/env'
import { OrchestrationError } from '@/lib/core/orchestration/types'
import { HttpError } from '@/lib/core/utils/http-error'
import { stringifyBoundedJson } from '@/lib/core/utils/bounded-json'
import {
  authorizeExcelTestExecution,
  readExcelTestExecutionPermit,
} from '@/lib/workflows/executor/excel-test-admission'
import { executeWorkflowService } from '@/lib/workflows/executor/execute-service'
import { workflowOperations } from './operations'
import { defineAuthorizedWorkflowUseCase } from './authorized-workflow-use-case'
import { resolvePrincipalWorkflowContext } from './principal-scope'

class ExcelTestUnavailableError extends HttpError {
  readonly statusCode = 503
  constructor() {
    super('excel_test_execution_unconfirmed')
  }
}
const inputSchema = z.strictObject({
  workflowId: runExcelTestContract.params.shape.id,
  body: runExcelTestBodySchema,
  requestId: z.string().min(1).max(128),
})
type Input = z.infer<typeof inputSchema>
const authorizedRun = defineAuthorizedWorkflowUseCase({
  operation: workflowOperations.runExcelTest,
  resolveContext: ({ principal, input }: { principal: Principal; input: Input }) =>
    resolvePrincipalWorkflowContext({
      principal,
      input: { workflowId: input.workflowId, assertedWorkspaceId: input.body.workspaceId },
    }),
  async execute({ principal, input: owned }) {
    const body = owned.body
    // This surface promises durable server execution, never the legacy inline queue.
    if (env.MEMLIA_DURABLE_WORKFLOWS_ENABLED !== '1') throw new ExcelTestUnavailableError()
    const permit = await authorizeExcelTestExecution({
      principal,
      input: {
        workflowId: owned.workflowId,
        assertedWorkspaceId: body.workspaceId,
        binding: {
          workspaceId: body.workspaceId,
          preparation: body.preparation,
          prepared: body.prepared,
        },
      },
    })
    const binding = readExcelTestExecutionPermit(permit, {
      principal,
      userId: principal.userId,
      workflowId: owned.workflowId,
    })
    const result = await executeWorkflowService({
      workflowId: owned.workflowId,
      principal,
      userId: principal.userId,
      input: {},
      triggerType: 'manual',
      requestId: owned.requestId,
      executionId: body.executionId,
      mode: 'async',
      useDraftState: false,
      useAuthenticatedUserAsActor: true,
      isPublicApiAccess: false,
      rateLimitCounter: 'async',
      deploymentVersionId: binding.prepared.deploymentVersionId,
      excelTestExecutionPermit: permit,
    })
    if (!result.ok && result.failure.kind === 'conflict')
      throw new OrchestrationError('conflict', 'excel_test_execution_unconfirmed')
    if (
      !result.ok ||
      !('queued' in result) ||
      !result.queued ||
      result.executionId !== body.executionId
    )
      throw new ExcelTestUnavailableError()
    return runExcelTestContract.response.schema.parse({
      status: 'queued',
      executionId: result.executionId,
      workflowId: binding.prepared.workflowId,
      deploymentVersionId: binding.prepared.deploymentVersionId,
      snapshotDigest: binding.prepared.snapshotDigest,
    })
  },
})
export const runExcelTest = {
  ...authorizedRun,
  async execute({
    principal,
    input,
  }: {
    principal: Principal
    input: { workflowId: string; body: unknown; requestId: string }
  }) {
    const text = stringifyBoundedJson(input, 20000, { strict: true })
    if (text === undefined)
      throw new OrchestrationError('validation', 'excel_test_execution_invalid')
    const parsed = inputSchema.safeParse(JSON.parse(text))
    if (!parsed.success) throw new OrchestrationError('validation', 'excel_test_execution_invalid')
    return authorizedRun.execute({ principal: structuredClone(principal), input: parsed.data })
  },
}
