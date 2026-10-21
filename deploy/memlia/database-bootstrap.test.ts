// Copyright (c) 2026 Memlia. All rights reserved.

import { chmod, link, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseBootstrapConfig, readBootstrapConfig } from './database-bootstrap'
import { afterEach, describe, expect, test } from 'bun:test'

const directories: string[] = []
const nonce = '0123456789abcdef0123456789abcdef'
function config() {
  return {
    version: 'memlia.database-bootstrap/v1',
    deploymentId: nonce,
    database: `memlia_ui_${nonce}`,
    stateDirectory: '/run/memlia-bootstrap/state',
    adminUrl: 'postgres://postgres:AdminExample0123456789@database:5432/postgres',
    urls: Object.fromEntries(
      ['migrate', 'web', 'realtime', 'worker', 'transport'].map((role) => [
        role,
        `postgres://ui_${role}_${nonce}:ExamplePassword_${role}_0123456789@database:5432/memlia_ui_${nonce}`,
      ])
    ),
  }
}
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true })
})
describe('installation database authority', () => {
  test('captures a strict five-role installation without retaining a mutable config', () => {
    const value = config()
    const captured = parseBootstrapConfig(value)
    value.urls.web = value.urls.migrate
    expect(captured.roles.web.name).toBe(`ui_web_${nonce}`)
    expect(Object.isFrozen(captured)).toBe(true)
    expect(Object.isFrozen(captured.roles)).toBe(true)
    expect(Object.isFrozen(captured.roles.web)).toBe(true)
  })
  test.each([
    (c: any) => {
      c.extra = true
    },
    (c: any) => {
      Reflect.deleteProperty(c.urls, 'worker')
    },
    (c: any) => {
      c.urls.extra = c.urls.web
    },
    (c: any) => {
      c.urls.web = c.urls.migrate
    },
    (c: any) => {
      c.urls.web = c.urls.web.replace('@database:', '@elsewhere:')
    },
    (c: any) => {
      c.urls.web += '?options=-csuperuser=on'
    },
    (c: any) => {
      c.urls.web += '#secret'
    },
    (c: any) => {
      c.urls.web = c.urls.web.replace('ui_web_', 'pg_web_')
    },
    (c: any) => {
      c.urls.web = c.urls.web.replace('ui_web_', 'bad%22name_')
    },
    (c: any) => {
      c.urls.web = c.urls.web.replace('ExamplePassword_web_0123456789', 'short')
    },
    (c: any) => {
      const u = new URL(c.adminUrl)
      u.pathname = '/other'
      c.adminUrl = u.toString()
    },
    (c: any) => {
      c.deploymentId += '\n'
    },
    (c: any) => {
      c.database = 'business;DROP DATABASE postgres'
    },
    (c: any) => {
      c.stateDirectory = 'relative'
    },
    (c: any) => {
      c.stateDirectory = '/run/../tmp/state'
    },
    (c: any) => {
      c.stateDirectory = '/'
    },
  ])('refuses a malformed or cross-purpose configuration before any connection', (mutate) => {
    const value = config()
    mutate(value)
    expect(() => parseBootstrapConfig(value)).toThrow('bootstrap_configuration_refused')
  })
  test('accepts a protected regular configuration and refuses symlink or loose mode', async () => {
    const directory = await mkdtemp(join(await realpath(tmpdir()), 'memlia-bootstrap-test-'))
    directories.push(directory)
    await chmod(directory, 0o700)
    const file = join(directory, 'config.json')
    await writeFile(file, JSON.stringify(config()), { mode: 0o600 })
    expect((await readBootstrapConfig(file)).config.database).toBe(`memlia_ui_${nonce}`)
    const link = join(directory, 'link.json')
    await symlink(file, link)
    await expect(readBootstrapConfig(link)).rejects.toThrow('bootstrap_configuration_refused')
    await chmod(file, 0o644)
    await expect(readBootstrapConfig(file)).rejects.toThrow('bootstrap_configuration_refused')
  })
  test('rejects hardlinks, overlarge input and writable parent before parsing', async () => {
    const directory = await mkdtemp(join(await realpath(tmpdir()), 'memlia-bootstrap-test-'))
    directories.push(directory)
    await chmod(directory, 0o700)
    const file = join(directory, 'config.json')
    await writeFile(file, ' '.repeat(65537), { mode: 0o600 })
    await expect(readBootstrapConfig(file)).rejects.toThrow('bootstrap_configuration_refused')
    await writeFile(file, JSON.stringify(config()))
    const hard = join(directory, 'hard.json')
    await link(file, hard)
    await expect(readBootstrapConfig(hard)).rejects.toThrow('bootstrap_configuration_refused')
    await rm(hard)
    await chmod(directory, 0o777)
    await expect(readBootstrapConfig(file)).rejects.toThrow('bootstrap_configuration_refused')
  })
  test('rejects an ancestor symlink even with a private final directory and protected leaf', async () => {
    const directory = await mkdtemp(join(await realpath(tmpdir()), 'memlia-bootstrap-test-'))
    directories.push(directory)
    await chmod(directory, 0o700)
    const real = join(directory, 'real')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(real, { mode: 0o700 })
    const file = join(real, 'config.json')
    await writeFile(file, JSON.stringify(config()), { mode: 0o600 })
    await symlink(real, join(directory, 'alias'))
    await expect(readBootstrapConfig(join(directory, 'alias', 'config.json'))).rejects.toThrow(
      'bootstrap_configuration_refused'
    )
  })
})
