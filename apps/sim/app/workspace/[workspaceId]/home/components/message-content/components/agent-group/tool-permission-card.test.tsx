/** @vitest-environment jsdom */
// Copyright (c) 2026 Memlia. All rights reserved.
import { act } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useToolPermissionStore } from '@/stores/tool-permission/store'

const http = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }))
// HTTP delivery only is doubled; the native card, store, schema and DOM are real.
vi.mock('@/lib/api/client/request', () => ({ requestRaw: http.read, requestJson: http.write }))

import { ToolPermissionCard } from './tool-permission-card'

const digest = `sha256:${'a'.repeat(64)}`
const body = JSON.stringify({
  atomic: true,
  expectedRevision: 0,
  operations: [
    {
      operation_type: 'edit',
      block_id: 'block-a',
      params: { name: `<script>not executed</script>${'x'.repeat(900)}` },
    },
  ],
  layout: 'none',
  setBlockEnabled: [{ block_id: 'block-a', enabled: false }],
})
const review = (id = 'proposal-a') => ({
  toolCallId: id,
  workflowId: 'workflow-a',
  workspaceId: 'workspace-a',
  expectedRevision: 0,
  issuedAt: '2026-10-19T12:00:00.000Z',
  expiresAt: '2026-10-19T12:10:00.000Z',
  digest,
  body,
})
let root: Root
let container: HTMLDivElement
let client: QueryClient
const reserved = 'memlia_apply_workflow_proposal'
const button = (text: string) =>
  Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === text)!
async function render(id = 'proposal-a', extra = false) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ToolPermissionCard
          toolCallId={id}
          toolName={reserved}
          displayTitle='Proposal'
          params={{ body: 'UNTRUSTED_STREAM_BODY' }}
        />
        {extra && (
          <>
            <ToolPermissionCard
              toolCallId='ordinary-a'
              toolName='read_file'
              displayTitle='Read A'
            />
            <ToolPermissionCard
              toolCallId='ordinary-b'
              toolName='read_file'
              displayTitle='Read B'
            />
          </>
        )}
      </QueryClientProvider>
    )
  )
}
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-19T12:00:01Z'))
  container = document.createElement('div')
  root = createRoot(container)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  useToolPermissionStore.getState().reset()
  http.read.mockReset().mockResolvedValue({ json: async () => review() })
  http.write.mockReset().mockResolvedValue({
    success: true,
    results: [{ toolCallId: 'proposal-a', decision: 'allow', applied: true }],
  })
})
afterEach(() => {
  act(() => root.unmount())
  client.clear()
  useToolPermissionStore.getState().reset()
  vi.useRealTimers()
})
it('loads an owner review before enabling only the two one-shot controls', async () => {
  http.read.mockReturnValue(new Promise(() => {}))
  await render()
  expect(http.read).toHaveBeenCalledOnce()
  expect(button('Autoriser une fois')?.disabled).toBe(true)
  expect(button('Refuser')?.disabled).toBe(true)
  expect(container.textContent).not.toContain("Don't ask again")
  expect(http.write).not.toHaveBeenCalled()
})
it('displays all exact persisted bytes and metadata rather than truncated stream arguments', async () => {
  await render()
  expect(container.querySelector('pre')?.textContent).toBe(body)
  expect(container.querySelector('script')).toBeNull()
  expect(container.textContent).toContain('workflow-a')
  expect(container.textContent).toContain('Révision : 0')
  expect(container.textContent).toContain(review().expiresAt)
  expect(container.textContent).toContain(digest)
  expect(container.textContent).not.toContain('UNTRUSTED_STREAM_BODY')
  expect(button('Autoriser une fois').disabled).toBe(false)
})
it('posts only the displayed digest and uses the actual first decision returned by the server', async () => {
  http.write.mockResolvedValue({
    success: true,
    results: [{ toolCallId: 'proposal-a', decision: 'skip', applied: false }],
  })
  await render()
  await act(async () => button('Autoriser une fois').click())
  expect(http.write.mock.calls[0][1].body).toEqual({
    decisions: [{ toolCallId: 'proposal-a', decision: 'allow', expectedDigest: digest }],
  })
  expect(container.textContent).toContain('Refus enregistré')
  expect(container.textContent).not.toContain('appliqué')
  expect(button('Autoriser une fois').disabled).toBe(true)
})
it('excludes reserved proposals from the actual ordinary bulk list', async () => {
  await render('proposal-a', true)
  expect(useToolPermissionStore.getState().awaitingIds).toEqual(['ordinary-a', 'ordinary-b'])
  await act(async () => button('Allow all').click())
  expect(
    http.write.mock.calls[0][1].body.decisions.map((d: { toolCallId: string }) => d.toolCallId)
  ).toEqual(['ordinary-a', 'ordinary-b'])
})
it('disables expiry and never sends even at the exact boundary', async () => {
  await render()
  await act(async () => vi.advanceTimersByTimeAsync(599000))
  expect(button('Autoriser une fois').disabled).toBe(true)
  expect(button('Refuser').disabled).toBe(true)
  await act(async () => button('Autoriser une fois').click())
  expect(http.write).not.toHaveBeenCalled()
})
it.each(['load', 'write'])(
  'disables on %s error without retry or invented cancellation',
  async (phase) => {
    if (phase === 'load') http.read.mockRejectedValue(new Error('PRIVATE_CAUSE'))
    else http.write.mockRejectedValue(new Error('PRIVATE_CAUSE'))
    await render()
    if (phase === 'write') await act(async () => button('Autoriser une fois').click())
    expect(button('Autoriser une fois').disabled).toBe(true)
    expect(button('Refuser').disabled).toBe(true)
    expect(container.textContent).not.toContain('PRIVATE_CAUSE')
    expect(container.textContent).not.toContain('annulée')
  }
)
it('does not adopt a late response for a previous proposal identity', async () => {
  let finish!: (v: unknown) => void
  http.read
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    .mockResolvedValueOnce({ json: async () => review('proposal-b') })
  await render()
  const signal = http.read.mock.calls[0][1].signal as AbortSignal
  await render('proposal-b')
  await act(async () => finish({ json: async () => review() }))
  expect(signal.aborted).toBe(true)
  await act(async () => button('Autoriser une fois').click())
  expect(http.write.mock.calls[0][1].body.decisions[0].toolCallId).toBe('proposal-b')
})

