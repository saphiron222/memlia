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
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { projectBlockDetail } from '@/lib/catalog/projection/block-detail'
import { projectBlockSummary } from '@/lib/catalog/projection/block-summary'
import { createInternalToolFileResult } from '@/lib/internal/tool-operations/file-result'
import { bindInternalToolFilePublication } from '@/lib/internal/tool-operations/file-result.server'
import { executeExcelFile } from '@/lib/memlia/excel/execute-excel-file.server'
import { runWithExcelToolWorkerRuntime } from '@/lib/memlia/excel/execute-tool.server'
import { validateBlockSentences } from '@/lib/workflows/blocks/canvas-sentence-validation'
import { validateInputsForBlock } from '@/lib/workflows/editing/validation'
import {
  getAllBlocks,
  getBlock,
  getBlockByToolName,
  getCanonicalBlocksByCategory,
  getLatestBlockForViewer,
} from '@/blocks/registry'
import { GenericBlockHandler } from '@/executor/handlers/generic/handler'
import { executeTool } from '@/tools'
import { memliaExcelTransformTool } from '@/tools/memlia_excel/transform'
import { tools } from '@/tools/registry'

vi.unmock('@/blocks/registry')
vi.unmock('@/tools/metadata')
vi.unmock('@/tools/metadata-outputs')

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

describe('bloc Excel natif', () => {
  it('est sélectionnable dans le registre et le catalogue natifs, sans exécution', () => {
    const block = getBlock('memlia_excel')
    expect(block).toBeDefined()
    expect(getAllBlocks().find((item) => item.type === 'memlia_excel')).toEqual(block)
    expect(getLatestBlockForViewer('memlia_excel')).toEqual(block)
    expect(getBlockByToolName('memlia_excel_transform')).toEqual(block)
    expect(block?.hideFromToolbar).not.toBe(true)
    expect(getCanonicalBlocksByCategory('tools').some((item) => item.type === 'memlia_excel')).toBe(
      true
    )
    expect(executeExcelFile).not.toHaveBeenCalled()
    expect(uploadsExecutionMockFns.mockUploadExecutionFile).not.toHaveBeenCalled()
  })

  it('projette le seul corps canonique et la sortie fichier, sans configuration opérateur', () => {
    const block = getBlock('memlia_excel')
    expect(block).toBeDefined()
    if (!block) return
    expect(projectBlockSummary(block)).toMatchObject({
      id: 'memlia_excel',
      source: 'builtin',
      triggerCapable: false,
      toolIds: ['memlia_excel_transform'],
    })
    const detail = projectBlockDetail(block, { deployment: { hostedKeys: false } })
    expect(Object.keys(detail.inputDefinitions)).toEqual(['request'])
    expect(detail.inputSchema.map((field) => field.id)).toEqual(['request'])
    expect(Object.keys(detail.tools[0].params)).toEqual(['request'])
    expect(detail.outputs.file.type).toBe('file')
    expect(detail.tools[0].id).toBe('memlia_excel_transform')
    expect(block.tools.config?.tool({ operation: 'foreign_tool' })).toBe('memlia_excel_transform')
    expect(block.subBlocks).toHaveLength(1)
    expect(block.subBlocks[0]).toMatchObject({
      id: 'request',
      type: 'code',
      language: 'json',
      required: true,
    })
    expect(validateBlockSentences(block).failures).toEqual([])
  })

  it('refuse les champs étrangers par la validation native du bloc', () => {
    expect(getBlock('memlia_excel')).toBeDefined()
    const result = validateInputsForBlock(
      'memlia_excel',
      {
        request: JSON.stringify(input),
        socketPath: '/foreign',
        operatorUid: 0,
        userId: 'foreign',
      },
      'block'
    )
    expect(result.validInputs).toEqual({ request: JSON.stringify(input) })
    expect(result.errors.map((error) => error.field).sort()).toEqual([
      'operatorUid',
      'socketPath',
      'userId',
    ])
  })

  it.each(['object', 'json'] as const)(
    'transmet le corps %s via le moteur et le vrai outil, puis présente le fichier protégé',
    async (representation) => {
      expect(getBlock('memlia_excel')).toBeDefined()
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
          {
            request: representation === 'json' ? JSON.stringify(input) : input,
            _context: { userId: 'foreign', executionId: 'foreign' },
          }
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
    }
  )
})

// Refus natifs du trajet de bloc : aucune préparation ni publication sans portée worker.
it('refuse le bloc sélectionné hors worker, sans repli local', async () => {
  const ctx = createExecutorContext({
    workflowId: 'workflow',
    workspaceId: 'workspace',
    executionId: 'run',
    userId: 'user',
  })
  await expect(
    new GenericBlockHandler().execute(
      ctx,
      createSerializedBlock({ type: 'memlia_excel', tool: 'memlia_excel_transform' }),
      { request: input }
    )
  ).rejects.toThrow('excel_tool_unavailable')
  expect(executeExcelFile).not.toHaveBeenCalled()
  expect(uploadsExecutionMockFns.mockUploadExecutionFile).not.toHaveBeenCalled()
})

it('conserve le refus du serveur sans publier un résultat inventé', async () => {
  vi.mocked(executeExcelFile).mockRejectedValueOnce(new Error('refus serveur synthétique'))
  const ctx = createExecutorContext({
    workflowId: 'workflow',
    workspaceId: 'workspace',
    executionId: 'run',
    userId: 'user',
  })
  await expect(
    runWithExcelToolWorkerRuntime(runtime, () =>
      new GenericBlockHandler().execute(
        ctx,
        createSerializedBlock({ type: 'memlia_excel', tool: 'memlia_excel_transform' }),
        { request: input }
      )
    )
  ).rejects.toThrow('excel_tool_refused')
  expect(executeExcelFile).toHaveBeenCalledTimes(1)
  expect(uploadsExecutionMockFns.mockUploadExecutionFile).not.toHaveBeenCalled()
})

it('préserve le refus Copilot même avec un bloc et une portée worker valides', async () => {
  const ctx = {
    ...createExecutorContext({
      workflowId: 'workflow',
      workspaceId: 'workspace',
      executionId: 'run',
      userId: 'user',
    }),
    copilotToolExecution: true,
  }
  await expect(
    runWithExcelToolWorkerRuntime(runtime, () =>
      new GenericBlockHandler().execute(
        ctx,
        createSerializedBlock({ type: 'memlia_excel', tool: 'memlia_excel_transform' }),
        { request: input }
      )
    )
  ).rejects.toThrow('excel_tool_refused')
  expect(executeExcelFile).not.toHaveBeenCalled()
  expect(uploadsExecutionMockFns.mockUploadExecutionFile).not.toHaveBeenCalled()
})

it('préserve l’annulation avant préparation', async () => {
  const controller = new AbortController()
  controller.abort()
  const ctx = createExecutorContext({
    workflowId: 'workflow',
    workspaceId: 'workspace',
    executionId: 'run',
    userId: 'user',
    abortSignal: controller.signal,
  })
  await expect(
    runWithExcelToolWorkerRuntime(runtime, () =>
      new GenericBlockHandler().execute(
        ctx,
        createSerializedBlock({ type: 'memlia_excel', tool: 'memlia_excel_transform' }),
        { request: input }
      )
    )
  ).rejects.toThrow()
  expect(executeExcelFile).not.toHaveBeenCalled()
  expect(uploadsExecutionMockFns.mockUploadExecutionFile).not.toHaveBeenCalled()
})
