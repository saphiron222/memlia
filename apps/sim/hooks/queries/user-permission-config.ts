// Copyright 2026 Memlia. All rights reserved.
import { useQuery } from '@tanstack/react-query'
import { permissionGroupKeys } from '@/hooks/queries/utils/permission-group-keys'
import { requestJson } from '@/lib/api/client/request'
import { getUserPermissionConfigContract } from '@/lib/api/contracts/permission-groups'

export function useUserPermissionConfig(workspaceId?: string) {
  return useQuery({
    queryKey: permissionGroupKeys.userConfig(workspaceId),
    enabled: Boolean(workspaceId),
    queryFn: ({ signal }) => {
      if (!workspaceId) throw new Error('Un espace est requis pour lire ses permissions.')
      return requestJson(getUserPermissionConfigContract, { query: { workspaceId }, signal })
    },
    staleTime: 0,
    retry: 1,
  })
}
