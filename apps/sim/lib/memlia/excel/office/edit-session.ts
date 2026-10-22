// Copyright (c) 2026 Memlia. All rights reserved.
import { type OfficeBackupClientResult, resolveOfficeBackupEditBinding } from './backup-client'
import { resolveOfficeDocument } from './preflight'
import { type OfficeRangeObservation, readOfficeRange } from './read-scope'

export type OfficeEditScalar = string | number | boolean | null
export type OfficeEditCode =
  | 'backup_binding_missing'
  | 'exclusive_copy_required'
  | 'invalid_values'
  | 'unsafe_range'
  | 'formula_protected'
  | 'preimage_changed'
  | 'scope_changed'
  | 'approval_invalid'
  | 'already_used'
  | 'busy'
  | 'cancelled'
  | 'timeout'
  | 'sdk_failure'
  | 'verification_failed'
  | 'formula_error'
  | 'calculation_unconfirmed'
  | 'save_binding_missing'
  | 'save_location_required'
  | 'read_only'
export class OfficeEditError extends Error {
  constructor(readonly code: OfficeEditCode) {
    super(code)
    this.name = 'OfficeEditError'
  }
}
export type OfficeEditPreview = Readonly<{
  digest: string
  observation: OfficeRangeObservation
  /** Zero-based offsets within the observed range, never absolute worksheet coordinates. */
  changes: readonly Readonly<{
    row: number
    column: number
    before: OfficeEditScalar
    after: OfficeEditScalar
  }>[]
  backupFileId: string
}>
declare const approvalBrand: unique symbol
export type OfficeEditApproval = Readonly<{ [approvalBrand]: true }>
export type OfficeEditResult =
  | Readonly<{
      status: 'verified'
      observation: OfficeRangeObservation
      changedCells: number
      calculation: 'range_calculated'
      durableSave: 'not_confirmed'
    }>
  | Readonly<{ status: 'refused' | 'uncertain'; code: OfficeEditCode }>

export type OfficeSaveResult =
  | Readonly<{
      status: 'acknowledged'
      durableSave: 'office_acknowledged'
      diskVerification: 'not_observed'
    }>
  | Readonly<{ status: 'refused' | 'uncertain'; code: OfficeEditCode }>

type Backup = Extract<OfficeBackupClientResult, { status: 'stored' }>
type Binding = NonNullable<ReturnType<typeof resolveOfficeBackupEditBinding>>
type Session = {
  backup: Backup
  binding: Binding
  values: readonly (readonly OfficeEditScalar[])[]
  mask: ReadonlySet<string>
  consumed: boolean
}
const previews = new WeakMap<OfficeEditPreview, Session>()
const approvals = new WeakMap<OfficeEditApproval, OfficeEditPreview>()
const verifiedEdits = new WeakMap<object, { binding: Binding; consumed: boolean }>()
const busy = new WeakSet<object>()
type Guard = (() => void) & { unknownClosure: () => void }
function fail(code: OfficeEditCode): never {
  throw new OfficeEditError(code)
}
type RecordValue = Record<string, unknown>
function record(v: unknown): RecordValue {
  if (v === null || typeof v !== 'object') return fail('sdk_failure')
  return v as RecordValue
}
function call(object: RecordValue, name: string, args: unknown[] = []): unknown {
  const fn = object[name]
  if (typeof fn !== 'function') return fail('sdk_failure')
  return Reflect.apply(fn, object, args)
}
function isPromise(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    'then' in value &&
    typeof value.then === 'function'
  )
}
function fixed(observation: OfficeRangeObservation) {
  const { sheetId, startRow, endRow, startColumn, endColumn } = observation.range
  return { sheetId, startRow, endRow, startColumn, endColumn }
}
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  return a.every((v, index) => equal(v, b[index]))
}
function captureValues(value: unknown, observation: OfficeRangeObservation) {
  const rows = observation.values.length
  const cols = observation.values[0].length
  if (rows * cols > 10_000) return fail('invalid_values')
  let text = 0
  function array(v: unknown, length: number): unknown[] {
    if (
      !Array.isArray(v) ||
      v.length !== length ||
      Object.getOwnPropertySymbols(v).length ||
      Object.getOwnPropertyNames(v).length !== length + 1
    )
      return fail('invalid_values')
    return Array.from({ length }, (_, i) => {
      const field = Object.getOwnPropertyDescriptor(v, String(i))
      if (!field || !('value' in field)) return fail('invalid_values')
      return field.value
    })
  }
  return Object.freeze(
    array(value, rows).map((row) =>
      Object.freeze(
        array(row, cols).map((v) => {
          if (typeof v === 'string') {
            text += v.length
            if (v.length > 32767 || text > 1_000_000 || !/^[^\uD800-\uDFFF]*$/u.test(v))
              return fail('invalid_values')
          } else if (typeof v === 'number') {
            if (!Number.isFinite(v)) return fail('invalid_values')
          } else if (typeof v !== 'boolean' && v !== null) return fail('invalid_values')
          return v as OfficeEditScalar
        })
      )
    )
  )
}

