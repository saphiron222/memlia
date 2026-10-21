// Copyright (c) 2026 Memlia. All rights reserved.
// RoomManager lifecycle is real; the Redis network boundary is explicitly doubled.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RedisRoomManager } from '@/rooms/redis-manager'

const redis = vi.hoisted(() => ({
  on: vi.fn(),
  connect: vi.fn(async () => {}),
  scriptLoad: vi.fn(async () => 'synthetic-script-hash'),
  quit: vi.fn(async () => {}),
}))

vi.mock('redis', () => ({ createClient: () => redis }))
vi.mock('@sim/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

beforeEach(() => {
  for (const method of Object.values(redis)) method.mockReset()
})

describe('RedisRoomManager shutdown', () => {
  it('releases its connection once and is no longer ready after successful shutdown', async () => {
    const manager = new RedisRoomManager({} as never, 'redis://synthetic.invalid')
    await manager.initialize()
    expect(manager.isReady()).toBe(true)
    await manager.shutdown()
    expect(manager.isReady()).toBe(false)
    await manager.shutdown()
    expect(redis.quit).toHaveBeenCalledOnce()
  })

  it('reports a failed quit to the shutdown coordinator and retains the handle for reconciliation', async () => {
    const manager = new RedisRoomManager({} as never, 'redis://synthetic.invalid')
    await manager.initialize()
    const refused = new Error('synthetic quit refusal')
    redis.quit.mockRejectedValueOnce(refused)
    await expect(manager.shutdown()).rejects.toBe(refused)
    await manager.shutdown()
    expect(redis.quit).toHaveBeenCalledTimes(2)
    expect(manager.isReady()).toBe(false)
  })

  it('does not invent an active connection when no initialization has occurred', async () => {
    const manager = new RedisRoomManager({} as never, 'redis://synthetic.invalid')
    await manager.shutdown()
    expect(manager.isReady()).toBe(false)
    expect(redis.quit).not.toHaveBeenCalled()
  })
})
