// Copyright (c) 2026 Memlia. All rights reserved.
'use client'
import { useEffect, useId, useRef, useState } from 'react'
import { Button, Input, pageHeadingClassName } from '@sim/emcn'
import { isApiClientError } from '@/lib/api/client/errors'
import { requestJson } from '@/lib/api/client/request'
import type { ContractJsonResponse } from '@/lib/api/contracts'
import {
  captureInputSchema,
  createCaptureContract,
  listCapturesContract,
} from '@/lib/api/contracts/desktop-agent-captures'
import {
  createEnrollmentContract,
  revokeEnrollmentContract,
} from '@/lib/api/contracts/desktop-agent-enrollment'
import {
  createPersonalTestContract,
  listProceduresContract,
  personalTestInputSchema,
  saveProcedureContract,
  saveProcedureInputSchema,
} from '@/lib/api/contracts/desktop-agent-procedures'
import { useSession } from '@/lib/auth/client'
import { useWorkspacePermissionsContext } from '@/app/workspace/[workspaceId]/providers/workspace-permissions-provider'

type Props = { workspaceId: string; userId: string }
type Created = ContractJsonResponse<typeof createEnrollmentContract>
type State =
  | { kind: 'idle' }
  | { kind: 'creating' }
  | { kind: 'code'; receipt: Created }
  | { kind: 'expired'; enrollmentId: string }
  | { kind: 'create_unknown'; until: number }
  | { kind: 'revoking'; enrollmentId: string }
  | { kind: 'revoked' }
  | { kind: 'revoke_unknown'; enrollmentId: string; certificate: boolean }
const TTL = 300_000
const focus =
  'min-h-8 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-accent)]'

/** Visibility is advisory; the existing native session/workspace API owns authority. */
export function SoftwareAutomations(props: Props) {
  const { userPermissions } = useWorkspacePermissionsContext()
  const session = useSession()
  return (
    <div className='h-full overflow-y-auto bg-[var(--bg)] text-[var(--text-primary)]'>
      <div className='mx-auto flex w-full max-w-4xl flex-col gap-8 px-6 py-10 text-sm'>
        <header className='space-y-3'>
          <h1 className={pageHeadingClassName}>Automatiser un logiciel</h1>
          <p className='text-[var(--text-secondary)]'>
            Associez votre poste Windows à votre compte pour y préparer vos automatisations. Une
            association ne donne pas l’autorisation d’enregistrer votre écran ou d’exécuter une
            procédure.
          </p>
        </header>
        {session.isPending ? (
          <p role='status'>Vérification du compte…</p>
        ) : session.error || session.data?.user?.id !== props.userId ? (
          <p role='alert'>Reconnectez-vous avant d’associer un poste.</p>
        ) : userPermissions.isLoading ? (
          <p role='status'>Vérification des permissions…</p>
        ) : userPermissions.error || !userPermissions.canEdit ? (
          <p role='alert'>
            Un accès en écriture à cet espace est nécessaire pour associer un poste.
          </p>
        ) : (
          <div key={`${props.workspaceId}:${props.userId}`} className='space-y-8'>
            <Enrollment {...props} />
            <Capture {...props} />
            <Procedures {...props} />
          </div>
        )}
      </div>
    </div>
  )
}

