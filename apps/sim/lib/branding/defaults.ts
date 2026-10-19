// Modified by Memlia in 2026. Upstream Apache-2.0 license and notices retained.
import type { BrandConfig } from './types'

/**
 * Default brand configuration values
 */
export const defaultBrandConfig: BrandConfig = {
  name: 'Memlia',
  logoUrl: '/brand/memlia-mark.svg',
  wordmarkUrl: '/brand/memlia-wordmark.svg',
  faviconUrl: '/brand/memlia-mark.svg',
  customCssUrl: undefined,
  supportEmail: undefined,
  documentationUrl: undefined,
  termsUrl: undefined,
  privacyUrl: undefined,
  theme: {
    primaryColor: '#33c482',
    primaryHoverColor: '#2dac72',
    accentColor: '#33b4ff',
    accentHoverColor: '#29a0e8',
    backgroundColor: '#0c0c0c',
  },
  isWhitelabeled: true,
}
