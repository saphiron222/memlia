// Modified by Memlia in 2026. Upstream Apache-2.0 license and notices retained.
import { Suspense } from 'react'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import SSOForm from '@/components/auth/sso-form'
import { isRegistrationDisabled, isSsoEnabled } from '@/lib/core/config/env-flags'
import SSOLoading from '@/app/(auth)/sso/loading'

export const metadata: Metadata = {
  title: 'Single Sign-On',
}

export const dynamic = 'force-dynamic'

export default async function SSOPage() {
  if (!isSsoEnabled) {
    redirect('/login')
  }

  return (
    <Suspense fallback={<SSOLoading />}>
      <SSOForm registrationDisabled={isRegistrationDisabled} />
    </Suspense>
  )
}
