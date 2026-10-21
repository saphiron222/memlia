// Copyright 2026 Memlia. All rights reserved.
import { useEffect, useRef, useState } from 'react'
import { generateId } from '@sim/utils/id'
import { useRouter } from 'next/navigation'
import { requestJson } from '@/lib/api/client/request'
import {
  localCapabilitiesContract,
  localCapabilitiesResponse,
} from '@/app/api/copilot/capabilities/contracts'
import { useWorkspacePermissionsContext } from '@/app/workspace/[workspaceId]/providers/workspace-permissions-provider'
import { useLocalChatCapabilities } from '@/hooks/queries/local-chat-capabilities'
import { useCreateWorkflow } from '@/hooks/queries/workflows'
import { useMothershipDraftsStore } from '@/stores/mothership-drafts/store'
import { usePanelStore } from '@/stores/panel/store'

const REFUSED = 'Création interrompue. Votre brouillon reste ici. Aucun message n’a été envoyé.'
const CREATED =
  'Le workflow a été créé, mais son Chat n’est plus prêt. Votre brouillon reste ici. Aucun message n’a été envoyé.'

/** Prepare a draft, never a queued send or an adoption ticket. Server authorization remains authoritative. */
export function useCreateWorkflowDraft(scope: {
  workspaceId: string
  userId?: string
  enabled: boolean
}) {
  const router = useRouter()
  const mutation = useCreateWorkflow()
  const capabilities = useLocalChatCapabilities({
    userId: scope.userId,
    workspaceId: scope.workspaceId,
  })
  const { userPermissions } = useWorkspacePermissionsContext()
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const mounted = useRef(false)
  const busy = useRef(false)
  // Once a mutation was issued, an uncertain response must not cause an automatic second creation.
  const attempted = useRef(false)
  const current = useRef({ ...scope, capabilities, userPermissions })
  current.current = { ...scope, capabilities, userPermissions }
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const read = () => {
    const now = current.current
    const observed = now.capabilities.read()
    const parsed = localCapabilitiesResponse.safeParse(observed.profile)
    if (
      !now.enabled ||
      !now.userId ||
      !now.workspaceId ||
      !now.userPermissions.canEdit ||
      now.userPermissions.isLoading ||
      now.userPermissions.error ||
      observed.status !== 'ready' ||
      !parsed.success
    )
      return null
    const profile = parsed.data
    if (
      profile.backend !== 'local' ||
      profile.workspaceId !== now.workspaceId ||
      profile.workflowId !== undefined ||
      profile.requestSupported ||
      profile.currentWorkflowReference !== 'unavailable'
    )
      return null
    return {
      userId: now.userId,
      workspaceId: now.workspaceId,
      profile,
      token: JSON.stringify([now.userId, now.workspaceId, profile]),
    }
  }
  const create = async (text: string, isCurrent: () => boolean): Promise<boolean> => {
    const initial = read()
    if (
      !mounted.current ||
      busy.current ||
      attempted.current ||
      !initial ||
      !text.trim() ||
      new TextEncoder().encode(text).byteLength > 64 * 1024 ||
      !isCurrent()
    )
      return false
    busy.current = true
    attempted.current = true
    setPending(true)
    setMessage(null)
    let created = false
    const stillCurrent = () => mounted.current && read()?.token === initial.token && isCurrent()
    try {
      const workflow = await mutation.mutateAsync({
        workspaceId: initial.workspaceId,
        id: generateId(),
        deduplicate: true,
      })
      created = true
      if (!stillCurrent() || workflow.workspaceId !== initial.workspaceId || !workflow.id)
        throw new Error('Draft transition refused')
      const profile = localCapabilitiesResponse.parse(
        await requestJson(localCapabilitiesContract, {
          query: { workspaceId: initial.workspaceId, workflowId: workflow.id },
        })
      )
      const expected = {
        ...initial.profile,
        workflowId: workflow.id,
        requestSupported: true,
        currentWorkflowReference: 'implicit',
      }
      // Parse both through the same strict schema; JSON key order is then canonical for this contract.
      if (
        !stillCurrent() ||
        JSON.stringify(profile) !== JSON.stringify(localCapabilitiesResponse.parse(expected))
      )
        throw new Error('Draft transition refused')
      const key = `${initial.workspaceId}:workflow-copilot:${workflow.id}:new`
      const drafts = useMothershipDraftsStore.getState()
      if (drafts.drafts[key]) throw new Error('Draft transition refused')
      drafts.setDraft(key, { text, localOrigin: true })
      // A synchronous store subscriber can navigate or revoke the local observation.
      if (!stillCurrent()) throw new Error('Draft transition refused')
      usePanelStore.getState().setActiveTab('copilot')
      if (!stillCurrent()) throw new Error('Draft transition refused')
      usePanelStore.getState().setIsMobilePanelOpen(true)
      if (!stillCurrent()) throw new Error('Draft transition refused')
      router.push(`/workspace/${initial.workspaceId}/w/${workflow.id}`)
      return true
    } catch {
      if (mounted.current) setMessage(created ? CREATED : REFUSED)
      return false
    } finally {
      busy.current = false
      if (mounted.current) setPending(false)
    }
  }
  return { available: Boolean(read()) && !attempted.current, pending, message, create }
}