function Enrollment({ workspaceId }: Props) {
  const [state, setState] = useState<State>({ kind: 'idle' })
  const [visible, setVisible] = useState(false)
  const fieldId = useId()
  const alive = useRef(false)
  const pending = useRef<AbortController | null>(null)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      pending.current?.abort()
    }
  }, [])
  useEffect(() => {
    if (state.kind !== 'code' && state.kind !== 'create_unknown') return
    const until = state.kind === 'code' ? state.receipt.expiresAt : state.until
    const expire = () => {
      setVisible(false)
      setState(
        state.kind === 'code'
          ? { kind: 'expired', enrollmentId: state.receipt.enrollmentId }
          : { kind: 'idle' }
      )
    }
    const timer = setTimeout(expire, Math.max(0, Math.min(TTL, until - Date.now())))
    const check = () => {
      if (Date.now() >= until) expire()
    }
    document.addEventListener('visibilitychange', check)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', check)
    }
  }, [state])

  async function create() {
    if (pending.current || !['idle', 'revoked'].includes(state.kind)) return
    const controller = new AbortController()
    pending.current = controller
    const until = Date.now() + TTL
    setVisible(false)
    setState({ kind: 'creating' })
    const timer = setTimeout(() => controller.abort(), 30_000)
    try {
      const receipt = await requestJson(createEnrollmentContract, {
        params: { id: workspaceId },
        body: {},
        query: {},
        signal: controller.signal,
      })
      if (!alive.current) return
      controller.signal.throwIfAborted()
      // This clock only controls display. Expiry and single use are enforced by the server.
      setState(
        receipt.expiresAt <= Date.now() || receipt.expiresAt > Date.now() + TTL
          ? { kind: 'expired', enrollmentId: receipt.enrollmentId }
          : { kind: 'code', receipt }
      )
    } catch {
      if (alive.current) setState({ kind: 'create_unknown', until })
    } finally {
      clearTimeout(timer)
      if (pending.current === controller) pending.current = null
    }
  }
  async function revoke(enrollmentId: string) {
    if (pending.current) return
    const controller = new AbortController()
    pending.current = controller
    setVisible(false)
    setState({ kind: 'revoking', enrollmentId })
    const timer = setTimeout(() => controller.abort(), 30_000)
    try {
      const result = await requestJson(revokeEnrollmentContract, {
        params: { id: workspaceId, enrollmentId },
        body: {},
        query: {},
        signal: controller.signal,
      })
      if (!alive.current) return
      controller.signal.throwIfAborted()
      setState(
        result.enrollmentId !== enrollmentId || result.certificateRevocation === 'unknown'
          ? { kind: 'revoke_unknown', enrollmentId, certificate: true }
          : { kind: 'revoked' }
      )
    } catch {
      if (alive.current) setState({ kind: 'revoke_unknown', enrollmentId, certificate: false })
    } finally {
      clearTimeout(timer)
      if (pending.current === controller) pending.current = null
    }
  }
  const enrollmentId =
    state.kind === 'code'
      ? state.receipt.enrollmentId
      : state.kind === 'expired' || state.kind === 'revoke_unknown'
        ? state.enrollmentId
        : null
  const canCreate = state.kind === 'idle' || state.kind === 'revoked'
  return (
    <section aria-labelledby='associate-windows' className='ph-no-capture space-y-4'>
      <h2 id='associate-windows' className='font-medium text-lg'>
        Associer votre poste Windows
      </h2>
      <p className='text-[var(--text-secondary)]'>
        Préparez un code à usage unique pour Memlia Agent sur votre poste. Gardez-le privé. Il
        expire au bout de cinq minutes. Votre consentement local restera nécessaire pour chaque
        enregistrement.
      </p>
      <Button
        type='button'
        className={focus}
        disabled={!canCreate}
        onClick={() => {
          void create()
        }}
      >
        Créer un code d’association
      </Button>
      <div aria-live='polite' aria-atomic='true'>
        {state.kind === 'creating' && <p role='status'>Création du code…</p>}
        {state.kind === 'expired' && (
          <p role='status'>
            Le code a expiré. Révoquez cette association avant d’en préparer une autre.
          </p>
        )}
        {state.kind === 'create_unknown' && (
          <p role='alert'>
            La création n’est pas confirmée. Attendez cinq minutes avant de demander un autre code.
          </p>
        )}
        {state.kind === 'revoking' && <p role='status'>Révocation en cours…</p>}
        {state.kind === 'revoked' && <p role='status'>Association révoquée.</p>}
        {state.kind === 'revoke_unknown' && (
          <p role='alert'>
            {state.certificate
              ? 'La révocation du certificat reste à vérifier.'
              : 'La révocation n’est pas confirmée.'}{' '}
            N’utilisez pas ce poste pour une automatisation avant vérification par votre
            administrateur.
          </p>
        )}
      </div>
      {state.kind === 'code' && (
        <div className='space-y-3'>
          <label htmlFor={`${fieldId}-identity`} className='block space-y-1'>
            <span>Identifiant d’association</span>
            <Input
              readOnly
              value={state.receipt.enrollmentId}
              aria-label='Identifiant d’association'
              id={`${fieldId}-identity`}
            />
          </label>
          <label htmlFor={`${fieldId}-code`} className='block space-y-1'>
            <span>Code d’association</span>
            <Input
              readOnly
              autoComplete='off'
              type={visible ? 'text' : 'password'}
              value={state.receipt.code}
              aria-label='Code d’association'
              id={`${fieldId}-code`}
            />
          </label>
          <Button type='button' className={focus} onClick={() => setVisible(!visible)}>
            {visible ? 'Masquer le code' : 'Afficher le code'}
          </Button>
          <p role='status'>Ce code ne confirme pas encore que le poste est associé.</p>
        </div>
      )}
      {enrollmentId && (
        <Button
          type='button'
          className={focus}
          onClick={() => {
            void revoke(enrollmentId)
          }}
        >
          Révoquer cette association
        </Button>
      )}
    </section>
  )
}

