// SPDX-License-Identifier: Apache-2.0
// Modified by Memlia: adapt Sim authoring fixtures to qualify the preview tool.

import { workflowAuthzMockFns } from '@sim/testing'
import {
  createDelegatedPrincipal,
  createExecutorPrincipal,
  createSessionPrincipal,
} from '@sim/testing/factories/principal.factory'
import { auditMock, auditMockFns } from '@sim/testing/mocks/audit.mock'
import {
  blockVisibilityMock,
  blockVisibilityMockFns,
} from '@sim/testing/mocks/block-visibility.mock'
import { dbChainMockFns } from '@sim/testing/mocks/database.mock'
import {
  permissionGroupScopeMock,
  permissionGroupScopeMockFns,
} from '@sim/testing/mocks/permission-group-scope.mock'
import { realtimeNotifyMock, realtimeNotifyMockFns } from '@sim/testing/mocks/realtime-notify.mock'
import {
  workflowContextMock,
  workflowContextMockFns,
} from '@sim/testing/mocks/workflow-context.mock'
import {
  workflowDeploymentStatusMock,
  workflowDeploymentStatusMockFns,
} from '@sim/testing/mocks/workflow-deployment-status.mock'
import { beforeEach, expect, it, vi } from 'vitest'

const infra = vi.hoisted(() => ({
  snapshot: vi.fn(),
  replace: vi.fn(),
  ids: vi.fn(),
  permission: vi.fn(),
  rows: new Map<string, any>(),
  run: vi.fn(),
  readSnapshot: vi.fn(),
}))
// Real use case, edit engine, schemas, sanitizer, lint and authorization funnel.
// Only infrastructure reads/writes and the static fixture registry are replaced.
vi.unmock('@/blocks/registry')
vi.mock('@/blocks/registry-maps', async () => {
  const { partialBlockRegistry } = await import('@sim/testing/mocks/block-registry.mock')
  return partialBlockRegistry(
    await import('@/blocks/blocks/function'),
    await import('@/blocks/blocks/api')
  )
})
vi.mock('@sim/audit', () => auditMock)
vi.mock('@sim/platform-authz/workspace', async (original) => ({
  ...(await original<typeof import('@sim/platform-authz/workspace')>()),
  resolveEffectiveWorkspacePermission: infra.permission,
}))
vi.mock('@/lib/workflows/application/context', () => workflowContextMock)
vi.mock('@/lib/workflows/persistence/utils', () => ({ loadWorkflowDraftSnapshot: infra.snapshot }))
vi.mock('@/lib/workflows/persistence/replace-normalized-state', async (original) => ({
  ...(await original<typeof import('@/lib/workflows/persistence/replace-normalized-state')>()),
  replaceWorkflowNormalizedState: infra.replace,
  assertWorkflowGraphIdsUnclaimed: infra.ids,
}))
vi.mock('@/lib/realtime/notify', () => realtimeNotifyMock)
vi.mock('@/lib/workflows/deployment-status', () => workflowDeploymentStatusMock)
vi.mock('@/lib/core/config/block-visibility', () => blockVisibilityMock)
vi.mock('@/lib/permission-groups/config-scope.server', () => permissionGroupScopeMock)

vi.mock('@/lib/auth/ban', () => ({ getActivelyBannedUserIds: async () => [] }))
vi.mock('@/lib/workflows/queries', () => ({ loadWorkflowReadSnapshot: infra.readSnapshot }))
vi.mock('@/lib/mothership/async-runs/repository', () => ({
  getRunSegment: infra.run,
  getAsyncToolCall: async (id: string) => structuredClone(infra.rows.get(id) ?? null),
  upsertAsyncToolCall: async (input: any) => {
    if (!infra.rows.has(input.toolCallId))
      infra.rows.set(input.toolCallId, {
        ...structuredClone(input),
        permissionRequestedAt: new Date(),
        permissionDecision: null,
        permissionDecidedAt: null,
        executionStartedAt: null,
        executionAttempts: 0,
      })
    return structuredClone(infra.rows.get(input.toolCallId))
  },
  recordToolPermissionDecision: async (id: string, decision: string) => {
    const row = infra.rows.get(id)
    if (row.permissionDecision || row.status !== 'pending') return null
    row.permissionDecision = decision
    row.permissionDecidedAt = new Date()
    return structuredClone(row)
  },
}))
vi.mock('@/lib/mothership/request/tools/execution-lifetime', () => ({
  withToolExecutionLifetime: async (id: string, work: (arg: any) => unknown) =>
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
      complete: async (input: any) => {
        Object.assign(infra.rows.get(id), input)
      },
    }),
}))

import { createWorkflowPreviewTools } from './workflow-preview-tools'
import {
  executeWorkflowProposal,
  recordWorkflowProposalDecision,
} from './workflow-proposals.server'

