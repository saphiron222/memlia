// Modified by Memlia in 2026. Upstream Apache-2.0 license and notices retained.
/** @vitest-environment jsdom */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ admin: true, close: vi.fn(), prepare: vi.fn() }))
vi.mock('nuqs', () => ({ useQueryState: () => ['slack', mocks.close] }))
vi.mock('@/app/o/[organizationId]/providers/organization-provider', () => ({ useOrganizationContext: () => ({ organization: {id:'org'},viewer:{isAdmin:mocks.admin} }) }))
vi.mock('@/hooks/queries/organization-accounts', () => ({useOrganizationAccounts: vi.fn(),useEnsureOrganizationAccounts: mocks.prepare}))
import { OrganizationSlackAccountSetup } from './slack-account-setup'
it('reports unavailable administrative setup without preparing credentials', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container=document.createElement('div'); const root=createRoot(container)
  await act(async()=>root.render(<OrganizationSlackAccountSetup />))
  expect(container.textContent).toContain('configuration Slack')
  expect(mocks.prepare).not.toHaveBeenCalled()
  mocks.admin=false
  await act(async()=>root.render(<OrganizationSlackAccountSetup />))
  expect(container.textContent).toBe('')
  await act(async()=>root.unmount())
})
