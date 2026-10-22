// Copyright (c) 2026 Memlia. All rights reserved.
// Native authorization funnel + bounded stream reader; native resource/storage ports doubled.
import { createSessionPrincipal } from '@sim/testing/factories/principal.factory'
import {
  workflowContextMock,
  workflowContextMockFns,
} from '@sim/testing/mocks/workflow-context.mock'
import { workspaceAuthzMock, workspaceAuthzMockFns } from '@sim/testing/mocks/workspace-authz.mock'
import { beforeEach, expect, it, vi } from 'vitest'

const b = vi.hoisted(() => ({ read: vi.fn(), download: vi.fn(), metadata: vi.fn() }))
vi.mock('@sim/platform-authz/workspace', () => workspaceAuthzMock)
vi.mock('@/lib/workflows/application/context', () => workflowContextMock)
vi.mock('./read-excel-test-results', () => ({ readExcelTestResults: { execute: b.read } }))
vi.mock('./download-workflow-run-file', () => ({
  downloadWorkflowRunFileStream: { execute: b.download },
}))
vi.mock('@/lib/uploads/server/metadata', () => ({ getFileMetadataByKey: b.metadata }))

import { downloadExcelTestResult } from './download-excel-test-result'

const digest = `sha256:${'a'.repeat(64)}`
const principal = () => createSessionPrincipal({ userId: 'subject', sessionId: 'session' })
const type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const expected = {
  resultFileId: 'file_result',
  fileName: 'result.xlsx',
  size: 4,
  contentType: type,
  resultContentVersion: 1000,
}
const input = () => ({
  workflowId: 'workflow',
  body: {
    workspaceId: 'space',
    executionId: 'test-run',
    prepared: {
      status: 'prepared_for_test' as const,
      workflowId: 'workflow',
      deploymentVersionId: 'inactive-version',
      version: 2,
      snapshotDigest: digest,
      executionAvailable: false as const,
      activationAvailable: false as const,
    },
    preparation: { expectedRevision: 7, expectedStateDigest: digest, operationId: 'owned' },
    expected: { ...expected },
  },
})
const key = 'execution/space/workflow/test-run/private/result.xlsx'
const metadata = () => ({
  id: expected.resultFileId,
  workspaceId: 'space',
  userId: 'subject',
  projectId: null,
  organizationId: null,
  context: 'execution',
  key,
  originalName: expected.fileName,
  sizeBytes: expected.size,
  contentType: type,
  contentUpdatedAt: new Date(expected.resultContentVersion),
  deletedAt: null,
})
const cancel = vi.fn()
function response(bytes = new Uint8Array([80, 75, 3, 4])) {
  return {
    file: {
      id: expected.resultFileId,
      name: expected.fileName,
      size: expected.size,
      type,
      key,
      context: 'execution',
    },
    stream: new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes)
        c.close()
      },
      cancel,
    }),
    contentType: type,
    contentLength: expected.size,
  }
}
beforeEach(() => {
  vi.clearAllMocks()
  for (const port of Object.values(b)) port.mockReset()
  workflowContextMockFns.mockResolveActiveWorkflowApplicationContext.mockResolvedValue({
    workflowId: 'workflow',
    workflow: { id: 'workflow', workspaceId: 'space' },
    workspaceId: 'space',
    workspaceOrganizationId: null,
    allowPersonalApiKeys: true,
    billedAccountUserId: 'billing',
  })
  workspaceAuthzMockFns.mockResolveEffectiveWorkspacePermission.mockResolvedValue('write')
  b.read.mockResolvedValue({
    status: 'completed',
    workflowId: 'workflow',
    executionId: 'test-run',
    deploymentVersionId: 'inactive-version',
    snapshotDigest: digest,
    items: [{ ...expected }],
    truncated: false,
  })
  b.download.mockImplementation(async () => response())
  b.metadata.mockResolvedValue(metadata())
})
it('reads exact bytes through the native download execute then rechecks the same item and scope before delivery', async () => {
  const result = await downloadExcelTestResult.execute({ principal: principal(), input: input() })
  expect([...result.bytes]).toEqual([80, 75, 3, 4])
  expect(result.file).toEqual(expected)
  expect(b.download).toHaveBeenCalledExactlyOnceWith({
    principal: principal(),
    input: { workflowId: 'workflow', runId: 'test-run', fileId: expected.resultFileId },
  })
  expect(b.read).toHaveBeenCalledTimes(2)
  const { expected: _expected, ...body } = input().body
  expect(b.read).toHaveBeenLastCalledWith({
    principal: principal(),
    input: { workflowId: 'workflow', body },
  })
  expect(b.metadata).toHaveBeenCalledExactlyOnceWith(key, 'execution')
})
it.each(['item', 'version', 'execution', 'digest', 'contentVersion'])(
  'refuses stale or mismatched result %s before opening the stream',
  async (kind) => {
    const r = await b.read.getMockImplementation()!()
    if (kind === 'item') r.items = []
    if (kind === 'version') r.deploymentVersionId = 'foreign'
    if (kind === 'execution') r.executionId = 'foreign'
    if (kind === 'digest') r.snapshotDigest = `sha256:${'b'.repeat(64)}`
    if (kind === 'contentVersion') r.items[0].resultContentVersion++
    b.read.mockResolvedValueOnce(r)
    await expect(
      downloadExcelTestResult.execute({ principal: principal(), input: input() })
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(b.download).not.toHaveBeenCalled()
  }
)
it.each(['key', 'type', 'size', 'metadataOwner', 'metadataVersion'])(
  'cancels the opened stream when native file metadata mismatches %s',
  async (kind) => {
    const r = response()
    r.stream = new ReadableStream<Uint8Array>({ cancel })
    if (kind === 'key') r.file.key = 'execution/space/workflow/foreign/secret.xlsx'
    if (kind === 'type') r.contentType = 'text/html'
    if (kind === 'size') r.contentLength++
    if (kind === 'metadataOwner')
      b.metadata.mockResolvedValueOnce({ ...metadata(), userId: 'foreign' })
    if (kind === 'metadataVersion')
      b.metadata.mockResolvedValueOnce({ ...metadata(), contentUpdatedAt: new Date(2000) })
    b.download.mockResolvedValueOnce(r)
    await expect(
      downloadExcelTestResult.execute({ principal: principal(), input: input() })
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(cancel).toHaveBeenCalled()
  }
)
it('bounds actual received bytes to announced size and cancels an oversized stream', async () => {
  b.download.mockResolvedValueOnce({
    ...response(),
    stream: new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(5))
      },
      cancel,
    }),
  })
  await expect(
    downloadExcelTestResult.execute({ principal: principal(), input: input() })
  ).rejects.toThrow()
  expect(cancel).toHaveBeenCalled()
  expect(b.read).toHaveBeenCalledOnce()
})
it('aborts and cancels a blocked native stream without retry or delivery', async () => {
  const controller = new AbortController()
  b.download.mockResolvedValueOnce({
    ...response(),
    stream: new ReadableStream<Uint8Array>(
      {
        pull() {
          controller.abort()
        },
        cancel,
      },
      { highWaterMark: 0 }
    ),
  })
  await expect(
    downloadExcelTestResult.execute({
      principal: principal(),
      input: input(),
      request: { headers: new Headers(), signal: controller.signal },
    })
  ).rejects.toThrow()
  expect(cancel).toHaveBeenCalled()
  expect(b.download).toHaveBeenCalledOnce()
})
it('refuses revoked authorization or changed exact item after reading and never delivers those bytes', async () => {
  b.read
    .mockResolvedValueOnce(await b.read.getMockImplementation()!())
    .mockRejectedValueOnce({ code: 'forbidden' })
  await expect(
    downloadExcelTestResult.execute({ principal: principal(), input: input() })
  ).rejects.toMatchObject({ code: 'forbidden' })
  const value = await b.read.getMockImplementation()!()
  b.read
    .mockResolvedValueOnce(value)
    .mockResolvedValueOnce({ ...value, items: [{ ...expected, resultContentVersion: 2000 }] })
  await expect(
    downloadExcelTestResult.execute({ principal: principal(), input: input() })
  ).rejects.toMatchObject({ code: 'conflict' })
})

