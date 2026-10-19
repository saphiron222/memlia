// Modified by Memlia: bind draft revision attestations to applied client snapshots.
import { createLogger } from '@sim/logger'
import { sleep } from '@sim/utils/helpers'
import { getQueryClient } from '@/app/_shell/providers/get-query-client'
import { fetchWorkflowEnvelope } from '@/hooks/queries/utils/fetch-workflow-envelope'
import { workflowKeys } from '@/hooks/queries/utils/workflow-keys'
import { useOperationQueueStore } from '@/stores/operation-queue/store'
import { useWorkflowDiffStore } from '@/stores/workflow-diff/store'
import { applyWorkflowStateToStores } from '@/stores/workflow-diff/utils'
import { useWorkflowRegistry } from '@/stores/workflows/registry/store'
import { useWorkflowStore } from '@/stores/workflows/workflow/store'
import type { DraftSyncVersions, WorkflowState } from '@/stores/workflows/workflow/types'

const logger = createLogger('SyncLocalDraft')

/**
 * A remote collaborator's edit applied mid-fetch means the fetched snapshot may
 * predate that edit's persist (the realtime server debounces writes), so the
 * sync refetches. After the bounded retry budget, preserve the graph already
 * updated by broadcasts rather than overwrite it with an older snapshot.
 */
const MAX_SYNC_FETCH_ATTEMPTS = 3
const SYNC_RETRY_DELAY_MS = 50

/**
 * Version vector describing everything that can move workflow state under a
 * full-state snapshot while it is being fetched or held:
 * - `localOperation`: local edits enqueued (operation queue)
 * - `remoteApply`: remote collaborator ops applied to the stores
 * - `remoteUpdate`: external full reloads (workflow-updated / revert)
 */
export type { DraftSyncVersions } from '@/stores/workflows/workflow/types'

/** Captures the current {@link DraftSyncVersions} for a workflow. */
export function captureDraftVersions(workflowId: string): DraftSyncVersions {
  const queueState = useOperationQueueStore.getState()
  return {
    localOperation: queueState.workflowOperationVersions[workflowId] ?? 0,
    remoteApply: queueState.remoteApplyVersions[workflowId] ?? 0,
    remoteUpdate: useWorkflowDiffStore.getState().remoteUpdateVersions[workflowId] ?? 0,
  }
}

/**
 * Hard guards shared by every snapshot application: the workflow is still
 * active, nothing local is pending or was enqueued since capture, no diff or
 * reconciliation is in progress, and no external full reload
 * (workflow-updated / revert) landed since capture. Remote collaborator ops
 * (`remoteApply`) are deliberately NOT part of this core — the sync loop
 * treats them as a refetch signal rather than a refusal.
 */
function canApplyServerSnapshot(
  workflowId: string,
  expected: Pick<DraftSyncVersions, 'localOperation' | 'remoteUpdate'>,
  requireActive = true
): boolean {
  if (requireActive && useWorkflowRegistry.getState().activeWorkflowId !== workflowId) return false
  const operationQueueState = useOperationQueueStore.getState()
  if (operationQueueState.hasPendingOperations(workflowId)) return false
  if (
    (operationQueueState.workflowOperationVersions[workflowId] ?? 0) !== expected.localOperation
  ) {
    return false
  }

  const diffState = useWorkflowDiffStore.getState()
  return (
    !diffState.hasActiveDiff &&
    !diffState.pendingExternalUpdates[workflowId] &&
    !diffState.reconcilingWorkflows[workflowId] &&
    !diffState.reconciliationErrors[workflowId] &&
    (diffState.remoteUpdateVersions[workflowId] ?? 0) === expected.remoteUpdate
  )
}

/**
 * Whether a full-state snapshot captured alongside `versions` may still be
 * applied. Unlike the sync loop — which refetches when remote collaborator
 * ops land mid-fetch — this treats a `remoteApply` movement as a hard
 * refusal, because callers holding a fixed snapshot (e.g. the raw join-state
 * fallback) cannot refetch a fresher one.
 */
export function canApplyDraftSnapshot(workflowId: string, versions: DraftSyncVersions): boolean {
  return (
    canApplyServerSnapshot(workflowId, versions) &&
    (useOperationQueueStore.getState().remoteApplyVersions[workflowId] ?? 0) ===
      versions.remoteApply
  )
}

/** Hydration owns its request-id guard; it must still respect draft activity. */
export function canApplyHydrationSnapshot(
  workflowId: string,
  versions: DraftSyncVersions
): boolean {
  return (
    canApplyServerSnapshot(workflowId, versions, false) &&
    (useOperationQueueStore.getState().remoteApplyVersions[workflowId] ?? 0) ===
      versions.remoteApply
  )
}

/** No ACK or local version counter can substitute for a server revision. */
export function getAttestedDraftRevision(workflowId: string): number | null {
  const state = useWorkflowStore.getState()
  const attestation = state.draftRevisionAttestation
  return attestation &&
    state.currentWorkflowId === workflowId &&
    attestation.workflowId === workflowId &&
    canApplyDraftSnapshot(workflowId, attestation.versions)
    ? attestation.revision
    : null
}

