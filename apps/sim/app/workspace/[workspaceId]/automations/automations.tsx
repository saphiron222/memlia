// Copyright (c) 2026 Memlia. All rights reserved.
'use client'
import { useEffect, useId, useRef, useState } from 'react'
import { Button, Input, pageHeadingClassName } from '@sim/emcn'
import { requestJson } from '@/lib/api/client/request'
import type { ContractJsonResponse } from '@/lib/api/contracts'
import {
  createEnrollmentContract,
  revokeEnrollmentContract,
} from '@/lib/api/contracts/desktop-agent-enrollment'
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
          <Enrollment key={`${props.workspaceId}:${props.userId}`} {...props} />
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
