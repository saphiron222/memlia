// @vitest-environment jsdom
// Copyright (c) 2026 Memlia. All rights reserved.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useWorkflowDiffStore } from '@/stores/workflow-diff'
import { captureDiffObservation } from '@/stores/workflow-diff/utils'
import { useWorkflowRegistry } from '@/stores/workflows/registry/store'
import { DiffControls } from './diff-controls'

const commands = vi.hoisted(() => ({ current: [] as any[] }))
vi.mock('@/app/workspace/[workspaceId]/providers/global-commands-provider', () => ({
  useRegisterGlobalCommands: (value: any[]) => {
    commands.current = value
  },
}))
vi.mock('@/app/workspace/[workspaceId]/w/[workflowId]/hooks', () => ({
  usePreventZoom: () => ({ current: null }),
}))
let root: Root
let container: HTMLDivElement
function render(node: React.ReactNode) {
  act(() => root.render(node))
}
function button(prefix: string) {
  return Array.from(container.querySelectorAll('button')).find((node) =>
    node.textContent?.trim().startsWith(prefix)
  )!
}
const initial = useWorkflowDiffStore.getState()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  useWorkflowDiffStore.setState({
    ...initial,
    hasActiveDiff: true,
    isDiffReady: true,
    diffError: null,
  })
  useWorkflowRegistry.setState({ activeWorkflowId: 'w' })
  commands.current = []
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useWorkflowDiffStore.setState(initial)
})
it.each(['saving', 'conflict', 'unknown'] as const)(
  'keeps %s observable and prevents button and keyboard execution',
  (phase) => {
    const accept = vi.fn().mockResolvedValue(undefined)
    const reject = vi.fn().mockResolvedValue(undefined)
    useWorkflowDiffStore.setState({
      action: { id: 'a', workflowId: 'w', phase, intendedState: { blocks: {}, edges: [] } },
      diffError: phase === 'conflict' ? 'Workflow changed (409)' : null,
      acceptChanges: accept,
      rejectChanges: reject,
    })
    render(<DiffControls />)
    expect(button('Accept').hasAttribute('disabled')).toBe(true)
    expect(button('Reject').hasAttribute('disabled')).toBe(true)
    act(() => {
      button('Accept').click()
      button('Reject').click()
    })
    commands.current[0]?.handler()
    expect(accept).not.toHaveBeenCalled()
    expect(reject).not.toHaveBeenCalled()
    if (phase === 'conflict')
      expect(container.querySelector('[role=alert]')?.textContent).toContain('409')
  }
)
it('renders a pending action and its error even before the diff overlay was applied', () => {
  useWorkflowDiffStore.setState({
    hasActiveDiff: false,
    isDiffReady: false,
    diffError: 'Response unknown: synchronize',
    action: {
      id: 'a',
      workflowId: 'w',
      phase: 'unknown',
      intendedState: { blocks: {}, edges: [] },
    },
  })
  render(<DiffControls />)
  expect(container.querySelector('[role=alert]')?.textContent).toContain('Response unknown')
})

it('shows the detached intention only on its workflow and requires explicit consultation before abandonment', async () => {
  const consult = vi.fn().mockResolvedValue(undefined)
  const abandon = vi.fn()
  useWorkflowDiffStore.setState({
    hasActiveDiff: false,
    isDiffReady: false,
    action: null,
    diffError: null,
    detachedDiffs: {
      w: {
        id: 'detached',
        action: {
          id: 'a',
          workflowId: 'w',
          phase: 'unknown',
          intendedState: { blocks: {}, edges: [] },
        },
        baseline: null,
        error: 'The write outcome is unknown',
        inFlight: false,
      },
    },
    consultDetachedDiff: consult,
    abandonDetachedDiff: abandon,
  })
  render(<DiffControls />)
  expect(container.querySelector('[role=alert]')?.textContent).toContain('unknown')
  expect(button('Abandon local intention').hasAttribute('disabled')).toBe(true)
  await act(async () => button('Consult server').click())
  expect(consult).toHaveBeenCalledWith('w')
  expect(abandon).not.toHaveBeenCalled()
  act(() => useWorkflowRegistry.setState({ activeWorkflowId: 'other' }))
  expect(container.querySelector('[role=alert]')).toBeNull()
  act(() => useWorkflowRegistry.setState({ activeWorkflowId: 'w' }))
  expect(container.querySelector('[role=alert]')?.textContent).toContain('unknown')
})

it('abandons only after a consulted snapshot and a separate explicit click', () => {
  const abandon = vi.fn()
  useWorkflowDiffStore.setState({
    hasActiveDiff: false,
    isDiffReady: false,
    action: null,
    diffError: null,
    detachedDiffs: {
      w: {
        id: 'detached',
        action: null,
        baseline: null,
        error: 'Retained proposal',
        inFlight: false,
        consultation: {
          revision: 12,
          state: { blocks: {}, edges: [] },
          observation: captureDiffObservation('w'),
          epoch: 0,
        },
      },
    },
    abandonDetachedDiff: abandon,
  })
  render(<DiffControls />)
  expect(container.textContent).toContain('does not confirm whether your earlier save completed')
  expect(abandon).not.toHaveBeenCalled()
  expect(button('Abandon local intention').hasAttribute('disabled')).toBe(false)
  act(() => button('Abandon local intention').click())
  expect(abandon).toHaveBeenCalledExactlyOnceWith('w')
})
