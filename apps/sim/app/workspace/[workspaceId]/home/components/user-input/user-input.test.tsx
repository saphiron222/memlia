/** @vitest-environment jsdom */
// Copyright 2026 Memlia. All rights reserved.

import { act, type ComponentProps } from 'react'
import { integrationMatcherMock } from '@sim/testing/mocks/integration-matcher.mock'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LocalChatPresentation } from '@/hooks/queries/local-chat-capabilities'

vi.mock('@/hooks/queries/skills', () => ({ useSkills: () => ({ data: [] }) }))
vi.mock('@/hooks/queries/mcp', () => ({ useMcpToolServers: () => ({ data: [] }) }))
vi.mock('@/blocks/integration-matcher', () => ({
  ...integrationMatcherMock,
  listIntegrationsByPopularity: () => [],
}))
vi.mock('@/hooks/use-settings-navigation', () => ({
  useSettingsNavigation: () => ({ navigateToSettings: vi.fn() }),
}))
vi.mock('@/hooks/use-voice-input', () => ({
  useVoiceInput: () => ({
    isSttSupported: false,
    isListening: false,
    resetTranscript: vi.fn(),
    audioLevels: [],
    permissionHelpOpen: false,
    setPermissionHelpOpen: vi.fn(),
  }),
}))
vi.mock('@/app/workspace/[workspaceId]/providers/feature-flags-provider', () => ({
  useFeatureFlag: () => false,
}))
vi.mock('next/navigation', () => ({
  useParams: () => ({ workspaceId: 'ws-1' }),
  usePathname: () => '/workspace/ws-1/home',
  useRouter: () => ({ push: vi.fn() }),
}))
// jsdom has no layout observer; editor and controls themselves remain native.
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    disconnect() {}
    unobserve() {}
  }
)

import { useMothershipDraftsStore } from '@/stores/mothership-drafts/store'
import { UserInput } from './user-input'

const roots: Root[] = []
afterEach(() => {
  roots.splice(0).forEach((root) => act(() => root.unmount()))
  document.body.innerHTML = ''
})
function render(
  onSubmit: () => boolean = vi.fn(() => false),
  localChat?: LocalChatPresentation,
  extra: Partial<ComponentProps<typeof UserInput>> = {}
) {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    }
  )
  // jsdom has no viewport media API; use a desktop viewport for the real Enter handler.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
  }))
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const node = document.createElement('div')
  document.body.appendChild(node)
  const root = createRoot(node)
  roots.push(root)
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } })
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <UserInput
          defaultValue='Brouillon humain'
          onSubmit={onSubmit}
          isSending={false}
          onStopGeneration={() => {}}
          localChat={localChat}
          {...extra}
        />
      </QueryClientProvider>
    )
  )
  return { node, onSubmit }
}
describe('native composer local acceptance', () => {
  it('keeps the actual editor text when submit is explicitly refused', () => {
    const { node, onSubmit } = render()
    const send = node.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!
    expect(send).not.toBeNull()
    act(() => send.click())
    expect(onSubmit).toHaveBeenCalledOnce()
    expect(node.querySelector('textarea')?.value).toBe('Brouillon humain')
  })
  it('keeps the real draft on Enter when the profile is loading', () => {
    const { node, onSubmit } = render(
      vi.fn(() => true),
      {
        backend: 'loading',
        blocked: true,
        adopted: false,
        message: 'Vérification des réglages du cabinet…',
        adopt: vi.fn(),
      }
    )
    const editor = node.querySelector('textarea')!
    act(() =>
      editor.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      )
    )
    expect(onSubmit).not.toHaveBeenCalled()
    expect(editor.value).toBe('Brouillon humain')
    expect(node.querySelector('[role="status"]')?.textContent).toContain('Vérification')
  })
  it('refuses file input before upload and leaves the actual draft visible', () => {
    const { node, onSubmit } = render(
      vi.fn(() => true),
      {
        backend: 'local',
        blocked: false,
        model: 'gpt-4.1',
        adopted: true,
        message: null,
        adopt: vi.fn(),
      }
    )
    const input = node.querySelector<HTMLInputElement>('input[type="file"]')!
    Object.defineProperty(input, 'files', {
      value: [new File(['Fictif'], 'fixture.txt', { type: 'text/plain' })],
    })
    act(() => input.dispatchEvent(new Event('change', { bubbles: true })))
    expect(onSubmit).not.toHaveBeenCalled()
    expect(node.textContent).toContain(
      'Les fichiers et ressources supplémentaires ne sont pas disponibles'
    )
    expect(node.querySelector('textarea')?.value).toBe('Brouillon humain')
    expect(node.textContent).not.toContain('fixture.txt')
  })
  it('shows the cabinet model and explanation without an editable model selection', () => {
    const { node, onSubmit } = render(
      vi.fn(() => true),
      {
        backend: 'local',
        blocked: true,
        model: 'gpt-4.1',
        settings: 'Préférences précédentes : modèle choisi',
        adopted: false,
        message: 'Choisissez les réglages du cabinet pour continuer.',
        adopt: vi.fn(),
      }
    )
    expect(node.textContent).toContain('gpt-4.1')
    expect(node.textContent).toContain('Utiliser les réglages du cabinet')
    act(() => node.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')?.click())
    expect(onSubmit).not.toHaveBeenCalled()
    expect(node.querySelector('textarea')?.value).toBe('Brouillon humain')
  })
})

