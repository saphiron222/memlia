// Copyright (c) 2026 Memlia. All rights reserved.
'use client'
import { useLayoutEffect, useRef, useState } from 'react'
import { Button } from '@sim/emcn'
import { generateId } from '@sim/utils/id'
import { requestJson, requestRaw } from '@/lib/api/client/request'
import {
  activateDeploymentVersionContract,
  listDeploymentVersionsContract,
} from '@/lib/api/contracts/deployments'
import {
  downloadExcelTestResultContract,
  type ExcelTestPreparationBody,
  type ExcelTestPreparationReceipt,
  type ExcelTestResultFile,
  readExcelTestResultsContract,
  runExcelTestContract,
} from '@/lib/api/contracts/excel-test-preparations'
import { getWorkflowExecutionContract } from '@/lib/api/contracts/workflows'
import { useSession } from '@/lib/auth/client'
import { waitWithAbort } from '@/lib/core/utils/concurrency'
import { saveBlob } from '@/lib/uploads/client/download'
import { MAX_BUFFERED_TRANSFER_BYTES } from '@/lib/uploads/shared/types'
import { useWorkspacePermissionsContext } from '@/app/workspace/[workspaceId]/providers/workspace-permissions-provider'
import { persistExecutionRecovery, readPreparedRecovery } from './preparation-recovery'

type Props = {
  workspaceId: string
  userId: string
  prepared: ExcelTestPreparationReceipt
  preparation: ExcelTestPreparationBody
}
const focus =
  'min-h-9 rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-accent)]'
const statusLabels = {
  queued: 'En file',
  pending: 'En attente',
  running: 'En cours',
  paused: 'Intervention nécessaire',
  completed: 'Terminée',
  failed: 'Échouée',
  cancelled: 'Annulée',
}

