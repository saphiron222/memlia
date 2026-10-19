// Modified by Memlia: display diff confirmation failures and guard pending actions.
import { memo, useCallback, useMemo, useState } from 'react'
import { createLogger } from '@sim/logger'
import { useRegisterGlobalCommands } from '@/app/workspace/[workspaceId]/providers/global-commands-provider'
import { createCommand } from '@/app/workspace/[workspaceId]/utils/commands'
import { usePreventZoom } from '@/app/workspace/[workspaceId]/w/[workflowId]/hooks'
import { useWorkflowDiffStore } from '@/stores/workflow-diff'
import { useWorkflowRegistry } from '@/stores/workflows/registry/store'

const logger = createLogger('DiffControls')

export const DiffControls = memo(function DiffControls() {
  const workflowId = useWorkflowRegistry((state) => state.activeWorkflowId)
  const detached = useWorkflowDiffStore((state) =>
    workflowId ? state.detachedDiffs[workflowId] : undefined
  )
  const [consulting, setConsulting] = useState<string | null>(null)
  const [resolutionError, setResolutionError] = useState<{
    workflowId: string
    message: string
  } | null>(null)
  const action = useWorkflowDiffStore((state) => state.action)
  const diffError = useWorkflowDiffStore((state) => state.diffError)
  const canResolve = action?.phase === 'confirmed' && !detached
  const isDiffReady = useWorkflowDiffStore((state) => state.isDiffReady)
  const hasActiveDiff = useWorkflowDiffStore((state) => state.hasActiveDiff)
  const acceptChanges = useWorkflowDiffStore((state) => state.acceptChanges)
  const rejectChanges = useWorkflowDiffStore((state) => state.rejectChanges)

  const handleAccept = useCallback(() => {
    if (useWorkflowDiffStore.getState().action?.phase !== 'confirmed') return
    acceptChanges().catch((error) => {
      logger.error('Failed to accept changes (background):', error)
    })
  }, [acceptChanges])

  const handleReject = useCallback(() => {
    if (useWorkflowDiffStore.getState().action?.phase !== 'confirmed') return
    rejectChanges().catch((error) => {
      logger.error('Failed to reject changes (background):', error)
    })
  }, [rejectChanges])

  const preventZoomRef = usePreventZoom()

  const acceptCommand = useMemo(
    () =>
      createCommand({
        id: 'accept-diff-changes',
        handler: () => {
          if (hasActiveDiff && isDiffReady && canResolve) {
            handleAccept()
          }
        },
      }),
    [hasActiveDiff, isDiffReady, canResolve, handleAccept]
  )
  useRegisterGlobalCommands([acceptCommand])

  if (detached && workflowId) {
    const error =
      resolutionError?.workflowId === workflowId ? resolutionError.message : detached.error
    return (
      <div className='absolute right-4 bottom-4 z-30 max-w-sm'>
        <p role='alert'>{error}</p>
        <p>Your local proposal is retained. Discarding it will not cancel an earlier save.</p>
        {detached.consultation && (
          <p>
            Server snapshot: {Object.keys(detached.consultation.state.blocks).length} blocks and{' '}
            {detached.consultation.state.edges.length} connections. Abandoning the local intention
            loads this snapshot; it does not confirm whether your earlier save completed.
          </p>
        )}
        <button
          disabled={
            detached.inFlight || !!detached.consultationRequest || consulting === workflowId
          }
          onClick={() => {
            const target = workflowId
            setConsulting(target)
            setResolutionError(null)
            useWorkflowDiffStore
              .getState()
              .consultDetachedDiff(target)
              .catch((error) => {
                setResolutionError({
                  workflowId: target,
                  message: error instanceof Error ? error.message : 'Consultation failed.',
                })
              })
              .finally(() => setConsulting((current) => (current === target ? null : current)))
          }}
        >
          Consult server
        </button>
        <button
          disabled={
            !detached.consultation ||
            detached.inFlight ||
            !!detached.consultationRequest ||
            consulting === workflowId
          }
          onClick={() => {
            try {
              useWorkflowDiffStore.getState().abandonDetachedDiff(workflowId)
              setResolutionError(null)
            } catch (error) {
              setResolutionError({
                workflowId,
                message:
                  error instanceof Error ? error.message : 'The workflow changed. Consult again.',
              })
            }
          }}
        >
          Abandon local intention
        </button>
      </div>
    )
  }

  if ((!hasActiveDiff || !isDiffReady) && !action && !diffError) {
    return null
  }

  return (
    <div
      ref={preventZoomRef}
      className='absolute z-30'
      style={{
        bottom: '16px',
        right: '16px',
      }}
    >
      {diffError && (
        <p role='alert' className='mb-2 max-w-sm text-sm'>
          {diffError}
        </p>
      )}
      {action?.phase === 'saving' && (
        <p role='status' className='mb-2 text-sm'>
          Saving and confirming changes…
        </p>
      )}
      <div
        className='group relative flex h-[30px] overflow-hidden rounded-sm'
        style={{ isolation: 'isolate' }}
      >
        {/* Reject side */}
        <button
          disabled={!canResolve}
          onClick={handleReject}
          title='Reject changes'
          className='relative flex h-full items-center border border-[var(--border)] bg-[var(--surface-4)] pr-5 pl-3 text-[var(--text-secondary)] text-small transition-colors hover-hover:border-[var(--border-1)] hover-hover:bg-[var(--surface-6)] hover-hover:text-[var(--text-primary)] dark:hover-hover:bg-[var(--surface-5)]'
          style={{
            clipPath: 'polygon(0 0, calc(100% + 10px) 0, 100% 100%, 0 100%)',
            borderRadius: '4px 0 0 4px',
          }}
        >
          Reject
        </button>
        {/* Slanted divider - split gray/green */}
        <div
          className='pointer-events-none absolute top-0 bottom-0 z-10'
          style={{
            left: '66px',
            width: '2px',
            transform: 'skewX(-18.4deg)',
            background:
              'linear-gradient(to right, var(--border) 50%, color-mix(in srgb, var(--brand-accent) 70%, var(--color-black)) 50%)',
          }}
        />
        {/* Accept side */}
        <button
          disabled={!canResolve}
          onClick={handleAccept}
          title='Accept changes (⇧⌘⏎)'
          className='-ml-2.5 relative flex h-full items-center border border-black/15 bg-[var(--brand-accent)] pr-3 pl-5 text-[var(--text-inverse)] text-small transition-[background-color,border-color,fill,stroke] hover-hover:brightness-110 dark:border-white/10'
          style={{
            clipPath: 'polygon(10px 0, 100% 0, 100% 100%, 0 100%)',
            borderRadius: '0 4px 4px 0',
          }}
        >
          Accept
          <kbd className='ml-2 rounded border border-white/20 bg-white/10 px-1.5 py-0.5 font-medium font-sans text-micro'>
            ⇧⌘<span className='translate-y-[-1px]'>⏎</span>
          </kbd>
        </button>
      </div>
    </div>
  )
})
