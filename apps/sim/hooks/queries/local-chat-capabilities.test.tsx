/** @vitest-environment jsdom */
// Copyright 2026 Memlia. All rights reserved.
import { act } from 'react'
import { createDeferred } from '@sim/testing/helpers/deferred'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { request } = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('@/lib/api/client/request', () => ({ requestJson: request }))

import { useLocalChatCapabilities } from './local-chat-capabilities'

const roots: Root[] = []
afterEach(() => {
  roots.splice(0).forEach((root) => act(() => root.unmount()))
  request.mockReset()
})
const scopeA = { userId: 'user-a', workspaceId: 'workspace-a', workflowId: 'workflow-a' }
const scopeB = { userId: 'user-a', workspaceId: 'workspace-b', workflowId: 'workflow-b' }
const local = (scope = scopeA) => ({
  version: 1,
  backend: 'local',
  provider: 'openai',
  model: 'admin-model',
  workspaceId: scope.workspaceId,
  workflowId: scope.workflowId,
  modes: ['agent'],
  requiresExistingWorkflow: true,
  requestSupported: true,
  currentWorkflowReference: 'implicit',
  modelSelection: false,
  effort: false,
  attachments: false,
  otherResources: false,
  contexts: false,
  desktop: false,
})
function mount() {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  let result: ReturnType<typeof useLocalChatCapabilities>
  const root = createRoot(document.createElement('div'))
  roots.push(root)
  function Probe({ scope }: { scope: typeof scopeA }) {
    result = useLocalChatCapabilities(scope)
    return null
  }
  const render = (scope = scopeA) =>
    act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <Probe scope={scope} />
        </QueryClientProvider>
      )
    )
  render()
  return {
    render,
    client,
    get result() {
      return result!
    },
  }
}
const flush = async () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
describe('local profile query scope', () => {
  it('blocks while loading instead of adopting a legacy fallback', async () => {
    const pending = createDeferred<unknown>()
    request.mockReturnValue(pending.promise)
    const ui = mount()
    expect(ui.result.status).toBe('loading')
    pending.resolve(local())
    await flush()
    expect(ui.result.status).toBe('ready')
  })
  it('does not adopt the late profile from a former workspace', async () => {
    const a = createDeferred<unknown>()
    const b = createDeferred<unknown>()
    request.mockImplementation((_contract, input) =>
      input.query.workspaceId === 'workspace-a' ? a.promise : b.promise
    )
    const ui = mount()
    ui.render(scopeB)
    a.resolve(local())
    await flush()
    expect(ui.result.status).toBe('loading')
    b.resolve(local(scopeB))
    await flush()
    expect(ui.result.profile).toMatchObject({ workspaceId: 'workspace-b' })
  })
  it('rejects a local profile whose canonical workflow is foreign', async () => {
    request.mockResolvedValue(local(scopeB))
    const ui = mount()
    await flush()
    expect(ui.result.status).toBe('unavailable')
  })
  it('blocks an error even when a previously usable profile remains cached', async () => {
    request.mockResolvedValue(local())
    const ui = mount()
    await flush()
    expect(ui.result.status).toBe('ready')
    request.mockRejectedValue(new Error('private cause'))
    await act(async () => {
      await ui.client.invalidateQueries()
    })
    await flush()
    expect(ui.result.status).toBe('unavailable')
    expect(JSON.stringify(ui.result)).not.toContain('private cause')
  })
  it('does not reuse a cached success while its refresh is paused', async () => {
    request.mockResolvedValue(local())
    const ui = mount()
    await flush()
    expect(ui.result.read().status).toBe('ready')
    const query = ui.client.getQueryCache().find({
      queryKey: ['local-chat-capabilities', scopeA.userId, scopeA.workspaceId, scopeA.workflowId],
    })!
    act(() => query.setState({ fetchStatus: 'paused' }))
    expect(ui.result.read().status).toBe('loading')
  })
  it('requires an identity and does not request a profile for an actorless surface', async () => {
    const ui = mount()
    ui.render({ ...scopeA, userId: '' })
    await flush()
    expect(ui.result.status).toBe('unavailable')
  })
})
