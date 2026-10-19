// Modified by Memlia: preserve a restrictive local draft origin across storage; never an adoption ticket.
import { create } from 'zustand'
import { devtools, persist } from 'zustand/middleware'
import type { FileAttachmentForApi } from '@/app/workspace/[workspaceId]/home/types'
import type { ChatContext } from '@/stores/panel'

export interface DraftPayload {
  text: string
  /** Only true is valid. Persisted input is untrusted; every other present value blocks submission. */
  localOrigin?: unknown
  /** Committed URL query that an editable Search-tab draft belongs to. */
  searchQuery?: string
  fileAttachments?: FileAttachmentForApi[]
  contexts?: ChatContext[]
}

export function readDraftLocalOrigin(payload: unknown): 'none' | 'local' | 'invalid' {
  if (!payload || typeof payload !== 'object' || !Object.hasOwn(payload, 'localOrigin'))
    return 'none'
  const descriptor = Object.getOwnPropertyDescriptor(payload, 'localOrigin')
  return descriptor && 'value' in descriptor && descriptor.value === true ? 'local' : 'invalid'
}

/**
 * Draft keys are owned by the surface that renders the input, not by this
 * store. Workspace keys include `<workspaceId>:<chatId|'new'>` for the home chat and
 * `<workspaceId>:workflow-copilot:<workflowId>:<chatId|'new'>` for the workflow
 * panel. Organization keys include the user, organization, and chat or Search surface.
 */
interface MothershipDraftsState {
  drafts: Record<string, DraftPayload>
  setDraft: (key: string, payload: DraftPayload) => void
  clearDraft: (key: string) => void
  migrateDraft: (fromKey: string, toKey: string) => void
  reset: () => void
}

const LEGACY_WORKFLOW_COPILOT_KEY = /^[^:]+:workflow-copilot:[^:]+$/

/**
 * v0 keyed workflow-panel drafts by workflow alone. Those entries are no longer
 * readable by any surface, and nothing prunes a key that is never written
 * again, so drop them once rather than leave them in storage forever. Home
 * drafts are untouched — their key shape did not change.
 */
export function dropLegacyWorkflowCopilotDrafts(persistedState: unknown): {
  drafts: Record<string, DraftPayload>
} {
  const drafts = (persistedState as MothershipDraftsState | null)?.drafts
  if (!drafts) return { drafts: {} }
  const kept: Record<string, DraftPayload> = {}
  for (const [key, payload] of Object.entries(drafts)) {
    if (!LEGACY_WORKFLOW_COPILOT_KEY.test(key)) kept[key] = payload
  }
  return { drafts: kept }
}

function isEmpty(payload: DraftPayload): boolean {
  return (
    !payload.text &&
    payload.searchQuery === undefined &&
    !payload.fileAttachments?.length &&
    !payload.contexts?.length
  )
}

export const useMothershipDraftsStore = create<MothershipDraftsState>()(
  devtools(
    persist(
      (set) => ({
        drafts: {},
        reset: () => set({ drafts: {} }),
        setDraft: (key, payload) =>
          set((s) => {
            if (isEmpty(payload)) {
              if (!(key in s.drafts)) return s
              const { [key]: _, ...rest } = s.drafts
              return { drafts: rest }
            }
            // JSON omits undefined fields: retain a malformed present restriction as null.
            const stored =
              Object.hasOwn(payload, 'localOrigin') && payload.localOrigin === undefined
                ? { ...payload, localOrigin: null }
                : payload
            return { drafts: { ...s.drafts, [key]: stored } }
          }),
        migrateDraft: (fromKey, toKey) =>
          set((state) => {
            if (fromKey === toKey || !state.drafts[fromKey]) return state
            const { [fromKey]: draft, ...rest } = state.drafts
            return { drafts: { ...rest, [toKey]: rest[toKey] ?? draft } }
          }),
        clearDraft: (key) =>
          set((s) => {
            if (!(key in s.drafts)) return s
            const { [key]: _, ...rest } = s.drafts
            return { drafts: rest }
          }),
      }),
      {
        name: 'mothership-drafts:v1',
        version: 1,
        migrate: (persistedState, version) =>
          (version ?? 0) < 1 ? dropLegacyWorkflowCopilotDrafts(persistedState) : persistedState,
        partialize: (state) => ({ drafts: state.drafts }),
      }
    ),
    { name: 'mothership-drafts-store' }
  )
)
