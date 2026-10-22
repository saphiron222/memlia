// Copyright (c) 2026 Memlia. All rights reserved.
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { V2WorkflowGraph } from '@/lib/api/contracts/v2/workflows'
import { chatCorpus } from './corpus'
import { type ChatObservation, gradeChatCase } from './oracles'

// Synthetic observations test the grader, never a model, DB, permission check or calculation.
function block(id: string, name: string, type = 'note') {
  return {
    id,
    name,
    type,
    position: { x: 0, y: 0 },
    enabled: true,
    outputs: {},
    subBlocks: {
      content: { id: 'content', type: 'long-input', value: 'Fictive annotation to preserve' },
    },
  }
}
function observation(id = 'note-rename'): ChatObservation {
  const before = {
    draftRevision: 7,
    blocks: { focus: block('focus', 'Initial'), sentinel: block('sentinel', 'Intact') },
    edges: [],
    loops: {},
    parallels: {},
    variables: {},
  }
  const after = structuredClone(before)
  after.draftRevision = 8
  after.blocks.focus.name = 'Note vérifiée'
  const body = JSON.stringify({
    expectedRevision: 7,
    atomic: true,
    layout: 'none',
    operations: [{ operation_type: 'edit', block_id: 'focus', params: { name: 'Note vérifiée' } }],
  })
  const digest = createHash('sha256').update(body).digest('hex')
  return {
    caseId: id,
    origin: 'synthetic',
    outcome: 'proposal',
    before,
    beforeConsent: structuredClone(before),
    after,
    authority: { scopeMatches: true, copilotUse: true, workflowWrite: true },
    proposal: {
      body,
      reviewedBody: body,
      bodySha256: `sha256:${digest}`,
      digest: `sha256:${'a'.repeat(64)}`,
      confirmedDigest: `sha256:${'a'.repeat(64)}`,
    },
    nativePreviewAccepted: true,
    streamClosed: true,
    tools: [
      { name: 'read_workflow', ok: true },
      { name: 'preview_workflow_operations', ok: true },
    ],
    questions: [],
    missingConnections: [],
    leaked: false,
    unexpectedEffects: 0,
    execution: 'not_executed',
  }
}
function task(id = 'note-rename') {
  const value = chatCorpus.find((c) => c.id === id)
  if (!value) throw new Error('case missing')
  return value
}
function graph(value: unknown): V2WorkflowGraph {
  return value as V2WorkflowGraph
}
function bodyChange(o: ChatObservation, change: (body: Record<string, unknown>) => void) {
  const value = JSON.parse(o.proposal!.body)
  change(value)
  const body = JSON.stringify(value)
  o.proposal = {
    body,
    reviewedBody: body,
    bodySha256: `sha256:${createHash('sha256').update(body).digest('hex')}`,
    digest: `sha256:${'a'.repeat(64)}`,
    confirmedDigest: `sha256:${'a'.repeat(64)}`,
  }
}

