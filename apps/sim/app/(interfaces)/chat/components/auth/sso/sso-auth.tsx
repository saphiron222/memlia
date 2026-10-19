'use client'

import { useState } from 'react'
import { Input, Label } from '@sim/emcn'
import { normalizeEmail } from '@sim/utils/string'
import { useRouter } from 'next/navigation'
import { requestJson } from '@/lib/api/client/request'
import { chatSSOContract } from '@/lib/api/contracts/chats'
import { validateCallbackUrl } from '@/lib/core/security/input-validation'
import { quickValidateEmail } from '@/lib/messaging/email/validation'
import { AuthHeader } from '@/app/(auth)/components/auth-header'
import { AuthSubmitButton } from '@/app/(auth)/components/auth-submit-button'

export default function SSOAuth({ identifier }: { identifier: string }) {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)

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
      const { eligible } = await requestJson(chatSSOContract, {
        params: { identifier },
        body: { email: normalizedEmail },
      })
      if (!eligible) {
        setError('Email not authorized for this chat.')
        setIsLoading(false)
        return
      }
      const callbackUrl = `/chat/${encodeURIComponent(identifier)}`
      if (!validateCallbackUrl(callbackUrl)) {
        setError('Unable to open this chat. Please try again.')
        setIsLoading(false)
        return
      }
      router.push(
        `/sso?email=${encodeURIComponent(normalizedEmail)}&callbackUrl=${encodeURIComponent(callbackUrl)}`
      )
    } catch {
      setError('Unable to verify access to this chat. Please try again.')
      setIsLoading(false)
    }
  }

  return (
    <div className='flex flex-1 items-center justify-center px-4 py-16'>
      <div className='w-full max-w-[410px]'>
        <AuthHeader
          title='SSO Authentication'
          description='This chat requires SSO authentication'
        />
        <form onSubmit={handleSubmit} className='mt-8 space-y-6' aria-busy={isLoading}>
          <div className='space-y-2'>
            <Label htmlFor='chat-sso-email'>Work Email</Label>
            <Input
              id='chat-sso-email'
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
              aria-describedby={error ? 'chat-sso-error' : undefined}
              onChange={(event) => {
                setEmail(event.target.value)
                setError(null)
              }}
            />
            {error && (
              <p id='chat-sso-error' role='alert' className='text-[var(--text-error)] text-xs'>
                {error}
              </p>
            )}
          </div>
          <AuthSubmitButton
            disabled={!email.trim()}
            loading={isLoading}
            loadingLabel='Redirecting to SSO…'
          >
            Continue with SSO
          </AuthSubmitButton>
        </form>
      </div>
    </div>
  )
}
