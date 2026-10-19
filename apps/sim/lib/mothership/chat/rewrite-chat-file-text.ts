// Copyright Memlia. All rights reserved.
import { iterateLocalFileReferenceTokens } from '@/lib/workspace-files/reference-tokens'
import type { ChatFileRefMaps } from './rewrite-file-references'

function rewriteReference(reference: string, maps: ChatFileRefMaps): string | null {
  const suffixAt = reference.search(/[?#]/)
  const pathname = suffixAt < 0 ? reference : reference.slice(0, suffixAt)
  const suffix = suffixAt < 0 ? '' : reference.slice(suffixAt)
  const serve = /^(\/api\/files\/serve\/(?:s3\/|blob\/|gcs\/)?)(.+)$/.exec(pathname)
  const view = /^(\/api\/files\/view\/)([^/]+)$/.exec(pathname)
  const page = /^(\/workspace\/([^/]+)\/files\/)([^/]+)$/.exec(pathname)
  const sim = /^(sim:file\/)([^/]+)$/.exec(pathname)
  const match = serve ?? view ?? page ?? sim
  if (!match) return null
  try {
    if (page && decodeURIComponent(page[2]) !== maps.workspaceId) return null
    if (sim && suffix.startsWith('?')) {
      const query = new URLSearchParams(suffix.split('#')[0].slice(1))
      if (
        query.has('project') ||
        (query.has('workspace') && query.get('workspace') !== maps.workspaceId)
      )
        return null
    }
    const identity = decodeURIComponent(page ? page[3] : match[2])
    const replacement = (serve ? maps.fileKeys : maps.fileIds).get(identity)
    return replacement === undefined ? null : match[1] + encodeURIComponent(replacement) + suffix
  } catch {
    return null
  }
}

/** Rewrite only mapped local file references, using the native Apache token boundaries. */
export function rewriteChatFileText(text: string, maps: ChatFileRefMaps): string {
  const chunks: string[] = []
  let offset = 0
  for (const { reference, start, end } of iterateLocalFileReferenceTokens(text)) {
    let value = rewriteReference(reference, maps)
    if (value === null && /[.,;:!?]+$/.test(reference)) {
      const trimmed = reference.replace(/[.,;:!?]+$/, '')
      const rewritten = rewriteReference(trimmed, maps)
      if (rewritten !== null) value = rewritten + reference.slice(trimmed.length)
    }
    if (value === null) continue
    chunks.push(text.slice(offset, start), value)
    offset = end
  }
  chunks.push(text.slice(offset))
  return chunks.join('')
}