describe('Chat evaluation observations, no model or executor', () => {
  it('leaves an unrun case unobserved instead of scoring a missing record as success', () => {
    expect(gradeChatCase(task()).status).toBe('not_observed')
  })
  it('accepts only the exact confirmed rename while preserving all configuration', () => {
    expect(gradeChatCase(task(), observation())).toMatchObject({
      status: 'pass',
      calculation: 'not_executed',
      modelQualityMeasured: false,
    })
  })
  it.each<[string, (o: ChatObservation) => void]>([
    [
      'foreign case',
      (o: ChatObservation) => {
        o.caseId = 'api-rename'
      },
    ],
    [
      'foreign scope',
      (o: ChatObservation) => {
        o.authority.scopeMatches = false
      },
    ],
    [
      'missing copilot permission',
      (o: ChatObservation) => {
        o.authority.copilotUse = false
      },
    ],
    [
      'missing write permission',
      (o: ChatObservation) => {
        o.authority.workflowWrite = false
      },
    ],
    [
      'early effect',
      (o: ChatObservation) => {
        o.beforeConsent = o.after
      },
    ],
    [
      'unknown execution',
      (o: ChatObservation) => {
        o.execution = 'unknown'
      },
    ],
    [
      'unapproved execution',
      (o: ChatObservation) => {
        o.execution = 'executed'
      },
    ],
    [
      'leak',
      (o: ChatObservation) => {
        o.leaked = true
      },
    ],
    [
      'unexpected effect',
      (o: ChatObservation) => {
        o.unexpectedEffects = 1
      },
    ],
    [
      'unclosed SSE',
      (o: ChatObservation) => {
        o.streamClosed = false
      },
    ],
    [
      'missing preview',
      (o: ChatObservation) => {
        o.nativePreviewAccepted = false
      },
    ],
    [
      'changed displayed bytes',
      (o: ChatObservation) => {
        o.proposal!.reviewedBody += ' '
      },
    ],
    [
      'foreign digest',
      (o: ChatObservation) => {
        o.proposal!.confirmedDigest = '0'.repeat(64)
      },
    ],
    [
      'no approval',
      (o: ChatObservation) => {
        o.proposal!.confirmedDigest = null
      },
    ],
    [
      'stale R',
      (o: ChatObservation) => {
        bodyChange(o, (b) => {
          b.expectedRevision = 6
        })
      },
    ],
    [
      'non atomic',
      (o: ChatObservation) => {
        bodyChange(o, (b) => {
          b.atomic = false
        })
      },
    ],
    [
      'extra write',
      (o: ChatObservation) => {
        bodyChange(o, (b) => {
          b.setBlockEnabled = [{ block_id: 'sentinel', enabled: false }]
        })
      },
    ],
    [
      'wrong revision',
      (o: ChatObservation) => {
        graph(o.after).draftRevision = 9
      },
    ],
    [
      'foreign block edit',
      (o: ChatObservation) => {
        graph(o.after).blocks.sentinel.name = 'Changed'
      },
    ],
    [
      'lost configuration',
      (o: ChatObservation) => {
        graph(o.after).blocks.focus.subBlocks = {}
      },
    ],
    [
      'extra block',
      (o: ChatObservation) => {
        graph(o.after).blocks.extra = block('extra', 'Extra')
      },
    ],
    [
      'dangling edge',
      (o: ChatObservation) => {
        graph(o.after).edges.push({ id: 'bad', source: 'focus', target: 'missing' })
      },
    ],
    [
      'forbidden tool',
      (o: ChatObservation) => {
        o.tools.push({ name: 'execute_workflow', ok: true })
      },
    ],
  ])('rejects %s', (_name, mutate) => {
    const o = observation()
    mutate(o)
    expect(gradeChatCase(task(), o).status).toBe('fail')
  })
  it('does not count a correct refusal as a successful edit on a feasible case', () => {
    const o = observation()
    o.outcome = 'refusal'
    o.after = o.before
    o.proposal = null
    expect(gradeChatCase(task(), o).status).toBe('fail')
  })
  it('requires an actual question and no writes for clarification', () => {
    const o = observation('note-clarify')
    o.outcome = 'clarification'
    o.after = o.before
    o.proposal = null
    o.tools = []
    expect(gradeChatCase(task(o.caseId), o).status).toBe('fail')
    o.questions = ['Quel contenu souhaitez-vous afficher ?']
    expect(gradeChatCase(task(o.caseId), o).status).toBe('pass')
    o.proposal = observation().proposal
    expect(gradeChatCase(task(o.caseId), o).status).toBe('fail')
  })
  it('distinguishes a missing connection from generic refusal and from a working integration', () => {
    const o = observation('gmail-create')
    o.outcome = 'connection_required'
    o.after = o.before
    o.proposal = null
    o.tools = []
    expect(gradeChatCase(task(o.caseId), o).status).toBe('fail')
    o.missingConnections = ['gmail']
    expect(gradeChatCase(task(o.caseId), o).status).toBe('pass')
  })
  it('read-only refusal preserves the graph without a proposal or successful mutation tool', () => {
    const o = observation('note-forbidden')
    o.outcome = 'refusal'
    o.authority.workflowWrite = false
    o.after = o.before
    o.proposal = null
    o.tools = []
    expect(gradeChatCase(task(o.caseId), o).status).toBe('pass')
    o.tools.push({ name: 'memlia_apply_workflow_proposal', ok: true })
    expect(gradeChatCase(task(o.caseId), o).status).toBe('fail')
  })
})

