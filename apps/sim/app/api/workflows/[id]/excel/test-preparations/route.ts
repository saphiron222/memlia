// Copyright (c) 2026 Memlia. All rights reserved.
import { type NextRequest, NextResponse } from 'next/server'
import {
  observeExcelTestPreparationContract,
  prepareExcelTestContract,
} from '@/lib/api/contracts/excel-test-preparations'
import {
  defineInternalJsonRoute,
  internalRateLimits,
  internalSessionAuth,
} from '@/lib/api/server/routes'
import { OrchestrationError } from '@/lib/core/orchestration/types'
import { isCrossSiteSessionRequest } from '@/lib/core/security/same-origin'
import { createInternalWorkflowErrorPolicy } from '@/lib/workflows/api'
import { workflowOperations } from '@/lib/workflows/application/operations'
import {
  observeExcelTestPreparation,
  prepareExcelTest,
} from '@/lib/workflows/application/prepare-excel-test'
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
const common = {
  operation: workflowOperations.prepareExcelTest,
  auth: internalSessionAuth,
  rateLimit: internalRateLimits.user({ bucketName: 'workflows.excel.test-preparations' }),
  errorPolicy: createInternalWorkflowErrorPolicy('excel_test_preparation_failed'),
  staticResponseHeaders: { 'Cache-Control': 'private, no-store' },
  parseOptions: {
    maxBodyBytes: 8192,
    rejectBlankQueryValues: true,
    rejectDuplicateQueryValues: true,
    validationErrorResponse: () =>
      NextResponse.json({ error: 'excel_test_preparation_invalid' }, { status: 400 }),
  },
  beforeParse({ request }: { request: NextRequest }) {
    if (isCrossSiteSessionRequest(request))
      throw new OrchestrationError('forbidden', 'excel_test_preparation_forbidden')
  },
}
export const GET = defineInternalJsonRoute({
  ...common,
  contract: observeExcelTestPreparationContract,
  useCase: observeExcelTestPreparation,
  mapInput: ({ params, query }) => ({
    workflowId: params.id,
    assertedWorkspaceId: query.workspaceId,
  }),
})
export const POST = defineInternalJsonRoute({
  ...common,
  contract: prepareExcelTestContract,
  useCase: prepareExcelTest,
  mapInput: ({ params, query, body }) => ({
    workflowId: params.id,
    assertedWorkspaceId: query.workspaceId,
    ...body,
  }),
})
