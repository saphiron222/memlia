// Copyright (c) 2026 Memlia. All rights reserved.
import { createHash } from 'node:crypto'
import { ExcelProcedureSchema } from '@memlia/contracts'
import { describe, expect, it } from 'vitest'
import { normalizedStringify } from '@/lib/workflows/comparison/normalize'
import { fixtures } from '../../../../../packages/memlia-contracts/tests/fixtures'
import {
  captureExcelProcedureSnapshot,
  materializeExcelProcedureSnapshot,
  readExcelProcedureSnapshotCapture,
} from './materialize-procedure-snapshot'
import { excelProcedureDraftSchema } from './procedure-capabilities'

const digest = (value: unknown) =>
  `sha256:${createHash('sha256').update(normalizedStringify(value)).digest('hex')}`
function input() {
  const full = structuredClone(fixtures.ExcelProcedure)
  full.decimalPolicy.precision = 18
  const draft = excelProcedureDraftSchema.parse(
    Object.fromEntries(
      Object.entries(full).filter(([key]) => key in excelProcedureDraftSchema.shape)
    )
  )
  const request = {
    procedure: draft,
    sources: { source: { fileId: 'file-fixture', sheetName: 'Source' } },
    output: { fileName: 'result.xlsx', sheetName: 'Result' },
  }
  const workflowState = {
    blocks: {
      excel: {
        id: 'excel',
        type: 'memlia_excel',
        name: 'Excel',
        position: { x: 10, y: 20 },
        enabled: true,
        subBlocks: { request: { id: 'request', type: 'code', value: JSON.stringify(request) } },
        outputs: {},
      },
      manual: {
        id: 'manual',
        type: 'start_trigger',
        name: 'Start',
        position: { x: 0, y: 0 },
        enabled: true,
        subBlocks: {},
        outputs: {},
      },
    },
    edges: [
      {
        id: 'edge',
        source: 'manual',
        target: 'excel',
        sourceHandle: 'source',
        targetHandle: 'target',
      },
    ],
    loops: {},
    parallels: {},
    variables: {},
  }
  return {
    workflowState,
    expectedRevision: 7,
    expectedStateDigest: digest(workflowState),
    scope: {
      organizationId: null,
      workspaceId: 'workspace-fixture',
      workflowId: 'workflow-fixture',
    },
    procedures: [
      {
        blockId: 'excel',
        expectedRequestDigest: digest(request),
        procedureId: 'procedure-fixture',
        version: 1,
        parentVersion: null,
        ownerUserId: 'author-fixture',
        policyVersion: 'policy-fixture',
      },
    ],
  }
}
const deployment = { id: 'deployment-server-fixture', version: 2 }
const current = (data: ReturnType<typeof input>) => ({
  workflowState: data.workflowState,
  revision: 7,
  scope: data.scope,
})
const refused = 'excel_materialization_refused'

