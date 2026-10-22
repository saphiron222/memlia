// Modified by Memlia: opt-in Excel materialization and refusal to activate test-only snapshots.
import {
  db,
  workflow,
  workflowDeploymentOperation,
  workflowDeploymentVersion,
  workspace,
} from '@sim/db'
import { createLogger } from '@sim/logger'
import { sha256Hex } from '@sim/security/hash'
import { generateId } from '@sim/utils/id'
import { loadWorkflowFromNormalizedTablesRaw } from '@sim/workflow-persistence/load'
import {
  assertWorkflowDraftTransaction,
  lockWorkflowDraft,
  WorkflowDraftError,
} from '@sim/workflow-persistence/revision'
import type { DbOrTx } from '@sim/workflow-persistence/types'
import type { WorkflowState } from '@sim/workflow-types/workflow'
import type { InferSelectModel } from 'drizzle-orm'
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { readOwnDataString, stringifyBoundedJson } from '@/lib/core/utils/bounded-json'
import type { DbTransaction } from '@/lib/db/types'
import {
  materializeExcelProcedureSnapshot,
  readExcelProcedureSnapshotCapture,
} from '@/lib/memlia/excel/materialize-procedure-snapshot'
import { normalizedStringify } from '@/lib/workflows/comparison/normalize'
import {
  canTransitionDeploymentOperation,
  createDeploymentReadiness,
  DEPLOYMENT_OPERATION_PROTOCOL_VERSION,
  type DeploymentComponentStatus,
  type DeploymentOperationAction,
  type DeploymentOperationStatus,
  type DeploymentReadiness,
  isDeploymentOperationAction,
  isDeploymentOperationStatus,
  isDeploymentReadinessComplete,
  parseDeploymentReadiness,
  toSafeDeploymentError,
} from '@/lib/workflows/deployment-lifecycle'

const logger = createLogger('DeploymentOperations')

export type WorkflowDeploymentOperation = InferSelectModel<typeof workflowDeploymentOperation>

type PrepareFailureReason =
  | 'workflow_not_found'
  | 'workflow_archived'
  | 'deployment_version_not_found'
  | 'idempotency_conflict'
  | 'invalid_request'

type MutationFailureReason =
  | 'operation_not_found'
  | 'invalid_transition'
  | 'stale_generation'
  | 'invalid_readiness'
  | 'not_ready'
  | 'deployment_version_not_found'

export type PrepareDeploymentOperationResult =
  | { success: true; operation: WorkflowDeploymentOperation; reused: boolean }
  | { success: false; reason: PrepareFailureReason; error: string }

export type DeploymentOperationMutationResult =
  | { success: true; operation: WorkflowDeploymentOperation }
  | { success: false; reason: MutationFailureReason; error: string }

interface PrepareOperationBase {
  workflowId: string
  actorId: string
  requestHash: string
  idempotencyKey?: string
  readinessComponents?: readonly string[]
  tx?: DbOrTx
  onPrepareTransaction?: (tx: DbOrTx, operation: WorkflowDeploymentOperation) => Promise<void>
}

export interface PrepareWorkflowDeploymentParams extends PrepareOperationBase {
  workflowState: WorkflowState
  /** Server-owned opaque capture; present invalid values refuse, never fall back. */
  excelProcedureSnapshot?: unknown
  name?: string | null
  description?: string | null
  /** Correlation ID for logging only. */
  requestId?: string
}

export interface PrepareWorkflowVersionActivationParams extends PrepareOperationBase {
  deploymentVersionId: string
}

export interface DeploymentOperationGeneration {
  workflowId: string
  operationId: string
  generation: number
}

/**
 * Identifies the operation a fenced step belongs to, optionally narrowed to
 * the version it targets and the statuses it may currently hold.
 */
export type DeploymentOperationFence = DeploymentOperationGeneration & {
  deploymentVersionId?: string
  statuses?: readonly DeploymentOperationStatus[]
}

export interface WorkflowDeploymentStatus {
  activeDeployment: {
    deploymentVersionId: string
    version: number
    deployedAt: Date
  } | null
  latestOperation: WorkflowDeploymentOperation | null
}

export interface MarkDeploymentComponentReadinessParams extends DeploymentOperationGeneration {
  component: string
  status: DeploymentComponentStatus
  expectedStatus?: DeploymentComponentStatus
}

export interface ActivateDeploymentOperationParams extends DeploymentOperationGeneration {
  onActivateTransaction?: (
    tx: DbTransaction,
    operation: WorkflowDeploymentOperation
  ) => Promise<void>
}

interface PrepareOperationContext {
  tx: DbOrTx
  now: Date
  actorId: string
  workflowId: string
}

interface OperationTarget {
  deploymentVersionId: string
  version: number
}

type ResolveOperationTarget = (context: PrepareOperationContext) =>
  | Promise<
      | { success: true; target: OperationTarget }
      | { success: false; reason: PrepareFailureReason; error: string }
    >
  | {
      success: true
      target: OperationTarget
    }
  | { success: false; reason: PrepareFailureReason; error: string }

const IN_FLIGHT_STATUSES: DeploymentOperationStatus[] = ['preparing', 'activating']

