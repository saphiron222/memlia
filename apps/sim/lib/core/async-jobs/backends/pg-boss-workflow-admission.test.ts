// Copyright (c) 2026 Memlia. All rights reserved.
/**
 * Durable admission preparation and the payload it persists, with the database and the authority
 * read doubled: the strict, lossless JSON boundary and the native optional fields it omits run
 * unchanged. Real persistence and authority: pg-boss-workflow-admission.integration.test.ts.
 */
import { describe, expect, it, vi } from 'vitest'
import type { EnqueueWorkflowExecutionParams } from '@/lib/workflows/executor/workflow-execution-payload'

const io = vi.hoisted(() => ({
  admitted: [] as Array<{ payload: Record<string, unknown> }>,
  authority: undefined as undefined | (() => Promise<unknown>),
  persistence: undefined as undefined | (() => Promise<never>),
}))
// Only persistence and the authority read are doubled; the strict JSON copier stays native.
vi.mock('@sim/db', () => ({ db: { transaction: (run: (tx: unknown) => unknown) => run('tx') } }))
vi.mock('./pg-boss-workflow-session-authority', () => ({
  capturePgBossWorkflowSessionAuthority: async () => (io.authority ? io.authority() : authority()),
}))
const authority = vi.hoisted(() => () => ({
  schemaVersion: 'memlia.principal/v1',
  workspaceId: 'workspace',
  organizationId: null,
  actor: { version: 1, principal: { kind: 'session', userId: 'user', sessionId: 'session' } },
  subject: { kind: 'user', userId: 'user' },
  authority: { kind: 'interactive' },
  scopes: [],
  allowedTools: [],
}))
vi.mock('./pg-boss-admission', async (original) => ({
  ...(await original<typeof import('./pg-boss-admission')>()),
  admitPgBossJob: async (
    _tx: unknown,
    input: { jobId: string; payload: Record<string, unknown> }
  ) => {
    io.admitted.push(input)
    if (io.persistence) return io.persistence()
    return { jobId: input.jobId, outboxEventId: 'event', duplicate: false }
  },
}))

import { PgBossAdmissionError } from './pg-boss-admission'
import {
  admitPgBossWorkflowAdmission,
  PgBossWorkflowAdmissionRejection,
  preparePgBossWorkflowAdmission,
} from './pg-boss-workflow-admission'

const params = (): EnqueueWorkflowExecutionParams => ({
  requestId: 'request',
  workflowId: 'workflow',
  userId: 'user',
  workspaceId: 'workspace',
  executionId: 'execution',
  principal: { kind: 'session', userId: 'user', sessionId: 'session' },
  billingAttribution: {
    actorUserId: 'user',
    billedAccountUserId: 'user',
    workspaceId: 'workspace',
    organizationId: null,
    billingEntity: { type: 'user', id: 'user' },
    billingPeriod: { start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z' },
    payerSubscription: null,
  },
  input: { fixture: true },
  triggerType: 'manual',
  executionTimeoutMs: 900000,
  enforceCredentialAccess: true,
  isPublicApiAccess: false,
})
const identity = () => ({
  commandId: 'command',
  submittedAt: '2026-10-22T12:00:00.000Z',
  admissionCompleted: true as const,
})
const prepare = (value: object, id: object = identity()) =>
  preparePgBossWorkflowAdmission(value as EnqueueWorkflowExecutionParams, id as never)
/** The native refusal: fixed message and acceptance, and the bounded code of its check. */
function refusal(run: () => unknown) {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(PgBossWorkflowAdmissionRejection)
    const rejection = error as PgBossWorkflowAdmissionRejection
    expect(rejection.message).toBe('workflow_admission_rejected')
    expect(rejection.retryable).toBe(false)
    return { reason: rejection.reason, acceptance: rejection.acceptance }
  }
  throw new Error('expected a refusal')
}
async function admissionRefusal(run: () => Promise<unknown>) {
  const error = await run().then(
    () => undefined,
    (caught: unknown) => caught
  )
  expect(error).toBeInstanceOf(PgBossWorkflowAdmissionRejection)
  const rejection = error as PgBossWorkflowAdmissionRejection
  expect(rejection.message).toBe('workflow_admission_rejected')
  return { reason: rejection.reason, acceptance: rejection.acceptance }
}

describe('durable admission preparation of an absent native input', () => {
  it.each([
    ['present as undefined', () => ({ ...params(), input: undefined })],
    [
      'absent',
      () => {
        const { input: _absent, ...rest } = params()
        return rest
      },
    ],
    ['an empty object', () => ({ ...params(), input: {} })],
  ])('admits an input %s', (_case, value) => {
    expect(prepare(value())).toEqual({ kind: 'prepared_workflow_admission' })
  })

  it.each([
    ['another optional field present as undefined', { excelTestExecution: undefined }],
    ['an unknown field present as undefined', { unexpected: undefined }],
    ['a function input', { input: () => 1 }],
    ['an input with a nested undefined value', { input: { nested: undefined } }],
    ['a non-finite input', { input: Number.NaN }],
    ['a custom-object input', { input: new Date('2026-10-22T12:00:00.000Z') }],
  ])('still refuses %s', (_case, extra) => {
    expect(() => prepare({ ...params(), ...extra })).toThrow('workflow_admission_rejected')
  })

  it('refuses a non-enumerable input left undefined', () => {
    const value = Object.defineProperty(params(), 'input', { value: undefined, enumerable: false })
    expect(refusal(() => prepare(value)).reason).toBe('caller_input_not_strict_json')
  })

  it('refuses an input accessor without invoking it', () => {
    let reads = 0
    const value = Object.defineProperty(params(), 'input', {
      enumerable: true,
      get: () => {
        reads++
        return {}
      },
    })
    expect(() => prepare(value)).toThrow('workflow_admission_rejected')
    expect(reads).toBe(0)
  })
})

