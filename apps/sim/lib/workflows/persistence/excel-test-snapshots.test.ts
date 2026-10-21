// Copyright (c) 2026 Memlia. All rights reserved.
import { ExcelProcedureSchema } from '@memlia/contracts'
import type { workflowDeploymentVersion } from '@sim/db'
import { sha256Hex } from '@sim/security/hash'
import { dbChainMockFns, queueTableRows, resetDbChainMock, schemaMock } from '@sim/testing'
import { idMock, idMockFns } from '@sim/testing/mocks/id.mock'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { excelProcedureDraftSchema } from '@/lib/memlia/excel/procedure-capabilities'
import { normalizedStringify } from '@/lib/workflows/comparison/normalize'
import { fixtures } from '../../../../../packages/memlia-contracts/tests/fixtures'
import {
  prepareExcelTestSnapshot,
  readExcelTestPreparationObservation,
} from './excel-test-snapshots'

vi.mock('@sim/utils/id', () => idMock)
const hash = (value: unknown) => `sha256:${sha256Hex(normalizedStringify(value))}`
const refused = 'excel_test_preparation_refused'
const policy = 'memlia_excel_test_admission_v1'
function fixture() {
  const full = structuredClone(fixtures.ExcelProcedure)
  full.decimalPolicy.precision = 18
  const procedure = excelProcedureDraftSchema.parse(
    Object.fromEntries(
      Object.entries(full).filter(([key]) => key in excelProcedureDraftSchema.shape)
    )
  )
  const block = {
    id: 'excel',
    type: 'memlia_excel',
    name: 'Excel',
    position: { x: 0, y: 0 },
    enabled: true,
    horizontalHandles: true,
    advancedMode: false,
    errorEnabled: false,
    triggerMode: false,
    height: 100,
    subBlocks: {
      request: {
        id: 'request',
        type: 'code' as const,
        value: JSON.stringify({ procedure, sources: {}, output: {} }),
      },
    },
    outputs: {},
    data: {},
    locked: false,
  }
  const graph = { blocks: { excel: block }, edges: [], loops: {}, parallels: {}, variables: {} }
  const input = {
    scope: { workflowId: 'workflow', workspaceId: 'space', organizationId: null },
    actorId: 'subject',
    expectedRevision: 7,
    expectedStateDigest: hash(graph),
    operationId: 'operation',
  }
  return { block, graph, input }
}
function queueGraph(
  f: ReturnType<typeof fixture>,
  change: { revision?: number; space?: string; archivedAt?: Date; name?: string } = {}
) {
  queueTableRows(schemaMock.workflow, [{ draftRevision: change.revision ?? 7 }])
  queueTableRows(schemaMock.workflow, [
    {
      id: 'workflow',
      workspaceId: change.space ?? 'space',
      variables: {},
      archivedAt: change.archivedAt ?? null,
    },
  ])
  queueTableRows(schemaMock.workspace, [{ organizationId: null, archivedAt: null }])
  queueTableRows(schemaMock.workflowBlocks, [
    { ...f.block, positionX: 0, positionY: 0, ...(change.name ? { name: change.name } : {}) },
  ])
  queueTableRows(schemaMock.workflowEdges, [])
  queueTableRows(schemaMock.workflowSubflows, [])
  queueTableRows(schemaMock.workflow, [{ workspaceId: 'space', draftRevision: 7 }])
}
function queueFresh(f: ReturnType<typeof fixture>) {
  queueGraph(f)
  dbChainMockFns.returning.mockResolvedValueOnce([{ key: 'owned' }])
  queueTableRows(schemaMock.workflowDeploymentVersion, [{ maxVersion: 2 }])
  idMockFns.mockGenerateId
    .mockReturnValueOnce('server-procedure')
    .mockReturnValueOnce('server-version')
}
type StoredFixture = Omit<typeof workflowDeploymentVersion.$inferSelect, 'state'> & {
  state: Omit<ReturnType<typeof fixture>['graph'], 'blocks'> & {
    blocks: Record<string, ReturnType<typeof fixture>['block']>
  }
}
function insertedSnapshot(): StoredFixture {
  const call = dbChainMockFns.values.mock.calls.find(
    ([v]) => v !== null && typeof v === 'object' && 'snapshotDigest' in v
  )
  if (!call) throw new Error('Expected real snapshot INSERT values')
  // The mocked INSERT receives the graph constructed by fixture(), not arbitrary SQL JSON.
  return call[0] as StoredFixture
}
function noDeploymentMutation() {
  expect(dbChainMockFns.insert).not.toHaveBeenCalledWith(schemaMock.workflowDeploymentOperation)
  expect(dbChainMockFns.insert).not.toHaveBeenCalledWith(schemaMock.outboxEvent)
  expect(dbChainMockFns.update).not.toHaveBeenCalledWith(schemaMock.workflowDeploymentOperation)
  expect(dbChainMockFns.update).not.toHaveBeenCalledWith(schemaMock.workflow)
}
describe('préparation inactive Excel — SQL doublé, contrats et matérialisation natifs', () => {
  beforeEach(() => {
    resetDbChainMock()
    idMockFns.mockGenerateId.mockReset()
  })
  it('enregistre seulement le snapshot test avec identité serveur et politique explicite', async () => {
    const f = fixture()
    queueFresh(f)
    const result = await prepareExcelTestSnapshot(f.input)
    const stored = insertedSnapshot()
    expect(result).toEqual({
      status: 'prepared_for_test',
      workflowId: 'workflow',
      deploymentVersionId: 'server-version',
      version: 3,
      snapshotDigest: hash(stored.state),
      executionAvailable: false,
      activationAvailable: false,
    })
    expect(stored).toMatchObject({
      isActive: false,
      preparationKind: 'excel_test_v1',
      createdBy: 'subject',
    })
    const canonical = ExcelProcedureSchema.parse(
      JSON.parse(stored.state.blocks.excel.subBlocks.request.value).procedure
    )
    expect(canonical).toMatchObject({
      procedureId: 'server-procedure',
      version: 1,
      parentVersion: null,
      ownerUserId: 'subject',
      policyVersion: policy,
      deployedVersionId: 'server-version',
    })
    expect(stored.snapshotDigest).toBe(hash(stored.state))
    noDeploymentMutation()
  })
  it.each([{ revision: 8 }, { space: 'foreign' }, { archivedAt: new Date() }, { name: 'Changed' }])(
    'refuse le brouillon divergent %j avant INSERT',
    async (change) => {
      const f = fixture()
      queueGraph(f, change)
      await expect(prepareExcelTestSnapshot(f.input)).rejects.toThrow(refused)
      expect(dbChainMockFns.insert).not.toHaveBeenCalled()
    }
  )
  it.each(['ownerUserId', 'policyVersion', 'tx', 'workflowState', 'onPrepareTransaction'])(
    'refuse le champ non prévu %s avant SQL',
    async (key) => {
      await expect(
        prepareExcelTestSnapshot({ ...fixture().input, [key]: 'foreign' })
      ).rejects.toThrow(refused)
      expect(dbChainMockFns.select).not.toHaveBeenCalled()
    }
  )
  it('capture tous les champs avant le premier await', async () => {
    const f = fixture()
    queueFresh(f)
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    dbChainMockFns.execute.mockImplementationOnce(async () => {
      await barrier
      return []
    })
    const pending = prepareExcelTestSnapshot(f.input)
    f.input.actorId = 'foreign'
    f.input.scope.workspaceId = 'foreign'
    f.input.operationId = 'changed'
    release()
    expect((await pending).status).toBe('prepared_for_test')
    expect(insertedSnapshot().createdBy).toBe('subject')
    noDeploymentMutation()
  })
  it('conserve l’auteur partagé et incrémente seulement la filiation vérifiée', async () => {
    const first = fixture()
    queueFresh(first)
    await prepareExcelTestSnapshot(first.input)
    const previous = structuredClone(insertedSnapshot())
    resetDbChainMock()
    idMockFns.mockGenerateId.mockReset()
    const next = fixture()
    next.input.actorId = 'authorized-collaborator'
    queueGraph(next)
    queueTableRows(schemaMock.workflowDeploymentVersion, [previous])
    queueTableRows(schemaMock.workflowDeploymentVersion, [{ maxVersion: 3 }])
    dbChainMockFns.returning.mockResolvedValueOnce([{ key: 'next' }])
    idMockFns.mockGenerateId.mockReturnValueOnce('next-version')
    await prepareExcelTestSnapshot({ ...next.input, previousTestVersionId: previous.id })
    const stored = insertedSnapshot()
    expect(stored.createdBy).toBe('authorized-collaborator')
    expect(JSON.parse(stored.state.blocks.excel.subBlocks.request.value).procedure).toMatchObject({
      procedureId: 'server-procedure',
      ownerUserId: 'subject',
      version: 2,
      parentVersion: 1,
      policyVersion: policy,
      deployedVersionId: 'next-version',
    })
    expect(idMockFns.mockGenerateId).toHaveBeenCalledOnce()
    noDeploymentMutation()
  })
  it.each([
    'kind',
    'digest',
    'scope',
    'identity',
    'policy',
    'procedureDigest',
    'block',
    'active',
    'missing',
  ])('refuse une filiation ancienne invalide : %s', async (kind) => {
    const f = fixture()
    queueFresh(f)
    await prepareExcelTestSnapshot(f.input)
    const prior = structuredClone(insertedSnapshot())
    if (kind === 'kind') prior.preparationKind = null
    if (kind === 'digest') prior.snapshotDigest = hash({})
    if (kind === 'active') prior.isActive = true
    if (['scope', 'identity', 'policy', 'procedureDigest'].includes(kind)) {
      const request = JSON.parse(prior.state.blocks.excel.subBlocks.request.value)
      if (kind === 'scope') request.procedure.workspaceId = 'foreign'
      if (kind === 'identity') request.procedure.deployedVersionId = 'foreign'
      if (kind === 'policy') request.procedure.policyVersion = 'foreign'
      const { digest: _ignored, ...unsigned } = request.procedure
      request.procedure.digest = kind === 'procedureDigest' ? hash({}) : hash(unsigned)
      prior.state.blocks.excel.subBlocks.request.value = JSON.stringify(request)
      prior.snapshotDigest = hash(prior.state)
    }
    if (kind === 'block') {
      prior.state.blocks = { other: { ...prior.state.blocks.excel, id: 'other' } }
      prior.snapshotDigest = hash(prior.state)
    }
    resetDbChainMock()
    idMockFns.mockGenerateId.mockReset()
    queueGraph(f)
    queueTableRows(schemaMock.workflowDeploymentVersion, kind === 'missing' ? [] : [prior])
    await expect(
      prepareExcelTestSnapshot({ ...f.input, previousTestVersionId: 'server-version' })
    ).rejects.toThrow(refused)
    expect(dbChainMockFns.insert).not.toHaveBeenCalled()
    expect(idMockFns.mockGenerateId).not.toHaveBeenCalled()
    noDeploymentMutation()
  })
  it.each([
    'valid',
    'rowDigest',
    'cachedDigest',
    'destination',
    'cachedUnknown',
    'missing',
    'changedGraph',
  ])('relit le snapshot pour la reprise idempotente : %s', async (kind) => {
    const f = fixture()
    queueFresh(f)
    const original = await prepareExcelTestSnapshot(f.input)
    const row = structuredClone(insertedSnapshot())
    const cached = { ...original }
    if (kind === 'rowDigest') row.snapshotDigest = hash({})
    if (kind === 'cachedDigest') cached.snapshotDigest = hash({})
    if (kind === 'destination') row.preparationKind = null
    if (kind === 'changedGraph') {
      row.state.blocks.excel.name = 'changed stored graph'
      row.snapshotDigest = hash(row.state)
      cached.snapshotDigest = row.snapshotDigest
    }
    resetDbChainMock()
    idMockFns.mockGenerateId.mockReset()
    queueGraph(f)
    dbChainMockFns.returning.mockResolvedValueOnce([])
    queueTableRows(schemaMock.idempotencyKey, [
      {
        result: {
          status: 'completed',
          requestFingerprint: hash({ ...f.input, policyVersion: policy }),
          result: kind === 'cachedUnknown' ? { ...cached, authority: true } : cached,
        },
      },
    ])
    queueTableRows(schemaMock.workflowDeploymentVersion, kind === 'missing' ? [] : [row])
    if (kind === 'valid') expect(await prepareExcelTestSnapshot(f.input)).toEqual(original)
    else await expect(prepareExcelTestSnapshot(f.input)).rejects.toThrow(refused)
    expect(dbChainMockFns.insert).not.toHaveBeenCalledWith(schemaMock.workflowDeploymentVersion)
    expect(idMockFns.mockGenerateId).not.toHaveBeenCalled()
    noDeploymentMutation()
  })
  it('refuse une clé réutilisée avec une autre empreinte, sans deuxième snapshot', async () => {
    const f = fixture()
    queueGraph(f)
    dbChainMockFns.returning.mockResolvedValueOnce([])
    queueTableRows(schemaMock.idempotencyKey, [
      {
        result: { status: 'completed', requestFingerprint: 'other', result: {} },
      },
    ])
    await expect(prepareExcelTestSnapshot(f.input)).rejects.toThrow(refused)
    expect(dbChainMockFns.insert).not.toHaveBeenCalledWith(schemaMock.workflowDeploymentVersion)
    noDeploymentMutation()
  })
  it('refuse le JSON avec accesseur sans l’évaluer', async () => {
    const f = fixture()
    const getter = vi.fn(() => 'subject')
    Object.defineProperty(f.input, 'actorId', { get: getter, enumerable: true })
    await expect(prepareExcelTestSnapshot(f.input)).rejects.toThrow(refused)
    expect(getter).not.toHaveBeenCalled()
    expect(dbChainMockFns.select).not.toHaveBeenCalled()
  })
  it.each(['confirmed', 'unknown'] as const)(
    'ne livre aucun résultat avant COMMIT %s doublé',
    async (outcome) => {
      const f = fixture()
      queueFresh(f)
      const nativeMockTransaction = dbChainMockFns.transaction.getMockImplementation()
      if (!nativeMockTransaction) throw new Error('Expected native transaction fixture')
      let release!: () => void
      let executed!: () => void
      const waiting = new Promise<void>((resolve) => {
        executed = resolve
      })
      const commit = new Promise<void>((resolve) => {
        release = resolve
      })
      dbChainMockFns.transaction.mockImplementationOnce(async (...args) => {
        const result = await nativeMockTransaction(...args)
        executed()
        await commit
        if (outcome === 'unknown') throw new Error('private_commit_canary')
        return result
      })
      let delivered = false
      const result = prepareExcelTestSnapshot(f.input).then(
        (value) => {
          delivered = true
          return value
        },
        (error: unknown) => {
          delivered = true
          return error
        }
      )
      await waiting
      expect(insertedSnapshot().preparationKind).toBe('excel_test_v1')
      expect(delivered).toBe(false)
      release()
      const final = await result
      if (outcome === 'confirmed') expect(final).toMatchObject({ status: 'prepared_for_test' })
      else {
        expect(final).toBeInstanceOf(Error)
        expect(String(final)).toBe(`Error: ${refused}`)
        expect(final).not.toHaveProperty('cause')
      }
      expect(dbChainMockFns.transaction).toHaveBeenCalledOnce()
      noDeploymentMutation()
    }
  )
  it('ferme l’erreur SQL sans cause brute et ne retente pas la transaction', async () => {
    const f = fixture()
    dbChainMockFns.execute.mockRejectedValueOnce(new Error('private_sql_canary'))
    const error = await prepareExcelTestSnapshot(f.input).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toBe(`Error: ${refused}`)
    expect(error).not.toHaveProperty('cause')
    expect(dbChainMockFns.transaction).toHaveBeenCalledOnce()
    expect(dbChainMockFns.insert).not.toHaveBeenCalled()
  })
})

