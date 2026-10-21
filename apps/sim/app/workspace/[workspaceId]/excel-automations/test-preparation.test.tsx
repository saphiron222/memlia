/** @vitest-environment jsdom */
// Copyright (c) 2026 Memlia. All rights reserved.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const rights = vi.hoisted(() => ({ canEdit: true }))
vi.mock('@/app/workspace/[workspaceId]/providers/workspace-permissions-provider', () => ({
  useWorkspacePermissionsContext: () => ({
    userPermissions: { canEdit: rights.canEdit, isLoading: false, error: null },
  }),
}))

import { ExcelTestPreparation } from './test-preparation'

const digest = `sha256:${'a'.repeat(64)}`
const observation = {
  workflowId: 'workflow',
  workspaceId: 'space',
  expectedRevision: 7,
  expectedStateDigest: digest,
}
const receipt = {
  status: 'prepared_for_test',
  workflowId: 'workflow',
  deploymentVersionId: 'opaque-deployment-id',
  version: 1,
  snapshotDigest: digest,
  executionAvailable: false,
  activationAvailable: false,
}
const catalog = {
  status: 'ready' as const,
  items: [{ id: 'workflow', name: 'Synthèse Excel' }],
  remaining: 0,
}
let storageFrame: HTMLIFrameElement
let root: Root
let host: HTMLDivElement
let fetcher: ReturnType<typeof vi.fn>
function render(workspaceId = 'space', userId = 'subject') {
  act(() =>
    root.render(
      <ExcelTestPreparation workspaceId={workspaceId} userId={userId} catalog={catalog} />
    )
  )
}
function button(text: string) {
  const el = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent === text
  )
  expect(el, text).toBeTruthy()
  return el!
}
async function click(text: string) {
  await act(async () => {
    button(text).click()
    await Promise.resolve()
  })
}
function choose() {
  const select = host.querySelector('select')
  expect(select).not.toBeNull()
  act(() => {
    select!.value = 'workflow'
    select!.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
function reply(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
beforeEach(() => {
  // Native test setup replaces storage with an in-memory mock. Use real jsdom Web Storage.
  storageFrame = document.createElement('iframe')
  document.body.append(storageFrame)
  vi.stubGlobal('sessionStorage', storageFrame.contentWindow!.sessionStorage)
  sessionStorage.clear()
  rights.canEdit = true
  fetcher = vi.fn(async (_url, options) => reply(options.method === 'GET' ? observation : receipt))
  vi.stubGlobal('fetch', fetcher)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  storageFrame.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
describe('action Excel native — client/contrat/DOM réels, HTTP doublé', () => {
  it('observe sur clic puis prépare exactement la version affichée, sans exécution', async () => {
    render()
    expect(fetcher).not.toHaveBeenCalled()
    choose()
    await click('Vérifier la version enregistrée')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][0]).toBe(
      '/api/workflows/workflow/excel/test-preparations?workspaceId=space'
    )
    expect(host.textContent).toContain('prête à être préparée')
    await click('Préparer une version de test')
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({
      expectedRevision: 7,
      expectedStateDigest: digest,
      operationId: expect.any(String),
    })
    expect(host.textContent).toContain('préparée pour test')
    expect(host.textContent).toContain('Aucun fichier exécuté')
    expect(host.textContent).not.toContain(digest)
    expect(host.textContent).not.toContain('opaque-deployment-id') // opaque id must not be rendered as an identifier
  })
  it('bloque la préparation sans droit write', () => {
    rights.canEdit = false
    render()
    expect(fetcher).not.toHaveBeenCalled()
    expect(host.textContent).toContain('droit de modification')
  })
  it('ne déduit pas de préparation d’une observation reçue pour un autre workflow', async () => {
    fetcher.mockResolvedValueOnce(reply({ ...observation, workflowId: 'foreign' }))
    render()
    choose()
    await click('Vérifier la version enregistrée')
    expect(
      [...host.querySelectorAll('button')].some(
        (b) => b.textContent === 'Préparer une version de test'
      )
    ).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(host.querySelector('[role="alert"]')).not.toBeNull()
  })
  it('refuse une réponse exposant le graphe au lieu de l’accepter', async () => {
    fetcher.mockResolvedValueOnce(reply({ ...observation, graph: {} }))
    render()
    choose()
    await click('Vérifier la version enregistrée')
    expect(
      [...host.querySelectorAll('button')].some(
        (b) => b.textContent === 'Préparer une version de test'
      )
    ).toBe(false)
  })
  it('une réponse POST perdue conserve le même operationId et les mêmes préconditions pour la reprise explicite', async () => {
    render()
    choose()
    await click('Vérifier la version enregistrée')
    fetcher.mockRejectedValueOnce(new Error('private-unavailable'))
    await click('Préparer une version de test')
    expect(host.textContent).toContain('Résultat non confirmé')
    expect(host.textContent).not.toContain('private-unavailable')
    const original = fetcher.mock.calls[1][1].body
    await click('Vérifier cette préparation')
    expect(fetcher.mock.calls[2][1].body).toBe(original)
    expect(host.textContent).toContain('préparée pour test')
  })
  it('refuse la préparation sur double clic et ne recommence pas automatiquement', async () => {
    render()
    choose()
    await click('Vérifier la version enregistrée')
    let release!: (value: Response) => void
    fetcher.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    act(() => {
      button('Préparer une version de test').click()
      button('Préparer une version de test').click()
    })
    expect(fetcher).toHaveBeenCalledTimes(2)
    await act(async () => release(reply(receipt)))
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('une perte de droit pendant GET interdit le POST et rejette la réponse tardive', async () => {
    let release!: (value: Response) => void
    fetcher.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    render()
    choose()
    await click('Vérifier la version enregistrée')
    rights.canEdit = false
    render()
    await act(async () => release(reply(observation)))
    expect(
      [...host.querySelectorAll('button')].some(
        (b) => b.textContent === 'Préparer une version de test'
      )
    ).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('un changement de sujet/espace invalide l’observation et annule la requête possédée', async () => {
    let release!: (value: Response) => void
    fetcher.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    render()
    choose()
    await click('Vérifier la version enregistrée')
    const signal = fetcher.mock.calls[0][1].signal
    render('other-space', 'other-subject')
    expect(signal.aborted).toBe(true)
    await act(async () => release(reply(observation)))
    expect(
      [...host.querySelectorAll('button')].some(
        (b) => b.textContent === 'Préparer une version de test'
      )
    ).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})

it('réautorise une observation explicite après révocation temporaire sans conserver la réponse tardive', async () => {
  let release!: (value: Response) => void
  fetcher.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  render()
  choose()
  await click('Vérifier la version enregistrée')
  rights.canEdit = false
  render()
  await act(async () => release(reply(observation)))
  rights.canEdit = true
  render()
  await click('Vérifier la version enregistrée')
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(fetcher.mock.calls.every(([, options]) => options.method === 'GET')).toBe(true)
})
it('conserve une réponse de destination étrangère comme résultat incertain sans nouvelle observation', async () => {
  render()
  choose()
  await click('Vérifier la version enregistrée')
  fetcher.mockResolvedValueOnce(reply({ ...receipt, workflowId: 'foreign' }))
  await click('Préparer une version de test')
  expect(host.textContent).toContain('Résultat non confirmé')
  expect(host.textContent).not.toContain('Version 1 préparée')
  expect(fetcher).toHaveBeenCalledTimes(2)
})
it('la version suivante ne reprend que le précédent reçu serveur du même workflow', async () => {
  render()
  choose()
  await click('Vérifier la version enregistrée')
  await click('Préparer une version de test')
  await click('Vérifier la version enregistrée')
  await click('Préparer une version de test')
  expect(JSON.parse(fetcher.mock.calls[3][1].body)).toMatchObject({
    previousTestVersionId: 'opaque-deployment-id',
    expectedRevision: 7,
    expectedStateDigest: digest,
  })
  expect(JSON.parse(fetcher.mock.calls[3][1].body).operationId).not.toBe(
    JSON.parse(fetcher.mock.calls[1][1].body).operationId
  )
})
it('le conflit ne provoque ni nouvelle lecture ni retry automatique', async () => {
  render()
  choose()
  await click('Vérifier la version enregistrée')
  fetcher.mockResolvedValueOnce(reply({ error: 'excel_test_preparation_refused' }, 409))
  await click('Préparer une version de test')
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(host.textContent).toContain('Résultat non confirmé')
  expect(
    [...host.querySelectorAll('button')].some(
      (b) => b.textContent === 'Vérifier la version enregistrée'
    )
  ).toBe(false)
})
it('révocation pendant POST : annule le transport, conserve la même tentative et attend une action après réautorisation', async () => {
  render()
  choose()
  await click('Vérifier la version enregistrée')
  let release!: (value: Response) => void
  fetcher.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  await click('Préparer une version de test')
  const original = fetcher.mock.calls[1][1].body
  const signal = fetcher.mock.calls[1][1].signal
  rights.canEdit = false
  render()
  expect(signal.aborted).toBe(true)
  await act(async () => release(reply(receipt)))
  expect(host.textContent).toContain('Résultat non confirmé')
  expect(host.textContent).not.toContain('Version 1 préparée')
  expect(button('Vérifier cette préparation').disabled).toBe(true)
  rights.canEdit = true
  render()
  expect(fetcher).toHaveBeenCalledTimes(2)
  await click('Vérifier cette préparation')
  expect(fetcher.mock.calls[2][1].body).toBe(original)
})
it('remontage après POST : aucun renvoi, résultat antérieur non attesté et limite de conservation visible', async () => {
  render()
  choose()
  await click('Vérifier la version enregistrée')
  let release!: (value: Response) => void
  fetcher.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  await click('Préparer une version de test')
  const signal = fetcher.mock.calls[1][1].signal
  act(() => root.render(null))
  expect(signal.aborted).toBe(true)
  render()
  choose()
  await act(async () => release(reply(receipt)))
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(host.textContent).not.toContain('Version 1 préparée')
  expect(host.textContent).toContain(
    'Après rechargement dans cet onglet, choisissez le même workflow pour vérifier manuellement'
  )
})

const recoveryKey = 'memlia:excel-test-preparation:v1:["subject","space","workflow"]'
function remount() {
  act(() => root.render(null))
  render()
  choose()
}
it('recharge un POST dont le COMMIT est possible, sans réseau, puis reprend exactement le CAS et l’opération', async () => {
  render()
  choose()
  await click('Vérifier la version enregistrée')
  fetcher.mockRejectedValueOnce(new Error('response-lost-after-possible-commit'))
  await click('Préparer une version de test')
  const body = fetcher.mock.calls[1][1].body
  remount()
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(host.textContent).toContain('Résultat non confirmé')
  await click('Vérifier cette préparation')
  expect(fetcher.mock.calls[2][1].body).toBe(body)
  expect(fetcher.mock.calls[2][1].method).toBe('POST')
  expect(sessionStorage.getItem(recoveryKey)).toBeNull()
  remount()
  expect(host.textContent).not.toContain('Résultat non confirmé')
  expect(fetcher).toHaveBeenCalledTimes(3)
})
it('persiste le corps fermé avant le premier transport et ne stocke ni reçu ni graphe', async () => {
  render()
  choose()
  await click('Vérifier la version enregistrée')
  expect(sessionStorage.length).toBe(0)
  let persisted: string | null = null
  fetcher.mockImplementationOnce(async () => {
    persisted = sessionStorage.getItem(recoveryKey)
    throw new Error('response-lost')
  })
  await click('Préparer une version de test')
  expect(persisted).not.toBeNull()
  expect(JSON.parse(persisted!)).toEqual({
    version: 1,
    userId: 'subject',
    workspaceId: 'space',
    workflowId: 'workflow',
    body: JSON.parse(fetcher.mock.calls[1][1].body),
  })
})
it('une écriture sessionStorage refusée interdit le POST et permet une reprise explicite après réparation du stockage', async () => {
  render()
  choose()
  await click('Vérifier la version enregistrée')
  const denied = vi
    .spyOn(Object.getPrototypeOf(sessionStorage), 'setItem')
    .mockImplementation(() => {
      throw new Error('private-storage-denial')
    })
  await click('Préparer une version de test')
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(host.textContent).toContain('stockage de cet onglet')
  expect(host.textContent).not.toContain('private-storage-denial')
  denied.mockRestore()
  await click('Préparer une version de test')
  expect(fetcher).toHaveBeenCalledTimes(2)
})
it('une entrée corrompue interdit observation et POST sans effacer la preuve locale', () => {
  sessionStorage.setItem(recoveryKey, '{broken-private-content')
  render()
  choose()
  expect(host.textContent).toContain('Impossible de vérifier ici')
  expect(host.textContent).not.toContain('broken-private-content')
  for (const button of host.querySelectorAll<HTMLButtonElement>('button')) {
    act(() => button.click())
  }
  expect(fetcher).not.toHaveBeenCalled()
  expect(sessionStorage.getItem(recoveryKey)).toBe('{broken-private-content')
})
it('un reçu tardif ne supprime pas une autre opération placée dans le même emplacement', async () => {
  render()
  choose()
  await click('Vérifier la version enregistrée')
  let release!: (value: Response) => void
  fetcher.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  await click('Préparer une version de test')
  const raw = sessionStorage.getItem(recoveryKey)
  expect(raw).not.toBeNull()
  const other = JSON.parse(raw!)
  other.body.operationId = 'another-owned-operation'
  const replacement = JSON.stringify(other)
  sessionStorage.setItem(recoveryKey, replacement)
  await act(async () => release(reply(receipt)))
  expect(sessionStorage.getItem(recoveryKey)).toBe(replacement)
  expect(host.textContent).not.toContain('Version 1 préparée')
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it.each(['user', 'workspace', 'workflow'] as const)(
  'la reprise ne traverse pas une autre portée %s',
  async (dimension) => {
    render()
    choose()
    await click('Vérifier la version enregistrée')
    fetcher.mockRejectedValueOnce(new Error('lost'))
    await click('Préparer une version de test')
    const original = sessionStorage.getItem(recoveryKey)
    act(() => root.render(null))
    if (dimension === 'workflow') {
      act(() =>
        root.render(
          <ExcelTestPreparation
            workspaceId='space'
            userId='subject'
            catalog={{ ...catalog, items: [{ id: 'other-workflow', name: 'Autre' }] }}
          />
        )
      )
      act(() => {
        const select = host.querySelector('select')!
        select.value = 'other-workflow'
        select.dispatchEvent(new Event('change', { bubbles: true }))
      })
    } else {
      render(
        dimension === 'workspace' ? 'other-space' : 'space',
        dimension === 'user' ? 'other-subject' : 'subject'
      )
      choose()
    }
    expect(host.textContent).not.toContain('Résultat non confirmé')
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(sessionStorage.getItem(recoveryKey)).toBe(original)
  }
)
it('une réponse invalide reste récupérable après rechargement avec ses préconditions exactes', async () => {
  render()
  choose()
  await click('Vérifier la version enregistrée')
  fetcher.mockResolvedValueOnce(reply({ ...receipt, activationAvailable: true }))
  await click('Préparer une version de test')
  const original = fetcher.mock.calls[1][1].body
  const stored = sessionStorage.getItem(recoveryKey)
  remount()
  expect(sessionStorage.getItem(recoveryKey)).toBe(stored)
  expect(fetcher).toHaveBeenCalledTimes(2)
  await click('Vérifier cette préparation')
  expect(fetcher.mock.calls[2][1].body).toBe(original)
})
it('un POST révoqué puis démonté conserve sa reprise malgré un reçu tardif, sans nouvelle autorité', async () => {
  render()
  choose()
  await click('Vérifier la version enregistrée')
  let release!: (value: Response) => void
  fetcher.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  await click('Préparer une version de test')
  const original = fetcher.mock.calls[1][1].body
  const stored = sessionStorage.getItem(recoveryKey)
  rights.canEdit = false
  render()
  expect(fetcher.mock.calls[1][1].signal.aborted).toBe(true)
  act(() => root.render(null))
  render()
  await act(async () => release(reply(receipt)))
  expect(sessionStorage.getItem(recoveryKey)).toBe(stored)
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(host.querySelector('select')!.disabled).toBe(true)
  rights.canEdit = true
  render()
  choose()
  expect(host.textContent).toContain('Résultat non confirmé')
  expect(fetcher).toHaveBeenCalledTimes(2)
  await click('Vérifier cette préparation')
  expect(fetcher.mock.calls[2][1].body).toBe(original)
})
it('la récupération manuelle ne double pas le POST même sur deux clics', async () => {
  render()
  choose()
  await click('Vérifier la version enregistrée')
  fetcher.mockRejectedValueOnce(new Error('lost'))
  await click('Préparer une version de test')
  remount()
  let release!: (value: Response) => void
  fetcher.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  const retry = button('Vérifier cette préparation')
  act(() => {
    retry.click()
    retry.click()
  })
  expect(fetcher).toHaveBeenCalledTimes(3)
  await act(async () => release(reply(receipt)))
  expect(sessionStorage.getItem(recoveryKey)).toBeNull()
})
it('une autre tentative apparue après observation interdit le POST et n’est pas écrasée', async () => {
  render()
  choose()
  await click('Vérifier la version enregistrée')
  const foreign = JSON.stringify({
    version: 1,
    userId: 'subject',
    workspaceId: 'space',
    workflowId: 'workflow',
    body: { expectedRevision: 3, expectedStateDigest: digest, operationId: 'other' },
  })
  sessionStorage.setItem(recoveryKey, foreign)
  await click('Préparer une version de test')
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(sessionStorage.getItem(recoveryKey)).toBe(foreign)
  remount()
  expect(fetcher).toHaveBeenCalledTimes(1)
  await click('Vérifier cette préparation')
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({
    expectedRevision: 3,
    expectedStateDigest: digest,
    operationId: 'other',
  })
})
it('une lecture storage refusée au montage bloque tout réseau sans supprimer les données', () => {
  const denied = vi
    .spyOn(Object.getPrototypeOf(sessionStorage), 'getItem')
    .mockImplementation(() => {
      throw new Error('private-read')
    })
  render()
  choose()
  expect(host.textContent).toContain('Impossible de vérifier ici')
  expect(host.textContent).not.toContain('private-read')
  expect(fetcher).not.toHaveBeenCalled()
  expect(host.querySelector('button')).toBeNull()
  denied.mockRestore()
})
it('un retrait refusé après reçu ne permet ni nouvelle opération ni faux acquittement local', async () => {
  render()
  choose()
  await click('Vérifier la version enregistrée')
  vi.spyOn(Object.getPrototypeOf(sessionStorage), 'removeItem').mockImplementation(() => {
    throw new Error('private-remove')
  })
  await click('Préparer une version de test')
  expect(host.textContent).toContain('Impossible de vérifier ici')
  expect(host.textContent).not.toContain('Version 1 préparée')
  expect(sessionStorage.getItem(recoveryKey)).not.toBeNull()
  expect(host.querySelector('button')).toBeNull()
  expect(fetcher).toHaveBeenCalledTimes(2)
})
