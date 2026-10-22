/** @vitest-environment jsdom */
// Copyright (c) 2026 Memlia. All rights reserved.
// Session/workspaces/SDK loading and the backup boundary are doubles; no real Excel claim.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OfficeBackupClientResult } from '@/lib/memlia/excel/office/backup-client'
import { OfficePreflightError } from '@/lib/memlia/excel/office/preflight'
import { type OfficeRangeObservation, OfficeReadError } from '@/lib/memlia/excel/office/read-scope'

const mocks = vi.hoisted(() => ({
  script: vi.fn(),
  session: vi.fn(),
  workspaces: vi.fn(),
  backup: vi.fn(),
  preflight: vi.fn(),
  selection: vi.fn(),
  editObservation: vi.fn(),
  editPrepare: vi.fn(),
  editApprove: vi.fn(),
  editApply: vi.fn(),
}))
vi.mock('@/lib/auth/client', () => ({ useSession: mocks.session }))
vi.mock('@/hooks/queries/workspace', () => ({ useWorkspacesWithMetadata: mocks.workspaces }))
vi.mock('@/lib/memlia/excel/office/backup-client', () => ({
  backupCurrentOfficeWorkbook: mocks.backup,
}))
vi.mock('@/lib/memlia/excel/office/preflight', async (original) => ({
  ...(await original<typeof import('@/lib/memlia/excel/office/preflight')>()),
  preflightOffice: mocks.preflight,
}))
vi.mock('@/lib/memlia/excel/office/read-scope', async (original) => ({
  ...(await original<typeof import('@/lib/memlia/excel/office/read-scope')>()),
  readSelectedOfficeRange: mocks.selection,
}))
vi.mock('next/script', () => ({
  default: () => {
    mocks.script()
    return null
  },
}))
vi.mock('@sim/emcn', async () => ({
  ...(await import('@sim/emcn/components/button/button')),
  ...(await import('@sim/emcn/components/label/label')),
}))

import { ExcelTaskpane } from './taskpane'

