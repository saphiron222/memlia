// Copyright (c) 2026 Memlia. All rights reserved.
// Real local backup/edit capabilities; only external HTTP and Office SDK are doubles.
import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import type { OfficeProcedureResult } from '@/lib/api/contracts/excel-office-procedures'
import { backupCurrentOfficeWorkbook } from './backup-client'
import { listOfficeProcedureResults, prepareOfficeProcedureEdit } from './procedure-client'

const source: OfficeProcedureResult = {
  workflowId: 'workflow-fixture',
  deploymentVersionId: 'deployment-fixture',
  blockId: 'block-fixture',
  executionId: 'execution-fixture',
  resultFileId: 'output-fixture',
  resultContentVersion: 7,
  workflowName: 'Procédure fictive',
  procedureName: 'Résultat fictif',
  fileName: 'resultat.xlsx',
  completedAt: '2026-10-21T08:00:00.000Z',
}
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
async function ready() {
  const values = [[2, 'literal']]
  const load = () => {}
  const context = { workbook: {} as unknown, application: {}, sync: async () => {} }
  const range = {
    context,
    load,
    address: 'Feuille!B2:C2',
    rowIndex: 1,
    columnIndex: 1,
    rowCount: 1,
    columnCount: 2,
    cellCount: 2,
    values,
    formulas: [[2, 'literal']],
    valueTypes: [['Integer', 'String']],
    numberFormat: [['General', '@']],
    hasSpill: false,
    getMergedAreasOrNullObject: () => ({ load, isNullObject: true }),
    getSpecialCellsOrNullObject: () => ({ load, isNullObject: true }),
  }
  const sheet = {
    context,
    load,
    id: 'native-sheet',
    name: 'Feuille',
    protection: { load, protected: false },
    getRangeByIndexes: () => range,
  }
  Object.defineProperty(range, 'worksheet', { value: sheet })
  context.workbook = { worksheets: { getItem: () => sheet }, getSelectedRange: () => range }
  const excel = {
    run: async (callback: (ctx: typeof context) => Promise<unknown>) => callback(context),
  }
  const bytes = Uint8Array.of(80, 75, 3, 4)
  const office = {
    onReady: async () => ({ host: 'Excel', platform: 'PC' }),
    context: {
      requirements: { isSetSupported: () => true },
      document: {
        mode: 'readWrite',
        getFileAsync(_kind: unknown, _options: unknown, done: (v: unknown) => void) {
          done({
            status: 'succeeded',
            value: {
              size: 4,
              sliceCount: 1,
              getSliceAsync(index: number, callback: (v: unknown) => void) {
                callback({ status: 'succeeded', value: { index, size: 4, data: bytes } })
              },
              closeAsync(callback: (v: unknown) => void) {
                callback({ status: 'succeeded' })
              },
            },
          })
        },
      },
    },
  }
  const receipt = {
    schemaVersion: 'memlia.office-copy-storage/v1',
    workspaceId: 'workspace-fixture',
    ownerUserId: 'user-fixture',
    fileId: 'backup-fixture',
    contentVersion: 11,
    byteLength: 4,
    sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  }
  const fetch = vi.fn(async () => response({ status: 'stored', receipt }))
  vi.stubGlobal('fetch', fetch)
  const backup = await backupCurrentOfficeWorkbook({
    office,
    workspaceId: 'workspace-fixture',
    expectedUserId: 'user-fixture',
    editSelection: { excel },
  })
  if (backup.status !== 'stored') throw new Error('Fixture backup failed')
  fetch.mockClear()
  fetch.mockImplementation(async () =>
    response({
      status: 'prepared',
      source,
      backupFileId: backup.receipt.fileId,
      values: [[4, '=1+2']],
    })
  )
  return { backup, excel, fetch, values }
}
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
it('proposes the exact constant output of one completed run through the existing bound preview', async () => {
  const { backup, excel, fetch, values } = await ready()
  const preview = await prepareOfficeProcedureEdit({
    backup,
    result: source,
    excel,
    exclusiveLocalCopyConfirmed: true,
  })
  expect(preview.changes).toEqual([
    { row: 0, column: 0, before: 2, after: 4 },
    { row: 0, column: 1, before: 'literal', after: '=1+2' },
  ])
  expect(preview.backupFileId).toBe('backup-fixture')
  expect(values).toEqual([[2, 'literal']])
  expect(fetch).toHaveBeenCalledOnce()
  const [url, request] = fetch.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe('/api/workspaces/workspace-fixture/excel/office-procedure-preview')
  expect(JSON.parse(String(request.body))).toEqual({ source, backupFileId: 'backup-fixture' })
})

