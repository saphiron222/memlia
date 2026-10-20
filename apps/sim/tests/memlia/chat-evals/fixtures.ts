// Copyright (c) 2026 Memlia. All rights reserved.
import {
  createBlock,
  createLoopBlock,
  createParallelBlock,
} from '@sim/testing/factories/block.factory'
import { transferBlockHeights } from '@/lib/workflows/autolayout/utils'
import {
  generateLoopBlocks,
  generateParallelBlocks,
} from '@sim/workflow-persistence/subflow-helpers'
import type { WorkflowState } from '@sim/workflow-types/workflow'
import { type V2WorkflowGraph, v2WorkflowGraphSchema } from '@/lib/api/contracts/v2/workflows'
import type { ChatCase } from './corpus'

/** Initial state only, using native test factories. Never a generated answer or DB write. */
export function createCaseGraph(task: ChatCase) {
  const graph: Pick<WorkflowState, 'blocks' | 'edges' | 'loops' | 'parallels'> &
    Pick<V2WorkflowGraph, 'draftRevision' | 'variables'> = {
    draftRevision: 7,
    blocks: {
      anchor: createBlock({
        id: 'anchor',
        type: 'function',
        name: 'Ancrage existant',
        subBlocks: { code: { id: 'code', type: 'code', value: 'return 0' } },
      }),
      'preserved-target': createBlock({
        id: 'preserved-target',
        type: 'function',
        name: 'Témoin existant à préserver',
        position: { x: 360, y: 0 },
        subBlocks: { code: { id: 'code', type: 'code', value: 'return 0' } },
      }),
      sentinel: createBlock({
        id: 'sentinel',
        type: 'note',
        name: 'Sentinelle à préserver',
        position: { x: 620, y: 150 },
        subBlocks: {
          content: { id: 'content', type: 'long-input', value: 'Annotation fictive conservée' },
        },
        locked: true,
      }),
    },
    edges: [{ id: 'preserved-edge', source: 'anchor', target: 'preserved-target', type: 'default' }],
    loops: {},
    parallels: {},
    variables: { taux: { id: 'taux', name: 'taux', type: 'number', value: 0.2 } },
  }
  if (task.family === 'variables' && task.setup === 'ambiguous') {
    graph.variables.tauxBis = { id: 'tauxBis', name: 'tauxBis', type: 'number', value: 0.3 }
  }
  if (task.setup === 'existing_focus' || task.setup === 'read_only') {
    const options = {
      id: 'focus',
      type: task.blockType,
      name: 'Bloc initial',
      position: { x: 250, y: 250 },
    }
    const focus =
      task.blockType === 'loop'
        ? createLoopBlock(options)
        : task.blockType === 'parallel'
          ? createParallelBlock(options)
          : createBlock(options)
    graph.blocks.focus = focus
  }
  graph.loops = generateLoopBlocks(graph.blocks)
  graph.parallels = generateParallelBlocks(graph.blocks)
  transferBlockHeights(graph.blocks, graph.blocks)
  for (const block of Object.values(graph.blocks)) {
    block.data ||= {}
    block.errorEnabled ??= false
  }
  return v2WorkflowGraphSchema.parse(graph)
}
