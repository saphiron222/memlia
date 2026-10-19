// Copyright 2026 Memlia. All rights reserved.
import {
  dbChainMockFns,
  hybridAuthMockFns,
  queueTableRows,
  resetDbChainMock,
  schemaMock,
  workflowAuthzMockFns,
} from '@sim/testing'
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { workflowStateResponseSchema } from '@/lib/api/contracts/workflows'

const writer = vi.hoisted(() => ({ save: vi.fn() }))
vi.mock('@/lib/workflows/persistence/save-normalized-state', () => ({
  saveWorkflowNormalizedState: writer.save,
}))

import { GET, PUT } from './route'

// Real GET handler, loader/migrations and serialization; database/auth are native unit doubles.
const workflowId = 'workflow-1'
const request = () => new NextRequest(`http://localhost:3000/api/workflows/${workflowId}/state`)
const context = () => ({ params: Promise.resolve({ id: workflowId }) })
function snapshotRows(revision: number) {
  queueTableRows(schemaMock.workflowBlocks, [])
  queueTableRows(schemaMock.workflowEdges, [])
  queueTableRows(schemaMock.workflowSubflows, [])
  // First workflow result belongs to the real raw loader, second to the route's same-tx projection.
  queueTableRows(schemaMock.workflow, [{ workspaceId: 'workspace-1', draftRevision: revision }])
  queueTableRows(schemaMock.workflow, [
    {
      draftRevision: revision,
      variables: {
        threshold: {
          id: 'threshold',
          name: 'threshold',
          type: 'number',
          value: 3,
          workflowId: 'foreign-value',
        },
      },
    },
  ])
}
beforeEach(() => {
  resetDbChainMock()
  hybridAuthMockFns.mockCheckSessionOrInternalAuth.mockResolvedValue({
    success: true,
    userId: 'reader',
    authType: 'session',
  })
  workflowAuthzMockFns.mockAuthorizeWorkflowByWorkspacePermission.mockResolvedValue({
    allowed: true,
    workflow: { id: workflowId, userId: 'reader', workspaceId: 'workspace-1', draftRevision: 99 },
    workspacePermission: 'read',
  })
})
describe('GET internal normalized workflow state', () => {
  it.each([0, 7, Number.MAX_SAFE_INTEGER])(
    'returns revision %s from the graph snapshot, not the authorization row',
    async (revision) => {
      snapshotRows(revision)
      const response = await GET(request(), context())
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body).toEqual({
        draftRevision: revision,
        blocks: {},
        edges: [],
        loops: {},
        parallels: {},
        variables: {
          threshold: { id: 'threshold', name: 'threshold', type: 'number', value: 3, workflowId },
        },
      })
      expect(workflowStateResponseSchema.parse(body)).toEqual(body)
      expect(dbChainMockFns.select).toHaveBeenCalledWith({
        variables: schemaMock.workflow.variables,
        draftRevision: schemaMock.workflow.draftRevision,
      })
      expect(dbChainMockFns.transaction).toHaveBeenCalledTimes(1)
      expect(dbChainMockFns.update).not.toHaveBeenCalled()
    }
  )
  it('refuses an unauthenticated reader before loading the snapshot', async () => {
    hybridAuthMockFns.mockCheckSessionOrInternalAuth.mockResolvedValueOnce({ success: false })
    const response = await GET(request(), context())
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'Unauthorized' })
    expect(dbChainMockFns.transaction).not.toHaveBeenCalled()
  })
  it('keeps the permission denial without loading or exposing a revision', async () => {
    workflowAuthzMockFns.mockAuthorizeWorkflowByWorkspacePermission.mockResolvedValueOnce({
      allowed: false,
      status: 403,
      message: 'Denied',
      workspacePermission: null,
    })
    const response = await GET(request(), context())
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'Forbidden' })
    expect(dbChainMockFns.transaction).not.toHaveBeenCalled()
  })
  it('keeps a missing normalized graph at 404 without a fabricated revision', async () => {
    const response = await GET(request(), context())
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'Workflow state not found' })
  })
  it('refuses a missing snapshot row instead of fabricating a revision', async () => {
    queueTableRows(schemaMock.workflowBlocks, [])
    queueTableRows(schemaMock.workflowEdges, [])
    queueTableRows(schemaMock.workflowSubflows, [])
    queueTableRows(schemaMock.workflow, [{ workspaceId: 'workspace-1', draftRevision: 7 }])
    queueTableRows(schemaMock.workflow, [])
    const response = await GET(request(), context())
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'Workflow state not found' })
    expect(dbChainMockFns.update).not.toHaveBeenCalled()
  })
  it('keeps database failures at 500 without exposing row data', async () => {
    dbChainMockFns.transaction.mockRejectedValueOnce(new Error('Controlled read failure'))
    const response = await GET(request(), context())
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Internal server error' })
  })
})

describe('PUT internal CAS transport (writer/auth doubles)', () => {
  const put = (body: unknown) =>
    new NextRequest(`http://localhost:3000/api/workflows/${workflowId}/state`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  it('passes expectedRevision and returns the same mutation receipt', async () => {
    writer.save.mockResolvedValue({
      success: true,
      warnings: [],
      baseRevision: 7,
      draftRevision: 8,
    })
    const response = await PUT(put({ blocks: {}, edges: [], expectedRevision: 7 }), context())
    expect(response.status).toBe(200)
    expect(writer.save).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 7 }))
    expect(await response.json()).toEqual({
      success: true,
      warnings: [],
      baseRevision: 7,
      draftRevision: 8,
    })
  })
  it('rejects invalid supplied revision before writing', async () => {
    const response = await PUT(put({ blocks: {}, edges: [], expectedRevision: '7' }), context())
    expect(response.status).toBe(400)
    expect(writer.save).not.toHaveBeenCalled()
  })
  it('does not turn a conflict into success or retry', async () => {
    writer.save.mockResolvedValue({ success: false, status: 409, error: 'Workflow draft changed' })
    const response = await PUT(put({ blocks: {}, edges: [], expectedRevision: 7 }), context())
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'Workflow draft changed' })
    expect(writer.save).toHaveBeenCalledOnce()
  })
  it('keeps authentication denial ahead of any save', async () => {
    hybridAuthMockFns.mockCheckSessionOrInternalAuth.mockResolvedValueOnce({ success: false })
    const response = await PUT(put({ blocks: {}, edges: [], expectedRevision: 7 }), context())
    expect(response.status).toBe(401)
    expect(writer.save).not.toHaveBeenCalled()
  })
})
