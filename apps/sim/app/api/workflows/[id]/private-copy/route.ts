// Copyright 2026 Memlia. All rights reserved.
import {
  defineInternalJsonRoute,
  internalRateLimits,
  internalSessionAuth,
} from '@/lib/api/server/routes'
import { OrchestrationError } from '@/lib/core/orchestration/types'
import { isCrossSiteSessionRequest } from '@/lib/core/security/same-origin'
import { internalWorkflowErrorPolicies } from '@/lib/workflows/api'
import { copyPrivateWorkflow } from '@/lib/workflows/application/copy-private-workflow'
import { workflowOperations } from '@/lib/workflows/application/operations'
import { internalPrivateCopyContract } from './contracts'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export const POST = defineInternalJsonRoute({
  contract: internalPrivateCopyContract,
  auth: internalSessionAuth,
  operation: workflowOperations.create,
  rateLimit: internalRateLimits.user({ bucketName: 'workflows.private-copy' }),
  errorPolicy: internalWorkflowErrorPolicies.concealWorkflowAuthorization,
  staticResponseHeaders: { 'Cache-Control': 'private, no-store' },
  parseOptions: { maxBodyBytes: 8192 },
  beforeParse: ({ request }) => {
    if (isCrossSiteSessionRequest(request)) {
      throw new OrchestrationError('forbidden', 'Cross-site requests are not allowed')
    }
  },
  mapInput: ({ params, body }) => ({
    sourceWorkflowId: params.id,
    destinationWorkspaceId: body.destinationWorkspaceId,
    name: body.name,
  }),
  useCase: copyPrivateWorkflow,
  present: (result) => ({
    data: {
      id: result.id,
      workspaceId: result.workspaceId,
      name: result.name,
      configurationRequired: result.configurationRequired,
    },
  }),
})
