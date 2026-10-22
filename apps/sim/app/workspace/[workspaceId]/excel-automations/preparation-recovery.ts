// Copyright (c) 2026 Memlia. All rights reserved.
'use client'

import { z } from 'zod'
import {
  type ExcelTestPreparationBody,
  type ExcelTestPreparationReceipt,
  excelTestPreparationBodySchema,
  excelTestPreparationObservationSchema,
  excelTestPreparationReceiptSchema,
  runExcelTestBodySchema,
} from '@/lib/api/contracts/excel-test-preparations'

const scopeSchema = z.strictObject({
  userId: z.string().min(1).max(256),
  workspaceId: excelTestPreparationObservationSchema.shape.workspaceId,
  workflowId: excelTestPreparationObservationSchema.shape.workflowId,
})
const recoverySchema = scopeSchema.extend({
  version: z.literal(1),
  body: excelTestPreparationBodySchema,
})
const preparedRecoverySchema = scopeSchema.extend({
  version: z.literal(2),
  body: excelTestPreparationBodySchema,
  prepared: excelTestPreparationReceiptSchema,
  executionId: runExcelTestBodySchema.shape.executionId
    .regex(/^[A-Za-z0-9._:-]+(?![\s\S])/)
    .nullable(),
})
type Scope = z.infer<typeof scopeSchema>
type Recovery =
  | { status: 'empty' }
  | { status: 'blocked' }
  | { status: 'pending'; body: ExcelTestPreparationBody; entry: string }
  | {
      status: 'prepared'
      body: ExcelTestPreparationBody
      prepared: ExcelTestPreparationReceipt
      executionId: string | null
      entry: string
    }

function key(scope: Scope) {
  const parsed = scopeSchema.parse(scope)
  return `memlia:excel-test-preparation:v1:${JSON.stringify([
    parsed.userId,
    parsed.workspaceId,
    parsed.workflowId,
  ])}`
}

function bounded(entry: string) {
  // Bound before JSON.parse and before allocating an encoded copy.
  return entry.length <= 4096 && new TextEncoder().encode(entry).byteLength <= 4096
}

/** Local recovery data never grants permission: every POST is still authorized by the server. */
export function readPreparationRecovery(scope: Scope): Recovery {
  try {
    const entry = window.sessionStorage.getItem(key(scope))
    if (entry === null) return { status: 'empty' }
    if (!bounded(entry)) return { status: 'blocked' }
    const parsed = z.union([recoverySchema, preparedRecoverySchema]).parse(JSON.parse(entry))
    if (
      parsed.userId !== scope.userId ||
      parsed.workspaceId !== scope.workspaceId ||
      parsed.workflowId !== scope.workflowId
    )
      return { status: 'blocked' }
    if (parsed.version === 2) {
      if (parsed.prepared.workflowId !== scope.workflowId) return { status: 'blocked' }
      return {
        status: 'prepared',
        body: parsed.body,
        prepared: parsed.prepared,
        executionId: parsed.executionId,
        entry,
      }
    }
    return { status: 'pending', body: parsed.body, entry }
  } catch {
    return { status: 'blocked' }
  }
}

/** Synchronous compare/write/read before transport. Never replace another pending operation. */
export function persistPreparationRecovery(
  scope: Scope,
  body: ExcelTestPreparationBody,
  expectedEntry: string | null
): { status: 'saved'; entry: string; body: ExcelTestPreparationBody } | { status: 'blocked' } {
  try {
    const parsed = recoverySchema.parse({ ...scope, version: 1, body })
    const canonical = JSON.stringify(parsed)
    if (!bounded(canonical)) return { status: 'blocked' }
    const storage = window.sessionStorage
    const storageKey = key(scope)
    let entry = canonical
    if (expectedEntry !== null) {
      const previous = readPreparationRecovery(scope)
      if (
        (previous.status !== 'pending' && previous.status !== 'prepared') ||
        previous.entry !== expectedEntry ||
        (previous.status === 'pending'
          ? JSON.stringify(previous.body) !== JSON.stringify(parsed.body)
          : parsed.body.previousTestVersionId !== previous.prepared.deploymentVersionId ||
            parsed.body.operationId === previous.body.operationId)
      )
        return { status: 'blocked' }
      if (previous.status === 'prepared') storage.setItem(storageKey, canonical)
      else entry = expectedEntry
    } else {
      if (storage.getItem(storageKey) !== null) return { status: 'blocked' }
      storage.setItem(storageKey, canonical)
    }
    if (storage.getItem(storageKey) !== entry) return { status: 'blocked' }
    return { status: 'saved', entry, body: parsed.body }
  } catch {
    return { status: 'blocked' }
  }
}