/** Only a genuine, still-bound local receipt exposes a captured observation. */
export function getOfficeEditBackupObservation(backup: unknown): OfficeRangeObservation | null {
  return resolveOfficeBackupEditBinding(backup)?.observation ?? null
}

/** The deadline does not release ownership while the native promise is still running. */
async function owned<T>(
  binding: Binding,
  signal: AbortSignal | undefined,
  work: (guard: Guard) => Promise<T>
): Promise<T> {
  const identity = resolveOfficeDocument(binding.scope).identity
  if (busy.has(identity)) return fail('busy')
  if (signal?.aborted) return fail('cancelled')
  busy.add(identity)
  const deadline = performance.now() + 10_000
  let stopped: OfficeEditCode | null = null
  let closureUnknown = false
  let rejectStop!: (error: OfficeEditError) => void
  const stopPromise = new Promise<never>((_, reject) => {
    rejectStop = reject
  })
  const stop = (code: OfficeEditCode) => {
    if (!stopped) {
      stopped = code
      rejectStop(new OfficeEditError(code))
    }
  }
  const abort = () => stop('cancelled')
  const timer = setTimeout(() => stop('timeout'), 10_000)
  signal?.addEventListener('abort', abort, { once: true })
  const guard: Guard = Object.assign(
    () => {
      if (stopped) fail(stopped)
      if (signal?.aborted) fail('cancelled')
      if (performance.now() >= deadline) fail('timeout')
      if (
        resolveOfficeDocument(binding.scope).identity !== identity ||
        Reflect.get(binding.excel, 'run') !== binding.run
      )
        fail('scope_changed')
    },
    {
      unknownClosure: () => {
        closureUnknown = true
        stopped ??= 'sdk_failure'
      },
    }
  )
  const pending = Promise.resolve().then(() => {
    guard()
    return work(guard)
  })
  // Finally follows the actual operation, not the race; late completions cannot revive it.
  const finished = pending.finally(() => {
    stopped ??= 'already_used'
    if (!closureUnknown) busy.delete(identity)
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  })
  return Promise.race([finished, stopPromise])
}

const rangeFields = [
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
  'hasSpill',
]
function matchesRange(
  range: RecordValue,
  sheet: RecordValue,
  before: OfficeRangeObservation
): boolean {
  return (
    sheet.id === before.worksheet.id &&
    sheet.name === before.worksheet.name &&
    range.address === before.range.address &&
    range.rowIndex === before.range.startRow - 1 &&
    range.columnIndex === before.range.startColumn - 1 &&
    range.rowCount === before.values.length &&
    range.columnCount === before.values[0].length &&
    range.cellCount === before.values.length * before.values[0].length &&
    equal(range.values, before.values) &&
    equal(range.valueTypes, before.valueTypes) &&
    equal(range.formulas, before.formulas) &&
    equal(range.numberFormat, before.numberFormat)
  )
}

