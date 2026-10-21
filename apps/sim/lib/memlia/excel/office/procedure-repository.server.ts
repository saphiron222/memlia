// Copyright (c) 2026 Memlia. All rights reserved.
import { db } from '@sim/db'
import {
  workflow,
  workflowDeploymentVersion,
  workflowExecutionLogs,
  workspaceFiles,
} from '@sim/db/schema'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import type { OfficeProcedureResult } from '@/lib/api/contracts/excel-office-procedures'

/** Metadata discovery only; application use cases authorize every workflow/run/byte read. */
export async function findOfficeProcedureCandidates(
  workspaceId: string,
  userId: string,
  source?: OfficeProcedureResult
) {
  const prefix = sql<string>`'execution/' || ${workflowExecutionLogs.workspaceId} || '/' || ${workflowExecutionLogs.workflowId} || '/' || ${workflowExecutionLogs.executionId} || '/'`
  return db
    .select({
      workflowId: workflow.id,
      workflowName: workflow.name,
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
        eq(workflow.workspaceId, workspaceId),
        eq(workflowExecutionLogs.workspaceId, workspaceId),
        isNull(workflow.archivedAt),
        eq(workflowExecutionLogs.status, 'completed'),
        eq(workflowDeploymentVersion.isActive, true),
        isNull(workflowDeploymentVersion.preparationKind),
        eq(workspaceFiles.userId, userId),
        eq(workspaceFiles.context, 'execution'),
        isNull(workspaceFiles.deletedAt),
        source
          ? and(
              eq(workflow.id, source.workflowId),
              eq(workflowDeploymentVersion.id, source.deploymentVersionId),
              eq(workflowExecutionLogs.executionId, source.executionId),
              eq(workspaceFiles.id, source.resultFileId)
            )
          : undefined
      )
    )
    .orderBy(desc(workflowExecutionLogs.endedAt), workspaceFiles.id)
    .limit(source ? 1 : 51)
}
export type OfficeProcedureCandidate = Awaited<
  ReturnType<typeof findOfficeProcedureCandidates>
>[number]
