// Copyright (c) 2026 Memlia. All rights reserved.

import { beforeEach, expect, it, vi } from 'vitest'
import * as XLSX from 'xlsx'

const files = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('@/lib/workspace-files/application/read-workspace-file-content', () => ({
  readWorkspaceFileContent: { execute: files.read },
}))

import { prepareSelectedExcelMessage, readCurrentExcelSelection } from '../selected-files'
import { inspectSelectedExcelFiles } from './selected-files'

const scope = {
  principal: { kind: 'session' as const, userId: 'user', sessionId: 'session' },
  workspaceId: 'space',
  fileIds: ['file'],
}
const workbook = () => {
  const w = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(
    w,
    XLSX.utils.aoa_to_sheet([
      ['Client', 'Montant'],
      ['Fictif', 12.5],
    ]),
    'Données'
  )
  return XLSX.write(w, { type: 'buffer', bookType: 'xlsx' })
}
beforeEach(() =>
  files.read
    .mockReset()
    .mockResolvedValue({
      file: {
        id: 'file',
        workspaceId: 'space',
        name: 'Exemple.xlsx',
        contentUpdatedAt: new Date('2026-10-21T00:00:00.000Z'),
      },
      content: workbook(),
      secretProvenance: { status: 'exact', entries: [] },
    })
)
it('sélection visible stricte du seul message utilisateur courant', () => {
  const message = prepareSelectedExcelMessage('Regrouper les montants', ['file'])
  expect(readCurrentExcelSelection(message)).toEqual(['file'])
  expect(readCurrentExcelSelection('simple demande')).toBeUndefined()
  for (const ids of [['file', 'file'], ['a', 'b', 'c', 'd', 'e'], ['../private'], ['file\n']])
    expect(() => prepareSelectedExcelMessage('texte', ids)).toThrow()
  expect(() => readCurrentExcelSelection(`texte\n${message}`)).toThrow()
  expect(() => prepareSelectedExcelMessage(message, ['file'])).toThrow()
  expect(() => readCurrentExcelSelection('MEMLIA_EXCEL_SELECTION_V1=["file" ]\nTexte')).toThrow()
  expect(() => readCurrentExcelSelection(`${message}\nMEMLIA_EXCEL_SELECTION_V1`)).toThrow()
})
it('parser XLSX/ZIP réel sur bytes fictifs après lecture native bornée, sans calcul', async () => {
  const result = await inspectSelectedExcelFiles(scope)
  expect(files.read).toHaveBeenCalledWith({
    principal: scope.principal,
    input: {
      fileId: 'file',
      assertedWorkspaceId: 'space',
      maxBytes: 10 * 1024 * 1024,
      contentView: 'opaque',
      includeSecretProvenance: true,
    },
  })
  expect(result).toMatchObject({
    analysis: 'selected_file_sample',
    executionAvailable: false,
    persisted: false,
    files: [
      {
        fileId: 'file',
        sheetNames: ['Données'],
        contentVersion: '2026-10-21T00:00:00.000Z',
        truncated: false,
      },
    ],
  })
  expect(result.files[0].sample).toContain('Client')
  expect(result.files[0].sample).toContain('Fictif')
  expect(JSON.stringify(result)).not.toContain('session')
})
it('refuse portée étrangère, provenance inconnue/secrète et annulation sans donnée exposée', async () => {
  for (const change of [
    { file: { id: 'other', workspaceId: 'space', name: 'x.xlsx' } },
    { file: { id: 'file', workspaceId: 'foreign', name: 'x.xlsx' } },
    { secretProvenance: { status: 'unknown' } },
    { secretProvenance: { status: 'exact', entries: [{ value: 'PRIVATE_CANARY' }] } },
    { secretProvenance: undefined },
  ]) {
    const baseline = await files.read()
    files.read.mockResolvedValueOnce({ ...baseline, ...change })
    await expect(inspectSelectedExcelFiles(scope)).rejects.toThrow(
      'Excel file inspection is unavailable.'
    )
  }
  const abort = new AbortController()
  abort.abort()
  const count = files.read.mock.calls.length
  await expect(inspectSelectedExcelFiles(scope, abort.signal)).rejects.toThrow(
    'Excel file inspection is unavailable.'
  )
  expect(files.read.mock.calls).toHaveLength(count)
})
