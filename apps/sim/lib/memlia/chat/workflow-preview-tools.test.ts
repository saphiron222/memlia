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

import { createWorkflowPreviewTools } from './workflow-preview-tools'

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
    workflow: { id: scope.workflowId, name: 'PRIVATE_NAME_CANARY', workspaceId: scope.workspaceId },
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
