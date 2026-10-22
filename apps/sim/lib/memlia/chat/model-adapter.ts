// Copyright (c) 2026 Memlia. All rights reserved.

export interface ModelRunLimits {
  maxModelCalls: number
  maxToolCalls: number
  maxDurationMs: number
}

export interface ModelRunControls<ToolResult> {
  signal: AbortSignal
  /** Call immediately before EVERY model transport attempt, including retries. */
  beforeModelCall(): void
  executeTool(toolId: string, params: Record<string, unknown>): Promise<ToolResult>
}

export interface ModelAdapterOptions<Event, ToolResult> {
  /** Server-owned binding to an existing provider loop, never supplied by the model. */
  start(controls: ModelRunControls<ToolResult>): ReadableStream<Event>
  /** Must enforce authority, schema, consent and result projection on every call. */
  dispatch(toolId: string, params: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult>
  /** A narrowing filter only; membership does not confer permission. */
  allowedTools: readonly string[]
  signal?: AbortSignal
  limits?: Partial<ModelRunLimits>
}

export interface ToolActivity {
  readonly active: number
  readonly lastDispatch?: Readonly<{ id: number; toolId: string }>
  readonly lastSettlement?: Readonly<{ id: number; toolId: string; status: 'fulfilled' | 'rejected' }>
}

export class ModelAdapterStop extends Error {
  constructor(readonly code: 'model_calls' | 'tool_calls' | 'duration' | 'tool_not_allowed') {
    super(`Model adapter stopped: ${code}`)
    this.name = 'ModelAdapterStop'
  }
}

/**
 * Bounds an existing provider loop. Events and tool results retain their upstream
 * types and objects; this port neither parses model output nor grants authority.
 * The trusted binding MUST install both controls in every transport/tool path.
 */
export function runModelAdapter<Event, ToolResult>(options: ModelAdapterOptions<Event, ToolResult>) {
  const limits: ModelRunLimits = {
    maxModelCalls: 12,
    maxToolCalls: 40,
    maxDurationMs: 180_000,
    ...options.limits,
  }
  for (const [key, value] of Object.entries(limits)) {
    const minimum = key === 'maxToolCalls' ? 0 : 1
    if (!Number.isSafeInteger(value) || value < minimum ||
      (key === 'maxDurationMs' && value > 2_147_483_647)) {
      throw new RangeError(`Invalid model adapter limit: ${key}`)
    }
  }

  const allowedTools = new Set(options.allowedTools)
  const abort = new AbortController()
  const deadline = performance.now() + limits.maxDurationMs
  let modelCalls = 0
  let toolCalls = 0
  let activeTools = 0
  let lastDispatch: ToolActivity['lastDispatch']
  let lastSettlement: ToolActivity['lastSettlement']
  let settled = false
  let reader: ReadableStreamDefaultReader<Event> | undefined
  let output: ReadableStreamDefaultController<Event>
  let timer: ReturnType<typeof setTimeout> | undefined

  function cleanup() {
    settled = true
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }

  function stop(reason: unknown, consumerCancelled = false) {
    if (settled) return
    cleanup()
    abort.abort(reason)
    if (!consumerCancelled) output.error(reason)
    // A provider that ignores cancellation must not hold the consumer hostage.
    void reader?.cancel(reason).catch(() => {})
  }

  function onAbort() {
    stop(options.signal?.reason ?? new DOMException('Cancelled', 'AbortError'))
  }

  function checkActive() {
    abort.signal.throwIfAborted()
    if (settled) throw new DOMException('Run has finished', 'AbortError')
    if (performance.now() >= deadline) {
      const error = new ModelAdapterStop('duration')
      stop(error)
      throw error
    }
  }

  function fail(code: ConstructorParameters<typeof ModelAdapterStop>[0]): never {
    const error = new ModelAdapterStop(code)
    stop(error)
    throw error
  }

  const controls: ModelRunControls<ToolResult> = {
    signal: abort.signal,
    beforeModelCall() {
      checkActive()
      if (modelCalls >= limits.maxModelCalls) fail('model_calls')
      modelCalls++
    },
    async executeTool(toolId, params) {
      checkActive()
      if (!allowedTools.has(toolId)) fail('tool_not_allowed')
      if (toolCalls >= limits.maxToolCalls) fail('tool_calls')
      toolCalls++
      const invocation = Object.freeze({ id: toolCalls, toolId })
      lastDispatch = invocation
      activeTools++
      const finish = (status: 'fulfilled' | 'rejected') => {
        activeTools--
        lastSettlement = Object.freeze({ ...invocation, status })
      }
      // Reserve before yielding: provider loops may execute several tools at once.
      return new Promise<ToolResult>((resolve, reject) => {
        const cancelled = () => reject(abort.signal.reason)
        abort.signal.addEventListener('abort', cancelled, { once: true })
        try {
          options.dispatch(toolId, params, abort.signal).then((result) => {
            finish('fulfilled')
            try { checkActive(); resolve(result) } catch (error) { reject(error) }
          }, (error) => {
            finish('rejected')
            reject(error)
          }).finally(() => abort.signal.removeEventListener('abort', cancelled))
        } catch (error) {
          finish('rejected')
          abort.signal.removeEventListener('abort', cancelled)
          reject(error)
        }
      })
    },
  }

  const stream = new ReadableStream<Event>({
    start(controller) {
      output = controller
      if (options.signal?.aborted) { onAbort(); return }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => stop(new ModelAdapterStop('duration')), limits.maxDurationMs)
      try {
        reader = options.start(controls).getReader()
        // start() may synchronously exhaust a budget before it returns the stream.
        if (abort.signal.aborted) void reader.cancel(abort.signal.reason).catch(() => {})
      } catch (error) {
        stop(error)
      }
    },
    async pull(controller) {
      if (settled || !reader) return
      try {
        const next = await reader.read()
        if (settled) return
        checkActive()
        if (next.done) {
          cleanup()
          reader.releaseLock()
          controller.close()
        } else {
          controller.enqueue(next.value)
        }
      } catch (error) {
        stop(error)
      }
    },
    cancel(reason) {
      stop(reason ?? new DOMException('Cancelled', 'AbortError'), true)
    },
  }, { highWaterMark: 0 })

  return {
    stream,
    usage: () => ({ modelCalls, toolCalls }),
    // Process-local observations only: no arguments, results or authority are retained.
    // Cancellation does not pretend that an uncooperative dispatcher has settled.
    toolActivity: (): ToolActivity => Object.freeze({ active: activeTools, lastDispatch, lastSettlement }),
  }
}
