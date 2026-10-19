// Modified by Memlia: qualify the additive bounded local transcript reader.
import { dbChainMockFns, resetDbChainMock, schemaMock, workflowAuthzMockFns } from '@sim/testing'
import { createSessionPrincipal } from '@sim/testing/factories/principal.factory'
import {
  mothershipOrganizationChatsMock,
  mothershipOrganizationChatsMockFns,
} from '@sim/testing/mocks/mothership-organization-chats.mock'
import { permissionsMock } from '@sim/testing/mocks/permissions.mock'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationError } from '@/lib/core/orchestration/types'
import { loadAuthorizedChatTranscript } from '@/lib/memlia/chat/authorized-transcript.server'
import { createTrustedOrganizationCopilotPrincipal } from '@/lib/mothership/auth/application-delegation'

const {
  mockAuthorizeWorkflowByWorkspacePermission: mockAuthorizeWorkflow,
  mockGetActiveWorkflowRecord: mockGetActiveWorkflow,
} = workflowAuthzMockFns

afterAll(() => {
  mockAuthorizeWorkflow.mockReset()
  mockGetActiveWorkflow.mockReset()
})

const {
  mockAuthorizeOrganizationChat: mockAuthorizeOrganization,
  mockAuthorizeOrganizationChatCancellation: mockAuthorizeCancellation,
} = mothershipOrganizationChatsMockFns
vi.mock('@/lib/mothership/chat/organization-chats', () => mothershipOrganizationChatsMock)

vi.mock('@/lib/workspaces/permissions/utils', () => permissionsMock)

import {
  getAccessibleCopilotChatAuth,
  getAccessibleCopilotChatForCancellation,
  getAccessibleCopilotChatWithMessages,
  loadBoundedCopilotChatText,
  resolveOrCreateChat,
} from '@/lib/mothership/chat/lifecycle'

const CHAT_ID = 'chat-1'
const USER_ID = 'user-1'

// A chat with no workflow/workspace skips the authz lookups and authorizes directly.
const chatRow = {
  id: CHAT_ID,
  userId: USER_ID,
  workflowId: null,
  workspaceId: null,
  organizationId: null,
  type: 'copilot',
  title: 'Test',
  conversationId: null,
  resources: [],
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
}

const userMsg = { id: 'm-user', role: 'user', content: 'Hi', timestamp: '2026-01-01T00:00:00.000Z' }
const asstMsg = {
  id: 'm-asst',
  role: 'assistant',
  content: 'Hello',
  timestamp: '2026-01-01T00:00:01.000Z',
}