/** Excel is the parser and calculator. This only scopes and compares its observations. */
async function inspectRange<T>(
  binding: Binding,
  before: OfficeRangeObservation,
  guard: Guard,
  use: (
    range: RecordValue,
    mask: Set<string>,
    sync: () => Promise<void>,
    application: RecordValue,
    workbook: RecordValue,
    rereadPreimage: () => Promise<void>
  ) => Promise<T>
): Promise<T> {
  const document = resolveOfficeDocument(binding.scope)
  document.requireRequirement('ExcelApi', '1.9')
  document.requireRequirement('ExcelApi', '1.13')
  let invoked = false
  let completed = false
  let active = true
  let callback: Promise<void> | undefined
  let output!: T
  const localGuard = () => {
    if (!active) fail('sdk_failure')
    guard()
  }
  const execute = async (raw: unknown) => {
    if (invoked) fail('sdk_failure')
    invoked = true
    localGuard()
    const context = record(raw)
    const book = record(context.workbook)
    const sheets = record(book.worksheets)
    const application = record(context.application)
    const sheet = record(call(sheets, 'getItem', [before.worksheet.id]))
    const range = record(
      call(sheet, 'getRangeByIndexes', [
        before.range.startRow - 1,
        before.range.startColumn - 1,
        before.values.length,
        before.values[0].length,
      ])
    )
    const protection = record(sheet.protection)
    const syncMethod = context.sync
    const getItem = sheets.getItem
    const getRange = sheet.getRangeByIndexes
    const sync = async () => {
      localGuard()
      const assertContext = () => {
        if (
          context.workbook !== book ||
          context.application !== application ||
          book.worksheets !== sheets ||
          sheets.getItem !== getItem ||
          sheet.getRangeByIndexes !== getRange ||
          context.sync !== syncMethod ||
          sheet.protection !== protection ||
          sheet.context !== context ||
          range.context !== context
        )
          fail('scope_changed')
      }
      assertContext()
      const synchronization = call(context, 'sync')
      if (!isPromise(synchronization)) {
        guard.unknownClosure()
        fail('sdk_failure')
      }
      await synchronization
      localGuard()
      assertContext()
    }
    const merged = record(call(range, 'getMergedAreasOrNullObject'))
    const formulaAreas = record(call(range, 'getSpecialCellsOrNullObject', ['Formulas']))
    call(merged, 'load', ['isNullObject'])
    call(formulaAreas, 'load', ['isNullObject'])
    call(protection, 'load', ['protected'])
    call(range, 'load', [rangeFields])
    call(sheet, 'load', [['id', 'name']])
    await sync()
    if (merged.isNullObject !== true || protection.protected !== false || range.hasSpill !== false)
      fail('unsafe_range')
    const mask = new Set<string>()
    if (formulaAreas.isNullObject !== true) {
      if (formulaAreas.isNullObject !== false) fail('unsafe_range')
      const areas = record(formulaAreas.areas)
      call(areas, 'load', ['items'])
      await sync()
      if (!Array.isArray(areas.items) || areas.items.length > 10_000) fail('unsafe_range')
      const items = areas.items.map(record)
      for (const area of items)
        call(area, 'load', [['rowIndex', 'columnIndex', 'rowCount', 'columnCount']])
      await sync()
      let total = 0
      for (const area of items) {
        const { rowIndex, columnIndex, rowCount, columnCount } = area
        if (
          ![rowIndex, columnIndex, rowCount, columnCount].every(
            (n) => typeof n === 'number' && Number.isSafeInteger(n)
          )
        )
          fail('unsafe_range')
        const r = (rowIndex as number) - before.range.startRow + 1
        const c = (columnIndex as number) - before.range.startColumn + 1
        const nr = rowCount as number
        const nc = columnCount as number
        if (
          r < 0 ||
          c < 0 ||
          nr <= 0 ||
          nc <= 0 ||
          r + nr > before.values.length ||
          c + nc > before.values[0].length
        )
          fail('unsafe_range')
        total += nr * nc
        if (total > 10_000) fail('unsafe_range')
        for (let i = r; i < r + nr; i++) for (let j = c; j < c + nc; j++) mask.add(`${i}:${j}`)
      }
    }
    // Reload the whole preimage after metadata discovery, immediately before dispatch.
    const rereadPreimage = async () => {
      call(range, 'load', [rangeFields])
      call(protection, 'load', ['protected'])
      call(sheet, 'load', [['id', 'name']])
      await sync()
      if (protection.protected !== false || range.hasSpill !== false) fail('unsafe_range')
      if (!matchesRange(range, sheet, before)) fail('preimage_changed')
      localGuard()
    }
    await rereadPreimage()
    output = await use(range, mask, sync, application, book, rereadPreimage)
    localGuard()
    completed = true
  }
  try {
    const result: unknown = Reflect.apply(
      binding.run as (...args: unknown[]) => unknown,
      binding.excel,
      [
        (raw: unknown) => {
          const pending = execute(raw)
          // Attach immediately even if a malformed run() discards the callback's promise.
          void pending.catch(() => {})
          callback ??= pending
          return pending
        },
      ]
    )
    if (!isPromise(result)) {
      guard.unknownClosure()
      fail('sdk_failure')
    }
    await result
    localGuard()
    if (!invoked || !completed) fail('sdk_failure')
    return output
  } finally {
    active = false
    // A valid run promise may settle before a misbehaving callback. Keep ownership until it ends.
    await callback?.catch(() => {})
  }
}

