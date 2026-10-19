/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SSOAuth from './sso-auth'

const mocks = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }))

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ eligible: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
  )
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

describe('shared chat SSO gate', () => {
  it('checks eligibility with the real contract before navigating to SSO', async () => {
    render(<SSOAuth identifier='demo' />)
    submit()
    await flush()
    expect(mocks.push).toHaveBeenCalledWith(
      '/sso?email=person%40example.com&callbackUrl=%2Fchat%2Fdemo'
    )
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    expect(String(url)).toBe('/api/chat/demo/sso')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({ email: 'person@example.com' })
  })

  it.each([{ eligible: false }, {}])(
    'does not grant access for refused or malformed eligibility %j',
    async (body) => {
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      render(<SSOAuth identifier='demo' />)
      submit()
      await flush()
      expect(alert()).toHaveTextContent(/not authorized|try again/i)
      expect(mocks.push).not.toHaveBeenCalled()
      expect(button()).toBeEnabled()
    }
  )

  it('refuses an invalid email before the network request and associates the error', () => {
    render(<SSOAuth identifier='demo' />)
    submit('invalid')
    expect(fetch).not.toHaveBeenCalled()
    expect(alert()).toHaveTextContent('valid email')
    expect(input()).toHaveAttribute('aria-invalid', 'true')
    expect(input()).toHaveAccessibleDescription(/valid email/)
  })

  it('recovers from network failure without navigating or revealing diagnostics', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('private diagnostic'))
    render(<SSOAuth identifier='demo' />)
    submit()
    await flush()
    expect(alert()).toHaveTextContent(/try again/i)
    expect(container.textContent).not.toContain('private diagnostic')
    expect(mocks.push).not.toHaveBeenCalled()
    expect(button()).toBeEnabled()
  })

  it('encodes the share identifier as a local path segment', async () => {
    render(<SSOAuth identifier='demo?next=//evil.example#fragment' />)
    submit()
    await flush()
    expect(mocks.push).toHaveBeenCalledTimes(1)
    const target = new URL(mocks.push.mock.calls[0][0], 'https://app.example')
    expect(target.pathname).toBe('/sso')
    expect(target.searchParams.get('callbackUrl')).toBe(
      '/chat/demo%3Fnext%3D%2F%2Fevil.example%23fragment'
    )
  })

  it('blocks duplicate submissions while checking eligibility', () => {
    vi.mocked(fetch).mockReturnValue(new Promise(() => {}))
    render(<SSOAuth identifier='demo' />)
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
})
