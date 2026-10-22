// Copyright (c) 2026 Memlia. All rights reserved.
// The durable CI fixture's graph, built by the native editor with the real block registry,
// must pass the ordinary Excel publish capture; only the raw SQL boundary is doubled.
import { dbChainMockFns, queueTableRows, resetDbChainMock, schemaMock } from '@sim/testing'
import { getMockLogger } from '@sim/testing/mocks/logger.mock'
import { permissionGroupScopeMock } from '@sim/testing/mocks/permission-group-scope.mock'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  materializeExcelProcedureSnapshot,
  readExcelProcedureSnapshotCapture,
} from '@/lib/memlia/excel/materialize-procedure-snapshot'
import { excelProcedureDraftSchema } from '@/lib/memlia/excel/procedure-capabilities'
import { applyOperationsToWorkflowState } from '@/lib/workflows/editing/engine'
import type { EditWorkflowOperation } from '@/lib/workflows/editing/types'
import { fixtures } from '../../../../../packages/memlia-contracts/tests/fixtures'
import { captureWorkflowExcelDeploymentSnapshot } from './excel-deployment-snapshots'

vi.mock('@/lib/permission-groups/config-scope.server', () => permissionGroupScopeMock)
vi.unmock('@/blocks/registry')
vi.unmock('@/tools/registry')

type Block = {
  id: string
  type: string
  position: { x: number; y: number }
  retry?: unknown
  subBlocks: Record<string, { value: unknown }>
}
type Edge = {
  id: string
  source: string
  target: string
  sourceHandle?: string
  targetHandle?: string
}

/** Same operations as scripts/ci/excel-file-workflow.ts sends for `durable-prepare`. */
function durableFixtureGraph() {
  const full = structuredClone(fixtures.ExcelProcedure)
  full.decimalPolicy.precision = 18
  const procedure = excelProcedureDraftSchema.parse(
    Object.fromEntries(
      Object.entries(full).filter(([key]) => Object.hasOwn(excelProcedureDraftSchema.shape, key))
    )
  )
  const start = '6f0c1a52-6a43-4d8f-9a55-1d3c2b4e5f60'
  const transform = '6f0c1a52-6a43-4d8f-9a55-1d3c2b4e5f61'
  const operations = [
    {
      operation_type: 'add',
      block_id: start,
      params: { type: 'start_trigger', name: 'Start', connections: { source: transform } },
    },
    {
      operation_type: 'add',
      block_id: transform,
      params: {
        type: 'memlia_excel',
        name: 'Transform',
        inputs: {
          request: JSON.stringify({
            procedure,
            sources: { source: { fileId: 'file-fixture', sheetName: 'Input' } },
            output: { sheetName: 'Result', fileName: 'result.xlsx' },
          }),
        },
      },
    },
  ] as EditWorkflowOperation[]
  const applied = applyOperationsToWorkflowState(
    { blocks: {}, edges: [], loops: {}, parallels: {} },
    operations
  )
  expect(applied.validationErrors).toEqual([])
  expect(applied.skippedItems).toEqual([])
  // Round-trips through JSON exactly as the normalized jsonb columns store it.
  const state = JSON.parse(JSON.stringify(applied.state)) as {
    blocks: Record<string, Block>
    edges: Edge[]
  }
  return { state, start, transform }
}

function queueStoredGraph(state: { blocks: Record<string, Block>; edges: Edge[] }) {
  queueTableRows(schemaMock.workflow, [
    { workspaceId: 'space', draftRevision: 3, variables: {}, archivedAt: null },
  ])
  queueTableRows(schemaMock.workflow, [{ workspaceId: 'space', draftRevision: 3 }])
  queueTableRows(schemaMock.workspace, [{ organizationId: null, archivedAt: null }])
  queueTableRows(
    schemaMock.workflowBlocks,
    Object.values(state.blocks).map((block) => ({
      ...block,
      positionX: block.position.x,
      positionY: block.position.y,
      retry: block.retry ?? null,
    }))
  )
  queueTableRows(
    schemaMock.workflowEdges,
    state.edges.map((edge) => ({
      id: edge.id,
      sourceBlockId: edge.source,
      targetBlockId: edge.target,
      sourceHandle: edge.sourceHandle ?? null,
      targetHandle: edge.targetHandle ?? null,
    }))
  )
  queueTableRows(schemaMock.workflowSubflows, [])
}

describe('ordinary Excel publication of the native-editor durable CI graph', () => {
  beforeEach(() => resetDbChainMock())

  it('captures and materializes the start trigger plus Excel graph without refusal', async () => {
    const { state, start, transform } = durableFixtureGraph()
    expect(Object.keys(state.blocks).sort()).toEqual([start, transform].sort())
    expect(typeof state.blocks[transform].subBlocks.request.value).toBe('string')
    queueStoredGraph(state)

    const result = await captureWorkflowExcelDeploymentSnapshot({
      workflowId: 'workflow',
      assertedWorkspaceId: 'space',
      idempotencyKey: 'generated-operation-key',
      actor: { kind: 'session', userId: 'fixture-user' },
      requestId: 'request',
    })

    expect(getMockLogger('ExcelDeploymentSnapshots').error).not.toHaveBeenCalled()
    if (!result) throw new Error('Expected Excel publication capture')
    const identity = readExcelProcedureSnapshotCapture(result.excelProcedureSnapshot)
    expect(identity).toMatchObject({ expectedRevision: 3 })
    const materialized = materializeExcelProcedureSnapshot(
      result.excelProcedureSnapshot,
      { workflowState: result.workflowState, revision: 3, scope: identity.scope },
      { id: 'ordinary-version', version: 1 }
    )
    expect(materialized.procedures.map((procedure) => procedure.version)).toEqual([1])
    expect(Object.keys(materialized.workflowState.blocks).sort()).toEqual([start, transform].sort())
    expect(dbChainMockFns.insert).not.toHaveBeenCalled()
  })
})