const DEPLOYMENT_TX_STATEMENT_TIMEOUT_MS = 30_000
const DEPLOYMENT_TX_LOCK_TIMEOUT_MS = 5_000
const DEPLOYMENT_TX_IDLE_TIMEOUT_MS = 30_000

/**
 * Applies transaction-scoped Postgres safety timeouts in one round trip.
 *
 * Deployment transactions hold the workflow-row lock plus webhook and
 * operation row locks across several statements; the idle timeout is the
 * backstop that stops a wedged client from pinning those locks indefinitely,
 * and `lock_timeout` keeps a waiter from inheriting the full statement clock.
 * `set_config(..., true)` is `SET LOCAL`-scoped, so it clears at
 * COMMIT/ROLLBACK and is safe under PgBouncer transaction pooling.
 */
export async function setDeploymentTxTimeouts(tx: DbOrTx): Promise<void> {
  await tx.execute(
    sql`SELECT set_config('statement_timeout', ${`${DEPLOYMENT_TX_STATEMENT_TIMEOUT_MS}ms`}, true),
        set_config('lock_timeout', ${`${DEPLOYMENT_TX_LOCK_TIMEOUT_MS}ms`}, true),
        set_config('idle_in_transaction_session_timeout', ${`${DEPLOYMENT_TX_IDLE_TIMEOUT_MS}ms`}, true)`
  )
}

/**
 * Creates an inactive immutable snapshot and a preparing deployment attempt.
 */
export async function prepareWorkflowDeployment(
  params: PrepareWorkflowDeploymentParams
): Promise<PrepareDeploymentOperationResult> {
  if (Object.hasOwn(params, 'excelProcedureSnapshot')) return prepareExcelSnapshotDeployment(params)
  return prepareOperation(params, 'deploy', async ({ tx, now, actorId, workflowId }) => {
    const [{ maxVersion }] = await tx
      .select({ maxVersion: sql<number>`COALESCE(MAX(${workflowDeploymentVersion.version}), 0)` })
      .from(workflowDeploymentVersion)
      .where(eq(workflowDeploymentVersion.workflowId, workflowId))
      .limit(1)
    const version = Number(maxVersion) + 1
    const deploymentVersionId = generateId()

    await tx.insert(workflowDeploymentVersion).values({
      id: deploymentVersionId,
      workflowId,
      version,
      name: params.name?.trim() || null,
      description: params.description?.trim() || null,
      state: params.workflowState,
      isActive: false,
      createdAt: now,
      createdBy: actorId,
    })

    return {
      success: true,
      target: { deploymentVersionId, version },
    }
  })
}

type LockedExcelSnapshot = { capture: object; current: unknown; requestId?: string }
type ExcelRefusalContext = { requestId?: string; workflowId?: string }

const ERROR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const SQLSTATE = /^[0-9A-Z]{5}$/
function errorName(error: unknown): string | undefined {
  return error instanceof Error && ERROR_NAME.test(error.name) ? error.name : undefined
}
function sqlState(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' && SQLSTATE.test(code) ? code : undefined
}

/**
 * Error class and SQLSTATE only, never a message: a Drizzle query error's message carries the SQL
 * and its parameters. Drizzle wraps driver errors, so the SQLSTATE is read on the error or its
 * direct `cause` (one level).
 */
export function deploymentRefusalErrorFields(error: unknown): Record<string, string> {
  try {
    const cause = error instanceof Error ? error.cause : undefined
    const fields: Record<string, string> = {}
    const name = errorName(error)
    const causeName = errorName(cause)
    const state = sqlState(error) ?? sqlState(cause)
    if (name) fields.errorName = name
    if (causeName) fields.causeName = causeName
    if (state) fields.sqlState = state
    return fields
  } catch {
    return {}
  }
}

/** Logs the internal code of the refusing check; the caller only sees the fixed refusal. */
function excelSnapshotRefused(
  context: ExcelRefusalContext,
  check: string,
  extra: Record<string, string> = {}
): PrepareDeploymentOperationResult & { success: false } {
  logger.error(`[${context.requestId}] Excel deployment snapshot refused`, {
    workflowId: context.workflowId,
    check,
    ...extra,
  })
  return { success: false, reason: 'invalid_request', error: 'Excel deployment snapshot refused' }
}

