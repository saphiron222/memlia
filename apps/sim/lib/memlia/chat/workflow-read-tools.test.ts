// Copyright (c) 2026 Memlia. All rights reserved.

import {
  createSessionPrincipal,
  createWorkspaceApiKeyPrincipal,
} from '@sim/testing/factories/principal.factory'
import { auditMock } from '@sim/testing/mocks/audit.mock'
import {
  workflowContextMock,
  workflowContextMockFns,
} from '@sim/testing/mocks/workflow-context.mock'
import {
  workflowsQueriesMock,
  workflowsQueriesMockFns,
} from '@sim/testing/mocks/workflows-queries.mock'
import { workspaceAuthzMock, workspaceAuthzMockFns } from '@sim/testing/mocks/workspace-authz.mock'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Native read use case, authorization, snapshot projection, v2 DTO and sanitizer.
// Only DB/context/permission lookups and registered input metadata are unit doubles.
vi.mock('@sim/audit', () => auditMock)
vi.mock('@sim/platform-authz/workspace', () => workspaceAuthzMock)
vi.mock('@/lib/workflows/application/context', () => workflowContextMock)
vi.mock('@/lib/workflows/queries', () => workflowsQueriesMock)

import { OrchestrationError } from '@/lib/core/orchestration/types'
import { getBlock } from '@/blocks/registry'
import { createWorkflowReadTools } from './workflow-read-tools'

const principal = createSessionPrincipal({ userId: 'workflow-reader' })
const scope = { principal, workspaceId: 'workspace-1', workflowId: 'workflow-1' }
const context = {
  workflowId: 'workflow-1',
  workflow: { id: 'workflow-1', workspaceId: 'workspace-1' },
  workspaceId: 'workspace-1',
  workspaceOrganizationId: null,
  allowPersonalApiKeys: true,
  billedAccountUserId: 'different-payer',
}
const load = workflowsQueriesMockFns.mockLoadWorkflowReadSnapshot
const resolve = workflowContextMockFns.mockResolveActiveWorkflowApplicationContext
const permission = workspaceAuthzMockFns.mockResolveEffectiveWorkspacePermission

function block(id: string) {
  return {
    id,
    type: 'fixture',
    name: id,
    position: { x: 0, y: 0 },
    enabled: true,
    outputs: {},
    subBlocks: {} as Record<string, { id: string; type: string; value: unknown }>,
    data: {} as Record<string, unknown>,
  }
}
let graph: ReturnType<typeof fixture>
function fixture() {
  const node = block('b1')
  for (const [id, type, value] of [
    ['password', 'short-input', 'FICTIVE_PASSWORD_MUST_NOT_LEAVE'],
    ['oauth', 'oauth-input', 'FICTIVE_OAUTH_MUST_NOT_LEAVE'],
    ['credentialId', 'short-input', 'FICTIVE_BINDING_MUST_NOT_LEAVE'],
    ['headers', 'table', [{ key: 'Authorization', value: 'FICTIVE_HEADER_MUST_NOT_LEAVE' }]],
    ['apiKey', 'short-input', '{{FICTIVE_API_KEY}}'],
    ['code', 'code', 'return "FICTIVE_LITERAL_SECRET_REMAINS"'],
  ] as const)
    node.subBlocks[id] = { id, type, value }
  return {
    draftRevision: 7,
    blocks: { b1: node } as Record<string, ReturnType<typeof block>>,
    edges: [] as Array<{
      id: string
      source: string
      target: string
      sourceHandle?: string
      targetHandle?: string
    }>,
    loops: {} as Record<
      string,
      { id: string; nodes: string[]; iterations: number; loopType: 'for'; forEachItems?: unknown[] }
    >,
    parallels: {} as Record<
      string,
      {
        id: string
        nodes: string[]
        count: number
        parallelType: 'count'
        distribution?: unknown[]
      }
    >,
    variables: {
      v1: {
        id: 'v1',
        name: 'Private variable',
        type: 'string',
        value: 'FICTIVE_VARIABLE_MUST_NOT_LEAVE',
      },
    },
  }
}

