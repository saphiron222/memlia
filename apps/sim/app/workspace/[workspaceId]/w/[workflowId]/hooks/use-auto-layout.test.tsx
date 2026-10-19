/** @vitest-environment jsdom */
// Copyright 2026 Memlia. All rights reserved.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAutoLayout } from './use-auto-layout'

const mocks = vi.hoisted(() => ({ layout: vi.fn(), toast: vi.fn(), fit: vi.fn() }))
vi.mock('../utils/auto-layout', () => ({ applyAutoLayoutAndUpdateStore: mocks.layout }))
vi.mock('@sim/emcn', () => ({ toast: mocks.toast }))
vi.mock('@xyflow/react', () => ({ useReactFlow: () => ({}) }))
vi.mock('@/hooks/queries/general-settings', () => ({ useSnapToGridSize: () => 0 }))
vi.mock('@/hooks/use-canvas-viewport', () => ({
  useCanvasViewport: () => ({ fitViewToBounds: mocks.fit }),
}))
let root: ReturnType<typeof createRoot>
let api: ReturnType<typeof useAutoLayout>
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => {
    fn()
    return 1
  })
  const el = document.createElement('div')
  document.body.appendChild(el)
  root = createRoot(el)
  function Probe() {
    api = useAutoLayout('workflow-a')
    return null
  }
  act(() => root.render(<Probe />))
})
afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})
it('shows a rejected layout once at the shared hook boundary without moving the viewport', async () => {
  mocks.layout.mockResolvedValue({
    success: false,
    error: 'Workflow changed; synchronize before retrying.',
  })
  await act(async () => {
    expect((await api.handleAutoLayout()).success).toBe(false)
  })
  expect(mocks.toast).toHaveBeenCalledTimes(1)
  expect(mocks.toast).toHaveBeenCalledWith({
    message: 'Workflow changed; synchronize before retrying.',
  })
  expect(mocks.fit).not.toHaveBeenCalled()
})
it('fits the viewport only after successful save and does not show an error', async () => {
  mocks.layout.mockResolvedValue({ success: true })
  await act(async () => {
    expect((await api.handleAutoLayout()).success).toBe(true)
  })
  expect(mocks.fit).toHaveBeenCalledTimes(1)
  expect(mocks.toast).not.toHaveBeenCalled()
})
