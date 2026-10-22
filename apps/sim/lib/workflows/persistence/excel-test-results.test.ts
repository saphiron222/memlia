// Copyright (c) 2026 Memlia. All rights reserved.
// SQL builder ports doubled; these assertions do not qualify a native PostgreSQL run.
import { dbChainMockFns, queueTableRows, resetDbChainMock, schemaMock } from '@sim/testing'
import { eq, isNull, sql } from 'drizzle-orm'
import { beforeEach, expect, it, vi } from 'vitest'
import { findExcelTestResultCandidates } from './excel-test-results'

const scope = {
  workspaceId: 'space',
  userId: 'subject',
  workflowId: 'workflow',
  executionId: 'test-run',
  deploymentVersionId: 'inactive-version',
  snapshotDigest: `sha256:${'a'.repeat(64)}`,
}
beforeEach(() => resetDbChainMock())
it('binds the exact completed journal to an inactive owned test version and owned execution files, bounded to 51 rows', async () => {
  queueTableRows(schemaMock.workflowExecutionLogs, [{ resultFileId: 'file' }])
  expect(await findExcelTestResultCandidates(scope)).toEqual([{ resultFileId: 'file' }])
  for (const [column, value] of [
    [schemaMock.workflow.id, scope.workflowId],
    [schemaMock.workflow.workspaceId, scope.workspaceId],
    [schemaMock.workflowExecutionLogs.workspaceId, scope.workspaceId],
    [schemaMock.workflowExecutionLogs.executionId, scope.executionId],
    [schemaMock.workflowExecutionLogs.status, 'completed'],
    [schemaMock.workflowDeploymentVersion.id, scope.deploymentVersionId],
    [schemaMock.workflowDeploymentVersion.snapshotDigest, scope.snapshotDigest],
    [schemaMock.workflowDeploymentVersion.createdBy, scope.userId],
    [schemaMock.workflowDeploymentVersion.isActive, false],
    [schemaMock.workflowDeploymentVersion.preparationKind, 'excel_test_v1'],
    [schemaMock.workspaceFiles.userId, scope.userId],
    [schemaMock.workspaceFiles.context, 'execution'],
  ])
    expect(vi.mocked(eq)).toHaveBeenCalledWith(column, value)
  expect(vi.mocked(isNull)).toHaveBeenCalledWith(schemaMock.workflow.archivedAt)
  expect(vi.mocked(isNull)).toHaveBeenCalledWith(schemaMock.workspaceFiles.deletedAt)
  expect(vi.mocked(eq)).toHaveBeenCalledWith(
    schemaMock.workflowDeploymentVersion.id,
    schemaMock.workflowExecutionLogs.deploymentVersionId
  )
  expect(vi.mocked(eq)).toHaveBeenCalledWith(
    schemaMock.workflowDeploymentVersion.workflowId,
    schemaMock.workflow.id
  )
  expect(vi.mocked(sql).mock.calls.some(([text]) => text.join('').includes('left('))).toBe(true)
  expect(dbChainMockFns.limit).toHaveBeenCalledExactlyOnceWith(51)
  expect(dbChainMockFns.insert).not.toHaveBeenCalled()
  expect(dbChainMockFns.update).not.toHaveBeenCalled()
  expect(dbChainMockFns.delete).not.toHaveBeenCalled()
})
