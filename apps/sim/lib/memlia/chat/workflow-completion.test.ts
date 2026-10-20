// Copyright (c) 2026 Memlia. All rights reserved.
import { expect, it } from 'vitest'
import { createEvent, eventToStreamEvent } from '@/lib/mothership/request/session/event'
import { parsePersistedStreamEventEnvelope } from '@/lib/mothership/request/session/contract'
import { workflowCompletion } from './workflow-completion'

it('keeps native completion observations through the existing persisted SSE contract', () => {
  const workflow = workflowCompletion(
    { evaluated: 2, refused: 1 },
    { created: 0, applied: 0, skipped: 0 }
  )
  const event = createEvent({
    streamId: 'stream',
    requestId: 'request',
    cursor: 'cursor',
    seq: 1,
    type: 'complete',
    payload: { status: 'complete', response: { workflow } },
  })
  const parsed = parsePersistedStreamEventEnvelope(JSON.parse(JSON.stringify(event)))
  expect(parsed.ok).toBe(true)
  if (!parsed.ok) throw new Error('Native SSE contract refused')
  expect(eventToStreamEvent(parsed.event).payload).toEqual({
    status: 'complete',
    response: { workflow },
  })
  expect(workflow.stage).toBe('preparation_only')
  expect(workflow).not.toHaveProperty('valid')
  expect(workflow).not.toHaveProperty('taskSucceeded')
})
it('observes an applied revision without claiming workflow execution or all requested work completed', () => {
  const observations = { created: 2, applied: 1, skipped: 1 }
  const revision = { baseRevision: 7, draftRevision: 8 }
  const workflow = workflowCompletion({ evaluated: 1, refused: 0 }, observations, revision)
  observations.applied = 0
  revision.draftRevision = 999
  expect(workflow).toMatchObject({
    provenance: 'native_port_results',
    stage: 'applied',
    proposals: { created: 2, applied: 1, skipped: 1 },
    latestAppliedRevision: { baseRevision: 7, draftRevision: 8 },
    workflowExecutionByThisChatBackend: 'not_performed',
  })
  expect(Object.isFrozen(workflow.proposals)).toBe(true)
  expect(Object.isFrozen(workflow.latestAppliedRevision)).toBe(true)
})
it('does not convert a skipped proposal into an application', () => {
  expect(
    workflowCompletion({ evaluated: 1, refused: 0 }, { created: 1, applied: 0, skipped: 1 })
  ).toMatchObject({ stage: 'proposal_not_applied' })
})
it.each([
  { created: 1, applied: 0, skipped: 0 }, // unresolved proposal
  { created: 0, applied: 1, skipped: 0 },
  { created: Number.MAX_SAFE_INTEGER + 1, applied: 0, skipped: Number.MAX_SAFE_INTEGER + 1 },
  { created: 0, applied: 0, skipped: 0, secret: 'CANARY' },
])(
  'rejects incomplete or unbounded observations without projecting input fields: %j',
  (proposals) => {
    expect(() => workflowCompletion({ evaluated: 0, refused: 0 }, proposals)).toThrow()
  }
)
it.each([
  { evaluated: -1, refused: 0 },
  { evaluated: Number.MAX_SAFE_INTEGER + 1, refused: 0 },
  { evaluated: 0.5, refused: 0 },
  { evaluated: 1, refused: 0, code: 'CANARY' },
])('rejects malformed preview observations: %j', (previews) => {
  expect(() => workflowCompletion(previews, { created: 0, applied: 0, skipped: 0 })).toThrow()
})
it('requires the exact native revision observation for applied, and none for unapplied', () => {
  expect(() =>
    workflowCompletion({ evaluated: 0, refused: 0 }, { created: 1, applied: 1, skipped: 0 })
  ).toThrow()
  expect(() =>
    workflowCompletion(
      { evaluated: 0, refused: 0 },
      { created: 0, applied: 0, skipped: 0 },
      { baseRevision: 7, draftRevision: 8 }
    )
  ).toThrow()
  expect(() =>
    workflowCompletion(
      { evaluated: 0, refused: 0 },
      { created: 1, applied: 1, skipped: 0 },
      { baseRevision: 7, draftRevision: 6 }
    )
  ).toThrow()
})

it('completion bounds — accepts 41 observations allowed by the native configurable limiter', () => {
  expect(
    workflowCompletion({ evaluated: 41, refused: 0 }, { created: 0, applied: 0, skipped: 0 })
  ).toMatchObject({ stage: 'preparation_only', previews: { evaluated: 41 } })
  expect(
    workflowCompletion({ evaluated: 0, refused: 0 }, { created: 41, applied: 0, skipped: 41 })
  ).toMatchObject({ stage: 'proposal_not_applied', proposals: { skipped: 41 } })
})
