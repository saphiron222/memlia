// Copyright (c) 2026 Memlia. All rights reserved.
// Native HTTP factory/client/contracts/auth/funnel; session/SQL/service effects doubled.
import { authMock, authMockFns } from '@sim/testing/mocks/auth.mock'
import { rateLimiterMock, rateLimiterMockFns } from '@sim/testing/mocks/rate-limiter.mock'
import {
  workflowContextMock,
  workflowContextMockFns,
} from '@sim/testing/mocks/workflow-context.mock'
import { workspaceAuthzMock, workspaceAuthzMockFns } from '@sim/testing/mocks/workspace-authz.mock'
import { NextRequest } from 'next/server'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
const io = vi.hoisted(() => ({ read: vi.fn(), verify: vi.fn(), execute: vi.fn(), config: vi.fn() }))
vi.mock('@/lib/auth', () => authMock)
vi.mock('@/lib/core/rate-limiter', () => rateLimiterMock)
vi.mock('@sim/platform-authz/workspace', () => workspaceAuthzMock)
vi.mock('@/lib/workflows/application/context', () => workflowContextMock)
vi.mock('@/lib/permission-groups/config-scope.server', () => ({
  resolvePermissionGroupConfig: io.config,
}))
vi.mock('@/lib/workflows/persistence/excel-test-snapshots', () => ({
  readExcelTestPreparationObservation: io.read,
  verifyExcelTestSnapshot: io.verify,
}))
vi.mock('@/lib/workflows/executor/execute-service', () => ({ executeWorkflowService: io.execute }))
vi.mock('@/lib/core/config/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/core/config/env')>()),
  env: { MEMLIA_DURABLE_WORKFLOWS_ENABLED: '1' },
}))
import { POST } from './route'
import { requestJson } from '@/lib/api/client/request'
import { runExcelTestContract } from '@/lib/api/contracts/excel-test-preparations'
const digest = `sha256:${'a'.repeat(64)}`
const prepared = {
  status: 'prepared_for_test',
  workflowId: 'workflow',
  deploymentVersionId: 'inactive-version',
  version: 2,
  snapshotDigest: digest,
  activationAvailable: false,
  executionAvailable: false,
}
const body = {
  workspaceId: 'space',
  preparation: { expectedRevision: 7, expectedStateDigest: digest, operationId: 'prepared-op' },
  prepared,
  executionId: 'stable-run',
  acknowledgeEffects: true as const,
}
const context = { params: Promise.resolve({ id: 'workflow' }) }
const request = (value: unknown = body, headers: Record<string, string> = {}) =>
  new NextRequest('http://localhost/api/workflows/workflow/excel/test-preparations/run', {
    method: 'POST',
    body: JSON.stringify(value),
    headers: { 'content-type': 'application/json', ...headers },
  })
beforeEach(() => {
  vi.clearAllMocks()
  authMockFns.mockGetSession.mockResolvedValue({
    user: { id: 'subject' },
    session: { id: 'session' },
  })
  rateLimiterMockFns.mockEnforceUserRateLimit.mockResolvedValue(null)
  workspaceAuthzMockFns.mockResolveEffectiveWorkspacePermission.mockResolvedValue('write')
  workflowContextMockFns.mockResolveActiveWorkflowApplicationContext.mockResolvedValue({
    workflowId: 'workflow',
    workflow: { id: 'workflow', workspaceId: 'space' },
    workspaceId: 'space',
    workspaceOrganizationId: null,
    allowPersonalApiKeys: true,
    billedAccountUserId: 'billing',
  })
  io.read.mockResolvedValue({
    expectedRevision: 7,
    expectedStateDigest: digest,
    blockTypes: ['memlia_excel'],
  })
  io.verify.mockResolvedValue(prepared)
  io.config.mockResolvedValue(null)
  io.execute.mockResolvedValue({
    ok: true,
    queued: true,
    executionId: 'stable-run',
    jobId: 'workflow-execution:stable-run',
  })
})
afterEach(() => vi.unstubAllGlobals())
it('session client/route composition returns202 with an exact inactive version and no deployment', async () => {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) =>
    POST(new NextRequest('http://localhost' + url, init), context)
  )
  const result = await requestJson(runExcelTestContract, {
    params: { id: 'workflow' },
    body: {
      ...body,
      prepared: {
        ...prepared,
        status: 'prepared_for_test',
        executionAvailable: false,
        activationAvailable: false,
      },
    },
  })
  expect(result).toEqual({
    status: 'queued',
    executionId: 'stable-run',
    workflowId: 'workflow',
    deploymentVersionId: 'inactive-version',
    snapshotDigest: digest,
  })
  expect(io.execute).toHaveBeenCalledWith(
    expect.objectContaining({
      principal: { kind: 'session', userId: 'subject', sessionId: 'session' },
      useAuthenticatedUserAsActor: true,
      isPublicApiAccess: false,
      deploymentVersionId: 'inactive-version',
      executionId: 'stable-run',
      mode: 'async',
      useDraftState: false,
    })
  )
})
it('cross-site, missing session, oversized body and service controls fail before test admission', async () => {
  const cross = request(body, { 'sec-fetch-site': 'cross-site' })
  expect((await POST(cross, context)).status).toBe(403)
  expect(cross.bodyUsed).toBe(false)
  expect((await POST(request(body, { 'content-length': '20001' }), context)).status).toBe(413)
  expect((await POST(request({ ...body, useDraftState: false }), context)).status).toBe(400)
  authMockFns.mockGetSession.mockResolvedValue(null)
  expect((await POST(request(), context)).status).toBe(401)
  expect(io.verify).not.toHaveBeenCalled()
  expect(io.execute).not.toHaveBeenCalled()
})
