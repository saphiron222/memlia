// Copyright (c) 2026 Memlia. All rights reserved.
import { type NextRequest, NextResponse } from 'next/server'
import { downloadExcelTestResultContract } from '@/lib/api/contracts/excel-test-preparations'
import {
  defineInternalBinaryRoute,
  internalRateLimits,
  internalSessionAuth,
} from '@/lib/api/server/routes'
import type { JsonRouteContext } from '@/lib/api/server/routes/types'
import { isCrossSiteSessionRequest } from '@/lib/core/security/same-origin'
import { encodeFilenameForHeader } from '@/lib/uploads/server/delivery'
import { createInternalWorkflowErrorPolicy } from '@/lib/workflows/api'
import { downloadExcelTestResult } from '@/lib/workflows/application/download-excel-test-result'
import { workflowOperations } from '@/lib/workflows/application/operations'
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
const download = defineInternalBinaryRoute({
  operation: workflowOperations.runExcelTest,
  contract: downloadExcelTestResultContract,
  auth: internalSessionAuth,
  rateLimit: internalRateLimits.none({
    reason: 'Read-only exact test result; native download authorizes the recorded run file',
  }),
  errorPolicy: createInternalWorkflowErrorPolicy('excel_test_result_download_failed'),
  parseOptions: { maxBodyBytes: 20000 },
  useCase: downloadExcelTestResult,
  mapInput: ({ params, body }) => ({ workflowId: params.id, body }),
  present: ({ bytes, file }) => ({
    body: bytes,
    contentType: file.contentType,
    contentLength: bytes.byteLength,
    contentDisposition: `attachment; ${encodeFilenameForHeader(file.fileName)}`,
    headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' },
  }),
})
export async function POST(request: NextRequest, context?: JsonRouteContext) {
  if (isCrossSiteSessionRequest(request))
    return NextResponse.json(
      { error: 'excel_test_result_download_forbidden' },
      {
        status: 403,
        headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' },
      }
    )
  return download(request, context)
}
