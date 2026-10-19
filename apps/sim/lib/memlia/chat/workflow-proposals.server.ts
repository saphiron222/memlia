// Copyright (c) 2026 Memlia. All rights reserved.
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { type WorkflowProposal, WorkflowProposalSchema } from '@memlia/contracts'
import { parsePrincipal, type SessionPrincipal } from '@sim/auth/principal'
import { db } from '@sim/db'
import { session, user } from '@sim/db/schema'
import { sortObjectKeysDeep } from '@sim/utils/object'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  WORKFLOW_PROPOSAL_TOOL_NAME,
  workflowProposalReviewSchema,
} from '@/lib/api/contracts/copilot'
import { v2ApplyWorkflowOperationsBodySchema } from '@/lib/api/contracts/v2/workflows'
import { getActivelyBannedUserIds } from '@/lib/auth/ban'
import { authorizeWorkspaceOperation } from '@/lib/core/application/workspace-authorization'
import { OrchestrationError } from '@/lib/core/orchestration/types'
import { stringifyBoundedJson } from '@/lib/core/utils/bounded-json'
import {
  getAsyncToolCall,
  getRunSegment,
  recordToolPermissionDecision,
  upsertAsyncToolCall,
} from '@/lib/mothership/async-runs/repository'
import { withToolExecutionLifetime } from '@/lib/mothership/request/tools/execution-lifetime'
import { withPermissionGroupScope } from '@/lib/permission-groups/request-scope.server'
import { applyWorkflowOperations } from '@/lib/workflows/application/apply-workflow-operations'
import { resolveActiveWorkflowApplicationContext } from '@/lib/workflows/application/context'
import { workflowOperations } from '@/lib/workflows/application/operations'
import { readWorkflowGraph } from '@/lib/workflows/application/read-workflow-graph'
import { MAX_IMPORT_BODY_BYTES } from '@/lib/workflows/operations/import-workflow'

