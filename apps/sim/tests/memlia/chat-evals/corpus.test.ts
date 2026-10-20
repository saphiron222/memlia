// Copyright (c) 2026 Memlia. All rights reserved.
import { expect, it } from 'vitest'
import { chatCorpus } from './corpus'

it('provides 60 distinct requests across 15 native families with four contrasting cases per family', () => {
  expect(chatCorpus).toHaveLength(60)
  expect(new Set(chatCorpus.map((c) => c.family)).size).toBe(15)
  expect(new Set(chatCorpus.map((c) => c.id)).size).toBe(60)
  expect(new Set(chatCorpus.map((c) => c.prompt)).size).toBe(60)
  for (const family of new Set(chatCorpus.map((c) => c.family))) {
    const cases = chatCorpus.filter((c) => c.family === family)
    expect(cases).toHaveLength(4)
    expect(cases.some((c) => c.change === 'rename')).toBe(true)
    expect(cases.some((c) => c.expected === 'clarification')).toBe(true)
    expect(cases.some((c) => c.expected === 'refusal' && c.setup === 'read_only')).toBe(true)
    for (const c of cases) {
      expect(c.prompt.length).toBeGreaterThan(40)
      expect(c.rubric.length).toBeGreaterThan(20)
    }
  }
})

import { createCaseGraph } from './fixtures'

it.each(chatCorpus)(
  '$id has an independent initial fixture, never an expected generated answer',
  (c) => {
    const g = createCaseGraph(c)
    expect(g.blocks.sentinel).toMatchObject({ name: 'Sentinelle à préserver', locked: true })
    expect(g.blocks['preserved-target']).toMatchObject({ id: 'preserved-target', type: 'function' })
    expect(g.blocks['preserved-target'].id).not.toBe(g.blocks.focus?.id)
    expect(g.variables.taux.value).toBe(0.2)
    expect(g.edges).toContainEqual({
      id: 'preserved-edge',
      source: 'anchor',
      target: 'preserved-target',
      type: 'default',
    })
    if (c.setup === 'existing_focus' || c.setup === 'read_only') {
      expect(g.blocks.focus.type).toBe(c.blockType)
      expect(g.blocks.focus.name).not.toBe(c.name)
    } else expect(g.blocks).not.toHaveProperty('focus')
    if (c.family === 'variables' && c.setup === 'ambiguous') {
      expect(g.variables.tauxBis.name).toBe('tauxBis')
    }
    g.blocks.sentinel.name = 'changed locally'
    g.blocks['preserved-target'].subBlocks.code.value = 'return 99'
    g.variables.taux.value = 99
    g.edges[0].target = 'changed locally'
    const fresh = createCaseGraph(c)
    expect(fresh.blocks.sentinel.name).toBe('Sentinelle à préserver')
    expect(fresh.blocks['preserved-target'].subBlocks.code.value).toBe('return 0')
    expect(fresh.variables.taux.value).toBe(0.2)
    expect(fresh.edges[0].target).toBe('preserved-target')
  }
)

import { prepareWorkflowStateForPersistence } from '@/lib/workflows/persistence/prepare-state'
import { transferBlockHeights } from '@/lib/workflows/autolayout/utils'
import { validateWorkflowState } from '@/lib/workflows/sanitization/validation'

it.each(chatCorpus)(
  '$id survives native preparation and validation without rewriting its initial fixture',
  (c) => {
    const graph = createCaseGraph(c)
    const before = structuredClone(graph)
    const prepared = prepareWorkflowStateForPersistence(structuredClone(graph))
    expect(prepared.warnings).toEqual([])
    expect(prepared.state).toEqual({
      blocks: graph.blocks,
      edges: graph.edges,
      loops: graph.loops,
      parallels: graph.parallels,
    })
    expect(prepareWorkflowStateForPersistence(structuredClone(prepared.state))).toEqual(prepared)
    const validation = validateWorkflowState(structuredClone(graph), { sanitize: true })
    expect(validation.valid).toBe(true)
    expect(validation.errors).toEqual([])
    expect(validation.warnings).toEqual([])
    const transferred = structuredClone(graph.blocks)
    transferBlockHeights(graph.blocks, transferred)
    for (const [id, block] of Object.entries(graph.blocks)) {
      expect(transferred[id].height).toBe(block.height)
      expect(block.height).toBeGreaterThan(0)
    }
    expect(createCaseGraph(c)).toEqual(before)
  }
)

it('initial heights match the native transfer before fixture seed/hash', () => {
  const graph = createCaseGraph(chatCorpus[0])
  const transferred = structuredClone(graph.blocks)
  transferBlockHeights(graph.blocks, transferred)
  for (const [id, block] of Object.entries(graph.blocks))
    expect(transferred[id].height).toBe(block.height)
  expect(graph.blocks.anchor.height).toBeGreaterThan(0)
  expect(graph.blocks.sentinel.height).toBeGreaterThan(0)
})
