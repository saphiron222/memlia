/** @vitest-environment jsdom */
// Copyright (c) 2026 Memlia. All rights reserved.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const scope = vi.hoisted(() => ({ userId: 'subject', canEdit: true, save: vi.fn() }))
vi.mock('@/lib/uploads/client/download', () => ({ saveBlob: scope.save }))
vi.mock('@/lib/auth/client', () => ({
  useSession: () => ({ data: { user: { id: scope.userId } }, isPending: false, error: null }),
}))
vi.mock('@/app/workspace/[workspaceId]/providers/workspace-permissions-provider', () => ({
  useWorkspacePermissionsContext: () => ({
    userPermissions: { canEdit: scope.canEdit, isLoading: false, error: null },
  }),
}))

import { runExcelTestContract } from '@/lib/api/contracts/excel-test-preparations'
import { queueSessionWorkflowContract } from '@/lib/api/contracts/workflows'
import { ExcelExecution } from './execution'

const prepared = {
  status: 'prepared_for_test' as const,
  workflowId: 'workflow',
  deploymentVersionId: 'version-id',
  version: 2,
  snapshotDigest: `sha256:${'a'.repeat(64)}`,
  executionAvailable: false as const,
  activationAvailable: false as const,
}
const preparation = {
  expectedRevision: 7,
  expectedStateDigest: prepared.snapshotDigest,
  operationId: 'preparation',
}
const active = {
  deploymentVersionId: 'version-id',
  version: 2,
  deployedAt: '2026-10-21T00:00:00.000Z',
}
let host: HTMLDivElement
let root: Root
let fetcher: ReturnType<typeof vi.fn>
let storageFrame: HTMLIFrameElement
const recoveryKey = 'memlia:excel-test-preparation:v1:["subject","space","workflow"]'
function seedRecovery(executionId: string | null = null) {
  sessionStorage.setItem(
    recoveryKey,
    JSON.stringify({
      userId: 'subject',
      workspaceId: 'space',
      workflowId: 'workflow',
      version: 2,
      body: preparation,
      prepared,
      executionId,
    })
  )
}
function render() {
  act(() =>
    root.render(
      <ExcelExecution
        workspaceId='space'
        userId='subject'
        prepared={prepared}
        preparation={preparation}
      />
    )
  )
}
function button(text: string) {
  const result = [...host.querySelectorAll('button')].find((b) => b.textContent === text)
  expect(result, text).toBeTruthy()
  return result!
}
async function click(text: string) {
  await act(async () => {
    button(text).click()
    await Promise.resolve()
  })
}
function reply(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
function agree() {
  act(() => host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click())
}
beforeEach(() => {
  storageFrame = document.createElement('iframe')
  document.body.append(storageFrame)
  vi.stubGlobal('sessionStorage', storageFrame.contentWindow!.sessionStorage)
  sessionStorage.clear()
  seedRecovery()
  scope.save.mockReset()
  scope.userId = 'subject'
  scope.canEdit = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  fetcher = vi.fn(async (url: string, options: RequestInit) => {
    if (url.endsWith('/deployments/2')) return reply({ success: true, activeDeployment: active })
    if (url.endsWith('/deployments'))
      return reply({
        versions: [
          {
            id: active.deploymentVersionId,
            version: 2,
            isActive: true,
            createdAt: active.deployedAt,
          },
        ],
      })
    if (url.endsWith('/excel/test-preparations/run'))
      return reply(
        {
          status: 'queued',
          workflowId: prepared.workflowId,
          deploymentVersionId: prepared.deploymentVersionId,
          snapshotDigest: prepared.snapshotDigest,
          executionId: JSON.parse(options.body as string).executionId,
        },
        202
      )
    if (url.includes('/executions/'))
      return reply({
        executionId: url.split('/executions/')[1].split('?')[0],
        workflowId: 'workflow',
        status: 'completed',
        trigger: 'manual',
        level: 'info',
        startedAt: '2026-10-21',
        endedAt: '2026-10-21',
        totalDurationMs: 1,
        paused: null,
        cost: null,
        error: null,
        finalOutput: null,
        blockOutputs: null,
      })
    if (!url.endsWith('/excel/test-preparations/results')) throw new Error('Unexpected surface')
    const body = JSON.parse(options.body as string)
    return reply({
      status: 'completed',
      workflowId: body.prepared.workflowId,
      deploymentVersionId: body.prepared.deploymentVersionId,
      snapshotDigest: body.prepared.snapshotDigest,
      executionId: body.executionId,
      items: [
        {
          resultFileId: 'file',
          fileName: 'Sortie.xlsx',
          size: 100,
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          resultContentVersion: 1,
        },
      ],
      truncated: false,
    })
  })
  vi.stubGlobal('fetch', fetcher)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  storageFrame.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('teste la version inactive avant activation, relit seulement son résultat, HTTP doublé', async () => {
  render()
  expect(fetcher).not.toHaveBeenCalled()
  expect(button('Tester cette version inactive').disabled).toBe(true)
  expect(host.textContent).not.toContain('Activer cette version')
  agree()
  await click('Tester cette version inactive')
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
    workspaceId: 'space',
    preparation,
    prepared,
    executionId: expect.any(String),
    acknowledgeEffects: true,
  })
  expect(host.textContent).toContain('mise en file')
  expect(host.textContent).not.toContain('Activer cette version')
  await click('Actualiser le résultat')
  expect(host.textContent).toContain('Terminée')
  expect(button('Télécharger Sortie.xlsx')).toBeTruthy()
  const read = fetcher.mock.calls.find((c) => c[0].endsWith('/excel/test-preparations/results'))!
  expect(read[1].method).toBe('POST')
  expect(JSON.parse(read[1].body)).toEqual({
    workspaceId: 'space',
    preparation,
    prepared,
    executionId: JSON.parse(fetcher.mock.calls[0][1].body).executionId,
  })
  expect(fetcher.mock.calls.some((c) => c[0].includes('/office-procedures'))).toBe(false)
  expect(button('Activer cette version').disabled).toBe(true)
  agree()
  await click('Activer cette version')
  await click('Vérifier la version active')
  expect(host.textContent).toContain('Version activée observée')
  expect(fetcher.mock.calls.filter((c) => c[0].endsWith('/deployments/2'))).toHaveLength(1)
  expect(fetcher.mock.calls.every((c) => c[0].startsWith('/api/'))).toBe(true)
})
it('perte de réponse test interdit le renvoi et permet seulement la lecture', async () => {
  render()
  agree()
  fetcher.mockRejectedValueOnce(new Error('private failure'))
  await click('Tester cette version inactive')
  expect(host.textContent).toContain('non confirmé')
  expect(host.textContent).not.toContain('private failure')
  expect(
    [...host.querySelectorAll('button')].some(
      (b) => b.textContent === 'Tester cette version inactive'
    )
  ).toBe(false)
  await click('Actualiser le résultat')
  expect(
    fetcher.mock.calls.filter((c) => c[0].endsWith('/excel/test-preparations/run'))
  ).toHaveLength(1)
})
it('perte du compte ou du droit masque le test tardif et interdit les actions', async () => {
  render()
  agree()
  let finish!: (response: Response) => void
  fetcher.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve
      })
  )
  await click('Tester cette version inactive')
  scope.userId = 'other'
  render()
  await act(async () =>
    finish(
      reply(
        {
          status: 'queued',
          workflowId: 'workflow',
          deploymentVersionId: 'version-id',
          snapshotDigest: prepared.snapshotDigest,
          executionId: 'late',
        },
        202
      )
    )
  )
  expect(host.textContent).not.toContain('mise en file')
  expect(host.querySelector('button')).toBeNull()
  scope.save.mockReset()
  scope.userId = 'subject'
  scope.canEdit = false
  render()
  expect(host.querySelector('button')).toBeNull()
})
it('un résultat d’une autre version ne permet jamais l’activation', async () => {
  render()
  agree()
  await click('Tester cette version inactive')
  const original = fetcher.getMockImplementation()!
  fetcher.mockImplementation(async (url: string, options: RequestInit) => {
    const response = await original(url, options)
    if (!url.endsWith('/excel/test-preparations/results')) return response
    const value = await response.json()
    return reply({ ...value, deploymentVersionId: 'different-version' })
  })
  await click('Actualiser le résultat')
  expect(host.textContent).toContain('Observation indisponible')
  expect(host.textContent).not.toContain('Activer cette version')
  expect(host.textContent).not.toContain('Télécharger Sortie.xlsx')
})
it('contrat test fermé interdit le brouillon, les options de service et le consentement absent', () => {
  const body = {
    workspaceId: 'space',
    preparation,
    prepared,
    executionId: 'stable',
    acknowledgeEffects: true,
  }
  expect(runExcelTestContract.body.safeParse(body).success).toBe(true)
  for (const key of [
    'useDraftState',
    'workflowStateOverride',
    'excelTestExecutionPermit',
    'userId',
    'deploymentVersionId',
  ])
    expect(runExcelTestContract.body.safeParse({ ...body, [key]: true }).success).toBe(false)
  expect(runExcelTestContract.body.safeParse({ ...body, acknowledgeEffects: false }).success).toBe(
    false
  )
})

