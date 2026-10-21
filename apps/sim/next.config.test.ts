// Modified by Memlia: verify the native compiler's standalone declaration tracing.
import { existsSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { unstable_getResponseFromNextConfig } from 'next/experimental/testing/server'
import { describe, expect, it } from 'vitest'
import nextConfig from '@/next.config'

describe('Office desktop build-time headers', () => {
  it('uses the exact taskpane override after generic headers', async () => {
    const response = await unstable_getResponseFromNextConfig({
      url: 'https://memlia.test/excel-addin',
      nextConfig,
    })
    expect(response.headers.get('Content-Security-Policy')).toContain(
      'https://officeapis.public.onecdn.static.microsoft'
    )
    expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'self'")
    expect(response.headers.get('Cross-Origin-Embedder-Policy')).toBe('unsafe-none')
    expect(response.headers.get('X-Frame-Options')).toBe('SAMEORIGIN')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  it.each([
    '/excel-addin-other',
    '/excel-addin/manifest.xml',
    '/api/workspaces/w/excel/office-backups',
  ])('leaves other policies unchanged for %s', async (path) => {
    const response = await unstable_getResponseFromNextConfig({
      url: `https://memlia.test${path}`,
      nextConfig,
    })
    expect(response.headers.get('Content-Security-Policy') ?? '').not.toContain(
      'officeapis.public.onecdn.static.microsoft'
    )
  })
})

describe('Next.js server dependency packaging', () => {
  it('keeps pdfjs external to the production server bundle', () => {
    expect(nextConfig.serverExternalPackages).toContain('pdfjs-dist')
    expect(nextConfig.serverExternalPackages).toContain('@napi-rs/canvas')
  })
})

it('keeps the actual hoisted Function compiler libraries in standalone traces', () => {
  const app = createRequire(path.join(process.cwd(), 'package.json'))
  const compiler = app('@typescript/typescript6') as typeof import('@typescript/typescript6')
  const library = compiler.getDefaultLibFilePath({ target: compiler.ScriptTarget.ES2023 })
  expect(existsSync(library)).toBe(true)
  expect(path.dirname(library)).toBe(
    realpathSync(path.resolve(process.cwd(), '../../node_modules/@typescript/old/lib'))
  )
  expect(path.basename(library)).toMatch(/^lib\..*\.d\.ts$/)
  expect(nextConfig.serverExternalPackages).toContain('@typescript/typescript6')
  expect(nextConfig.outputFileTracingIncludes?.['/*']).toContain(
    '../../node_modules/@typescript/old/lib/lib.*.d.ts'
  )
})
