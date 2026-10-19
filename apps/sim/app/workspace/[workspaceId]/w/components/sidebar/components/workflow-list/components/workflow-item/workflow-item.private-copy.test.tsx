// Copyright 2026 Memlia. All rights reserved.
/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { WorkflowMetadata } from '@/stores/workflows/registry/types'
import { WorkflowItem } from './workflow-item'

const state = vi.hoisted(() => ({
  workflows: new Set(['source']),
  folders: new Set<string>(),
  update: vi.fn(),
}))
vi.mock('@sim/emcn', () => ({
  chipVariants: () => '',
  cn: () => '',
  rowActionsGroupClass: '',
  OverflowText: ({ label }: { label: string }) => <span>{label}</span>,
  RowActions: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock('next/link', () => ({
  default: ({ children, ...props }: React.ComponentProps<'a'>) => <a {...props}>{children}</a>,
}))
vi.mock('@/app/workspace/[workspaceId]/providers/workspace-permissions-provider', () => ({
  useUserPermissionsContext: () => ({ canEdit: false, canAdmin: false }),
}))
vi.mock(
  '@/app/workspace/[workspaceId]/w/components/sidebar/components/sidebar-row-actions',
  () => ({ SidebarRowAction: (props: React.ComponentProps<'button'>) => <button {...props} /> })
)
vi.mock(
  '@/app/workspace/[workspaceId]/w/components/sidebar/components/workflow-list/components/workflow-item/avatars/avatars',
  () => ({ Avatars: () => null })
)
vi.mock(
  '@/app/workspace/[workspaceId]/w/components/sidebar/components/workflow-list/components/delete-modal/delete-modal',
  () => ({ DeleteModal: () => null })
)
vi.mock(
  '@/app/workspace/[workspaceId]/w/components/sidebar/components/workflow-list/components/private-copy-dialog/private-copy-dialog',
  () => ({
    PrivateCopyDialog: ({
      sourceWorkflowId,
      sourceWorkspaceId,
    }: {
      sourceWorkflowId: string
      sourceWorkspaceId: string
    }) => (
      <section role='dialog'>
        {sourceWorkspaceId}/{sourceWorkflowId}
      </section>
    ),
  })
)
vi.mock(
  '@/app/workspace/[workspaceId]/w/components/sidebar/components/workflow-list/components/context-menu/context-menu',
  () => ({
    ContextMenu: ({
      isOpen,
      showPrivateCopy,
      onPrivateCopy,
    }: {
      isOpen: boolean
      showPrivateCopy: boolean
      onPrivateCopy: () => void
    }) =>
      isOpen && showPrivateCopy ? (
        <button onClick={onPrivateCopy}>Créer une copie privée</button>
      ) : null,
  })
)
vi.mock('@/stores/folders/store', () => {
  const getState = () => ({
    selectedWorkflows: state.workflows,
    selectedFolders: state.folders,
    clearAllSelection: () => {
      state.workflows.clear()
      state.folders.clear()
    },
    selectWorkflow: (id: string) => state.workflows.add(id),
  })
  return {
    useFolderStore: Object.assign(
      (selector: (s: ReturnType<typeof getState>) => unknown) => selector(getState()),
      { getState }
    ),
  }
})
vi.mock('@/hooks/queries/folders', () => ({ useFolderMap: () => ({ data: {} }) }))
vi.mock('@/hooks/queries/utils/folder-cache', () => ({ getFolderMap: () => ({}) }))
vi.mock('@/hooks/queries/utils/folder-tree', () => ({
  isFolderOrAncestorLocked: () => false,
  isWorkflowEffectivelyLocked: () => true,
}))
vi.mock('@/hooks/queries/utils/workflow-cache', () => ({
  getWorkflows: () => [{ id: 'source', name: 'Protégé' }],
}))
vi.mock('@/hooks/queries/workflows', () => ({
  useUpdateWorkflow: () => ({ mutate: state.update, mutateAsync: state.update }),
}))
vi.mock('@/app/workspace/[workspaceId]/w/components/sidebar/hooks', () => ({
  useSidebarListContext: () => ({
    isAnyDragActive: false,
    dragDisabled: true,
    activeWorkflowIdRef: { current: null },
    onWorkflowClick: vi.fn(),
    onItemDragStart: vi.fn(),
    onItemDragEnd: vi.fn(),
  }),
  useItemDrag: () => ({
    shouldPreventClickRef: { current: false },
    handleDragStart: vi.fn(),
    handleDragEnd: vi.fn(),
  }),
  useItemRename: () => ({
    isEditing: false,
    inputRef: { current: null },
    handleStartEdit: vi.fn(),
  }),
}))
vi.mock('@/app/workspace/[workspaceId]/w/components/sidebar/utils', () => ({
  buildDragResources: vi.fn(),
  createSidebarDragGhost: vi.fn(),
}))
vi.mock('@/app/workspace/[workspaceId]/w/hooks', () => ({
  useCanDelete: () => ({ canDeleteWorkflows: () => false, canDeleteFolder: () => false }),
  useDeleteSelection: () => ({}),
  useDeleteWorkflow: () => ({}),
  useDuplicateSelection: () => ({}),
  useDuplicateWorkflow: () => ({}),
  useExportSelection: () => ({}),
  useExportWorkflow: () => ({}),
}))
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  state.workflows = new Set(['source'])
  state.folders = new Set()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})
function open() {
  const workflow = {
    id: 'source',
    name: 'Protégé',
    locked: true,
    workspaceId: 'shared',
  } as WorkflowMetadata
  act(() => root.render(<WorkflowItem workspaceId='shared' workflow={workflow} active={false} />))
  act(() =>
    container.querySelector('a')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
  )
}
it('offers private copying of one protected source without mutating that source', () => {
  open()
  const action = Array.from(container.querySelectorAll('button')).find(
    (x) => x.textContent === 'Créer une copie privée'
  )
  expect(action).toBeDefined()
  act(() => action!.click())
  expect(container.querySelector('[role="dialog"]')?.textContent).toBe('shared/source')
  expect(state.update).not.toHaveBeenCalled()
})
it.each(['workflow', 'folder'])('hides copying when the selection includes another %s', (kind) => {
  if (kind === 'workflow') state.workflows.add('second')
  else state.folders.add('folder')
  open()
  expect(container.textContent).not.toContain('Créer une copie privée')
})
it('rechecks a selection changed after menu opening', () => {
  open()
  const action = Array.from(container.querySelectorAll('button')).find(
    (x) => x.textContent === 'Créer une copie privée'
  )
  expect(action).toBeDefined()
  state.workflows.add('second')
  act(() => action!.click())
  expect(container.querySelector('[role="dialog"]')).toBeNull()
})