const blockId = '11111111-1111-4111-8111-111111111111'
const principal = createSessionPrincipal()
const scope = { principal, workflowId: 'workflow-preview', workspaceId: 'workspace-preview' }
const state = () => ({
  blocks: {
    [blockId]: {
      id: blockId,
      type: 'function',
      name: 'Before',
      enabled: true,
      position: { x: 0, y: 0 },
      outputs: {},
      subBlocks: { code: { id: 'code', type: 'code', value: 'return "PRIVATE_GRAPH_CANARY"' } },
    },
  },
  edges: [],
  loops: {},
  parallels: {},
})
const body = () => ({
  expectedRevision: 7,
  layout: 'none',
  operations: [{ operation_type: 'edit', block_id: blockId, params: { name: 'After' } }],
})
beforeEach(() => {
  infra.snapshot.mockReset().mockImplementation(async () => ({ state: state(), draftRevision: 7 }))
  infra.permission.mockReset().mockResolvedValue('write')
  infra.replace.mockReset().mockRejectedValue(new Error('A preview must never write'))
  infra.ids.mockReset().mockResolvedValue(undefined)
  workflowContextMockFns.mockResolveActiveWorkflowApplicationContext.mockReset().mockResolvedValue({
    workflowId: scope.workflowId,
    workflow: {
      id: scope.workflowId,
      name: 'PRIVATE_NAME_CANARY',
      workspaceId: scope.workspaceId,
      draftRevision: 7,
    },
    workspaceId: scope.workspaceId,
    workspaceOrganizationId: null,
    allowPersonalApiKeys: true,
    billedAccountUserId: 'different-billing-owner',
  })
  workflowAuthzMockFns.mockAssertWorkflowMutable.mockReset().mockResolvedValue(undefined)
  blockVisibilityMockFns.mockGetBlockVisibility.mockResolvedValue({
    revealed: [],
    disabled: [],
    previewTagged: [],
  })
  permissionGroupScopeMockFns.mockResolvePermissionGroupConfig.mockResolvedValue(null)
  workflowDeploymentStatusMockFns.mockCheckNeedsRedeployment.mockResolvedValue(true)
  auditMockFns.mockRecordAudit.mockClear()
  realtimeNotifyMockFns.mockNotifyWorkflowUpdated.mockClear()
})

it('evaluates actual native operations without writing or disclosing the graph', async () => {
  const result = await createWorkflowPreviewTools(scope).dispatch(
    'preview_workflow_operations',
    body()
  )
  expect(result).toMatchObject({
    ok: true,
    data: {
      dryRun: true,
      persisted: false,
      baseRevision: 7,
      draftRevision: 7,
      operationCount: 1,
      applied: 1,
      lint: { completeness: 'best_effort' },
    },
  })
  expect(infra.replace).not.toHaveBeenCalled()
  expect(auditMockFns.mockRecordAudit).not.toHaveBeenCalled()
  expect(realtimeNotifyMockFns.mockNotifyWorkflowUpdated).not.toHaveBeenCalled()
  expect(JSON.stringify(result)).not.toMatch(
    /PRIVATE_|"graph"|"workflowName"|"mintedBlockIds"|"previewBlockIds"/
  )
})

it('returns a native machine refusal and request index without arbitrary explanation', async () => {
  const result = await createWorkflowPreviewTools(scope).dispatch('preview_workflow_operations', {
    expectedRevision: 7,
    layout: 'none',
    operations: [{ operation_type: 'delete', block_id: 'missing-private-message' }],
  })
  expect(result).toMatchObject({
    ok: true,
    data: { applied: 0, skipped: [{ code: 'block_not_found', operationIndexes: [0] }] },
  })
  expect(JSON.stringify(result)).not.toMatch(/missing-private-message|PRIVATE_|reason|details/)
  expect(infra.replace).not.toHaveBeenCalled()
})

it('reports atomic refusal without an applied-success envelope or arbitrary message', async () => {
  const result = await createWorkflowPreviewTools(scope).dispatch('preview_workflow_operations', {
    expectedRevision: 7,
    atomic: true,
    layout: 'none',
    operations: [{ operation_type: 'delete', block_id: 'missing-private-message' }],
  })
  expect(result).toMatchObject({
    ok: false,
    error: { code: 'atomic_refused' },
    diagnostics: {
      skipped: [{ code: 'block_not_found', operationIndexes: [0] }],
    },
  })
  expect(result).not.toHaveProperty('data')
  expect(JSON.stringify(result)).not.toMatch(
    /missing-private-message|PRIVATE_|atomic was requested/
  )
  expect(infra.replace).not.toHaveBeenCalled()
})

it('projects native configuration lint as fixed diagnostics and counts, not values or prose', async () => {
  // Function.code is not required natively. API.url is, with method configured.
  infra.snapshot.mockResolvedValue({
    state: {
      ...state(),
      blocks: {
        [blockId]: {
          ...state().blocks[blockId],
          type: 'api',
          subBlocks: {
            url: { id: 'url', type: 'short-input', value: '' },
            method: { id: 'method', type: 'dropdown', value: 'GET' },
          },
        },
      },
    },
    draftRevision: 7,
  })
  const input = {
    expectedRevision: 7,
    layout: 'none',
    operations: [{ operation_type: 'edit', block_id: blockId, params: { name: 'After' } }],
  }
  const result = await createWorkflowPreviewTools(scope).dispatch(
    'preview_workflow_operations',
    input
  )
  expect(result).toMatchObject({
    ok: true,
    data: {
      lint: {
        completeness: 'best_effort',
        diagnostics: expect.arrayContaining([
          { code: 'missing_required_fields', operationIndexes: [0], count: 1 },
        ]),
      },
    },
  })
  expect(JSON.stringify(result)).not.toMatch(
    /PRIVATE_|blockName|missingRequiredFields|"reason"|"value"/
  )
})

