// Modified by Memlia: qualify persistent local engine boundaries.
import { copilotChats, copilotRuns, member, settings, user, workspace } from '@sim/db/schema'
import {
  dbChainMockFns,
  queueTableRows,
  resetDbChainMock,
  resetEnvFlagsMock,
  setEnvFlags,
} from '@sim/testing'
import { createSessionPrincipal } from '@sim/testing/factories/principal.factory'
import { authBanMock, authBanMockFns } from '@sim/testing/mocks/auth-ban.mock'
import {
  knowledgeAvailabilityMock,
  knowledgeAvailabilityMockFns,
} from '@sim/testing/mocks/knowledge-availability.mock'
import {
  mothershipChatMessagesMock,
  mothershipChatMessagesMockFns,
} from '@sim/testing/mocks/mothership-chat-messages.mock'
import {
  mothershipChatStatusMock,
  mothershipChatStatusMockFns,
} from '@sim/testing/mocks/mothership-chat-status.mock'
import {
  permissionGroupsResolveMock,
  permissionGroupsResolveMockFns,
} from '@sim/testing/mocks/permission-groups-resolve.mock'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { admitChatTurn, turnDesktopDevice } from '@/lib/mothership/chat/application/admit-turn'
import { ChatSendSupersededError } from '@/lib/mothership/chat/application/send-superseded'

const hoisted = vi.hoisted(() => ({
  lease: vi.fn(),
  workspaceAuth: vi.fn(),
  resolveDesktop: vi.fn(),
}))
const mocks = {
  ...hoisted,
  append: mothershipChatMessagesMockFns.mockAppendCopilotChatMessages,
  banned: authBanMockFns.mockGetActivelyBannedUserIds,
  config: permissionGroupsResolveMockFns.mockGetUserPermissionConfigForOrganization,
  searchAvailable: knowledgeAvailabilityMockFns.mockRequireOrganizationSearchAvailable,
}
vi.mock('@/lib/core/application/workspace-authorization', async (original) => ({
  ...(await original<typeof import('@/lib/core/application/workspace-authorization')>()),
  authorizeWorkspaceOperation: hoisted.workspaceAuth,
}))
vi.mock('@/lib/knowledge/access/availability', () => knowledgeAvailabilityMock)
afterAll(resetEnvFlagsMock)
vi.mock('@/lib/mothership/chat/messages-store', () => mothershipChatMessagesMock)
vi.mock('@/lib/mothership/request/session/controller-lease', () => ({
  assertChatStreamLease: hoisted.lease,
}))
vi.mock('@/lib/auth/ban', () => authBanMock)
vi.mock('@/lib/permission-groups/resolve.server', () => permissionGroupsResolveMock)
vi.mock('@/lib/mothership/chat-status', () => mothershipChatStatusMock)
vi.mock('@/lib/desktop/application/executor', () => ({
  resolveTurnDesktopDevice: hoisted.resolveDesktop,
}))

const principal = createSessionPrincipal({ userId: 'actor', sessionId: 'session' })
const chatId = '11111111-1111-4111-8111-111111111111'
const streamId = '22222222-2222-4222-8222-222222222222'
const chat = {
  mode: 'assistant',
  userId: 'actor',
  organizationId: 'org-1',
  workspaceId: null,
  type: 'mothership',
}
function input(mode: 'assistant' | 'agent' | 'plan' = 'assistant') {
  return {
    chatId,
    runId: 'run-1',
    executionId: 'execution-1',
    requestId: 'request-1',
    message: { id: streamId, content: 'Find the policy', requestMode: mode },
    recovery: {
      kind: 'interactive_stream' as const,
      goRoute: '/api/mothership' as const,
      clientToolPickupExpected: false,
      request: {
        userId: 'actor',
        chatId,
        messageId: streamId,
        organizationId: 'org-1',
        mode,
        message: 'Find the policy',
      },
    },
    lease: { key: 'lease', value: 'controller' },
    sendClaim: { normalizedKey: 'claim', claimToken: 'token' },
    notifyWorkspaceStatus: false,
  }
}