export const WORKFLOW_PROPOSAL_TOOL = WORKFLOW_PROPOSAL_TOOL_NAME
export const WORKFLOW_PROPOSAL_TTL_MS = 600_000
const POLICY = 'memlia-workflow-edit-v1'
const Id = WorkflowProposalSchema.shape.proposalId
// A planned revision is mandatory but grants no authority: compare it with the server snapshot.
export const workflowProposalInputSchema = v2ApplyWorkflowOperationsBodySchema.omit({
  atomic: true,
})
const envelopeSchema = z.strictObject({
  version: z.literal('memlia.private-workflow-proposal/v1'),
  proposal: WorkflowProposalSchema,
  body: z.string().max(MAX_IMPORT_BODY_BYTES),
  sessionId: Id,
})
type Envelope = z.infer<typeof envelopeSchema>
type Body = z.output<typeof v2ApplyWorkflowOperationsBodySchema>
function refused() {
  return new Error('proposal_unavailable')
}
function capture(value: unknown) {
  const text = stringifyBoundedJson(value, MAX_IMPORT_BODY_BYTES, { strict: true })
  if (text === undefined) throw refused()
  return JSON.parse(text)
}
function encoded(value: unknown): string {
  const sorted = sortObjectKeysDeep(value)
  if (!isDeepStrictEqual(value, sorted)) throw refused()
  const text = stringifyBoundedJson(sorted, MAX_IMPORT_BODY_BYTES, { strict: true })
  if (text === undefined) throw refused()
  return text
}
function hash(text: string) {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`
}
function human(value: unknown): SessionPrincipal {
  const parsed = parsePrincipal({ version: 1, principal: capture(value) })
  if (parsed.kind !== 'session') throw refused()
  return parsed
}
function checkTime(proposal: WorkflowProposal, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const issued = Date.parse(proposal.issuedAt)
  const expires = Date.parse(proposal.expiresAt)
  const now = Date.now()
  if (expires - issued !== WORKFLOW_PROPOSAL_TTL_MS || now < issued || now >= expires)
    throw refused()
}
function validDecisionTime(date: Date | null, proposal: WorkflowProposal) {
  return (
    date !== null &&
    Number.isFinite(date.getTime()) &&
    date.getTime() >= Date.parse(proposal.issuedAt) &&
    date.getTime() < Date.parse(proposal.expiresAt)
  )
}
async function authority(principal: SessionPrincipal, workflowId: string, workspaceId: string) {
  // Same native session/account checks as the server session authority port;
  // never selects a bearer token and authorizes editing, not execution.
  const [live] = await db
    .select({ id: session.id })
    .from(session)
    .innerJoin(user, eq(user.id, session.userId))
    .where(
      and(
        eq(session.id, principal.sessionId),
        eq(session.userId, principal.userId),
        sql`${session.expiresAt} > clock_timestamp()`,
        isNull(session.impersonatedBy)
      )
    )
    .limit(1)
  if (!live || (await getActivelyBannedUserIds([principal.userId])).length) throw refused()
  const context = await resolveActiveWorkflowApplicationContext({
    workflowId,
    assertedWorkspaceId: workspaceId,
  })
  await authorizeWorkspaceOperation(principal, workflowOperations.applyOperations, context, {
    executor: db,
  })
  return context
}
async function runScope(runId: string, userId: string, workspaceId: string, workflowId: string) {
  const run = await getRunSegment(runId)
  if (
    !run ||
    run.userId !== userId ||
    run.workspaceId !== workspaceId ||
    (run.workflowId !== null && run.workflowId !== workflowId) ||
    run.organizationId
  )
    throw refused()
}
function applyInput(
  proposal: WorkflowProposal,
  body: Body,
  checkAborted: () => void,
  dryRun: boolean
) {
  return {
    workflowId: proposal.workflowId,
    assertedWorkspaceId: proposal.workspaceId,
    expectedRevision: body.expectedRevision,
    operations: body.operations,
    atomic: true,
    layout: body.layout,
    blockEnabledChanges: body.setBlockEnabled?.map(({ block_id, enabled }) => ({
      blockId: block_id,
      enabled,
    })),
    dryRun,
    checkAborted,
  }
}
async function load(id: string, runId?: string, userId?: string) {
  const row = await getAsyncToolCall(Id.parse(id))
  if (
    !row ||
    row.toolName !== WORKFLOW_PROPOSAL_TOOL ||
    (runId !== undefined && row.runId !== runId)
  )
    throw refused()
  const envelope = envelopeSchema.parse(capture(row.args))
  const proposal = envelope.proposal
  const body = v2ApplyWorkflowOperationsBodySchema.parse(JSON.parse(envelope.body))
  const { digest, ...unsigned } = proposal
  if (
    proposal.proposalId !== id ||
    proposal.operations.artifactId !== id ||
    (proposal.authorUserId !== userId && userId !== undefined) ||
    proposal.policyVersion !== POLICY ||
    body.atomic !== true ||
    body.expectedRevision !== proposal.expectedRevision ||
    proposal.operations.count !== body.operations.length ||
    proposal.operations.sha256 !== hash(envelope.body) ||
    encoded(body) !== envelope.body ||
    hash(encoded(unsigned)) !== digest ||
    row.executionDeadlineAt?.getTime() !== Date.parse(proposal.expiresAt) ||
    !row.permissionRequestedAt
  )
    throw refused()
  checkTime(proposal)
  await runScope(row.runId, proposal.authorUserId, proposal.workspaceId, proposal.workflowId)
  const principal = human({
    kind: 'session',
    userId: proposal.authorUserId,
    sessionId: envelope.sessionId,
  })
  const context = await authority(principal, proposal.workflowId, proposal.workspaceId)
  if (context.workspaceOrganizationId !== proposal.organizationId) throw refused()
  checkTime(proposal)
  return { row, envelope, body, principal }
}

/** Server-only after authenticated session ingress. No endpoint accepts this context from a model. */
export async function createWorkflowProposal(
  context: { principal: SessionPrincipal; runId: string; workflowId: string; workspaceId: string },
  params: unknown,
  signal?: AbortSignal
): Promise<WorkflowProposal> {
  try {
    const principal = human(context.principal)
    const runId = Id.parse(context.runId)
    const workflowId = Id.parse(context.workflowId)
    const workspaceId = Id.parse(context.workspaceId)
    const captured = capture(params)
    encoded(captured) // Refuse any field the native canonicalizer cannot preserve.
    const intention = workflowProposalInputSchema.parse(captured)
    signal?.throwIfAborted()
    await runScope(runId, principal.userId, workspaceId, workflowId)
    const canonical = await authority(principal, workflowId, workspaceId)
    const snapshot = await readWorkflowGraph.execute({
      principal,
      input: { workflowId, assertedWorkspaceId: workspaceId },
    })
    if (
      snapshot.workflowId !== workflowId ||
      snapshot.workspaceId !== workspaceId ||
      snapshot.draftRevision !== intention.expectedRevision
    )
      throw refused()
    const body = v2ApplyWorkflowOperationsBodySchema.parse({ ...intention, atomic: true })
    const bytes = encoded(body)
    const proposalId = randomUUID()
    const issuedAt = new Date().toISOString()
    const unsigned = {
      schemaVersion: 'memlia.workflow-proposal/v1' as const,
      proposalId,
      workflowId,
      workspaceId,
      organizationId: canonical.workspaceOrganizationId,
      authorUserId: principal.userId,
      expectedRevision: body.expectedRevision,
      operations: {
        artifactId: proposalId,
        sha256: hash(bytes),
        format: 'sim.workflow-operations/v1' as const,
        count: body.operations.length,
      },
      policyVersion: POLICY,
      touchedResourceIds: [workflowId],
      issuedAt,
      expiresAt: new Date(Date.parse(issuedAt) + WORKFLOW_PROPOSAL_TTL_MS).toISOString(),
    }
    const proposal = WorkflowProposalSchema.parse({ ...unsigned, digest: hash(encoded(unsigned)) })
    const check = () => checkTime(proposal, signal)
    const preview = await withPermissionGroupScope(() =>
      applyWorkflowOperations.execute({ principal, input: applyInput(proposal, body, check, true) })
    )
    check()
    if (
      !preview.dryRun ||
      preview.baseRevision !== proposal.expectedRevision ||
      preview.draftRevision !== proposal.expectedRevision ||
      preview.workflowId !== workflowId ||
      preview.workspaceId !== workspaceId ||
      preview.skipped.length ||
      preview.inputValidationErrors.length
    )
      throw refused()
    const envelope: Envelope = {
      version: 'memlia.private-workflow-proposal/v1',
      proposal,
      body: bytes,
      sessionId: principal.sessionId,
    }
    const stored = await upsertAsyncToolCall({
      runId,
      toolCallId: proposalId,
      toolName: WORKFLOW_PROPOSAL_TOOL,
      args: envelope,
      status: 'pending',
      permissionRequested: true,
      executionDeadlineAt: new Date(proposal.expiresAt),
    })
    check()
    if (!stored || encoded(stored.args) !== encoded(envelope)) throw refused()
    const reread = await load(proposalId, runId, principal.userId)
    check()
    if (
      encoded(reread.envelope) !== encoded(envelope) ||
      reread.row.status !== 'pending' ||
      reread.row.permissionDecision !== null ||
      reread.row.executionStartedAt !== null
    )
      throw refused()
    return structuredClone(proposal)
  } catch {
    throw refused()
  }
}

/** Public metadata only; never returns the immutable body or session reference. */
export async function readWorkflowProposal(
  id: string,
  runId: string,
  userId: string
): Promise<WorkflowProposal> {
  try {
    return structuredClone((await load(id, runId, userId)).envelope.proposal)
  } catch {
    throw refused()
  }
}

async function reviewAuthority(
  loaded: Awaited<ReturnType<typeof load>>,
  principal: SessionPrincipal
) {
  const proposal = loaded.envelope.proposal
  if (
    principal.sessionId !== loaded.principal.sessionId ||
    principal.userId !== loaded.principal.userId ||
    loaded.row.status !== 'pending' ||
    loaded.row.executionStartedAt !== null
  )
    throw refused()
  const context = await authority(principal, proposal.workflowId, proposal.workspaceId)
  if (context.workspaceOrganizationId !== proposal.organizationId) throw refused()
  // The authorized native context already contains the active persisted row.
  // Reading the graph here could schedule migrate-on-read writes on a GET.
  if (
    context.workflowId !== proposal.workflowId ||
    context.workspaceId !== proposal.workspaceId ||
    WorkflowProposalSchema.shape.expectedRevision.parse(context.workflow.draftRevision) !==
      proposal.expectedRevision
  )
    throw refused()
  checkTime(proposal)
}

/** Authenticated owner review only. Never sent through the metadata/SSE reader. */
export async function readWorkflowProposalReview(input: {
  toolCallId: string
  principal: SessionPrincipal
}) {
  try {
    const id = Id.parse(input.toolCallId)
    const principal = human(input.principal)
    const loaded = await load(id, undefined, principal.userId)
    await reviewAuthority(loaded, principal)
    if (loaded.row.permissionDecision !== null) throw refused()
    const p = loaded.envelope.proposal
    return workflowProposalReviewSchema.parse({
      toolCallId: id,
      workflowId: p.workflowId,
      workspaceId: p.workspaceId,
      expectedRevision: p.expectedRevision,
      issuedAt: p.issuedAt,
      expiresAt: p.expiresAt,
      digest: p.digest,
      body: loaded.envelope.body,
    })
  } catch {
    throw refused()
  }
}

export async function recordWorkflowProposalDecision(input: {
  toolCallId: string
  principal: SessionPrincipal
  decision: string
  single: boolean
  expectedDigest?: string
}) {
  try {
    const id = Id.parse(input.toolCallId)
    const principal = human(input.principal)
    const decision = input.decision
    const single = input.single
    const expectedDigest = WorkflowProposalSchema.shape.digest.parse(input.expectedDigest)
    if (!single || (decision !== 'allow' && decision !== 'skip')) throw refused()
    const loaded = await load(id, undefined, principal.userId)
    const proposal = loaded.envelope.proposal
    if (expectedDigest !== proposal.digest) throw refused()
    await reviewAuthority(loaded, principal)
    const claimed = await recordToolPermissionDecision(id, decision, {
      expectedArgsJSONB: encoded(loaded.envelope),
      expiresAt: new Date(proposal.expiresAt),
    })
    const current = await load(id, loaded.row.runId, principal.userId)
    if (
      encoded(current.envelope) !== encoded(loaded.envelope) ||
      !['allow', 'skip'].includes(current.row.permissionDecision ?? '') ||
      !validDecisionTime(current.row.permissionDecidedAt, proposal)
    )
      throw refused()
    return {
      toolCallId: id,
      decision: current.row.permissionDecision as 'allow' | 'skip',
      applied: claimed !== null,
    }
  } catch {
    throw refused()
  }
}

export async function executeWorkflowProposal(
  id: string,
  runId: string,
  userId: string,
  signal?: AbortSignal
): Promise<
  | { status: 'applied'; baseRevision: number; draftRevision: number }
  | { status: 'unknown' }
  | { status: 'rejected'; code: 'conflict' }
> {
  try {
    // Primitives are owned across all awaits. A restored/foreign lease is not permission to retry.
    id = Id.parse(id)
    runId = Id.parse(runId)
    userId = Id.parse(userId)
    const initial = await load(id, runId, userId)
    if (
      initial.row.permissionDecision !== 'allow' ||
      initial.row.status !== 'pending' ||
      initial.row.executionStartedAt !== null ||
      initial.row.executionAttempts !== 0 ||
      !validDecisionTime(initial.row.permissionDecidedAt, initial.envelope.proposal)
    )
      throw refused()
    checkTime(initial.envelope.proposal, signal)
    return await withToolExecutionLifetime(id, async (lifetime) => {
      const claim = await lifetime.claim(runId, userId)
      if (claim.outcome !== 'claimed') throw refused()
      const current = await load(id, runId, userId)
      if (
        current.row.executionAttempts !== 1 ||
        current.row.permissionDecision !== 'allow' ||
        encoded(current.envelope) !== encoded(initial.envelope)
      )
        throw refused()
      const check = () => {
        checkTime(current.envelope.proposal, signal)
        lifetime.signal.throwIfAborted()
      }
      check()
      let returned = false
      try {
        const result = await withPermissionGroupScope(() =>
          applyWorkflowOperations.execute({
            principal: current.principal,
            input: applyInput(current.envelope.proposal, current.body, check, false),
          })
        )
        returned = true
        if (
          result.dryRun ||
          result.baseRevision !== current.envelope.proposal.expectedRevision ||
          result.workflowId !== current.envelope.proposal.workflowId ||
          result.workspaceId !== current.envelope.proposal.workspaceId ||
          !Number.isSafeInteger(result.draftRevision) ||
          result.draftRevision < result.baseRevision
        )
          throw refused()
        const receipt = {
          status: 'applied' as const,
          baseRevision: result.baseRevision,
          draftRevision: result.draftRevision,
        }
        await lifetime.complete({ toolCallId: id, status: 'completed', result: receipt })
        const settled = await getAsyncToolCall(id)
        if (
          !settled ||
          settled.runId !== runId ||
          settled.toolName !== WORKFLOW_PROPOSAL_TOOL ||
          settled.status !== 'completed' ||
          encoded(settled.args) !== encoded(current.envelope) ||
          encoded(settled.result) !== encoded(receipt)
        )
          throw refused()
        return receipt
      } catch (error) {
        if (!returned && error instanceof OrchestrationError && error.code === 'conflict') {
          const receipt = { status: 'rejected' as const, code: 'conflict' as const }
          try {
            await lifetime.complete({
              toolCallId: id,
              status: 'failed',
              result: receipt,
              error: 'proposal_conflict',
            })
            return receipt
          } catch {
            return { status: 'unknown' as const }
          }
        }
        // Even an aborted response can follow a committed write. No replay or fabricated rollback.
        await lifetime
          .complete({
            toolCallId: id,
            status: 'failed',
            result: { status: 'unknown' },
            error: 'proposal_outcome_unknown',
          })
          .catch(() => {})
        return { status: 'unknown' as const }
      }
    })
  } catch {
    throw refused()
  }
}