describe('bounded authorized text reader (DB/authz boundaries doubled)', () => {
  const scoped = { ...chatRow, mode: 'agent', workflowId: 'wf', workspaceId: 'ws' }
  const projected = { rowId: 'row-1', id: 'message-1', role: 'user', content: userMsg }
  function reads(first = scoped, last = scoped) {
    dbChainMockFns.limit
      .mockResolvedValueOnce([first])
      .mockResolvedValueOnce([{ id: 'row-1' }])
      .mockResolvedValueOnce([projected])
      .mockResolvedValueOnce([last])
  }
  beforeEach(() => {
    resetDbChainMock()
    mockAuthorizeWorkflow.mockReset()
    mockAuthorizeWorkflow.mockResolvedValue({
      allowed: true,
      workflow: { id: 'wf', workspaceId: 'ws' },
    })
    permissionsMock.checkWorkspaceAccess.mockResolvedValue({ exists: true, hasAccess: true })
  })
  afterEach(() => mockAuthorizeWorkflow.mockReset())
  it('returns only bounded text rows after native ownership and canonical workflow checks', async () => {
    reads()
    expect(await loadBoundedCopilotChatText(CHAT_ID, USER_ID, 'wf', 'ws')).toEqual([
      { id: 'message-1', role: 'user', content: userMsg },
    ])
    expect(dbChainMockFns.limit.mock.calls.map(([value]) => value)).toEqual([1, 129, 129, 1])
    expect(mockAuthorizeWorkflow).toHaveBeenCalledWith({
      workflowId: 'wf',
      userId: USER_ID,
      action: 'read',
    })
  })
  it.each([
    { userId: 'foreign' },
    { id: 'foreign' },
    { organizationId: 'org' },
    { workflowId: null },
    { workflowId: 'foreign' },
    { workspaceId: 'foreign' },
  ])('refuses incompatible owner/scope before selecting messages: %j', async (change) => {
    dbChainMockFns.limit.mockResolvedValueOnce([{ ...scoped, ...change }])
    expect(await loadBoundedCopilotChatText(CHAT_ID, USER_ID, 'wf', 'ws')).toBeNull()
    expect(dbChainMockFns.limit).toHaveBeenCalledTimes(1)
  })
  it('refuses a canonical workspace mismatch despite an asserted chat workspace', async () => {
    dbChainMockFns.limit.mockResolvedValueOnce([scoped])
    mockAuthorizeWorkflow.mockResolvedValue({
      allowed: true,
      workflow: { id: 'wf', workspaceId: 'foreign' },
    })
    expect(await loadBoundedCopilotChatText(CHAT_ID, USER_ID, 'wf', 'ws')).toBeNull()
    expect(dbChainMockFns.limit).toHaveBeenCalledTimes(1)
  })
  it('does not detoast messages after count overflow detected using IDs only', async () => {
    dbChainMockFns.limit
      .mockResolvedValueOnce([scoped])
      .mockResolvedValueOnce(Array.from({ length: 129 }, (_, i) => ({ id: String(i) })))
    await expect(loadBoundedCopilotChatText(CHAT_ID, USER_ID, 'wf', 'ws')).rejects.toThrow(
      'Authorized transcript unavailable.'
    )
    expect(dbChainMockFns.select).toHaveBeenCalledTimes(2)
    expect(dbChainMockFns.select.mock.calls[1][0]).toEqual({ id: schemaMock.copilotMessages.id })
  })
  it('refuses changed row identities between the count read and projected snapshot', async () => {
    dbChainMockFns.limit
      .mockResolvedValueOnce([scoped])
      .mockResolvedValueOnce([{ id: 'row-1' }])
      .mockResolvedValueOnce([{ ...projected, rowId: 'replacement' }])
    await expect(loadBoundedCopilotChatText(CHAT_ID, USER_ID, 'wf', 'ws')).rejects.toThrow(
      'Authorized transcript unavailable.'
    )
  })
  it('rechecks ownership after reading and refuses a transfer', async () => {
    reads(scoped, { ...scoped, userId: 'foreign' })
    expect(await loadBoundedCopilotChatText(CHAT_ID, USER_ID, 'wf', 'ws')).toBeNull()
  })
  it('refuses read permission revoked during the projection', async () => {
    reads()
    mockAuthorizeWorkflow
      .mockResolvedValueOnce({ allowed: true, workflow: { id: 'wf', workspaceId: 'ws' } })
      .mockResolvedValueOnce({ allowed: true, workflow: { id: 'wf', workspaceId: 'ws' } })
      .mockResolvedValue({ allowed: false })
    expect(await loadBoundedCopilotChatText(CHAT_ID, USER_ID, 'wf', 'ws')).toBeNull()
  })

  it('composes the real text reader and adapter without tool data or a duplicate current turn', async () => {
    const current = { id: 'message-1', content: 'current text' }
    dbChainMockFns.limit
      .mockResolvedValueOnce([scoped])
      .mockResolvedValueOnce([{ id: 'row-1' }])
      .mockResolvedValueOnce([
        { ...projected, content: { ...current, role: 'user', contentBlocks: null } },
      ])
      .mockResolvedValueOnce([scoped])
    expect(
      await loadAuthorizedChatTranscript({
        principal: { kind: 'session', userId: USER_ID, sessionId: 'session-1' },
        chatId: CHAT_ID,
        workspaceId: 'ws',
        workflowId: 'wf',
        currentMessage: current,
      })
    ).toEqual({ messages: [{ role: 'user', content: 'current text' }] })
  })

  it('closes an oversized SQL projection as refusal without returning a partial transcript', async () => {
    dbChainMockFns.limit
      .mockResolvedValueOnce([scoped])
      .mockResolvedValueOnce([{ id: 'row-1' }])
      .mockResolvedValueOnce([{ ...projected, content: null }])
      .mockResolvedValueOnce([scoped])
    await expect(
      loadAuthorizedChatTranscript({
        principal: { kind: 'session', userId: USER_ID, sessionId: 'session-1' },
        chatId: CHAT_ID,
        workspaceId: 'ws',
        workflowId: 'wf',
        currentMessage: { id: 'current', content: 'x' },
      })
    ).rejects.toThrow('Authorized transcript unavailable.')
  })

  it('generates native PostgreSQL queries with bounded projection, live rows and canonical order', async () => {
    // Real Drizzle/schema/SQL construction; the proxy returns rows without a DB connection.
    const native = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm')
    const proxy =
      await vi.importActual<typeof import('drizzle-orm/pg-proxy')>('drizzle-orm/pg-proxy')
    const { databaseMock, drizzleOrmMock } = await import('@sim/testing/mocks/database.mock')
    vi.resetModules()
    vi.doMock('drizzle-orm', () => native)
    try {
      const schema = await vi.importActual<typeof import('@sim/db/schema')>('@sim/db/schema')
      vi.doMock('@sim/db/schema', () => schema)
      const statements: Array<{ sql: string; params: unknown[] }> = []
      const nativeDb = proxy.drizzle(async (sql, params) => {
        statements.push({ sql, params })
        if (sql.includes('from "copilot_chats"'))
          return { rows: [[CHAT_ID, 'agent', USER_ID, 'wf', 'ws', null, 'copilot']] }
        if (sql.includes('octet_length')) return { rows: [['row-1', 'message-1', 'user', userMsg]] }
        return { rows: [['row-1']] }
      })
      vi.doMock('@sim/db', () => ({ db: nativeDb }))
      const reader = await import('@/lib/mothership/chat/lifecycle')
      expect(await reader.loadBoundedCopilotChatText(CHAT_ID, USER_ID, 'wf', 'ws')).toEqual([
        { id: 'message-1', role: 'user', content: userMsg },
      ])
      expect(statements).toHaveLength(4)
      expect(statements[0].params).toContain(CHAT_ID)
      expect(statements[0].params).toContain(USER_ID)
      expect(statements[1].sql).not.toContain('"content"')
      expect(statements[1].params.at(-1)).toBe(129)
      const projectedSql = statements[2].sql
      expect(projectedSql).toContain('octet_length("copilot_messages"."content"::text) <= 65536')
      expect(projectedSql).toContain('else null end')
      expect(projectedSql).toContain('"deleted_at" is null')
      expect(projectedSql).toContain('"seq" asc nulls last')
      expect(projectedSql).toContain('"created_at" asc')
      expect(projectedSql).toContain('"id" asc')
      expect(projectedSql).toContain('strict $.contentBlocks[*] ? (@.type == "text")')
      expect(statements[2].params.at(-1)).toBe(129)
    } finally {
      vi.doMock('@sim/db', () => databaseMock)
      vi.doMock('@sim/db/schema', () => schemaMock)
      vi.doMock('drizzle-orm', () => drizzleOrmMock)
      vi.resetModules()
    }
  })
})

