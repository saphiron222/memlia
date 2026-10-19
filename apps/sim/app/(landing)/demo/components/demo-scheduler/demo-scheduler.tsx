// Modified by Memlia in 2026. Upstream Apache-2.0 license and notices retained.
'use client'
// Copyright 2026 Memlia. All rights reserved.

/** Only an explicitly configured absolute destination is used, without personal query data. */
export function resolveCalendarUrl(configuredLink?: string): string | null {
  if (!configuredLink?.trim()) return null
  try {
    const url = new URL(configuredLink.trim())
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}

export function DemoScheduler() {
  const calendarUrl = resolveCalendarUrl(process.env.NEXT_PUBLIC_CAL_LINK)
  if (!calendarUrl) return <p>Le calendrier de démonstration n’est pas configuré.</p>
  return (
    <div className='flex h-full min-w-0 flex-col gap-4 p-6 max-sm:p-5'>
      <h2 className='text-[var(--text-primary)] text-xl'>Choisir un créneau</h2>
      <p className='text-[var(--text-secondary)] text-sm'>Ouvrez le calendrier configuré par votre administrateur pour prendre rendez-vous.</p>
      <a href={calendarUrl} target='_blank' rel='noopener noreferrer' referrerPolicy='no-referrer' className='underline'>Ouvrir le calendrier</a>
    </div>
  )
}
