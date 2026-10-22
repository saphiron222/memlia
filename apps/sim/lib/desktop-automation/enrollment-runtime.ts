// Protected descriptor read adapted from Sim's chat-policy-source.server.ts.
// Upstream Apache-2.0 license and notices retained; modified by Memlia in 2026.
// Additional enrollment composition and secret handling: Copyright (c) 2026 Memlia.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import type { createEnrollmentService } from './enrollment'
import type { NativeEnrollmentAuthority } from './enrollment-authority'

const configLocation = process.env.MEMLIA_AGENT_ENROLLMENT_CONFIG
const unavailable = (): never => {
  throw new Error('enrollment_runtime_unavailable')
}
const absolutePath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      path.posix.isAbsolute(value) &&
      path.posix.normalize(value) === value &&
      !/[\0\r\n]/.test(value) &&
      value !== '/'
  )
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const schema = z.strictObject({
  version: z.literal('memlia.agent-enrollment-runtime/v1'),
  installation: z.strictObject({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    fqdn: z
      .string()
      .max(2048)
      .refine((value) => {
        try {
          const url = new URL(value)
          return url.protocol === 'https:' && url.origin === value && !url.username && !url.password
        } catch {
          return false
        }
      }),
  }),
  openssl: z.strictObject({
    path: absolutePath,
    sha256: digest,
    administratorGroupIds: z
      .array(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER))
      .max(16)
      .optional(),
  }),
  caCertificatePath: absolutePath,
  caCertificateSha256: digest,
  encryptedKeyPath: absolutePath,
  passphraseFilePath: absolutePath,
  spoolDirectory: absolutePath,
  certificateDays: z.number().int().min(1).max(30),
})
type Config = z.infer<typeof schema>
type Service = ReturnType<typeof createEnrollmentService>
let observedConfig: Readonly<Config> | null | undefined
let servicePromise: Promise<Service | null> | undefined

function identity() {
  if (
    os.platform() !== 'linux' ||
    process.getuid?.() !== 1001 ||
    process.geteuid?.() !== 1001 ||
    process.getgid?.() !== 1001 ||
    process.getegid?.() !== 1001
  )
    unavailable()
}
function administratorOnly(location: string, stat: fs.Stats) {
  if (stat.uid !== 0 || (stat.mode & 0o022) !== 0 || stat.isSymbolicLink()) unavailable()
  try {
    fs.accessSync(location, fs.constants.W_OK)
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      ['EACCES', 'EPERM', 'EROFS'].includes(String(error.code))
    )
      return
    return unavailable()
  }
  unavailable()
}
function directories(location: string, secret: boolean) {
  for (let current = path.posix.dirname(location); ; current = path.posix.dirname(current)) {
    const s = fs.lstatSync(current)
    if (!s.isDirectory() || s.isSymbolicLink()) unavailable()
    if (!secret || s.uid === 0) administratorOnly(current, s)
    else if (s.uid !== 1001 || (s.mode & 0o022) !== 0) unavailable()
    if (
      secret &&
      current === path.posix.dirname(location) &&
      (s.uid !== 1001 || (s.mode & 0o777) !== 0o700)
    )
      unavailable()
    if (current === '/') break
  }
}
function validFile(location: string, s: fs.Stats, secret: boolean) {
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1) unavailable()
  if (secret) {
    if (s.uid !== 1001 || ![0o400, 0o600].includes(s.mode & 0o777)) unavailable()
  } else administratorOnly(location, s)
}
function sameSnapshot(a: fs.Stats, b: fs.Stats) {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mode === b.mode &&
    a.uid === b.uid &&
    a.gid === b.gid &&
    a.size === b.size &&
    a.nlink === b.nlink &&
    a.ctimeMs === b.ctimeMs &&
    a.mtimeMs === b.mtimeMs
  )
}
/** Same bounded/no-follow/stable-descriptor pattern as the installation policy reader.
 * Secret storage is service-owned; configuration remains administrator-only. */
function readProtected(location: string, maximum: number, secret: boolean): Buffer {
  absolutePath.parse(location)
  identity()
  directories(location, secret)
  const initial = fs.lstatSync(location)
  validFile(location, initial, secret)
  let fd: number | undefined
  const buffer = Buffer.alloc(maximum + 1)
  let result: Buffer | undefined
  try {
    fd = fs.openSync(
      location,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
    )
    const before = fs.fstatSync(fd)
    validFile(location, before, secret)
    if (!sameSnapshot(initial, before) || before.size < 1 || before.size > maximum) unavailable()
    let count = 0
    while (count < buffer.length) {
      const n = fs.readSync(fd, buffer, count, buffer.length - count, count)
      if (n === 0) break
      count += n
    }
    const after = fs.fstatSync(fd)
    const current = fs.lstatSync(location)
    validFile(location, current, secret)
    if (
      count > maximum ||
      count !== before.size ||
      !sameSnapshot(before, after) ||
      !sameSnapshot(after, current)
    )
      unavailable()
    directories(location, secret)
    result = buffer.subarray(0, count)
  } finally {
    try {
      if (fd !== undefined) fs.closeSync(fd)
    } catch {
      buffer.fill(0)
      unavailable()
    }
    if (!result) buffer.fill(0)
  }
  return result!
}
function configuration(): Readonly<Config> | null {
  if (observedConfig !== undefined) return observedConfig
  observedConfig = null
  try {
    if (!configLocation) return null
    const bytes = readProtected(configLocation, 8192, false)
    const value = schema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes))
    )
    Object.freeze(value.installation)
    if (value.openssl.administratorGroupIds) Object.freeze(value.openssl.administratorGroupIds)
    Object.freeze(value.openssl)
    observedConfig = Object.freeze(value)
  } catch {
    /* No path, configuration, native cause or secret is exposed to callers. */
  }
  return observedConfig
}

/** Observes only the captured protected administrator configuration. Never initializes CA/DB. */
export function getEnrollmentOrigin(): string | null {
  return configuration()?.installation.fqdn ?? null
}
async function initialize(): Promise<Service | null> {
  const config = configuration()
  if (!config) return null
  let passphrase: Buffer | undefined
  let authority: NativeEnrollmentAuthority | null = null
  try {
    passphrase = readProtected(config.passphraseFilePath, 1024, true)
    if (passphrase.length < 16 || passphrase.some((x) => x === 0 || x === 10 || x === 13))
      unavailable()
    const { createNativeEnrollmentAuthority } = await import('./enrollment-authority')
    authority = await createNativeEnrollmentAuthority({
      installation: config.installation,
      openssl: config.openssl,
      caCertificatePath: config.caCertificatePath,
      caCertificateSha256: config.caCertificateSha256,
      encryptedKeyPath: config.encryptedKeyPath,
      spoolDirectory: config.spoolDirectory,
      certificateDays: config.certificateDays,
      passphrase,
    })
    // The native factory captured its own Buffer. Never retain this file-read copy in the runtime.
    passphrase.fill(0)
    if (!authority) return null
    const { createEnrollmentService } = await import('./enrollment')
    return createEnrollmentService({ authority, installation: config.installation })
  } catch {
    try {
      authority?.close()
    } catch {
      /* Initialization remains unavailable; never retry it. */
    }
    return null
  } finally {
    passphrase?.fill(0)
  }
}
/** Call only after the native HTTP/auth funnel. One failed initialization remains closed until restart. */
export function getEnrollmentService(): Promise<Service | null> {
  servicePromise ??= initialize()
  return servicePromise
}

// Internal reuse by the dedicated control process; identical protected-reader policy.
export { readProtected as readProtectedAgentRuntimeFile }