it('lists only the contract result descriptors without sending a user identity', async () => {
  const fetch = vi.fn(async (_url: string) => response({ items: [source], truncated: true }))
  vi.stubGlobal('fetch', fetch)
  expect(await listOfficeProcedureResults('workspace-fixture')).toEqual({
    items: [source],
    truncated: true,
  })
  expect(fetch.mock.calls[0][0]).toBe('/api/workspaces/workspace-fixture/excel/office-procedures')
})
it('rejects a copied backup and missing exclusive-copy confirmation before any HTTP or Office work', async () => {
  const { backup, excel, fetch } = await ready()
  await expect(
    prepareOfficeProcedureEdit({
      backup: JSON.parse(JSON.stringify(backup)),
      result: source,
      excel,
      exclusiveLocalCopyConfirmed: true,
    })
  ).rejects.toMatchObject({ code: 'invalid_context' })
  await expect(
    prepareOfficeProcedureEdit({
      backup,
      result: source,
      excel,
      exclusiveLocalCopyConfirmed: false,
    })
  ).rejects.toMatchObject({ code: 'exclusive_copy_required' })
  expect(fetch).not.toHaveBeenCalled()
})
it.each(['backup', 'version', 'workflow'] as const)(
  'rejects a mismatched %s response without preparing an edit',
  async (kind) => {
    const { backup, excel, fetch, values } = await ready()
    fetch.mockImplementation(async () =>
      response({
        status: 'prepared',
        backupFileId: kind === 'backup' ? 'other-backup' : backup.receipt.fileId,
        source: {
          ...source,
          ...(kind === 'version' ? { resultContentVersion: 8 } : {}),
          ...(kind === 'workflow' ? { workflowId: 'other-workflow' } : {}),
        },
        values: [[4, 'new']],
      })
    )
    await expect(
      prepareOfficeProcedureEdit({
        backup,
        result: source,
        excel,
        exclusiveLocalCopyConfirmed: true,
      })
    ).rejects.toMatchObject({ code: 'proposal_mismatch' })
    expect(values).toEqual([[2, 'literal']])
    expect(fetch).toHaveBeenCalledOnce()
  }
)
it('refuses a result with different dimensions instead of cropping, padding or guessing coordinates', async () => {
  const { backup, excel, fetch } = await ready()
  fetch.mockImplementation(async () =>
    response({ status: 'prepared', source, backupFileId: backup.receipt.fileId, values: [[4]] })
  )
  await expect(
    prepareOfficeProcedureEdit({ backup, result: source, excel, exclusiveLocalCopyConfirmed: true })
  ).rejects.toMatchObject({ code: 'selection_mismatch' })
})
it.each([
  { values: [[4, 'new'], [1]] },
  { values: [] },
  { values: [[4, 'new']], authority: 'PRIVATE' },
])(
  'rejects invalid projection shapes with a fixed error and no response content',
  async (invalid) => {
    const { backup, excel, fetch } = await ready()
    fetch.mockImplementation(async () =>
      response({ status: 'prepared', source, backupFileId: backup.receipt.fileId, ...invalid })
    )
    await expect(
      prepareOfficeProcedureEdit({
        backup,
        result: source,
        excel,
        exclusiveLocalCopyConfirmed: true,
      })
    ).rejects.toMatchObject({ code: 'result_unavailable', message: 'result_unavailable' })
  }
)
it('retains an authentication or permission refusal as unavailable, without raw server details or retry', async () => {
  const { backup, excel, fetch } = await ready()
  fetch.mockImplementation(async () => response({ error: 'PRIVATE_ACCOUNT' }, 403))
  await expect(
    prepareOfficeProcedureEdit({ backup, result: source, excel, exclusiveLocalCopyConfirmed: true })
  ).rejects.toMatchObject({ code: 'result_unavailable', message: 'result_unavailable' })
  expect(fetch).toHaveBeenCalledOnce()
})
it('does not accept a late response after cancellation or open a native edit', async () => {
  const { backup, excel, fetch, values } = await ready()
  const controller = new AbortController()
  let complete!: (v: Response) => void
  fetch.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve
      })
  )
  const pending = prepareOfficeProcedureEdit({
    backup,
    result: source,
    excel,
    exclusiveLocalCopyConfirmed: true,
    signal: controller.signal,
  })
  const expected = expect(pending).rejects.toMatchObject({ code: 'cancelled' })
  controller.abort()
  await expected
  complete(
    response({
      status: 'prepared',
      source,
      backupFileId: backup.receipt.fileId,
      values: [[4, 'new']],
    })
  )
  await Promise.resolve()
  expect(values).toEqual([[2, 'literal']])
  expect(fetch).toHaveBeenCalledOnce()
})
it('bounds an HTTP wait and ignores its late completion without retrying or starting Excel', async () => {
  const { backup, excel, fetch, values } = await ready()
  vi.useFakeTimers()
  let complete!: (v: Response) => void
  fetch.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve
      })
  )
  const pending = prepareOfficeProcedureEdit({
    backup,
    result: source,
    excel,
    exclusiveLocalCopyConfirmed: true,
  })
  const expected = expect(pending).rejects.toMatchObject({ code: 'timeout' })
  await vi.advanceTimersByTimeAsync(10_000)
  await expected
  complete(
    response({
      status: 'prepared',
      source,
      backupFileId: backup.receipt.fileId,
      values: [[4, 'new']],
    })
  )
  await Promise.resolve()
  expect(values).toEqual([[2, 'literal']])
  expect(fetch).toHaveBeenCalledOnce()
})
it('rechecks the same local Office binding after loading rather than accepting a changed SDK identity', async () => {
  const { backup, excel, fetch } = await ready()
  fetch.mockImplementation(async () => {
    excel.run = async () => undefined
    return response({
      status: 'prepared',
      source,
      backupFileId: backup.receipt.fileId,
      values: [[4, 'new']],
    })
  })
  await expect(
    prepareOfficeProcedureEdit({ backup, result: source, excel, exclusiveLocalCopyConfirmed: true })
  ).rejects.toMatchObject({ code: 'invalid_context' })
})
