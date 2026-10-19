// Copyright (c) 2026 Memlia. All rights reserved.
import { z } from 'zod'
import { ArtifactRef, Digest, Id, IdList, Lifetime, Revision, Scope } from './common.ts'

export const WorkflowProposalSchema = z.strictObject({
  schemaVersion: z.literal('memlia.workflow-proposal/v1'),
  ...Scope,
  proposalId: Id,
  workflowId: Id,
  expectedRevision: Revision,
  authorUserId: Id,
  // Exact immutable bytes, resolved privately and validated by Sim's editing
  // use case. Do not redefine its block-specific params in this package.
  operations: ArtifactRef.extend({
    format: z.literal('sim.workflow-operations/v1'),
    count: z.int().min(1).max(200),
  }),
  digest: Digest,
  policyVersion: Id,
  touchedResourceIds: IdList.min(1),
  ...Lifetime,
})
export const ApprovalSchema = z.strictObject({
  schemaVersion: z.literal('memlia.approval/v1'),
  ...Scope,
  approvalId: Id,
  approverUserId: Id,
  ...Lifetime,
  target: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('workflow'),
      proposalId: Id,
      workflowId: Id,
      expectedRevision: Revision,
      digest: Digest,
    }),
    z.strictObject({
      kind: z.literal('excel'),
      procedureId: Id,
      procedureVersion: Revision,
      procedureDigest: Digest,
      snapshotDigest: Digest,
      patchDigest: Digest,
      destinationBindingId: Id,
    }),
  ]),
})
export type WorkflowProposal = z.infer<typeof WorkflowProposalSchema>
export type Approval = z.infer<typeof ApprovalSchema>
