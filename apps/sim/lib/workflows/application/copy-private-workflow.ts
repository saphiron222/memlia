// Copyright 2026 Memlia. All rights reserved.
import { AuditAction, AuditResourceType } from '@sim/audit'
import type { Principal } from '@sim/auth/principal'
import { z } from 'zod'
import { defineAuthorizedWorkspaceUseCase } from '@/lib/core/application'
import { OrchestrationError } from '@/lib/core/orchestration/types'
import {
  copyPrivateWorkflowRecord,
  type PrivateWorkflowCopyInput,
  requirePrivateCopySubject,
} from '@/lib/memlia/workflows/private-copy-store'
import { notifyWorkspaceWorkflowsChanged } from '@/lib/realtime/notify'
import { workflowOperations } from '@/lib/workflows/application/operations'
import { resolveActiveWorkspaceApplicationContext } from '@/lib/workspaces/application/context'

const inputSchema = z.strictObject({
  sourceWorkflowId: z.string().min(1).max(128),
  destinationWorkspaceId: z.string().min(1).max(128),
  name: z.string().trim().min(1).max(100),
})

/** New compound use case. The existing same-workspace duplicate contract is untouched. */
export const copyPrivateWorkflow = defineAuthorizedWorkspaceUseCase({
  operation: workflowOperations.create,
  authorizationOptions: {},
  async resolveContext({
    principal,
    input,
  }: {
    principal: Principal
    input: PrivateWorkflowCopyInput
  }) {
    requirePrivateCopySubject(principal)
    const parsed = inputSchema.safeParse(input)
    if (!parsed.success)
      throw new OrchestrationError(
        'validation',
        'Provide only source workflow, personal destination and copy name'
      )
    const context = await resolveActiveWorkspaceApplicationContext(
      parsed.data.destinationWorkspaceId
    )
    return { ...context, copyInput: parsed.data }
  },
  async execute({ principal, context }) {
    return copyPrivateWorkflowRecord(principal, context.copyInput)
  },
  projectAudit: ({ result }) => ({
    action: AuditAction.WORKFLOW_DUPLICATED,
    resourceType: AuditResourceType.WORKFLOW,
    resourceId: result.id,
    resourceName: result.name,
    description: 'Created a private workflow copy requiring configuration',
    metadata: {
      sourceWorkflowId: result.source.workflowId,
      sourceRevision: result.source.revision,
      workspaceId: result.workspaceId,
      configurationRequired: true,
    },
  }),
  afterSuccess: ({ result }) => notifyWorkspaceWorkflowsChanged(result.workspaceId),
})
