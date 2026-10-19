// Copyright 2026 Memlia. All rights reserved.
import { describe, expect, it } from 'vitest'
import { MEMLIA_CONSENT_POLICY } from './memlia-policy'

describe('consentement local Memlia', () => {
  it('ne configure ni serveur amont ni script marketing', () => {
    expect(MEMLIA_CONSENT_POLICY).toEqual({ mode: 'offline', scripts: [] })
  })
})