it('contrat de queue refuse les contrôles brouillon, les options inline et une identité sans portée', () => {
  const schema = queueSessionWorkflowContract.body
  expect(schema.safeParse({ parentWorkspaceId: 'space', isClientSession: true }).success).toBe(true)
  for (const key of [
    'includeFileBase64',
    'useDraftState',
    'deploymentVersionId',
    'workflowStateOverride',
    'executionId',
  ])
    expect(
      schema.safeParse({ parentWorkspaceId: 'space', isClientSession: true, [key]: false }).success
    ).toBe(false)
  expect(schema.safeParse({ parentWorkspaceId: 'space', isClientSession: false }).success).toBe(
    false
  )
  expect(schema.safeParse({}).success).toBe(false)
  expect(
    queueSessionWorkflowContract.headers.safeParse({ 'X-Execution-Mode': 'async' }).success
  ).toBe(false)
})

it('un résultat tronqué est lisible mais ne permet pas l’activation', async () => {
  render()
  agree()
  await click('Tester cette version inactive')
  const original = fetcher.getMockImplementation()!
  fetcher.mockImplementation(async (url: string, options: RequestInit) => {
    const response = await original(url, options)
    if (!url.endsWith('/excel/test-preparations/results')) return response
    return reply({ ...(await response.json()), truncated: true })
  })
  await click('Actualiser le résultat')
  expect(button('Télécharger Sortie.xlsx')).toBeTruthy()
  expect(host.textContent).toContain('tronquée')
  expect(host.textContent).not.toContain('Activer cette version')
})

