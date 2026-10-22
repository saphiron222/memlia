// Copyright (c) 2026 Memlia. All rights reserved.
import { createHash } from 'node:crypto'
import { ExcelProcedureSchema } from '@memlia/contracts'
import { parsePrincipal, type SessionPrincipal } from '@sim/auth/principal'
import { z } from 'zod'
import { authorizeWorkspaceOperation } from '@/lib/core/application'
import { OrchestrationError } from '@/lib/core/orchestration/types'
import { stringifyBoundedJson } from '@/lib/core/utils/bounded-json'
import type { WorkspaceFileRecord } from '@/lib/uploads/contexts/workspace/file-manager'
import { resolveActiveWorkflowDeploymentVersionApplicationContext } from '@/lib/workflows/application/context'
import { workflowOperations } from '@/lib/workflows/application/operations'
import { createWorkspaceFileFromBuffer } from '@/lib/workspace-files/application/create-workspace-file'
import { readWorkspaceFileContent } from '@/lib/workspace-files/application/read-workspace-file-content'

const MAX_BYTES = 10_000_000 // Same bounded snapshot profile as memlia_excel.ingestion.
const CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const id = ExcelProcedureSchema.shape.workspaceId
const digest = ExcelProcedureSchema.shape.digest
const unrecorded = Object.freeze({ status: 'unrecorded' } as const)
const bindingSchema = z.strictObject({
  organizationId: ExcelProcedureSchema.shape.organizationId,
  workspaceId: id,
  workflowId: ExcelProcedureSchema.shape.workflowId,
  deployedVersionId: ExcelProcedureSchema.shape.deployedVersionId,
  subjectUserId: ExcelProcedureSchema.shape.ownerUserId,
  bindingId: ExcelProcedureSchema.shape.inputs.element.shape.bindingId,
  bindingVersion: ExcelProcedureSchema.shape.version,
  procedureDigest: digest,
  role: ExcelProcedureSchema.shape.inputs.element.shape.role,
  sheetName: z.string().min(1).max(128),
  folderId: id.nullable(),
})
const nameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (name) =>
      Buffer.byteLength(name) <= 255 &&
      name.toLowerCase().endsWith('.xlsx') &&
      !/[/\\\x00-\x1f\x7f:]/.test(name) &&
      !/[ .]$/.test(name) &&
      !/[\uD800-\uDFFF]/u.test(name) &&
      !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i.test(name)
  )
const receiptSchema = z.strictObject({
  schemaVersion: z.literal('memlia.inbox-snapshot/v1'),
  binding: bindingSchema,
  occurrenceId: id,
  occurrenceKey: digest,
  originalName: nameSchema,
  fileId: id,
  fileKey: z.string().min(1).max(2048),
  contentVersion: z.int().min(0).max(8_640_000_000_000_000),
  byteLength: z.int().min(1).max(MAX_BYTES),
  sha256: digest,
  secretProvenance: z.strictObject({ status: z.literal('unrecorded') }),
})
export type InboxSnapshotBinding = z.infer<typeof bindingSchema>
type Binding = InboxSnapshotBinding
export type InboxSnapshotReceipt = z.infer<typeof receiptSchema>
const pendingReceiptSchema = receiptSchema.extend({
  contentVersion: receiptSchema.shape.contentVersion.optional(),
})
type Stage = 'before_creation' | 'creation_unknown' | 'created_unverified' | 'resume_unverified'
type Verified = {
  status: 'verified'
  receipt: InboxSnapshotReceipt
  sources: Record<string, { fileId: string; sheetName: string }>
  durableOccurrenceAdmitted: false
  executionAvailable: false
}
type Refused = {
  status: 'refused'
  code: 'inbox_snapshot_refused' | 'inbox_snapshot_conflict'
  stage: Stage
  fileId: string | null
}
export type InboxSnapshotResult = Verified | Refused

