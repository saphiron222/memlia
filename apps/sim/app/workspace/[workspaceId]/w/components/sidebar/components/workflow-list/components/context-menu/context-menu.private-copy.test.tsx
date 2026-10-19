// Copyright 2026 Memlia. All rights reserved.
/** @vitest-environment jsdom */
import { act, createRef, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ContextMenu } from './context-menu'

// Keep the production menu's conditions and selection callback; double Radix presentation only.
vi.mock('@sim/emcn', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({
    children,
    onSelect,
    disabled,
  }: {
    children: ReactNode
    onSelect: () => void
    disabled: boolean
  }) => (
    <button disabled={disabled} onClick={onSelect}>
      {children}
    </button>
  ),
}))
let root: Root
let container: HTMLDivElement
function mount(extra: Partial<React.ComponentProps<typeof ContextMenu>> = {}) {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  root = createRoot(container)
  act(() =>
    root.render(
      <ContextMenu
        isOpen
        position={{ x: 0, y: 0 }}
        menuRef={createRef()}
        onClose={() => {}}
        {...extra}
      />
    )
  )
}
afterEach(() => act(() => root?.unmount()))
it('keeps private copying absent by default on other menu surfaces', () => {
  mount({ onPrivateCopy: vi.fn() })
  expect(container.textContent).not.toContain('Créer une copie privée')
})
it('invokes only the private-copy action and closes for one selected workflow', () => {
  const copy = vi.fn()
  const duplicate = vi.fn()
  const close = vi.fn()
  mount({ showPrivateCopy: true, onPrivateCopy: copy, onDuplicate: duplicate, onClose: close })
  const action = Array.from(container.querySelectorAll('button')).find(
    (x) => x.textContent === 'Créer une copie privée'
  )
  expect(action).toBeDefined()
  act(() => action!.click())
  expect(copy).toHaveBeenCalledTimes(1)
  expect(close).toHaveBeenCalledTimes(1)
  expect(duplicate).not.toHaveBeenCalled()
})
it('does not offer an implicit private batch copy', () => {
  mount({ showPrivateCopy: true, onPrivateCopy: vi.fn(), selectedCount: 2 })
  expect(container.textContent).not.toContain('Créer une copie privée')
})
