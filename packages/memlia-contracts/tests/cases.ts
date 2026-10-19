// Copyright (c) 2026 Memlia. All rights reserved.
import { fixtures, artifact, principal } from './fixtures.ts'
import type { ContractName } from '../src/index.ts'
export type Case = { label: string; name: ContractName; value: unknown; valid: boolean }
export const cases: Case[] = Object.entries(fixtures).map(([name, value]) => ({
  label: `${name} valid`,
  name: name as ContractName,
  value,
  valid: true,
}))
function bad(name: ContractName, label: string, change: (value: any) => void) {
  const value = structuredClone(fixtures[name])
  change(value)
  cases.push({ name, label, value, valid: false })
}
for (const name of Object.keys(fixtures) as ContractName[]) {
  bad(name, `${name} rejects future wire versions`, (v) => {
    v.schemaVersion += '.future'
  })
  bad(name, `${name} rejects undeclared secrets`, (v) => {
    v.accessToken = 'FAKE-CANARY-NOT-A-SECRET'
  })
}
bad('Principal', 'actorless schedule requires explicit grant', (v) => {
  v.actor.principal = {
    kind: 'system',
    serviceId: 'schedule',
    workspaceId: 'workspace-fixture',
    workflowId: 'workflow-fixture',
  }
})
bad('Principal', 'principal cannot omit actor', (v) => {
  delete v.actor
})
bad('Principal', 'delegated authority cannot omit grant', (v) => {
  v.authority = { kind: 'delegation' }
})
bad('Principal', 'bearer never appears in serialized Sim identity', (v) => {
  v.actor.principal.token = 'FAKE-CANARY'
})
bad('Binding', 'personal binding cannot fall back to owner', (v) => {
  v.connection.resolution = 'workflow_owner'
})
bad('Binding', 'shared binding requires approval', (v) => {
  v.connection = {
    kind: 'shared',
    credentialOwnerUserId: 'other-fixture',
    allowedSubjectIds: ['user-fixture'],
  }
})
bad('Delegation', 'revoked grant needs revocation time', (v) => {
  v.revocation.state = 'revoked'
})
bad('Delegation', 'grant uses canonical UTC millisecond timestamps', (v) => {
  v.expiresAt = '2026-10-20T05:00:00+02:00'
})
bad('WorkflowProposal', 'proposal cannot use unsafe integer revisions', (v) => {
  v.expectedRevision = 9007199254740992
})
bad('WorkflowProposal', 'proposal requires exact operation bytes hash', (v) => {
  delete v.operations.sha256
})
bad('Approval', 'approval requires target digest', (v) => {
  delete v.target.digest
})
bad('JobEnvelope', 'unknown runner is rejected', (v) => {
  v.runner = 'eval-python'
})
bad('JobEnvelope', 'job input reference rejects host traversal', (v) => {
  v.inputs[0].artifactId = '../../etc/passwd'
})
bad('JobEnvelope', 'provider idempotence requires verifier', (v) => {
  v.effectPolicy = { kind: 'provider_idempotent', providerKey: 'key-fixture' }
})
bad('RunReceipt', 'uncertain effect cannot be declared verified', (v) => {
  v.outcome.status = 'succeeded_verified'
})
bad('RunReceipt', 'verified success requires independent proof', (v) => {
  v.outcome = {
    status: 'succeeded_verified',
    effect: 'known',
    evidence: [],
    verifierId: 'verifier-fixture',
  }
})
bad('RunReceipt', 'cancel-before-start cannot report effects', (v) => {
  v.outcome = { status: 'cancelled_before_start', effect: 'known', evidence: [] }
})
bad('SessionCapability', 'capability requires local consent', (v) => {
  delete v.consent
})
bad('SessionCapability', 'capability requires locks', (v) => {
  v.resourceLocks = []
})
bad('AgentCommand', 'negative fencing epoch is refused', (v) => {
  v.leaseEpoch = -1
})
bad('AgentCommand', 'remote command cannot carry shell', (v) => {
  v.action = { kind: 'shell', command: 'echo fixture' }
})
bad('AgentCommand', 'download URL is not a bundle reference', (v) => {
  v.bundle = { url: 'https://example.invalid/a' }
})
bad('ExcelProcedure', 'unknown Excel operation is rejected', (v) => {
  v.operations[0].op = 'exec'
})
bad('ExcelProcedure', 'injected host path is rejected', (v) => {
  v.inputs[0].bindingId = 'C:\\private\\fixture.xlsx'
})
bad('ExcelProcedure', 'all-null aggregate cannot silently become zero', (v) => {
  v.decimalPolicy.allNullAggregate = 'zero'
})
bad('ExcelProcedure', 'formula network function is rejected', (v) => {
  v.formulaPolicy.allowedFunctions = ['WEBSERVICE']
})
bad('ExcelProcedure', 'infinite job duration is rejected', (v) => {
  v.limits.timeoutSeconds = 601
})
bad('Snapshot', 'decimal must be exact text', (v) => {
  v.cells[0].value.value = 12.5
})
bad('Snapshot', 'locale comma is not canonical Decimal', (v) => {
  v.cells[0].value.value = '12,50'
})
bad('Snapshot', 'raw formula text is not data formula intent', (v) => {
  v.cells[0].formula = '=WEBSERVICE("https://example.invalid")'
})
bad('PatchSet', 'mutation requires preimage', (v) => {
  delete v.mutations[0].before
})
bad('PatchSet', 'column outside Excel bounds is rejected', (v) => {
  v.mutations[0].column = 16385
})
bad('CommitReceipt', 'partial write requires verified backup receipt', (v) => {
  delete v.outcome.backup
})
bad('CommitReceipt', 'partial write requires reconciliation', (v) => {
  v.outcome.reconciliationRequired = false
})
bad('CommitReceipt', 'written file alone is not verified success', (v) => {
  v.outcome = { status: 'succeeded_verified', saved: artifact }
})
const schedule = structuredClone(principal) as any
schedule.actor.principal = {
  kind: 'system',
  serviceId: 'schedule',
  workspaceId: 'workspace-fixture',
  workflowId: 'workflow-fixture',
}
schedule.authority = { kind: 'delegation', delegationId: 'grant-fixture' }
cases.push({
  name: 'Principal',
  label: 'schedule explicitly carries subject delegation',
  value: schedule,
  valid: true,
})
for (const cellValue of [
  { kind: 'null' },
  { kind: 'decimal', value: '0' },
  { kind: 'string', value: '=not-a-formula' },
]) {
  const value = structuredClone(fixtures.Snapshot) as any
  value.cells[0].value = cellValue
  cases.push({
    name: 'Snapshot',
    label: `cell ${JSON.stringify(cellValue)} is preserved`,
    value,
    valid: true,
  })
}
for (const operation of [
  { op: 'cast', column: 'amount', type: 'decimal', onInvalid: 'reject' },
  { op: 'map', column: 'amount', mapping: artifact, onUnmatched: 'reject' },
  {
    op: 'join',
    rightInput: 'reference',
    leftKeys: ['id'],
    rightKeys: ['id'],
    how: 'left',
    cardinality: 'many_to_one',
    onUnmatched: 'report',
  },
  {
    op: 'aggregate',
    groupBy: ['id'],
    values: [{ column: 'amount', as: 'total', function: 'sum', allNull: 'null' }],
  },
  { op: 'pivot', index: ['id'], on: 'month', value: 'amount', function: 'sum', allNull: 'reject' },
  { op: 'melt', index: ['id'], values: ['january'], variableName: 'month', valueName: 'amount' },
  { op: 'sort', keys: [{ column: 'amount', direction: 'asc', nulls: 'last' }] },
  {
    op: 'derive',
    column: 'doubled',
    expression: {
      kind: 'arithmetic',
      operator: 'multiply',
      left: { kind: 'col', name: 'amount' },
      right: { kind: 'literal', value: { kind: 'decimal', value: '2' } },
    },
  },
  {
    op: 'filter',
    predicate: {
      kind: 'comparison',
      operator: 'gt',
      left: { kind: 'col', name: 'amount' },
      right: { kind: 'literal', value: { kind: 'decimal', value: '0' } },
    },
  },
]) {
  const value = structuredClone(fixtures.ExcelProcedure) as any
  value.operations = [{ ...operation, input: 'source', output: 'result' }]
  cases.push({
    name: 'ExcelProcedure',
    label: `typed ${operation.op} operation`,
    value,
    valid: true,
  })
}

