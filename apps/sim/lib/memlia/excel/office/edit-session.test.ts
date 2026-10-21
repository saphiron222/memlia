// Copyright (c) 2026 Memlia. All rights reserved.
// External Office/HTTP doubles only. These tests do not qualify Excel Desktop.
import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { backupCurrentOfficeWorkbook } from './backup-client'
import {
  applyOfficeEdit,
  approveOfficeEdit,
  getOfficeEditBackupObservation,
  prepareOfficeEdit,
  saveVerifiedOfficeEdit,
} from './edit-session'

type Scalar = string | number | boolean | null
function host() {
  const state = {
    values: [
      [2, 'literal'],
      [3, 5],
    ] as Scalar[][],
    formulas: [
      [2, 'literal'],
      [3, '=SUM(B2:B3)'],
    ] as Scalar[][],
    valueTypes: [
      ['Integer', 'String'],
      ['Integer', 'Integer'],
    ],
    numberFormat: [
      ['General', '@'],
      ['General', '0.00'],
    ],
    formulaCells: [[1, 1]],
    merged: false,
    spill: false,
    protected: false,
    writes: [] as unknown[],
    calculated: 0,
    saved: 0,
    previouslySaved: true,
    readOnly: false,
    saveApiSupported: true,
    saveHook: (() => {}) as () => void,
    syncHook: (() => {}) as () => void | Promise<void>,
  }
  const application = { load: vi.fn(), calculationState: 'Done' }
  let saveMetadataQueued = false
  let saveMetadataAvailable = false
  const context = {
    workbook: {},
    application,
    sync: async () => {
      await state.syncHook()
      if (saveMetadataQueued) saveMetadataAvailable = true
    },
  }
  const load = vi.fn()
  const range = {
    context,
    load,
    address: 'Sheet1!B2:C3',
    rowIndex: 1,
    columnIndex: 1,
    rowCount: 2,
    columnCount: 2,
    cellCount: 4,
    get values() {
      return state.values
    },
    get formulas() {
      return state.formulas
    },
    get valueTypes() {
      return state.valueTypes
    },
    get numberFormat() {
      return state.numberFormat
    },
    get hasSpill() {
      return state.spill
    },
    getMergedAreasOrNullObject: () => ({ load, isNullObject: !state.merged }),
    getSpecialCellsOrNullObject: (kind: string) => {
      expect(kind).toBe('Formulas')
      return {
        load,
        isNullObject: state.formulaCells.length === 0,
        areas: {
          load,
          items: state.formulaCells.map(([r, c]) => ({
            load,
            rowIndex: 1 + r,
            columnIndex: 1 + c,
            rowCount: 1,
            columnCount: 1,
          })),
        },
      }
    },
    getCell: (r: number, c: number) => ({
      set values(matrix: Scalar[][]) {
        const raw = matrix[0][0]
        state.writes.push([r, c, raw])
        const v = typeof raw === 'string' && raw.startsWith("'") ? raw.slice(1) : raw
        state.values[r][c] = v
        state.formulas[r][c] = v
        state.valueTypes[r][c] =
          v === null
            ? 'Empty'
            : typeof v === 'string'
              ? 'String'
              : typeof v === 'boolean'
                ? 'Boolean'
                : Number.isInteger(v)
                  ? 'Integer'
                  : 'Double'
      },
      clear(kind: string) {
        expect(kind).toBe('Contents')
        state.writes.push([r, c, null])
        state.values[r][c] = null
        state.formulas[r][c] = ''
        state.valueTypes[r][c] = 'Empty'
      },
    }),
    calculate() {
      state.calculated++
      state.values[1][1] = Number(state.values[0][0]) + Number(state.values[1][0])
    },
  }
  const sheet = {
    context,
    load,
    id: 'sheet-native',
    name: 'Sheet1',
    protection: {
      load,
      get protected() {
        return state.protected
      },
    },
    getRangeByIndexes: vi.fn(() => range),
  }
  Object.defineProperty(range, 'worksheet', { get: () => sheet })
  const workbook = {
    worksheets: { getItem: () => sheet },
    getSelectedRange: () => range,
    load: vi.fn(() => {
      saveMetadataQueued = true
    }),
    get previouslySaved() {
      if (!saveMetadataAvailable) throw Error('save_metadata_not_loaded')
      return state.previouslySaved
    },
    get readOnly() {
      if (!saveMetadataAvailable) throw Error('save_metadata_not_loaded')
      return state.readOnly
    },
    save: vi.fn(() => {
      state.saved += 1
      state.saveHook()
    }),
  }
  context.workbook = workbook
  const bytes = Uint8Array.of(80, 75, 3, 4)
  const office = {
    onReady: async () => ({ host: 'Excel', platform: 'PC' }),
    context: {
      requirements: {
        isSetSupported: (_name: string, version: string) =>
          version !== '1.13' || state.saveApiSupported,
      },
      document: {
        mode: 'readWrite',
        getFileAsync(_kind: string, _options: unknown, done: (value: unknown) => void) {
          done({
            status: 'succeeded',
            value: {
              size: 4,
              sliceCount: 1,
              getSliceAsync(index: number, callback: (value: unknown) => void) {
                callback({ status: 'succeeded', value: { index, size: 4, data: bytes } })
              },
              closeAsync(callback: (value: unknown) => void) {
                callback({ status: 'succeeded' })
              },
            },
          })
        },
      },
    },
  }
  const excel = {
    run: vi.fn(async (callback: (ctx: typeof context) => Promise<unknown>) => callback(context)),
  }
  const receipt = {
    schemaVersion: 'memlia.office-copy-storage/v1',
    workspaceId: 'workspace-fixture',
    ownerUserId: 'user-fixture',
    fileId: 'backup-fixture',
    contentVersion: 17,
    byteLength: 4,
    sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  }
  const fetch = vi.fn(
    async () =>
      new Response(JSON.stringify({ status: 'stored', receipt }), {
        headers: { 'Content-Type': 'application/json' },
      })
  )
  vi.stubGlobal('fetch', fetch)
  const backup = () =>
    backupCurrentOfficeWorkbook({
      office,
      workspaceId: 'workspace-fixture',
      expectedUserId: 'user-fixture',
      editSelection: { excel },
    })
  return { state, context, application, range, sheet, office, excel, fetch, backup, workbook }
}
async function ready(h = host()) {
  const backup = await h.backup()
  if (backup.status !== 'stored') throw new Error('backup did not bind')
  const values = [
    [4, 'literal'],
    [3, 5],
  ]
  return { h, backup, values }
}
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('binds only the exact immutable receipt to the observed document, not a JSON clone', async () => {
  const { backup } = await ready()
  expect(getOfficeEditBackupObservation(backup)?.values).toEqual([
    [2, 'literal'],
    [3, 5],
  ])
  expect(getOfficeEditBackupObservation(JSON.parse(JSON.stringify(backup)))).toBeNull()
  expect(Object.isFrozen(backup.receipt)).toBe(true)
})
it('retains a stored file as unconfirmed if selection changes during backup; never retries POST', async () => {
  const h = host()
  const original = h.fetch.getMockImplementation()!
  h.fetch.mockImplementation(async () => {
    h.state.values[0][0] = 99
    return original()
  })
  expect(await h.backup()).toEqual({
    status: 'unconfirmed',
    code: 'selection_changed',
    fileId: 'backup-fixture',
  })
  expect(h.fetch).toHaveBeenCalledTimes(1)
})
it('previews exact changes, writes once, calculates only the range and independently verifies', async () => {
  const { h, backup, values } = await ready()
  const preview = await prepareOfficeEdit({
    backup,
    excel: h.excel,
    values,
    exclusiveLocalCopyConfirmed: true,
  })
  expect(preview.changes).toEqual([{ row: 0, column: 0, before: 2, after: 4 }])
  expect(preview.digest).toMatch(/^sha256:[a-f0-9]{64}$/)
  values[0][0] = 100
  const approval = approveOfficeEdit(preview)
  const result = await applyOfficeEdit(preview, approval)
  expect(result).toMatchObject({
    status: 'verified',
    changedCells: 1,
    calculation: 'range_calculated',
    durableSave: 'not_confirmed',
    observation: {
      values: [
        [4, 'literal'],
        [3, 7],
      ],
    },
  })
  expect(h.state.writes).toEqual([[0, 0, 4]])
  expect(h.state.formulas[1][1]).toBe('=SUM(B2:B3)')
  expect(h.state.calculated).toBe(1)
  expect(await applyOfficeEdit(preview, approval)).toMatchObject({ status: 'refused' })
})
it.each(['merged', 'spill', 'protected'] as const)('refuses %s without writing', async (key) => {
  const { h, backup, values } = await ready()
  h.state[key] = true
  await expect(
    prepareOfficeEdit({ backup, excel: h.excel, values, exclusiveLocalCopyConfirmed: true })
  ).rejects.toMatchObject({ code: 'unsafe_range' })
  expect(h.state.writes).toEqual([])
})
it('uses native formula membership to refuse a replacement of a calculated value', async () => {
  const { h, backup, values } = await ready()
  values[1][1] = 9
  await expect(
    prepareOfficeEdit({ backup, excel: h.excel, values, exclusiveLocalCopyConfirmed: true })
  ).rejects.toMatchObject({ code: 'formula_protected' })
  expect(h.state.writes).toEqual([])
})
it('treats a formula-looking constant as literal, and a native formula with identical text as protected', async () => {
  const h = host()
  h.state.values[0][1] = '=literal'
  h.state.formulas[0][1] = '=literal'
  h.state.values[1][1] = '=opaque'
  h.state.formulas[1][1] = '=opaque'
  h.state.valueTypes[1][1] = 'String'
  const { backup } = await ready(h)
  const p = await prepareOfficeEdit({
    backup,
    excel: h.excel,
    values: [
      [2, "'literal"],
      [3, '=opaque'],
    ],
    exclusiveLocalCopyConfirmed: true,
  })
  expect(p.changes).toEqual([{ row: 0, column: 1, before: '=literal', after: "'literal" }])
  await expect(
    prepareOfficeEdit({
      backup,
      excel: h.excel,
      values: [
        [2, '=literal'],
        [3, 'changed'],
      ],
      exclusiveLocalCopyConfirmed: true,
    })
  ).rejects.toMatchObject({ code: 'formula_protected' })
})
it('refuses changed preimage after consent before any write', async () => {
  const { h, backup, values } = await ready()
  const p = await prepareOfficeEdit({
    backup,
    excel: h.excel,
    values,
    exclusiveLocalCopyConfirmed: true,
  })
  const a = approveOfficeEdit(p)
  h.state.numberFormat[0][0] = '0.000'
  expect(await applyOfficeEdit(p, a)).toMatchObject({ status: 'refused', code: 'preimage_changed' })
  expect(h.state.writes).toEqual([])
})
it('escapes formula-looking and apostrophe strings as literal values; null clears contents only', async () => {
  const { h, backup } = await ready()
  const p = await prepareOfficeEdit({
    backup,
    excel: h.excel,
    values: [
      [null, '=HYPERLINK("x")'],
      [3, 5],
    ],
    exclusiveLocalCopyConfirmed: true,
  })
  expect(await applyOfficeEdit(p, approveOfficeEdit(p))).toMatchObject({ status: 'verified' })
  expect(h.state.writes).toEqual([
    [0, 0, null],
    [0, 1, '\'=HYPERLINK("x")'],
  ])
})
it('refuses forged preview/approval and does not let a mismatched approval consume another preview', async () => {
  const { h, backup, values } = await ready()
  const p = await prepareOfficeEdit({
    backup,
    excel: h.excel,
    values,
    exclusiveLocalCopyConfirmed: true,
  })
  const a = approveOfficeEdit(p)
  expect(() => approveOfficeEdit({ ...p })).toThrow()
  expect(await applyOfficeEdit(p, { ...a })).toMatchObject({ status: 'refused' })
  expect(await applyOfficeEdit(p, a)).toMatchObject({ status: 'verified' })
})
it.each([false, undefined])(
  'requires the explicit local-copy attestation: %s',
  async (confirmed) => {
    const { h, backup, values } = await ready()
    await expect(
      prepareOfficeEdit({
        backup,
        excel: h.excel,
        values,
        exclusiveLocalCopyConfirmed: confirmed as boolean,
      })
    ).rejects.toMatchObject({ code: 'exclusive_copy_required' })
  }
)
it.each([
  {
    values: [
      [Number.NaN, 'x'],
      [3, 5],
    ],
  },
  {
    values: [
      [{}, 'x'],
      [3, 5],
    ],
  },
  { values: [[2]] },
  {
    values: [
      [Number.POSITIVE_INFINITY, 'x'],
      [3, 5],
    ],
  },
])('refuses a malformed matrix before mutation', async ({ values }) => {
  const { h, backup } = await ready()
  await expect(
    prepareOfficeEdit({ backup, excel: h.excel, values, exclusiveLocalCopyConfirmed: true })
  ).rejects.toMatchObject({ code: 'invalid_values' })
  expect(h.state.writes).toEqual([])
})
it('classifies an SDK failure after dispatch as uncertain without rollback or replay', async () => {
  const { h, backup, values } = await ready()
  const p = await prepareOfficeEdit({
    backup,
    excel: h.excel,
    values,
    exclusiveLocalCopyConfirmed: true,
  })
  h.state.syncHook = () => {
    if (h.state.writes.length) throw new Error('PRIVATE CONTENT')
  }
  expect(await applyOfficeEdit(p, approveOfficeEdit(p))).toEqual({
    status: 'uncertain',
    code: 'sdk_failure',
  })
  expect(h.state.writes).toHaveLength(1)
})
it('rejects accessors/sparse and oversized matrices before invoking their cells', async () => {
  const { h, backup } = await ready()
  const getter = vi.fn(() => 4)
  const cellRow = [2, 'literal']
  Object.defineProperty(cellRow, '0', { get: getter })
  for (const values of [
    [cellRow, [3, 5]],
    [
      [undefined, 'literal'],
      [3, 5],
    ],
    [
      [2, 'x'.repeat(32768)],
      [3, 5],
    ],
    Array(10001).fill([1]),
  ]) {
    await expect(
      prepareOfficeEdit({ backup, excel: h.excel, values, exclusiveLocalCopyConfirmed: true })
    ).rejects.toMatchObject({ code: 'invalid_values' })
  }
  expect(getter).not.toHaveBeenCalled()
})
it('does not bind a historical copy or a different Excel adapter', async () => {
  const h = host()
  const backup = await backupCurrentOfficeWorkbook({
    office: h.office,
    workspaceId: 'workspace-fixture',
    expectedUserId: 'user-fixture',
  })
  expect(getOfficeEditBackupObservation(backup)).toBeNull()
  const b = await ready(h)
  await expect(
    prepareOfficeEdit({
      backup: b.backup,
      excel: { ...h.excel },
      values: b.values,
      exclusiveLocalCopyConfirmed: true,
    })
  ).rejects.toMatchObject({ code: 'backup_binding_missing' })
})
it('revokes the receipt binding when the document changes', async () => {
  const { h, backup, values } = await ready()
  h.office.context.document = { ...h.office.context.document }
  expect(getOfficeEditBackupObservation(backup)).toBeNull()
  await expect(
    prepareOfficeEdit({ backup, excel: h.excel, values, exclusiveLocalCopyConfirmed: true })
  ).rejects.toMatchObject({ code: 'backup_binding_missing' })
})
it('refuses pre-dispatch cancellation and consumes approval without any write', async () => {
  const { h, backup, values } = await ready()
  const p = await prepareOfficeEdit({
    backup,
    excel: h.excel,
    values,
    exclusiveLocalCopyConfirmed: true,
  })
  const a = approveOfficeEdit(p)
  const abort = new AbortController()
  abort.abort()
  expect(await applyOfficeEdit(p, a, abort.signal)).toEqual({
    status: 'refused',
    code: 'cancelled',
  })
  expect(h.state.writes).toEqual([])
  expect(await applyOfficeEdit(p, a)).toMatchObject({ status: 'refused' })
})
it('keeps native ownership after cancellation until the in-flight sync really settles', async () => {
  const { h, backup, values } = await ready()
  const p = await prepareOfficeEdit({
    backup,
    excel: h.excel,
    values,
    exclusiveLocalCopyConfirmed: true,
  })
  const abort = new AbortController()
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  h.state.syncHook = () => (h.state.writes.length ? held : undefined)
  const pending = applyOfficeEdit(p, approveOfficeEdit(p), abort.signal)
  await vi.waitFor(() => expect(h.state.writes).toHaveLength(1))
  abort.abort()
  expect(await pending).toEqual({ status: 'uncertain', code: 'cancelled' })
  await expect(
    prepareOfficeEdit({ backup, excel: h.excel, values, exclusiveLocalCopyConfirmed: true })
  ).rejects.toMatchObject({ code: 'busy' })
  h.state.syncHook = () => {}
  release()
  await vi.waitFor(async () => {
    await expect(
      prepareOfficeEdit({ backup, excel: h.excel, values, exclusiveLocalCopyConfirmed: true })
    ).rejects.toMatchObject({ code: 'preimage_changed' })
  })
  expect(h.state.writes).toHaveLength(1)
})
it('does not revive a timed-out native batch or release its slot early', async () => {
  const { h, backup, values } = await ready()
  const p = await prepareOfficeEdit({
    backup,
    excel: h.excel,
    values,
    exclusiveLocalCopyConfirmed: true,
  })
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  h.state.syncHook = () => (h.state.writes.length ? held : undefined)
  const pending = applyOfficeEdit(p, approveOfficeEdit(p))
  await vi.waitFor(() => expect(h.state.writes).toHaveLength(1))
  // Move the monotonic clock before the native acknowledgement, without waiting in real time.
  const now = performance.now()
  vi.spyOn(performance, 'now').mockReturnValue(now + 10_001)
  release()
  expect(await pending).toEqual({ status: 'uncertain', code: 'timeout' })
  vi.restoreAllMocks()
  expect(h.state.writes).toHaveLength(1)
})
it('does not claim verified when native readback reports a formula error or a changed format', async () => {
  for (const bad of ['error', 'format']) {
    const { h, backup, values } = await ready()
    const p = await prepareOfficeEdit({
      backup,
      excel: h.excel,
      values,
      exclusiveLocalCopyConfirmed: true,
    })
    h.state.syncHook = () => {
      if (h.state.writes.length) {
        if (bad === 'error') {
          h.state.values[1][1] = '#VALUE!'
          h.state.valueTypes[1][1] = 'Error'
        } else h.state.numberFormat[0][0] = '0.000'
      }
    }
    expect(await applyOfficeEdit(p, approveOfficeEdit(p))).toEqual({
      status: 'uncertain',
      code: bad === 'error' ? 'formula_error' : 'verification_failed',
    })
  }
})
it('refuses a native metadata range that leaves the captured selection', async () => {
  const { h, backup, values } = await ready()
  h.state.formulaCells = [[4, 1]]
  await expect(
    prepareOfficeEdit({ backup, excel: h.excel, values, exclusiveLocalCopyConfirmed: true })
  ).rejects.toMatchObject({ code: 'unsafe_range' })
  expect(h.state.writes).toEqual([])
})
it('refuses a non-Promise sync without dispatching and retains unknown native ownership', async () => {
  const { h, backup, values } = await ready()
  const p = await prepareOfficeEdit({
    backup,
    excel: h.excel,
    values,
    exclusiveLocalCopyConfirmed: true,
  })
  const native = h.excel.run.getMockImplementation()!
  h.excel.run.mockImplementationOnce(native).mockImplementationOnce(async (callback) => {
    h.context.sync = (() => undefined) as never
    return native(callback)
  })
  expect(await applyOfficeEdit(p, approveOfficeEdit(p))).toMatchObject({ status: 'refused' })
  expect(h.state.writes).toEqual([])
  await expect(
    prepareOfficeEdit({ backup, excel: h.excel, values, exclusiveLocalCopyConfirmed: true })
  ).rejects.toMatchObject({ code: 'busy' })
})
it('inhibits a started callback when run returns no promise, without releasing its unknown slot', async () => {
  const { h, backup, values } = await ready()
  const p = await prepareOfficeEdit({
    backup,
    excel: h.excel,
    values,
    exclusiveLocalCopyConfirmed: true,
  })
  const native = h.excel.run.getMockImplementation()!
  let batch: Promise<unknown> | undefined
  h.excel.run.mockImplementationOnce(native).mockImplementationOnce(((
    callback: (ctx: typeof h.context) => Promise<unknown>
  ) => {
    batch = callback(h.context)
    void batch.catch(() => {})
    return undefined
  }) as never)
  expect(await applyOfficeEdit(p, approveOfficeEdit(p))).toMatchObject({ status: 'refused' })
  await batch?.catch(() => {})
  expect(h.state.writes).toEqual([])
  await expect(
    prepareOfficeEdit({ backup, excel: h.excel, values, exclusiveLocalCopyConfirmed: true })
  ).rejects.toMatchObject({ code: 'busy' })
})
it('a callback delivered after run has already settled cannot enter the document', async () => {
  const { h, backup, values } = await ready()
  const p = await prepareOfficeEdit({
    backup,
    excel: h.excel,
    values,
    exclusiveLocalCopyConfirmed: true,
  })
  const native = h.excel.run.getMockImplementation()!
  let late!: (context: typeof h.context) => Promise<unknown>
  h.excel.run.mockImplementationOnce(native).mockImplementationOnce(async (callback) => {
    late = callback
  })
  expect(await applyOfficeEdit(p, approveOfficeEdit(p))).toMatchObject({ status: 'refused' })
  await expect(late(h.context)).rejects.toBeDefined()
  expect(h.state.writes).toEqual([])
})
it('accepts native Empty with an empty string after explicit null clearing only', async () => {
  const { h, backup } = await ready()
  const p = await prepareOfficeEdit({
    backup,
    excel: h.excel,
    values: [
      [null, 'literal'],
      [3, 5],
    ],
    exclusiveLocalCopyConfirmed: true,
  })
  h.state.syncHook = () => {
    if (h.state.writes.length) h.state.values[0][0] = ''
  }
  expect(await applyOfficeEdit(p, approveOfficeEdit(p))).toMatchObject({ status: 'verified' })
})
it('does not treat Empty as a successful literal empty-string write', async () => {
  const { h, backup } = await ready()
  const p = await prepareOfficeEdit({
    backup,
    excel: h.excel,
    values: [
      [2, ''],
      [3, 5],
    ],
    exclusiveLocalCopyConfirmed: true,
  })
  h.state.syncHook = () => {
    if (h.state.writes.length) h.state.valueTypes[0][1] = 'Empty'
  }
  expect(await applyOfficeEdit(p, approveOfficeEdit(p))).toMatchObject({
    status: 'uncertain',
    code: 'verification_failed',
  })
})
it('requires observed Done after the one targeted calculation, without repeating it', async () => {
  const { h, backup, values } = await ready()
  const p = await prepareOfficeEdit({
    backup,
    excel: h.excel,
    values,
    exclusiveLocalCopyConfirmed: true,
  })
  h.application.calculationState = 'Calculating'
  expect(await applyOfficeEdit(p, approveOfficeEdit(p))).toEqual({
    status: 'uncertain',
    code: 'calculation_unconfirmed',
  })
  expect(h.state.calculated).toBe(1)
})

