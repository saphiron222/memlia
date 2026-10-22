// Copyright (c) 2026 Memlia. All rights reserved.
'use client'

import { useEffect, useRef, useState } from 'react'
import { Button, Label } from '@sim/emcn'
import Script from 'next/script'
import { useSession } from '@/lib/auth/client'
import {
  backupCurrentOfficeWorkbook,
  type OfficeBackupClientResult,
  type OfficeBackupPhase,
} from '@/lib/memlia/excel/office/backup-client'
import { OFFICE_JS_URL } from '@/lib/memlia/excel/office/constants'
import { OfficePreflightError, preflightOffice } from '@/lib/memlia/excel/office/preflight'
import {
  type OfficeRangeObservation,
  OfficeReadError,
  readSelectedOfficeRange,
} from '@/lib/memlia/excel/office/read-scope'
import { useWorkspacesWithMetadata } from '@/hooks/queries/workspace'
import { OfficeEditPanel, SelectionTable } from './edit-panel'

const LOGIN = '/login?callbackUrl=%2Fexcel-addin'
const focus =
  'focus-visible:ring-2 focus-visible:ring-[var(--text-primary)] focus-visible:ring-offset-2'
const phases: Record<OfficeBackupPhase, string> = {
  preflight: 'Vérification de la connexion à Excel…',
  copy: 'Lecture de la copie du classeur…',
  storing: 'Envoi et vérification de la sauvegarde privée…',
}

// Office.js assigns null to history methods. Install before mounting Script, not in its
// parent's effect after Script has already mounted. Preserve callable Next router updates.
// https://learn.microsoft.com/en-us/office/dev/add-ins/develop/referencing-the-javascript-api-for-office-library-from-its-cdn#workaround-for-nextjs
const protectedHistory = new WeakMap<History, PropertyDescriptorMap>()
function protectOfficeHistory(): boolean {
  try {
    const history = window.history
    const names = ['pushState', 'replaceState'] as const
    const previous = protectedHistory.get(history)
    if (
      previous &&
      names.every((name) => {
        const current = Object.getOwnPropertyDescriptor(history, name)
        return current?.get === previous[name].get && current?.set === previous[name].set
      })
    )
      return true
    const descriptors: PropertyDescriptorMap = {}
    for (const name of names) {
      let method = history[name]
      const descriptor = Object.getOwnPropertyDescriptor(history, name)
      if (
        typeof method !== 'function' ||
        descriptor?.configurable === false ||
        (!descriptor && !Object.isExtensible(history))
      )
        return false
      descriptors[name] = {
        configurable: true,
        enumerable: descriptor?.enumerable ?? false,
        get: () => method,
        set: (value: unknown) => {
          if (typeof value === 'function') method = value as History[typeof name]
        },
      }
    }
    Object.defineProperties(history, descriptors)
    protectedHistory.set(history, descriptors)
    return true
  } catch {
    return false
  }
}

function officeSDK(): unknown {
  return (globalThis as typeof globalThis & { Office?: unknown }).Office
}
function excelSDK(): unknown {
  return (globalThis as typeof globalThis & { Excel?: unknown }).Excel
}

function Refusal({ result }: { result: Extract<OfficeBackupClientResult, { status: 'refused' }> }) {
  const message = {
    invalid_context: 'Sélectionnez un espace disponible et vérifiez votre connexion Memlia.',
    copy_refused:
      'La copie a été refusée. Ouvrez ce volet dans Excel de bureau sur Windows, avec un classeur accessible en modification.',
    copy_too_large:
      'La copie dépasse la limite de 7,5 Mo de ce transfert. Aucune sauvegarde n’a été envoyée.',
    cancelled: 'Opération annulée avant l’envoi de la sauvegarde.',
    storage_refused:
      'Le serveur a refusé la sauvegarde avant sa création. Vérifiez vos droits et l’espace disponible.',
    authentication_required:
      'Votre session Memlia doit être reconnectée avant une nouvelle sauvegarde.',
  }[result.code]
  return <p>{message}</p>
}

