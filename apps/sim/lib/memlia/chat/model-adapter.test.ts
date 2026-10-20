// Copyright (c) 2026 Memlia. All rights reserved.
import { expect, test } from 'bun:test'
import { runModelAdapter } from './model-adapter'

async function collect<T>(stream: ReadableStream<T>): Promise<T[]> {
  return Array.fromAsync(stream)
}

// These tests catch loss of events, an extra paid model call or tool effect,
// cancellation reported as success, and a dispatcher called outside its allowlist.
test('preserves provider events and raw/model tool result separation', async () => {
  let result: unknown
  const run = runModelAdapter({
    allowedTools: ['catalogue'],
    dispatch: async () => ({ rawResponse: { private: 'trace' }, modelResponse: { names: ['agent'] } }),
    start(controls) {
      return new ReadableStream({ async start(controller) {
        controls.beforeModelCall()
        controller.enqueue({ type: 'thinking_delta', text: 'Inspect' })
        result = await controls.executeTool('catalogue', { query: 'agent' })
        controller.enqueue({ type: 'tool_call_end', status: 'success' })
        controls.beforeModelCall()
        controller.enqueue({ type: 'text_delta', text: 'Ready', turn: 'final' })
        controller.close()
      } })
    },
  })
  expect(await collect(run.stream)).toEqual([
    { type: 'thinking_delta', text: 'Inspect' },
    { type: 'tool_call_end', status: 'success' },
    { type: 'text_delta', text: 'Ready', turn: 'final' },
  ])
  expect(result).toEqual({ rawResponse: { private: 'trace' }, modelResponse: { names: ['agent'] } })
  expect(run.usage()).toEqual({ modelCalls: 2, toolCalls: 1 })
})

test('reserves each model call before transport, including final synthesis', async () => {
  let calls = 0
  const run = runModelAdapter({
    limits: { maxModelCalls: 2 }, allowedTools: [], dispatch: async () => null,
    start(controls) {
      return new ReadableStream({ start() {
        for (let i = 0; i < 3; i++) { controls.beforeModelCall(); calls++ }
      } })
    },
  })
  await expect(collect(run.stream)).rejects.toMatchObject({ code: 'model_calls' })
  expect(calls).toBe(2)
})

test('reserves tool budget synchronously even when a provider dispatches concurrently', async () => {
  let effects = 0
  const run = runModelAdapter({
    limits: { maxToolCalls: 1 }, allowedTools: ['preview'],
    dispatch: async () => { effects++; return 'preview' },
    start(controls) {
      return new ReadableStream({ async start() {
        await Promise.all([controls.executeTool('preview', {}), controls.executeTool('preview', {})])
      } })
    },
  })
  await expect(collect(run.stream)).rejects.toMatchObject({ code: 'tool_calls' })
  expect(effects).toBe(1)
})

test('refuses tools absent from the server allowlist without invoking dispatcher', async () => {
  let effects = 0
  const run = runModelAdapter({
    allowedTools: ['catalogue'], dispatch: async () => { effects++; return null },
    start(controls) {
      return new ReadableStream({ async start() { await controls.executeTool('shell', {}) } })
    },
  })
  await expect(collect(run.stream)).rejects.toMatchObject({ code: 'tool_not_allowed' })
  expect(effects).toBe(0)
})

test('does not start a provider for an already cancelled request', async () => {
  let started = false
  const run = runModelAdapter({
    signal: AbortSignal.abort(), allowedTools: [], dispatch: async () => null,
    start() { started = true; return new ReadableStream() },
  })
  await expect(collect(run.stream)).rejects.toMatchObject({ name: 'AbortError' })
  expect(started).toBe(false)
})

test('deadline aborts an unread stalled stream and prevents late tools', async () => {
  let controls: Parameters<Parameters<typeof runModelAdapter>[0]['start']>[0]
  let cancelled = false
  let effects = 0
  const run = runModelAdapter({
    limits: { maxDurationMs: 10 }, allowedTools: ['apply'],
    dispatch: async () => { effects++; return null },
    start(value) { controls = value; return new ReadableStream({ cancel() { cancelled = true } }) },
  })
  await Bun.sleep(30)
  await expect(collect(run.stream)).rejects.toMatchObject({ code: 'duration' })
  await expect(controls!.executeTool('apply', {})).rejects.toMatchObject({ code: 'duration' })
  expect(effects).toBe(0)
  expect(cancelled).toBe(true)
})

test('consumer cancellation aborts dispatcher signal and cancels provider stream', async () => {
  let signal: AbortSignal | undefined
  let cancelled = false
  const run = runModelAdapter({
    allowedTools: [], dispatch: async () => null,
    start(controls) { signal = controls.signal; return new ReadableStream({ cancel() { cancelled = true } }) },
  })
  await run.stream.cancel('user stop')
  expect(signal?.aborted).toBe(true)
  expect(cancelled).toBe(true)
})