describe('persisted durable payload', () => {
  it.each([
    ['omits an absent input', undefined, false],
    ['keeps an empty input', {}, true],
    ['keeps a provided input', { fixture: true }, true],
  ])('%s', async (_case, input, present) => {
    io.admitted.length = 0
    await admitPgBossWorkflowAdmission(prepare({ ...params(), input }))
    expect(io.admitted).toHaveLength(1)
    const { payload } = io.admitted[0]
    expect(Object.hasOwn(payload, 'input')).toBe(present)
    if (present) expect(payload.input).toEqual(input)
    expect(payload).toMatchObject({ workflowId: 'workflow', enforceCredentialAccess: true })
  })
})

describe('bounded refusal code of each preparation check', () => {
  it.each([
    ['credential_enforcement', { enforceCredentialAccess: false }],
    ['credential_enforcement', { enforceCredentialAccess: 'true' }],
    ['public_api_access', { isPublicApiAccess: true }],
    ['public_api_access', { isPublicApiAccess: 0 }],
    [
      'principal_not_session',
      { principal: { kind: 'personal_api_key', userId: 'user', keyId: 'k' } },
    ],
    ['principal_invalid', { principal: { kind: 'forged' } }],
    ['actor_mismatch', { userId: 'other' }],
    ['execution_id_invalid', { executionId: 'invalid:reference' }],
    ['correlation_id_invalid', { requestId: '' }],
    ['billing_attribution_invalid', { billingAttribution: { actorUserId: 'user' } }],
    [
      'billing_attribution_mismatch',
      { billingAttribution: { ...params().billingAttribution, workspaceId: 'other' } },
    ],
    ['trigger_type_unsupported', { triggerType: 'forged' }],
    ['execution_timeout_invalid', { executionTimeoutMs: 0 }],
    ['execution_timeout_invalid', { executionTimeoutMs: -1 }],
    ['max_duration_invalid', { executionTimeoutMs: 86_340_000 }],
    ['caller_input_not_strict_json', { input: () => 1 }],
    ['caller_input_not_strict_json', { unexpected: undefined }],
    // Strict JSON runs first: a guard field present as undefined never reaches its own check.
    ['caller_input_not_strict_json', { enforceCredentialAccess: undefined }],
    ['caller_input_not_strict_json', { isPublicApiAccess: undefined }],
    ['caller_input_not_strict_json', { executionTimeoutMs: Number.POSITIVE_INFINITY }],
  ] as const)('%s', (reason, patch) => {
    expect(refusal(() => prepare({ ...params(), ...patch }))).toEqual({
      reason,
      acceptance: 'rejected',
    })
  })

  it.each([
    ['identity_shape', { ...identity(), extra: true }],
    ['identity_shape', { ...identity(), admissionCompleted: false }],
    ['identity_not_strict_json', { ...identity(), commandId: undefined }],
    ['command_id_invalid', { ...identity(), commandId: 'invalid:reference' }],
    ['submitted_at_invalid', { ...identity(), submittedAt: 'not-time' }],
  ] as const)('%s for the server identity', (reason, id) => {
    expect(refusal(() => prepare(params(), id)).reason).toBe(reason)
  })
})

describe('bounded refusal code of the admission', () => {
  const reset = () => {
    io.authority = undefined
    io.persistence = undefined
  }

  it('refuses a handle it did not mint', async () => {
    reset()
    expect(
      await admissionRefusal(() =>
        admitPgBossWorkflowAdmission({ kind: 'prepared_workflow_admission' })
      )
    ).toEqual({ reason: 'admission_handle_unknown', acceptance: 'rejected' })
  })

  it('refuses an unconfirmed authority before any persistence', async () => {
    reset()
    io.authority = async () => {
      throw new Error('workflow_session_authority_rejected')
    }
    io.admitted.length = 0
    expect(await admissionRefusal(() => admitPgBossWorkflowAdmission(prepare(params())))).toEqual({
      reason: 'authority_refused',
      acceptance: 'rejected',
    })
    expect(io.admitted).toHaveLength(0)
  })

  it('refuses an authority from another organization', async () => {
    reset()
    io.authority = async () => ({ ...authority(), organizationId: 'other-organization' })
    expect(await admissionRefusal(() => admitPgBossWorkflowAdmission(prepare(params())))).toEqual({
      reason: 'authority_organization_mismatch',
      acceptance: 'rejected',
    })
  })

  it.each([
    [
      'admission_identity_conflict',
      'rejected',
      () => new PgBossAdmissionError('admission_identity_conflict'),
    ],
    [
      'admission_persistence_unknown',
      'unknown',
      () => new PgBossAdmissionError('admission_persistence_unknown', 'unknown'),
    ],
    ['persistence_unknown', 'unknown', () => new Error('PRIVATE_CANARY select')],
    // Only the bounded persistence codes pass through; any other text is never logged.
    ['persistence_unknown', 'rejected', () => new PgBossAdmissionError('PRIVATE_CANARY select')],
  ] as const)(
    'persistence refusal %s keeps its acceptance %s',
    async (reason, acceptance, error) => {
      reset()
      io.persistence = async () => {
        throw error()
      }
      expect(await admissionRefusal(() => admitPgBossWorkflowAdmission(prepare(params())))).toEqual(
        {
          reason,
          acceptance,
        }
      )
      io.persistence = undefined
    }
  )
})
