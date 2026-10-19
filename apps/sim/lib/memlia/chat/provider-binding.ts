// Copyright (c) 2026 Memlia. All rights reserved.

import { z } from 'zod'
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
}

/** Server-only binding; no ambient workflow identity, tools or conversation compactor is inherited. */
export function runCatalogProvider(options: CatalogProviderOptions) {
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

  return runModelAdapter<AgentStreamEvent, ProviderToolExecutionResult>({
    limits: options.limits,
    signal: options.signal,
    allowedTools: tools.map((tool) => tool.id),
    async dispatch(toolId, params, signal) {
      // Added by Sim's native prepareToolExecution, never an authority input.
      const { _toolSchema: _schema, ...modelParams } = params
      const result = await catalog.dispatch(toolId, modelParams, signal)
      const response = result.ok
        ? { success: true, output: result.data }
        : { success: false, output: { error: result.error }, error: result.error.message }
      return { rawResponse: response, modelResponse: response }
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
