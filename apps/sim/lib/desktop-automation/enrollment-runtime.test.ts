// Copyright (c) 2026 Memlia. All rights reserved.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  platform: 'linux',
  files: new Map<string, any>(),
  descriptors: new Map<number, string>(),
  nextFd: 10,
  reads: 0,
  opens: 0,
  closes: 0,
  configImports: 0,
  serviceImports: 0,
  afterRead: null as null | (() => void),
  closeFails: false,
  authority: { close: vi.fn() },
  service: Object.freeze({ marker: 'service-double' }),
  makeAuthority: vi.fn(),
  makeService: vi.fn(),
}))
vi.mock('node:os', () => ({ default: { platform: () => h.platform } }))
vi.mock('node:fs', async (original) => {
  const native = await original<typeof import('node:fs')>()
  return {
    default: {
      constants: native.constants,
      lstatSync: (path: string) => {
        const entry = h.files.get(path)
        if (!entry) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        return { ...entry.stat }
      },
      accessSync: (path: string) => {
        if (h.files.get(path)?.writable) return
        throw Object.assign(new Error('denied'), { code: 'EACCES' })
      },
      openSync: (path: string, flags: number) => {
        expect(flags & native.constants.O_NOFOLLOW).not.toBe(0)
        expect(flags & native.constants.O_NONBLOCK).not.toBe(0)
        h.opens++
        const fd = h.nextFd++
        h.descriptors.set(fd, path)
        return fd
      },
      fstatSync: (fd: number) => ({ ...h.files.get(h.descriptors.get(fd)!)?.stat }),
      readSync: (fd: number, buffer: Buffer, offset: number, count: number, position: number) => {
        h.reads++
        const bytes = h.files.get(h.descriptors.get(fd)!)?.bytes as Buffer
        const size = Math.max(0, Math.min(count, bytes.length - position))
        bytes.copy(buffer, offset, position, position + size)
        h.afterRead?.()
        return size
      },
      closeSync: (fd: number) => {
        h.closes++
        h.descriptors.delete(fd)
        if (h.closeFails) throw new Error('close refused')
      },
    },
  }
})
vi.mock('./enrollment-authority', () => {
  h.configImports++
  return { createNativeEnrollmentAuthority: h.makeAuthority }
})
vi.mock('./enrollment', () => {
  h.serviceImports++
  return { createEnrollmentService: h.makeService }
})
const configPath = '/etc/memlia/enrollment.json'
const secretPath = '/run/memlia/ca/passphrase'
const shape = () => ({
  version: 'memlia.agent-enrollment-runtime/v1',
  installation: { id: 'fixture-installation', fqdn: 'https://cabinet.example:8443' },
  openssl: { path: '/usr/bin/openssl', sha256: 'a'.repeat(64), administratorGroupIds: [0] },
  caCertificatePath: '/run/memlia/ca/cert.pem',
  caCertificateSha256: 'b'.repeat(64),
  encryptedKeyPath: '/run/memlia/ca/key.pem',
  passphraseFilePath: secretPath,
  spoolDirectory: '/run/memlia/ca/spool',
  certificateDays: 7,
})
function entry(path: string, bytes?: Buffer, uid = 0, mode = 0o755) {
  h.files.set(path, {
    bytes,
    writable: false,
    stat: {
      uid,
      gid: uid,
      mode,
      nlink: 1,
      dev: 1,
      ino: h.files.size + 1,
      size: bytes?.length ?? 0,
      mtimeMs: 1,
      ctimeMs: 1,
      isFile: () => bytes !== undefined,
      isDirectory: () => bytes === undefined,
      isSymbolicLink: () => false,
    },
  })
}
function config(value: unknown = shape()) {
  entry(configPath, Buffer.from(JSON.stringify(value)), 0, 0o444)
}
async function load() {
  return import('./enrollment-runtime')
}
beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  h.files.clear()
  h.descriptors.clear()
  Object.assign(h, {
    platform: 'linux',
    nextFd: 10,
    reads: 0,
    opens: 0,
    closes: 0,
    configImports: 0,
    serviceImports: 0,
    afterRead: null,
    closeFails: false,
  })
  for (const name of ['getuid', 'geteuid', 'getgid', 'getegid'] as const)
    vi.spyOn(process, name).mockReturnValue(1001)
  vi.stubEnv('MEMLIA_AGENT_ENROLLMENT_CONFIG', configPath)
  for (const path of ['/', '/etc', '/etc/memlia', '/run', '/run/memlia']) entry(path)
  entry('/run/memlia/ca', undefined, 1001, 0o700)
  config()
  entry(secretPath, Buffer.from('fictive-passphrase-only'), 1001, 0o600)
  h.makeAuthority.mockResolvedValue(h.authority)
  h.makeService.mockReturnValue(h.service)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('enrollment runtime (OS, filesystem and native ports doubled)', () => {
  it('absent config does not read files or import authority/service and remains closed', async () => {
    vi.stubEnv('MEMLIA_AGENT_ENROLLMENT_CONFIG', '')
    const runtime = await load()
    vi.stubEnv('MEMLIA_AGENT_ENROLLMENT_CONFIG', configPath)
    expect(runtime.getEnrollmentOrigin()).toBeNull()
    expect(await runtime.getEnrollmentService()).toBeNull()
    expect(h.opens).toBe(0)
    expect([h.configImports, h.serviceImports]).toEqual([0, 0])
  })
  it('observes immutable origin without reading secret or initializing CA/database', async () => {
    const runtime = await load()
    expect(runtime.getEnrollmentOrigin()).toBe('https://cabinet.example:8443')
    const opens = h.opens
    config({ ...shape(), installation: { id: 'other', fqdn: 'https://other.example' } })
    expect(runtime.getEnrollmentOrigin()).toBe('https://cabinet.example:8443')
    expect(h.opens).toBe(opens)
    expect([h.configImports, h.serviceImports]).toEqual([0, 0])
  })
  it.each([
    () => {
      h.platform = 'darwin'
    },
    () => {
      vi.spyOn(process, 'geteuid').mockReturnValue(0)
    },
    () => {
      vi.spyOn(process, 'getegid').mockReturnValue(1002)
    },
    () => {
      h.files.get(configPath).stat.uid = 1001
    },
    () => {
      h.files.get('/etc').stat.mode = 0o775
    },
    () => {
      h.files.get('/etc/memlia').writable = true
    },
    () => {
      h.files.get(configPath).writable = true
    },
    () => {
      h.files.get(configPath).stat.nlink = 2
    },
    () => {
      h.files.get('/etc').stat.isSymbolicLink = () => true
    },
    () => {
      h.files.get(configPath).stat.isSymbolicLink = () => true
    },
    () => {
      h.closeFails = true
    },
    () => {
      h.afterRead = () => {
        h.files.get(configPath).stat.ctimeMs++
      }
    },
    () => {
      entry(configPath, Buffer.alloc(8193, 32), 0, 0o444)
    },
    () => {
      entry(configPath, Buffer.from([0xff]), 0, 0o444)
    },
  ])(
    'rejects an unsafe environment or protected-file observation before imports',
    async (change) => {
      change()
      const runtime = await load()
      expect(runtime.getEnrollmentOrigin()).toBeNull()
      expect(await runtime.getEnrollmentService()).toBeNull()
      expect([h.configImports, h.serviceImports]).toEqual([0, 0])
      expect(h.descriptors.size).toBe(0)
    }
  )
  it.each([
    { ...shape(), extra: true },
    { ...shape(), version: 'other' },
    { ...shape(), passphrase: 'forbidden-inline' },
    { ...shape(), certificateDays: 31 },
    ...[
      'http://cabinet.example',
      'https://cabinet.example/',
      'https://user@cabinet.example',
      'https://cabinet.example?x=1',
    ].map((fqdn) => ({ ...shape(), installation: { id: 'fixed', fqdn } })),
  ])('rejects noncanonical or unknown config without CA or service', async (value) => {
    config(value)
    const runtime = await load()
    expect(runtime.getEnrollmentOrigin()).toBeNull()
    expect(await runtime.getEnrollmentService()).toBeNull()
    expect([h.configImports, h.serviceImports]).toEqual([0, 0])
  })
  it.each([
    () => {
      h.files.get(secretPath).stat.mode = 0o644
    },
    () => {
      h.files.get(secretPath).stat.uid = 0
    },
    () => {
      h.files.get(secretPath).stat.nlink = 2
    },
    () => {
      h.files.get('/run/memlia/ca').stat.mode = 0o755
    },
    () => {
      h.files.get(secretPath).stat.isSymbolicLink = () => true
    },
    () => {
      entry(secretPath, Buffer.alloc(1025, 65), 1001, 0o600)
    },
    () => {
      entry(secretPath, Buffer.alloc(15, 65), 1001, 0o600)
    },
    ...[0, 10, 13].map((x) => () => {
      entry(secretPath, Buffer.concat([Buffer.alloc(16, 65), Buffer.from([x])]), 1001, 0o600)
    }),
  ])('refuses unsafe or malformed secret before authority import', async (change) => {
    change()
    const runtime = await load()
    expect(await runtime.getEnrollmentService()).toBeNull()
    expect([h.configImports, h.serviceImports]).toEqual([0, 0])
    expect(h.descriptors.size).toBe(0)
  })
  it('shares initialization, captures configuration and zeroizes its secret after CA capture', async () => {
    let finish!: (value: typeof h.authority) => void
    let held: Buffer | undefined
    h.makeAuthority.mockImplementation((value) => {
      held = value.passphrase
      expect(value.installation).toEqual(shape().installation)
      expect(Object.isFrozen(value.installation)).toBe(true)
      expect(held?.toString()).toBe('fictive-passphrase-only')
      return new Promise((resolve) => {
        finish = resolve
      })
    })
    const runtime = await load()
    const first = runtime.getEnrollmentService()
    const second = runtime.getEnrollmentService()
    expect(second).toBe(first)
    await vi.waitFor(() => expect(h.makeAuthority).toHaveBeenCalledOnce())
    expect(h.serviceImports).toBe(0)
    finish(h.authority)
    expect(await first).toBe(h.service)
    expect(held?.every((x) => x === 0)).toBe(true)
    expect(await runtime.getEnrollmentService()).toBe(h.service)
    expect(h.makeService).toHaveBeenCalledWith({
      authority: h.authority,
      installation: shape().installation,
    })
    expect(h.makeAuthority).toHaveBeenCalledOnce()
  })
  it('CA failure stays closed, zeroizes the temporary secret and never imports service', async () => {
    let held: Buffer | undefined
    h.makeAuthority.mockImplementation((value) => {
      held = value.passphrase
      throw new Error('private cause')
    })
    const runtime = await load()
    expect(await runtime.getEnrollmentService()).toBeNull()
    expect(await runtime.getEnrollmentService()).toBeNull()
    expect(held?.every((x) => x === 0)).toBe(true)
    expect(h.makeAuthority).toHaveBeenCalledOnce()
    expect(h.serviceImports).toBe(0)
  })
  it('closes created authority if composing service fails, without retry', async () => {
    h.makeService.mockImplementation(() => {
      throw new Error('private database import failure')
    })
    const runtime = await load()
    expect(await runtime.getEnrollmentService()).toBeNull()
    expect(await runtime.getEnrollmentService()).toBeNull()
    expect(h.authority.close).toHaveBeenCalledOnce()
    expect(h.makeAuthority).toHaveBeenCalledOnce()
  })
})