describe('organization turn admission through current private-chat authorization', () => {
  beforeEach(() => {
    resetDbChainMock()
    mocks.config.mockResolvedValue(null)
    mocks.banned.mockResolvedValue([])
    mocks.searchAvailable.mockResolvedValue(undefined)
    setEnvFlags({ isBillingEnabled: true })
  })
  it('persists the organization owner and accepted message in the existing admission transaction', async () => {
    queueTableRows(copilotChats, [chat])
    queueTableRows(member, [{ role: 'member' }])
    dbChainMockFns.returning
      .mockResolvedValueOnce([{ model: null }])
      .mockResolvedValueOnce([{ id: 'run-1', organizationId: 'org-1', workspaceId: null }])
      .mockResolvedValueOnce([{ key: 'claim' }])
    const admitted = await admitChatTurn.execute({ principal, input: input() })
    expect(admitted.organizationId).toBe('org-1')
    expect(dbChainMockFns.insert).toHaveBeenCalledWith(copilotRuns)
    expect(dbChainMockFns.values).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        workspaceId: null,
        userId: 'actor',
        streamId,
      })
    )
    expect(mocks.append).toHaveBeenCalledWith(
      chatId,
      [
        expect.objectContaining({
          id: streamId,
          content: 'Find the policy',
          requestMode: 'assistant',
        }),
      ],
      expect.objectContaining({ streamId }),
      expect.anything()
    )
  })
  /**
   * Another attempt with this id re-took the claim after this one's in-progress
   * TTL ran out. That attempt may admit the turn, so this one must not, and the
   * route answers it as a duplicate.
   */
  it('refuses to admit a send whose claim another attempt took', async () => {
    queueTableRows(copilotChats, [chat])
    queueTableRows(member, [{ role: 'member' }])
    dbChainMockFns.returning
      .mockResolvedValueOnce([{ model: null }])
      .mockResolvedValueOnce([{ id: 'run-1', organizationId: 'org-1', workspaceId: null }])
      .mockResolvedValueOnce([])
    await expect(admitChatTurn.execute({ principal, input: input() })).rejects.toBeInstanceOf(
      ChatSendSupersededError
    )
  })
  it("keeps an organization chat's turn with its chat view, never on a desktop", async () => {
    hoisted.resolveDesktop.mockResolvedValue('device-1')
    const offered = '33333333-3333-4333-8333-333333333333'

    await expect(turnDesktopDevice(principal, null, offered)).resolves.toBeNull()
    await expect(turnDesktopDevice(principal, 'ws-1', offered)).resolves.toBe('device-1')
    await expect(turnDesktopDevice(principal, 'ws-1', undefined)).resolves.toBeNull()
  })
  it.each(['agent', 'assistant', 'plan'] as const)(
    'switches the same chat to %s atomically with turn admission',
    async (mode) => {
      setEnvFlags({ isMothershipBenchmarkEnabled: true })
      queueTableRows(user, [{ role: 'admin' }])
      queueTableRows(settings, [{ superUserModeEnabled: true }])
      queueTableRows(copilotChats, [{ ...chat, mode: mode === 'agent' ? 'assistant' : 'agent' }])
      queueTableRows(member, [{ role: 'owner' }])
      if (mode !== 'assistant') queueTableRows(member, [{ role: 'owner' }])
      dbChainMockFns.returning
        .mockResolvedValueOnce([{ model: null }])
        .mockResolvedValueOnce([{ id: 'run-1' }])
        .mockResolvedValueOnce([{ key: 'claim' }])
      await admitChatTurn.execute({ principal, input: input(mode) })
      const update = dbChainMockFns.set.mock.calls[0][0]
      expect(Object.keys(update).sort()).toEqual(['config', 'conversationId', 'updatedAt'])
      expect(update.config.toSQL().sql).toContain("jsonb_build_object('conversationMode'")
      expect(update.config.toSQL().params).toContain(mode)
      expect(mocks.append).toHaveBeenCalledWith(
        chatId,
        [expect.objectContaining({ requestMode: mode })],
        expect.anything(),
        expect.anything()
      )
      expect(dbChainMockFns.values).toHaveBeenCalledWith(
        expect.objectContaining({
          requestContext: expect.objectContaining({
            recovery: expect.objectContaining({
              request: expect.objectContaining({ mode, chatId }),
            }),
          }),
        })
      )
    }
  )
  it.each([
    [undefined, false],
    ['low', true],
  ] as const)(
    'records the send effort %s as the chat choice in the admission write: %s',
    async (effortChoice, recorded) => {
      queueTableRows(copilotChats, [chat])
      queueTableRows(member, [{ role: 'member' }])
      dbChainMockFns.returning
        .mockResolvedValueOnce([{ model: null }])
        .mockResolvedValueOnce([{ id: 'run-1' }])
        .mockResolvedValueOnce([{ key: 'claim' }])
      await admitChatTurn.execute({ principal, input: { ...input(), effortChoice } })
      const config = dbChainMockFns.set.mock.calls[0][0].config.toSQL()
      expect(config.sql.includes("jsonb_build_object('effort'")).toBe(recorded)
      expect(config.params.includes('low')).toBe(recorded)
    }
  )
  it.each(['agent', 'plan'] as const)(
    'denies switching to %s without current workspace-create permission before any mutation',
    async (mode) => {
      queueTableRows(copilotChats, [chat])
      queueTableRows(member, [{ role: 'member' }])
      queueTableRows(member, [{ role: 'member' }])
      await expect(admitChatTurn.execute({ principal, input: input(mode) })).rejects.toThrow(
        'Build requires permission'
      )
      expect(dbChainMockFns.set).not.toHaveBeenCalled()
      expect(mocks.append).not.toHaveBeenCalled()
    }
  )
  it('denies switching to Search after its availability is revoked', async () => {
    queueTableRows(copilotChats, [{ ...chat, mode: 'agent' }])
    queueTableRows(member, [{ role: 'owner' }])
    mocks.searchAvailable.mockRejectedValueOnce(new Error('Search disabled'))
    await expect(admitChatTurn.execute({ principal, input: input() })).rejects.toThrow(
      'Search disabled'
    )
    expect(dbChainMockFns.set).not.toHaveBeenCalled()
  })
  it('does not rewrite mode if the stream lease is lost', async () => {
    queueTableRows(copilotChats, [{ ...chat, mode: 'agent' }])
    queueTableRows(member, [{ role: 'owner' }])
    mocks.lease.mockRejectedValueOnce(new Error('Lease lost'))
    await expect(admitChatTurn.execute({ principal, input: input() })).rejects.toThrow('Lease lost')
    expect(dbChainMockFns.set).not.toHaveBeenCalled()
  })
  it.each([
    { ...chat, userId: 'other' },
    { ...chat, workspaceId: 'workspace' },
    { ...chat, organizationId: null },
    { ...chat, type: 'copilot' },
  ])('rejects invalid private-chat ownership before persistence', async (row) => {
    queueTableRows(copilotChats, [row])
    await expect(admitChatTurn.execute({ principal, input: input() })).rejects.toThrow(
      'Chat not found'
    )
    expect(dbChainMockFns.insert).not.toHaveBeenCalled()
    expect(mocks.append).not.toHaveBeenCalled()
  })
  it('rejects removed membership before admission or message persistence', async () => {
    queueTableRows(copilotChats, [chat])
    await expect(admitChatTurn.execute({ principal, input: input() })).rejects.toThrow(
      'Organization not found'
    )
    expect(dbChainMockFns.insert).not.toHaveBeenCalled()
    expect(mocks.lease).not.toHaveBeenCalled()
  })
  it('rejects a request owner different from its canonical chat', async () => {
    queueTableRows(copilotChats, [chat])
    queueTableRows(member, [{ role: 'member' }])
    const request = input()
    request.recovery.request.organizationId = 'org-2'
    await expect(admitChatTurn.execute({ principal, input: request })).rejects.toThrow(
      'Turn identity'
    )
    expect(dbChainMockFns.insert).not.toHaveBeenCalled()
  })
})

