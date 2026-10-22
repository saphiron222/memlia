// Copyright (c) 2026 Memlia. All rights reserved.
import { z } from 'zod'
import { ArtifactRef, Digest, Id, Revision, Timestamp } from './common.ts'
import { AgentCommandSchema, SessionCapabilitySchema } from './desktop.ts'
import { RunReceiptSchema } from './jobs.ts'

// These bounds keep each HTTP body below the listener's 512 KiB limit. A bundle
// is streamed as separately hashed artifacts, never a base64-encoded ZIP body.
export const AGENT_CONTROL_BODY_BYTES = 524288
export const AGENT_ARTIFACT_CHUNK_BYTES = 262144
export const AGENT_ARTIFACT_MAX_BYTES = 34603008
const Offset = z.int().min(0).max(AGENT_ARTIFACT_MAX_BYTES)
const Base64 = z.string().max(349528).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?(?![\s\S])/)
const Command = z.strictObject({ commandId: Id, digest: Digest, leaseEpoch: Revision })
export const AgentSessionObservation = z.strictObject({
  windowsSid: z.string().regex(/^S-1-(?:[0-9]+-){1,14}[0-9]+(?![\s\S])/),
  sessionId: Id,
})
export const AgentConsentObservation = z.strictObject({
  ...AgentSessionObservation.shape,
  consentId: Id,
  confirmedLocallyAt: Timestamp,
  commandDigest: Digest,
})
const request = { schemaVersion: z.literal('memlia.agent-control-request/v1'), requestId: Id }
const response = { schemaVersion: z.literal('memlia.agent-control-response/v1'), requestId: Id }

export const AgentControlRequestSchema = z.discriminatedUnion('op', [
  z.strictObject({ ...request, op: z.literal('claim'), session: AgentSessionObservation }),
  z.strictObject({ ...request, op: z.literal('checkpoint'), command: Command, capabilityId: Id.nullable() }),
  z.strictObject({ ...request, op: z.literal('consent'), command: Command, observation: AgentConsentObservation }),
  z.strictObject({
    ...request, op: z.literal('artifact.read'), command: Command, capabilityId: Id.nullable(),
    reference: ArtifactRef, offset: Offset, limit: z.int().min(1).max(AGENT_ARTIFACT_CHUNK_BYTES),
  }),
  z.strictObject({
    ...request, op: z.literal('artifact.put'), command: Command, capabilityId: Id,
    reference: ArtifactRef, offset: Offset, totalBytes: Offset, dataBase64: Base64,
  }),
  z.strictObject({
    ...request, op: z.literal('publish'), command: Command, capabilityId: Id.nullable(),
    receipt: RunReceiptSchema, artifacts: z.array(ArtifactRef).max(128),
  }),
])
export const AgentControlResponseSchema = z.discriminatedUnion('op', [
  z.strictObject({ ...response, op: z.literal('claim'), command: AgentCommandSchema.nullable() }),
  z.strictObject({ ...response, op: z.literal('checkpoint'), accepted: z.literal(true) }),
  z.strictObject({ ...response, op: z.literal('consent'), capability: SessionCapabilitySchema }),
  z.strictObject({
    ...response, op: z.literal('artifact.read'), reference: ArtifactRef,
    offset: Offset, totalBytes: Offset, dataBase64: Base64, done: z.boolean(),
  }),
  z.strictObject({
    ...response, op: z.literal('artifact.put'), reference: ArtifactRef,
    nextOffset: Offset, complete: z.boolean(),
  }),
  z.strictObject({ ...response, op: z.literal('publish'), accepted: z.literal(true) }),
  z.strictObject({
    ...response, op: z.literal('refused'),
    code: z.enum(['control_refused', 'control_unavailable']),
  }),
])
export type AgentControlRequest = z.infer<typeof AgentControlRequestSchema>
export type AgentControlResponse = z.infer<typeof AgentControlResponseSchema>
