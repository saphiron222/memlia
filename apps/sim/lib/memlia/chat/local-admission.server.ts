// Copyright 2026 Memlia. All rights reserved.
import { parsePrincipal } from '@sim/auth/principal'
import { z } from 'zod'
import { getRotatingApiKey } from '@/lib/core/config/api-keys'
import { isCopilotToolPermissionsEnabled } from '@/lib/core/config/env-flags'
import { stringifyBoundedJson } from '@/lib/core/utils/bounded-json'
import { readChatBudgetWindow } from '@/lib/memlia/ai/chat-budget-window.server'
import { selectWorkflowReadPolicy } from '@/lib/memlia/ai/chat-policy.server'
import { readChatInstallationPolicyFile } from '@/lib/memlia/ai/chat-policy-source.server'
import { captureChatPricingProfile } from '@/lib/memlia/ai/chat-pricing-profile.server'
import { LocalChatAdmissionSchema } from '@/lib/mothership/request/lifecycle/recovery-config'
import { assertWorkspaceCapability } from '@/lib/permission-groups/capability-assertions'
import { validateModelProvider } from '@/lib/permission-groups/permission-check'
import {
  type AuthorizedTranscriptInput,
  loadAuthorizedChatTranscript,
} from './authorized-transcript.server'
import { captureLocalChatOptions, type LocalChatOptions } from './local-driver.server'

export type PreparedLocalChatAdmission = {
  /** Native admission intent, including current text only; never provider options. */
  intent: z.infer<typeof LocalChatAdmissionSchema>
  /** Ephemeral server memory only: contains a credential and authorized history. */
  localChat: LocalChatOptions
}

const request = LocalChatAdmissionSchema.shape.request.shape
const inputSchema = z
  .object({
    principal: z.unknown(),
    chatId: request.chatId,
    workspaceId: request.workspaceId,
    workflowId: request.workflowId,
    currentMessage: z.object({ id: request.messageId, content: request.message }).strict(),
  })
  .strict()
const transcriptSchema = z
  .object({
    messages: z
      .array(
        z
          .object({
            role: z.enum(['user', 'assistant']),
            content: z.string(),
          })
          .strict()
      )
      .min(1)
      .max(128),
  })
  .strict()
const unavailable = () => new Error('Local Chat admission is unavailable.')

/** Prepare only. The caller must establish a real authenticated session first.
 * No durable write, admission, reservation, transport or worker fallback occurs here.
 */
export async function prepareLocalChatAdmission(
  raw: AuthorizedTranscriptInput
): Promise<PreparedLocalChatAdmission> {
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
    const intent = LocalChatAdmissionSchema.parse({
      kind: 'memlia_local_chat',
      version: 1,
      request: {
        userId: principal.userId,
        chatId: input.chatId,
        workspaceId: input.workspaceId,
        workflowId: input.workflowId,
        messageId: input.currentMessage.id,
        message: input.currentMessage.content,
        mode: 'agent',
      },
    })
    const { policy } = readChatInstallationPolicyFile()
    const workflow = selectWorkflowReadPolicy(policy, input.workflowId)
    if (!policy.localBackend || workflow?.policy !== 'sanitized_details') throw unavailable()
    // Own primitive configuration selections before any asynchronous boundary.
    const model = policy.model
    const provider = policy.provider
    const anthropicWorkspaceId = policy.anthropicWorkspaceId
    const windowId = policy.localBackend.budgetWindow.id
    const windowVersion = policy.localBackend.budgetWindow.version
    await assertWorkspaceCapability(principal.userId, input.workspaceId, 'copilot.use')
    // Native implementation throws on both denied model and denied provider.
    await validateModelProvider(principal.userId, input.workspaceId, model)
    if (!isCopilotToolPermissionsEnabled) throw unavailable()
    const transcript = await loadAuthorizedChatTranscript({ ...input, principal })
    const transcriptJSON = stringifyBoundedJson(transcript, 2 * 1024 * 1024, { strict: true })
    if (transcriptJSON === undefined) throw unavailable()
    const { messages } = transcriptSchema.parse(JSON.parse(transcriptJSON))
    if (
      messages.reduce((total, message) => total + Buffer.byteLength(message.content, 'utf8'), 0) >
      256 * 1024
    )
      throw unavailable()
    const observed = await readChatBudgetWindow({ windowId, windowVersion, model })
    const { profile } = captureChatPricingProfile(observed.pricingProfile)
    if (
      observed.windowId !== windowId ||
      observed.windowVersion !== windowVersion ||
      profile.model !== model ||
      profile.provider !== provider
    )
      throw unavailable()
    // Last sensitive read, after all admission observations; never logged or persisted.
    // The budgeted driver must still COMMIT a reservation before each physical transport.
    const apiKey = getRotatingApiKey(provider)
    if (typeof apiKey !== 'string' || apiKey.length === 0) throw unavailable()
    const localChat = captureLocalChatOptions({
      principal,
      workspaceId: input.workspaceId,
      workflow: { ...workflow, previewOperations: true },
      request: { model, maxTokens: profile.bounds.outputTokens, messages, apiKey },
      budget: { windowId, windowVersion, pricingProfile: profile },
      ...(anthropicWorkspaceId === undefined ? {} : { anthropicWorkspaceId }),
    })
    return { intent, localChat }
  } catch {
    // No native cause, validation issues, transcript, profile or credential escapes.
    throw unavailable()
  }
}
