// Modified by Memlia: qualify one-shot session-bound proposal decisions.
import { copilotHttpMock, copilotHttpMockFns } from '@sim/testing'
import { setEnvFlags } from '@sim/testing/mocks/env-flags.mock'
import {
  mothershipAsyncRunsMock,
  mothershipAsyncRunsMockFns,
} from '@sim/testing/mocks/mothership-async-runs.mock'
import {
  permissionGroupsResolveMock,
  permissionGroupsResolveMockFns,
} from '@sim/testing/mocks/permission-groups-resolve.mock'
import { createMockRequest } from '@sim/testing/mocks/request.mock'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  publishToolPermissionDecision,
  addAutoAllowedTool,
  addChatAutoAllowedTool,
  recordProposal,
  reviewProposal,
} = vi.hoisted(() => ({
  publishToolPermissionDecision: vi.fn(),
  recordProposal: vi.fn(),
  reviewProposal: vi.fn(),
  addAutoAllowedTool: vi.fn(),
  addChatAutoAllowedTool: vi.fn(),
}))

// This route suite doubles the server proposal adapter; its native-engine composition
// is qualified separately in workflow-preview-tools.test.ts.
vi.mock('@/lib/memlia/chat/workflow-proposals.server', () => ({
  WORKFLOW_PROPOSAL_TOOL: 'memlia_apply_workflow_proposal',
  recordWorkflowProposalDecision: recordProposal,
  readWorkflowProposalReview: reviewProposal,
}))

vi.mock('@/lib/mothership/request/http', () => copilotHttpMock)

vi.mock('@/lib/mothership/async-runs/repository', () => mothershipAsyncRunsMock)

vi.mock('@/lib/mothership/persistence/tool-permission', () => ({
  publishToolPermissionDecision,
  TOOL_PERMISSION_DECISION: {
    allow: 'allow',
    allow_chat: 'allow_chat',
    always_allow: 'always_allow',
    skip: 'skip',
  },
}))

vi.mock('@/lib/mothership/persistence/tool-permission/auto-allow', () => ({
  addAutoAllowedTool,
  addChatAutoAllowedTool,
}))

vi.mock('@/lib/permission-groups/resolve.server', () => permissionGroupsResolveMock)

import { GET, POST } from './route'

const getAsyncToolCall = mothershipAsyncRunsMockFns.mockGetAsyncToolCall
const getRunSegment = mothershipAsyncRunsMockFns.mockGetRunSegment
const recordToolPermissionDecision = mothershipAsyncRunsMockFns.mockRecordToolPermissionDecision
const getUserPermissionConfig = permissionGroupsResolveMockFns.mockGetUserPermissionConfig
setEnvFlags({ isCopilotToolPermissionsEnabled: true })

