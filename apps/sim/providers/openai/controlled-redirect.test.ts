// Copyright 2026 Memlia. All rights reserved.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { providersMock } from '@sim/testing/mocks/providers.mock'
import { providersUtilsMock, providersUtilsMockFns } from '@sim/testing/mocks/providers-utils.mock'
import { toolsMock } from '@sim/testing/mocks/tools.mock'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { executeResponsesProviderRequest } from '@/providers/openai/core'
import {
  getProviderRuntimeContext,
  runWithProviderRuntimeContext,
} from '@/providers/runtime-context'
import type { ProviderRequest } from '@/providers/types'

// Unrelated tools/model capabilities use the established native provider test doubles.
// ALS, reservation hook, retry, Responses transport and Node fetch remain real.
vi.mock('@/providers', () => providersMock)
vi.mock('@/providers/utils', () => providersUtilsMock)
vi.mock('@/tools', () => toolsMock)

const COMPLETED = {
  id: 'fixture-response',
  status: 'completed',
  output: [
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'fixture complete' }],
    },
  ],
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
}
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never
let nativeFetch: typeof fetch
beforeAll(() => {
  // The ordinary Sim unit setup stubs fetch. Restore Node's implementation explicitly.
  vi.unstubAllGlobals()
  nativeFetch = globalThis.fetch
  expect(vi.isMockFunction(nativeFetch)).toBe(false)
})
beforeEach(() => {
  providersUtilsMockFns.mockSupportsReasoningEffort.mockReturnValue(true)
  providersUtilsMockFns.mockPrepareToolsWithUsageControl.mockImplementation((tools) => ({
    tools,
    toolChoice: undefined,
    forcedTools: [],
    hasFilteredTools: false,
  }))
})
afterAll(() => vi.unstubAllGlobals())

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture listener unavailable')
  return { server, url: `http://127.0.0.1:${address.port}` }
}
async function close(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
    server.closeAllConnections()
  })
}
async function withEndpoints(
  statuses: number[],
  run: (fixture: {
    endpoint: string
    inits: RequestInit[]
    fetch: typeof fetch
    sourceBodies: string[]
    targetBodies: string[]
  }) => Promise<void>
) {
  const targetBodies: string[] = []
  const sourceBodies: string[] = []
  const inits: RequestInit[] = []
  const target = await listen((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      targetBodies.push(body)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(COMPLETED))
    })
  })
  let source: Awaited<ReturnType<typeof listen>> | undefined
  try {
    source = await listen((req, res) => {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        sourceBodies.push(body)
        const status = statuses[Math.min(sourceBodies.length - 1, statuses.length - 1)]!
        if ([302, 307, 308].includes(status)) {
          res.writeHead(status, { Location: `${target.url}/target` })
          res.end()
          return
        }
        if (status === 400) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              error: { message: 'reasoning.summary requires organization verification' },
            })
          )
          return
        }
        if (status === 503) {
          res.writeHead(503, { 'retry-after-ms': '1' })
          res.end('fixture transient')
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(COMPLETED))
      })
    })
    const endpoint = `${source.url}/responses`
    const transport: typeof fetch = async (input, init) => {
      expect(String(input)).toBe(endpoint) // Only these owned loopback origins are reachable.
      inits.push(init ?? {})
      return nativeFetch(input, init)
    }
    await run({ endpoint, inits, fetch: transport, sourceBodies, targetBodies })
  } finally {
    if (source) await close(source.server)
    await close(target.server)
  }
}
function request(
  fixture: { endpoint: string; fetch: typeof fetch },
  options: Partial<ProviderRequest> = {}
) {
  return executeResponsesProviderRequest(
    {
      apiKey: 'FICTIVE_MEMLIA_TEST_ONLY',
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'local redirect body canary' }],
      ...options,
    },
    {
      providerId: 'openai',
      providerLabel: 'OpenAI',
      modelName: 'gpt-5.5',
      endpoint: fixture.endpoint,
      headers: {
        Authorization: 'Bearer FICTIVE_MEMLIA_TEST_ONLY',
        'Content-Type': 'application/json',
      },
      logger,
      fetch: fixture.fetch,
    }
  )
}
function controls(signal = new AbortController().signal) {
  const beforeModelCall = vi.fn()
  return {
    controlledRun: {
      signal,
      beforeModelCall,
      executeTool: async () => {
        throw new Error('No fixture tool is callable')
      },
    },
    beforeModelCall,
  }
}