it('refuses lone surrogates before any native write', async () => {
  const { h, backup } = await ready()
  await expect(
    prepareOfficeEdit({
      backup,
      excel: h.excel,
      values: [
        [2, '\ud800'],
        [3, 5],
      ],
      exclusiveLocalCopyConfirmed: true,
    })
  ).rejects.toMatchObject({ code: 'invalid_values' })
  expect(h.state.writes).toEqual([])
})
it('refuses an already errored selection during preparation', async () => {
  const h = host()
  h.state.values[1][1] = '#VALUE!'
  h.state.valueTypes[1][1] = 'Error'
  const { backup } = await ready(h)
  await expect(
    prepareOfficeEdit({
      backup,
      excel: h.excel,
      values: [
        [4, 'literal'],
        [3, '#VALUE!'],
      ],
      exclusiveLocalCopyConfirmed: true,
    })
  ).rejects.toMatchObject({ code: 'formula_error' })
  expect(h.state.writes).toEqual([])
})

it('does not certify a literal if the native formula mask changes despite identical value/formula text', async () => {
  const { h, backup } = await ready()
  const p = await prepareOfficeEdit({
    backup,
    excel: h.excel,
    values: [
      [2, '=literal'],
      [3, 5],
    ],
    exclusiveLocalCopyConfirmed: true,
  })
  h.state.syncHook = () => {
    if (h.state.writes.length)
      h.state.formulaCells = [
        [1, 1],
        [0, 1],
      ]
  }
  expect(await applyOfficeEdit(p, approveOfficeEdit(p))).toEqual({
    status: 'uncertain',
    code: 'verification_failed',
  })
})

