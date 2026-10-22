// Copyright 2026 Memlia. All rights reserved.

import { authMock, authMockFns } from '@sim/testing/mocks/auth.mock'
import { resetEnvFlagsMock, setEnvFlags } from '@sim/testing/mocks/env-flags.mock'
import {
  permissionGroupScopeMock,
  permissionGroupScopeMockFns,
} from '@sim/testing/mocks/permission-group-scope.mock'
import { rateLimiterMock, rateLimiterMockFns } from '@sim/testing/mocks/rate-limiter.mock'
import { workspaceAuthzMock, workspaceAuthzMockFns } from '@sim/testing/mocks/workspace-authz.mock'
import {
  workspaceContextMock,
  workspaceContextMockFns,
} from '@sim/testing/mocks/workspace-context.mock'
import { NextRequest, NextResponse } from 'next/server'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const infra = vi.hoisted(() => ({
  policy: vi.fn(),
  workflow: vi.fn(),
  modelConfig: vi.fn(),
  key: vi.fn(),
  window: vi.fn(),
  transcript: vi.fn(),
}))
vi.mock('@/lib/auth', () => authMock)
vi.mock('@sim/platform-authz/workspace', () => workspaceAuthzMock)
vi.mock('@/lib/workspaces/application/context', () => workspaceContextMock)
vi.mock('@/lib/core/rate-limiter', () => rateLimiterMock)
vi.mock('@/lib/permission-groups/config-scope.server', () => permissionGroupScopeMock)
vi.mock('@/lib/permission-groups/resolve.server', async (original) => ({
  ...(await original<typeof import('@/lib/permission-groups/resolve.server')>()),
  getUserPermissionConfig: infra.modelConfig,
}))
vi.mock('@/lib/workflows/utils', () => ({ resolveWorkflowIdForUser: infra.workflow }))
vi.mock('@/lib/memlia/ai/chat-policy-source.server', () => ({
  readChatInstallationPolicyFile: infra.policy,
}))
vi.mock('@/lib/core/config/api-keys', () => ({ getRotatingApiKey: infra.key }))
vi.mock('@/lib/memlia/ai/chat-budget-window.server', () => ({ readChatBudgetWindow: infra.window }))
vi.mock('@/lib/memlia/chat/authorized-transcript.server', () => ({
  loadAuthorizedChatTranscript: infra.transcript,
}))

import { parseChatInstallationPolicy } from '@/lib/memlia/ai/chat-policy.server'
import { readLocalChatCapabilities } from '@/lib/memlia/chat/local-capabilities.server'
import { DEFAULT_PERMISSION_GROUP_CONFIG } from '@/lib/permission-groups/fields'
import { localCapabilitiesResponse } from './contracts'
import { GET } from './route'

