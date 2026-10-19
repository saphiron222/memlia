// Modified by Memlia: reject malformed migrate-on-read revisions even for an empty batch.
import { describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>
const migrationMocks = vi.hoisted(() => ({ warn: vi.fn(), transaction: vi.fn() }))

const tables = vi.hoisted(() => ({
  workflow: { name: 'workflow' as const },
  workflowBlocks: {
    name: 'workflowBlocks' as const,
    workflowId: 'workflow_id',
    updatedAt: 'updated_at',
  },
  workflowEdges: { name: 'workflowEdges' as const, workflowId: 'workflow_id' },
  workflowSubflows: { name: 'workflowSubflows' as const, workflowId: 'workflow_id' },
}))

vi.mock('@sim/db', () => ({
  db: { transaction: migrationMocks.transaction },
  workflow: tables.workflow,
  workflowBlocks: tables.workflowBlocks,
  workflowEdges: tables.workflowEdges,
  workflowSubflows: tables.workflowSubflows,
}))

vi.mock('@sim/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: migrationMocks.warn,
  }),
}))

vi.mock('drizzle-orm', () => ({
  and: vi.fn(),
  eq: vi.fn(),
  getTableColumns: vi.fn(() => ({})),
  isNull: vi.fn(),
  sql: vi.fn(() => 'updated_at::text'),
}))

import { loadWorkflowFromNormalizedTablesRaw, persistMigratedBlocks } from './load'

/**
 * Minimal stand-in for the drizzle query builder the loader uses: every chain
 * ends in the rows registered for the table named by `.from(...)`, and the
 * chain is awaitable both with and without a trailing `.limit(...)`.
 */
function createTx(rowsByTable: Record<string, Row[]>) {
  const resultFor = (rows: Row[]) => {
    const result = {
      where: () => result,
      limit: () => Promise.resolve(rows),
      then: (onFulfilled: (rows: Row[]) => unknown) => Promise.resolve(rows).then(onFulfilled),
    }
    return result
  }

  return {
    select: () => ({
      from: (table: { name: string }) => resultFor(rowsByTable[table.name] ?? []),
    }),
  }
}

function blockRow(retry: unknown): Row {
  return {
    id: 'block-1',
    type: 'api',
    name: 'API',
    positionX: '0',
    positionY: '0',
    enabled: true,
    horizontalHandles: true,
    advancedMode: false,
    errorEnabled: false,
    retry,
    triggerMode: false,
    height: '0',
    subBlocks: {},
    outputs: {},
    data: {},
    locked: false,
    updatedAtText: '2026-01-01 00:00:00.000000',
  }
}

async function loadRetry(retry: unknown) {
  const tx = createTx({
    workflowBlocks: [blockRow(retry)],
    workflowEdges: [],
    workflowSubflows: [],
    workflow: [{ workspaceId: 'workspace-1' }],
  })

  const loaded = await loadWorkflowFromNormalizedTablesRaw(
    'workflow-1',
    tx as unknown as Parameters<typeof loadWorkflowFromNormalizedTablesRaw>[1]
  )

  return loaded?.blocks['block-1'].retry
}

describe('loadWorkflowFromNormalizedTablesRaw', () => {
  /**
   * The `retry` column is jsonb written verbatim by writers that never bound it
   * (realtime batch-add and replace-state, the admin/superuser import routes),
   * so a stored value can sit outside the range the HTTP read contract demands.
   */
  it('pins an out-of-range enabled policy to the bounds', async () => {
    expect(
      await loadRetry({ enabled: true, maxTries: 999, waitBetweenTriesMs: 10_000_000 })
    ).toEqual({ enabled: true, maxTries: 5, waitBetweenTriesMs: 5000 })
  })

  it('resolves a non-boolean enabled flag the way execution reads it', async () => {
    expect(await loadRetry({ enabled: 'yes', maxTries: 3, waitBetweenTriesMs: 1000 })).toEqual({
      enabled: true,
      maxTries: 3,
      waitBetweenTriesMs: 1000,
    })
  })
})

it.each([undefined, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
  'validates migration revision %s before the no-op path without unhandled rejection',
  async (revision) => {
    migrationMocks.warn.mockClear()
    migrationMocks.transaction.mockClear()
    await expect(
      persistMigratedBlocks('workflow', {}, {}, {}, revision as number)
    ).resolves.toBeUndefined()
    expect(migrationMocks.warn).toHaveBeenCalledWith(
      'Failed to persist block migrations',
      expect.objectContaining({
        workflowId: 'workflow',
        error: expect.objectContaining({ code: 'validation' }),
      })
    )
    expect(migrationMocks.transaction).not.toHaveBeenCalled()
  }
)
