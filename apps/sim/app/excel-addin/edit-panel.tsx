// Copyright (c) 2026 Memlia. All rights reserved.
'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from '@sim/emcn'
import type { OfficeBackupClientResult } from '@/lib/memlia/excel/office/backup-client'
import {
  applyOfficeEdit,
  approveOfficeEdit,
  getOfficeEditBackupObservation,
  OfficeEditError,
  type OfficeEditPreview,
  type OfficeEditResult,
  type OfficeSaveResult,
  saveVerifiedOfficeEdit,
  prepareOfficeEdit,
} from '@/lib/memlia/excel/office/edit-session'
import {
  listOfficeProcedureResults,
  OfficeProcedureError,
  type OfficeProcedureResult,
  prepareOfficeProcedureEdit,
} from '@/lib/memlia/excel/office/procedure-client'
import type { OfficeRangeObservation } from '@/lib/memlia/excel/office/read-scope'

const focus =
  'focus-visible:ring-2 focus-visible:ring-[var(--text-primary)] focus-visible:ring-offset-2'
type StoredBackup = Extract<OfficeBackupClientResult, { status: 'stored' }>
type Scalar = OfficeRangeObservation['values'][number][number]
function cellText(value: Scalar) {
  const text = value === null ? '∅' : String(value)
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}
function draftValues(observation: OfficeRangeObservation | null) {
  return (
    observation?.values.map((row) => row.map((value) => (value === null ? '' : String(value)))) ??
    []
  )
}

