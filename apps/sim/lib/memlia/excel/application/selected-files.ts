// Copyright (c) 2026 Memlia. All rights reserved.
import { parsePrincipal, type SessionPrincipal } from '@sim/auth/principal'
import { z } from 'zod'
import { stringifyBoundedJson } from '@/lib/core/utils/bounded-json'
import { waitWithAbort } from '@/lib/core/utils/concurrency'
import { XlsxParser } from '@/lib/file-parsers/xlsx-parser'
import { readWorkspaceFileContent } from '@/lib/workspace-files/application/read-workspace-file-content'
import { selectedExcelFileIdsSchema } from '../selected-files'

const inputSchema = z.strictObject({
  principal: z.unknown(),
  workspaceId: z.string().regex(/^[A-Za-z0-9_-]{1,128}(?![\s\S])/),
  fileIds: selectedExcelFileIdsSchema,
})
const unavailable = () => new Error('Excel file inspection is unavailable.')
const MAX_BYTES = 10 * 1024 * 1024
type Scope = { principal: SessionPrincipal; workspaceId: string; fileIds: readonly string[] }

/** Reads only server-selected, authorized sources. No file identity comes from a model argument. */
export async function inspectSelectedExcelFiles(raw: Scope, signal?: AbortSignal) {
  try {
    signal?.throwIfAborted()
    const captured = stringifyBoundedJson(raw, 4096, { strict: true })
    if (captured === undefined) throw unavailable()
    const input = inputSchema.parse(JSON.parse(captured))
    const principal = parsePrincipal({ version: 1, principal: input.principal })
    if (principal.kind !== 'session') throw unavailable()
    const files = []
    for (const fileId of input.fileIds) {
      signal?.throwIfAborted()
      const source = await waitWithAbort(
        readWorkspaceFileContent.execute({
          principal,
          input: {
            fileId,
            assertedWorkspaceId: input.workspaceId,
            maxBytes: MAX_BYTES,
            contentView: 'opaque',
            includeSecretProvenance: true,
          },
        }),
        signal
      )
      signal?.throwIfAborted()
      const provenance = source.secretProvenance
      // A session read admits the human's bytes. External model delivery is stricter:
      // refuse unknown/stale and any secret-bearing binary before parsing/projecting.
      if (
        source.file.id !== fileId ||
        source.file.workspaceId !== input.workspaceId ||
        !source.file.name.toLowerCase().endsWith('.xlsx') ||
        source.content.byteLength > MAX_BYTES ||
        !provenance ||
        !(
          provenance.status === 'unrecorded' ||
          (provenance.status === 'exact' && provenance.entries.length === 0)
        )
      )
        throw unavailable()
      const parsed = await new XlsxParser().parseBuffer(source.content, { signal })
      signal?.throwIfAborted()
      const names = parsed.metadata?.sheetNames
      if (
        !Array.isArray(names) ||
        names.length > 64 ||
        !names.every((name: unknown) => typeof name === 'string' && name.length <= 256)
      )
        throw unavailable()
      // The parser's own ZIP/worksheet windows run first. This transport is a sample,
      // not a schema proof, calculation, formula evaluation or complete file.
      let sample = parsed.content.slice(0, 4096)
      while (Buffer.byteLength(sample, 'utf8') > 4096) sample = sample.slice(0, -1)
      files.push({
        fileId,
        name: source.file.name,
        contentVersion: source.file.contentUpdatedAt?.toISOString() ?? null,
        sheetNames: names as string[],
        sample,
        truncated: parsed.metadata?.truncated === true || sample.length < parsed.content.length,
      })
    }
    const result = {
      analysis: 'selected_file_sample' as const,
      executionAvailable: false as const,
      persisted: false as const,
      untrustedWorkbookData: true as const,
      files,
    }
    if (stringifyBoundedJson(result, 32 * 1024, { strict: true }) === undefined) throw unavailable()
    return result
  } catch {
    throw unavailable()
  }
}
