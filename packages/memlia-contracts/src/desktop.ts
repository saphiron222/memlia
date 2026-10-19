// Copyright (c) 2026 Memlia. All rights reserved.
import { z } from 'zod'
import { ArtifactRef, Digest, Id, Lifetime, Revision, Scope, Timestamp } from './common.ts'

export const ResourceLock = z.strictObject({
  kind: z.enum(['desktop', 'workbook', 'com_session']),
  resourceId: Id,
  fence: Revision,
})
const session = {
  ...Scope,
  agentId: Id,
  ownerUserId: Id,
  windowsSid: z.string().regex(/^S-1-(?:[0-9]+-){1,14}[0-9]+(?![\s\S])/),
  sessionId: Id,
  leaseEpoch: Revision,
  ...Lifetime,
  resourceLocks: z.array(ResourceLock).min(1).max(8),
}
export const SessionCapabilitySchema = z.strictObject({
  schemaVersion: z.literal('memlia.session-capability/v1'),
  ...session,
  capabilityId: Id,
  consent: z.strictObject({ consentId: Id, confirmedLocallyAt: Timestamp, commandDigest: Digest }),
  capabilities: z
    .array(z.enum(['desktop.capture', 'desktop.replay', 'excel.apply', 'excel.recalculate']))
    .min(1)
    .max(4),
  qualification: ArtifactRef,
})
export const AgentCommandSchema = z.strictObject({
  schemaVersion: z.literal('memlia.desktop-command/v1'),
  ...session,
  commandId: Id,
  runId: Id,
  digest: Digest,
  capabilityId: Id,
  bundle: ArtifactRef,
  qualification: ArtifactRef,
  action: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('capture.start'),
      maxDurationSeconds: z.int().min(1).max(1800),
      maxBytes: z.int().min(1).max(2147483648),
      audio: z.literal(false),
    }),
    z.strictObject({
      kind: z.literal('procedure.run'),
      procedure: ArtifactRef,
      parameters: ArtifactRef,
    }),
    z.strictObject({
      kind: z.literal('excel.apply'),
      patch: ArtifactRef,
      approvalId: Id,
      backup: ArtifactRef,
    }),
  ]),
})
export type AgentCommand = z.infer<typeof AgentCommandSchema>
export type SessionCapability = z.infer<typeof SessionCapabilitySchema>
