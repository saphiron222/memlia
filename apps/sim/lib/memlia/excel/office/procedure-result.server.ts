// Copyright (c) 2026 Memlia. All rights reserved.
import * as XLSX from 'xlsx'
import { MAX_OFFICE_PROCEDURE_CELLS } from '@/lib/api/contracts/excel-office-procedures'
import {
  assertOoxmlArchiveWithinLimits,
  findEocdOffset,
  readZipCentralDirectoryStats,
} from '@/lib/file-parsers/zip-guard'

type Scalar = string | number | boolean | null
const MAX_BYTES = 7_500_000
function refuse(): never {
  throw new Error('office_procedure_result_refused')
}

/** Pure projection of a separately authorized, published output; never a calculation engine. */
export function projectOfficeProcedureWorkbook(content: Buffer): Scalar[][] {
  try {
    if (
      !Buffer.isBuffer(content) ||
      !content.length ||
      content.length > MAX_BYTES ||
      content.readUInt32LE(0) !== 0x04034b50
    )
      refuse()
    // Align the guard and SheetJS/CFB on one terminal, single-disk directory.
    // CFB searches the last EOCD signature; a comment may contain a competing one.
    const end = findEocdOffset(content)
    if (
      end !== content.length - 22 ||
      end < 0 ||
      content.readUInt16LE(end + 20) !== 0 ||
      content.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])) !== end ||
      content.readUInt16LE(end + 4) !== 0 ||
      content.readUInt16LE(end + 6) !== 0
    )
      refuse()
    const directory = readZipCentralDirectoryStats(content)
    if (
      !directory ||
      directory.entryCount > 128 ||
      directory.totalExtraFieldBytes !== 0 ||
      content.readUInt16LE(end + 8) !== directory.entryCount ||
      content.readUInt16LE(end + 10) !== directory.entryCount ||
      content.readUInt32LE(end + 16) + content.readUInt32LE(end + 12) !== end
    )
      refuse()
    // Reuse the native guard, including its actual bounded inflation/integrity checks.
    assertOoxmlArchiveWithinLimits(content, {
      rejectLocalExtraFields: true,
      maxTotalUncompressedBytes: 8 * 1024 * 1024,
      maxEntryUncompressedBytes: 4 * 1024 * 1024,
      maxCompressionRatio: 150,
      ratioCheckFloorBytes: 1024 * 1024,
    })
    const book = XLSX.read(content, {
      type: 'buffer',
      cellFormula: true,
      cellNF: true,
      cellStyles: true,
      cellDates: false,
      bookVBA: true,
      bookFiles: true,
    })
    if (book.bookType !== 'xlsx') refuse()
    const names = book.SheetNames
    if (
      names.length !== 1 ||
      book.vbaraw ||
      book.Workbook?.Names?.length ||
      book.Workbook?.Sheets?.some((sheet) => Boolean(sheet.Hidden))
    )
      refuse()
    const keys = (book as XLSX.WorkBook & { keys?: string[] }).keys
    if (
      !Array.isArray(keys) ||
      keys.some((key) =>
        /(?:^|\/)(?:externalLinks|connections|pivotTables|pivotCache|drawings|activeX|embeddings|macrosheets|customUI)(?:\/|\.|$)|vbaProject/i.test(
          key
        )
      )
    )
      refuse()
    const sheet = book.Sheets[names[0]]
    if (
      !sheet ||
      !sheet['!ref'] ||
      sheet['!merges']?.length ||
      sheet['!rows']?.some((row) => row && (row.hidden || row.level)) ||
      sheet['!cols']?.some((column) => column && (column.hidden || column.level))
    )
      refuse()
    const fullRef = sheet['!fullref']
    if (fullRef && fullRef !== sheet['!ref']) refuse()
    const range = XLSX.utils.decode_range(sheet['!ref'])
    const rows = range.e.r - range.s.r + 1
    const columns = range.e.c - range.s.c + 1
    if (
      ![range.s.r, range.s.c, rows, columns].every(Number.isSafeInteger) ||
      range.s.r < 0 ||
      range.s.c < 0 ||
      rows < 1 ||
      columns < 1 ||
      rows * columns > MAX_OFFICE_PROCEDURE_CELLS
    )
      refuse()
    const value = (cell: XLSX.CellObject | undefined): Scalar => {
      if (!cell) return null
      if (
        cell.f !== undefined ||
        cell.F !== undefined ||
        cell.l !== undefined ||
        cell.t === 'e' ||
        cell.t === 'd' ||
        (typeof cell.z === 'string' && XLSX.SSF.is_date(cell.z))
      )
        refuse()
      if (cell.t === 'z' || cell.v === undefined || cell.v === null) return null
      if (cell.t === 's' && typeof cell.v === 'string' && cell.v.length <= 32_767) return cell.v
      if (cell.t === 'n' && typeof cell.v === 'number' && Number.isFinite(cell.v)) return cell.v
      if (cell.t === 'b' && typeof cell.v === 'boolean') return cell.v
      refuse()
    }
    for (const [address, cell] of Object.entries(sheet)) {
      if (address.startsWith('!')) continue
      const coordinate = XLSX.utils.decode_cell(address)
      if (
        coordinate.r < range.s.r ||
        coordinate.r > range.e.r ||
        coordinate.c < range.s.c ||
        coordinate.c > range.e.c
      )
        refuse()
      value(cell as XLSX.CellObject)
    }
    return Array.from({ length: rows }, (_, row) =>
      Array.from({ length: columns }, (_, column) =>
        value(sheet[XLSX.utils.encode_cell({ r: range.s.r + row, c: range.s.c + column })])
      )
    )
  } catch {
    // Do not forward parser/XML/archive messages or source data across the API.
    refuse()
  }
}
