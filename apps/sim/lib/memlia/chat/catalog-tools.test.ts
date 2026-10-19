// Copyright (c) 2026 Memlia. All rights reserved.

import { createSessionPrincipal } from '@sim/testing/factories/principal.factory'
import { auditMock } from '@sim/testing/mocks/audit.mock'
import { blockVisibilityMock } from '@sim/testing/mocks/block-visibility.mock'
import { customBlockOperationsMock } from '@sim/testing/mocks/custom-block-operations.mock'
import { integrationsAvailabilityMock } from '@sim/testing/mocks/integrations-availability.mock'
import { workspaceAuthzMock, workspaceAuthzMockFns } from '@sim/testing/mocks/workspace-authz.mock'
import {
  workspaceContextMock,
  workspaceContextMockFns,
} from '@sim/testing/mocks/workspace-context.mock'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Composition: native use cases, authorization funnel, schemas and projections.
// Database/role/visibility lookups and registry definitions use the upstream unit fixtures.
vi.mock('@/lib/workspaces/application/context', () => workspaceContextMock)
vi.mock('@sim/platform-authz/workspace', () => workspaceAuthzMock)
vi.mock('@sim/audit', () => auditMock)
vi.mock('@/lib/core/config/block-visibility', () => blockVisibilityMock)
vi.mock('@/lib/workflows/custom-blocks/operations', () => customBlockOperationsMock)
vi.mock('@/lib/integrations/availability.server', () => integrationsAvailabilityMock)
vi.mock('@/lib/integrations/principal-scope.server', () => ({
  allowedIntegrationTypes: async () => null,
  principalUserId: (principal: { userId?: string }) => principal.userId,
}))
vi.mock('@/blocks/custom/server-overlay', () => ({
  withCustomBlockOverlay: <T>(_rows: unknown, run: () => Promise<T>) => run(),
}))
vi.mock('@/blocks/visibility/server-context', () => ({
  withBlockVisibility: <T>(_state: unknown, run: () => Promise<T>) => run(),
}))

import { getAllBlocks } from '@/blocks/registry'
import type { BlockConfig } from '@/blocks/types'
import { getToolMetadata } from '@/tools/metadata'
import { getToolOutputsMetadata } from '@/tools/metadata-outputs'
import { createCatalogTools } from './catalog-tools'

const principal = createSessionPrincipal({ userId: 'catalog-reader' })
let registryBlock: BlockConfig

beforeEach(() => {
  workspaceContextMockFns.mockLoadActiveWorkspaceApplicationContext.mockImplementation(
    async (workspaceId) =>
      workspaceId === 'workspace-1'
        ? {
            workspaceId: 'workspace-1',
            workspaceOrganizationId: null,
            allowPersonalApiKeys: true,
            billedAccountUserId: 'different-billing-owner',
          }
        : null
  )
  workspaceAuthzMockFns.mockResolveEffectiveWorkspacePermission.mockImplementation(
    async (userId, workspaceId) =>
      userId === 'catalog-reader' && workspaceId === 'workspace-1' ? 'read' : null
  )
  registryBlock = {
    type: 'slack',
    name: 'Slack',
    description: 'Messaging',
    category: 'tools',
    bgColor: '#000000',
    icon: () => null,
    subBlocks: [],
    outputs: {},
    tools: { access: ['slack_message'] },
  }
  vi.mocked(getAllBlocks).mockReturnValue([registryBlock])
  const metadata = {
    id: 'slack_message',
    name: 'Send Message',
    description: 'Send a message',
    params: { text: { type: 'string' as const, required: true } },
    oauth: { required: true, provider: 'slack' },
    connection: { value: 'FICTIVE_CREDENTIAL_MUST_NOT_LEAVE' },
  }
  vi.mocked(getToolMetadata).mockImplementation((id) =>
    id === 'slack_message' ? metadata : undefined
  )
  const outputs = { ok: { type: 'boolean' as const, value: 'FICTIVE_CREDENTIAL_MUST_NOT_LEAVE' } }
  vi.mocked(getToolOutputsMetadata).mockReturnValue(outputs)
})

