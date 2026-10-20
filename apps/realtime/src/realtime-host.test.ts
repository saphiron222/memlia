// Copyright (c) 2026 Memlia. All rights reserved.
import { once } from 'node:events'
import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const observed = vi.hoisted(() => ({
  servers: [] as Server[],
  hosts: [] as unknown[],
}))

const teardown = vi.hoisted(() => ({
  revalidation: vi.fn(() => {}),
  flush: vi.fn(async () => {}),
  transport: vi.fn(async () => {}),
  connections: vi.fn(async () => {}),
  rooms: vi.fn(async () => {}),
  adapter: vi.fn(async () => {}),
  store: vi.fn(async () => {}),
}))

// Keep the HTTP listener real. Refuse non-loopback binds in the test itself,
// including the historical hard-coded 0.0.0.0 path exercised by the RED.
vi.mock('http', async (importOriginal) => {
  const native = await importOriginal<typeof import('node:http')>()
  return {
    ...native,
    createServer: () => {
      const server = native.createServer()
      observed.servers.push(server)
      const listen = server.listen
      vi.spyOn(server, 'listen').mockImplementation((...args) => {
        const host: unknown = args[1]
        observed.hosts.push(host)
        if (host === '127.0.0.1') return Reflect.apply(listen, server, args)
        return server
      })
      return server
    },
  }
})

