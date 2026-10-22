// Copyright (c) 2026 Memlia. All rights reserved.
import { ExcelProcedureSchema } from '@memlia/contracts'
import { sha256Hex } from '@sim/security/hash'
import { z } from 'zod'
import { type WorkflowStateContractInput, workflowStateSchema } from '@/lib/api/contracts/workflows'
import { stringifyBoundedJson } from '@/lib/core/utils/bounded-json'
import { normalizedStringify } from '@/lib/workflows/comparison/normalize'
import { excelProcedureDraftSchema } from './procedure-capabilities'
import { validateExcelProcedureDraftDataflow } from './procedure-dataflow'

const shape = ExcelProcedureSchema.shape
const revision = z.int().min(0).max(Number.MAX_SAFE_INTEGER)
const scopeSchema = z.strictObject({
  organizationId: shape.organizationId,
  workspaceId: shape.workspaceId,
  workflowId: shape.workflowId,
})
const procedurePlanSchema = z.strictObject({
  blockId: shape.procedureId,
  expectedRequestDigest: shape.digest,
  procedureId: shape.procedureId,
  version: shape.version,
  parentVersion: shape.parentVersion,
  ownerUserId: shape.ownerUserId,
  policyVersion: shape.policyVersion,
})
const planSchema = z.strictObject({
  workflowState: z.unknown(),
  expectedRevision: revision,
  expectedStateDigest: shape.digest,
  scope: scopeSchema,
  procedures: z.array(procedurePlanSchema).min(1).max(32),
})
const currentSchema = z.strictObject({ workflowState: z.unknown(), revision, scope: scopeSchema })
const deploymentSchema = z.strictObject({ id: shape.deployedVersionId, version: shape.version })
// Only the procedure is materialized. Sources/output are preserved, not authorized or interpreted.
const requestSchema = z.strictObject({
  procedure: excelProcedureDraftSchema,
  sources: z.unknown(),
  output: z.unknown(),
})
const captures = new WeakMap<object, z.output<typeof planSchema>>()
const MAX_GRAPH_BYTES = 2 * 1024 * 1024
const MAX_REQUEST_BYTES = 512 * 1024
function refuse(): never {
  throw new Error('excel_materialization_refused')
}
function copy(value: unknown, limit = MAX_GRAPH_BYTES): unknown {
  const json = stringifyBoundedJson(value, limit, { strict: true })
  if (json === undefined) refuse()
  return JSON.parse(json)
}
function digest(value: unknown): string {
  return `sha256:${sha256Hex(normalizedStringify(value))}`
}
function isState(value: unknown): value is WorkflowStateContractInput {
  return workflowStateSchema.safeParse(value).success
}
function state(value: unknown) {
  // Validate without projecting: native schema parsing would strip unknown graph metadata.
  if (!isState(value)) refuse()
  return value
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
function readRequest(graph: WorkflowStateContractInput, blockId: string) {
  if (!Object.hasOwn(graph.blocks, blockId)) refuse()
  const block = graph.blocks[blockId]
  if (block.id !== blockId || block.type !== 'memlia_excel') refuse()
  const subBlock = block.subBlocks.request
  if (
    !subBlock ||
    subBlock.id !== 'request' ||
    subBlock.type !== 'code' ||
    typeof subBlock.value !== 'string'
  )
    refuse()
  if (Buffer.byteLength(subBlock.value, 'utf8') > MAX_REQUEST_BYTES) refuse()
  const request = requestSchema.parse(copy(JSON.parse(subBlock.value), MAX_REQUEST_BYTES))
  if (!Object.hasOwn(request, 'sources') || !Object.hasOwn(request, 'output')) refuse()
  if (!validateExcelProcedureDraftDataflow(request.procedure).declaredDataflowValid) refuse()
  return request
}

/** Capture before awaiting authorization/locks. An opaque capture is ownership, never authority. */
export function captureExcelProcedureSnapshot(input: unknown): object {
  try {
    const plan = planSchema.parse(copy(input))
    const graph = state(plan.workflowState)
    if (digest(graph) !== plan.expectedStateDigest) refuse()
    const blockIds = new Set(plan.procedures.map((item) => item.blockId))
    const procedureIds = new Set(plan.procedures.map((item) => item.procedureId))
    if (blockIds.size !== plan.procedures.length || procedureIds.size !== plan.procedures.length)
      refuse()
    const excelIds = Object.entries(graph.blocks)
      .filter(([, block]) => block.type === 'memlia_excel')
      .map(([id]) => id)
    if (excelIds.length !== blockIds.size || excelIds.some((id) => !blockIds.has(id))) refuse()
    for (const item of plan.procedures) {
      if (
        (item.version === 1) !== (item.parentVersion === null) ||
        (item.parentVersion !== null && item.parentVersion >= item.version)
      )
        refuse()
      if (digest(readRequest(graph, item.blockId)) !== item.expectedRequestDigest) refuse()
    }
    const handle: object = Object.freeze(Object.create(null))
    captures.set(handle, freeze(plan))
    return handle
  } catch {
    return refuse()
  }
}

/** Pure server-only assembly after native locking. No insert, activation, approval or execution. */
export function materializeExcelProcedureSnapshot(
  capture: object,
  current: unknown,
  deployment: unknown
) {
  try {
    const plan = captures.get(capture)
    if (!plan) refuse()
    const locked = currentSchema.parse(copy(current))
    const identity = deploymentSchema.parse(copy(deployment, 4096))
    const graph = state(locked.workflowState)
    if (
      locked.revision !== plan.expectedRevision ||
      digest(graph) !== plan.expectedStateDigest ||
      digest(locked.scope) !== digest(plan.scope)
    )
      refuse()
    const procedures = []
    for (const item of plan.procedures) {
      const request = readRequest(graph, item.blockId)
      const unsigned = {
        schemaVersion: 'memlia.excel-procedure/v1' as const,
        ...plan.scope,
        procedureId: item.procedureId,
        version: item.version,
        parentVersion: item.parentVersion,
        deployedVersionId: identity.id,
        ownerUserId: item.ownerUserId,
        policyVersion: item.policyVersion,
        ...request.procedure,
      }
      const procedure = ExcelProcedureSchema.parse({ ...unsigned, digest: digest(unsigned) })
      const encoded = stringifyBoundedJson({ ...request, procedure }, MAX_REQUEST_BYTES, {
        strict: true,
      })
      if (encoded === undefined) refuse()
      graph.blocks[item.blockId].subBlocks.request.value = encoded
      procedures.push({
        blockId: item.blockId,
        procedureId: procedure.procedureId,
        version: procedure.version,
        digest: procedure.digest,
      })
    }
    if (stringifyBoundedJson(graph, MAX_GRAPH_BYTES, { strict: true }) === undefined) refuse()
    // Hash the actual graph including every materialized request, not the pre-deployment draft.
    return freeze({
      workflowState: graph,
      deployment: identity,
      inputDigest: digest(plan),
      snapshotDigest: digest(graph),
      procedures,
    })
  } catch {
    return refuse()
  }
}

/** Read immutable capture identity only; this confers no permission or deployment authority. */
export function readExcelProcedureSnapshotCapture(capture: unknown) {
  if (!capture || typeof capture !== 'object') return refuse()
  const plan = captures.get(capture)
  if (!plan) return refuse()
  return freeze({
    scope: { ...plan.scope },
    expectedRevision: plan.expectedRevision,
    expectedStateDigest: plan.expectedStateDigest,
    inputDigest: digest(plan),
  })
}