describe('controlled Responses redirect policy with native loopback HTTP', () => {
  for (const status of [302, 307, 308]) {
    for (const stream of [false, true]) {
      it(`refuses ${status} without reaching its target (stream=${stream})`, async () => {
        await withEndpoints([status], async (f) => {
          const c = controls()
          await expect(
            runWithProviderRuntimeContext({ controlledRun: c.controlledRun }, () =>
              request(f, { stream })
            )
          ).rejects.toThrow()
          expect(f.sourceBodies).toHaveLength(1)
          expect(f.targetBodies).toHaveLength(0)
          expect(c.beforeModelCall).toHaveBeenCalledTimes(1)
          expect(f.inits[0]?.redirect).toBe('error')
          expect(f.inits[0]?.signal).toBe(c.controlledRun.signal)
        })
      })
    }
    it(`preserves native redirect following outside controls (${status})`, async () => {
      await withEndpoints([status], async (f) => {
        await expect(request(f)).resolves.toMatchObject({ content: 'fixture complete' })
        expect(f.sourceBodies).toHaveLength(1)
        expect(f.targetBodies).toHaveLength(1)
        expect(Object.hasOwn(f.inits[0]!, 'redirect')).toBe(false)
        if (status !== 302) expect(f.targetBodies[0]).toContain('local redirect body canary')
      })
    })
  }
  it('keeps the redirect policy on a physical retry and reserves each attempt', async () => {
    await withEndpoints([503, 307], async (f) => {
      const c = controls()
      await expect(
        runWithProviderRuntimeContext({ controlledRun: c.controlledRun }, () => request(f))
      ).rejects.toThrow()
      expect(f.sourceBodies).toHaveLength(2)
      expect(f.targetBodies).toHaveLength(0)
      expect(f.inits.map((init) => init.redirect)).toEqual(['error', 'error'])
      expect(c.beforeModelCall).toHaveBeenCalledTimes(2)
    })
  })
  it('keeps the redirect policy through native reasoning-summary fallback', async () => {
    await withEndpoints([400, 307], async (f) => {
      const c = controls()
      await expect(
        runWithProviderRuntimeContext({ controlledRun: c.controlledRun }, () =>
          request(f, { agentEvents: true })
        )
      ).rejects.toThrow()
      expect(f.sourceBodies).toHaveLength(2)
      expect(f.targetBodies).toHaveLength(0)
      expect(JSON.parse(f.sourceBodies[0]!).reasoning.summary).toBe('auto')
      expect(JSON.parse(f.sourceBodies[1]!).reasoning?.summary).toBeUndefined()
      expect(f.inits.map((init) => init.redirect)).toEqual(['error', 'error'])
      expect(c.beforeModelCall).toHaveBeenCalledTimes(2)
    })
  })
  it('preserves abort and budget refusal before any physical request', async () => {
    await withEndpoints([200], async (f) => {
      const aborted = new AbortController()
      aborted.abort()
      const c = controls(aborted.signal)
      await expect(
        runWithProviderRuntimeContext({ controlledRun: c.controlledRun }, () => request(f))
      ).rejects.toThrow()
      expect(c.beforeModelCall).not.toHaveBeenCalled()
      const budget = controls()
      budget.beforeModelCall.mockImplementation(() => {
        throw new Error('fixture budget exhausted')
      })
      await expect(
        runWithProviderRuntimeContext({ controlledRun: budget.controlledRun }, () => request(f))
      ).rejects.toThrow()
      expect(budget.beforeModelCall).toHaveBeenCalledTimes(1)
      expect(f.sourceBodies).toHaveLength(0)
      expect(f.inits).toHaveLength(0)
    })
  })
  it('preserves successful requests and isolates concurrent controlled and native calls', async () => {
    await withEndpoints([200], async (f) => {
      const c = controls()
      await expect(
        runWithProviderRuntimeContext({ controlledRun: c.controlledRun }, () => request(f))
      ).resolves.toMatchObject({ content: 'fixture complete' })
      expect(c.beforeModelCall).toHaveBeenCalledTimes(1)
      expect(f.inits[0]?.redirect).toBe('error')
    })
    await withEndpoints([307], async (f) => {
      const c = controls()
      const results = await Promise.allSettled([
        runWithProviderRuntimeContext({ controlledRun: c.controlledRun }, () => request(f)),
        request(f),
      ])
      expect(results.map((result) => result.status)).toEqual(['rejected', 'fulfilled'])
      expect(f.targetBodies).toHaveLength(1)
      expect(c.beforeModelCall).toHaveBeenCalledTimes(1)
      expect(getProviderRuntimeContext()).toBeUndefined()
    })
  })
})