async function prepareExcelSnapshotDeployment(
  input: PrepareWorkflowDeploymentParams
): Promise<PrepareDeploymentOperationResult> {
  // Read every caller-owned value before the first await; never re-read mutable params in a TX.
  let capture: object
  let identity: ReturnType<typeof readExcelProcedureSnapshotCapture>
  let params: PrepareOperationBase & { name?: string | null; description?: string | null }
  // Correlation reads run no caller accessor; caller values are read inside the try below.
  const refusal: ExcelRefusalContext = {
    requestId: readOwnDataString(input, ['requestId']),
    workflowId: readOwnDataString(input, ['workflowId']),
  }
  let check = 'capture_handle'
  try {
    const candidate = input.excelProcedureSnapshot
    identity = readExcelProcedureSnapshotCapture(candidate)
    if (!candidate || typeof candidate !== 'object') return excelSnapshotRefused(refusal, check)
    capture = candidate
    check = 'caller_input'
    params = {
      workflowId: input.workflowId,
      actorId: input.actorId,
      requestHash: input.requestHash,
      idempotencyKey: input.idempotencyKey,
      tx: input.tx,
      readinessComponents: input.readinessComponents && [...input.readinessComponents],
      onPrepareTransaction: input.onPrepareTransaction,
      name: input.name,
      description: input.description,
    }
    const stateJson = stringifyBoundedJson(input.workflowState, 2 * 1024 * 1024, { strict: true })
    if (stateJson === undefined) return excelSnapshotRefused(refusal, 'state_not_strict_json')
    check = 'capture_identity_mismatch'
    if (
      identity.scope.workflowId !== params.workflowId ||
      typeof params.actorId !== 'string' ||
      typeof params.requestHash !== 'string' ||
      (params.name != null && typeof params.name !== 'string') ||
      (params.description != null && typeof params.description !== 'string') ||
      `sha256:${sha256Hex(normalizedStringify(JSON.parse(stateJson)))}` !==
        identity.expectedStateDigest
    ) {
      return excelSnapshotRefused(refusal, check)
    }
  } catch {
    return excelSnapshotRefused(refusal, check)
  }

  const prepare = async (tx: DbOrTx): Promise<PrepareDeploymentOperationResult> => {
    // This is the same workflow row lock acquired by all native normalized draft writers.
    // Read raw tables after that lock: do not run opportunistic block migrations or add Date.now().
    assertWorkflowDraftTransaction(tx)
    let snapshot: LockedExcelSnapshot
    try {
      const revision = await lockWorkflowDraft(tx, params.workflowId, identity.expectedRevision)
      const [row] = await tx
        .select({ workspaceId: workflow.workspaceId, variables: workflow.variables })
        .from(workflow)
        .where(eq(workflow.id, params.workflowId))
        .limit(1)
      if (!row || row.workspaceId !== identity.scope.workspaceId)
        return excelSnapshotRefused(refusal, 'workflow_row')
      const [space] = await tx
        .select({ organizationId: workspace.organizationId, archivedAt: workspace.archivedAt })
        .from(workspace)
        .where(eq(workspace.id, row.workspaceId))
        .limit(1)
        .for('share')
      if (!space || space.archivedAt || space.organizationId !== identity.scope.organizationId)
        return excelSnapshotRefused(refusal, 'workspace')
      const raw = await loadWorkflowFromNormalizedTablesRaw(params.workflowId, tx)
      if (!raw || raw.workspaceId !== row.workspaceId || raw.draftRevision !== revision)
        return excelSnapshotRefused(refusal, 'raw_draft')
      // Native normalized serialization drops only undefined optional DB-reader properties.
      const graph: unknown = JSON.parse(
        normalizedStringify({
          blocks: raw.blocks,
          edges: raw.edges,
          loops: raw.loops,
          parallels: raw.parallels,
          variables: row.variables ?? {},
        })
      )
      if (`sha256:${sha256Hex(normalizedStringify(graph))}` !== identity.expectedStateDigest)
        return excelSnapshotRefused(refusal, 'state_digest')
      snapshot = {
        capture,
        current: { workflowState: graph, revision, scope: identity.scope },
        requestId: refusal.requestId,
      }
    } catch (error) {
      if (error instanceof WorkflowDraftError && error.code === 'conflict')
        return excelSnapshotRefused(refusal, 'draft_revision_conflict')
      return excelSnapshotRefused(
        refusal,
        'locked_read_failed',
        deploymentRefusalErrorFields(error)
      )
    }
    return prepareOperation(
      { ...params, tx },
      'deploy',
      async ({ now, actorId, workflowId }) => {
        const [{ maxVersion }] = await tx
          .select({
            maxVersion: sql<number>`COALESCE(MAX(${workflowDeploymentVersion.version}), 0)`,
          })
          .from(workflowDeploymentVersion)
          .where(eq(workflowDeploymentVersion.workflowId, workflowId))
          .limit(1)
        const version = Number(maxVersion) + 1
        const deploymentVersionId = generateId()
        const materialized = materializeExcelProcedureSnapshot(snapshot.capture, snapshot.current, {
          id: deploymentVersionId,
          version,
        })
        await tx.insert(workflowDeploymentVersion).values({
          id: deploymentVersionId,
          workflowId,
          version,
          name: params.name?.trim() || null,
          description: params.description?.trim() || null,
          state: materialized.workflowState,
          snapshotDigest: materialized.snapshotDigest,
          isActive: false,
          createdAt: now,
          createdBy: actorId,
        })
        return { success: true, target: { deploymentVersionId, version } }
      },
      snapshot
    )
  }
  if (params.tx) return prepare(params.tx)
  return db.transaction(async (tx) => {
    await setDeploymentTxTimeouts(tx)
    return prepare(tx)
  })
}

/**
 * Creates a preparing attempt targeting an existing immutable snapshot.
 */