describe('lifecycle copilot chat reads (cutover to copilot_messages)', () => {
  beforeEach(() => {
    resetDbChainMock()
    mockAuthorizeOrganization.mockResolvedValue({
      organizationId: 'org-1',
      userId: USER_ID,
      role: 'member',
    })
  })

  it('getAccessibleCopilotChatWithMessages sources messages from copilot_messages in seq order', async () => {
    // 1st query: chat metadata (select().from().where().limit())
    dbChainMockFns.limit.mockResolvedValueOnce([chatRow])
    // 2nd query: messages (select().from().where().orderBy())
    dbChainMockFns.orderBy.mockResolvedValueOnce([{ content: userMsg }, { content: asstMsg }])

    const result = await getAccessibleCopilotChatWithMessages(CHAT_ID, USER_ID)

    expect(result).not.toBeNull()
    expect(result?.messages).toEqual([userMsg, asstMsg])
    expect(dbChainMockFns.orderBy).toHaveBeenCalledTimes(1)
  })

  it('strips tool-result output on read, keeping success/error', async () => {
    const toolMsg = {
      id: 'm-tool',
      role: 'assistant',
      content: '',
      timestamp: '2026-01-01T00:00:02.000Z',
      contentBlocks: [
        {
          type: 'tool',
          phase: 'call',
          toolCall: {
            id: 'tc-1',
            name: 'get_workflow_logs',
            state: 'success',
            result: { success: true, output: { huge: 'x'.repeat(5000) } },
          },
        },
      ],
    }
    dbChainMockFns.limit.mockResolvedValueOnce([chatRow])
    dbChainMockFns.orderBy.mockResolvedValueOnce([{ content: toolMsg }])

    const result = await getAccessibleCopilotChatWithMessages(CHAT_ID, USER_ID)

    expect(result?.messages?.[0].contentBlocks?.[0].toolCall?.result).toEqual({ success: true })
    expect(JSON.stringify(result?.messages)).not.toContain('huge')
  })

  it('returns null and does NOT query messages when the chat is not found', async () => {
    dbChainMockFns.limit.mockResolvedValueOnce([])

    const result = await getAccessibleCopilotChatWithMessages(CHAT_ID, USER_ID)

    expect(result).toBeNull()
    expect(dbChainMockFns.orderBy).not.toHaveBeenCalled()
  })

  it('returns null and does NOT query messages when the row is found but authorization fails', async () => {
    // Row exists but belongs to a workflow the user cannot read.
    dbChainMockFns.limit.mockResolvedValueOnce([{ ...chatRow, workflowId: 'wf-1' }])
    mockAuthorizeWorkflow.mockResolvedValueOnce({ allowed: false, workflow: null })

    const result = await getAccessibleCopilotChatWithMessages(CHAT_ID, USER_ID)

    expect(result).toBeNull()
    expect(dbChainMockFns.orderBy).not.toHaveBeenCalled()
  })

  it('scopes the chat lookup to the requesting user, not the chat id alone', async () => {
    dbChainMockFns.limit.mockResolvedValueOnce([chatRow])
    dbChainMockFns.orderBy.mockResolvedValueOnce([])

    await getAccessibleCopilotChatWithMessages(CHAT_ID, USER_ID)

    const predicate = dbChainMockFns.where.mock.calls[0]?.[0] as {
      type: string
      conditions: unknown[]
    }
    expect(predicate.type).toBe('and')
    // Three conditions exactly: dropping one silently widens the lookup, so the
    // count is asserted alongside the membership checks.
    expect(predicate.conditions).toHaveLength(3)
    expect(predicate.conditions).toContainEqual({
      type: 'eq',
      left: schemaMock.copilotChats.userId,
      right: USER_ID,
    })
    expect(predicate.conditions).toContainEqual({
      type: 'eq',
      left: schemaMock.copilotChats.id,
      right: CHAT_ID,
    })
    expect(predicate.conditions).toContainEqual({
      type: 'isNull',
      column: schemaMock.copilotChats.deletedAt,
    })
  })

  it('resolveOrCreateChat scopes its existing-chat lookup to the requesting user', async () => {
    dbChainMockFns.limit.mockResolvedValueOnce([chatRow])
    dbChainMockFns.orderBy.mockResolvedValueOnce([])

    await resolveOrCreateChat({ chatId: CHAT_ID, userId: USER_ID, model: 'm' })

    const predicate = dbChainMockFns.where.mock.calls[0]?.[0] as {
      type: string
      conditions: unknown[]
    }
    expect(predicate.conditions).toHaveLength(3)
    expect(predicate.conditions).toContainEqual({
      type: 'eq',
      left: schemaMock.copilotChats.userId,
      right: USER_ID,
    })
  })

  it('resolveOrCreateChat refuses a resumed chat whose type is not the asserted one', async () => {
    dbChainMockFns.limit.mockResolvedValueOnce([{ ...chatRow, type: 'mothership' }])

    const result = await resolveOrCreateChat({
      chatId: CHAT_ID,
      userId: USER_ID,
      model: 'm',
      type: 'copilot',
    })

    // Same shape an unknown id resolves to: the refusal carries no reason.
    expect(result.chat).toBeNull()
    expect(result.isNew).toBe(false)
  })

  it('resolveOrCreateChat resumes a chat whose type matches the asserted one', async () => {
    dbChainMockFns.limit.mockResolvedValueOnce([{ ...chatRow, type: 'mothership' }])

    const result = await resolveOrCreateChat({
      chatId: CHAT_ID,
      userId: USER_ID,
      model: 'm',
      type: 'mothership',
    })

    expect(result.chat).not.toBeNull()
  })
})

