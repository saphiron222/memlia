// Copyright (c) 2026 Memlia. All rights reserved.
import { describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { projectOfficeProcedureWorkbook } from './procedure-result.server'

function workbook(sheet: XLSX.WorkSheet, extra?: (book: XLSX.WorkBook) => void) {
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, sheet, 'Résultat')
  extra?.(book)
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx', compression: true }) as Buffer
}

describe('published XLSX to an Office value proposal', () => {
  it('reads the real workbook without evaluating a leading equals literal or inventing zero for null', () => {
    const bytes = workbook(
      XLSX.utils.aoa_to_sheet(
        [
          [3.25, '=1+2'],
          [false, null],
        ],
        { sheetStubs: true }
      )
    )
    expect(projectOfficeProcedureWorkbook(bytes)).toEqual([
      [3.25, '=1+2'],
      [false, null],
    ])
  })
  it('refuses actual formulas and hyperlinks instead of converting their cache into constants', () => {
    for (const cell of [
      { t: 'n', v: 4, f: '2+2' },
      { t: 's', v: 'site', l: { Target: 'https://example.invalid' } },
    ]) {
      const bytes = workbook({ A1: cell, '!ref': 'A1' } as XLSX.WorkSheet)
      expect(() => projectOfficeProcedureWorkbook(bytes)).toThrow('office_procedure_result_refused')
    }
  })
  it('refuses multiple or hidden sheets and merged output', () => {
    const sheet = XLSX.utils.aoa_to_sheet([[1, 2]])
    const variants = [
      workbook(sheet, (book) =>
        XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([[2]]), 'Autre')
      ),
      workbook(sheet, (book) => {
        book.Workbook = { Sheets: [{ name: 'Résultat', Hidden: 1 }] }
      }),
      workbook({ ...sheet, '!merges': [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }] }),
    ]
    for (const bytes of variants)
      expect(() => projectOfficeProcedureWorkbook(bytes)).toThrow('office_procedure_result_refused')
  })
  it('refuses oversized geometry before allocating a proposal matrix', () => {
    const bytes = workbook({ A1: { t: 'n', v: 1 }, A10001: { t: 'n', v: 2 }, '!ref': 'A1:A10001' })
    expect(() => projectOfficeProcedureWorkbook(bytes)).toThrow('office_procedure_result_refused')
  })
  it('rejects non-XLSX bytes and date-typed output outside the constant table profile', () => {
    expect(() => projectOfficeProcedureWorkbook(Buffer.from('a,b\n1,2'))).toThrow(
      'office_procedure_result_refused'
    )
    const bytes = workbook({ A1: { t: 'n', v: 45951, z: 'yyyy-mm-dd' }, '!ref': 'A1' })
    expect(() => projectOfficeProcedureWorkbook(bytes)).toThrow('office_procedure_result_refused')
  })
})
