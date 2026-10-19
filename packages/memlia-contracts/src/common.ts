// Copyright (c) 2026 Memlia. All rights reserved.
import { z } from 'zod'

// No path, URI, credential or executable payload is accepted in reference fields.
export const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}(?![\s\S])/)
// JSON Schema measures Unicode code points, not JavaScript UTF-16 units. The
// Unicode regexp has the same scalar-value semantics in JS and Python. Reject
// unpaired surrogates; never normalize or coerce valid Unicode data.
export function unicodeText(minimum: number, maximum: number) {
  return z
    .string()
    .regex(new RegExp(`^[^\\uD800-\\uDFFF]{${minimum},${maximum}}(?![\\s\\S])`, 'u'))
    .meta({ minLength: minimum, maxLength: maximum })
}
export const Label = unicodeText(1, 256)
export const Digest = z.string().regex(/^sha256:[a-f0-9]{64}(?![\s\S])/)
// Keep Zod's calendar validation and explicitly bound the common Python/JS
// Gregorian range. The second pattern also enforces an absolute end in Python.
export const Timestamp = z.iso.datetime({ precision: 3 }).regex(/^(?!0000)[0-9TZ:.-]+(?![\s\S])/)
export const CalendarDate = z.iso.date().regex(/^(?!0000)[0-9-]+(?![\s\S])/)

export const Revision = z.int().min(0).max(Number.MAX_SAFE_INTEGER)
// Explicit null means no organization, never an unrestricted scope.
export const Scope = { organizationId: Id.nullable(), workspaceId: Id }
export const ArtifactRef = z.strictObject({ artifactId: Id, sha256: Digest })
export const Lifetime = { issuedAt: Timestamp, expiresAt: Timestamp }
export const StringList = z.array(Label).max(256)
export const RefList = z.array(ArtifactRef).max(256)
export const IdList = z.array(Id).max(256)
