// Copyright (c) 2026 Memlia. All rights reserved.

import type { BlockState } from '@sim/workflow-types/workflow'
import { z } from 'zod'
import {
  v2WorkflowBlockSchema,
  v2WorkflowGraphSchema,
  v2WorkflowVariableSchema,
} from '@/lib/api/contracts/v2/workflows'
import { OrchestrationError } from '@/lib/core/orchestration/types'
import { waitWithAbort } from '@/lib/core/utils/concurrency'
import { readWorkflowGraph } from '@/lib/workflows/application/read-workflow-graph'
import { sanitizeWorkflowForSharing } from '@/lib/workflows/credentials/extractor'

const revision = v2WorkflowGraphSchema.shape.draftRevision
const section = z.enum(['blocks', 'edges', 'variables', 'loops', 'parallels'])
const variableDeclaration = v2WorkflowVariableSchema.omit({ value: true })
const variableDeclarations = z.record(z.string(), variableDeclaration)
const blockSummary = v2WorkflowBlockSchema
  .pick({ id: true, type: true, name: true, enabled: true, locked: true, triggerMode: true })
  .extend({
    data: v2WorkflowBlockSchema.shape.data
      .unwrap()
      .pick({ parentId: true, extent: true })
      .optional(),
  })
const loopSummary = v2WorkflowGraphSchema.shape.loops.valueType.pick({
  id: true,
  nodes: true,
  loopType: true,
  enabled: true,
  locked: true,
})
const parallelSummary = v2WorkflowGraphSchema.shape.parallels.valueType.pick({
  id: true,
  nodes: true,
  parallelType: true,
  enabled: true,
  locked: true,
})

export const workflowReadInputs = Object.freeze({
  read_workflow: z
    .discriminatedUnion('view', [
      z.object({ view: z.literal('full'), expectedRevision: revision.optional() }).strict(),
      z
        .object({
          view: z.literal('summary'),
          section,
          offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
          limit: z.number().int().min(1).max(100).default(50),
          expectedRevision: revision.optional(),
        })
        .strict(),
    ])
    .refine(
      (input) =>
        input.view === 'full' || input.offset === 0 || input.expectedRevision !== undefined,
      'Pages after offset zero require the observed expectedRevision.'
    ),
  read_workflow_block: z
    .object({
      blockId: v2WorkflowBlockSchema.shape.id.max(512),
      expectedRevision: revision.optional(),
    })
    .strict(),
})

type WorkflowReadContext = {
  principal: Parameters<typeof readWorkflowGraph.execute>[0]['principal']
  workspaceId: string
  workflowId: string
}

