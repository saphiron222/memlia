// Modified by Memlia: track confirmed diff actions independently of draft attestations.
import type { DiffAnalysis, WorkflowDiff } from '@/lib/workflows/diff'
import type { WorkflowState } from '../workflows/workflow/types'
import type { DiffObservation } from './utils'

/**
 * The lifecycle stage of the workflow diff overlay.
 *
 * @remarks
 * This is the single source of truth for the diff overlay. The legacy
 * `hasActiveDiff` / `isShowingDiff` / `isDiffReady` booleans are derived from
 * it via {@link deriveDiffFlags}, which makes contradictory combinations —
 * such as "showing a diff that has no active diff" — unrepresentable.
 *
 * - `none` — no diff staged; the canvas shows the live workflow.
 * - `staged` — a diff is staged and ready, but the canvas is showing the
 *   baseline (proposed changes hidden).
 * - `showing` — a diff is staged and ready, and the canvas is showing the
 *   proposed changes with diff markers.
 */
export type WorkflowDiffStatus = 'none' | 'staged' | 'showing'

export interface DiffAction {
  id: string
  workflowId: string
  phase: 'saving' | 'confirmed' | 'conflict' | 'unknown'
  intendedState: WorkflowState
  confirmed?: { revision: number; state: WorkflowState; observation: DiffObservation }
}

export interface DetachedDiff {
  id: string
  action: DiffAction | null
  baseline: WorkflowState | null
  error: string
  inFlight: boolean
  consultationRequest?: string
  consultation?: {
    revision: number
    state: WorkflowState
    observation: DiffObservation
    epoch: number
  }
}

export interface WorkflowDiffState {
  detachedDiffs: Record<string, DetachedDiff>
  action: DiffAction | null
  /** Lifecycle stage of the diff overlay; the source of truth for diff flags */
  status: WorkflowDiffStatus
  /** Derived from {@link status}: a diff is staged (`staged` or `showing`) */
  hasActiveDiff: boolean
  /** Derived from {@link status}: the canvas is rendering the proposed changes */
  isShowingDiff: boolean
  /** Derived from {@link status}: a staged diff is ready to view/toggle */
  isDiffReady: boolean
  baselineWorkflow: WorkflowState | null
  baselineWorkflowId: string | null
  diffAnalysis: DiffAnalysis | null
  diffMetadata: WorkflowDiff['metadata'] | null
  diffError?: string | null
  pendingExternalUpdates: Record<string, number>
  remoteUpdateVersions: Record<string, number>
  reconcilingWorkflows: Record<string, boolean>
  reconciliationErrors: Record<string, string>
  _triggerMessageId?: string | null
}

interface DiffActionOptions {
  /** Skip recording this operation for undo/redo. Used during undo/redo replay. */
  skipRecording?: boolean
  /** Legacy flag is rejected; persisted changes must use showPersistedChanges with an owned GET. */
  skipPersist?: boolean
  /**
   * Optional owned baseline. It must match the attested live source exactly.
   * Historical inverse baselines are retained only by a confirmed diff action.
   */
  baselineWorkflow?: WorkflowState
}

export interface WorkflowDiffActions {
  /** Returns a guard revoked by any later detach or identity reset. */
  detachDiffForWorkspaceChange: (
    sourceWorkflowId: string | null,
    destinationWorkspaceId: string
  ) => () => boolean
  detachDiffForNavigation: (sourceWorkflowId: string | null, destinationWorkflowId: string) => void
  consultDetachedDiff: (workflowId: string) => Promise<void>
  abandonDetachedDiff: (workflowId: string) => void
  showPersistedChanges: (workflowId: string) => Promise<void>
  setProposedChanges: (
    workflowState: WorkflowState,
    diffAnalysis?: DiffAnalysis,
    options?: DiffActionOptions
  ) => Promise<void>
  clearDiff: (options?: { restoreBaseline?: boolean }) => void
  toggleDiffView: () => void
  acceptChanges: (options?: DiffActionOptions) => Promise<void>
  rejectChanges: (options?: DiffActionOptions) => Promise<void>
  reapplyDiffMarkers: () => void
  markRemoteUpdateSeen: (workflowId: string) => void
  markExternalUpdatePending: (workflowId: string) => void
  clearExternalUpdatePending: (workflowId: string) => void
  setWorkflowReconciliationInProgress: (workflowId: string, isReconciling: boolean) => void
  setWorkflowReconciliationError: (workflowId: string, error: string | null) => void
  _batchedStateUpdate: (updates: Partial<WorkflowDiffState>) => void
}

/**
 * The {@link WorkflowDiffStatus} fields shared by `status` and its derived
 * booleans. Spread this into a state patch so the source of truth and the
 * legacy flags never drift apart.
 */
export type DiffStatusFlags = Pick<
  WorkflowDiffState,
  'status' | 'hasActiveDiff' | 'isShowingDiff' | 'isDiffReady'
>

/**
 * Computes the legacy `hasActiveDiff` / `isShowingDiff` / `isDiffReady`
 * booleans (plus the `status` itself) from a {@link WorkflowDiffStatus}.
 *
 * @remarks
 * Keeping the derived booleans on the stored state lets existing consumers
 * keep reading `state.hasActiveDiff` etc. unchanged while
 * {@link WorkflowDiffStatus} remains the single source of truth.
 */
export function deriveDiffFlags(status: WorkflowDiffStatus): DiffStatusFlags {
  return {
    status,
    hasActiveDiff: status !== 'none',
    isShowingDiff: status === 'showing',
    isDiffReady: status !== 'none',
  }
}
