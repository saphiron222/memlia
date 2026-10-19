// Copyright (c) 2026 Memlia. All rights reserved.
import { z } from 'zod'
import { Id, IdList, Label, Lifetime, Revision, Scope, StringList, Timestamp } from './common.ts'

// Wire projection of Sim's SerializedPrincipalV1. This validates transport only;
// Sim parsePrincipal/serializePrincipal and platform-authz remain authoritative.
const HumanActor = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('session'), userId: Id, sessionId: Id }),
  z.strictObject({ kind: z.literal('personal_api_key'), userId: Id, keyId: Id }),
  z.strictObject({
    kind: z.literal('oauth_access_token'),
    userId: Id,
    clientId: Id,
    tokenId: Id,
    scopes: StringList,
    expiresAt: Timestamp,
  }),
])
const ServiceActor = z.union([
  z.strictObject({ kind: z.literal('workspace_api_key'), workspaceId: Id, keyId: Id }),
  z.strictObject({
    kind: z.literal('system'),
    serviceId: z.enum(['public_api', 'schedule', 'internal', 'table', 'chat']),
    workspaceId: Id,
    workflowId: Id,
  }),
  z.strictObject({
    kind: z.literal('system'),
    serviceId: z.literal('webhook'),
    workspaceId: Id,
    workflowId: Id,
    webhookId: Id,
    provider: Label,
  }),
])
const DelegatedActor = z.strictObject({
  kind: z.literal('delegated'),
  serviceId: z.enum(['copilot', 'realtime']),
  subjectUserId: Id,
  workspaceId: Id,
  delegationId: Id,
  audience: Label,
  ...Lifetime,
})
export const SerializedSimPrincipal = z.strictObject({
  version: z.literal(1),
  principal: z.union([HumanActor, ServiceActor, DelegatedActor]),
})
const base = {
  schemaVersion: z.literal('memlia.principal/v1'),
  ...Scope,
  scopes: StringList,
  allowedTools: StringList,
}
export const PrincipalSchema = z.union([
  z.strictObject({
    ...base,
    actor: z.strictObject({ version: z.literal(1), principal: HumanActor }),
    subject: z.strictObject({ kind: z.literal('user'), userId: Id }),
    authority: z.strictObject({ kind: z.literal('interactive') }),
  }),
  z.strictObject({
    ...base,
    actor: SerializedSimPrincipal,
    subject: z.strictObject({ kind: z.literal('user'), userId: Id }),
    authority: z.strictObject({ kind: z.literal('delegation'), delegationId: Id }),
  }),
  z.strictObject({
    ...base,
    actor: z.strictObject({ version: z.literal(1), principal: ServiceActor }),
    subject: z.strictObject({ kind: z.literal('service'), serviceAccountId: Id }),
    authority: z.strictObject({ kind: z.literal('approved_shared'), grantId: Id }),
  }),
])
export const BindingSchema = z.strictObject({
  schemaVersion: z.literal('memlia.binding/v1'),
  ...Scope,
  bindingId: Id,
  provider: Label,
  accountRef: Id,
  scopes: StringList,
  connection: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('personal'),
      subjectUserId: Id,
      resolution: z.literal('subject_only'),
    }),
    z.strictObject({
      kind: z.literal('shared'),
      credentialOwnerUserId: Id,
      approvalId: Id,
      allowedSubjectIds: IdList.min(1),
    }),
  ]),
})
export const DelegationSchema = z.strictObject({
  schemaVersion: z.literal('memlia.delegation/v1'),
  ...Scope,
  delegationId: Id,
  subjectUserId: Id,
  serviceId: z.enum(['schedule', 'webhook', 'workspace_api_key', 'copilot', 'realtime']),
  triggerId: Id,
  workflowId: Id,
  deployedVersionId: Id,
  bindingIds: IdList,
  scopes: StringList,
  allowedTools: StringList,
  ...Lifetime,
  revocation: z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('active'), revision: Revision }),
    z.strictObject({ state: z.literal('revoked'), revision: Revision, revokedAt: Timestamp }),
  ]),
})
export type Principal = z.infer<typeof PrincipalSchema>
export type Binding = z.infer<typeof BindingSchema>
export type Delegation = z.infer<typeof DelegationSchema>
