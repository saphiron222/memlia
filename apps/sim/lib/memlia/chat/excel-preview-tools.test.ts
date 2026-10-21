// Copyright (c) 2026 Memlia. All rights reserved.
// Native use-case authorization and capability assertion; only lookup/DB boundaries doubled.
import { createSessionPrincipal } from '@sim/testing/factories/principal.factory'
import {
  workflowContextMock,
  workflowContextMockFns,
} from '@sim/testing/mocks/workflow-context.mock'
import { workspaceAuthzMock, workspaceAuthzMockFns } from '@sim/testing/mocks/workspace-authz.mock'
import { beforeEach, expect, it, vi } from 'vitest'
import { fixtures } from '../../../../../packages/memlia-contracts/tests/fixtures'
const infra = vi.hoisted(() => ({ config: vi.fn() }))
vi.mock('@/lib/workflows/application/context', () => workflowContextMock)
vi.mock('@sim/platform-authz/workspace', () => workspaceAuthzMock)
vi.mock('@/lib/permission-groups/config-scope.server', () => ({
  resolvePermissionGroupConfig: infra.config,
}))
import { createExcelPreviewTools } from './excel-preview-tools'
const scope = () => ({
  principal: createSessionPrincipal({ userId: 'excel-reader' }),
  workspaceId: 'workspace-1',
  workflowId: 'workflow-1',
})
function draft() {
  const {
    schemaVersion,
    organizationId,
    workspaceId,
    procedureId,
    version,
    parentVersion,
    workflowId,
    deployedVersionId,
    ownerUserId,
    digest,
    policyVersion,
    ...value
  } = structuredClone(fixtures.ExcelProcedure)
  value.decimalPolicy.precision = 18
  return value
}
const resolve = workflowContextMockFns.mockResolveActiveWorkflowApplicationContext
const permission = workspaceAuthzMockFns.mockResolveEffectiveWorkspacePermission
beforeEach(() => {
  resolve.mockReset().mockResolvedValue({
    workflowId: 'workflow-1',
    workflow: { id: 'workflow-1', workspaceId: 'workspace-1' },
    workspaceId: 'workspace-1',
    workspaceOrganizationId: null,
    allowPersonalApiKeys: true,
    billedAccountUserId: 'not-authority',
  })
  permission.mockReset().mockResolvedValue('read')
  infra.config.mockReset().mockResolvedValue(null)
})
it('describes primitive options without runtime, publication or file authority', async () => {
  const result = await createExcelPreviewTools(scope()).dispatch('excel_describe_capabilities', {})
  expect(result).toMatchObject({
    ok: true,
    data: {
      analysis: 'declarative_draft',
      executionAvailable: false,
      persisted: false,
      profile: {
        id: 'memlia.excel-kernel-primitives/p00-v1',
        xlsx: { formulas: false, csv: false },
      },
    },
  })
  expect(permission).toHaveBeenCalledWith(
    'excel-reader',
    'workspace-1',
    null,
    undefined,
    expect.anything()
  )
})
it('analyzes the real ordered IR with fixed indexed diagnostics and no echoed values', async () => {
  const value = draft()
  const result = await createExcelPreviewTools(scope()).dispatch('excel_preview_procedure', {
    request: value,
  })
  expect(result).toMatchObject({
    ok: true,
    data: {
      analysis: 'declarative_draft',
      executionAvailable: false,
      persisted: false,
      capabilities: { schemaValid: true, primitiveOptionsCompatible: true },
      dataflow: { schemaValid: true, declaredDataflowValid: true, diagnostics: [] },
    },
  })
  expect(JSON.stringify(result)).not.toContain('bindingId')
  expect(JSON.stringify(result)).not.toContain('ownerUserId')
})
it('keeps dataflow refusal as analysis rather than a successful calculation', async () => {
  const value = draft()
  value.operations[0].input = 'future'
  expect(
    await createExcelPreviewTools(scope()).dispatch('excel_preview_procedure', { request: value })
  ).toMatchObject({
    ok: true,
    data: {
      executionAvailable: false,
      dataflow: {
        declaredDataflowValid: false,
        diagnostics: [
          { code: 'table_missing', operationIndex: 0 },
          { code: 'table_missing', writeIndex: 0 },
          { code: 'table_missing', controlIndex: 0 },
        ],
      },
    },
  })
})
it.each(['workspaceId', 'ownerUserId', 'digest', 'deployedVersionId'])(
  'refuses injected identity %s before authorization',
  async (key) => {
    const result = await createExcelPreviewTools(scope()).dispatch('excel_preview_procedure', {
      request: { ...draft(), [key]: 'PRIVATE_CANARY' },
    })
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    expect(JSON.stringify(result)).not.toContain('PRIVATE_CANARY')
    expect(resolve).not.toHaveBeenCalled()
  }
)
it('refuses unknown tools without registry fallback', async () => {
  expect(await createExcelPreviewTools(scope()).dispatch('excel_request_run', {})).toMatchObject({
    ok: false,
    error: { code: 'tool_not_allowed' },
  })
  expect(resolve).not.toHaveBeenCalled()
})
it.each(['workspace-foreign', 'workflow-foreign'])(
  'refuses canonical foreign context %s',
  async (foreign) => {
    resolve.mockResolvedValue({
      workflowId: foreign.startsWith('workflow') ? foreign : 'workflow-1',
      workflow: { id: 'workflow-1' },
      workspaceId: foreign.startsWith('workspace') ? foreign : 'workspace-1',
      workspaceOrganizationId: null,
      allowPersonalApiKeys: true,
      billedAccountUserId: 'not-authority',
    })
    expect(
      await createExcelPreviewTools(scope()).dispatch('excel_describe_capabilities', {})
    ).toMatchObject({ ok: false })
  }
)
it('rechecks workflow membership on every call', async () => {
  const tools = createExcelPreviewTools(scope())
  expect(await tools.dispatch('excel_describe_capabilities', {})).toMatchObject({ ok: true })
  permission.mockResolvedValue(null)
  expect(await tools.dispatch('excel_describe_capabilities', {})).toMatchObject({ ok: false })
})
it('closes native lookup errors without exposing causes', async () => {
  resolve.mockRejectedValue(new Error('PRIVATE_DB_CANARY'))
  const result = await createExcelPreviewTools(scope()).dispatch('excel_preview_procedure', {
    request: draft(),
  })
  expect(result).toMatchObject({ ok: false })
  expect(JSON.stringify(result)).not.toContain('PRIVATE_DB_CANARY')
})
it('owns context and draft before any authority await', async () => {
  let release!: (v: null) => void
  infra.config.mockImplementationOnce(
    () =>
      new Promise((r) => {
        release = r
      })
  )
  const context = scope()
  const value = draft()
  const tools = createExcelPreviewTools(context)
  const running = tools.dispatch('excel_preview_procedure', { request: value })
  context.workspaceId = 'foreign'
  context.principal.userId = 'foreign'
  value.operations[0].input = 'future'
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  release(null)
  expect(await running).toMatchObject({
    ok: true,
    data: { dataflow: { declaredDataflowValid: true } },
  })
  expect(resolve).toHaveBeenCalledWith({
    workflowId: 'workflow-1',
    assertedWorkspaceId: 'workspace-1',
  })
})
it('refuses cancelled delivery even when the native authorization ignores cancellation', async () => {
  const abort = new AbortController()
  infra.config.mockImplementationOnce(async () => {
    abort.abort()
    return null
  })
  expect(
    await createExcelPreviewTools(scope()).dispatch('excel_describe_capabilities', {}, abort.signal)
  ).toMatchObject({ ok: false, error: { code: 'cancelled' } })
})

