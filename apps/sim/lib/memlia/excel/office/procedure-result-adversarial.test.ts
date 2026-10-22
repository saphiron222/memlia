// Copyright (c) 2026 Memlia. All rights reserved.
// Small real OOXML archives and real SheetJS/ZIP guards; no stress or native Office.
import { expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import { findEocdOffset } from '@/lib/file-parsers/zip-guard'
import { projectOfficeProcedureWorkbook } from './procedure-result.server'

function workbook(value: number): Buffer {
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([[value]]), 'Result')
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx', compression: true }) as Buffer
}
it('refuses a formula beyond a false declared dimension rather than silently dropping that row', () => {
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(
    book,
    { A1: { t: 'n', v: 1 }, A10002: { t: 'n', v: 4, f: '2+2' }, '!ref': 'A1:A10002' },
    'Result'
  )
  const raw = XLSX.write(book, { type: 'buffer', bookType: 'xlsx', compression: true }) as Buffer
  const archive = XLSX.CFB.read(raw, { type: 'buffer' })
  const sheet = XLSX.CFB.find(archive, 'Root Entry/xl/worksheets/sheet1.xml')!
  const xml = Buffer.from(sheet.content as Uint8Array).toString('utf8')
  expect(xml).toContain('<dimension ref="A1:A10002"')
  expect(xml).toContain('<f>2+2</f>')
  sheet.content = Buffer.from(xml.replace('ref="A1:A10002"', 'ref="A1"'))
  sheet.size = sheet.content.length
  const bytes = XLSX.CFB.write(archive, {
    type: 'buffer',
    fileType: 'zip',
    compression: true,
  }) as Buffer
  expect(bytes.length).toBeLessThan(20_000)
  expect(() => projectOfficeProcedureWorkbook(bytes)).toThrow('office_procedure_result_refused')
})
it('refuses an EOCD comment decoy that SheetJS would resolve against a different archive directory', () => {
  const first = workbook(1)
  const second = workbook(2)
  const firstEnd = findEocdOffset(first)
  const secondEnd = findEocdOffset(second)
  const base = first.length
  expect(second.length).toBeLessThan(65_536)
  let cursor = second.readUInt32LE(secondEnd + 16)
  const count = second.readUInt16LE(secondEnd + 10)
  for (let index = 0; index < count; index++) {
    expect(second.readUInt32LE(cursor)).toBe(0x02014b50)
    second.writeUInt32LE(second.readUInt32LE(cursor + 42) + base, cursor + 42)
    cursor +=
      46 +
      second.readUInt16LE(cursor + 28) +
      second.readUInt16LE(cursor + 30) +
      second.readUInt16LE(cursor + 32)
  }
  second.writeUInt32LE(second.readUInt32LE(secondEnd + 16) + base, secondEnd + 16)
  // This last signature lies inside the first EOCD comment, and is not valid at EOF.
  // CFB nevertheless chooses it because its scanner does not validate comment length.
  second.writeUInt16LE(1, secondEnd + 20)
  first.writeUInt16LE(second.length, firstEnd + 20)
  const combined = Buffer.concat([first, second])
  expect(combined.length).toBeLessThan(40_000)
  expect(findEocdOffset(combined)).toBe(firstEnd)
  expect(XLSX.read(combined, { type: 'buffer' }).Sheets.Result.A1.v).toBe(2)
  expect(() => projectOfficeProcedureWorkbook(combined)).toThrow('office_procedure_result_refused')
})

it('refuses ZIP-based XLSB constants outside the qualified XLSX-only profile', () => {
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([[1, 'literal']]), 'Result')
  const bytes = XLSX.write(book, { type: 'buffer', bookType: 'xlsb', compression: true }) as Buffer
  expect(bytes.length).toBeLessThan(20_000)
  expect(XLSX.read(bytes, { type: 'buffer' }).bookType).toBe('xlsb')
  expect(() => projectOfficeProcedureWorkbook(bytes)).toThrow('office_procedure_result_refused')
})

it('refuses a local ZIP64 size override before SheetJS attempts an oversized allocation', () => {
  const raw = workbook(1)
  const end = findEocdOffset(raw)
  const directory = raw.readUInt32LE(end + 16)
  const count = raw.readUInt16LE(end + 10)
  const entries: { central: number; local: number; name: string }[] = []
  let cursor = directory
  for (let index = 0; index < count; index++) {
    expect(raw.readUInt32LE(cursor)).toBe(0x02014b50)
    const length = raw.readUInt16LE(cursor + 28)
    entries.push({
      central: cursor,
      local: raw.readUInt32LE(cursor + 42),
      name: raw.subarray(cursor + 46, cursor + 46 + length).toString('utf8'),
    })
    cursor += 46 + length + raw.readUInt16LE(cursor + 30) + raw.readUInt16LE(cursor + 32)
  }
  const target = entries.find((entry) => entry.name === 'xl/worksheets/sheet1.xml')!
  expect(target).toBeDefined()
  expect(raw.readUInt16LE(target.local + 8)).toBe(8)
  expect(raw.readUInt16LE(target.local + 28)).toBe(0)
  const insertion = target.local + 30 + raw.readUInt16LE(target.local + 26)
  const extra = Buffer.alloc(20)
  extra.writeUInt16LE(1, 0)
  extra.writeUInt16LE(16, 2)
  extra.writeBigUInt64LE(BigInt(16 * 1024 * 1024), 4)
  extra.writeBigUInt64LE(BigInt(raw.readUInt32LE(target.local + 18)), 12)
  const bytes = Buffer.concat([raw.subarray(0, insertion), extra, raw.subarray(insertion)])
  bytes.writeUInt16LE(extra.length, target.local + 28)
  for (const entry of entries)
    bytes.writeUInt32LE(
      entry.local >= insertion ? entry.local + extra.length : entry.local,
      entry.central + extra.length + 42
    )
  bytes.writeUInt32LE(directory + extra.length, end + extra.length + 16)
  expect(bytes.length).toBeLessThan(20_000)
  const original = Buffer.allocUnsafe
  const oversizedRequests: number[] = []
  // Do not allocate the malicious size: observe the actual parser request and stop it first.
  Buffer.allocUnsafe = (size: number) => {
    if (size > 4 * 1024 * 1024) {
      oversizedRequests.push(size)
      throw new Error('review_allocation_intercepted')
    }
    return original(size)
  }
  try {
    expect(() => projectOfficeProcedureWorkbook(bytes)).toThrow('office_procedure_result_refused')
  } finally {
    Buffer.allocUnsafe = original
  }
  expect(oversizedRequests).toEqual([])
})