async function resultBlob(response: Response, expected: ExcelTestResultFile, signal: AbortSignal) {
  if (
    response.headers.get('content-type') !== expected.contentType ||
    Number(response.headers.get('content-length')) !== expected.size ||
    expected.size > MAX_BUFFERED_TRANSFER_BYTES ||
    !response.body
  ) {
    await response.body?.cancel().catch(() => {})
    throw new Error('result')
  }
  const reader = response.body.getReader()
  const chunks: ArrayBuffer[] = []
  let size = 0
  const abort = () => {
    void reader.cancel().catch(() => {})
  }
  signal.addEventListener('abort', abort)
  try {
    while (true) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done) break
      size += value.byteLength
      if (size > expected.size) throw new Error('result')
      chunks.push(new Uint8Array(value).buffer)
    }
    if (size !== expected.size) throw new Error('result')
    return new Blob(chunks, { type: expected.contentType })
  } finally {
    signal.removeEventListener('abort', abort)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export function ExcelExecution(props: Props) {
  const session = useSession()
  const { userPermissions } = useWorkspacePermissionsContext()
  if (
    session.isPending ||
    session.error ||
    session.data?.user?.id !== props.userId ||
    userPermissions.isLoading ||
    userPermissions.error ||
    !userPermissions.canEdit
  )
    return (
      <p role='status'>
        Un compte autorisé et un droit de modification sont nécessaires pour tester ou activer.
      </p>
    )
  return (
    <ExecutionActions
      key={JSON.stringify([props.workspaceId, props.userId, props.prepared, props.preparation])}
      {...props}
    />
  )
}

function ExecutionActions({ workspaceId, userId, prepared, preparation }: Props) {
  const [agreed, setAgreed] = useState(false)
  const [activationAttempted, setActivationAttempted] = useState(false)
  const [active, setActive] = useState(false)
  const [testAgreed, setTestAgreed] = useState(false)
  const [testRead, setTestRead] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [executionId, setExecutionId] = useState<string | null>(null)
  const [results, setResults] = useState<ExcelTestResultFile[]>([])
  const mounted = useRef(false)
  const owned = useRef<AbortController | null>(null)
  const attemptedRun = useRef<string | null>(null)
  const recoveryEntry = useRef<string | null>(null)
  const [recoveryReady, setRecoveryReady] = useState(false)
  useLayoutEffect(() => {
    mounted.current = true
    const found = readPreparedRecovery(
      { userId, workspaceId, workflowId: prepared.workflowId },
      preparation,
      prepared
    )
    if (found.status === 'prepared') {
      recoveryEntry.current = found.entry
      attemptedRun.current = found.executionId
      setExecutionId(found.executionId)
      setRecoveryReady(true)
    }
    return () => {
      mounted.current = false
      owned.current?.abort()
    }
  }, [userId, workspaceId, prepared, preparation])
  async function perform(
    kind: 'activate' | 'observe' | 'run' | 'result' | 'download',
    selected?: ExcelTestResultFile
  ) {
    if (
      owned.current ||
      !mounted.current ||
      !recoveryReady ||
      (kind === 'activate' && (!testRead || !agreed || activationAttempted)) ||
      (kind === 'run' && (!testAgreed || attemptedRun.current))
    )
      return
    const controller = new AbortController()
    owned.current = controller
    setBusy(true)
    const timer = setTimeout(() => controller.abort(), 30_000)
    const current = () => {
      if (!mounted.current) throw new Error('scope')
      controller.signal.throwIfAborted()
      const found = readPreparedRecovery(
        { userId, workspaceId, workflowId: prepared.workflowId },
        preparation,
        prepared
      )
      if (
        found.status !== 'prepared' ||
        found.entry !== recoveryEntry.current ||
        found.executionId !== attemptedRun.current
      ) {
        setRecoveryReady(false)
        setAgreed(false)
        setTestRead(false)
        setResults([])
        throw new Error('recovery')
      }
    }
    const request = <T,>(promise: Promise<T>) => waitWithAbort(promise, controller.signal)
    let runSubmitted = false
    try {
      current()
      if (kind === 'download') {
        const id = attemptedRun.current
        if (!id || !selected || !results.includes(selected)) return
        const response = await request(
          requestRaw(
            downloadExcelTestResultContract,
            {
              params: { id: prepared.workflowId },
              body: { workspaceId, preparation, prepared, executionId: id, expected: selected },
              signal: controller.signal,
            },
            { cache: 'no-store' }
          )
        )
        current()
        const blob = await request(resultBlob(response, selected, controller.signal))
        current()
        saveBlob(blob, selected.fileName)
        setMessage(
          'Téléchargement demandé au navigateur. Ouvrez le fichier et vérifiez son contenu avant de donner votre accord ; le téléchargement ne confirme pas sa lecture.'
        )
      } else if (kind === 'activate') {
        setActivationAttempted(true)
        // The prepared receipt confers no authority: this is a separate native write.
        const result = await request(
          requestJson(activateDeploymentVersionContract, {
            params: { id: prepared.workflowId, version: prepared.version },
            body: { isActive: true },
            signal: controller.signal,
          })
        )
        current()
        if (
          result.activeDeployment?.deploymentVersionId !== prepared.deploymentVersionId ||
          result.activeDeployment.version !== prepared.version
        )
          throw new Error('unconfirmed')
        setMessage(
          'Activation acquittée. Vérifiez la version active avant de lancer une exécution.'
        )
      } else if (kind === 'observe') {
        setActive(false)
        const result = await request(
          requestJson(listDeploymentVersionsContract, {
            params: { id: prepared.workflowId },
            signal: controller.signal,
          })
        )
        current()
        const version = result.versions.find((v) => v.isActive)
        if (
          !version ||
          version.id !== prepared.deploymentVersionId ||
          version.version !== prepared.version
        )
          throw new Error('version')
        setActive(true)
        setMessage(
          `Version ${version.version} active observée. L’exécution utilisera la version active au moment de sa prise en charge serveur.`
        )
      } else if (kind === 'run') {
        const id = generateId()
        const saved =
          recoveryEntry.current &&
          persistExecutionRecovery(
            { userId, workspaceId, workflowId: prepared.workflowId },
            preparation,
            prepared,
            id,
            recoveryEntry.current
          )
        if (!saved || saved.status !== 'saved') throw new Error('recovery')
        recoveryEntry.current = saved.entry
        attemptedRun.current = id
        setExecutionId(id)
        runSubmitted = true
        const result = await request(
          requestJson(runExcelTestContract, {
            params: { id: prepared.workflowId },
            body: { workspaceId, preparation, prepared, executionId: id, acknowledgeEffects: true },
            signal: controller.signal,
          })
        )
        current()
        if (
          result.executionId !== id ||
          result.workflowId !== prepared.workflowId ||
          result.deploymentVersionId !== prepared.deploymentVersionId ||
          result.snapshotDigest !== prepared.snapshotDigest
        )
          throw new Error('scope')
        setMessage(
          'Exécution mise en file sur le serveur. Ce reçu ne confirme pas son résultat ; vous pouvez fermer le navigateur.'
        )
      } else {
        setTestRead(false)
        setAgreed(false)
        setResults([])
        const id = attemptedRun.current
        if (!id) return
        const result = await request(
          requestJson(getWorkflowExecutionContract, {
            params: { id: prepared.workflowId, executionId: id },
            query: { includeOutput: 'false' },
            signal: controller.signal,
          })
        )
        current()
        if (result.executionId !== id || result.workflowId !== prepared.workflowId)
          throw new Error('scope')
        setMessage(statusLabels[result.status])
        if (result.status === 'completed') {
          const files = await request(
            requestJson(readExcelTestResultsContract, {
              params: { id: prepared.workflowId },
              body: { workspaceId, preparation, prepared, executionId: id },
              signal: controller.signal,
            })
          )
          current()
          if (
            files.workflowId !== prepared.workflowId ||
            files.executionId !== id ||
            files.deploymentVersionId !== prepared.deploymentVersionId ||
            files.snapshotDigest !== prepared.snapshotDigest
          )
            throw new Error('scope')
          setResults(files.items)
          setTestRead(files.items.length > 0 && !files.truncated)
          if (files.truncated)
            setMessage(
              'Liste des résultats tronquée à 50 fichiers. Activation indisponible tant que le test ne peut pas être relu entièrement.'
            )
          else if (files.items.length === 0)
            setMessage(
              'Exécution terminée ; aucun résultat de cette version n’a pu être relu. Activation indisponible.'
            )
        }
      }
    } catch {
      if (mounted.current && kind === 'download') {
        setTestRead(false)
        setAgreed(false)
      }
      if (mounted.current)
        setMessage(
          kind === 'run'
            ? runSubmitted
              ? 'Envoi non confirmé. Aucun renvoi automatique ; actualisez ce même résultat avant toute autre exécution.'
              : 'La reprise de ce test n’a pas pu être conservée. Aucun envoi effectué ; rechargez pour vérifier son identifiant avant de poursuivre.'
            : kind === 'activate'
              ? 'Activation non confirmée. Vérifiez la version active ; aucune nouvelle activation automatique.'
              : 'Observation indisponible. Vérifiez vos droits puis actualisez manuellement.'
        )
    } finally {
      clearTimeout(timer)
      if (owned.current === controller) owned.current = null
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <section className='space-y-3' aria-label='Test et activation Excel' aria-busy={busy}>
      <p>
        Le reçu décrit une préparation inactive ; le serveur le revérifie lors de chaque test ou
        lecture du résultat. L’activation rend cette version disponible aux API et peut activer ses
        déclencheurs et horaires. Relisez le workflow avant de continuer.
      </p>
      <a
        className={`${focus} inline-block underline`}
        href={`/workspace/${encodeURIComponent(workspaceId)}/w/${encodeURIComponent(prepared.workflowId)}`}
      >
        Relire le workflow
      </a>
      {testRead && !activationAttempted && (
        <>
          <label className='flex items-center gap-2'>
            <input
              type='checkbox'
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
              disabled={busy}
            />
            J’ai vérifié le résultat du test et j’autorise l’activation de cette version et de ses
            déclencheurs.
          </label>
          <Button
            className={focus}
            disabled={!agreed || busy}
            onClick={() => void perform('activate')}
          >
            Activer cette version
          </Button>
        </>
      )}
      {activationAttempted && (
        <Button className={focus} disabled={busy} onClick={() => void perform('observe')}>
          Vérifier la version active
        </Button>
      )}
      {!recoveryReady && (
        <p role='alert'>
          L’indice de reprise de cet onglet est indisponible ou ne correspond plus à cette
          préparation. Aucune nouvelle exécution n’a été envoyée ; rechargez pour vérifier la
          reprise.
        </p>
      )}
      {recoveryReady && !executionId && (
        <>
          <label className='flex items-center gap-2'>
            <input
              type='checkbox'
              checked={testAgreed}
              onChange={(e) => setTestAgreed(e.target.checked)}
              disabled={busy}
            />
            J’autorise le test de ce workflow et ses effets sur les fichiers et services connectés,
            sans activer ses déclencheurs.
          </label>
          <Button
            className={focus}
            disabled={!testAgreed || busy}
            onClick={() => void perform('run')}
          >
            Tester cette version inactive
          </Button>
        </>
      )}
      {recoveryReady && executionId && (
        <Button className={focus} disabled={busy} onClick={() => void perform('result')}>
          Actualiser le résultat
        </Button>
      )}
      {active && <p role='status'>Version activée observée.</p>}
      {message && <p role='status'>{message}</p>}
      {results.length > 0 && (
        <ul>
          {results.map((result) => (
            <li key={result.resultFileId}>
              <Button
                className={focus}
                disabled={busy}
                onClick={() => void perform('download', result)}
              >
                Télécharger {result.fileName}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <p className='text-[var(--text-secondary)]'>
        Un résultat terminé reste à vérifier métier. Les cellules et secrets des journaux ne sont
        pas affichés ici. Après rechargement dans cet onglet, choisissez le même workflow puis
        actualisez son résultat. Aucun test n’est renvoyé automatiquement. Fermer l’onglet peut
        perdre cette reprise ; elle n’est pas partagée entre navigateurs.
      </p>
    </section>
  )
}
