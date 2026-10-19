// Modified by Memlia: admit a local run atomically without worker recovery.
import type { SessionPrincipal } from '@sim/auth/principal'
import { copilotChats, idempotencyKey } from '@sim/db/schema'
import { createLogger } from '@sim/logger'
import { getErrorMessage } from '@sim/utils/errors'
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { z } from 'zod'
import { defineWorkspaceOperation } from '@/lib/core/application'
import { defineOrganizationOperation } from '@/lib/core/application/organization-operation'
import { OrchestrationError } from '@/lib/core/orchestration/types'
import { resolveTurnDesktopDevice } from '@/lib/desktop/application/executor'
import { requireOrganizationSearchAvailable } from '@/lib/knowledge/access/availability'
import { insertRunSegment, withRunAdmissionLock } from '@/lib/mothership/async-runs/repository'
import { defineAuthorizedChatUseCase } from '@/lib/mothership/chat/application/authorized-chat-use-case'
import { resolveOwnedChatContext } from '@/lib/mothership/chat/application/context'
import { ChatSendSupersededError } from '@/lib/mothership/chat/application/send-superseded'
import { withChatEffortChoice } from '@/lib/mothership/chat/intent'
import { appendCopilotChatMessages } from '@/lib/mothership/chat/messages-store'
import { authorizeOrganizationChat } from '@/lib/mothership/chat/organization-chats'
import {
  buildPersistedUserMessage,
  type UserMessageParams,
} from '@/lib/mothership/chat/persisted-message'
import { publishChatStatusChanged } from '@/lib/mothership/chat-status'
import type { MothershipEffort } from '@/lib/mothership/model-options'
import {
  classifyRunExecution,
  LOCAL_CHAT_EXECUTION,
  LocalChatAdmissionSchema,
  StreamRecoveryConfigSchema,
} from '@/lib/mothership/request/lifecycle/recovery-config'
import {
  assertChatStreamLease,
  type ChatStreamLease,
} from '@/lib/mothership/request/session/controller-lease'

interface AdmitTurnInput {
  chatId: string
  runId: string
  executionId: string
  requestId: string
  message: UserMessageParams
  recovery?: z.input<typeof StreamRecoveryConfigSchema>
  /** Server-only local intent; mutually exclusive with worker recovery. */
  local?: z.input<typeof LocalChatAdmissionSchema>
  lease: ChatStreamLease
  sendClaim: { normalizedKey: string; claimToken: string }
  notifyWorkspaceStatus: boolean
  /** The effort this send picked, kept as the chat's choice for later turns. */
  effortChoice?: MothershipEffort
  /** The composer's desktop, offered for its background executor to run this turn's desktop tools. */
  desktopDeviceId?: string
}

/**
 * The desktop a turn runs on, if any. Only a workspace chat runs on a desktop in the background:
 * its sidebar shows the status and an approval notification links back to it. An organization
 * chat stays with its chat view.
 */
export async function turnDesktopDevice(
  principal: SessionPrincipal,
  workspaceId: string | null | undefined,
  offeredDeviceId: string | undefined
): Promise<string | null> {
  if (!offeredDeviceId || !workspaceId) return null
  return resolveTurnDesktopDevice(principal, offeredDeviceId)
}

