// Copyright 2026 Memlia. All rights reserved.
'use client'

import { useEffect, useId, useRef, useState } from 'react'
import {
  ChipModal,
  ChipModalBody,
  ChipModalDescription,
  ChipModalError,
  ChipModalField,
  ChipModalFooter,
  ChipModalHeader,
} from '@sim/emcn'
import { useRouter } from 'next/navigation'
import { ApiClientError } from '@/lib/api/client/errors'
import { useSession } from '@/lib/auth/client'
import { usePrivateWorkflowCopy } from '@/hooks/queries/private-workflow-copy'
import { useWorkspacesQuery } from '@/hooks/queries/workspace'

interface PrivateCopyDialogProps {
  sourceWorkflowId: string
  sourceWorkspaceId: string
  sourceName: string
  onClose: () => void
}

export function PrivateCopyDialog({
  sourceWorkflowId,
  sourceWorkspaceId,
  sourceName,
  onClose,
}: PrivateCopyDialogProps) {
  const { data: session, isPending: sessionPending } = useSession()
  const workspaces = useWorkspacesQuery(true, 'active')
  const mutation = usePrivateWorkflowCopy()
  const router = useRouter()
  const descriptionId = useId()
  const [name, setName] = useState(() => `${sourceName} — copie privée`.slice(0, 100))
  const [destinationId, setDestinationId] = useState('')
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)
  const generation = useRef(0)
  const userId = session?.user?.id
  useEffect(() => {
    generation.current++
    return () => {
      generation.current++
    }
  }, [sourceWorkflowId, sourceWorkspaceId, userId])

  const loading = sessionPending || workspaces.isPending || workspaces.isPlaceholderData
  // A discovery filter only. The server rechecks ownership and authorization atomically.
  const eligible =
    !loading && !workspaces.isError && userId
      ? (workspaces.data ?? []).filter(
          (workspace) =>
            workspace.workspaceMode === 'personal' &&
            workspace.ownerId === userId &&
            workspace.organizationId === null &&
            !workspace.archivedAt &&
            workspace.id !== sourceWorkspaceId
        )
      : []
  const destination = eligible.find((workspace) => workspace.id === destinationId)
  const trimmedName = name.trim()
  const nameValid = trimmedName.length > 0 && trimmedName.length <= 100
  const pending = mutation.isPending
  const canSubmit = Boolean(destination) && nameValid && !pending && !mutation.isSuccess

  function close() {
    if (!inFlight.current) onClose()
  }

  async function submit() {
    if (inFlight.current || !canSubmit || !destination) return
    inFlight.current = true
    const startedIn = generation.current
    setError(null)
    try {
      const copy = await mutation.mutateAsync({
        sourceWorkflowId,
        destinationWorkspaceId: destination.id,
        name: trimmedName,
      })
      if (generation.current !== startedIn) return
      router.push(
        `/workspace/${encodeURIComponent(copy.workspaceId)}/w/${encodeURIComponent(copy.id)}`
      )
      onClose()
    } catch (cause) {
      if (generation.current !== startedIn) return
      setError(
        cause instanceof ApiClientError && cause.status === 403
          ? 'Accès refusé. Vos droits ou cet espace ont peut-être changé.'
          : cause instanceof ApiClientError && cause.status === 409
            ? 'La source ou la destination a changé. Actualisez avant de réessayer.'
            : 'La création n’a pas été confirmée. Vérifiez votre espace personnel avant de réessayer.'
      )
    } finally {
      inFlight.current = false
    }
  }

  return (
    <ChipModal
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
      srTitle='Créer une copie privée'
      aria-describedby={descriptionId}
      dismissDisabled={pending}
    >
      <ChipModalHeader onClose={close}>Créer une copie privée</ChipModalHeader>
      <ChipModalBody aria-busy={pending}>
        <ChipModalDescription id={descriptionId}>
          Copie de la structure uniquement, à reconfigurer : seuls la structure simple et les noms
          des blocs sont conservés. Les connexions, paramètres et contenus sont retirés, y compris
          les codes, prompts et règles. Les boucles, traitements parallèles et blocs personnalisés
          ne sont pas pris en charge. La source reste inchangée. Aucune exécution ni activation
          n’est lancée.
        </ChipModalDescription>
        <ChipModalField
          type='input'
          title='Nom de la copie'
          value={name}
          onChange={setName}
          maxLength={100}
          required
          disabled={pending}
          error={!nameValid ? 'Saisissez un nom de 1 à 100 caractères.' : undefined}
        />
        <ChipModalField
          type='dropdown'
          title='Espace personnel de destination'
          value={destination?.id ?? ''}
          onChange={setDestinationId}
          options={eligible.map((workspace) => ({ value: workspace.id, label: workspace.name }))}
          placeholder='Choisir un espace personnel'
          required
          disabled={pending || loading || eligible.length === 0}
        />
        {loading && <p role='status'>Chargement des espaces personnels…</p>}
        {!loading && workspaces.isError && (
          <ChipModalError>
            Impossible de charger vos espaces. Fermez puis rouvrez ce dialogue pour réessayer.
          </ChipModalError>
        )}
        {!loading && !workspaces.isError && eligible.length === 0 && (
          <ChipModalDescription>
            Aucun espace personnel éligible : il faut un autre espace actif dont vous êtes
            propriétaire, sans organisation. Aucun espace n’est créé automatiquement.
          </ChipModalDescription>
        )}
        {error && <ChipModalError>{error}</ChipModalError>}
        {pending && <p role='status'>Création en cours…</p>}
      </ChipModalBody>
      <ChipModalFooter
        onCancel={close}
        cancelLabel='Annuler'
        cancelDisabled={pending}
        primaryAction={{
          label: pending ? 'Création en cours…' : 'Créer une copie privée',
          onClick: () => {
            void submit()
          },
          disabled: !canSubmit,
        }}
      />
    </ChipModal>
  )
}
