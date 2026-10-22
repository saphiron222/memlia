// Copyright (c) 2026 Memlia. All rights reserved.
import { listOfficeProcedureResultsContract } from '@/lib/api/contracts/excel-office-procedures'
import {
  defineInternalJsonRoute,
  internalRateLimits,
  internalSessionAuth,
} from '@/lib/api/server/routes'
import { listOfficeProcedureResults } from '@/lib/memlia/excel/office/procedure-http.server'
import { internalFileErrorPolicies } from '@/lib/workspace-files/api'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const GET = defineInternalJsonRoute({
  contract: listOfficeProcedureResultsContract,
  operation: listOfficeProcedureResults.operation,
  useCase: listOfficeProcedureResults,
  auth: internalSessionAuth,
  rateLimit: internalRateLimits.user({ bucketName: 'excel.office-procedures' }),
  errorPolicy: internalFileErrorPolicies.concealResourceAuthorization,
  staticResponseHeaders: { 'Cache-Control': 'private, no-store' },
  parseOptions: { rejectBlankQueryValues: true, rejectDuplicateQueryValues: true },
  mapInput: ({ params }) => ({ workspaceId: params.id }),
})
