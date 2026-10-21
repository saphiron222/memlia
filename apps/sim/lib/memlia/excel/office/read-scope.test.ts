// Copyright (c) 2026 Memlia. All rights reserved.
// The Office/Excel SDK is doubled at its external boundary; no Desktop qualification.

import { createDeferred } from '@sim/testing/helpers/deferred'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { preflightOffice } from './preflight'
import { readOfficeRange, readSelectedOfficeRange } from './read-scope'

const request = {
  sheetId: '{native-sheet-id}',
  startRow: 2,
  endRow: 3,
  startColumn: 2,
  endColumn: 3,
}
function host() {
  const calls: unknown[] = []
  const queued = new Set<string>()
  const loaded = new Set<string>()
  const data = {
    address: "'Données'!B2:C3",
    rowIndex: 1,
    columnIndex: 1,
    rowCount: 2,
    columnCount: 2,
    cellCount: 4,
    values: [
      [3, 'literal'],
      [false, '#VALUE!'],
    ],
    valueTypes: [
      ['Integer', 'String'],
      ['Boolean', 'Error'],
    ],
    formulas: [
      ['=XLOOKUP(A1,D:D,E:E)', 'literal'],
      [false, '#VALUE!'],
    ],
    numberFormat: [
      ['0.00', '@'],
      ['General', 'General'],
    ],
  }
  const context = {
    workbook: {},
    sync: async () => {
      calls.push('sync')
      for (const name of queued) loaded.add(name)
    },
  }
  const range = {
    context,
    load: (properties: unknown) => {
      if (
        !Array.isArray(properties) ||
        properties.some((name) => typeof name !== 'string' || !(name in data))
      )
        throw new Error('invalid load')
      for (const name of properties) queued.add(`range.${name}`)
      calls.push(['range.load', properties])
    },
  }
  for (const key of Object.keys(data)) {
    Object.defineProperty(range, key, {
      get: () => {
        if (!loaded.has(`range.${key}`)) throw new Error('not loaded')
        calls.push(['read', key])
        return data[key as keyof typeof data]
      },
      set: () => {
        throw new Error('write forbidden')
      },
    })
  }
  const sheet = {
    context,
    get id() {
      if (!loaded.has('sheet.id')) throw new Error('not loaded')
      return request.sheetId
    },
    get name() {
      if (!loaded.has('sheet.name')) throw new Error('not loaded')
      return 'Données'
    },
    load: (properties: unknown) => {
      if (!Array.isArray(properties) || properties.some((name) => !['id', 'name'].includes(name)))
        throw new Error('invalid load')
      for (const name of properties) queued.add(`sheet.${name}`)
      calls.push(['sheet.load', properties])
    },
    getRangeByIndexes: (...coordinates: number[]) => {
      calls.push(['range', ...coordinates])
      return range
    },
  }
  const sheets = {
    getItem: (id: string) => {
      calls.push(['sheet', id])
      return sheet
    },
  }
  Object.defineProperty(range, 'worksheet', { get: () => sheet })
  const book = {
    worksheets: sheets,
    getSelectedRange: () => {
      calls.push('selection')
      return range
    },
  }
  context.workbook = book
  const office = {
    onReady: async () => ({ host: 'Excel', platform: 'PC' }),
    context: {
      requirements: { isSetSupported: (_name: string, _version: string) => true },
      document: {
        mode: 'readWrite',
        getFileAsync: () => {
          throw new Error('no file request permitted')
        },
      },
    },
  }
  const excel = {
    run: async (batch: (ctx: typeof context) => Promise<unknown>) => {
      calls.push('run')
      try {
        return await batch(context)
      } finally {
        calls.push('run-ended')
      }
    },
  }
  return { office, excel, context, book, sheet, sheets, range, data, calls }
}

