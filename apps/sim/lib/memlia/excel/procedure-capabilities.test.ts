// Copyright (c) 2026 Memlia. All rights reserved.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { type ExcelProcedure, ExcelProcedureSchema } from '@memlia/contracts'
import { describe, expect, it, vi } from 'vitest'
import { fixtures } from '../../../../../packages/memlia-contracts/tests/fixtures'
import { inspectExcelProcedureCapabilities, inspectExcelProcedureDraftCapabilities } from './procedure-capabilities'

function recipe(): ExcelProcedure {
  const value = ExcelProcedureSchema.parse(structuredClone(fixtures.ExcelProcedure))
  value.decimalPolicy.precision = 18
  return value
}
function inspect(value: unknown = recipe()) {
  const result = inspectExcelProcedureCapabilities(value)
  expect(result.executionAvailable).toBe(false)
  return result
}
function codes(value: unknown) {
  const result = inspect(value)
  expect(result.schemaValid).toBe(true)
  if (!result.schemaValid) throw new Error('Expected schema-valid fixture')
  return result.diagnostics.map((entry) => entry.code)
}
const table = { input: 'source', output: 'result' }
const col = { kind: 'col' as const, name: 'amount' }
const literal = { kind: 'literal' as const, value: { kind: 'decimal' as const, value: '1.00' } }
const comparison = {
  kind: 'comparison' as const,
  operator: 'eq' as const,
  left: col,
  right: literal,
}
function withOperation(operation: ExcelProcedure['operations'][number]) {
  const value = recipe()
  value.operations = [operation]
  value.requiredCapabilities = ['file.xlsx', `table.${operation.op}`]
  return value
}

