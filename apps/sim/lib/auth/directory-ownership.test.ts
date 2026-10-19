// Copyright 2026 Memlia. All rights reserved.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { assertMembershipNotDirectoryManaged, assertInviteeNotDirectoryManaged } from './directory-ownership'
const finish = vi.fn()
const tx = { select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: finish }) }) })) }
beforeEach(() => { vi.clearAllMocks(); finish.mockResolvedValue([]) })
describe('identités encore gérées par un annuaire', () => {
  it('refuse une modification manuelle si un rattachement existe', async () => {
    finish.mockResolvedValue([{ id: 'managed' }])
    await expect(assertMembershipNotDirectoryManaged({ organizationId: 'org-a', userId: 'user-a', executor: tx as never })).rejects.toMatchObject({ code: 'forbidden', detailCode: 'SCIM_MANAGED_MEMBERSHIP' })
  })
  it('conserve les adhésions natives et propage les erreurs de lecture', async () => {
    await expect(assertMembershipNotDirectoryManaged({ organizationId: 'org-a', userId: 'user-a', executor: tx as never })).resolves.toBeUndefined()
    finish.mockRejectedValue(new Error('unavailable'))
    await expect(assertMembershipNotDirectoryManaged({ organizationId: 'org-a', userId: 'user-a', executor: tx as never })).rejects.toThrow('unavailable')
  })
  it('refuse un résultat de lookup d’invitation géré', () => {
    expect(() => assertInviteeNotDirectoryManaged({ managed: true })).toThrow()
    expect(() => assertInviteeNotDirectoryManaged({ managed: false })).not.toThrow()
  })
})
