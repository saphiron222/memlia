// Copyright (c) 2026 Memlia. All rights reserved.
import { z } from 'zod'

/** A visible, editable user selection in the prepared message, never a model tool argument. */
const marker = 'MEMLIA_EXCEL_SELECTION_V1='
const markerName = 'MEMLIA_EXCEL_SELECTION_V1'
export const selectedExcelFileIdsSchema = z
  .array(z.string().regex(/^[A-Za-z0-9_-]{1,128}(?![\s\S])/))
  .min(1)
  .max(4)
  .refine((ids) => new Set(ids).size === ids.length)
export function prepareSelectedExcelMessage(text: string, fileIds: readonly string[]) {
  if (!fileIds.length) return text
  if (text.includes(marker)) throw new Error('Excel selection is unavailable.')
  return `${marker}${JSON.stringify(selectedExcelFileIdsSchema.parse(fileIds))}\n${text}`
}
/** Call only on the authenticated current user's message, after transcript admission. */
export function readCurrentExcelSelection(text: string): string[] | undefined {
  if (!text.includes(markerName)) return undefined
  if (!text.startsWith(marker) || text.indexOf(markerName, markerName.length) >= 0)
    throw new Error('Excel selection is unavailable.')
  const lineEnd = text.indexOf('\n')
  if (lineEnd < 0 || lineEnd > 1024) throw new Error('Excel selection is unavailable.')
  const serialized = text.slice(marker.length, lineEnd)
  const selected = selectedExcelFileIdsSchema.parse(JSON.parse(serialized))
  if (JSON.stringify(selected) !== serialized) throw new Error('Excel selection is unavailable.')
  return selected
}