export async function prepareWorkflowVersionActivation(
  params: PrepareWorkflowVersionActivationParams
): Promise<PrepareDeploymentOperationResult> {
  return prepareOperation(params, 'activate', async ({ tx, workflowId }) => {
    const [versionRow] = await tx
      .select({
        id: workflowDeploymentVersion.id,
        version: workflowDeploymentVersion.version,
        createdAt: workflowDeploymentVersion.createdAt,
        preparationKind: workflowDeploymentVersion.preparationKind,
      })
      .from(workflowDeploymentVersion)
      .where(
        and(
          eq(workflowDeploymentVersion.workflowId, workflowId),
          eq(workflowDeploymentVersion.id, params.deploymentVersionId)
        )
      )
      .limit(1)

    if (!versionRow) {
      return {
        success: false,
        reason: 'deployment_version_not_found',
        error: 'Deployment version not found',
      }
    }
    if (versionRow.preparationKind !== null) {
      return {
        success: false,
        reason: 'invalid_request',
        error: 'Excel test snapshot cannot be activated',
      }
    }

    return {
      success: true,
      target: {
        deploymentVersionId: versionRow.id,
        version: versionRow.version,
      },
    }
  })
}

/**
 * Returns the active immutable version and latest deployment attempt for a workflow.
 */
export async function getWorkflowDeploymentStatus(
  workflowId: string
): Promise<WorkflowDeploymentStatus> {
  const [[activeVersion], [workflowRow], [latestOperation]] = await Promise.all([
    db
      .select({
        id: workflowDeploymentVersion.id,
        version: workflowDeploymentVersion.version,
        createdAt: workflowDeploymentVersion.createdAt,
      })
      .from(workflowDeploymentVersion)
      .where(
        and(
          eq(workflowDeploymentVersion.workflowId, workflowId),
          eq(workflowDeploymentVersion.isActive, true)
        )
      )
      .orderBy(desc(workflowDeploymentVersion.version))
      .limit(1),
    db
      .select({ deployedAt: workflow.deployedAt })
      .from(workflow)
      .where(eq(workflow.id, workflowId))
      .limit(1),
    db
      .select()
      .from(workflowDeploymentOperation)
      .where(eq(workflowDeploymentOperation.workflowId, workflowId))
      .orderBy(desc(workflowDeploymentOperation.generation))
      .limit(1),
  ])

  return {
    activeDeployment: activeVersion
      ? {
          deploymentVersionId: activeVersion.id,
          version: activeVersion.version,
          deployedAt: workflowRow?.deployedAt ?? activeVersion.createdAt,
        }
      : null,
    latestOperation: latestOperation ?? null,
  }
}

/**
 * Loads one generation-scoped operation for an outbox worker.
 */
export async function getDeploymentOperation(
  params: DeploymentOperationGeneration
): Promise<WorkflowDeploymentOperation | null> {
  const [operation] = await db
    .select()
    .from(workflowDeploymentOperation)
    .where(
      and(
        eq(workflowDeploymentOperation.id, params.operationId),
        eq(workflowDeploymentOperation.workflowId, params.workflowId),
        eq(workflowDeploymentOperation.generation, params.generation)
      )
    )
    .limit(1)

  return operation ?? null
}

/**
 * Confirms an operation still owns the workflow's latest generation.
 */
export async function isDeploymentOperationCurrent(
  params: DeploymentOperationFence,
  executor: Pick<DbOrTx, 'select'> = db
): Promise<boolean> {
  const [latestOperation] = await executor
    .select({
      id: workflowDeploymentOperation.id,
      generation: workflowDeploymentOperation.generation,
      deploymentVersionId: workflowDeploymentOperation.deploymentVersionId,
      status: workflowDeploymentOperation.status,
    })
    .from(workflowDeploymentOperation)
    .where(eq(workflowDeploymentOperation.workflowId, params.workflowId))
    .orderBy(desc(workflowDeploymentOperation.generation))
    .limit(1)

  if (
    !latestOperation ||
    latestOperation.id !== params.operationId ||
    latestOperation.generation !== params.generation ||
    (params.deploymentVersionId !== undefined &&
      latestOperation.deploymentVersionId !== params.deploymentVersionId)
  ) {
    return false
  }
  if (!params.statuses) return true
  if (!isDeploymentOperationStatus(latestOperation.status)) return false
  return params.statuses.includes(latestOperation.status)
}

/**
 * Protects an inactive v2 candidate from rolling-deploy v1 cleanup workers.
 */
export async function isDeploymentVersionProtectedByCurrentOperation(
  workflowId: string,
  deploymentVersionId: string,
  executor: Pick<DbOrTx, 'select'> = db
): Promise<boolean> {
  return (await getProtectedDeploymentVersionId(workflowId, executor)) === deploymentVersionId
}

/**
 * The deployment version the current operation is still preparing, or null
 * once the latest operation is terminal. Cleanup must leave this version
 * alone: it is inactive until cutover, yet its schedules and webhook
 * candidates are live preparation state.
 */
