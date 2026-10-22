// Copyright (c) 2026 Memlia. All rights reserved.
import { type NextRequest, NextResponse } from 'next/server'
import { readExcelTestResultsContract } from '@/lib/api/contracts/excel-test-preparations'
import {
  defineInternalJsonRoute,
  internalRateLimits,
  internalSessionAuth,
} from '@/lib/api/server/routes'
import { OrchestrationError } from '@/lib/core/orchestration/types'
import { isCrossSiteSessionRequest } from '@/lib/core/security/same-origin'
import { createInternalWorkflowErrorPolicy } from '@/lib/workflows/api'
import { workflowOperations } from '@/lib/workflows/application/operations'
import { readExcelTestResults } from '@/lib/workflows/application/read-excel-test-results'
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const POST = defineInternalJsonRoute({
  operation: workflowOperations.runExcelTest,
  contract: readExcelTestResultsContract,
  auth: internalSessionAuth,
  rateLimit: internalRateLimits.user({ bucketName: 'workflows.excel.test-results' }),
  errorPolicy: createInternalWorkflowErrorPolicy('excel_test_results_failed'),
  staticResponseHeaders: { 'Cache-Control': 'private, no-store' },
  parseOptions: {
    maxBodyBytes: 20000,
    rejectBlankQueryValues: true,
    rejectDuplicateQueryValues: true,
    validationErrorResponse: () =>
      NextResponse.json({ error: 'excel_test_results_invalid' }, { status: 400 }),
  },
  beforeParse({ request }: { request: NextRequest }) {
    if (isCrossSiteSessionRequest(request))
      throw new OrchestrationError('forbidden', 'excel_test_results_forbidden')
  },
  useCase: readExcelTestResults,
  mapInput: ({ params, body }) => ({ workflowId: params.id, body }),
})
