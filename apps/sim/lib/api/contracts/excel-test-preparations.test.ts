// Copyright (c) 2026 Memlia. All rights reserved.
import { describe, expect, it } from 'vitest'
import {
  excelTestPreparationBodySchema,
  excelTestPreparationObservationSchema,
  excelTestPreparationQuerySchema,
  excelTestPreparationReceiptSchema,
} from './excel-test-preparations'

const digest = `sha256:${'a'.repeat(64)}`
const body = { expectedRevision: 7, expectedStateDigest: digest, operationId: 'operation-7' }
const observation = {
  workflowId: 'workflow',
  workspaceId: 'space',
  expectedRevision: 7,
  expectedStateDigest: digest,
}
const receipt = {
  status: 'prepared_for_test',
  workflowId: 'workflow',
  deploymentVersionId: 'version-7',
  version: 7,
  snapshotDigest: digest,
  executionAvailable: false,
  activationAvailable: false,
}

describe('contrat de préparation inactive Excel', () => {
  it('transmet les préconditions exactes et une lignée serveur facultative', () => {
    expect(excelTestPreparationBodySchema.parse(body)).toEqual(body)
    expect(
      excelTestPreparationBodySchema.parse({ ...body, previousTestVersionId: 'previous-6' })
    ).toEqual({ ...body, previousTestVersionId: 'previous-6' })
    expect(excelTestPreparationQuerySchema.parse({ workspaceId: 'space' })).toEqual({
      workspaceId: 'space',
    })
    expect(excelTestPreparationObservationSchema.parse(observation)).toEqual(observation)
    expect(excelTestPreparationReceiptSchema.parse(receipt)).toEqual(receipt)
  })
  it.each([
    'actorId',
    'organizationId',
    'workflowId',
    'scope',
    'policyVersion',
    'procedure',
    'workflowState',
    'activate',
    'tx',
  ])('refuse le champ client %s au lieu de le retirer silencieusement', (key) => {
    expect(excelTestPreparationBodySchema.safeParse({ ...body, [key]: 'untrusted' }).success).toBe(
      false
    )
  })
  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '7', null])(
    'refuse la révision %j',
    (expectedRevision) => {
      expect(excelTestPreparationBodySchema.safeParse({ ...body, expectedRevision }).success).toBe(
        false
      )
    }
  )
  it.each(['', `sha256:${'A'.repeat(64)}`, `${digest}\n`, 'a'.repeat(64)])(
    'refuse le digest non canonique %j',
    (expectedStateDigest) => {
      expect(
        excelTestPreparationBodySchema.safeParse({ ...body, expectedStateDigest }).success
      ).toBe(false)
    }
  )
  it.each(['', 'a/b', 'a\nb', 'a'.repeat(129)])('refuse l’opération malformée', (operationId) => {
    expect(excelTestPreparationBodySchema.safeParse({ ...body, operationId }).success).toBe(false)
  })
  it('refuse la portée absente, modifiée ou supplémentaire', () => {
    for (const input of [
      {},
      { workspaceId: ' space' },
      { workspaceId: 'space', actorId: 'subject' },
    ]) {
      expect(excelTestPreparationQuerySchema.safeParse(input).success).toBe(false)
    }
  })
  it('ne laisse exposer ni graphe ni types ni autorité d’exécution', () => {
    expect(
      excelTestPreparationObservationSchema.safeParse({ ...observation, blocks: {} }).success
    ).toBe(false)
    expect(
      excelTestPreparationObservationSchema.safeParse({
        ...observation,
        blockTypes: ['memlia_excel'],
      }).success
    ).toBe(false)
    expect(
      excelTestPreparationReceiptSchema.safeParse({ ...receipt, activationAvailable: true }).success
    ).toBe(false)
    expect(
      excelTestPreparationReceiptSchema.safeParse({ ...receipt, executionAvailable: true }).success
    ).toBe(false)
  })
})
