/** @vitest-environment jsdom */
// Copyright (c) 2026 Memlia. All rights reserved.
import { describe, expect, it, vi } from 'vitest'
import * as urls from '@/lib/core/utils/urls'
import { GET } from '@/app/excel-addin/manifest.xml/route'
import { createOfficeAddinManifest } from './manifest'

describe('Office manifest for the configured Memlia instance', () => {
  it('targets the native taskpane at the canonical HTTPS origin without account or lab data', () => {
    const xml = createOfficeAddinManifest('https://cabinet.example:8443/')
    const parsed = new DOMParser().parseFromString(xml, 'application/xml')
    expect(parsed.querySelector('parsererror')).toBeNull()
    expect(parsed.getElementsByTagName('SourceLocation')[0]?.getAttribute('DefaultValue')).toBe(
      'https://cabinet.example:8443/excel-addin'
    )
    expect(xml).toContain('<Host Name="Workbook"/>')
    expect(xml).toContain(
      '<SourceLocation DefaultValue="https://cabinet.example:8443/excel-addin"/>'
    )
    expect(xml).toContain('<Permissions>ReadWriteDocument</Permissions>')
    expect(xml).toContain('<Set Name="File" MinVersion="1.1"/>')
    expect(xml).toContain('<Set Name="CompressedFile" MinVersion="1.1"/>')
    expect(xml).not.toMatch(/localhost|taskpane.html|Memlia Lab|userId|token|secret/)
    expect(xml).toContain('<DefaultLocale>fr-FR</DefaultLocale>')
  })
  it.each([
    'http://cabinet.example',
    'https://user:secret@cabinet.example',
    'https://cabinet.example/prefix',
    'https://cabinet.example/?token=x',
    'https://cabinet.example/#identity',
    'not a URL',
  ])('refuses a non-canonical product URL: %s', (value) => {
    expect(() => createOfficeAddinManifest(value)).toThrow('office_manifest_url_refused')
  })
})

describe('configured manifest route', () => {
  it('serves the configured instance as XML with private no-store delivery', async () => {
    vi.spyOn(urls, 'getBaseUrl').mockReturnValue('https://cabinet.example')
    const response = GET()
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/xml; charset=utf-8')
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(await response.text()).toContain('https://cabinet.example/excel-addin')
  })
  it('refuses a missing HTTPS configuration without returning its contents', async () => {
    vi.spyOn(urls, 'getBaseUrl').mockReturnValue('http://invalid-private-fixture.example')
    const response = GET()
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'office_manifest_unavailable' })
  })
})
