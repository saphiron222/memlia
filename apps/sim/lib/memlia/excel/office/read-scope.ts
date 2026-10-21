// Copyright (c) 2026 Memlia. All rights reserved.
import { Range } from '@memlia/contracts'
import { z } from 'zod'
import {
  type OfficePreflight,
  type OfficePreflightCode,
  OfficePreflightError,
  resolveOfficeDocument,
} from './preflight'

type Scalar = string | number | boolean | null
export type OfficeReadCode =
  | OfficePreflightCode
  | 'office_read_scope_invalid'
  | 'office_excel_sdk_invalid'
  | 'office_read_scope_changed'
  | 'office_range_invalid'
  | 'office_range_value_unsupported'
  | 'office_read_sdk_failure'
  | 'office_read_cancelled'
  | 'office_read_timeout'
  | 'office_read_busy'
export class OfficeReadError extends Error {
  constructor(readonly code: OfficeReadCode) {
    super(code)
    this.name = 'OfficeReadError'
  }
}
// Native Worksheet.id is opaque (including braces), not a canonical Memlia resource Id.
const Request = Range.omit({ sheetId: true }).extend({
  sheetId: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[^\uD800-\uDFFF]+$/u),
})
export type OfficeRangeRequest = z.infer<typeof Request>
export type OfficeRangeObservation = Readonly<{
  version: 1
  kind: 'office_range_observation'
  scope: 'current_office_document'
  qualification: 'not_verified'
  worksheet: Readonly<{ id: string; name: string }>
  range: Readonly<OfficeRangeRequest & { address: string }>
  values: readonly (readonly Scalar[])[]
  valueTypes: readonly (readonly string[])[]
  /** Native matrix: constant cells contain their values, not necessarily a formula. */
  formulas: readonly (readonly Scalar[])[]
  numberFormat: readonly (readonly string[])[]
}>
const busy = new WeakSet<object>()
function fail(code: OfficeReadCode): never {
  throw new OfficeReadError(code)
}
function failure(error: unknown) {
  return error instanceof OfficeReadError
    ? error
    : new OfficeReadError(
        error instanceof OfficePreflightError ? error.code : 'office_read_sdk_failure'
      )
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) fail('office_excel_sdk_invalid')
  return value
}
function isPromise(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    'then' in value &&
    typeof value.then === 'function'
  )
}
function call(target: Record<string, unknown>, method: string, args: unknown[] = []): unknown {
  const fn = target[method]
  if (typeof fn !== 'function') fail('office_excel_sdk_invalid')
  return Reflect.apply(fn, target, args)
}
function capture(value: unknown): Readonly<OfficeRangeRequest> {
  if (value === null || typeof value !== 'object') fail('office_read_scope_invalid')
  const input = value
  if (Array.isArray(input) || Object.getOwnPropertySymbols(input).length)
    fail('office_read_scope_invalid')
  const copy: Record<string, unknown> = Object.create(null)
  for (const key of Object.getOwnPropertyNames(input)) {
    const field = Object.getOwnPropertyDescriptor(input, key)
    if (!field || !('value' in field)) fail('office_read_scope_invalid')
    copy[key] = field.value
  }
  const parsed = Request.safeParse(copy)
  if (!parsed.success) fail('office_read_scope_invalid')
  const result = parsed.data
  if (
    result.endRow < result.startRow ||
    result.endColumn < result.startColumn ||
    (result.endRow - result.startRow + 1) * (result.endColumn - result.startColumn + 1) > 10_000
  )
    fail('office_read_scope_invalid')
  return Object.freeze(result)
}
function matrix<T>(
  value: unknown,
  rows: number,
  columns: number,
  cell: (value: unknown) => T
): readonly (readonly T[])[] {
  if (!Array.isArray(value) || value.length !== rows) fail('office_range_invalid')
  const result: (readonly T[])[] = []
  for (let row = 0; row < rows; row++) {
    const source = value[row]
    if (!Array.isArray(source) || source.length !== columns) fail('office_range_invalid')
    const output: T[] = []
    for (let column = 0; column < columns; column++) output.push(cell(source[column]))
    result.push(Object.freeze(output))
  }
  return Object.freeze(result)
}
/** Read-only raw observation; no Snapshot, stable workbook version, approval or patch authority. */
async function observeOfficeRange(
  scope: OfficePreflight,
  excel: unknown,
  target: { kind: 'explicit'; input: unknown } | { kind: 'selection' },
  signal?: AbortSignal
): Promise<OfficeRangeObservation> {
  let stopped: OfficeReadCode | undefined
  try {
    if (signal !== undefined && !(signal instanceof AbortSignal)) fail('office_read_scope_invalid')
    if (signal?.aborted) fail('office_read_cancelled')
    const explicit = target.kind === 'explicit' ? capture(target.input) : undefined
    const document = resolveOfficeDocument(scope)
    document.requireRequirement('ExcelApi', '1.7')
    const sdk = record(excel)
    const run = sdk.run
    if (typeof run !== 'function') fail('office_excel_sdk_invalid')
    if (busy.has(document.identity)) fail('office_read_busy')
    busy.add(document.identity)
    const deadline = performance.now() + 10_000
    let released = false
    const release = () => {
      if (released) return
      released = true
      busy.delete(document.identity)
    }
    const binding = () => {
      if (stopped) fail(stopped)
      if (signal?.aborted) fail('office_read_cancelled')
      if (performance.now() >= deadline) fail('office_read_timeout')
      const current = resolveOfficeDocument(scope)
      current.requireRequirement('ExcelApi', '1.7')
      if (current.identity !== document.identity || sdk.run !== run)
        fail('office_read_scope_changed')
    }
    let entered = false
    const execute = async () => {
      let observation: OfficeRangeObservation | undefined
      try {
        binding()
      } catch (error) {
        release()
        throw error
      }
      const pending = Reflect.apply(run, sdk, [
        async (value: unknown) => {
          if (entered) fail('office_read_scope_changed')
          entered = true
          binding()
          const context = record(value)
          const book = record(context.workbook)
          const sheets = record(book.worksheets)
          const item = sheets.getItem
          let request = explicit
          if (!request) {
            const getSelected = book.getSelectedRange
            const selected = record(call(book, 'getSelectedRange'))
            const selectedSheet = record(selected.worksheet)
            if (selected.context !== context || selectedSheet.context !== context)
              fail('office_read_scope_changed')
            call(selectedSheet, 'load', [['id', 'name']])
            call(selected, 'load', [
              ['address', 'rowIndex', 'columnIndex', 'rowCount', 'columnCount', 'cellCount'],
            ])
            const sync = context.sync
            const geometry = call(context, 'sync')
            if (!isPromise(geometry)) fail('office_excel_sdk_invalid')
            await geometry
            binding()
            if (
              context.sync !== sync ||
              context.workbook !== book ||
              book.worksheets !== sheets ||
              sheets.getItem !== item ||
              book.getSelectedRange !== getSelected ||
              selected.worksheet !== selectedSheet ||
              selected.context !== context ||
              selectedSheet.context !== context
            )
              fail('office_read_scope_changed')
            const row = selected.rowIndex
            const column = selected.columnIndex
            const rows = selected.rowCount
            const columns = selected.columnCount
            if (
              typeof row !== 'number' ||
              !Number.isSafeInteger(row) ||
              row < 0 ||
              typeof column !== 'number' ||
              !Number.isSafeInteger(column) ||
              column < 0 ||
              typeof rows !== 'number' ||
              !Number.isSafeInteger(rows) ||
              rows < 1 ||
              typeof columns !== 'number' ||
              !Number.isSafeInteger(columns) ||
              columns < 1 ||
              selected.cellCount !== rows * columns ||
              typeof selectedSheet.name !== 'string' ||
              selectedSheet.name.length < 1 ||
              selectedSheet.name.length > 256 ||
              typeof selected.address !== 'string' ||
              selected.address.length < 1 ||
              selected.address.length > 8192
            )
              fail('office_range_invalid')
            request = capture({
              sheetId: selectedSheet.id,
              startRow: row + 1,
              endRow: row + rows,
              startColumn: column + 1,
              endColumn: column + columns,
            })
          }
          // Pin the observed coordinates, rather than re-reading a selection that may have moved.
          const rows = request.endRow - request.startRow + 1
          const columns = request.endColumn - request.startColumn + 1
          const sheet = record(call(sheets, 'getItem', [request.sheetId]))
          const getRange = sheet.getRangeByIndexes
          const range = record(
            call(sheet, 'getRangeByIndexes', [
              request.startRow - 1,
              request.startColumn - 1,
              rows,
              columns,
            ])
          )
          if (sheet.context !== context || range.context !== context)
            fail('office_read_scope_changed')
          call(sheet, 'load', [['id', 'name']])
          call(range, 'load', [
            [
              'address',
              'rowIndex',
              'columnIndex',
              'rowCount',
              'columnCount',
              'cellCount',
              'values',
              'valueTypes',
              'formulas',
              'numberFormat',
            ],
          ])
          const sync = context.sync
          const synchronization = call(context, 'sync')
          if (!isPromise(synchronization)) fail('office_excel_sdk_invalid')
          await synchronization
          binding()
          if (
            context.sync !== sync ||
            context.workbook !== book ||
            book.worksheets !== sheets ||
            sheets.getItem !== item ||
            sheet.getRangeByIndexes !== getRange ||
            sheet.context !== context ||
            range.context !== context
          )
            fail('office_read_scope_changed')
          if (
            sheet.id !== request.sheetId ||
            typeof sheet.name !== 'string' ||
            sheet.name.length < 1 ||
            sheet.name.length > 256 ||
            typeof range.address !== 'string' ||
            range.address.length < 1 ||
            range.address.length > 8192 ||
            range.rowIndex !== request.startRow - 1 ||
            range.columnIndex !== request.startColumn - 1 ||
            range.rowCount !== rows ||
            range.columnCount !== columns ||
            range.cellCount !== rows * columns
          )
            fail('office_range_invalid')
          let characters = 0
          const text = (value: unknown): string => {
            if (
              typeof value !== 'string' ||
              value.length > 32767 ||
              !/^[^\uD800-\uDFFF]*$/u.test(value)
            )
              fail('office_range_invalid')
            characters += value.length
            if (characters > 1_000_000) fail('office_range_invalid')
            return value
          }
          const scalar = (value: unknown): Scalar => {
            if (typeof value === 'string') return text(value)
            if (
              value === null ||
              typeof value === 'boolean' ||
              (typeof value === 'number' && Number.isFinite(value))
            )
              return value
            return fail('office_range_value_unsupported')
          }
          const values = matrix(range.values, rows, columns, scalar)
          const valueTypes = matrix(range.valueTypes, rows, columns, (value) => {
            if (
              typeof value !== 'string' ||
              !['Empty', 'String', 'Integer', 'Double', 'Boolean', 'Error'].includes(value)
            )
              fail('office_range_value_unsupported')
            return value
          })
          for (let row = 0; row < rows; row++)
            for (let column = 0; column < columns; column++) {
              const value = values[row][column]
              const type = valueTypes[row][column]
              const valid =
                type === 'Empty'
                  ? value === null || value === ''
                  : type === 'Boolean'
                    ? typeof value === 'boolean'
                    : type === 'String' || type === 'Error'
                      ? typeof value === 'string'
                      : type === 'Integer'
                        ? typeof value === 'number' && Number.isInteger(value)
                        : typeof value === 'number'
              if (!valid) fail('office_range_value_unsupported')
            }
          const formulas = matrix(range.formulas, rows, columns, scalar)
          const numberFormat = matrix(range.numberFormat, rows, columns, text)
          observation = Object.freeze({
            version: 1,
            kind: 'office_range_observation',
            scope: 'current_office_document',
            qualification: 'not_verified',
            worksheet: Object.freeze({ id: sheet.id, name: text(sheet.name) }),
            range: Object.freeze({ ...request, address: text(range.address) }),
            values,
            valueTypes,
            formulas,
            numberFormat,
          })
        },
      ])
      if (!isPromise(pending)) fail('office_excel_sdk_invalid')
      try {
        await pending
        binding()
        if (!observation) fail('office_excel_sdk_invalid')
        return observation
      } finally {
        release()
      }
    }
    let stop!: (code: OfficeReadCode) => void
    const cancellation = new Promise<never>((_resolve, reject) => {
      stop = (code) => {
        stopped ??= code
        reject(new OfficeReadError(stopped))
      }
    })
    const abort = () => stop('office_read_cancelled')
    const timer = setTimeout(() => stop('office_read_timeout'), 10_000)
    signal?.addEventListener('abort', abort, { once: true })
    try {
      return await Promise.race([execute(), cancellation])
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
  } catch (error) {
    const normalized = failure(error)
    stopped ??= normalized.code
    throw normalized
  }
}

/** Read-only raw observation; no Snapshot, stable workbook version, approval or patch authority. */
export async function readOfficeRange(
  scope: OfficePreflight,
  excel: unknown,
  input: unknown,
  signal?: AbortSignal
): Promise<OfficeRangeObservation> {
  return observeOfficeRange(scope, excel, { kind: 'explicit', input }, signal)
}

/** Current single selection after an explicit UI action; bounded before loading cell contents. */
export async function readSelectedOfficeRange(
  scope: OfficePreflight,
  excel: unknown,
  signal?: AbortSignal
): Promise<OfficeRangeObservation> {
  return observeOfficeRange(scope, excel, { kind: 'selection' }, signal)
}
