// Copyright 2026 Memlia. All rights reserved.
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/blocks/registry', () => ({ getBlock: vi.fn(), getBlockRegistry: vi.fn() }))

import { getBlock, getBlockRegistry } from '@/blocks/registry'
import { preparePrivateCopyState } from './private-copy-state'

const state = () => ({
  blocks: {
    original: {
      id: 'original',
      type: 'gmail',
      name: 'Author private customer',
      position: { x: 1, y: 2 },
      enabled: true,
      outputs: { customer: 'private result' },
      data: { credentialId: 'author-connection' },
      subBlocks: {
        credential: { id: 'credential', type: 'oauth-input', value: 'author-connection' },
        message: {
          id: 'message',
          type: 'long-input',
          value: 'author personal data /api/files/view/private-file',
        },
      },
    },
    second: {
      id: 'second',
      type: 'gmail',
      name: 'Second',
      position: { x: 3, y: 4 },
      enabled: true,
      outputs: {},
      subBlocks: {},
    },
  },
  edges: [
    {
      id: 'old-edge',
      source: 'original',
      target: 'second',
      sourceHandle: 'source',
      targetHandle: 'target',
      data: { private: 'author data' },
      label: 'private label',
    },
  ],
  loops: {},
  parallels: {},
  variables: { old: { id: 'old', name: 'customer', type: 'string', value: 'private variable' } },
})
beforeEach(() => {
  vi.mocked(getBlockRegistry).mockImplementation(() => ({ gmail: getBlock('gmail')! }))
  vi.mocked(getBlock).mockReturnValue({
    name: 'Mail',
    subBlocks: [
      { id: 'credential', type: 'oauth-input' },
      { id: 'message', type: 'long-input' },
    ],
    outputs: {},
  } as never)
})
describe('private copy state boundary', () => {
  it('keeps topology under fresh ids, clears all author inputs and reports configuration required', () => {
    const source = state()
    const result = preparePrivateCopyState(source as never)
    expect(Object.keys(result.state.blocks)).toHaveLength(2)
    expect(Object.keys(result.state.blocks)).not.toContain('original')
    const serialized = JSON.stringify(result.state)
    for (const value of [
      'author-connection',
      'private-file',
      'private variable',
      'private label',
      'private result',
      'Author private customer',
    ])
      expect(serialized).not.toContain(value)
    expect(result.state.variables).toEqual({})
    expect(result.configurationRequired).toBe(true)
    expect(result.state.edges[0].source).toBe(Object.keys(result.state.blocks)[0])
    expect(result.state.edges[0].target).toBe(Object.keys(result.state.blocks)[1])
    expect(result.state.edges[0].id).not.toBe('old-edge')
    expect(source.blocks.original.subBlocks.credential.value).toBe('author-connection')
  })
  it('refuses an unregistered block instead of carrying opaque source data', () => {
    vi.mocked(getBlock).mockReturnValue(undefined)
    expect(() => preparePrivateCopyState(state() as never)).toThrow(/cannot be copied privately/)
  })
  it('refuses dynamic topology not covered by this first copy boundary', () => {
    const graph = state()
    graph.edges[0].sourceHandle = 'condition-author-private-branch'
    expect(() => preparePrivateCopyState(graph as never)).toThrow(/cannot be copied privately/)
  })
  it('refuses foreign edge endpoints instead of keeping a stale reference', () => {
    const graph = state()
    graph.edges[0].target = 'foreign-block'
    expect(() => preparePrivateCopyState(graph as never)).toThrow(/cannot be copied privately/)
  })
})

it('refuses dynamic custom registry overlays even when getBlock resolves them', () => {
  vi.mocked(getBlockRegistry).mockReturnValue({})
  expect(() => preparePrivateCopyState(state() as never)).toThrow(/cannot be copied privately/)
})
