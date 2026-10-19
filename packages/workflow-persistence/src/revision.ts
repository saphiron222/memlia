// Copyright 2026 Memlia. All rights reserved.
import { workflow } from '@sim/db'
import { and, eq, isNull } from 'drizzle-orm'
import type { DbOrTx } from './types'

export type WorkflowDraftTransaction = Extract<DbOrTx, { rollback: () => never }>

/** Native Drizzle transactions expose rollback; the global pool does not. */
export function assertWorkflowDraftTransaction(tx: DbOrTx): asserts tx is WorkflowDraftTransaction {
  if (typeof (tx as Partial<WorkflowDraftTransaction>)?.rollback !== 'function') {
    throw new WorkflowDraftError('validation', 'Workflow draft mutation requires a transaction')
  }
}

export interface WorkflowDraftReceipt {
  baseRevision: number
  draftRevision: number
}

export class WorkflowDraftError extends Error {
  constructor(
    readonly code: 'validation' | 'conflict' | 'not_found',
    message: string
  ) {
    super(message)
    this.name = 'WorkflowDraftError'
  }
}

export function assertWorkflowRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new WorkflowDraftError(
      'validation',
      'Workflow revision must be a non-negative safe integer'
    )
  }
}

/** Caller must pass its business transaction, never the global pool. Lock before reading any graph. */
export async function lockWorkflowDraft(
  tx: WorkflowDraftTransaction,
  workflowId: string,
  expectedRevision?: number
): Promise<number> {
  assertWorkflowDraftTransaction(tx)
  if (expectedRevision !== undefined) assertWorkflowRevision(expectedRevision)
  const [row] = await tx
    .select({ draftRevision: workflow.draftRevision })
    .from(workflow)
    .where(and(eq(workflow.id, workflowId), isNull(workflow.archivedAt)))
    .limit(1)
    .for('update')
  if (!row) throw new WorkflowDraftError('not_found', 'Workflow not found')
  assertWorkflowRevision(row.draftRevision)
  if (expectedRevision !== undefined && row.draftRevision !== expectedRevision) {
    throw new WorkflowDraftError(
      'conflict',
      'Workflow draft changed; refresh the proposal before applying it'
    )
  }
  return row.draftRevision
}

/** Called once after a logical mutation, on the same row-locked transaction. */
export async function advanceWorkflowDraft(
  tx: WorkflowDraftTransaction,
  workflowId: string,
  baseRevision: number
): Promise<WorkflowDraftReceipt> {
  assertWorkflowDraftTransaction(tx)
  assertWorkflowRevision(baseRevision)
  if (baseRevision === Number.MAX_SAFE_INTEGER) {
    throw new WorkflowDraftError('conflict', 'Workflow draft revision limit reached')
  }
  const draftRevision = baseRevision + 1
  const [updated] = await tx
    .update(workflow)
    .set({ draftRevision })
    .where(and(eq(workflow.id, workflowId), eq(workflow.draftRevision, baseRevision)))
    .returning({ draftRevision: workflow.draftRevision })
  if (!updated) throw new WorkflowDraftError('conflict', 'Workflow draft changed during mutation')
  return { baseRevision, draftRevision: updated.draftRevision }
}

/** No external IO/AI/approval in mutate. Failure must propagate to roll back the caller's transaction. */
export async function withWorkflowDraftMutation<T>(
  tx: WorkflowDraftTransaction,
  workflowId: string,
  mutate: () => Promise<{ changed: boolean; value: T }>,
  expectedRevision?: number
): Promise<{ value: T } & WorkflowDraftReceipt> {
  assertWorkflowDraftTransaction(tx)
  const baseRevision = await lockWorkflowDraft(tx, workflowId, expectedRevision)
  const result = await mutate()
  const receipt = result.changed
    ? await advanceWorkflowDraft(tx, workflowId, baseRevision)
    : { baseRevision, draftRevision: baseRevision }
  return { value: result.value, ...receipt }
}