bad('PatchSet', 'each mutation is addressable by a receipt', (v) => {
  delete v.mutations[0].mutationId
})
bad('ExcelProcedure', 'procedure must map its table output to a destination', (v) => {
  delete v.writes
})

const verifiedRun = structuredClone(fixtures.RunReceipt) as any
verifiedRun.outcome = {
  status: 'succeeded_verified',
  effect: 'known',
  evidence: [artifact],
  verifierId: 'verifier-fixture',
}
cases.push({
  name: 'RunReceipt',
  label: 'verified run with independent evidence',
  value: verifiedRun,
  valid: true,
})
const verifiedCommit = structuredClone(fixtures.CommitReceipt) as any
verifiedCommit.outcome = {
  status: 'succeeded_verified',
  backup: fixtures.CommitReceipt.outcome.backup,
  appliedMutationIds: ['mutation-fixture'],
  calculation: 'verified',
  saved: artifact,
  readback: artifact,
  postconditionEvidence: [artifact],
  publishedManifest: artifact,
}
cases.push({
  name: 'CommitReceipt',
  label: 'verified saved/readback/publication receipt',
  value: verifiedCommit,
  valid: true,
})
const noEffect = structuredClone(fixtures.CommitReceipt) as any
noEffect.outcome = {
  status: 'cancelled_without_effect',
  reasonCode: 'user-cancelled',
  effect: 'none',
}
cases.push({
  name: 'CommitReceipt',
  label: 'cancellation before writes needs no invented backup',
  value: noEffect,
  valid: true,
})
const uncalculated = structuredClone(fixtures.CommitReceipt) as any
uncalculated.outcome = {
  status: 'written_unverified',
  backup: fixtures.CommitReceipt.outcome.backup,
  appliedMutationIds: ['mutation-fixture'],
  calculation: 'not_calculated',
  saved: artifact,
  evidence: [],
}
cases.push({
  name: 'CommitReceipt',
  label: 'uncalculated workbook is explicitly unverified',
  value: uncalculated,
  valid: true,
})
const shared = structuredClone(fixtures.Binding) as any
shared.connection = {
  kind: 'shared',
  credentialOwnerUserId: 'owner-fixture',
  approvalId: 'approval-fixture',
  allowedSubjectIds: ['user-fixture'],
}
cases.push({
  name: 'Binding',
  label: 'shared connection carries approval and subject list',
  value: shared,
  valid: true,
})
const revoked = structuredClone(fixtures.Delegation) as any
revoked.revocation = { state: 'revoked', revision: 1, revokedAt: '2026-10-19T03:01:00.000Z' }
cases.push({
  name: 'Delegation',
  label: 'revoked grant remains representable for audit',
  value: revoked,
  valid: true,
})
const capture = structuredClone(fixtures.AgentCommand) as any
capture.action = {
  kind: 'capture.start',
  maxDurationSeconds: 1800,
  maxBytes: 2147483648,
  audio: false,
}
cases.push({
  name: 'AgentCommand',
  label: 'bounded capture command has no audio or arbitrary command',
  value: capture,
  valid: true,
})

