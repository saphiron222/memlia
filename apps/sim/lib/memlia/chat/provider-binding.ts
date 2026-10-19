// Copyright (c) 2026 Memlia. All rights reserved.

import { z } from 'zod'
import { workflowIdParamsSchema } from '@/lib/api/contracts/workflows'
import type { StreamingExecution } from '@/executor/types'
import { anthropicProvider } from '@/providers/anthropic'
import { openaiProvider } from '@/providers/openai'
import {
  type ProviderToolExecutionResult,
  runWithProviderRuntimeContext,
} from '@/providers/runtime-context'
import type { AgentStreamEvent } from '@/providers/stream-events'
import type { ProviderRequest, ProviderToolConfig } from '@/providers/types'
import { catalogToolInputs, createCatalogTools } from './catalog-tools'
import { type ModelRunLimits, runModelAdapter } from './model-adapter'
import { createWorkflowPreviewTools, workflowPreviewInputs } from './workflow-preview-tools'
import { createWorkflowReadTools, workflowReadInputs } from './workflow-read-tools'

const workflowBinding = z
  .object({
    workflowId: workflowIdParamsSchema.shape.id,
    policy: z.enum(['summary_only', 'sanitized_details']),
    previewOperations: z.literal(true).optional(),
  })
  .strict()
  .refine((value) => !value.previewOperations || value.policy === 'sanitized_details')
const workflowInput = z.object({ request: workflowReadInputs.read_workflow }).strict()
// Validate the wrapper only here; the preview owns and validates the original body
// with the exact v2 schema before any await, without prior lossy Zod defaults.
const workflowPreviewInput = z.object({ request: z.unknown() }).strict()
const workflowBlockInput = z.object({ request: workflowReadInputs.read_workflow_block }).strict()

type CatalogProviderOptions = Parameters<typeof createCatalogTools>[0] & {
  provider: 'openai' | 'anthropic'
  request: Pick<
    ProviderRequest,
    | 'model'
    | 'apiKey'
    | 'messages'
    | 'systemPrompt'
    | 'temperature'
    | 'maxTokens'
    | 'reasoningEffort'
    | 'thinkingLevel'
  >
  limits?: Partial<ModelRunLimits>
  signal?: AbortSignal
  /** Explicit server policy only; absence never grants workflow reads. */
  workflow?: z.input<typeof workflowBinding>
}