it('rechecks copilot.use with an explicit native executor after a prior allowed call', async () => {
  const tools = createExcelPreviewTools(scope())
  expect(await tools.dispatch('excel_describe_capabilities', {})).toMatchObject({ ok: true })
  infra.config.mockResolvedValue({ hideCopilot: true })
  const result = await tools.dispatch('excel_describe_capabilities', {})
  expect(result).toMatchObject({ ok: false })
  expect(
    infra.config.mock.calls.some(
      (args) => args[0] === 'excel-reader' && args[1] === 'workspace-1' && args[3] !== undefined
    )
  ).toBe(true)
})
it('does not invoke input accessors, and refuses extra wrapper fields', async () => {
  let reads = 0
  const params = Object.defineProperty({}, 'request', {
    enumerable: true,
    get() {
      reads++
      return draft()
    },
  })
  const tools = createExcelPreviewTools(scope())
  expect(await tools.dispatch('excel_preview_procedure', params)).toMatchObject({
    ok: false,
    error: { code: 'invalid_input' },
  })
  expect(
    await tools.dispatch('excel_preview_procedure', { request: draft(), approve: true })
  ).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
  expect(reads).toBe(0)
  expect(resolve).not.toHaveBeenCalled()
})
it('never echoes an untrusted column name through diagnostics or errors', async () => {
  const value = draft()
  value.operations[0] = {
    op: 'select',
    input: 'source',
    output: 'selected',
    columns: ['PRIVATE_COLUMN_CANARY'],
  }
  const result = await createExcelPreviewTools(scope()).dispatch('excel_preview_procedure', {
    request: value,
  })
  expect(result).toMatchObject({ ok: true, data: { dataflow: { declaredDataflowValid: false } } })
  expect(JSON.stringify(result)).not.toContain('PRIVATE_COLUMN_CANARY')
})
it('owns the returned profile so client mutation cannot change a later observation', async () => {
  const tools = createExcelPreviewTools(scope())
  const result = await tools.dispatch('excel_describe_capabilities', {})
  if (!result.ok || !('profile' in result.data) || !result.data.profile)
    throw new Error('fixture refused')
  result.data.profile.xlsx.formulas = true as never
  expect(await tools.dispatch('excel_describe_capabilities', {})).toMatchObject({
    ok: true,
    data: { profile: { xlsx: { formulas: false } } },
  })
})
it('rejects non-session authority and getters without invoking them', () => {
  expect(() =>
    createExcelPreviewTools({ ...scope(), principal: { kind: 'workspace_api_key' } as never })
  ).toThrow('Excel analysis is unavailable.')
  let reads = 0
  const value = Object.defineProperty(scope(), 'principal', {
    enumerable: true,
    get() {
      reads++
      throw new Error('PRIVATE_GETTER')
    },
  })
  expect(() => createExcelPreviewTools(value)).toThrow('Excel analysis is unavailable.')
  expect(reads).toBe(0)
})
it('refuses an already aborted invocation before any authority lookup', async () => {
  const abort = new AbortController()
  abort.abort()
  expect(
    await createExcelPreviewTools(scope()).dispatch('excel_describe_capabilities', {}, abort.signal)
  ).toMatchObject({ ok: false, error: { code: 'cancelled' } })
  expect(resolve).not.toHaveBeenCalled()
})
