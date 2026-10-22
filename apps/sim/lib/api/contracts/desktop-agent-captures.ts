// Copyright (c) 2026 Memlia. All rights reserved.
import { z } from 'zod'
import { noInputSchema } from '@/lib/api/contracts/primitives'
import { defineRouteContract } from '@/lib/api/contracts/types'

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}(?![\s\S])/)
const time = z.number().int().nonnegative().max(8640000000000000)
export const captureInputSchema = z.strictObject({
  agentId: id,
  requestId: z.uuid(),
  maxDurationSeconds: z.int().min(1).max(1800),
  maxBytes: z
    .int()
    .min(1)
    .max(32 * 1024 * 1024),
})
export const captureSummarySchema = z.strictObject({
  commandId: id,
  requestId: z.uuid().nullable(),
  agentId: id,
  status: z.enum(['queued', 'claimed', 'consented', 'running', 'hold', 'terminal', 'expired']),
  outcome: z
    .enum([
      'awaiting_local_consent',
      'running',
      'succeeded_verified',
      'failed',
      'stopped',
      'cancelled_before_start',
      'uncertain',
      'awaiting_intervention',
    ])
    .nullable(),
  createdAt: time,
  exportStatus: z.enum(['none', 'to_test']),
})
const error = z.strictObject({ error: z.enum(['capture_refused', 'capture_unavailable']) })
export const createCaptureContract = defineRouteContract({
  method: 'POST',
  path: '/api/workspaces/[id]/desktop-agent-captures',
  params: z.strictObject({ id }),
  query: noInputSchema,
  body: captureInputSchema,
  response: { mode: 'json', schema: captureSummarySchema },
  error,
})
export const listCapturesContract = defineRouteContract({
  method: 'GET',
  path: '/api/workspaces/[id]/desktop-agent-captures',
  params: z.strictObject({ id }),
  query: z.strictObject({ requestId: z.uuid().optional() }),
  response: {
    mode: 'json',
    schema: z.strictObject({
      observedAt: time,
      devices: z
        .array(
          z.strictObject({
            agentId: id,
            observedAt: time.nullable(),
            observation: z.enum(['recent', 'offline', 'unavailable']),
            busy: z.enum(['idle', 'busy', 'hold']),
          })
        )
        .max(20),
      commands: z.array(captureSummarySchema).max(51),
      truncated: z.boolean(),
    }),
  },
  error,
})