it('owns the request before a native snapshot read can yield to caller edits', async () => {
  let release!: () => void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  infra.snapshot.mockImplementationOnce(async () => {
    await wait
    return { state: state(), draftRevision: 7 }
  })
  const input = body()
  const run = createWorkflowPreviewTools(scope).dispatch('preview_workflow_operations', input)
  await vi.waitFor(() => expect(infra.snapshot).toHaveBeenCalled())
  input.expectedRevision = 99
  input.operations.length = 0
  release()
  expect(await run).toMatchObject({
    ok: true,
    data: { operationCount: 1, applied: 1, baseRevision: 7 },
  })
})

it.each([
  { ...body(), expectedRevision: undefined },
  { ...body(), expectedRevision: -1 },
  { ...body(), expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
  { ...body(), dryRun: false },
  { ...body(), baseGraph: {} },
  { ...body(), operations: [] },
  { ...body(), extra: 'SECRET_CANARY' },
])('rejects non-contract input before infrastructure reads: %#', async (input) => {
  expect(
    await createWorkflowPreviewTools(scope).dispatch('preview_workflow_operations', input)
  ).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
  expect(infra.snapshot).not.toHaveBeenCalled()
  expect(infra.permission).not.toHaveBeenCalled()
})

it('refuses input accessors without executing them and unknown tools without reading inputs', async () => {
  const getter = vi.fn(() => 'SECRET_CANARY')
  const input = Object.defineProperty(body(), 'hidden', { get: getter, enumerable: true })
  const tool = createWorkflowPreviewTools(scope)
  expect(await tool.dispatch('preview_workflow_operations', input)).toMatchObject({
    error: { code: 'invalid_input' },
  })
  expect(await tool.dispatch('apply_workflow_operations', input)).toMatchObject({
    error: { code: 'tool_not_allowed' },
  })
  expect(getter).not.toHaveBeenCalled()
  expect(infra.snapshot).not.toHaveBeenCalled()
})

it.each(['read', null])('uses native permission refusal for %s', async (permission) => {
  infra.permission.mockResolvedValue(permission)
  const result = await createWorkflowPreviewTools(scope).dispatch(
    'preview_workflow_operations',
    body()
  )
  expect(result).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  expect(infra.snapshot).not.toHaveBeenCalled()
  expect(infra.replace).not.toHaveBeenCalled()
})

it('uses the native revision check before the edit engine', async () => {
  const result = await createWorkflowPreviewTools(scope).dispatch('preview_workflow_operations', {
    ...body(),
    expectedRevision: 6,
  })
  expect(result).toMatchObject({ ok: false, error: { code: 'revision_conflict' } })
  expect(infra.ids).not.toHaveBeenCalled()
})

it('refuses an incoherent workspace returned by the context infrastructure double', async () => {
  workflowContextMockFns.mockResolveActiveWorkflowApplicationContext.mockResolvedValue({
    workflowId: scope.workflowId,
    workflow: { id: scope.workflowId, workspaceId: 'other-workspace' },
    workspaceId: 'other-workspace',
    workspaceOrganizationId: null,
    allowPersonalApiKeys: true,
    billedAccountUserId: 'user-1',
  })
  expect(
    await createWorkflowPreviewTools(scope).dispatch('preview_workflow_operations', body())
  ).toMatchObject({ ok: false, error: { code: 'unavailable' } })
  expect(workflowContextMockFns.mockResolveActiveWorkflowApplicationContext).toHaveBeenCalledWith({
    workflowId: scope.workflowId,
    assertedWorkspaceId: scope.workspaceId,
  })
})

it('keeps the principal and context captured before caller mutation', async () => {
  const callerPrincipal = createSessionPrincipal()
  const context = { ...scope, principal: callerPrincipal }
  const tools = createWorkflowPreviewTools(context)
  callerPrincipal.userId = 'caller-mutated-user'
  context.workflowId = 'caller-mutated-workflow'
  context.workspaceId = 'caller-mutated-workspace'
  expect(await tools.dispatch('preview_workflow_operations', body())).toMatchObject({ ok: true })
  expect(infra.permission.mock.calls[0]?.slice(0, 2)).toEqual(['user-1', scope.workspaceId])
})

it('returns cancellation before reads and during a suspended native snapshot without writes', async () => {
  const before = new AbortController()
  before.abort('SECRET_ABORT_CANARY')
  const tools = createWorkflowPreviewTools(scope)
  expect(await tools.dispatch('preview_workflow_operations', body(), before.signal)).toMatchObject({
    error: { code: 'cancelled' },
  })
  expect(infra.snapshot).not.toHaveBeenCalled()
  let release!: () => void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  infra.snapshot.mockImplementationOnce(async () => {
    await wait
    return { state: state(), draftRevision: 7 }
  })
  const during = new AbortController()
  const pending = tools.dispatch('preview_workflow_operations', body(), during.signal)
  await vi.waitFor(() => expect(infra.snapshot).toHaveBeenCalled())
  during.abort('SECRET_ABORT_CANARY')
  const result = await pending
  expect(result).toMatchObject({ ok: false, error: { code: 'cancelled' } })
  expect(JSON.stringify(result)).not.toContain('SECRET_')
  release()
  // Flush the abandoned native continuation; its abort checkpoint must stop before ID checks.
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(infra.ids).not.toHaveBeenCalled()
  expect(infra.replace).not.toHaveBeenCalled()
  expect(realtimeNotifyMockFns.mockNotifyWorkflowUpdated).not.toHaveBeenCalled()
})

it('retains native graph-ID conflicts without publishing their messages', async () => {
  const { OrchestrationError } = await import('@/lib/core/orchestration/types')
  infra.ids.mockRejectedValue(new OrchestrationError('conflict', 'PRIVATE_GRAPH_CANARY'))
  const result = await createWorkflowPreviewTools(scope).dispatch(
    'preview_workflow_operations',
    body()
  )
  expect(result).toMatchObject({ ok: false, error: { code: 'revision_conflict' } })
  expect(JSON.stringify(result)).not.toContain('PRIVATE_')
  expect(infra.replace).not.toHaveBeenCalled()
})

it('counts provisional native IDs without exposing generated IDs or graph values', async () => {
  const result = await createWorkflowPreviewTools(scope).dispatch('preview_workflow_operations', {
    expectedRevision: 7,
    layout: 'none',
    operations: [
      {
        operation_type: 'add',
        block_id: 'new-function',
        params: {
          type: 'function',
          name: 'PRIVATE_NEW_NAME',
          inputs: { code: 'return "PRIVATE_NEW_CODE"' },
        },
      },
    ],
  })
  expect(result).toMatchObject({ ok: true, data: { applied: 1, provisionalBlockIdCount: 1 } })
  expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|new-function|previewBlockIds|mintedBlockIds/)
  expect(infra.replace).not.toHaveBeenCalled()
})

