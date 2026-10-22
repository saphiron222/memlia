// Copyright (c) 2026 Memlia. All rights reserved.
export type CatalogObservation = {
  status: 'pending' | 'error' | 'success'
  isPlaceholderData: boolean
  data?: unknown
}
export type Catalog = {
  status: 'loading' | 'error' | 'ready'
  items: { id: string; name: string }[]
  remaining: number
}
/** Presentation only; the native list/read routes retain every authorization check. */
export function projectExcelCatalog(
  workspaceId: string,
  query: CatalogObservation,
  kind: 'workflows' | 'files'
): Catalog {
  const empty = (status: Catalog['status']): Catalog => ({ status, items: [], remaining: 0 })
  if (query.status === 'error') return empty('error')
  if (query.status === 'pending' || query.isPlaceholderData) return empty('loading')
  if (!workspaceId || !Array.isArray(query.data)) return empty('error')
  const items: Catalog['items'] = []
  const seen = new Set<string>()
  for (const value of query.data) {
    if (!value || typeof value !== 'object') return empty('error')
    // Project no storage URL, key, secret, authority or execution status into the page.
    const read = (key: string) => {
      const field = Object.getOwnPropertyDescriptor(value, key)
      return field && 'value' in field ? field.value : undefined
    }
    const id = read('id')
    const name = read('name')
    if (
      read('workspaceId') !== workspaceId ||
      typeof id !== 'string' ||
      !id ||
      id.length > 128 ||
      id === '.' ||
      id === '..' ||
      /[\x00-\x1f\x7f]/.test(id) ||
      seen.has(id) ||
      typeof name !== 'string' ||
      !name
    )
      return empty('error')
    seen.add(id)
    if (read('archivedAt') || read('deletedAt')) continue
    if (kind === 'files' && !name.toLowerCase().endsWith('.xlsx')) continue
    items.push({ id, name })
  }
  return { status: 'ready', items: items.slice(0, 20), remaining: Math.max(0, items.length - 20) }
}
