// Copyright (c) 2026 Memlia. All rights reserved.

import { describe, expect, it } from 'vitest'
import { workflowCompletion } from '@/lib/memlia/chat/workflow-completion'
import { buildCompletionNotice } from './completion-notice'

function payload() {
  return {
    status: 'complete',
    response: {
      modelTurn: { finishReason: 'max_tokens' },
      workflow: workflowCompletion(
        { evaluated: 1, refused: 0 },
        { created: 1, applied: 1, skipped: 0 },
        { baseRevision: 4, draftRevision: 5 }
      ),
    },
  }
}

describe('closed completion display observation', () => {
  it.each([
    [
      workflowCompletion({ evaluated: 0, refused: 0 }, { created: 0, applied: 0, skipped: 0 }),
      'ni préparation ni modification',
    ],
    [
      workflowCompletion({ evaluated: 1, refused: 1 }, { created: 0, applied: 0, skipped: 0 }),
      'préparation du workflow est signalée, sans modification appliquée',
    ],
    [
      workflowCompletion({ evaluated: 1, refused: 0 }, { created: 1, applied: 0, skipped: 1 }),
      'proposition est signalée, sans modification appliquée',
    ],
    [payload().response.workflow, 'modification du workflow est signalée comme appliquée'],
  ])('separates a limited reply from the native workflow stage (%#)', (workflow, phrase) => {
    const notice = buildCompletionNotice({
      ...payload(),
      response: { ...payload().response, workflow },
    })
    expect(notice).toContain('Réponse limitée')
    expect(notice).toContain('vide ou incomplète')
    expect(notice).toContain(phrase)
    expect(notice).toContain('Aucune exécution du workflow par ce Chat')
    expect(notice).not.toContain('draftRevision')
    expect(notice).not.toContain('native_port_results')
    expect(notice).not.toMatch(/<|href=|\[.*\]\(/)
  })

  it.each(['end_turn', 'stop_sequence', 'not_observed'])(
    'leaves a non-limited observation unchanged (%s)',
    (finishReason) => {
      const value = payload()
      value.response.modelTurn.finishReason = finishReason
      expect(buildCompletionNotice(value)).toBeUndefined()
    }
  )

  it.each([
    {},
    { status: 'complete' },
    { status: 'complete', response: {} },
    { status: 'complete', response: { workflow: payload().response.workflow } },
  ])('keeps legacy completion presentation (%#)', (value) => {
    expect(buildCompletionNotice(value)).toBeUndefined()
  })

  it.each(['error', 'cancelled', undefined, 'unexpected'])(
    'never substitutes a completion notice for status %s',
    (status) => {
      expect(buildCompletionNotice({ ...payload(), status })).toBeUndefined()
    }
  )

  const response = payload().response
  const workflow = response.workflow
  it.each([
    ['unknown response field', { ...response, raw: '<script>secret</script>' }],
    ['pause', { ...response, async_pause: {} }],
    ['unknown model field', { ...response, modelTurn: { ...response.modelTurn, raw: 'secret' } }],
    ['unknown reason', { ...response, modelTurn: { finishReason: '<b>success</b>' } }],
    ['null model', { ...response, modelTurn: null }],
    ['array workflow', { ...response, workflow: [] }],
    ['version', { ...response, workflow: { ...workflow, version: true } }],
    ['provenance', { ...response, workflow: { ...workflow, provenance: 'model' } }],
    ['unknown workflow field', { ...response, workflow: { ...workflow, html: '<img src=x>' } }],
    [
      'unknown preview field',
      { ...response, workflow: { ...workflow, previews: { ...workflow.previews, extra: true } } },
    ],
    [
      'negative count',
      { ...response, workflow: { ...workflow, previews: { ...workflow.previews, evaluated: -1 } } },
    ],
    [
      'fractional count',
      {
        ...response,
        workflow: { ...workflow, proposals: { ...workflow.proposals, created: 1.5 } },
      },
    ],
    [
      'unsafe count',
      {
        ...response,
        workflow: {
          ...workflow,
          previews: { ...workflow.previews, refused: Number.MAX_SAFE_INTEGER + 1 },
        },
      },
    ],
    [
      'string count',
      { ...response, workflow: { ...workflow, previews: { ...workflow.previews, refused: '0' } } },
    ],
    [
      'nonfinite count',
      {
        ...response,
        workflow: { ...workflow, previews: { ...workflow.previews, refused: Infinity } },
      },
    ],
    ['inconsistent stage', { ...response, workflow: { ...workflow, stage: 'no_preparation' } }],
    [
      'inconsistent totals',
      { ...response, workflow: { ...workflow, proposals: { ...workflow.proposals, skipped: 1 } } },
    ],
    [
      'missing revision',
      { ...response, workflow: { ...workflow, latestAppliedRevision: undefined } },
    ],
    [
      'unexpected revision',
      {
        ...response,
        workflow: {
          ...workflow,
          proposals: { created: 1, applied: 0, skipped: 1 },
          stage: 'proposal_not_applied',
        },
      },
    ],
    [
      'reverse revision',
      {
        ...response,
        workflow: { ...workflow, latestAppliedRevision: { baseRevision: 4, draftRevision: 3 } },
      },
    ],
    [
      'extra revision field',
      {
        ...response,
        workflow: {
          ...workflow,
          latestAppliedRevision: { ...workflow.latestAppliedRevision, extra: true },
        },
      },
    ],
    [
      'execution claim',
      { ...response, workflow: { ...workflow, workflowExecutionByThisChatBackend: 'performed' } },
    ],
  ])(
    'ignores malformed/untrusted observations without rendering raw values: %s',
    (_label, invalidResponse) => {
      expect(
        buildCompletionNotice({ status: 'complete', response: invalidResponse })
      ).toBeUndefined()
    }
  )
})
