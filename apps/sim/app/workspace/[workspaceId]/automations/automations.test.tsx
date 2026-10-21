/** @vitest-environment jsdom */
// Copyright (c) 2026 Memlia. All rights reserved.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createEnrollmentContract,
  revokeEnrollmentContract,
} from '@/lib/api/contracts/desktop-agent-enrollment'

const fixture = vi.hoisted(() => ({
  request: vi.fn(),
  canEdit: true,
  loading: false,
  sessionUserId: 'user-1',
}))
vi.mock('@/lib/auth/client', () => ({
  useSession: () => ({
    data: { user: { id: fixture.sessionUserId } },
    isPending: false,
    error: null,
  }),
}))
vi.mock('@/lib/api/client/request', () => ({ requestJson: fixture.request }))
vi.mock('@/app/workspace/[workspaceId]/providers/workspace-permissions-provider', () => ({
  useWorkspacePermissionsContext: () => ({
    userPermissions: {
      canEdit: fixture.canEdit,
      isLoading: fixture.loading,
      error: null,
    },
  }),
}))

import { SoftwareAutomations } from './automations'

let root: Root
let host: HTMLDivElement
const expires = () => Date.now() + 300_000
const receipt = () => ({ enrollmentId: 'binding-1', code: 'q'.repeat(43), expiresAt: expires() })
function render(workspaceId = 'ws-1', userId = 'user-1') {
  act(() => root.render(<SoftwareAutomations workspaceId={workspaceId} userId={userId} />))
}
function button(label: string) {
  const result = [...host.querySelectorAll('button')].find((el) => el.textContent === label)
  expect(result, label).toBeDefined()
  return result!
}
async function click(label: string) {
  await act(async () => {
    button(label).click()
    await Promise.resolve()
  })
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers()
  vi.clearAllMocks()
  fixture.sessionUserId = 'user-1'
  fixture.canEdit = true
  fixture.loading = false
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('native software automation enrollment panel', () => {
  it('serializes create and revoke through the native request client and strict contracts', async () => {
    const native = await vi.importActual<typeof import('@/lib/api/client/request')>(
      '@/lib/api/client/request'
    )
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    fetch.mockResolvedValueOnce(Response.json(receipt()))
    fixture.request.mockImplementationOnce(native.requestJson)
    render()
    await click('Créer un code d’association')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenLastCalledWith(
      '/api/workspaces/ws-1/desktop-agent-enrollments',
      expect.objectContaining({ method: 'POST', body: '{}' })
    )
    expect(host.querySelector('input[aria-label="Code d’association"]')).not.toBeNull()
    fetch.mockResolvedValueOnce(
      Response.json({
        status: 'revoked',
        enrollmentId: 'binding-1',
        certificateRevocation: 'not_issued',
      })
    )
    fixture.request.mockImplementationOnce(native.requestJson)
    await click('Révoquer cette association')
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch).toHaveBeenLastCalledWith(
      '/api/workspaces/ws-1/desktop-agent-enrollments/binding-1/revoke',
      expect.objectContaining({ method: 'POST', body: '{}' })
    )
    expect(host.textContent).toContain('Association révoquée')
  })
  it('does nothing on mount, then creates once using the existing session contract and masks the code', async () => {
    render()
    expect(fixture.request).not.toHaveBeenCalled()
    fixture.request.mockResolvedValueOnce(receipt())
    await click('Créer un code d’association')
    expect(fixture.request).toHaveBeenCalledTimes(1)
    expect(fixture.request).toHaveBeenCalledWith(
      createEnrollmentContract,
      expect.objectContaining({
        params: { id: 'ws-1' },
        body: {},
        query: {},
      })
    )
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Code d’association"]')!
    expect(input.value).toBe('q'.repeat(43))
    expect(input.type).toBe('password')
    await click('Afficher le code')
    expect(input.type).toBe('text')
    expect(input.closest('.ph-no-capture')).not.toBeNull()
    expect(
      host.querySelector('input[aria-label="Identifiant d’association"]')!.closest('.ph-no-capture')
    ).not.toBeNull()
  })
  it('admits one create during two synchronous clicks', async () => {
    let resolve!: (value: unknown) => void
    fixture.request.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    render()
    act(() => {
      const el = button('Créer un code d’association')
      el.click()
      el.click()
    })
    expect(fixture.request).toHaveBeenCalledTimes(1)
    await act(async () => {
      resolve(receipt())
    })
  })
  it('bounds a hung native request and keeps its possible effect uncertain', async () => {
    fixture.request.mockImplementationOnce(
      (_contract, input) =>
        new Promise((_resolve, reject) => {
          input.signal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true }
          )
        })
    )
    render()
    await click('Créer un code d’association')
    await act(async () => {
      vi.advanceTimersByTime(30_001)
      await Promise.resolve()
    })
    expect(host.textContent).toContain('La création n’est pas confirmée')
    expect(button('Créer un code d’association').disabled).toBe(true)
    expect(fixture.request).toHaveBeenCalledTimes(1)
  })
  it('expires the secret locally and keeps only the identifier needed for revocation', async () => {
    fixture.request.mockResolvedValueOnce(receipt())
    render()
    await click('Créer un code d’association')
    await act(async () => {
      vi.advanceTimersByTime(300_001)
    })
    expect(host.querySelector('input[aria-label="Code d’association"]')).toBeNull()
    expect(host.textContent).toContain('Le code a expiré')
    expect(fixture.request).toHaveBeenCalledTimes(1)
    fixture.request.mockResolvedValueOnce({
      status: 'revoked',
      enrollmentId: 'binding-1',
      certificateRevocation: 'not_issued',
    })
    await click('Révoquer cette association')
    expect(fixture.request).toHaveBeenLastCalledWith(
      revokeEnrollmentContract,
      expect.objectContaining({
        params: { id: 'ws-1', enrollmentId: 'binding-1' },
        body: {},
        query: {},
      })
    )
    expect(host.textContent).toContain('Association révoquée')
  })
  it('does not retry a lost create response and requires waiting for its possible expiry', async () => {
    fixture.request.mockRejectedValueOnce(new Error('private diagnostic'))
    render()
    await click('Créer un code d’association')
    expect(host.textContent).toContain('La création n’est pas confirmée')
    expect(host.textContent).not.toContain('private diagnostic')
    expect(button('Créer un code d’association').disabled).toBe(true)
    await act(async () => {
      vi.advanceTimersByTime(300_001)
    })
    expect(button('Créer un code d’association').disabled).toBe(false)
    expect(fixture.request).toHaveBeenCalledTimes(1)
  })
  it('removes the code before revoking and does not call uncertain certificate revocation complete', async () => {
    fixture.request.mockResolvedValueOnce(receipt())
    render()
    await click('Créer un code d’association')
    let resolve!: (value: unknown) => void
    fixture.request.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    await click('Révoquer cette association')
    expect(host.querySelector('input[aria-label="Code d’association"]')).toBeNull()
    await act(async () => {
      resolve({ status: 'revoked', enrollmentId: 'binding-1', certificateRevocation: 'unknown' })
    })
    expect(host.textContent).toContain('La révocation du certificat reste à vérifier')
    expect(host.textContent).not.toContain('Association révoquée')
  })
  it('keeps a lost revoke result uncertain and never retries automatically', async () => {
    fixture.request.mockResolvedValueOnce(receipt())
    render()
    await click('Créer un code d’association')
    fixture.request.mockRejectedValueOnce(new Error('hidden failure'))
    await click('Révoquer cette association')
    await act(async () => {
      vi.advanceTimersByTime(600_000)
    })
    expect(host.textContent).toContain('La révocation n’est pas confirmée')
    expect(host.textContent).not.toContain('hidden failure')
    expect(fixture.request).toHaveBeenCalledTimes(2)
  })
  it('blocks read-only/loading permissions without sending any request', () => {
    fixture.canEdit = false
    render()
    expect(host.querySelector('button')).toBeNull()
    fixture.loading = true
    render()
    expect(host.textContent).toContain('Vérification des permissions')
    expect(fixture.request).not.toHaveBeenCalled()
  })
  it('aborts and discards a late response after workspace change', async () => {
    let resolve!: (value: unknown) => void
    fixture.request.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    render()
    await click('Créer un code d’association')
    const signal = fixture.request.mock.calls[0][1].signal as AbortSignal
    render('ws-2')
    expect(signal.aborted).toBe(true)
    await act(async () => {
      resolve(receipt())
    })
    expect(host.querySelector('input[aria-label="Code d’association"]')).toBeNull()
    expect(button('Créer un code d’association').disabled).toBe(false)
  })
  it('removes a code when the native session changes before server props refresh', async () => {
    fixture.request.mockResolvedValueOnce(receipt())
    render()
    await click('Créer un code d’association')
    fixture.sessionUserId = 'another-user'
    render()
    expect(host.querySelector('input[aria-label="Code d’association"]')).toBeNull()
    expect(host.querySelector('button')).toBeNull()
    expect(host.textContent).toContain('Reconnectez-vous')
  })
  it('discards the displayed code on account or permission change', async () => {
    fixture.request.mockResolvedValueOnce(receipt())
    render()
    await click('Créer un code d’association')
    fixture.sessionUserId = 'user-2'
    render('ws-1', 'user-2')
    expect(host.querySelector('input[aria-label="Code d’association"]')).toBeNull()
    fixture.request.mockResolvedValueOnce(receipt())
    await click('Créer un code d’association')
    fixture.canEdit = false
    render('ws-1', 'user-2')
    expect(host.querySelector('input[aria-label="Code d’association"]')).toBeNull()
  })
})