describe('Copilot tool permission API', () => {
  beforeEach(() => {
    recordProposal
      .mockReset()
      .mockResolvedValue({ toolCallId: 'tool-1', decision: 'allow', applied: true })
    copilotHttpMockFns.mockAuthenticateCopilotRequestSessionOnly.mockResolvedValue({
      userId: 'user-1',
      isAuthenticated: true,
    })
    getAsyncToolCall.mockResolvedValue({
      toolCallId: 'tool-1',
      runId: 'run-1',
      toolName: 'run_workflow',
      status: 'pending',
      permissionDecision: null,
    })
    getRunSegment.mockResolvedValue({
      id: 'run-1',
      userId: 'user-1',
      chatId: 'chat-1',
      workspaceId: 'workspace-1',
    })
    getUserPermissionConfig.mockResolvedValue(null)
    recordToolPermissionDecision.mockResolvedValue({
      toolCallId: 'tool-1',
      runId: 'run-1',
      toolName: 'run_workflow',
      status: 'pending',
      permissionDecision: 'allow',
      permissionDecidedAt: new Date('2026-08-01T00:00:00.000Z'),
    })
    addAutoAllowedTool.mockResolvedValue(undefined)
    addChatAutoAllowedTool.mockResolvedValue(undefined)
  })

  function createRequest(
    decision: 'allow' | 'allow_chat' | 'always_allow' | 'skip',
    expectedDigest?: string
  ) {
    return createMockRequest({
      method: 'POST',
      url: 'http://localhost:3000/api/copilot/tool-permission',
      body: { decisions: [{ toolCallId: 'tool-1', decision, expectedDigest }] },
    })
  }

  function proposalSession() {
    getAsyncToolCall.mockResolvedValue({
      toolCallId: 'tool-1',
      runId: 'run-1',
      toolName: 'memlia_apply_workflow_proposal',
      status: 'pending',
      permissionDecision: null,
    })
    copilotHttpMockFns.mockAuthenticateCopilotRequestSessionOnly.mockResolvedValue({
      userId: 'user-1',
      isAuthenticated: true,
      principal: { kind: 'session', userId: 'user-1', sessionId: 'session-1' },
    })
  }
  it('passes only the actual session principal to the one-shot server decision', async () => {
    proposalSession()
    const response = await POST(createRequest('allow', `sha256:${'a'.repeat(64)}`))
    expect(response.status).toBe(200)
    expect(recordProposal).toHaveBeenCalledExactlyOnceWith({
      toolCallId: 'tool-1',
      principal: { kind: 'session', userId: 'user-1', sessionId: 'session-1' },
      decision: 'allow',
      single: true,
      expectedDigest: `sha256:${'a'.repeat(64)}`,
    })
    expect(recordToolPermissionDecision).not.toHaveBeenCalled()
    expect(addAutoAllowedTool).not.toHaveBeenCalled()
    expect(addChatAutoAllowedTool).not.toHaveBeenCalled()
    expect(publishToolPermissionDecision).toHaveBeenCalledOnce()
  })
  it('does not republish a losing first-decision race', async () => {
    proposalSession()
    recordProposal.mockResolvedValue({ toolCallId: 'tool-1', decision: 'skip', applied: false })
    const response = await POST(createRequest('allow', `sha256:${'a'.repeat(64)}`))
    expect(await response.json()).toMatchObject({ results: [{ decision: 'skip', applied: false }] })
    expect(publishToolPermissionDecision).not.toHaveBeenCalled()
  })
  it('refuses bulk proposal decisions without invoking their authority adapter', async () => {
    proposalSession()
    const request = createMockRequest({
      method: 'POST',
      url: 'http://localhost:3000/api/copilot/tool-permission',
      body: {
        decisions: [
          { toolCallId: 'tool-1', decision: 'allow' },
          { toolCallId: 'tool-2', decision: 'allow' },
        ],
      },
    })
    expect((await POST(request)).status).toBe(404)
    expect(recordProposal).not.toHaveBeenCalled()
    expect(publishToolPermissionDecision).not.toHaveBeenCalled()
  })
  it('refuses cross-site requests before any persisted lookup', async () => {
    proposalSession()
    const request = createRequest('allow')
    request.headers.set('sec-fetch-site', 'cross-site')
    expect((await POST(request)).status).toBe(403)
    expect(getAsyncToolCall).not.toHaveBeenCalled()
    expect(recordProposal).not.toHaveBeenCalled()
  })
  it('does not substitute a forged header for a missing session principal', async () => {
    proposalSession()
    copilotHttpMockFns.mockAuthenticateCopilotRequestSessionOnly.mockResolvedValue({
      userId: 'user-1',
      isAuthenticated: true,
    })
    const request = createRequest('allow')
    request.headers.set('x-user-id', 'user-1')
    expect((await POST(request)).status).toBe(404)
    expect(recordProposal).not.toHaveBeenCalled()
  })
  it('conceals adapter refusal and its private cause', async () => {
    proposalSession()
    recordProposal.mockRejectedValue(new Error('PRIVATE_AUTHORIZATION'))
    const response = await POST(createRequest('allow', `sha256:${'a'.repeat(64)}`))
    expect(response.status).toBe(404)
    expect(JSON.stringify(await response.json())).not.toContain('PRIVATE_AUTHORIZATION')
    expect(publishToolPermissionDecision).not.toHaveBeenCalled()
  })

  it.each(['allow_chat', 'always_allow'] as const)(
    'refuses %s for a workflow proposal before recording any decision',
    async (decision) => {
      getAsyncToolCall.mockResolvedValue({
        toolCallId: 'tool-1',
        runId: 'run-1',
        toolName: 'memlia_apply_workflow_proposal',
        status: 'pending',
        permissionDecision: null,
      })
      const response = await POST(createRequest(decision))
      expect(response.status).toBe(404)
      expect(recordToolPermissionDecision).not.toHaveBeenCalled()
      expect(publishToolPermissionDecision).not.toHaveBeenCalled()
    }
  )

  it.each(['allow', 'allow_chat', 'always_allow', 'skip'] as const)(
    'records the generic %s decision without changing execution state',
    async (decision) => {
      recordToolPermissionDecision.mockResolvedValueOnce({
        toolCallId: 'tool-1',
        runId: 'run-1',
        toolName: 'run_workflow',
        status: 'pending',
        permissionDecision: decision,
        permissionDecidedAt: new Date('2026-08-01T00:00:00.000Z'),
      })

      const response = await POST(createRequest(decision))

      expect(response.status).toBe(200)
      expect(recordToolPermissionDecision).toHaveBeenCalledWith('tool-1', decision)
      expect(publishToolPermissionDecision).toHaveBeenCalledWith(
        expect.objectContaining({ toolCallId: 'tool-1', decision })
      )
    }
  )

  describe('when the permission group withholds tool auto-approval', () => {
    beforeEach(() => {
      getUserPermissionConfig.mockResolvedValue({ disableToolAutoApproval: true })
    })

    it.each(['always_allow', 'allow_chat'] as const)(
      'answers the %s prompt without remembering it',
      async (decision) => {
        recordToolPermissionDecision.mockResolvedValueOnce({
          toolCallId: 'tool-1',
          runId: 'run-1',
          toolName: 'run_workflow',
          status: 'pending',
          permissionDecision: decision,
          permissionDecidedAt: new Date('2026-08-01T00:00:00.000Z'),
        })

        const response = await POST(createRequest(decision))

        // The waiting orchestrator still gets its answer; only the durable
        // preference is refused, so the next call prompts again.
        expect(response.status).toBe(200)
        expect(publishToolPermissionDecision).toHaveBeenCalledWith(
          expect.objectContaining({ toolCallId: 'tool-1', decision })
        )
        expect(addAutoAllowedTool).not.toHaveBeenCalled()
        expect(addChatAutoAllowedTool).not.toHaveBeenCalled()
      }
    )

    /**
     * The row is claimed before this lookup runs, so a rejection that escaped
     * would answer 500 with the decision unpublished — and the retry lands on
     * the already-answered branch, which does not republish, leaving the turn
     * to wait out its permission timeout.
     */
    it('answers the prompt when the lookup itself fails, remembering nothing', async () => {
      getUserPermissionConfig.mockRejectedValue(new Error('permission group lookup failed'))
      recordToolPermissionDecision.mockResolvedValueOnce({
        toolCallId: 'tool-1',
        runId: 'run-1',
        toolName: 'run_workflow',
        status: 'pending',
        permissionDecision: 'always_allow',
        permissionDecidedAt: new Date('2026-08-01T00:00:00.000Z'),
      })

      const response = await POST(createRequest('always_allow'))

      expect(response.status).toBe(200)
      expect(publishToolPermissionDecision).toHaveBeenCalledWith(
        expect.objectContaining({ toolCallId: 'tool-1', decision: 'always_allow' })
      )
      expect(addAutoAllowedTool).not.toHaveBeenCalled()
    })
  })
})