// DB, Socket.IO, rooms, authentication and business handlers are explicit
// boundaries here. This suite qualifies configuration and the real HTTP bind,
// not authentication, permissions, collaboration or the database.
vi.mock('@sim/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))
vi.mock('@/config/socket', () => ({
  createSocketIOServer: async () => ({
    use: vi.fn(),
    on: vi.fn(),
    engine: { on: vi.fn() },
    close: teardown.transport,
  }),
  shutdownSocketIOAdapter: teardown.adapter,
}))
vi.mock('@/database/preflight', () => ({ assertSchemaCompatibility: vi.fn() }))
vi.mock('@/access-revalidation', () => ({
  startAccessRevalidationSweep: () => ({ stop: teardown.revalidation }),
}))
vi.mock('@/handlers', () => ({ setupAllHandlers: vi.fn() }))
vi.mock('@/handlers/connection', () => ({ waitForConnectionCleanup: teardown.connections }))
vi.mock('@/handlers/file-doc', () => ({
  flushAllFileDocRooms: teardown.flush,
  registerFileDocPresenceRelay: vi.fn(),
}))
vi.mock('@/handlers/file-doc-store', () => ({
  initFileDocStore: vi.fn(),
  getFileDocStore: () => ({ shutdown: teardown.store }),
}))
vi.mock('@/middleware/auth', () => ({ authenticateSocket: vi.fn() }))
vi.mock('@/rooms', () => {
  class RoomManager {
    async initialize() {}
    async shutdown() {
      await teardown.rooms()
    }
  }
  return { MemoryRoomManager: RoomManager, RedisRoomManager: RoomManager }
})
vi.mock('@/routes/http', () => ({
  createHttpHandler: () => (_request: unknown, response: import('node:http').ServerResponse) => {
    response.writeHead(200, { 'Content-Type': 'text/plain' })
    response.end('owned-listener')
  },
}))

function preserveListeners<T>(read: () => T[], remove: (listener: T) => void): () => void {
  const before = read()
  return () => {
    for (const listener of read()) {
      if (!before.includes(listener)) remove(listener)
    }
    expect(read()).toEqual(before)
  }
}

let restoreListeners: (() => void)[]

beforeEach(() => {
  vi.resetModules()
  observed.servers.length = 0
  observed.hosts.length = 0
  for (const port of Object.values(teardown)) port.mockReset()
  vi.stubEnv('REALTIME_HOST', undefined)
  vi.stubEnv('REDIS_URL', undefined)
  vi.stubEnv('DISABLE_AUTH', undefined)
  restoreListeners = [
    preserveListeners(
      () => process.listeners('uncaughtException'),
      (listener) => process.removeListener('uncaughtException', listener)
    ),
    preserveListeners(
      () => process.listeners('unhandledRejection'),
      (listener) => process.removeListener('unhandledRejection', listener)
    ),
    preserveListeners(
      () => process.listeners('SIGINT'),
      (listener) => process.removeListener('SIGINT', listener)
    ),
    preserveListeners(
      () => process.listeners('SIGTERM'),
      (listener) => process.removeListener('SIGTERM', listener)
    ),
  ]
})

async function ownShutdownListener() {
  const before = new Set(process.listeners('SIGTERM'))
  await import('./index')
  await vi.waitFor(() =>
    expect(process.listeners('SIGTERM').filter((listener) => !before.has(listener))).toHaveLength(1)
  )
  return process.listeners('SIGTERM').find((listener) => !before.has(listener))!
}

describe('realtime shutdown result', () => {
  it('exits successfully only after every owned cleanup step completes', async () => {
    const shutdown = await ownShutdownListener()
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    vi.useFakeTimers()
    try {
      await shutdown('SIGTERM')
      expect(exit).toHaveBeenCalledExactlyOnceWith(0)
      expect(teardown.flush).toHaveBeenCalledTimes(2)
      expect(teardown.connections).toHaveBeenCalledOnce()
      expect(teardown.rooms).toHaveBeenCalledOnce()
      expect(teardown.adapter).toHaveBeenCalledOnce()
      expect(teardown.store).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  it.each(['flush', 'transport', 'connections', 'rooms', 'adapter', 'store'] as const)(
    'retains failure of %s while attempting the remaining owned cleanup',
    async (stage) => {
      const shutdown = await ownShutdownListener()
      teardown[stage].mockRejectedValueOnce(new Error('synthetic cleanup refusal'))
      const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
      vi.useFakeTimers()
      try {
        await shutdown('SIGTERM')
        expect(exit).toHaveBeenCalledExactlyOnceWith(1)
        expect(teardown.connections).toHaveBeenCalledOnce()
        expect(teardown.flush).toHaveBeenCalledTimes(2)
        expect(teardown.rooms).toHaveBeenCalledOnce()
        expect(teardown.adapter).toHaveBeenCalledOnce()
        expect(teardown.store).toHaveBeenCalledOnce()
        expect(teardown.connections.mock.invocationCallOrder[0]).toBeLessThan(
          teardown.store.mock.invocationCallOrder[0]
        )
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        vi.clearAllTimers()
        vi.useRealTimers()
      }
    }
  )

  it('still attempts transport, drain and stores when stopping the sweep throws', async () => {
    const shutdown = await ownShutdownListener()
    teardown.revalidation.mockImplementationOnce(() => {
      throw new Error('synthetic sweep stop refusal')
    })
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    vi.useFakeTimers()
    try {
      await shutdown('SIGTERM')
      expect(exit).toHaveBeenCalledExactlyOnceWith(1)
      expect(teardown.transport).toHaveBeenCalledOnce()
      expect(teardown.connections).toHaveBeenCalledOnce()
      expect(teardown.store).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('retains a final document flush failure after a successful initial flush', async () => {
    const shutdown = await ownShutdownListener()
    teardown.flush
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('synthetic final flush refusal'))
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    vi.useFakeTimers()
    try {
      await shutdown('SIGTERM')
      expect(exit).toHaveBeenCalledExactlyOnceWith(1)
      expect(teardown.flush).toHaveBeenCalledTimes(2)
      expect(teardown.rooms).toHaveBeenCalledOnce()
      expect(teardown.adapter).toHaveBeenCalledOnce()
      expect(teardown.store).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('keeps a second signal from starting another cleanup while the first flush is pending', async () => {
    const shutdown = await ownShutdownListener()
    let release!: () => void
    const flushing = new Promise<void>((resolve) => {
      release = resolve
    })
    teardown.flush.mockReturnValueOnce(flushing)
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    vi.useFakeTimers()
    try {
      const pending = shutdown('SIGTERM')
      await shutdown('SIGINT')
      expect(teardown.revalidation).toHaveBeenCalledOnce()
      expect(teardown.flush).toHaveBeenCalledOnce()
      expect(exit).not.toHaveBeenCalled()
      release()
      await pending
      expect(exit).toHaveBeenCalledExactlyOnceWith(0)
      expect(teardown.transport).toHaveBeenCalledOnce()
      expect(teardown.flush).toHaveBeenCalledTimes(2)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      release()
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })
})

afterEach(async () => {
  for (const server of observed.servers) {
    server.closeAllConnections()
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
    expect(server.listening).toBe(false)
  }
  for (const restore of restoreListeners) restore()
})

describe('operator-selected realtime bind', () => {
  it('preserves the container default and authentication when the setting is absent', async () => {
    const { env, isAuthDisabled } = await import('./env')
    expect(env).toHaveProperty('REALTIME_HOST', '0.0.0.0')
    expect(isAuthDisabled).toBe(false)
  })

  it.each(['127.0.0.1', '0.0.0.0', '::1', '::'])('accepts the IP literal %s', async (host) => {
    vi.stubEnv('REALTIME_HOST', host)
    const { env } = await import('./env')
    expect(env).toHaveProperty('REALTIME_HOST', host)
  })

  it.each(['', 'localhost', 'https://127.0.0.1', '127.0.0.1:3002', ' 127.0.0.1 ', '999.1.1.1'])(
    'refuses an explicit invalid bind rather than reverting to a wildcard: %s',
    async (host) => {
      vi.stubEnv('REALTIME_HOST', host)
      await expect(import('./env')).rejects.toThrow('Invalid realtime server environment')
      expect(observed.servers).toHaveLength(0)
    }
  )

  it('makes the actual entry point listen on IPv4 loopback and closes its owned listener', async () => {
    const native = await vi.importActual<typeof import('node:http')>('node:http')
    const reservation = native.createServer()
    reservation.listen(0, '127.0.0.1')
    await once(reservation, 'listening')
    const address = reservation.address()
    if (!address || typeof address === 'string') throw new Error('port reservation unavailable')
    const port = address.port
    await new Promise<void>((resolve) => reservation.close(() => resolve()))
    vi.stubEnv('PORT', String(port))
    vi.stubEnv('REALTIME_HOST', '127.0.0.1')

    await import('./index')
    await vi.waitFor(() => expect(observed.hosts).toHaveLength(1))
    expect(observed.hosts).toEqual(['127.0.0.1'])
    const server = observed.servers[0]
    await vi.waitFor(() => expect(server.listening).toBe(true))
    expect(server.address()).toEqual({ address: '127.0.0.1', family: 'IPv4', port })
    const result = await new Promise<{ status: number | undefined; body: string }>(
      (resolve, reject) => {
        const request = native.get(
          { hostname: '127.0.0.1', port, path: '/health', agent: false },
          (response) => {
            let body = ''
            response.setEncoding('utf8')
            response.on('data', (part: string) => {
              body += part
            })
            response.on('end', () => resolve({ status: response.statusCode, body }))
          }
        )
        request.on('error', reject)
        request.setTimeout(1000, () => request.destroy(new Error('owned request timeout')))
      }
    )
    expect(result).toEqual({ status: 200, body: 'owned-listener' })
  })
})