/** Server-only binding; no ambient workflow identity, tools or conversation compactor is inherited. */
export function runCatalogProvider(options: CatalogProviderOptions) {
  const selection = workflowBinding.optional().safeParse(options.workflow)
  if (!selection.success) throw new Error('Invalid workflow read binding.')
  const workflow = selection.data
  const provider =
    options.provider === 'openai'
      ? openaiProvider
      : options.provider === 'anthropic'
        ? anthropicProvider
        : undefined
  if (!provider) throw new Error('Unsupported catalogue model provider.')
  if (options.request.messages?.some((message) => message.files?.length))
    throw new Error('Catalogue model attachments are not supported.')
  const catalog = createCatalogTools(options)
  const workflowReads = workflow
    ? createWorkflowReadTools({
        principal: options.principal,
        workspaceId: options.workspaceId,
        workflowId: workflow.workflowId,
      })
    : undefined
  const workflowPreview = workflow?.previewOperations
    ? createWorkflowPreviewTools({
        principal: options.principal,
        workspaceId: options.workspaceId,
        workflowId: workflow.workflowId,
      })
    : undefined
  const tools: ProviderToolConfig[] = Object.entries(catalogToolInputs).map(([id, schema]) => {
    const json = z.toJSONSchema(schema, { io: 'input' })
    return {
      id,
      description: `Read the authorized workflow catalogue: ${id}.`,
      params: {},
      parameters: {
        type: 'object',
        properties: json.properties ?? {},
        required: json.required ?? [],
      },
    }
  })
  if (workflow) {
    const native = jsonInput(workflowReadInputs.read_workflow)
    const input =
      workflow.policy === 'summary_only'
        ? (native.anyOf ?? native.oneOf)?.find((branch) => {
            const view = branch.properties?.view
            return typeof view === 'object' && view !== null && view.const === 'summary'
          })
        : native
    if (!input) throw new Error('Unsupported workflow read schema.')
    // Native Anthropic drops root unions; a property preserves the original schema.
    tools.push({
      id: 'read_workflow',
      description:
        'Read the server-selected workflow. Keep the observed expectedRevision for subsequent pages and sections.',
      params: {},
      parameters: { type: 'object', properties: { request: input }, required: ['request'] },
    })
    if (workflow.policy === 'sanitized_details')
      tools.push({
        id: 'read_workflow_block',
        description:
          'Read one sanitized block of the server-selected workflow at an optional expectedRevision.',
        params: {},
        parameters: {
          type: 'object',
          properties: { request: jsonInput(workflowReadInputs.read_workflow_block) },
          required: ['request'],
        },
      })
  }

  if (workflowPreview)
    tools.push({
      id: 'preview_workflow_operations',
      description:
        'Evaluate operations on the server-selected workflow at the required expectedRevision. Dry run only: no persistence or execution; diagnostics are best effort.',
      params: {},
      parameters: {
        type: 'object',
        properties: { request: previewJsonInput() },
        required: ['request'],
      },
    })

  async function previewWorkflow(params: unknown, signal: AbortSignal) {
    const parsed = workflowPreviewInput.safeParse(params)
    if (!parsed.success || !Object.hasOwn(parsed.data, 'request'))
      return workflowFailure('invalid_input')
    if (!workflowPreview) return workflowFailure('forbidden')
    return workflowPreview.dispatch('preview_workflow_operations', parsed.data.request, signal)
  }

  async function readWorkflow(toolId: string, params: unknown, signal: AbortSignal) {
    const parsed = (toolId === 'read_workflow' ? workflowInput : workflowBlockInput).safeParse(
      params
    )
    if (!parsed.success) return workflowFailure('invalid_input')
    if (
      !workflowReads ||
      (workflow?.policy === 'summary_only' &&
        (toolId === 'read_workflow_block' ||
          ('view' in parsed.data.request && parsed.data.request.view !== 'summary')))
    )
      return workflowFailure('forbidden')
    return workflowReads.dispatch(toolId, parsed.data.request, signal)
  }

  return runModelAdapter<AgentStreamEvent, ProviderToolExecutionResult>({
    limits: options.limits,
    signal: options.signal,
    allowedTools: tools.map((tool) => tool.id),
    async dispatch(toolId, params, signal) {
      // Added by Sim's native prepareToolExecution, never an authority input.
      const { _toolSchema: _schema, ...modelParams } = params
      const previewCall = Boolean(workflowPreview) && toolId === 'preview_workflow_operations'
      const workflowCall =
        previewCall ||
        (Boolean(workflowReads) && (toolId === 'read_workflow' || toolId === 'read_workflow_block'))
      const result = previewCall
        ? await previewWorkflow(modelParams, signal)
        : workflowCall
          ? await readWorkflow(toolId, modelParams, signal)
          : await catalog.dispatch(toolId, modelParams, signal)
      const refusal = !result.ok
        ? {
            error: result.error,
            ...('diagnostics' in result ? { diagnostics: result.diagnostics } : {}),
          }
        : {}
      const response = result.ok
        ? { success: true, output: result.data }
        : { success: false, output: refusal, error: result.error.message }
      // Native error formatting drops structured output. Preserve a refusal as
      // model data, while raw failure still controls the provider error events.
      const modelResponse =
        workflowCall && !result.ok ? { success: true, output: { ok: false, ...refusal } } : response
      return { rawResponse: response, modelResponse }
    },
    start(controls) {
      const context = { controlledRun: controls }
      const {
        model,
        apiKey,
        systemPrompt,
        temperature,
        maxTokens,
        reasoningEffort,
        thinkingLevel,
      } = options.request
      const request: ProviderRequest = {
        model,
        apiKey,
        systemPrompt,
        temperature,
        maxTokens: maxTokens ?? 2048,
        reasoningEffort,
        thinkingLevel,
        messages: options.request.messages?.map(({ role, content }) => ({ role, content })),
        tools,
        stream: true,
        agentEvents: true,
        abortSignal: controls.signal,
      }
      let reader: ReadableStreamDefaultReader<AgentStreamEvent> | undefined
      return new ReadableStream<AgentStreamEvent>(
        {
          async start() {
            const result = await runWithProviderRuntimeContext(context, () =>
              provider.executeRequest(request)
            )
            if (!('stream' in result) || result.streamFormat !== 'agent-events-v1')
              throw new Error('Catalogue provider did not return the supported event stream.')
            const stream = (result as StreamingExecution).stream as ReadableStream<AgentStreamEvent>
            if (controls.signal.aborted) {
              await stream.cancel(controls.signal.reason)
              controls.signal.throwIfAborted()
            }
            reader = stream.getReader()
          },
          async pull(controller) {
            const next = await runWithProviderRuntimeContext(context, () => reader!.read())
            if (next.done) {
              reader!.releaseLock()
              controller.close()
            } else controller.enqueue(next.value)
          },
          cancel(reason) {
            return reader?.cancel(reason)
          },
        },
        { highWaterMark: 0 }
      )
    },
  })
}

function jsonInput(schema: z.ZodType) {
  const { $schema: _dialect, ...native } = z.toJSONSchema(schema, { io: 'input' })
  return native
}
function workflowFailure(code: 'invalid_input' | 'forbidden') {
  return { ok: false as const, error: { code, message: 'Workflow read could not complete.' } }
}

/** Keep the native definitions with the body; SDK formatters discard root $defs. */
function previewJsonInput() {
  const native = jsonInput(workflowPreviewInputs.preview_workflow_operations)
  const pending: unknown[] = [native]
  while (pending.length) {
    const node = pending.pop()
    if (!node || typeof node !== 'object') continue
    for (const [key, value] of Object.entries(node)) {
      // These are instance/annotation data, never schema reference locations.
      if (key === 'examples' || key === 'default' || key === 'const' || key === 'enum') continue
      if (key !== '$ref') {
        pending.push(value)
        continue
      }
      if (typeof value !== 'string' || !/^#\/\$defs\/[^/]+$/.test(value) || /~(?![01])/.test(value))
        throw new Error('Unsupported workflow preview schema reference.')
      let target: unknown = native
      for (const part of value.slice(2).split('/')) {
        const field = part.replace(/~1/g, '/').replace(/~0/g, '~')
        if (!target || typeof target !== 'object' || !Object.hasOwn(target, field))
          throw new Error('Unsupported workflow preview schema reference.')
        target = (target as Record<string, unknown>)[field]
      }
      if (
        typeof target !== 'boolean' &&
        (!target || typeof target !== 'object' || Array.isArray(target))
      )
        throw new Error('Unsupported workflow preview schema reference.')
      // Generated schema is privately owned; constraints/definitions remain identical.
      const record = node as Record<string, unknown>
      record.$ref = `#/properties/request${value.slice(1)}`
    }
  }
  return native
}
