/** @vitest-environment jsdom */
// Copyright (c) 2026 Memlia. All rights reserved.
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMothershipDraftsStore } from '@/stores/mothership-drafts/store'
import { usePanelStore } from '@/stores/panel/store'

const fixture = vi.hoisted(() => ({
  request: vi.fn(),
  push: vi.fn(),
  read: vi.fn(),
  canEdit: true,
  hideChat: false,
  hideFiles: false,
  workflows: {
    status: 'success',
    isPlaceholderData: false,
    data: [{ id: 'wf-existing', workspaceId: 'ws-1', name: 'Mon workflow' }],
  },
  files: {
    status: 'success',
    isPlaceholderData: false,
    data: [{ id: 'file-1', workspaceId: 'ws-1', name: 'Exemple.xlsx' }],
  },
}))
vi.mock('@/lib/api/client/request', () => ({ requestJson: fixture.request }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: fixture.push }),
  useParams: () => ({ workspaceId: 'ws-1' }),
}))
vi.mock('@/hooks/queries/local-chat-capabilities', () => ({
  useLocalChatCapabilities: () => ({ ...fixture.read(), read: fixture.read }),
}))
vi.mock('@/hooks/queries/workflows', async (load) => ({
  ...(await load<typeof import('@/hooks/queries/workflows')>()),
  useWorkflows: () => fixture.workflows,
}))
vi.mock('@/hooks/queries/workspace-files', () => ({ useWorkspaceFiles: () => fixture.files }))
vi.mock('@/hooks/queries/user-permission-config', () => ({
  useUserPermissionConfig: () => ({
    isSuccess: true,
    data: { config: { hideCopilot: fixture.hideChat, hideFilesTab: fixture.hideFiles } },
  }),
}))
vi.mock('@/app/workspace/[workspaceId]/providers/workspace-permissions-provider', () => ({
  useWorkspacePermissionsContext: () => ({
    userPermissions: { canEdit: fixture.canEdit, isLoading: false, error: null },
  }),
}))

import { ExcelAutomations } from './excel-automations'

