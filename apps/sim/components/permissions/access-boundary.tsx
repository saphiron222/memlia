// Copyright 2026 Memlia. All rights reserved.
'use client'
import type { ReactNode } from 'react'
import { useParams } from 'next/navigation'
import type { BooleanPermissionGroupConfigKey } from '@/lib/permission-groups/features'
import { useUserPermissionConfig } from '@/hooks/queries/user-permission-config'

/** Visibility only: the Apache authorization funnel remains authoritative on the server. */
export function PermissionAccessBoundary({ configKey, children }: { configKey: BooleanPermissionGroupConfigKey; children?: ReactNode }) {
  const params = useParams()
  const workspaceId = typeof params?.workspaceId === 'string' ? params.workspaceId : undefined
  const query = useUserPermissionConfig(workspaceId)
  if (!query.isSuccess || !query.data) return <p role='status'>Vérification des permissions…</p>
  if (query.data.config?.[configKey]) return <p role='alert'>Cette fonctionnalité n’est pas autorisée dans cet espace.</p>
  return children
}