function generated(): ChatObservation {
  const o = observation('function-create')
  const before = {
    draftRevision: 7,
    blocks: { sentinel: block('sentinel', 'Intact') },
    edges: [],
    loops: {},
    parallels: {},
    variables: {},
  }
  const data = {
    ...block('data', 'Donnees', 'function'),
    subBlocks: { code: { id: 'code', type: 'code', value: 'return [12, 8, 5]' } },
  }
  const total = {
    ...block('total', 'Total', 'function'),
    subBlocks: {
      code: {
        id: 'code',
        type: 'code',
        value: 'return <donnees.result>.reduce((sum, value) => sum + value, 0)',
      },
    },
  }
  o.before = before
  o.beforeConsent = structuredClone(before)
  o.after = {
    ...before,
    draftRevision: 8,
    blocks: { ...before.blocks, start: block('start', 'Départ', 'start_trigger'), data, total },
    edges: [
      { id: 'e1', source: 'start', target: 'data' },
      { id: 'e2', source: 'data', target: 'total' },
    ],
  }
  bodyChange(o, (b) => {
    b.operations = [
      {
        operation_type: 'add',
        block_id: 'start',
        params: {
          type: 'start_trigger',
          name: 'Départ',
          connections: { source: { target: 'data' } },
        },
      },
      {
        operation_type: 'add',
        block_id: 'data',
        params: {
          type: 'function',
          name: 'Donnees',
          inputs: { code: data.subBlocks.code.value },
          connections: { source: { target: 'total' } },
        },
      },
      {
        operation_type: 'add',
        block_id: 'total',
        params: { type: 'function', name: 'Total', inputs: { code: total.subBlocks.code.value } },
      },
    ]
  })
  o.tools.push({ name: 'get_block', ok: true })
  return o
}

describe('generated graph regressions (no generated code evaluated)', () => {
  it('keeps an explicit harmless native add position', () => {
    const o = generated()
    bodyChange(o, (b) => {
      ;(b.operations as Array<{ params: Record<string, unknown> }>)[0].params.position = {
        x: 10,
        y: 20,
      }
    })
    expect(gradeChatCase(task(o.caseId), o).status).toBe('pass')
  })
  it('accepts a native structured predecessor and two real edges, but does not claim the sum was executed', () => {
    const result = gradeChatCase(task('function-create'), generated())
    expect(result).toMatchObject({
      status: 'pass',
      calculation: 'not_executed',
      semantics: 'requires_review',
      modelQualityMeasured: false,
    })
  })
  it.each(['output', 'stdout', 'files', 'resultx'])(
    'rejects a reference to %s instead of the native structured output',
    (key) => {
      const o = generated()
      graph(o.after).blocks.total.subBlocks.code.value = `return <donnees.${key}>`
      expect(gradeChatCase(task(o.caseId), o).status).toBe('fail')
    }
  )
  it.each<[string, (o: ChatObservation) => void]>([
    [
      'foreign reference',
      (o: ChatObservation) => {
        graph(o.after).blocks.total.subBlocks.code.value = 'return <foreign.result>'
      },
    ],
    [
      'hardcoded answer without predecessor',
      (o: ChatObservation) => {
        graph(o.after).blocks.total.subBlocks.code.value = 'return 25'
      },
    ],
    [
      'missing chain edge',
      (o: ChatObservation) => {
        graph(o.after).edges.pop()
      },
    ],
    [
      'old sentinel removed',
      (o: ChatObservation) => {
        Reflect.deleteProperty(graph(o.after).blocks, 'sentinel')
      },
    ],
    [
      'unknown extra container',
      (o: ChatObservation) => {
        ;(o.after as { loops: object }).loops = {
          alien: { id: 'alien', nodes: [], iterations: 3, loopType: 'for' },
        }
      },
    ],
    [
      'body missing two creations',
      (o: ChatObservation) => {
        bodyChange(o, (b) => {
          b.operations = (b.operations as unknown[]).slice(0, 1)
        })
      },
    ],
    [
      'body creates an unrelated block',
      (o: ChatObservation) => {
        bodyChange(o, (b) => {
          b.operations = [
            {
              operation_type: 'add',
              block_id: 'foreign',
              params: { type: 'note', name: 'Unrelated' },
            },
          ]
        })
      },
    ],
    [
      'missing native details',
      (o: ChatObservation) => {
        o.tools = o.tools.filter((t) => t.name !== 'get_block')
      },
    ],
  ])('rejects %s', (_name, mutate) => {
    const o = generated()
    mutate(o)
    expect(gradeChatCase(task(o.caseId), o).status).toBe('fail')
  })
})

it('accepts native provisional add ids followed by connection edits of those same additions', () => {
  const o = generated()
  bodyChange(o, (b) => {
    b.operations = [
      {
        operation_type: 'add',
        block_id: 'new-start',
        params: { type: 'start_trigger', name: 'Départ' },
      },
      {
        operation_type: 'add',
        block_id: 'new-data',
        params: { type: 'function', name: 'Donnees', inputs: { code: 'return [12, 8, 5]' } },
      },
      {
        operation_type: 'add',
        block_id: 'new-total',
        params: { type: 'function', name: 'Total', inputs: { code: 'return <donnees.result>' } },
      },
      {
        operation_type: 'edit',
        block_id: 'new-start',
        params: { connections: { source: 'new-data' } },
      },
      {
        operation_type: 'edit',
        block_id: 'new-data',
        params: { connections: { source: 'new-total' } },
      },
    ]
  })
  expect(gradeChatCase(task(o.caseId), o).status).toBe('pass')
})

