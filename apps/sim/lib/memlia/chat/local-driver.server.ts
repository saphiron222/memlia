// Copyright (c) 2026 Memlia. All rights reserved.
import { generateId } from '@sim/utils/id'
import { WORKFLOW_PROPOSAL_TOOL_NAME } from '@/lib/api/contracts/copilot'
import { stringifyBoundedJson } from '@/lib/core/utils/bounded-json'
import { waitWithAbort } from '@/lib/core/utils/concurrency'
import {
  type BudgetedCatalogProviderOptions,
  runBudgetedCatalogProvider,
} from '@/lib/memlia/ai/budgeted-catalog-provider.server'
import {
  applyStreamEvent,
  prePersistClientExecutableToolCall,
} from '@/lib/mothership/request/handlers'
import { getToolCallStateOutput } from '@/lib/mothership/request/tool-call-state'
import type {
  ExecutionContext,
  OrchestratorOptions,
  StreamEvent,
  StreamingContext,
} from '@/lib/mothership/request/types'
import { catalogToolInputs } from './catalog-tools'

export type LocalChatOptions = Omit<BudgetedCatalogProviderOptions, 'signal' | 'proposal'>
const unavailable = () => new Error('Local Chat is unavailable.')
const readTools = new Set([
  ...Object.keys(catalogToolInputs),
  'read_workflow',
  'read_workflow_block',
  'preview_workflow_operations',
])

/** Own JSON before the lifecycle's first await. Not authentication or permission to send. */
export function captureLocalChatOptions(raw: LocalChatOptions): LocalChatOptions {
  try {
    const json = stringifyBoundedJson(raw, 2 * 1024 * 1024, { strict: true })
    if (json === undefined) throw unavailable()
    const owned: LocalChatOptions = JSON.parse(json)
    if (
      !owned ||
      Object.keys(owned).some(
        (k) => !['principal', 'workspaceId', 'workflow', 'request', 'budget', 'limits'].includes(k)
      ) ||
      owned.principal?.kind !== 'session' ||
      !owned.principal.userId ||
      !owned.principal.sessionId ||
      !owned.workspaceId ||
      !owned.workflow?.workflowId ||
      owned.workflow.policy !== 'sanitized_details' ||
      owned.workflow.previewOperations !== true ||
      !owned.request ||
      !owned.request.apiKey ||
      !Array.isArray(owned.request.messages) ||
      owned.request.messages.some(
        (m) =>
          !m ||
          Object.keys(m).some((k) => !['role', 'content'].includes(k)) ||
          !['user', 'assistant', 'system'].includes(m.role) ||
          typeof m.content !== 'string'
      )
    )
      throw unavailable()
    for (const [key, max] of Object.entries({
      maxModelCalls: 12,
      maxToolCalls: 40,
      maxDurationMs: 180000,
    })) {
      const limit = owned.limits?.[key as keyof NonNullable<LocalChatOptions['limits']>]
      if (
        limit !== undefined &&
        (!Number.isSafeInteger(limit) || limit < (key === 'maxToolCalls' ? 0 : 1) || limit > max)
      )
        throw unavailable()
    }
    return owned
  } catch {
    throw unavailable()
  }
}