export async function prepareOfficeEdit(input: {
  backup: Backup
  excel: unknown
  values: unknown
  exclusiveLocalCopyConfirmed: boolean
  signal?: AbortSignal
}): Promise<OfficeEditPreview> {
  const { backup, excel, values, exclusiveLocalCopyConfirmed, signal } = input
  if (exclusiveLocalCopyConfirmed !== true) return fail('exclusive_copy_required')
  const binding = resolveOfficeBackupEditBinding(backup)
  if (!binding || binding.excel !== excel) return fail('backup_binding_missing')
  if (binding.observation.valueTypes.some((row) => row.includes('Error'))) fail('formula_error')
  const captured = captureValues(values, binding.observation)
  try {
    return await owned(binding, signal, async (guard) => {
      const observation = await readOfficeRange(
        binding.scope,
        excel,
        fixed(binding.observation),
        signal
      )
      guard()
      if (JSON.stringify(observation) !== JSON.stringify(binding.observation))
        fail('preimage_changed')
      const mask = await inspectRange(
        binding,
        observation,
        guard,
        async (_range, nativeMask) => nativeMask
      )
      const changes: OfficeEditPreview['changes'][number][] = []
      for (let row = 0; row < captured.length; row++)
        for (let column = 0; column < captured[row].length; column++) {
          const before = observation.values[row][column]
          const after = captured[row][column]
          if (before === after) continue
          if (mask.has(`${row}:${column}`)) fail('formula_protected')
          changes.push(Object.freeze({ row, column, before, after }))
        }
      const encoded = new TextEncoder().encode(
        JSON.stringify({ receipt: backup.receipt, observation, values: captured, changes })
      )
      const hash = await crypto.subtle.digest('SHA-256', encoded)
      guard()
      const digest = `sha256:${Array.from(new Uint8Array(hash), (n) => n.toString(16).padStart(2, '0')).join('')}`
      const preview = Object.freeze({
        digest,
        observation,
        changes: Object.freeze(changes),
        backupFileId: backup.receipt.fileId,
      })
      previews.set(preview, { backup, binding, values: captured, mask, consumed: false })
      return preview
    })
  } catch (error) {
    throw error instanceof OfficeEditError ? error : new OfficeEditError('sdk_failure')
  }
}

