// Bounded descriptor read adapted from Sim packages/sim-cli/src/config/json-file.ts.
// Upstream Apache-2.0 license and notices retained; modified by Memlia in 2026.
// Additional installation ownership checks and policy composition by Memlia.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseChatInstallationPolicy } from './chat-policy.server'

const MAX_BYTES = 4096

/** Linux server observation only. No admission, credential resolution or activation. */
export function readChatInstallationPolicyFile() {
  try {
    const location = process.env.MEMLIA_CHAT_POLICY_FILE
    const uid = process.getuid?.()
    const effectiveUid = process.geteuid?.()
    const gid = process.getgid?.()
    const effectiveGid = process.getegid?.()
    if (
      os.platform() !== 'linux' ||
      !Number.isInteger(uid) ||
      !Number.isInteger(effectiveUid) ||
      uid === undefined ||
      effectiveUid === undefined ||
      uid <= 0 ||
      effectiveUid <= 0 ||
      uid !== effectiveUid ||
      !Number.isInteger(gid) ||
      gid !== effectiveGid ||
      typeof location !== 'string' ||
      location.length === 0 ||
      location.length > MAX_BYTES ||
      location.includes('\0') ||
      !path.posix.isAbsolute(location) ||
      path.posix.normalize(location) !== location
    )
      throw unavailable()

    // Every ancestor must be controlled by the administrator, not the web identity.
    for (let parent = path.posix.dirname(location); ; parent = path.posix.dirname(parent)) {
      const stats = fs.lstatSync(parent)
      if (!stats.isDirectory()) throw unavailable()
      administratorOnly(parent, stats)
      if (parent === '/') break
    }
    const initial = fs.lstatSync(location)
    if (!initial.isFile()) throw unavailable()
    administratorOnly(location, initial)

    let descriptor: number | null = null
    try {
      descriptor = fs.openSync(
        location,
        fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW
      )
      const before = fs.fstatSync(descriptor)
      if (!before.isFile() || !sameSnapshot(initial, before) || before.size > MAX_BYTES)
        throw unavailable()
      const buffer = Buffer.allocUnsafe(MAX_BYTES + 1)
      let bytesRead = 0
      while (bytesRead < buffer.byteLength) {
        const count = fs.readSync(
          descriptor,
          buffer,
          bytesRead,
          buffer.byteLength - bytesRead,
          bytesRead
        )
        if (count === 0) break
        bytesRead += count
      }
      const after = fs.fstatSync(descriptor)
      const current = fs.lstatSync(location)
      if (
        bytesRead > MAX_BYTES ||
        bytesRead !== before.size ||
        !sameSnapshot(before, after) ||
        !sameSnapshot(after, current) ||
        !current.isFile()
      )
        throw unavailable()
      administratorOnly(location, current)
      const raw = JSON.parse(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
          buffer.subarray(0, bytesRead)
        )
      )
      return Object.freeze({
        kind: 'installation_file_observation' as const,
        policy: parseChatInstallationPolicy(raw),
      })
    } finally {
      // A failed close must also prevent a successful observation.
      if (descriptor !== null) fs.closeSync(descriptor)
    }
  } catch {
    throw unavailable()
  }
}

function administratorOnly(location: string, stats: fs.Stats) {
  if (stats.uid !== 0 || (stats.mode & 0o022) !== 0) throw unavailable()
  try {
    fs.accessSync(location, fs.constants.W_OK)
  } catch (error) {
    // Check actual OS access too, including ACLs. Missing/unsupported checks fail closed.
    if (
      error instanceof Error &&
      'code' in error &&
      (error.code === 'EACCES' || error.code === 'EPERM' || error.code === 'EROFS')
    )
      return
    throw unavailable()
  }
  throw unavailable()
}

function sameSnapshot(left: fs.Stats, right: fs.Stats) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}
function unavailable() {
  return new Error('Chat installation policy is unavailable.')
}
