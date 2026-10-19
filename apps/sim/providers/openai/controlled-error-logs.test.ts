// Copyright 2026 Memlia. All rights reserved.
import type { Logger } from '@sim/logger'
import { providersMock } from '@sim/testing/mocks/providers.mock'
import { providersUtilsMock, providersUtilsMockFns } from '@sim/testing/mocks/providers-utils.mock'
import { toolsMock, toolsMockFns } from '@sim/testing/mocks/tools.mock'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isProviderConversationCaptureEnabled,
  recordProviderConversationToolError,
} from '@/providers/conversation-history'
import { executeResponsesProviderRequest } from '@/providers/openai/core'
import { createOpenAIResponsesStreamingToolLoopStream } from '@/providers/openai/streaming-tool-loop'
import { runWithProviderRuntimeContext } from '@/providers/runtime-context'
import type { ProviderRequest } from '@/providers/types'

// Provider loops, SSE parser, ALS, error objects and logger serialization are native.
// HTTP and unrelated model/tool infrastructure are the existing native test doubles.
vi.mock('@/providers', () => providersMock)
vi.mock('@/providers/utils', () => providersUtilsMock)
vi.mock('@/tools', () => toolsMock)
vi.unmock('@sim/logger')

const marker = 'FICTITIOUS_CONTROLLED_ERROR_CONTENT'
let logger: Logger
let lines: string[]
beforeEach(async () => {
  const native = await vi.importActual<typeof import('@sim/logger')>('@sim/logger')
  logger = native.createLogger('OpenAIProvider', {
    colorize: false,
    logLevel: 'ERROR',
    enabled: true,
  })
  lines = []
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    lines.push(
      args.map((value) => (typeof value === 'string' ? value : JSON.stringify(value))).join(' ')
    )
  })
  providersUtilsMockFns.mockPrepareToolsWithUsageControl.mockImplementation((tools) => ({
    tools,
    toolChoice: undefined,
    forcedTools: [],
    hasFilteredTools: false,
  }))
  providersUtilsMockFns.mockSupportsReasoningEffort.mockReturnValue(true)
  toolsMockFns.mockExecuteTool.mockRejectedValue(new Error(marker))
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function controls() {
  return {
    signal: new AbortController().signal,
    beforeModelCall() {},
    executeTool: async () => {
      throw new Error(marker)
    },
  }
}
function within<T>(controlled: boolean, run: () => T): T {
  return runWithProviderRuntimeContext(controlled ? { controlledRun: controls() } : undefined, run)
}
function call(controlled: boolean, transport: typeof fetch, extra: Partial<ProviderRequest> = {}) {
  return within(controlled, () =>
    executeResponsesProviderRequest(
      {
        apiKey: 'FICTIVE_MEMLIA_TEST_ONLY',
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'fixture input' }],
        ...extra,
      },
      {
        providerId: 'openai',
        providerLabel: 'OpenAI',
        modelName: 'gpt-4o',
        endpoint: 'http://127.0.0.1:1/unused-http-double',
        headers: {},
        fetch: transport,
        logger,
      }
    )
  )
}
function assertProjection(controlled: boolean) {
  expect(lines.length > 0).toBe(true)
  expect(lines.some((line) => line.includes(marker))).toBe(!controlled)
  if (controlled)
    for (const line of lines) {
      const entry = JSON.parse(line)
      expect(Object.keys(entry).sort()).toEqual(['code', 'level', 'message', 'module', 'timestamp'])
      expect(entry.code).toMatch(/^OPENAI_CONTROLLED_[A-Z_]+$/)
    }
}
function terminal(output: unknown[]) {
  return {
    id: 'fixture',
    status: 'completed',
    output,
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  }
}
function sse(output: unknown[]) {
  return new Response(
    `data: ${JSON.stringify({ type: 'response.completed', response: terminal(output) })}\n\n`,
    { headers: { 'Content-Type': 'text/event-stream' } }
  )
}
async function consume(stream: ReadableStream) {
  const reader = stream.getReader()
  try {
    while (!(await reader.read()).done) {}
  } finally {
    reader.releaseLock()
  }
}

