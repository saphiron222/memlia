// Copyright (c) 2026 Memlia. All rights reserved.
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createInternalToolFileResult } from '@/lib/internal/tool-operations/file-result'
import { executeExcelFile } from '@/lib/memlia/excel/execute-excel-file.server'
import {
  captureExcelToolWorkerRuntime,
  executeMemliaExcelTool,
  runWithExcelToolWorkerRuntime,
} from './execute-tool.server'

vi.mock('@/lib/memlia/excel/execute-excel-file.server', () => ({ executeExcelFile: vi.fn() }))
const runtime = { socketPath: '/run/memlia/excel.sock', operatorUid: 0 }
const context = {
  workflowId: 'workflow',
  workspaceId: 'workspace',
  executionId: 'run',
  userId: 'user',
}
function request(input: unknown = { procedure: {}, sources: {}, output: {} }) {
  return {
    toolId: 'memlia_excel_transform',
    input,
    context,
    headers: new Headers(),
    requestId: 'fixture',
  }
}
const output = () =>
  createInternalToolFileResult(
    {
      buffer: Buffer.from('fixture'),
      name: 'result.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    },
    (file) => ({ success: true, output: { file } })
  )
async function refused(value: unknown, code = 'excel_tool_unavailable') {
  expect(value).toBeInstanceOf(Response)
  const response = value as Response
  expect(response.status).toBe(code === 'excel_tool_unavailable' ? 503 : 400)
  expect(await response.json()).toEqual({
    success: false,
    output: {},
    error: code,
    retryable: false,
  })
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(executeExcelFile).mockResolvedValue(output())
})
describe('worker-only Excel tool runtime', () => {
  it('preserves native guarded result identity and trusted execution context', async () => {
    const native = output()
    vi.mocked(executeExcelFile).mockResolvedValue(native)
    const call = request()
    const result = await runWithExcelToolWorkerRuntime(runtime, () => executeMemliaExcelTool(call))
    expect(result).toBe(native)
    expect(executeExcelFile).toHaveBeenCalledWith(call.input, context, runtime, undefined)
  })
  it('refuses outside the worker scope even with runtime-like client fields', async () => {
    await refused(await executeMemliaExcelTool(request({ ...runtime, runtime, worker: true })))
    expect(executeExcelFile).not.toHaveBeenCalled()
  })
  it('does not transfer scope with a serialized runtime or through environment', async () => {
    vi.stubEnv('MEMLIA_EXCEL_HOST_SOCKET', runtime.socketPath)
    vi.stubEnv('MEMLIA_EXCEL_HOST_OPERATOR_UID', '0')
    try {
      await refused(
        await executeMemliaExcelTool(request({ runtime: JSON.parse(JSON.stringify(runtime)) }))
      )
    } finally {
      vi.unstubAllEnvs()
    }
    expect(executeExcelFile).not.toHaveBeenCalled()
  })
  it('retains the async scope through a scheduled native callback and closes caller scope', async () => {
    const result = await runWithExcelToolWorkerRuntime(
      runtime,
      () =>
        new Promise((resolve) =>
          setTimeout(() => {
            void executeMemliaExcelTool(request()).then(resolve)
          }, 0)
        )
    )
    expect(result).not.toBeInstanceOf(Response)
    await refused(await executeMemliaExcelTool(request()))
    expect(executeExcelFile).toHaveBeenCalledTimes(1)
  })
  it('captures a detached configuration before await and keeps concurrent scopes separate', async () => {
    const first = { ...runtime }
    const second = { socketPath: '/run/memlia/second.sock', operatorUid: 10 }
    let release!: () => void
    const waiting = new Promise<void>((resolve) => {
      release = resolve
    })
    const a = runWithExcelToolWorkerRuntime(first, async () => {
      await waiting
      return executeMemliaExcelTool(request())
    })
    first.socketPath = '/changed'
    await runWithExcelToolWorkerRuntime(second, () => executeMemliaExcelTool(request()))
    release()
    await a
    expect(vi.mocked(executeExcelFile).mock.calls.map((call) => call[2])).toEqual([second, runtime])
  })
  it('nested absent scope refuses without inheriting an outer configuration', async () => {
    await runWithExcelToolWorkerRuntime(runtime, () =>
      runWithExcelToolWorkerRuntime(undefined, async () =>
        refused(await executeMemliaExcelTool(request()))
      )
    )
    expect(executeExcelFile).not.toHaveBeenCalled()
  })
  it('preserves the abort signal and prevents calls already cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    await runWithExcelToolWorkerRuntime(runtime, async () =>
      refused(
        await executeMemliaExcelTool({ ...request(), signal: controller.signal }),
        'excel_tool_refused'
      )
    )
    expect(executeExcelFile).not.toHaveBeenCalled()
  })
  it('returns a fixed non-retryable refusal without exposing the original cause', async () => {
    vi.mocked(executeExcelFile).mockRejectedValue(new Error('fixture-private-cause'))
    await runWithExcelToolWorkerRuntime(runtime, async () =>
      refused(await executeMemliaExcelTool(request()), 'excel_tool_refused')
    )
    expect(executeExcelFile).toHaveBeenCalledTimes(1)
  })
  it('refuses unknown tools and Copilot before calling the native operation', async () => {
    await runWithExcelToolWorkerRuntime(runtime, async () => {
      await refused(
        await executeMemliaExcelTool({ ...request(), toolId: 'file_get' }),
        'excel_tool_refused'
      )
      await refused(
        await executeMemliaExcelTool({
          ...request(),
          context: { ...context, copilotToolExecution: true },
        }),
        'excel_tool_refused'
      )
    })
    expect(executeExcelFile).not.toHaveBeenCalled()
  })
  it('accepts only both absent operator fields as unavailable', () => {
    expect(captureExcelToolWorkerRuntime(undefined, undefined)).toBeUndefined()
    expect(captureExcelToolWorkerRuntime(runtime.socketPath, '0')).toEqual(runtime)
  })
  it.each([
    [undefined, '0'],
    [runtime.socketPath, undefined],
    ['', '0'],
    [runtime.socketPath, ''],
    [runtime.socketPath, '01'],
    [runtime.socketPath, '-1'],
    [runtime.socketPath, '4294967296'],
    [runtime.socketPath, '1.5'],
    [runtime.socketPath, 0],
    ['relative.sock', '0'],
    ['/run/../tmp/sock', '0'],
    ['/run/secret\0.sock', '0'],
    [`/${'a'.repeat(101)}`, '0'],
  ])('refuses malformed operator fields without falling back (%j)', (path, uid) => {
    expect(() => captureExcelToolWorkerRuntime(path, uid)).toThrow(
      'excel_worker_configuration_invalid'
    )
  })
})