export function ExcelTaskpane() {
  const session = useSession()
  return (
    <main className='mx-auto flex min-h-screen w-full max-w-lg flex-col gap-5 bg-[var(--bg)] p-5 text-[var(--text-primary)]'>
      <header className='space-y-2'>
        <p className='font-semibold text-[var(--text-muted)] text-small'>Memlia · Excel</p>
        <h1 className='font-semibold text-lg'>Sauvegarder le classeur</h1>
        <p className='text-[var(--text-secondary)] text-small'>
          Conservez une copie privée sur le serveur de votre cabinet, liée à votre compte Memlia.
        </p>
      </header>
      {session.isPending ? (
        <p role='status'>Vérification de votre session Memlia…</p>
      ) : session.error || !session.data?.user ? (
        <section className='space-y-3' aria-label='Connexion Memlia'>
          <p>Connectez-vous à Memlia dans ce volet pour accéder à vos espaces.</p>
          <a className={`inline-block min-h-9 rounded px-2 py-2 underline ${focus}`} href={LOGIN}>
            Se connecter à Memlia
          </a>
        </section>
      ) : (
        <SignedInTaskpane key={session.data.user.id} userId={session.data.user.id} />
      )}
      <p className='text-[var(--text-muted)] text-caption'>
        Les modifications de la sélection ne sont lancées qu’après votre accord sur un aperçu.
      </p>
    </main>
  )
}

