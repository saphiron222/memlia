// Modified by Memlia: qualify required draft CAS contracts and read/write receipts.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  v2ApplyWorkflowOperationsBodySchema,
  v2ApplyWorkflowOperationsDataSchema,
  v2ReplaceWorkflowStateBodySchema,
  v2WorkflowGraphSchema,
  v2WorkflowOperationSchema,
} from '@/lib/api/contracts/v2/workflows'
import { WORKFLOW_SKIPPED_ITEM_TYPES } from '@/lib/workflows/editing/types'

const STORED_GRAPH = {
  draftRevision: 7,
  blocks: {
    'block-1': {
      id: 'block-1',
      type: 'starter',
      name: 'Start',
      position: { x: 0, y: 0 },
      subBlocks: { 'sub-1': { id: 'sub-1', type: 'oauth-input', value: 'credential-1' } },
      outputs: { result: { type: 'string' } },
      enabled: true,
      horizontalHandles: true,
      height: 0,
      data: { parentId: 'loop-1', extent: 'parent' },
      /** A stored key this surface does not publish. */
      layout: { measured: true },
    },
  },
  edges: [
    {
      id: 'edge-1',
      source: 'block-1',
      target: 'block-2',
      sourceHandle: null,
      targetHandle: null,
      /** Reactflow rendering members the stored row carries. */
      animated: true,
      style: { stroke: '#000' },
    },
  ],
  loops: {
    'loop-1': { id: 'loop-1', nodes: ['block-1'], iterations: 3, loopType: 'for', enabled: true },
  },
  parallels: {},
  variables: {
    'var-1': {
      id: 'var-1',
      name: 'region',
      type: 'string',
      value: 'eu',
      /** Server-stamped for the client's global variables store; not part of this surface. */
      workflowId: 'workflow-1',
    },
  },
}

describe('the read shape tolerates what the write path never bounded', () => {
  /**
   * `workflow_blocks.name` and `.type` are bare `text()`, and the realtime
   * rename op accepts `z.string()`, so a block renamed past 255 characters on
   * the canvas is legal stored data. Asserting the input bound on the way out
   * made that workflow a `500` on the one endpoint that opens it — and since
   * `PUT /state` needs the `GET` round trip, unrepairable over v2.
   */
  it('reads a block whose stored name exceeds the write-side bound', () => {
    const longName = 'x'.repeat(300)
    const graph = structuredClone(STORED_GRAPH)
    graph.blocks['block-1'].name = longName

    expect(v2WorkflowGraphSchema.parse(graph).blocks['block-1'].name).toBe(longName)
  })
})

describe('v2WorkflowGraphSchema', () => {
  /**
   * A v2 response schema is `.parse`d on the way out, so a stored member the
   * surface has not published must be stripped rather than rejected — a throw
   * here would be a 500 on a plain read.
   */
  it('canonicalizes a stored graph instead of rejecting its unpublished members', () => {
    const parsed = v2WorkflowGraphSchema.parse(STORED_GRAPH)

    expect(parsed.blocks['block-1']).not.toHaveProperty('layout')
    expect(parsed.edges[0]).not.toHaveProperty('animated')
    expect(parsed.variables['var-1']).not.toHaveProperty('workflowId')
    expect(parsed.blocks['block-1'].subBlocks['sub-1'].value).toBe('credential-1')
    expect(parsed.loops['loop-1'].iterations).toBe(3)
  })

  /** The round trip has to close: what the read emits is what the write accepts. */
  it('accepts its own output as a replacement body', () => {
    const parsed = v2WorkflowGraphSchema.parse(STORED_GRAPH)

    const { draftRevision, ...graph } = parsed
    expect(
      v2ReplaceWorkflowStateBodySchema.safeParse({ ...graph, expectedRevision: draftRevision })
        .success
    ).toBe(true)
  })
})

/** An empty report carrying every field the lint schema requires. */
const EMPTY_LINT = {
  sources: [],
  sinks: [],
  orphanBlocks: [],
  emptyOutgoingPorts: [],
  invalidBranchPorts: [],
  invalidConnectionTargets: [],
  fieldIssues: [],
  unresolvedReferences: [],
  tableFieldIssues: [],
  notes: [],
}

