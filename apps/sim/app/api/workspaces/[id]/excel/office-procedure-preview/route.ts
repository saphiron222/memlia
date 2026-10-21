// Copyright (c) 2026 Memlia. All rights reserved.
import { prepareOfficeProcedureEditContract } from '@/lib/api/contracts/excel-office-procedures'
import {
  defineInternalJsonRoute,
  internalRateLimits,
  internalSessionAuth,
} from '@/lib/api/server/routes'
import { OrchestrationError } from '@/lib/core/orchestration/types'
import { isCrossSiteSessionRequest } from '@/lib/core/security/same-origin'
import { prepareOfficeProcedureEdit } from '@/lib/memlia/excel/office/procedure-http.server'
import { internalFileErrorPolicies } from '@/lib/workspace-files/api'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const POST = defineInternalJsonRoute({
  contract: prepareOfficeProcedureEditContract,
  operation: prepareOfficeProcedureEdit.operation,
  useCase: prepareOfficeProcedureEdit,
  auth: internalSessionAuth,
  rateLimit: internalRateLimits.user({ bucketName: 'excel.office-procedure-preview' }),
  errorPolicy: internalFileErrorPolicies.concealResourceAuthorization,
  staticResponseHeaders: { 'Cache-Control': 'private, no-store' },
  parseOptions: {
    maxBodyBytes: 8192,
    rejectBlankQueryValues: true,
    rejectDuplicateQueryValues: true,
  },
  beforeParse({ request }) {
    if (isCrossSiteSessionRequest(request))
      throw new OrchestrationError('forbidden', 'Office procedure preview forbidden')
  },
  mapInput: ({ params, body }) => ({ ...body, workspaceId: params.id }),
})
