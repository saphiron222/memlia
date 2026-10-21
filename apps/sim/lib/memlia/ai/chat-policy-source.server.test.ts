// Copyright 2026 Memlia. All rights reserved.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getModelSunsetStatus, getProviderModels } from '@/providers/models'
import { readChatInstallationPolicyFile } from './chat-policy-source.server'

const native = {
  lstatSync: fs.lstatSync,
  fstatSync: fs.fstatSync,
  accessSync: fs.accessSync,
  openSync: fs.openSync,
  readSync: fs.readSync,
  closeSync: fs.closeSync,
}
const unavailable = 'Chat installation policy is unavailable.'
let directory: string
let file: string
const ancestors = new Set<string>()
function configuration(provider: 'openai' | 'anthropic' = 'openai') {
  return {
    enabled: true,
    provider,
    model: getProviderModels(provider).find(
      (model) => getModelSunsetStatus(model) !== 'deprecated'
    )!,
    destination: 'official',
    data: { conversation: true, catalogue: true, workflow: 'catalogue_only' },
  }
}
function write(contents: string | Buffer) {
  if (fs.existsSync(file)) fs.chmodSync(file, 0o600)
  fs.writeFileSync(file, contents, { mode: 0o600 })
  fs.chmodSync(file, 0o444)
}
function metadata(stats: fs.Stats): fs.Stats {
  // Only administrator ownership/parent permissions are simulated on macOS.
  // The descriptor, contents, symlinks, lengths and inode replacement remain real.
  return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, {
    uid: 0,
    ...(stats.isDirectory() ? { mode: (stats.mode & ~0o777) | 0o555 } : {}),
  })
}
function denyWrite() {
  throw Object.assign(new Error('test-only denied'), { code: 'EACCES' })
}
function refuses() {
  expect(() => readChatInstallationPolicyFile()).toThrowError(new Error(unavailable))
}

beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'memlia-policy-')))
  file = path.join(directory, 'policy.json')
  ancestors.clear()
  for (let parent = directory; ; parent = path.dirname(parent)) {
    ancestors.add(parent)
    if (parent === path.dirname(parent)) break
  }
  write(JSON.stringify(configuration()))
  vi.stubEnv('MEMLIA_CHAT_POLICY_FILE', file)
  vi.spyOn(os, 'platform').mockReturnValue('linux')
  vi.spyOn(fs, 'lstatSync').mockImplementation((target) => metadata(native.lstatSync(target)))
  vi.spyOn(fs, 'fstatSync').mockImplementation((fd) => metadata(native.fstatSync(fd)))
  vi.spyOn(fs, 'accessSync').mockImplementation((target, mode) => {
    if (mode === fs.constants.W_OK && ancestors.has(String(target))) return denyWrite()
    return native.accessSync(target, mode)
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  fs.rmSync(directory, { recursive: true, force: true })
})

describe('installation file observation — no admission or activation', () => {
  it.each(['openai', 'anthropic'] as const)(
    'reads the real bounded %s document, keeping the decision frozen and blocked',
    (provider) => {
      write(JSON.stringify(configuration(provider)))
      const result = readChatInstallationPolicyFile()
      expect(result.kind).toBe('installation_file_observation')
      expect(result.policy).toEqual({
        ...configuration(provider),
        kind: 'configuration_decision',
        activation: 'blocked',
      })
      expect(Object.isFrozen(result)).toBe(true)
      expect(Object.isFrozen(result.policy)).toBe(true)
      expect(Object.isFrozen(result.policy.data)).toBe(true)
      expect(JSON.stringify(result)).not.toContain(directory)
      expect(Object.keys(result).sort()).toEqual(['kind', 'policy'])
    }
  )
  it.each([undefined, '', 'relative.json', '/tmp/../policy.json', '/'.repeat(4097)])(
    'refuses an absent or noncanonical server path (%#) before opening a file',
    (value) => {
      vi.stubEnv('MEMLIA_CHAT_POLICY_FILE', value)
      vi.stubEnv('NEXT_PUBLIC_MEMLIA_CHAT_POLICY_FILE', file)
      const open = vi.spyOn(fs, 'openSync')
      refuses()
      expect(open).not.toHaveBeenCalled()
    }
  )
  it('accepts exactly 4096 bytes and rejects 4097 bytes', () => {
    const text = JSON.stringify(configuration())
    write(text.padEnd(4096, ' '))
    expect(readChatInstallationPolicyFile().policy.activation).toBe('blocked')
    write(text.padEnd(4097, ' '))
    refuses()
  })
  it.each(['', '{', '\uFEFF{}', Buffer.from([0xc3, 0x28])])(
    'refuses malformed JSON or invalid UTF-8 (%#)',
    (input) => {
      write(input)
      refuses()
    }
  )
  it.each([
    { enabled: false },
    { provider: 'ollama' },
    { model: 'unknown-model' },
    { destination: 'https://example.invalid' },
    { apiKey: 'FICTITIOUS_CANARY' },
  ])('uses the native strict policy parser without fallback (%#)', (override) => {
    write(JSON.stringify({ ...configuration(), ...override }))
    refuses()
  })
  it('has no last-good cache after removal, corruption or a path change', () => {
    const original = readChatInstallationPolicyFile()
    write('{}')
    refuses()
    fs.unlinkSync(file)
    refuses()
    vi.stubEnv('MEMLIA_CHAT_POLICY_FILE', path.join(directory, 'missing.json'))
    refuses()
    expect(original.policy.activation).toBe('blocked')
  })
  it('does not read configuration during module import', async () => {
    const open = vi.spyOn(fs, 'openSync')
    const stat = vi.spyOn(fs, 'lstatSync')
    vi.resetModules()
    await import('./chat-policy-source.server')
    expect(open).not.toHaveBeenCalled()
    expect(stat).not.toHaveBeenCalled()
  })
})

