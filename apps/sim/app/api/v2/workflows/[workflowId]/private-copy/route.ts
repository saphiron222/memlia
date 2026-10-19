// Copyright 2026 Memlia. All rights reserved.
import { defineV2JsonRoute, v2ApiKeyAuth, v2RateLimits } from '@/lib/api/server/routes'
import { v2WorkflowErrorPolicies } from '@/lib/workflows/api'
import { copyPrivateWorkflow } from '@/lib/workflows/application/copy-private-workflow'
import { workflowOperations } from '@/lib/workflows/application/operations'
import { privateCopyContract } from './contracts'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export const POST = defineV2JsonRoute({
  contract: privateCopyContract,
  auth: v2ApiKeyAuth,
  operation: workflowOperations.create,
  rateLimit: v2RateLimits.publicApi,
  errorPolicy: v2WorkflowErrorPolicies.concealWorkflowAuthorization,
  parseOptions: { maxBodyBytes: 8192 },
  mapInput: ({ params, body }) => ({
    sourceWorkflowId: params.workflowId,
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