export function OfficeEditPanel({
  backup,
  excel,
  enabled,
  onLockChange,
}: {
  backup: StoredBackup
  excel: unknown
  enabled: boolean
  onLockChange: (locked: boolean) => void
}) {
  const observation = getOfficeEditBackupObservation(backup)
  const [draft, setDraft] = useState(() => draftValues(observation))
  const [cleared, setCleared] = useState<boolean[][]>(() =>
    draftValues(observation).map((row) => row.map(() => false))
  )
  const [source, setSource] = useState<'manual' | 'procedure'>('manual')
  const [catalog, setCatalog] = useState<Awaited<
    ReturnType<typeof listOfficeProcedureResults>
  > | null>(null)
  const [selectedResult, setSelectedResult] = useState<OfficeProcedureResult | null>(null)
  const [exclusive, setExclusive] = useState(false)
  const [agreement, setAgreement] = useState(false)
  const [preview, setPreview] = useState<OfficeEditPreview | null>(null)
  const [result, setResult] = useState<OfficeEditResult | null>(null)
  const [saveResult, setSaveResult] = useState<OfficeSaveResult | null>(null)
  const [saveCandidate, setSaveCandidate] = useState<{
    backup: StoredBackup
    result: Extract<OfficeEditResult, { status: 'verified' }>
  } | null>(null)
  const saveAttempted = useRef(false)
  const [phase, setPhase] = useState<'catalog' | 'prepare' | 'apply' | 'save' | null>(null)
  const [issue, setIssue] = useState<string | null>(null)
  const [terminal, setTerminal] = useState(false)
  const active = useRef<AbortController | null>(null)
  const prepared = useRef<OfficeEditPreview | null>(null)
  const agreed = useRef(false)
  const frozen = useRef(false)
  const priorBackup = useRef(backup)
  function invalidate() {
    prepared.current = null
    agreed.current = false
    setPreview(null)
    setAgreement(false)
    if (!frozen.current) setIssue(null)
  }
  useEffect(() => {
    invalidate()
    active.current?.abort()
    setSaveCandidate(null)
    setSaveResult(null)
    saveAttempted.current = false
    setCatalog(null)
    setSelectedResult(null)
    if (priorBackup.current !== backup) {
      priorBackup.current = backup
      setDraft(draftValues(observation))
      setCleared(draftValues(observation).map((row) => row.map(() => false)))
      setExclusive(false)
    }
  }, [backup, enabled])
  useEffect(
    () => () => {
      active.current?.abort()
      active.current = null
    },
    []
  )
  const pending = phase !== null
  const disabled = !enabled || pending || terminal
  const cells = observation
    ? (observation.range.endRow - observation.range.startRow + 1) *
      (observation.range.endColumn - observation.range.startColumn + 1)
    : 0
  if (!observation)
    return (
      <p role='alert'>
        Cette sauvegarde ne permet pas de préparer une modification. Préparez une nouvelle
        sauvegarde avec cette option activée.
      </p>
    )
  if (cells > 100)
    return (
      <section className='space-y-3' aria-label='Sélection à réduire'>
        <p>
          L’édition dans ce volet est limitée à 100 cellules. Sélectionnez une plage plus petite,
          puis créez une nouvelle sauvegarde liée.
        </p>
        <SelectionTable observation={observation} />
      </section>
    )

  function edit(row: number, column: number, value: string) {
    if (disabled || frozen.current) return
    invalidate()
    setDraft((previous) =>
      previous.map((line, index) =>
        index === row ? line.map((cell, position) => (position === column ? value : cell)) : line
      )
    )
  }
  async function loadResults() {
    if (disabled || frozen.current || active.current || source !== 'procedure') return
    invalidate()
    setCatalog(null)
    setSelectedResult(null)
    const controller = new AbortController()
    active.current = controller
    setPhase('catalog')
    onLockChange(true)
    try {
      const next = await listOfficeProcedureResults(backup.receipt.workspaceId, controller.signal)
      if (active.current === controller && !controller.signal.aborted) setCatalog(next)
    } catch {
      if (active.current === controller)
        setIssue(
          'Résultats indisponibles. Vérifiez votre session et vos droits, puis chargez la liste à nouveau si nécessaire.'
        )
    } finally {
      if (active.current === controller) {
        active.current = null
        setPhase(null)
        onLockChange(false)
      }
    }
  }
  async function prepare() {
    if (
      disabled ||
      frozen.current ||
      active.current ||
      !exclusive ||
      !observation ||
      (source === 'procedure' && !selectedResult)
    )
      return
    const values: Scalar[][] = []
    for (let row = 0; source === 'manual' && row < observation.values.length; row++) {
      const line: Scalar[] = []
      for (let column = 0; column < observation.values[row].length; column++) {
        const original = observation.values[row][column]
        const value = draft[row][column]
        if (cleared[row][column]) line.push(null)
        else if (typeof original === 'number') {
          if (
            !/^-?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:[eE][+-]?\d+)?$/.test(value.trim()) ||
            !Number.isFinite(Number(value.replace(',', '.')))
          ) {
            setIssue('Renseignez un nombre fini, ou cochez Effacer pour vider la cellule.')
            return
          }
          line.push(Number(value.replace(',', '.')))
        } else if (typeof original === 'boolean') line.push(value === 'true')
        else line.push(original === null && value === '' ? null : value)
      }
      values.push(line)
    }
    invalidate()
    const controller = new AbortController()
    active.current = controller
    setPhase('prepare')
    onLockChange(true)
    let keepParentLocked = false
    try {
      const next =
        source === 'procedure' && selectedResult
          ? await prepareOfficeProcedureEdit({
              backup,
              excel,
              result: selectedResult,
              exclusiveLocalCopyConfirmed: exclusive,
              signal: controller.signal,
            })
          : await prepareOfficeEdit({
              backup,
              excel,
              values,
              exclusiveLocalCopyConfirmed: exclusive,
              signal: controller.signal,
            })
      if (active.current !== controller) return
      if (controller.signal.aborted) {
        frozen.current = true
        setTerminal(true)
        keepParentLocked = true
        setIssue('Attente de préparation annulée. Excel peut encore terminer une lecture.')
        return
      }
      prepared.current = next
      setPreview(next)
    } catch (error) {
      if (active.current === controller) {
        const code = error instanceof OfficeEditError ? error.code : undefined
        if (error instanceof OfficeProcedureError) {
          setIssue(
            error.code === 'selection_mismatch'
              ? 'Le résultat ne correspond pas aux dimensions de votre sélection. Choisissez une plage de mêmes dimensions et créez une nouvelle sauvegarde liée.'
              : 'Ce résultat n’est pas disponible pour cette sauvegarde. Vérifiez votre session, vos droits et la version de la procédure avant de charger à nouveau la liste.'
          )
        } else if (controller.signal.aborted) {
          frozen.current = true
          setTerminal(true)
          keepParentLocked = true
          setIssue('Attente de préparation annulée. Excel peut encore terminer une lecture.')
        } else if (code === 'formula_protected')
          setIssue(
            'Une proposition toucherait une formule existante. Conservez sa valeur actuelle, puis préparez un nouvel aperçu.'
          )
        else if (code === 'invalid_values')
          setIssue(
            'Les valeurs proposées ne sont pas acceptées. Vérifiez leur type et leur taille.'
          )
        else if (code === 'unsafe_range' || code === 'exclusive_copy_required')
          setIssue(
            'Vérifiez la plage et votre attestation de copie locale exclusive avant de préparer un autre aperçu.'
          )
        else {
          frozen.current = true
          setTerminal(true)
          keepParentLocked = code !== 'backup_binding_missing' && code !== 'preimage_changed'
          setIssue(
            keepParentLocked
              ? 'Préparation non confirmée. Vérifiez l’état du classeur dans Excel et ne relancez pas ce parcours.'
              : 'La sélection ne correspond plus à cette sauvegarde. Créez une nouvelle sauvegarde avant de préparer des modifications.'
          )
        }
      }
    } finally {
      if (active.current === controller) {
        active.current = null
        setPhase(null)
        onLockChange(keepParentLocked)
      }
    }
  }
  async function apply() {
    if (
      disabled ||
      frozen.current ||
      active.current ||
      !preview ||
      prepared.current !== preview ||
      !agreed.current
    )
      return
    const controller = new AbortController()
    active.current = controller
    frozen.current = true
    setTerminal(true)
    setPhase('apply')
    setIssue(null)
    onLockChange(true)
    try {
      const approval = approveOfficeEdit(preview)
      const observed = await applyOfficeEdit(preview, approval, controller.signal)
      if (active.current === controller) {
        setResult(observed)
        if (observed.status === 'verified' && !controller.signal.aborted)
          setSaveCandidate({ backup, result: observed })
      }
    } catch {
      if (active.current === controller)
        setIssue(
          'Résultat incertain. Vérifiez le classeur dans Excel avant toute autre modification. Ne relancez pas cette application.'
        )
    } finally {
      if (active.current === controller) {
        active.current = null
        setPhase(null)
      }
    }
  }
  async function save() {
    if (
      !enabled ||
      phase !== null ||
      active.current ||
      saveAttempted.current ||
      !saveCandidate ||
      saveCandidate.backup !== backup ||
      saveCandidate.result !== result
    )
      return
    const controller = new AbortController()
    active.current = controller
    saveAttempted.current = true
    setPhase('save')
    onLockChange(true)
    try {
      const saved = await saveVerifiedOfficeEdit(saveCandidate.result, controller.signal)
      if (active.current === controller && !controller.signal.aborted) setSaveResult(saved)
      else if (active.current === controller)
        setSaveResult({ status: 'uncertain', code: 'cancelled' })
    } catch {
      if (active.current === controller) setSaveResult({ status: 'uncertain', code: 'sdk_failure' })
    } finally {
      if (active.current === controller) {
        active.current = null
        setPhase(null)
      }
    }
  }
  return (
    <section
      className='space-y-4 rounded-lg border border-[var(--border-1)] bg-[var(--surface-1)] p-4 text-small'
      aria-labelledby='office-edit-title'
    >
      <h2 id='office-edit-title' className='font-semibold'>
        Préparer des modifications
      </h2>
      <label className='block space-y-2'>
        <span>Source des valeurs proposées</span>
        <select
          aria-label='Source des valeurs proposées'
          value={source}
          disabled={disabled}
          className={`min-h-9 w-full rounded border border-[var(--border-1)] bg-[var(--bg)] px-2 ${focus}`}
          onChange={(event) => {
            if (disabled || frozen.current) return
            invalidate()
            setSource(event.target.value === 'procedure' ? 'procedure' : 'manual')
          }}
        >
          <option value='manual'>Valeurs saisies</option>
          <option value='procedure'>Résultat d’une procédure</option>
        </select>
      </label>
      {source === 'procedure' ? (
        <div className='space-y-3'>
          <p>
            Choisissez le résultat d’une exécution déjà terminée. Ce choix ne recalcule pas la
            procédure sur votre classeur ouvert.
          </p>
          <Button
            type='button'
            disabled={disabled}
            className={`min-h-9 w-full ${focus}`}
            onClick={() => void loadResults()}
          >
            Charger les résultats de procédures
          </Button>
          {catalog && (
            <>
              {catalog.items.length === 0 ? (
                <p>
                  Aucun résultat de procédure autorisé dans cet espace. Exécutez d’abord une
                  procédure déployée depuis Memlia.
                </p>
              ) : (
                <label className='block space-y-2'>
                  <span>Résultat de procédure</span>
                  <select
                    aria-label='Résultat de procédure'
                    disabled={disabled}
                    value={selectedResult ? String(catalog.items.indexOf(selectedResult)) : ''}
                    className={`min-h-9 w-full rounded border border-[var(--border-1)] bg-[var(--bg)] px-2 ${focus}`}
                    onChange={(event) => {
                      if (disabled || frozen.current) return
                      invalidate()
                      setSelectedResult(
                        event.target.value === ''
                          ? null
                          : (catalog.items[Number(event.target.value)] ?? null)
                      )
                    }}
                  >
                    <option value=''>Choisir un résultat</option>
                    {catalog.items.map((item, index) => (
                      <option key={index} value={String(index)}>
                        {item.procedureName} · {item.workflowName} ·{' '}
                        {new Date(item.completedAt).toLocaleString('fr-FR')} · {item.fileName}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {catalog.truncated && <p>Seuls les 50 premiers résultats autorisés sont proposés.</p>}
            </>
          )}
        </div>
      ) : (
        <p>
          {observation.range.address} · Les champs conservent les nombres, les textes et les valeurs
          oui/non. Cochez Effacer pour vider une cellule. Les formules existantes sont contrôlées
          avant toute application.
        </p>
      )}
      {!enabled && (
        <p role='alert'>
          Votre compte ou vos droits actuels sur cet espace ne permettent pas cette modification.
        </p>
      )}
      {source === 'manual' && (
        <div className='max-h-96 space-y-3 overflow-y-auto'>
          {observation.values.map((row, r) =>
            row.map((value, c) => {
              const label = `Ligne ${observation.range.startRow + r}, colonne ${observation.range.startColumn + c}`
              return (
                <div key={`${r}:${c}`} className='space-y-1 border-[var(--border-1)] border-b pb-3'>
                  <p>
                    {label} · Actuel : {cellText(value)}
                  </p>
                  <p className='break-all font-mono text-caption'>
                    Formule ou constante observée : {cellText(observation.formulas[r][c])}
                  </p>
                  <p className='text-[var(--text-muted)] text-caption'>
                    {typeof value === 'number'
                      ? 'Nombre (virgule ou point).'
                      : typeof value === 'boolean'
                        ? 'Valeur oui/non.'
                        : 'Texte ; les signes = et + restent des données.'}
                  </p>
                  <label className='flex items-center gap-2'>
                    <span>Valeur proposée</span>
                    <input
                      aria-label={`${label} — valeur proposée`}
                      type={typeof value === 'boolean' ? 'checkbox' : 'text'}
                      inputMode={typeof value === 'number' ? 'decimal' : undefined}
                      {...(typeof value === 'boolean'
                        ? { checked: draft[r][c] === 'true' }
                        : { value: draft[r][c] })}
                      disabled={disabled || cleared[r][c]}
                      onChange={(event) =>
                        edit(
                          r,
                          c,
                          typeof value === 'boolean'
                            ? String(event.target.checked)
                            : event.target.value
                        )
                      }
                      className={
                        typeof value === 'boolean'
                          ? `size-5 ${focus}`
                          : `min-h-9 min-w-0 flex-1 rounded border border-[var(--border-1)] bg-[var(--bg)] px-2 ${focus}`
                      }
                    />
                  </label>
                  <label className='flex min-h-9 items-center gap-2'>
                    <input
                      type='checkbox'
                      aria-label={`Effacer ligne ${observation.range.startRow + r}, colonne ${observation.range.startColumn + c}`}
                      checked={cleared[r][c]}
                      disabled={disabled}
                      className={`size-5 ${focus}`}
                      onChange={(event) => {
                        if (disabled || frozen.current) return
                        invalidate()
                        const checked = event.target.checked
                        setCleared((previous) =>
                          previous.map((line, index) =>
                            index === r
                              ? line.map((cell, position) => (position === c ? checked : cell))
                              : line
                          )
                        )
                      }}
                    />
                    Effacer
                  </label>
                </div>
              )
            })
          )}
        </div>
      )}
      <label className='flex items-start gap-2'>
        <input
          type='checkbox'
          aria-label='Je travaille sur une copie locale exclusive, sans coédition'
          checked={exclusive}
          disabled={disabled}
          className={`mt-1 size-5 shrink-0 ${focus}`}
          onChange={(event) => {
            if (disabled || frozen.current) return
            invalidate()
            setExclusive(event.target.checked)
          }}
        />
        <span>Je travaille sur une copie locale exclusive, sans coédition.</span>
      </label>
      <Button
        type='button'
        disabled={disabled || !exclusive || (source === 'procedure' && !selectedResult)}
        className={`min-h-9 w-full ${focus}`}
        onClick={() => void prepare()}
      >
        Préparer les modifications
      </Button>
      {pending && (
        <>
          <p role='status'>
            {phase === 'catalog'
              ? 'Chargement des résultats…'
              : phase === 'prepare'
                ? 'Préparation de l’aperçu…'
                : phase === 'save'
                  ? 'Enregistrement du classeur en cours…'
                  : 'Application et vérification en cours…'}
          </p>
          <Button
            type='button'
            className={`min-h-9 w-full ${focus}`}
            onClick={() => active.current?.abort()}
          >
            Annuler l’attente
          </Button>
        </>
      )}
      {issue && <p role='alert'>{issue}</p>}
      {preview && (
        <section className='space-y-3' aria-label='Aperçu des modifications'>
          <h3 className='font-semibold'>Aperçu avant application</h3>
          <p>Cet aperçu est lié à la sélection de votre sauvegarde vérifiée ci-dessus.</p>
          {preview.changes.length === 0 && (
            <p>
              Aucune différence à appliquer. Modifiez les valeurs proposées pour préparer un autre
              aperçu.
            </p>
          )}
          <table className='w-full text-caption'>
            <caption className='text-left'>Modifications proposées</caption>
            <thead>
              <tr>
                <th scope='col'>Cellule</th>
                <th scope='col'>Avant</th>
                <th scope='col'>Après</th>
              </tr>
            </thead>
            <tbody>
              {preview.changes.map((change) => (
                <tr key={`${change.row}:${change.column}`}>
                  <th scope='row'>
                    Ligne {preview.observation.range.startRow + change.row}, colonne{' '}
                    {preview.observation.range.startColumn + change.column}
                  </th>
                  <td className='break-all'>{cellText(change.before)}</td>
                  <td className='break-all'>{cellText(change.after)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <label className='flex items-start gap-2'>
            <input
              type='checkbox'
              aria-label='J’approuve les modifications de cet aperçu'
              checked={agreement}
              disabled={disabled || preview.changes.length === 0}
              className={`mt-1 size-5 shrink-0 ${focus}`}
              onChange={(event) => {
                if (disabled || frozen.current || prepared.current !== preview) return
                agreed.current = event.target.checked
                setAgreement(event.target.checked)
              }}
            />
            <span>J’approuve les modifications de cet aperçu.</span>
          </label>
          <Button
            type='button'
            disabled={
              disabled || !agreement || prepared.current !== preview || preview.changes.length === 0
            }
            className={`min-h-9 w-full ${focus}`}
            onClick={() => void apply()}
          >
            Appliquer et vérifier
          </Button>
        </section>
      )}
      {result && (
        <section aria-live='polite' className='space-y-2'>
          {result.status === 'verified' ? (
            <>
              <h3 className='font-semibold'>Modification relue et vérifiée</h3>
              <p>
                {result.changedCells} cellule(s) modifiée(s). Recalcul de la plage effectué, puis
                résultat relu dans Excel.
              </p>
              {saveResult?.status === 'acknowledged' ? (
                <p>
                  Excel a confirmé l’enregistrement du classeur. La persistance physique du fichier
                  n’est pas vérifiée par ce volet.
                </p>
              ) : (
                <p>
                  L’enregistrement sur disque n’est pas confirmé. Enregistrez votre classeur dans
                  Excel.
                </p>
              )}
              {saveResult && saveResult.status !== 'acknowledged' && (
                <p role='alert'>
                  {saveResult.status === 'uncertain'
                    ? 'Enregistrement incertain. Vérifiez le fichier dans Excel et ne relancez pas cette commande.'
                    : saveResult.code === 'save_location_required'
                      ? 'Choisissez d’abord un emplacement en enregistrant ce classeur dans Excel. Memlia ne choisit aucun emplacement par défaut.'
                      : 'Enregistrement refusé. Vérifiez le classeur dans Excel ; aucune relance automatique ne sera effectuée.'}
                </p>
              )}
              {enabled && saveCandidate?.backup === backup && saveCandidate.result === result && (
                <Button
                  type='button'
                  disabled={pending || saveAttempted.current}
                  className={`min-h-9 w-full ${focus}`}
                  onClick={() => void save()}
                >
                  Enregistrer le classeur
                </Button>
              )}
              <SelectionTable observation={result.observation} />
            </>
          ) : (
            <p role='alert'>
              {result.status === 'uncertain'
                ? 'Résultat incertain. Vérifiez le classeur dans Excel et ne relancez pas cette application.'
                : 'Application refusée. Aucune relance automatique ne sera effectuée.'}
            </p>
          )}
        </section>
      )}
    </section>
  )
}

export function SelectionTable({ observation }: { observation: OfficeRangeObservation }) {
  const { range } = observation
  const rows = range.endRow - range.startRow + 1
  const columns = range.endColumn - range.startColumn + 1
  const visibleRows = Math.min(rows, 20)
  const visibleColumns = Math.min(columns, 8)
  const cellText = (value: string | number | boolean | null) => {
    const text = value === null ? '∅' : String(value)
    return text.length > 200 ? `${text.slice(0, 200)}…` : text
  }
  const address = range.address.length > 512 ? `${range.address.slice(0, 512)}…` : range.address
  return (
    <div className='space-y-3'>
      <p className='break-all'>
        {observation.worksheet.name} · {address}
      </p>
      <p>
        {rows.toLocaleString('fr-FR')} lignes · {columns.toLocaleString('fr-FR')} colonnes.
      </p>
      <p className='text-[var(--text-muted)] text-caption'>
        Aperçu limité aux 20 premières lignes, aux 8 premières colonnes et à 200 caractères par
        valeur ou formule.{' '}
        {rows > visibleRows || columns > visibleColumns
          ? 'Sélection tronquée à l’affichage.'
          : 'Toutes les cellules de la sélection sont affichées.'}{' '}
        Le symbole … indique un texte tronqué ; ∅ indique une valeur vide.
      </p>
      <div
        className={`overflow-x-auto rounded border border-[var(--border-1)] ${focus}`}
        role='region'
        // biome-ignore lint/a11y/noNoninteractiveTabindex: The bounded table must remain keyboard-scrollable in the Office WebView.
        tabIndex={0}
        aria-label='Aperçu défilant de la sélection'
      >
        <table className='w-full border-collapse text-caption'>
          <caption className='p-2 text-left'>
            Valeurs et formules ou constantes observées dans Excel
          </caption>
          <thead>
            <tr>
              <th scope='col' className='p-2 text-left'>
                Ligne
              </th>
              {Array.from({ length: visibleColumns }, (_, column) => (
                <th scope='col' key={column} className='p-2 text-left'>
                  Colonne {range.startColumn + column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {observation.values.slice(0, visibleRows).map((row, index) => (
              <tr key={index}>
                <th scope='row' className='border-[var(--border-1)] border-t p-2 text-left'>
                  {range.startRow + index}
                </th>
                {row.slice(0, visibleColumns).map((value, column) => (
                  <td
                    key={column}
                    className='max-w-60 break-words border-[var(--border-1)] border-t p-2 align-top'
                  >
                    <p>Valeur : {cellText(value)}</p>
                    <p className='font-mono'>
                      Formule ou constante : {cellText(observation.formulas[index][column])}
                    </p>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