describe('Memlia catalog read tools — native composition with unit infrastructure fixtures', () => {
  it('discovers the native Loop authoring type through an authorized workspace read', async () => {
    const tools = createCatalogTools({ principal, workspaceId: 'workspace-1' })
    const result = await tools.dispatch('list_blocks', { search: 'Loop', limit: 1 })
    expect(result).toMatchObject({
      ok: true,
      data: { entries: [{ id: 'loop', category: 'blocks', source: 'builtin' }], hasMore: false },
    })
  })

  it.each(['execute_tool', 'apply_workflow', 'constructor', '__proto__'])(
    'refuses the non-catalog capability %s',
    async (name) => {
      const tools = createCatalogTools({ principal, workspaceId: 'workspace-1' })
      expect(await tools.dispatch(name, {})).toMatchObject({
        ok: false,
        error: { code: 'tool_not_allowed' },
      })
    }
  )

  it.each([
    { workspaceId: 'foreign-workspace' },
    { principal: { kind: 'system' } },
    { userId: 'different-billing-owner' },
    { limit: 101 },
    { limit: 0 },
    { search: '   ' },
    { offset: -1 },
    { offset: 10_001 },
    null,
    [],
  ])('refuses invalid filters or model-provided authority before lookup: %j', async (params) => {
    const tools = createCatalogTools({ principal, workspaceId: 'workspace-1' })
    workspaceContextMockFns.mockLoadActiveWorkspaceApplicationContext.mockRejectedValue(
      new Error('FICTIVE_INTERNAL_FAILURE_MUST_NOT_LEAVE')
    )
    expect(await tools.dispatch('list_blocks', params)).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    })
  })

  it.each([
    ['list_blocks', {}],
    ['get_block', { blockId: 'loop' }],
    ['list_tools', {}],
    ['get_tool', { toolId: 'slack_message' }],
  ] as const)(
    'rechecks current native workspace access on each %s invocation',
    async (name, params) => {
      const tools = createCatalogTools({ principal, workspaceId: 'workspace-1' })
      expect(await tools.dispatch(name, params)).toMatchObject({ ok: true })
      workspaceAuthzMockFns.mockResolveEffectiveWorkspacePermission.mockResolvedValue(null)
      expect(await tools.dispatch(name, params)).toMatchObject({
        ok: false,
        error: { code: 'forbidden' },
      })
    }
  )

  it('does not expose an underlying database error or credential-like message', async () => {
    const tools = createCatalogTools({ principal, workspaceId: 'workspace-1' })
    workspaceContextMockFns.mockLoadActiveWorkspaceApplicationContext.mockRejectedValue(
      new Error('FICTIVE_INTERNAL_FAILURE_MUST_NOT_LEAVE')
    )
    const result = await tools.dispatch('list_blocks', {})
    expect(result).toMatchObject({ ok: false, error: { code: 'unavailable' } })
    expect(JSON.stringify(result)).not.toContain('FICTIVE_INTERNAL_FAILURE_MUST_NOT_LEAVE')
  })

  it('reads native container configuration instead of inventing a block schema', async () => {
    const tools = createCatalogTools({ principal, workspaceId: 'workspace-1' })
    expect(await tools.dispatch('get_block', { blockId: 'loop' })).toMatchObject({
      ok: true,
      data: {
        block: {
          id: 'loop',
          inputSchema: expect.arrayContaining([
            expect.objectContaining({ id: 'loopType', type: 'dropdown' }),
          ]),
        },
      },
    })
  })

  it('discovers a permitted tool with its declared OAuth requirement', async () => {
    const tools = createCatalogTools({ principal, workspaceId: 'workspace-1' })
    expect(await tools.dispatch('list_tools', { oauthProvider: 'slack' })).toMatchObject({
      ok: true,
      data: {
        entries: [
          {
            id: 'slack_message',
            hostedApiKey: 'none',
            oauth: { provider: 'slack', required: true },
          },
        ],
      },
    })
  })

  it('returns native tool parameter/output schemas without opaque metadata or runtime credentials', async () => {
    const tools = createCatalogTools({ principal, workspaceId: 'workspace-1' })
    const result = await tools.dispatch('get_tool', { toolId: 'slack_message' })
    expect(result).toMatchObject({
      ok: true,
      data: {
        tool: {
          id: 'slack_message',
          params: { text: { type: 'string', required: true } },
          outputs: { ok: { type: 'boolean' } },
        },
      },
    })
    expect(JSON.stringify(result)).not.toContain('FICTIVE_CREDENTIAL_MUST_NOT_LEAVE')
    expect(JSON.stringify(result)).not.toContain('connection')
  })

  it('conceals a tool which no visible block exposes', async () => {
    const tools = createCatalogTools({ principal, workspaceId: 'workspace-1' })
    expect(await tools.dispatch('get_tool', { toolId: 'gmail_send' })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    })
  })

  it('refuses authority injection in detail arguments rather than silently stripping it', async () => {
    const tools = createCatalogTools({ principal, workspaceId: 'workspace-1' })
    expect(
      await tools.dispatch('get_block', { blockId: 'loop', workspaceId: 'foreign' })
    ).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    })
  })

  it('does not start a native read after cancellation or expose the abort reason', async () => {
    const tools = createCatalogTools({ principal, workspaceId: 'workspace-1' })
    let lookups = 0
    workspaceContextMockFns.mockLoadActiveWorkspaceApplicationContext.mockImplementation(
      async () => {
        lookups++
        throw new Error('FICTIVE_INTERNAL_FAILURE_MUST_NOT_LEAVE')
      }
    )
    const abort = new AbortController()
    abort.abort('FICTIVE_PRIVATE_ABORT_REASON')
    const result = await tools.dispatch('list_blocks', {}, abort.signal)
    expect(result).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    expect(lookups).toBe(0)
    expect(JSON.stringify(result)).not.toContain('FICTIVE_PRIVATE_ABORT_REASON')
  })

  it('stops delivering a read while its native database lookup is still pending', async () => {
    const tools = createCatalogTools({ principal, workspaceId: 'workspace-1' })
    let finish!: () => void
    workspaceContextMockFns.mockLoadActiveWorkspaceApplicationContext.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(null)
        })
    )
    const abort = new AbortController()
    const pending = tools.dispatch('list_blocks', {}, abort.signal)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      abort.abort('FICTIVE_PRIVATE_ABORT_REASON')
      const result = await Promise.race([
        pending,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve('still waiting'), 150)
        }),
      ])
      expect(result).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    } finally {
      clearTimeout(timer)
      finish()
      await pending
    }
  })

  it('refuses an oversized native metadata result instead of clipping its schema', async () => {
    const tools = createCatalogTools({ principal, workspaceId: 'workspace-1' })
    vi.mocked(getToolMetadata).mockReturnValue({
      id: 'slack_message',
      name: 'Large example',
      params: {},
      description: 'é'.repeat(140_000),
    })
    expect(await tools.dispatch('get_tool', { toolId: 'slack_message' })).toMatchObject({
      ok: false,
      error: { code: 'result_too_large' },
    })
  })

  it('keeps native ordering and indicates that a bounded page has more entries', async () => {
    const tools = createCatalogTools({ principal, workspaceId: 'workspace-1' })
    expect(await tools.dispatch('list_blocks', { limit: 1 })).toMatchObject({
      ok: true,
      data: { entries: [{ id: 'loop' }], hasMore: true, limit: 1, offset: 0 },
    })
    expect(await tools.dispatch('list_blocks', { limit: 1, offset: 1 })).toMatchObject({
      ok: true,
      data: { entries: [{ id: 'parallel' }], hasMore: true, limit: 1, offset: 1 },
    })
  })

  it('does not discover a tool from an unrevealed preview block', async () => {
    vi.mocked(getAllBlocks).mockReturnValue([{ ...registryBlock, preview: true }])
    const tools = createCatalogTools({ principal, workspaceId: 'workspace-1' })
    expect(await tools.dispatch('list_tools', {})).toMatchObject({
      ok: true,
      data: { entries: [] },
    })
    expect(await tools.dispatch('get_tool', { toolId: 'slack_message' })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    })
  })

  it('reports malformed native output as unavailable rather than blaming valid model arguments', async () => {
    vi.mocked(getToolOutputsMetadata).mockReturnValue({ ok: { type: 42 } } as never)
    const tools = createCatalogTools({ principal, workspaceId: 'workspace-1' })
    expect(await tools.dispatch('get_tool', { toolId: 'slack_message' })).toMatchObject({
      ok: false,
      error: { code: 'unavailable' },
    })
  })
})
