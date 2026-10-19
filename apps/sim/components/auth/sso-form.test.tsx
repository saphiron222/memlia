/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SSOForm from './sso-form'

const mocks = vi.hoisted(() => ({ sso: vi.fn(), params: new URLSearchParams() }))
vi.mock('@/lib/auth/client', () => ({ client: { signIn: { sso: mocks.sso } } }))
vi.mock('next/navigation', () => ({ useSearchParams: () => mocks.params }))

beforeEach(() => {
  mocks.params = new URLSearchParams()
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ providerId: 'verified-idp' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
  )
  mocks.sso
    .mockReset()
    .mockResolvedValue({ data: { url: 'https://idp.example.com/login' }, error: null })
})
let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})
function render(ui: ReactNode) {
  act(() => root.render(ui))
}
function input() {
  const field = container.querySelector<HTMLInputElement>('input[type="email"]')
  expect(field, 'email input is rendered').not.toBeNull()
  expect(container.querySelector(`label[for="${field!.id}"]`)).toHaveTextContent('Work Email')
  return field!
}
function button() {
  const control = container.querySelector<HTMLButtonElement>('button[type="submit"]')
  expect(control, 'submit button is rendered').not.toBeNull()
  return control!
}
function alert() {
  return container.querySelector('[role="alert"]')
}
async function flush() {
  await act(async () => {})
}

function submit(email = ' Person@Example.com ') {
  act(() => {
    const field = input()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, email)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  act(() =>
    button()
      .closest('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  )
}

describe('SSO sign-in form', () => {
  it('uses the existing SSO client with normalized email and the local callback', async () => {
    mocks.params = new URLSearchParams({
      email: 'person@example.com',
      callbackUrl: '/chat/demo?mode=full',
    })
    render(<SSOForm registrationDisabled={false} />)
    expect(input()).toHaveValue('person@example.com')
    submit()
    await flush()
    expect(mocks.sso).toHaveBeenCalledWith({
      email: 'person@example.com',
      providerId: 'verified-idp',
      callbackURL: '/chat/demo?mode=full',
      errorCallbackURL:
        '/sso?error=sso_failed&provider=verified-idp&callbackUrl=%2Fchat%2Fdemo%3Fmode%3Dfull',
    })
  })

  it('refuses sign-in when the server cannot resolve a verified provider', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: 'private diagnostic' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      })
    )
    render(<SSOForm registrationDisabled />)
    submit()
    await flush()
    expect(mocks.sso).not.toHaveBeenCalled()
    expect(alert()).toHaveTextContent(/try again/i)
    expect(container.textContent).not.toContain('private diagnostic')
    expect(button()).toBeEnabled()
  })

  it('announces a failed callback without reflecting the untrusted error', () => {
    mocks.params = new URLSearchParams({ error: 'private diagnostic' })
    render(<SSOForm registrationDisabled />)
    expect(alert()).toHaveTextContent(/try again/i)
    expect(container.textContent).not.toContain('private diagnostic')
  })

  it('preserves an explicit provider selection', async () => {
    mocks.params = new URLSearchParams({ provider: 'example-idp' })
    render(<SSOForm registrationDisabled />)
    submit()
    await flush()
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toBe('/api/auth/sso/resolve')
    expect(JSON.parse(init?.body as string)).toEqual({
      email: 'person@example.com',
      providerId: 'example-idp',
    })
    expect(mocks.sso).toHaveBeenCalledWith({
      email: 'person@example.com',
      providerId: 'verified-idp',
      callbackURL: '/home',
      errorCallbackURL: '/sso?error=sso_failed&provider=verified-idp&callbackUrl=%2Fhome',
    })
  })

  it.each([
    'https://evil.example/path',
    '//evil.example',
    '/\\evil.example',
    'javascript:alert(1)',
    'https://localhost:3000.evil.example',
    '\n//evil.example',
  ])('does not propagate an external callback: %s', async (callbackUrl) => {
    mocks.params = new URLSearchParams({ callbackUrl })
    render(<SSOForm registrationDisabled={false} />)
    submit()
    await flush()
    expect(mocks.sso).toHaveBeenCalledWith({
      email: 'person@example.com',
      providerId: 'verified-idp',
      callbackURL: '/home',
      errorCallbackURL: '/sso?error=sso_failed&provider=verified-idp&callbackUrl=%2Fhome',
    })
    for (const link of container.querySelectorAll('a'))
      expect(link.getAttribute('href')).not.toContain('evil.example')
  })

  it('rejects an invalid email with an accessible field error before authentication', () => {
    render(<SSOForm registrationDisabled />)
    submit('invalid')
    expect(mocks.sso).not.toHaveBeenCalled()
    expect(alert()).toHaveTextContent('valid email')
    expect(input()).toHaveAttribute('aria-invalid', 'true')
    expect(input()).toHaveAccessibleDescription(/valid email/)
  })

  it.each(['response', 'network'])(
    'shows a recoverable %s failure without exposing backend details',
    async (failure) => {
      if (failure === 'response')
        mocks.sso.mockResolvedValue({
          data: null,
          error: { message: 'private diagnostic', status: 403 },
        })
      else mocks.sso.mockRejectedValue(new Error('private diagnostic'))
      render(<SSOForm registrationDisabled />)
      submit()
      await flush()
      expect(alert()).toHaveTextContent(/try again/i)
      expect(container.textContent).not.toContain('private diagnostic')
      expect(button()).toBeEnabled()
    }
  )

  it('prevents repeat requests while the handoff is pending', () => {
    mocks.sso.mockReturnValue(new Promise(() => {}))
    render(<SSOForm registrationDisabled />)
    submit()
    const pending = button()
    expect(pending).toBeDisabled()
    act(() =>
      pending
        .closest('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    )
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('keeps the validated return on alternate auth links and hides disabled registration', () => {
    mocks.params = new URLSearchParams({ callbackUrl: '/chat/demo' })
    render(<SSOForm registrationDisabled={false} />)
    expect(container.querySelector('a[href^="/signup"]')).toHaveAttribute(
      'href',
      '/signup?callbackUrl=%2Fchat%2Fdemo'
    )
    expect(container.querySelector('a[href^="/login"]')).toHaveAttribute(
      'href',
      '/login?callbackUrl=%2Fchat%2Fdemo'
    )
    render(<SSOForm registrationDisabled />)
    expect(container.querySelector('a[href^="/signup"]')).toBeNull()
  })
})
