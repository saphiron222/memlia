// Copyright (c) 2026 Memlia. All rights reserved.
import { lstat } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { platform } from 'node:os'
import { dirname, isAbsolute, normalize } from 'node:path'
import { z } from 'zod'
import type { RunSandboxTaskOptions } from '@/lib/execution/sandbox/run-task'
import { captured, captureExcelProcess, MAX_WIRE, refuse } from './excel-process-protocol'

/** Operator configuration, supplied only to the trusted worker; never model input. */
export interface ExcelHostRuntime {
  socketPath: string
  operatorUid: number
}
const runtimeSchema = z.strictObject({
  socketPath: z.string().min(1).max(100),
  operatorUid: z.number().int().min(0).max(0xffffffff),
})

async function inspect(runtime: ExcelHostRuntime) {
  if (platform() !== 'linux' || !process.getuid || runtime.operatorUid === process.getuid())
    refuse()
  const path = runtime.socketPath
  if (!isAbsolute(path) || normalize(path) !== path || Buffer.byteLength(path) > 100) refuse()
  let parent = dirname(path)
  for (;;) {
    const row = await lstat(parent)
    if (!row.isDirectory() || ![0, runtime.operatorUid].includes(row.uid) || row.mode & 0o022)
      refuse()
    const next = dirname(parent)
    if (next === parent) break
    parent = next
  }
  const row = await lstat(path)
  if (!row.isSocket() || row.uid !== runtime.operatorUid || row.mode & 0o007) refuse()
  return `${row.dev}:${row.ino}:${row.uid}:${row.gid}:${row.mode}`
}

/** No fallback, user authorization, publication or image admission occurs in this transport. */
export async function prepareExcelThroughHost(
  input: unknown,
  runtime: ExcelHostRuntime,
  options: Pick<RunSandboxTaskOptions, 'signal' | 'requestId'> = {}
) {
  try {
    const capture = captureExcelProcess(input, options)
    const config = runtimeSchema.parse(JSON.parse(captured(runtime, 8192)))
    const { signal, active } = capture
    const identity = await inspect(config)
    active()
    const wire = await new Promise<string>((resolve, reject) => {
      const socket = createConnection({ path: config.socketPath })
      let failed = false
      let ended = false
      let length = 0
      let expected: number | undefined
      const chunks: Buffer[] = []
      let prefix = Buffer.alloc(0)
      const stop = () => {
        failed = true
        socket.destroy()
      }
      const timer = setTimeout(stop, capture.timeout)
      signal?.addEventListener('abort', stop, { once: true })
      socket.on('error', stop)
      socket.on('connect', () => {
        void (async () => {
          try {
            if (failed || signal?.aborted || (await inspect(config)) !== identity) return stop()
            active()
            const body = Buffer.from(capture.body)
            const header = Buffer.alloc(4)
            header.writeUInt32BE(body.length)
            socket.write(header)
            socket.write(body)
            // Keep the write side open: EOF is cancellation at the host.
          } catch {
            stop()
          }
        })()
      })
      socket.on('data', (part: Buffer) => {
        length += part.length
        if (length > MAX_WIRE + 5) return stop()
        if (prefix.length < 5) prefix = Buffer.concat([prefix, part.subarray(0, 5 - prefix.length)])
        if (prefix.length === 5 && expected === undefined) {
          expected = prefix.readUInt32BE(1)
          if (prefix[0] !== 0 || expected < 1 || expected > MAX_WIRE) return stop()
        }
        if (expected !== undefined && length > expected + 5) return stop()
        chunks.push(part)
      })
      socket.on('end', () => {
        ended = true
      })
      socket.on('close', () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', stop)
        if (
          failed ||
          signal?.aborted ||
          !ended ||
          expected === undefined ||
          length !== expected + 5
        ) {
          reject(new Error('excel_process_refused'))
          return
        }
        try {
          resolve(
            new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks).subarray(5))
          )
        } catch {
          reject(new Error('excel_process_refused'))
        }
      })
      if (signal?.aborted) stop()
    })
    active()
    return capture.accept(wire)
  } catch {
    refuse()
  }
}
