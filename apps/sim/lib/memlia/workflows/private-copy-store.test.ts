// Copyright 2026 Memlia. All rights reserved.
import {
  dbChainMockFns,
  queueTableRows,
  resetDbChainMock,
  schemaMock,
  workflowsUtilsMock,
  workflowsUtilsMockFns,
} from '@sim/testing'
import {
  workflowContextMock,
  workflowContextMockFns,
} from '@sim/testing/mocks/workflow-context.mock'
import { workspaceAuthzMock, workspaceAuthzMockFns } from '@sim/testing/mocks/workspace-authz.mock'
import {
  workspaceContextMock,
  workspaceContextMockFns,
} from '@sim/testing/mocks/workspace-context.mock'
import { beforeEach, expect, it, vi } from 'vitest'

const stubs = vi.hoisted(() => ({ load: vi.fn(), admit: vi.fn(), save: vi.fn() }))
vi.mock('@sim/workflow-persistence/load', () => ({
  loadWorkflowFromNormalizedTablesRaw: stubs.load,
}))
vi.mock('@/lib/workflows/persistence/utils', () => ({
  admitWorkflowState: stubs.admit,
  saveAdmittedWorkflowState: stubs.save,
}))
vi.mock('@/lib/workflows/utils', () => workflowsUtilsMock)
vi.mock('@sim/platform-authz/workspace', () => workspaceAuthzMock)
vi.mock('@/lib/workflows/application/context', () => workflowContextMock)
vi.mock('@/lib/workspaces/application/context', () => workspaceContextMock)
vi.mock('@/blocks/registry', () => ({ getBlock: vi.fn(), getBlockRegistry: vi.fn() }))

import { getBlock, getBlockRegistry } from '@/blocks/registry'
import { copyPrivateWorkflowRecord } from './private-copy-store'

const principal = { kind: 'session' as const, userId: 'recipient', sessionId: 'session' }
const input = {
  sourceWorkflowId: 'source-wf',
  destinationWorkspaceId: 'private-ws',
  name: 'My private copy',
}
function queue(
  options: { owner?: string; mode?: string; members?: string[]; blocked?: boolean } = {}
) {
  queueTableRows(schemaMock.user, [
    { id: 'recipient', banned: options.blocked ?? false, banExpires: null, suspendedAt: null },
  ])
  queueTableRows(schemaMock.workspace, [
    {
      id: 'private-ws',
      ownerId: options.owner ?? 'recipient',
      workspaceMode: options.mode ?? 'personal',
      organizationId: null,
      archivedAt: null,
      allowPersonalApiKeys: true,
      billedAccountUserId: 'recipient',
    },
  ])
  queueTableRows(schemaMock.workflow, [
    {
      id: 'source-wf',
      workspaceId: 'shared-ws',
      archivedAt: null,
      updatedAt: new Date('2026-01-01'),
      userId: 'author',
    },
  ])
  queueTableRows(schemaMock.workspace, [
    { id: 'shared-ws', organizationId: null, archivedAt: null, allowPersonalApiKeys: true },
  ])
  queueTableRows(
    schemaMock.permissions,
    (options.members ?? ['recipient']).map((userId) => ({ userId }))
  )
  queueTableRows(schemaMock.workflow, [])
  queueTableRows(schemaMock.folder, [])
  queueTableRows(schemaMock.workspace, [{ archivedAt: null, forkSyncNewWorkflowsExcluded: false }])
}
beforeEach(() => {
  resetDbChainMock()
  vi.clearAllMocks()
  workflowContextMockFns.mockResolveActiveWorkflowApplicationContext.mockResolvedValue({
    workspaceId: 'shared-ws',
    workspaceOrganizationId: null,
    allowPersonalApiKeys: true,
  })
  workspaceContextMockFns.mockResolveActiveWorkspaceApplicationContext.mockResolvedValue({
    workspaceId: 'private-ws',
    workspaceOrganizationId: null,
    allowPersonalApiKeys: true,
  })
  workspaceAuthzMockFns.mockResolveEffectiveWorkspacePermission.mockImplementation(
    async (_user, workspace) => (workspace === 'shared-ws' ? 'read' : 'admin')
  )
  workflowsUtilsMockFns.mockDeduplicateWorkflowName.mockImplementation(async (name) => name)
  vi.mocked(getBlockRegistry).mockImplementation(() => ({ gmail: getBlock('gmail')! }))
  vi.mocked(getBlock).mockReturnValue({
    name: 'Mail',
    subBlocks: [{ id: 'credential', type: 'oauth-input' }],
    outputs: {},
  } as never)
  stubs.load.mockResolvedValue({
    blocks: {
      b: {
        id: 'b',
        name: 'Author',
        type: 'gmail',
        position: { x: 0, y: 0 },
        subBlocks: {
          credential: { id: 'credential', type: 'oauth-input', value: 'author-token-ref' },
        },
        outputs: {},
      },
    },
    edges: [],
    loops: {},
    parallels: {},
  })
  stubs.admit.mockImplementation(async (state) => ({ state }))
  stubs.save.mockResolvedValue({ success: true })
})
it('creates only in the subject personal workspace with new id and empty connection', async () => {
  queue()
  const result = await copyPrivateWorkflowRecord(principal, input)
  expect(result.id).not.toBe('source-wf')
  expect(result.workspaceId).toBe('private-ws')
  const insertIndex = dbChainMockFns.insert.mock.calls.findIndex(
    ([table]) => table === schemaMock.workflow
  )
  expect(dbChainMockFns.values.mock.calls[insertIndex][0]).toMatchObject({
    userId: 'recipient',
    workspaceId: 'private-ws',
    isDeployed: false,
    runCount: 0,
    variables: {},
  })
  expect(JSON.stringify(stubs.save.mock.calls)).not.toContain('author-token-ref')
  expect(stubs.admit.mock.calls[0][1]).toEqual({
    workspaceId: 'private-ws',
    subjectUserId: 'recipient',
  })
})
it.each([
  { owner: 'author' },
  { mode: 'grandfathered_shared' },
  { members: ['recipient', 'author'] },
  { blocked: true },
])('refuses an unsafe personal destination/account %j', async (options) => {
  queue(options)
  await expect(copyPrivateWorkflowRecord(principal, input)).rejects.toMatchObject({
    code: 'forbidden',
  })
  expect(dbChainMockFns.insert).not.toHaveBeenCalled()
  expect(stubs.save).not.toHaveBeenCalled()
})
it.each(['shared-ws', 'private-ws'])(
  'rechecks revoked permission on %s before writes',
  async (denied) => {
    queue()
    workspaceAuthzMockFns.mockResolveEffectiveWorkspacePermission.mockImplementation(
      async (_user, workspace) => (workspace === denied ? null : 'admin')
    )
    await expect(copyPrivateWorkflowRecord(principal, input)).rejects.toMatchObject({
      code: 'forbidden',
    })
    expect(dbChainMockFns.insert).not.toHaveBeenCalled()
  }
)