it('locks both actions while a decision is pending and never resends on a second click', async () => {
  let finish!: (v: unknown) => void
  http.write.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  await render()
  await act(async () => {
    button('Autoriser une fois').click()
    button('Autoriser une fois').click()
  })
  expect(http.write).toHaveBeenCalledOnce()
  expect(button('Refuser').disabled).toBe(true)
  await act(async () =>
    finish({
      success: true,
      results: [{ toolCallId: 'proposal-a', decision: 'allow', applied: true }],
    })
  )
  expect(container.textContent).toContain('Autorisation enregistrée')
})
it('does not settle the new proposal from an old pending decision after navigation', async () => {
  let finish!: (v: unknown) => void
  http.write.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  await render()
  await act(async () => button('Autoriser une fois').click())
  http.read.mockResolvedValue({ json: async () => review('proposal-b') })
  await render('proposal-b')
  await act(async () =>
    finish({
      success: true,
      results: [{ toolCallId: 'proposal-a', decision: 'allow', applied: true }],
    })
  )
  expect(button('Autoriser une fois').disabled).toBe(false)
  expect(container.textContent).not.toContain('Autorisation enregistrée')
})
it.each(['foreign', 'malformed'])(
  'refuses a %s review response before rendering a body or enabling decisions',
  async (mode) => {
    http.read.mockResolvedValue({
      json: async () =>
        mode === 'foreign' ? review('foreign-id') : { ...review(), sessionId: 'PRIVATE_SESSION' },
    })
    await render()
    expect(container.querySelector('pre')).toBeNull()
    expect(button('Autoriser une fois').disabled).toBe(true)
    expect(container.textContent).not.toContain('PRIVATE_SESSION')
  }
)
