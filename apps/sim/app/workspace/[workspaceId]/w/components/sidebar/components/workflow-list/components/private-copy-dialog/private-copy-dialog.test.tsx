// Copyright 2026 Memlia. All rights reserved.
/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PrivateCopyDialog } from './private-copy-dialog'

const state = vi.hoisted(() => ({
  userId: 'human',
  userPresent: true,
  workspaces: [] as Array<Record<string, unknown>>,
  loading: false,
  error: false,
  push: vi.fn(),
  close: vi.fn(),
}))
vi.mock('@/lib/auth/client', () => ({
  useSession: () => ({
    data: { user: state.userPresent ? { id: state.userId } : null },
    isPending: false,
  }),
}))
vi.mock('@/hooks/queries/workspace', () => ({
  useWorkspacesQuery: () => ({
    data: state.workspaces,
    isPending: state.loading,
    isError: state.error,
    isPlaceholderData: false,
  }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: state.push }) }))
vi.mock('@/lib/api/client-id', () => ({ CLIENT_ID_HEADER: 'x-client-id', getClientId: () => null }))
vi.mock('@/lib/api/client-info', () => ({
  CLIENT_INFO_HEADER: 'x-client-info',
  getClientInfoHeader: () => null,
}))
// Native visual primitives are doubled; React state, mutation, contract and requestJson are real.
// These tests do not qualify Radix focus/keyboard behavior or the browser layout.
vi.mock('@sim/emcn', () => ({
  ChipModal: ({ children, srTitle }: { children: ReactNode; srTitle: string }) => (
    <section role='dialog' aria-label={srTitle}>
      {children}
    </section>
  ),
  ChipModalHeader: ({ children, onClose }: { children: ReactNode; onClose: () => void }) => (
    <header>
      {children}
      <button onClick={onClose}>Fermer</button>
    </header>
  ),
  ChipModalBody: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ChipModalDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  ChipModalError: ({ children }: { children: ReactNode }) => <p role='alert'>{children}</p>,
  ChipModalField: ({
    type,
    title,
    value,
    onChange,
    options,
    disabled,
    maxLength,
    error,
  }: {
    type: string
    title: string
    value: string
    onChange: (value: string) => void
    options?: Array<{ value: string; label: string }>
    disabled?: boolean
    maxLength?: number
    error?: string
  }) => (
    <label htmlFor={`fixture-${type}`}>
      {title}
      {type === 'dropdown' ? (
        <select
          id={`fixture-${type}`}
          aria-label={title}
          disabled={disabled}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value=''>Choisir</option>
          {options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={`fixture-${type}`}
          aria-label={title}
          disabled={disabled}
          maxLength={maxLength}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {error && <span role='alert'>{error}</span>}
    </label>
  ),
  ChipModalFooter: ({
    onCancel,
    cancelDisabled,
    primaryAction,
  }: {
    onCancel: () => void
    cancelDisabled: boolean
    primaryAction: { label: string; disabled: boolean; onClick: () => void }
  }) => (
    <footer>
      <button disabled={cancelDisabled} onClick={onCancel}>
        Annuler
      </button>
      <button disabled={primaryAction.disabled} onClick={primaryAction.onClick}>
        {primaryAction.label}
      </button>
    </footer>
  ),
}))
let root: Root
let client: QueryClient
let container: HTMLDivElement
function render(sourceId = 'source') {
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <PrivateCopyDialog
          sourceWorkflowId={sourceId}
          sourceWorkspaceId='shared'
          sourceName='Original'
          onClose={state.close}
        />
      </QueryClientProvider>
    )
  )
}
function button(text: string) {
  return Array.from(container.querySelectorAll('button')).find((x) => x.textContent === text)!
}
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5))
  })
}
function change(selector: string, value: string) {
  const el = container.querySelector(selector) as HTMLInputElement | HTMLSelectElement
  const prototype =
    el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(
      new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })
    )
  })
}
function submit() {
  act(() => button('Créer une copie privée').click())
}
function success() {
  return new Response(
    JSON.stringify({
      data: { id: 'copy', workspaceId: 'personal', name: 'Ma copie', configurationRequired: true },
    }),
    { status: 201 }
  )
}
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  state.userId = 'human'
  state.userPresent = true
  state.loading = false
  state.error = false
  state.workspaces = [
    {
      id: 'personal',
      name: 'Mon espace',
      ownerId: 'human',
      workspaceMode: 'personal',
      organizationId: null,
      archivedAt: null,
    },
    {
      id: 'shared',
      name: 'Source',
      ownerId: 'human',
      workspaceMode: 'personal',
      organizationId: null,
    },
    {
      id: 'foreign',
      name: 'Autre',
      ownerId: 'other',
      workspaceMode: 'personal',
      organizationId: null,
    },
    {
      id: 'organization',
      name: 'Équipe',
      ownerId: 'human',
      workspaceMode: 'personal',
      organizationId: 'org',
    },
    {
      id: 'archived',
      name: 'Archivé',
      ownerId: 'human',
      workspaceMode: 'personal',
      organizationId: null,
      archivedAt: '2026-01-01',
    },
  ]
  state.workspaces.push({
    id: 'legacy-shared',
    name: 'Ancien espace partagé',
    ownerId: 'human',
    organizationId: null,
    workspaceMode: 'grandfathered_shared',
    archivedAt: null,
  })
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  client.clear()
})

