/** @vitest-environment jsdom */
// Copyright (c) 2026 Memlia. All rights reserved.
// Real ReactDOM/Sim controls; edit authority and SDK are declared boundary doubles.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OfficeBackupClientResult } from '@/lib/memlia/excel/office/backup-client'
import { OfficeEditError } from '@/lib/memlia/excel/office/edit-session'
import {
  OfficeProcedureError,
  type OfficeProcedureResult,
} from '@/lib/memlia/excel/office/procedure-client'
import type { OfficeRangeObservation } from '@/lib/memlia/excel/office/read-scope'

const mocks = vi.hoisted(() => ({
  observation: vi.fn(),
  prepare: vi.fn(),
  approve: vi.fn(),
  apply: vi.fn(),
  save: vi.fn(),
  list: vi.fn(),
  procedurePrepare: vi.fn(),
}))
vi.mock('@/lib/memlia/excel/office/edit-session', async (original) => ({
  ...(await original<typeof import('@/lib/memlia/excel/office/edit-session')>()),
  getOfficeEditBackupObservation: mocks.observation,
  prepareOfficeEdit: mocks.prepare,
  approveOfficeEdit: mocks.approve,
  applyOfficeEdit: mocks.apply,
  saveVerifiedOfficeEdit: mocks.save,
}))
vi.mock('@/lib/memlia/excel/office/procedure-client', async (original) => ({
  ...(await original<typeof import('@/lib/memlia/excel/office/procedure-client')>()),
  listOfficeProcedureResults: mocks.list,
  prepareOfficeProcedureEdit: mocks.procedurePrepare,
}))
vi.mock('@sim/emcn', async () => ({
  ...(await import('@sim/emcn/components/button/button')),
  ...(await import('@sim/emcn/components/label/label')),
}))

import { OfficeEditPanel } from './edit-panel'

