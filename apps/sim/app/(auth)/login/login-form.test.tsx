/** @vitest-environment jsdom */
// Memlia — regression coverage; reserved rights, see repository notices.
import { act } from 'react'
import { nextNavigationMock, nextNavigationMockFns } from '@sim/testing/mocks/next-navigation.mock'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { transport } = vi.hoisted(() => ({ transport: vi.fn<typeof fetch>() }))
// Real Better Auth client/default redirect plugin; only HTTP is replaced, no real authentication.
vi.mock('@/lib/auth/client', async () => {
  const { createAuthClient } = await import('better-auth/react')
  return {
    client: createAuthClient({
      baseURL: 'http://localhost:3000',
      fetchOptions: { customFetchImpl: (...args) => transport(...args) },
    }),
  }
})
vi.mock('next/navigation', () => nextNavigationMock)
vi.mock('@/hooks/use-capture-when-ready', () => ({ useCaptureWhenReady: () => {} }))

import LoginForm from '@/app/(auth)/login/login-form'

let root: Root
let container: HTMLDivElement
let navigations: string[]
let responseBody: Record<string, unknown>
let responseStatus: number

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  navigations = []
  responseStatus = 200
  responseBody = {
    redirect: true,
    url: '/home',
    token: 'synthetic-session',
    user: {
      id: 'fixture',
      name: 'Fixture',
      email: 'fixture@example.com',
      emailVerified: true,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      image: null,
    },
  }
  transport.mockImplementation(
    async () =>
      new Response(JSON.stringify(responseBody), {
        status: responseStatus,
        headers: { 'content-type': 'application/json' },
      })
  )
  nextNavigationMockFns.mockUseSearchParams.mockReturnValue(new URLSearchParams())
  // JSDOM cannot navigate documents. Observe that browser boundary, preserving the real DOM.
  const nativeWindow = window
  const location = {
    origin: 'http://localhost:3000',
    get href() {
      return 'http://localhost:3000/login'
    },
    set href(value: string) {
      navigations.push(value)
    },
  }
  vi.stubGlobal(
    'window',
    new Proxy(nativeWindow, {
      get(target, key) {
        return key === 'location' ? location : Reflect.get(target, key, target)
      },
    })
  )
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  sessionStorage.clear()
})

async function submit() {
  await act(async () =>
    root.render(
      <LoginForm
        githubAvailable={false}
        googleAvailable={false}
        microsoftAvailable={false}
        registrationDisabled={false}
      />
    )
  )
  for (const [selector, value] of [
    ['input[name="email"]', 'fixture@example.com'],
    ['input[name="password"]', 'synthetic-password'],
  ]) {
    const input = container.querySelector<HTMLInputElement>(selector)!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  await act(async () => {
    container
      .querySelector<HTMLFormElement>('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

describe('native login document navigation', () => {
  it('delegates a successful redirect exactly once to the real Better Auth plugin', async () => {
    await submit()
    expect(navigations).toEqual(['/home'])
    expect(transport).toHaveBeenCalledTimes(1)
    const [, init] = transport.mock.calls[0]
    expect(JSON.parse(String(init?.body))).toMatchObject({
      callbackURL: '/home',
      email: 'fixture@example.com',
    })
  })
  it('keeps the document fallback when the response does not request a redirect', async () => {
    responseBody.redirect = false
    await submit()
    expect(navigations).toEqual(['/home'])
  })
  it('keeps the document fallback when no response URL exists', async () => {
    responseBody.url = undefined
    await submit()
    expect(navigations).toEqual(['/home'])
  })
  it('keeps a validated callback through the real client and navigates once', async () => {
    nextNavigationMockFns.mockUseSearchParams.mockReturnValue(
      new URLSearchParams({ callbackUrl: '/workspace/fixture/w' })
    )
    responseBody.url = '/workspace/fixture/w'
    await submit()
    expect(navigations).toEqual(['/workspace/fixture/w'])
    const [, init] = transport.mock.calls[0]
    expect(JSON.parse(String(init?.body)).callbackURL).toBe('/workspace/fixture/w')
  })
  it('uses the safe document fallback when the plugin rejects a dangerous scheme', async () => {
    responseBody.url = 'javascript:alert(1)'
    await submit()
    expect(navigations).toEqual(['/home'])
  })
  it('does not forward an invalid external callback URL', async () => {
    nextNavigationMockFns.mockUseSearchParams.mockReturnValue(
      new URLSearchParams({ callbackUrl: 'https://foreign.invalid/callback' })
    )
    responseBody.redirect = false
    await submit()
    const [, init] = transport.mock.calls[0]
    expect(JSON.parse(String(init?.body)).callbackURL).toBe('/home')
    expect(navigations).toEqual(['/home'])
  })
  it('shows a native 403 policy refusal without document navigation', async () => {
    responseStatus = 403
    responseBody = { code: 'ACCOUNT_SUSPENDED', message: 'Account is suspended' }
    await submit()
    expect(navigations).toEqual([])
    expect(container.textContent).toContain('Account is suspended')
  })
  it('preserves email verification navigation on native error', async () => {
    responseStatus = 403
    responseBody = { code: 'EMAIL_NOT_VERIFIED', message: 'Email is not verified' }
    await submit()
    expect(navigations).toEqual([])
    expect(nextNavigationMockFns.router.push).toHaveBeenCalledWith('/verify')
    expect(sessionStorage.getItem('verificationEmail')).toBe('fixture@example.com')
  })
})