function refuse(): never {
  throw new Error('inbox_snapshot_refused')
}
function copy(value: unknown): unknown {
  const encoded = stringifyBoundedJson(value, 16_384, { strict: true })
  if (encoded === undefined) refuse()
  return JSON.parse(encoded)
}
function capturePrincipal(principal: SessionPrincipal) {
  const captured = parsePrincipal({ version: 1, principal: copy(principal) })
  if (captured.kind !== 'session') refuse()
  return captured
}
function hash(content: Buffer | string) {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}
function key(binding: Binding, occurrenceId: string) {
  // Fixed tuple, independent of object property order, filename and content digest.
  return hash(
    JSON.stringify([
      'memlia.inbox-occurrence/v1',
      binding.organizationId,
      binding.workspaceId,
      binding.subjectUserId,
      binding.bindingId,
      binding.bindingVersion,
      binding.workflowId,
      binding.deployedVersionId,
      binding.procedureDigest,
      occurrenceId,
    ])
  )
}
function active(signal?: AbortSignal) {
  if (signal !== undefined && !(signal instanceof AbortSignal)) refuse()
  signal?.throwIfAborted()
}
async function authorize(principal: SessionPrincipal, binding: Binding, signal?: AbortSignal) {
  active(signal)
  if (principal.userId !== binding.subjectUserId) refuse()
  const context = await resolveActiveWorkflowDeploymentVersionApplicationContext({
    workflowId: binding.workflowId,
    deploymentVersionId: binding.deployedVersionId,
    assertedWorkspaceId: binding.workspaceId,
  })
  active(signal)
  if (
    context.workflowId !== binding.workflowId ||
    context.workspaceId !== binding.workspaceId ||
    context.workspaceOrganizationId !== binding.organizationId ||
    context.deploymentVersionId !== binding.deployedVersionId
  )
    refuse()
  await authorizeWorkspaceOperation(principal, workflowOperations.read, context)
  active(signal)
}
function checkFile(file: WorkspaceFileRecord, binding: Binding, occurrenceKey: string) {
  if (
    file.workspaceId !== binding.workspaceId ||
    file.uploadedBy !== binding.subjectUserId ||
    (file.folderId ?? null) !== binding.folderId ||
    file.deletedAt != null ||
    (file.storageContext ?? 'workspace') !== 'workspace' ||
    file.vfsNamespace !== undefined ||
    file.name !== `inbox-${occurrenceKey.slice(7)}.xlsx` ||
    file.type !== CONTENT_TYPE
  )
    refuse()
  id.parse(file.id)
}
function snapshot(value: unknown) {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype)
    refuse()
  const fields = Object.getOwnPropertyDescriptors(value)
  const keys = Reflect.ownKeys(fields)
  if (
    keys.length !== 3 ||
    !['name', 'content', 'sha256'].every((key) => fields[key]?.enumerable && 'value' in fields[key])
  )
    refuse()
  const source = fields.content.value
  if (!Buffer.isBuffer(source) || !source.length || source.length > MAX_BYTES) refuse()
  const content = Buffer.from(source)
  const name = nameSchema.parse(fields.name.value)
  const sha256 = digest.parse(fields.sha256.value)
  if (hash(content) !== sha256) refuse()
  return { name, content, sha256 }
}
async function read(
  principal: SessionPrincipal,
  binding: Binding,
  expected: z.infer<typeof pendingReceiptSchema>,
  signal?: AbortSignal
) {
  active(signal)
  const loaded = await readWorkspaceFileContent.execute({
    principal,
    input: {
      fileId: expected.fileId,
      assertedWorkspaceId: binding.workspaceId,
      maxBytes: MAX_BYTES,
      includeSecretProvenance: true,
    },
  })
  active(signal)
  const file = loaded.file
  checkFile(file, binding, expected.occurrenceKey)
  if (
    file.id !== expected.fileId ||
    file.key !== expected.fileKey ||
    !(file.contentUpdatedAt instanceof Date) ||
    !Number.isFinite(file.contentUpdatedAt.getTime()) ||
    (expected.contentVersion !== undefined &&
      file.contentUpdatedAt.getTime() !== expected.contentVersion) ||
    file.size !== expected.byteLength ||
    !Buffer.isBuffer(loaded.content) ||
    loaded.content.length !== expected.byteLength ||
    hash(loaded.content) !== expected.sha256 ||
    JSON.stringify(copy(loaded.secretProvenance)) !== JSON.stringify(unrecorded)
  )
    refuse()
  const receipt = receiptSchema.parse({
    ...expected,
    contentVersion: file.contentUpdatedAt.getTime(),
  })
  await authorize(principal, binding, signal)
  return {
    status: 'verified',
    receipt,
    sources: { [binding.role]: { fileId: expected.fileId, sheetName: binding.sheetName } },
    durableOccurrenceAdmitted: false,
    executionAvailable: false,
  } satisfies Verified
}
function failure(stage: Stage, fileId: string | null, error: unknown): Refused {
  return {
    status: 'refused',
    stage,
    fileId,
    code:
      stage === 'creation_unknown' &&
      error instanceof OrchestrationError &&
      error.code === 'conflict'
        ? 'inbox_snapshot_conflict'
        : 'inbox_snapshot_refused',
  }
}