/** The accepted message, its start intent and retry destination commit together. */
export const admitChatTurn = defineAuthorizedChatUseCase({
  operation: defineWorkspaceOperation({
    id: 'mothership.chats.admit_turn',
    minimumRole: 'read',
    workspaceApiKey: 'deny',
    capability: 'copilot.use',
    principalKinds: ['session'],
  }),
  organizationOperation: defineOrganizationOperation({
    id: 'mothership.chats.admit_turn',
    minimumRole: 'member',
    capability: 'copilot.use',
    principalKinds: ['session'],
  }),
  resolveContext({ principal, input }: { principal: SessionPrincipal; input: AdmitTurnInput }) {
    return resolveOwnedChatContext(principal, input.chatId)
  },
  authorizationOptions: {},
  async execute({ principal, context, input }) {
    const { userId, workspaceId, organizationId, chatId } = context
    const hasLocal = Object.hasOwn(input, 'local')
    if (hasLocal && (Object.hasOwn(input, 'recovery') || input.desktopDeviceId))
      throw new OrchestrationError('validation', 'Local Chat is unavailable.')
    const local = hasLocal ? LocalChatAdmissionSchema.parse(input.local) : undefined
    const recovery = local ? undefined : StreamRecoveryConfigSchema.parse(input.recovery)
    const request = local ? { ...local.request, organizationId: undefined } : recovery!.request
    if (local && (!workspaceId || organizationId || request.workflowId !== context.workflowId))
      throw new OrchestrationError('validation', 'Local Chat is unavailable.')
    if (
      request.userId !== userId ||
      request.workspaceId !== workspaceId ||
      request.organizationId !== organizationId ||
      (input.message.requestMode ?? 'agent') !== (request.mode ?? 'agent') ||
      request.chatId !== chatId ||
      request.messageId !== input.message.id ||
      request.message !== input.message.content
    ) {
      throw new OrchestrationError('validation', 'Turn identity does not match its chat')
    }
    if (local) {
      if (Object.keys(input.message).some((key) => !['id', 'content', 'requestMode'].includes(key)))
        throw new OrchestrationError('validation', 'Local Chat is unavailable.')
      input = {
        ...input,
        local,
        message: { id: request.messageId, content: request.message, requestMode: 'agent' },
        lease: { ...input.lease },
        sendClaim: { ...input.sendClaim },
      }
    }
    if (organizationId) {
      if (request.mode === 'agent' || request.mode === 'plan')
        await authorizeOrganizationChat.execute({
          principal,
          input: { organizationId, mode: request.mode },
        })
      else await requireOrganizationSearchAvailable(organizationId)
    }
    await assertChatStreamLease(input.lease)
    const desktopDeviceId = local
      ? null
      : await turnDesktopDevice(principal, workspaceId, input.desktopDeviceId)
    const turnConfig = sql`COALESCE(${copilotChats.config}, '{}'::jsonb) || jsonb_build_object('conversationMode', ${request.mode ?? 'agent'}::text)`
    return withRunAdmissionLock(userId, request.messageId, async (tx) => {
      const [chat] = await tx
        .update(copilotChats)
        .set({
          conversationId: request.messageId,
          updatedAt: new Date(),
          config: input.effortChoice
            ? withChatEffortChoice(turnConfig, input.effortChoice)
            : turnConfig,
        })
        .where(
          and(
            eq(copilotChats.id, chatId),
            eq(copilotChats.userId, userId),
            workspaceId
              ? eq(copilotChats.workspaceId, workspaceId)
              : isNull(copilotChats.workspaceId),
            organizationId
              ? eq(copilotChats.organizationId, organizationId)
              : isNull(copilotChats.organizationId),
            isNull(copilotChats.deletedAt)
          )
        )
        .returning({ model: copilotChats.model })
      if (!chat) throw new OrchestrationError('not_found', 'Chat not found')
      await appendCopilotChatMessages(
        chatId,
        [buildPersistedUserMessage(input.message)],
        { streamId: request.messageId, chatModel: chat.model },
        tx
      )
      const run = await insertRunSegment(tx, {
        id: input.runId,
        executionId: input.executionId,
        chatId,
        userId,
        workspaceId,
        organizationId,
        streamId: request.messageId,
        workflowId: request.workflowId,
        desktopDeviceId,
        requestContext: {
          requestId: input.requestId,
          controllerToken: input.lease.value,
          ...(local ? { localExecution: LOCAL_CHAT_EXECUTION } : { recovery }),
        },
      })
      const [claim] = await tx
        .update(idempotencyKey)
        .set({
          result: {
            success: true,
            status: 'completed',
            result: { chatId },
            claimToken: input.sendClaim.claimToken,
          },
          createdAt: new Date(),
        })
        .where(
          and(
            eq(idempotencyKey.key, input.sendClaim.normalizedKey),
            sql`${idempotencyKey.result} ->> 'claimToken' = ${input.sendClaim.claimToken}`
          )
        )
        .returning({ key: idempotencyKey.key })
      if (!claim) throw new ChatSendSupersededError()
      return run
    })
  },
  async afterSuccess({ context, input, result }) {
    if (!input.notifyWorkspaceStatus) return
    try {
      publishChatStatusChanged(
        {
          workspaceId: context.workspaceId,
          organizationId: context.organizationId,
          userId: context.userId,
        },
        {
          chatId: context.chatId,
          type: 'started',
          streamId:
            classifyRunExecution(result.requestContext) === 'local'
              ? result.streamId
              : input.message.id,
        }
      )
    } catch (error) {
      createLogger('ChatAdmission').warn('Could not publish admitted chat status', {
        error: getErrorMessage(error),
      })
    }
  },
})
