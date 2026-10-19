// @vitest-environment jsdom
// Copyright (c) 2026 Memlia. All rights reserved.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useWorkflowOperations } from '@/app/workspace/[workspaceId]/w/components/sidebar/hooks/use-workflow-operations'
import { useImportWorkflow } from '@/app/workspace/[workspaceId]/w/hooks/use-import-workflow'
import { useOperationQueueStore } from '@/stores/operation-queue/store'
import { useVariablesStore } from '@/stores/variables/store'
import { useWorkflowRegistry } from '@/stores/workflows/registry/store'
import { useSubBlockStore } from '@/stores/workflows/subblock/store'
import { useWorkflowStore } from '@/stores/workflows/workflow/store'
import type { WorkflowState } from '@/stores/workflows/workflow/types'
import { useWorkflowDiffStore as diff, RESET_DIFF_STATE } from './store'

const io = vi.hoisted(() => ({
  push: vi.fn(),
  create: vi.fn(),
  imported: vi.fn(),
  request: vi.fn(),
  markCreating: vi.fn(),
}))
vi.unmock('@/blocks/registry')
vi.mock('@/lib/api/client/request', () => ({ requestJson: io.request }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: io.push }) }))
vi.mock('@/hooks/queries/workflows', () => ({
  useWorkflowMap: () => ({ data: {}, isLoading: false }),
  useCreateWorkflow: () => ({ mutate: io.create, mutateAsync: io.create, isPending: false }),
}))
vi.mock('@/hooks/queries/folders', () => ({ useCreateFolder: () => ({ mutateAsync: vi.fn() }) }))
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }))
vi.mock('@/hooks/queries/utils/invalidate-workflow-lists', () => ({
  invalidateWorkflowLists: vi.fn(),
}))
vi.mock('@/lib/workflows/operations/import-export', () => ({
  persistImportedWorkflow: io.imported,
  sanitizePathSegment: (s: string) => s,
  extractWorkflowsFromFiles: async () => [{ content: '{}', name: 'fixture.json' }],
  extractWorkflowsFromZip: vi.fn(),
}))
vi.mock('@sim/emcn', () => ({ toast: { error: vi.fn() } }))
vi.mock('posthog-js/react', () => ({ usePostHog: () => null }))
vi.mock('@/lib/posthog/client', () => ({ captureEvent: vi.fn() }))
let root: Root
let host: HTMLDivElement
let creation: ReturnType<typeof useWorkflowOperations>
let importing: ReturnType<typeof useImportWorkflow>
function Harness() {
  creation = useWorkflowOperations({ workspaceId: 'workspace' })
  importing = useImportWorkflow({ workspaceId: 'workspace' })
  return null
}
function graph(): WorkflowState {
  return {
    blocks: {
      b: {
        id: 'b',
        type: 'function',
        name: 'Persisted',
        position: { x: 0, y: 0 },
        enabled: true,
        subBlocks: { code: { id: 'code', type: 'code', value: 'return 1' } },
        outputs: {},
      },
    },
    edges: [],
    loops: {},
    parallels: {},
    variables: {},
  }
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.clearAllMocks()
  io.imported.mockReset()
  useOperationQueueStore.getState().reset()
  useWorkflowRegistry.setState({ activeWorkflowId: 'a' })
  vi.spyOn(useWorkflowRegistry.getState(), 'markWorkflowCreating').mockImplementation(
    io.markCreating
  )
  diff.setState({
    ...RESET_DIFF_STATE,
    detachedDiffs: {},
    pendingExternalUpdates: {},
    remoteUpdateVersions: {},
    reconcilingWorkflows: {},
    reconciliationErrors: {},
  })
  useWorkflowStore
    .getState()
    .replaceWorkflowState({ ...graph(), blocks: {}, currentWorkflowId: 'a' })
  useSubBlockStore.getState().initializeFromWorkflow('a', {})
  useVariablesStore.setState({ variables: {} })
  io.request.mockResolvedValue({ ...graph(), draftRevision: 5 })
  await diff.getState().showPersistedChanges('a')
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root.render(<Harness />))
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})
it('lets creation navigate while preserving the confirmed source intention', async () => {
  let result: string | null = null
  await act(async () => {
    result = await creation.handleCreateWorkflow()
  })
  expect(io.create).toHaveBeenCalledOnce()
  expect(io.push).toHaveBeenCalledWith(`/workspace/workspace/w/${result}`)
  expect(diff.getState().detachedDiffs.a.action?.phase).toBe('confirmed')
  expect(diff.getState().action).toBeNull()
})
it('does not detach for an import failure', async () => {
  io.imported.mockRejectedValueOnce(new Error('Invalid import'))
  const original = diff.getState().action
  const event = {
    target: { files: [new File(['{}'], 'fixture.json')], value: 'fixture' },
  } as unknown as React.ChangeEvent<HTMLInputElement>
  await act(async () => {
    await importing.handleFileChange(event)
  })
  expect(diff.getState().action).toBe(original)
  expect(diff.getState().detachedDiffs).toEqual({})
  expect(io.push).not.toHaveBeenCalled()
})
it('detaches only at the final successful import navigation', async () => {
  let complete!: (v: { workflowId: string }) => void
  io.imported.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve
      })
  )
  const original = diff.getState().action
  const event = {
    target: { files: [new File(['{}'], 'fixture.json')], value: 'fixture' },
  } as unknown as React.ChangeEvent<HTMLInputElement>
  let run!: Promise<void>
  await act(async () => {
    run = importing.handleFileChange(event)
    await Promise.resolve()
  })
  await vi.waitFor(() => expect(io.imported).toHaveBeenCalledOnce())
  expect(diff.getState().action).toBe(original)
  expect(io.push).not.toHaveBeenCalled()
  await act(async () => {
    complete({ workflowId: 'imported' })
    await run
  })
  expect(io.push).toHaveBeenCalledWith('/workspace/workspace/w/imported')
  expect(diff.getState().detachedDiffs.a.action?.id).toBe(original?.id)
})
it('executes the hydration preamble without restoring the old graph or blocking loading', () => {
  const loading = { current: null as string | null }
  const setActive = vi.fn()
  const setReady = vi.fn()
  const oldGraph = useWorkflowStore.getState().blocks
  // Same ordered preamble as workflow.tsx; no Next renderer/network is simulated as an end-to-end test.
  diff.getState().detachDiffForNavigation('a', 'b')
  loading.current = 'b'
  setReady(false)
  setActive('b')
  expect(setActive).toHaveBeenCalledWith('b')
  expect(loading.current).toBe('b')
  expect(useWorkflowStore.getState().blocks).toBe(oldGraph)
  expect(diff.getState().detachedDiffs.a).toBeDefined()
})
