// Copyright (c) 2026 Memlia. All rights reserved.
import { type NextRequest, NextResponse } from 'next/server'
import { runExcelTestContract } from '@/lib/api/contracts/excel-test-preparations'
import {
  defineInternalJsonRoute,
  internalRateLimits,
  internalSessionAuth,
} from '@/lib/api/server/routes'
import { OrchestrationError } from '@/lib/core/orchestration/types'
import { isCrossSiteSessionRequest } from '@/lib/core/security/same-origin'
import { createInternalWorkflowErrorPolicy } from '@/lib/workflows/api'
import { workflowOperations } from '@/lib/workflows/application/operations'
import { runExcelTest } from '@/lib/workflows/application/run-excel-test'
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const POST = defineInternalJsonRoute({
  operation: workflowOperations.runExcelTest,
  contract: runExcelTestContract,
  auth: internalSessionAuth,
  rateLimit: internalRateLimits.user({ bucketName: 'workflows.excel.test-run' }),
  errorPolicy: createInternalWorkflowErrorPolicy('excel_test_execution_failed'),
  staticResponseHeaders: { 'Cache-Control': 'private, no-store' },
  parseOptions: {
    maxBodyBytes: 20000,
    rejectBlankQueryValues: true,
    rejectDuplicateQueryValues: true,
    validationErrorResponse: () =>
      NextResponse.json({ error: 'excel_test_execution_invalid' }, { status: 400 }),
  },
  beforeParse({ request }: { request: NextRequest }) {
    if (isCrossSiteSessionRequest(request))
      throw new OrchestrationError('forbidden', 'excel_test_execution_forbidden')
  },
  useCase: runExcelTest,
  mapInput: ({ params, body }) => ({ workflowId: params.id, body, requestId: body.executionId }),
})