it.each([
  createDelegatedPrincipal({ workspaceId: 'other-workspace', audience: 'sim:workflows' }),
  createDelegatedPrincipal({ workspaceId: scope.workspaceId, audience: 'wrong-audience' }),
  createDelegatedPrincipal({
    workspaceId: scope.workspaceId,
    audience: 'sim:workflows',
    expiresAt: new Date(0),
  }),
  createExecutorPrincipal({
    workspaceId: scope.workspaceId,
    audience: 'sim:workflows',
    delegationContext: { kind: 'workflow_execution', workflowId: scope.workflowId },
  }),
])('preserves native delegated refusal without inventing grants: %#', async (delegated) => {
  expect(
    await createWorkflowPreviewTools({ ...scope, principal: delegated }).dispatch(
      'preview_workflow_operations',
      body()
    )
  ).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  expect(infra.snapshot).not.toHaveBeenCalled()
  expect(infra.replace).not.toHaveBeenCalled()
})

it('preserves native locked-workflow refusal and bounds infrastructure failures', async () => {
  const { WorkflowLockedError } = await import('@sim/platform-authz/workflow')
  workflowAuthzMockFns.mockAssertWorkflowMutable.mockRejectedValueOnce(
    new WorkflowLockedError(scope.workflowId)
  )
  const tools = createWorkflowPreviewTools(scope)
  expect(await tools.dispatch('preview_workflow_operations', body())).toMatchObject({
    error: { code: 'locked' },
  })
  expect(infra.snapshot).not.toHaveBeenCalled()
  infra.snapshot.mockRejectedValue(new Error('SECRET_CONNECTION_CANARY'))
  const result = await tools.dispatch('preview_workflow_operations', body())
  expect(result).toMatchObject({ error: { code: 'unavailable' } })
  expect(JSON.stringify(result)).not.toContain('SECRET_')
})

// These explicitly replace the native result boundary AFTER evaluating the real engine.
// They qualify fail-closed projection, not any database or engine implementation.
it.each([
  { workflowId: 'wrong-workflow' },
  { workspaceId: 'wrong-workspace' },
  { dryRun: false },
  { baseRevision: 8 },
  { draftRevision: 8 },
  { operationCount: 0 },
  { applied: -1 },
  { applied: 99 },
  { applied: Number.NaN },
  { needsRedeployment: undefined },
])('rejects an incoherent native result boundary: %#', async (patch) => {
  const { applyWorkflowOperations } = await import(
    '@/lib/workflows/application/apply-workflow-operations'
  )
  const execute = applyWorkflowOperations.execute
  const spy = vi
    .spyOn(applyWorkflowOperations, 'execute')
    .mockImplementation(
      async (args) =>
        ({ ...(await execute(args)), ...patch }) as Awaited<ReturnType<typeof execute>>
    )
  try {
    expect(
      await createWorkflowPreviewTools(scope).dispatch('preview_workflow_operations', body())
    ).toMatchObject({ ok: false, error: { code: 'unavailable' } })
  } finally {
    spy.mockRestore()
  }
})