beforeEach(() => {
  graph = fixture()
  resolve.mockReset().mockImplementation(async ({ workflowId, assertedWorkspaceId }) => {
    if (
      workflowId !== 'workflow-1' ||
      (assertedWorkspaceId && assertedWorkspaceId !== 'workspace-1')
    )
      throw new OrchestrationError('not_found', 'FICTIVE_INTERNAL_SCOPE_DETAIL')
    return context
  })
  permission
    .mockReset()
    .mockImplementation(async (userId, workspaceId) =>
      userId === 'workflow-reader' && workspaceId === 'workspace-1' ? 'read' : null
    )
  load.mockReset().mockImplementation(async () => ({
    workflowRecord: {
      id: 'workflow-1',
      draftRevision: graph.draftRevision,
      variables: graph.variables,
    },
    normalizedData: {
      blocks: graph.blocks,
      edges: graph.edges,
      loops: graph.loops,
      parallels: graph.parallels,
    },
  }))
  vi.mocked(getBlock).mockReturnValue({
    name: 'Fixture',
    description: '',
    outputs: {},
    subBlocks: [
      { id: 'password', type: 'short-input', password: true },
      { id: 'oauth', type: 'oauth-input' },
      { id: 'headers', type: 'table' },
      { id: 'apiKey', type: 'short-input', password: true },
      { id: 'code', type: 'code' },
    ],
  } as never)
})