export async function getProtectedDeploymentVersionId(
  workflowId: string,
  executor: Pick<DbOrTx, 'select'> = db
): Promise<string | null> {
  const [latestOperation] = await executor
    .select({
      deploymentVersionId: workflowDeploymentOperation.deploymentVersionId,
      protocolVersion: workflowDeploymentOperation.protocolVersion,
      status: workflowDeploymentOperation.status,
    })
    .from(workflowDeploymentOperation)
    .where(eq(workflowDeploymentOperation.workflowId, workflowId))
    .orderBy(desc(workflowDeploymentOperation.generation))
    .limit(1)

  if (
    !latestOperation ||
    latestOperation.protocolVersion !== DEPLOYMENT_OPERATION_PROTOCOL_VERSION ||
    !isDeploymentOperationStatus(latestOperation.status) ||
    !IN_FLIGHT_STATUSES.includes(latestOperation.status)
  ) {
    return null
  }
  return latestOperation.deploymentVersionId
}

/**
 * True when the given deployment version is the workflow's active one.
 * Cleanup re-checks this immediately before any provider teardown because a
 * version can be re-activated between a batch being selected and its rows
 * being processed, and the fenced row delete that follows cannot undo a
 * provider call.
 */
export async function isDeploymentVersionActive(
  workflowId: string,
  deploymentVersionId: string,
  executor: Pick<DbOrTx, 'select'> = db
): Promise<boolean> {
  const [versionRow] = await executor
    .select({ id: workflowDeploymentVersion.id })
    .from(workflowDeploymentVersion)
    .where(
      and(
        eq(workflowDeploymentVersion.workflowId, workflowId),
        eq(workflowDeploymentVersion.id, deploymentVersionId),
        eq(workflowDeploymentVersion.isActive, true)
      )
    )
    .limit(1)

  return Boolean(versionRow)
}

/**
 * Moves the current preparing generation into its activation phase.
 */
export async function beginDeploymentOperationActivation(
  params: DeploymentOperationGeneration
): Promise<DeploymentOperationMutationResult> {
  return db.transaction(async (tx) => {
    await setDeploymentTxTimeouts(tx)
    const operation = await lockCurrentOperation(tx, params)
    if (!operation.success) return operation

    if (
      !isDeploymentOperationStatus(operation.operation.status) ||
      !canTransitionDeploymentOperation(operation.operation.status, 'activating')
    ) {
      return {
        success: false,
        reason: 'invalid_transition',
        error: `Cannot transition deployment operation from ${operation.operation.status} to activating`,
      }
    }

    const now = new Date()
    await tx
      .update(workflowDeploymentOperation)
      .set({
        status: 'activating',
        errorCode: null,
        errorMessage: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(workflowDeploymentOperation.id, params.operationId),
          eq(workflowDeploymentOperation.workflowId, params.workflowId),
          eq(workflowDeploymentOperation.generation, params.generation),
          eq(workflowDeploymentOperation.status, 'preparing')
        )
      )

    return {
      success: true,
      operation: {
        ...operation.operation,
        status: 'activating',
        errorCode: null,
        errorMessage: null,
        updatedAt: now,
      },
    }
  })
}

/**
 * Atomically updates one declared component using operation, generation, and
 * component-state compare-and-swap predicates.
 */
export async function markDeploymentComponentReadiness(
  params: MarkDeploymentComponentReadinessParams
): Promise<DeploymentOperationMutationResult> {
  const component = params.component.trim()
  if (!component) {
    return {
      success: false,
      reason: 'invalid_readiness',
      error: 'Deployment readiness component name cannot be empty',
    }
  }

  const now = new Date()
  const expectedStatus = params.expectedStatus ?? 'pending'
  const nextState = {
    status: params.status,
    updatedAt: now.toISOString(),
  }

  const [updated] = await db
    .update(workflowDeploymentOperation)
    .set({
      componentReadiness: sql`jsonb_set(
        ${workflowDeploymentOperation.componentReadiness},
        ARRAY[${component}]::text[],
        ${JSON.stringify(nextState)}::jsonb,
        false
      )`,
      errorCode: null,
      errorMessage: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(workflowDeploymentOperation.id, params.operationId),
        eq(workflowDeploymentOperation.workflowId, params.workflowId),
        eq(workflowDeploymentOperation.generation, params.generation),
        inArray(workflowDeploymentOperation.status, IN_FLIGHT_STATUSES),
        sql`${workflowDeploymentOperation.componentReadiness} ? ${component}`,
        sql`${workflowDeploymentOperation.componentReadiness} -> ${component} ->> 'status' = ${expectedStatus}`
      )
    )
    .returning()

  if (!updated) {
    return {
      success: false,
      reason: 'stale_generation',
      error: 'Deployment operation generation or component state is stale',
    }
  }

  return { success: true, operation: updated }
}

/**
 * Atomically activates an all-ready current operation and projects it onto the
 * legacy workflow/version fields.
 */
