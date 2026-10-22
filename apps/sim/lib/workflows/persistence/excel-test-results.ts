// Copyright (c) 2026 Memlia. All rights reserved.
import { db } from '@sim/db'
import {
  workflow,
  workflowDeploymentVersion,
  workflowExecutionLogs,
  workspaceFiles,
} from '@sim/db/schema'
import { and, eq, isNull, sql } from 'drizzle-orm'

/** Discovery only, behind the native session/write and preparation verification funnel.
 * Kept separate from the active Office catalogue: no inactive result becomes edit authority.
 */
export async function findExcelTestResultCandidates(scope: {
  workspaceId: string
  userId: string
  workflowId: string
  executionId: string
  deploymentVersionId: string
  snapshotDigest: string
}) {
  const prefix = sql<string>`'execution/' || ${workflowExecutionLogs.workspaceId} || '/' || ${workflowExecutionLogs.workflowId} || '/' || ${workflowExecutionLogs.executionId} || '/'`
  return db
    .select({
      workflowId: workflow.id,
      workspaceId: workflowExecutionLogs.workspaceId,
      deploymentVersionId: workflowDeploymentVersion.id,
      snapshotDigest: workflowDeploymentVersion.snapshotDigest,
      executionId: workflowExecutionLogs.executionId,
      completedAt: workflowExecutionLogs.endedAt,
      resultFileId: workspaceFiles.id,
      key: workspaceFiles.key,
      size: workspaceFiles.sizeBytes,
      fileName: workspaceFiles.originalName,
      contentType: workspaceFiles.contentType,
      contentUpdatedAt: workspaceFiles.contentUpdatedAt,
    })
    .from(workflowExecutionLogs)
    .innerJoin(workflow, eq(workflow.id, workflowExecutionLogs.workflowId))
    .innerJoin(
      workflowDeploymentVersion,
      and(
        eq(workflowDeploymentVersion.id, workflowExecutionLogs.deploymentVersionId),
        eq(workflowDeploymentVersion.workflowId, workflow.id)
      )
    )
    .innerJoin(
      workspaceFiles,
      and(
        eq(workspaceFiles.workspaceId, workflowExecutionLogs.workspaceId),
        sql`left(${workspaceFiles.key}, length(${prefix})) = ${prefix}`
      )
    )
    .where(
      and(
        eq(workflow.id, scope.workflowId),
        eq(workflow.workspaceId, scope.workspaceId),
        eq(workflowExecutionLogs.workspaceId, scope.workspaceId),
        eq(workflowExecutionLogs.executionId, scope.executionId),
        eq(workflowExecutionLogs.status, 'completed'),
        isNull(workflow.archivedAt),
        eq(workflowDeploymentVersion.id, scope.deploymentVersionId),
        eq(workflowDeploymentVersion.snapshotDigest, scope.snapshotDigest),
        eq(workflowDeploymentVersion.isActive, false),
        eq(workflowDeploymentVersion.preparationKind, 'excel_test_v1'),
        eq(workflowDeploymentVersion.createdBy, scope.userId),
        eq(workspaceFiles.userId, scope.userId),
        eq(workspaceFiles.context, 'execution'),
        isNull(workspaceFiles.deletedAt)
      )
    )
    .orderBy(workspaceFiles.id)
    .limit(51)
}
