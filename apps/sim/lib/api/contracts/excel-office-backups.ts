// Copyright (c) 2026 Memlia. All rights reserved.
import { z } from 'zod'
import { isCanonicalBase64, noInputSchema } from '@/lib/api/contracts/primitives'
import { defineRouteContract } from '@/lib/api/contracts/types'

const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+(?![\s\S])/)
const digest = z.string().regex(/^sha256:[a-f0-9]{64}(?![\s\S])/)
// Base64 and JSON must fit the native 10 MiB proxy ceiling. The SDK copy may be larger.
export const MAX_OFFICE_BACKUP_HTTP_COPY_BYTES = 7_500_000
export const MAX_OFFICE_BACKUP_HTTP_BYTES = 10_000_256

/** The body carries a bounded compressed copy, never a snapshot or permission to write Excel. */
export const officeBackupBodySchema = z.strictObject({
  copyVersion: z.literal(1),
  contentBase64: z
    .string()
    .min(4)
    .max(10_000_000)
    .refine((value) => {
      if (!isCanonicalBase64(value)) return false
      const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
      return (value.length / 4) * 3 - padding <= MAX_OFFICE_BACKUP_HTTP_COPY_BYTES
    }),
})

export const officeBackupResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('stored'),
    receipt: z.strictObject({
      schemaVersion: z.literal('memlia.office-copy-storage/v1'),
      workspaceId: id,
      ownerUserId: id,
      fileId: id,
      contentVersion: z.int().min(0).max(8_640_000_000_000_000),
      byteLength: z.int().min(1).max(10_000_000),
      sha256: digest,
    }),
  }),
  z.strictObject({
    status: z.enum(['refused', 'unconfirmed']),
    code: z.enum([
      'office_backup_refused',
      'office_backup_cancelled',
      'office_backup_storage_unknown',
    ]),
    stage: z.enum(['before_creation', 'creation_unknown', 'created_unverified']),
    fileId: id.nullable(),
  }),
])

export const storeOfficeBackupContract = defineRouteContract({
  method: 'POST',
  path: '/api/workspaces/[id]/excel/office-backups',
  params: z.strictObject({ id }),
  query: noInputSchema,
  body: officeBackupBodySchema,
  response: { mode: 'json', schema: officeBackupResultSchema },
})

export type OfficeBackupBody = z.infer<typeof officeBackupBodySchema>
export type OfficeBackupResponse = z.infer<typeof officeBackupResultSchema>
