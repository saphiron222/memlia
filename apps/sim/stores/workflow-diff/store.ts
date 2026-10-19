// Modified by Memlia: persist diff intentions once with CAS, then reconcile exact snapshots.
import { createLogger } from '@sim/logger'
import { omit } from '@sim/utils/object'
import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import { ApiClientError } from '@/lib/api/client/errors'
import { requestJson } from '@/lib/api/client/request'
import { getWorkflowNormalizedStateContract } from '@/lib/api/contracts/workflows'
import { stripWorkflowDiffMarkers, WorkflowDiffEngine } from '@/lib/workflows/diff'
import { Serializer } from '@/serializer'
import { registerUserDataReset } from '@/stores/user-data-reset-registry'
import { useWorkflowRegistry } from '../workflows/registry/store'
import { getAttestedDraftRevision } from '../workflows/sync-local-draft'
import { useWorkflowStore } from '../workflows/workflow/store'
import type { WorkflowState } from '../workflows/workflow/types'
import { deriveDiffFlags, type WorkflowDiffActions, type WorkflowDiffState } from './types'
import {
  applyWorkflowStateToStores,
  assertDiffObservation,
  assertExactDiffSnapshot,
  captureBaselineSnapshot,
  captureDiffObservation,
  cloneWorkflowState,
  createBatchedUpdater,
  diffSnapshotFingerprint,
  observeAppliedDiff,
  persistWorkflowStateToServer,
  WORKFLOW_DIFF_SETTLED_EVENT,
} from './utils'

const logger = createLogger('WorkflowDiffStore')
const diffEngine = new WorkflowDiffEngine()

/**
 * Canonical state patch that clears the diff overlay back to `none`: the
 * none-derived flags plus a wipe of all diff payload fields.
 */
export const RESET_DIFF_STATE = {
  ...deriveDiffFlags('none'),
  action: null,
  baselineWorkflow: null,
  baselineWorkflowId: null,
  diffAnalysis: null,
  diffMetadata: null,
  diffError: null,
  _triggerMessageId: null,
} as const

/**
 * Detects when a diff contains no meaningful changes.
 */
function isEmptyDiffAnalysis(
  diffAnalysis?: {
    new_blocks?: string[]
    edited_blocks?: string[]
    deleted_blocks?: string[]
    field_diffs?: Record<string, { changed_fields: string[] }>
    edge_diff?: { new_edges?: string[]; deleted_edges?: string[] }
  } | null
): boolean {
  if (!diffAnalysis) return false
  const hasBlockChanges =
    (diffAnalysis.new_blocks?.length || 0) > 0 ||
    (diffAnalysis.edited_blocks?.length || 0) > 0 ||
    (diffAnalysis.deleted_blocks?.length || 0) > 0
  const hasEdgeChanges =
    (diffAnalysis.edge_diff?.new_edges?.length || 0) > 0 ||
    (diffAnalysis.edge_diff?.deleted_edges?.length || 0) > 0
  const hasFieldChanges = Object.values(diffAnalysis.field_diffs || {}).some(
    (diff) => (diff?.changed_fields?.length || 0) > 0
  )
  return !hasBlockChanges && !hasEdgeChanges && !hasFieldChanges
}

function notifyDiffSettled(workflowId: string | null | undefined): void {
  if (!workflowId || typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(WORKFLOW_DIFF_SETTLED_EVENT, { detail: { workflowId } }))
}

