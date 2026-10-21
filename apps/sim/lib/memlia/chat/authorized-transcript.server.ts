// Copyright (c) 2026 Memlia. All rights reserved.
import { parsePrincipal, type SessionPrincipal } from '@sim/auth/principal'
import { z } from 'zod'
import { stringifyBoundedJson } from '@/lib/core/utils/bounded-json'
import { loadBoundedCopilotChatText } from '@/lib/mothership/chat/lifecycle'

export type AuthorizedTranscriptInput = {
  principal: SessionPrincipal
  chatId: string
  workspaceId: string
  workflowId: string
  currentMessage: { id: string; content: string }
}

export type AuthorizedTranscript = {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
}

const id = z.string().min(1).max(512)
const inputSchema = z
  .object({
    principal: z.unknown(),
    chatId: id,
    workspaceId: id,
    workflowId: id,
    currentMessage: z.object({ id, content: z.string() }).strict(),
  })
  .strict()
const projectedMessage = z.object({
  id,
  role: z.enum(['user', 'assistant']),
  // Task-origin rows use role=user in native storage but are system notifications.
  origin: z.null().optional(),
  content: z.string().nullable().optional(),
  contentBlocks: z
    .array(z.object({ type: z.literal('text'), content: z.string() }))
    .nullable()
    .optional(),
})
const unavailable = () => new Error('Authorized transcript unavailable.')

export async function loadAuthorizedChatTranscript(
  raw: AuthorizedTranscriptInput
): Promise<AuthorizedTranscript> {
  try {
    const json = stringifyBoundedJson(raw, 96 * 1024, { strict: true })
    if (json === undefined) throw unavailable()
    const input = inputSchema.parse(JSON.parse(json))
    const principal = parsePrincipal({ version: 1, principal: input.principal })
    if (
      principal.kind !== 'session' ||
      Buffer.byteLength(input.currentMessage.content, 'utf8') > 65536
    )
      throw unavailable()
    const rows = await loadBoundedCopilotChatText(
      input.chatId,
      principal.userId,
      input.workflowId,
      input.workspaceId
    )
    if (!rows || rows.length > 128) throw unavailable()
    const messages: AuthorizedTranscript['messages'] = []
    const seen = new Set<string>()
    let bytes = 0
    let currentFound = false
    const append = (role: 'user' | 'assistant', content: string) => {
      bytes += Buffer.byteLength(content, 'utf8')
      if (bytes > 256 * 1024 || messages.length >= 128) throw unavailable()
      messages.push({ role, content })
    }
    for (const [index, row] of rows.entries()) {
      const messageId = id.parse(row.id)
      if (seen.has(messageId)) throw unavailable()
      seen.add(messageId)
      const isCurrent = messageId === input.currentMessage.id
      if (row.role !== 'user' && row.role !== 'assistant') {
        if (isCurrent) throw unavailable()
        continue
      }
      const captured = stringifyBoundedJson(row.content, 65536, { strict: true })
      if (captured === undefined) throw unavailable()
      const message = projectedMessage.parse(JSON.parse(captured))
      if (message.id !== messageId || message.role !== row.role) throw unavailable()
      const text = message.contentBlocks?.length
        ? message.contentBlocks.map((block) => block.content).join('')
        : message.content
      if (typeof text !== 'string') throw unavailable()
      if (isCurrent) {
        if (
          message.role !== 'user' ||
          text !== input.currentMessage.content ||
          index !== rows.length - 1
        )
          throw unavailable()
        currentFound = true
      }
      append(message.role, text)
    }
    if (!currentFound) append('user', input.currentMessage.content)
    return { messages }
  } catch {
    throw unavailable()
  }
}
