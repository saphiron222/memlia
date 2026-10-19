// Copyright 2026 Memlia. All rights reserved.
// Independent adapters over the Apache permission-group primitives.
import { getUserOrganization } from '@/lib/billing/organizations/membership'
import { ForbiddenOperationError } from '@/lib/core/application/forbidden'
import { isInvitationsDisabled, isPublicApiDisabled } from '@/lib/core/config/env-flags'
import type { DbOrTx } from '@/lib/db/types'
import { isBlockTypeAccessControlExempt } from './block-access'
import { CAPABILITY_RULES, refuseCapability, type PermissionGroupCapability } from './capabilities'
import type { PermissionGroupConfig } from './fields'
import { resolveAccessControlBlockType, toAccessControlAllowlist } from './integration-allowlist'
import { createModelAccessGate } from './model-access'
import { createToolAccessGate } from './operation-access'
import {
  getUserPermissionConfig,
  getUserPermissionConfigForOrganization,
  mergeEnvAllowlist,
} from './resolve.server'
import { findProviderFromModel } from '@/providers/models'

export { getUserPermissionConfig, resolveVerifiedUserAccessControlContext } from './resolve.server'

export class IntegrationNotAllowedError extends ForbiddenOperationError {
  constructor(integration: string) {
    super(
      'INTEGRATION_NOT_ALLOWED',
      `Integration "${integration}" is not allowed based on your permission group settings`
    )
    this.name = 'IntegrationNotAllowedError'
  }
}
export class ModelNotAllowedError extends ForbiddenOperationError {
  constructor(model: string) {
    super(
      'PERMISSION_GROUP_CAPABILITY_BLOCKED',
      `Le modèle ${model} est interdit par la politique de cet espace.`
    )
    this.name = 'ModelNotAllowedError'
  }
}
export class ProviderNotAllowedError extends ForbiddenOperationError {
  constructor(provider: string) {
    super(
      'PERMISSION_GROUP_CAPABILITY_BLOCKED',
      `Le fournisseur ${provider} est interdit par la politique de cet espace.`
    )
    this.name = 'ProviderNotAllowedError'
  }
}
export class ToolNotAllowedError extends ForbiddenOperationError {
  constructor(tool: string) {
    super(
      'PERMISSION_GROUP_CAPABILITY_BLOCKED',
      `L’outil ${tool} est interdit par la politique de cet espace.`
    )
    this.name = 'ToolNotAllowedError'
  }
}
export class CustomToolsNotAllowedError extends ForbiddenOperationError {
  constructor() {
    super('PERMISSION_GROUP_CAPABILITY_BLOCKED', 'Les outils personnalisés sont désactivés.')
  }
}
export class McpToolsNotAllowedError extends ForbiddenOperationError {
  constructor() {
    super('PERMISSION_GROUP_CAPABILITY_BLOCKED', 'Les outils MCP sont désactivés.')
  }
}
export class SkillsNotAllowedError extends ForbiddenOperationError {
  constructor() {
    super('PERMISSION_GROUP_CAPABILITY_BLOCKED', 'Les compétences sont désactivées.')
  }
}
export class InvitationsNotAllowedError extends ForbiddenOperationError {
  constructor() {
    super('PERMISSION_GROUP_CAPABILITY_BLOCKED', 'Les invitations sont désactivées.')
  }
}
export class PublicApiNotAllowedError extends ForbiddenOperationError {
  constructor() {
    super('PERMISSION_GROUP_CAPABILITY_BLOCKED', 'L’API publique est désactivée.')
  }
}

// These are policy checks after resource authorization, never a replacement for
// membership/role checks. Missing users get deployment policy, not another user's group.
async function loadConfig(userId?: string, workspaceId?: string, executor?: DbOrTx) {
  if (!userId) return mergeEnvAllowlist(null)
  if (workspaceId) return getUserPermissionConfig(userId, workspaceId, executor)
  const membership = await getUserOrganization(userId)
  return membership?.organizationId
    ? getUserPermissionConfigForOrganization(membership.organizationId, executor)
    : mergeEnvAllowlist(null)
}