export async function activateDeploymentOperation(
  params: ActivateDeploymentOperationParams
): Promise<DeploymentOperationMutationResult> {
  return db.transaction(async (tx) => {
    await setDeploymentTxTimeouts(tx)
    const operationResult = await lockCurrentOperation(tx, params)
    if (!operationResult.success) return operationResult

    const operation = operationResult.operation
    if (
      !isDeploymentOperationStatus(operation.status) ||
      !canTransitionDeploymentOperation(operation.status, 'active')
    ) {
      return {
        success: false,
        reason: 'invalid_transition',
        error: `Cannot transition deployment operation from ${operation.status} to active`,
      }
    }

    const readiness = parseDeploymentReadiness(operation.componentReadiness)
    if (!readiness) {
      return {
        success: false,
        reason: 'invalid_readiness',
        error: 'Deployment operation readiness is invalid',
      }
    }
    if (!isDeploymentReadinessComplete(readiness)) {
      return {
        success: false,
        reason: 'not_ready',
        error: 'Deployment operation components are not all ready',
      }
    }

    const [currentActiveVersion] = await tx
      .select({ id: workflowDeploymentVersion.id })
      .from(workflowDeploymentVersion)
      .where(
        and(
          eq(workflowDeploymentVersion.workflowId, operation.workflowId),
          eq(workflowDeploymentVersion.isActive, true)
        )
      )
      .orderBy(desc(workflowDeploymentVersion.version))
      .limit(1)
    if ((currentActiveVersion?.id ?? null) !== operation.previousActiveVersionId) {
      const supersededAt = new Date()
      await tx
        .update(workflowDeploymentOperation)
        .set({
          status: 'superseded',
          completedAt: supersededAt,
          updatedAt: supersededAt,
        })
        .where(
          and(
            eq(workflowDeploymentOperation.id, operation.id),
            eq(workflowDeploymentOperation.workflowId, operation.workflowId),
            eq(workflowDeploymentOperation.generation, operation.generation),
            eq(workflowDeploymentOperation.status, 'activating')
          )
        )
      return {
        success: false,
        reason: 'stale_generation',
        error: 'Active deployment changed while this operation was preparing',
      }
    }

    if (!operation.deploymentVersionId) {
      return {
        success: false,
        reason: 'deployment_version_not_found',
        error: 'Deployment operation has no target version',
      }
    }

    const [targetVersion] = await tx
      .select({
        id: workflowDeploymentVersion.id,
        preparationKind: workflowDeploymentVersion.preparationKind,
      })
      .from(workflowDeploymentVersion)
      .where(
        and(
          eq(workflowDeploymentVersion.workflowId, operation.workflowId),
          eq(workflowDeploymentVersion.id, operation.deploymentVersionId)
        )
      )
      .limit(1)
    if (!targetVersion) {
      return {
        success: false,
        reason: 'deployment_version_not_found',
        error: 'Deployment version not found',
      }
    }
    if (targetVersion.preparationKind !== null) {
      return {
        success: false,
        reason: 'invalid_transition',
        error: 'Excel test snapshot cannot be activated',
      }
    }

    const now = new Date()
    if (!isDeploymentOperationAction(operation.action)) {
      return {
        success: false,
        reason: 'invalid_transition',
        error: `Deployment operation action is invalid: ${operation.action}`,
      }
    }

    /**
     * Single-statement cutover: only rows whose isActive value actually
     * changes are touched (the previously active row and the target), instead
     * of rewriting every version row of the workflow on each deploy. There is
     * no unique index on (workflowId, isActive), so the one-statement flip has
     * no constraint-ordering hazard.
     */
    await tx
      .update(workflowDeploymentVersion)
      .set({
        isActive: sql<boolean>`${workflowDeploymentVersion.id} = ${operation.deploymentVersionId}`,
      })
      .where(
        and(
          eq(workflowDeploymentVersion.workflowId, operation.workflowId),
          or(
            eq(workflowDeploymentVersion.isActive, true),
            eq(workflowDeploymentVersion.id, operation.deploymentVersionId)
          )
        )
      )

    await tx
      .update(workflow)
      .set({
        isDeployed: true,
        deployedAt: now,
      })
      .where(eq(workflow.id, operation.workflowId))

    await tx
      .update(workflowDeploymentOperation)
      .set({
        status: 'active',
        errorCode: null,
        errorMessage: null,
        completedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(workflowDeploymentOperation.id, operation.id),
          eq(workflowDeploymentOperation.generation, operation.generation),
          eq(workflowDeploymentOperation.status, 'activating')
        )
      )

    const activatedOperation: WorkflowDeploymentOperation = {
      ...operation,
      status: 'active',
      errorCode: null,
      errorMessage: null,
      completedAt: now,
      updatedAt: now,
    }
    await params.onActivateTransaction?.(tx, activatedOperation)

    return { success: true, operation: activatedOperation }
  })
}

/**
 * Marks an in-flight operation failed without changing the live deployment.
 */
export async function markDeploymentOperationFailed(
  params: DeploymentOperationGeneration & { error: unknown; errorCode?: string }
): Promise<DeploymentOperationMutationResult> {
  const safeError = toSafeDeploymentError(params.error, params.errorCode)
  return markDeploymentOperationTerminal(params, 'failed', safeError)
}

/**
 * Records a transient attempt failure on an in-flight operation without
 * changing its lifecycle status, so status surfaces can show "retrying" with
 * the live error instead of a blank pending state. Cleared again the moment a
 * later attempt makes progress (component readiness or activation).
 */