const backup: Extract<OfficeBackupClientResult, { status: 'stored' }> = {
  status: 'stored',
  receipt: {
    schemaVersion: 'memlia.office-copy-storage/v1',
    workspaceId: 'workspace',
    ownerUserId: 'user',
    fileId: 'backup',
    contentVersion: 1,
    byteLength: 8,
    sha256: `sha256:${'a'.repeat(64)}`,
  },
}
const observation: OfficeRangeObservation = {
  version: 1,
  kind: 'office_range_observation',
  scope: 'current_office_document',
  qualification: 'not_verified',
  worksheet: { id: 'opaque-sheet', name: 'Feuille fictive' },
  range: {
    sheetId: 'opaque-sheet',
    startRow: 2,
    endRow: 3,
    startColumn: 3,
    endColumn: 4,
    address: 'Feuille fictive!C2:D3',
  },
  values: [
    [1, '=DONNEE_OPAQUE()'],
    [true, null],
  ],
  valueTypes: [
    ['Integer', 'String'],
    ['Boolean', 'Empty'],
  ],
  formulas: [
    [1, '=DONNEE_OPAQUE()'],
    [true, null],
  ],
  numberFormat: [
    ['General', 'General'],
    ['General', 'General'],
  ],
}
const procedureResult: OfficeProcedureResult = {
  workflowId: 'workflow',
  deploymentVersionId: 'deployment',
  blockId: 'block',
  executionId: 'run',
  resultFileId: 'result',
  resultContentVersion: 1,
  workflowName: 'Workflow fictif',
  procedureName: 'Procédure fictive',
  fileName: 'resultat.xlsx',
  completedAt: '2026-10-21T08:00:00.000Z',
}
const preview = {
  digest: `sha256:${'b'.repeat(64)}`,
  observation,
  backupFileId: 'backup',
  changes: [{ row: 0, column: 0, before: 1, after: 2 }],
}
let container: HTMLDivElement
let root: Root
let mounted: boolean
let enabled: boolean
let currentBackup = backup
const excel = {}
const lock = vi.fn()
beforeEach(() => {
  mocks.observation.mockReset().mockReturnValue(observation)
  mocks.prepare.mockReset().mockResolvedValue(preview)
  mocks.list.mockReset().mockResolvedValue({ items: [procedureResult], truncated: false })
  mocks.procedurePrepare.mockReset().mockResolvedValue(preview)
  mocks.approve.mockReset().mockReturnValue(Object.freeze({}))
  mocks.apply.mockReset().mockResolvedValue({
    status: 'verified',
    observation: {
      ...observation,
      values: [
        [2, '=DONNEE_OPAQUE()'],
        [true, null],
      ],
    },
    changedCells: 1,
    calculation: 'range_calculated',
    durableSave: 'not_confirmed',
  })
  mocks.save
    .mockReset()
    .mockResolvedValue({
      status: 'acknowledged',
      durableSave: 'office_acknowledged',
      diskVerification: 'not_observed',
    })
  enabled = true
  currentBackup = backup
  mounted = true
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  if (mounted) await act(async () => root.unmount())
  container.remove()
})
async function render() {
  await act(async () =>
    root.render(
      <OfficeEditPanel backup={currentBackup} excel={excel} enabled={enabled} onLockChange={lock} />
    )
  )
}
function button(label: string) {
  const value = [...container.querySelectorAll('button')].find((item) => item.textContent === label)
  if (!value) throw new Error('Expected action missing')
  return value
}
function input(label: string) {
  const value = [...container.querySelectorAll('input')].find(
    (item) => item.getAttribute('aria-label') === label
  )
  if (!value) throw new Error('Expected field missing')
  return value
}
async function text(label: string, value: string) {
  await act(async () => {
    const target = input(label)
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(target, value)
    target.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function attest() {
  await act(async () =>
    input('Je travaille sur une copie locale exclusive, sans coédition').click()
  )
}
async function prepare() {
  await text('Ligne 2, colonne 3 — valeur proposée', '2')
  await attest()
  await act(async () => button('Préparer les modifications').click())
}
async function procedureMode() {
  const source = container.querySelector<HTMLSelectElement>(
    'select[aria-label="Source des valeurs proposées"]'
  )!
  await act(async () => {
    source.value = 'procedure'
    source.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
async function chooseProcedure() {
  await procedureMode()
  await act(async () => button('Charger les résultats de procédures').click())
  const result = container.querySelector<HTMLSelectElement>(
    'select[aria-label="Résultat de procédure"]'
  )!
  await act(async () => {
    result.value = '0'
    result.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
async function agree() {
  await act(async () => input('J’approuve les modifications de cet aperçu').click())
}

describe('Office edit panel', () => {
  it('lets the user choose a published procedure result without treating it as a recalculation', async () => {
    await render()
    const source = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Source des valeurs proposées"]'
    )
    expect(source).not.toBeNull()
    await act(async () => {
      source!.value = 'procedure'
      source!.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(container.textContent).toContain('résultat d’une exécution déjà terminée')
    expect(container.textContent).toContain(
      'Ce choix ne recalcule pas la procédure sur votre classeur ouvert.'
    )
    expect(
      container.querySelector('[aria-label="Ligne 2, colonne 3 — valeur proposée"]')
    ).toBeNull()
    await attest()
    expect(button('Préparer les modifications').disabled).toBe(true)
    expect(mocks.prepare).not.toHaveBeenCalled()
  })
  it('uses a selected published run result with the same explicit preview, approval and apply controls', async () => {
    await render()
    const source = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Source des valeurs proposées"]'
    )!
    await act(async () => {
      source.value = 'procedure'
      source.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => button('Charger les résultats de procédures').click())
    expect(mocks.list).toHaveBeenCalledWith('workspace', expect.any(AbortSignal))
    const result = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Résultat de procédure"]'
    )!
    expect(result.textContent).toContain('Procédure fictive')
    await act(async () => {
      result.value = '0'
      result.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await attest()
    await act(async () => button('Préparer les modifications').click())
    expect(mocks.procedurePrepare).toHaveBeenCalledWith(
      expect.objectContaining({
        backup,
        excel,
        result: procedureResult,
        exclusiveLocalCopyConfirmed: true,
        signal: expect.any(AbortSignal),
      })
    )
    expect(mocks.prepare).not.toHaveBeenCalled()
    expect(mocks.apply).not.toHaveBeenCalled()
    await agree()
    await act(async () => button('Appliquer et vérifier').click())
    expect(mocks.apply).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('Modification relue et vérifiée')
    expect(container.textContent).toContain('L’enregistrement sur disque n’est pas confirmé')
  })
  it('loads the result catalog only on an explicit click and guards synchronous double clicks', async () => {
    let finish!: (value: unknown) => void
    mocks.list.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    await render()
    await procedureMode()
    expect(mocks.list).not.toHaveBeenCalled()
    const load = button('Charger les résultats de procédures')
    await act(async () => {
      load.click()
      load.click()
    })
    expect(mocks.list).toHaveBeenCalledOnce()
    expect(lock).toHaveBeenLastCalledWith(true)
    await act(async () => finish({ items: [procedureResult], truncated: true }))
    expect(container.textContent).toContain('Seuls les 50 premiers résultats')
    expect(lock).toHaveBeenLastCalledWith(false)
    await attest()
    expect(button('Préparer les modifications').disabled).toBe(true)
  })
  it('clears the preview and agreement when the result choice is removed or the source changes', async () => {
    await render()
    await chooseProcedure()
    await attest()
    await act(async () => button('Préparer les modifications').click())
    await agree()
    const result = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Résultat de procédure"]'
    )!
    await act(async () => {
      result.value = ''
      result.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(container.textContent).not.toContain('J’approuve les modifications de cet aperçu')
    expect(button('Préparer les modifications').disabled).toBe(true)
    expect(mocks.apply).not.toHaveBeenCalled()
    const source = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Source des valeurs proposées"]'
    )!
    await act(async () => {
      source.value = 'manual'
      source.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(input('Ligne 2, colonne 3 — valeur proposée')).not.toBeNull()
    expect(mocks.procedurePrepare).toHaveBeenCalledOnce()
  })
  it('shows an empty authorized catalog without inventing an approved procedure', async () => {
    mocks.list.mockResolvedValue({ items: [], truncated: false })
    await render()
    await procedureMode()
    await act(async () => button('Charger les résultats de procédures').click())
    expect(container.textContent).toContain('Aucun résultat de procédure autorisé')
    expect(container.querySelector('[aria-label="Résultat de procédure"]')).toBeNull()
    expect(mocks.procedurePrepare).not.toHaveBeenCalled()
  })
  it('does not keep a late catalog when current rights change during loading', async () => {
    let finish!: (value: unknown) => void
    mocks.list.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    await render()
    await procedureMode()
    await act(async () => button('Charger les résultats de procédures').click())
    const signal = mocks.list.mock.calls[0][1] as AbortSignal
    enabled = false
    await render()
    expect(signal.aborted).toBe(true)
    await act(async () => finish({ items: [procedureResult], truncated: false }))
    enabled = true
    await render()
    expect(container.querySelector('[aria-label="Résultat de procédure"]')).toBeNull()
    expect(mocks.procedurePrepare).not.toHaveBeenCalled()
  })
  it('keeps server refusals private and allows only a new explicit read before any native work', async () => {
    mocks.procedurePrepare.mockRejectedValue(new OfficeProcedureError('result_unavailable'))
    await render()
    await chooseProcedure()
    await attest()
    await act(async () => button('Préparer les modifications').click())
    expect(container.textContent).toContain(
      'Ce résultat n’est pas disponible pour cette sauvegarde'
    )
    expect(container.textContent).not.toContain('J’approuve les modifications de cet aperçu')
    expect(mocks.procedurePrepare).toHaveBeenCalledOnce()
    expect(mocks.apply).not.toHaveBeenCalled()
    expect(lock).toHaveBeenLastCalledWith(false)
    expect(button('Charger les résultats de procédures').disabled).toBe(false)
  })
  it('keeps native preparation uncertainty locked when a procedure result was selected', async () => {
    mocks.procedurePrepare.mockRejectedValue(new OfficeEditError('timeout'))
    await render()
    await chooseProcedure()
    await attest()
    await act(async () => button('Préparer les modifications').click())
    expect(container.textContent).toContain('Préparation non confirmée')
    expect(button('Charger les résultats de procédures').disabled).toBe(true)
    expect(button('Préparer les modifications').disabled).toBe(true)
    expect(lock).toHaveBeenLastCalledWith(true)
    expect(mocks.procedurePrepare).toHaveBeenCalledOnce()
  })
  it('requires an authentic backup binding and never derives authority from the receipt alone', async () => {
    mocks.observation.mockReturnValue(null)
    await render()
    expect(container.textContent).toContain(
      'Cette sauvegarde ne permet pas de préparer une modification'
    )
    expect(container.querySelector('input')).toBeNull()
    expect(mocks.prepare).not.toHaveBeenCalled()
  })
  it('requires the local exclusive-copy attestation and preserves native input types', async () => {
    await render()
    expect(button('Préparer les modifications').disabled).toBe(true)
    expect(mocks.prepare).not.toHaveBeenCalled()
    await text('Ligne 2, colonne 3 — valeur proposée', '3,5')
    await text('Ligne 2, colonne 4 — valeur proposée', '=NOUVELLE_DONNEE()')
    await attest()
    await act(async () => button('Préparer les modifications').click())
    expect(mocks.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        backup,
        excel,
        values: [
          [3.5, '=NOUVELLE_DONNEE()'],
          [true, null],
        ],
        exclusiveLocalCopyConfirmed: true,
        signal: expect.any(AbortSignal),
      })
    )
    expect(container.textContent).toContain('Avant')
    expect(container.textContent).toContain('Après')
    expect(container.textContent).toContain('Ligne 2, colonne 3')
    expect(mocks.apply).not.toHaveBeenCalled()
  })
  it('refuses an empty numeric field instead of converting it to zero', async () => {
    await render()
    await text('Ligne 2, colonne 3 — valeur proposée', '')
    await attest()
    await act(async () => button('Préparer les modifications').click())
    expect(container.textContent).toContain('Renseignez un nombre fini')
    expect(mocks.prepare).not.toHaveBeenCalled()
  })
  it('uses an explicit clearing control for null and a native checkbox for booleans', async () => {
    await render()
    await act(async () => input('Effacer ligne 2, colonne 3').click())
    await act(async () => input('Ligne 3, colonne 3 — valeur proposée').click())
    await prepare()
    expect(mocks.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        values: [
          [null, '=DONNEE_OPAQUE()'],
          [false, null],
        ],
      })
    )
  })
  it('invalidates the preview and its agreement when proposed values change', async () => {
    await render()
    await prepare()
    await agree()
    expect(button('Appliquer et vérifier').disabled).toBe(false)
    await text('Ligne 2, colonne 3 — valeur proposée', '4')
    expect(container.textContent).not.toContain('J’approuve les modifications de cet aperçu')
    expect(mocks.approve).not.toHaveBeenCalled()
    expect(mocks.apply).not.toHaveBeenCalled()
  })
  it('invalidates the agreement when the exclusive-copy attestation is withdrawn', async () => {
    await render()
    await prepare()
    await agree()
    await attest()
    expect(container.textContent).not.toContain('J’approuve les modifications de cet aperçu')
    expect(button('Préparer les modifications').disabled).toBe(true)
    expect(mocks.apply).not.toHaveBeenCalled()
  })
  it('allows correcting a protected-formula proposal without inferring formulas in the UI', async () => {
    mocks.prepare.mockRejectedValueOnce(new OfficeEditError('formula_protected'))
    await render()
    await prepare()
    expect(container.textContent).toContain('Une proposition toucherait une formule existante')
    expect(input('Ligne 2, colonne 3 — valeur proposée').disabled).toBe(false)
    await text('Ligne 2, colonne 3 — valeur proposée', '1')
    await act(async () => button('Préparer les modifications').click())
    expect(mocks.prepare).toHaveBeenCalledTimes(2)
    expect(mocks.apply).not.toHaveBeenCalled()
  })
  it('keeps a preparation timeout locked and does not retry it automatically', async () => {
    mocks.prepare.mockRejectedValue(new OfficeEditError('timeout'))
    await render()
    await prepare()
    expect(container.textContent).toContain('Préparation non confirmée')
    expect(input('Ligne 2, colonne 3 — valeur proposée').disabled).toBe(true)
    expect(mocks.prepare).toHaveBeenCalledTimes(1)
    expect(lock).toHaveBeenLastCalledWith(true)
  })
  it('does not offer approval or application when the preview has no changes', async () => {
    mocks.prepare.mockResolvedValue({ ...preview, changes: [] })
    await render()
    await prepare()
    expect(container.textContent).toContain('Aucune différence à appliquer')
    expect(input('J’approuve les modifications de cet aperçu').disabled).toBe(true)
    expect(button('Appliquer et vérifier').disabled).toBe(true)
    expect(mocks.approve).not.toHaveBeenCalled()
  })
  it('invalidates agreement when current permissions or the bound backup change', async () => {
    await render()
    await prepare()
    await agree()
    enabled = false
    await render()
    expect(container.textContent).not.toContain('J’approuve les modifications de cet aperçu')
    expect(button('Préparer les modifications').disabled).toBe(true)
    enabled = true
    currentBackup = { ...backup, receipt: { ...backup.receipt, fileId: 'another-backup' } }
    await render()
    expect(container.textContent).not.toContain('J’approuve les modifications de cet aperçu')
    expect(mocks.apply).not.toHaveBeenCalled()
  })
  it('guards synchronous double clicks and shows recalculation, readback and the unconfirmed durable save', async () => {
    let finish!: (value: unknown) => void
    mocks.apply.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    await render()
    await prepare()
    await agree()
    const apply = button('Appliquer et vérifier')
    await act(async () => {
      apply.click()
      apply.click()
    })
    expect(mocks.approve).toHaveBeenCalledTimes(1)
    expect(mocks.apply).toHaveBeenCalledTimes(1)
    expect(mocks.apply).toHaveBeenCalledWith(
      preview,
      mocks.approve.mock.results[0].value,
      expect.any(AbortSignal)
    )
    await act(async () =>
      finish({
        status: 'verified',
        observation: {
          ...observation,
          values: [
            [2, '=DONNEE_OPAQUE()'],
            [true, null],
          ],
        },
        changedCells: 1,
        calculation: 'range_calculated',
        durableSave: 'not_confirmed',
      })
    )
    expect(container.textContent).toContain('Modification relue et vérifiée')
    expect(container.textContent).toContain('Recalcul de la plage effectué')
    expect(container.textContent).toContain('L’enregistrement sur disque n’est pas confirmé')
    expect(input('Ligne 2, colonne 3 — valeur proposée').disabled).toBe(true)
    expect(mocks.apply).toHaveBeenCalledTimes(1)
    expect(lock).toHaveBeenLastCalledWith(true)
  })
  it.each(['refused', 'uncertain'] as const)(
    'freezes after an application result %s without retry',
    async (status) => {
      mocks.apply.mockResolvedValue({ status, code: 'fixture_closed_code' })
      await render()
      await prepare()
      await agree()
      await act(async () => button('Appliquer et vérifier').click())
      expect(container.textContent).toContain(
        status === 'uncertain' ? 'Résultat incertain' : 'Application refusée'
      )
      expect(container.textContent).not.toContain('Modification relue et vérifiée')
      expect(input('Ligne 2, colonne 3 — valeur proposée').disabled).toBe(true)
      expect(mocks.apply).toHaveBeenCalledTimes(1)
    }
  )
  it('retains an unexpected application uncertainty when permissions change', async () => {
    mocks.apply.mockRejectedValue(new Error('Boundary fixture failure'))
    await render()
    await prepare()
    await agree()
    await act(async () => button('Appliquer et vérifier').click())
    expect(container.textContent).toContain('Résultat incertain')
    enabled = false
    await render()
    enabled = true
    await render()
    expect(container.textContent).toContain('Résultat incertain')
    expect(button('Préparer les modifications').disabled).toBe(true)
    expect(container.textContent).not.toContain('J’approuve les modifications de cet aperçu')
    expect(mocks.apply).toHaveBeenCalledTimes(1)
    expect(lock).toHaveBeenLastCalledWith(true)
  })
  it('aborts the owned wait at unmount without accepting a late result', async () => {
    let finish!: (value: unknown) => void
    mocks.apply.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    await render()
    await prepare()
    await agree()
    await act(async () => button('Appliquer et vérifier').click())
    const signal = mocks.apply.mock.calls[0][2] as AbortSignal
    await act(async () => root.unmount())
    mounted = false
    expect(signal.aborted).toBe(true)
    await act(async () => finish({ status: 'uncertain', code: 'fixture_closed_code' }))
    expect(mocks.apply).toHaveBeenCalledTimes(1)
  })
  it('shows a bounded observation but refuses editable grids larger than 100 cells', async () => {
    mocks.observation.mockReturnValue({
      ...observation,
      range: { ...observation.range, endRow: 102, endColumn: 3 },
      values: Array.from({ length: 101 }, () => [1]),
      valueTypes: Array.from({ length: 101 }, () => ['Integer']),
      formulas: Array.from({ length: 101 }, () => [1]),
      numberFormat: Array.from({ length: 101 }, () => ['General']),
    })
    await render()
    expect(container.textContent).toContain('L’édition dans ce volet est limitée à 100 cellules')
    expect(container.querySelectorAll('tbody tr').length).toBeLessThanOrEqual(20)
    expect(container.querySelector('input')).toBeNull()
    expect(mocks.prepare).not.toHaveBeenCalled()
  })
})

describe('save final: Office edit panel', () => {
  it('offers a separate explicit save after verification and never presents its acknowledgement as a disk read', async () => {
    await render()
    expect(container.textContent).not.toContain('Enregistrer le classeur')
    await prepare()
    await agree()
    await act(async () => button('Appliquer et vérifier').click())
    expect(mocks.save).not.toHaveBeenCalled()
    await act(async () => {
      const save = button('Enregistrer le classeur')
      save.click()
      save.click()
    })
    expect(mocks.save).toHaveBeenCalledExactlyOnceWith(
      await mocks.apply.mock.results[0].value,
      expect.any(AbortSignal)
    )
    expect(container.textContent).toContain('Excel a confirmé l’enregistrement')
    expect(container.textContent).toContain('persistance physique du fichier n’est pas vérifiée')
    expect(button('Enregistrer le classeur').disabled).toBe(true)
    expect(mocks.apply).toHaveBeenCalledTimes(1)
  })
  it('keeps a lost save result uncertain and does not retry on render', async () => {
    mocks.save.mockRejectedValueOnce(new Error('PRIVATE_CANARY native failure'))
    await render()
    await prepare()
    await agree()
    await act(async () => button('Appliquer et vérifier').click())
    await act(async () => button('Enregistrer le classeur').click())
    await render()
    expect(container.textContent).toContain('Enregistrement incertain')
    expect(container.textContent).not.toContain('PRIVATE_CANARY')
    expect(mocks.save).toHaveBeenCalledTimes(1)
    expect(button('Enregistrer le classeur').disabled).toBe(true)
  })
})

it('save final: a permission or backup change discards a late acknowledgement and cannot revive save eligibility', async () => {
  for (const mode of ['permission', 'backup']) {
    let resolve!: (value: unknown) => void
    mocks.save.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    await render()
    await prepare()
    await agree()
    await act(async () => button('Appliquer et vérifier').click())
    await act(async () => button('Enregistrer le classeur').click())
    const signal = mocks.save.mock.calls.at(-1)![1] as AbortSignal
    if (mode === 'permission') enabled = false
    else currentBackup = structuredClone(backup)
    await render()
    expect(signal.aborted).toBe(true)
    await act(async () =>
      resolve({
        status: 'acknowledged',
        durableSave: 'office_acknowledged',
        diskVerification: 'not_observed',
      })
    )
    enabled = true
    await render()
    expect(container.textContent).not.toContain('Excel a confirmé l’enregistrement')
    expect(
      [...container.querySelectorAll('button')].some(
        (el) => el.textContent === 'Enregistrer le classeur'
      )
    ).toBe(false)
    if (mode === 'permission') {
      await act(async () => root.unmount())
      root = createRoot(container)
      currentBackup = backup
    }
  }
  expect(mocks.save).toHaveBeenCalledTimes(2)
})