describe('controlled OpenAI error diagnostics with the native logger', () => {
  for (const controlled of [true, false]) {
    it.each([true, false])(
      `HTTP400 preserves the caller error and closes logs controlled=${controlled}, stream=%s`,
      async (stream) => {
        const http = vi.fn(
          async () =>
            new Response(JSON.stringify({ error: { message: marker } }), {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            })
        )
        const failure = await call(controlled, http, { stream }).catch((error) => error)
        expect(failure instanceof Error).toBe(true)
        expect(failure.message.includes(marker)).toBe(true)
        expect(failure.cause instanceof Error).toBe(true)
        expect(http).toHaveBeenCalledTimes(1)
        assertProjection(controlled)
      }
    )
    it(`preserves the native abort annotation and its cause controlled=${controlled}`, async () => {
      const failure = new DOMException(marker, 'AbortError')
      const http = vi.fn(async () => {
        throw failure
      })
      const observed = await call(controlled, http).catch((error) => error)
      expect(observed.cause === failure).toBe(true)
      expect(observed.name).toBe('AbortError')
      expect(http).toHaveBeenCalledTimes(1)
      assertProjection(controlled)
    })
    it.each([true, false])(
      `tool error logs controlled=${controlled}, streaming=%s`,
      async (streaming) => {
        const tool = {
          type: 'function_call',
          call_id: 'fixture_call',
          name: 'fixture_tool',
          arguments: '{}',
        }
        const http = vi
          .fn()
          .mockResolvedValueOnce(streaming ? sse([tool]) : Response.json(terminal([tool])))
          .mockResolvedValueOnce(streaming ? sse([]) : Response.json(terminal([])))
        const result = await call(controlled, http, {
          stream: streaming,
          agentEvents: true,
          tools: [
            {
              id: 'fixture_tool',
              description: 'Fixture',
              parameters: { type: 'object', properties: {} },
            },
          ],
        })
        if ('stream' in result) await consume(result.stream)
        expect(http).toHaveBeenCalledTimes(2)
        assertProjection(controlled)
      }
    )
    it(`stream termination preserves the exact failure controlled=${controlled}`, async () => {
      const failure = new Error(marker)
      const stream = within(controlled, () =>
        createOpenAIResponsesStreamingToolLoopStream({
          providerId: 'openai',
          providerLabel: 'OpenAI',
          request: { model: 'gpt-4o', messages: [] },
          initialInput: [],
          createStream: async () => {
            throw failure
          },
          logger,
          timeSegments: [],
          onComplete() {},
        })
      )
      expect(await consume(stream).catch((error) => error)).toBe(failure)
      assertProjection(controlled)
    })
    it(`last-resort callback diagnostic remains closed controlled=${controlled}`, async () => {
      const failure = new Error(marker)
      const stream = within(controlled, () =>
        createOpenAIResponsesStreamingToolLoopStream({
          providerId: 'openai',
          providerLabel: 'OpenAI',
          request: { model: 'gpt-4o', messages: [] },
          initialInput: [],
          createStream: async () => {
            throw failure
          },
          logger,
          timeSegments: [],
          onComplete() {
            throw failure
          },
        })
      )
      await vi.waitFor(() => expect(lines.length > 0).toBe(true))
      await stream.cancel()
      assertProjection(controlled)
    })
  }
  it('retains the captured closed tool policy after a context mutation during the first response', async () => {
    let release!: (response: Response) => void
    const first = new Promise<Response>((resolve) => {
      release = resolve
    })
    const context: { controlledRun?: ReturnType<typeof controls> } = { controlledRun: controls() }
    const createStream = vi.fn().mockReturnValueOnce(first).mockResolvedValueOnce(sse([]))
    const stream = runWithProviderRuntimeContext(context, () =>
      createOpenAIResponsesStreamingToolLoopStream({
        providerId: 'openai',
        providerLabel: 'OpenAI',
        request: {
          model: 'gpt-4o',
          messages: [],
          tools: [
            {
              id: 'fixture_tool',
              description: 'Fixture',
              parameters: { type: 'object', properties: {} },
            },
          ],
        },
        initialInput: [],
        createStream,
        logger,
        timeSegments: [],
        onComplete() {},
      })
    )
    context.controlledRun = undefined
    release(
      sse([
        { type: 'function_call', call_id: 'fixture_call', name: 'fixture_tool', arguments: '{}' },
      ])
    )
    await consume(stream)
    expect(createStream).toHaveBeenCalledTimes(2)
    assertProjection(true)
  })
  for (const controlled of [true, false]) {
    it.each(['transport', 'status'] as const)(
      `native retry log projection controlled=${controlled}, %s`,
      async (kind) => {
        vi.useFakeTimers()
        const native = await vi.importActual<typeof import('@sim/logger')>('@sim/logger')
        logger = native.createLogger('OpenAIProvider', {
          enabled: true,
          colorize: false,
          logLevel: 'WARN',
        })
        vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
          lines.push(
            args
              .map((value) => (typeof value === 'string' ? value : JSON.stringify(value)))
              .join(' ')
          )
        })
        const http = vi.fn()
        if (kind === 'transport')
          http.mockRejectedValueOnce(Object.assign(new Error(marker), { code: 'ECONNRESET' }))
        else
          http.mockResolvedValueOnce(
            new Response(null, { status: 503, headers: { 'x-request-id': marker } })
          )
        http.mockResolvedValueOnce(Response.json({ error: { message: marker } }, { status: 400 }))
        const outcome = call(controlled, http).catch((error) => error)
        await vi.runAllTimersAsync()
        const failure = await outcome
        expect(failure instanceof Error).toBe(true)
        expect(http).toHaveBeenCalledTimes(2)
        expect(lines.some((line) => line.includes(marker))).toBe(!controlled)
        const warning = lines
          .map((line) => JSON.parse(line))
          .find((entry) => entry.level === 'WARN')
        expect(warning !== undefined).toBe(true)
        if (controlled) {
          expect(warning.code).toBe('CONTROLLED_PROVIDER_RETRY')
          expect(Object.keys(warning).sort()).toEqual([
            'attempt',
            'code',
            'delayMs',
            'level',
            'maxRetries',
            'message',
            'module',
            'timestamp',
          ])
        }
      }
    )
  }
  it.each([true, false])(
    'does not log a provider-supplied terminal status controlled=%s',
    async (controlled) => {
      const native = await vi.importActual<typeof import('@sim/logger')>('@sim/logger')
      logger = native.createLogger('OpenAIProvider', {
        enabled: true,
        colorize: false,
        logLevel: 'WARN',
      })
      vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        lines.push(
          args.map((value) => (typeof value === 'string' ? value : JSON.stringify(value))).join(' ')
        )
      })
      const body = {
        ...terminal([
          { type: 'function_call', call_id: 'fixture_call', name: 'fixture_tool', arguments: '{}' },
        ]),
        status: marker,
      }
      const stream = within(controlled, () =>
        createOpenAIResponsesStreamingToolLoopStream({
          providerId: 'openai',
          providerLabel: 'OpenAI',
          request: { model: 'gpt-4o', messages: [] },
          initialInput: [],
          createStream: async () =>
            new Response(
              `data: ${JSON.stringify({ type: 'response.completed', response: body })}\n\n`,
              { headers: { 'Content-Type': 'text/event-stream' } }
            ),
          logger,
          timeSegments: [],
          onComplete() {},
        })
      )
      await consume(stream)
      expect(lines.some((line) => line.includes(marker))).toBe(!controlled)
      const warning = lines.map((line) => JSON.parse(line)).find((entry) => entry.level === 'WARN')
      expect(warning !== undefined).toBe(true)
      if (controlled) expect(warning.code).toBe('OPENAI_CONTROLLED_TOOL_SKIPPED')
    }
  )
  it('the closed binding context shape does not inherit ambient conversation error capture', async () => {
    const recordToolError = vi.fn()
    const request = { model: 'gpt-4o', messages: [] }
    await runWithProviderRuntimeContext({ agentConversation: { recordToolError } as never }, () =>
      within(true, async () => {
        expect(isProviderConversationCaptureEnabled(request)).toBe(false)
        await recordProviderConversationToolError(request, 'fixture', 'fixture_tool', marker)
      })
    )
    expect(recordToolError).not.toHaveBeenCalled()
  })
})