describe('owner proposal review GET', () => {
  const digest = `sha256:${'a'.repeat(64)}`
  const review = {
    toolCallId: 'tool-1',
    workflowId: 'workflow-a',
    workspaceId: 'workspace-a',
    expectedRevision: 0,
    issuedAt: '2026-10-19T12:00:00.000Z',
    expiresAt: '2026-10-19T12:10:00.000Z',
    digest,
    body: '{"atomic":true}',
  }
  beforeEach(() => {
    setEnvFlags({ isCopilotToolPermissionsEnabled: true })
    copilotHttpMockFns.mockAuthenticateCopilotRequestSessionOnly.mockResolvedValue({
      userId: 'user-1',
      isAuthenticated: true,
      principal: { kind: 'session', userId: 'user-1', sessionId: 'session-1' },
    })
    reviewProposal.mockReset().mockResolvedValue(review)
  })
  const request = () =>
    createMockRequest({
      method: 'GET',
      url: 'http://localhost:3000/api/copilot/tool-permission?toolCallId=tool-1',
    })
  it('returns exact validated review only, with no-store and no decision writes', async () => {
    const response = await GET(request())
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(await response.json()).toEqual(review)
    expect(recordToolPermissionDecision).not.toHaveBeenCalled()
  })
  it.each([
    undefined,
    { kind: 'apiKey', userId: 'user-1', apiKeyId: 'key' },
    { kind: 'session', userId: 'other', sessionId: 'session-1' },
  ])('refuses missing or nonmatching actual session %j', async (principal) => {
    copilotHttpMockFns.mockAuthenticateCopilotRequestSessionOnly.mockResolvedValue({
      userId: 'user-1',
      isAuthenticated: true,
      principal,
    })
    const response = await GET(request())
    expect(response.status).toBe(401)
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(reviewProposal).not.toHaveBeenCalled()
  })
  it('conceals expired, foreign and revoked permission errors without their private cause', async () => {
    reviewProposal.mockRejectedValue(new Error('PRIVATE_BODY_OR_SESSION'))
    const response = await GET(request())
    expect(response.status).toBe(404)
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(JSON.stringify(await response.json())).not.toContain('PRIVATE_BODY_OR_SESSION')
  })
  it('rejects cross-site reads before loading the body', async () => {
    const req = request()
    req.headers.set('sec-fetch-site', 'cross-site')
    expect((await GET(req)).status).toBe(403)
    expect(reviewProposal).not.toHaveBeenCalled()
  })
})

