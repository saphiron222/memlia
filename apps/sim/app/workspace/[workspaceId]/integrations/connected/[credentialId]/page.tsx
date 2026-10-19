// Modified by Memlia in 2026. Upstream Apache-2.0 license and notices retained.
import type { Metadata } from 'next'
import { ConnectedCredentialDetail } from '@/app/workspace/[workspaceId]/integrations/connected/[credentialId]/connected-credential-detail'
import { PermissionAccessBoundary } from '@/components/permissions/access-boundary'

export const metadata: Metadata = {
  title: 'Connected Integration',
}

export default async function ConnectedCredentialPage({
  params,
}: {
  params: Promise<{ workspaceId: string; credentialId: string }>
}) {
  const { workspaceId, credentialId } = await params
  return (
    <PermissionAccessBoundary configKey='hideIntegrationsTab'>
      <ConnectedCredentialDetail workspaceId={workspaceId} credentialId={credentialId} />
    </PermissionAccessBoundary>
  )
}