describe('matérialisation pure du snapshot Excel', () => {
  it('matérialise le vrai ID serveur et un digest canonique, sans modifier le reste du graphe', () => {
    const data = input()
    const before = structuredClone(data)
    const result = materializeExcelProcedureSnapshot(
      captureExcelProcedureSnapshot(data),
      current(data),
      deployment
    )
    const value = result.workflowState.blocks.excel.subBlocks.request.value
    if (typeof value !== 'string') throw new Error('Expected native JSON field')
    const request = JSON.parse(value)
    const procedure = ExcelProcedureSchema.parse(request.procedure)
    expect(procedure).toMatchObject({
      deployedVersionId: deployment.id,
      ownerUserId: 'author-fixture',
      version: 1,
      parentVersion: null,
    })
    const { digest: observed, ...unsigned } = procedure
    expect(observed).toBe(digest(unsigned))
    const restored = structuredClone(result.workflowState)
    restored.blocks.excel.subBlocks.request.value =
      before.workflowState.blocks.excel.subBlocks.request.value
    expect(restored).toEqual(before.workflowState)
    expect(data).toEqual(before)
    expect(result.snapshotDigest).toBe(digest(result.workflowState))
  })
  it('refuse une révision obsolète plutôt que matérialiser un nouveau graphe', () => {
    const data = input()
    expect(() =>
      materializeExcelProcedureSnapshot(
        captureExcelProcedureSnapshot(data),
        { ...current(data), revision: 8 },
        deployment
      )
    ).toThrow(refused)
  })
  it('refuse une divergence du graphe même avec la même révision déclarée', () => {
    const data = input()
    const changed = structuredClone(data.workflowState)
    changed.blocks.manual.name = 'Changed'
    expect(() =>
      materializeExcelProcedureSnapshot(
        captureExcelProcedureSnapshot(data),
        { ...current(data), workflowState: changed },
        deployment
      )
    ).toThrow(refused)
  })
  it('refuse les champs d’autorité introduits dans le brouillon', () => {
    const data = input()
    const request = JSON.parse(data.workflowState.blocks.excel.subBlocks.request.value)
    request.procedure.ownerUserId = 'client-owner'
    data.workflowState.blocks.excel.subBlocks.request.value = JSON.stringify(request)
    data.expectedStateDigest = digest(data.workflowState)
    data.procedures[0].expectedRequestDigest = digest(request)
    expect(() => captureExcelProcedureSnapshot(data)).toThrow(refused)
  })
  it('refuse une capture reconstruite depuis JSON', () => {
    const data = input()
    const handle = captureExcelProcedureSnapshot(data)
    expect(() =>
      materializeExcelProcedureSnapshot(
        JSON.parse(JSON.stringify(handle)),
        current(data),
        deployment
      )
    ).toThrow(refused)
  })
  it('garde l’identité d’entrée stable et couvre le vrai snapshot final', () => {
    const data = input()
    const handle = captureExcelProcedureSnapshot(data)
    const first = materializeExcelProcedureSnapshot(handle, current(data), deployment)
    const second = materializeExcelProcedureSnapshot(handle, current(data), {
      id: 'deployment-other',
      version: 3,
    })
    expect(first.inputDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(second.inputDigest).toBe(first.inputDigest)
    expect(second.snapshotDigest).not.toBe(first.snapshotDigest)
  })
})

describe('frontières de capture et conservation', () => {
  it.each([
    [
      'empreinte graphe',
      (data: ReturnType<typeof input>) => {
        data.expectedStateDigest = `sha256:${'0'.repeat(64)}`
      },
    ],
    [
      'empreinte demande',
      (data: ReturnType<typeof input>) => {
        data.procedures[0].expectedRequestDigest = `sha256:${'0'.repeat(64)}`
      },
    ],
    [
      'bloc étranger',
      (data: ReturnType<typeof input>) => {
        data.procedures[0].blockId = 'manual'
      },
    ],
    [
      'cible absente',
      (data: ReturnType<typeof input>) => {
        data.procedures[0].blockId = 'missing'
      },
    ],
    [
      'cible dupliquée',
      (data: ReturnType<typeof input>) => {
        data.procedures.push(structuredClone(data.procedures[0]))
      },
    ],
    [
      'auteur invalide',
      (data: ReturnType<typeof input>) => {
        data.procedures[0].ownerUserId = '../owner'
      },
    ],
    [
      'policy absente',
      (data: ReturnType<typeof input>) => {
        data.procedures[0].policyVersion = ''
      },
    ],
    [
      'parent incohérent',
      (data: ReturnType<typeof input>) => {
        data.procedures[0].version = 2
      },
    ],
    [
      'organisation absente',
      (data: ReturnType<typeof input>) => {
        Reflect.deleteProperty(data.scope, 'organizationId')
      },
    ],
    [
      'JSON invalide',
      (data: ReturnType<typeof input>) => {
        data.workflowState.blocks.excel.subBlocks.request.value = '{'
        data.expectedStateDigest = digest(data.workflowState)
      },
    ],
    [
      'taille excessive',
      (data: ReturnType<typeof input>) => {
        data.workflowState.blocks.excel.subBlocks.request.value = 'x'.repeat(512 * 1024 + 1)
        data.expectedStateDigest = digest(data.workflowState)
      },
    ],
  ])('refuse %s sans modifier les entrées', (_name, change) => {
    const data = input()
    change(data)
    const before = structuredClone(data)
    expect(() => captureExcelProcedureSnapshot(data)).toThrow(refused)
    expect(data).toEqual(before)
  })
  it('refuse un accesseur sans l’invoquer et sans exposer son message', () => {
    const data = input()
    let calls = 0
    Object.defineProperty(data.scope, 'workflowId', {
      enumerable: true,
      get() {
        calls++
        throw new Error('private value')
      },
    })
    expect(() => captureExcelProcedureSnapshot(data)).toThrow(refused)
    expect(calls).toBe(0)
  })
  it('possède la capture malgré une mutation ultérieure du plan serveur', () => {
    const data = input()
    const locked = structuredClone(current(data))
    const handle = captureExcelProcedureSnapshot(data)
    data.procedures[0].ownerUserId = 'different-owner'
    data.workflowState.blocks.manual.name = 'Changed'
    const result = materializeExcelProcedureSnapshot(handle, locked, deployment)
    const value = result.workflowState.blocks.excel.subBlocks.request.value
    if (typeof value !== 'string') throw new Error('Expected native JSON field')
    expect(JSON.parse(value).procedure.ownerUserId).toBe('author-fixture')
    expect(result.workflowState.blocks.manual.name).toBe('Start')
    expect(Object.isFrozen(result.workflowState.blocks.excel.subBlocks.request)).toBe(true)
    expect(() => {
      result.workflowState.blocks.manual.name = 'Changed'
    }).toThrow()
  })
  it.each(['organizationId', 'workspaceId', 'workflowId'] as const)(
    'refuse une portée courante différente : %s',
    (key) => {
      const data = input()
      const observed = structuredClone(current(data))
      Object.assign(observed.scope, { [key]: 'foreign' })
      expect(() =>
        materializeExcelProcedureSnapshot(captureExcelProcedureSnapshot(data), observed, deployment)
      ).toThrow(refused)
    }
  )
  it.each([
    {},
    { id: '../invalid', version: 1 },
    { id: 'valid', version: 0 },
    { id: 'valid', version: 1, image: 'client-image' },
  ])('refuse une identité de déploiement invalide', (identity) => {
    const data = input()
    expect(() =>
      materializeExcelProcedureSnapshot(
        captureExcelProcedureSnapshot(data),
        current(data),
        identity
      )
    ).toThrow(refused)
  })
  it('préserve les métadonnées inconnues du graphe au lieu de les projeter silencieusement', () => {
    const data = input()
    Object.assign(data.workflowState, { auditFixture: { nested: ['literal', null, false] } })
    Object.assign(data.workflowState.blocks.manual, { extraFixture: { label: 'do not remove' } })
    data.expectedStateDigest = digest(data.workflowState)
    const result = materializeExcelProcedureSnapshot(
      captureExcelProcedureSnapshot(data),
      current(data),
      deployment
    )
    const restored = structuredClone(result.workflowState)
    restored.blocks.excel.subBlocks.request.value =
      data.workflowState.blocks.excel.subBlocks.request.value
    expect(restored).toEqual(data.workflowState)
  })
  it('refuse un second bloc Excel non déclaré dans le plan', () => {
    const data = input()
    Object.assign(data.workflowState.blocks, {
      other: { ...structuredClone(data.workflowState.blocks.excel), id: 'other' },
    })
    data.expectedStateDigest = digest(data.workflowState)
    expect(() => captureExcelProcedureSnapshot(data)).toThrow(refused)
  })
  it('refuse une recette au dataflow inconnu même si le schéma est valide', () => {
    const data = input()
    const request = JSON.parse(data.workflowState.blocks.excel.subBlocks.request.value)
    request.procedure.operations[0].input = 'unknown_table'
    data.workflowState.blocks.excel.subBlocks.request.value = JSON.stringify(request)
    data.expectedStateDigest = digest(data.workflowState)
    data.procedures[0].expectedRequestDigest = digest(request)
    expect(() => captureExcelProcedureSnapshot(data)).toThrow(refused)
  })
})

// Additive identity accessor checks; the capture and materializer bodies remain unchanged.
it('reads only immutable primitive capture identity and refuses unowned handles', () => {
  const plan = input()
  const handle = captureExcelProcedureSnapshot(plan)
  const first = readExcelProcedureSnapshotCapture(handle)
  expect(first).toEqual({
    scope: plan.scope,
    expectedRevision: 7,
    expectedStateDigest: plan.expectedStateDigest,
    inputDigest: digest(plan),
  })
  expect(Object.isFrozen(first)).toBe(true)
  expect(Object.isFrozen(first.scope)).toBe(true)
  plan.scope.workspaceId = 'changed'
  expect(readExcelProcedureSnapshotCapture(handle)).toEqual(first)
  expect(readExcelProcedureSnapshotCapture(handle).scope).not.toBe(first.scope)
  for (const forged of [{}, null, false, JSON.parse(JSON.stringify(handle))])
    expect(() => readExcelProcedureSnapshotCapture(forged)).toThrow('excel_materialization_refused')
})
