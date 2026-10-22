// Copyright (c) 2026 Memlia. All rights reserved.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { load } = vi.hoisted(() => ({ load: vi.fn() }))
vi.mock('@/lib/mothership/chat/lifecycle', () => ({
  loadBoundedCopilotChatText: load,
}))

import { loadAuthorizedChatTranscript } from './authorized-transcript.server'

const input = () => ({
  principal: { kind: 'session' as const, userId: 'user-1', sessionId: 'session-1' },
  chatId: 'chat-1',
  workspaceId: 'workspace-1',
  workflowId: 'workflow-1',
  currentMessage: { id: 'current', content: 'Current question' },
})
const row = (id: string, role: string, content: unknown = 'text') => ({
  id,
  role,
  content: { id, role, content, contentBlocks: null },
})

describe('authorized local text transcript (native loader doubled)', () => {
  beforeEach(() => {
    load.mockReset()
    load.mockResolvedValue([])
  })

  it('owns current input before await and appends it once', async () => {
    const original = input()
    load.mockImplementationOnce(async () => {
      original.currentMessage.content = 'changed'
      original.currentMessage.id = 'changed'
      original.principal.userId = 'foreign'
      original.chatId = 'foreign'
      original.workspaceId = 'foreign'
      original.workflowId = 'foreign'
      return [row('past', 'assistant')]
    })
    expect(await loadAuthorizedChatTranscript(original)).toEqual({
      messages: [
        { role: 'assistant', content: 'text' },
        { role: 'user', content: 'Current question' },
      ],
    })
    expect(load).toHaveBeenCalledWith('chat-1', 'user-1', 'workflow-1', 'workspace-1')
  })

  it('does not duplicate an identical current user message already persisted last', async () => {
    load.mockResolvedValue([row('current', 'user', 'Current question')])
    expect(await loadAuthorizedChatTranscript(input())).toEqual({
      messages: [{ role: 'user', content: 'Current question' }],
    })
  })

  it.each([
    [row('current', 'user', 'different')],
    [row('current', 'assistant', 'Current question')],
    [row('current', 'system', 'Current question')],
    [row('current', 'user', 'Current question'), row('later', 'assistant')],
    [row('same', 'user'), row('same', 'assistant')],
  ])('refuses divergent, non-user, non-final or duplicate message identity', async (...rows) => {
    load.mockResolvedValue(rows)
    await expect(loadAuthorizedChatTranscript(input())).rejects.toThrow(
      'Authorized transcript unavailable.'
    )
  })

  it('projects only exact text blocks without trimming or tool data', async () => {
    load.mockResolvedValue([
      row('system', 'system', 'CANARY_SYSTEM'),
      row('tool', 'tool', 'CANARY_TOOL'),
      {
        id: 'past',
        role: 'assistant',
        content: {
          id: 'past',
          role: 'assistant',
          content: 'unused fallback',
          contentBlocks: [
            { type: 'text', content: ' A ', credentials: 'CANARY_CREDENTIAL' },
            { type: 'text', content: '\nB', output: 'CANARY_OUTPUT' },
          ],
          fileAttachments: [{ content: 'CANARY_ATTACHMENT' }],
          contexts: ['CANARY_CONTEXT'],
        },
      },
    ])
    const output = await loadAuthorizedChatTranscript(input())
    expect(output.messages).toEqual([
      { role: 'assistant', content: ' A \nB' },
      { role: 'user', content: 'Current question' },
    ])
    expect(JSON.stringify(output)).not.toContain('CANARY')
    expect(JSON.stringify(output)).not.toContain('session-1')
  })

  it.each([null, true, { bad: 'CANARY' }, 12])(
    'never coerces malformed text %j',
    async (content) => {
      load.mockResolvedValue([row('past', 'user', content)])
      await expect(loadAuthorizedChatTranscript(input())).rejects.toThrow(
        'Authorized transcript unavailable.'
      )
    }
  )

  it.each([
    { id: 'foreign', role: 'user', content: 'x' },
    { id: 'past', role: 'system', content: 'x' },
    { id: 'past', role: 'user', content: 'x', contentBlocks: [{ type: 'text', content: true }] },
    {
      id: 'past',
      role: 'user',
      content: 'x',
      contentBlocks: [{ type: 'tool', content: 'CANARY' }],
    },
    { id: 'past', role: 'user', content: 'x', contentBlocks: 'bad' },
  ])('refuses corrupt projected payload rather than inventing a role or text', async (content) => {
    load.mockResolvedValue([{ id: 'past', role: 'user', content }])
    await expect(loadAuthorizedChatTranscript(input())).rejects.toThrow(
      'Authorized transcript unavailable.'
    )
  })

  it('refuses all text exceeding the global UTF-8 cap instead of silently truncating', async () => {
    load.mockResolvedValue(
      Array.from({ length: 8 }, (_, i) => row(`p${i}`, 'user', 'é'.repeat(20000)))
    )
    await expect(loadAuthorizedChatTranscript(input())).rejects.toThrow(
      'Authorized transcript unavailable.'
    )
  })
  it('refuses a 129th output message and oversized current text before the loader', async () => {
    const large = input()
    large.currentMessage.content = 'é'.repeat(40000)
    await expect(loadAuthorizedChatTranscript(large)).rejects.toThrow(
      'Authorized transcript unavailable.'
    )
    expect(load).not.toHaveBeenCalled()
    load.mockResolvedValue(Array.from({ length: 128 }, (_, i) => row(`p${i}`, 'user')))
    await expect(loadAuthorizedChatTranscript(input())).rejects.toThrow(
      'Authorized transcript unavailable.'
    )
  })
  it('refuses accessor input without invoking it', async () => {
    const value = input()
    const getter = vi.fn(() => 'CANARY')
    Object.defineProperty(value.currentMessage, 'content', { enumerable: true, get: getter })
    await expect(loadAuthorizedChatTranscript(value)).rejects.toThrow(
      'Authorized transcript unavailable.'
    )
    expect(getter).not.toHaveBeenCalled()
    expect(load).not.toHaveBeenCalled()
  })
  it.each([
    { kind: 'personal_api_key', userId: 'user-1', keyId: 'key-1' },
    { kind: 'session', userId: 'user-1', sessionId: '' },
    { kind: 'session', userId: 'user-1', sessionId: 'session-1', authority: 'forged' },
  ])('refuses a non-session or malformed principal before loading', async (principal) => {
    const value = input()
    Reflect.set(value, 'principal', principal)
    await expect(loadAuthorizedChatTranscript(value)).rejects.toThrow(
      'Authorized transcript unavailable.'
    )
    expect(load).not.toHaveBeenCalled()
  })
  it('closes loader refusal/errors without exposing their cause', async () => {
    load.mockResolvedValueOnce(null)
    await expect(loadAuthorizedChatTranscript(input())).rejects.toThrow(
      'Authorized transcript unavailable.'
    )
    load.mockRejectedValueOnce(new Error('CANARY_DATABASE'))
    await expect(loadAuthorizedChatTranscript(input())).rejects.toEqual(
      new Error('Authorized transcript unavailable.')
    )
  })
  it('refuses an automatic task notification instead of promoting it to human text', async () => {
    load.mockResolvedValue([
      {
        id: 'task-message',
        role: 'user',
        content: {
          id: 'task-message',
          role: 'user',
          origin: 'task',
          content: 'CANARY_NOTIFICATION',
        },
      },
    ])
    await expect(loadAuthorizedChatTranscript(input())).rejects.toThrow(
      'Authorized transcript unavailable.'
    )
  })
})