test('cancellation rejects a hanging dispatcher and ignores its late result', async () => {
  const controller = new AbortController()
  let toolResult: Promise<unknown> | undefined
  let dispatcherSignal: AbortSignal | undefined
  const run = runModelAdapter({
    signal: controller.signal, allowedTools: ['apply'],
    dispatch: async (_name, _params, signal) => { dispatcherSignal = signal; return new Promise(() => {}) },
    start(controls) {
      toolResult = controls.executeTool('apply', {})
      toolResult.catch(() => {})
      return new ReadableStream()
    },
  })
  controller.abort()
  await expect(collect(run.stream)).rejects.toMatchObject({ name: 'AbortError' })
  await expect(toolResult!).rejects.toMatchObject({ name: 'AbortError' })
  expect(dispatcherSignal?.aborted).toBe(true)
})

test('rejects invalid limits before starting provider', () => {
  for (const maxDurationMs of [0, -1, Infinity, NaN, 2147483648]) {
    expect(() => runModelAdapter({ limits: { maxDurationMs }, allowedTools: [], dispatch: async () => null,
      start() { throw new Error('must not start') },
    })).toThrow(RangeError)
  }
})

test('tool activity snapshots distinguish overlapping invocations and settle without data', async () => {
  let controls!: Parameters<Parameters<typeof runModelAdapter>[0]['start']>[0]
  const releases: Array<(value: string) => void> = []
  const run = runModelAdapter({
    allowedTools: ['apply'],
    dispatch: async () => new Promise<string>((resolve) => releases.push(resolve)),
    start(value) { controls = value; return new ReadableStream() },
  })
  const first = controls.executeTool('apply', { secret: 'PRIVATE_ARGUMENT' })
  const one = run.toolActivity()
  const second = controls.executeTool('apply', {})
  const two = run.toolActivity()
  expect(Object.isFrozen(one)).toBe(true)
  expect(Object.isFrozen(one.lastDispatch)).toBe(true)
  expect(one).toEqual({ active: 1, lastDispatch: { id: 1, toolId: 'apply' }, lastSettlement: undefined })
  expect(two.active).toBe(2)
  expect(two.lastDispatch?.id).toBe(2)
  releases[1]('PRIVATE_RESULT')
  await second
  expect(run.toolActivity().lastSettlement).toEqual({ id: 2, toolId: 'apply', status: 'fulfilled' })
  releases[0]('PRIVATE_RESULT')
  await first
  expect(run.toolActivity()).toEqual({ active: 0, lastDispatch: { id: 2, toolId: 'apply' },
    lastSettlement: { id: 1, toolId: 'apply', status: 'fulfilled' } })
  expect(one.active).toBe(1)
  expect(JSON.stringify(run.toolActivity())).not.toContain('PRIVATE')
  await run.stream.cancel()
})

test('cancelled caller does not falsely settle an outstanding dispatch', async () => {
  let controls!: Parameters<Parameters<typeof runModelAdapter>[0]['start']>[0]
  let release!: () => void
  const run = runModelAdapter({ allowedTools: ['apply'],
    dispatch: async () => new Promise<void>((resolve) => { release = resolve }),
    start(value) { controls = value; return new ReadableStream() },
  })
  const pending = controls.executeTool('apply', {})
  void pending.catch(() => {})
  await run.stream.cancel()
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  expect(run.toolActivity().active).toBe(1)
  expect(run.toolActivity().lastSettlement).toBeUndefined()
  release()
  await new Promise<void>((resolve) => queueMicrotask(resolve))
  expect(run.toolActivity().active).toBe(0)
  expect(run.toolActivity().lastSettlement?.status).toBe('fulfilled')
})

test('sync and async dispatch failures record a rejected invocation only once', async () => {
  for (const sync of [true, false]) {
    let controls!: Parameters<Parameters<typeof runModelAdapter>[0]['start']>[0]
    const run = runModelAdapter({ allowedTools: ['apply'],
      dispatch: () => { if (sync) throw new Error('PRIVATE'); return Promise.reject(new Error('PRIVATE')) },
      start(value) { controls = value; return new ReadableStream() },
    })
    await expect(controls.executeTool('apply', {})).rejects.toThrow('PRIVATE')
    expect(run.toolActivity()).toEqual({ active: 0, lastDispatch: { id: 1, toolId: 'apply' },
      lastSettlement: { id: 1, toolId: 'apply', status: 'rejected' } })
    await run.stream.cancel()
  }
})
