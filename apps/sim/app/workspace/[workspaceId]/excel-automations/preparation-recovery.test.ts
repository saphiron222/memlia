/** @vitest-environment jsdom */
// Copyright (c) 2026 Memlia. All rights reserved.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearPreparationRecovery,
  persistExecutionRecovery,
  persistPreparationRecovery,
  readPreparationRecovery,
  readPreparedRecovery,
  retainPreparedRecovery,
} from './preparation-recovery'

const scope = { userId: 'subject', workspaceId: 'space', workflowId: 'workflow' }
const key = 'memlia:excel-test-preparation:v1:["subject","space","workflow"]'
const body = {
  expectedRevision: 7,
  expectedStateDigest: `sha256:${'a'.repeat(64)}`,
  operationId: 'operation-owned',
}
const entry = JSON.stringify({ ...scope, version: 1, body })
let frame: HTMLIFrameElement
beforeEach(() => {
  frame = document.createElement('iframe')
  document.body.append(frame)
  vi.stubGlobal('sessionStorage', frame.contentWindow!.sessionStorage)
  sessionStorage.clear()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  frame.remove()
})

describe('reprise dédiée Excel — Web Storage jsdom réel', () => {
  it('isole sujet, espace et workflow, y compris les délimiteurs dans un sujet', () => {
    sessionStorage.setItem(key, entry)
    for (const foreign of [
      { ...scope, userId: 'foreign' },
      { ...scope, workspaceId: 'foreign' },
      { ...scope, workflowId: 'foreign' },
    ]) {
      expect(readPreparationRecovery(foreign)).toEqual({ status: 'empty' })
    }
    expect(
      persistPreparationRecovery({ ...scope, userId: 'subject:space' }, body, null).status
    ).toBe('saved')
    expect(sessionStorage.getItem(key)).toBe(entry)
    expect(readPreparationRecovery(scope)).toEqual({ status: 'pending', entry, body })
  })
  it.each([
    ['JSON', '{'],
    ['null', 'null'],
    ['array', '[]'],
    ['version', JSON.stringify({ ...scope, version: 2, body })],
    ['foreign subject', JSON.stringify({ ...scope, userId: 'foreign', version: 1, body })],
    ['foreign workspace', JSON.stringify({ ...scope, workspaceId: 'foreign', version: 1, body })],
    ['foreign workflow', JSON.stringify({ ...scope, workflowId: 'foreign', version: 1, body })],
    ['extra field', JSON.stringify({ ...scope, version: 1, body, receipt: {} })],
    [
      'extra body field',
      JSON.stringify({ ...scope, version: 1, body: { ...body, authorization: true } }),
    ],
    [
      'negative revision',
      JSON.stringify({ ...scope, version: 1, body: { ...body, expectedRevision: -1 } }),
    ],
    [
      'unsafe revision',
      JSON.stringify({
        ...scope,
        version: 1,
        body: { ...body, expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
      }),
    ],
    [
      'digest',
      JSON.stringify({ ...scope, version: 1, body: { ...body, expectedStateDigest: 'invalid' } }),
    ],
    [
      'operation',
      JSON.stringify({ ...scope, version: 1, body: { ...body, operationId: 'operation\n' } }),
    ],
    ['oversized text', entry.padEnd(4097, ' ')],
    ['oversized UTF8', JSON.stringify({ ...scope, version: 1, body }) + '\u3000'.repeat(1300)],
  ])('refuse %s sans effacer ni écraser', (_name, raw) => {
    sessionStorage.setItem(key, raw)
    expect(readPreparationRecovery(scope)).toEqual({ status: 'blocked' })
    expect(persistPreparationRecovery(scope, body, null)).toEqual({ status: 'blocked' })
    expect(sessionStorage.getItem(key)).toBe(raw)
  })
  it('accepte une enveloppe valide à la borne, puis refuse un octet supplémentaire', () => {
    const bounded = entry.padEnd(4096, ' ')
    sessionStorage.setItem(key, bounded)
    expect(readPreparationRecovery(scope)).toEqual({ status: 'pending', body, entry: bounded })
    sessionStorage.setItem(key, `${bounded} `)
    expect(readPreparationRecovery(scope)).toEqual({ status: 'blocked' })
  })
  it('valide le corps natif et copie les données avant de les rendre au transport', () => {
    const mutable = { ...body, previousTestVersionId: 'server-version' }
    const saved = persistPreparationRecovery(scope, mutable, null)
    expect(saved.status).toBe('saved')
    mutable.operationId = 'mutated'
    expect(JSON.parse(sessionStorage.getItem(key)!).body).toEqual({
      ...body,
      previousTestVersionId: 'server-version',
    })
    if (saved.status !== 'saved') throw new Error('expected saved')
    expect(saved.body.operationId).toBe('operation-owned')
    expect(persistPreparationRecovery(scope, mutable, saved.entry)).toEqual({ status: 'blocked' })
  })
  it('ne remplace pas une entrée concurrente et ne recrée pas une opération déjà retirée', () => {
    sessionStorage.setItem(key, entry)
    expect(persistPreparationRecovery(scope, { ...body, operationId: 'other' }, null)).toEqual({
      status: 'blocked',
    })
    expect(sessionStorage.getItem(key)).toBe(entry)
    expect(persistPreparationRecovery(scope, body, entry).status).toBe('saved')
    expect(clearPreparationRecovery(scope, entry)).toBe(true)
    expect(persistPreparationRecovery(scope, body, entry)).toEqual({ status: 'blocked' })
    expect(sessionStorage.getItem(key)).toBeNull()
  })
  it('compare les octets exacts avant retrait et préserve une autre entrée', () => {
    const newer = JSON.stringify({ ...scope, version: 1, body: { ...body, operationId: 'newer' } })
    sessionStorage.setItem(key, newer)
    expect(clearPreparationRecovery(scope, entry)).toBe(false)
    expect(sessionStorage.getItem(key)).toBe(newer)
    sessionStorage.setItem('unrelated', 'sentinel')
    expect(clearPreparationRecovery(scope, newer)).toBe(true)
    expect(sessionStorage.getItem('unrelated')).toBe('sentinel')
  })
  it('refuse si la lecture de vérification après écriture échoue', () => {
    const original = sessionStorage.getItem.bind(sessionStorage)
    let reads = 0
    vi.spyOn(Object.getPrototypeOf(sessionStorage), 'getItem').mockImplementation(
      (name: string) => {
        if (++reads > 1) throw new Error('unavailable')
        return original(name)
      }
    )
    expect(persistPreparationRecovery(scope, body, null)).toEqual({ status: 'blocked' })
    expect(original(key)).toBe(entry)
  })
  it('un accès ou retrait refusé reste fermé sans erreur brute', () => {
    sessionStorage.setItem(key, entry)
    const denied = vi
      .spyOn(Object.getPrototypeOf(sessionStorage), 'getItem')
      .mockImplementation(() => {
        throw new Error('private')
      })
    expect(readPreparationRecovery(scope)).toEqual({ status: 'blocked' })
    expect(persistPreparationRecovery(scope, body, entry)).toEqual({ status: 'blocked' })
    expect(clearPreparationRecovery(scope, entry)).toBe(false)
    denied.mockRestore()
    vi.spyOn(Object.getPrototypeOf(sessionStorage), 'removeItem').mockImplementation(() => {
      throw new Error('private')
    })
    expect(clearPreparationRecovery(scope, entry)).toBe(false)
    expect(sessionStorage.getItem(key)).toBe(entry)
  })
})

const prepared = {
  status: 'prepared_for_test' as const,
  workflowId: 'workflow',
  deploymentVersionId: 'deployment',
  version: 2,
  snapshotDigest: `sha256:${'b'.repeat(64)}`,
  executionAvailable: false as const,
  activationAvailable: false as const,
}

it('recharge un indice préparé fermé sans lui attribuer accord ni résultat', () => {
  const saved = JSON.stringify({ ...scope, version: 2, body, prepared, executionId: null })
  sessionStorage.setItem(key, saved)
  expect(readPreparationRecovery(scope)).toEqual({
    status: 'prepared',
    body,
    prepared,
    executionId: null,
    entry: saved,
  })
})
it('recharge le même identifiant de test avant toute observation réseau', () => {
  const saved = JSON.stringify({ ...scope, version: 2, body, prepared, executionId: 'run-owned' })
  sessionStorage.setItem(key, saved)
  expect(readPreparationRecovery(scope)).toMatchObject({
    status: 'prepared',
    body,
    prepared,
    executionId: 'run-owned',
  })
})

function preparedHint() {
  const pending = persistPreparationRecovery(scope, body, null)
  if (pending.status !== 'saved') throw new Error('pending')
  const ready = retainPreparedRecovery(scope, body, prepared, pending.entry)
  if (ready.status !== 'saved') throw new Error('prepared')
  return ready.entry
}
it('reprise reload — conserve le reçu et un seul identifiant avec CAS, jamais accord ni fichier', () => {
  const ready = preparedHint()
  expect(readPreparedRecovery(scope, body, prepared)).toMatchObject({ executionId: null })
  const sent = persistExecutionRecovery(scope, body, prepared, 'stable-run', ready)
  expect(sent.status).toBe('saved')
  if (sent.status !== 'saved') throw new Error('saved')
  expect(JSON.parse(sent.entry)).toEqual({
    ...scope,
    version: 2,
    body,
    prepared,
    executionId: 'stable-run',
  })
  expect(persistExecutionRecovery(scope, body, prepared, 'new-run', sent.entry)).toEqual({
    status: 'blocked',
  })
  expect(sessionStorage.getItem(key)).toBe(sent.entry)
})
it('reprise reload — refuse un reçu étranger ou un binding modifié sans altérer l’indice', () => {
  const ready = preparedHint()
  expect(readPreparedRecovery(scope, { ...body, expectedRevision: 8 }, prepared)).toEqual({
    status: 'blocked',
  })
  expect(
    readPreparedRecovery(scope, body, { ...prepared, deploymentVersionId: 'foreign' })
  ).toEqual({ status: 'blocked' })
  for (const patch of [
    { prepared: { ...prepared, workflowId: 'foreign' } },
    { prepared: { ...prepared, activationAvailable: true } },
    { executionId: 'invalid\n' },
    { agreed: true },
    { results: [] },
  ]) {
    sessionStorage.setItem(key, JSON.stringify({ ...JSON.parse(ready), ...patch }))
    expect(readPreparationRecovery(scope)).toEqual({ status: 'blocked' })
  }
})
it('reprise reload — une écriture ambiguë garde le premier identifiant sans autoriser un autre', () => {
  const ready = preparedHint()
  const original = sessionStorage.getItem.bind(sessionStorage)
  const denied = vi
    .spyOn(Object.getPrototypeOf(sessionStorage), 'getItem')
    .mockImplementation((name: string) => {
      const value = original(name)
      if (value?.includes('stable-run')) throw new Error('private-read-denied')
      return value
    })
  expect(persistExecutionRecovery(scope, body, prepared, 'stable-run', ready)).toEqual({
    status: 'blocked',
  })
  denied.mockRestore()
  const saved = original(key)!
  expect(JSON.parse(saved).executionId).toBe('stable-run')
  expect(persistExecutionRecovery(scope, body, prepared, 'other-run', ready)).toEqual({
    status: 'blocked',
  })
  expect(sessionStorage.getItem(key)).toBe(saved)
})
it('reprise reload — préserve un remplacement concurrent lors de la réception ou de l’envoi', () => {
  const pending = persistPreparationRecovery(scope, body, null)
  if (pending.status !== 'saved') throw new Error('pending')
  sessionStorage.setItem(key, 'foreign-entry')
  expect(retainPreparedRecovery(scope, body, prepared, pending.entry)).toEqual({
    status: 'blocked',
  })
  expect(sessionStorage.getItem(key)).toBe('foreign-entry')
  sessionStorage.removeItem(key)
  const ready = preparedHint()
  sessionStorage.setItem(key, 'foreign-entry')
  expect(persistExecutionRecovery(scope, body, prepared, 'run', ready)).toEqual({
    status: 'blocked',
  })
  expect(sessionStorage.getItem(key)).toBe('foreign-entry')
})
it('reprise reload — une nouvelle préparation remplace seulement le reçu de sa lignée exacte', () => {
  const ready = preparedHint()
  expect(
    persistPreparationRecovery(scope, { ...body, operationId: 'new-operation' }, ready)
  ).toEqual({ status: 'blocked' })
  const next = {
    ...body,
    operationId: 'new-operation',
    previousTestVersionId: prepared.deploymentVersionId,
  }
  expect(persistPreparationRecovery(scope, next, ready).status).toBe('saved')
  expect(readPreparationRecovery(scope)).toMatchObject({ status: 'pending', body: next })
})
it('reprise reload — refuse une mise à jour ignorée avant la préparation suivante', () => {
  const ready = preparedHint()
  vi.spyOn(Object.getPrototypeOf(sessionStorage), 'setItem').mockImplementation(() => {})
  const next = {
    ...body,
    operationId: 'new-operation',
    previousTestVersionId: prepared.deploymentVersionId,
  }
  expect(persistPreparationRecovery(scope, next, ready)).toEqual({ status: 'blocked' })
  expect(sessionStorage.getItem(key)).toBe(ready)
})
