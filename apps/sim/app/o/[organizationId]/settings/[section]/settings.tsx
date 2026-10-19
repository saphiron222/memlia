// Modified by Memlia in 2026. Upstream Apache-2.0 license and notices retained.
'use client'

import dynamic from 'next/dynamic'
import {
  getOrganizationSettingsHref,
  ORGANIZATION_SETTINGS_ITEMS,
  type OrganizationSettingsSection,
} from '@/components/settings/navigation'
import { SettingsSectionProvider } from '@/components/settings/settings-panel'
import { useOrganizationContext } from '@/app/o/[organizationId]/providers/organization-provider'

const KnowledgeGraphs = dynamic(() =>
  import('@/app/o/[organizationId]/settings/components/knowledge-graphs').then(
    (m) => m.KnowledgeGraphs
  )
)

const OrganizationRecentlyDeleted = dynamic(() =>
  import('@/app/o/[organizationId]/settings/components/organization-recently-deleted').then(
    (m) => m.OrganizationRecentlyDeleted
  )
)

const OrganizationIntegrationsSettings = dynamic(() =>
  import(
    '@/app/o/[organizationId]/settings/components/integrations/organization-integrations-settings'
  ).then((m) => m.OrganizationIntegrationsSettings)
)
const OrganizationSearchMcp = dynamic(() =>
  import('@/app/o/[organizationId]/settings/components/organization-search-mcp').then(
    (m) => m.OrganizationSearchMcp
  )
)
const OrganizationSearchSlack = dynamic(() =>
  import('@/app/o/[organizationId]/settings/components/organization-search-slack').then(
    (m) => m.OrganizationSearchSlack
  )
)

const TeamManagement = dynamic(() =>
  import('@/app/workspace/[workspaceId]/settings/components/team-management/team-management').then(
    (m) => m.TeamManagement
  )
)
const Billing = dynamic(() =>
  import('@/app/workspace/[workspaceId]/settings/components/billing/billing').then((m) => m.Billing)
)
const OrganizationSecuritySettings = dynamic(() =>
  import('@/components/settings/organization-security').then((m) => m.OrganizationSecuritySettings)
)

interface OrganizationSettingsProps {
  section: OrganizationSettingsSection
}

export function OrganizationSettings({ section }: OrganizationSettingsProps) {
  const { organization, viewer } = useOrganizationContext()
  const organizationId = organization.id
  const meta = ORGANIZATION_SETTINGS_ITEMS.find(({ id }) => id === section)

  return (
    <SettingsSectionProvider section={section} meta={meta}>
      {section === 'recently-deleted' && (
        <OrganizationRecentlyDeleted key={organizationId} organizationId={organizationId} />
      )}
      {section === 'knowledge-graphs' && <KnowledgeGraphs organizationId={organizationId} />}
      {section === 'integrations' && <OrganizationIntegrationsSettings />}
      
      {section === 'search-mcp' && <OrganizationSearchMcp />}
      {section === 'search-slack' && <OrganizationSearchSlack />}
      {section === 'members' && (
        <TeamManagement
          organizationId={organizationId}
          canInviteMembers={viewer.canInviteMembers}
          billingHref={getOrganizationSettingsHref(organizationId, 'billing')}
        />
      )}
      {section === 'billing' && <Billing scope='organization' organizationId={organizationId} />}
      
      
      
      
      
      {section === 'security' && <OrganizationSecuritySettings organizationId={organizationId} />}
      
      
      
    </SettingsSectionProvider>
  )
}