const orgPrincipal = createSessionPrincipal({ userId: USER_ID })

describe('organization chat isolation', () => {
  beforeEach(() => {
    dbChainMockFns.limit.mockReset()
    resetDbChainMock()
    mockAuthorizeOrganization.mockResolvedValue({
      organizationId: 'org-1',
      userId: USER_ID,
      role: 'member',
    })
  })

  it('allows an org member without a workspace to read their transcript', async () => {
    dbChainMockFns.limit.mockResolvedValueOnce([
      { ...chatRow, organizationId: 'org-1', type: 'mothership' },
    ])
    dbChainMockFns.orderBy.mockResolvedValueOnce([{ content: userMsg }])
    const chat = await getAccessibleCopilotChatWithMessages(CHAT_ID, USER_ID, {
      principal: orgPrincipal,
    })
    expect(chat?.messages).toEqual([userMsg])
    expect(mockAuthorizeOrganization).toHaveBeenCalledWith({
      principal: orgPrincipal,
      input: { organizationId: 'org-1' },
    })
  })

  it('does not expose org content to a legacy caller without a principal', async () => {
    dbChainMockFns.limit.mockResolvedValueOnce([{ ...chatRow, organizationId: 'org-1' }])
    expect(await getAccessibleCopilotChatWithMessages(CHAT_ID, USER_ID)).toBeNull()
    expect(dbChainMockFns.orderBy).not.toHaveBeenCalled()
  })

  it('rejects a principal that does not represent the chat owner', async () => {
    dbChainMockFns.limit.mockResolvedValueOnce([{ ...chatRow, organizationId: 'org-1' }])
    expect(
      await getAccessibleCopilotChatWithMessages(CHAT_ID, USER_ID, {
        principal: { ...orgPrincipal, userId: 'other-user' },
      })
    ).toBeNull()
    expect(mockAuthorizeOrganization).not.toHaveBeenCalled()
    expect(dbChainMockFns.orderBy).not.toHaveBeenCalled()
  })

  it.each(['agent', 'assistant'] as const)(
    'retains the same chat and resources when requesting %s for the next turn',
    async (mode) => {
      const resources = [{ type: 'table', id: 'table', title: 'Evidence' }]
      dbChainMockFns.limit.mockResolvedValueOnce([
        {
          ...chatRow,
          organizationId: 'org-1',
          type: 'mothership',
          mode: mode === 'agent' ? 'assistant' : 'agent',
          resources,
        },
      ])
      const result = await resolveOrCreateChat({
        chatId: CHAT_ID,
        userId: USER_ID,
        organizationId: 'org-1',
        principal: orgPrincipal,
        mode,
        model: 'm',
        type: 'mothership',
      })
      expect(result.chatId).toBe(CHAT_ID)
      expect(result.isNew).toBe(false)
      expect(result.chat?.resources).toEqual(resources)
      expect(mockAuthorizeOrganization).toHaveBeenCalledWith({
        principal: orgPrincipal,
        input: { organizationId: 'org-1', mode },
      })
      expect(dbChainMockFns.insert).not.toHaveBeenCalled()
    }
  )

  it('refuses to resume an org chat through a different organization', async () => {
    dbChainMockFns.limit.mockResolvedValueOnce([
      { ...chatRow, organizationId: 'org-2', type: 'mothership' },
    ])
    const result = await resolveOrCreateChat({
      chatId: CHAT_ID,
      userId: USER_ID,
      organizationId: 'org-1',
      principal: orgPrincipal,
      model: 'm',
      type: 'mothership',
    })
    expect(result.chat).toBeNull()
  })

  it('rejects mixed organization and workspace ownership before creating a chat', async () => {
    await expect(
      resolveOrCreateChat({
        userId: USER_ID,
        organizationId: 'org-1',
        workspaceId: 'ws-1',
        principal: orgPrincipal,
        model: 'm',
      })
    ).rejects.toThrow('cannot have workspace')
    expect(dbChainMockFns.values).not.toHaveBeenCalled()
  })
})

