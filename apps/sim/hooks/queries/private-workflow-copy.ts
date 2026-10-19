// Copyright 2026 Memlia. All rights reserved.
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { requestJson } from '@/lib/api/client/request'
import { internalPrivateCopyContract } from '@/app/api/workflows/[id]/private-copy/contracts'
import { invalidateWorkflowLists } from '@/hooks/queries/utils/invalidate-workflow-lists'

interface PrivateCopyVariables {
  sourceWorkflowId: string
  destinationWorkspaceId: string
  name: string
}

/** Browser-session copy only; never mutates or optimistically replaces the source. */
export function usePrivateWorkflowCopy() {
  const queryClient = useQueryClient()
  return useMutation({
    retry: false,
    mutationFn: async ({
      sourceWorkflowId,
      destinationWorkspaceId,
      name,
    }: PrivateCopyVariables) => {
      const { data } = await requestJson(internalPrivateCopyContract, {
        params: { id: sourceWorkflowId },
        query: {},
        body: { destinationWorkspaceId, name },
      })
      if (data.workspaceId !== destinationWorkspaceId || data.id === sourceWorkflowId) {
        throw new Error(
          'La réponse de création est incohérente. Vérifiez votre espace avant de réessayer.'
        )
      }
      return data
    },
    onSuccess: async (data) => {
      await invalidateWorkflowLists(queryClient, data.workspaceId)
    },
  })
}
