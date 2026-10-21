// Modified by Memlia: qualify persistent local engine boundaries.
import { featureFlagsMock, featureFlagsMockFns } from '@sim/testing/mocks/feature-flags.mock'
import { describe, expect, it, vi } from 'vitest'
import { createCopilotResourceAdmission } from '@/lib/mothership/auth/application-delegation'
import {
  classifyRunExecution,
  LocalChatAdmissionSchema,
  StreamRecoveryConfigSchema,
  streamRecoveryConfig,
} from '@/lib/mothership/request/lifecycle/recovery-config'

vi.mock('@/lib/core/config/feature-flags', () => featureFlagsMock)

const identity = {
  userId: 'actor',
  chatId: '11111111-1111-4111-8111-111111111111',
  messageId: '22222222-2222-4222-8222-222222222222',
  message: 'Continue',
}
const workspaceRequest = { ...identity, workspaceId: '33333333-3333-4333-8333-333333333333' }
const organizationRequest = {
  ...identity,
  organizationId: 'org-1',
  mode: 'assistant' as const,
  assistantSearch: { source: 'drive', documentIds: ['document-1'] },
}
function config(request: object, requestMode?: string) {
  return {
    kind: 'interactive_stream',
    request,
    requestMode,
    goRoute: '/api/mothership',
    clientToolPickupExpected: false,
  }
}

describe('durable recovery admission contract', () => {
  it.each(['agent', 'build', 'plan'])(
    'retains existing %s UI intent without changing the Build wire contract',
    (mode) => {
      expect(
        StreamRecoveryConfigSchema.parse(config(workspaceRequest, mode)).request
      ).not.toHaveProperty('mode')
    }
  )
  it('preserves admitted Assistant policy and filters while stripping transport secrets and receipts', () => {
    const parsed = StreamRecoveryConfigSchema.parse(
      config(
        {
          ...organizationRequest,
          byokApiKey: 'test-only-key',
          delegationToken: 'test-only-token',
          receivedTextChars: 7,
        },
        'assistant'
      )
    )
    expect(parsed.request).toMatchObject(organizationRequest)
    expect(parsed.request).not.toHaveProperty('byokApiKey')
    expect(parsed.request).not.toHaveProperty('delegationToken')
    expect(parsed.request).not.toHaveProperty('receivedTextChars')
    expect(parsed.request).not.toHaveProperty('integrationTools')
    expect(parsed.request).not.toHaveProperty('mothershipTools')
  })
  it.each(['integrationTools', 'mothershipTools'])(
    'rejects %s schemas at the durable request boundary',
    (field) => {
      expect(
        StreamRecoveryConfigSchema.safeParse(
          config({
            ...workspaceRequest,
            [field]: [{ name: 'tool', inputSchema: { type: 'object' } }],
          })
        ).success
      ).toBe(false)
    }
  )
  it.each([
    config(workspaceRequest, 'assistant'),
    config({ ...workspaceRequest, mode: 'plan' }, 'agent'),
    config({ ...workspaceRequest, mode: 'agent' }, 'plan'),
    config(organizationRequest, 'agent'),
    config({ ...organizationRequest, workspaceId: workspaceRequest.workspaceId }, 'assistant'),
    config({ ...organizationRequest, mode: undefined }, 'assistant'),
    config({ ...organizationRequest, workflowId: 'workflow' }, 'assistant'),
  ])('rejects conflicting durable mode or owner declarations', (input) => {
    expect(StreamRecoveryConfigSchema.safeParse(input).success).toBe(false)
  })
})

it('preserves the explicit Plan wire mode on recovery', () => {
  expect(
    StreamRecoveryConfigSchema.parse(config({ ...workspaceRequest, mode: 'plan' }, 'plan')).request
      .mode
  ).toBe('plan')
})

describe('recovery marker written by an admitted turn', () => {
  const options = {
    interactive: true,
    userId: identity.userId,
    chatId: identity.chatId,
    goRoute: '/api/mothership',
    copilotResourceAdmission: createCopilotResourceAdmission({
      userId: identity.userId,
      invocation: { kind: 'chat', chatId: identity.chatId },
    }),
  }

  it('stays off a recovery config older builds must still parse while Projects are off', async () => {
    featureFlagsMockFns.mockIsFeatureEnabled.mockResolvedValue(false)
    const recovery = await streamRecoveryConfig(options, workspaceRequest)
    expect(recovery).not.toHaveProperty('resourceAuthoringVersion')
  })

  it('restores authoring admission on recovery while Projects are on', async () => {
    featureFlagsMockFns.mockIsFeatureEnabled.mockImplementation(async (flag) => flag === 'projects')
    const recovery = await streamRecoveryConfig(options, workspaceRequest)
    expect(recovery?.resourceAuthoringVersion).toBe(1)
  })
})

const localMarker = { kind: 'memlia_local_chat', version: 1, recovery: 'none' }
describe('local run persistence contract', () => {
  it('distinguishes absent historical marker from the exact local marker', () => {
    expect(classifyRunExecution(undefined)).toBe('worker')
    expect(classifyRunExecution({ recovery: config(workspaceRequest) })).toBe('worker')
    expect(classifyRunExecution({ localExecution: localMarker })).toBe('local')
  })
  it.each([
    null,
    undefined,
    false,
    {},
    { ...localMarker, version: 2 },
    { ...localMarker, apiKey: 'fixture' },
  ])('never treats a present invalid marker as worker', (marker) => {
    expect(classifyRunExecution({ localExecution: marker })).toBe('unavailable')
  })
  it('refuses conflicting worker recovery and any local marker', () => {
    expect(
      classifyRunExecution({ localExecution: localMarker, recovery: config(workspaceRequest) })
    ).toBe('unavailable')
  })
  it('captures a minimal local admission and rejects secrets/worker routing', () => {
    const intent = {
      kind: 'memlia_local_chat',
      version: 1,
      request: { ...workspaceRequest, workflowId: 'workflow', mode: 'agent' },
    }
    expect(LocalChatAdmissionSchema.parse(intent)).toEqual(intent)
    for (const extra of [
      { apiKey: 'fixture' },
      { goRoute: '/api/copilot' },
      { sessionId: 'fixture' },
    ]) {
      expect(LocalChatAdmissionSchema.safeParse({ ...intent, ...extra }).success).toBe(false)
      expect(
        LocalChatAdmissionSchema.safeParse({ ...intent, request: { ...intent.request, ...extra } })
          .success
      ).toBe(false)
    }
  })
})