describe('local durable admission (SQL builder double, native use case)', () => {
  const workspaceId = '33333333-3333-4333-8333-333333333333'
  const marker = { kind: 'memlia_local_chat', version: 1, recovery: 'none' }
  const local = {
    kind: 'memlia_local_chat' as const,
    version: 1 as const,
    request: {
      userId: 'actor',
      chatId,
      messageId: streamId,
      workspaceId,
      workflowId: 'workflow',
      message: 'Find the policy',
      mode: 'agent' as const,
    },
  }
  function localInput() {
    const { recovery: _recovery, ...rest } = input('agent')
    return { ...rest, local: { ...local, request: { ...local.request } } }
  }
  beforeEach(() => {
    resetDbChainMock()
    mocks.banned.mockResolvedValue([])
    hoisted.workspaceAuth.mockReset().mockResolvedValue(undefined)
    queueTableRows(copilotChats, [
      {
        userId: 'actor',
        workspaceId,
        organizationId: null,
        workflowId: 'workflow',
        type: 'copilot',
        mode: 'agent',
      },
    ])
    queueTableRows(workspace, [
      {
        id: workspaceId,
        organizationId: null,
        allowPersonalApiKeys: false,
        billedAccountUserId: 'actor',
      },
    ])
    dbChainMockFns.returning
      .mockResolvedValueOnce([{ model: null }])
      .mockResolvedValueOnce([{ id: 'run-1' }])
      .mockResolvedValueOnce([{ key: 'claim' }])
  })
  it('commits the local identity with the message and claim, without worker recovery', async () => {
    await admitChatTurn.execute({ principal, input: localInput() })
    const row = dbChainMockFns.values.mock.calls.find(([value]) => value.id === 'run-1')?.[0]
    expect(row.requestContext).toEqual({
      requestId: 'request-1',
      controllerToken: 'controller',
      localExecution: marker,
    })
    expect(row.workflowId).toBe('workflow')
    expect(mocks.append).toHaveBeenCalledOnce()
    expect(hoisted.workspaceAuth).toHaveBeenCalledOnce()
    expect(hoisted.resolveDesktop).not.toHaveBeenCalled()
  })
  it.each(['userId', 'chatId', 'workspaceId', 'workflowId', 'messageId', 'message'] as const)(
    'rejects conflicting local %s before writing',
    async (key) => {
      await expect(
        admitChatTurn.execute({
          principal,
          input: {
            ...localInput(),
            local: { ...local, request: { ...local.request, [key]: 'foreign' } },
          },
        })
      ).rejects.toThrow()
      expect(mocks.append).not.toHaveBeenCalled()
      expect(dbChainMockFns.insert).not.toHaveBeenCalled()
    }
  )
  it('cannot combine local admission with worker recovery', async () => {
    await expect(
      admitChatTurn.execute({
        principal,
        input: { ...localInput(), recovery: input('agent').recovery },
      })
    ).rejects.toThrow()
    expect(mocks.append).not.toHaveBeenCalled()
  })
  it.each([
    { desktopDeviceId: 'desktop' },
    {
      message: {
        id: streamId,
        content: 'Find the policy',
        requestMode: 'agent' as const,
        contexts: [],
      },
    },
  ])('refuses unsupported local context before any write', async (extra) => {
    await expect(
      admitChatTurn.execute({ principal, input: { ...localInput(), ...extra } })
    ).rejects.toThrow('Local Chat is unavailable.')
    expect(mocks.append).not.toHaveBeenCalled()
    expect(dbChainMockFns.insert).not.toHaveBeenCalled()
  })
  it('owns the accepted local message and claim across the lease await', async () => {
    const candidate = localInput()
    mocks.lease.mockImplementationOnce(async () => {
      candidate.message.content = 'foreign mutation'
      candidate.sendClaim.claimToken = 'foreign-claim'
      candidate.runId = 'foreign-run'
      candidate.local.request.message = 'foreign intention'
    })
    await admitChatTurn.execute({ principal, input: candidate })
    expect(mocks.append).toHaveBeenCalledWith(
      chatId,
      [expect.objectContaining({ content: 'Find the policy' })],
      expect.anything(),
      expect.anything()
    )
    expect(dbChainMockFns.values).toHaveBeenCalledWith(expect.objectContaining({ id: 'run-1' }))
    expect(dbChainMockFns.set.mock.calls.at(-1)?.[0].result.claimToken).toBe('token')
  })
  it('publishes only the committed local stream identity after a mutable caller crosses admission', async () => {
    const candidate = { ...localInput(), notifyWorkspaceStatus: true }
    dbChainMockFns.returning
      .mockReset()
      .mockResolvedValueOnce([{ model: null }])
      .mockResolvedValueOnce([
        { id: 'run-1', streamId, requestContext: { localExecution: marker } },
      ])
      .mockResolvedValueOnce([{ key: 'claim' }])
    mocks.lease.mockImplementationOnce(async () => {
      candidate.message.id = 'foreign-stream'
    })
    await admitChatTurn.execute({ principal, input: candidate })
    expect(mothershipChatStatusMockFns.mockPublishChatStatusChanged).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId, userId: 'actor' }),
      { chatId, type: 'started', streamId }
    )
  })
  it('rejects revoked workspace authorization before persisting the marker', async () => {
    hoisted.workspaceAuth.mockRejectedValue(new Error('revoked'))
    await expect(admitChatTurn.execute({ principal, input: localInput() })).rejects.toThrow(
      'revoked'
    )
    expect(mocks.append).not.toHaveBeenCalled()
    expect(dbChainMockFns.insert).not.toHaveBeenCalled()
  })
})