const config = () => ({
  enabled: true,
  provider: 'openai',
  model: 'gpt-5.4',
  destination: 'official',
  data: { conversation: true, catalogue: true, workflow: 'sanitized_details' },
  localBackend: {
    kind: 'memlia_local_chat',
    version: 1,
    budgetWindow: { id: 'PRIVATE_WINDOW', version: 7 },
  },
})
const query = '?workspaceId=workspace-1&workflowId=workflow-1'
function request(q = query, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost/api/copilot/capabilities${q}`, { headers })
}
const expected = {
  version: 1,
  backend: 'local',
  provider: 'openai',
  model: 'gpt-5.4',
  workspaceId: 'workspace-1',
  workflowId: 'workflow-1',
  modes: ['agent'],
  requiresExistingWorkflow: true,
  requestSupported: true,
  currentWorkflowReference: 'implicit',
  modelSelection: false,
  effort: false,
  attachments: false,
  otherResources: false,
  contexts: false,
  desktop: false,
}
beforeEach(() => {
  setEnvFlags({ isCopilotToolPermissionsEnabled: true })
  vi.clearAllMocks()
  vi.stubEnv('MEMLIA_CHAT_POLICY_FILE', '/fixture/policy.json')
  authMockFns.mockGetSession.mockResolvedValue({
    user: { id: 'user-1' },
    session: { id: 'session-1' },
  })
  rateLimiterMockFns.mockEnforceUserRateLimit.mockResolvedValue(null)
  workspaceAuthzMockFns.mockResolveEffectiveWorkspacePermission.mockResolvedValue('read')
  workspaceContextMockFns.mockResolveActiveWorkspaceApplicationContext.mockResolvedValue({
    workspaceId: 'workspace-1',
    workspaceOrganizationId: 'org-1',
    allowPersonalApiKeys: true,
    billedAccountUserId: 'payer-not-actor',
  })
  permissionGroupScopeMockFns.mockResolvePermissionGroupConfig.mockResolvedValue(null)
  infra.modelConfig.mockResolvedValue(null)
  infra.policy.mockImplementation(() => ({
    kind: 'installation_file_observation',
    policy: parseChatInstallationPolicy(config()),
  }))
  infra.workflow.mockResolvedValue({
    status: 'resolved',
    workflowId: 'workflow-1',
    workspaceId: 'workspace-1',
  })
})
afterEach(() => {
  expect(infra.key).not.toHaveBeenCalled()
  expect(infra.window).not.toHaveBeenCalled()
  expect(infra.transcript).not.toHaveBeenCalled()
  vi.unstubAllEnvs()
})
it('projects only the authorized non-secret profile with no-store and native rate-limit', async () => {
  const response = await GET(request())
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual(expected)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(rateLimiterMockFns.mockEnforceUserRateLimit).toHaveBeenCalledWith(
    'chat.local-capabilities',
    'user-1',
    undefined
  )
  expect(infra.modelConfig).toHaveBeenCalledWith('user-1', 'workspace-1', undefined)
})
it('requires session before policy and authorization', async () => {
  authMockFns.mockGetSession.mockResolvedValue(null)
  expect((await GET(request(query, { 'x-user-id': 'other', 'x-api-key': 'fixture' }))).status).toBe(
    401
  )
  expect(infra.policy).not.toHaveBeenCalled()
  expect(infra.workflow).not.toHaveBeenCalled()
})
it('refuses revoked workspace access before policy disclosure', async () => {
  workspaceAuthzMockFns.mockResolveEffectiveWorkspacePermission.mockResolvedValue(null)
  expect((await GET(request())).status).toBe(403)
  expect(infra.policy).not.toHaveBeenCalled()
})
it('refuses copilot.use through the native assertion before policy', async () => {
  permissionGroupScopeMockFns.mockResolvePermissionGroupConfig.mockResolvedValue({
    ...DEFAULT_PERMISSION_GROUP_CONFIG,
    hideCopilot: true,
  })
  expect((await GET(request())).status).toBe(403)
  expect(infra.policy).not.toHaveBeenCalled()
})
it.each([{ deniedModels: ['gpt-5.4'] }, { allowedModelProviders: ['anthropic'] }])(
  'conceals a denied model/provider %j',
  async (restriction) => {
    infra.modelConfig.mockResolvedValue({ ...DEFAULT_PERMISSION_GROUP_CONFIG, ...restriction })
    const response = await GET(request())
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'Local Chat profile is unavailable.' })
  }
)
it.each([
  { status: 'not_found' },
  { status: 'resolved', workflowId: 'workflow-1', workspaceId: 'foreign' },
  { status: 'resolved', workflowId: 'foreign', workspaceId: 'workspace-1' },
])('refuses noncanonical workflow %j', async (resolved) => {
  infra.workflow.mockResolvedValue(resolved)
  expect((await GET(request())).status).toBe(403)
  expect(infra.policy).not.toHaveBeenCalled()
})
it('refuses mismatched canonical workspace', async () => {
  workspaceContextMockFns.mockResolveActiveWorkspaceApplicationContext.mockResolvedValue({
    workspaceId: 'foreign',
    workspaceOrganizationId: null,
    allowPersonalApiKeys: true,
    billedAccountUserId: 'payer',
  })
  expect((await GET(request())).status).toBe(403)
  expect(infra.policy).not.toHaveBeenCalled()
})
it('absence alone preserves the legacy observation after native permission checks', async () => {
  vi.stubEnv('MEMLIA_CHAT_POLICY_FILE', undefined)
  const response = await GET(request())
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ version: 1, backend: 'legacy' })
  expect(infra.policy).not.toHaveBeenCalled()
})
it.each(['', 'bad'])(
  'present but refused configuration is unavailable, never legacy: %s',
  async (value) => {
    vi.stubEnv('MEMLIA_CHAT_POLICY_FILE', value)
    infra.policy.mockImplementation(() => {
      throw new Error('PRIVATE_WINDOW /fixture/policy.json')
    })
    const response = await GET(request())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      version: 1,
      backend: 'unavailable',
      code: 'local_profile_unavailable',
    })
  }
)
it.each(['summary_only', 'catalogue_only'])(
  'refuses unsupported workflow profile %s',
  async (workflow) => {
    infra.policy.mockImplementation(() => ({
      policy: parseChatInstallationPolicy({ ...config(), data: { ...config().data, workflow } }),
    }))
    expect(await (await GET(request())).json()).toEqual({
      version: 1,
      backend: 'unavailable',
      code: 'local_profile_unavailable',
    })
  }
)
it('reports existing workflow prerequisite without inventing a Home workflow', async () => {
  const response = await GET(request('?workspaceId=workspace-1'))
  expect(response.status).toBe(200)
  const { workflowId: _, ...home } = expected
  expect(await response.json()).toEqual({
    ...home,
    requestSupported: false,
    currentWorkflowReference: 'unavailable',
  })
  expect(infra.workflow).not.toHaveBeenCalled()
})
it.each([
  '',
  '?workspaceId=workspace-1&unexpected=secret',
  '?workspaceId=workspace-1&workflowId=',
  '?workspaceId=workspace-1&workspaceId=other',
])('refuses malformed/duplicate query %s', async (q) => {
  expect((await GET(request(q))).status).toBe(400)
  expect(infra.policy).not.toHaveBeenCalled()
})
it('retains native rate-limit refusal without observing configuration', async () => {
  rateLimiterMockFns.mockEnforceUserRateLimit.mockResolvedValue(
    NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })
  )
  expect((await GET(request())).status).toBe(429)
  expect(infra.policy).not.toHaveBeenCalled()
})
it('owns principal, query and backend presence before awaits', async () => {
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  workspaceContextMockFns.mockResolveActiveWorkspaceApplicationContext.mockImplementation(
    async () => {
      await pending
      return {
        workspaceId: 'workspace-1',
        workspaceOrganizationId: null,
        allowPersonalApiKeys: true,
        billedAccountUserId: 'payer',
      }
    }
  )
  const args = {
    principal: { kind: 'session' as const, userId: 'user-1', sessionId: 'session-1' },
    input: { workspaceId: 'workspace-1', workflowId: 'workflow-1' },
  }
  const result = readLocalChatCapabilities.execute(args)
  args.principal.userId = 'foreign'
  args.input.workflowId = 'foreign'
  args.input.workspaceId = 'foreign'
  vi.stubEnv('MEMLIA_CHAT_POLICY_FILE', undefined)
  release()
  expect(await result).toEqual(expected)
  expect(infra.workflow).toHaveBeenCalledWith('user-1', 'workflow-1')
  expect(infra.modelConfig).toHaveBeenCalledWith('user-1', 'workspace-1', undefined)
})
it('response schema rejects foreign sensitive properties', () => {
  expect(localCapabilitiesResponse.safeParse({ ...expected, sessionId: 'secret' }).success).toBe(
    false
  )
})

it('missing localBackend is unavailable rather than implicitly activated', async () => {
  const { localBackend: _, ...withoutBackend } = config()
  infra.policy.mockImplementation(() => ({ policy: parseChatInstallationPolicy(withoutBackend) }))
  expect(await (await GET(request())).json()).toEqual({
    version: 1,
    backend: 'unavailable',
    code: 'local_profile_unavailable',
  })
})
it('legacy still refuses revoked access', async () => {
  vi.stubEnv('MEMLIA_CHAT_POLICY_FILE', undefined)
  workspaceAuthzMockFns.mockResolveEffectiveWorkspacePermission.mockResolvedValue(null)
  expect((await GET(request())).status).toBe(403)
  expect(infra.policy).not.toHaveBeenCalled()
})
it('does not accept a client-selected backend or model', async () => {
  const response = await GET(request(`${query}&backend=legacy&model=other`))
  expect(response.status).toBe(400)
  expect(infra.policy).not.toHaveBeenCalled()
})
it('ignores forged subject headers in favor of the session', async () => {
  const response = await GET(
    request(query, {
      'x-user-id': 'foreign',
      authorization: 'Bearer fixture',
      'x-api-key': 'fixture',
    })
  )
  expect(response.status).toBe(200)
  expect(infra.workflow).toHaveBeenCalledWith('user-1', 'workflow-1')
  expect(infra.modelConfig).toHaveBeenCalledWith('user-1', 'workspace-1', undefined)
})
it('owns the selected model while awaiting its current permission', async () => {
  const policy = { ...parseChatInstallationPolicy(config()) }
  infra.policy.mockReturnValue({ policy })
  infra.modelConfig.mockImplementation(async () => {
    policy.model = 'foreign'
    return null
  })
  expect(await (await GET(request())).json()).toEqual(expected)
})
it('returns fixed operational errors without native causes or model data', async () => {
  infra.modelConfig.mockRejectedValue(
    new Error('PRIVATE_WINDOW /fixture/policy.json FICTITIOUS_KEY')
  )
  const response = await GET(request())
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({ error: 'Local Chat profile is unavailable.' })
})
it('refuses direct actorless principals before any context load', async () => {
  await expect(
    readLocalChatCapabilities.execute({
      principal: { kind: 'workspace_api_key', keyId: 'fixture-key', workspaceId: 'workspace-1' },
      input: { workspaceId: 'workspace-1' },
    })
  ).rejects.toThrow()
  expect(
    workspaceContextMockFns.mockResolveActiveWorkspaceApplicationContext
  ).not.toHaveBeenCalled()
  expect(infra.policy).not.toHaveBeenCalled()
})

it.each(['disabled', 'absent'])(
  'reports unavailable when native confirmation is %s, without exposing the local profile',
  async (configuration) => {
    if (configuration === 'absent') resetEnvFlagsMock()
    else setEnvFlags({ isCopilotToolPermissionsEnabled: false })
    const response = await GET(request())
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(await response.json()).toEqual({
      version: 1,
      backend: 'unavailable',
      code: 'local_profile_unavailable',
    })
    expect(infra.modelConfig).toHaveBeenCalledWith('user-1', 'workspace-1', undefined)
  }
)
it('keeps the legacy observation when confirmation is disabled and no local policy is present', async () => {
  setEnvFlags({ isCopilotToolPermissionsEnabled: false })
  vi.stubEnv('MEMLIA_CHAT_POLICY_FILE', undefined)
  const response = await GET(request())
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ version: 1, backend: 'legacy' })
  expect(infra.policy).not.toHaveBeenCalled()
})
it('retains copilot.use authorization with confirmation disabled', async () => {
  setEnvFlags({ isCopilotToolPermissionsEnabled: false })
  permissionGroupScopeMockFns.mockResolvePermissionGroupConfig.mockResolvedValue({
    ...DEFAULT_PERMISSION_GROUP_CONFIG,
    hideCopilot: true,
  })
  const response = await GET(request())
  expect(response.status).toBe(403)
  expect(infra.policy).not.toHaveBeenCalled()
})
it('retains denied-model refusal with confirmation disabled', async () => {
  setEnvFlags({ isCopilotToolPermissionsEnabled: false })
  infra.modelConfig.mockResolvedValue({
    ...DEFAULT_PERMISSION_GROUP_CONFIG,
    deniedModels: ['gpt-5.4'],
  })
  const response = await GET(request())
  expect(response.status).toBe(403)
  expect(await response.json()).toEqual({ error: 'Local Chat profile is unavailable.' })
})

it('observes authorized Anthropic capabilities without exposing its API workspace or credentials', async () => {
  infra.policy.mockImplementation(() => ({
    policy: parseChatInstallationPolicy({
      ...config(),
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      anthropicWorkspaceId: 'wrkspc_Fictitious1234',
    }),
  }))
  const response = await GET(request())
  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body).toEqual({ ...expected, provider: 'anthropic', model: 'claude-haiku-4-5' })
  expect(JSON.stringify(body)).not.toMatch(/wrkspc_|pricing|apiKey/)
})
it('keeps native provider restrictions on Anthropic capabilities', async () => {
  infra.policy.mockImplementation(() => ({
    policy: parseChatInstallationPolicy({
      ...config(),
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
    }),
  }))
  infra.modelConfig.mockResolvedValue({
    ...DEFAULT_PERMISSION_GROUP_CONFIG,
    allowedModelProviders: ['openai'],
  })
  expect((await GET(request())).status).toBe(403)
})
