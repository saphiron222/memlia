'use client'

import { useState } from 'react'
import { normalizeEmail } from '@sim/utils/string'
import { useSearchParams } from 'next/navigation'
import { requestJson } from '@/lib/api/client/request'
import { resolveSsoProviderContract } from '@/lib/api/contracts/auth'
import { client } from '@/lib/auth/client'
import { validateCallbackUrl } from '@/lib/core/security/input-validation'
import { quickValidateEmail } from '@/lib/messaging/email/validation'
import { buildAuthCrossLink, DEFAULT_POST_AUTH_ROUTE } from '@/app/(auth)/auth-redirect'
import { AuthField } from '@/app/(auth)/components/auth-field'
import { AuthHeader } from '@/app/(auth)/components/auth-header'
import { AuthInput } from '@/app/(auth)/components/auth-input'
import { AuthNavPrompt } from '@/app/(auth)/components/auth-nav-prompt'
import { AuthSubmitButton } from '@/app/(auth)/components/auth-submit-button'

export default function SSOForm({ registrationDisabled }: { registrationDisabled: boolean }) {
  const searchParams = useSearchParams()
  const [email, setEmail] = useState(searchParams?.get('email') ?? '')
  const [error, setError] = useState<string | null>(
    searchParams?.get('error')
      ? 'Unable to sign in with SSO. Please try again or contact your administrator.'
      : null
  )
  const [isLoading, setIsLoading] = useState(false)
  const rawCallbackUrl = searchParams?.get('callbackUrl')
  const callbackUrl =
    rawCallbackUrl && validateCallbackUrl(rawCallbackUrl) ? rawCallbackUrl : DEFAULT_POST_AUTH_ROUTE
  const providerId = searchParams?.get('provider')?.trim()
  const crossLinkParams = {
    callbackUrl: rawCallbackUrl && validateCallbackUrl(rawCallbackUrl) ? rawCallbackUrl : null,
    isInviteFlow: searchParams?.get('invite_flow') === 'true',
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (isLoading) return
    const normalizedEmail = normalizeEmail(email)
    if (!quickValidateEmail(normalizedEmail).isValid) {
      setError('Please enter a valid email address.')
      return
    }
    setError(null)
    setIsLoading(true)
    try {
      const resolved = await requestJson(resolveSsoProviderContract, {
        body: { email: normalizedEmail, ...(providerId ? { providerId } : {}) },
      })
      const errorParams = new URLSearchParams({
        error: 'sso_failed',
        provider: resolved.providerId,
        callbackUrl,
      })
      const result = await client.signIn.sso({
        email: normalizedEmail,
        providerId: resolved.providerId,
        callbackURL: callbackUrl,
        errorCallbackURL: `/sso?${errorParams.toString()}`,
      })
      if (result.error) {
        setError('Unable to sign in with SSO. Please try again or contact your administrator.')
        setIsLoading(false)
      }
    } catch {
      setError('Unable to sign in with SSO. Please try again or contact your administrator.')
      setIsLoading(false)
    }
  }

  return (
    <div className='space-y-6'>
      <AuthHeader title='Single Sign-On' description='Sign in with your work account' />
      <form onSubmit={handleSubmit} className='space-y-6' aria-busy={isLoading}>
        <AuthField htmlFor='sso-email' label='Work Email'>
          <AuthInput
            id='sso-email'
            name='email'
            type='email'
            required
            autoComplete='email'
            autoCapitalize='none'
            autoCorrect='off'
            placeholder='Enter your work email'
            value={email}
            disabled={isLoading}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? 'sso-error' : undefined}
            onChange={(event) => {
              setEmail(event.target.value)
              setError(null)
            }}
          />
          {error && (
            <p id='sso-error' role='alert' className='text-[var(--text-error)] text-xs'>
              {error}
            </p>
          )}
        </AuthField>
        <AuthSubmitButton
          disabled={!email.trim()}
          loading={isLoading}
          loadingLabel='Redirecting to SSO…'
        >
          Continue with SSO
        </AuthSubmitButton>
      </form>
      <AuthNavPrompt
        href={buildAuthCrossLink('/login', crossLinkParams)}
        linkLabel='Back to login'
      />
      {!registrationDisabled && (
        <AuthNavPrompt
          prompt="Don't have an account?"
          href={buildAuthCrossLink('/signup', crossLinkParams)}
          linkLabel='Sign up'
        />
      )}
    </div>
  )
}