// Real installed pg-boss polling loop; only the database fetch is a controlled promise.
it('inherits worker scope in the native pg-boss loop even when its callback was created outside', async () => {
  const require = createRequire(import.meta.url)
  const workerPath = pathToFileURL(join(dirname(require.resolve('pg-boss')), 'worker.js')).href
  const { default: Worker } = await import(/* @vite-ignore */ workerPath)
  let release!: (jobs: unknown[]) => void
  const fetched = new Promise<unknown[]>((resolve) => {
    release = resolve
  })
  let resolveResult!: (result: unknown) => void
  const result = new Promise((resolve) => {
    resolveResult = resolve
  })
  const errors: unknown[] = []
  const worker = new Worker({
    id: 'fixture',
    workId: 'fixture',
    name: 'fixture',
    options: {},
    clock: { now: Date.now },
    resolveInterval: () => 0,
    fetch: () => fetched,
    onFetch: async () => {
      void worker.stop()
      resolveResult(await executeMemliaExcelTool(request()))
    },
    onError: (error: unknown) => {
      errors.push(error)
      void worker.stop()
      resolveResult(undefined)
    },
  })
  runWithExcelToolWorkerRuntime(runtime, () => worker.start())
  release([{ id: 'owned-fixture' }])
  expect(await result).not.toBeInstanceOf(Response)
  await worker.stop()
  expect(worker.stopped).toBe(true)
  expect(errors).toEqual([])
  expect(executeExcelFile).toHaveBeenCalledTimes(1)
  await refused(await executeMemliaExcelTool(request()))
})

it('refuses getters and extraneous runtime fields without invoking caller code', () => {
  const getter = vi.fn(() => '/run/foreign.sock')
  const malicious = Object.defineProperty({ operatorUid: 0 }, 'socketPath', {
    get: getter,
    enumerable: true,
  })
  expect(() =>
    runWithExcelToolWorkerRuntime(malicious as typeof runtime, () => undefined)
  ).toThrow()
  expect(getter).not.toHaveBeenCalled()
  expect(() =>
    runWithExcelToolWorkerRuntime(
      { ...runtime, image: 'foreign' } as typeof runtime,
      () => undefined
    )
  ).toThrow('excel_worker_configuration_invalid')
})
it('does not attach scope to a callback invoked by an unrelated asynchronous origin', async () => {
  let detached!: () => Promise<unknown>
  runWithExcelToolWorkerRuntime(runtime, () => {
    detached = () => executeMemliaExcelTool(request())
  })
  await refused(await detached())
  expect(executeExcelFile).not.toHaveBeenCalled()
})