it('projects dropped input details without their credential, field, block type or raw error', async () => {
  const { applyWorkflowOperations } = await import(
    '@/lib/workflows/application/apply-workflow-operations'
  )
  const { WorkflowOperationsNotAppliedError } = await import(
    '@/lib/workflows/application/operations-error'
  )
  const execute = applyWorkflowOperations.execute
  const dropped = {
    blockId,
    blockType: 'SECRET_TYPE',
    field: 'SECRET_FIELD',
    value: 'SECRET_CREDENTIAL',
    error: 'SECRET_MESSAGE',
  }
  const spy = vi.spyOn(applyWorkflowOperations, 'execute').mockImplementation(async (args) => {
    const result = await execute(args)
    if (args.input.atomic) throw new WorkflowOperationsNotAppliedError([], [dropped])
    return { ...result, inputValidationErrors: [dropped] }
  })
  try {
    const tools = createWorkflowPreviewTools(scope)
    const normal = await tools.dispatch('preview_workflow_operations', body())
    expect(normal).toMatchObject({
      ok: true,
      data: {
        inputValidationErrorCount: 1,
        inputValidationErrors: [{ code: 'input_rejected', operationIndexes: [0] }],
      },
    })
    const atomic = await tools.dispatch('preview_workflow_operations', { ...body(), atomic: true })
    expect(atomic).toMatchObject({
      ok: false,
      error: { code: 'atomic_refused' },
      diagnostics: {
        inputValidationErrorCount: 1,
        inputValidationErrors: [{ code: 'input_rejected', operationIndexes: [0] }],
      },
    })
    expect(JSON.stringify([normal, atomic])).not.toMatch(/SECRET_|PRIVATE_|credential/)
    expect(infra.replace).not.toHaveBeenCalled()
  } finally {
    spy.mockRestore()
  }
})

it('bounds the projected output without returning a partial success', async () => {
  const { applyWorkflowOperations } = await import(
    '@/lib/workflows/application/apply-workflow-operations'
  )
  const execute = applyWorkflowOperations.execute
  const spy = vi.spyOn(applyWorkflowOperations, 'execute').mockImplementation(async (args) => {
    const result = await execute(args)
    return {
      ...result,
      skipped: Array.from({ length: 5000 }, () => ({
        type: 'block_not_found' as const,
        operationType: 'edit' as const,
        blockId,
        reason: 'SECRET_REASON',
      })),
    }
  })
  try {
    expect(
      await createWorkflowPreviewTools(scope).dispatch('preview_workflow_operations', body())
    ).toMatchObject({ ok: false, error: { code: 'result_too_large' } })
  } finally {
    spy.mockRestore()
  }
})

it('exports the exact strict v2 input schema without a preview-specific substitute', async () => {
  const { workflowPreviewInputs } = await import('./workflow-preview-tools')
  const { v2ApplyWorkflowOperationsBodySchema } = await import('@/lib/api/contracts/v2/workflows')
  expect(workflowPreviewInputs.preview_workflow_operations).toBe(
    v2ApplyWorkflowOperationsBodySchema
  )
  expect(Object.isFrozen(workflowPreviewInputs)).toBe(true)
})

it('uses native enablement changes without modifying the stored snapshot fixture', async () => {
  const stored = state()
  const before = structuredClone(stored)
  infra.snapshot.mockResolvedValue({ state: stored, draftRevision: 7 })
  const result = await createWorkflowPreviewTools(scope).dispatch('preview_workflow_operations', {
    ...body(),
    setBlockEnabled: [{ block_id: blockId, enabled: false }],
  })
  expect(result).toMatchObject({
    ok: true,
    data: { applied: 2, operationCount: 1, persisted: false },
  })
  expect(stored).toEqual(before)
  expect(infra.replace).not.toHaveBeenCalled()
})

it('refuses proposal creation without a server run while keeping the native preview read-only', async () => {
  const result = await createWorkflowPreviewTools(scope).propose({
    expectedRevision: 7,
    operations: body().operations,
    layout: 'none',
  })
  expect(result).toMatchObject({ ok: false, error: { code: 'tool_not_allowed' } })
  expect(infra.replace).not.toHaveBeenCalled()
})

it('previews a server-owned proposal through the real native engine and applies only after consent', async () => {
  dbChainMockFns.limit.mockResolvedValue([{ id: principal.sessionId }])
  infra.rows.clear()
  infra.run.mockResolvedValue({
    id: 'run-preview',
    userId: principal.userId,
    workspaceId: scope.workspaceId,
    workflowId: scope.workflowId,
    organizationId: null,
  })
  infra.readSnapshot.mockResolvedValue({
    workflowRecord: {
      id: scope.workflowId,
      workspaceId: scope.workspaceId,
      draftRevision: 7,
      variables: {},
    },
    normalizedData: state(),
  })
  const result = await createWorkflowPreviewTools({
    ...scope,
    proposalRunId: 'run-preview',
  }).propose({ expectedRevision: 7, operations: body().operations, layout: 'none' })
  expect(result).toMatchObject({ ok: true, proposal: { expectedRevision: 7 }, persisted: false })
  expect(infra.replace).not.toHaveBeenCalled()
  if (!('proposal' in result)) throw new Error('Expected a persisted proposal, not a graph write')
  const proposal = result.proposal as { proposalId: string; digest: string }
  await recordWorkflowProposalDecision({
    toolCallId: proposal.proposalId,
    expectedDigest: proposal.digest,
    principal,
    decision: 'allow',
    single: true,
  })
  infra.replace.mockResolvedValue({ baseRevision: 7, draftRevision: 8, warnings: [] })
  expect(
    await executeWorkflowProposal(proposal.proposalId, 'run-preview', principal.userId)
  ).toMatchObject({ status: 'applied', draftRevision: 8 })
  expect(infra.replace).toHaveBeenCalledOnce()
  expect(infra.replace.mock.calls[0][0]).toMatchObject({
    expectedRevision: 7,
    subjectUserId: principal.userId,
    state: { blocks: { [blockId]: { name: 'After' } } },
  })
  expect(auditMockFns.mockRecordAudit).toHaveBeenCalledOnce()
  expect(realtimeNotifyMockFns.mockNotifyWorkflowUpdated).toHaveBeenCalledOnce()
})

