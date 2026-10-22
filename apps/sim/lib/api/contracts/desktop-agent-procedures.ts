// Copyright (c) 2026 Memlia. All rights reserved.
import { z } from 'zod'
import { captureSummarySchema } from '@/lib/api/contracts/desktop-agent-captures'
import { noInputSchema } from '@/lib/api/contracts/primitives'
import { defineRouteContract } from '@/lib/api/contracts/types'

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}(?![\s\S])/)
const text = z.string().refine(
  (v) =>
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v) &&
    [...v].every((c) => {
      const code = c.codePointAt(0)!
      return code < 0xd800 || code > 0xdfff
    })
)
export const saveProcedureInputSchema = z
  .strictObject({
    requestId: z.uuid(),
    procedureId: z.uuid().nullable(),
    expectedRevision: z
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER - 1),
    commandId: id,
    name: text.pipe(z.string().trim().min(1).max(120)),
    description: text.pipe(z.string().max(2000)),
  })
  .refine((v) => (v.procedureId === null) === (v.expectedRevision === 0))
export const procedureVersionSchema = z.strictObject({
  procedureId: z.uuid(),
  revision: z.int().min(1).max(Number.MAX_SAFE_INTEGER),
  requestId: z.uuid(),
  name: z.string().min(1).max(120),
  description: z.string().max(2000),
  commandId: id,
  createdAt: z.int().nonnegative().max(8640000000000000),
  status: z.literal('to_test'),
})
export const listProcedureInputSchema = z.strictObject({ procedureId: z.uuid().optional() })
export const personalTestInputSchema = z.strictObject({
  procedureId: z.uuid(),
  revision: z.int().min(1).max(Number.MAX_SAFE_INTEGER),
  agentId: id,
  requestId: z.uuid(),
  maxDurationSeconds: z.int().min(1).max(1800),
})
const error = z.strictObject({
  error: z.enum(['procedure_refused', 'procedure_unavailable', 'procedure_revision_conflict']),
})
export const saveProcedureContract = defineRouteContract({
  method: 'POST',
  path: '/api/workspaces/[id]/desktop-agent-procedures',
  params: z.strictObject({ id }),
  query: noInputSchema,
  body: saveProcedureInputSchema,
  response: { mode: 'json', schema: procedureVersionSchema },
  error,
})
export const listProceduresContract = defineRouteContract({
  method: 'GET',
  path: '/api/workspaces/[id]/desktop-agent-procedures',
  params: z.strictObject({ id }),
  query: listProcedureInputSchema,
  response: {
    mode: 'json',
    schema: z.strictObject({
      procedures: z.array(procedureVersionSchema).max(50),
      versions: z.array(procedureVersionSchema).max(50),
      truncated: z.boolean(),
    }),
  },
  error,
})
export const createPersonalTestContract = defineRouteContract({
  method: 'POST',
  path: '/api/workspaces/[id]/desktop-agent-procedures/test',
  params: z.strictObject({ id }),
  query: noInputSchema,
  body: personalTestInputSchema,
  response: { mode: 'json', schema: captureSummarySchema },
  error,
})
