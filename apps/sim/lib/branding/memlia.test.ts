// Copyright 2026 Memlia. All rights reserved.
import { describe, expect, test } from 'vitest'
import { generateBrandedMetadata, generateThemeCSS, getBrandConfig, useBrandConfig } from './index'

describe('identité fixe Memlia', () => {
  test('sert la même identité locale au serveur et au client', () => {
    const brand = getBrandConfig()
    expect(brand.name).toBe('Memlia')
    expect(brand.logoUrl).toBe('/brand/memlia-mark.svg')
    expect(brand.wordmarkUrl).toBe('/brand/memlia-wordmark.svg')
    expect(brand.isWhitelabeled).toBe(true)
    expect(useBrandConfig()).toEqual(brand)
    expect(JSON.stringify(brand)).not.toMatch(/sim\.ai|simstudio/)
  })
  test('isole les mutations d’un consommateur', () => {
    const brand = getBrandConfig()
    brand.name = 'Un autre nom'
    brand.theme!.primaryColor = '#000000'
    expect(getBrandConfig().name).toBe('Memlia')
    expect(getBrandConfig().theme!.primaryColor).toBe('#33c482')
  })
  test('utilise des métadonnées et ressources locales', () => {
    expect(generateBrandedMetadata()).toMatchObject({
      title: { default: 'Memlia', template: '%s | Memlia' },
      applicationName: 'Memlia',
      icons: { icon: '/brand/memlia-mark.svg' },
    })
  })
  test('conserve le thème CSS natif sans injecter de CSS organisationnel', () => {
    expect(generateThemeCSS()).toBe('')
  })
})
