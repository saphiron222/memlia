// Copyright 2026 Memlia. All rights reserved.
import { z } from 'zod'
import { workflowIdSchema, workspaceIdSchema } from '@/lib/api/contracts/primitives'
import { defineRouteContract } from '@/lib/api/contracts/types'

export const localCapabilitiesQuery = z
  .object({
    workspaceId: workspaceIdSchema.max(512),
    workflowId: workflowIdSchema.max(512).optional(),
  })
  .strict()
export const localCapabilitiesResponse = z.discriminatedUnion('backend', [
  z.object({ version: z.literal(1), backend: z.literal('legacy') }).strict(),
  z
    .object({
      version: z.literal(1),
      backend: z.literal('unavailable'),
      code: z.literal('local_profile_unavailable'),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      backend: z.literal('local'),
      provider: z.literal('openai'),
      model: z.string().min(1).max(256),
      workspaceId: workspaceIdSchema,
      workflowId: workflowIdSchema.optional(),
      modes: z.tuple([z.literal('agent')]),
      requiresExistingWorkflow: z.literal(true),
      requestSupported: z.boolean(),
      currentWorkflowReference: z.enum(['implicit', 'unavailable']),
      modelSelection: z.literal(false),
      effort: z.literal(false),
      attachments: z.literal(false),
      otherResources: z.literal(false),
      contexts: z.literal(false),
      desktop: z.literal(false),
    })
    .strict(),
])
export type LocalCapabilities = z.infer<typeof localCapabilitiesResponse>
export type LocalCapabilitiesQuery = z.infer<typeof localCapabilitiesQuery>
export const localCapabilitiesContract = defineRouteContract({
  method: 'GET',
  path: '/api/copilot/capabilities',
  query: localCapabilitiesQuery,
  response: { mode: 'json', schema: localCapabilitiesResponse },
})