function referenceBatch(head = 'donnees-block', name = 'Donnees') {
  return {
    expectedRevision: 7,
    layout: 'none',
    operations: [
      {
        operation_type: 'add',
        block_id: 'donnees-block',
        params: {
          type: 'function',
          name,
          inputs: { code: 'return "PRIVATE_DATA_CODE"' },
          connections: { source: 'total-block' },
        },
      },
      {
        operation_type: 'add',
        block_id: 'total-block',
        params: {
          type: 'function',
          name: 'Total',
          inputs: { code: `return <${head}.result>` },
        },
      },
    ],
  }
}

it('gives native corrective reference heads for an evaluated batch with unresolved references', async () => {
  const input = referenceBatch()
  const before = structuredClone(input)
  const result = await createWorkflowPreviewTools(scope).dispatch(
    'preview_workflow_operations',
    input
  )
  expect(input).toEqual(before)
  expect(result).toMatchObject({
    ok: true,
    data: {
      applied: 2,
      persisted: false,
      lint: { hasUnresolvedReferences: true },
      referenceCorrection: {
        scope: 'evaluated_operations',
        targets: [
          { operationIndexes: [0], referenceHead: 'donnees' },
          { operationIndexes: [1], referenceHead: 'total' },
        ],
      },
    },
  })
  const wire = JSON.stringify(result)
  expect(wire).not.toMatch(
    /PRIVATE_|"Before"|"before"|donnees-block|total-block|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/
  )
  expect(infra.replace).not.toHaveBeenCalled()
})

it('uses the real normalized name to correct code references without rewriting inputs', async () => {
  const result = await createWorkflowPreviewTools(scope).dispatch(
    'preview_workflow_operations',
    referenceBatch('donnees')
  )
  expect(result).toMatchObject({ ok: true, data: { lint: { hasUnresolvedReferences: false } } })
  expect(result).not.toHaveProperty('data.referenceCorrection')
  expect(infra.replace).not.toHaveBeenCalled()
})

it('reports existing reference lint without blocking an otherwise valid rename', async () => {
  const stored = state()
  stored.blocks[blockId].subBlocks.code.value = 'return <missing.result>'
  infra.snapshot.mockResolvedValue({ state: stored, draftRevision: 7 })
  const result = await createWorkflowPreviewTools(scope).dispatch(
    'preview_workflow_operations',
    body()
  )
  expect(result).toMatchObject({
    ok: true,
    data: {
      applied: 1,
      persisted: false,
      lint: { hasUnresolvedReferences: true },
      referenceCorrection: { targets: [{ operationIndexes: [0], referenceHead: 'after' }] },
    },
  })
  expect(JSON.stringify(result)).not.toMatch(/missing\.result|return|PRIVATE_/)
  expect(stored.blocks[blockId].name).toBe('Before')
  expect(infra.replace).not.toHaveBeenCalled()
})

it('never includes untouched names, code, credential or arbitrary lint strings in reference correction', async () => {
  const stored = state()
  stored.blocks[blockId].name = 'PRIVATE_UNTOUCHED_NAME'
  stored.blocks[blockId].subBlocks.code.value = 'return "PRIVATE_CREDENTIAL"'
  infra.snapshot.mockResolvedValue({ state: stored, draftRevision: 7 })
  const result = await createWorkflowPreviewTools(scope).dispatch(
    'preview_workflow_operations',
    referenceBatch()
  )
  expect(result).toHaveProperty('data.referenceCorrection')
  expect(JSON.stringify(result).toLowerCase()).not.toMatch(
    /private_|credential|reason|"code":"return|"value"|"subblocks"|"outputs"/
  )
  expect(infra.replace).not.toHaveBeenCalled()
})

it('refuses an oversized corrective projection rather than truncating its targets', async () => {
  const result = await createWorkflowPreviewTools(scope).dispatch(
    'preview_workflow_operations',
    referenceBatch('donnees-block', 'n'.repeat(256 * 1024))
  )
  expect(result).toMatchObject({ ok: false, error: { code: 'result_too_large' } })
  expect(result).not.toHaveProperty('data')
  expect(infra.replace).not.toHaveBeenCalled()
})

it('publishes no reference correction when native authorization refuses', async () => {
  infra.permission.mockResolvedValue('read')
  const result = await createWorkflowPreviewTools(scope).dispatch(
    'preview_workflow_operations',
    referenceBatch()
  )
  expect(result).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  expect(result).not.toHaveProperty('data')
  expect(infra.snapshot).not.toHaveBeenCalled()
})

