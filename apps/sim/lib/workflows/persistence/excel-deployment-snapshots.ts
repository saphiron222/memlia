// Copyright (c) 2026 Memlia. All rights reserved.
import { ExcelProcedureSchema } from '@memlia/contracts'
import type { PrincipalActor } from '@sim/auth/principal'
import { db, workflow, workspace } from '@sim/db'
import { createLogger } from '@sim/logger'
import { sha256Hex } from '@sim/security/hash'
import { loadWorkflowFromNormalizedTablesRaw } from '@sim/workflow-persistence/load'
import type { WorkflowState } from '@sim/workflow-types/workflow'
import { eq } from 'drizzle-orm'
import { workflowStateSchema } from '@/lib/api/contracts/workflows'
import { OrchestrationError } from '@/lib/core/orchestration/types'
import { readOwnDataString, stringifyBoundedJson } from '@/lib/core/utils/bounded-json'
import { captureExcelProcedureSnapshot } from '@/lib/memlia/excel/materialize-procedure-snapshot'
import { normalizedStringify } from '@/lib/workflows/comparison/normalize'
import { assertNoWithheldBlockType } from './block-access-guard'
import { deploymentRefusalErrorFields, setDeploymentTxTimeouts } from './deployment-operations'

const logger = createLogger('ExcelDeploymentSnapshots')
const POLICY = 'memlia_excel_publication_v1'
const REFUSED = 'Excel deployment snapshot refused'
const digest = (value: unknown) => `sha256:${sha256Hex(normalizedStringify(value))}`
const refusals = new WeakSet<object>()
/** Logs the internal code of the refusing check once; the client only sees the fixed refusal. */
function refuse(
  context: { requestId?: string; workflowId: string },
  check: string,
  extra: Record<string, string> = {}
): never {
  logger.error(`[${context.requestId}] ${REFUSED}`, {
    workflowId: context.workflowId,
    check,
    ...extra,
  })
  const error = new OrchestrationError('validation', REFUSED)
  refusals.add(error)
  throw error
}
function author(actor: PrincipalActor | undefined): string | undefined {
  switch (actor?.kind) {
    case 'session':
    case 'personal_api_key':
    case 'oauth_access_token':
      return actor.userId
    case 'delegated':
    case 'resource_delegated':
    case 'organization_delegated':
      return actor.subjectUserId
    default:
      return undefined
  }
}

/**
 * Trusted read port for an already-authorized native publish action. Reads no test version.
 * A null result selects the pre-existing non-Excel deployment loader, never an Excel fallback.
 */
export async function captureWorkflowExcelDeploymentSnapshot(input: {
  workflowId: string
  assertedWorkspaceId?: string
  idempotencyKey: string
  actor?: PrincipalActor
  /** Correlation ID for logging only. */
  requestId?: string
}) {
  // Only primitives cross the first await; legacy userId/billing attribution is not authorship.
  const workflowId = input.workflowId
  const assertedWorkspaceId = input.assertedWorkspaceId
  const idempotencyKey = input.idempotencyKey
  const ownerUserId = author(input.actor)
  const refusal = { requestId: readOwnDataString(input, ['requestId']), workflowId }
  const captured = await db
    .transaction(
      async (tx) => {
        await setDeploymentTxTimeouts(tx)
        const [row] = await tx
          .select({
            workspaceId: workflow.workspaceId,
            draftRevision: workflow.draftRevision,
            variables: workflow.variables,
            archivedAt: workflow.archivedAt,
          })
          .from(workflow)
          .where(eq(workflow.id, workflowId))
          .limit(1)
        const raw = await loadWorkflowFromNormalizedTablesRaw(workflowId, tx)
        if (!row || row.archivedAt || !raw || raw.workspaceId !== row.workspaceId)
          refuse(refusal, 'workflow_row')
        const excel = Object.entries(raw.blocks).filter(
          ([, block]) => block.type === 'memlia_excel'
        )
        if (excel.length === 0) return null
        if (assertedWorkspaceId !== raw.workspaceId) refuse(refusal, 'asserted_workspace')
        if (
          raw.draftRevision !== row.draftRevision ||
          !Number.isSafeInteger(row.draftRevision) ||
          row.draftRevision < 0
        )
          refuse(refusal, 'draft_revision')
        if (!ExcelProcedureSchema.shape.ownerUserId.safeParse(ownerUserId).success)
          refuse(refusal, 'author')
        if (
          typeof idempotencyKey !== 'string' ||
          idempotencyKey.length === 0 ||
          idempotencyKey.length > 1024
        )
          refuse(refusal, 'idempotency_key')
        const [space] = await tx
          .select({ organizationId: workspace.organizationId, archivedAt: workspace.archivedAt })
          .from(workspace)
          .where(eq(workspace.id, raw.workspaceId))
          .limit(1)
        if (!space || space.archivedAt) refuse(refusal, 'workspace')
        const workflowState: WorkflowState = JSON.parse(
          normalizedStringify({
            blocks: raw.blocks,
            edges: raw.edges,
            loops: raw.loops,
            parallels: raw.parallels,
            variables: row.variables ?? {},
          })
        )
        if (
          stringifyBoundedJson(workflowState, 2 * 1024 * 1024, { strict: true }) === undefined ||
          !workflowStateSchema.safeParse(workflowState).success
        )
          refuse(refusal, 'workflow_state')
        const scope = {
          workflowId,
          workspaceId: raw.workspaceId,
          organizationId: space.organizationId,
        }
        const expectedStateDigest = digest(workflowState)
        const procedures = excel.map(([blockId, block]) => {
          const value = block.subBlocks.request?.value
          if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 512 * 1024)
            refuse(refusal, 'excel_request')
          let request: unknown
          try {
            request = JSON.parse(value)
          } catch {
            refuse(refusal, 'excel_request')
          }
          return {
            blockId,
            expectedRequestDigest: digest(request),
            procedureId: sha256Hex(
              normalizedStringify({
                scope,
                blockId,
                idempotencyKey,
                expectedStateDigest,
                ownerUserId,
                policyVersion: POLICY,
              })
            ),
            version: 1,
            parentVersion: null,
            ownerUserId,
            policyVersion: POLICY,
          }
        })
        let excelProcedureSnapshot: object
        try {
          excelProcedureSnapshot = captureExcelProcedureSnapshot({
            workflowState,
            expectedRevision: row.draftRevision,
            expectedStateDigest,
            scope,
            procedures,
          })
        } catch {
          refuse(refusal, 'procedure_capture')
        }
        return { workflowState, excelProcedureSnapshot, workspaceId: scope.workspaceId }
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' }
    )
    // Any other failure of the read transaction refuses too, never falls back.
    .catch((error) => {
      if (refusals.has(error)) throw error
      return refuse(refusal, 'read_transaction_failed', deploymentRefusalErrorFields(error))
    })
  if (captured) {
    await assertNoWithheldBlockType(
      { workspaceId: captured.workspaceId, subjectUserId: ownerUserId ?? null },
      Object.values(captured.workflowState.blocks)
    )
  }
  return captured
}
