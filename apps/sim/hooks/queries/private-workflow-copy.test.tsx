// Copyright 2026 Memlia. All rights reserved.
/** @vitest-environment jsdom */
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { usePrivateWorkflowCopy } from './private-workflow-copy'
import { workflowKeys } from './utils/workflow-keys'

vi.mock('@/lib/api/client-id', () => ({ CLIENT_ID_HEADER: 'x-client-id', getClientId: () => null }))
vi.mock('@/lib/api/client-info', () => ({
  CLIENT_INFO_HEADER: 'x-client-info',
  getClientInfoHeader: () => null,
}))
let root: Root
let client: QueryClient
function mount() {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  let mutation: ReturnType<typeof usePrivateWorkflowCopy>
  function Probe() {
    mutation = usePrivateWorkflowCopy()
    return null
  }
  root = createRoot(document.createElement('div'))
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>
    )
  )
  return () => mutation!
}
afterEach(() => {
  act(() => root?.unmount())
  client?.clear()
})

it('posts only the requested copy, invalidates the destination and preserves source caches', async () => {
  const fetch = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        data: {
          id: 'copy',
          workspaceId: 'personal',
          name: 'Copie privée',
          configurationRequired: true,
        },
      }),
      { status: 201 }
    )
  )
  vi.stubGlobal('fetch', fetch)
  const mutation = mount()
  const source = { fixture: 'source immutable' }
  client.setQueryData(workflowKeys.state('source'), source)
  client.setQueryData(workflowKeys.list('shared'), ['source'])
  client.setQueryData(workflowKeys.list('personal'), [])
  let result: unknown
  await act(async () => {
    result = await mutation().mutateAsync({
      sourceWorkflowId: 'source',
      destinationWorkspaceId: 'personal',
      name: 'Copie privée',
    })
  })
  expect(result).toEqual({
    id: 'copy',
    workspaceId: 'personal',
    name: 'Copie privée',
    configurationRequired: true,
  })
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(fetch.mock.calls[0][0]).toBe('/api/workflows/source/private-copy')
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
    destinationWorkspaceId: 'personal',
    name: 'Copie privée',
  })
  expect(fetch.mock.calls[0][1].method).toBe('POST')
  expect(client.getQueryData(workflowKeys.state('source'))).toEqual(source)
  expect(client.getQueryState(workflowKeys.list('shared'))?.isInvalidated).toBe(false)
  expect(client.getQueryState(workflowKeys.list('personal'))?.isInvalidated).toBe(true)
})

it.each([403, 409, 500])('does not retry or invalidate on server refusal %s', async (status) => {
  const fetch = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ error: 'Copie refusée' }), { status }))
  vi.stubGlobal('fetch', fetch)
  const mutation = mount()
  client.setQueryData(workflowKeys.list('personal'), [])
  await act(async () => {
    await expect(
      mutation().mutateAsync({
        sourceWorkflowId: 'source',
        destinationWorkspaceId: 'personal',
        name: 'Copie',
      })
    ).rejects.toThrow('Copie refusée')
  })
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(client.getQueryState(workflowKeys.list('personal'))?.isInvalidated).toBe(false)
})

it('rejects a mismatched response destination without invalidating any cache', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            id: 'copy',
            workspaceId: 'foreign',
            name: 'Copie',
            configurationRequired: true,
          },
        }),
        { status: 201 }
      )
    )
  )
  const mutation = mount()
  client.setQueryData(workflowKeys.list('personal'), [])
  await act(async () => {
    await expect(
      mutation().mutateAsync({
        sourceWorkflowId: 'source',
        destinationWorkspaceId: 'personal',
        name: 'Copie',
      })
    ).rejects.toThrow()
  })
  expect(client.getQueryState(workflowKeys.list('personal'))?.isInvalidated).toBe(false)
})

it('rejects a name beyond the server bound before any HTTP request', async () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const mutation = mount()
  await act(async () => {
    await expect(
      mutation().mutateAsync({
        sourceWorkflowId: 'source',
        destinationWorkspaceId: 'personal',
        name: 'x'.repeat(101),
      })
    ).rejects.toThrow()
  })
  expect(fetch).not.toHaveBeenCalled()
})

it('does not accept a response that marks the copy ready for execution', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            id: 'copy',
            workspaceId: 'personal',
            name: 'Copie',
            configurationRequired: false,
          },
        }),
        { status: 201 }
      )
    )
  )
  const mutation = mount()
  client.setQueryData(workflowKeys.list('personal'), [])
  await act(async () => {
    await expect(
      mutation().mutateAsync({
        sourceWorkflowId: 'source',
        destinationWorkspaceId: 'personal',
        name: 'Copie',
      })
    ).rejects.toThrow()
  })
  expect(client.getQueryState(workflowKeys.list('personal'))?.isInvalidated).toBe(false)
})
