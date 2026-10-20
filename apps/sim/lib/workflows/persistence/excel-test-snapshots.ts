// Copyright (c) 2026 Memlia. All rights reserved.
import { ExcelProcedureSchema } from '@memlia/contracts'
import { db, workflow, workflowDeploymentVersion, workspace } from '@sim/db'
import { sha256Hex } from '@sim/security/hash'
import { generateId } from '@sim/utils/id'
import { loadWorkflowFromNormalizedTablesRaw } from '@sim/workflow-persistence/load'
import { lockWorkflowDraft } from '@sim/workflow-persistence/revision'
import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { workflowStateSchema } from '@/lib/api/contracts/workflows'
import { executeTransactionallyIdempotent } from '@/lib/core/idempotency/transaction'
import { stringifyBoundedJson } from '@/lib/core/utils/bounded-json'
import {
  captureExcelProcedureSnapshot,
  materializeExcelProcedureSnapshot,
} from '@/lib/memlia/excel/materialize-procedure-snapshot'
import { normalizedStringify } from '@/lib/workflows/comparison/normalize'
import { setDeploymentTxTimeouts } from './deployment-operations'

const POLICY = 'memlia_excel_test_admission_v1'
const KIND = 'excel_test_v1'
const shape = ExcelProcedureSchema.shape
const inputSchema = z.strictObject({
  scope: z.strictObject({
    organizationId: shape.organizationId,
    workspaceId: shape.workspaceId,
    workflowId: shape.workflowId,
  }),
  actorId: shape.ownerUserId,
  expectedRevision: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
  expectedStateDigest: shape.digest,
  operationId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/),
  previousTestVersionId: shape.deployedVersionId.optional(),
})
type Input = z.output<typeof inputSchema>
type Snapshot = typeof workflowDeploymentVersion.$inferSelect
type Graph = z.input<typeof workflowStateSchema>
type Result = {
  status: 'prepared_for_test'
  workflowId: string
  deploymentVersionId: string
  version: number
  snapshotDigest: string
  executionAvailable: false
  activationAvailable: false
}
function refuse(): never {
  throw new Error('excel_test_preparation_refused')
}
function copy(value: unknown, maxBytes = 2 * 1024 * 1024): unknown {
  const json = stringifyBoundedJson(value, maxBytes, { strict: true })
  if (json === undefined) refuse()
  return JSON.parse(json)
}
function digest(value: unknown): string {
  return `sha256:${sha256Hex(normalizedStringify(value))}`
}
function graph(value: unknown): Graph {
  const owned = copy(value)
  if (!workflowStateSchema.safeParse(owned).success) refuse()
  // Validate without schema projection, retaining the entire stored graph.
  return owned as Graph
}
function rawGraph(
  raw: NonNullable<Awaited<ReturnType<typeof loadWorkflowFromNormalizedTablesRaw>>>,
  variables: unknown
): Graph {
  return graph(
    JSON.parse(
      normalizedStringify({
        blocks: raw.blocks,
        edges: raw.edges,
        loops: raw.loops,
        parallels: raw.parallels,
        variables: variables ?? {},
      })
    )
  )
}
function requests(state: Graph) {
  const found = Object.entries(state.blocks).filter(([, block]) => block.type === 'memlia_excel')
  if (found.length < 1 || found.length > 32) refuse()
  return found.map(([blockId, block]) => {
    const field = block.subBlocks.request
    if (
      block.id !== blockId ||
      field?.id !== 'request' ||
      field.type !== 'code' ||
      typeof field.value !== 'string' ||
      Buffer.byteLength(field.value, 'utf8') > 512 * 1024
    )
      refuse()
    return { blockId, request: copy(JSON.parse(field.value), 512 * 1024) }
  })
}
function storedProcedures(row: Snapshot | undefined, input: Input) {
  if (
    !row ||
    row.workflowId !== input.scope.workflowId ||
    row.preparationKind !== KIND ||
    row.isActive !== false ||
    !Number.isSafeInteger(row.version) ||
    row.version < 1 ||
    !shape.deployedVersionId.safeParse(row.id).success
  )
    refuse()
  const state = graph(row.state)
  if (row.snapshotDigest !== digest(state)) refuse()
  const procedures = requests(state).map(({ blockId, request }) => {
    const envelope = z
      .strictObject({
        procedure: ExcelProcedureSchema,
        sources: z.unknown(),
        output: z.unknown(),
      })
      .parse(request)
    if (!Object.hasOwn(envelope, 'sources') || !Object.hasOwn(envelope, 'output')) refuse()
    const p = envelope.procedure
    const { digest: observed, ...unsigned } = p
    if (
      p.organizationId !== input.scope.organizationId ||
      p.workspaceId !== input.scope.workspaceId ||
      p.workflowId !== input.scope.workflowId ||
      p.deployedVersionId !== row.id ||
      p.policyVersion !== POLICY ||
      observed !== digest(unsigned) ||
      (p.version === 1) !== (p.parentVersion === null) ||
      (p.parentVersion !== null && p.parentVersion !== p.version - 1)
    )
      refuse()
    return { blockId, procedure: p }
  })
  if (new Set(procedures.map(({ procedure }) => procedure.procedureId)).size !== procedures.length)
    refuse()
  return procedures
}
function receipt(
  row: Pick<Snapshot, 'id' | 'version' | 'snapshotDigest'>,
  workflowId: string
): Result {
  if (!row.snapshotDigest) refuse()
  return {
    status: 'prepared_for_test',
    workflowId,
    deploymentVersionId: row.id,
    version: row.version,
    snapshotDigest: row.snapshotDigest,
    executionAvailable: false,
    activationAvailable: false,
  }
}