/** Synchronous final guard: never recapture versions to justify an older raw payload. */
export function applyRawDraftSnapshot(
  workflowId: string,
  state: WorkflowState,
  revision: unknown,
  versions: DraftSyncVersions
): boolean {
  if (
    !Object.hasOwn(state, 'variables') ||
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    !canApplyDraftSnapshot(workflowId, versions)
  )
    return false
  applyWorkflowStateToStores(
    workflowId,
    { ...state, currentWorkflowId: workflowId },
    {
      draftRevisionAttestation: { workflowId, revision, versions },
    }
  )
  return true
}

/** Join payload ownership is captured before HTTP can yield to newer local/remote work. */
export async function syncSocketDraftFromSnapshot(snapshot: {
  id: string
  draftRevision: unknown
  state: WorkflowState
  variables?: WorkflowState['variables'] | null
}): Promise<boolean> {
  const workflowId = snapshot.id
  const revision = Object.hasOwn(snapshot, 'variables') ? snapshot.draftRevision : undefined
  const versions = captureDraftVersions(workflowId)
  const rawState = {
    ...structuredClone(snapshot.state),
    ...(Object.hasOwn(snapshot, 'variables')
      ? { variables: structuredClone(snapshot.variables ?? {}) }
      : {}),
  }
  try {
    return await syncLocalDraftFromServer(workflowId)
  } catch (error) {
    // Degraded path only: the primary HTTP path applies app block migrations.
    logger.warn('Join-state HTTP sync failed; checking raw fallback', { workflowId, error })
    return applyRawDraftSnapshot(workflowId, rawState, revision, versions)
  }
}

/**
 * Reconciles the local Zustand stores with the server's current draft by
 * fetching migrated state over HTTP and applying it — used after deploys and
 * on socket join, where the realtime server can only supply raw (unmigrated)
 * state.
 *
 * Fetches through the shared `workflowKeys.state(id)` React Query entry
 * (always-fresh, in-flight deduped), so a sync racing the registry hydration
 * coalesces into a single request and the cache stays warm.
 *
 * Refuses to apply (returns false) when the session is busy — pending or
 * newly-queued local operations, an active copilot diff, in-progress
 * reconciliation, a newer remote update during the fetch, or navigation away —
 * so it never clobbers in-flight work. A remote collaborator's op applied
 * during the fetch triggers a bounded refetch instead (the snapshot may
 * predate that op's persist). Throws when the fetch itself fails.
 */
export async function syncLocalDraftFromServer(workflowId: string): Promise<boolean> {
  if (useWorkflowRegistry.getState().activeWorkflowId !== workflowId) return false
  if (useOperationQueueStore.getState().hasPendingOperations(workflowId)) return false
  const versionsAtStart = captureDraftVersions(workflowId)

  let snapshotVersions = versionsAtStart
  let envelope: Awaited<ReturnType<typeof fetchWorkflowEnvelope>> | undefined
  for (let attempt = 1; ; attempt++) {
    const remoteApplyVersionAtStart =
      useOperationQueueStore.getState().remoteApplyVersions[workflowId] ?? 0

    envelope = await getQueryClient().fetchQuery({
      queryKey: workflowKeys.state(workflowId),
      queryFn: ({ signal }) => fetchWorkflowEnvelope(workflowId, signal),
      staleTime: 0,
    })

    if (!canApplyServerSnapshot(workflowId, versionsAtStart)) {
      return false
    }

    const remoteOpAppliedDuringFetch =
      (useOperationQueueStore.getState().remoteApplyVersions[workflowId] ?? 0) !==
      remoteApplyVersionAtStart
    if (!remoteOpAppliedDuringFetch) {
      snapshotVersions = { ...versionsAtStart, remoteApply: remoteApplyVersionAtStart }
      break
    }

    if (attempt >= MAX_SYNC_FETCH_ATTEMPTS) {
      logger.info('Keeping current draft after concurrent remote ops exhausted snapshot retries', {
        workflowId,
        attempts: attempt,
      })
      return false
    }
    await sleep(SYNC_RETRY_DELAY_MS)
  }

  const wireState = envelope?.state
  if (
    !envelope ||
    !wireState ||
    !Number.isSafeInteger(envelope.draftRevision) ||
    envelope.draftRevision < 0
  ) {
    throw new Error('No workflow state was returned while syncing the local draft')
  }

  // Copy before annotating: the envelope is the shared React Query cache entry
  // and must not be mutated.
  const draftState = Object.hasOwn(envelope, 'variables')
    ? { ...wireState, variables: envelope.variables || {} }
    : { ...wireState }
  // double-cast-allowed: workflowStateSchema is a wire supertype; normalized workflow state is persisted in store-compatible shape
  const workflowState = draftState as unknown as WorkflowState
  applyWorkflowStateToStores(
    workflowId,
    { ...workflowState, currentWorkflowId: workflowId },
    {
      updateLastSaved: true,
      ...(Object.hasOwn(envelope, 'variables')
        ? {
            draftRevisionAttestation: {
              workflowId,
              revision: envelope.draftRevision,
              versions: snapshotVersions,
            },
          }
        : {}),
    }
  )
  return true
}
