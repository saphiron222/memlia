// Copyright (c) 2026 Memlia. All rights reserved.
import { z } from 'zod'
import { Id, RefList, Revision, Scope, Timestamp } from './common.ts'
import { PrincipalSchema } from './identity.ts'

// Existing Apache Sim JobType names. Excludes run-data-drain (EE). A schema
// entry does not register a runner; admission must check the actual registry.
export const Runner = z.enum([
  'slack-search',
  'workflow-execution',
  'schedule-execution',
  'webhook-execution',
  'quickbooks-webhook-ingress',
  'resume-execution',
  'workflow-group-cell',
  'cleanup-logs',
  'cleanup-soft-deletes',
  'cleanup-table-row-ttl',
  'cleanup-stale-executions',
  'cleanup-tasks',
  'cleanup-file-versions',
  'cleanup-dispatch',
  'knowledge-connector-directory-sync',
])
export const JobEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal('memlia.job/v1'),
  commandId: Id,
  runId: Id,
  runner: Runner,
  inputs: RefList,
  authority: PrincipalSchema,
  idempotencyKey: Id,
  submittedAt: Timestamp,
  effectPolicy: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('read_only') }),
    z.strictObject({ kind: z.literal('provider_idempotent'), providerKey: Id, verifierId: Id }),
    z.strictObject({ kind: z.literal('no_automatic_retry') }),
  ]),
})
export const RunReceiptSchema = z.strictObject({
  schemaVersion: z.literal('memlia.run-receipt/v1'),
  ...Scope,
  runId: Id,
  commandId: Id,
  sequence: Revision,
  recordedAt: Timestamp,
  outcome: z.discriminatedUnion('status', [
    z.strictObject({
      status: z.enum([
        'queued',
        'awaiting_local_consent',
        'running',
        'awaiting_intervention',
        'stop_requested',
      ]),
      effect: z.enum(['none', 'known', 'unknown']),
      evidence: RefList,
    }),
    z.strictObject({
      status: z.literal('succeeded_verified'),
      effect: z.literal('known'),
      evidence: RefList.min(1),
      verifierId: Id,
    }),
    z.strictObject({
      status: z.enum(['failed', 'stopped']),
      effect: z.enum(['none', 'known']),
      evidence: RefList,
      reasonCode: Id,
    }),
    z.strictObject({
      status: z.literal('cancelled_before_start'),
      effect: z.literal('none'),
      evidence: RefList,
    }),
    z.strictObject({
      status: z.literal('uncertain'),
      effect: z.literal('unknown'),
      reconciliationRequired: z.literal(true),
      evidence: RefList,
    }),
  ]),
})
export type JobEnvelope = z.infer<typeof JobEnvelopeSchema>
export type RunReceipt = z.infer<typeof RunReceiptSchema>