it('télécharge via POST lié au test et conserve un accord humain distinct', async () => {
  render()
  agree()
  await click('Tester cette version inactive')
  await click('Actualiser le résultat')
  fetcher.mockResolvedValueOnce(
    new Response(new Uint8Array(100), {
      headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-length': '100',
      },
    })
  )
  await click('Télécharger Sortie.xlsx')
  expect(fetcher.mock.calls.at(-1)![0]).toBe(
    '/api/workflows/workflow/excel/test-preparations/results/download'
  )
  expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body)).toMatchObject({
    workspaceId: 'space',
    prepared,
    preparation,
    executionId: expect.any(String),
    expected: { resultFileId: 'file', size: 100 },
  })
  expect(scope.save).toHaveBeenCalledExactlyOnceWith(expect.any(Blob), 'Sortie.xlsx')
  expect(host.textContent).toContain('ne confirme pas sa lecture')
  expect(button('Activer cette version').disabled).toBe(true)
  expect(fetcher.mock.calls.some((c) => c[0].endsWith('/deployments/2'))).toBe(false)
})
it('annule un téléchargement dépassant les octets annoncés et ne crée aucun fichier', async () => {
  render()
  agree()
  await click('Tester cette version inactive')
  await click('Actualiser le résultat')
  const cancel = vi.fn()
  fetcher.mockResolvedValueOnce(
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(101))
        },
        cancel,
      }),
      {
        headers: {
          'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'content-length': '100',
        },
      }
    )
  )
  await click('Télécharger Sortie.xlsx')
  expect(cancel).toHaveBeenCalled()
  expect(scope.save).not.toHaveBeenCalled()
  expect(host.textContent).not.toContain('Activer cette version')
  expect(host.textContent).toContain('Observation indisponible')
})