vi.mock('@/lib/memlia/excel/office/edit-session', () => ({
  getOfficeEditBackupObservation: mocks.editObservation,
  prepareOfficeEdit: mocks.editPrepare,
  approveOfficeEdit: mocks.editApprove,
  applyOfficeEdit: mocks.editApply,
}))

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  mocks.script.mockReset()
  mocks.preflight.mockReset()
  mocks.selection.mockReset()
  mocks.editObservation.mockReset().mockReturnValue(null)
  mocks.editPrepare.mockReset()
  mocks.editApprove.mockReset().mockReturnValue(Object.freeze({}))
  mocks.editApply.mockReset()
  mocks.session.mockReturnValue({
    data: { user: { id: 'signed-in-user' } },
    isPending: false,
    error: null,
  })
  mocks.workspaces.mockReturnValue({
    data: {
      workspaces: [{ id: 'allowed-workspace', name: 'Espace fictif', permissions: 'write' }],
    },
    isPending: false,
    isError: false,
  })
  vi.stubGlobal('Office', {})
  vi.stubGlobal('Excel', {})
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})
async function render() {
  await act(async () => root.render(<ExcelTaskpane />))
}
function button(label = 'Créer ma sauvegarde privée') {
  const found = [...container.querySelectorAll('button')].find((item) => item.textContent === label)
  if (!found) throw new Error('Expected action missing')
  return found
}
function checkbox() {
  return container.querySelector<HTMLInputElement>('input[type="checkbox"]')!
}
async function consent() {
  const select = container.querySelector<HTMLSelectElement>('select')!
  await act(async () => {
    select.value = 'allowed-workspace'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await act(async () => checkbox().click())
  expect(button().disabled).toBe(false)
}
async function storedBackup() {
  mocks.backup.mockResolvedValue({
    status: 'stored',
    receipt: {
      fileId: 'private-backup',
      byteLength: 4,
      contentVersion: 12,
      sha256: `sha256:${'a'.repeat(64)}`,
    },
  })
  await render()
  await consent()
  await act(async () => button().click())
}
function selection(): OfficeRangeObservation {
  return {
    version: 1,
    kind: 'office_range_observation',
    scope: 'current_office_document',
    qualification: 'not_verified',
    worksheet: { id: 'opaque-sheet', name: 'Feuille fictive' },
    range: {
      sheetId: 'opaque-sheet',
      startRow: 2,
      endRow: 2,
      startColumn: 3,
      endColumn: 4,
      address: 'Feuille fictive!C2:D2',
    },
    values: [['<script>fictif</script>', 25]],
    valueTypes: [['String', 'Integer']],
    formulas: [['<script>fictif</script>', '=SUM(A1:A2)']],
    numberFormat: [['General', '0']],
  }
}

describe('Memlia native Excel taskpane', () => {
  it('uses native login with a fixed return path when no session is available', async () => {
    mocks.session.mockReturnValue({ data: null, isPending: false, error: null })
    await render()
    expect(container.querySelector('a')?.getAttribute('href')).toBe(
      '/login?callbackUrl=%2Fexcel-addin'
    )
    expect(container.querySelector('button')).toBeNull()
    expect(mocks.backup).not.toHaveBeenCalled()
  })
  it('requires a listed workspace and explicit consent before reading or uploading', async () => {
    await render()
    expect(button().disabled).toBe(true)
    expect(checkbox().disabled).toBe(true)
    expect(mocks.backup).not.toHaveBeenCalled()
    await consent()
    expect(mocks.backup).not.toHaveBeenCalled()
    expect(container.querySelector('label[for="office-backup-workspace"]')).not.toBeNull()
    expect(container.querySelector('[aria-live="polite"]')).not.toBeNull()
  })
  it('shows a verified receipt only after the backup boundary returns stored', async () => {
    mocks.backup.mockResolvedValue({
      status: 'stored',
      receipt: {
        fileId: 'private-backup',
        byteLength: 4,
        contentVersion: 12,
        sha256: `sha256:${'a'.repeat(64)}`,
      },
    })
    await render()
    await consent()
    await act(async () => button().click())
    expect(container.querySelector('h2')?.textContent).toBe('Sauvegarde privée vérifiée')
    expect(container.textContent).toContain('private-backup')
    expect(mocks.backup).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'allowed-workspace',
        expectedUserId: 'signed-in-user',
      })
    )
    expect(container.querySelector('input[type="text"]')).toBeNull()
  })
  it('binds an edit backup only after the explicit edit-selection option is checked', async () => {
    mocks.backup.mockResolvedValue({
      status: 'stored',
      receipt: {
        fileId: 'private-backup',
        workspaceId: 'allowed-workspace',
        ownerUserId: 'signed-in-user',
        byteLength: 4,
        contentVersion: 12,
        sha256: `sha256:${'a'.repeat(64)}`,
      },
    })
    await render()
    await consent()
    const option = container.querySelector<HTMLInputElement>(
      'input[aria-label="Préparer une modification de ma sélection"]'
    )!
    await act(async () => option.click())
    await act(async () => button().click())
    expect(mocks.backup).toHaveBeenCalledWith(
      expect.objectContaining({ editSelection: { excel: Reflect.get(globalThis, 'Excel') } })
    )
    expect(container.textContent).toContain(
      'Cette sauvegarde ne permet pas de préparer une modification'
    )
    expect(container.textContent).not.toContain('Examiner la sélection ouverte')
  })
  it('blocks backup reset during native edit preparation and keeps it blocked after an uncertain application', async () => {
    const observed = selection()
    mocks.editObservation.mockReturnValue(observed)
    mocks.backup.mockResolvedValue({
      status: 'stored',
      receipt: {
        fileId: 'private-backup',
        workspaceId: 'allowed-workspace',
        ownerUserId: 'signed-in-user',
        byteLength: 4,
        contentVersion: 12,
        sha256: `sha256:${'a'.repeat(64)}`,
      },
    })
    let finish!: (value: unknown) => void
    mocks.editPrepare.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    mocks.editApply.mockResolvedValue({ status: 'uncertain', code: 'verification_failed' })
    await render()
    await consent()
    await act(async () =>
      container
        .querySelector<HTMLInputElement>(
          'input[aria-label="Préparer une modification de ma sélection"]'
        )!
        .click()
    )
    await act(async () => button().click())
    await act(async () =>
      container
        .querySelector<HTMLInputElement>(
          'input[aria-label="Je travaille sur une copie locale exclusive, sans coédition"]'
        )!
        .click()
    )
    await act(async () => button('Préparer les modifications').click())
    const reset = button('Préparer une autre sauvegarde')
    expect(reset.disabled).toBe(true)
    await act(async () => reset.click())
    expect(mocks.backup).toHaveBeenCalledTimes(1)
    expect((mocks.editPrepare.mock.calls[0][0].signal as AbortSignal).aborted).toBe(false)
    await act(async () =>
      finish({
        digest: `sha256:${'b'.repeat(64)}`,
        observation: observed,
        backupFileId: 'private-backup',
        changes: [{ row: 0, column: 1, before: 25, after: 26 }],
      })
    )
    await act(async () =>
      container
        .querySelector<HTMLInputElement>(
          'input[aria-label="J’approuve les modifications de cet aperçu"]'
        )!
        .click()
    )
    await act(async () => button('Appliquer et vérifier').click())
    expect(container.textContent).toContain('Résultat incertain')
    expect(reset.disabled).toBe(true)
    await act(async () => reset.click())
    expect(mocks.backup).toHaveBeenCalledTimes(1)
    expect(mocks.editApply).toHaveBeenCalledTimes(1)
    expect(container.textContent).not.toContain('Examiner la sélection ouverte')
  })
  it('prevents concurrent clicks and any new upload after an unknown result', async () => {
    let finish!: (v: OfficeBackupClientResult) => void
    mocks.backup.mockImplementation(
      () =>
        new Promise<OfficeBackupClientResult>((resolve) => {
          finish = resolve
        })
    )
    await render()
    await consent()
    const action = button()
    await act(async () => {
      action.click()
      action.click()
    })
    expect(mocks.backup).toHaveBeenCalledTimes(1)
    await act(async () => finish({ status: 'unconfirmed', code: 'response_unknown', fileId: null }))
    expect(container.querySelector('h2')?.textContent).toBe('Résultat non confirmé')
    expect(action.disabled).toBe(true)
    await act(async () => action.click())
    expect(mocks.backup).toHaveBeenCalledTimes(1)
    expect(container.textContent).not.toContain('Préparer une autre sauvegarde')
  })
  it('does not offer a workspace whose native role is read-only', async () => {
    mocks.workspaces.mockReturnValue({
      data: { workspaces: [{ id: 'read-only', name: 'Lecture seule', permissions: 'read' }] },
      isPending: false,
      isError: false,
    })
    await render()
    expect(container.querySelectorAll('option')).toHaveLength(1)
    expect(button().disabled).toBe(true)
    expect(mocks.backup).not.toHaveBeenCalled()
  })
  it('does not enable backup while the authenticated workspace list is unavailable', async () => {
    mocks.workspaces.mockReturnValue({ data: undefined, isPending: false, isError: true })
    await render()
    expect(button().disabled).toBe(true)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Les espaces ne sont pas disponibles'
    )
    expect(mocks.backup).not.toHaveBeenCalled()
  })
  it('reads a new selection only on an explicit click after a stored backup and renders it as text', async () => {
    const scope = Object.freeze({ version: 1 })
    mocks.preflight.mockResolvedValue(scope)
    mocks.selection.mockResolvedValue(selection())
    await storedBackup()
    expect(mocks.preflight).not.toHaveBeenCalled()
    expect(mocks.selection).not.toHaveBeenCalled()
    await act(async () => button('Examiner ma sélection').click())
    expect(mocks.preflight).toHaveBeenCalledWith(
      Reflect.get(globalThis, 'Office'),
      expect.any(AbortSignal)
    )
    expect(mocks.selection).toHaveBeenCalledWith(
      scope,
      Reflect.get(globalThis, 'Excel'),
      expect.any(AbortSignal)
    )
    expect(container.querySelector('table')?.textContent).toContain('<script>fictif</script>')
    expect(container.querySelector('script')).toBeNull()
    expect(container.textContent).toContain('=SUM(A1:A2)')
    expect(container.textContent).toContain('Feuille fictive!C2:D2')
    expect(container.textContent).toContain('nouvelle observation locale')
    expect(container.textContent).toContain('le classeur peut avoir changé depuis la sauvegarde')
    expect(mocks.backup).toHaveBeenCalledTimes(1)
  })
  it.each([
    { status: 'refused', code: 'storage_refused' },
    { status: 'unconfirmed', code: 'response_unknown', fileId: null },
  ] as const)('does not expose selection reading after a $status backup', async (outcome) => {
    mocks.backup.mockResolvedValue(outcome)
    await render()
    await consent()
    await act(async () => button().click())
    expect(container.textContent).not.toContain('Examiner ma sélection')
    expect(mocks.preflight).not.toHaveBeenCalled()
    expect(mocks.selection).not.toHaveBeenCalled()
  })
  it('refuses an unavailable Office host before requesting any selection', async () => {
    mocks.preflight.mockRejectedValue(new OfficePreflightError('office_platform_unqualified'))
    await storedBackup()
    await act(async () => button('Examiner ma sélection').click())
    expect(mocks.selection).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Lecture refusée')
    expect(container.querySelector('table')).toBeNull()
  })
  it('shows a fixed refusal for an invalid selection and never displays the SDK cause', async () => {
    mocks.preflight.mockResolvedValue(Object.freeze({ version: 1 }))
    const error = new OfficeReadError('office_read_scope_invalid')
    error.message = 'FICTITIOUS_PRIVATE_SDK_DETAIL'
    mocks.selection.mockRejectedValue(error)
    await storedBackup()
    await act(async () => button('Examiner ma sélection').click())
    expect(container.textContent).toContain('Lecture refusée')
    expect(container.textContent).not.toContain('FICTITIOUS_PRIVATE_SDK_DETAIL')
    expect(container.querySelector('table')).toBeNull()
    expect(mocks.backup).toHaveBeenCalledTimes(1)
  })
  it('bounds displayed rows, columns and cell text without evaluating formulas', async () => {
    mocks.preflight.mockResolvedValue(Object.freeze({ version: 1 }))
    const observed = selection()
    const values = Array.from({ length: 21 }, (_, row) =>
      Array.from({ length: 9 }, (_, column) =>
        row === 20 || column === 8 ? 'FICTITIOUS_HIDDEN_CELL' : `${'x'.repeat(200)}OMITTED_SUFFIX`
      )
    )
    mocks.selection.mockResolvedValue({
      ...observed,
      range: { ...observed.range, endRow: 22, endColumn: 11 },
      values,
      valueTypes: values.map((row) => row.map(() => 'String')),
      formulas: values.map((row) => row.map(() => '=FICTITIOUS_FORMULA()')),
      numberFormat: values.map((row) => row.map(() => 'General')),
    })
    await storedBackup()
    await act(async () => button('Examiner ma sélection').click())
    expect(container.querySelectorAll('tbody tr')).toHaveLength(20)
    expect(container.querySelectorAll('tbody td')).toHaveLength(160)
    expect(container.textContent).toContain('21 lignes · 9 colonnes')
    expect(container.textContent).toContain('Sélection tronquée à l’affichage')
    expect(container.textContent).not.toContain('FICTITIOUS_HIDDEN_CELL')
    expect(container.textContent).not.toContain('OMITTED_SUFFIX')
    expect(container.textContent).toContain(`${'x'.repeat(200)}…`)
    expect(container.querySelector('caption')?.textContent).toContain('formules ou constantes')
    expect(container.querySelector('th[scope="row"]')?.textContent).toBe('2')
    expect(container.querySelector('thead')?.textContent).toContain('Colonne 3')
  })
  it('guards two synchronous selection clicks and discards a result after cancellation', async () => {
    mocks.preflight.mockResolvedValue(Object.freeze({ version: 1 }))
    let finish!: (result: OfficeRangeObservation) => void
    mocks.selection.mockImplementation(
      () =>
        new Promise<OfficeRangeObservation>((resolve) => {
          finish = resolve
        })
    )
    await storedBackup()
    const action = button('Examiner ma sélection')
    await act(async () => {
      action.click()
      action.click()
    })
    expect(mocks.preflight).toHaveBeenCalledTimes(1)
    expect(mocks.selection).toHaveBeenCalledTimes(1)
    const signal = mocks.selection.mock.calls[0][2] as AbortSignal
    expect(signal.aborted).toBe(false)
    await act(async () => button('Annuler la lecture').click())
    expect(signal.aborted).toBe(true)
    await act(async () => finish(selection()))
    expect(container.textContent).toContain('Attente annulée')
    expect(container.querySelector('table')).toBeNull()
    expect(action.disabled).toBe(true)
    await act(async () => action.click())
    expect(mocks.selection).toHaveBeenCalledTimes(1)
  })
  it.each([
    new OfficeReadError('office_read_timeout'),
    new OfficeReadError('office_read_scope_changed'),
    new Error('FICTITIOUS_PRIVATE_FAILURE'),
  ])('keeps an uncertain reading closed without automatic retries', async (error) => {
    mocks.preflight.mockResolvedValue(Object.freeze({ version: 1 }))
    mocks.selection.mockRejectedValue(error)
    await storedBackup()
    await act(async () => button('Examiner ma sélection').click())
    expect(container.textContent).toContain('Résultat de lecture inconnu')
    expect(container.textContent).not.toContain('FICTITIOUS_PRIVATE_FAILURE')
    expect(container.querySelector('table')).toBeNull()
    expect(button('Examiner ma sélection').disabled).toBe(true)
    await act(async () => button('Examiner ma sélection').click())
    expect(mocks.selection).toHaveBeenCalledTimes(1)
    expect(mocks.backup).toHaveBeenCalledTimes(1)
  })
  it('does not read Excel when the user cancels while preflight is pending', async () => {
    let finish!: (scope: object) => void
    mocks.preflight.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    await storedBackup()
    await act(async () => button('Examiner ma sélection').click())
    await act(async () => button('Annuler la lecture').click())
    await act(async () => finish(Object.freeze({ version: 1 })))
    expect(mocks.selection).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Attente annulée')
  })
  it('aborts the owned read when the saved-backup view is left and ignores its late result', async () => {
    mocks.preflight.mockResolvedValue(Object.freeze({ version: 1 }))
    let finish!: (result: OfficeRangeObservation) => void
    mocks.selection.mockImplementation(
      () =>
        new Promise<OfficeRangeObservation>((resolve) => {
          finish = resolve
        })
    )
    await storedBackup()
    await act(async () => button('Examiner ma sélection').click())
    const signal = mocks.selection.mock.calls[0][2] as AbortSignal
    await act(async () => button('Préparer une autre sauvegarde').click())
    expect(signal.aborted).toBe(true)
    await act(async () => finish(selection()))
    expect(container.querySelector('table')).toBeNull()
    expect(container.textContent).not.toContain('nouvelle observation locale')
    expect(mocks.backup).toHaveBeenCalledTimes(1)
  })
  it('allows another explicit reading after success and clears the old preview while reading', async () => {
    mocks.preflight.mockResolvedValue(Object.freeze({ version: 1 }))
    let finish!: (result: OfficeRangeObservation) => void
    mocks.selection.mockResolvedValueOnce(selection()).mockImplementationOnce(
      () =>
        new Promise<OfficeRangeObservation>((resolve) => {
          finish = resolve
        })
    )
    await storedBackup()
    await act(async () => button('Examiner ma sélection').click())
    expect(container.querySelector('table')?.textContent).toContain('<script>fictif</script>')
    expect(mocks.selection).toHaveBeenCalledTimes(1)
    expect(button('Examiner ma sélection').disabled).toBe(false)
    await act(async () => button('Examiner ma sélection').click())
    expect(container.querySelector('table')).toBeNull()
    expect(mocks.selection).toHaveBeenCalledTimes(2)
    const updated = selection()
    await act(async () => finish({ ...updated, values: [['Nouvelle valeur fictive', 42]] }))
    expect(container.querySelector('table')?.textContent).toContain('Nouvelle valeur fictive')
    expect(mocks.preflight).toHaveBeenCalledTimes(2)
    expect(mocks.backup).toHaveBeenCalledTimes(1)
  })
  it('allows a new explicit selection after a known geometry refusal', async () => {
    mocks.preflight.mockResolvedValue(Object.freeze({ version: 1 }))
    mocks.selection
      .mockRejectedValueOnce(new OfficeReadError('office_read_scope_invalid'))
      .mockResolvedValueOnce(selection())
    await storedBackup()
    await act(async () => button('Examiner ma sélection').click())
    expect(container.textContent).toContain('Lecture refusée')
    expect(button('Examiner ma sélection').disabled).toBe(false)
    expect(mocks.selection).toHaveBeenCalledTimes(1)
    await act(async () => button('Examiner ma sélection').click())
    expect(container.querySelector('table')).not.toBeNull()
    expect(mocks.selection).toHaveBeenCalledTimes(2)
    expect(mocks.backup).toHaveBeenCalledTimes(1)
  })
  it('keeps an invalid run contract unknown because the native operation may remain open', async () => {
    const realPreflight = await vi.importActual<
      typeof import('@/lib/memlia/excel/office/preflight')
    >('@/lib/memlia/excel/office/preflight')
    const realReader = await vi.importActual<typeof import('@/lib/memlia/excel/office/read-scope')>(
      '@/lib/memlia/excel/office/read-scope'
    )
    mocks.preflight.mockImplementation(realPreflight.preflightOffice)
    mocks.selection.mockImplementation(realReader.readSelectedOfficeRange)
    vi.stubGlobal('Office', {
      onReady: () => Promise.resolve({ host: 'Excel', platform: 'PC' }),
      context: {
        document: { mode: 'readWrite', getFileAsync: vi.fn() },
        requirements: { isSetSupported: () => true },
      },
    })
    // A real reader/preflight composition over an SDK double; no Windows qualification.
    const run = vi.fn(() => undefined)
    vi.stubGlobal('Excel', { run })
    await storedBackup()
    await act(async () => button('Examiner ma sélection').click())
    expect(container.textContent).toContain('Résultat de lecture inconnu')
    expect(container.querySelector('table')).toBeNull()
    expect(button('Examiner ma sélection').disabled).toBe(true)
    await act(async () => button('Examiner ma sélection').click())
    expect(mocks.selection).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledTimes(1)
  })
})