it.each(['excel_describe_capabilities', 'excel_preview_procedure'])(
  'accepts the native declared Excel read-only tool %s',
  (name) => {
    const o = observation('excel-clarify')
    o.outcome = 'clarification'
    o.after = o.before
    o.proposal = null
    o.questions = ['Quel fichier autorisé et quelle transformation souhaitez-vous ?']
    o.tools = [{ name, ok: true }]
    expect(gradeChatCase(task(o.caseId), o).status).toBe('pass')
  }
)

describe('native layout policy for creation observations', () => {
  it.each(['targeted', 'default'] as const)(
    'accepts %s creation layout while preserving existing elements',
    (layout) => {
      const o = generated()
      bodyChange(o, (body) => {
        if (layout === 'default') delete body.layout
        else body.layout = layout
      })
      graph(o.after).blocks.start.position = { x: 100, y: 200 }
      graph(o.after).blocks.data.position = { x: 500, y: 200 }
      graph(o.after).blocks.total.position = { x: 900, y: 200 }
      expect(gradeChatCase(task(o.caseId), o)).toMatchObject({
        status: 'pass',
        calculation: 'not_executed',
      })
    }
  )
  it('still refuses a targeted creation that moves an unrelated sentinel', () => {
    const o = generated()
    o.after = structuredClone(o.after)
    bodyChange(o, (body) => {
      body.layout = 'targeted'
    })
    graph(o.after).blocks.sentinel.position.x = 100
    expect(gradeChatCase(task(o.caseId), o).errors).toContain('existing_block_changed')
  })
  it.each(['targeted', 'default'] as const)(
    'still refuses %s on a position-preserving rename',
    (layout) => {
      const o = observation()
      bodyChange(o, (body) => {
        if (layout === 'default') delete body.layout
        else body.layout = layout
      })
      expect(gradeChatCase(task(o.caseId), o).errors).toContain('batch_outside_scope')
    }
  )
  it('refuses a layout absent from the native schema', () => {
    const o = generated()
    bodyChange(o, (body) => {
      body.layout = 'all'
    })
    expect(gradeChatCase(task(o.caseId), o).errors).toContain('invalid_native_operations')
  })
})

describe('collector-bound native target identity', () => {
  const targetBlockId = 'a0a0b1b1-c2c2-43d3-84e4-f5f5a6a6b7b7'
  function nativeTarget() {
    const o = observation()
    for (const state of [o.before, o.beforeConsent, o.after]) {
      const g = graph(state)
      g.blocks[targetBlockId] = { ...g.blocks.focus, id: targetBlockId }
      delete g.blocks.focus
    }
    bodyChange(o, (body) => {
      body.operations = [
        { operation_type: 'edit', block_id: targetBlockId, params: { name: 'Note vérifiée' } },
      ]
    })
    return o
  }
  it('accepts the collector UUID without projecting observed body or graph', () => {
    const o = nativeTarget()
    const unchanged = structuredClone(o)
    expect(gradeChatCase({ ...task(), targetBlockId }, o).status).toBe('pass')
    expect(o).toEqual(unchanged)
  })
  it('does not infer the collector target from model operations', () => {
    expect(gradeChatCase(task(), nativeTarget()).status).toBe('fail')
  })
  it('rejects a different collector UUID', () => {
    expect(
      gradeChatCase(
        { ...task(), targetBlockId: '00000000-0000-4000-8000-000000000001' },
        nativeTarget()
      ).status
    ).toBe('fail')
  })
  it.each(['configuration', 'other block'])('preserves %s with a native target', (mutation) => {
    const o = nativeTarget()
    if (mutation === 'configuration')
      graph(o.after).blocks[targetBlockId].subBlocks.content.value = 'changed'
    else graph(o.after).blocks.sentinel.name = 'changed'
    expect(gradeChatCase({ ...task(), targetBlockId }, o)).toMatchObject({
      status: 'fail',
      errors: expect.arrayContaining(['rename_not_preserved']),
    })
  })
  it('keeps historical focus default', () => {
    expect(gradeChatCase(task(), observation()).status).toBe('pass')
  })
})
