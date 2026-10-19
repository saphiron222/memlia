// Copyright 2026 Memlia. All rights reserved.
import { createHash } from 'node:crypto'
import { type Principal, requirePrincipalSubjectUserId } from '@sim/auth/principal'
import { db } from '@sim/db'
import { memliaWorkflowCopy, permissions, user, workflow, workspace } from '@sim/db/schema'
import { generateId } from '@sim/utils/id'
import { sortObjectKeysDeep } from '@sim/utils/object'
import {
  loadWorkflowFromNormalizedTablesRaw,
  type RawNormalizedWorkflow,
} from '@sim/workflow-persistence/load'
import { and, eq } from 'drizzle-orm'
import { isAccountBlocked } from '@/lib/auth/ban'
import { authorizeWorkspaceOperation } from '@/lib/core/application'
import { OrchestrationError } from '@/lib/core/orchestration/types'
import { resolveActiveWorkflowApplicationContext } from '@/lib/workflows/application/context'
import { workflowOperations } from '@/lib/workflows/application/operations'
import { insertNewWorkflowRow } from '@/lib/workflows/persistence/new-workflow-row'
import { admitWorkflowState, saveAdmittedWorkflowState } from '@/lib/workflows/persistence/utils'
import { nextWorkflowSortOrder } from '@/lib/workflows/sort-order'
import { deduplicateWorkflowName } from '@/lib/workflows/utils'
import { resolveActiveWorkspaceApplicationContext } from '@/lib/workspaces/application/context'
import { preparePrivateCopyState } from './private-copy-state'

export interface PrivateWorkflowCopyInput {
  sourceWorkflowId: string
  destinationWorkspaceId: string
  name: string
}

export function requirePrivateCopySubject(principal: Principal) {
  if (!['session', 'personal_api_key', 'oauth_access_token'].includes(principal.kind)) {
    throw new OrchestrationError(
      'forbidden',
      'A private copy requires an authenticated human principal'
    )
  }
  return requirePrincipalSubjectUserId(principal)
}

/** SQL row order is not graph state. Preserve authored arrays; only edges form an ID-keyed set. */
function sourceStateDigest(source: RawNormalizedWorkflow) {
  const canonical = sortObjectKeysDeep({
    ...source,
    edges: [...source.edges].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  })
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

/** All state is loaded server-side. Serializable admission also protects the membership predicate. */
export async function copyPrivateWorkflowRecord(
  principal: Principal,
  input: PrivateWorkflowCopyInput
) {
  const subjectUserId = requirePrivateCopySubject(principal)
  // Native authoring admission uses the global pool. Keep it outside the business transaction,
  // then compare the locked source snapshot and recheck grants inside before any mutation.
  const sourceContext = await resolveActiveWorkflowApplicationContext({
    workflowId: input.sourceWorkflowId,
  })
  const targetContext = await resolveActiveWorkspaceApplicationContext(input.destinationWorkspaceId)
  await authorizeWorkspaceOperation(principal, workflowOperations.export, sourceContext)
  await authorizeWorkspaceOperation(principal, workflowOperations.create, targetContext)
  const original = await loadWorkflowFromNormalizedTablesRaw(input.sourceWorkflowId)
  if (!original) throw new OrchestrationError('not_found', 'Workflow state not found')
  const revision = sourceStateDigest(original)
  const prepared = preparePrivateCopyState({ ...original, variables: {} })
  const admitted = await admitWorkflowState(prepared.state, {
    workspaceId: input.destinationWorkspaceId,
    subjectUserId,
  })
  return db.transaction(
    async (tx) => {
      const [account] = await tx
        .select()
        .from(user)
        .where(eq(user.id, subjectUserId))
        .for('share')
        .limit(1)
      if (!account || isAccountBlocked(account))
        throw new OrchestrationError('forbidden', 'Account is not active')
      const [target] = await tx
        .select()
        .from(workspace)
        .where(eq(workspace.id, input.destinationWorkspaceId))
        .for('update')
        .limit(1)
      if (
        !target ||
        target.archivedAt ||
        target.workspaceMode !== 'personal' ||
        target.ownerId !== subjectUserId ||
        target.organizationId !== null
      ) {
        throw new OrchestrationError(
          'forbidden',
          'Destination must be the subject personal workspace'
        )
      }
      const [source] = await tx
        .select()
        .from(workflow)
        .where(eq(workflow.id, input.sourceWorkflowId))
        .for('share')
        .limit(1)
      if (!source || source.archivedAt || !source.workspaceId || source.workspaceId === target.id)
        throw new OrchestrationError('not_found', 'Shared source workflow not found')
      const [sourceWorkspace] = await tx
        .select()
        .from(workspace)
        .where(eq(workspace.id, source.workspaceId))
        .for('share')
        .limit(1)
      if (!sourceWorkspace || sourceWorkspace.archivedAt)
        throw new OrchestrationError('not_found', 'Shared source workflow not found')
      const context = (row: typeof workspace.$inferSelect) => ({
        workspaceId: row.id,
        workspaceOrganizationId: row.organizationId,
        allowPersonalApiKeys: row.allowPersonalApiKeys,
      })
      // Ownership is a destination-identity constraint, never a replacement for these native grants.
      await authorizeWorkspaceOperation(
        principal,
        workflowOperations.export,
        context(sourceWorkspace),
        { executor: tx, forUpdate: true }
      )
      await authorizeWorkspaceOperation(principal, workflowOperations.create, context(target), {
        executor: tx,
        forUpdate: true,
      })
      const members = await tx
        .select({ userId: permissions.userId })
        .from(permissions)
        .where(and(eq(permissions.entityType, 'workspace'), eq(permissions.entityId, target.id)))
        .for('share')
      if (members.length !== 1 || members[0].userId !== subjectUserId)
        throw new OrchestrationError(
          'forbidden',
          'Destination is not a single-user personal workspace'
        )
      const raw = await loadWorkflowFromNormalizedTablesRaw(source.id, tx)
      if (!raw) throw new OrchestrationError('not_found', 'Workflow state not found')
      if (source.workspaceId !== sourceContext.workspaceId || sourceStateDigest(raw) !== revision)
        throw new OrchestrationError('conflict', 'Source workflow changed during private copy')
      const id = generateId()
      const name = await deduplicateWorkflowName(input.name, target.id, null, tx)
      const sortOrder = await nextWorkflowSortOrder(target.id, null, tx)
      await insertNewWorkflowRow(tx, {
        id,
        userId: subjectUserId,
        workspaceId: target.id,
        folderId: null,
        name,
        description: null,
        sortOrder,
        variables: {},
      })
      const saved = await saveAdmittedWorkflowState(tx, id, admitted)
      if (!saved.success)
        throw new OrchestrationError('internal', 'Private workflow copy could not be persisted')
      // Provenance and the new graph commit together; never inherit source grants or bindings.
      await tx.insert(memliaWorkflowCopy).values({
        workflowId: id,
        sourceWorkflowId: source.id,
        sourceStateDigest: revision,
        createdByUserId: subjectUserId,
        createdAt: new Date(),
      })
      return {
        id,
        name,
        workspaceId: target.id,
        configurationRequired: prepared.configurationRequired,
        source: { workflowId: source.id, revision },
      }
    },
    { isolationLevel: 'serializable' }
  )
}