export async function recordDeploymentOperationRetry(
  params: DeploymentOperationGeneration & { error: unknown }
): Promise<void> {
  const safeError = toSafeDeploymentError(params.error, 'preparation_retrying')
  const now = new Date()
  await db
    .update(workflowDeploymentOperation)
    .set({
      errorCode: safeError.code,
      errorMessage: safeError.message,
      updatedAt: now,
    })
    .where(
      and(
        eq(workflowDeploymentOperation.id, params.operationId),
        eq(workflowDeploymentOperation.workflowId, params.workflowId),
        eq(workflowDeploymentOperation.generation, params.generation),
        inArray(workflowDeploymentOperation.status, IN_FLIGHT_STATUSES)
      )
    )
}

/**
 * Supersedes every in-flight operation for `workflowIds`. Must run inside the
 * undeploy/archive transaction so a queued preparation cannot activate a
 * version after the user explicitly took the workflow offline.
 */
export async function supersedeInFlightDeploymentOperations(
  executor: DbOrTx,
  workflowIds: readonly string[]
): Promise<void> {
  if (workflowIds.length === 0) return
  const now = new Date()
  await executor
    .update(workflowDeploymentOperation)
    .set({
      status: 'superseded',
      completedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        inArray(workflowDeploymentOperation.workflowId, workflowIds),
        inArray(workflowDeploymentOperation.status, IN_FLIGHT_STATUSES)
      )
    )
}

