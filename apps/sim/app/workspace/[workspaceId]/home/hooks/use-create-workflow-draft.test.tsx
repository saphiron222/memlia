/** @vitest-environment jsdom */
// Copyright 2026 Memlia. All rights reserved.
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMothershipDraftsStore } from '@/stores/mothership-drafts/store'
import { usePanelStore } from '@/stores/panel/store'

const fixture = vi.hoisted(() => ({
  create: vi.fn(),
  request: vi.fn(),
  push: vi.fn(),
  read: vi.fn(),
  canEdit: true,
  nativeCreate: undefined as undefined | (() => unknown),
}))
vi.mock('@/hooks/queries/workflows', () => ({
  useCreateWorkflow: () =>
    fixture.nativeCreate ? fixture.nativeCreate() : { mutateAsync: fixture.create },
}))
vi.mock('@/lib/api/client/request', () => ({ requestJson: fixture.request }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: fixture.push }) }))
vi.mock('@/hooks/queries/local-chat-capabilities', () => ({
  useLocalChatCapabilities: () => ({ ...fixture.read(), read: fixture.read }),
}))
vi.mock('@/app/workspace/[workspaceId]/providers/workspace-permissions-provider', () => ({
  useWorkspacePermissionsContext: () => ({
    userPermissions: { canEdit: fixture.canEdit, isLoading: false, error: null },
  }),
}))

import { useCreateWorkflowDraft } from './use-create-workflow-draft'

