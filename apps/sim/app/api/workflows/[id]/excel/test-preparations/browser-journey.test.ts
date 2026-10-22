// Copyright (c) 2026 Memlia. All rights reserved.
/**
 * Contract between the inactive-test routes and the durable browser journey
 * (scripts/ci/linux-chat-browser.mjs --inactive-test). The journey's page writes are
 * served by the real observe/prepare/run routes, presenters and strict contracts;
 * session, SQL snapshots and the execution service are doubled. A change of a
 * route's native form must fail here before a Linux VM pass.
 */
import { authMock, authMockFns } from '@sim/testing/mocks/auth.mock'
import { rateLimiterMock, rateLimiterMockFns } from '@sim/testing/mocks/rate-limiter.mock'
import {
  workflowContextMock,
  workflowContextMockFns,
} from '@sim/testing/mocks/workflow-context.mock'
import { workspaceAuthzMock, workspaceAuthzMockFns } from '@sim/testing/mocks/workspace-authz.mock'
import { NextRequest } from 'next/server'
import { beforeEach, expect, it, vi } from 'vitest'
import { durableJourney } from '../../../../../../../../scripts/ci/linux-chat-browser.mjs'

const io = vi.hoisted(() => ({
  read: vi.fn(),
  prepare: vi.fn(),
  verify: vi.fn(),
  execute: vi.fn(),
  policy: vi.fn(),
}))
vi.mock('@/lib/auth', () => authMock)
vi.mock('@/lib/core/rate-limiter', () => rateLimiterMock)
vi.mock('@sim/platform-authz/workspace', () => workspaceAuthzMock)
vi.mock('@/lib/workflows/application/context', () => workflowContextMock)
vi.mock('@/lib/permission-groups/config-scope.server', () => ({
  resolvePermissionGroupConfig: io.policy,
}))
vi.mock('@/lib/workflows/persistence/excel-test-snapshots', () => ({
  readExcelTestPreparationObservation: io.read,
  prepareExcelTestSnapshot: io.prepare,
  verifyExcelTestSnapshot: io.verify,
}))
vi.mock('@/lib/workflows/executor/execute-service', () => ({ executeWorkflowService: io.execute }))
vi.mock('@/lib/core/config/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/core/config/env')>()),
  env: { MEMLIA_DURABLE_WORKFLOWS_ENABLED: '1' },
}))

import { GET, POST } from './route'
import { POST as RUN } from './run/route'

const digest = `sha256:${'a'.repeat(64)}`
const prepared = {
  status: 'prepared_for_test',
  workflowId: 'owned-flow',
  deploymentVersionId: 'inactive-version',
  version: 2,
  snapshotDigest: digest,
  executionAvailable: false,
  activationAvailable: false,
}
type PageWrite = { path: string; method?: string; headers?: Record<string, string>; body?: string }

/** Serves the journey's same-origin writes with the native route handlers. */
async function nativeWrite(request: PageWrite) {
  const url = new URL(request.path, 'https://localhost')
  const native = new NextRequest(url, {
    method: request.method ?? 'POST',
    headers: { 'sec-fetch-site': 'same-origin', ...(request.headers ?? {}) },
    ...(request.body === undefined ? {} : { body: request.body }),
  })
  const context = { params: Promise.resolve({ id: 'owned-flow' }) }
  const path = '/api/workflows/owned-flow/excel/test-preparations'
  const handler =
    url.pathname === `${path}/run`
      ? RUN
      : url.pathname === path
        ? native.method === 'GET'
          ? GET
          : POST
        : undefined
  if (!handler) throw new Error(`unexpected_journey_write ${url.pathname}`)
  const response = await handler(native, context)
  return { status: response.status, raw: await response.text(), overflow: false }
}

function page(writes: PageWrite[]) {
  const locator = {
    fill: async () => {},
    click: async () => {},
    waitFor: async () => {},
    elementHandle: async () => ({}),
  }
  return {
    setDefaultTimeout() {},
    goto: async () => {},
    locator: () => locator,
    getByRole: () => locator,
    waitForFunction: async () => {},
    waitForURL: async () => {},
    waitForResponse: async () => ({ status: () => 200 }),
    evaluate: async (_fn: unknown, request: string | PageWrite) => {
      if (typeof request === 'string') return { data: { user: { id: 'owned-user' } } }
      writes.push(request)
      return nativeWrite(request)
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  authMockFns.mockGetSession.mockResolvedValue({
    user: { id: 'owned-user' },
    session: { id: 'owned-session' },
  })
  rateLimiterMockFns.mockEnforceUserRateLimit.mockResolvedValue(null)
  workspaceAuthzMockFns.mockResolveEffectiveWorkspacePermission.mockResolvedValue('write')
  workflowContextMockFns.mockResolveActiveWorkflowApplicationContext.mockResolvedValue({
    workflowId: 'owned-flow',
    workflow: { id: 'owned-flow', workspaceId: 'owned-space' },
    workspaceId: 'owned-space',
    workspaceOrganizationId: null,
    allowPersonalApiKeys: true,
    billedAccountUserId: 'owned-user',
  })
  io.policy.mockResolvedValue(null)
  io.read.mockResolvedValue({
    expectedRevision: 7,
    expectedStateDigest: digest,
    blockTypes: ['memlia_excel'],
  })
  io.prepare.mockResolvedValue(prepared)
  io.verify.mockResolvedValue(prepared)
  io.execute.mockImplementation(async (input: { executionId: string }) => ({
    ok: true,
    queued: true,
    executionId: input.executionId,
    jobId: `workflow-execution:${input.executionId}`,
  }))
})

it('observes, prepares and queues through the native routes, recording the prepared version', async () => {
  const writes: PageWrite[] = []
  const captured: string[] = []
  const observed: Record<string, unknown> = {}
  await durableJourney(
    page(writes),
    {
      origin: 'https://localhost',
      userId: 'owned-user',
      email: 'fictitious@example.invalid',
      password: 'fictitious',
    },
    { workflowId: 'owned-flow', workspaceId: 'owned-space' },
    observed,
    (phase: string) => {
      captured.push(phase)
    },
    true
  )
  expect(captured).toEqual(['test-observe', 'test-identities', 'test-prepare', 'test-enqueue'])
  expect(
    writes.map((write) => [write.method ?? 'POST', new URL(write.path, 'https://x').pathname])
  ).toEqual([
    ['GET', '/api/workflows/owned-flow/excel/test-preparations'],
    ['POST', '/api/workflows/owned-flow/excel/test-preparations'],
    ['POST', '/api/workflows/owned-flow/excel/test-preparations/run'],
  ])
  expect(observed).toMatchObject({
    authenticated: true,
    preparedForTest: true,
    queued: true,
    deploymentVersionId: 'inactive-version',
    snapshotDigest: digest,
  })
  expect(observed.executionId).toBe(io.execute.mock.calls[0][0].executionId)
  expect(observed.deployed).toBeUndefined()
})
