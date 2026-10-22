// Copyright (c) 2026 Memlia. All rights reserved.
'use client'
import { type MutableRefObject, useId, useLayoutEffect, useRef, useState } from 'react'
import { Button, pageHeadingClassName, Textarea } from '@sim/emcn'
import Link from 'next/link'
import { PermissionAccessBoundary } from '@/components/permissions/access-boundary'
import { useSession } from '@/lib/auth/client'
import { prepareSelectedExcelMessage } from '@/lib/memlia/excel/selected-files'
import { useCreateWorkflowDraft } from '@/app/workspace/[workspaceId]/home/hooks/use-create-workflow-draft'
import { useWorkflows } from '@/hooks/queries/workflows'
import { useWorkspaceFiles } from '@/hooks/queries/workspace-files'
import { type Catalog, projectExcelCatalog } from './catalog'
import { ExcelTestPreparation } from './test-preparation'

const focus =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-accent)]'
type Props = { workspaceId: string; userId: string }

export function ExcelAutomations(props: Props) {
  const session = useSession()
  if (session.isPending || session.error || session.data?.user?.id !== props.userId)
    return <p role='status'>Vérifiez votre compte avant de préparer une automatisation Excel.</p>
  return (
    <PermissionAccessBoundary configKey='hideCopilot'>
      <ExcelAutomationsContent key={`${props.workspaceId}:${props.userId}`} {...props} />
    </PermissionAccessBoundary>
  )
}

function CatalogList({
  catalog,
  href,
  empty,
  retry,
}: {
  catalog: Catalog
  href: (id: string) => string
  empty: string
  retry: () => void
}) {
  if (catalog.status === 'loading') return <p role='status'>Chargement…</p>
  if (catalog.status === 'error')
    return (
      <div>
        <p role='alert'>La liste n’a pas pu être chargée.</p>
        <Button className={`${focus} min-h-8`} onClick={retry}>
          Réessayer
        </Button>
      </div>
    )
  if (!catalog.items.length) return <p className='text-[var(--text-secondary)]'>{empty}</p>
  return (
    <>
      <ul className='flex flex-col gap-3'>
        {catalog.items.map((item) => (
          <li key={item.id}>
            <Link
              className={
                focus +
                ' inline-block rounded-sm py-1 text-[var(--text-primary)] underline underline-offset-4'
              }
              href={href(item.id)}
            >
              {item.name}
            </Link>
          </li>
        ))}
      </ul>
      {catalog.remaining > 0 && (
        <p className='mt-3 text-[var(--text-secondary)]'>
          {catalog.remaining} autres éléments sont disponibles dans la liste complète.
        </p>
      )}
    </>
  )
}

type FileSelection = { fileIds: string[]; valid: boolean }
function ExampleFiles({
  workspaceId,
  selection,
  disabled,
}: {
  workspaceId: string
  selection: MutableRefObject<FileSelection>
  disabled: boolean
}) {
  const query = useWorkspaceFiles(workspaceId)
  const [selected, setSelected] = useState<string[]>([])
  const catalog = projectExcelCatalog(workspaceId, query, 'files')
  const valid =
    selected.length === 0 ||
    (catalog.status === 'ready' &&
      selected.every((id) => catalog.items.some((item) => item.id === id)))
  useLayoutEffect(() => {
    selection.current = { fileIds: [...selected], valid }
    return () => {
      selection.current = { fileIds: [], valid: true }
    }
  }, [selection, selected, valid])
  const base = `/workspace/${encodeURIComponent(workspaceId)}/files`
  return (
    <section aria-labelledby='excel-example-files' className='space-y-4'>
      <h2 id='excel-example-files' className='font-medium text-lg'>
        Fichiers exemples
      </h2>
      <p className='text-[var(--text-secondary)]'>
        Sélectionnez jusqu’à quatre classeurs et précisez vos règles. Leurs échantillons pourront
        être transmis au fournisseur IA configuré lorsque vous enverrez votre demande dans le Chat.
        La sélection reste visible et modifiable dans ce brouillon avant son envoi.
      </p>
      {catalog.status === 'ready' && (
        <fieldset disabled={disabled} className='space-y-2'>
          <legend>Classeurs exemples à analyser</legend>
          {catalog.items.map((item) => (
            <label key={item.id} className='flex items-center gap-2'>
              <input
                type='checkbox'
                checked={selected.includes(item.id)}
                disabled={!selected.includes(item.id) && selected.length >= 4}
                onChange={(event) =>
                  setSelected((ids) =>
                    event.target.checked ? [...ids, item.id] : ids.filter((id) => id !== item.id)
                  )
                }
              />
              {item.name}
            </label>
          ))}
        </fieldset>
      )}
      {!valid && (
        <p role='alert'>
          La sélection n’est plus disponible. Actualisez les fichiers avant de continuer.
        </p>
      )}
      <CatalogList
        catalog={catalog}
        href={(id) => `${base}/${encodeURIComponent(id)}/view`}
        empty='Aucun classeur Excel dans cet espace.'
        retry={() => {
          void query.refetch()
        }}
      />
      <Link
        href={base}
        className={`${focus} inline-block rounded-sm py-1 underline underline-offset-4`}
      >
        Ajouter ou consulter des fichiers
      </Link>
    </section>
  )
}