describe('owned chat cancellation policy', () => {
  const orgChat = { ...chatRow, organizationId: 'org-1', type: 'mothership' }
  beforeEach(() => {
    resetDbChainMock()
    mockAuthorizeOrganization.mockReset().mockResolvedValue(undefined)
    mockAuthorizeCancellation.mockReset().mockResolvedValue(undefined)
  })

  it('allows stopping an owned org chat after capability revocation while ordinary reads remain denied', async () => {
    mockAuthorizeOrganization.mockRejectedValue(
      new OrchestrationError('forbidden', 'Copilot disabled')
    )
    dbChainMockFns.limit.mockResolvedValueOnce([orgChat]).mockResolvedValueOnce([orgChat])
    expect(
      await getAccessibleCopilotChatForCancellation(CHAT_ID, USER_ID, { principal: orgPrincipal })
    ).toEqual(orgChat)
    expect(mockAuthorizeCancellation).toHaveBeenCalledWith({
      principal: orgPrincipal,
      input: { organizationId: 'org-1' },
    })
    expect(mockAuthorizeOrganization).not.toHaveBeenCalled()
    expect(
      await getAccessibleCopilotChatAuth(CHAT_ID, USER_ID, { principal: orgPrincipal })
    ).toBeNull()
    expect(mockAuthorizeOrganization).toHaveBeenCalledTimes(1)
    expect(dbChainMockFns.orderBy).not.toHaveBeenCalled()
  })

  it('keeps the owned-live-chat predicate on cancellation', async () => {
    dbChainMockFns.limit.mockResolvedValueOnce([orgChat])
    await getAccessibleCopilotChatForCancellation(CHAT_ID, USER_ID, { principal: orgPrincipal })
    const predicate = dbChainMockFns.where.mock.calls[0][0] as { conditions: unknown[] }
    expect(predicate.conditions).toEqual([
      { type: 'eq', left: schemaMock.copilotChats.id, right: CHAT_ID },
      { type: 'eq', left: schemaMock.copilotChats.userId, right: USER_ID },
      { type: 'isNull', column: schemaMock.copilotChats.deletedAt },
    ])
  })

  it('denies cancellation after organization membership removal', async () => {
    dbChainMockFns.limit.mockResolvedValueOnce([orgChat])
    mockAuthorizeCancellation.mockRejectedValueOnce(
      new OrchestrationError('not_found', 'Organization not found')
    )
    expect(
      await getAccessibleCopilotChatForCancellation(CHAT_ID, USER_ID, { principal: orgPrincipal })
    ).toBeNull()
    expect(mockAuthorizeOrganization).not.toHaveBeenCalled()
  })

  it.each([undefined, { ...orgPrincipal, userId: 'other-user' }])(
    'denies cancellation without the matching actor principal',
    async (principal) => {
      dbChainMockFns.limit.mockResolvedValueOnce([orgChat])
      expect(
        await getAccessibleCopilotChatForCancellation(CHAT_ID, USER_ID, { principal })
      ).toBeNull()
      expect(mockAuthorizeCancellation).not.toHaveBeenCalled()
    }
  )

  it('does not let delegated cancellation switch to another chat owned by the same actor', async () => {
    dbChainMockFns.limit.mockResolvedValueOnce([orgChat])
    const principal = createTrustedOrganizationCopilotPrincipal(
      {
        userId: USER_ID,
        organizationId: 'org-1',
        chatId: 'other-chat',
        delegationId: 'request',
      },
      { audience: 'sim:copilot-cancel', ttlMs: 60000 }
    )
    expect(
      await getAccessibleCopilotChatForCancellation(CHAT_ID, USER_ID, { principal })
    ).toBeNull()
    expect(mockAuthorizeCancellation).not.toHaveBeenCalled()
  })

  it('denies missing/deleted/non-owned chats before authorizing cancellation', async () => {
    dbChainMockFns.limit.mockResolvedValueOnce([])
    expect(
      await getAccessibleCopilotChatForCancellation(CHAT_ID, USER_ID, { principal: orgPrincipal })
    ).toBeNull()
    expect(mockAuthorizeCancellation).not.toHaveBeenCalled()
  })

  it('propagates cancellation authorization infrastructure errors', async () => {
    dbChainMockFns.limit.mockResolvedValueOnce([orgChat])
    mockAuthorizeCancellation.mockRejectedValueOnce(new Error('database unavailable'))
    await expect(
      getAccessibleCopilotChatForCancellation(CHAT_ID, USER_ID, { principal: orgPrincipal })
    ).rejects.toThrow('database unavailable')
  })
})