/**
 * Trusted persistence port, not an authorization boundary. The session/write use case
 * supplies the verified subject and scope; HTTP observations grant no authority to this port.
 * Owns its TX: a positive result is returned only after COMMIT, never permission to execute.
 */
export async function prepareExcelTestSnapshot(value: unknown): Promise<Result> {
  let input: Input
  try {
    input = inputSchema.parse(copy(value, 8192))
  } catch {
    return refuse()
  }
  try {
    return await db.transaction(async (tx) => {
      await setDeploymentTxTimeouts(tx)
      const revision = await lockWorkflowDraft(tx, input.scope.workflowId, input.expectedRevision)
      const [row] = await tx
        .select({
          workspaceId: workflow.workspaceId,
          variables: workflow.variables,
          archivedAt: workflow.archivedAt,
        })
        .from(workflow)
        .where(eq(workflow.id, input.scope.workflowId))
        .limit(1)
      if (!row || row.archivedAt || row.workspaceId !== input.scope.workspaceId) refuse()
      const [space] = await tx
        .select({
          organizationId: workspace.organizationId,
          archivedAt: workspace.archivedAt,
        })
        .from(workspace)
        .where(eq(workspace.id, row.workspaceId))
        .limit(1)
        .for('share')
      if (!space || space.archivedAt || space.organizationId !== input.scope.organizationId)
        refuse()
      const raw = await loadWorkflowFromNormalizedTablesRaw(input.scope.workflowId, tx)
      if (!raw || raw.workspaceId !== row.workspaceId || raw.draftRevision !== revision) refuse()
      const state = rawGraph(raw, row.variables)
      if (digest(state) !== input.expectedStateDigest) refuse()
      const draftRequests = requests(state)
      const readVersion = async (id: string) => {
        const [version] = await tx
          .select()
          .from(workflowDeploymentVersion)
          .where(
            and(
              eq(workflowDeploymentVersion.workflowId, input.scope.workflowId),
              eq(workflowDeploymentVersion.id, id)
            )
          )
          .limit(1)
          .for('share')
        return version
      }
      const previous = input.previousTestVersionId
        ? storedProcedures(await readVersion(input.previousTestVersionId), input)
        : undefined
      if (
        previous &&
        (previous.length !== draftRequests.length ||
          previous.some((p) => !draftRequests.some((d) => d.blockId === p.blockId)))
      )
        refuse()
      const plan = (
        identities: {
          blockId: string
          procedureId: string
          ownerUserId: string
          version: number
          parentVersion: number | null
        }[]
      ) =>
        captureExcelProcedureSnapshot({
          workflowState: state,
          expectedRevision: revision,
          expectedStateDigest: input.expectedStateDigest,
          scope: input.scope,
          procedures: draftRequests.map(({ blockId, request }) => {
            const identity = identities.find((p) => p.blockId === blockId)
            if (!identity) refuse()
            return { ...identity, policyVersion: POLICY, expectedRequestDigest: digest(request) }
          }),
        })
      const capturedInputDigest = digest({ ...input, policyVersion: POLICY })
      const { result, isFirstTime } = await executeTransactionallyIdempotent(tx, {
        namespace: `excel-test-preparation:${digest({ scope: input.scope, actorId: input.actorId })}`,
        operationId: input.operationId,
        requestFingerprint: capturedInputDigest,
        operation: async () => {
          const identities = draftRequests.map(({ blockId }) => {
            const prior = previous?.find((p) => p.blockId === blockId)?.procedure
            return {
              blockId,
              procedureId: prior?.procedureId ?? generateId(),
              ownerUserId: prior?.ownerUserId ?? input.actorId,
              version: prior ? prior.version + 1 : 1,
              parentVersion: prior?.version ?? null,
            }
          })
          const capture = plan(identities)
          const [{ maxVersion }] = await tx
            .select({
              maxVersion: sql<number>`COALESCE(MAX(${workflowDeploymentVersion.version}), 0)`,
            })
            .from(workflowDeploymentVersion)
            .where(eq(workflowDeploymentVersion.workflowId, input.scope.workflowId))
            .limit(1)
          const version = Number(maxVersion) + 1
          if (!Number.isSafeInteger(version) || version < 1 || version > 2147483647) refuse()
          const id = generateId()
          const materialized = materializeExcelProcedureSnapshot(
            capture,
            { workflowState: state, revision, scope: input.scope },
            { id, version }
          )
          await tx.insert(workflowDeploymentVersion).values({
            id,
            workflowId: input.scope.workflowId,
            version,
            state: materialized.workflowState,
            snapshotDigest: materialized.snapshotDigest,
            preparationKind: KIND,
            isActive: false,
            createdBy: input.actorId,
            createdAt: new Date(),
          })
          return receipt(
            { id, version, snapshotDigest: materialized.snapshotDigest },
            input.scope.workflowId
          )
        },
      })
      if (isFirstTime) return result
      // The idempotency table holds JSON, never a trustworthy version or authority by itself.
      const cached = z
        .strictObject({
          status: z.literal('prepared_for_test'),
          workflowId: shape.workflowId,
          deploymentVersionId: shape.deployedVersionId,
          version: z.int().positive(),
          snapshotDigest: shape.digest,
          executionAvailable: z.literal(false),
          activationAvailable: z.literal(false),
        })
        .parse(copy(result, 8192))
      if (cached.workflowId !== input.scope.workflowId) refuse()
      const stored = await readVersion(cached.deploymentVersionId)
      const canonical = storedProcedures(stored, input)
      if (
        !stored ||
        stored.version !== cached.version ||
        stored.snapshotDigest !== cached.snapshotDigest ||
        stored.createdBy !== input.actorId ||
        canonical.length !== draftRequests.length
      )
        refuse()
      const expectedIdentities = canonical.map(({ blockId, procedure: p }) => {
        const prior = previous?.find((entry) => entry.blockId === blockId)?.procedure
        if (
          prior
            ? p.procedureId !== prior.procedureId ||
              p.ownerUserId !== prior.ownerUserId ||
              p.version !== prior.version + 1 ||
              p.parentVersion !== prior.version
            : p.version !== 1 || p.parentVersion !== null || p.ownerUserId !== input.actorId
        )
          refuse()
        return {
          blockId,
          procedureId: p.procedureId,
          ownerUserId: p.ownerUserId,
          version: p.version,
          parentVersion: p.parentVersion,
        }
      })
      const expected = materializeExcelProcedureSnapshot(
        plan(expectedIdentities),
        { workflowState: state, revision, scope: input.scope },
        { id: stored.id, version: stored.version }
      )
      if (
        expected.snapshotDigest !== stored.snapshotDigest ||
        normalizedStringify(expected.workflowState) !== normalizedStringify(stored.state)
      )
        refuse()
      return receipt(stored, input.scope.workflowId)
    })
  } catch {
    // Rollback/COMMIT uncertainty is not a prepared result. Never retry a transaction here.
    return refuse()
  }
}