async function prepareOperation(
  params: PrepareOperationBase,
  action: DeploymentOperationAction,
  resolveTarget: ResolveOperationTarget,
  excelSnapshot?: LockedExcelSnapshot
): Promise<PrepareDeploymentOperationResult> {
  const actorId = params.actorId.trim()
  const requestHash = params.requestHash.trim()
  const idempotencyKey = params.idempotencyKey?.trim() || null
  if (!actorId || !requestHash) {
    return {
      success: false,
      reason: 'invalid_request',
      error: 'Deployment operation actor and request hash are required',
    }
  }

  let readiness: DeploymentReadiness
  try {
    readiness = createDeploymentReadiness(params.readinessComponents ?? [])
  } catch (error) {
    return {
      success: false,
      reason: 'invalid_request',
      error: toSafeDeploymentError(error, 'invalid_readiness').message,
    }
  }

  const executePrepare = async (tx: DbOrTx): Promise<PrepareDeploymentOperationResult> => {
    const now = new Date()
    const [workflowRow] = await tx
      .select({
        id: workflow.id,
        archivedAt: workflow.archivedAt,
      })
      .from(workflow)
      .where(eq(workflow.id, params.workflowId))
      .for('update')
    if (!workflowRow) {
      return {
        success: false,
        reason: 'workflow_not_found',
        error: 'Workflow not found',
      }
    }
    if (workflowRow.archivedAt) {
      return {
        success: false,
        reason: 'workflow_archived',
        error: 'Cannot change deployment state for an archived workflow',
      }
    }

    if (idempotencyKey) {
      const [existing] = await tx
        .select()
        .from(workflowDeploymentOperation)
        .where(
          and(
            eq(workflowDeploymentOperation.workflowId, params.workflowId),
            eq(workflowDeploymentOperation.idempotencyKey, idempotencyKey)
          )
        )
        .limit(1)
      if (existing) {
        if (existing.requestHash !== requestHash) {
          return {
            success: false,
            reason: 'idempotency_conflict',
            error: 'Idempotency key was already used for a different deployment request',
          }
        }
        if (action === 'activate') {
          const [target] = await tx
            .select({ preparationKind: workflowDeploymentVersion.preparationKind })
            .from(workflowDeploymentVersion)
            .where(
              and(
                eq(workflowDeploymentVersion.id, existing.deploymentVersionId),
                eq(workflowDeploymentVersion.workflowId, params.workflowId)
              )
            )
            .limit(1)
            .for('share')
          if (!target || target.preparationKind !== null) {
            return {
              success: false,
              reason: 'invalid_request',
              error: 'Excel test snapshot cannot be activated',
            }
          }
        }
        if (existing.status !== 'failed' && existing.status !== 'superseded') {
          if (excelSnapshot) {
            const [stored] = await tx
              .select()
              .from(workflowDeploymentVersion)
              .where(
                and(
                  eq(workflowDeploymentVersion.id, existing.deploymentVersionId),
                  eq(workflowDeploymentVersion.workflowId, params.workflowId)
                )
              )
              .limit(1)
            if (
              !stored ||
              stored.id !== existing.deploymentVersionId ||
              stored.version !== existing.version
            )
              return excelSnapshotRefused(
                { requestId: excelSnapshot.requestId, workflowId: params.workflowId },
                'reused_version_row'
              )
            const expected = materializeExcelProcedureSnapshot(
              excelSnapshot.capture,
              excelSnapshot.current,
              { id: stored.id, version: stored.version }
            )
            if (
              stored.snapshotDigest !== expected.snapshotDigest ||
              normalizedStringify(stored.state) !== normalizedStringify(expected.workflowState)
            )
              return excelSnapshotRefused(
                { requestId: excelSnapshot.requestId, workflowId: params.workflowId },
                'reused_version_mismatch'
              )
          }
          return { success: true, operation: existing, reused: true }
        }
        /**
         * A terminally failed or superseded attempt releases its idempotency
         * key: duplicate-submission protection must never pin a retry to a
         * spent attempt — the caller would get success with no live work
         * behind it. The key moves to the fresh operation created below so
         * later duplicates of the same request reuse that one instead.
         */
        await tx
          .update(workflowDeploymentOperation)
          .set({ idempotencyKey: null, updatedAt: now })
          .where(eq(workflowDeploymentOperation.id, existing.id))
      }
    }

    const [currentActiveVersion] = await tx
      .select({ id: workflowDeploymentVersion.id })
      .from(workflowDeploymentVersion)
      .where(
        and(
          eq(workflowDeploymentVersion.workflowId, params.workflowId),
          eq(workflowDeploymentVersion.isActive, true)
        )
      )
      .orderBy(desc(workflowDeploymentVersion.version))
      .limit(1)

    const targetResult = await resolveTarget({
      tx,
      now,
      actorId,
      workflowId: params.workflowId,
    })
    if (!targetResult.success) return targetResult

    const [{ maxGeneration }] = await tx
      .select({
        maxGeneration: sql<number>`COALESCE(MAX(${workflowDeploymentOperation.generation}), 0)`,
      })
      .from(workflowDeploymentOperation)
      .where(eq(workflowDeploymentOperation.workflowId, params.workflowId))
      .limit(1)
    const generation = Number(maxGeneration) + 1

    await tx
      .update(workflowDeploymentOperation)
      .set({
        status: 'superseded',
        completedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(workflowDeploymentOperation.workflowId, params.workflowId),
          inArray(workflowDeploymentOperation.status, IN_FLIGHT_STATUSES)
        )
      )

    const [operation] = await tx
      .insert(workflowDeploymentOperation)
      .values({
        id: generateId(),
        workflowId: params.workflowId,
        deploymentVersionId: targetResult.target.deploymentVersionId,
        version: targetResult.target.version,
        previousActiveVersionId: currentActiveVersion?.id ?? null,
        action,
        protocolVersion: DEPLOYMENT_OPERATION_PROTOCOL_VERSION,
        generation,
        status: 'preparing',
        componentReadiness: readiness,
        errorCode: null,
        errorMessage: null,
        idempotencyKey,
        requestHash,
        actorId,
        completedAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning()

    if (!operation) {
      throw new Error('Failed to create deployment operation')
    }
    await params.onPrepareTransaction?.(tx, operation)
    return { success: true, operation, reused: false }
  }

  if (params.tx) return executePrepare(params.tx)
  return db.transaction(async (tx) => {
    await setDeploymentTxTimeouts(tx)
    return executePrepare(tx)
  })
}

async function lockCurrentOperation(
  tx: DbOrTx,
  params: DeploymentOperationGeneration
): Promise<DeploymentOperationMutationResult> {
  const [workflowRow] = await tx
    .select({ id: workflow.id })
    .from(workflow)
    .where(eq(workflow.id, params.workflowId))
    .for('update')
  if (!workflowRow) {
    return {
      success: false,
      reason: 'operation_not_found',
      error: 'Deployment operation workflow not found',
    }
  }

  const [operation] = await tx
    .select()
    .from(workflowDeploymentOperation)
    .where(
      and(
        eq(workflowDeploymentOperation.id, params.operationId),
        eq(workflowDeploymentOperation.workflowId, params.workflowId),
        eq(workflowDeploymentOperation.generation, params.generation)
      )
    )
    .for('update')
  if (!operation) {
    return {
      success: false,
      reason: 'operation_not_found',
      error: 'Deployment operation not found',
    }
  }

  const [{ maxGeneration }] = await tx
    .select({
      maxGeneration: sql<number>`COALESCE(MAX(${workflowDeploymentOperation.generation}), 0)`,
    })
    .from(workflowDeploymentOperation)
    .where(eq(workflowDeploymentOperation.workflowId, operation.workflowId))
    .limit(1)
  if (Number(maxGeneration) !== params.generation) {
    return {
      success: false,
      reason: 'stale_generation',
      error: 'Deployment operation generation is stale',
    }
  }

  return { success: true, operation }
}

async function markDeploymentOperationTerminal(
  params: DeploymentOperationGeneration,
  status: Extract<DeploymentOperationStatus, 'failed' | 'superseded'>,
  error?: { code: string; message: string }
): Promise<DeploymentOperationMutationResult> {
  const now = new Date()
  const [updated] = await db
    .update(workflowDeploymentOperation)
    .set({
      status,
      errorCode: error?.code ?? null,
      errorMessage: error?.message ?? null,
      completedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(workflowDeploymentOperation.id, params.operationId),
        eq(workflowDeploymentOperation.workflowId, params.workflowId),
        eq(workflowDeploymentOperation.generation, params.generation),
        inArray(workflowDeploymentOperation.status, IN_FLIGHT_STATUSES)
      )
    )
    .returning()

  if (!updated) {
    return {
      success: false,
      reason: 'invalid_transition',
      error: `Deployment operation cannot transition to ${status}`,
    }
  }

  return { success: true, operation: updated }
}