it('offers only an owned active personal destination and explains removed settings', () => {
  render()
  expect(Array.from(container.querySelectorAll('option')).map((x) => x.value)).toEqual([
    '',
    'personal',
  ])
  expect(container.textContent).toContain('connexions')
  expect(container.textContent).toContain('paramètres')
  expect(container.textContent).toContain('structure uniquement')
  expect(container.textContent).toContain('contenus sont retirés')
  expect(container.textContent).toContain('blocs personnalisés')
  expect(container.textContent).toContain('Aucune exécution')
  expect(container.querySelector('input')?.maxLength).toBe(100)
  expect(button('Créer une copie privée').disabled).toBe(true)
})

it('offers no destination and cannot submit when the session user is null', () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  state.userPresent = false

  expect(() => render()).not.toThrow()

  expect(Array.from(container.querySelectorAll('option')).map((option) => option.value)).toEqual([
    '',
  ])
  expect(container.querySelector('select')?.disabled).toBe(true)
  expect(button('Créer une copie privée').disabled).toBe(true)
  expect(container.textContent).toContain('Aucun espace personnel')
  submit()
  expect(fetch).not.toHaveBeenCalled()
  expect(state.push).not.toHaveBeenCalled()
})

it('blocks missing destination, empty name, lost eligibility and loading/error states', () => {
  render()
  change('select', 'personal')
  change('input', '   ')
  expect(button('Créer une copie privée').disabled).toBe(true)
  change('input', 'Ma copie')
  expect(button('Créer une copie privée').disabled).toBe(false)
  state.workspaces = []
  render()
  expect(container.textContent).toContain('Aucun espace personnel')
  expect(button('Créer une copie privée').disabled).toBe(true)
  state.loading = true
  render()
  expect(button('Créer une copie privée').disabled).toBe(true)
  state.loading = false
  state.error = true
  render()
  expect(container.textContent).toContain('Impossible de charger')
})

it('submits once while pending and navigates only after a confirmed success', async () => {
  let resolve!: (value: Response) => void
  const fetch = vi.fn(
    () =>
      new Promise<Response>((r) => {
        resolve = r
      })
  )
  vi.stubGlobal('fetch', fetch)
  render()
  change('select', 'personal')
  change('input', 'Ma copie')
  act(() => {
    button('Créer une copie privée').click()
    button('Créer une copie privée').click()
  })
  await flush()
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(state.push).not.toHaveBeenCalled()
  expect(button('Annuler').disabled).toBe(true)
  act(() => button('Fermer').click())
  expect(state.close).not.toHaveBeenCalled()
  expect(container.querySelector('input')?.disabled).toBe(true)
  await act(async () => resolve(success()))
  await flush()
  expect(state.push).toHaveBeenCalledExactlyOnceWith('/workspace/personal/w/copy')
  expect(state.close).toHaveBeenCalledTimes(1)
})

it('shows a refusal without navigating or closing', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ error: 'access_denied' }), { status: 403 }))
  )
  render()
  change('select', 'personal')
  submit()
  await flush()
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('refusé')
  expect(state.push).not.toHaveBeenCalled()
  expect(state.close).not.toHaveBeenCalled()
})

it.each(['session', 'source', 'unmount'])(
  'ignores stale success after a %s change',
  async (kind) => {
    let resolve!: (value: Response) => void
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((r) => {
            resolve = r
          })
      )
    )
    render()
    change('select', 'personal')
    submit()
    await flush()
    if (kind === 'session') {
      state.userId = 'other'
      render()
    }
    if (kind === 'source') render('another-source')
    if (kind === 'unmount') act(() => root.render(null))
    await act(async () => resolve(success()))
    await flush()
    expect(state.push).not.toHaveBeenCalled()
    expect(state.close).not.toHaveBeenCalled()
  }
)

it('blocks a destination that becomes shared after selection', () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  render()
  change('select', 'personal')
  state.workspaces[0].workspaceMode = 'grandfathered_shared'
  render()
  expect(button('Créer une copie privée').disabled).toBe(true)
  submit()
  expect(fetch).not.toHaveBeenCalled()
})
