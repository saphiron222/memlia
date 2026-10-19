// Modified by Memlia in 2026. Upstream Apache-2.0 license and notices retained.
import { Suspense } from 'react'
import { dehydrate, HydrationBoundary, type QueryClient } from '@tanstack/react-query'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { SettingsNavigationProvider } from '@/components/settings/settings-navigation-provider'
import type { WorkspaceHostContext } from '@/lib/api/contracts/workspaces'
import { getSession } from '@/lib/auth'
import { getActiveOrganizationId } from '@/lib/auth/session-response'
import { isChangelogEnabled } from '@/lib/changelog/feature-flag'
import { isComputerUseAvailable } from '@/lib/computer-use/availability.server'
import { isDashboardsEnabled } from '@/lib/dashboards/feature-flag'
import {
  hasDesktopBackgroundExecutor,
  isDesktopBackgroundExecutorAvailable,
} from '@/lib/desktop/executor/availability'
import { isMothershipModelSelectorEnabled, isPlanModeEnabled } from '@/lib/mothership/feature-flags'
import { resolveOrganizationEntryPath } from '@/lib/navigation/resolve-app-entry'
import { isProjectsEnabled } from '@/lib/projects/rollout.server'
import { isWorkflowTestsEnabled } from '@/lib/workflow-tests/feature-flag'
import { ApplicationLoading } from '@/app/_shell/application-loading'
import { getQueryClient } from '@/app/_shell/providers/get-query-client'
import { ImpersonationBanner } from '@/app/workspace/[workspaceId]/components/impersonation-banner'
import { SessionExpired } from '@/app/workspace/[workspaceId]/components/session-expired'
import { WorkspaceAccessDenied } from '@/app/workspace/[workspaceId]/components/workspace-access-denied'
import {
  WorkspaceChrome,
  WorkspaceViewport,
} from '@/app/workspace/[workspaceId]/components/workspace-chrome'
import {
  prefetchWorkspaceHostContext,
  prefetchWorkspaceSidebar,
} from '@/app/workspace/[workspaceId]/prefetch'
import { prefetchWorkspaceAccess } from '@/app/workspace/[workspaceId]/prefetch-access'
import { BlockVisibilityLoader } from '@/app/workspace/[workspaceId]/providers/block-visibility-loader'
import { CustomBlocksLoader } from '@/app/workspace/[workspaceId]/providers/custom-blocks-loader'
import { DesktopOAuthConnectListener } from '@/app/workspace/[workspaceId]/providers/desktop-oauth-connect-listener'
import { FeatureFlagsProvider } from '@/app/workspace/[workspaceId]/providers/feature-flags-provider'
import { GlobalCommandsProvider } from '@/app/workspace/[workspaceId]/providers/global-commands-provider'
import { ProviderModelsLoader } from '@/app/workspace/[workspaceId]/providers/provider-models-loader'
import { SettingsLoader } from '@/app/workspace/[workspaceId]/providers/settings-loader'
import { WorkspaceHostProvider } from '@/app/workspace/[workspaceId]/providers/workspace-host-provider'
import { WorkspacePermissionsProvider } from '@/app/workspace/[workspaceId]/providers/workspace-permissions-provider'
import { WorkspaceScopeSync } from '@/app/workspace/[workspaceId]/providers/workspace-scope-sync'
import { Sidebar } from '@/app/workspace/[workspaceId]/w/components/sidebar/sidebar'
import { getBrandConfig } from '@/lib/branding'

interface WorkspaceLayoutProps {
  children: React.ReactNode
  params: Promise<{ workspaceId: string }>
}

interface WorkspaceContentProps {
  children: React.ReactNode
  workspaceId: string
  session: NonNullable<Awaited<ReturnType<typeof getSession>>>
  queryClient: QueryClient
  hostContext: WorkspaceHostContext
}

