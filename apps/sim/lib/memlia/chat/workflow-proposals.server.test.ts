// Copyright (c) 2026 Memlia. All rights reserved.
import { createHash } from 'node:crypto'
import { beforeEach, expect, it, vi } from 'vitest'

const infra = vi.hoisted(() => ({
  rows: new Map<string, any>(),
  live: true,
  context: vi.fn(),
  authorize: vi.fn(),
  graph: vi.fn(),
  apply: vi.fn(),
  run: vi.fn(),
  upsert: vi.fn(),
  complete: vi.fn(),
  bans: vi.fn(),
}))
// PostgreSQL, auth policy and execution lease are explicit doubles. Schemas,
// capture, hashes, immutable envelope and decision/apply adapter are real.
vi.mock('@sim/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({ limit: async () => (infra.live ? [{ id: 'session-a' }] : []) }),
        }),
      }),
    }),
  },
}))
vi.mock('@/lib/auth/ban', () => ({ getActivelyBannedUserIds: infra.bans }))
vi.mock('@/lib/workflows/application/context', () => ({
  resolveActiveWorkflowApplicationContext: infra.context,
}))
vi.mock('@/lib/core/application/workspace-authorization', () => ({
  authorizeWorkspaceOperation: infra.authorize,
}))
vi.mock('@/lib/workflows/application/read-workflow-graph', () => ({
  readWorkflowGraph: { execute: infra.graph },
}))
vi.mock('@/lib/workflows/application/apply-workflow-operations', () => ({
  applyWorkflowOperations: { execute: infra.apply },
}))
vi.mock('@/lib/mothership/async-runs/repository', () => ({
  getRunSegment: infra.run,
  getAsyncToolCall: async (id: string) => structuredClone(infra.rows.get(id) ?? null),
  upsertAsyncToolCall: infra.upsert,
  recordToolPermissionDecision: async (id: string, decision: string) => {
    const row = infra.rows.get(id)
    if (!row || row.permissionDecision || row.status !== 'pending') return null
    row.permissionDecision = decision
    row.permissionDecidedAt = new Date()
    return structuredClone(row)
  },
}))
vi.mock('@/lib/mothership/request/tools/execution-lifetime', () => ({
  withToolExecutionLifetime: async (id: string, work: (lifetime: unknown) => unknown) =>
    work({
      signal: new AbortController().signal,
      claim: async () => {
        const row = infra.rows.get(id)
        if (row.status !== 'pending') return { outcome: 'existing' }
        row.status = 'running'
        row.executionAttempts++
        row.executionStartedAt = new Date()
        return { outcome: 'claimed' }
      },
      complete: infra.complete,
    }),
}))

import {
  createWorkflowProposal,
  executeWorkflowProposal,
  readWorkflowProposal,
  readWorkflowProposalReview,
  recordWorkflowProposalDecision,
} from './workflow-proposals.server'

