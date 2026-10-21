// Copyright Memlia. All rights reserved.
import { NextRequest, NextResponse } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const boundary = vi.hoisted(() => ({ session: vi.fn(), envelope: vi.fn(), handler: vi.fn() }))
vi.mock('@/lib/auth', () => ({ getSession: boundary.session }))
vi.mock('@/lib/mothership/request/http', () => ({ validateShimEnvelope: boundary.envelope }))
vi.mock('@/lib/mothership/chat/post', () => ({ handleUnifiedChatPost: boundary.handler }))

import { POST } from './route'

describe('native mothership shim body ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('MEMLIA_CHAT_POLICY_FILE', undefined)
    boundary.session.mockResolvedValue({ user: { id: 'fixture-user' } })
    boundary.envelope.mockResolvedValue(null)
    boundary.handler.mockResolvedValue(NextResponse.json({ fixture: true }))
  })
  afterEach(() => vi.unstubAllEnvs())
  it.each(['', '/fixture/policy.json'])(
    'delegates local presence %s without pre-reading or shim auth',
    async (policy) => {
      vi.stubEnv('MEMLIA_CHAT_POLICY_FILE', policy)
      const request = new NextRequest('http://localhost/api/mothership/chat', {
        method: 'POST',
        body: '{}',
      })
      const clone = vi.spyOn(request, 'clone')
      expect((await POST(request, undefined)).status).toBe(200)
      expect(boundary.handler).toHaveBeenCalledExactlyOnceWith(request)
      expect(boundary.session).not.toHaveBeenCalled()
      expect(boundary.envelope).not.toHaveBeenCalled()
      expect(clone).not.toHaveBeenCalled()
      expect(request.bodyUsed).toBe(false)
    }
  )
  it('preserves legacy session and envelope validation', async () => {
    const request = new NextRequest('http://localhost/api/mothership/chat', {
      method: 'POST',
      body: '{}',
    })
    await POST(request, undefined)
    expect(boundary.session).toHaveBeenCalledOnce()
    expect(boundary.envelope).toHaveBeenCalledOnce()
    expect(boundary.handler).toHaveBeenCalledExactlyOnceWith(request)
    expect(boundary.envelope.mock.invocationCallOrder[0]).toBeLessThan(
      boundary.handler.mock.invocationCallOrder[0]
    )
  })
  it('preserves legacy unauthenticated refusal', async () => {
    boundary.session.mockResolvedValue(null)
    expect((await POST(new NextRequest('http://localhost'), undefined)).status).toBe(401)
    expect(boundary.envelope).not.toHaveBeenCalled()
    expect(boundary.handler).not.toHaveBeenCalled()
  })
  it('preserves legacy envelope refusal', async () => {
    boundary.envelope.mockResolvedValue(
      NextResponse.json({ error: 'fixture-invalid' }, { status: 400 })
    )
    expect((await POST(new NextRequest('http://localhost'), undefined)).status).toBe(400)
    expect(boundary.handler).not.toHaveBeenCalled()
  })
})