/** A closed browser hint, never proof of a committed version or permission to run it. */
export function readPreparedRecovery(
  scope: Scope,
  body: ExcelTestPreparationBody,
  prepared: ExcelTestPreparationReceipt
) {
  try {
    const found = readPreparationRecovery(scope)
    if (
      found.status !== 'prepared' ||
      JSON.stringify(found.body) !== JSON.stringify(excelTestPreparationBodySchema.parse(body)) ||
      JSON.stringify(found.prepared) !==
        JSON.stringify(excelTestPreparationReceiptSchema.parse(prepared))
    )
      return { status: 'blocked' as const }
    return found
  } catch {
    return { status: 'blocked' as const }
  }
}

function replacePreparedRecovery(
  scope: Scope,
  value: unknown,
  expectedEntry: string
): { status: 'saved'; entry: string } | { status: 'blocked' } {
  try {
    const parsed = preparedRecoverySchema.parse(value)
    if (parsed.prepared.workflowId !== scope.workflowId) return { status: 'blocked' }
    const entry = JSON.stringify(parsed)
    if (!bounded(entry)) return { status: 'blocked' }
    const storage = window.sessionStorage
    const storageKey = key(scope)
    if (storage.getItem(storageKey) !== expectedEntry) return { status: 'blocked' }
    storage.setItem(storageKey, entry)
    return storage.getItem(storageKey) === entry
      ? { status: 'saved', entry }
      : { status: 'blocked' }
  } catch {
    return { status: 'blocked' }
  }
}

/** Retain a received hint only if the exact pending operation still occupies its slot. */
export function retainPreparedRecovery(
  scope: Scope,
  body: ExcelTestPreparationBody,
  prepared: ExcelTestPreparationReceipt,
  expectedEntry: string
) {
  try {
    const pending = readPreparationRecovery(scope)
    if (
      pending.status !== 'pending' ||
      pending.entry !== expectedEntry ||
      JSON.stringify(pending.body) !== JSON.stringify(excelTestPreparationBodySchema.parse(body))
    )
      return { status: 'blocked' as const }
    return replacePreparedRecovery(
      scope,
      { ...scope, version: 2, body, prepared, executionId: null },
      expectedEntry
    )
  } catch {
    return { status: 'blocked' as const }
  }
}

/** Persist the sole attempt ID before transport; an existing ID can never be replaced. */
export function persistExecutionRecovery(
  scope: Scope,
  body: ExcelTestPreparationBody,
  prepared: ExcelTestPreparationReceipt,
  executionId: string,
  expectedEntry: string
) {
  const found = readPreparedRecovery(scope, body, prepared)
  if (found.status !== 'prepared' || found.entry !== expectedEntry || found.executionId !== null)
    return { status: 'blocked' as const }
  return replacePreparedRecovery(
    scope,
    { ...scope, version: 2, body, prepared, executionId },
    expectedEntry
  )
}

/** Call only after a validated receipt for the captured live request; preserve foreign state. */
export function clearPreparationRecovery(scope: Scope, expectedEntry: string): boolean {
  try {
    const storage = window.sessionStorage
    const storageKey = key(scope)
    if (storage.getItem(storageKey) !== expectedEntry) return false
    storage.removeItem(storageKey)
    return storage.getItem(storageKey) === null
  } catch {
    return false
  }
}
