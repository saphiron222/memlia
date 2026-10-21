// Copyright (c) 2026 Memlia. All rights reserved.
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  getInternalToolOperationHandler,
  isInternalToolOperationRegistered,
} from '@/lib/internal/tool-operations/registry.server'
import { executeMemliaExcelTool } from '@/lib/memlia/excel/execute-tool.server'
import toolOutputs from '@/tools/generated/tool-outputs'
import { getToolMetadata } from '@/tools/metadata'
import { hasToolId } from '@/tools/tool-ids'
import { memliaExcelTransformTool } from './transform'

vi.unmock('@/tools/metadata')

describe('Memlia Excel native registration', () => {
  it('resolves the exact internal handler without HTTP', async () => {
    expect(isInternalToolOperationRegistered('memlia_excel_transform')).toBe(true)
    expect(await getInternalToolOperationHandler('memlia_excel_transform')).toBe(
      executeMemliaExcelTool
    )
  })
  it('discovers only declarative request metadata, without worker configuration', () => {
    expect(hasToolId('memlia_excel_transform')).toBe(true)
    expect(getToolMetadata('memlia_excel_transform')).toMatchObject({
      id: 'memlia_excel_transform',
      params: { request: { type: 'object', required: true } },
      hostedApiKey: 'none',
    })
  })
  it('declares the native file result', () => {
    expect(toolOutputs.memlia_excel_transform).toEqual({
      file: {
        type: 'file',
        description: 'New execution file; publication revalidates source and authority.',
      },
    })
  })
})

it('projects request only and never model-supplied execution/runtime fields', () => {
  const request = { procedure: {}, sources: {}, output: {} }
  expect(
    memliaExcelTransformTool.operation.input({
      request,
      userId: 'foreign',
      runtime: { socketPath: '/tmp/x' },
    } as { request: unknown })
  ).toBe(request)
  expect(Object.keys(memliaExcelTransformTool.params)).toEqual(['request'])
  expect(memliaExcelTransformTool).not.toHaveProperty('request')
  expect(memliaExcelTransformTool).not.toHaveProperty('oauth')
})
it('is wired into the executable registry and captures only operator fields at worker startup', () => {
  const registry = readFileSync(new URL('../registry.ts', import.meta.url), 'utf8')
  expect(registry).toContain(
    "import { memliaExcelTransformTool } from '@/tools/memlia_excel/transform'"
  )
  expect(registry).toContain('memlia_excel_transform: memliaExcelTransformTool,')
  const entry = readFileSync(
    new URL('../../scripts/memlia-workflow-worker.ts', import.meta.url),
    'utf8'
  )
  expect(entry.match(/process\.env\.MEMLIA_EXCEL_HOST_SOCKET/g)).toHaveLength(1)
  expect(entry.match(/process\.env\.MEMLIA_EXCEL_HOST_OPERATOR_UID/g)).toHaveLength(1)
  expect(entry).toContain(
    'runWithExcelToolWorkerRuntime(excelRuntime, () => startPgBossWorkflowWorker())'
  )
})
