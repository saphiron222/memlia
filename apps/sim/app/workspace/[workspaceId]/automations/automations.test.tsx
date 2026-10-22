/** @vitest-environment jsdom */
// Copyright (c) 2026 Memlia. All rights reserved.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '@/lib/api/client/errors'
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

describe('native capture request panel', () => {
  it('keeps the same request after an ambiguous response and never submits automatically', async () => {
    sessionStorage.clear()
    render()
    expect(fixture.request).not.toHaveBeenCalled()
    fixture.request.mockResolvedValueOnce({
      observedAt: Date.now(),
      devices: [{ agentId: 'agent', observedAt: Date.now(), observation: 'recent', busy: 'idle' }],
      commands: [],
      truncated: false,
    })
    await click('Actualiser mes postes et captures')
    fixture.request.mockRejectedValueOnce(Error('network'))
    await click('Demander cet enregistrement')
    const first = fixture.request.mock.calls.at(-1)![1].body
    expect(first.sessionId).toBeUndefined()
    expect(first.requestId).toMatch(/[0-9a-f-]{36}/)
    expect(host.textContent).toContain('La demande reste à vérifier')
    fixture.request.mockResolvedValueOnce({
      commandId: 'command',
      requestId: first.requestId,
      agentId: 'agent',
      status: 'queued',
      outcome: null,
      createdAt: Date.now(),
      exportStatus: 'none',
    })
    await click('Vérifier la même demande')
    expect(fixture.request.mock.calls.at(-1)![1].body).toEqual(first)
    expect(host.textContent).toContain('Consentement local requis')
  })
  it('shows HOLD and offline honestly and does not offer a new capture', async () => {
    sessionStorage.clear()
    render()
    fixture.request.mockResolvedValueOnce({
      observedAt: Date.now(),
      devices: [
        { agentId: 'agent', observedAt: Date.now() - 60000, observation: 'offline', busy: 'hold' },
      ],
      commands: [],
      truncated: false,
    })
    await click('Actualiser mes postes et captures')
    expect(button('Demander cet enregistrement').disabled).toBe(true)
    expect(host.textContent).toContain('Intervention requise')
  })
  it('restores an ambiguous request across remount without POST and rejects account changes', async () => {
    sessionStorage.clear()
    const key = `memlia.capture.request:${JSON.stringify(['ws-1', 'user-1'])}`
    const saved = {
      agentId: 'agent',
      requestId: '11111111-1111-4111-8111-111111111111',
      maxDurationSeconds: 60,
      maxBytes: 1024,
    }
    sessionStorage.setItem(key, JSON.stringify(saved))
    render()
    expect(fixture.request).not.toHaveBeenCalled()
    expect(button('Vérifier la même demande')).toBeDefined()
    fixture.sessionUserId = 'another-user'
    render()
    expect(host.textContent).toContain('Reconnectez-vous')
    expect(fixture.request).not.toHaveBeenCalled()
    fixture.sessionUserId = 'user-1'
    render()
    fixture.request.mockResolvedValueOnce({
      commandId: 'same',
      requestId: saved.requestId,
      agentId: 'agent',
      status: 'queued',
      outcome: null,
      createdAt: Date.now(),
      exportStatus: 'none',
    })
    await click('Vérifier la même demande')
    expect(fixture.request.mock.calls.at(-1)![1].body).toEqual(saved)
  })
  it('expires a device observation locally and labels an export as to_test, never ready', async () => {
    sessionStorage.clear()
    render()
    fixture.request.mockResolvedValueOnce({
      observedAt: Date.now(),
      devices: [
        { agentId: 'agent', observedAt: Date.now() - 29000, observation: 'recent', busy: 'idle' },
      ],
      commands: [
        {
          commandId: 'done',
          requestId: null,
          agentId: 'agent',
          status: 'terminal',
          outcome: 'succeeded_verified',
          createdAt: Date.now(),
          exportStatus: 'to_test',
        },
      ],
      truncated: false,
    })
    await click('Actualiser mes postes et captures')
    expect(button('Demander cet enregistrement').disabled).toBe(false)
    act(() => vi.advanceTimersByTime(1001))
    expect(button('Demander cet enregistrement').disabled).toBe(true)
    expect(host.textContent).toContain('Export à tester')
    expect(host.textContent).not.toContain('prêt')
  })
})