describe('Excel procedure primitive capability observation', () => {
  it('validates the complete canonical fixture but refuses its precision 28 profile', () => {
    expect(codes(fixtures.ExcelProcedure)).toContain('decimal_profile_unsupported')
  })
  it('reports compatible primitive options without asserting dataflow, controls or authority', () => {
    const result = inspect()
    expect(result).toMatchObject({
      schemaValid: true,
      primitiveOptionsCompatible: true,
      diagnostics: [],
    })
    expect(result.notVerified).toEqual([
      'dataflow_and_column_types',
      'input_data_and_runtime_limits',
      'procedure_controls',
      'bindings_and_authority',
      'artifact_and_procedure_digests',
      'workflow_revision_and_deployment',
      'write_scopes_and_protected_cells',
      'snapshot_backup_and_approval',
      'patch_application_and_readback',
      'publication_and_idempotence',
      'isolated_runner_and_timeout',
    ])
  })
  it('explicitly leaves missing dataflow and undeclared column types unverified', () => {
    const value = recipe()
    value.operations[0].input = 'missing-table'
    expect(inspect(value)).toMatchObject({
      schemaValid: true,
      primitiveOptionsCompatible: true,
      executionAvailable: false,
      notVerified: expect.arrayContaining(['dataflow_and_column_types']),
    })
  })
  it('allows explicit null organization only as shape, never as authority', () => {
    const value = recipe()
    value.organizationId = null
    expect(inspect(value)).toMatchObject({ schemaValid: true, executionAvailable: false })
  })
  it('pins both kernel sources so expanding its profile requires deliberate requalification', () => {
    const result = inspect()
    expect(result.profile.id).toBe('memlia.excel-kernel-primitives/p00-v1')
    for (const source of result.profile.sources) {
      const bytes = readFileSync(new URL(`../../../../../${source.path}`, import.meta.url))
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(source.sha256)
    }
    expect(result.profile.xlsx).toMatchObject({
      csv: false,
      formulas: false,
      recalculation: false,
      stylesPreserved: false,
      output: 'new_workbook_in_memory',
      decimalOutput: 'exact_text',
      maxCellsIncludingHeaders: 100000,
      maxArchiveBytes: 10000000,
      maxArchiveParts: 512,
    })
  })
  it.each([
    { op: 'select', ...table, columns: ['amount'] },
    { op: 'cast', ...table, column: 'amount', type: 'decimal', onInvalid: 'reject' },
    { op: 'sort', ...table, keys: [{ column: 'amount', direction: 'desc', nulls: 'first' }] },
    {
      op: 'aggregate',
      ...table,
      groupBy: [],
      values: [{ column: 'amount', as: 'total', function: 'sum', allNull: 'null' }],
    },
    {
      op: 'join',
      ...table,
      rightInput: 'right',
      leftKeys: ['amount'],
      rightKeys: ['amount'],
      how: 'left',
      cardinality: 'many_to_one',
      onUnmatched: 'reject',
    },
    {
      op: 'derive',
      ...table,
      column: 'result',
      expression: { kind: 'arithmetic', operator: 'add', left: col, right: literal },
    },
    { op: 'filter', ...table, predicate: comparison },
  ] satisfies ExcelProcedure['operations'])(
    'recognizes implemented options for $op without executing',
    (operation) => {
      expect(codes(withOperation(operation))).toEqual([])
    }
  )
  it.each([
    {
      op: 'map',
      ...table,
      column: 'amount',
      mapping: { artifactId: 'map', sha256: fixtures.ExcelProcedure.digest },
      onUnmatched: 'reject',
    },
    {
      op: 'pivot',
      ...table,
      index: ['amount'],
      on: 'amount',
      value: 'amount',
      function: 'sum',
      allNull: 'null',
    },
    {
      op: 'melt',
      ...table,
      index: ['amount'],
      values: ['amount'],
      variableName: 'name',
      valueName: 'value',
    },
    { op: 'cast', ...table, column: 'amount', type: 'string', onInvalid: 'reject' },
    { op: 'cast', ...table, column: 'amount', type: 'decimal', onInvalid: 'null' },
    {
      op: 'join',
      ...table,
      rightInput: 'right',
      leftKeys: ['amount'],
      rightKeys: ['amount'],
      how: 'full',
      cardinality: 'one_to_one',
      onUnmatched: 'reject',
    },
    {
      op: 'join',
      ...table,
      rightInput: 'right',
      leftKeys: ['amount'],
      rightKeys: ['amount'],
      how: 'inner',
      cardinality: 'one_to_many',
      onUnmatched: 'report',
    },
    {
      op: 'aggregate',
      ...table,
      groupBy: [],
      values: [{ column: 'amount', as: 'total', function: 'mean', allNull: 'reject' }],
    },
    {
      op: 'derive',
      ...table,
      column: 'result',
      expression: { kind: 'arithmetic', operator: 'multiply', left: col, right: literal },
    },
    {
      op: 'derive',
      ...table,
      column: 'result',
      expression: { kind: 'arithmetic', operator: 'divide', left: col, right: literal },
    },
    {
      op: 'derive',
      ...table,
      column: 'result',
      expression: { kind: 'condition', when: comparison, then: col, otherwise: literal },
    },
    {
      op: 'derive',
      ...table,
      column: 'result',
      expression: { kind: 'literal', value: { kind: 'date', value: '2026-01-01' } },
    },
    {
      op: 'filter',
      ...table,
      predicate: {
        ...comparison,
        right: { kind: 'literal', value: { kind: 'date', value: '2026-01-01' } },
      },
    },
  ] satisfies ExcelProcedure['operations'])('refuses unsupported options for $op', (operation) => {
    expect(codes(withOperation(operation))).toContain('operation_options_unsupported')
  })
  it.each([
    { kind: 'null' },
    { kind: 'string', value: '1.00' },
    { kind: 'boolean', value: true },
  ] as const)('refuses a known non-Decimal arithmetic literal $kind', (value) => {
    expect(
      codes(
        withOperation({
          op: 'derive',
          ...table,
          column: 'result',
          expression: {
            kind: 'arithmetic',
            operator: 'add',
            left: col,
            right: { kind: 'literal', value },
          },
        })
      )
    ).toContain('operation_options_unsupported')
  })
  it('derives required capabilities rather than trusting an omitted declaration', () => {
    const value = recipe()
    value.requiredCapabilities = ['table.sort']
    const result = inspect(value)
    expect(result).toMatchObject({
      requiredCapabilities: ['file.xlsx', 'table.select'],
      primitiveOptionsCompatible: false,
    })
    if (result.schemaValid)
      expect(
        result.diagnostics.filter((d) => d.code === 'required_capability_undeclared')
      ).toHaveLength(2)
  })
  it.each(['excel.formulas', 'excel.recalculate', 'excel.styles', 'file.csv'] as const)(
    'does not grant declared %s',
    (capability) => {
      const value = recipe()
      value.requiredCapabilities.push(capability)
      expect(codes(value)).toContain('declared_capability_unsupported')
    }
  )
  it('detects CSV input/output and date input even when capability claims omit them', () => {
    const value = recipe()
    value.inputs[0].format = 'csv'
    value.inputs[0].columns[0].type = 'date'
    value.outputs = [
      {
        role: 'result',
        bindingId: 'output',
        format: 'csv',
        encoding: 'utf-8',
        delimiter: ';',
        formulaInjection: 'escape',
      },
    ]
    expect(codes(value)).toEqual(
      expect.arrayContaining([
        'file_format_unsupported',
        'input_type_unsupported',
        'required_capability_undeclared',
      ])
    )
  })
  it.each([
    (v: ExcelProcedure) => {
      v.decimalPolicy.scale = 18
      v.decimalPolicy.precision = 17
    },
    (v: ExcelProcedure) => {
      v.limits.maxCells = 100001
    },
    (v: ExcelProcedure) => {
      v.limits.maxRows = 100001
    },
  ])('refuses resource or decimal declarations beyond primitive bounds', (mutate) => {
    const value = recipe()
    mutate(value)
    expect(codes(value).length).toBeGreaterThan(0)
  })
  it.each([
    (v: Record<string, unknown>) => {
      Reflect.deleteProperty(v, 'controls')
    },
    (v: Record<string, unknown>) => {
      Reflect.deleteProperty(v, 'writes')
    },
    (v: Record<string, unknown>) => {
      Reflect.deleteProperty(v, 'organizationId')
    },
    (v: Record<string, unknown>) => {
      v.workspaceId = ''
    },
    (v: Record<string, unknown>) => {
      v.path = '/private/canary'
    },
    (v: Record<string, unknown>) => {
      v.operations = [{ op: 'shell', command: 'secret-canary' }]
    },
    (v: Record<string, unknown>) => {
      v.formulaPolicy = { externalLinks: 'allow', dataStrings: 'literal', allowedFunctions: [] }
    },
  ])('refuses the entire malformed recipe instead of extracting its operations', (mutate) => {
    const value = { ...recipe() }
    mutate(value)
    expect(inspect(value)).toMatchObject({ schemaValid: false, code: 'invalid_input' })
  })
  it('captures strict JSON without invoking accessors or toJSON, and rejects lossy containers', () => {
    const callback = vi.fn(() => 'secret-canary')
    const accessor = recipe()
    Object.defineProperty(accessor, 'procedureId', { get: callback, enumerable: true })
    const hidden = recipe()
    Object.defineProperty(hidden, 'hidden', { value: 'secret-canary' })
    const sparse = recipe()
    sparse.operations = Array(2)
    sparse.operations[1] = recipe().operations[0]
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    for (const value of [
      accessor,
      hidden,
      sparse,
      cyclic,
      { ...recipe(), toJSON: callback },
      { ...recipe(), extra: undefined },
    ]) {
      expect(inspect(value)).toMatchObject({ schemaValid: false, code: 'invalid_input' })
    }
    expect(callback).not.toHaveBeenCalled()
  })
  it('bounds input, diagnostics and output without leaking arbitrary values', () => {
    expect(inspect({ ...recipe(), secret: 'x'.repeat(1024 * 1024) })).toMatchObject({
      schemaValid: false,
    })
    const value = withOperation({
      op: 'cast',
      ...table,
      column: 'secret-canary',
      type: 'date',
      onInvalid: 'null',
    })
    value.operations = Array.from({ length: 200 }, () => structuredClone(value.operations[0]))
    const result = inspect(value)
    expect(result).toMatchObject({ diagnosticsTruncated: true, primitiveOptionsCompatible: false })
    if (result.schemaValid) expect(result.diagnostics).toHaveLength(128)
    expect(JSON.stringify(result)).not.toContain('secret-canary')
    expect(JSON.stringify(result).length).toBeLessThan(20000)
  })
  it('returns owned observations and provenance, without mutable global state', () => {
    const value = recipe()
    const result = inspect(value)
    const encoded = JSON.stringify(result)
    value.operations.length = 0
    value.ownerUserId = 'changed'
    expect(JSON.stringify(result)).toBe(encoded)
    result.profile.sources[0].sha256 = 'caller-mutated'
    expect(inspect(recipe()).profile.sources[0].sha256).not.toBe('caller-mutated')
  })
})


