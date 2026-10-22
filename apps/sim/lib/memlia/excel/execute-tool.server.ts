// Copyright (c) 2026 Memlia. All rights reserved.
import { AsyncLocalStorage } from 'node:async_hooks'
import { isAbsolute, normalize } from 'node:path'
import { stringifyBoundedJson } from '@/lib/core/utils/bounded-json'
import type { ExcelHostRuntime } from '@/lib/execution/sandbox/excel-host'
import type {
  InternalToolOperationHandler,
  InternalToolOperationResult,
} from '@/lib/internal/tool-operations/types'
import { executeExcelFile } from './execute-excel-file.server'

const workerRuntime = new AsyncLocalStorage<Readonly<ExcelHostRuntime> | undefined>()
function invalid(): never {
  throw new Error('excel_worker_configuration_invalid')
}

/** Only the owned worker entrypoint supplies these operator strings. No environment read here. */
export function captureExcelToolWorkerRuntime(
  socketPath: unknown,
  operatorUid: unknown
): Readonly<ExcelHostRuntime> | undefined {
  if (socketPath === undefined && operatorUid === undefined) return undefined
  if (
    typeof socketPath !== 'string' ||
    !isAbsolute(socketPath) ||
    normalize(socketPath) !== socketPath ||
    socketPath.includes('\0') ||
    Buffer.byteLength(socketPath) > 100 ||
    typeof operatorUid !== 'string' ||
    !/^(0|[1-9][0-9]{0,9})$/.test(operatorUid)
  )
    invalid()
  const uid = Number(operatorUid)
  if (!Number.isSafeInteger(uid) || uid > 0xffffffff) invalid()
  return Object.freeze({ socketPath, operatorUid: uid })
}

/** Async process scope only; never derives user authority or serializes a capability. */
export function runWithExcelToolWorkerRuntime<T>(
  runtime: ExcelHostRuntime | undefined,
  run: () => T
): T {
  let captured: Readonly<ExcelHostRuntime> | undefined
  if (runtime !== undefined) {
    const text = stringifyBoundedJson(runtime, 8192, { strict: true })
    if (text === undefined) invalid()
    const value = JSON.parse(text)
    if (
      !value ||
      Array.isArray(value) ||
      Object.keys(value).length !== 2 ||
      typeof value.operatorUid !== 'number' ||
      !Number.isSafeInteger(value.operatorUid)
    )
      invalid()
    captured = captureExcelToolWorkerRuntime(value.socketPath, String(value.operatorUid))
  }
  return workerRuntime.run(captured, run)
}

function refusal(code: 'excel_tool_unavailable' | 'excel_tool_refused') {
  return Response.json(
    { success: false, output: {}, error: code, retryable: false },
    { status: code === 'excel_tool_unavailable' ? 503 : 400 }
  )
}

/** Preserve the exact protected result until Sim's native file presenter stores it. */
export const executeMemliaExcelTool: InternalToolOperationHandler<
  InternalToolOperationResult
> = async (request) => {
  const runtime = workerRuntime.getStore()
  if (!runtime) return refusal('excel_tool_unavailable')
  try {
    if (request.toolId !== 'memlia_excel_transform' || request.context.copilotToolExecution) {
      return refusal('excel_tool_refused')
    }
    request.signal?.throwIfAborted()
    return await executeExcelFile(request.input, request.context, runtime, request.signal)
  } catch {
    return refusal('excel_tool_refused')
  }
}