const profile = {
  version: 1,
  backend: 'local',
  provider: 'openai',
  model: 'gpt-4.1',
  workspaceId: 'ws-home',
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
function observed() {
  return { status: 'ready', scopeKey: 'home', profile }
}
function target() {
  return {
    ...profile,
    workflowId: 'wf-created',
    requestSupported: true,
    currentWorkflowReference: 'implicit',
  }
}
function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
let client: QueryClient
let root: Root | undefined
let api: ReturnType<typeof useCreateWorkflowDraft>
let scope: { workspaceId: string; userId?: string; enabled: boolean } = {
  workspaceId: 'ws-home',
  userId: 'user-home',
  enabled: true,
}
function Host() {
  api = useCreateWorkflowDraft(scope)
  return null
}
function render() {
  if (!root) {
    root = createRoot(document.createElement('div'))
  }
  act(() =>
    root!.render(
      <QueryClientProvider client={client}>
        <Host />
      </QueryClientProvider>
    )
  )
}
beforeEach(() => {
  vi.clearAllMocks()
  fixture.nativeCreate = undefined
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  scope = { workspaceId: 'ws-home', userId: 'user-home', enabled: true }
  fixture.canEdit = true
  fixture.read.mockImplementation(observed)
  fixture.create.mockResolvedValue({ id: 'wf-created', workspaceId: 'ws-home' })
  fixture.request.mockImplementation(async (contract) => {
    if (contract.method !== 'GET' || contract.path !== '/api/copilot/capabilities')
      throw new Error('Unexpected request')
    return target()
  })
  useMothershipDraftsStore.getState().reset()
  useMothershipDraftsStore.getState().setDraft('ws-home:new', { text: 'Mon intention' })
})
afterEach(() => {
  if (root) act(() => root!.unmount())
  root = undefined
  client.clear()
  useMothershipDraftsStore.getState().reset()
})

describe('Home workflow draft transition (native stores; creation and GET transport doubled)', () => {
  it('creates, checks the workflow profile, copies only text and navigates without sending or adopting', async () => {
    render()
    await act(async () => {
      expect(await api.create('Mon intention', () => true)).toBe(true)
    })
    expect(fixture.create).toHaveBeenCalledOnce()
    expect(fixture.create.mock.calls[0][0]).toEqual(
      expect.objectContaining({ workspaceId: 'ws-home' })
    )
    expect(fixture.request).toHaveBeenCalledOnce()
    expect(
      useMothershipDraftsStore.getState().drafts['ws-home:workflow-copilot:wf-created:new']
    ).toEqual({ text: 'Mon intention', localOrigin: true })
    expect(useMothershipDraftsStore.getState().drafts['ws-home:new']).toEqual({
      text: 'Mon intention',
    })
    expect(usePanelStore.getState().activeTab).toBe('copilot')
    expect(usePanelStore.getState().isMobilePanelOpen).toBe(true)
    expect(fixture.push).toHaveBeenCalledWith('/workspace/ws-home/w/wf-created')
  })
  it.each(['read-only', 'unavailable', 'legacy', 'missing-user', 'not-home', 'empty', 'oversized'])(
    'refuses %s before creation',
    async (mode) => {
      if (mode === 'read-only') fixture.canEdit = false
      if (mode === 'unavailable')
        fixture.read.mockReturnValue({ status: 'unavailable', scopeKey: 'home' })
      if (mode === 'legacy')
        fixture.read.mockReturnValue({ ...observed(), profile: { backend: 'legacy', version: 1 } })
      if (mode === 'missing-user') scope.userId = undefined
      if (mode === 'not-home') scope.enabled = false
      render()
      const text =
        mode === 'empty' ? ' ' : mode === 'oversized' ? 'x'.repeat(65537) : 'Mon intention'
      await act(async () => {
        expect(await api.create(text, () => true)).toBe(false)
      })
      expect(fixture.create).not.toHaveBeenCalled()
      expect(fixture.push).not.toHaveBeenCalled()
    }
  )
  it('deduplicates a double click while the creation is pending', async () => {
    const wait = deferred<{ id: string; workspaceId: string }>()
    fixture.create.mockReturnValue(wait.promise)
    render()
    let first!: Promise<boolean>
    act(() => {
      first = api.create('Mon intention', () => true)
    })
    await act(async () => {
      expect(await api.create('Mon intention', () => true)).toBe(false)
    })
    await act(async () => {
      wait.resolve({ id: 'wf-created', workspaceId: 'ws-home' })
      await first
    })
    expect(fixture.create).toHaveBeenCalledOnce()
    await act(async () => {
      expect(await api.create('Mon intention', () => true)).toBe(false)
    })
    expect(fixture.create).toHaveBeenCalledOnce()
  })
  it.each(['permissions', 'profile', 'subject', 'workspace', 'text', 'unmount'])(
    'retains the Home draft and does not navigate after %s changes during creation',
    async (change) => {
      const wait = deferred<{ id: string; workspaceId: string }>()
      fixture.create.mockReturnValue(wait.promise)
      render()
      let current = true
      let first!: Promise<boolean>
      act(() => {
        first = api.create('Mon intention', () => current)
      })
      if (change === 'permissions') fixture.canEdit = false
      if (change === 'profile')
        fixture.read.mockReturnValue({ ...observed(), profile: { ...profile, model: 'gpt-other' } })
      if (change === 'subject') scope = { ...scope, userId: 'other' }
      if (change === 'workspace') scope = { ...scope, workspaceId: 'other' }
      if (change === 'text') current = false
      if (change === 'unmount') {
        act(() => root!.unmount())
        root = undefined
      } else render()
      await act(async () => {
        wait.resolve({ id: 'wf-created', workspaceId: 'ws-home' })
        expect(await first).toBe(false)
      })
      expect(fixture.push).not.toHaveBeenCalled()
      expect(useMothershipDraftsStore.getState().drafts['ws-home:new']?.text).toBe('Mon intention')
      expect(
        useMothershipDraftsStore.getState().drafts['ws-home:workflow-copilot:wf-created:new']
      ).toBeUndefined()
    }
  )
  it('keeps the draft on creation failure and never exposes the error', async () => {
    fixture.create.mockRejectedValue(new Error('PRIVATE_FAILURE_CANARY'))
    render()
    await act(async () => {
      expect(await api.create('Mon intention', () => true)).toBe(false)
    })
    expect(api.message).not.toContain('PRIVATE_FAILURE_CANARY')
    expect(fixture.request).not.toHaveBeenCalled()
    expect(fixture.push).not.toHaveBeenCalled()
    expect(useMothershipDraftsStore.getState().drafts['ws-home:new']?.text).toBe('Mon intention')
  })
  it.each(['wrong-workflow', 'wrong-model', 'unavailable', 'extra-field'])(
    'refuses target capabilities %s after creation without dispatch',
    async (change) => {
      fixture.request.mockResolvedValue(
        change === 'unavailable'
          ? { version: 1, backend: 'unavailable', code: 'local_profile_unavailable' }
          : {
              ...target(),
              ...(change === 'wrong-workflow'
                ? { workflowId: 'foreign' }
                : change === 'wrong-model'
                  ? { model: 'gpt-other' }
                  : { unexpected: true }),
            }
      )
      render()
      await act(async () => {
        expect(await api.create('Mon intention', () => true)).toBe(false)
      })
      expect(fixture.push).not.toHaveBeenCalled()
      expect(
        useMothershipDraftsStore.getState().drafts['ws-home:workflow-copilot:wf-created:new']
      ).toBeUndefined()
    }
  )
  it('does not overwrite another draft in the created workflow', async () => {
    useMothershipDraftsStore
      .getState()
      .setDraft('ws-home:workflow-copilot:wf-created:new', { text: 'Autre intention' })
    render()
    await act(async () => {
      expect(await api.create('Mon intention', () => true)).toBe(false)
    })
    expect(
      useMothershipDraftsStore.getState().drafts['ws-home:workflow-copilot:wf-created:new']?.text
    ).toBe('Autre intention')
    expect(fixture.push).not.toHaveBeenCalled()
  })
})

describe('late profile transport boundaries', () => {
  it('refuses after target GET if the editor or subject changes during that wait', async () => {
    const wait = deferred<ReturnType<typeof target>>()
    fixture.request.mockReturnValue(wait.promise)
    render()
    let current = true
    let pending!: Promise<boolean>
    await act(async () => {
      pending = api.create('Mon intention', () => current)
      await Promise.resolve()
    })
    expect(fixture.request).toHaveBeenCalledOnce()
    current = false
    await act(async () => {
      wait.resolve(target())
      expect(await pending).toBe(false)
    })
    expect(fixture.push).not.toHaveBeenCalled()
    expect(
      useMothershipDraftsStore.getState().drafts['ws-home:workflow-copilot:wf-created:new']
    ).toBeUndefined()
  })
  it('does not navigate on target GET failure and does not create twice after an uncertain response', async () => {
    fixture.request.mockRejectedValue(new Error('PRIVATE_TARGET_FAILURE'))
    render()
    await act(async () => {
      expect(await api.create('Mon intention', () => true)).toBe(false)
    })
    await act(async () => {
      expect(await api.create('Mon intention', () => true)).toBe(false)
    })
    expect(fixture.create).toHaveBeenCalledOnce()
    expect(fixture.push).not.toHaveBeenCalled()
    expect(api.message).not.toContain('PRIVATE_TARGET_FAILURE')
  })
})

describe('actual native creation mutation', () => {
  it('uses only the canonical create route and capabilities GET, with the real Query mutation/cache lifecycle', async () => {
    const native = await vi.importActual<typeof import('@/hooks/queries/workflows')>(
      '@/hooks/queries/workflows'
    )
    fixture.nativeCreate = native.useCreateWorkflow
    fixture.request.mockImplementation(async (contract, options) => {
      if (contract.method === 'POST' && contract.path === '/api/workflows') {
        expect(options.body.workspaceId).toBe('ws-home')
        expect(options.body.deduplicate).toBe(true)
        expect(typeof options.body.id).toBe('string')
        expect(options.body).not.toHaveProperty('message')
        expect(options.body).not.toHaveProperty('localOrigin')
        return { id: 'wf-created', name: 'Workflow fictif', workspaceId: 'ws-home', sortOrder: 0 }
      }
      if (contract.method === 'GET' && contract.path === '/api/copilot/capabilities')
        return target()
      throw new Error('Unexpected Chat/provider request')
    })
    render()
    await act(async () => {
      expect(await api.create('Mon intention', () => true)).toBe(true)
    })
    expect(
      fixture.request.mock.calls.map(([contract]) => [contract.method, contract.path])
    ).toEqual([
      ['POST', '/api/workflows'],
      ['GET', '/api/copilot/capabilities'],
    ])
    expect(fixture.push).toHaveBeenCalledOnce()
    expect(
      useMothershipDraftsStore.getState().drafts['ws-home:workflow-copilot:wf-created:new']
    ).toEqual({ text: 'Mon intention', localOrigin: true })
  })
})
