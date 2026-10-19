// Copyright 2026 Memlia. All rights reserved.
import { describe, expect, it, vi } from 'vitest'

const clientBoundary = vi.hoisted(() => ({
  register: vi.fn(() => {
    throw new Error('Client reset registration called from server import')
  }),
}))
// Only the RSC call boundary is doubled. Native parser/ID regeneration remain real.
// This is not a Next compiler or a qualification of all route module graphs.
vi.mock('@/stores/user-data-reset-registry', () => ({
  registerUserDataReset: clientBoundary.register,
  resetRegisteredUserData: () => {
    throw new Error('Client reset called from server import')
  },
}))

function source() {
  const block = (id: string, type: string, name: string) => ({
    id,
    type,
    name,
    position: { x: 0, y: 0 },
    subBlocks: {},
    outputs: {},
    enabled: true,
  })
  return {
    blocks: {
      condition: {
        ...block('condition', 'condition', 'Condition'),
        subBlocks: {
          conditions: {
            id: 'conditions',
            type: 'condition-input',
            value: JSON.stringify([
              { id: 'condition-if', title: 'if', value: 'true' },
              { id: 'condition-else', title: 'else', value: '' },
            ]),
          },
        },
      },
      loop: { ...block('loop', 'loop', 'Loop'), data: { count: 2, loopType: 'for' } },
      child: {
        ...block('child', 'function', 'Child'),
        data: { parentId: 'loop', extent: 'parent' },
        subBlocks: { code: { id: 'code', type: 'code', value: 'return 1' } },
      },
    },
    edges: [
      {
        id: 'edge',
        source: 'condition',
        target: 'child',
        sourceHandle: 'condition-condition-if',
        targetHandle: 'target',
      },
    ],
    loops: { loop: { id: 'loop', nodes: ['child'], iterations: 2, loopType: 'for' } },
    parallels: {},
    metadata: { name: 'Boundary fixture' },
    variables: {},
  }
}

describe('server import uses native regeneration without evaluating client stores', () => {
  it('imports the real parser and preserves regenerated graph relationships without any client reset call', async () => {
    const { parseWorkflowJson } = await import('./import-export')
    const original = source()
    const bytes = JSON.stringify(original)
    const { data, errors } = parseWorkflowJson(bytes)
    expect(errors).toEqual([])
    expect(data).not.toBeNull()
    if (!data) throw new Error('Expected a parsed workflow')
    const condition = Object.values(data.blocks).find((b) => b.name === 'Condition')!
    const loop = Object.values(data.blocks).find((b) => b.name === 'Loop')!
    const child = Object.values(data.blocks).find((b) => b.name === 'Child')!
    expect(new Set(Object.keys(data.blocks)).size).toBe(3)
    expect(Object.keys(data.blocks).every((id) => !Object.hasOwn(original.blocks, id))).toBe(true)
    expect(child.data?.parentId).toBe(loop.id)
    expect(data.loops[loop.id].nodes).toEqual([child.id])
    expect(data.edges[0]).toMatchObject({
      source: condition.id,
      target: child.id,
      sourceHandle: `condition-${condition.id}-if`,
      targetHandle: 'target',
    })
    expect(data.edges[0].id).not.toBe('edge')
    const rows = JSON.parse(condition.subBlocks.conditions.value as string)
    expect(rows.map((r: { id: string }) => r.id)).toEqual([
      `${condition.id}-if`,
      `${condition.id}-else`,
    ])
    expect(child.subBlocks.code.value).toBe('return 1')
    expect(data.metadata).toEqual(original.metadata)
    expect(JSON.stringify(original)).toBe(bytes)
    expect(clientBoundary.register).not.toHaveBeenCalled()
  })
  it('retains the native opt-out and malformed-input refusal without reaching client state', async () => {
    const { parseWorkflowJson } = await import('./import-export')
    const { data, errors } = parseWorkflowJson(JSON.stringify(source()), false)
    expect(errors).toEqual([])
    expect(Object.keys(data!.blocks).sort()).toEqual(['child', 'condition', 'loop'])
    expect(parseWorkflowJson('{').data).toBeNull()
    expect(clientBoundary.register).not.toHaveBeenCalled()
  })
})
