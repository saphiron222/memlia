// Copyright (c) 2026 Memlia. All rights reserved.
import { expect, it } from 'vitest'
import { copilotToolPermissionBodySchema, workflowProposalReviewSchema } from './copilot'

const digest = `sha256:${'a'.repeat(64)}`
it('preserves ordinary decisions without a digest while carrying a declared digest unchanged', () => {
  const decision = { toolCallId: 'call', decision: 'allow' as const }
  expect(copilotToolPermissionBodySchema.parse({ decisions: [decision] })).toEqual({
    decisions: [decision],
  })
  expect(
    copilotToolPermissionBodySchema.parse({ decisions: [{ ...decision, expectedDigest: digest }] })
      .decisions[0].expectedDigest
  ).toBe(digest)
})
it.each(['', 'a'.repeat(64), `sha256:${'g'.repeat(64)}`, 0, null])(
  'rejects a malformed declared digest %j',
  (expectedDigest) => {
    expect(
      copilotToolPermissionBodySchema.safeParse({
        decisions: [{ toolCallId: 'call', decision: 'allow', expectedDigest }],
      }).success
    ).toBe(false)
  }
)
it('keeps revision zero and exact body bytes but rejects private projection fields', () => {
  const review = {
    toolCallId: 'call',
    workflowId: 'workflow',
    workspaceId: 'workspace',
    expectedRevision: 0,
    issuedAt: '2026-10-19T12:00:00.000Z',
    expiresAt: '2026-10-19T12:10:00.000Z',
    digest,
    body: ' {"atomic":true}\n',
  }
  expect(workflowProposalReviewSchema.parse(review)).toEqual(review)
  expect(
    workflowProposalReviewSchema.safeParse({ ...review, sessionId: 'private-session' }).success
  ).toBe(false)
})