export default async function WorkspaceLayout({ children, params }: WorkspaceLayoutProps) {
  const session = await getSession()
  if (!session?.user) {
    redirect('/login')
  }

  const { workspaceId } = await params
  const queryClient = getQueryClient()
  const hostContext = await prefetchWorkspaceHostContext(queryClient, workspaceId, session.user.id)
  if (!hostContext) {
    return <WorkspaceAccessDenied />
  }

  return (
    <Suspense fallback={<WorkspaceLoading />}>
      <WorkspaceContent
        workspaceId={workspaceId}
        session={session}
        queryClient={queryClient}
        hostContext={hostContext}
      >
        {children}
      </WorkspaceContent>
    </Suspense>
  )
}

function WorkspaceLoading() {
  const brand = getBrandConfig()
  return <ApplicationLoading brand={brand} />
}

async function WorkspaceContent({
  children,
  workspaceId,
  session,
  queryClient,
  hostContext,
}: WorkspaceContentProps) {
  const activeOrganizationId = getActiveOrganizationId(session)
  const principal = {
    kind: 'session',
    userId: session.user.id,
    sessionId: session.session.id,
  } as const
  const [
    cookieStore,
    ,
    modelSelectorEnabled,
    planModeEnabled,
    organizationHref,
    dashboardsEnabled,
    workflowTestsEnabled,
    changelogEnabled,
    desktopExecutorRegistered,
    computerUseEnabled,
    projectsEnabled,
  ] = await Promise.all([
    cookies(),
      prefetchWorkspaceSidebar(
      queryClient,
      workspaceId,
      session.user.id,
      hostContext,
      activeOrganizationId
    ),
    isMothershipModelSelectorEnabled(),
    isPlanModeEnabled(session.user.id).catch(() => false),
    resolveOrganizationEntryPath(session),
    isDashboardsEnabled(hostContext.hostOrganizationId),
    isWorkflowTestsEnabled(hostContext.hostOrganizationId),
    isChangelogEnabled(hostContext.hostOrganizationId),
    hasDesktopBackgroundExecutor(session.user.id),
    isComputerUseAvailable(hostContext.hostOrganizationId),
    isProjectsEnabled(),
    prefetchWorkspaceAccess(queryClient, workspaceId, principal),
  ])
  const initialSidebarCollapsed = cookieStore.get('sidebar_collapsed')?.value === '1'

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <FeatureFlagsProvider
        flags={{
          dashboards: dashboardsEnabled,
          'workflow-tests': workflowTestsEnabled,
          changelog: changelogEnabled,
          'mothership-model-selector': modelSelectorEnabled,
          'mothership-computer-use': computerUseEnabled,
          'mothership-plan-mode': planModeEnabled,
          projects: projectsEnabled,
        }}
      >
        <WorkspaceHostProvider workspaceId={workspaceId} initialContext={hostContext}>
            <DesktopOAuthConnectListener />
            <SettingsLoader />
            <ProviderModelsLoader />
            <CustomBlocksLoader />
            <BlockVisibilityLoader />
            <GlobalCommandsProvider>
              <WorkspaceViewport>
                <ImpersonationBanner />
                <SessionExpired />
                <WorkspacePermissionsProvider>
                  <WorkspaceScopeSync />
                  <SettingsNavigationProvider>
                    <WorkspaceChrome
                      sidebar={
                        <Sidebar
                          organizationHref={organizationHref}
                          desktopExecutor={{
                            available: isDesktopBackgroundExecutorAvailable(),
                            registered: desktopExecutorRegistered,
                          }}
                        />
                      }
                      initialSidebarCollapsed={initialSidebarCollapsed}
                    >
                      {children}
                    </WorkspaceChrome>
                  </SettingsNavigationProvider>
                </WorkspacePermissionsProvider>
              </WorkspaceViewport>
            </GlobalCommandsProvider>
        </WorkspaceHostProvider>
      </FeatureFlagsProvider>
    </HydrationBoundary>
  )
}
