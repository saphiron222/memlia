// Copyright 2026 Memlia. All rights reserved.

import { isPlainRecord } from '@sim/utils/object'
import { z } from 'zod'
import { workflowIdParamsSchema } from '@/lib/api/contracts/workflows'
import { getModelSunsetStatus, getProviderModels } from '@/providers/models'
import type { runCatalogProvider } from '../chat/provider-binding'

const configuration = z
  .object({
    enabled: z.literal(true),
    provider: z.enum(['openai', 'anthropic']),
    model: z.string().min(1).max(256),
    destination: z.literal('official'),
    data: z
      .object({
        conversation: z.literal(true),
        catalogue: z.literal(true),
        workflow: z.enum(['catalogue_only', 'summary_only', 'sanitized_details']),
      })
      .strict(),
  })
  .strict()
const decision = configuration
  .extend({ kind: z.literal('configuration_decision'), activation: z.literal('blocked') })
  .strict()
const workflowId = workflowIdParamsSchema.shape.id.max(512).optional()

/** Non-secret configuration decision only: neither authentication nor transport admission. */
export function parseChatInstallationPolicy(raw: unknown) {
  try {
    if (!plainConfiguration(raw)) throw unavailable()
    const parsed = configuration.safeParse(raw)
    if (
      !parsed.success ||
      !getProviderModels(parsed.data.provider).includes(parsed.data.model) ||
      getModelSunsetStatus(parsed.data.model) === 'deprecated'
    )
      throw unavailable()
    return Object.freeze({
      ...parsed.data,
      data: Object.freeze(parsed.data.data),
      kind: 'configuration_decision' as const,
      activation: 'blocked' as const,
    })
  } catch {
    throw unavailable()
  }
}

/** Derives a ceiling for P05, not a grant: native resource authorization remains mandatory. */
export function selectWorkflowReadPolicy(
  policy: unknown,
  serverWorkflowId?: unknown
): NonNullable<Parameters<typeof runCatalogProvider>[0]['workflow']> | undefined {
  try {
    if (!plainConfiguration(policy)) throw unavailable()
    const parsed = decision.safeParse(policy)
    const id = workflowId.safeParse(serverWorkflowId)
    if (!parsed.success || !id.success) throw unavailable()
    const { kind: _kind, activation: _activation, ...config } = parsed.data
    const selected = parseChatInstallationPolicy(config)
    if (id.data === undefined || selected.data.workflow === 'catalogue_only') return undefined
    return Object.freeze({ workflowId: id.data, policy: selected.data.workflow })
  } catch {
    throw unavailable()
  }
}

/** Inspect descriptors before Zod can evaluate a configuration object's accessors. */
function plainConfiguration(value: unknown) {
  return plainRecord(value) && plainRecord(Object.getOwnPropertyDescriptor(value, 'data')?.value)
}
function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== 'string') return false
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor?.enumerable === true && 'value' in descriptor
  })
}

function unavailable() {
  return new Error('Chat installation policy is unavailable.')
}