function ExcelAutomationsContent({ workspaceId, userId }: Props) {
  const [text, setText] = useState('')
  const currentText = useRef('')
  const fileSelection = useRef<FileSelection>({ fileIds: [], valid: true })
  const [selectionError, setSelectionError] = useState(false)
  const instructionId = useId()
  const helpId = useId()
  const workflowDraft = useCreateWorkflowDraft({ workspaceId, userId, enabled: true })
  const workflows = useWorkflows(workspaceId)
  const tooLong = new TextEncoder().encode(text).byteLength > 64 * 1024
  const base = `/workspace/${encodeURIComponent(workspaceId)}`
  return (
    <div className='h-full overflow-y-auto bg-[var(--bg)] text-[var(--text-primary)]'>
      <div className='mx-auto flex w-full max-w-4xl flex-col gap-10 px-6 py-10 text-sm'>
        <header className='space-y-3'>
          <h1 className={pageHeadingClassName}>Automatiser Excel</h1>
          <p className='text-[var(--text-secondary)]'>
            Décrivez le résultat attendu pour préparer une automatisation dans votre espace de
            travail.
          </p>
        </header>
        <section aria-labelledby='excel-desktop-pane' className='space-y-3'>
          <h2 id='excel-desktop-pane' className='font-medium text-lg'>
            Votre classeur ouvert dans Excel
          </h2>
          <p className='text-[var(--text-secondary)]'>
            Le volet Memlia pour Excel de bureau sur Windows permet de sauvegarder une copie privée
            du classeur sur le serveur du cabinet, puis de prévisualiser et d’approuver des
            modifications. Après application et vérification, l’enregistrement du classeur reste une
            action explicite ; son acquittement par Excel ne remplace pas une vérification du
            fichier.
          </p>
          <a
            href='/excel-addin/manifest.xml'
            download='memlia-excel.xml'
            className={`${focus} inline-block rounded-sm py-1 underline underline-offset-4`}
          >
            Télécharger le fichier d’installation du volet Excel
          </a>
        </section>
        <form
          className='space-y-4'
          onSubmit={(event) => {
            event.preventDefault()
            const instruction = currentText.current
            const selected = JSON.stringify(fileSelection.current)
            if (tooLong || !workflowDraft.available || !fileSelection.current.valid) return
            try {
              const message = prepareSelectedExcelMessage(
                instruction,
                fileSelection.current.fileIds
              )
              if (new TextEncoder().encode(message).byteLength > 64 * 1024) throw new Error('limit')
              setSelectionError(false)
              void workflowDraft.create(
                message,
                () =>
                  currentText.current === instruction &&
                  JSON.stringify(fileSelection.current) === selected
              )
            } catch {
              setSelectionError(true)
            }
          }}
        >
          <label htmlFor={instructionId} className='block font-medium'>
            Que souhaitez-vous automatiser ?
          </label>
          <Textarea
            id={instructionId}
            aria-describedby={helpId}
            aria-invalid={tooLong}
            value={text}
            rows={5}
            maxLength={65536}
            className={focus}
            placeholder='Par exemple : regrouper les montants par client et créer un nouveau classeur de synthèse.'
            onChange={(event) => {
              currentText.current = event.target.value
              setText(event.target.value)
            }}
          />
          <p id={helpId} className='text-[var(--text-secondary)]'>
            Un brouillon sera créé et votre demande sera préparée dans le Chat. Vous pourrez la
            relire avant de l’envoyer.
          </p>
          {tooLong && (
            <p role='alert'>Votre demande est trop longue. Raccourcissez-la avant de continuer.</p>
          )}
          {selectionError && (
            <p role='alert'>
              La demande ou sa sélection est invalide ou trop longue. Corrigez-la avant de
              continuer.
            </p>
          )}
          {workflowDraft.message && <p role='status'>{workflowDraft.message}</p>}
          {!workflowDraft.available && !workflowDraft.pending && !workflowDraft.message && (
            <p role='status'>La préparation avec le Chat n’est pas disponible pour le moment.</p>
          )}
          <Button
            type='submit'
            variant='primary'
            className={`${focus} min-h-9 px-4`}
            disabled={!workflowDraft.available || workflowDraft.pending || !text.trim() || tooLong}
          >
            {workflowDraft.pending ? 'Préparation…' : 'Préparer avec le Chat'}
          </Button>
        </form>
        <PermissionAccessBoundary configKey='hideFilesTab'>
          <ExampleFiles
            workspaceId={workspaceId}
            selection={fileSelection}
            disabled={workflowDraft.pending}
          />
        </PermissionAccessBoundary>
        <ExcelTestPreparation
          workspaceId={workspaceId}
          userId={userId}
          catalog={projectExcelCatalog(workspaceId, workflows, 'workflows')}
        />
        <section aria-labelledby='excel-resume-workflow' className='space-y-4'>
          <h2 id='excel-resume-workflow' className='font-medium text-lg'>
            Reprendre un workflow
          </h2>
          <p className='text-[var(--text-secondary)]'>
            Retrouvez les workflows auxquels vous avez accès pour poursuivre leur préparation.
          </p>
          <CatalogList
            catalog={projectExcelCatalog(workspaceId, workflows, 'workflows')}
            href={(id) => `${base}/w/${encodeURIComponent(id)}`}
            empty='Aucun workflow dans cet espace.'
            retry={() => {
              void workflows.refetch()
            }}
          />
          <Link
            href={`${base}/w`}
            className={`${focus} inline-block rounded-sm py-1 underline underline-offset-4`}
          >
            Voir tous les workflows
          </Link>
        </section>
      </div>
    </div>
  )
}
