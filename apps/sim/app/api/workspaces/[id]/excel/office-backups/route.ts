// Copyright (c) 2026 Memlia. All rights reserved.
import { NextResponse } from 'next/server'
import {
  MAX_OFFICE_BACKUP_HTTP_BYTES,
  storeOfficeBackupContract,
} from '@/lib/api/contracts/excel-office-backups'
import {
  defineInternalJsonRoute,
  internalRateLimits,
  internalSessionAuth,
} from '@/lib/api/server/routes'
import { OrchestrationError } from '@/lib/core/orchestration/types'
import { isCrossSiteSessionRequest } from '@/lib/core/security/same-origin'
import { storeOfficeBackup } from '@/lib/memlia/excel/office/backup-http.server'
import { internalFileErrorPolicies } from '@/lib/workspace-files/api'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export const POST = defineInternalJsonRoute({
  contract: storeOfficeBackupContract,
  operation: storeOfficeBackup.operation,
  useCase: storeOfficeBackup,
  auth: internalSessionAuth,
  rateLimit: internalRateLimits.user({ bucketName: 'excel.office-backups' }),
  errorPolicy: internalFileErrorPolicies.concealResourceAuthorization,
  staticResponseHeaders: { 'Cache-Control': 'private, no-store' },
  parseOptions: {
    maxBodyBytes: MAX_OFFICE_BACKUP_HTTP_BYTES,
    rejectBlankQueryValues: true,
    rejectDuplicateQueryValues: true,
    validationErrorResponse: () =>
      NextResponse.json({ error: 'office_backup_invalid' }, { status: 400 }),
  },
  beforeParse({ request }) {
    if (isCrossSiteSessionRequest(request)) {
      throw new OrchestrationError('forbidden', 'Office backup forbidden')
    }
  },
  mapInput: ({ params, body }) => ({ ...body, workspaceId: params.id }),
})
