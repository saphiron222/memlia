// Modified by Memlia in 2026. Upstream Apache-2.0 license and notices retained.
// Copyright 2026 Memlia. All rights reserved.
/** @vitest-environment jsdom */
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DemoScheduler, resolveCalendarUrl } from './demo-scheduler'
afterEach(() => vi.unstubAllEnvs())
describe('lien explicite vers le calendrier administrateur', () => {
  it('refuse les destinations implicites, credentials et protocoles exécutables', () => {
    for (const value of [undefined, '', 'team/demo', 'javascript:alert(1)', 'https://user:password@example.com/demo']) {
      expect(resolveCalendarUrl(value)).toBeNull()
    }
    vi.stubEnv('NEXT_PUBLIC_CAL_LINK', '')
    expect(renderToStaticMarkup(<DemoScheduler />)).not.toContain('<a')
  })
  it('garde seulement origine et chemin, sans paramètres personnels ni fragment', () => {
    expect(resolveCalendarUrl('https://calendar.example.com/team/demo?email=ada%40example.com&name=Ada&notes=private#tracking')).toBe('https://calendar.example.com/team/demo')
  })
  it('rend un lien sans embed, preload, transmission ni tracker', () => {
    vi.stubEnv('NEXT_PUBLIC_CAL_LINK', 'https://calendar.example.com/team/demo')
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    const html = renderToStaticMarkup(<DemoScheduler />)
    expect(html).toContain('href="https://calendar.example.com/team/demo"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).toContain('referrerPolicy="no-referrer"')
    expect(html).not.toMatch(/<iframe|<script|<link|embed.js|email=/)
    expect(fetch).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