/** Reads only the workflow selected by trusted server context, never by model arguments. */
export function createWorkflowReadTools({
  principal,
  workspaceId,
  workflowId,
}: WorkflowReadContext) {
  async function read(toolId: string, params: unknown, signal?: AbortSignal) {
    const input = parseInput(toolId, params)
    const snapshot = await readWorkflowGraph.execute({
      principal,
      input: { workflowId, assertedWorkspaceId: workspaceId },
    })
    // Native reads have no signal parameter; discard late work before projection.
    signal?.throwIfAborted()
    // Canonical authorization deliberately ignores assertions for scoped principals;
    // their successful read must still match this server binding before any delivery.
    if (snapshot.workflowId !== workflowId || snapshot.workspaceId !== workspaceId)
      throw new WorkflowReadError('forbidden')
    const { workflowId: _workflow, workspaceId: _workspace, ...state } = snapshot
    const graph = v2WorkflowGraphSchema.parse(state)
    if (input.expectedRevision !== undefined && input.expectedRevision !== graph.draftRevision)
      throw new WorkflowReadError('revision_conflict')
    if ('blockId' in input) {
      if (!Object.hasOwn(graph.blocks, input.blockId)) throw new WorkflowReadError('not_found')
      return {
        draftRevision: graph.draftRevision,
        block: sanitizedBlocks({ [input.blockId]: graph.blocks[input.blockId] })[input.blockId],
      }
    }
    if (input.view === 'full')
      return {
        view: 'full' as const,
        ...graph,
        blocks: sanitizedBlocks(graph.blocks),
        variables: variableDeclarations.parse(graph.variables),
      }

    const counts = {
      blocks: Object.keys(graph.blocks).length,
      edges: graph.edges.length,
      variables: Object.keys(graph.variables).length,
      loops: Object.keys(graph.loops).length,
      parallels: Object.keys(graph.parallels).length,
    }
    const { offset, limit, section } = input
    const page = (total: number) => ({
      offset,
      limit,
      total,
      nextOffset: offset + limit < total ? offset + limit : null,
    })
    const common = { view: 'summary' as const, draftRevision: graph.draftRevision, section, counts }
    switch (section) {
      case 'blocks':
        return {
          ...common,
          page: page(counts.blocks),
          entries: pageRecord(graph.blocks, offset, limit, (block) => blockSummary.parse(block)),
        }
      case 'variables':
        return {
          ...common,
          page: page(counts.variables),
          entries: pageRecord(graph.variables, offset, limit, (variable) =>
            variableDeclaration.parse(variable)
          ),
        }
      case 'loops':
        return {
          ...common,
          page: page(counts.loops),
          entries: pageRecord(graph.loops, offset, limit, (loop) => loopSummary.parse(loop)),
        }
      case 'parallels':
        return {
          ...common,
          page: page(counts.parallels),
          entries: pageRecord(graph.parallels, offset, limit, (parallel) =>
            parallelSummary.parse(parallel)
          ),
        }
      case 'edges':
        return {
          ...common,
          page: page(counts.edges),
          entries: [...graph.edges]
            .sort(
              (left, right) =>
                compare(left.id, right.id) || compare(JSON.stringify(left), JSON.stringify(right))
            )
            .slice(offset, offset + limit),
        }
    }
  }

  return {
    async dispatch(toolId: string, params: unknown, signal?: AbortSignal) {
      try {
        signal?.throwIfAborted()
        const data = await waitWithAbort(read(toolId, params, signal), signal)
        signal?.throwIfAborted()
        const result = { ok: true as const, data }
        if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 256 * 1024)
          return failure('result_too_large')
        return result
      } catch (error) {
        if (signal?.aborted) return failure('cancelled')
        if (error instanceof WorkflowReadError) return failure(error.code)
        if (error instanceof OrchestrationError && error.code === 'forbidden')
          return failure('forbidden')
        if (error instanceof OrchestrationError && error.code === 'not_found')
          return failure('not_found')
        return failure('unavailable')
      }
    },
  }
}

function sanitizedBlocks(blocks: z.output<typeof v2WorkflowGraphSchema.shape.blocks>) {
  const sanitized = sanitizeWorkflowForSharing(
    { blocks: blocks as Record<string, BlockState> },
    {
      preserveEnvVars: true,
      preserveWorkspaceBindings: true,
      redactOpaqueCredentialInputs: true,
    }
  )
  return v2WorkflowGraphSchema.shape.blocks.parse(sanitized.blocks)
}
function pageRecord<T, Result>(
  record: Record<string, T>,
  offset: number,
  limit: number,
  project: (value: T) => Result
) {
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .slice(offset, offset + limit)
      .map((key) => [key, project(record[key])])
  )
}
function compare(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0
}
function parseInput(toolId: string, params: unknown) {
  switch (toolId) {
    case 'read_workflow':
      return parse(workflowReadInputs.read_workflow, params)
    case 'read_workflow_block':
      return parse(workflowReadInputs.read_workflow_block, params)
    default:
      throw new WorkflowReadError('tool_not_allowed')
  }
}
function parse<T>(schema: z.ZodType<T>, params: unknown): T {
  const parsed = schema.safeParse(params)
  if (!parsed.success) throw new WorkflowReadError('invalid_input')
  return parsed.data
}
type FailureCode =
  | 'tool_not_allowed'
  | 'invalid_input'
  | 'forbidden'
  | 'not_found'
  | 'unavailable'
  | 'cancelled'
  | 'result_too_large'
  | 'revision_conflict'
class WorkflowReadError extends Error {
  constructor(readonly code: FailureCode) {
    super('Workflow read could not complete.')
  }
}
function failure(code: FailureCode) {
  return { ok: false as const, error: { code, message: 'Workflow read could not complete.' } }
}