/**
 * Trusted read port, not authorization. A single read-only snapshot must agree with the
 * authorized scope. Its internal block types are for persistence governance, never HTTP.
 */
export async function readExcelTestPreparationObservation(value: unknown): Promise<{
  expectedRevision: number
  expectedStateDigest: string
  blockTypes: string[]
}> {
  let scope: Input['scope']
  try {
    scope = inputSchema.shape.scope.parse(copy(value, 8192))
  } catch {
    return refuse()
  }
  try {
    return await db.transaction(
      async (tx) => {
        await setDeploymentTxTimeouts(tx)
        const [row] = await tx
          .select({
            workspaceId: workflow.workspaceId,
            draftRevision: workflow.draftRevision,
            variables: workflow.variables,
            archivedAt: workflow.archivedAt,
          })
          .from(workflow)
          .where(eq(workflow.id, scope.workflowId))
          .limit(1)
        if (
          !row ||
          row.archivedAt ||
          row.workspaceId !== scope.workspaceId ||
          !inputSchema.shape.expectedRevision.safeParse(row.draftRevision).success
        )
          refuse()
        const [space] = await tx
          .select({
            organizationId: workspace.organizationId,
            archivedAt: workspace.archivedAt,
          })
          .from(workspace)
          .where(eq(workspace.id, scope.workspaceId))
          .limit(1)
        if (!space || space.archivedAt || space.organizationId !== scope.organizationId) refuse()
        const raw = await loadWorkflowFromNormalizedTablesRaw(scope.workflowId, tx)
        if (!raw || raw.workspaceId !== row.workspaceId || raw.draftRevision !== row.draftRevision)
          refuse()
        const state = rawGraph(raw, row.variables)
        // Refuse a non-Excel/malformed draft before presenting an actionable observation.
        requests(state)
        return {
          expectedRevision: row.draftRevision,
          expectedStateDigest: digest(state),
          blockTypes: Object.values(state.blocks).map((block) => block.type),
        }
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' }
    )
  } catch {
    return refuse()
  }
}
