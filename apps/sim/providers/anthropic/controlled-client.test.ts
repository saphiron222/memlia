// Copyright (c) 2026 Memlia. All rights reserved.

import { toolsMock } from '@sim/testing/mocks/tools.mock'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { anthropicProvider } from '@/providers/anthropic'
import { clearProviderClientCacheForTests } from '@/providers/client-cache'
import { runWithProviderRuntimeContext } from '@/providers/runtime-context'
import { createControlledAnthropicClient } from './controlled-client'

// Real SDK, cache and provider loop. HTTP, DB/auth globals and business tools are doubles.
vi.mock('@/providers', () => ({ MAX_TOOL_ITERATIONS: 1 }))
vi.mock('@/tools', () => toolsMock)

const apiKey = 'FICTITIOUS_MEMLIA_EXPLICIT_KEY'

function message() {
  return new Response(
    JSON.stringify({
      id: 'msg_fixture',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text: 'Fixture only' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { headers: { 'Content-Type': 'application/json' } }
  )
}
const request = {
  model: 'claude-sonnet-4-5',
  max_tokens: 16,
  messages: [{ role: 'user' as const, content: 'Fixture only' }],
}

beforeEach(() => {
  clearProviderClientCacheForTests()
  vi.stubEnv('ANTHROPIC_BASE_URL', 'https://fictitious-ambient.invalid')
  vi.stubEnv('ANTHROPIC_API_KEY', 'FICTITIOUS_AMBIENT_KEY')
  vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'FICTITIOUS_AMBIENT_TOKEN')
  vi.stubEnv('ANTHROPIC_WEBHOOK_SIGNING_KEY', 'FICTITIOUS_AMBIENT_WEBHOOK')
  vi.stubEnv('ANTHROPIC_CUSTOM_HEADERS', '')
  vi.stubEnv('ANTHROPIC_LOG', 'off')
})
afterEach(() => {
  clearProviderClientCacheForTests()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('controlled Anthropic client — actual SDK with HTTP doubles', () => {
  it('sends only the explicit key to the official destination with redirects disabled', async () => {
    const http = vi.fn<typeof fetch>(async () => message())
    vi.stubGlobal('fetch', http)
    const response = await createControlledAnthropicClient(apiKey).messages.create(request)
    expect(response.content).toEqual([{ type: 'text', text: 'Fixture only' }])
    expect(http).toHaveBeenCalledTimes(1)
    expect(String(http.mock.calls[0][0])).toBe('https://api.anthropic.com/v1/messages')
    const init = http.mock.calls[0][1]
    const headers = new Headers(init?.headers)
    expect(headers.get('x-api-key')).toBe(apiKey)
    expect(headers.has('authorization')).toBe(false)
    expect(init?.redirect).toBe('error')
  })

  it.each([
    'X-Api-Key: FICTITIOUS_OVERRIDE',
    ' ',
    '\n',
    'X-Fictitious: '.concat('x'.repeat(65536)),
  ])('refuses ambient custom headers before client construction or HTTP', (customHeaders) => {
    const http = vi.fn<typeof fetch>(async () => message())
    vi.stubGlobal('fetch', http)
    vi.stubEnv('ANTHROPIC_CUSTOM_HEADERS', customHeaders)
    expect(() => createControlledAnthropicClient(apiKey)).toThrow(
      new Error('Controlled Anthropic transport is unavailable.')
    )
    expect(http).not.toHaveBeenCalled()
  })

  it.each([
    undefined,
    null,
    {},
    '',
    ' \t\n',
    'FICTITIOUS\r\nKEY',
    'FICTITIOUS\0KEY',
    'FICTITIOUS_\u0100',
  ])(
    'rejects an invalid explicit key instead of letting the SDK resolve ambient credentials',
    (key) => {
      const http = vi.fn<typeof fetch>(async () => message())
      vi.stubGlobal('fetch', http)
      expect(() => Reflect.apply(createControlledAnthropicClient, undefined, [key])).toThrow(
        new Error('Controlled Anthropic transport is unavailable.')
      )
      expect(http).not.toHaveBeenCalled()
    }
  )

  it('ignores the old native cache only during controlled runs and preserves it afterwards', async () => {
    const http = vi.fn<typeof fetch>(async () => message())
    vi.stubGlobal('fetch', http)
    vi.stubEnv('ANTHROPIC_CUSTOM_HEADERS', 'X-Fictitious-Old-Client: FICTITIOUS_OLD_HEADER')
    const nativeRequest = { ...request, apiKey, maxTokens: 16 }
    await anthropicProvider.executeRequest(nativeRequest)
    vi.stubEnv('ANTHROPIC_CUSTOM_HEADERS', '')
    const beforeModelCall = vi.fn()
    await runWithProviderRuntimeContext(
      {
        controlledRun: {
          signal: new AbortController().signal,
          beforeModelCall,
          executeTool: async () => {
            throw new Error('No business tool expected')
          },
        },
      },
      () => anthropicProvider.executeRequest(nativeRequest)
    )
    await anthropicProvider.executeRequest(nativeRequest)

    expect(http.mock.calls.map(([url]) => String(url))).toEqual([
      'https://fictitious-ambient.invalid/v1/messages',
      'https://api.anthropic.com/v1/messages',
      'https://fictitious-ambient.invalid/v1/messages',
    ])
    const headers = http.mock.calls.map(([, init]) => new Headers(init?.headers))
    expect(headers[0].get('authorization')).toBe('Bearer FICTITIOUS_AMBIENT_TOKEN')
    expect(headers[0].get('x-fictitious-old-client')).toBe('FICTITIOUS_OLD_HEADER')
    expect(headers[1].get('x-api-key')).toBe(apiKey)
    expect(headers[1].has('authorization')).toBe(false)
    expect(headers[1].has('x-fictitious-old-client')).toBe(false)
    expect(headers[2].get('x-fictitious-old-client')).toBe('FICTITIOUS_OLD_HEADER')
    expect(http.mock.calls[1][1]?.redirect).toBe('error')
    expect(http.mock.calls[2][1]?.redirect).toBeUndefined()
    expect(beforeModelCall).toHaveBeenCalledTimes(1)
  })

  it.each([undefined, ''])('accepts an absent or empty custom-header setting', async (headers) => {
    vi.stubEnv('ANTHROPIC_CUSTOM_HEADERS', headers)
    const http = vi.fn<typeof fetch>(async () => message())
    vi.stubGlobal('fetch', http)
    await createControlledAnthropicClient(apiKey).messages.create(request)
    expect(new Headers(http.mock.calls[0][1]?.headers).get('x-api-key')).toBe(apiKey)
  })

  it('keeps SDK request bodies out of logs even if the ambient SDK log level is debug', async () => {
    vi.stubEnv('ANTHROPIC_LOG', 'debug')
    const logs = ['debug', 'info', 'warn', 'error'] as const
    const spies = logs.map((level) => vi.spyOn(console, level).mockImplementation(() => {}))
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () => message())
    )
    await createControlledAnthropicClient(apiKey).messages.create(request)
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  })

  it('does not retry an SDK request after a temporary HTTP failure', async () => {
    const http = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Fixture only' } }),
          { status: 503, headers: { 'retry-after-ms': '0' } }
        )
    )
    vi.stubGlobal('fetch', http)
    await expect(
      createControlledAnthropicClient(apiKey).messages.create(request)
    ).rejects.toMatchObject({ status: 503 })
    expect(http).toHaveBeenCalledTimes(1)
  })

  it('propagates caller cancellation to the SDK HTTP request without a replay', async () => {
    const controller = new AbortController()
    let started!: () => void
    const requestStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    const http = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Fixture cancellation', 'AbortError')),
            { once: true }
          )
          started()
        })
    )
    vi.stubGlobal('fetch', http)
    const response = createControlledAnthropicClient(apiKey).messages.create(request, {
      signal: controller.signal,
    })
    const rejected = expect(response).rejects.toBeDefined()
    await requestStarted
    controller.abort()
    await rejected
    expect(http.mock.calls[0][1]?.signal?.aborted).toBe(true)
    expect(http).toHaveBeenCalledTimes(1)
  })

  it('refuses custom headers in the native controlled entry before reserving a model call', async () => {
    vi.stubEnv('ANTHROPIC_CUSTOM_HEADERS', 'Authorization: FICTITIOUS_HEADER_CANARY')
    const http = vi.fn<typeof fetch>(async () => message())
    vi.stubGlobal('fetch', http)
    const beforeModelCall = vi.fn()
    await expect(
      runWithProviderRuntimeContext(
        {
          controlledRun: {
            signal: new AbortController().signal,
            beforeModelCall,
            executeTool: async () => {
              throw new Error('No business tool expected')
            },
          },
        },
        () => anthropicProvider.executeRequest({ ...request, apiKey, maxTokens: 16 })
      )
    ).rejects.toThrow(new Error('Controlled Anthropic transport is unavailable.'))
    expect(http).not.toHaveBeenCalled()
    expect(beforeModelCall).not.toHaveBeenCalled()
  })

  it('keeps concurrent controlled credentials separate without modifying the environment', async () => {
    const http = vi.fn<typeof fetch>(async () => message())
    vi.stubGlobal('fetch', http)
    const beforeModelCall = [vi.fn(), vi.fn()]
    await Promise.all(
      ['FICTITIOUS_KEY_A', 'FICTITIOUS_KEY_B'].map((key, index) =>
        runWithProviderRuntimeContext(
          {
            controlledRun: {
              signal: new AbortController().signal,
              beforeModelCall: beforeModelCall[index],
              executeTool: async () => {
                throw new Error('No business tool expected')
              },
            },
          },
          () => anthropicProvider.executeRequest({ ...request, apiKey: key, maxTokens: 16 })
        )
      )
    )
    expect(
      http.mock.calls.map(([, init]) => new Headers(init?.headers).get('x-api-key')).sort()
    ).toEqual(['FICTITIOUS_KEY_A', 'FICTITIOUS_KEY_B'])
    for (const [url, init] of http.mock.calls) {
      expect(String(url)).toBe('https://api.anthropic.com/v1/messages')
      expect(new Headers(init?.headers).has('authorization')).toBe(false)
    }
    for (const reserve of beforeModelCall) expect(reserve).toHaveBeenCalledTimes(1)
    expect(process.env.ANTHROPIC_BASE_URL).toBe('https://fictitious-ambient.invalid')
    expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe('FICTITIOUS_AMBIENT_TOKEN')
    expect(process.env.ANTHROPIC_CUSTOM_HEADERS).toBe('')
  })
})