const principal = { kind: 'session' as const, userId: 'user-a', sessionId: 'session-a' }
const scope = { principal, runId: 'run-a', workflowId: 'workflow-a', workspaceId: 'workspace-a' }
const body = () => ({
  expectedRevision: 7,
  operations: [
    { operation_type: 'edit', block_id: 'block-a', params: { name: 'NEW_PRIVATE_NAME' } },
  ],
  layout: 'none',
})
const hash = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`
beforeEach(() => {
  vi.useRealTimers()
  infra.rows.clear()
  infra.live = true
  infra.context.mockReset().mockResolvedValue({
    workflowId: 'workflow-a',
    workspaceId: 'workspace-a',
    workspaceOrganizationId: null,
    workflow: { id: 'workflow-a', draftRevision: 7 },
    allowPersonalApiKeys: true,
  })
  infra.authorize.mockReset().mockResolvedValue(undefined)
  infra.bans.mockReset().mockResolvedValue([])
  infra.graph
    .mockReset()
    .mockResolvedValue({ workflowId: 'workflow-a', workspaceId: 'workspace-a', draftRevision: 7 })
  infra.run.mockReset().mockResolvedValue({
    id: 'run-a',
    userId: 'user-a',
    workspaceId: 'workspace-a',
    workflowId: 'workflow-a',
    organizationId: null,
  })
  infra.apply.mockReset().mockImplementation(async ({ input }) => ({
    workflowId: 'workflow-a',
    workspaceId: 'workspace-a',
    baseRevision: 7,
    draftRevision: input.dryRun ? 7 : 8,
    dryRun: input.dryRun === true,
    applied: 1,
    operationCount: 1,
    skipped: [],
    deferred: [],
    inputValidationErrors: [],
  }))
  infra.upsert.mockReset().mockImplementation(async (input) => {
    if (!infra.rows.has(input.toolCallId))
      infra.rows.set(input.toolCallId, {
        ...structuredClone(input),
        permissionRequestedAt: new Date(),
        permissionDecision: null,
        permissionDecidedAt: null,
        executionAttempts: 0,
        executionStartedAt: null,
      })
    return structuredClone(infra.rows.get(input.toolCallId))
  })
  infra.complete.mockReset().mockImplementation(async (input) => {
    Object.assign(infra.rows.get(input.toolCallId), structuredClone(input))
  })
})
async function prepared() {
  return createWorkflowProposal(scope, body())
}
async function allow(id: string) {
  return recordWorkflowProposalDecision({
    toolCallId: id,
    expectedDigest: infra.rows.get(id).args.proposal.digest,
    principal,
    decision: 'allow',
    single: true,
  })
}
it('captures the actual server revision and complete atomic v2 bytes before showing a proposal', async () => {
  const shown = await prepared()
  const row = infra.rows.get(shown.proposalId)
  const envelope = row.args
  const bytes = envelope.body
  expect(JSON.parse(bytes)).toEqual({ ...body(), expectedRevision: 7, atomic: true })
  expect(shown.operations.sha256).toBe(hash(bytes))
  expect(shown.operations.count).toBe(1)
  expect(Date.parse(shown.expiresAt) - Date.parse(shown.issuedAt)).toBe(600000)
  expect(JSON.stringify(shown)).not.toContain('NEW_PRIVATE_NAME')
  expect(JSON.stringify(shown)).not.toContain('session-a')
  expect(infra.apply.mock.calls.every(([call]) => call.input.dryRun === true)).toBe(true)
})
it('applies only the persisted bytes after a single real decision and returns no graph', async () => {
  const shown = await prepared()
  await allow(shown.proposalId)
  const result = await executeWorkflowProposal(shown.proposalId, 'run-a', 'user-a')
  expect(result).toMatchObject({ status: 'applied', baseRevision: 7, draftRevision: 8 })
  expect(infra.apply.mock.calls.filter(([call]) => !call.input.dryRun)).toHaveLength(1)
  expect(infra.apply.mock.calls.at(-1)?.[0].input).toMatchObject({
    expectedRevision: 7,
    atomic: true,
    layout: 'none',
    operations: body().operations,
  })
  expect(JSON.stringify(result)).not.toContain('NEW_PRIVATE_NAME')
  await expect(executeWorkflowProposal(shown.proposalId, 'run-a', 'user-a')).rejects.toThrow(
    'proposal_unavailable'
  )
  expect(infra.apply.mock.calls.filter(([call]) => !call.input.dryRun)).toHaveLength(1)
})
it.each(['missing', 'skip', 'allow_chat', 'always_allow'])(
  'never applies decision %s',
  async (decision) => {
    const shown = await prepared()
    if (decision !== 'missing') infra.rows.get(shown.proposalId).permissionDecision = decision
    await expect(executeWorkflowProposal(shown.proposalId, 'run-a', 'user-a')).rejects.toThrow(
      'proposal_unavailable'
    )
    expect(infra.apply.mock.calls.filter(([call]) => !call.input.dryRun)).toHaveLength(0)
  }
)
it.each(['allow_chat', 'always_allow'])(
  'does not persist %s or a bulk answer',
  async (decision) => {
    const shown = await prepared()
    await expect(
      recordWorkflowProposalDecision({
        toolCallId: shown.proposalId,
        expectedDigest: shown.digest,
        principal,
        decision,
        single: true,
      })
    ).rejects.toThrow('proposal_unavailable')
    await expect(
      recordWorkflowProposalDecision({
        toolCallId: shown.proposalId,
        expectedDigest: shown.digest,
        principal,
        decision: 'allow',
        single: false,
      })
    ).rejects.toThrow('proposal_unavailable')
    expect(infra.rows.get(shown.proposalId).permissionDecision).toBeNull()
  }
)
it.each(['body', 'digest', 'organization', 'deadline'])(
  'refuses modified persisted %s before a decision',
  async (mutation) => {
    const shown = await prepared()
    const row = infra.rows.get(shown.proposalId)
    if (mutation === 'body')
      row.args.body = row.args.body.replace('NEW_PRIVATE_NAME', 'CHANGED_PRIVATE')
    if (mutation === 'digest') row.args.proposal.digest = `sha256:${'0'.repeat(64)}`
    if (mutation === 'organization') row.args.proposal.organizationId = 'other-org'
    if (mutation === 'deadline') row.executionDeadlineAt = new Date(Date.now() + 3600000)
    await expect(allow(shown.proposalId)).rejects.toThrow('proposal_unavailable')
    expect(row.permissionDecision).toBeNull()
  }
)
it('rejects expiry exactly at ten minutes and a revoked session without recording consent', async () => {
  const shown = await prepared()
  vi.useFakeTimers()
  vi.setSystemTime(new Date(shown.expiresAt))
  await expect(allow(shown.proposalId)).rejects.toThrow('proposal_unavailable')
  vi.useRealTimers()
  infra.live = false
  await expect(allow(shown.proposalId)).rejects.toThrow('proposal_unavailable')
})
it('does not publish a proposal when JSONB changed the stored intention', async () => {
  const insert = infra.upsert.getMockImplementation()!
  infra.upsert.mockImplementation(async (input) => {
    const row = await insert(input)
    infra.rows.get(row.toolCallId).args.body = '{}'
    return row
  })
  await expect(prepared()).rejects.toThrow('proposal_unavailable')
})
it('owns the intention and principal before the first await', async () => {
  let release!: () => void
  infra.run.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () =>
          resolve({
            id: 'run-a',
            userId: 'user-a',
            workspaceId: 'workspace-a',
            workflowId: 'workflow-a',
            organizationId: null,
          })
      })
  )
  const input = body()
  const own = { ...scope, principal: { ...principal } }
  const pending = createWorkflowProposal(own, input)
  void pending.catch(() => {})
  input.operations[0].params.name = 'ALTERED'
  own.principal.userId = 'stranger'
  release?.()
  const shown = await pending
  expect(JSON.parse(infra.rows.get(shown.proposalId).args.body).operations[0].params.name).toBe(
    'NEW_PRIVATE_NAME'
  )
  expect(shown.authorUserId).toBe('user-a')
})
it('retains an unknown issue after a possible write and never replays it', async () => {
  const shown = await prepared()
  await allow(shown.proposalId)
  infra.apply.mockRejectedValueOnce(new Error('PRIVATE_POST_COMMIT_ERROR'))
  const result = await executeWorkflowProposal(shown.proposalId, 'run-a', 'user-a')
  expect(result).toEqual({ status: 'unknown' })
  expect(JSON.stringify(result)).not.toContain('PRIVATE')
  await expect(executeWorkflowProposal(shown.proposalId, 'run-a', 'user-a')).rejects.toThrow(
    'proposal_unavailable'
  )
})
it('refuses resumed execution attempts rather than treating a dead lease as permission to replay', async () => {
  const shown = await prepared()
  await allow(shown.proposalId)
  infra.rows.get(shown.proposalId).executionAttempts = 1
  await expect(executeWorkflowProposal(shown.proposalId, 'run-a', 'user-a')).rejects.toThrow(
    'proposal_unavailable'
  )
  expect(infra.apply.mock.calls.filter(([call]) => !call.input.dryRun)).toHaveLength(0)
})
it('checks current scope, role and actor again rather than borrowing the original authorization', async () => {
  const shown = await prepared()
  await expect(
    recordWorkflowProposalDecision({
      toolCallId: shown.proposalId,
      expectedDigest: shown.digest,
      principal: { ...principal, userId: 'other' },
      decision: 'allow',
      single: true,
    })
  ).rejects.toThrow('proposal_unavailable')
  infra.authorize.mockRejectedValue(new Error('revoked'))
  await expect(allow(shown.proposalId)).rejects.toThrow('proposal_unavailable')
  expect(infra.rows.get(shown.proposalId).permissionDecision).toBeNull()
})
it('rejects a stale planned revision instead of replacing its attestation', async () => {
  await expect(createWorkflowProposal(scope, { ...body(), expectedRevision: 0 })).rejects.toThrow(
    'proposal_unavailable'
  )
  expect(infra.upsert).not.toHaveBeenCalled()
})
it('loads only public metadata for the matching run and human', async () => {
  const shown = await prepared()
  expect(await readWorkflowProposal(shown.proposalId, 'run-a', 'user-a')).toEqual(shown)
  await expect(readWorkflowProposal(shown.proposalId, 'other-run', 'user-a')).rejects.toThrow(
    'proposal_unavailable'
  )
})
it('refuses a decision timestamp before issuance rather than accepting an unbound old answer', async () => {
  const shown = await prepared()
  await allow(shown.proposalId)
  infra.rows.get(shown.proposalId).permissionDecidedAt = new Date(Date.parse(shown.issuedAt) - 1)
  await expect(executeWorkflowProposal(shown.proposalId, 'run-a', 'user-a')).rejects.toThrow(
    'proposal_unavailable'
  )
  expect(infra.apply.mock.calls.filter(([call]) => !call.input.dryRun)).toHaveLength(0)
})
it('reports a native revision conflict distinctly without a replacement or a retry', async () => {
  const { OrchestrationError } = await import('@/lib/core/orchestration/types')
  const shown = await prepared()
  await allow(shown.proposalId)
  infra.apply.mockRejectedValueOnce(new OrchestrationError('conflict', 'PRIVATE_REVISION'))
  expect(await executeWorkflowProposal(shown.proposalId, 'run-a', 'user-a')).toEqual({
    status: 'rejected',
    code: 'conflict',
  })
  expect(infra.apply.mock.calls.filter(([call]) => !call.input.dryRun)).toHaveLength(1)
})
it('does not silently lose prototype-named input fields while making immutable bytes', async () => {
  const input = JSON.parse(
    '{"expectedRevision":7,"operations":[{"operation_type":"edit","block_id":"block-a","params":{"inputs":{"__proto__":"PRIVATE_DATA"}}}],"layout":"none"}'
  )
  await expect(createWorkflowProposal(scope, input)).rejects.toThrow('proposal_unavailable')
  expect(infra.upsert).not.toHaveBeenCalled()
})
it.each(['before', 'during'])(
  'cancellation %s admission prevents a graph application',
  async (when) => {
    const shown = await prepared()
    await allow(shown.proposalId)
    const controller = new AbortController()
    if (when === 'before') controller.abort()
    else
      infra.authorize.mockImplementationOnce(async () => {
        controller.abort()
      })
    await expect(
      executeWorkflowProposal(shown.proposalId, 'run-a', 'user-a', controller.signal)
    ).rejects.toThrow('proposal_unavailable')
    expect(infra.apply.mock.calls.filter(([call]) => !call.input.dryRun)).toHaveLength(0)
  }
)
it('returns unknown if the graph applied but its completion receipt could not be persisted', async () => {
  const shown = await prepared()
  await allow(shown.proposalId)
  infra.complete.mockRejectedValue(new Error('PRIVATE_DB_FAILURE'))
  expect(await executeWorkflowProposal(shown.proposalId, 'run-a', 'user-a')).toEqual({
    status: 'unknown',
  })
  await expect(executeWorkflowProposal(shown.proposalId, 'run-a', 'user-a')).rejects.toThrow(
    'proposal_unavailable'
  )
  expect(infra.apply.mock.calls.filter(([call]) => !call.input.dryRun)).toHaveLength(1)
})
it('does not mistake null organization for an organization wildcard', async () => {
  const shown = await prepared()
  infra.context.mockResolvedValue({
    workflowId: 'workflow-a',
    workspaceId: 'workspace-a',
    workspaceOrganizationId: 'org-changed',
  })
  await expect(allow(shown.proposalId)).rejects.toThrow('proposal_unavailable')
  expect(infra.rows.get(shown.proposalId).permissionDecision).toBeNull()
})
it('retains the first persisted decision against a later opposite answer', async () => {
  const shown = await prepared()
  expect(
    await recordWorkflowProposalDecision({
      toolCallId: shown.proposalId,
      expectedDigest: shown.digest,
      principal,
      decision: 'skip',
      single: true,
    })
  ).toMatchObject({ decision: 'skip', applied: true })
  expect(await allow(shown.proposalId)).toMatchObject({ decision: 'skip', applied: false })
  await expect(executeWorkflowProposal(shown.proposalId, 'run-a', 'user-a')).rejects.toThrow(
    'proposal_unavailable'
  )
})
it('refuses failed policy revalidation after the lease claim before touching the graph', async () => {
  const shown = await prepared()
  await allow(shown.proposalId)
  infra.authorize
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error('revoked between claim and apply'))
  await expect(executeWorkflowProposal(shown.proposalId, 'run-a', 'user-a')).rejects.toThrow(
    'proposal_unavailable'
  )
  expect(infra.apply.mock.calls.filter(([call]) => !call.input.dryRun)).toHaveLength(0)
})
it('does not claim applied when native completion returns without persisting the owned result', async () => {
  const shown = await prepared()
  await allow(shown.proposalId)
  infra.complete.mockResolvedValue(undefined)
  expect(await executeWorkflowProposal(shown.proposalId, 'run-a', 'user-a')).toEqual({
    status: 'unknown',
  })
  expect(infra.apply.mock.calls.filter(([call]) => !call.input.dryRun)).toHaveLength(1)
  await expect(executeWorkflowProposal(shown.proposalId, 'run-a', 'user-a')).rejects.toThrow(
    'proposal_unavailable'
  )
})
it('requires the planned revision and never invents one for an unattested intention', async () => {
  const { expectedRevision: _revision, ...unattested } = { ...body(), expectedRevision: 7 }
  await expect(createWorkflowProposal(scope, unattested)).rejects.toThrow('proposal_unavailable')
  expect(infra.apply).not.toHaveBeenCalled()
  expect(infra.upsert).not.toHaveBeenCalled()
})
it('accepts an explicitly planned revision only when the server snapshot agrees', async () => {
  expect(await createWorkflowProposal(scope, { ...body(), expectedRevision: 7 })).toMatchObject({
    expectedRevision: 7,
  })
})

// Consent must bind the exact review, not merely the proposal ID.
it.each([undefined, `sha256:${'0'.repeat(64)}`])(
  'refuses absent or different displayed digest before any decision: %s',
  async (expectedDigest) => {
    const proposal = await prepared()
    await expect(
      recordWorkflowProposalDecision({
        toolCallId: proposal.proposalId,
        principal,
        decision: 'allow',
        single: true,
        expectedDigest,
      })
    ).rejects.toThrow('proposal_unavailable')
    expect(infra.rows.get(proposal.proposalId).permissionDecision).toBeNull()
  }
)
it('refuses another valid session of the same author before recording a decision', async () => {
  const proposal = await prepared()
  await expect(
    recordWorkflowProposalDecision({
      toolCallId: proposal.proposalId,
      principal: { ...principal, sessionId: 'other-session' },
      decision: 'allow',
      single: true,
      expectedDigest: proposal.digest,
    })
  ).rejects.toThrow('proposal_unavailable')
  expect(infra.rows.get(proposal.proposalId).permissionDecision).toBeNull()
})
it('reviews exact body bytes, revision and deadline without exposing private session or mutating rows', async () => {
  const proposal = await prepared()
  const before = structuredClone(infra.rows.get(proposal.proposalId))
  const review = await readWorkflowProposalReview({ toolCallId: proposal.proposalId, principal })
  expect(review).toEqual({
    toolCallId: proposal.proposalId,
    workflowId: 'workflow-a',
    workspaceId: 'workspace-a',
    expectedRevision: 7,
    issuedAt: proposal.issuedAt,
    expiresAt: proposal.expiresAt,
    digest: proposal.digest,
    body: before.args.body,
  })
  expect(infra.rows.get(proposal.proposalId)).toEqual(before)
  expect(JSON.stringify(review)).not.toContain('session-a')
})
it('refuses a stale graph before review or recording the displayed decision', async () => {
  const proposal = await prepared()
  infra.context.mockResolvedValue({
    workflowId: 'workflow-a',
    workspaceId: 'workspace-a',
    workflow: { id: 'workflow-a', draftRevision: 8 },
    workspaceOrganizationId: null,
  })
  await expect(
    readWorkflowProposalReview({ toolCallId: proposal.proposalId, principal })
  ).rejects.toThrow('proposal_unavailable')
  await expect(
    recordWorkflowProposalDecision({
      toolCallId: proposal.proposalId,
      principal,
      decision: 'allow',
      single: true,
      expectedDigest: proposal.digest,
    })
  ).rejects.toThrow('proposal_unavailable')
  expect(infra.rows.get(proposal.proposalId).permissionDecision).toBeNull()
})

it.each(['foreign', 'revoked', 'expired'])(
  'refuses %s owner review and leaves the row unchanged',
  async (issue) => {
    const proposal = await prepared()
    const before = structuredClone(infra.rows.get(proposal.proposalId))
    const subject = issue === 'foreign' ? { ...principal, userId: 'other-user' } : principal
    if (issue === 'revoked') infra.authorize.mockRejectedValue(new Error('PRIVATE_POLICY'))
    if (issue === 'expired') {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(proposal.expiresAt))
    }
    await expect(
      readWorkflowProposalReview({ toolCallId: proposal.proposalId, principal: subject })
    ).rejects.toThrow('proposal_unavailable')
    expect(infra.rows.get(proposal.proposalId)).toEqual(before)
  }
)
it('owns displayed digest and subject before awaiting the authorization checks', async () => {
  const proposal = await prepared()
  const input = {
    toolCallId: proposal.proposalId,
    principal: { ...principal },
    expectedDigest: proposal.digest,
    decision: 'allow',
    single: true,
  }
  infra.authorize.mockImplementationOnce(async () => {
    input.expectedDigest = `sha256:${'0'.repeat(64)}`
    input.principal.sessionId = 'mutated-session'
  })
  expect(await recordWorkflowProposalDecision(input)).toMatchObject({
    decision: 'allow',
    applied: true,
  })
})

it('reviews and records without calling the graph loader that can persist migrations on read', async () => {
  const proposal = await prepared()
  infra.graph.mockClear()
  await readWorkflowProposalReview({ toolCallId: proposal.proposalId, principal })
  await recordWorkflowProposalDecision({
    toolCallId: proposal.proposalId,
    principal,
    decision: 'allow',
    single: true,
    expectedDigest: proposal.digest,
  })
  expect(infra.graph).not.toHaveBeenCalled()
})