const profile = {
  version: 1,
  backend: 'local',
  provider: 'openai',
  model: 'model-fixture',
  workspaceId: 'ws-1',
  modes: ['agent'],
  requiresExistingWorkflow: true,
  requestSupported: false,
  currentWorkflowReference: 'unavailable',
  modelSelection: false,
  effort: false,
  attachments: false,
  otherResources: false,
  contexts: false,
  desktop: false,
}
let root: Root
let host: HTMLDivElement
let client: QueryClient
function render(scope = { workspaceId: 'ws-1', userId: 'user-1' }) {
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <ExcelAutomations {...scope} />
      </QueryClientProvider>
    )
  )
}
function type(text: string) {
  const el = host.querySelector('textarea')
  expect(el).not.toBeNull()
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, text)
    el!.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function submit() {
  const form = host.querySelector('form')
  expect(form).not.toBeNull()
  await act(async () => {
    form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await Promise.resolve()
  })
}
beforeEach(() => {
  vi.clearAllMocks()
  fixture.canEdit = true
  fixture.hideChat = false
  fixture.hideFiles = false
  fixture.read.mockReturnValue({ status: 'ready', profile, scopeKey: 'scope' })
  fixture.workflows = {
    status: 'success',
    isPlaceholderData: false,
    data: [{ id: 'wf-existing', workspaceId: 'ws-1', name: 'Mon workflow' }],
  }
  fixture.files = {
    status: 'success',
    isPlaceholderData: false,
    data: [{ id: 'file-1', workspaceId: 'ws-1', name: 'Exemple.xlsx' }],
  }
  fixture.request.mockImplementation(async (contract) => {
    if (contract.method === 'POST' && contract.path === '/api/workflows')
      return { id: 'wf-created', workspaceId: 'ws-1', name: 'Workflow fictif', sortOrder: 0 }
    if (contract.method === 'GET' && contract.path === '/api/copilot/capabilities')
      return {
        ...profile,
        workflowId: 'wf-created',
        requestSupported: true,
        currentWorkflowReference: 'implicit',
      }
    throw new Error('Unexpected provider or execution request')
  })
  useMothershipDraftsStore.getState().reset()
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  client.clear()
  useMothershipDraftsStore.getState().reset()
})
describe('page Excel, vrai hook de création et stores natifs, transport HTTP doublé', () => {
  it('présente le parcours et ses liens natifs sans déclencher un effet', () => {
    render()
    expect(host.querySelector('h1')?.textContent).toBe('Automatiser Excel')
    expect(host.querySelector('label')?.htmlFor).toBe(host.querySelector('textarea')?.id)
    expect(host.querySelector('a[href="/workspace/ws-1/w/wf-existing"]')?.textContent).toBe(
      'Mon workflow'
    )
    expect(host.querySelector('a[href="/workspace/ws-1/files/file-1/view"]')?.textContent).toBe(
      'Exemple.xlsx'
    )
    expect(fixture.request).not.toHaveBeenCalled()
  })
  it('prépare exactement l’instruction dans le vrai Chat du nouveau workflow sans envoyer ni exécuter', async () => {
    render()
    type('  Regroupe les salaires par client.\nPréserve les sources.  ')
    await submit()
    expect(fixture.request.mock.calls.map(([c]) => [c.method, c.path])).toEqual([
      ['POST', '/api/workflows'],
      ['GET', '/api/copilot/capabilities'],
    ])
    expect(
      useMothershipDraftsStore.getState().drafts['ws-1:workflow-copilot:wf-created:new']
    ).toEqual({
      text: '  Regroupe les salaires par client.\nPréserve les sources.  ',
      localOrigin: true,
    })
    expect(usePanelStore.getState().activeTab).toBe('copilot')
    expect(fixture.push).toHaveBeenCalledWith('/workspace/ws-1/w/wf-created')
  })
  it('masque l’ancien inventaire pendant le changement de workspace', () => {
    fixture.workflows.isPlaceholderData = true
    fixture.files.isPlaceholderData = true
    render({ workspaceId: 'ws-2', userId: 'user-1' })
    expect(host.textContent).not.toContain('Mon workflow')
    expect(host.textContent).not.toContain('Exemple.xlsx')
    expect(host.textContent).toContain('Chargement')
  })
  it('ne prépare aucun brouillon sans droit de modification', async () => {
    fixture.canEdit = false
    render()
    type('Créer une synthèse')
    await submit()
    expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true)
    expect(fixture.request).not.toHaveBeenCalled()
  })
  it('respecte séparément les restrictions Chat et fichiers', () => {
    fixture.hideFiles = true
    render()
    expect(host.textContent).not.toContain('Exemple.xlsx')
    expect(host.textContent).toContain('Mon workflow')
    fixture.hideChat = true
    render()
    expect(host.querySelector('textarea')).toBeNull()
    expect(fixture.request).not.toHaveBeenCalled()
  })
  it('conserve la demande et masque les erreurs de transport privées', async () => {
    fixture.request.mockRejectedValueOnce(new Error('PRIVATE_TRANSPORT_CANARY'))
    render()
    type('Créer une synthèse')
    await submit()
    expect(host.querySelector('textarea')?.value).toBe('Créer une synthèse')
    expect(host.textContent).toContain('Votre brouillon reste ici')
    expect(host.textContent).not.toContain('PRIVATE_TRANSPORT_CANARY')
    expect(fixture.push).not.toHaveBeenCalled()
  })
  it('ne navigue pas avec l’instruction devenue obsolète pendant la création', async () => {
    let finish!: (value: unknown) => void
    fixture.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    render()
    type('Instruction initiale')
    await submit()
    type('Instruction corrigée')
    await act(async () => {
      finish({ id: 'wf-created', workspaceId: 'ws-1' })
    })
    expect(fixture.push).not.toHaveBeenCalled()
    expect(
      useMothershipDraftsStore.getState().drafts['ws-1:workflow-copilot:wf-created:new']
    ).toBeUndefined()
    expect(host.querySelector('textarea')?.value).toBe('Instruction corrigée')
  })
  it('ne transfère pas une demande entre espaces après une réponse tardive', async () => {
    let finish!: (value: unknown) => void
    fixture.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    render()
    type('Ancien espace')
    await submit()
    render({ workspaceId: 'ws-2', userId: 'user-1' })
    await act(async () => {
      finish({ id: 'wf-created', workspaceId: 'ws-1' })
    })
    expect(fixture.push).not.toHaveBeenCalled()
    expect(host.querySelector('textarea')?.value).toBe('')
  })
  it('laisse la déduplication native empêcher un double envoi', async () => {
    let finish!: (value: unknown) => void
    fixture.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    render()
    type('Une seule création')
    await submit()
    await submit()
    expect(fixture.request).toHaveBeenCalledTimes(1)
    await act(async () => {
      finish({ id: 'wf-created', workspaceId: 'ws-1' })
    })
    expect(fixture.push).toHaveBeenCalledTimes(1)
  })
  it('refuse une demande dépassant la borne en octets sans appel HTTP', async () => {
    render()
    type('é'.repeat(32769))
    await submit()
    expect(host.querySelector('textarea')?.getAttribute('aria-invalid')).toBe('true')
    expect(fixture.request).not.toHaveBeenCalled()
  })
})

it('monte la préparation inactive dans la page sans requête automatique', () => {
  render()
  expect(host.querySelector('select')).not.toBeNull()
  expect(host.textContent).toContain('Préparer une version de test')
  expect(fixture.request).not.toHaveBeenCalled()
})