it('refuses a changed source snapshot before creating a destination row', async () => {
  queue()
  const original = await stubs.load()
  stubs.load
    .mockResolvedValueOnce(original)
    .mockResolvedValueOnce({ ...original, edges: [{ id: 'changed' }] })
  await expect(copyPrivateWorkflowRecord(principal, input)).rejects.toThrow(
    'Source workflow changed'
  )
  expect(dbChainMockFns.insert).not.toHaveBeenCalled()
})
it('rechecks grants inside the transaction after a successful preflight', async () => {
  queue()
  workspaceAuthzMockFns.mockResolveEffectiveWorkspacePermission
    .mockResolvedValueOnce('read')
    .mockResolvedValueOnce('admin')
    .mockResolvedValueOnce(null)
  await expect(copyPrivateWorkflowRecord(principal, input)).rejects.toMatchObject({
    code: 'forbidden',
  })
  expect(dbChainMockFns.insert).not.toHaveBeenCalled()
})

it('persists provenance for the human subject in the graph transaction', async () => {
  queue()
  const result = await copyPrivateWorkflowRecord(principal, input)
  const index = dbChainMockFns.insert.mock.calls.findIndex(
    ([table]) => table === schemaMock.memliaWorkflowCopy
  )
  expect(index).toBeGreaterThanOrEqual(0)
  expect(dbChainMockFns.values.mock.calls[index][0]).toMatchObject({
    workflowId: result.id,
    sourceWorkflowId: 'source-wf',
    sourceStateDigest: result.source.revision,
    createdByUserId: 'recipient',
    createdAt: expect.any(Date),
  })
  expect(result.source.revision).toMatch(/^[a-f0-9]{64}$/)
})
it('does not insert provenance after graph persistence fails', async () => {
  queue()
  stubs.save.mockResolvedValue({ success: false })
  await expect(copyPrivateWorkflowRecord(principal, input)).rejects.toMatchObject({
    code: 'internal',
  })
  expect(dbChainMockFns.insert).not.toHaveBeenCalledWith(schemaMock.memliaWorkflowCopy)
})

it('accepts unchanged SQL rows returned in a different block and edge order', async () => {
  queue()
  const original = await stubs.load()
  const b = original.blocks.b
  const graph = {
    ...original,
    blocks: { b, c: { ...b, id: 'c' }, d: { ...b, id: 'd' } },
    edges: [
      { id: 'edge-a', source: 'b', target: 'c', sourceHandle: 'source', targetHandle: 'target' },
      { id: 'edge-b', source: 'c', target: 'd', sourceHandle: 'source', targetHandle: 'target' },
    ],
    blockUpdatedAtById: { b: 'unchanged', c: 'unchanged', d: 'unchanged' },
  }
  stubs.load.mockResolvedValueOnce(graph).mockResolvedValueOnce({
    ...graph,
    blocks: { d: graph.blocks.d, c: graph.blocks.c, b: graph.blocks.b },
    edges: [...graph.edges].reverse(),
    blockUpdatedAtById: { d: 'unchanged', c: 'unchanged', b: 'unchanged' },
  })
  await expect(copyPrivateWorkflowRecord(principal, input)).resolves.toMatchObject({
    workspaceId: 'private-ws',
    configurationRequired: true,
  })
  expect(stubs.save).toHaveBeenCalledOnce()
})

it('still rejects reordered author content arrays as a real source change', async () => {
  queue()
  const original = await stubs.load()
  const graph = structuredClone(original)
  graph.blocks.b.subBlocks.orderedContent = {
    id: 'orderedContent',
    type: 'table',
    value: ['first', 'second'],
  }
  const changed = structuredClone(graph)
  changed.blocks.b.subBlocks.orderedContent.value.reverse()
  stubs.load.mockResolvedValueOnce(graph).mockResolvedValueOnce(changed)
  await expect(copyPrivateWorkflowRecord(principal, input)).rejects.toMatchObject({
    code: 'conflict',
  })
  expect(dbChainMockFns.insert).not.toHaveBeenCalled()
})