export const useWorkflowDiffStore = create<WorkflowDiffState & WorkflowDiffActions>()(
  devtools(
    (set, get) => {
      const batchedUpdate = createBatchedUpdater(set)
      let displayEpoch = 0
      const runningActions = new Set<string>()
      registerUserDataReset('workflow-diff', () => {
        displayEpoch += 1
        batchedUpdate.cancel()
        runningActions.clear()
        diffEngine.clearDiff()
        set({
          ...RESET_DIFF_STATE,
          detachedDiffs: {},
          pendingExternalUpdates: {},
          remoteUpdateVersions: {},
          reconcilingWorkflows: {},
          reconciliationErrors: {},
        })
      })

      // The caller captures the source before resetting identities. Never recover an
      // owner from a null source: that would authorize an unrelated late transition.
      function detachDisplay(sourceWorkflowId: string | null): () => boolean {
        if (sourceWorkflowId !== useWorkflowRegistry.getState().activeWorkflowId) return () => false
        const current = get()
        const owner = current.action?.workflowId ?? current.baselineWorkflowId
        if (owner && owner !== sourceWorkflowId) return () => false
        if (owner && current.detachedDiffs[owner])
          throw new Error('An unresolved intention already exists for this workflow.')
        const detached = owner
          ? {
              ...current.detachedDiffs,
              [owner]: {
                id: crypto.randomUUID(),
                action: current.action ? structuredClone(current.action) : null,
                baseline: current.baselineWorkflow
                  ? cloneWorkflowState(current.baselineWorkflow)
                  : null,
                error:
                  current.diffError ||
                  'This intention is detached. Consult the server before abandoning it.',
                inFlight: !!current.action && runningActions.has(current.action.id),
              },
            }
          : current.detachedDiffs
        const epoch = ++displayEpoch
        const isCurrent = () => displayEpoch === epoch
        batchedUpdate.cancel()
        diffEngine.clearDiff()
        // Archive and revoke in one store publication. A subscriber may navigate or
        // reset identity synchronously; no later write may restore this transition.
        set({ ...RESET_DIFF_STATE, detachedDiffs: detached })
        return isCurrent
      }

      function assertDisplay(workflowId: string, epoch: number) {
        if (
          displayEpoch !== epoch ||
          useWorkflowRegistry.getState().activeWorkflowId !== workflowId ||
          useWorkflowStore.getState().currentWorkflowId !== workflowId
        )
          throw new Error('The workflow display changed. Synchronize before continuing.')
      }

      function assertOwner(actionId: string) {
        if (get().action?.id !== actionId) throw new Error('The diff action was superseded.')
      }
      function validateCandidate(state: WorkflowState) {
        const serializer = new Serializer()
        serializer.deserializeWorkflow(
          serializer.serializeWorkflow(
            state.blocks,
            state.edges,
            state.loops,
            state.parallels,
            false
          )
        )
      }
      function record(detail: Record<string, unknown>) {
        if (typeof window !== 'undefined')
          window.dispatchEvent(
            new CustomEvent('record-diff-operation', { detail: structuredClone(detail) })
          )
      }
      function consumeCoveredNotification(observation: ReturnType<typeof captureDiffObservation>) {
        if (
          (get().pendingExternalUpdates[observation.workflowId] ?? 0) ===
            observation.pendingGeneration &&
          (get().remoteUpdateVersions[observation.workflowId] ?? 0) ===
            observation.versions.remoteUpdate
        ) {
          get().clearExternalUpdatePending(observation.workflowId)
        }
      }
      function failAction(actionId: string, error: unknown) {
        const detachedEntry = Object.entries(get().detachedDiffs).find(
          ([, entry]) => entry.action?.id === actionId
        )
        if (get().action?.id !== actionId && !detachedEntry) return
        const message =
          error instanceof Error
            ? error.message
            : 'The diff could not be confirmed. Synchronize the workflow.'
        if (detachedEntry) {
          const [workflowId, entry] = detachedEntry
          set((state) => ({
            detachedDiffs: {
              ...state.detachedDiffs,
              [workflowId]: {
                ...entry,
                action: entry.action
                  ? {
                      ...entry.action,
                      phase:
                        error instanceof ApiClientError && error.status === 409
                          ? 'conflict'
                          : 'unknown',
                    }
                  : null,
                error: 'This intention was detached. Consult the server before abandoning it.',
              },
            },
          }))
          return
        }
        const action = get().action!
        set({
          action: {
            ...action,
            phase: error instanceof ApiClientError && error.status === 409 ? 'conflict' : 'unknown',
          },
          diffError: message,
        })
        if (get().action?.id === actionId)
          get().setWorkflowReconciliationError(action.workflowId, message)
      }
      function finishAction(actionId: string, workflowId: string) {
        runningActions.delete(actionId)
        const detached = get().detachedDiffs[workflowId]
        if (detached?.action?.id === actionId) {
          set((state) => ({
            detachedDiffs: {
              ...state.detachedDiffs,
              [workflowId]: { ...detached, inFlight: false },
            },
          }))
        }
        if (!get().action || get().action?.id === actionId)
          get().setWorkflowReconciliationInProgress(workflowId, false)
      }
      async function readback(
        actionId: string,
        previous: ReturnType<typeof captureDiffObservation>,
        expected: number | undefined,
        baseline: WorkflowState
      ) {
        assertOwner(actionId)
        assertDiffObservation(previous, true)
        const observation = captureDiffObservation(previous.workflowId)
        const { draftRevision, ...received } = await requestJson(
          getWorkflowNormalizedStateContract,
          {
            params: { id: previous.workflowId },
          }
        )
        const state = cloneWorkflowState(received)
        assertOwner(actionId)
        assertDiffObservation(observation)
        if (expected !== undefined && draftRevision !== expected)
          throw new Error(
            'A newer workflow revision was observed. Synchronize before resolving this diff.'
          )
        assertExactDiffSnapshot(state)
        validateCandidate(state)
        const result = await diffEngine.createDiffFromWorkflowState(
          state,
          undefined,
          baseline,
          'persisted_snapshot'
        )
        assertOwner(actionId)
        assertDiffObservation(observation)
        if (
          !result.success ||
          !result.diff ||
          diffSnapshotFingerprint(result.diff.proposedState) !== diffSnapshotFingerprint(state)
        )
          throw new Error('The snapshot could not be displayed without modification.')
        return { state, revision: draftRevision, observation, diff: result.diff }
      }
      function publishDiff(
        actionId: string,
        baseline: WorkflowState,
        confirmed: Awaited<ReturnType<typeof readback>>
      ) {
        assertOwner(actionId)
        assertDiffObservation(confirmed.observation)
        const workflowId = confirmed.observation.workflowId
        const epoch = displayEpoch
        const assertPublication = () => {
          assertOwner(actionId)
          assertDisplay(workflowId, epoch)
        }
        if (
          isEmptyDiffAnalysis(confirmed.diff.diffAnalysis) &&
          diffSnapshotFingerprint(baseline) === diffSnapshotFingerprint(confirmed.state)
        ) {
          useWorkflowStore.getState().invalidateDraftRevisionAttestation()
          assertPublication()
          consumeCoveredNotification(confirmed.observation)
          assertPublication()
          batchedUpdate.cancel()
          set(RESET_DIFF_STATE)
          diffEngine.clearDiff()
          assertDisplay(workflowId, epoch)
          notifyDiffSettled(workflowId)
          return false
        }
        set({
          ...deriveDiffFlags('showing'),
          baselineWorkflow: cloneWorkflowState(baseline),
          baselineWorkflowId: workflowId,
          diffAnalysis: confirmed.diff.diffAnalysis ?? null,
          diffMetadata: confirmed.diff.metadata,
          diffError: null,
        })
        assertOwner(actionId)
        assertDiffObservation(confirmed.observation)
        applyWorkflowStateToStores(
          workflowId,
          {
            ...confirmed.diff.proposedState,
            currentWorkflowId: workflowId,
          },
          undefined,
          assertPublication
        )
        assertPublication()
        observeAppliedDiff(confirmed.observation, confirmed.state)
        consumeCoveredNotification(confirmed.observation)
        assertPublication()
        const applied = observeAppliedDiff(confirmed.observation, confirmed.state, 0)
        set({
          action: {
            ...get().action!,
            phase: 'confirmed',
            confirmed: {
              revision: confirmed.revision,
              state: cloneWorkflowState(confirmed.state),
              observation: applied,
            },
          },
        })
        return true
      }

      return {
        ...deriveDiffFlags('none'),
        action: null,
        baselineWorkflow: null,
        baselineWorkflowId: null,
        diffAnalysis: null,
        diffMetadata: null,
        diffError: null,
        pendingExternalUpdates: {},
        remoteUpdateVersions: {},
        reconcilingWorkflows: {},
        reconciliationErrors: {},
        _triggerMessageId: null,
        detachedDiffs: {},
        _batchedStateUpdate: batchedUpdate,

        detachDiffForNavigation: (sourceWorkflowId, destinationWorkflowId) => {
          if (!destinationWorkflowId) return
          detachDisplay(sourceWorkflowId)
        },

        detachDiffForWorkspaceChange: (sourceWorkflowId, destinationWorkspaceId) => {
          if (!destinationWorkspaceId) return () => false
          return detachDisplay(sourceWorkflowId)
        },

        consultDetachedDiff: async (workflowId) => {
          const entry = get().detachedDiffs[workflowId]
          const epoch = displayEpoch
          assertDisplay(workflowId, epoch)
          if (!entry || entry.inFlight || entry.consultationRequest)
            throw new Error('Wait for the pending request before consulting the server.')
          const entryId = entry.id
          const requestId = crypto.randomUUID()
          const observation = captureDiffObservation(workflowId)
          assertDiffObservation(observation)
          set((state) => ({
            detachedDiffs: {
              ...state.detachedDiffs,
              [workflowId]: { ...entry, consultationRequest: requestId, consultation: undefined },
            },
          }))
          try {
            const { draftRevision, ...received } = await requestJson(
              getWorkflowNormalizedStateContract,
              { params: { id: workflowId } }
            )
            assertDisplay(workflowId, epoch)
            assertDiffObservation(observation)
            if (
              get().detachedDiffs[workflowId]?.id !== entryId ||
              get().detachedDiffs[workflowId]?.consultationRequest !== requestId
            )
              throw new Error('The detached intention changed.')
            const snapshot = cloneWorkflowState(received)
            if (!Number.isSafeInteger(draftRevision) || draftRevision < 0)
              throw new Error('Invalid server revision.')
            assertExactDiffSnapshot(snapshot)
            validateCandidate(snapshot)
            set((state) => ({
              detachedDiffs: {
                ...state.detachedDiffs,
                [workflowId]: {
                  ...state.detachedDiffs[workflowId],
                  consultation: { revision: draftRevision, state: snapshot, observation, epoch },
                },
              },
            }))
          } finally {
            const current = get().detachedDiffs[workflowId]
            if (current?.id === entryId && current.consultationRequest === requestId)
              set((state) => ({
                detachedDiffs: {
                  ...state.detachedDiffs,
                  [workflowId]: { ...current, consultationRequest: undefined },
                },
              }))
          }
        },

        abandonDetachedDiff: (workflowId) => {
          const entry = get().detachedDiffs[workflowId]
          const consulted = entry?.consultation
          if (!entry || entry.inFlight || entry.consultationRequest || !consulted)
            throw new Error('Consult the server before abandoning the local intention.')
          const entryId = entry.id
          const epoch = consulted.epoch
          const snapshot = cloneWorkflowState(consulted.state)
          const observation = {
            ...consulted.observation,
            versions: { ...consulted.observation.versions },
          }
          assertDisplay(workflowId, epoch)
          assertDiffObservation(observation)
          // Explicit user choice applies the consulted snapshot, without claiming who committed it.
          const assertAbandonment = () => {
            assertDisplay(workflowId, epoch)
            if (get().detachedDiffs[workflowId]?.id !== entryId)
              throw new Error('The detached intention changed.')
          }
          applyWorkflowStateToStores(
            workflowId,
            { ...snapshot, currentWorkflowId: workflowId },
            undefined,
            assertAbandonment
          )
          assertDisplay(workflowId, epoch)
          observeAppliedDiff(observation, snapshot)
          set((state) => ({ detachedDiffs: omit(state.detachedDiffs, [workflowId]) }))
          get().setWorkflowReconciliationError(workflowId, null)
          assertDisplay(workflowId, epoch)
          notifyDiffSettled(workflowId)
        },

        setProposedChanges: async (proposedState, diffAnalysis, options) => {
          const workflowId = useWorkflowRegistry.getState().activeWorkflowId
          const revision = workflowId ? getAttestedDraftRevision(workflowId) : null
          if (
            !workflowId ||
            revision === null ||
            options?.skipPersist ||
            get().action ||
            get().detachedDiffs[workflowId]
          ) {
            throw new Error('Synchronize the workflow before proposing changes.')
          }
          const observation = captureDiffObservation(workflowId)
          assertDiffObservation(observation)
          const baseline = cloneWorkflowState(
            options?.baselineWorkflow ?? captureBaselineSnapshot(workflowId)
          )
          if (diffSnapshotFingerprint(baseline) !== observation.fingerprint)
            throw new Error('The baseline does not match the attested source.')
          const intended = cloneWorkflowState(proposedState)
          if (!Object.hasOwn(intended, 'variables'))
            intended.variables = structuredClone(baseline.variables ?? {})
          const analysis = diffAnalysis ? structuredClone(diffAnalysis) : undefined
          const skipRecording = options?.skipRecording === true
          const actionId = crypto.randomUUID()
          const epoch = displayEpoch
          runningActions.add(actionId)
          set({
            action: {
              id: actionId,
              workflowId,
              phase: 'saving',
              intendedState: cloneWorkflowState(intended),
            },
            baselineWorkflow: cloneWorkflowState(baseline),
            baselineWorkflowId: workflowId,
            diffError: null,
          })
          try {
            assertOwner(actionId)
            assertDisplay(workflowId, epoch)
            get().setWorkflowReconciliationInProgress(workflowId, true)
            assertOwner(actionId)
            assertDisplay(workflowId, epoch)
            const result = await diffEngine.createDiffFromWorkflowState(
              intended,
              analysis,
              baseline
            )
            if (!result.success || !result.diff)
              throw new Error(result.errors?.join(', ') || 'Failed to create diff')
            assertOwner(actionId)
            assertDiffObservation(observation)
            const candidate = result.diff.proposedState
            validateCandidate(candidate)
            if (
              isEmptyDiffAnalysis(result.diff.diffAnalysis) &&
              diffSnapshotFingerprint(candidate) === observation.fingerprint
            ) {
              set(RESET_DIFF_STATE)
              return
            }
            set({ action: { ...get().action!, intendedState: cloneWorkflowState(candidate) } })
            const receipt = await persistWorkflowStateToServer(workflowId, candidate, revision)
            const confirmed = await readback(actionId, observation, receipt.draftRevision, baseline)
            const displayed = publishDiff(actionId, baseline, confirmed)
            if (displayed) assertOwner(actionId)
            assertDisplay(workflowId, epoch)
            if (displayed && !skipRecording)
              record({
                type: 'apply-diff',
                baselineSnapshot: baseline,
                proposedState: confirmed.diff.proposedState,
                diffAnalysis: confirmed.diff.diffAnalysis,
              })
          } catch (error) {
            failAction(actionId, error)
            throw error
          } finally {
            finishAction(actionId, workflowId)
          }
        },

        showPersistedChanges: async (workflowId) => {
          const prior = get().action
          if (
            get().detachedDiffs[workflowId] ||
            (prior && (prior.phase !== 'confirmed' || prior.workflowId !== workflowId)) ||
            (!prior && get().hasActiveDiff)
          )
            throw new Error('Finish the current diff before refreshing it.')
          const observation = captureDiffObservation(workflowId)
          assertDiffObservation(observation)
          const baseline = cloneWorkflowState(
            prior && get().baselineWorkflow
              ? get().baselineWorkflow!
              : captureBaselineSnapshot(workflowId)
          )
          const actionId = crypto.randomUUID()
          const epoch = displayEpoch
          runningActions.add(actionId)
          set({
            action: {
              id: actionId,
              workflowId,
              phase: 'saving',
              intendedState: cloneWorkflowState(baseline),
            },
            baselineWorkflow: cloneWorkflowState(baseline),
            baselineWorkflowId: workflowId,
            diffError: null,
          })
          try {
            assertOwner(actionId)
            assertDisplay(workflowId, epoch)
            get().setWorkflowReconciliationInProgress(workflowId, true)
            assertOwner(actionId)
            assertDisplay(workflowId, epoch)
            const confirmed = await readback(actionId, observation, undefined, baseline)
            const displayed = publishDiff(actionId, baseline, confirmed)
            if (displayed) assertOwner(actionId)
            assertDisplay(workflowId, epoch)
            if (displayed)
              record({
                type: 'apply-diff',
                baselineSnapshot: baseline,
                proposedState: confirmed.diff.proposedState,
                diffAnalysis: confirmed.diff.diffAnalysis,
              })
          } catch (error) {
            failAction(actionId, error)
            throw error
          } finally {
            finishAction(actionId, workflowId)
          }
        },

        clearDiff: ({ restoreBaseline = true } = {}) => {
          if (get().action?.phase === 'saving' || (restoreBaseline && get().action))
            throw new Error(
              'Resolve the diff through its confirmed save before restoring a baseline.'
            )
          batchedUpdate.cancel()
          const { baselineWorkflow, baselineWorkflowId } = get()
          const activeWorkflowId = useWorkflowRegistry.getState().activeWorkflowId

          if (
            restoreBaseline &&
            baselineWorkflow &&
            baselineWorkflowId &&
            baselineWorkflowId === activeWorkflowId
          ) {
            applyWorkflowStateToStores(baselineWorkflowId, baselineWorkflow)
          }

          diffEngine.clearDiff()

          set(RESET_DIFF_STATE)
          notifyDiffSettled(baselineWorkflowId ?? activeWorkflowId)
        },

        toggleDiffView: () => {
          const { status } = get()
          if (status === 'none') {
            logger.warn('Cannot toggle diff view without an active, ready diff')
            return
          }
          batchedUpdate(deriveDiffFlags(status === 'showing' ? 'staged' : 'showing'))
        },

        acceptChanges: async (options) => {
          const action = get().action
          if (!action || action.phase !== 'confirmed' || !action.confirmed)
            throw new Error('This diff is not confirmed. Synchronize the workflow.')
          const epoch = displayEpoch
          try {
            assertDiffObservation(action.confirmed.observation)
            const beforeAccept = captureBaselineSnapshot(action.workflowId)
            const afterAccept = stripWorkflowDiffMarkers(cloneWorkflowState(beforeAccept))
            assertExactDiffSnapshot(afterAccept)
            const baseline = get().baselineWorkflow
            const analysis = get().diffAnalysis
            // Clearing overlay metadata grants no new revision attestation.
            applyWorkflowStateToStores(action.workflowId, afterAccept, undefined, () => {
              assertOwner(action.id)
              assertDisplay(action.workflowId, epoch)
            })
            assertOwner(action.id)
            assertDisplay(action.workflowId, epoch)
            batchedUpdate.cancel()
            set(RESET_DIFF_STATE)
            diffEngine.clearDiff()
            if (!options?.skipRecording)
              record({
                type: 'accept-diff',
                beforeAccept,
                afterAccept,
                diffAnalysis: analysis,
                baselineSnapshot: baseline,
              })
            assertDisplay(action.workflowId, epoch)
            notifyDiffSettled(action.workflowId)
          } catch (error) {
            failAction(action.id, error)
            throw error
          }
        },

        rejectChanges: async (options) => {
          const action = get().action
          const baseline = get().baselineWorkflow
          if (!action || action.phase !== 'confirmed' || !action.confirmed || !baseline)
            throw new Error('This diff is not confirmed. Synchronize the workflow.')
          const workflowId = action.workflowId
          const revision = action.confirmed.revision
          const target = cloneWorkflowState(baseline)
          const beforeReject = captureBaselineSnapshot(workflowId)
          const analysis = get().diffAnalysis ? structuredClone(get().diffAnalysis) : null
          const skipRecording = options?.skipRecording === true
          const sourceState = cloneWorkflowState(action.confirmed.state)
          const observation = {
            ...action.confirmed.observation,
            versions: { ...action.confirmed.observation.versions },
          }
          const actionId = crypto.randomUUID()
          const epoch = displayEpoch
          runningActions.add(actionId)
          set({
            action: { ...action, id: actionId, phase: 'saving', intendedState: target },
            diffError: null,
          })
          try {
            assertOwner(actionId)
            assertDisplay(workflowId, epoch)
            get().setWorkflowReconciliationInProgress(workflowId, true)
            assertOwner(actionId)
            assertDisplay(workflowId, epoch)
            assertDiffObservation(observation)
            // A fresh read may confirm the known source, never rebase it onto a newer revision.
            const source = await requestJson(getWorkflowNormalizedStateContract, {
              params: { id: workflowId },
            })
            assertOwner(actionId)
            assertDiffObservation(observation)
            if (
              source.draftRevision !== revision ||
              diffSnapshotFingerprint(source) !== diffSnapshotFingerprint(sourceState)
            )
              throw new Error('The saved diff changed. Synchronize before rejecting it.')
            validateCandidate(target)
            const receipt = await persistWorkflowStateToServer(workflowId, target, revision)
            const confirmed = await readback(actionId, observation, receipt.draftRevision, target)
            assertOwner(actionId)
            assertDiffObservation(confirmed.observation)
            applyWorkflowStateToStores(
              workflowId,
              {
                ...confirmed.state,
                currentWorkflowId: workflowId,
              },
              undefined,
              () => {
                assertOwner(actionId)
                assertDisplay(workflowId, epoch)
              }
            )
            assertOwner(actionId)
            assertDisplay(workflowId, epoch)
            observeAppliedDiff(confirmed.observation, confirmed.state)
            consumeCoveredNotification(confirmed.observation)
            observeAppliedDiff(confirmed.observation, confirmed.state, 0)
            assertOwner(actionId)
            assertDisplay(workflowId, epoch)
            batchedUpdate.cancel()
            set(RESET_DIFF_STATE)
            diffEngine.clearDiff()
            if (!skipRecording)
              record({
                type: 'reject-diff',
                beforeReject,
                afterReject: confirmed.state,
                diffAnalysis: analysis,
                baselineSnapshot: target,
              })
            assertDisplay(workflowId, epoch)
            notifyDiffSettled(workflowId)
          } catch (error) {
            failAction(actionId, error)
            throw error
          } finally {
            finishAction(actionId, workflowId)
          }
        },

        reapplyDiffMarkers: () => {
          const { hasActiveDiff, isDiffReady, diffAnalysis } = get()
          if (!hasActiveDiff || !isDiffReady || !diffAnalysis) {
            return
          }

          const workflowStore = useWorkflowStore.getState()
          const currentBlocks = workflowStore.blocks

          // Check if any blocks need markers applied (checking the actual property, not just existence)
          const needsUpdate =
            diffAnalysis.new_blocks?.some((blockId) => {
              const block = currentBlocks[blockId]
              const blockDiffState = (block as { is_diff?: string } | undefined)?.is_diff
              return block && blockDiffState !== 'new'
            }) ||
            diffAnalysis.edited_blocks?.some((blockId) => {
              const block = currentBlocks[blockId]
              const blockDiffState = (block as { is_diff?: string } | undefined)?.is_diff
              return block && blockDiffState !== 'edited'
            })

          if (!needsUpdate) {
            return
          }

          const updatedBlocks: Record<string, any> = {}
          let hasChanges = false

          // Only clone blocks that need diff markers
          Object.entries(currentBlocks).forEach(([blockId, block]) => {
            const isNewBlock = diffAnalysis.new_blocks?.includes(blockId)
            const isEditedBlock = diffAnalysis.edited_blocks?.includes(blockId)
            const blockDiffState = (block as { is_diff?: string } | undefined)?.is_diff

            if (isNewBlock && blockDiffState !== 'new') {
              updatedBlocks[blockId] = { ...block, is_diff: 'new' }
              hasChanges = true
            } else if (isEditedBlock && blockDiffState !== 'edited') {
              updatedBlocks[blockId] = { ...block, is_diff: 'edited' }

              // Re-apply field_diffs if available
              if (diffAnalysis.field_diffs?.[blockId]) {
                updatedBlocks[blockId].field_diffs = diffAnalysis.field_diffs[blockId]

                // Clone subblocks and apply markers
                const fieldDiff = diffAnalysis.field_diffs[blockId]
                updatedBlocks[blockId].subBlocks = { ...block.subBlocks }

                fieldDiff.changed_fields.forEach((field) => {
                  if (updatedBlocks[blockId].subBlocks?.[field]) {
                    updatedBlocks[blockId].subBlocks[field] = {
                      ...updatedBlocks[blockId].subBlocks[field],
                      is_diff: 'changed',
                    }
                  }
                })
              }
              hasChanges = true
            } else {
              updatedBlocks[blockId] = block
            }
          })

          // Only update if we actually made changes
          if (hasChanges) {
            useWorkflowStore.setState({ blocks: updatedBlocks })
            logger.info('Re-applied diff markers to workflow blocks')
          }
        },

        markRemoteUpdateSeen: (workflowId) => {
          set((state) => ({
            remoteUpdateVersions: {
              ...state.remoteUpdateVersions,
              [workflowId]: (state.remoteUpdateVersions[workflowId] ?? 0) + 1,
            },
            reconciliationErrors: omit(state.reconciliationErrors, [workflowId]),
          }))
        },

        markExternalUpdatePending: (workflowId) => {
          const current = get()
          set({
            pendingExternalUpdates: {
              ...current.pendingExternalUpdates,
              [workflowId]: (current.pendingExternalUpdates[workflowId] ?? 0) + 1,
            },
            remoteUpdateVersions: {
              ...current.remoteUpdateVersions,
              [workflowId]: (current.remoteUpdateVersions[workflowId] ?? 0) + 1,
            },
            reconciliationErrors: omit(current.reconciliationErrors, [workflowId]),
          })
        },

        clearExternalUpdatePending: (workflowId) => {
          set((state) => {
            const { [workflowId]: _removed, ...pendingExternalUpdates } =
              state.pendingExternalUpdates
            return { pendingExternalUpdates }
          })
        },

        setWorkflowReconciliationInProgress: (workflowId, isReconciling) => {
          set((state) => {
            const { [workflowId]: _removed, ...reconcilingWorkflows } = state.reconcilingWorkflows
            return {
              reconcilingWorkflows: isReconciling
                ? { ...reconcilingWorkflows, [workflowId]: true }
                : reconcilingWorkflows,
            }
          })
        },

        setWorkflowReconciliationError: (workflowId, error) => {
          set((state) => {
            const { [workflowId]: _removed, ...reconciliationErrors } = state.reconciliationErrors
            return {
              reconciliationErrors: error
                ? { ...reconciliationErrors, [workflowId]: error }
                : reconciliationErrors,
            }
          })
        },
      }
    },
    { name: 'workflow-diff-store' }
  )
)
