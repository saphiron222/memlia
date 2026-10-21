// Copyright (c) 2026 Memlia. All rights reserved.
'use client'

import { z } from 'zod'
import {
  type ExcelTestPreparationBody,
  excelTestPreparationBodySchema,
  excelTestPreparationObservationSchema,
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
type Scope = z.infer<typeof scopeSchema>
type Recovery =
  | { status: 'empty' }
  | { status: 'blocked' }
  | { status: 'pending'; body: ExcelTestPreparationBody; entry: string }

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
    const parsed = recoverySchema.parse(JSON.parse(entry))
    if (
      parsed.userId !== scope.userId ||
      parsed.workspaceId !== scope.workspaceId ||
      parsed.workflowId !== scope.workflowId
    )
      return { status: 'blocked' }
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
    if (expectedEntry !== null) {
      const previous = readPreparationRecovery(scope)
      if (
        previous.status !== 'pending' ||
        previous.entry !== expectedEntry ||
        JSON.stringify(previous.body) !== JSON.stringify(parsed.body)
      )
        return { status: 'blocked' }
    } else {
      if (storage.getItem(storageKey) !== null) return { status: 'blocked' }
      storage.setItem(storageKey, canonical)
    }
    const entry = expectedEntry ?? canonical
    if (storage.getItem(storageKey) !== entry) return { status: 'blocked' }
    return { status: 'saved', entry, body: parsed.body }
  } catch {
    return { status: 'blocked' }
  }
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
