// Copyright (c) 2026 Memlia. All rights reserved.
import { createHash, randomUUID } from 'node:crypto'
import { ExcelProcedureSchema } from '@memlia/contracts'
import { z } from 'zod'
import { stringifyBoundedJson } from '@/lib/core/utils/bounded-json'
import type { RunSandboxTaskOptions } from '@/lib/execution/sandbox/run-task'

const VERSION = 'memlia.excel-process/v1'
export const MAX_WIRE = 14 * 1024 * 1024
const MAX_CONTENT = 10_000_000
const text = z.string().min(1).max(128)
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/)
const base64 = z.string().max(4 * Math.ceil(MAX_CONTENT / 3))
const target = z.strictObject({ bindingId: text, sheetId: text, sheetName: text })
const source = target.extend({ contentBase64: base64, sha256: digest })
const inputs = z.strictObject({
  procedure: ExcelProcedureSchema,
  sources: z.record(text, source),
  targets: z.record(text, target),
})
const output = z.strictObject({
  role: text,
  bindingId: text,
  sheetId: text,
  contentBase64: base64,
  sha256: digest,
})
const response = z.strictObject({
  schemaVersion: z.literal(VERSION),
  requestId: text,
  status: z.literal('prepared_in_memory'),
  published: z.literal(false),
  outputs: z.array(output).min(1).max(32),
  controls: z
    .array(
      z.strictObject({
        index: z.int().min(0),
        kind: z.enum(['unique', 'not_null', 'balance']),
        severity: z.enum(['blocking', 'informative']),
        satisfied: z.boolean(),
      })
    )
    .max(200),
})
export function refuse(): never {
  throw new Error('excel_process_refused')
}
export function captured(value: unknown, limit: number): string {
  const result = stringifyBoundedJson(value, limit, { strict: true })
  if (result === undefined) refuse()
  return result
}
function bytes(value: string): Buffer {
  // Bound decoding first, then require the native canonical roundtrip below.
  // A repeated-group regexp can exhaust V8's stack on otherwise valid input.
  if (value.length % 4 !== 0) refuse()
  const size = (value.length / 4) * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0)
  if (size < 1 || size > MAX_CONTENT) refuse()
  const content = Buffer.from(value, 'base64')
  if (content.toString('base64') !== value) refuse()
  return content
}
function hash(value: Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

/** Capture once; neither a parsed procedure nor a successful response grants authority. */
export function captureExcelProcess(
  input: unknown,
  options: Pick<RunSandboxTaskOptions, 'signal' | 'requestId'> = {}
) {
  try {
    const data = inputs.parse(JSON.parse(captured(input, MAX_WIRE)))
    captured(data.procedure, 512 * 1024)
    const signalField = Object.getOwnPropertyDescriptor(options, 'signal')
    const idField = Object.getOwnPropertyDescriptor(options, 'requestId')
    if ((signalField && !('value' in signalField)) || (idField && !('value' in idField))) refuse()
    const signal: AbortSignal | undefined = signalField?.value
    if (signal !== undefined && !(signal instanceof AbortSignal)) refuse()
    const requestId = text.parse(idField?.value ?? randomUUID())
    const active = () => {
      if (signal?.aborted) refuse()
    }
    active()
    if (
      Object.keys(data.sources).length < 1 ||
      Object.keys(data.sources).length > 32 ||
      Object.keys(data.targets).length < 1 ||
      Object.keys(data.targets).length > 32
    )
      refuse()
    // Aggregate encoded bound before ANY decoding; no allocation based on untrusted sizes.
    if (
      Object.values(data.sources).reduce((sum, item) => sum + item.contentBase64.length, 0) >
      4 * Math.ceil(MAX_CONTENT / 3) + 32 * 4
    )
      refuse()
    let total = 0
    for (const item of Object.values(data.sources)) {
      const content = bytes(item.contentBase64)
      total += content.length
      if (total > MAX_CONTENT || hash(content) !== item.sha256) refuse()
    }
    const body = captured(
      { schemaVersion: VERSION, requestId, profile: 'memlia.excel-memory/a1-header-v1', ...data },
      MAX_WIRE
    )
    const timeout = Math.min(120_000, data.procedure.limits.timeoutSeconds * 1000)
    const accept = (wire: string) => {
      try {
        active()
        const parsed = response.parse(JSON.parse(wire))
        if (wire !== `${JSON.stringify(parsed)}\n`) refuse()
        if (
          parsed.requestId !== requestId ||
          parsed.outputs.length !== data.procedure.outputs.length ||
          parsed.controls.length !== data.procedure.controls.length
        )
          refuse()
        const seen = new Set<string>()
        let total = 0
        const outputs = parsed.outputs.map((item) => {
          const declaration = data.procedure.outputs.find(
            (candidate) => candidate.role === item.role
          )
          const destination = data.targets[item.role]
          if (
            seen.has(item.role) ||
            !declaration ||
            !destination ||
            item.bindingId !== declaration.bindingId ||
            item.bindingId !== destination.bindingId ||
            item.sheetId !== destination.sheetId
          )
            refuse()
          seen.add(item.role)
          const content = bytes(item.contentBase64)
          total += content.length
          if (total > MAX_CONTENT || hash(content) !== item.sha256) refuse()
          return {
            role: item.role,
            bindingId: item.bindingId,
            sheetId: item.sheetId,
            sha256: item.sha256,
            content,
          }
        })
        parsed.controls.forEach((item, index) => {
          const expected = data.procedure.controls[index]
          if (
            item.index !== index ||
            item.kind !== expected.kind ||
            item.severity !== expected.severity ||
            (!item.satisfied && item.severity === 'blocking')
          )
            refuse()
        })
        return {
          status: parsed.status,
          published: parsed.published,
          outputs,
          controls: parsed.controls,
        }
      } catch {
        refuse()
      }
    }
    return Object.freeze({ body, timeout, signal, requestId, active, accept })
  } catch {
    refuse()
  }
}