describe('Home creation and restricted draft restoration', () => {
  const local: LocalChatPresentation = {
    backend: 'local',
    model: 'gpt-4.1',
    blocked: true,
    adopted: false,
    message: null,
    adopt: vi.fn(),
  }
  const legacy: LocalChatPresentation = {
    backend: 'legacy',
    blocked: false,
    adopted: false,
    message: null,
    adopt: vi.fn(),
  }
  const draftKey = 'ws-1:workflow-copilot:wf-created:new'
  afterEach(() => useMothershipDraftsStore.getState().reset())
  it('offers explicit draft creation without submitting or clearing the text', async () => {
    const create = vi.fn(async (_text: string, _isCurrent: () => boolean) => true)
    const { node, onSubmit } = render(
      vi.fn(() => true),
      local,
      { workflowDraft: { available: true, pending: false, message: null, create } }
    )
    const button = Array.from(node.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Créer un workflow avec ce brouillon')
    )
    expect(button).toBeDefined()
    await act(async () => button!.click())
    expect(create).toHaveBeenCalledOnce()
    expect(create.mock.calls[0][0]).toBe('Brouillon humain')
    expect(onSubmit).not.toHaveBeenCalled()
    expect(node.querySelector('textarea')?.value).toBe('Brouillon humain')
    expect(node.textContent).toContain('Aucun message envoyé automatiquement')
  })
  it.each([true, false, null, 'local'])(
    'preserves a persisted restriction %s across rehydration and blocks legacy Enter/click',
    async (marker) => {
      useMothershipDraftsStore
        .getState()
        .setDraft(draftKey, { text: 'Brouillon humain', localOrigin: marker })
      const serialized = localStorage.getItem('mothership-drafts:v1')!
      useMothershipDraftsStore.getState().reset()
      localStorage.setItem('mothership-drafts:v1', serialized)
      await useMothershipDraftsStore.persist.rehydrate()
      const { node, onSubmit } = render(
        vi.fn(() => true),
        legacy,
        { draftScopeKey: draftKey }
      )
      act(() => node.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')?.click())
      act(() =>
        node
          .querySelector('textarea')!
          .dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
          )
      )
      expect(onSubmit).not.toHaveBeenCalled()
      expect(node.querySelector('textarea')?.value).toBe('Brouillon humain')
      expect(node.textContent).toContain('brouillon local')
      expect(useMothershipDraftsStore.getState().drafts[draftKey]).toHaveProperty(
        'localOrigin',
        marker
      )
    }
  )
  it('requires explicit local resumption for a malformed marker, never treating it as an adoption', async () => {
    useMothershipDraftsStore
      .getState()
      .setDraft(draftKey, { text: 'Brouillon humain', localOrigin: false })
    const adopt = vi.fn()
    const { node, onSubmit } = render(
      vi.fn(() => false),
      { ...local, blocked: false, adopted: true, adopt },
      { draftScopeKey: draftKey }
    )
    act(() => node.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')?.click())
    expect(onSubmit).not.toHaveBeenCalled()
    const resume = Array.from(node.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Reprendre ce brouillon local')
    )
    expect(resume).toBeDefined()
    act(() => resume!.click())
    expect(onSubmit).not.toHaveBeenCalled()
    expect(adopt).not.toHaveBeenCalled()
    expect(useMothershipDraftsStore.getState().drafts[draftKey]?.localOrigin).toBe(true)
    act(() => node.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')?.click())
    expect(onSubmit).toHaveBeenCalledOnce()
  })
})

describe('local draft write → read → remount', () => {
  const key = 'ws-1:workflow-copilot:created:new'
  const local: LocalChatPresentation = {
    backend: 'local',
    blocked: true,
    adopted: false,
    message: null,
    adopt: vi.fn(),
  }
  afterEach(() => useMothershipDraftsStore.getState().reset())
  it('keeps origin after an edit and remount with a changed profile; Enter cannot send', async () => {
    useMothershipDraftsStore
      .getState()
      .setDraft(key, { text: 'Brouillon humain', localOrigin: true })
    const first = render(
      vi.fn(() => true),
      local,
      { draftScopeKey: key }
    )
    const editor = first.node.querySelector('textarea')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        editor,
        'Intention modifiée'
      )
      editor.dispatchEvent(new Event('input', { bubbles: true }))
    })
    act(() => roots.splice(0).forEach((root) => root.unmount()))
    expect(useMothershipDraftsStore.getState().drafts[key]).toEqual(
      expect.objectContaining({ text: 'Intention modifiée', localOrigin: true })
    )
    const serialized = localStorage.getItem('mothership-drafts:v1')!
    useMothershipDraftsStore.getState().reset()
    localStorage.setItem('mothership-drafts:v1', serialized)
    await useMothershipDraftsStore.persist.rehydrate()
    const restored = render(
      vi.fn(() => true),
      { backend: 'legacy', blocked: false, adopted: false, message: null, adopt: vi.fn() },
      { defaultValue: '', draftScopeKey: key }
    )
    expect(restored.node.querySelector('textarea')?.value).toBe('Intention modifiée')
    act(() =>
      restored.node
        .querySelector('textarea')!
        .dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
        )
    )
    expect(restored.onSubmit).not.toHaveBeenCalled()
  })
  it('keeps a legacy draft without a marker on the legacy submission path', () => {
    useMothershipDraftsStore.getState().setDraft(key, { text: 'Brouillon humain' })
    const { node, onSubmit } = render(
      vi.fn(() => false),
      { backend: 'legacy', blocked: false, adopted: false, message: null, adopt: vi.fn() },
      { draftScopeKey: key }
    )
    act(() => node.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!.click())
    expect(onSubmit).toHaveBeenCalledOnce()
  })
})