describe('personal procedure records UI', () => {
  const procedure = {
    procedureId: '22222222-2222-4222-8222-222222222222',
    revision: 1,
    requestId: '11111111-1111-4111-8111-111111111111',
    commandId: 'capture',
    name: 'Fiche fictive',
    description: 'Description conservée',
    createdAt: 1000,
    status: 'to_test',
  }
  const sources = {
    observedAt: Date.now(),
    devices: [],
    commands: [{ commandId: 'capture', exportStatus: 'to_test' }],
    truncated: false,
  }
  function change(label: string, value: string) {
    const el = host.querySelector(`[aria-label="${label}"]`) as HTMLInputElement | HTMLSelectElement
    expect(el).not.toBeNull()
    act(() => {
      Object.getOwnPropertyDescriptor(
        el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype,
        'value'
      )!.set!.call(el, value)
      el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
    })
  }
  it('personal procedure UI reloads names and history without exposing or executing bytes', async () => {
    sessionStorage.clear()
    render()
    expect(fixture.request).not.toHaveBeenCalled()
    fixture.request
      .mockResolvedValueOnce(sources)
      .mockResolvedValueOnce({ procedures: [procedure], versions: [], truncated: false })
    await click('Actualiser mes procédures')
    expect(host.textContent).toContain('Fiche fictive')
    change('Procédure personnelle', procedure.procedureId)
    expect(
      (host.querySelector('[aria-label="Description de la procédure"]') as HTMLInputElement).value
    ).toBe(procedure.description)
    fixture.request.mockResolvedValueOnce({
      procedures: [procedure],
      versions: [procedure],
      truncated: false,
    })
    await click('Voir les versions')
    expect(host.textContent).toContain('Version 1')
    expect(host.textContent).toContain('À tester')
    expect(button('Partager').disabled).toBe(true)
    expect(button('Demander ce test').disabled).toBe(true)
    expect(fixture.request.mock.calls.every((c) => c[0].method === 'GET')).toBe(true)
  })
  it('personal procedure UI releases a proven no-write conflict but requires a fresh listing', async () => {
    sessionStorage.clear()
    render()
    fixture.request
      .mockResolvedValueOnce(sources)
      .mockResolvedValueOnce({ procedures: [procedure], versions: [], truncated: false })
    await click('Actualiser mes procédures')
    change('Procédure personnelle', procedure.procedureId)
    fixture.request.mockRejectedValueOnce(
      new ApiClientError({
        status: 409,
        message: 'conflict',
        body: { error: 'procedure_revision_conflict' },
      })
    )
    await click('Enregistrer cette version')
    expect(host.textContent).toContain('La fiche a changé')
    expect(button('Enregistrer cette version').disabled).toBe(true)
    expect(fixture.request).toHaveBeenCalledTimes(3)
    expect(
      sessionStorage.getItem(`memlia.procedure.request:${JSON.stringify(['ws-1', 'user-1'])}`)
    ).toBeNull()
  })
  it('personal procedure UI preserves the exact ambiguous save across remount and permission loss', async () => {
    sessionStorage.clear()
    render()
    fixture.request
      .mockResolvedValueOnce(sources)
      .mockResolvedValueOnce({ procedures: [], versions: [], truncated: false })
    await click('Actualiser mes procédures')
    change('Nom de la procédure', 'Fictive')
    change('Description de la procédure', 'Mon descriptif')
    fixture.request.mockRejectedValueOnce(Error('network'))
    await click('Enregistrer cette version')
    const body = fixture.request.mock.calls.at(-1)![1].body
    expect(body).toMatchObject({
      procedureId: null,
      expectedRevision: 0,
      commandId: 'capture',
      name: 'Fictive',
      description: 'Mon descriptif',
    })
    fixture.canEdit = false
    render()
    fixture.canEdit = true
    render()
    expect(button('Vérifier le même enregistrement')).toBeDefined()
    expect(fixture.request).toHaveBeenCalledTimes(3)
    fixture.request.mockResolvedValueOnce({
      ...procedure,
      name: 'Fictive',
      description: 'Mon descriptif',
      requestId: body.requestId,
    })
    await click('Vérifier le même enregistrement')
    expect(fixture.request.mock.calls.at(-1)![1].body).toEqual(body)
  })
})