async function verifiedForSave(h = host()) {
  const { backup, values } = await ready(h)
  const preview = await prepareOfficeEdit({
    backup,
    excel: h.excel,
    values,
    exclusiveLocalCopyConfirmed: true,
  })
  const result = await applyOfficeEdit(preview, approveOfficeEdit(preview))
  expect(result.status).toBe('verified')
  return { h, result, backup, values }
}
it('save final: requires the genuine verified result and dispatches one explicit native save only', async () => {
  const { h, result } = await verifiedForSave()
  expect(h.state.saved).toBe(0)
  expect(await saveVerifiedOfficeEdit(structuredClone(result))).toMatchObject({
    status: 'refused',
    code: 'save_binding_missing',
  })
  expect(await saveVerifiedOfficeEdit(result)).toEqual({
    status: 'acknowledged',
    durableSave: 'office_acknowledged',
    diskVerification: 'not_observed',
  })
  expect(h.workbook.save).toHaveBeenCalledExactlyOnceWith('Save')
  expect(h.workbook.load).toHaveBeenCalledWith(['previouslySaved', 'readOnly'])
  expect(h.state.calculated).toBe(1)
  expect(h.state.writes).toEqual([[0, 0, 4]])
  expect(await saveVerifiedOfficeEdit(result)).toMatchObject({
    status: 'refused',
    code: 'already_used',
  })
  expect(h.state.saved).toBe(1)
})
it('save final: refuses unsaved and read-only workbooks without selecting a default save location', async () => {
  for (const key of ['previouslySaved', 'readOnly'] as const) {
    const { h, result } = await verifiedForSave()
    h.state[key] = key === 'readOnly'
    expect(await saveVerifiedOfficeEdit(result)).toMatchObject({
      status: 'refused',
      code: key === 'readOnly' ? 'read_only' : 'save_location_required',
    })
    expect(h.workbook.save).not.toHaveBeenCalled()
  }
})

