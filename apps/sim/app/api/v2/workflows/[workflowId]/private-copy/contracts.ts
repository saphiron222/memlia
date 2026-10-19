// Copyright 2026 Memlia. All rights reserved.
import { z } from 'zod'
import { noInputSchema, workspaceIdSchema } from '@/lib/api/contracts/primitives'
import { defineRouteContract } from '@/lib/api/contracts/types'
import { v2DataResponse } from '@/lib/api/contracts/v2/shared'
import { v2WorkflowIdParamsSchema } from '@/lib/api/contracts/v2/workflows'

export const privateCopyContract = defineRouteContract({
  method: 'POST',
  path: '/api/v2/workflows/[workflowId]/private-copy',
  params: v2WorkflowIdParamsSchema,
  query: noInputSchema,
  body: z.strictObject({
    destinationWorkspaceId: workspaceIdSchema.describe(
      'Personal workspace owned by the authenticated human.'
    ),
    name: z.string().trim().min(1).max(100).describe('Name of the private copy.'),
  }),
  response: {
    mode: 'json',
    status: 201,
    schema: v2DataResponse(
      z.strictObject({
        id: z.string().min(1),
        workspaceId: workspaceIdSchema,
        name: z.string().min(1).describe('Server-deduplicated name, which may include a suffix.'),
        configurationRequired: z
          .literal(true)
          .describe('Configure personal connections and inputs before execution.'),
      })
    ),
  },
})