// Independent review regressions. Existing expectations above remain unchanged.
for (const [endingName, ending] of [
  ['LF', '\n'],
  ['CR', '\r'],
  ['CRLF', '\r\n'],
  ['NEL', '\u0085'],
  ['LS', '\u2028'],
  ['PS', '\u2029'],
  ['LF followed by text', '\nextra'],
]) {
  bad('Binding', `ID rejects ${endingName}`, (v) => {
    v.bindingId += ending
  })
  bad('WorkflowProposal', `digest rejects ${endingName}`, (v) => {
    v.digest += ending
  })
  bad('Delegation', `timestamp rejects ${endingName}`, (v) => {
    v.issuedAt += ending
  })
  bad('AgentCommand', `SID rejects ${endingName}`, (v) => {
    v.windowsSid += ending
  })
  bad('Snapshot', `Decimal rejects ${endingName}`, (v) => {
    v.cells[0].value.value += ending
  })
  bad('Snapshot', `cell date rejects ${endingName}`, (v) => {
    v.cells[0].value = { kind: 'date', value: `2026-10-19${ending}` }
  })
}
for (const [label, text, valid] of [
  ['empty', '', false],
  ['BMP limit', 'é'.repeat(256), true],
  ['BMP over limit', 'é'.repeat(257), false],
  ['review astral example', '😀'.repeat(129), true],
  ['astral limit', '😀'.repeat(256), true],
  ['astral over limit', '😀'.repeat(257), false],
  ['combining limit', 'e\u0301'.repeat(128), true],
  ['combining over limit', 'e\u0301'.repeat(129), false],
  ['unpaired surrogate', '\ud800', false],
] as const) {
  const value = structuredClone(fixtures.Binding)
  value.provider = text
  cases.push({
    name: 'Binding',
    label: `Label counts Unicode scalar values: ${label}`,
    value,
    valid,
  })
}
for (const [label, text, valid] of [
  ['empty', '', true],
  ['BMP limit', 'é'.repeat(32767), true],
  ['BMP over limit', 'é'.repeat(32768), false],
  ['review astral example', '😀'.repeat(16384), true],
  ['astral limit', '😀'.repeat(32767), true],
  ['astral over limit', '😀'.repeat(32768), false],
  ['mixed limit', `${'😀'.repeat(16383)}${'é'.repeat(16384)}`, true],
  ['unpaired surrogate', '\udfff', false],
] as const) {
  const value = structuredClone(fixtures.Snapshot) as any
  value.cells[0].value = { kind: 'string', value: text }
  cases.push({
    name: 'Snapshot',
    label: `CellValue string counts Unicode scalar values: ${label}`,
    value,
    valid,
  })
}
for (const [date, valid] of [
  ['0000-01-01', false],
  ['0001-01-01', true],
  ['9999-12-31', true],
  ['10000-01-01', false],
  ['2000-02-29', true],
  ['1900-02-29', false],
] as const) {
  const value = structuredClone(fixtures.Snapshot) as any
  value.cells[0].value = { kind: 'date', value: date }
  cases.push({ name: 'Snapshot', label: `Gregorian cell date ${date}`, value, valid })
}
for (const [timestamp, valid] of [
  ['0000-01-01T00:00:00.000Z', false],
  ['0001-01-01T00:00:00.000Z', true],
  ['9999-12-31T23:59:59.999Z', true],
  ['10000-01-01T00:00:00.000Z', false],
] as const) {
  const value = structuredClone(fixtures.Delegation)
  value.issuedAt = timestamp
  cases.push({ name: 'Delegation', label: `Gregorian timestamp ${timestamp}`, value, valid })
}
const noChangesPatch = {
  ...structuredClone(fixtures.PatchSet),
  kind: 'no_changes',
  writeScopes: [],
  mutations: [],
  calculation: 'not_required',
}
cases.push({
  name: 'PatchSet',
  label: 'explicit no-changes observation has zero mutations',
  value: noChangesPatch,
  valid: true,
})
const noChangesReceipt = {
  ...structuredClone(fixtures.CommitReceipt),
  outcome: {
    status: 'no_changes_verified',
    effect: 'none',
    procedureId: 'procedure-fixture',
    procedureVersion: 1,
    procedureDigest: fixtures.PatchSet.procedureDigest,
    snapshotId: 'snapshot-fixture',
    workbookId: 'workbook-fixture',
    workbookVersion: 'version-fixture',
    appliedMutationIds: [],
    readback: artifact,
    postconditionEvidence: [artifact],
  },
}
cases.push({
  name: 'CommitReceipt',
  label: 'verified idempotent replay has evidence but no invented write or backup',
  value: noChangesReceipt,
  valid: true,
})
for (const missing of [
  'procedureId',
  'procedureVersion',
  'procedureDigest',
  'snapshotId',
  'workbookId',
  'workbookVersion',
  'readback',
]) {
  const value = structuredClone(noChangesReceipt) as any
  delete value.outcome[missing]
  cases.push({
    name: 'CommitReceipt',
    label: `no-changes verification requires ${missing}`,
    value,
    valid: false,
  })
}
for (const [label, change] of [
  [
    'write ID',
    (v: any) => {
      v.outcome.appliedMutationIds = ['mutation-fixture']
    },
  ],
  [
    'known effect',
    (v: any) => {
      v.outcome.effect = 'known'
    },
  ],
  [
    'no proof',
    (v: any) => {
      v.outcome.postconditionEvidence = []
    },
  ],
  [
    'saved output',
    (v: any) => {
      v.outcome.saved = artifact
    },
  ],
] as const) {
  const value = structuredClone(noChangesReceipt)
  change(value)
  cases.push({
    name: 'CommitReceipt',
    label: `no-changes branch rejects ${label}`,
    value,
    valid: false,
  })
}
for (const [label, change] of [
  [
    'mutation',
    (v: any) => {
      v.mutations = fixtures.PatchSet.mutations
    },
  ],
  [
    'write scope',
    (v: any) => {
      v.writeScopes = fixtures.PatchSet.writeScopes
    },
  ],
  [
    'missing procedure version',
    (v: any) => {
      delete v.procedureVersion
    },
  ],
  [
    'missing snapshot digest',
    (v: any) => {
      delete v.snapshotDigest
    },
  ],
] as const) {
  const value = structuredClone(noChangesPatch)
  change(value)
  cases.push({
    name: 'PatchSet',
    label: `no-changes observation rejects ${label}`,
    value,
    valid: false,
  })
}
bad('PatchSet', 'empty mutation patch must be explicitly a no-changes observation', (v) => {
  v.mutations = []
})
for (const [label, original] of [
  ['verified write', verifiedCommit],
  ['unverified write', uncalculated],
  ['partial write', fixtures.CommitReceipt],
] as const) {
  const value = structuredClone(original) as any
  delete value.outcome.backup
  cases.push({
    name: 'CommitReceipt',
    label: `${label} cannot omit backup after no-changes extension`,
    value,
    valid: false,
  })
}

for (const [label, original] of [
  ['verified', verifiedCommit],
  ['unverified', uncalculated],
  ['partial', fixtures.CommitReceipt],
  [
    'uncertain',
    {
      ...fixtures.CommitReceipt,
      outcome: { ...fixtures.CommitReceipt.outcome, status: 'uncertain' },
    },
  ],
] as const) {
  for (const field of ['persistedAt', 'verifiedAt']) {
    const value = structuredClone(original) as any
    delete value.outcome.backup[field]
    cases.push({
      name: 'CommitReceipt',
      label: `${label} write requires backup ${field}`,
      value,
      valid: false,
    })
  }
}