describe('workflow reads for authoring — native use case and sanitizer with unit infrastructure', () => {
  it('returns the exact snapshot revision and native sanitized graph without variable values', async () => {
    const before = structuredClone(graph)
    const result = await createWorkflowReadTools(scope).dispatch('read_workflow', { view: 'full' })
    expect(result).toMatchObject({
      ok: true,
      data: {
        view: 'full',
        draftRevision: 7,
        variables: { v1: { id: 'v1', name: 'Private variable', type: 'string' } },
        blocks: {
          b1: {
            subBlocks: {
              password: { value: null },
              oauth: { value: null },
              credentialId: { value: null },
              headers: { value: null },
              apiKey: { value: '{{FICTIVE_API_KEY}}' },
              code: { value: 'return "FICTIVE_LITERAL_SECRET_REMAINS"' },
            },
          },
        },
      },
    })
    expect(JSON.stringify(result)).not.toContain('MUST_NOT_LEAVE')
    expect(result).toHaveProperty('data.variables.v1', {
      id: 'v1',
      name: 'Private variable',
      type: 'string',
    })
    expect(graph).toEqual(before)
    expect(load).toHaveBeenCalledWith('workflow-1', 'workspace-1')
    expect(resolve).toHaveBeenCalledWith({
      workflowId: 'workflow-1',
      assertedWorkspaceId: 'workspace-1',
    })
    expect(permission.mock.calls[0].slice(0, 2)).toEqual(['workflow-reader', 'workspace-1'])
  })
  it('pages a stable structural summary and requires the same revision after offset zero', async () => {
    graph.blocks = { z: block('z'), b1: graph.blocks.b1, a: block('a') }
    const tools = createWorkflowReadTools(scope)
    expect(
      await tools.dispatch('read_workflow', { view: 'summary', section: 'blocks', limit: 1 })
    ).toMatchObject({
      ok: true,
      data: {
        view: 'summary',
        draftRevision: 7,
        section: 'blocks',
        counts: { blocks: 3, edges: 0, variables: 1, loops: 0, parallels: 0 },
        page: { offset: 0, limit: 1, total: 3, nextOffset: 1 },
        entries: { a: { id: 'a', type: 'fixture', name: 'a' } },
      },
    })
    load.mockClear()
    expect(
      await tools.dispatch('read_workflow', {
        view: 'summary',
        section: 'blocks',
        offset: 1,
        limit: 1,
      })
    ).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    expect(load).not.toHaveBeenCalled()
    const second = await tools.dispatch('read_workflow', {
      view: 'summary',
      section: 'blocks',
      offset: 1,
      limit: 1,
      expectedRevision: 7,
    })
    expect(second).toMatchObject({
      ok: true,
      data: { draftRevision: 7, page: { total: 3, nextOffset: 2 }, entries: { b1: { id: 'b1' } } },
    })
    expect(JSON.stringify(second)).not.toContain('FICTIVE_')
    graph.draftRevision = 8
    expect(
      await tools.dispatch('read_workflow', {
        view: 'summary',
        section: 'blocks',
        offset: 2,
        expectedRevision: 7,
      })
    ).toMatchObject({ ok: false, error: { code: 'revision_conflict' } })
  })

  it('preserves reconstructible native edges and container membership in explicit summary sections', async () => {
    graph.blocks.b1.data = { parentId: 'loop1', collection: ['FICTIVE_COLLECTION_NOT_SUMMARY'] }
    graph.loops.loop1 = {
      id: 'loop1',
      nodes: ['b1'],
      loopType: 'for',
      iterations: 4,
      forEachItems: ['FICTIVE_ITEMS_NOT_SUMMARY'],
    }
    graph.parallels.parallel1 = {
      id: 'parallel1',
      nodes: ['loop1'],
      count: 2,
      parallelType: 'count',
      distribution: ['FICTIVE_DISTRIBUTION_NOT_SUMMARY'],
    }
    graph.edges = [
      { id: 'z', source: 'b1', target: 'parallel1' },
      { id: 'a', source: 'loop1', target: 'b1', sourceHandle: 'loop-start' },
    ]
    const tools = createWorkflowReadTools(scope)
    expect(
      await tools.dispatch('read_workflow', { view: 'summary', section: 'blocks' })
    ).toMatchObject({ ok: true, data: { entries: { b1: { data: { parentId: 'loop1' } } } } })
    expect(
      await tools.dispatch('read_workflow', { view: 'summary', section: 'edges', limit: 1 })
    ).toMatchObject({
      ok: true,
      data: {
        page: { total: 2, nextOffset: 1 },
        entries: [{ id: 'a', source: 'loop1', target: 'b1', sourceHandle: 'loop-start' }],
      },
    })
    const loop = await tools.dispatch('read_workflow', { view: 'summary', section: 'loops' })
    expect(loop).toMatchObject({
      ok: true,
      data: { entries: { loop1: { id: 'loop1', nodes: ['b1'], loopType: 'for' } } },
    })
    expect(JSON.stringify(loop)).not.toContain('FICTIVE_')
    const parallel = await tools.dispatch('read_workflow', {
      view: 'summary',
      section: 'parallels',
    })
    expect(parallel).toMatchObject({
      ok: true,
      data: {
        entries: { parallel1: { id: 'parallel1', nodes: ['loop1'], parallelType: 'count' } },
      },
    })
    expect(JSON.stringify(parallel)).not.toContain('FICTIVE_')
    const variables = await tools.dispatch('read_workflow', {
      view: 'summary',
      section: 'variables',
    })
    expect(variables).toMatchObject({
      ok: true,
      data: {
        entries: { v1: { name: 'Private variable', type: 'string' } },
        page: { total: 1, nextOffset: null },
      },
    })
    expect(JSON.stringify(variables)).not.toContain('MUST_NOT_LEAVE')
  })

  it('returns an explicitly requested block when a full graph exceeds the delivery bound', async () => {
    graph.blocks.large = block('large')
    graph.blocks.large.subBlocks.code = { id: 'code', type: 'code', value: 'x'.repeat(300 * 1024) }
    const tools = createWorkflowReadTools(scope)
    expect(await tools.dispatch('read_workflow', { view: 'full' })).toMatchObject({
      ok: false,
      error: { code: 'result_too_large' },
    })
    expect(
      await tools.dispatch('read_workflow', { view: 'summary', section: 'blocks' })
    ).toMatchObject({ ok: true, data: { page: { total: 2, nextOffset: null } } })
    expect(
      await tools.dispatch('read_workflow_block', { blockId: 'b1', expectedRevision: 7 })
    ).toMatchObject({
      ok: true,
      data: { draftRevision: 7, block: { id: 'b1', subBlocks: { password: { value: null } } } },
    })
    expect(await tools.dispatch('read_workflow_block', { blockId: 'large' })).toMatchObject({
      ok: false,
      error: { code: 'result_too_large' },
    })
  })

  it.each([
    ['read_workflow', { view: 'full', workflowId: 'foreign-workflow' }],
    ['read_workflow', { view: 'full', workspaceId: 'foreign-workspace' }],
    ['read_workflow', { view: 'full', principal: { userId: 'owner' } }],
    ['read_workflow', { view: 'full', userId: 'owner' }],
    ['read_workflow', { view: 'full', operations: [{ op: 'delete' }] }],
    ['read_workflow', { view: 'full', offset: 0 }],
    ['read_workflow', { view: 'summary', section: 'credentials' }],
    ['read_workflow', { view: 'summary', section: 'blocks', limit: 101 }],
    ['read_workflow', { view: 'summary', section: 'blocks', offset: -1 }],
    ['read_workflow', { view: 'summary', section: 'blocks', offset: 0.5 }],
    ['read_workflow', { view: 'full', expectedRevision: '7' }],
    ['read_workflow', { view: 'full', expectedRevision: -1 }],
    ['read_workflow', { view: 'full', expectedRevision: Number.MAX_SAFE_INTEGER + 1 }],
    ['read_workflow_block', { blockId: '' }],
    ['read_workflow_block', { blockId: 'x'.repeat(513) }],
    ['read_workflow_block', { blockId: 'b1', workflowId: 'foreign-workflow' }],
    ['read_workflow_block', { blockId: 'b1', includeCredentials: true }],
  ])(
    'rejects model-owned scope, unknown fields and invalid bounds before reads: %s %j',
    async (tool, input) => {
      expect(await createWorkflowReadTools(scope).dispatch(tool, input)).toEqual({
        ok: false,
        error: { code: 'invalid_input', message: 'Workflow read could not complete.' },
      })
      expect(resolve).not.toHaveBeenCalled()
      expect(permission).not.toHaveBeenCalled()
      expect(load).not.toHaveBeenCalled()
    }
  )

  it('refuses unknown and mutation tools without lookup or native fallback', async () => {
    const tools = createWorkflowReadTools(scope)
    for (const name of [
      'apply_workflow_operations',
      'execute_workflow',
      'get_credentials',
      '__proto__',
    ])
      expect(await tools.dispatch(name, {})).toMatchObject({
        ok: false,
        error: { code: 'tool_not_allowed' },
      })
    expect(resolve).not.toHaveBeenCalled()
    expect(load).not.toHaveBeenCalled()
  })

  it('rechecks current read permission for shared resources and never substitutes the payer', async () => {
    const tools = createWorkflowReadTools(scope)
    expect(await tools.dispatch('read_workflow', { view: 'full' })).toMatchObject({ ok: true })
    permission.mockResolvedValue(null)
    load.mockClear()
    expect(await tools.dispatch('read_workflow', { view: 'summary', section: 'blocks' })).toEqual({
      ok: false,
      error: { code: 'forbidden', message: 'Workflow read could not complete.' },
    })
    expect(permission).toHaveBeenCalledTimes(2)
    expect(permission.mock.calls.every(([userId]) => userId === 'workflow-reader')).toBe(true)
    expect(load).not.toHaveBeenCalled()
  })

  it('denies an unauthorized different user before loading any shared draft', async () => {
    const tools = createWorkflowReadTools({
      ...scope,
      principal: createSessionPrincipal({ userId: 'foreign-user' }),
    })
    expect(await tools.dispatch('read_workflow', { view: 'full' })).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    })
    expect(permission.mock.calls[0][0]).toBe('foreign-user')
    expect(load).not.toHaveBeenCalled()
  })

  it.each([{ workspaceId: 'foreign-workspace' }, { workflowId: 'foreign-workflow' }])(
    'keeps the server-selected scope during the native lookup: %j',
    async (foreign) => {
      const result = await createWorkflowReadTools({ ...scope, ...foreign }).dispatch(
        'read_workflow',
        { view: 'full' }
      )
      expect(result).toEqual({
        ok: false,
        error: { code: 'not_found', message: 'Workflow read could not complete.' },
      })
      expect(load).not.toHaveBeenCalled()
      expect(JSON.stringify(result)).not.toContain('FICTIVE_')
    }
  )

  it('does not deliver a canonical scoped-principal read from a different server workspace', async () => {
    const tools = createWorkflowReadTools({
      ...scope,
      workspaceId: 'server-workspace-other',
      principal: createWorkspaceApiKeyPrincipal({ workspaceId: 'workspace-1' }),
    })
    expect(await tools.dispatch('read_workflow', { view: 'full' })).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    })
    // Scoped principal authorization is native and successful in workspace-1;
    // its ignored workspace assertion must not turn into delivery to another binding.
    expect(resolve).toHaveBeenCalledWith({
      workflowId: 'workflow-1',
      assertedWorkspaceId: undefined,
    })
    expect(load).toHaveBeenCalledWith('workflow-1', 'workspace-1')
  })

  it('returns not_found for missing own blocks including inherited object names', async () => {
    const tools = createWorkflowReadTools(scope)
    for (const blockId of ['missing', '__proto__', 'constructor', 'toString'])
      expect(await tools.dispatch('read_workflow_block', { blockId })).toMatchObject({
        ok: false,
        error: { code: 'not_found' },
      })
    load.mockResolvedValue({ workflowRecord: null, normalizedData: null })
    expect(await tools.dispatch('read_workflow', { view: 'full' })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    })
  })

  it('preserves zero and maximum safe revisions and checks expected revision before block delivery', async () => {
    const tools = createWorkflowReadTools(scope)
    graph.draftRevision = 0
    expect(
      await tools.dispatch('read_workflow', { view: 'full', expectedRevision: 0 })
    ).toMatchObject({ ok: true, data: { draftRevision: 0 } })
    expect(
      await tools.dispatch('read_workflow', {
        view: 'summary',
        section: 'blocks',
        offset: 1,
        expectedRevision: 0,
      })
    ).toMatchObject({
      ok: true,
      data: { draftRevision: 0, entries: {}, page: { total: 1, nextOffset: null } },
    })
    expect(
      await tools.dispatch('read_workflow_block', { blockId: 'b1', expectedRevision: 1 })
    ).toMatchObject({ ok: false, error: { code: 'revision_conflict' } })
    graph.draftRevision = Number.MAX_SAFE_INTEGER
    expect(
      await tools.dispatch('read_workflow_block', {
        blockId: 'b1',
        expectedRevision: Number.MAX_SAFE_INTEGER,
      })
    ).toMatchObject({ ok: true, data: { draftRevision: Number.MAX_SAFE_INTEGER } })
    expect(
      await tools.dispatch('read_workflow', { view: 'full', expectedRevision: 0 })
    ).toMatchObject({ ok: false, error: { code: 'revision_conflict' } })
  })

  it('breaks edge sort ties deterministically and reports empty end pages explicitly', async () => {
    const edges = [
      { id: 'tie', source: 'z', target: 'b1' },
      { id: 'tie', source: 'a', target: 'b1' },
    ]
    graph.edges = edges
    const tools = createWorkflowReadTools(scope)
    const first = await tools.dispatch('read_workflow', { view: 'summary', section: 'edges' })
    graph.edges = [...edges].reverse()
    expect(await tools.dispatch('read_workflow', { view: 'summary', section: 'edges' })).toEqual(
      first
    )
    expect(first).toMatchObject({
      ok: true,
      data: { entries: [edges[1], edges[0]], page: { total: 2, nextOffset: null } },
    })
    expect(
      await tools.dispatch('read_workflow', {
        view: 'summary',
        section: 'edges',
        offset: 9,
        expectedRevision: 7,
      })
    ).toMatchObject({
      ok: true,
      data: { entries: [], page: { offset: 9, total: 2, nextOffset: null } },
    })
  })

  it('projects only native DTO fields and omits nested values of every variable declaration', async () => {
    Object.assign(graph.blocks.b1, { unknownField: 'FICTIVE_UNKNOWN_MUST_NOT_LEAVE' })
    Object.assign(graph.variables.v1, {
      unknownField: 'FICTIVE_UNKNOWN_MUST_NOT_LEAVE',
      value: { nested: ['FICTIVE_VARIABLE_MUST_NOT_LEAVE'] },
    })
    const tools = createWorkflowReadTools(scope)
    for (const [tool, params] of [
      ['read_workflow', { view: 'full' }],
      ['read_workflow', { view: 'summary', section: 'variables' }],
      ['read_workflow_block', { blockId: 'b1' }],
    ] as const)
      expect(JSON.stringify(await tools.dispatch(tool, params))).not.toContain('MUST_NOT_LEAVE')
  })

  it('measures the delivery bound in UTF-8 bytes rather than characters', async () => {
    graph.blocks.b1.subBlocks.code.value = 'é'.repeat(140 * 1024)
    expect(
      await createWorkflowReadTools(scope).dispatch('read_workflow_block', { blockId: 'b1' })
    ).toMatchObject({ ok: false, error: { code: 'result_too_large' } })
  })

  it('includes the success envelope in the delivery bound and accepts the exact limit', async () => {
    graph.blocks.b1.subBlocks.code.value = ''
    const tools = createWorkflowReadTools(scope)
    const empty = await tools.dispatch('read_workflow_block', { blockId: 'b1' })
    expect(empty.ok).toBe(true)
    const overhead = Buffer.byteLength(JSON.stringify(empty), 'utf8')
    graph.blocks.b1.subBlocks.code.value = 'x'.repeat(256 * 1024 - overhead)
    const exact = await tools.dispatch('read_workflow_block', { blockId: 'b1' })
    expect(exact.ok).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(exact), 'utf8')).toBe(256 * 1024)
    graph.blocks.b1.subBlocks.code.value += 'x'
    expect(await tools.dispatch('read_workflow_block', { blockId: 'b1' })).toMatchObject({
      ok: false,
      error: { code: 'result_too_large' },
    })
  })

  it('refuses malformed stored graphs without exposing parser or database details', async () => {
    graph.draftRevision = -1
    const tools = createWorkflowReadTools(scope)
    expect(await tools.dispatch('read_workflow', { view: 'full' })).toEqual({
      ok: false,
      error: { code: 'unavailable', message: 'Workflow read could not complete.' },
    })
    load.mockRejectedValue(new Error('FICTIVE_DATABASE_PASSWORD_MUST_NOT_LEAVE'))
    expect(await tools.dispatch('read_workflow_block', { blockId: 'b1' })).toEqual({
      ok: false,
      error: { code: 'unavailable', message: 'Workflow read could not complete.' },
    })
  })

  it('does not start an already-cancelled read or return private abort reasons', async () => {
    const signal = AbortSignal.abort(new Error('FICTIVE_PRIVATE_ABORT_REASON'))
    expect(
      await createWorkflowReadTools(scope).dispatch('read_workflow', { view: 'full' }, signal)
    ).toEqual({
      ok: false,
      error: { code: 'cancelled', message: 'Workflow read could not complete.' },
    })
    expect(resolve).not.toHaveBeenCalled()
    expect(load).not.toHaveBeenCalled()
  })

  it('cancels delivery while a native read is pending, discards its late result and removes listeners', async () => {
    let finish!: (value: Awaited<ReturnType<typeof load>>) => void
    const snapshot = await load()
    load.mockReset().mockImplementation(
      () =>
        new Promise((done) => {
          finish = done
        })
    )
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const pending = createWorkflowReadTools(scope).dispatch(
      'read_workflow',
      { view: 'full' },
      controller.signal
    )
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1))
    controller.abort('FICTIVE_PRIVATE_ABORT_REASON')
    expect(await pending).toEqual({
      ok: false,
      error: { code: 'cancelled', message: 'Workflow read could not complete.' },
    })
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    vi.mocked(getBlock).mockClear()
    finish(snapshot)
    await new Promise((done) => setTimeout(done, 0))
    expect(await pending).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    expect(getBlock).not.toHaveBeenCalled()
  })
})