describe('personal procedure test UI', () => {
  const procedure = {
    procedureId: '22222222-2222-4222-8222-222222222222',
    revision: 2,
    requestId: '11111111-1111-4111-8111-111111111111',
    commandId: 'capture',
    name: 'Procédure fictive',
    description: '',
    createdAt: 1000,
    status: 'to_test',
  }
  const key = `memlia.procedure.test.request:${JSON.stringify(['ws-1', 'user-1'])}`
  const catalog = () => ({
    observedAt: Date.now(),
    devices: [{ agentId: 'agent', observation: 'recent', observedAt: Date.now(), busy: 'idle' }],
    commands: [],
    truncated: false,
  })
  const result = (requestId: string) => ({
    commandId: 'test-command',
    requestId,
    agentId: 'agent',
    status: 'queued',
    outcome: null,
    createdAt: Date.now(),
    exportStatus: 'none',
  })
  function change(label: string, value: string) {
    const el = host.querySelector(`[aria-label="${label}"]`) as HTMLInputElement | HTMLSelectElement
    expect(el).not.toBeNull()
    act(() => {
      Object.getOwnPropertyDescriptor(
        el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype,
        'value'
      )!.set!.call(el, value)
      el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
    })
  }
  async function selectVersion() {
    fixture.request
      .mockResolvedValueOnce(catalog())
      .mockResolvedValueOnce({ procedures: [procedure], versions: [], truncated: false })
    await click('Actualiser mes procédures')
    change('Procédure personnelle', procedure.procedureId)
    change('Version de la procédure à tester', `${procedure.procedureId}:2`)
    fixture.request.mockResolvedValueOnce(catalog())
    await click('Actualiser mes postes et tests')
    change('Poste pour le test', 'agent')
  }
  it('personal test UI requires an explicit version and recent device, persists exact intent before POST', async () => {
    sessionStorage.clear()
    render()
    expect(fixture.request).not.toHaveBeenCalled()
    expect(button('Demander ce test').disabled).toBe(true)
    await selectVersion()
    expect(button('Demander ce test').disabled).toBe(false)
    fixture.request.mockImplementationOnce(async (contract, options) => {
      expect(contract.path).toBe('/api/workspaces/[id]/desktop-agent-procedures/test')
      expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual(options.body)
      expect(options.body).toEqual({
        procedureId: procedure.procedureId,
        revision: 2,
        agentId: 'agent',
        requestId: expect.any(String),
        maxDurationSeconds: 60,
      })
      return result(options.body.requestId)
    })
    await click('Demander ce test')
    expect(host.textContent).toContain('Consentement local requis')
    expect(host.textContent).not.toContain('prête pour la production')
    expect(fixture.request.mock.calls.at(-1)![1].body).not.toHaveProperty('sessionId')
    expect(fixture.request.mock.calls.at(-1)![1].body).not.toHaveProperty('mode')
  })
  it('personal test UI reconciles ambiguous outcomes by GET without another POST across remount', async () => {
    sessionStorage.clear()
    render()
    await selectVersion()
    fixture.request.mockRejectedValueOnce(Error('network'))
    await click('Demander ce test')
    const input = JSON.parse(sessionStorage.getItem(key)!)
    fixture.canEdit = false
    render()
    fixture.canEdit = true
    render()
    expect(fixture.request).toHaveBeenCalledTimes(4)
    fixture.request.mockResolvedValueOnce({ ...catalog(), commands: [result(input.requestId)] })
    await click('Vérifier la demande de test')
    expect(fixture.request.mock.calls.at(-1)![0].method).toBe('GET')
    expect(fixture.request.mock.calls.at(-1)![1].query).toEqual({ requestId: input.requestId })
    expect(sessionStorage.getItem(key)).toBe(JSON.stringify(input))
    expect(fixture.request.mock.calls.filter(([c]) => c.method === 'POST')).toHaveLength(1)
  })
  it('personal test UI refuses persistence failure and expired or held device before any POST', async () => {
    sessionStorage.clear()
    render()
    await selectVersion()
    const store = vi.spyOn(sessionStorage, 'setItem').mockImplementationOnce(() => {
      throw Error('unavailable')
    })
    await click('Demander ce test')
    expect(fixture.request.mock.calls.filter(([c]) => c.method === 'POST')).toHaveLength(0)
    expect(host.textContent).toContain('Aucun test demandé')
    store.mockRestore()
  })
  it('personal test UI expires recent observations and never admits a device in HOLD', async () => {
    sessionStorage.clear()
    render()
    await selectVersion()
    act(() => vi.advanceTimersByTime(30001))
    expect(button('Demander ce test').disabled).toBe(true)
    fixture.request.mockResolvedValueOnce({
      ...catalog(),
      devices: [{ ...catalog().devices[0], busy: 'hold' }],
    })
    await click('Actualiser mes postes et tests')
    expect(button('Demander ce test').disabled).toBe(true)
    expect(host.textContent).toContain('Intervention requise')
  })
  it('personal test UI keeps mismatched receipts uncertain and treats an unverified result as observed only', async () => {
    sessionStorage.clear()
    render()
    await selectVersion()
    fixture.request.mockResolvedValueOnce(result('33333333-3333-4333-8333-333333333333'))
    await click('Demander ce test')
    expect(host.textContent).toContain('Résultat du test à vérifier')
    const input = JSON.parse(sessionStorage.getItem(key)!)
    fixture.request.mockResolvedValueOnce({
      ...catalog(),
      commands: [{ ...result(input.requestId), status: 'terminal', outcome: 'stopped' }],
    })
    await click('Vérifier la demande de test')
    expect(host.textContent).toContain('Test observé — effets non vérifiés')
    expect(host.textContent).not.toContain('Procédure prête')
    expect(button('Partager').disabled).toBe(true)
  })
  it('personal test UI bounds a lost request and never releases an uncertain terminal receipt', async () => {
    sessionStorage.clear()
    render()
    await selectVersion()
    fixture.request.mockImplementationOnce(
      (_contract, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true }
          )
        })
    )
    await click('Demander ce test')
    await act(async () => {
      vi.advanceTimersByTime(30001)
    })
    expect(host.textContent).toContain('Résultat du test à vérifier')
    const input = JSON.parse(sessionStorage.getItem(key)!)
    fixture.request.mockResolvedValueOnce({
      ...catalog(),
      commands: [{ ...result(input.requestId), status: 'terminal', outcome: 'uncertain' }],
    })
    await click('Vérifier la demande de test')
    expect(host.textContent).toContain('Intervention requise — résultat incertain')
    expect(
      [...host.querySelectorAll('button')].some((b) => b.textContent === 'Préparer un autre test')
    ).toBe(false)
    expect(sessionStorage.getItem(key)).not.toBeNull()
    expect(fixture.request.mock.calls.filter(([c]) => c.method === 'POST')).toHaveLength(1)
  })
  it('personal test storage readback refuses a silently ignored write before POST', async () => {
    sessionStorage.clear()
    render()
    await selectVersion()
    const store = vi.spyOn(sessionStorage, 'setItem').mockImplementationOnce(() => undefined)
    try {
      await click('Demander ce test')
      expect(fixture.request.mock.calls.filter(([c]) => c.method === 'POST')).toHaveLength(0)
      expect(sessionStorage.getItem(key)).toBeNull()
      expect(host.textContent).toContain('Aucun test demandé')
      expect(button('Demander ce test').disabled).toBe(true)
    } finally {
      store.mockRestore()
    }
  })
  it('personal test storage canonical readback refuses even JSON-equivalent changed bytes', async () => {
    sessionStorage.clear()
    render()
    await selectVersion()
    const write = sessionStorage.setItem.bind(sessionStorage)
    const store = vi.spyOn(sessionStorage, 'setItem').mockImplementationOnce((name, value) => {
      write(name, `${value} `)
    })
    try {
      await click('Demander ce test')
      expect(fixture.request.mock.calls.filter(([c]) => c.method === 'POST')).toHaveLength(0)
      expect(sessionStorage.getItem(key)).not.toBeNull()
      expect(host.textContent).toContain('Aucun test demandé')
    } finally {
      store.mockRestore()
    }
  })
  it.each([
    { workspace: 'ws-2', user: 'user-1' },
    { workspace: 'ws-1', user: 'another-user' },
  ])(
    'personal test storage readback discards old authority and late result across $workspace/$user',
    async ({ workspace, user }) => {
      sessionStorage.clear()
      render()
      await selectVersion()
      let resolve!: (value: unknown) => void
      fixture.request.mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done
          })
      )
      await click('Demander ce test')
      const previous = fixture.request.mock.calls.at(-1)![1]
      const old = sessionStorage.getItem(key)
      expect(old).not.toBeNull()
      fixture.sessionUserId = user
      render(workspace, user)
      expect(previous.signal.aborted).toBe(true)
      expect(button('Demander ce test').disabled).toBe(true)
      expect(
        host.querySelector<HTMLSelectElement>('[aria-label="Poste pour le test"]')!.options
      ).toHaveLength(1)
      expect(
        host.querySelector<HTMLSelectElement>('[aria-label="Version de la procédure à tester"]')!
          .options
      ).toHaveLength(1)
      await act(async () => {
        resolve(result(previous.body.requestId))
      })
      expect(host.textContent).not.toContain('Consentement local requis')
      expect(host.textContent).not.toContain('Cette demande est conservée')
      expect(sessionStorage.getItem(key)).toBe(old)
      expect(
        sessionStorage.getItem(`memlia.procedure.test.request:${JSON.stringify([workspace, user])}`)
      ).toBeNull()
      expect(fixture.request).toHaveBeenCalledTimes(4)
    }
  )
})