// As in the existing result-boundary tests, this alters only a native result
// after evaluation; it does not qualify persistence of these malformed names.
it.each(['empty', 'collision'])(
  'omits %s reference hints without asserting reference validity',
  async (kind) => {
    const stored = state()
    stored.blocks[blockId].subBlocks.code.value = 'return <missing.result>'
    infra.snapshot.mockResolvedValue({ state: stored, draftRevision: 7 })
    const { applyWorkflowOperations } = await import(
      '@/lib/workflows/application/apply-workflow-operations'
    )
    const execute = applyWorkflowOperations.execute
    const spy = vi.spyOn(applyWorkflowOperations, 'execute').mockImplementation(async (args) => {
      const result = await execute(args)
      if (kind === 'empty') result.graph.blocks[blockId].name = ' .\t'
      else
        result.graph.blocks.untouched = {
          ...result.graph.blocks[blockId],
          id: 'untouched',
          name: 'A f.t e r',
        }
      return result
    })
    try {
      const result = await createWorkflowPreviewTools(scope).dispatch(
        'preview_workflow_operations',
        body()
      )
      expect(result).toMatchObject({
        ok: true,
        data: {
          applied: 1,
          lint: { hasUnresolvedReferences: true },
          referenceCorrection: { completeness: 'best_effort', targets: [], omittedTargetCount: 1 },
        },
      })
      expect(infra.replace).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  }
)

it('does not publish a corrective name for an edit declined by the native engine', async () => {
  const stored = state()
  stored.blocks[blockId].subBlocks.code.value = 'return <missing.result>'
  const otherId = '22222222-2222-4222-8222-222222222222'
  const snapshot = {
    ...stored,
    blocks: {
      ...stored.blocks,
      [otherId]: { ...stored.blocks[blockId], id: otherId, name: 'After' },
    },
  }
  infra.snapshot.mockResolvedValue({ state: snapshot, draftRevision: 7 })
  const result = await createWorkflowPreviewTools(scope).dispatch(
    'preview_workflow_operations',
    body()
  )
  expect(result).toMatchObject({
    ok: true,
    data: { applied: 0, referenceCorrection: { targets: [] } },
  })
  expect(JSON.stringify(result).toLowerCase()).not.toMatch(/"before"|"after"/)
  expect(infra.replace).not.toHaveBeenCalled()
})

it('diagnoses the observed V5 unbound Function read without executing or publishing code', async () => {
  const code =
    'const donnees = inputs.Donnees; const total = donnees.montants.reduce((sum,val)=>sum+val,0); return {total};'
  const result = await createWorkflowPreviewTools(scope).dispatch('preview_workflow_operations', {
    ...body(),
    operations: [{ operation_type: 'edit', block_id: blockId, params: { inputs: { code } } }],
  })
  expect(result).toMatchObject({
    ok: true,
    data: {
      functionCode: {
        completeness: 'best_effort',
        targets: [
          {
            operationIndexes: [0],
            status: 'analyzed',
            diagnostics: [{ code: 'unbound_identifier', line: 1, column: 17 }],
          },
        ],
      },
    },
  })
  expect(JSON.stringify(result)).not.toMatch(/inputs|Donnees|montants|reduce|PRIVATE_GRAPH/)
  expect(infra.replace).not.toHaveBeenCalled()
})

it('keeps a legal locally declared inputs object and native references distinguishable', async () => {
  const result = await createWorkflowPreviewTools(scope).dispatch('preview_workflow_operations', {
    ...body(),
    operations: [
      {
        operation_type: 'edit',
        block_id: blockId,
        params: {
          inputs: { code: 'const inputs = {value: 2}; return inputs.value + <missing.result>' },
        },
      },
    ],
  })
  expect(result).toMatchObject({
    ok: true,
    data: {
      functionCode: {
        targets: [{ status: 'analyzed', diagnostics: [] }],
      },
      lint: { hasUnresolvedReferences: true },
    },
  })
})

it('analyzes only evaluated Function targets and never unchanged or skipped code', async () => {
  const stored = state()
  stored.blocks[blockId].subBlocks.code.value = 'return PRIVATE_UNTOUCHED_GLOBAL'
  infra.snapshot.mockResolvedValue({ state: stored, draftRevision: 7 })
  const added = await createWorkflowPreviewTools(scope).dispatch('preview_workflow_operations', {
    ...body(),
    operations: [
      {
        operation_type: 'add',
        block_id: 'new-function',
        params: { type: 'function', name: 'New', inputs: { code: 'return 1' } },
      },
    ],
  })
  expect(added).toMatchObject({
    ok: true,
    data: {
      functionCode: { targets: [{ operationIndexes: [0], status: 'analyzed', diagnostics: [] }] },
    },
  })
  expect(JSON.stringify(added)).not.toMatch(/PRIVATE_UNTOUCHED_GLOBAL|new-function|11111111/)
  const skipped = await createWorkflowPreviewTools(scope).dispatch('preview_workflow_operations', {
    ...body(),
    operations: [
      {
        operation_type: 'edit',
        block_id: '22222222-2222-4222-8222-222222222222',
        params: { name: 'Missing' },
      },
    ],
  })
  expect(skipped).toMatchObject({ ok: true, data: { functionCode: { targets: [] } } })
  expect(infra.replace).not.toHaveBeenCalled()
})

it('keeps other languages explicitly unavailable without blocking the native dry run', async () => {
  const result = await createWorkflowPreviewTools(scope).dispatch('preview_workflow_operations', {
    ...body(),
    operations: [
      {
        operation_type: 'edit',
        block_id: blockId,
        params: { inputs: { code: 'return 1', language: 'python' } },
      },
    ],
  })
  expect(result).toMatchObject({
    ok: true,
    data: { functionCode: { targets: [{ status: 'unavailable', reason: 'context' }] } },
  })
})

it('bounds the corrective target list without presenting omitted targets as analyzed', async () => {
  const result = await createWorkflowPreviewTools(scope).dispatch('preview_workflow_operations', {
    ...body(),
    operations: Array.from({ length: 17 }, (_, i) => ({
      operation_type: 'add',
      block_id: `new-function-${i}`,
      params: { type: 'function', name: `New${i}`, inputs: { code: 'return 1' } },
    })),
  })
  expect(result).toMatchObject({ ok: true, data: { functionCode: { omittedTargetCount: 1 } } })
  expect(result).toHaveProperty('data.functionCode.targets.length', 16)
  expect(JSON.stringify(result)).not.toMatch(/return 1|new-function-/)
  expect(infra.replace).not.toHaveBeenCalled()
})

it.each([
  'return require("fs").readFileSync(params.path)',
  'const file = <source.files[0].path>; return process.version',
])(
  'does not apply the fast globals contract to a filesystem/import target without sandboxId',
  async (code) => {
    const result = await createWorkflowPreviewTools(scope).dispatch('preview_workflow_operations', {
      ...body(),
      operations: [{ operation_type: 'edit', block_id: blockId, params: { inputs: { code } } }],
    })
    expect(result).toMatchObject({
      ok: true,
      data: { functionCode: { targets: [{ status: 'unavailable', reason: 'context' }] } },
    })
    expect(JSON.stringify(result)).not.toMatch(/process|require|readFileSync|source.files/)
    expect(infra.replace).not.toHaveBeenCalled()
  }
)

it('diagnoses V6 workflow params in the authorized evaluated batch without exposing values', async () => {
  const code = 'const values = params.donnees_result; return values.a+values.b+values.c;'
  const result = await createWorkflowPreviewTools(scope).dispatch('preview_workflow_operations', {
    ...body(),
    operations: [{ operation_type: 'edit', block_id: blockId, params: { inputs: { code } } }],
  })
  expect(result).toMatchObject({
    ok: true,
    data: {
      functionCode: {
        targets: [
          {
            operationIndexes: [0],
            status: 'analyzed',
            diagnostics: [{ code: 'unprovided_workflow_parameter', line: 1, column: 23 }],
          },
        ],
      },
    },
  })
  expect(JSON.stringify(result)).not.toMatch(/donnees_result|values|params|PRIVATE_GRAPH/)
  expect(infra.replace).not.toHaveBeenCalled()
})

it('completion protocol — next step requires the actual server proposal binding, never preview success alone', async () => {
  const standalone = await createWorkflowPreviewTools(scope).dispatch(
    'preview_workflow_operations',
    body()
  )
  expect(standalone).toMatchObject({ ok: true })
  expect(standalone).not.toHaveProperty('data.nextStep')
  const bound = await createWorkflowPreviewTools({ ...scope, proposalRunId: 'run-owned' }).dispatch(
    'preview_workflow_operations',
    body()
  )
  expect(bound).toHaveProperty('data.nextStep', {
    kind: 'review_diagnostics_then_propose_or_clarify',
    proposalTool: 'propose_workflow_operations',
    humanApprovalRequired: true,
  })
  expect(JSON.stringify(bound)).not.toMatch(/run-owned|PRIVATE_/)
  expect(infra.replace).not.toHaveBeenCalled()
})

it('completion protocol — next step never promotes unresolved diagnostics to valid code', async () => {
  const result = await createWorkflowPreviewTools({
    ...scope,
    proposalRunId: 'run-owned',
  }).dispatch('preview_workflow_operations', {
    ...body(),
    operations: [
      {
        operation_type: 'edit',
        block_id: blockId,
        params: { inputs: { code: 'return inputs.Donnees' } },
      },
    ],
  })
  expect(result).toMatchObject({
    ok: true,
    data: {
      nextStep: { kind: 'review_diagnostics_then_propose_or_clarify' },
      functionCode: { completeness: 'best_effort' },
    },
  })
  expect(JSON.stringify(result)).toContain('unbound_identifier')
  expect(result).not.toHaveProperty('data.valid')
  expect(JSON.stringify(result)).not.toMatch(/return inputs|PRIVATE_/)
  expect(infra.replace).not.toHaveBeenCalled()
})

it('refuses a string trigger mode before evaluating the native preview engine', async () => {
  const rowsBefore = structuredClone([...infra.rows.entries()])
  const result = await createWorkflowPreviewTools(scope).dispatch('preview_workflow_operations', {
    expectedRevision: 7,
    layout: 'targeted',
    operations: [
      {
        operation_type: 'add',
        block_id: 'start',
        params: { type: 'start_trigger', name: 'Départ', triggerMode: 'manual' },
      },
    ],
  })
  expect(result).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
  expect(infra.snapshot).not.toHaveBeenCalled()
  expect(infra.replace).not.toHaveBeenCalled()
  expect([...infra.rows.entries()]).toStrictEqual(rowsBefore)
})
