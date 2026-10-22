// Copyright (c) 2026 Memlia. All rights reserved.
import { createExecutorContext, createSerializedBlock } from '@sim/testing'
import {
  permissionCheckMock,
  permissionCheckMockFns,
} from '@sim/testing/mocks/permission-check.mock'
import {
  uploadsExecutionMock,
  uploadsExecutionMockFns,
} from '@sim/testing/mocks/uploads-execution.mock'
import { afterAll, beforeEach, expect, it, vi } from 'vitest'
import { createInternalToolFileResult } from '@/lib/internal/tool-operations/file-result'
import { bindInternalToolFilePublication } from '@/lib/internal/tool-operations/file-result.server'
import { executeExcelFile } from '@/lib/memlia/excel/execute-excel-file.server'
import { runWithExcelToolWorkerRuntime } from '@/lib/memlia/excel/execute-tool.server'
import { GenericBlockHandler } from '@/executor/handlers/generic/handler'
import { executeTool } from '@/tools'
import { tools } from '@/tools/registry'
import { memliaExcelTransformTool } from './transform'

// The engine, tool executor, operation registry, handler, protected result and presenter are real.
// File preparation, permissions DB and storage I/O are explicit doubles, qualified separately.
vi.mock('@/lib/memlia/excel/execute-excel-file.server', () => ({ executeExcelFile: vi.fn() }))
vi.mock('@/lib/permission-groups/permission-check', () => permissionCheckMock)
vi.mock('@/lib/uploads/contexts/execution', () => uploadsExecutionMock)
const runtime = { socketPath: '/run/memlia/excel.sock', operatorUid: 0 }
const provenance = { status: 'unrecorded' as const }
const stored = {
  id: 'file-fixture',
  name: 'result.xlsx',
  url: '/api/files/execution/fixture',
  size: 7,
  type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  key: 'execution/fixture',
  context: 'execution' as const,
}
const input = { procedure: { synthetic: true }, sources: {}, output: { name: 'result.xlsx' } }
const revalidate = vi.fn()
const previous = tools.memlia_excel_transform
beforeEach(() => {
  vi.clearAllMocks()
  tools.memlia_excel_transform = memliaExcelTransformTool
  uploadsExecutionMockFns.mockUploadExecutionFile.mockResolvedValue(stored)
  vi.mocked(executeExcelFile).mockImplementation(async (_input, context) => {
    return bindInternalToolFilePublication(
      createInternalToolFileResult(
        { buffer: Buffer.from('fixture'), name: stored.name, mimeType: stored.type },
        (file) => ({ success: true, output: { file } })
      ),
      provenance,
      async (current) => {
        expect(current).toBe(context)
        await revalidate()
      }
    )
  })
})
afterAll(() => {
  if (previous) tools.memlia_excel_transform = previous
  else Reflect.deleteProperty(tools, 'memlia_excel_transform')
})