type CaptureInput = ReturnType<typeof captureInputSchema.parse>
type CaptureList = ContractJsonResponse<typeof listCapturesContract>
type CaptureResult = ContractJsonResponse<typeof createCaptureContract>
function Capture({ workspaceId, userId }: Props) {
  const storageKey = `memlia.capture.request:${JSON.stringify([workspaceId, userId])}`
  const [catalog, setCatalog] = useState<CaptureList | null>(null)
  const [agent, setAgent] = useState('')
  const [seconds, setSeconds] = useState('60')
  const [request, setRequest] = useState<CaptureInput | null>(null)
  const [receipt, setReceipt] = useState<CaptureResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [clock, setClock] = useState(Date.now())
  const [storageReady, setStorageReady] = useState(false)
  const alive = useRef(false)
  const pending = useRef<AbortController | null>(null)
  const field = useId()
  useEffect(() => {
    alive.current = true
    try {
      const saved = sessionStorage.getItem(storageKey)
      if (saved) {
        if (saved.length > 512) throw Error('refused')
        setRequest(captureInputSchema.parse(JSON.parse(saved)))
      }
      setStorageReady(true)
    } catch {
      setError(
        'La demande conservée ne peut pas être vérifiée. Aucun nouvel enregistrement ne sera demandé.'
      )
    }
    return () => {
      alive.current = false
      pending.current?.abort()
    }
  }, [storageKey])
  useEffect(() => {
    if (!catalog) return
    const expiry = Math.min(
      catalog.observedAt + 30000,
      ...catalog.devices
        .filter((d) => d.observation === 'recent' && d.observedAt !== null)
        .map((d) => d.observedAt! + 30000)
    )
    const timer = setTimeout(() => setClock(Date.now()), Math.max(0, expiry - Date.now()))
    return () => clearTimeout(timer)
  }, [catalog])
  const device = catalog?.devices.find((d) => d.agentId === agent)
  const recent =
    device?.observation === 'recent' &&
    device.observedAt !== null &&
    device.observedAt > clock - 30000
  const canCreate =
    storageReady &&
    !request &&
    !busy &&
    recent &&
    device?.busy === 'idle' &&
    Number.isInteger(Number(seconds)) &&
    Number(seconds) >= 1 &&
    Number(seconds) <= 1800
  async function run(kind: 'list' | 'create') {
    if (pending.current || !storageReady) return
    let input = request
    if (kind === 'create' && !input) {
      if (!canCreate || !device?.observedAt || Date.now() - device.observedAt >= 30000) return
      try {
        input = captureInputSchema.parse({
          agentId: agent,
          requestId: crypto.randomUUID(),
          maxDurationSeconds: Number(seconds),
          maxBytes: 32 * 1024 * 1024,
        })
        // Persist BEFORE HTTP. Remount/lost response never changes the idempotency key.
        sessionStorage.setItem(storageKey, JSON.stringify(input))
        setRequest(input)
      } catch {
        setStorageReady(false)
        setError('Impossible de conserver la demande. Aucun enregistrement demandé.')
        return
      }
    }
    const controller = new AbortController()
    pending.current = controller
    setBusy(true)
    setError(null)
    const timer = setTimeout(() => controller.abort(), 30000)
    try {
      if (kind === 'list') {
        const result = await requestJson(listCapturesContract, {
          params: { id: workspaceId },
          query: input ? { requestId: input.requestId } : {},
          signal: controller.signal,
        })
        controller.signal.throwIfAborted()
        if (!alive.current) return
        setCatalog(result)
        setClock(Date.now())
        setAgent((current) =>
          result.devices.some((d) => d.agentId === current)
            ? current
            : (result.devices[0]?.agentId ?? '')
        )
        const found = input && result.commands.find((c) => c.requestId === input.requestId)
        if (found) setReceipt(found)
      } else {
        const result = await requestJson(createCaptureContract, {
          params: { id: workspaceId },
          query: {},
          body: input!,
          signal: controller.signal,
        })
        controller.signal.throwIfAborted()
        if (!alive.current) return
        if (result.requestId !== input!.requestId || result.agentId !== input!.agentId)
          throw Error('receipt_mismatch')
        setReceipt(result)
      }
    } catch {
      if (alive.current)
        setError(
          kind === 'create'
            ? 'La demande reste à vérifier. Ne démarrez pas un autre enregistrement.'
            : 'Impossible de vérifier les postes et captures pour le moment.'
        )
    } finally {
      clearTimeout(timer)
      if (pending.current === controller) pending.current = null
      if (alive.current) setBusy(false)
    }
  }
  const labels = {
    queued: 'Consentement local requis',
    claimed: 'Consentement local requis',
    consented: 'Consentement local reçu',
    running: 'Enregistrement en cours',
    hold: 'Intervention requise — résultat incertain',
    terminal: 'Enregistrement terminé',
    expired: 'Demande expirée',
  }
  const describeResult = (c: CaptureResult) =>
    c.status === 'terminal'
      ? c.outcome === 'succeeded_verified'
        ? 'Résultat reçu'
        : c.outcome === 'failed'
          ? 'Enregistrement en échec'
          : c.outcome === 'cancelled_before_start'
            ? 'Annulé avant démarrage'
            : 'Enregistrement arrêté'
      : labels[c.status]
  return (
    <section className='space-y-4' aria-labelledby={`${field}-title`}>
      <h2 id={`${field}-title`} className='font-medium text-lg'>
        Enregistrer une procédure
      </h2>
      <p>
        Choisissez un poste récemment observé. Son utilisateur devra accepter localement chaque
        enregistrement et pourra l’arrêter. Un poste observé n’est pas une confirmation que son
        bureau est disponible.
      </p>
      <Button className={focus} disabled={busy || !storageReady} onClick={() => void run('list')}>
        Actualiser mes postes et captures
      </Button>
      {catalog && (
        <>
          <label htmlFor={`${field}-agent`}>Mon poste</label>
          <select
            id={`${field}-agent`}
            value={agent}
            disabled={busy || !!request}
            onChange={(e) => setAgent(e.target.value)}
            className={focus}
          >
            {catalog.devices.map((d) => (
              <option key={d.agentId} value={d.agentId}>
                {d.agentId} —{' '}
                {d.observation === 'recent'
                  ? 'observé récemment'
                  : d.observation === 'offline'
                    ? 'hors ligne'
                    : 'indisponible'}
                {d.busy === 'hold'
                  ? ' — Intervention requise'
                  : d.busy === 'busy'
                    ? ' — occupé'
                    : ''}
              </option>
            ))}
          </select>
          {catalog.devices.length === 0 && (
            <p>Aucun poste observé dans cet espace pour ce compte.</p>
          )}
          <label htmlFor={`${field}-duration`}>Durée maximale en secondes</label>
          <Input
            id={`${field}-duration`}
            type='number'
            min={1}
            max={1800}
            value={seconds}
            disabled={busy || !!request}
            onChange={(e) => setSeconds(e.target.value)}
          />
        </>
      )}
      <Button
        className={focus}
        disabled={request ? busy || !storageReady : !canCreate}
        onClick={() => void run('create')}
      >
        {request ? 'Vérifier la même demande' : 'Demander cet enregistrement'}
      </Button>
      {busy && <p role='status'>Vérification en cours…</p>}
      {error && <p role='alert'>{error}</p>}
      {receipt && (
        <p role='status'>
          {describeResult(receipt)}
          {receipt.exportStatus === 'to_test'
            ? ' — Export reçu, à tester. Aucune exécution n’est autorisée.'
            : ''}
        </p>
      )}
      {request && receipt && ['terminal', 'expired'].includes(receipt.status) && (
        <Button
          className={focus}
          disabled={busy}
          onClick={() => {
            try {
              sessionStorage.removeItem(storageKey)
              setRequest(null)
              setReceipt(null)
              setCatalog(null)
              setError(null)
            } catch {
              setStorageReady(false)
            }
          }}
        >
          Préparer une nouvelle demande
        </Button>
      )}
      {catalog && (
        <ul aria-label='Mes dernières captures'>
          {catalog.commands.map((c) => (
            <li key={c.commandId}>
              {c.commandId} : {describeResult(c)}
              {c.exportStatus === 'to_test' ? ' — Export à tester' : ''}
            </li>
          ))}
        </ul>
      )}
      {catalog?.truncated && <p>Seuls les postes et résultats les plus récents sont affichés.</p>}
    </section>
  )
}

