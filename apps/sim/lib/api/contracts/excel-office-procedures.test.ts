// Copyright (c) 2026 Memlia. All rights reserved.
import { describe, expect, it, vi } from 'vitest'
import {
  officeProcedurePreviewSchema,
  prepareOfficeProcedureEditContract,
} from './excel-office-procedures'

const source = {
  workflowId: 'workflow-1',
  deploymentVersionId: 'deployment-1',
  blockId: 'block-1',
  executionId: 'execution-1',
  resultFileId: 'result-1',
  resultContentVersion: 1,
  workflowName: 'Traitement',
  procedureName: 'Résultat calculé',
  fileName: 'result.xlsx',
  completedAt: '2026-10-21T08:00:00.000Z',
}
const preview = {
  status: 'prepared',
  source,
  backupFileId: 'backup-1',
  values: [
    [1, 'texte'],
    [false, null],
  ],
}

describe('Office procedure result boundary', () => {
  it('bounds shared string expansion without serializing an oversized proposal', () => {
    const large = { ...preview, values: [Array(10_000).fill('a'.repeat(32_767))] }
    // Intercept before any expanded JSON allocation. A size guard must not serialize this.
    const original = JSON.stringify.bind(JSON)
    const expanded = vi.fn(() => 'null')
    const stringify = vi
      .spyOn(JSON, 'stringify')
      .mockImplementation((value, ...rest) =>
        value &&
        typeof value === 'object' &&
        Array.isArray(value.values) &&
        value.values[0]?.length === 10_000
          ? expanded()
          : original(value, ...rest)
      )
    try {
      expect(officeProcedurePreviewSchema.safeParse(large).success).toBe(false)
      expect(expanded).not.toHaveBeenCalled()
    } finally {
      stringify.mockRestore()
    }
  })
  it('accepts literal scalar data, including a leading equals sign, without formula intent', () => {
    expect(officeProcedurePreviewSchema.safeParse({ ...preview, values: [['=1+2']] }).success).toBe(
      true
    )
  })
  it('rejects ragged or empty matrices rather than inventing missing cells', () => {
    for (const values of [[], [[]], [[1], [2, 3]]])
      expect(officeProcedurePreviewSchema.safeParse({ ...preview, values }).success).toBe(false)
  })
  it('rejects non-scalar cells and non-finite numbers before an edit can be prepared', () => {
    for (const value of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      { formula: '=WEBSERVICE("https://example.invalid")' },
    ])
      expect(
        officeProcedurePreviewSchema.safeParse({ ...preview, values: [[value]] }).success
      ).toBe(false)
  })
  it('refuses data exceeding the native selection ceiling', () => {
    expect(
      officeProcedurePreviewSchema.safeParse({ ...preview, values: [Array(10_001).fill(1)] })
        .success
    ).toBe(false)
  })
  it('rejects an unbound result or an extra executable payload', () => {
    expect(
      officeProcedurePreviewSchema.safeParse({ ...preview, source: { ...source, executionId: '' } })
        .success
    ).toBe(false)
    expect(
      officeProcedurePreviewSchema.safeParse({ ...preview, execute: 'arbitrary' }).success
    ).toBe(false)
  })
  it('accepts references only in a request, never caller-supplied owner or matrix authority', () => {
    const body = prepareOfficeProcedureEditContract.body!
    expect(body.safeParse({ source, backupFileId: 'backup-1' }).success).toBe(true)
    expect(
      body.safeParse({ source, backupFileId: 'backup-1', ownerUserId: 'colleague' }).success
    ).toBe(false)
    expect(body.safeParse({ source, backupFileId: 'backup-1', values: [[1]] }).success).toBe(false)
  })
})