/** Called only at the UI's explicit consent boundary; never inferred from prose. */
export function approveOfficeEdit(preview: OfficeEditPreview): OfficeEditApproval {
  const session = previews.get(preview)
  if (!session || session.consumed) return fail('approval_invalid')
  const approval = Object.freeze({}) as OfficeEditApproval
  approvals.set(approval, preview)
  return approval
}

function verify(
  after: OfficeRangeObservation,
  before: OfficeRangeObservation,
  values: Session['values'],
  mask: ReadonlySet<string>
) {
  if (
    JSON.stringify(after.range) !== JSON.stringify(before.range) ||
    JSON.stringify(after.worksheet) !== JSON.stringify(before.worksheet) ||
    !equal(after.numberFormat, before.numberFormat)
  )
    fail('verification_failed')
  for (let r = 0; r < values.length; r++)
    for (let c = 0; c < values[r].length; c++) {
      if (after.valueTypes[r][c] === 'Error') fail('formula_error')
      if (mask.has(`${r}:${c}`)) {
        if (after.formulas[r][c] !== before.formulas[r][c]) fail('verification_failed')
      } else {
        const value = values[r][c]
        const actual = after.values[r][c]
        const type = after.valueTypes[r][c]
        const matches =
          value === null
            ? type === 'Empty' && (actual === '' || actual === null)
            : actual === value &&
              (typeof value === 'string'
                ? type === 'String'
                : typeof value === 'boolean'
                  ? type === 'Boolean'
                  : type === 'Integer' || type === 'Double')
        if (!matches) fail('verification_failed')
        // Excel exposes constants in the formulas matrix, with an empty string for cleared cells.
        if (after.formulas[r][c] !== (values[r][c] ?? '')) fail('verification_failed')
      }
    }
}

export async function applyOfficeEdit(
  preview: OfficeEditPreview,
  approval: OfficeEditApproval,
  signal?: AbortSignal
): Promise<OfficeEditResult> {
  const session = previews.get(preview)
  if (!session || approvals.get(approval) !== preview)
    return { status: 'refused', code: 'approval_invalid' }
  if (session.consumed) return { status: 'refused', code: 'already_used' }
  session.consumed = true
  approvals.delete(approval)
  let dispatched = false
  try {
    if (resolveOfficeBackupEditBinding(session.backup) !== session.binding)
      fail('backup_binding_missing')
    return await owned(session.binding, signal, async (guard) => {
      // Also shares the existing reader's busy guard with any still-pending native read.
      const before = await readOfficeRange(
        session.binding.scope,
        session.binding.excel,
        fixed(preview.observation),
        signal
      )
      guard()
      if (JSON.stringify(before) !== JSON.stringify(preview.observation)) fail('preimage_changed')
      await inspectRange(session.binding, before, guard, async (range, mask, sync, application) => {
        if (mask.size !== session.mask.size || [...mask].some((key) => !session.mask.has(key)))
          fail('preimage_changed')
        const calculate = range.calculate
        const getCell = range.getCell
        if (typeof calculate !== 'function' || typeof getCell !== 'function') fail('sdk_failure')
        // Resolve all cell handles before the first write, so malformed SDK ports cannot partly dispatch.
        const cells = preview.changes.map((change) => {
          const cell = record(call(range, 'getCell', [change.row, change.column]))
          if (change.after === null && typeof cell.clear !== 'function') fail('sdk_failure')
          return cell
        })
        guard()
        for (let i = 0; i < cells.length; i++) {
          guard()
          dispatched = true
          const value = preview.changes[i].after
          if (value === null) call(cells[i], 'clear', ['Contents'])
          else if (
            !Reflect.set(cells[i], 'values', [[typeof value === 'string' ? `'${value}` : value]])
          )
            fail('sdk_failure')
        }
        guard()
        dispatched = true
        Reflect.apply(calculate, range, [])
        call(application, 'load', ['calculationState'])
        await sync()
        if (application.calculationState !== 'Done') fail('calculation_unconfirmed')
      })
      guard()
      const after = await readOfficeRange(
        session.binding.scope,
        session.binding.excel,
        fixed(preview.observation),
        signal
      )
      guard()
      verify(after, preview.observation, session.values, session.mask)
      await inspectRange(session.binding, after, guard, async (_range, mask) => {
        if (mask.size !== session.mask.size || [...mask].some((key) => !session.mask.has(key)))
          fail('verification_failed')
      })
      const result = Object.freeze({
        status: 'verified' as const,
        observation: after,
        changedCells: preview.changes.length,
        calculation: 'range_calculated' as const,
        durableSave: 'not_confirmed' as const,
      })
      verifiedEdits.set(result, { binding: session.binding, consumed: false })
      return result
    })
  } catch (error) {
    return Object.freeze({
      status: dispatched ? 'uncertain' : 'refused',
      code: error instanceof OfficeEditError ? error.code : 'sdk_failure',
    })
  }
}

