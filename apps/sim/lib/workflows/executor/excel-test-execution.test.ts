// Copyright (c) 2026 Memlia. All rights reserved.
// Native application/authorization/service/payload/worker composition. DB, quota,
// queue acceptance and final core effects are doubles, not a durable Linux run.
import {
  createSessionPrincipal,
  createPersonalApiKeyPrincipal,
} from '@sim/testing/factories/principal.factory'
import {
  workflowContextMock,
  workflowContextMockFns,
} from '@sim/testing/mocks/workflow-context.mock'
import { workspaceAuthzMock, workspaceAuthzMockFns } from '@sim/testing/mocks/workspace-authz.mock'
import { loggingSessionMock } from '@sim/testing/mocks/logging-session.mock'
import { beforeEach, expect, it, vi } from 'vitest'
const b = vi.hoisted(() => ({
  read: vi.fn(),
  verify: vi.fn(),
  config: vi.fn(),
  preprocess: vi.fn(),
  enqueue: vi.fn(),
  claim: vi.fn(),
  release: vi.fn(),
  core: vi.fn(),
  load: vi.fn(),
  route: vi.fn(),
  env: { MEMLIA_DURABLE_WORKFLOWS_ENABLED: '1' },
}))
vi.mock('@sim/platform-authz/workspace', () => workspaceAuthzMock)
vi.mock('@/lib/core/network/config.server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/core/network/config.server')>()),
  isOutboundRoutingEnabled: () => true,
  resolveOutboundRoute: b.route,
}))
vi.mock('@/lib/workflows/application/context', () => workflowContextMock)
vi.mock('@/lib/permission-groups/config-scope.server', () => ({
  resolvePermissionGroupConfig: b.config,
}))
vi.mock('@/lib/workflows/persistence/excel-test-snapshots', () => ({
  readExcelTestPreparationObservation: b.read,
  verifyExcelTestSnapshot: b.verify,
}))
vi.mock('@/lib/core/config/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/core/config/env')>()),
  env: b.env,
}))
vi.mock('@/lib/execution/preprocessing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/execution/preprocessing')>()),
  preprocessExecution: b.preprocess,
}))
vi.mock('@/lib/workflows/executor/enqueue-execution', () => ({
  enqueueWorkflowExecution: b.enqueue,
}))
vi.mock('@/lib/workflows/executor/execution-id-claim', () => ({
  claimExecutionId: b.claim,
  hasDurableExecutionOwner: vi.fn(async () => true),
  releaseExecutionIdClaim: b.release,
}))
vi.mock('@/lib/logs/execution/logging-session', () => loggingSessionMock)
vi.mock('@/lib/workflows/executor/execution-core', () => ({
  executeWorkflowCore: b.core,
  wasExecutionFinalizedByCore: vi.fn(() => false),
}))
vi.mock('@/lib/workflows/executor/pause-persistence', () => ({
  handlePostExecutionPauseState: vi.fn(),
}))
vi.mock('@/lib/workflows/persistence/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workflows/persistence/utils')>()),
  loadWorkflowDeploymentVersionState: b.load,
}))
vi.mock('@/lib/billing/calculations/usage-reservation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/billing/calculations/usage-reservation')>()),
  refreshExecutionSlotExpiry: vi.fn(async () => true),
  releaseExecutionSlot: vi.fn(),
}))
import { resolveCurrentOutboundRoute } from '@/lib/core/network/context.server'
import { runExcelTest } from '@/lib/workflows/application/run-excel-test'
import { executeWorkflowService } from './execute-service'
import { authorizeExcelTestExecution, readExcelTestExecutionPermit } from './excel-test-admission'
import { prepareWorkflowExecutionPayload } from './workflow-execution-payload'
import { executeWorkflowJob, type WorkflowExecutionPayload } from '@/background/workflow-execution'
const digest = `sha256:${'a'.repeat(64)}`
const prepared = {
  status: 'prepared_for_test' as const,
  workflowId: 'workflow',
  deploymentVersionId: 'inactive-version',
  version: 2,
  snapshotDigest: digest,
  executionAvailable: false as const,
  activationAvailable: false as const,
}
const preparation = {
  expectedRevision: 7,
  expectedStateDigest: digest,
  operationId: 'prepared-operation',
}
const binding = () => ({
  workspaceId: 'space',
  preparation: { ...preparation },
  prepared: { ...prepared },
})
const principal = () => createSessionPrincipal({ userId: 'subject', sessionId: 'session' })
const input = () => ({
  workflowId: 'workflow',
  requestId: 'request',
  body: { ...binding(), executionId: 'stable-id', acknowledgeEffects: true },
})
let queued: WorkflowExecutionPayload | undefined
const billing = {
  actorUserId: 'subject',
  workspaceId: 'space',
  organizationId: null,
  billedAccountUserId: 'billing',
  billingEntity: { type: 'user', id: 'billing' },
  billingPeriod: { start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z' },
  payerSubscription: null,
}
beforeEach(() => {
  vi.clearAllMocks()
  queued = undefined
  b.env.MEMLIA_DURABLE_WORKFLOWS_ENABLED = '1'
  workflowContextMockFns.mockResolveActiveWorkflowApplicationContext.mockResolvedValue({
    workflowId: 'workflow',
    workflow: { id: 'workflow', workspaceId: 'space' },
    workspaceId: 'space',
    workspaceOrganizationId: null,
    allowPersonalApiKeys: true,
    billedAccountUserId: 'billing',
  })
  workspaceAuthzMockFns.mockResolveEffectiveWorkspacePermission.mockResolvedValue('write')
  b.config.mockResolvedValue(null)
  b.read.mockResolvedValue({ ...preparation, blockTypes: ['memlia_excel'] })
  b.verify.mockResolvedValue(prepared)
  b.claim.mockResolvedValue({ executionId: 'stable-id' })
  b.preprocess.mockResolvedValue({
    success: true,
    actorUserId: 'subject',
    workflowRecord: {
      id: 'workflow',
      workspaceId: 'space',
      userId: 'different-owner',
      variables: { wrong: 9 },
    },
    billingAttribution: billing,
    executionTimeout: { async: 10000 },
  })
  b.enqueue.mockImplementation(async (params) => {
    resolveCurrentOutboundRoute()
    queued = prepareWorkflowExecutionPayload(params).payload
    return {
      outcome: 'queued',
      jobId: 'job',
      executionId: params.executionId,
      retainExecutionClaim: true,
    }
  })
  b.core.mockResolvedValue({ status: 'completed', success: true, output: {}, metadata: {} })
  b.load.mockResolvedValue({
    blocks: {},
    edges: [],
    loops: {},
    parallels: {},
    variables: { pinned: 1 },
    deploymentVersionId: prepared.deploymentVersionId,
  })
})
it('inactive test retains the pin through the native service/payload/worker and reauthorizes the human', async () => {
  const result = await runExcelTest.execute({ principal: principal(), input: input() })
  expect(result).toEqual({
    status: 'queued',
    executionId: 'stable-id',
    workflowId: 'workflow',
    deploymentVersionId: 'inactive-version',
    snapshotDigest: digest,
  })
  expect(b.preprocess).toHaveBeenCalledWith(
    expect.objectContaining({
      checkDeployment: false,
      useAuthenticatedUserAsActor: true,
      executionType: 'async',
    })
  )
  expect(b.enqueue).toHaveBeenCalledOnce()
  expect(b.route).toHaveBeenCalledExactlyOnceWith(null) // verified personal workspace, never absent outbound scope
  expect(queued).toMatchObject({
    excelTestExecution: binding(),
    userId: 'subject',
    enforceCredentialAccess: true,
    isPublicApiAccess: false,
    admissionCompleted: true,
    executionMode: 'async',
  })
  expect(b.core).not.toHaveBeenCalled() // browser admission does not execute the graph
  const outcome = await executeWorkflowJob(queued!)
  expect(outcome).toMatchObject({ success: true, executionId: 'stable-id' })
  expect(b.preprocess).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({
      useAuthenticatedUserAsActor: true,
    })
  )
  expect(b.verify).toHaveBeenCalledTimes(2)
  expect(b.load).toHaveBeenCalledExactlyOnceWith('workflow', 'inactive-version', 'space')
  expect(b.core).toHaveBeenCalledWith(
    expect.objectContaining({
      snapshot: expect.objectContaining({
        metadata: expect.objectContaining({
          useDraftState: false,
          enforceCredentialAccess: true,
          workflowStateOverride: expect.objectContaining({
            deploymentVersionId: 'inactive-version',
          }),
        }),
        workflowVariables: { pinned: 1 },
      }),
    })
  )
})
it('foreign principal, lost write, stale graph and withheld block never enqueue', async () => {
  await expect(
    runExcelTest.execute({ principal: createPersonalApiKeyPrincipal(), input: input() })
  ).rejects.toMatchObject({ code: 'forbidden' })
  workspaceAuthzMockFns.mockResolveEffectiveWorkspacePermission.mockResolvedValueOnce('read')
  await expect(
    runExcelTest.execute({ principal: principal(), input: input() })
  ).rejects.toMatchObject({ code: 'forbidden' })
  b.read.mockResolvedValueOnce({
    ...preparation,
    expectedRevision: 8,
    blockTypes: ['memlia_excel'],
  })
  await expect(
    runExcelTest.execute({ principal: principal(), input: input() })
  ).rejects.toMatchObject({ code: 'conflict' })
  b.config.mockResolvedValueOnce({ allowedIntegrations: [] })
  await expect(
    runExcelTest.execute({ principal: principal(), input: input() })
  ).rejects.toMatchObject({ code: 'forbidden' })
  b.verify.mockRejectedValueOnce(new Error('private SQL'))
  await expect(
    runExcelTest.execute({ principal: principal(), input: input() })
  ).rejects.toMatchObject({ message: 'excel_test_execution_refused' })
  expect(b.enqueue).not.toHaveBeenCalled()
  expect(b.claim).not.toHaveBeenCalled()
})
it('structural permit and another account/session cannot authorize the inactive deployment', async () => {
  const permit = await authorizeExcelTestExecution({
    principal: principal(),
    input: { workflowId: 'workflow', assertedWorkspaceId: 'space', binding: binding() },
  })
  expect(() =>
    readExcelTestExecutionPermit(
      { kind: 'excel_test_execution_permit' },
      { principal: principal(), workflowId: 'workflow', userId: 'subject' }
    )
  ).toThrow('excel_test_execution_refused')
  for (const p of [
    createSessionPrincipal({ userId: 'other', sessionId: 'session' }),
    createSessionPrincipal({ userId: 'subject', sessionId: 'other-session' }),
  ])
    expect(() =>
      readExcelTestExecutionPermit(permit, {
        principal: p,
        workflowId: 'workflow',
        userId: p.userId,
      })
    ).toThrow('excel_test_execution_refused')
  const copy = readExcelTestExecutionPermit(permit, {
    principal: principal(),
    workflowId: 'workflow',
    userId: 'subject',
  })
  copy.prepared.deploymentVersionId = 'forged'
  expect(
    readExcelTestExecutionPermit(permit, {
      principal: principal(),
      workflowId: 'workflow',
      userId: 'subject',
    }).prepared.deploymentVersionId
  ).toBe('inactive-version')
  const refused = await executeWorkflowService({
    workflowId: 'workflow',
    principal: principal(),
    userId: 'subject',
    requestId: 'request',
    input: {},
    triggerType: 'manual',
    excelTestExecutionPermit: permit,
    deploymentVersionId: 'forged',
    useAuthenticatedUserAsActor: true,
    isPublicApiAccess: false,
    mode: 'async',
  })
  expect(refused).toMatchObject({ ok: false })
  expect(b.claim).not.toHaveBeenCalled()
})
it('unknown queue retains stable identity, never retries; a reused native claim conflicts', async () => {
  b.enqueue.mockResolvedValueOnce({
    outcome: 'ambiguous',
    executionId: 'stable-id',
    retainExecutionClaim: true,
  })
  await expect(
    runExcelTest.execute({ principal: principal(), input: input() })
  ).rejects.toMatchObject({ message: 'excel_test_execution_unconfirmed' })
  expect(b.enqueue).toHaveBeenCalledOnce()
  expect(b.release).not.toHaveBeenCalled()
  b.claim.mockResolvedValueOnce(null)
  await expect(
    runExcelTest.execute({ principal: principal(), input: input() })
  ).rejects.toMatchObject({ code: 'conflict' })
  expect(b.enqueue).toHaveBeenCalledOnce()
})
it.each(['workspace', 'actor'])(
  'preprocessing cannot change the admitted test %s before enqueue',
  async (kind) => {
    const result = await b.preprocess.getMockImplementation()!()
    if (kind === 'workspace') result.workflowRecord.workspaceId = 'foreign'
    else result.actorUserId = 'foreign'
    b.preprocess.mockResolvedValueOnce(result)
    await expect(
      runExcelTest.execute({ principal: principal(), input: input() })
    ).rejects.toMatchObject({ statusCode: 503 })
    expect(b.enqueue).not.toHaveBeenCalled()
  }
)
it('queued work rechecks changed permissions before any graph or secret effects', async () => {
  await runExcelTest.execute({ principal: principal(), input: input() })
  workspaceAuthzMockFns.mockResolveEffectiveWorkspacePermission.mockResolvedValueOnce('read')
  await expect(executeWorkflowJob(queued!)).rejects.toMatchObject({ code: 'forbidden' })
  expect(b.preprocess).toHaveBeenCalledOnce()
  expect(b.load).not.toHaveBeenCalled()
  expect(b.core).not.toHaveBeenCalled()
})
it.each(['workspace', 'actor'])(
  'worker preprocessing cannot change the test %s before loading the graph',
  async (kind) => {
    await runExcelTest.execute({ principal: principal(), input: input() })
    const result = await b.preprocess.getMockImplementation()!()
    if (kind === 'workspace') result.workflowRecord.workspaceId = 'foreign'
    else result.actorUserId = 'foreign'
    b.preprocess.mockResolvedValueOnce(result)
    await expect(executeWorkflowJob(queued!)).rejects.toThrow('Excel test execution refused')
    expect(b.load).not.toHaveBeenCalled()
    expect(b.core).not.toHaveBeenCalled()
  }
)
it('without the durable queue or explicit effect consent no test starts', async () => {
  b.env.MEMLIA_DURABLE_WORKFLOWS_ENABLED = '0'
  await expect(
    runExcelTest.execute({ principal: principal(), input: input() })
  ).rejects.toMatchObject({ statusCode: 503 })
  b.env.MEMLIA_DURABLE_WORKFLOWS_ENABLED = '1'
  const value = input()
  value.body.acknowledgeEffects = false
  await expect(runExcelTest.execute({ principal: principal(), input: value })).rejects.toThrow()
  expect(b.enqueue).not.toHaveBeenCalled()
  expect(b.claim).not.toHaveBeenCalled()
})
