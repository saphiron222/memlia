// Copyright (c) 2026 Memlia. All rights reserved.
'use client'
import { useId, useRef, useState } from 'react'
import { Button, pageHeadingClassName, Textarea } from '@sim/emcn'
import Link from 'next/link'
import { PermissionAccessBoundary } from '@/components/permissions/access-boundary'
import { useCreateWorkflowDraft } from '@/app/workspace/[workspaceId]/home/hooks/use-create-workflow-draft'
import { useWorkflows } from '@/hooks/queries/workflows'
import { useWorkspaceFiles } from '@/hooks/queries/workspace-files'
import { type Catalog, projectExcelCatalog } from './catalog'
import { ExcelTestPreparation } from './test-preparation'

const focus =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-accent)]'
type Props = { workspaceId: string; userId: string }

export function ExcelAutomations(props: Props) {
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

function ExampleFiles({ workspaceId }: { workspaceId: string }) {
  const query = useWorkspaceFiles(workspaceId)
  const base = `/workspace/${encodeURIComponent(workspaceId)}/files`
  return (
    <section aria-labelledby='excel-example-files' className='space-y-4'>
      <h2 id='excel-example-files' className='font-medium text-lg'>
        Fichiers exemples
      </h2>
      <p className='text-[var(--text-secondary)]'>
        Consultez vos classeurs et précisez les règles à appliquer dans votre demande.
      </p>
      <CatalogList
        catalog={projectExcelCatalog(workspaceId, query, 'files')}
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
        <form
          className='space-y-4'
          onSubmit={(event) => {
            event.preventDefault()
            const instruction = currentText.current
            if (tooLong || !workflowDraft.available) return
            void workflowDraft.create(instruction, () => currentText.current === instruction)
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
          <ExampleFiles workspaceId={workspaceId} />
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
