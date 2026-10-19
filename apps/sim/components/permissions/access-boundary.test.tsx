// Copyright 2026 Memlia. All rights reserved.
/** @vitest-environment jsdom */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ isSuccess: false, isPending: false, data: undefined as undefined | { config: null | { hideFilesTab: boolean } } }))
vi.mock('next/navigation', () => ({ useParams: () => ({ workspaceId: 'w' }) }))
vi.mock('@/hooks/queries/user-permission-config', () => ({ useUserPermissionConfig: () => state }))
import { PermissionAccessBoundary } from './access-boundary'

describe('frontière de visibilité native', () => {
  it('cache le contenu tant que les permissions sont inconnues, en erreur ou refusées', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div'); const root = createRoot(container)
    for (const value of [
      { isSuccess: false, isPending: true, data: undefined },
      { isSuccess: false, isPending: false, data: undefined },
      { isSuccess: true, isPending: false, data: { config: { hideFilesTab: true } } },
    ]) {
      Object.assign(state, value)
      await act(async () => root.render(<PermissionAccessBoundary configKey='hideFilesTab'><span>protected-content</span></PermissionAccessBoundary>))
      expect(container.textContent).not.toContain('protected-content')
    }
    Object.assign(state, { isSuccess: true, isPending: false, data: { config: null } })
    await act(async () => root.render(<PermissionAccessBoundary configKey='hideFilesTab'><span>protected-content</span></PermissionAccessBoundary>))
    expect(container.textContent).toContain('protected-content')
    await act(async () => root.unmount())
  })
})