function SignedInTaskpane({ userId }: { userId: string }) {
  const workspaces = useWorkspacesWithMetadata()
  const [selected, setSelected] = useState('')
  const [consent, setConsent] = useState(false)
  const [sdk, setSDK] = useState<'loading' | 'loaded' | 'failed'>('loading')
  const [historyReady, setHistoryReady] = useState(false)
  const [phase, setPhase] = useState<OfficeBackupPhase | null>(null)
  const [result, setResult] = useState<OfficeBackupClientResult | null>(null)
  const [editRequested, setEditRequested] = useState(false)
  const [editLocked, setEditLocked] = useState(false)
  const editLock = useRef(false)
  const active = useRef<AbortController | null>(null)
  useEffect(() => {
    if (protectOfficeHistory()) {
      setHistoryReady(true)
      if (officeSDK()) setSDK('loaded')
    } else {
      setSDK('failed')
    }
    return () => {
      active.current?.abort()
      active.current = null
    }
  }, [])
  const available = (workspaces.data?.workspaces ?? []).filter(
    (item) => item.permissions === 'admin' || item.permissions === 'write'
  )
  const workspace = available.find((item) => item.id === selected)
  const pending = phase !== null
  const locked = pending || result?.status === 'unconfirmed' || result?.status === 'stored'
  const authenticationRequired =
    result?.status === 'refused' && result.code === 'authentication_required'
  const canStart =
    sdk === 'loaded' &&
    consent &&
    Boolean(workspace) &&
    !workspaces.isPending &&
    !workspaces.isError &&
    !locked &&
    !authenticationRequired

  async function save() {
    // React's disabled render is not a synchronous guard against two quick clicks.
    if (!canStart || active.current || !workspace) return
    const controller = new AbortController()
    active.current = controller
    setResult(null)
    try {
      const observed = await backupCurrentOfficeWorkbook({
        office: officeSDK(),
        workspaceId: workspace.id,
        expectedUserId: userId,
        signal: controller.signal,
        onPhase: (next) => {
          if (active.current === controller) setPhase(next)
        },
        ...(editRequested ? { editSelection: { excel: excelSDK() } } : {}),
      })
      if (active.current === controller) setResult(observed)
    } catch {
      if (active.current === controller)
        setResult({ status: 'unconfirmed', code: 'response_unknown', fileId: null })
    } finally {
      if (active.current === controller) {
        active.current = null
        setPhase(null)
      }
    }
  }

  return (
    <>
      {historyReady && (
        <Script
          src={OFFICE_JS_URL}
          strategy='afterInteractive'
          onReady={() => setSDK('loaded')}
          onError={() => setSDK('failed')}
        />
      )}
      <section
        className='space-y-4 rounded-lg border border-[var(--border-1)] bg-[var(--surface-1)] p-4'
        aria-label='Copie privée du classeur'
      >
        <div className='space-y-2'>
          <Label htmlFor='office-backup-workspace'>Espace Memlia</Label>
          <select
            id='office-backup-workspace'
            value={selected}
            disabled={locked || workspaces.isPending || workspaces.isError}
            onChange={(event) => {
              setSelected(event.target.value)
              setConsent(false)
              setResult(null)
            }}
            className={`min-h-9 w-full rounded border border-[var(--border-1)] bg-[var(--bg)] px-2 py-2 text-small ${focus}`}
          >
            <option value=''>Choisir un espace</option>
            {available.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          {workspaces.isPending && (
            <p role='status' className='text-small'>
              Chargement de vos espaces…
            </p>
          )}
          {workspaces.isError && (
            <p role='alert' className='text-small'>
              Les espaces ne sont pas disponibles. Vérifiez votre connexion Memlia.
            </p>
          )}
          {!workspaces.isPending && !workspaces.isError && available.length === 0 && (
            <p className='text-small'>
              Aucun espace autorisant cette sauvegarde. Contactez votre administrateur.
            </p>
          )}
        </div>
        <label className='flex items-start gap-2 text-small' htmlFor='office-backup-consent'>
          <input
            id='office-backup-consent'
            type='checkbox'
            checked={consent}
            disabled={locked || !workspace}
            onChange={(event) => setConsent(event.target.checked)}
            className={`mt-1 size-5 shrink-0 ${focus}`}
          />
          <span>
            J’autorise l’envoi d’une copie complète du classeur ouvert vers le serveur du cabinet,
            dans l’espace choisi. Cette sauvegarde reste privée à mon compte.
          </span>
        </label>
        <label className='flex items-start gap-2 text-small'>
          <input
            type='checkbox'
            aria-label='Préparer une modification de ma sélection'
            checked={editRequested}
            disabled={locked || !workspace}
            className={`mt-1 size-5 shrink-0 ${focus}`}
            onChange={(event) => setEditRequested(event.target.checked)}
          />
          <span>
            Préparer une modification de ma sélection : choisissez d’abord une seule plage dans
            Excel, puis créez cette sauvegarde. L’édition dans ce volet est limitée à 100 cellules.
          </span>
        </label>
        <p className='text-[var(--text-muted)] text-caption'>
          Excel de bureau sur Windows · copie de 7,5 Mo maximum.
        </p>
        {sdk === 'loading' && (
          <p role='status' className='text-small'>
            Chargement du composant Microsoft Office…
          </p>
        )}
        {sdk === 'failed' && (
          <p role='alert' className='text-small'>
            Le composant Microsoft Office n’a pas pu être chargé. Vérifiez que son accès est
            autorisé sur ce poste.
          </p>
        )}
        <Button
          type='button'
          variant='primary'
          className={`min-h-9 w-full ${focus}`}
          disabled={!canStart}
          onClick={() => void save()}
        >
          {pending ? 'Sauvegarde en cours…' : 'Créer ma sauvegarde privée'}
        </Button>
        {pending && (
          <Button
            type='button'
            className={`min-h-9 w-full ${focus}`}
            onClick={() => active.current?.abort()}
          >
            Interrompre l’attente
          </Button>
        )}
      </section>
      <section
        aria-label='Résultat de la sauvegarde'
        aria-live='polite'
        aria-atomic='true'
        className='space-y-3 text-small'
      >
        {phase && <p role='status'>{phases[phase]}</p>}
        {result?.status === 'stored' && (
          <>
            <h2 className='font-semibold'>Sauvegarde privée vérifiée</h2>
            <p>Le serveur a relu la copie et confirmé son contenu au moment du contrôle.</p>
            <dl className='space-y-1 break-all'>
              <dt>Référence</dt>
              <dd>{result.receipt.fileId}</dd>
              <dt>Taille</dt>
              <dd>{result.receipt.byteLength.toLocaleString('fr-FR')} octets</dd>
              <dt>Version de la sauvegarde</dt>
              <dd>{result.receipt.contentVersion}</dd>
              <dt>Empreinte de la copie</dt>
              <dd className='font-mono text-caption'>{result.receipt.sha256}</dd>
            </dl>
            <Button
              type='button'
              className={`min-h-9 ${focus}`}
              disabled={editLocked}
              onClick={() => {
                if (editLock.current) return
                setResult(null)
                setConsent(false)
                setEditRequested(false)
              }}
            >
              Préparer une autre sauvegarde
            </Button>
          </>
        )}
        {result?.status === 'refused' && (
          <div role='alert'>
            <h2 className='font-semibold'>Sauvegarde refusée</h2>
            <Refusal result={result} />
          </div>
        )}
        {authenticationRequired && (
          <a className={`inline-block min-h-9 rounded py-2 underline ${focus}`} href={LOGIN}>
            Reconnecter Memlia
          </a>
        )}
        {result?.status === 'unconfirmed' && (
          <div role='alert' className='space-y-2'>
            <h2 className='font-semibold'>Résultat non confirmé</h2>
            <p>
              {result.code === 'copy_unconfirmed'
                ? 'La fermeture de la copie Excel n’a pas pu être confirmée.'
                : 'Une copie a pu être conservée sur le serveur, mais la sauvegarde n’est pas confirmée.'}{' '}
              Ne relancez pas cette opération. Contactez votre administrateur pour vérifier son
              état.
            </p>
            {result.fileId && (
              <p className='break-all'>Référence à communiquer : {result.fileId}</p>
            )}
          </div>
        )}
      </section>
      {result?.status === 'stored' &&
        (editRequested ? (
          <OfficeEditPanel
            key={result.receipt.fileId}
            backup={result}
            excel={excelSDK()}
            enabled={
              Boolean(workspace) &&
              !workspaces.isPending &&
              !workspaces.isError &&
              result.receipt.workspaceId === workspace?.id &&
              result.receipt.ownerUserId === userId
            }
            onLockChange={(value) => {
              editLock.current = value
              setEditLocked(value)
            }}
          />
        ) : (
          <OfficeSelectionPreview key={result.receipt.fileId} />
        ))}
    </>
  )
}

type SelectionResult =
  | { status: 'idle' | 'reading' | 'refused' | 'cancelled' | 'unknown' }
  | { status: 'read'; observation: OfficeRangeObservation }

function OfficeSelectionPreview() {
  const [result, setResult] = useState<SelectionResult>({ status: 'idle' })
  const active = useRef<AbortController | null>(null)
  const canRead =
    result.status === 'idle' || result.status === 'read' || result.status === 'refused'
  useEffect(
    () => () => {
      active.current?.abort()
      active.current = null
    },
    []
  )

  async function examine() {
    if (!canRead || active.current) return
    const controller = new AbortController()
    active.current = controller
    setResult({ status: 'reading' })
    try {
      const scope = await preflightOffice(officeSDK(), controller.signal)
      if (controller.signal.aborted) {
        if (active.current === controller) setResult({ status: 'cancelled' })
        return
      }
      const excel = (globalThis as typeof globalThis & { Excel?: unknown }).Excel
      const observation = await readSelectedOfficeRange(scope, excel, controller.signal)
      if (active.current === controller)
        setResult(
          controller.signal.aborted ? { status: 'cancelled' } : { status: 'read', observation }
        )
    } catch (error) {
      if (active.current !== controller) return
      const code =
        error instanceof OfficeReadError || error instanceof OfficePreflightError
          ? error.code
          : undefined
      const status =
        controller.signal.aborted ||
        code === 'office_read_cancelled' ||
        code === 'office_preflight_cancelled'
          ? 'cancelled'
          : code &&
              [
                'office_sdk_unavailable',
                'office_sdk_invalid',
                'office_host_unsupported',
                'office_platform_unqualified',
                'office_document_mode_unsupported',
                'office_requirement_missing',
                'office_read_scope_invalid',
                'office_range_invalid',
                'office_range_value_unsupported',
              ].includes(code)
            ? 'refused'
            : 'unknown'
      setResult({ status })
    } finally {
      if (active.current === controller) active.current = null
    }
  }

  return (
    <section
      aria-labelledby='office-selection-title'
      className='space-y-3 rounded-lg border border-[var(--border-1)] bg-[var(--surface-1)] p-4 text-small'
    >
      <h2 id='office-selection-title' className='font-semibold'>
        Examiner la sélection ouverte
      </h2>
      <p>
        Sélectionnez une seule plage dans Excel (10 000 cellules maximum) pour afficher ses valeurs
        et formules ici, sans modifier le classeur.
      </p>
      <p className='text-[var(--text-muted)] text-caption'>
        Cet aperçu est une nouvelle observation locale : le classeur peut avoir changé depuis la
        sauvegarde.
      </p>
      <Button
        type='button'
        className={`min-h-9 w-full ${focus}`}
        disabled={!canRead}
        onClick={() => void examine()}
      >
        {result.status === 'reading' ? 'Lecture de la sélection…' : 'Examiner ma sélection'}
      </Button>
      {result.status === 'reading' && (
        <Button
          type='button'
          className={`min-h-9 w-full ${focus}`}
          onClick={() => active.current?.abort()}
        >
          Annuler la lecture
        </Button>
      )}
      <div aria-live='polite' aria-atomic='true'>
        {result.status === 'reading' && <p role='status'>Lecture locale de la sélection…</p>}
        {result.status === 'read' && <p>Valeurs et formules lues.</p>}
        {result.status === 'refused' && (
          <p role='alert'>
            Lecture refusée. Vérifiez que ce volet est ouvert dans Excel Windows et sélectionnez une
            seule plage de 10 000 cellules maximum avant de réessayer.
          </p>
        )}
        {result.status === 'cancelled' && (
          <p role='status'>Attente annulée. Excel peut encore terminer sa lecture.</p>
        )}
        {result.status === 'unknown' && (
          <p role='alert'>
            Résultat de lecture inconnu. Vérifiez l’état d’Excel avant toute nouvelle tentative.
          </p>
        )}
      </div>
      {result.status === 'read' && <SelectionTable observation={result.observation} />}
    </section>
  )
}