describe('Office history before SDK', () => {
  let history: History
  let push: PropertyDescriptor | undefined
  let replace: PropertyDescriptor | undefined
  beforeEach(() => {
    history = window.history
    push = Object.getOwnPropertyDescriptor(history, 'pushState')
    replace = Object.getOwnPropertyDescriptor(history, 'replaceState')
  })
  afterEach(() => {
    vi.stubGlobal('history', history)
    for (const [name, descriptor] of [
      ['pushState', push],
      ['replaceState', replace],
    ] as const) {
      if (descriptor) Object.defineProperty(history, name, descriptor)
      else Reflect.deleteProperty(history, name)
    }
  })
  it('protects both native methods before the first Script render can assign null', async () => {
    const nativePush = history.pushState
    const nativeReplace = history.replaceState
    mocks.script.mockImplementation(() => {
      Reflect.set(history, 'pushState', null)
      Reflect.set(history, 'replaceState', null)
    })
    await render()
    expect(mocks.script).toHaveBeenCalled()
    expect(history.pushState).toBe(nativePush)
    expect(history.replaceState).toBe(nativeReplace)
    expect(() => history.replaceState({ fixture: true }, '', '#office-history')).not.toThrow()
    expect(history.state).toEqual({ fixture: true })
  })
  it('accepts callable Next wrappers unchanged and preserves the history receiver', async () => {
    await render()
    const original = history.pushState
    let receiver: unknown
    const wrapper: History['pushState'] = function (this: History, ...args) {
      receiver = this
      return original.apply(this, args)
    }
    history.pushState = wrapper
    Reflect.set(history, 'pushState', null)
    Reflect.set(history, 'pushState', {})
    expect(history.pushState).toBe(wrapper)
    history.pushState({ next: true }, '', '#office-next')
    expect(receiver).toBe(history)
    expect(history.state).toEqual({ next: true })
  })
  it('is idempotent when the authenticated pane remounts', async () => {
    await render()
    const descriptors = Object.getOwnPropertyDescriptors(history)
    mocks.session.mockReturnValue({
      data: { user: { id: 'other-owned-user' } },
      isPending: false,
      error: null,
    })
    await render()
    expect(Object.getOwnPropertyDescriptor(history, 'pushState')).toEqual(descriptors.pushState)
    expect(Object.getOwnPropertyDescriptor(history, 'replaceState')).toEqual(
      descriptors.replaceState
    )
    Reflect.set(history, 'replaceState', null)
    expect(typeof history.replaceState).toBe('function')
  })
  it('does not request the SDK or enable backup when a descriptor cannot be protected', async () => {
    const blocked = { pushState: history.pushState, replaceState: history.replaceState }
    Object.defineProperty(blocked, 'replaceState', { configurable: false })
    vi.stubGlobal('history', blocked)
    await render()
    expect(mocks.script).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'n’a pas pu être chargé'
    )
    expect(button().disabled).toBe(true)
    expect(mocks.backup).not.toHaveBeenCalled()
  })
  it('refuses missing native methods instead of manufacturing navigation functions', async () => {
    vi.stubGlobal('history', { pushState: null, replaceState: history.replaceState })
    await render()
    expect(mocks.script).not.toHaveBeenCalled()
    expect(button().disabled).toBe(true)
  })
})
