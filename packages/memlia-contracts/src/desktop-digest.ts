// Copyright (c) 2026 Memlia. All rights reserved.
import { AgentCommandSchema } from './desktop.ts'

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, item]) => [key, ordered(item)]),
    )
  }
  return value
}

/** Transport fingerprint only, never authorization, signature or local consent.
 * Every field except digest participates, including lease, fences and lifetime.
 * The closed schema has ASCII keys/strings and only safe integer numbers.
 */
export function desktopCommandBytes(value: unknown): Uint8Array<ArrayBuffer> {
  const { digest: _digest, ...command } = AgentCommandSchema.parse(value)
  return new TextEncoder().encode(
    `memlia.desktop-command.v2\0${JSON.stringify(ordered(command))}`,
  )
}

export async function desktopCommandDigest(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', desktopCommandBytes(value))
  return `sha256:${Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')}`
}
