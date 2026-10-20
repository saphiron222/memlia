// Copyright (c) 2026 Memlia. All rights reserved.
'use client'
import { useId, useLayoutEffect, useRef, useState } from 'react'
import { Button } from '@sim/emcn'
import { generateId } from '@sim/utils/id'
import { requestJson } from '@/lib/api/client/request'
import {
  type ExcelTestPreparationBody,
  type ExcelTestPreparationReceipt,
  observeExcelTestPreparationContract,
  prepareExcelTestContract,
} from '@/lib/api/contracts/excel-test-preparations'
import { useWorkspacePermissionsContext } from '@/app/workspace/[workspaceId]/providers/workspace-permissions-provider'
import type { Catalog } from './catalog'
import {
  clearPreparationRecovery,
  persistPreparationRecovery,
  readPreparationRecovery,
} from './preparation-recovery'

type Props = { workspaceId: string; userId: string; catalog: Catalog }
const focus =
  'min-h-9 rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-accent)]'
export function ExcelTestPreparation(props: Props) {
  return <PreparationSelection key={JSON.stringify([props.workspaceId, props.userId])} {...props} />
}
function PreparationSelection({ workspaceId, userId, catalog }: Props) {
  const { userPermissions } = useWorkspacePermissionsContext()
  const canEdit = userPermissions.canEdit && !userPermissions.isLoading && !userPermissions.error
  const [workflowId, setWorkflowId] = useState('')
  const [locked, setLocked] = useState(false)
  const label = useId()
  const available =
    catalog.status === 'ready' && catalog.items.some((item) => item.id === workflowId)
  return (
    <section aria-labelledby={label} className='space-y-4'>
      <h2 id={label} className='font-medium text-lg'>
        Préparer une version de test
      </h2>
      <p className='text-[var(--text-secondary)]'>
        Choisissez un workflow enregistré contenant une procédure Excel. Cette étape prépare une
        copie inactive, sans lancer de transformation.
      </p>
      <p className='text-[var(--text-secondary)]'>
        Après rechargement dans cet onglet, choisissez le même workflow pour vérifier manuellement
        une préparation non confirmée. Fermer l’onglet peut perdre cette reprise.
      </p>
      <label className='flex flex-col gap-2'>
        Workflow à préparer
        <select
          className={`${focus} border border-[var(--border)] bg-[var(--bg)] px-3 text-[var(--text-primary)]`}
          value={workflowId}
          disabled={!canEdit || locked || catalog.status !== 'ready'}
          onChange={(event) => setWorkflowId(event.target.value)}
        >
          <option value=''>Choisir un workflow</option>
          {catalog.items.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      {!canEdit && (
        <p role='status'>
          Un droit de modification est nécessaire pour préparer une version de test.
        </p>
      )}
      {catalog.status !== 'ready' && (
        <p role='status'>La liste des workflows n’est pas disponible.</p>
      )}
      {available && (
        <PreparationActions
          key={workflowId}
          workspaceId={workspaceId}
          userId={userId}
          workflowId={workflowId}
          canEdit={Boolean(canEdit)}
          onLock={setLocked}
        />
      )}
    </section>
  )
}
function PreparationActions({
  workspaceId,
  userId,
  workflowId,
  canEdit,
  onLock,
}: {
  workspaceId: string
  userId: string
  workflowId: string
  canEdit: boolean
  onLock: (locked: boolean) => void
}) {
  const [attempt, setAttempt] = useState<ExcelTestPreparationBody | null>(null)
  const [receipt, setReceipt] = useState<ExcelTestPreparationReceipt | null>(null)
  const [phase, setPhase] = useState<
    | 'idle'
    | 'observing'
    | 'ready'
    | 'preparing'
    | 'uncertain'
    | 'prepared'
    | 'refused'
    | 'storage-refused'
    | 'recovery-blocked'
  >('idle')
  const recoveryEntry = useRef<string | null>(null)
  const active = useRef<AbortController | null>(null)
  const mounted = useRef(false)
  const live = useRef(false)
  const busy = useRef(false)
  useLayoutEffect(() => {
    live.current = canEdit
    return () => {
      live.current = false
      active.current?.abort()
    }
  }, [canEdit])
  useLayoutEffect(() => {
    mounted.current = true
    const recovery = readPreparationRecovery({ userId, workspaceId, workflowId })
    if (recovery.status === 'pending') {
      recoveryEntry.current = recovery.entry
      setAttempt(recovery.body)
      setPhase('uncertain')
      onLock(true)
    } else if (recovery.status === 'blocked') {
      setPhase('recovery-blocked')
    }
    return () => {
      mounted.current = false
      active.current?.abort()
      onLock(false)
    }
  }, [onLock, userId, workspaceId, workflowId])
  const pending = phase === 'observing' || phase === 'preparing'
  async function observe() {
    if (!canEdit || !live.current || busy.current || phase === 'uncertain') return
    busy.current = true
    onLock(true)
    setPhase('observing')
    setAttempt(null)
    const controller = new AbortController()
    active.current = controller
    try {
      const result = await requestJson(observeExcelTestPreparationContract, {
        params: { id: workflowId },
        query: { workspaceId },
        signal: controller.signal,
      })
      if (!live.current || controller.signal.aborted) return
      if (result.workflowId !== workflowId || result.workspaceId !== workspaceId)
        throw new Error('scope')
      setAttempt({
        expectedRevision: result.expectedRevision,
        expectedStateDigest: result.expectedStateDigest,
        operationId: generateId(),
        ...(receipt ? { previousTestVersionId: receipt.deploymentVersionId } : {}),
      })
      setPhase('ready')
    } catch {
      if (live.current && !controller.signal.aborted) setPhase('refused')
    } finally {
      busy.current = false
      if (active.current === controller) active.current = null
      if (mounted.current) {
        onLock(false)
        if (controller.signal.aborted) setPhase('idle')
      }
    }
  }
  async function prepare() {
    if (
      !canEdit ||
      !live.current ||
      busy.current ||
      !attempt ||
      (phase !== 'ready' && phase !== 'uncertain' && phase !== 'storage-refused')
    )
      return
    const saved = persistPreparationRecovery(
      { userId, workspaceId, workflowId },
      attempt,
      recoveryEntry.current
    )
    if (saved.status !== 'saved') {
      setPhase('storage-refused')
      return
    }
    recoveryEntry.current = saved.entry
    busy.current = true
    onLock(true)
    setPhase('preparing')
    const controller = new AbortController()
    active.current = controller
    try {
      const result = await requestJson(prepareExcelTestContract, {
        params: { id: workflowId },
        query: { workspaceId },
        body: saved.body,
        signal: controller.signal,
      })
      if (!live.current || controller.signal.aborted) return
      if (result.workflowId !== workflowId) throw new Error('scope')
      if (!clearPreparationRecovery({ userId, workspaceId, workflowId }, saved.entry)) {
        setPhase('recovery-blocked')
        return
      }
      recoveryEntry.current = null
      setReceipt(result)
      setAttempt(null)
      setPhase('prepared')
      onLock(false)
    } catch {
      if (live.current) setPhase('uncertain')
    } finally {
      busy.current = false
      if (active.current === controller) active.current = null
      // Cancellation cannot establish rollback. Keep the same operation and CAS for an
      // explicit confirmation attempt; never fetch a newer digest to disguise uncertainty.
      if (mounted.current && controller.signal.aborted) setPhase('uncertain')
    }
  }
  return (
    <div className='space-y-3' aria-busy={pending}>
      {phase === 'ready' && (
        <p role='status'>
          La version enregistrée est prête à être préparée. Les modifications ultérieures
          nécessiteront une nouvelle vérification.
        </p>
      )}
      {phase === 'prepared' && (
        <p role='status'>
          Version {receipt?.version} préparée pour test. Aucun fichier exécuté ; aucune
          automatisation activée.
        </p>
      )}
      {phase === 'refused' && (
        <p role='alert'>
          La version n’a pas pu être vérifiée. Vérifiez vos droits et la procédure enregistrée, puis
          réessayez.
        </p>
      )}
      {phase === 'uncertain' && (
        <p role='alert'>
          Résultat non confirmé. Vérifiez cette même préparation avant d’en commencer une autre.
        </p>
      )}
      {phase === 'storage-refused' && (
        <p role='alert'>
          Le stockage de cet onglet ne permet pas de conserver cette préparation. Aucun nouvel envoi
          n’a été effectué. Rétablissez le stockage puis réessayez ; si une préparation y est déjà
          conservée, rechargez la page pour la vérifier.
        </p>
      )}
      {phase === 'recovery-blocked' && (
        <p role='alert'>
          Impossible de vérifier ici la préparation conservée dans cet onglet : son contenu est
          indisponible, invalide ou a changé. Aucun nouvel envoi ne sera effectué. Consultez les
          versions enregistrées avant de poursuivre. Aucune autre entrée ne sera effacée.
        </p>
      )}
      {(phase === 'idle' ||
        phase === 'observing' ||
        phase === 'prepared' ||
        phase === 'refused') && (
        <Button
          type='button'
          className={focus}
          disabled={!canEdit || pending}
          onClick={() => void observe()}
        >
          {phase === 'observing' ? 'Vérification…' : 'Vérifier la version enregistrée'}
        </Button>
      )}
      {(phase === 'ready' || phase === 'preparing' || phase === 'storage-refused') && (
        <Button
          type='button'
          variant='primary'
          className={focus}
          disabled={!canEdit || pending}
          onClick={() => void prepare()}
        >
          {phase === 'preparing' ? 'Préparation…' : 'Préparer une version de test'}
        </Button>
      )}
      {phase === 'uncertain' && (
        <Button type='button' className={focus} disabled={!canEdit} onClick={() => void prepare()}>
          Vérifier cette préparation
        </Button>
      )}
    </div>
  )
}