function assertCapability(
  config: PermissionGroupConfig | null,
  capability: PermissionGroupCapability,
  parameter = ''
) {
  if (!config) return
  const rule = CAPABILITY_RULES[capability]
  if (rule.kind === 'static' ? rule.deniedBy(config) : rule.deniedBy(config, parameter)) {
    refuseCapability(capability)
  }
}

export async function validateBlockType(
  userId: string | undefined,
  workspaceId: string | undefined,
  blockType: string,
  _ctx?: unknown
) {
  const config = await loadConfig(userId, workspaceId)
  const allowed = toAccessControlAllowlist(config?.allowedIntegrations ?? null)
  if (allowed === null || isBlockTypeAccessControlExempt(blockType)) return
  if (!allowed.has(resolveAccessControlBlockType(blockType.toLowerCase()).toLowerCase())) {
    throw new IntegrationNotAllowedError(blockType)
  }
}

function assertModel(config: PermissionGroupConfig | null, model: string) {
  // Reuse the native gate, including case folding and Ollama normalization.
  if (
    !createModelAccessGate({
      deniedModels: config?.deniedModels ?? [],
      allowedModelProviders: null,
    })(model)
  ) {
    throw new ModelNotAllowedError(model)
  }
  if (!createModelAccessGate(config)(model)) {
    throw new ProviderNotAllowedError(findProviderFromModel(model) ?? model)
  }
}

export async function validateModelProvider(
  userId: string | undefined,
  workspaceId: string | undefined,
  model: string,
  _ctx?: unknown
) {
  assertModel(await loadConfig(userId, workspaceId), model)
}

export async function assertPermissionsAllowed(input: {
  userId?: string
  workspaceId?: string
  model?: string
  toolId?: string
  toolKind?: 'custom' | 'mcp' | 'skill' | 'integration'
  ctx?: unknown
  signal?: AbortSignal
}) {
  input.signal?.throwIfAborted()
  const config = await loadConfig(input.userId, input.workspaceId)
  input.signal?.throwIfAborted()
  if (input.model) assertModel(config, input.model)
  if (input.toolId && !createToolAccessGate(config?.deniedTools)(input.toolId))
    throw new ToolNotAllowedError(input.toolId)
  if (config) {
    if (input.toolKind === 'custom' && CAPABILITY_RULES['custom_tools.use'].deniedBy(config))
      throw new CustomToolsNotAllowedError()
    if (input.toolKind === 'mcp' && CAPABILITY_RULES['mcp_tools.use'].deniedBy(config))
      throw new McpToolsNotAllowedError()
    if (input.toolKind === 'skill' && CAPABILITY_RULES['skills.use'].deniedBy(config))
      throw new SkillsNotAllowedError()
  }
}

export async function validateInvitationsAllowed(
  userId: string,
  scope: string | { workspaceId: string } | { organizationId: string },
  executor?: DbOrTx
) {
  if (isInvitationsDisabled) throw new InvitationsNotAllowedError()
  const config =
    typeof scope === 'string'
      ? await loadConfig(userId, scope, executor)
      : 'workspaceId' in scope
        ? await loadConfig(userId, scope.workspaceId, executor)
        : await getUserPermissionConfigForOrganization(scope.organizationId, executor)
  if (config && CAPABILITY_RULES['invitations.send'].deniedBy(config))
    throw new InvitationsNotAllowedError()
}

export async function validatePublicApiAllowed(
  userId: string | undefined,
  workspaceId: string | undefined
) {
  if (isPublicApiDisabled) throw new PublicApiNotAllowedError()
  const config = await loadConfig(userId, workspaceId)
  if (config && CAPABILITY_RULES['public_api.use'].deniedBy(config))
    throw new PublicApiNotAllowedError()
}

export async function validateChatDeployAuth(
  userId: string,
  workspaceId: string,
  authType: string
) {
  const config = await loadConfig(userId, workspaceId)
  assertCapability(config, 'deploy.chat.auth_mode', authType)
}

export async function validatePublicFileSharing(
  userId: string,
  workspaceId: string,
  authType: string
) {
  const config = await loadConfig(userId, workspaceId)
  assertCapability(config, 'file_share.publish')
  assertCapability(config, 'file_share.auth_mode', authType)
}