it('save final: rechecks the scope, save API and both initial and last preimages before dispatch', async () => {
  for (const mode of ['scope', 'requirement', 'initial', 'metadata', 'method'] as const) {
    const { h, result } = await verifiedForSave()
    if (mode === 'scope') h.office.context.document = { ...h.office.context.document }
    if (mode === 'requirement') h.state.saveApiSupported = false
    if (mode === 'initial') h.state.values[0][0] = 91
    if (mode === 'metadata') {
      const load = h.workbook.load.getMockImplementation()!
      h.workbook.load.mockImplementation(() => {
        load()
        h.state.values[0][0] = 92
      })
    }
    if (mode === 'method') h.workbook.save = undefined as never
    expect(await saveVerifiedOfficeEdit(result)).toMatchObject({ status: 'refused' })
    if (h.workbook.save) expect(h.workbook.save).not.toHaveBeenCalled()
    expect(h.state.saved).toBe(0)
  }
})
it('save final: a dispatched native error stays uncertain and never retries the same result', async () => {
  const { h, result } = await verifiedForSave()
  h.state.saveHook = () => {
    throw Error('PRIVATE_CANARY native failure')
  }
  expect(await saveVerifiedOfficeEdit(result)).toEqual({ status: 'uncertain', code: 'sdk_failure' })
  expect(await saveVerifiedOfficeEdit(result)).toEqual({ status: 'refused', code: 'already_used' })
  expect(h.state.saved).toBe(1)
})
it('save final: a changed post-save observation cannot become an acknowledged verified save', async () => {
  const { h, result } = await verifiedForSave()
  h.state.saveHook = () => {
    h.state.values[0][0] = 93
  }
  expect(await saveVerifiedOfficeEdit(result)).toEqual({
    status: 'uncertain',
    code: 'verification_failed',
  })
  expect(h.state.saved).toBe(1)
})
it('save final: a timed out native save retains ownership until the actual sync finishes', async () => {
  const { h, result, backup, values } = await verifiedForSave()
  vi.useFakeTimers()
  let finish!: () => void
  const wait = new Promise<void>((resolve) => {
    finish = resolve
  })
  h.state.syncHook = () => (h.state.saved ? wait : undefined)
  const saving = saveVerifiedOfficeEdit(result)
  for (let i = 0; i < 1000 && !h.state.saved; i++) await Promise.resolve()
  expect(h.state.saved).toBe(1)
  await vi.advanceTimersByTimeAsync(10_001)
  expect(await saving).toEqual({ status: 'uncertain', code: 'timeout' })
  await expect(
    prepareOfficeEdit({ backup, excel: h.excel, values, exclusiveLocalCopyConfirmed: true })
  ).rejects.toMatchObject({ code: 'busy' })
  expect(await saveVerifiedOfficeEdit(result)).toMatchObject({
    status: 'refused',
    code: 'already_used',
  })
  finish()
  for (let i = 0; i < 100; i++) await Promise.resolve()
  expect(h.state.saved).toBe(1)
  await expect(
    prepareOfficeEdit({ backup, excel: h.excel, values, exclusiveLocalCopyConfirmed: true })
  ).rejects.toMatchObject({ code: 'preimage_changed' })
})