describe('explicit Office range read', () => {
  afterEach(() => vi.useRealTimers())
  it('loads/syncs one explicit range and preserves opaque formulas and detached values', async () => {
    const h = host()
    const result = await readOfficeRange(await preflightOffice(h.office), h.excel, request)
    expect(result).toMatchObject({
      version: 1,
      kind: 'office_range_observation',
      scope: 'current_office_document',
      qualification: 'not_verified',
      worksheet: { id: request.sheetId, name: 'Données' },
      range: { ...request, address: "'Données'!B2:C3" },
      values: [
        [3, 'literal'],
        [false, '#VALUE!'],
      ],
      valueTypes: [
        ['Integer', 'String'],
        ['Boolean', 'Error'],
      ],
      formulas: [
        ['=XLOOKUP(A1,D:D,E:E)', 'literal'],
        [false, '#VALUE!'],
      ],
      numberFormat: [
        ['0.00', '@'],
        ['General', 'General'],
      ],
    })
    expect(h.calls.filter((value) => value === 'sync')).toHaveLength(1)
    expect(h.calls).toContainEqual(['sheet', request.sheetId])
    expect(h.calls).toContainEqual(['range', 1, 1, 2, 2])
    h.data.values[0][0] = 99
    expect(result.values[0][0]).toBe(3)
    expect(Object.isFrozen(result.values[0])).toBe(true)
  })
  it.each([
    { startRow: 0 },
    { endRow: 1 },
    { startColumn: 0 },
    { endColumn: 1 },
    { startRow: 1.5 },
    { endRow: 1_048_577 },
    { endColumn: 16_385 },
    { endRow: 201, endColumn: 201 },
    { sheetId: '' },
    { unexpected: true },
  ])('refuses an invalid or oversized explicit scope before Excel.run %j', async (change) => {
    const h = host()
    await expect(
      readOfficeRange(await preflightOffice(h.office), h.excel, { ...request, ...change })
    ).rejects.toMatchObject({ code: 'office_read_scope_invalid' })
    expect(h.calls).toEqual([])
  })
  it('captures the requested coordinates before the first await', async () => {
    const h = host()
    const asked = { ...request }
    const sync = h.context.sync
    h.context.sync = async () => {
      await sync()
      asked.sheetId = 'other'
      asked.startRow = 100
    }
    await expect(
      readOfficeRange(await preflightOffice(h.office), h.excel, asked)
    ).resolves.toMatchObject({ range: request })
  })
  it('requires the returned worksheet identity and range coordinates to match the request', async () => {
    const h = host()
    h.data.rowIndex = 2
    await expect(
      readOfficeRange(await preflightOffice(h.office), h.excel, request)
    ).rejects.toMatchObject({ code: 'office_range_invalid' })
  })
  it('refuses a range proxy belonging to another request context before sync', async () => {
    const h = host()
    Object.assign(h.range, { context: {} })
    await expect(
      readOfficeRange(await preflightOffice(h.office), h.excel, request)
    ).rejects.toMatchObject({ code: 'office_read_scope_changed' })
    expect(h.calls).not.toContain('sync')
  })
  it('normalizes private SDK exceptions without returning their messages or cause', async () => {
    const h = host()
    h.context.sync = async () => {
      throw new Error('SENSITIVE_WORKBOOK_OR_TOKEN')
    }
    const failure = await readOfficeRange(await preflightOffice(h.office), h.excel, request).catch(
      (e: unknown) => e
    )
    expect(failure).toMatchObject({
      code: 'office_read_sdk_failure',
      message: 'office_read_sdk_failure',
    })
    expect(failure).not.toHaveProperty('cause')
  })

  it('rejects an already cancelled read without calling Excel.run', async () => {
    const h = host()
    const controller = new AbortController()
    controller.abort()
    await expect(
      readOfficeRange(await preflightOffice(h.office), h.excel, request, controller.signal)
    ).rejects.toMatchObject({ code: 'office_read_cancelled' })
    expect(h.calls).toEqual([])
  })
  it('cancels a pending sync without publishing data or releasing a still active read', async () => {
    const h = host()
    const entered = createDeferred<void>()
    const done = createDeferred<void>()
    const sync = h.context.sync
    h.context.sync = async () => {
      entered.resolve()
      await done.promise
      await sync()
    }
    const scope = await preflightOffice(h.office)
    const controller = new AbortController()
    let rejected: unknown
    const pending = readOfficeRange(scope, h.excel, request, controller.signal).catch(
      (error: unknown) => {
        rejected = error
      }
    )
    await entered.promise
    try {
      controller.abort()
      await pending
      expect(rejected).toMatchObject({ code: 'office_read_cancelled' })
      await expect(readOfficeRange(scope, h.excel, request)).rejects.toMatchObject({
        code: 'office_read_busy',
      })
    } finally {
      done.resolve()
      await pending
      await vi.waitFor(() => expect(h.calls).toContain('run-ended'))
    }
    expect(h.calls.filter((value) => Array.isArray(value) && value[0] === 'read')).toEqual([])
  })
  it('rejects an ACK after the monotonic deadline even before its timer is dispatched', async () => {
    vi.useFakeTimers()
    const h = host()
    vi.spyOn(performance, 'now').mockReturnValue(0)
    const sync = h.context.sync
    h.context.sync = async () => {
      await sync()
      vi.mocked(performance.now).mockReturnValue(10_000)
    }
    await expect(
      readOfficeRange(await preflightOffice(h.office), h.excel, request)
    ).rejects.toMatchObject({ code: 'office_read_timeout' })
  })
  it.each([
    { values: [[3, 'literal']] },
    {
      numberFormat: [
        ['General', null],
        ['General', 'General'],
      ],
    },
    {
      valueTypes: [
        ['RichValue', 'String'],
        ['Boolean', 'Error'],
      ],
    },
    {
      values: [
        [Number.NaN, 'literal'],
        [false, '#VALUE!'],
      ],
    },
    {
      formulas: [
        [{ arbitrary: 'object' }, 'literal'],
        [false, '#VALUE!'],
      ],
    },
    {
      values: [
        [3, '\uD800'],
        [false, '#VALUE!'],
      ],
    },
  ])(
    'refuses unsupported or malformed SDK cells without partial observation %j',
    async (change) => {
      const h = host()
      Object.assign(h.data, change)
      const failure = await readOfficeRange(
        await preflightOffice(h.office),
        h.excel,
        request
      ).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(Error)
      expect(failure).not.toHaveProperty('values')
      expect(failure).not.toHaveProperty('formulas')
    }
  )

  it('refuses inconsistent basic value types rather than inventing a typed cell', async () => {
    const h = host()
    h.data.valueTypes[0][0] = 'String'
    await expect(
      readOfficeRange(await preflightOffice(h.office), h.excel, request)
    ).rejects.toMatchObject({ code: 'office_range_value_unsupported' })
  })
  it('refuses accessor/hidden fields and null input without executing caller getters', async () => {
    const h = host()
    let accessed = false
    const input = { ...request }
    Object.defineProperty(input, 'sheetId', {
      get: () => {
        accessed = true
        return request.sheetId
      },
    })
    const scope = await preflightOffice(h.office)
    await expect(readOfficeRange(scope, h.excel, input)).rejects.toMatchObject({
      code: 'office_read_scope_invalid',
    })
    await expect(readOfficeRange(scope, h.excel, null)).rejects.toMatchObject({
      code: 'office_read_scope_invalid',
    })
    expect(accessed).toBe(false)
    expect(h.calls).toEqual([])
  })
  it('refuses values beyond the bounded total text profile', async () => {
    const h = host()
    const values = Array.from({ length: 10 }, () => Array(10).fill('a'.repeat(10_000)))
    Object.assign(h.data, {
      rowIndex: 0,
      columnIndex: 0,
      rowCount: 10,
      columnCount: 10,
      cellCount: 100,
      values,
      formulas: values,
      valueTypes: Array.from({ length: 10 }, () => Array(10).fill('String')),
      numberFormat: Array.from({ length: 10 }, () => Array(10).fill('General')),
    })
    await expect(
      readOfficeRange(await preflightOffice(h.office), h.excel, {
        ...request,
        startRow: 1,
        startColumn: 1,
        endRow: 10,
        endColumn: 10,
      })
    ).rejects.toMatchObject({ code: 'office_range_invalid' })
  })
  it('keeps date serials and formula-looking strings opaque without creating a canonical Snapshot', async () => {
    const h = host()
    Object.assign(h.data, {
      values: [
        [45292, '=literal'],
        [false, '#VALUE!'],
      ],
      valueTypes: [
        ['Double', 'String'],
        ['Boolean', 'Error'],
      ],
      formulas: [
        [45292, '=literal'],
        [false, '#VALUE!'],
      ],
      numberFormat: [
        ['yyyy-mm-dd', '@'],
        ['General', 'General'],
      ],
    })
    const result = await readOfficeRange(await preflightOffice(h.office), h.excel, request)
    expect(result.values[0]).toEqual([45292, '=literal'])
    expect(result.formulas[0]).toEqual([45292, '=literal'])
    expect(result).not.toHaveProperty('snapshotId')
    expect(result).not.toHaveProperty('cells')
  })
  it('rejects SDK binding substitutions after sync', async () => {
    const h = host()
    const sync = h.context.sync
    h.context.sync = async () => {
      await sync()
      h.sheets.getItem = () => h.sheet
    }
    await expect(
      readOfficeRange(await preflightOffice(h.office), h.excel, request)
    ).rejects.toMatchObject({ code: 'office_read_scope_changed' })
  })
  it('requires a real preflight binding and ExcelApi1.7 before invoking Excel', async () => {
    const h = host()
    const scope = await preflightOffice(h.office)
    await expect(readOfficeRange({ ...scope }, h.excel, request)).rejects.toMatchObject({
      code: 'office_scope_changed',
    })
    const missing = host()
    missing.office.context.requirements.isSetSupported = (name: string) => name !== 'ExcelApi'
    await expect(
      readOfficeRange(await preflightOffice(missing.office), missing.excel, request)
    ).rejects.toMatchObject({ code: 'office_requirement_missing' })
    expect(h.calls).toEqual([])
    expect(missing.calls).toEqual([])
  })
  it('does not read cell contents after a document binding changes during sync', async () => {
    const h = host()
    const sync = h.context.sync
    h.context.sync = async () => {
      await sync()
      h.office.context.document = host().office.context.document
    }
    await expect(
      readOfficeRange(await preflightOffice(h.office), h.excel, request)
    ).rejects.toMatchObject({ code: 'office_scope_changed' })
    expect(h.calls).not.toContainEqual(['read', 'values'])
  })
  it('times out pending SDK work and admits no new read until the native run settles', async () => {
    vi.useFakeTimers()
    const h = host()
    const entered = createDeferred<void>()
    const done = createDeferred<void>()
    const sync = h.context.sync
    h.context.sync = async () => {
      entered.resolve()
      await done.promise
      await sync()
    }
    const scope = await preflightOffice(h.office)
    const pending = readOfficeRange(scope, h.excel, request)
    const result = pending.catch((error: unknown) => error)
    await entered.promise
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await result).toMatchObject({ code: 'office_read_timeout' })
    await expect(readOfficeRange(scope, h.excel, request)).rejects.toMatchObject({
      code: 'office_read_busy',
    })
    done.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.calls).toContain('run-ended')
    expect(h.calls).not.toContainEqual(['read', 'values'])
    await expect(readOfficeRange(scope, h.excel, request)).resolves.toMatchObject({
      kind: 'office_range_observation',
    })
  })
  it('requires the native sync Promise instead of treating a missing synchronization ACK as success', async () => {
    const h = host()
    Object.defineProperty(h.context, 'sync', { value: () => undefined })
    await expect(
      readOfficeRange(await preflightOffice(h.office), h.excel, request)
    ).rejects.toMatchObject({ code: 'office_excel_sdk_invalid' })
    expect(h.calls).not.toContainEqual(['read', 'values'])
  })
  it('refuses replacement of sync while its original native request is awaiting completion', async () => {
    const h = host()
    const sync = h.context.sync
    h.context.sync = async () => {
      await sync()
      h.context.sync = async () => {}
    }
    await expect(
      readOfficeRange(await preflightOffice(h.office), h.excel, request)
    ).rejects.toMatchObject({ code: 'office_read_scope_changed' })
  })
  it.each(['throw', 'non-promise'])(
    'retains exclusion when native run closure is unknown (%s)',
    async (mode) => {
      const h = host()
      Object.defineProperty(h.excel, 'run', {
        value: () => {
          h.calls.push('run-unknown')
          if (mode === 'throw') throw new Error('PRIVATE_RUN_FAILURE')
          return undefined
        },
      })
      const scope = await preflightOffice(h.office)
      await expect(readOfficeRange(scope, h.excel, request)).rejects.toMatchObject({
        code: mode === 'throw' ? 'office_read_sdk_failure' : 'office_excel_sdk_invalid',
      })
      await expect(readOfficeRange(scope, h.excel, request)).rejects.toMatchObject({
        code: 'office_read_busy',
      })
      expect(h.calls).toEqual(['run-unknown'])
    }
  )
})

