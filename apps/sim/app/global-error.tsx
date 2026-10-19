// Modified by Memlia in 2026. Upstream Apache-2.0 license and notices retained.
'use client'

import { Chip, StatusPageContent } from '@sim/emcn'
import { inter } from '@/app/_styles/fonts/inter/inter'
import { LogoShell } from '@/app/(landing)/components/logo-shell'
import '@/app/_styles/globals.css'

interface GlobalErrorProps {
  error: Error & { digest?: string }
  reset: () => void
}

export default function GlobalError({ reset }: GlobalErrorProps) {
  return (
    <html lang='en' className='light'>
      <body className={`${inter.variable} font-sans`}>
        <LogoShell center>
          <StatusPageContent
            title='Something went wrong'
            description='An unexpected error occurred. Please try again.'
          >
            <Chip variant='primary' onClick={reset}>
              Try again
            </Chip>
          </StatusPageContent>
        </LogoShell>
      </body>
    </html>
  )
}
