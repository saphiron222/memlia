// Copyright (c) 2026 Memlia. All rights reserved.
import { describe, expect, it } from 'vitest'
import { projectExcelCatalog } from './catalog'

const row = {
  id: 'file-1',
  workspaceId: 'ws-1',
  name: 'Exemple.xlsx',
  key: 'PRIVATE_STORAGE_KEY',
  url: 'PRIVATE_URL',
}
const ready = (data: unknown) => ({ status: 'success' as const, isPlaceholderData: false, data })
describe('catalogue Excel sur les listes natives', () => {
  it('projette uniquement le nom et l’identifiant des fichiers actifs XLSX du bon espace', () => {
    const result = projectExcelCatalog(
      'ws-1',
      ready([
        row,
        { ...row, id: 'pdf', name: 'Autre.pdf' },
        { ...row, id: 'deleted', deletedAt: new Date() },
      ]),
      'files'
    )
    expect(result).toEqual({
      status: 'ready',
      items: [{ id: 'file-1', name: 'Exemple.xlsx' }],
      remaining: 0,
    })
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
  })
  it('ne présente jamais l’ancien cache d’un autre espace pendant une transition', () => {
    expect(
      projectExcelCatalog('ws-2', { ...ready([row]), isPlaceholderData: true }, 'files')
    ).toEqual({ status: 'loading', items: [], remaining: 0 })
    expect(projectExcelCatalog('ws-2', ready([row]), 'files')).toEqual({
      status: 'error',
      items: [],
      remaining: 0,
    })
  })
  it.each([
    undefined,
    {},
    [null],
    [{ ...row, id: '' }],
    [{ ...row, name: 123 }],
    [{ ...row, workspaceId: undefined }],
  ])('refuse un inventaire invalide sans le rendre vide et réussi', (data) => {
    expect(projectExcelCatalog('ws-1', ready(data), 'files').status).toBe('error')
  })
  it('distingue chargement, refus et liste vraiment vide', () => {
    expect(
      projectExcelCatalog('ws-1', { status: 'pending', isPlaceholderData: false }, 'files').status
    ).toBe('loading')
    expect(projectExcelCatalog('ws-1', { ...ready([row]), status: 'error' }, 'files')).toEqual({
      status: 'error',
      items: [],
      remaining: 0,
    })
    expect(projectExcelCatalog('ws-1', ready([]), 'files')).toEqual({
      status: 'ready',
      items: [],
      remaining: 0,
    })
  })
  it('conserve les workflows autorisés sans leur inventer un état Excel ou une réussite', () => {
    expect(
      projectExcelCatalog(
        'ws-1',
        ready([row, { ...row, id: 'archived', archivedAt: new Date() }]),
        'workflows'
      )
    ).toEqual({ status: 'ready', items: [{ id: 'file-1', name: 'Exemple.xlsx' }], remaining: 0 })
  })
  it('borne la liste visible et annonce le reste sans modifier le cache', () => {
    const data = Array.from({ length: 23 }, (_, i) => ({ ...row, id: `item-${i}` }))
    const result = projectExcelCatalog('ws-1', ready(data), 'files')
    expect(result.items).toHaveLength(20)
    expect(result.remaining).toBe(3)
    expect(data).toHaveLength(23)
  })
  it.each(['.', '..', 'bad\u0000id'])(
    'refuse un identifiant qui ne peut pas devenir un lien natif : %s',
    (id) => {
      expect(projectExcelCatalog('ws-1', ready([{ ...row, id }]), 'files')).toEqual({
        status: 'error',
        items: [],
        remaining: 0,
      })
    }
  )
  it('refuse les doublons au lieu de produire des liens ambigus', () => {
    expect(
      projectExcelCatalog('ws-1', ready([row, { ...row, name: 'Autre.xlsx' }]), 'files')
    ).toEqual({ status: 'error', items: [], remaining: 0 })
  })
})