describe('observation brute préalable — SQL doublé', () => {
  beforeEach(() => resetDbChainMock())
  function observed(
    f: ReturnType<typeof fixture>,
    change: {
      workspaceId?: string
      organizationId?: string
      archivedAt?: Date
      spaceArchivedAt?: Date
      rawRevision?: number
      rawWorkspaceId?: string
      variables?: unknown
    } = {}
  ) {
    queueTableRows(schemaMock.workflow, [
      {
        workspaceId: change.workspaceId ?? 'space',
        draftRevision: 7,
        variables: change.variables ?? {},
        archivedAt: change.archivedAt ?? null,
      },
    ])
    queueTableRows(schemaMock.workspace, [
      { organizationId: change.organizationId ?? null, archivedAt: change.spaceArchivedAt ?? null },
    ])
    queueTableRows(schemaMock.workflowBlocks, [{ ...f.block, positionX: 0, positionY: 0 }])
    queueTableRows(schemaMock.workflowEdges, [])
    queueTableRows(schemaMock.workflowSubflows, [])
    queueTableRows(schemaMock.workflow, [
      { workspaceId: change.rawWorkspaceId ?? 'space', draftRevision: change.rawRevision ?? 7 },
    ])
  }
  it('produit une précondition que le port accepte sans normalisation de variables supplémentaire', async () => {
    const f = fixture()
    observed(f)
    const result = await readExcelTestPreparationObservation(f.input.scope)
    expect(result).toEqual({
      expectedRevision: 7,
      expectedStateDigest: f.input.expectedStateDigest,
      blockTypes: ['memlia_excel'],
    })
    expect(dbChainMockFns.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    })
    expect(dbChainMockFns.insert).not.toHaveBeenCalled()
    resetDbChainMock()
    queueFresh(f)
    expect(
      (
        await prepareExcelTestSnapshot({
          ...f.input,
          expectedRevision: result.expectedRevision,
          expectedStateDigest: result.expectedStateDigest,
        })
      ).status
    ).toBe('prepared_for_test')
  })
  it('conserve les variables brutes sans ajouter workflowId', async () => {
    const f = fixture()
    const variables = { amount: { id: 'amount', name: 'Amount', type: 'number', value: 3 } }
    observed(f, { variables })
    const result = await readExcelTestPreparationObservation(f.input.scope)
    expect(result.expectedStateDigest).toBe(hash({ ...f.graph, variables }))
    expect(result.expectedStateDigest).not.toBe(
      hash({ ...f.graph, variables: { amount: { ...variables.amount, workflowId: 'workflow' } } })
    )
  })
  it.each([
    { workspaceId: 'moved' },
    { organizationId: 'moved' },
    { archivedAt: new Date() },
    { spaceArchivedAt: new Date() },
    { rawRevision: 8 },
    { rawWorkspaceId: 'moved' },
  ])('refuse une vue différente du contexte autorisé %j', async (change) => {
    const f = fixture()
    observed(f, change)
    await expect(readExcelTestPreparationObservation(f.input.scope)).rejects.toThrow(refused)
    expect(dbChainMockFns.insert).not.toHaveBeenCalled()
  })
  it('capture la portée avant attente et refuse les champs non déclarés avant SQL', async () => {
    const f = fixture()
    await expect(
      readExcelTestPreparationObservation({ ...f.input.scope, actorId: 'foreign' })
    ).rejects.toThrow(refused)
    expect(dbChainMockFns.select).not.toHaveBeenCalled()
    observed(f)
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    dbChainMockFns.execute.mockImplementationOnce(async () => {
      await barrier
      return []
    })
    const pending = readExcelTestPreparationObservation(f.input.scope)
    f.input.scope.workspaceId = 'moved'
    release()
    expect((await pending).expectedRevision).toBe(7)
  })
})