type ProcedureVersion = ContractJsonResponse<typeof saveProcedureContract>
type ProcedureSave = typeof saveProcedureInputSchema._output
function Procedures({ workspaceId, userId }: Props) {
  const field = useId()
  const storageKey = `memlia.procedure.request:${JSON.stringify([workspaceId, userId])}`
  const [catalog, setCatalog] = useState<ContractJsonResponse<
    typeof listProceduresContract
  > | null>(null)
  const [exports, setExports] = useState<string[]>([])
  const [selected, setSelected] = useState('')
  const [commandId, setCommand] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [request, setRequest] = useState<ProcedureSave | null>(null)
  const [saved, setSaved] = useState<ProcedureVersion | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [storageReady, setStorageReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const alive = useRef(false)
  const pending = useRef<AbortController | null>(null)
  useEffect(() => {
    alive.current = true
    try {
      const value = sessionStorage.getItem(storageKey)
      if (value) {
        if (value.length > 16384) throw Error('bounded')
        const old = saveProcedureInputSchema.parse(JSON.parse(value))
        setRequest(old)
        setCommand(old.commandId)
        setName(old.name)
        setDescription(old.description)
        setSelected(old.procedureId ?? '')
      }
      setStorageReady(true)
    } catch {
      setError('La version conservée reste à vérifier. Aucun nouvel enregistrement ne sera envoyé.')
    }
    return () => {
      alive.current = false
      pending.current?.abort()
    }
  }, [storageKey])
  const current = catalog?.procedures.find((p) => p.procedureId === selected)
  async function run(action: 'list' | 'history' | 'save') {
    if (pending.current || !storageReady) return
    let input = request
    if (action === 'save' && !input) {
      if (!commandId || !name.trim() || (selected && !current)) return
      try {
        input = saveProcedureInputSchema.parse({
          requestId: crypto.randomUUID(),
          procedureId: selected || null,
          expectedRevision: current?.revision ?? 0,
          commandId,
          name,
          description,
        })
        sessionStorage.setItem(storageKey, JSON.stringify(input))
        setRequest(input)
      } catch {
        setError(
          'Vérifiez le nom et la description. La demande doit pouvoir être conservée avant envoi.'
        )
        return
      }
    }
    const controller = new AbortController()
    pending.current = controller
    setBusy(true)
    setError(null)
    const timer = setTimeout(() => controller.abort(), 30000)
    try {
      if (action === 'save') {
        const result = await requestJson(saveProcedureContract, {
          params: { id: workspaceId },
          query: {},
          body: input!,
          signal: controller.signal,
        })
        controller.signal.throwIfAborted()
        if (!alive.current) return
        if (
          result.requestId !== input!.requestId ||
          result.commandId !== input!.commandId ||
          result.revision !== input!.expectedRevision + 1 ||
          result.name !== input!.name ||
          result.description !== input!.description ||
          (input!.procedureId !== null && result.procedureId !== input!.procedureId)
        )
          throw Error('receipt_mismatch')
        // Remove the durable retry only AFTER the exact receipt was checked.
        sessionStorage.removeItem(storageKey)
        setRequest(null)
        setSaved(result)
        setSelected(result.procedureId)
        setCatalog((old) => ({
          procedures: [
            result,
            ...(old?.procedures ?? []).filter((p) => p.procedureId !== result.procedureId),
          ],
          versions: [],
          truncated: old?.truncated ?? false,
        }))
      } else if (action === 'history') {
        if (!selected) return
        const result = await requestJson(listProceduresContract, {
          params: { id: workspaceId },
          query: { procedureId: selected },
          signal: controller.signal,
        })
        controller.signal.throwIfAborted()
        if (!alive.current) return
        setCatalog((old) => ({
          procedures: old?.procedures ?? result.procedures,
          versions: result.versions,
          truncated: result.truncated,
        }))
      } else {
        const sources = await requestJson(listCapturesContract, {
          params: { id: workspaceId },
          query: {},
          signal: controller.signal,
        })
        const result = await requestJson(listProceduresContract, {
          params: { id: workspaceId },
          query: {},
          signal: controller.signal,
        })
        controller.signal.throwIfAborted()
        if (!alive.current) return
        setCatalog(result)
        const ids = sources.commands
          .filter((c) => c.exportStatus === 'to_test')
          .map((c) => c.commandId)
        setExports(ids)
        if (!input) {
          setSelected('')
          setCommand(ids[0] ?? '')
          setName('')
          setDescription('')
          setSaved(null)
        }
      }
    } catch (failure) {
      if (alive.current) {
        if (
          action === 'save' &&
          isApiClientError(failure) &&
          failure.status === 409 &&
          failure.body &&
          typeof failure.body === 'object' &&
          'error' in failure.body &&
          failure.body.error === 'procedure_revision_conflict'
        ) {
          try {
            sessionStorage.removeItem(storageKey)
            setRequest(null)
            setCatalog(null)
            setExports([])
            setSelected('')
            setCommand('')
            setSaved(null)
            setError(
              'La fiche a changé. Actualisez les procédures avant de préparer une nouvelle version.'
            )
            return
          } catch {
            setStorageReady(false)
          }
        }
        if (action !== 'save') {
          setCatalog(null)
          setExports([])
        }
        setError(
          action === 'save'
            ? 'Résultat à vérifier. Réutilisez le même enregistrement ; ne créez pas une nouvelle demande.'
            : 'Impossible de lire ces procédures. Les permissions et associations doivent être valides.'
        )
      }
    } finally {
      clearTimeout(timer)
      if (pending.current === controller) pending.current = null
      if (alive.current) setBusy(false)
    }
  }
  const choose = (id: string) => {
    setSelected(id)
    setSaved(null)
    const v = catalog?.procedures.find((p) => p.procedureId === id)
    setName(v?.name ?? '')
    setDescription(v?.description ?? '')
    setCommand(v?.commandId ?? exports[0] ?? '')
    setCatalog((old) => (old ? { ...old, versions: [] } : old))
  }
  return (
    <section className='space-y-4' aria-label='Mes procédures personnelles'>
      <h2 className='font-medium text-lg'>Mes procédures personnelles</h2>
      <p>
        Nommez vos exports reçus et conservez leurs versions. Chaque version reste à tester ; elle
        n’autorise aucune exécution.
      </p>
      <Button className={focus} disabled={busy || !storageReady} onClick={() => void run('list')}>
        Actualiser mes procédures
      </Button>
      {catalog && (
        <>
          <label>
            Procédure personnelle
            <select
              aria-label='Procédure personnelle'
              className={focus}
              disabled={busy || !!request}
              value={selected}
              onChange={(e) => choose(e.target.value)}
            >
              <option value=''>Nouvelle fiche personnelle</option>
              {catalog.procedures.map((p) => (
                <option key={p.procedureId} value={p.procedureId}>
                  {p.name} — version {p.revision}
                </option>
              ))}
            </select>
          </label>
          <label>
            Capture source
            <select
              aria-label='Capture source de la procédure'
              className={focus}
              disabled={busy || !!request}
              value={commandId}
              onChange={(e) => setCommand(e.target.value)}
            >
              {[...new Set([...exports, ...(current ? [current.commandId] : [])])].map((id) => (
                <option key={id} value={id}>
                  {id} — Export à tester
                </option>
              ))}
            </select>
          </label>
          {exports.length === 0 && !current && <p>Aucun export à tester disponible.</p>}
        </>
      )}
      <label htmlFor={`${field}-name`}>
        Nom
        <Input
          id={`${field}-name`}
          aria-label='Nom de la procédure'
          maxLength={120}
          value={name}
          disabled={busy || !!request}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label htmlFor={`${field}-description`}>
        Description
        <Input
          id={`${field}-description`}
          aria-label='Description de la procédure'
          maxLength={2000}
          value={description}
          disabled={busy || !!request}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      <Button
        className={focus}
        disabled={
          busy ||
          !storageReady ||
          (!request && (!commandId || !name.trim() || (!!selected && !current)))
        }
        onClick={() => void run('save')}
      >
        {request ? 'Vérifier le même enregistrement' : 'Enregistrer cette version'}
      </Button>
      <Button
        className={focus}
        disabled={busy || !selected || !!request}
        onClick={() => void run('history')}
      >
        Voir les versions
      </Button>
      {busy && <p role='status'>Vérification en cours…</p>}
      {error && <p role='alert'>{error}</p>}
      {saved && <p role='status'>Version {saved.revision} enregistrée — À tester</p>}
      <ol aria-label='Historique des versions'>
        {catalog?.versions.map((v) => (
          <li key={v.revision}>
            Version {v.revision} — {v.name} — {v.description} — À tester — capture {v.commandId}
          </li>
        ))}
      </ol>
      {catalog?.truncated && (
        <p>Seules les 50 fiches ou versions les plus récentes sont affichées.</p>
      )}
      <p>
        Le partage reste indisponible. Une capture reçue et un test observé ne constituent pas une
        qualification de ses effets métier.
      </p>
      <Button disabled>Partager</Button>
      <ProcedureTest
        workspaceId={workspaceId}
        userId={userId}
        versions={
          current
            ? [
                current,
                ...(catalog?.versions ?? []).filter(
                  (v) => v.procedureId === current.procedureId && v.revision !== current.revision
                ),
              ]
            : []
        }
      />
    </section>
  )
}

type PersonalTest = typeof personalTestInputSchema._output
function ProcedureTest({
  workspaceId,
  userId,
  versions,
}: Props & { versions: ProcedureVersion[] }) {
  const field = useId()
  const storageKey = `memlia.procedure.test.request:${JSON.stringify([workspaceId, userId])}`
  const [request, setRequest] = useState<PersonalTest | null>(null)
  const [receipt, setReceipt] = useState<CaptureResult | null>(null)
  const [catalog, setCatalog] = useState<ContractJsonResponse<typeof listCapturesContract> | null>(
    null
  )
  const [version, setVersion] = useState('')
  const [agent, setAgent] = useState('')
  const [seconds, setSeconds] = useState('60')
  const [clock, setClock] = useState(Date.now())
  const [storageReady, setStorageReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(false)
  const pending = useRef<AbortController | null>(null)
  useEffect(() => {
    alive.current = true
    try {
      const saved = sessionStorage.getItem(storageKey)
      if (saved) {
        if (saved.length > 16384) throw Error('bounded')
        setRequest(personalTestInputSchema.parse(JSON.parse(saved)))
      }
      setStorageReady(true)
    } catch {
      setError('La demande de test conservée reste à vérifier. Aucun nouveau test demandé.')
    }
    return () => {
      alive.current = false
      pending.current?.abort()
    }
  }, [storageKey])
  useEffect(() => {
    if (!catalog) return
    const expiry = Math.min(
      catalog.observedAt + 30000,
      ...catalog.devices
        .filter((d) => d.observation === 'recent' && d.observedAt !== null)
        .map((d) => d.observedAt! + 30000)
    )
    const timer = setTimeout(() => setClock(Date.now()), Math.max(0, expiry - Date.now()))
    return () => clearTimeout(timer)
  }, [catalog])
  const chosen = versions.find((v) => `${v.procedureId}:${v.revision}` === version)
  const device = catalog?.devices.find((d) => d.agentId === agent)
  const fresh = (now: number) =>
    !!catalog &&
    catalog.observedAt <= now &&
    catalog.observedAt > now - 30000 &&
    device?.observation === 'recent' &&
    device.observedAt !== null &&
    device.observedAt <= now &&
    device.observedAt > now - 30000 &&
    device.busy === 'idle'
  const canRequest =
    storageReady &&
    !busy &&
    !request &&
    !!chosen &&
    fresh(clock) &&
    Number.isInteger(Number(seconds)) &&
    Number(seconds) >= 1 &&
    Number(seconds) <= 1800
  async function run(action: 'read' | 'request') {
    if (pending.current || !storageReady) return
    let input = request
    if (action === 'request') {
      if (input || !canRequest || !chosen || !fresh(Date.now())) return
      try {
        input = personalTestInputSchema.parse({
          procedureId: chosen.procedureId,
          revision: chosen.revision,
          agentId: agent,
          requestId: crypto.randomUUID(),
          maxDurationSeconds: Number(seconds),
        })
        // Store the exact immutable intent BEFORE HTTP; ambiguity permits only GET reconciliation.
        const serialized = JSON.stringify(input)
        sessionStorage.setItem(storageKey, serialized)
        if (sessionStorage.getItem(storageKey) !== serialized)
          throw Error('storage_write_unconfirmed')
        setRequest(input)
      } catch {
        setStorageReady(false)
        setError('Impossible de conserver la demande. Aucun test demandé.')
        return
      }
    }
    const controller = new AbortController()
    pending.current = controller
    setBusy(true)
    setError(null)
    const timer = setTimeout(() => controller.abort(), 30000)
    try {
      if (action === 'request') {
        const result = await requestJson(createPersonalTestContract, {
          params: { id: workspaceId },
          query: {},
          body: input!,
          signal: controller.signal,
        })
        controller.signal.throwIfAborted()
        if (!alive.current) return
        if (
          result.requestId !== input!.requestId ||
          result.agentId !== input!.agentId ||
          result.exportStatus !== 'none'
        )
          throw Error('receipt_mismatch')
        setReceipt(result)
      } else {
        const result = await requestJson(listCapturesContract, {
          params: { id: workspaceId },
          query: input ? { requestId: input.requestId } : {},
          signal: controller.signal,
        })
        controller.signal.throwIfAborted()
        if (!alive.current) return
        const found = input ? result.commands.filter((c) => c.requestId === input.requestId) : []
        if (
          found.length > 1 ||
          (found[0] && (found[0].agentId !== input!.agentId || found[0].exportStatus !== 'none'))
        )
          throw Error('receipt_mismatch')
        setCatalog(result)
        setClock(Date.now())
        if (found[0]) setReceipt(found[0])
        else if (input)
          setError('Résultat du test à vérifier. La même demande est conservée sans nouvel envoi.')
      }
    } catch {
      if (alive.current) {
        setCatalog(null)
        setError(
          'Résultat du test à vérifier. Actualisez la même demande avant toute nouvelle action.'
        )
      }
    } finally {
      clearTimeout(timer)
      if (pending.current === controller) pending.current = null
      if (alive.current) setBusy(false)
    }
  }
  const uncertain =
    receipt?.status === 'hold' ||
    receipt?.outcome === 'uncertain' ||
    receipt?.outcome === 'awaiting_intervention'
  const resultLabel = !receipt
    ? null
    : uncertain
      ? 'Intervention requise — résultat incertain'
      : receipt.status === 'terminal'
        ? receipt.outcome === 'failed'
          ? 'Test en échec'
          : receipt.outcome === 'cancelled_before_start'
            ? 'Test annulé avant démarrage'
            : 'Test observé — effets non vérifiés'
        : receipt.status === 'expired'
          ? 'Demande de test expirée'
          : receipt.status === 'queued' || receipt.status === 'claimed'
            ? 'Consentement local requis'
            : receipt.status === 'running'
              ? 'Test en cours'
              : 'Consentement local reçu'
  return (
    <section className='space-y-4' aria-labelledby={`${field}-title`}>
      <h3 id={`${field}-title`} className='font-medium text-base'>
        Tester une version sur mon poste
      </h3>
      <p>
        Le test peut agir sur votre logiciel. Choisissez une version exacte et un poste personnel.
        Vous devrez accepter localement chaque test et pourrez l’arrêter sur ce poste. Un poste
        récemment observé ne garantit pas la disponibilité de son bureau.
      </p>
      <label htmlFor={`${field}-version`}>Version de la procédure à tester</label>
      <select
        id={`${field}-version`}
        aria-label='Version de la procédure à tester'
        className={focus}
        value={version}
        disabled={busy || !!request}
        onChange={(e) => setVersion(e.target.value)}
      >
        <option value=''>Choisir une version</option>
        {versions.map((v) => (
          <option key={`${v.procedureId}:${v.revision}`} value={`${v.procedureId}:${v.revision}`}>
            {v.name} — version {v.revision}
          </option>
        ))}
      </select>
      <Button className={focus} disabled={busy || !storageReady} onClick={() => void run('read')}>
        Actualiser mes postes et tests
      </Button>
      <label htmlFor={`${field}-agent`}>Poste pour le test</label>
      <select
        id={`${field}-agent`}
        aria-label='Poste pour le test'
        className={focus}
        value={agent}
        disabled={busy || !!request}
        onChange={(e) => setAgent(e.target.value)}
      >
        <option value=''>Choisir mon poste</option>
        {catalog?.devices.map((d) => (
          <option key={d.agentId} value={d.agentId}>
            {d.agentId} — {d.observation === 'recent' ? 'observé récemment' : 'indisponible'}
            {d.busy === 'hold' ? ' — Intervention requise' : d.busy === 'busy' ? ' — occupé' : ''}
          </option>
        ))}
      </select>
      <label htmlFor={`${field}-duration`}>Durée maximale du test en secondes</label>
      <Input
        id={`${field}-duration`}
        aria-label='Durée maximale du test en secondes'
        type='number'
        min={1}
        max={1800}
        value={seconds}
        disabled={busy || !!request}
        onChange={(e) => setSeconds(e.target.value)}
      />
      <Button
        className={focus}
        disabled={request ? busy || !storageReady : !canRequest}
        onClick={() => void run(request ? 'read' : 'request')}
      >
        {request ? 'Vérifier la demande de test' : 'Demander ce test'}
      </Button>
      {request && (
        <p>
          Version {request.revision} — poste {request.agentId}. Cette demande est conservée jusqu’à
          vérification.
        </p>
      )}
      {busy && <p role='status'>Vérification du test en cours…</p>}
      {error && <p role='alert'>{error}</p>}
      {resultLabel && <p role='status'>{resultLabel}. La procédure reste à tester.</p>}
      {request &&
        receipt &&
        !uncertain &&
        (receipt.status === 'expired' ||
          (receipt.status === 'terminal' &&
            receipt.outcome !== null &&
            ['succeeded_verified', 'failed', 'stopped', 'cancelled_before_start'].includes(
              receipt.outcome
            ))) && (
          <Button
            className={focus}
            disabled={busy}
            onClick={() => {
              try {
                sessionStorage.removeItem(storageKey)
                setRequest(null)
                setReceipt(null)
                setCatalog(null)
                setAgent('')
                setVersion('')
                setError(null)
              } catch {
                setStorageReady(false)
              }
            }}
          >
            Préparer un autre test
          </Button>
        )}
      <p>
        Les observations du test ne valident pas les effets métier et n’activent aucune exécution en
        production.
      </p>
    </section>
  )
}
