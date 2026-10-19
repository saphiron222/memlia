// Copyright 2026 Memlia. All rights reserved.
import { describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ query: vi.fn((options) => options), request: vi.fn() }))
vi.mock('@tanstack/react-query', () => ({ useQuery: mocks.query }))
vi.mock('@/lib/api/client/request', () => ({ requestJson: mocks.request }))
import { useUserPermissionConfig } from './user-permission-config'

describe('lecture des permissions de l’espace', () => {
  it('n’envoie aucune requête sans espace et distingue les caches', () => {
    useUserPermissionConfig(undefined)
    expect(mocks.query.mock.lastCall?.[0].enabled).toBe(false)
    useUserPermissionConfig('space-a')
    const a = mocks.query.mock.lastCall?.[0]
    useUserPermissionConfig('space-b')
    expect(mocks.query.mock.lastCall?.[0].queryKey).not.toEqual(a.queryKey)
  })
  it('transmet l’espace exact et le signal au contrat Apache authentifié', async () => {
    useUserPermissionConfig('space-a')
    const signal = new AbortController().signal
    await mocks.query.mock.lastCall?.[0].queryFn({ signal })
    expect(mocks.request).toHaveBeenCalledWith(expect.objectContaining({ path: '/api/permission-groups/user' }), { query: { workspaceId: 'space-a' }, signal })
  })
})