describe('P11 draft analysis shares the canonical business fields without invented identity', () => {
  function draft() {
    const full = recipe()
    const {
      schemaVersion,
      organizationId,
      workspaceId,
      procedureId,
      version,
      parentVersion,
      workflowId,
      deployedVersionId,
      ownerUserId,
      digest,
      policyVersion,
      ...value
    } = full
    return value
  }
  it('accepts the known ordered select without publication identity', () => {
    const result = inspectExcelProcedureDraftCapabilities(draft())
    expect(result).toMatchObject({
      schemaValid: true,
      executionAvailable: false,
      primitiveOptionsCompatible: true,
      diagnostics: [],
    })
    expect(result).toEqual(inspectExcelProcedureCapabilities(recipe()))
  })
  it.each([
    'schemaVersion',
    'organizationId',
    'workspaceId',
    'procedureId',
    'version',
    'parentVersion',
    'workflowId',
    'deployedVersionId',
    'ownerUserId',
    'digest',
    'policyVersion',
    'principal',
  ])('refuses model authority field %s rather than discarding it', (key) => {
    expect(
      inspectExcelProcedureDraftCapabilities({ ...draft(), [key]: 'MODEL_AUTHORITY' }).schemaValid
    ).toBe(false)
  })
  it('preserves the primitive refusal instead of treating a draft as a complete runtime profile', () => {
    const value = draft()
    value.decimalPolicy.precision = 28
    expect(inspectExcelProcedureDraftCapabilities(value)).toMatchObject({
      schemaValid: true,
      primitiveOptionsCompatible: false,
      executionAvailable: false,
    })
  })
  it('captures strict JSON without invoking a getter or accepting oversize text', () => {
    let calls = 0
    const getter = Object.defineProperty(draft(), 'operations', {
      enumerable: true,
      get() {
        calls++
        return []
      },
    })
    expect(inspectExcelProcedureDraftCapabilities(getter).schemaValid).toBe(false)
    expect(calls).toBe(0)
    const value = draft()
    value.inputs[0].columns[0].name = 'x'.repeat(512 * 1024)
    expect(inspectExcelProcedureDraftCapabilities(value).schemaValid).toBe(false)
  })
})