it('composes the real binary POST/session parser and returns private XLSX bytes without putting proof in a URL', async () => {
  const { authMockFns } = await import('@sim/testing/mocks/auth.mock')
  const { NextRequest } = await import('next/server')
  const { POST } = await import(
    '@/app/api/workflows/[id]/excel/test-preparations/results/download/route'
  )
  authMockFns.mockGetSession.mockResolvedValueOnce({
    user: { id: 'subject' },
    session: { id: 'session' },
  })
  const response = await POST(
    new NextRequest(
      'http://localhost/api/workflows/workflow/excel/test-preparations/results/download',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
        body: JSON.stringify(input().body),
      }
    ),
    { params: Promise.resolve({ id: 'workflow' }) }
  )
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  expect(response.headers.get('content-type')).toBe(type)
  expect(response.headers.get('content-length')).toBe('4')
  expect(response.headers.get('content-disposition')).toContain('attachment;')
  expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([80, 75, 3, 4])
})
it('denies unauthenticated, cross-site and malformed binary reads before any run or storage access', async () => {
  const { authMockFns } = await import('@sim/testing/mocks/auth.mock')
  const { NextRequest } = await import('next/server')
  const { POST } = await import(
    '@/app/api/workflows/[id]/excel/test-preparations/results/download/route'
  )
  const call = (body: unknown, crossSite = false) =>
    POST(
      new NextRequest(
        'http://localhost/api/workflows/workflow/excel/test-preparations/results/download',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'sec-fetch-site': crossSite ? 'cross-site' : 'same-origin',
          },
          body: JSON.stringify(body),
        }
      ),
      { params: Promise.resolve({ id: 'workflow' }) }
    )
  authMockFns.mockGetSession.mockResolvedValueOnce(null)
  expect((await call(input().body)).status).toBe(401)
  expect((await call(input().body, true)).status).toBe(403)
  authMockFns.mockGetSession.mockResolvedValueOnce({
    user: { id: 'subject' },
    session: { id: 'session' },
  })
  expect((await call({ ...input().body, key: 'untrusted' })).status).toBe(400)
  expect(b.read).not.toHaveBeenCalled()
  expect(b.download).not.toHaveBeenCalled()
  expect(b.metadata).not.toHaveBeenCalled()
})