describe('Office current selection read', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })
  it('loads only selection geometry before bounded cell contents in the same run', async () => {
    const h = host()
    const result = await readSelectedOfficeRange(await preflightOffice(h.office), h.excel)
    expect(result).toMatchObject({
      kind: 'office_range_observation',
      range: request,
      values: [
        [3, 'literal'],
        [false, '#VALUE!'],
      ],
    })
    expect(h.calls.filter((value) => value === 'run')).toHaveLength(1)
    expect(h.calls.filter((value) => value === 'selection')).toHaveLength(1)
    expect(h.calls.filter((value) => value === 'sync')).toHaveLength(2)
    const firstSync = h.calls.indexOf('sync')
    const firstLoads = h.calls
      .slice(0, firstSync)
      .filter((value) => Array.isArray(value) && value[0] === 'range.load')
    expect(firstLoads).toEqual([
      [
        'range.load',
        ['address', 'rowIndex', 'columnIndex', 'rowCount', 'columnCount', 'cellCount'],
      ],
    ])
    expect(h.calls.slice(0, firstSync)).not.toContainEqual(['read', 'values'])
    expect(h.calls.slice(firstSync + 1)).toContainEqual(['range', 1, 1, 2, 2])
    expect(result.formulas[0][0]).toBe('=XLOOKUP(A1,D:D,E:E)')
  })
  it.each([
    {
      change: { rowIndex: 0, rowCount: 1_048_576, columnCount: 1, cellCount: 1_048_576 },
      code: 'office_read_scope_invalid',
    },
    {
      change: { rowIndex: 0, columnIndex: 0, rowCount: 101, columnCount: 100, cellCount: 10_100 },
      code: 'office_read_scope_invalid',
    },
    { change: { rowIndex: 1_048_575, rowCount: 2 }, code: 'office_read_scope_invalid' },
    { change: { rowCount: 0, cellCount: 0 }, code: 'office_range_invalid' },
    { change: { rowIndex: 1.5 }, code: 'office_range_invalid' },
    { change: { columnIndex: -1 }, code: 'office_range_invalid' },
    { change: { cellCount: 3 }, code: 'office_range_invalid' },
    { change: { columnCount: Number.NaN }, code: 'office_range_invalid' },
  ])(
    'refuses selection geometry before loading any cell contents: %j',
    async ({ change, code }) => {
      const h = host()
      Object.assign(h.data, change)
      await expect(
        readSelectedOfficeRange(await preflightOffice(h.office), h.excel)
      ).rejects.toMatchObject({ code })
      const loads = h.calls.filter((value) => Array.isArray(value) && value[0] === 'range.load')
      expect(loads).toEqual([
        [
          'range.load',
          ['address', 'rowIndex', 'columnIndex', 'rowCount', 'columnCount', 'cellCount'],
        ],
      ])
      expect(h.calls).not.toContainEqual(['read', 'values'])
      expect(h.calls.some((value) => Array.isArray(value) && value[0] === 'range')).toBe(false)
    }
  )
  it('pins the first observed coordinates when the user moves the selection between syncs', async () => {
    const h = host()
    let selected = h.range
    h.book.getSelectedRange = () => {
      h.calls.push('selection')
      return selected
    }
    const sync = h.context.sync
    h.context.sync = async () => {
      await sync()
      selected = host().range
    }
    const result = await readSelectedOfficeRange(await preflightOffice(h.office), h.excel)
    expect(result.range).toMatchObject(request)
    expect(h.calls.filter((value) => value === 'selection')).toHaveLength(1)
    expect(h.calls).toContainEqual(['range', 1, 1, 2, 2])
  })
  it('refuses discontiguous selection errors without falling back to another range', async () => {
    const h = host()
    h.book.getSelectedRange = () => {
      h.calls.push('selection')
      throw new Error('PRIVATE_MULTIPLE_RANGE_DETAILS')
    }
    const error = await readSelectedOfficeRange(await preflightOffice(h.office), h.excel).catch(
      (value: unknown) => value
    )
    expect(error).toMatchObject({
      code: 'office_read_sdk_failure',
      message: 'office_read_sdk_failure',
    })
    expect(error).not.toHaveProperty('cause')
    expect(h.calls).not.toContain('sync')
    expect(h.calls.some((value) => Array.isArray(value) && value[0] === 'range')).toBe(false)
  })
  it('requires selection and worksheet proxies from the same request context', async () => {
    const h = host()
    Object.assign(h.sheet, { context: {} })
    await expect(
      readSelectedOfficeRange(await preflightOffice(h.office), h.excel)
    ).rejects.toMatchObject({ code: 'office_read_scope_changed' })
    expect(h.calls).not.toContain('sync')
  })
  it('refuses a substituted selection SDK binding after geometry sync before loading contents', async () => {
    const h = host()
    const sync = h.context.sync
    h.context.sync = async () => {
      await sync()
      h.book.getSelectedRange = () => h.range
    }
    await expect(
      readSelectedOfficeRange(await preflightOffice(h.office), h.excel)
    ).rejects.toMatchObject({ code: 'office_read_scope_changed' })
    expect(
      h.calls.filter((value) => Array.isArray(value) && value[0] === 'range.load')
    ).toHaveLength(1)
    expect(h.calls).not.toContainEqual(['read', 'values'])
  })
  it('cancels geometry sync without cell loading or releasing a still active native run', async () => {
    const h = host()
    const entered = createDeferred<void>()
    const done = createDeferred<void>()
    const sync = h.context.sync
    h.context.sync = async () => {
      entered.resolve()
      await done.promise
      await sync()
    }
    const scope = await preflightOffice(h.office)
    const controller = new AbortController()
    const pending = readSelectedOfficeRange(scope, h.excel, controller.signal).catch(
      (error: unknown) => error
    )
    await entered.promise
    try {
      controller.abort()
      expect(await pending).toMatchObject({ code: 'office_read_cancelled' })
      await expect(readOfficeRange(scope, h.excel, request)).rejects.toMatchObject({
        code: 'office_read_busy',
      })
    } finally {
      done.resolve()
      await vi.waitFor(() => expect(h.calls).toContain('run-ended'))
    }
    expect(
      h.calls.filter((value) => Array.isArray(value) && value[0] === 'range.load')
    ).toHaveLength(1)
    expect(h.calls).not.toContainEqual(['read', 'values'])
    await expect(readSelectedOfficeRange(scope, h.excel)).resolves.toMatchObject({
      kind: 'office_range_observation',
    })
  })
  it.each([1, 2])(
    'keeps one monotonic deadline across both sync phases (late phase %i)',
    async (latePhase) => {
      vi.useFakeTimers()
      vi.spyOn(performance, 'now').mockReturnValue(0)
      const h = host()
      const sync = h.context.sync
      let phase = 0
      h.context.sync = async () => {
        await sync()
        phase++
        vi.mocked(performance.now).mockReturnValue(phase === latePhase ? 10_000 : 9_000)
      }
      await expect(
        readSelectedOfficeRange(await preflightOffice(h.office), h.excel)
      ).rejects.toMatchObject({ code: 'office_read_timeout' })
      expect(
        h.calls.filter((value) => Array.isArray(value) && value[0] === 'range.load')
      ).toHaveLength(latePhase)
      expect(h.calls).not.toContainEqual(['read', 'values'])
    }
  )
})
