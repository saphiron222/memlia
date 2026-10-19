// Copyright (c) 2026 Memlia. All rights reserved.
import { PrincipalSchema, BindingSchema, DelegationSchema } from './identity.ts'
import { WorkflowProposalSchema, ApprovalSchema } from './workflow.ts'
import { JobEnvelopeSchema, RunReceiptSchema } from './jobs.ts'
import { AgentCommandSchema, SessionCapabilitySchema } from './desktop.ts'
import {
  ExcelProcedureSchema,
  SnapshotSchema,
  PatchSetSchema,
  CommitReceiptSchema,
} from './excel.ts'
export * from './identity.ts'
export * from './workflow.ts'
export * from './jobs.ts'
export * from './desktop.ts'
export * from './excel.ts'
export const schemas = {
  Principal: PrincipalSchema,
  Binding: BindingSchema,
  Delegation: DelegationSchema,
  WorkflowProposal: WorkflowProposalSchema,
  Approval: ApprovalSchema,
  JobEnvelope: JobEnvelopeSchema,
  RunReceipt: RunReceiptSchema,
  AgentCommand: AgentCommandSchema,
  SessionCapability: SessionCapabilitySchema,
  ExcelProcedure: ExcelProcedureSchema,
  Snapshot: SnapshotSchema,
  PatchSet: PatchSetSchema,
  CommitReceipt: CommitReceiptSchema,
} as const
export type ContractName = keyof typeof schemas