type NativeSavePort = Readonly<{
  workbook: RecordValue
  sync: () => Promise<void>
  rereadPreimage: () => Promise<void>
  guard: Guard
  dispatch: () => void
}>

/** Internal native adapter. No exported port or serialized observation grants save authority. */
async function saveNativeWorkbook(port: NativeSavePort): Promise<void> {
  const { workbook, sync, rereadPreimage, guard, dispatch } = port
  const save = workbook.save
  if (typeof save !== 'function') fail('sdk_failure')
  call(workbook, 'load', [['previouslySaved', 'readOnly']])
  await rereadPreimage()
  if (workbook.readOnly !== false) fail('read_only')
  if (workbook.previouslySaved !== true) fail('save_location_required')
  if (workbook.save !== save) fail('scope_changed')
  guard()
  dispatch()
  // SaveBehavior is1.9, but Workbook.save itself is1.11, covered by inspectRange's1.13 gate.
  const result = Reflect.apply(save, workbook, ['Save'])
  if (result !== undefined) {
    guard.unknownClosure()
    fail('sdk_failure')
  }
  await sync()
}

/** An explicit one-shot save of the exact genuine post-apply result; never an automatic retry. */
export async function saveVerifiedOfficeEdit(
  result: OfficeEditResult,
  signal?: AbortSignal
): Promise<OfficeSaveResult> {
  const entry = verifiedEdits.get(result)
  if (!entry) return Object.freeze({ status: 'refused', code: 'save_binding_missing' })
  if (entry.consumed) return Object.freeze({ status: 'refused', code: 'already_used' })
  entry.consumed = true
  let dispatched = false
  try {
    if (result.status !== 'verified') fail('save_binding_missing')
    return await owned(entry.binding, signal, async (guard) => {
      const before = await readOfficeRange(
        entry.binding.scope,
        entry.binding.excel,
        fixed(result.observation),
        signal
      )
      guard()
      if (JSON.stringify(before) !== JSON.stringify(result.observation)) fail('preimage_changed')
      await inspectRange(
        entry.binding,
        before,
        guard,
        async (_range, _mask, sync, _application, workbook, rereadPreimage) =>
          saveNativeWorkbook({
            workbook,
            sync,
            rereadPreimage,
            guard,
            dispatch: () => {
              dispatched = true
            },
          })
      )
      guard()
      const after = await readOfficeRange(
        entry.binding.scope,
        entry.binding.excel,
        fixed(result.observation),
        signal
      )
      guard()
      if (JSON.stringify(after) !== JSON.stringify(result.observation)) fail('verification_failed')
      return Object.freeze({
        status: 'acknowledged',
        durableSave: 'office_acknowledged',
        diskVerification: 'not_observed',
      })
    })
  } catch (error) {
    return Object.freeze({
      status: dispatched ? 'uncertain' : 'refused',
      code: error instanceof OfficeEditError ? error.code : 'sdk_failure',
    })
  }
}
