// Modified by Memlia in 2026. Upstream Apache-2.0 license and notices retained.
'use client'
// Copyright 2026 Memlia. All rights reserved.
import { useQueryState } from 'nuqs'
import { useOrganizationContext } from '@/app/o/[organizationId]/providers/organization-provider'
import { connectedAccountsParam } from './search-params'

/** Existing connectors continue to work; the absent administrative UI must not provision accounts. */
export function OrganizationSlackAccountSetup() {
  const { viewer } = useOrganizationContext()
  const [provider, setProvider] = useQueryState(
    connectedAccountsParam.key,
    connectedAccountsParam.parser.withOptions({ history: 'replace' })
  )
  if (provider !== 'slack' || !viewer.isAdmin) return null
  return <div role='status' className='rounded border p-4'>
    <p>La configuration Slack administrée n’est pas encore disponible dans Memlia.</p>
    <button type='button' onClick={() => void setProvider(null)}>Fermer</button>
  </div>
}