it('refuses a reserved decision with no displayed digest before the adapter or UPDATE', async () => {
  copilotHttpMockFns.mockAuthenticateCopilotRequestSessionOnly.mockResolvedValue({
    isAuthenticated: true,
    userId: 'user-1',
    principal: { kind: 'session', userId: 'user-1', sessionId: 'session-1' },
  })
  getAsyncToolCall.mockResolvedValue({ toolName: 'memlia_apply_workflow_proposal', runId: 'run-1' })
  recordProposal.mockClear()
  recordToolPermissionDecision.mockClear()
  const response = await POST(
    createMockRequest({
      method: 'POST',
      url: 'http://localhost:3000/api/copilot/tool-permission',
      body: { decisions: [{ toolCallId: 'tool-1', decision: 'allow' }] },
    })
  )
  expect(response.status).toBe(404)
  expect(recordProposal).not.toHaveBeenCalled()
  expect(recordToolPermissionDecision).not.toHaveBeenCalled()
})

it('does not let a mismatched native principal decide for another authenticated user', async () => {
  copilotHttpMockFns.mockAuthenticateCopilotRequestSessionOnly.mockResolvedValue({
    isAuthenticated: true,
    userId: 'other-user',
    principal: { kind: 'session', userId: 'user-1', sessionId: 'session-1' },
  })
  getAsyncToolCall.mockResolvedValue({ toolName: 'memlia_apply_workflow_proposal', runId: 'run-1' })
  recordProposal
    .mockReset()
    .mockResolvedValue({ toolCallId: 'tool-1', decision: 'allow', applied: true })
  const response = await POST(
    createMockRequest({
      method: 'POST',
      url: 'http://localhost:3000/api/copilot/tool-permission',
      body: {
        decisions: [
          { toolCallId: 'tool-1', decision: 'allow', expectedDigest: `sha256:${'a'.repeat(64)}` },
        ],
      },
    })
  )
  expect(response.status).toBe(404)
  expect(recordProposal).not.toHaveBeenCalled()
})
