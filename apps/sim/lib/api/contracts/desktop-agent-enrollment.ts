// Copyright (c) 2026 Memlia. All rights reserved.
import { z } from 'zod'
import { noInputSchema } from '@/lib/api/contracts/primitives'
import { defineRouteContract } from '@/lib/api/contracts/types'

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}(?![\s\S])/)
const digest = z.string().regex(/^[0-9a-f]{64}(?![\s\S])/)
const code = z.string().regex(/^[A-Za-z0-9_-]{43}(?![\s\S])/)
const instant = z.number().int().min(0).max(8_640_000_000_000_000)
const csrPem = z.string().min(1).max(16_384)

export const ENROLLMENT_SESSION_MAX_BODY_BYTES = 1024
export const ENROLLMENT_ONESHOT_MAX_BODY_BYTES = 196_608
export const enrollmentHttpErrorSchema = z.strictObject({
  error: z.enum(['enrollment_refused', 'enrollment_unavailable']),
})

export const createEnrollmentContract = defineRouteContract({
  method: 'POST',
  path: '/api/workspaces/[id]/desktop-agent-enrollments',
  params: z.strictObject({ id }),
  query: noInputSchema,
  body: noInputSchema,
  response: {
    mode: 'json',
    schema: z.strictObject({ enrollmentId: id, code, expiresAt: instant }),
  },
  error: enrollmentHttpErrorSchema,
})

export const revokeEnrollmentContract = defineRouteContract({
  method: 'POST',
  path: '/api/workspaces/[id]/desktop-agent-enrollments/[enrollmentId]/revoke',
  params: z.strictObject({ id, enrollmentId: id }),
  query: noInputSchema,
  body: noInputSchema,
  response: {
    mode: 'json',
    schema: z.strictObject({
      status: z.literal('revoked'),
      enrollmentId: id,
      certificateRevocation: z.enum(['not_issued', 'confirmed', 'unknown']),
    }),
  },
  error: enrollmentHttpErrorSchema,
})

export const challengeEnrollmentContract = defineRouteContract({
  method: 'POST',
  path: '/api/desktop-agent-enrollments/challenge',
  params: noInputSchema,
  query: noInputSchema,
  body: z.strictObject({
    enrollmentId: id,
    code,
    csrPem,
    windowsSid: z
      .string()
      .max(184)
      .regex(/^S-1-\d+(?:-\d+){1,14}(?![\s\S])/),
  }),
  response: {
    mode: 'json',
    schema: z.strictObject({
      enrollmentId: id,
      challengePayload: z.string().min(1).max(4096),
      expiresAt: instant,
    }),
  },
  error: enrollmentHttpErrorSchema,
})

export const completeEnrollmentContract = defineRouteContract({
  method: 'POST',
  path: '/api/desktop-agent-enrollments/complete',
  params: noInputSchema,
  query: noInputSchema,
  body: z.strictObject({
    enrollmentId: id,
    code,
    csrPem,
    signature: z
      .string()
      .min(1)
      .max(8192)
      .regex(/^[A-Za-z0-9_+/=-]+(?![\s\S])/),
  }),
  response: {
    mode: 'json',
    status: [200, 202],
    schema: z.discriminatedUnion('status', [
      z.strictObject({ status: z.literal('issuance_unknown'), enrollmentId: id }),
      z.strictObject({
        status: z.literal('issued'),
        enrollmentId: id,
        agentId: id,
        issuanceId: id,
        bindingDigest: digest,
        certificate: z
          .strictObject({
            certificateSerial: z.string().regex(/^[0-9a-f]{1,40}(?![\s\S])/),
            certificateSha256: digest,
            certificatePem: z.string().min(1).max(16_384),
            spkiSha256: digest,
            notBefore: instant,
            notAfter: instant,
          })
          .refine((certificate) => certificate.notBefore < certificate.notAfter),
      }),
    ]),
  },
  error: enrollmentHttpErrorSchema,
})
