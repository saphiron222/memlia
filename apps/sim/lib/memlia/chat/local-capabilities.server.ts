// Copyright 2026 Memlia. All rights reserved.
import { type Principal, parsePrincipal } from '@sim/auth/principal'
import { defineAuthorizedWorkspaceUseCase } from '@/lib/core/application/authorized-workspace-use-case'
import { defineWorkspaceOperation } from '@/lib/core/application/workspace-operation'
import { isCopilotToolPermissionsEnabled } from '@/lib/core/config/env-flags'
import {
  OrchestrationError,
  type OrchestrationRequestContext,
} from '@/lib/core/orchestration/types'
import { stringifyBoundedJson } from '@/lib/core/utils/bounded-json'
import { selectWorkflowReadPolicy } from '@/lib/memlia/ai/chat-policy.server'
import { readChatInstallationPolicyFile } from '@/lib/memlia/ai/chat-policy-source.server'
import { chatOperations } from '@/lib/mothership/application/operations'
import { validateModelProvider } from '@/lib/permission-groups/permission-check'
import { resolveWorkflowIdForUser } from '@/lib/workflows/utils'
import { resolveActiveWorkspaceApplicationContext } from '@/lib/workspaces/application/context'
import {
  type LocalCapabilities,
  type LocalCapabilitiesQuery,
  localCapabilitiesQuery,
} from '@/app/api/copilot/capabilities/contracts'

export const localCapabilitiesOperation = defineWorkspaceOperation({
  id: 'chat.local_capabilities',
  minimumRole: 'read',
  workspaceApiKey: 'deny',
  principalKinds: ['session'],
  capability: chatOperations.send.capability,
})
const forbidden = () => new OrchestrationError('forbidden', 'Local Chat profile is unavailable.')
const unavailable = (): LocalCapabilities => ({
  version: 1,
  backend: 'unavailable',
  code: 'local_profile_unavailable',
})
type CapturedInput = LocalCapabilitiesQuery & { localRequested: boolean }

const authorized = defineAuthorizedWorkspaceUseCase({
  operation: localCapabilitiesOperation,
  resolveContext: async ({ input }: { input: CapturedInput }) => {
    const context = await resolveActiveWorkspaceApplicationContext(input.workspaceId)
    if (context.workspaceId !== input.workspaceId) throw forbidden()
    return { ...context }
  },
  authorizationOptions: {},
  execute: async ({ principal, input, context }): Promise<LocalCapabilities> => {
    // Even the legacy observation is behind native workspace/capability authorization.
    if (input.workflowId !== undefined) {
      const resolved = await resolveWorkflowIdForUser(principal.userId, input.workflowId)
      if (
        resolved.status !== 'resolved' ||
        resolved.workspaceId !== context.workspaceId ||
        resolved.workflowId !== input.workflowId
      )
        throw forbidden()
    }
    if (!input.localRequested) return { version: 1, backend: 'legacy' }
    let model: string
    let provider: 'openai' | 'anthropic'
    try {
      const { policy } = readChatInstallationPolicyFile()
      if (!policy.localBackend || policy.data.workflow !== 'sanitized_details') return unavailable()
      if (
        input.workflowId !== undefined &&
        selectWorkflowReadPolicy(policy, input.workflowId)?.policy !== 'sanitized_details'
      )
        return unavailable()
      model = policy.model
      provider = policy.provider
    } catch {
      return unavailable()
    }
    // Preserve native denied-model/provider failures as authorization refusals, not legacy.
    await validateModelProvider(principal.userId, context.workspaceId, model)
    if (!isCopilotToolPermissionsEnabled) return unavailable()
    return {
      version: 1,
      backend: 'local',
      provider,
      model,
      workspaceId: context.workspaceId,
      ...(input.workflowId === undefined ? {} : { workflowId: input.workflowId }),
      modes: ['agent'],
      requiresExistingWorkflow: true,
      requestSupported: input.workflowId !== undefined,
      currentWorkflowReference: input.workflowId === undefined ? 'unavailable' : 'implicit',
      modelSelection: false,
      effort: false,
      attachments: false,
      otherResources: false,
      contexts: false,
      desktop: false,
    }
  },
})

/** Observation only; callers must authenticate the real session. No spend, key or transcript read. */
export const readLocalChatCapabilities = {
  operation: localCapabilitiesOperation,
  async execute(args: {
    principal: Principal
    input: LocalCapabilitiesQuery
    request?: OrchestrationRequestContext
  }): Promise<LocalCapabilities> {
    const localRequested = Object.hasOwn(process.env, 'MEMLIA_CHAT_POLICY_FILE')
    const json = stringifyBoundedJson({ principal: args.principal, input: args.input }, 8192, {
      strict: true,
    })
    if (json === undefined) throw forbidden()
    const owned = JSON.parse(json)
    const principal = parsePrincipal({ version: 1, principal: owned.principal })
    const input = localCapabilitiesQuery.parse(owned.input)
    return authorized.execute({
      principal,
      input: { ...input, localRequested },
      request: args.request,
    })
  },
}