/** A report exercising every finding kind the lint schema publishes. */
const FULL_LINT = {
  sources: [{ blockId: 'block-1', blockName: 'Start', blockType: 'starter' }],
  sinks: [{ blockId: 'block-2', blockName: 'Triage', blockType: 'agent' }],
  orphanBlocks: [{ blockId: 'block-3', blockName: null, blockType: null }],
  emptyOutgoingPorts: [
    {
      blockId: 'loop-1',
      blockName: 'Loop',
      blockType: 'loop',
      handle: 'loop-start-source',
      label: 'loop-start-source',
    },
  ],
  invalidBranchPorts: [
    {
      blockId: 'cond-1',
      blockName: 'Check',
      blockType: 'condition',
      sourceHandle: 'condition-gone',
      reason: 'No such branch',
    },
  ],
  invalidConnectionTargets: [
    {
      sourceBlockId: 'block-1',
      sourceBlockName: 'Start',
      sourceHandle: null,
      targetBlockId: 'block-9',
      reason: 'Target is inside a container',
    },
  ],
  fieldIssues: [
    {
      blockId: 'block-2',
      blockName: 'Triage',
      blockType: 'agent',
      missingRequiredFields: ['systemPrompt'],
      inactiveModeValues: [
        {
          canonicalId: 'model',
          activeMemberId: 'model',
          inactiveMemberId: 'modelAdvanced',
          kind: 'other',
        },
      ],
    },
  ],
  unresolvedReferences: [
    {
      blockId: 'block-2',
      blockName: 'Triage',
      blockType: 'agent',
      field: 'credential',
      value: 'cred-9',
      kind: 'credential',
      reason: 'Not accessible',
    },
  ],
  tableFieldIssues: [
    {
      blockId: 'block-3',
      blockName: 'Query leads',
      blockType: 'table_v2',
      field: 'score',
      tableName: 'Leads',
    },
  ],
  notes: ['lint note'],
}

describe('v2ApplyWorkflowOperationsDataSchema', () => {
  /** The published skip vocabulary is the engine's, so a new reason cannot ship undocumented. */
  it('publishes every reason the engine can decline an operation for', () => {
    for (const type of WORKFLOW_SKIPPED_ITEM_TYPES) {
      const result = v2ApplyWorkflowOperationsDataSchema.safeParse({
        id: 'workflow-1',
        baseRevision: 7,
        draftRevision: 8,
        warnings: [],
        needsRedeployment: false,
        applied: 0,
        skipped: [{ type, operationType: 'add', blockId: 'block-1', reason: 'because' }],
        deferred: [],
        inputValidationErrors: [],
        mintedBlockIds: {},
        lint: EMPTY_LINT,
        dryRun: false,
      })
      expect(result.success, `skip type ${type} is not published`).toBe(true)
    }
  })

  /**
   * The lint report is what a headless builder acts on. Publishing only
   * `unresolvedReferences` dropped ~75% of it, `fieldIssues` — the blocks
   * missing a required field — most of all.
   */
  it('publishes every field of the lint report the use case produces', () => {
    const result = v2ApplyWorkflowOperationsDataSchema.safeParse({
      id: 'workflow-1',
      baseRevision: 7,
      draftRevision: 8,
      warnings: [],
      needsRedeployment: false,
      applied: 1,
      skipped: [],
      deferred: [],
      inputValidationErrors: [],
      mintedBlockIds: {},
      lint: FULL_LINT,
      dryRun: false,
    })

    expect(result.error?.issues ?? []).toEqual([])
    // The response schema is `.parse`d on the way out, so a field it does not
    // declare is silently stripped rather than rejected. Assert the parsed
    // output, not just that the input was accepted.
    expect(result.data?.lint).toEqual(FULL_LINT)
  })
})

