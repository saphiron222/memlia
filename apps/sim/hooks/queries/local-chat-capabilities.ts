// Copyright 2026 Memlia. All rights reserved.
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { requestJson } from '@/lib/api/client/request'
import {
  type LocalCapabilities,
  localCapabilitiesContract,
  localCapabilitiesResponse,
} from '@/app/api/copilot/capabilities/contracts'

export interface LocalChatPresentation {
  backend: 'loading' | 'unavailable' | 'legacy' | 'local'
  message: string | null
  blocked: boolean
  model?: string
  settings?: string
  adopted: boolean
  adopt: () => void
}
export type LocalProfileObservation = {
  status: 'loading' | 'unavailable' | 'ready'
  scopeKey: string
  profile?: LocalCapabilities
}

export function useLocalChatCapabilities(scope: {
  userId?: string
  workspaceId?: string
  workflowId?: string
}) {
  const { userId, workspaceId, workflowId } = scope
  const client = useQueryClient()
  const queryKey = ['local-chat-capabilities', userId, workspaceId, workflowId] as const
  const scopeKey = JSON.stringify(queryKey)
  const enabled = Boolean(userId && workspaceId)
  useQuery({
    queryKey,
    enabled,
    queryFn: ({ signal }) => {
      if (!workspaceId || !userId) throw new Error('Chat profile unavailable')
      return requestJson(localCapabilitiesContract, {
        query: { workspaceId, ...(workflowId ? { workflowId } : {}) },
        signal,
      })
    },
    staleTime: 0,
    retry: false,
  })
  // Read the query state again at the send boundary, not only the React render.
  const read = (): LocalProfileObservation => {
    if (!enabled) return { status: 'unavailable', scopeKey }
    const state = client.getQueryState(queryKey)
    if (state?.fetchStatus !== 'idle' || state?.status === 'pending' || !state) {
      return { status: 'loading', scopeKey }
    }
    const parsed = localCapabilitiesResponse.safeParse(state.data)
    if (state.status !== 'success' || !parsed.success) return { status: 'unavailable', scopeKey }
    const profile = parsed.data
    if (
      profile.backend === 'unavailable' ||
      (profile.backend === 'local' &&
        (profile.workspaceId !== workspaceId || profile.workflowId !== workflowId))
    ) {
      return { status: 'unavailable', scopeKey }
    }
    return { status: 'ready', scopeKey, profile }
  }
  return { ...read(), read }
}
