// Modified by Memlia: verify internal draft revision projection.
import { describe, expect, it } from 'vitest'
import {
  executeWorkflowBodySchema,
  getWorkflowResponseDataSchema,
  putWorkflowNormalizedStateContract,
  workflowStateResponseSchema,
  workflowStateSchema,
} from '@/lib/api/contracts/workflows'
import { PRIVATE_SECRET_PROVENANCE_FIELD } from '@/lib/execution/private-tool-metadata'

describe('workflow contracts', () => {
  it('retains a private workflow-input provenance envelope for boundary validation', () => {
    const bundle = {
      version: 1 as const,
      complete: true,
      selections: [
        {
          key: 'input',
          provenance: {
            version: 1 as const,
            complete: true,
            entries: [{ name: 'TOKEN', encryptedValue: 'encrypted-token' }],
            scope: { userId: 'parent-owner', workspaceId: 'workspace-1' },
          },
        },
      ],
    }

    expect(
      executeWorkflowBodySchema.parse({ [PRIVATE_SECRET_PROVENANCE_FIELD]: bundle })
    ).toMatchObject({ [PRIVATE_SECRET_PROVENANCE_FIELD]: bundle })
  })

  it('normalizes null React Flow edge handles in execution overrides', () => {
    const parsed = executeWorkflowBodySchema.parse({
      workflowStateOverride: {
        blocks: {
          source: {
            id: 'source',
            type: 'start_trigger',
            name: 'Start',
            position: { x: 0, y: 0 },
            subBlocks: {},
            outputs: {},
            enabled: true,
          },
          target: {
            id: 'target',
            type: 'function',
            name: 'Function',
            position: { x: 100, y: 0 },
            subBlocks: {},
            outputs: {},
            enabled: true,
          },
        },
        edges: [
          {
            id: 'edge-1',
            source: 'source',
            target: 'target',
            sourceHandle: null,
            targetHandle: null,
            type: 'workflowEdge',
          },
        ],
        loops: {},
        parallels: {},
      },
    })

    expect(parsed.workflowStateOverride?.edges[0].sourceHandle).toBeUndefined()
    expect(parsed.workflowStateOverride?.edges[0].targetHandle).toBeUndefined()
  })

  /**
   * `workflowStateSchema` is the PUT `/api/workflows/[id]/state` body and also
   * the `state` slot of the GET response. A stored value outside these bounds
   * used to 500 the read, which is now prevented by pinning the policy when the
   * normalized tables are loaded — not by widening the write contract. Relaxing
   * these bounds would let a caller persist a policy the executor will not run.
   */
  it('rejects a retry policy outside the bounds on the write contract', () => {
    const stateWith = (retry: Record<string, unknown>) => ({
      blocks: {
        'block-1': {
          id: 'block-1',
          type: 'api',
          name: 'API',
          position: { x: 0, y: 0 },
          subBlocks: {},
          outputs: {},
          enabled: true,
          retry,
        },
      },
      edges: [],
    })

    expect(
      workflowStateSchema.safeParse(
        stateWith({ enabled: true, maxTries: 999, waitBetweenTriesMs: 0 })
      ).success
    ).toBe(false)
    expect(
      workflowStateSchema.safeParse(
        stateWith({ enabled: true, maxTries: 3, waitBetweenTriesMs: 10_000_000 })
      ).success
    ).toBe(false)
    expect(
      workflowStateSchema.safeParse(
        stateWith({ enabled: true, maxTries: 3, waitBetweenTriesMs: 0 })
      ).success
    ).toBe(true)
  })
})

const normalized = { blocks: {}, edges: [], loops: {}, parallels: {}, variables: {} }
const envelope = {
  id: 'workflow-1',
  userId: 'reader',
  workspaceId: 'workspace-1',
  folderId: null,
  sortOrder: 0,
  name: 'Revision fixture',
  description: null,
  lastSynced: '2026-10-19T00:00:00Z',
  createdAt: '2026-10-19T00:00:00Z',
  updatedAt: '2026-10-19T00:00:00Z',
  isDeployed: false,
  deployedAt: null,
  isPublicApi: false,
  locked: false,
  runCount: 0,
  lastRunAt: null,
  archivedAt: null,
  state: normalized,
  variables: {},
}
describe('internal draft read revisions', () => {
  for (const [name, schema, fixture] of [
    ['envelope', getWorkflowResponseDataSchema, envelope],
    ['normalized', workflowStateResponseSchema, normalized],
  ] as const) {
    it.each([0, 7, Number.MAX_SAFE_INTEGER])(
      `retains the canonical revision in ${name} reads: %s`,
      (draftRevision) => {
        expect(schema.parse({ ...fixture, draftRevision })).toMatchObject({ draftRevision })
      }
    )
    it.each([
      undefined,
      null,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '7',
    ])(`rejects missing or invalid ${name} revision: %s`, (draftRevision) => {
      expect(schema.safeParse({ ...fixture, draftRevision }).success).toBe(false)
    })
  }
})

describe('transitional internal full-state CAS contract', () => {
  const state = { blocks: {}, edges: [] }
  it.each([0, 7, Number.MAX_SAFE_INTEGER])('retains expectedRevision%s', (revision) => {
    expect(
      putWorkflowNormalizedStateContract.body.parse({ ...state, expectedRevision: revision })
    ).toMatchObject({ expectedRevision: revision })
  })
  it.each([null, -1, 1.5, '7', Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects a supplied invalid revision%s',
    (expectedRevision) => {
      expect(
        putWorkflowNormalizedStateContract.body.safeParse({ ...state, expectedRevision }).success
      ).toBe(false)
    }
  )
  it('temporarily preserves legacy omission only', () => {
    expect(putWorkflowNormalizedStateContract.body.safeParse(state).success).toBe(true)
  })
})