/** Internal composition only. The caller authenticates the session and authorizes the binding.
 * Neither the configuration nor this file receipt grants execution or autonomous trigger authority. */
export async function persistInboxSnapshot(
  principal: SessionPrincipal,
  configuredBinding: unknown,
  occurrenceId: unknown,
  input: unknown,
  signal?: AbortSignal
): Promise<InboxSnapshotResult> {
  let stage: Stage = 'before_creation'
  let fileId: string | null = null
  try {
    const captured = capturePrincipal(principal)
    const binding = bindingSchema.parse(copy(configuredBinding))
    const occurrence = id.parse(occurrenceId)
    const source = snapshot(input) // Own and bound bytes before the first await.
    const occurrenceKey = key(binding, occurrence)
    await authorize(captured, binding, signal)
    stage = 'creation_unknown'
    const created = await createWorkspaceFileFromBuffer.execute({
      principal: captured,
      input: {
        workspaceId: binding.workspaceId,
        folderId: binding.folderId,
        name: `inbox-${occurrenceKey.slice(7)}.xlsx`,
        exactName: true,
        content: source.content,
        contentType: CONTENT_TYPE,
        secretProvenance: unrecorded,
        notifyWorkspaceChange: false,
      },
    })
    checkFile(created.file, binding, occurrenceKey)
    fileId = id.parse(created.file.id)
    stage = 'created_unverified'
    active(signal)
    const expected = pendingReceiptSchema.parse({
      schemaVersion: 'memlia.inbox-snapshot/v1',
      binding,
      occurrenceId: occurrence,
      occurrenceKey,
      originalName: source.name,
      fileId,
      fileKey: created.file.key,
      contentVersion: created.file.contentUpdatedAt?.getTime(),
      byteLength: source.content.length,
      sha256: source.sha256,
      secretProvenance: unrecorded,
    })
    const verified = await read(captured, binding, expected, signal)
    active(signal)
    return verified
  } catch (error) {
    return failure(stage, fileId, error)
  }
}

/** Revalidate an explicitly saved fileId/identity; never search by filename or reopen the inbox. */
export async function resumeInboxSnapshot(
  principal: SessionPrincipal,
  configuredBinding: unknown,
  savedReceipt: unknown,
  signal?: AbortSignal
): Promise<InboxSnapshotResult> {
  try {
    const captured = capturePrincipal(principal)
    const binding = bindingSchema.parse(copy(configuredBinding))
    const expected = receiptSchema.parse(copy(savedReceipt))
    if (
      JSON.stringify(binding) !== JSON.stringify(expected.binding) ||
      key(binding, expected.occurrenceId) !== expected.occurrenceKey
    )
      refuse()
    await authorize(captured, binding, signal)
    const verified = await read(captured, binding, expected, signal)
    active(signal)
    return verified
  } catch (error) {
    return failure('resume_unverified', null, error)
  }
}