it('une nouvelle lecture du résultat exige un nouvel accord d’activation', async () => {
  render()
  agree()
  await click('Tester cette version inactive')
  await click('Actualiser le résultat')
  agree()
  expect(button('Activer cette version').disabled).toBe(false)
  await click('Actualiser le résultat')
  expect(button('Activer cette version').disabled).toBe(true)
})
it('un téléchargement tardif après changement de compte ne sauvegarde pas de fichier', async () => {
  render()
  agree()
  await click('Tester cette version inactive')
  await click('Actualiser le résultat')
  let finish!: (response: Response) => void
  fetcher.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve
      })
  )
  await click('Télécharger Sortie.xlsx')
  scope.userId = 'foreign'
  render()
  await act(async () =>
    finish(
      new Response(new Uint8Array(100), {
        headers: {
          'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'content-length': '100',
        },
      })
    )
  )
  expect(scope.save).not.toHaveBeenCalled()
  expect(host.querySelector('button')).toBeNull()
})

function reloadExecution() {
  act(() => root.render(null))
  render()
}
it('reprise reload — persiste avant envoi puis relit le même test sans renvoi ni accord restauré', async () => {
  render()
  agree()
  let captured: unknown
  fetcher.mockImplementationOnce(async () => {
    captured = JSON.parse(sessionStorage.getItem(recoveryKey)!)
    throw new Error('unknown-acceptance')
  })
  await click('Tester cette version inactive')
  const id = JSON.parse(fetcher.mock.calls[0][1].body).executionId
  expect(captured).toMatchObject({ executionId: id })
  reloadExecution()
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(host.textContent).not.toContain('Tester cette version inactive')
  expect(host.textContent).not.toContain('Télécharger Sortie.xlsx')
  expect(host.textContent).not.toContain('Activer cette version')
  await click('Actualiser le résultat')
  expect(fetcher.mock.calls[1][0]).toContain(`/executions/${id}?`)
  expect(JSON.parse(fetcher.mock.calls[2][1].body).executionId).toBe(id)
  expect(button('Activer cette version').disabled).toBe(true)
  agree()
  expect(button('Activer cette version').disabled).toBe(false)
  reloadExecution()
  expect(fetcher).toHaveBeenCalledTimes(3)
  expect(host.textContent).not.toContain('Activer cette version')
  expect(host.textContent).not.toContain('Télécharger Sortie.xlsx')
  await click('Actualiser le résultat')
  expect(button('Activer cette version').disabled).toBe(true)
  expect(
    fetcher.mock.calls.filter(([url]) => url.endsWith('/excel/test-preparations/run'))
  ).toHaveLength(1)
})
it('reprise reload — stockage refusé avant test interdit tout transport et garde le binding', async () => {
  render()
  agree()
  const original = sessionStorage.getItem(recoveryKey)
  vi.spyOn(Object.getPrototypeOf(sessionStorage), 'setItem').mockImplementation(() => {
    throw new Error('private-storage')
  })
  await click('Tester cette version inactive')
  expect(fetcher).not.toHaveBeenCalled()
  expect(sessionStorage.getItem(recoveryKey)).toBe(original)
  expect(host.textContent).not.toContain('private-storage')
})
it('reprise reload — écriture ambiguë puis remontage ne choisit jamais un second identifiant', async () => {
  render()
  agree()
  const original = sessionStorage.getItem.bind(sessionStorage)
  const denied = vi
    .spyOn(Object.getPrototypeOf(sessionStorage), 'getItem')
    .mockImplementation((key: string) => {
      const value = original(key)
      if (value && JSON.parse(value).executionId) throw new Error('readback-failed')
      return value
    })
  await click('Tester cette version inactive')
  expect(fetcher).not.toHaveBeenCalled()
  denied.mockRestore()
  const id = JSON.parse(original(recoveryKey)!).executionId
  expect(id).toEqual(expect.any(String))
  reloadExecution()
  expect(host.textContent).not.toContain('Tester cette version inactive')
  await click('Actualiser le résultat')
  expect(fetcher.mock.calls[0][0]).toContain(`/executions/${id}?`)
  expect(fetcher.mock.calls.some(([url]) => url.endsWith('/excel/test-preparations/run'))).toBe(
    false
  )
})
it('reprise reload — cache altéré ou reçu sans bonne portée interdit les actions', () => {
  const record = JSON.parse(sessionStorage.getItem(recoveryKey)!)
  sessionStorage.setItem(recoveryKey, JSON.stringify({ ...record, userId: 'foreign' }))
  render()
  expect(host.querySelector('button')).toBeNull()
  expect(host.textContent).toContain('indice de reprise')
  expect(fetcher).not.toHaveBeenCalled()
})
it('reprise reload — refus serveur du CAS restauré ne rend ni résultat ni activation', async () => {
  seedRecovery('saved-run')
  render()
  const original = fetcher.getMockImplementation()!
  fetcher.mockImplementation(async (url, options) =>
    url.endsWith('/excel/test-preparations/results')
      ? reply({ error: 'excel_test_execution_refused' }, 409)
      : original(url, options)
  )
  await click('Actualiser le résultat')
  expect(host.textContent).toContain('Observation indisponible')
  expect(host.textContent).not.toContain('Activer cette version')
  expect(host.textContent).not.toContain('Télécharger Sortie.xlsx')
  expect(fetcher.mock.calls.some(([url]) => url.endsWith('/excel/test-preparations/run'))).toBe(
    false
  )
})
it('reprise reload — révocation pendant la relecture ignore le résultat tardif', async () => {
  seedRecovery('saved-run')
  render()
  let finish!: (response: Response) => void
  fetcher.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve
      })
  )
  await click('Actualiser le résultat')
  const signal = fetcher.mock.calls[0][1].signal
  scope.canEdit = false
  render()
  expect(signal.aborted).toBe(true)
  await act(async () => finish(reply({ error: 'late' }, 409)))
  expect(host.querySelector('button')).toBeNull()
  scope.canEdit = true
  render()
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(host.textContent).not.toContain('Tester cette version inactive')
  expect(host.textContent).not.toContain('Activer cette version')
})
it('reprise reload — remplacement concurrent après lecture retire résultats et accord sans activation', async () => {
  seedRecovery('saved-run')
  render()
  await click('Actualiser le résultat')
  agree()
  sessionStorage.setItem(recoveryKey, 'changed')
  await click('Activer cette version')
  expect(host.textContent).not.toContain('Télécharger Sortie.xlsx')
  expect(host.textContent).not.toContain('Activer cette version')
  expect(fetcher.mock.calls.some(([url]) => url.endsWith('/deployments/2'))).toBe(false)
  expect(sessionStorage.getItem(recoveryKey)).toBe('changed')
})
