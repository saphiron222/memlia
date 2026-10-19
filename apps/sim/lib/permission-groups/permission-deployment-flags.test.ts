// Copyright 2026 Memlia. All rights reserved.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.unmock('@/lib/core/config/env-flags')
vi.mock('@/lib/permission-groups/resolve.server', () => ({
 getUserPermissionConfig: async()=>null,
 getUserPermissionConfigForOrganization: async()=>null,
 mergeEnvAllowlist: ()=>null,
 resolveVerifiedUserAccessControlContext: async()=>({config:null}),
}))
vi.mock('@/lib/billing/organizations/membership',()=>({getUserOrganization:async()=>null}))
vi.mock('@/blocks/registry',()=>({getBlock:()=>undefined}))
vi.mock('@/providers/models',()=>({findProviderFromModel:()=>null}))
beforeEach(()=>{vi.resetModules();vi.stubEnv('DISABLE_PUBLIC_API','true');vi.stubEnv('DISABLE_INVITATIONS','true')})
it('server public API shutdown must deny even when no group restricts access',async()=>{
 const flags=await import('@/lib/core/config/env-flags')
 expect(flags.isPublicApiDisabled).toBe(true)
 const {validatePublicApiAllowed}=await import('@/lib/permission-groups/permission-check')
 await expect(validatePublicApiAllowed('billing-user','workspace')).rejects.toMatchObject({code:'forbidden'})
})
it('server invitation shutdown must deny even when no group restricts access',async()=>{
 const flags=await import('@/lib/core/config/env-flags')
 expect(flags.isInvitationsDisabled).toBe(true)
 const {validateInvitationsAllowed}=await import('@/lib/permission-groups/permission-check')
 await expect(validateInvitationsAllowed('admin','workspace')).rejects.toMatchObject({code:'forbidden'})
})

afterEach(() => vi.unstubAllEnvs())

it('preserves the native policy result when both deployment shutdown flags are off', async () => {
  vi.stubEnv('DISABLE_PUBLIC_API', 'false')
  vi.stubEnv('DISABLE_INVITATIONS', 'false')
  const flags = await import('@/lib/core/config/env-flags')
  expect(flags.isPublicApiDisabled).toBe(false)
  expect(flags.isInvitationsDisabled).toBe(false)
  const { validatePublicApiAllowed, validateInvitationsAllowed } = await import('@/lib/permission-groups/permission-check')
  await expect(validatePublicApiAllowed('user', 'workspace')).resolves.toBeUndefined()
  await expect(validateInvitationsAllowed('admin', { organizationId: 'organization' })).resolves.toBeUndefined()
})
it('keeps the deployment API shutdown effective for an actorless request', async () => {
  const { validatePublicApiAllowed } = await import('@/lib/permission-groups/permission-check')
  await expect(validatePublicApiAllowed(undefined, undefined)).rejects.toMatchObject({ code: 'forbidden' })
})
