// Modified by Memlia: common workflow draft revision and regression coverage.
/**
 * Tests for workflow variables API route
 * Tests the optimized permissions and caching system
 */
import {
  auditMock,
  dbChainMockFns,
  hybridAuthMockFns,
  queueTableRows,
  schemaMock,
  workflowAuthzMockFns,
  workflowsUtilsMock,
} from '@sim/testing'
import { NextRequest } from 'next/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@sim/audit', () => auditMock)

vi.mock('@/lib/workflows/utils', () => workflowsUtilsMock)

import { GET, POST } from '@/app/api/workflows/[id]/variables/route'

describe('Workflow Variables API Route', () => {
  describe('GET /api/workflows/[id]/variables', () => {
    it('should deny access when user has no workspace permissions', async () => {
      const mockWorkflow = {
        id: 'workflow-123',
        userId: 'other-user',
        workspaceId: 'workspace-456',
        variables: {},
      }

      hybridAuthMockFns.mockCheckSessionOrInternalAuth.mockResolvedValueOnce({
        success: true,
        userId: 'user-123',
        authType: 'session',
      })
      workflowAuthzMockFns.mockAuthorizeWorkflowByWorkspacePermission.mockResolvedValueOnce({
        allowed: false,
        status: 403,
        message: 'Unauthorized: Access denied to read this workflow',
        workflow: mockWorkflow,
        workspacePermission: null,
      })

      const req = new NextRequest('http://localhost:3000/api/workflows/workflow-123/variables')
      const params = Promise.resolve({ id: 'workflow-123' })

      const response = await GET(req, { params })

      expect(response.status).toBe(403)
      const data = await response.json()
      expect(data.error).toBe('Unauthorized: Access denied to read this workflow')
    })
  })

  describe('POST /api/workflows/[id]/variables', () => {
    it('persists variables and advances the common revision in one transaction', async () => {
      hybridAuthMockFns.mockCheckSessionOrInternalAuth.mockResolvedValueOnce({
        success: true,
        userId: 'user-123',
        authType: 'session',
      })
      workflowAuthzMockFns.mockAuthorizeWorkflowByWorkspacePermission.mockResolvedValueOnce({
        allowed: true,
        workflow: {
          id: 'workflow-123',
          userId: 'user-123',
          workspaceId: 'workspace-456',
          name: 'Fixture',
        },
        workspacePermission: 'admin',
      })
      queueTableRows(schemaMock.workflow, [{ draftRevision: 8 }])
      dbChainMockFns.returning.mockResolvedValueOnce([{ draftRevision: 9 }])
      const variables = { sample: { id: 'sample', name: 'sample', type: 'string', value: 'human' } }
      const response = await POST(
        new NextRequest('http://localhost:3000/api/workflows/workflow-123/variables', {
          method: 'POST',
          body: JSON.stringify({ variables }),
        }),
        { params: Promise.resolve({ id: 'workflow-123' }) }
      )
      expect(response.status).toBe(200)
      expect(dbChainMockFns.for).toHaveBeenCalledWith('update')
      expect(dbChainMockFns.set).toHaveBeenCalledWith(expect.objectContaining({ variables }))
      expect(dbChainMockFns.set).toHaveBeenCalledWith({ draftRevision: 9 })
    })

    it('should deny access for users without permissions', async () => {
      const mockWorkflow = {
        id: 'workflow-123',
        userId: 'other-user',
        workspaceId: 'workspace-456',
        variables: {},
      }

      hybridAuthMockFns.mockCheckSessionOrInternalAuth.mockResolvedValueOnce({
        success: true,
        userId: 'user-123',
        authType: 'session',
      })
      workflowAuthzMockFns.mockAuthorizeWorkflowByWorkspacePermission.mockResolvedValueOnce({
        allowed: false,
        status: 403,
        message: 'Unauthorized: Access denied to write this workflow',
        workflow: mockWorkflow,
        workspacePermission: null,
      })

      const variables = {
        'var-1': {
          id: 'var-1',
          workflowId: 'workflow-123',
          name: 'test',
          type: 'string',
          value: 'hello',
        },
      }

      const req = new NextRequest('http://localhost:3000/api/workflows/workflow-123/variables', {
        method: 'POST',
        body: JSON.stringify({ variables }),
      })
      const params = Promise.resolve({ id: 'workflow-123' })

      const response = await POST(req, { params })

      expect(response.status).toBe(403)
      const data = await response.json()
      expect(data.error).toBe('Unauthorized: Access denied to write this workflow')
    })
  })
})
