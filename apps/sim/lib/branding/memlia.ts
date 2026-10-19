// Copyright 2026 Memlia. All rights reserved.
// Fixed product identity; implemented independently from upstream Enterprise code.
import type { Metadata } from 'next'
import { defaultBrandConfig } from './defaults'
import type { BrandConfig } from './types'

export function getBrandConfig(): BrandConfig {
  return { ...defaultBrandConfig, theme: { ...defaultBrandConfig.theme } }
}

// Client consumers share the same fixed identity; no organization lookup or override.
export const useBrandConfig = getBrandConfig

export function generateBrandedMetadata(): Metadata {
  const brand = getBrandConfig()
  return {
    title: { default: brand.name, template: `%s | ${brand.name}` },
    applicationName: brand.name,
    description: 'Votre espace de travail pour les agents et les automatisations.',
    icons: { icon: brand.faviconUrl! },
  }
}

export function generateThemeCSS(): string {
  return ''
}