/** Native lifecycle branch: no worker, recovery, title call, direct apply or external retry. */
export async function runLocalChat(
  raw: LocalChatOptions,
  context: StreamingContext,
  exec: ExecutionContext,
  options: OrchestratorOptions
): Promise<void> {
  const input = captureLocalChatOptions(raw)
  const runId = context.runId
  if (
    !runId ||
    exec.organizationId ||
    exec.userId !== input.principal.userId ||
    exec.workspaceId !== input.workspaceId ||
    exec.workflowId !== input.workflow?.workflowId ||
    exec.runId !== runId ||
    options.interactive !== true ||
    options.autoExecuteTools === false ||
    !context.toolPermissions.enabled ||
    !options.onEvent
  )
    throw unavailable()
  let closed = false
  const scopeIntact = () => {
    if (
      closed ||
      exec.organizationId ||
      context.runId !== runId ||
      exec.userId !== input.principal.userId ||
      exec.workspaceId !== input.workspaceId ||
      exec.workflowId !== input.workflow?.workflowId ||
      exec.runId !== runId ||
      !context.toolPermissions.enabled
    )
      throw unavailable()
  }
  const onEvent = options.onEvent
  const assertOwnership = options.assertControllerOwnership
  const parentSignal = options.abortSignal
  const stop = new AbortController()
  const abort = () => stop.abort(unavailable())
  parentSignal?.addEventListener('abort', abort, { once: true })
  if (parentSignal?.aborted) abort()
  const seen = new Set<string>()
  const presented = new Map<string, { id: string; name: string }>()
  let reader:
    | ReadableStreamDefaultReader<import('@/providers/stream-events').AgentStreamEvent>
    | undefined
  let final = false
  async function publish(event: StreamEvent, signal = stop.signal) {
    signal.throwIfAborted()
    scopeIntact()
    await assertOwnership?.()
    scopeIntact()
    signal.throwIfAborted()
    // Keep the enriched handler frame private: publishers may normalize/mutate their copy.
    try {
      await onEvent(structuredClone(event))
      scopeIntact()
    } catch {
      abort()
      throw unavailable()
    }
    signal.throwIfAborted()
  }
  async function deliver(event: StreamEvent, signal = stop.signal) {
    const nativeOptions = {
      ...options,
      abortSignal: signal,
      onEvent: (e: StreamEvent) => publish(e, signal),
    }
    scopeIntact()
    await prePersistClientExecutableToolCall(event, context, nativeOptions, exec)
    scopeIntact()
    await publish(event, signal)
    await applyStreamEvent(event, context, exec, nativeOptions)
  }
  try {
    stop.signal.throwIfAborted()
    const run = await waitWithAbort(
      runBudgetedCatalogProvider({
        ...input,
        signal: stop.signal,
        proposal: {
          runId,
          async onProposal(proposal, signal) {
            try {
              signal.throwIfAborted()
              const id = proposal.proposalId
              const revision = proposal.expectedRevision
              if (
                closed ||
                final ||
                seen.has(id) ||
                context.runId !== runId ||
                proposal.authorUserId !== input.principal.userId ||
                proposal.workspaceId !== input.workspaceId ||
                proposal.workflowId !== input.workflow?.workflowId
              )
                throw unavailable()
              seen.add(id)
              await deliver(
                {
                  type: 'tool',
                  payload: {
                    phase: 'call',
                    toolCallId: id,
                    toolName: WORKFLOW_PROPOSAL_TOOL_NAME,
                    executor: 'sim',
                    mode: 'async',
                  },
                },
                signal
              )
              // A synchronously settled gate may already have removed its pending promise.
              // Its canonical terminal state, not a transport 'success', is the receipt.
              const pending = context.pendingToolPromises.get(id)
              if (pending) await waitWithAbort(pending, signal)
              signal.throwIfAborted()
              scopeIntact()
              const call = context.toolCalls.get(id)
              if (!call || call.name !== WORKFLOW_PROPOSAL_TOOL_NAME) throw unavailable()
              if (call.status === 'skipped') return { status: 'skipped' }
              const result = getToolCallStateOutput(call)
              if (
                call.status !== 'success' ||
                !result ||
                typeof result !== 'object' ||
                !('status' in result) ||
                result.status !== 'applied' ||
                !('baseRevision' in result) ||
                result.baseRevision !== revision ||
                !('draftRevision' in result) ||
                typeof result.draftRevision !== 'number' ||
                !Number.isSafeInteger(result.draftRevision) ||
                result.draftRevision < revision
              )
                throw unavailable()
              return {
                status: 'applied',
                baseRevision: revision,
                draftRevision: result.draftRevision,
              }
            } catch {
              // Effect may already have begun: stop synthesis/tools; never replay the intent.
              abort()
              throw unavailable()
            }
          },
        },
      }),
      stop.signal
    )
    reader = run.stream.getReader()
    for (;;) {
      const next = await waitWithAbort(reader.read(), stop.signal)
      if (next.done) break
      if (final) throw unavailable()
      const event = next.value
      if (event.type === 'turn_end') {
        final = event.turn === 'final'
        continue
      }
      if (event.type === 'text_delta' || event.type === 'thinking_delta') {
        await deliver({
          type: 'text',
          payload: {
            channel: event.type === 'thinking_delta' ? 'thinking' : 'assistant',
            text: event.text,
          },
        })
      } else if (event.type === 'tool_call_start') {
        // Intent transport events have no authority and never create an approval card.
        if (event.name === 'propose_workflow_operations') continue
        if (!readTools.has(event.name) || presented.has(event.id)) throw unavailable()
        const call = { id: generateId(), name: event.name }
        presented.set(event.id, call)
        await deliver({
          type: 'tool',
          payload: {
            phase: 'call',
            toolCallId: call.id,
            toolName: call.name,
            executor: 'sim',
            mode: 'sync',
            ui: { inbandOwned: true },
          },
        })
      } else if (event.type === 'tool_call_end') {
        if (event.name === 'propose_workflow_operations') continue
        const call = presented.get(event.id)
        if (!call || call.name !== event.name) throw unavailable()
        presented.delete(event.id)
        await deliver({
          type: 'tool',
          payload: {
            phase: 'result',
            toolCallId: call.id,
            toolName: call.name,
            executor: 'sim',
            mode: 'sync',
            status: event.status,
            success: event.status === 'success',
          },
        })
      } else throw unavailable()
    }
    if (!final || presented.size) throw unavailable()
    await deliver({ type: 'complete', payload: { status: 'complete' } })
  } catch {
    abort()
    throw unavailable()
  } finally {
    closed = true
    parentSignal?.removeEventListener('abort', abort)
    // Cancellation has no authority to undo an effect or release known spend.
    await reader?.cancel(unavailable()).catch(() => {})
    reader?.releaseLock()
  }
}