describe('POSIX ownership and bounded descriptor lifecycle', () => {
  it('refuses a real file owned by the test user instead of pretending it is administrator-owned', () => {
    vi.mocked(fs.lstatSync).mockImplementation(native.lstatSync)
    vi.mocked(fs.fstatSync).mockImplementation(native.fstatSync)
    refuses()
  })
  it.each(['darwin', 'win32'] as const)(
    'refuses the unqualified %s host without opening files',
    (platform) => {
      vi.mocked(os.platform).mockReturnValue(platform)
      const open = vi.spyOn(fs, 'openSync')
      refuses()
      expect(open).not.toHaveBeenCalled()
    }
  )
  it.each(['getuid', 'geteuid'] as const)('refuses a root web identity (%s)', (method) => {
    vi.spyOn(process, method).mockReturnValue(0)
    refuses()
  })
  it.each(['geteuid', 'getegid'] as const)(
    'refuses a changed effective identity (%s)',
    (method) => {
      vi.spyOn(process, method).mockReturnValue(424242)
      refuses()
    }
  )
  it('refuses an unavailable OS write-access check', () => {
    vi.mocked(fs.accessSync).mockImplementation(() => {
      throw Object.assign(new Error('FICTITIOUS_CANARY'), { code: 'EIO' })
    })
    refuses()
  })
  it.each([0o464, 0o446, 0o666])('refuses writable file permissions %i', (mode) => {
    fs.chmodSync(file, mode)
    refuses()
  })
  it('refuses write access allowed by the OS even when POSIX mode bits look read-only', () => {
    vi.mocked(fs.accessSync).mockImplementation((target, mode) => {
      if (String(target) === file && mode === fs.constants.W_OK) return
      return denyWrite()
    })
    refuses()
  })
  it('refuses a writable parent or a parent not owned by root', () => {
    for (const override of [{ uid: process.getuid() }, { mode: 0o40777 }]) {
      vi.mocked(fs.lstatSync).mockImplementation((target) => {
        const stat = metadata(native.lstatSync(target))
        return String(target) === directory ? Object.assign(stat, override) : stat
      })
      refuses()
    }
  })
  it('refuses real directory and symbolic-link leaves without touching their targets', () => {
    fs.unlinkSync(file)
    fs.mkdirSync(file)
    refuses()
    fs.rmdirSync(file)
    const target = path.join(directory, 'sentinel.json')
    fs.writeFileSync(target, JSON.stringify(configuration()), { mode: 0o444 })
    fs.symlinkSync(target, file)
    refuses()
    expect(fs.readFileSync(target, 'utf8')).toBe(JSON.stringify(configuration()))
  })
  it('refuses a real symbolic-link parent', () => {
    const link = path.join(directory, 'alias')
    fs.symlinkSync(directory, link)
    vi.stubEnv('MEMLIA_CHAT_POLICY_FILE', path.join(link, 'policy.json'))
    refuses()
  })
  it('refuses a real inode replacement after open and closes the original descriptor', () => {
    const replacement = path.join(directory, 'replacement.json')
    fs.writeFileSync(replacement, JSON.stringify(configuration('anthropic')), { mode: 0o444 })
    const close = vi.spyOn(fs, 'closeSync')
    vi.spyOn(fs, 'openSync').mockImplementation((target, flags, mode) => {
      const fd = native.openSync(target, flags, mode)
      fs.renameSync(file, path.join(directory, 'previous.json'))
      fs.renameSync(replacement, file)
      return fd
    })
    refuses()
    expect(close).toHaveBeenCalledOnce()
  })
  it('refuses growth during a real read and never reads more than the bound plus one', () => {
    let bytesRequested = 0
    vi.spyOn(fs, 'readSync').mockImplementation((fd, buffer, offset, length, position) => {
      bytesRequested += length
      fs.chmodSync(file, 0o600)
      fs.appendFileSync(file, ' '.repeat(4097))
      fs.chmodSync(file, 0o444)
      return native.readSync(fd, buffer, offset, length, position)
    })
    refuses()
    expect(bytesRequested).toBeLessThanOrEqual(4097)
  })
  it('closes on a read failure and hides all raw error details', () => {
    const close = vi.spyOn(fs, 'closeSync')
    vi.spyOn(fs, 'readSync').mockImplementation(() => {
      throw new Error(`FICTITIOUS_CANARY ${file}`)
    })
    refuses()
    expect(close).toHaveBeenCalledOnce()
  })
  it('does not return a successful decision when closing the descriptor fails', () => {
    vi.spyOn(fs, 'closeSync').mockImplementation((fd) => {
      native.closeSync(fd)
      throw new Error('FICTITIOUS_CANARY close')
    })
    refuses()
  })
})

it('reads the explicit local backend from the same administrator policy file', () => {
  write(
    JSON.stringify({
      ...configuration(),
      localBackend: {
        kind: 'memlia_local_chat',
        version: 1,
        budgetWindow: { id: 'cabinet_chat_v1', version: 7 },
      },
    })
  )
  const result = readChatInstallationPolicyFile()
  expect(result.policy.localBackend).toEqual({
    kind: 'memlia_local_chat',
    version: 1,
    budgetWindow: { id: 'cabinet_chat_v1', version: 7 },
  })
  expect(result.policy.activation).toBe('blocked')
  write(JSON.stringify({ ...configuration(), localBackend: null }))
  refuses()
})
