// Copyright (c) 2026 Memlia. All rights reserved.
import { authMock, authMockFns } from '@sim/testing/mocks/auth.mock'
import { networkConfigMock } from '@sim/testing/mocks/network-config.mock'
import { NextRequest } from 'next/server'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const authority = vi.hoisted(() => ({ imports: vi.fn() }))
vi.mock('@/lib/auth', () => authMock)
vi.mock('@/lib/core/network/config.server', () => networkConfigMock)
vi.mock('./enrollment-authority', () => {
  authority.imports()
  throw new Error('unconfigured_route_must_not_import_signer')
})
// Keep the real runtime/config reader and four real route exports. Only their
// unused infrastructure ports are doubled; no server, CA or Windows is qualified.
vi.unmock('./enrollment-runtime')

beforeEach(() => {
  vi.stubEnv('MEMLIA_AGENT_ENROLLMENT_CONFIG', '')
})
afterAll(() => vi.unstubAllEnvs())
describe('installed enrollment route composition without administrator configuration', () => {
  it.each([
    ['create', '/api/workspaces/fixture/desktop-agent-enrollments'],
    ['revoke', '/api/workspaces/fixture/desktop-agent-enrollments/fixture/revoke'],
    ['challenge', '/api/desktop-agent-enrollments/challenge'],
    ['complete', '/api/desktop-agent-enrollments/complete'],
  ] as const)(
    'keeps the real %s route unavailable, without loading a signer or identity',
    async (kind, pathname) => {
      const routes = {
        create: () => import('@/app/api/workspaces/[id]/desktop-agent-enrollments/route'),
        revoke: () =>
          import('@/app/api/workspaces/[id]/desktop-agent-enrollments/[enrollmentId]/revoke/route'),
        challenge: () => import('@/app/api/desktop-agent-enrollments/challenge/route'),
        complete: () => import('@/app/api/desktop-agent-enrollments/complete/route'),
      }
      const route = await routes[kind]()
      expect(route.runtime).toBe('nodejs')
      expect(route.dynamic).toBe('force-dynamic')
      const request = new NextRequest(`https://fixture.example${pathname}`, {
        method: 'POST',
        headers: { origin: 'https://fixture.example', 'content-type': 'application/json' },
        body: '{}',
      })
      const response = await route.POST(request)
      expect(response.status).toBe(503)
      expect(response.headers.get('cache-control')).toBe('private, no-store')
      expect(await response.json()).toEqual({ error: 'enrollment_unavailable' })
      expect(authority.imports).not.toHaveBeenCalled()
      expect(authMockFns.mockGetSession).not.toHaveBeenCalled()
    }
  )
})