it('passes the protected file through GenericBlockHandler, executeTool and the native presenter', async () => {
  const ctx = createExecutorContext({
    workflowId: 'workflow',
    workspaceId: 'workspace',
    executionId: 'run',
    userId: 'user',
  })
  const result = await runWithExcelToolWorkerRuntime(runtime, () =>
    new GenericBlockHandler().execute(
      ctx,
      createSerializedBlock({ type: 'memlia_excel', tool: 'memlia_excel_transform' }),
      { request: input, _context: { userId: 'foreign', executionId: 'foreign' } }
    )
  )
  expect(result).toEqual({ file: stored })
  expect(executeExcelFile).toHaveBeenCalledTimes(1)
  expect(vi.mocked(executeExcelFile).mock.calls[0][0]).toEqual(input)
  expect(vi.mocked(executeExcelFile).mock.calls[0][1]).toMatchObject({
    userId: 'user',
    executionId: 'run',
    workflowId: 'workflow',
    workspaceId: 'workspace',
  })
  expect(revalidate).toHaveBeenCalledTimes(2)
  expect(uploadsExecutionMockFns.mockUploadExecutionFile).toHaveBeenCalledTimes(1)
  expect(uploadsExecutionMockFns.mockUploadExecutionFile.mock.calls[0][5]).toEqual(provenance)
  expect(permissionCheckMockFns.mockAssertPermissionsAllowed).toHaveBeenCalled()
})
it('refuses native executeTool without worker scope and never prepares or uploads', async () => {
  const result = await executeTool(
    'memlia_excel_transform',
    { request: input },
    {
      executionContext: createExecutorContext({
        workflowId: 'workflow',
        workspaceId: 'workspace',
        executionId: 'run',
        userId: 'user',
      }),
    }
  )
  expect(result.success).toBe(false)
  expect(result.error).toContain('excel_tool_unavailable')
  expect(result.retryable).toBe(false)
  expect(executeExcelFile).not.toHaveBeenCalled()
  expect(uploadsExecutionMockFns.mockUploadExecutionFile).not.toHaveBeenCalled()
})
it('refuses a copied result whose private publication binding was lost before upload', async () => {
  const original = vi.mocked(executeExcelFile).getMockImplementation()!
  vi.mocked(executeExcelFile).mockImplementation(async (...args) => ({
    ...(await original(...args)),
  }))
  const result = await runWithExcelToolWorkerRuntime(runtime, () =>
    executeTool(
      'memlia_excel_transform',
      { request: input },
      {
        executionContext: createExecutorContext({
          workflowId: 'workflow',
          workspaceId: 'workspace',
          executionId: 'run',
          userId: 'user',
        }),
      }
    )
  )
  expect(result.success).toBe(false)
  expect(uploadsExecutionMockFns.mockUploadExecutionFile).not.toHaveBeenCalled()
})
it('never retries the native operation after a fixed preparation refusal', async () => {
  vi.mocked(executeExcelFile).mockRejectedValue(new Error('synthetic-private-cause'))
  const result = await runWithExcelToolWorkerRuntime(runtime, () =>
    executeTool(
      'memlia_excel_transform',
      { request: input },
      {
        executionContext: createExecutorContext({
          workflowId: 'workflow',
          workspaceId: 'workspace',
          executionId: 'run',
          userId: 'user',
        }),
      }
    )
  )
  expect(result.success).toBe(false)
  expect(result.error).toContain('excel_tool_refused')
  expect(JSON.stringify(result)).not.toContain('synthetic-private-cause')
  expect(result.retryable).toBe(false)
  expect(executeExcelFile).toHaveBeenCalledTimes(1)
  expect(uploadsExecutionMockFns.mockUploadExecutionFile).not.toHaveBeenCalled()
})

it('preserves permission refusal before preparation, storage and worker transport', async () => {
  permissionCheckMockFns.mockAssertPermissionsAllowed.mockRejectedValueOnce(
    new Error('permission_denied')
  )
  const result = await runWithExcelToolWorkerRuntime(runtime, () =>
    executeTool(
      'memlia_excel_transform',
      { request: input },
      {
        executionContext: createExecutorContext({
          workflowId: 'workflow',
          workspaceId: 'workspace',
          executionId: 'run',
          userId: 'user',
        }),
      }
    )
  )
  expect(result.success).toBe(false)
  expect(executeExcelFile).not.toHaveBeenCalled()
  expect(uploadsExecutionMockFns.mockUploadExecutionFile).not.toHaveBeenCalled()
})
it('preserves Copilot refusal even when the server worker scope exists', async () => {
  const result = await runWithExcelToolWorkerRuntime(runtime, () =>
    executeTool(
      'memlia_excel_transform',
      { request: input },
      {
        executionContext: {
          ...createExecutorContext({
            workflowId: 'workflow',
            workspaceId: 'workspace',
            executionId: 'run',
            userId: 'user',
          }),
          copilotToolExecution: true,
        },
      }
    )
  )
  expect(result.success).toBe(false)
  expect(executeExcelFile).not.toHaveBeenCalled()
  expect(uploadsExecutionMockFns.mockUploadExecutionFile).not.toHaveBeenCalled()
})
it('refuses a cancelled engine invocation before preparation and upload', async () => {
  const controller = new AbortController()
  controller.abort()
  const result = await runWithExcelToolWorkerRuntime(runtime, () =>
    executeTool(
      'memlia_excel_transform',
      { request: input },
      {
        executionContext: createExecutorContext({
          workflowId: 'workflow',
          workspaceId: 'workspace',
          executionId: 'run',
          userId: 'user',
          abortSignal: controller.signal,
        }),
      }
    )
  )
  expect(result.success).toBe(false)
  expect(executeExcelFile).not.toHaveBeenCalled()
  expect(uploadsExecutionMockFns.mockUploadExecutionFile).not.toHaveBeenCalled()
})