describe('draft revision wire contract', () => {
  it('keeps published graph-write examples valid after adding revision authority', () => {
    for (const schema of [v2ReplaceWorkflowStateBodySchema, v2ApplyWorkflowOperationsBodySchema]) {
      for (const example of schema.meta()?.examples ?? []) {
        expect(schema.safeParse(example).success).toBe(true)
      }
    }
  })
  it('preserves the native 200-operation limit', () => {
    const operation = { operation_type: 'delete', block_id: 'b' }
    expect(
      v2ApplyWorkflowOperationsBodySchema.safeParse({
        expectedRevision: 0,
        operations: Array(200).fill(operation),
      }).success
    ).toBe(true)
    expect(
      v2ApplyWorkflowOperationsBodySchema.safeParse({
        expectedRevision: 0,
        operations: Array(201).fill(operation),
      }).success
    ).toBe(false)
  })
  it.each([
    undefined,
    null,
    -1,
    1.5,
    '7',
    Number.MAX_SAFE_INTEGER + 1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('rejects missing or invalid expected revision %s', (expectedRevision) => {
    expect(
      v2ReplaceWorkflowStateBodySchema.safeParse({ blocks: {}, edges: [], expectedRevision })
        .success
    ).toBe(false)
    expect(
      v2ApplyWorkflowOperationsBodySchema.safeParse({
        operations: [{ operation_type: 'delete', block_id: 'b' }],
        expectedRevision,
      }).success
    ).toBe(false)
  })
  it.each([0, 7, Number.MAX_SAFE_INTEGER])(
    'accepts safe revision %s without coercion',
    (expectedRevision) => {
      expect(
        v2ReplaceWorkflowStateBodySchema.parse({ blocks: {}, edges: [], expectedRevision })
          .expectedRevision
      ).toBe(expectedRevision)
      expect(
        v2ApplyWorkflowOperationsBodySchema.parse({
          operations: [{ operation_type: 'delete', block_id: 'b' }],
          expectedRevision,
        }).expectedRevision
      ).toBe(expectedRevision)
    }
  )
  it('does not accept an unrenamed read revision as write authority', () => {
    expect(
      v2ReplaceWorkflowStateBodySchema.safeParse({ blocks: {}, edges: [], draftRevision: 7 })
        .success
    ).toBe(false)
  })
})

describe('workflow operation trigger-mode contract', () => {
  const operations = ['add', 'edit', 'insert_into_subflow'] as const
  const request = (operation_type: (typeof operations)[number], extra: Record<string, unknown>) => ({
    expectedRevision: 7,
    operations: [
      {
        operation_type,
        block_id: 'start',
        params: { type: 'start_trigger', name: 'Départ', subflowId: 'loop', ...extra },
      },
    ],
  })

  it.each(operations)('rejects non-boolean triggerMode for %s without coercion', (operation) => {
    for (const triggerMode of ['manual', 'true', 0, 1, null, {}, []]) {
      const result = v2ApplyWorkflowOperationsBodySchema.safeParse(
        request(operation, { triggerMode })
      )
      expect(result.success).toBe(false)
      expect(result.error?.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: ['operations', 0, 'params', 'triggerMode'] }),
        ])
      )
    }
  })

  it.each(operations)('preserves booleans and omission for %s', (operation) => {
    for (const extra of [{}, { triggerMode: false }, { triggerMode: true }]) {
      const input = request(operation, extra)
      const parsed = v2ApplyWorkflowOperationsBodySchema.parse(input)
      expect(parsed.operations[0]).toStrictEqual(input.operations[0])
    }
  })
})

it('publishes boolean triggerMode in every native block-parameter envelope', () => {
  const published = z.toJSONSchema(v2WorkflowOperationSchema, { io: 'input' })
  for (const operation of ['add', 'edit', 'insert_into_subflow']) {
    const variant = published.oneOf?.find(
      (entry) => entry.properties?.operation_type?.const === operation
    )
    expect(variant).toBeDefined()
    const params = variant?.properties?.params
    const envelope = operation === 'edit' ? params?.allOf?.[0] : params
    expect(envelope?.properties?.triggerMode).toMatchObject({ type: 'boolean' })
    expect(envelope?.required ?? []).not.toContain('triggerMode')
  }
})
