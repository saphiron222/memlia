// Copyright 2026 Memlia. All rights reserved.
import { describe, expect, it, vi } from 'vitest'
import type { WorkflowDraftTransaction } from './revision'

vi.mock('@sim/db', () => ({
  workflow: { id: 'id', draftRevision: 'revision', archivedAt: 'archived' },
}))
vi.mock('drizzle-orm', () => ({ and: vi.fn(), eq: vi.fn(), isNull: vi.fn() }))

import { withWorkflowDraftMutation } from './revision'

function transaction(revision: number) {
  const write = vi.fn().mockResolvedValue([{ draftRevision: revision + 1 }])
  const lock = vi.fn().mockResolvedValue([{ draftRevision: revision }])
  const tx = {
    rollback: () => {
      throw new Error('rollback')
    },
    select: () => ({ from: () => ({ where: () => ({ limit: () => ({ for: lock }) }) }) }),
    update: () => ({ set: () => ({ where: () => ({ returning: write }) }) }),
  } as unknown as WorkflowDraftTransaction
  return { tx, write, lock }
}

describe('workflow draft mutation contract (database double)', () => {
  it('refuses an obsolete proposal before executing its mutation', async () => {
    const { tx, write } = transaction(4)
    const mutation = vi.fn(async () => ({ changed: true, value: 'new graph' }))
    await expect(withWorkflowDraftMutation(tx, 'workflow', mutation, 3)).rejects.toMatchObject({
      code: 'conflict',
    })
    expect(mutation).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })
  it('returns the committed revision for one logical mutation', async () => {
    const { tx, lock } = transaction(0)
    await expect(
      withWorkflowDraftMutation(tx, 'workflow', async () => ({ changed: true, value: 'saved' }), 0)
    ).resolves.toEqual({ value: 'saved', baseRevision: 0, draftRevision: 1 })
    expect(lock).toHaveBeenCalledWith('update')
  })

  it('does not consume a revision for a no-op', async () => {
    const { tx, write } = transaction(5)
    await expect(
      withWorkflowDraftMutation(tx, 'workflow', async () => ({ changed: false, value: null }))
    ).resolves.toEqual({ value: null, baseRevision: 5, draftRevision: 5 })
    expect(write).not.toHaveBeenCalled()
  })

  it('propagates a mutation failure without incrementing', async () => {
    const { tx, write } = transaction(2)
    await expect(
      withWorkflowDraftMutation(tx, 'workflow', async () => {
        throw new Error('abort')
      })
    ).rejects.toThrow('abort')
    expect(write).not.toHaveBeenCalled()
  })

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid expected revision %s before mutation',
    async (expected) => {
      const { tx, lock } = transaction(0)
      await expect(
        withWorkflowDraftMutation(
          tx,
          'workflow',
          async () => ({ changed: true, value: null }),
          expected
        )
      ).rejects.toMatchObject({ code: 'validation' })
      expect(lock).not.toHaveBeenCalled()
    }
  )

  it('refuses overflow instead of wrapping or losing integer precision', async () => {
    const { tx, write } = transaction(Number.MAX_SAFE_INTEGER)
    await expect(
      withWorkflowDraftMutation(tx, 'workflow', async () => ({ changed: true, value: null }))
    ).rejects.toMatchObject({ code: 'conflict' })
    expect(write).not.toHaveBeenCalled()
  })
})
