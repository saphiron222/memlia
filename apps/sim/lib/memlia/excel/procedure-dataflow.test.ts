// Copyright (c) 2026 Memlia. All rights reserved.
import { type ExcelProcedure, ExcelProcedureSchema } from '@memlia/contracts'
import { describe, expect, it } from 'vitest'
import { fixtures } from '../../../../../packages/memlia-contracts/tests/fixtures'
import { validateExcelProcedureDataflow } from './procedure-dataflow'

type Op = ExcelProcedure['operations'][number]
function recipe() {
  const value = ExcelProcedureSchema.parse(structuredClone(fixtures.ExcelProcedure))
  value.decimalPolicy.precision = 18
  return value
}
function inspect(value: unknown) {
  const result = validateExcelProcedureDataflow(value)
  expect(result.executionAvailable).toBe(false)
  return result
}
function codes(value: unknown) {
  const result = inspect(value)
  expect(result.schemaValid).toBe(true)
  if (!result.schemaValid) throw new Error('fixture rejected by schema')
  return result.diagnostics.map((d) => d.code)
}
function operations(value: ExcelProcedure, ops: Op[], final = 'selected', column = 'amount') {
  value.operations = ops
  value.requiredCapabilities = ['file.xlsx', ...new Set(ops.map((op) => `table.${op.op}` as const))]
  value.writes[0].input = final
  value.writes[0].columns = [{ source: column, targetColumn: 1 }]
  value.controls = [{ kind: 'not_null', input: final, columns: [column], severity: 'blocking' }]
}
const col = (name: string) => ({ kind: 'col' as const, name })
const decimal = { kind: 'literal' as const, value: { kind: 'decimal' as const, value: '1.00' } }

describe('declarative Excel dataflow without execution authority', () => {
  it('resolves the canonical ordered select without granting execution or business controls', () => {
    const result = inspect(recipe())
    expect(result).toMatchObject({ schemaValid: true, declaredDataflowValid: true, diagnostics: [] })
    expect(result.notVerified).toContain('idempotence_business_key_scope')
    expect(result.notVerified).toContain('input_data_and_runtime_limits')
  })
  it.each(['__proto__', 'constructor'])('owns column %s and a prototype-like valid table ID in Maps', (name) => {
    const value = recipe()
    value.inputs[0].role = 'constructor'
    value.inputs[0].columns[0].name = name
    operations(value, [{ op: 'select', input: 'constructor', output: 'selected', columns: [name] }], 'selected', name)
    expect(inspect(value).declaredDataflowValid).toBe(true)
  })
  it.each([
    ['role_duplicate', (v: ExcelProcedure) => v.inputs.push(structuredClone(v.inputs[0]))],
    ['column_duplicate', (v: ExcelProcedure) => v.inputs[0].columns.push(structuredClone(v.inputs[0].columns[0]))],
    ['column_missing', (v: ExcelProcedure) => v.inputs[0].keyColumns.push('missing')],
    ['table_missing', (v: ExcelProcedure) => { v.operations[0].input = 'future' }],
    ['table_redefinition', (v: ExcelProcedure) => { v.operations[0].output = 'source' }],
    ['column_missing', (v: ExcelProcedure) => { v.operations[0] = { op: 'select', input: 'source', output: 'selected', columns: ['absent'] } }],
    ['binding_missing', (v: ExcelProcedure) => { v.writes[0].destinationBindingId = 'absent' }],
    ['column_missing', (v: ExcelProcedure) => { v.writes[0].columns[0].source = 'absent' }],
    ['table_missing', (v: ExcelProcedure) => { v.controls[0].input = 'absent' }],
    ['role_duplicate', (v: ExcelProcedure) => v.outputs.push(structuredClone(v.outputs[0]))],
  ] as const)('refuses %s without accepting a malformed dependency', (code, mutate) => {
    const value = recipe(); mutate(value)
    expect(codes(value)).toContain(code)
    expect(inspect(value).declaredDataflowValid).toBe(false)
  })
  it('does not publish the table of a rejected operation for a downstream use', () => {
    const value = recipe()
    operations(value, [
      { op: 'select', input: 'source', output: 'bad', columns: ['missing'] },
      { op: 'select', input: 'bad', output: 'selected', columns: ['amount'] },
    ])
    expect(inspect(value).diagnostics).toContainEqual({ code: 'table_missing', operationIndex: 1 })
  })
  it('does not resolve a forward reference even if a later operation creates it', () => {
    const value = recipe()
    operations(value, [
      { op: 'select', input: 'future', output: 'selected', columns: ['amount'] },
      { op: 'select', input: 'source', output: 'future', columns: ['amount'] },
    ])
    expect(inspect(value).diagnostics).toContainEqual({ code: 'table_missing', operationIndex: 0 })
  })
  it('propagates count as integer and requires explicit cast before a decimal sum or write', () => {
    const value = recipe()
    const count: Op = { op: 'aggregate', input: 'source', output: 'counted', groupBy: [], values: [{ column: 'amount', as: 'amount', function: 'count', allNull: 'null' }] }
    operations(value, [count], 'counted')
    expect(codes(value)).toContain('write_type_unsupported')
    operations(value, [count, { op: 'aggregate', input: 'counted', output: 'selected', groupBy: [], values: [{ column: 'amount', as: 'amount', function: 'sum', allNull: 'null' }] }])
    expect(codes(value)).toContain('type_mismatch')
    operations(value, [count, { op: 'cast', input: 'counted', output: 'selected', column: 'amount', type: 'decimal', onInvalid: 'reject' }])
    expect(inspect(value).declaredDataflowValid).toBe(true)
  })
  it.each(['eq', 'lt'] as const)('refuses %s between declared types without implicit cast', (operator) => {
    const value = recipe(); value.inputs[0].columns[0].type = 'string'
    operations(value, [{ op: 'filter', input: 'source', output: 'selected', predicate: { kind: 'comparison', operator, left: col('amount'), right: decimal } }])
    expect(codes(value)).toContain('type_mismatch')
  })
  it('propagates arithmetic and comparison types through downstream consumers', () => {
    const value = recipe()
    operations(value, [
      { op: 'derive', input: 'source', output: 'plus', column: 'plus', expression: { kind: 'arithmetic', operator: 'add', left: col('amount'), right: decimal } },
      { op: 'derive', input: 'plus', output: 'selected', column: 'flag', expression: { kind: 'comparison', operator: 'eq', left: col('plus'), right: decimal } },
    ], 'selected', 'flag')
    expect(inspect(value).declaredDataflowValid).toBe(true)
    value.operations.push({ op: 'cast', input: 'selected', output: 'bad', column: 'flag', type: 'decimal', onInvalid: 'reject' })
    value.requiredCapabilities.push('table.cast')
    expect(codes(value)).toContain('type_mismatch')
  })
})

function joinRecipe() {
  const value = recipe()
  value.inputs[0].columns.unshift({ name: 'leftKey', type: 'string', nullable: false })
  value.inputs.push({ ...structuredClone(value.inputs[0]), role: 'right', columns: [
    { name: 'rightKey', type: 'string', nullable: false },
    { name: 'rightValue', type: 'boolean', nullable: true },
  ] })
  operations(value, [{ op: 'join', input: 'source', output: 'selected', rightInput: 'right', leftKeys: ['leftKey'], rightKeys: ['rightKey'], how: 'left', cardinality: 'many_to_one', onUnmatched: 'reject' }])
  return value
}

describe('bounded owned declarative propagation', () => {
  it('removes right keys and preserves declared nullability for the matched-only left join', () => {
    const value = joinRecipe()
    const result = inspect(value)
    expect(result.declaredDataflowValid).toBe(true)
    expect(result.columnTypes.filter((entry) => entry.operationIndex === 0)).toEqual([
      { operationIndex: 0, columnIndex: 0, type: 'string', nullable: false },
      { operationIndex: 0, columnIndex: 1, type: 'decimal', nullable: true },
      { operationIndex: 0, columnIndex: 2, type: 'boolean', nullable: true },
    ])
    value.writes[0].columns[0].source = 'rightKey'
    expect(codes(value)).toContain('column_missing')
  })
  it('preserves nonnullable right values because unmatched left rows are rejected by this profile', () => {
    const value = joinRecipe(); value.inputs[1].columns[1].nullable = false
    expect(inspect(value).columnTypes).toContainEqual({ operationIndex: 0, columnIndex: 2, type: 'boolean', nullable: false })
  })
  it.each(['collision', 'keyType', 'keyLength', 'duplicateKey'] as const)('rejects ambiguous join %s', (kind) => {
    const value = joinRecipe(); const op = value.operations[0]
    if (op.op !== 'join') throw new Error('fixture')
    if (kind === 'collision') value.inputs[1].columns[1].name = 'amount'
    if (kind === 'keyType') value.inputs[1].columns[0].type = 'boolean'
    if (kind === 'keyLength') op.rightKeys.push('rightValue')
    if (kind === 'duplicateKey') { op.leftKeys.push('leftKey'); op.rightKeys.push('rightKey') }
    expect(inspect(value).declaredDataflowValid).toBe(false)
  })
  it('accepts only the paired shared key collision and retains its left declaration', () => {
    const value = joinRecipe(); const op = value.operations[0]
    if (op.op !== 'join') throw new Error('fixture')
    value.inputs[1].columns[0].name = 'leftKey'; op.rightKeys = ['leftKey']
    expect(inspect(value).declaredDataflowValid).toBe(true)
  })
  it('validates controls and explicit write destinations but does not execute their rules', () => {
    const value = recipe()
    value.controls = [{ kind: 'balance', input: 'selected', debit: 'amount', credit: 'amount', tolerance: '0.00', severity: 'blocking' }]
    expect(inspect(value).declaredDataflowValid).toBe(true)
    value.inputs[0].columns[0].type = 'boolean'
    expect(codes(value)).toContain('type_mismatch')
    value.writes[0].columns.push({ source: 'amount', targetColumn: 1 })
    expect(codes(value)).toContain('write_column_duplicate')
  })
  it('keeps validating after the type summary is truncated', () => {
    const value = recipe(); value.inputs[0].columns = Array.from({ length: 256 }, (_, i) => ({ name: `c${i}`, type: 'decimal', nullable: false }))
    const columns = value.inputs[0].columns.map((c) => c.name)
    operations(value, [
      { op: 'select', input: 'source', output: 'first', columns },
      { op: 'select', input: 'first', output: 'selected', columns },
    ], 'selected', 'c0')
    expect(inspect(value)).toMatchObject({ declaredDataflowValid: true, columnTypesTruncated: true, diagnosticsTruncated: false })
    value.operations.push({ op: 'select', input: 'selected', output: 'later', columns: ['absent'] })
    const result = inspect(value)
    expect(result.declaredDataflowValid).toBe(false)
    expect(result.diagnostics).toContainEqual({ code: 'column_missing', operationIndex: 2 })
    expect(result.columnTypes).toHaveLength(512)
  })
  it('refuses the global propagation budget rather than constructing an unbounded chain', () => {
    const value = recipe(); value.inputs[0].columns = Array.from({ length: 256 }, (_, i) => ({ name: `c${i}`, type: 'decimal', nullable: false }))
    const columns = value.inputs[0].columns.map((c) => c.name)
    operations(value, Array.from({ length: 200 }, (_, i) => ({ op: 'select', input: i ? `t${i-1}` : 'source', output: `t${i}`, columns })), 't199', 'c0')
    const result = inspect(value)
    expect(result.declaredDataflowValid).toBe(false)
    expect(result.diagnostics.map((d) => d.code)).toContain('analysis_budget_exceeded')
    expect(result.columnTypes.length).toBeLessThanOrEqual(512)
  })
  it('bounds diagnostics independently and never returns caller names or values', () => {
    const value = recipe(); value.inputs[0].columns = Array.from({ length: 256 }, () => ({ name: 'private_column_canary', type: 'decimal', nullable: false }))
    const result = inspect(value)
    expect(result).toMatchObject({ declaredDataflowValid: false, diagnosticsTruncated: true })
    expect(result.diagnostics).toHaveLength(128)
    expect(JSON.stringify(result)).not.toContain('private_column_canary')
    expect(JSON.stringify(result)).not.toContain(value.procedureId)
  })
  it('does not retain mutable caller objects or share returned summaries between calls', () => {
    const value = recipe(); const first = inspect(value)
    const before = structuredClone(first)
    value.inputs[0].columns[0].type = 'boolean'
    expect(first).toEqual(before)
    first.columnTypes.splice(0); first.diagnostics.push({ code: 'table_missing' })
    expect(inspect(recipe())).toEqual(before)
  })
  it('refuses the unsupported primitive profile before any propagation', () => {
    const value = recipe()
    operations(value, [{ op: 'derive', input: 'source', output: 'bad', column: 'x', expression: { kind: 'condition', when: { kind: 'comparison', operator: 'eq', left: col('amount'), right: decimal }, then: decimal, otherwise: decimal } }, { op: 'select', input: 'bad', output: 'selected', columns: ['amount'] }])
    expect(codes(value)).toContain('primitive_profile_unsupported')
    expect(inspect(value).columnTypes).toEqual([])
  })
  it('rejects non-JSON, accessors and oversized input without invoking user code', () => {
    let calls = 0
    const value = { get procedureId() { calls++; return 'never' } }
    for (const invalid of [value, undefined, new Date(), { data: 'x'.repeat(512 * 1024) }]) {
      expect(inspect(invalid)).toMatchObject({ schemaValid: false, declaredDataflowValid: false })
    }
    expect(calls).toBe(0)
  })
})

describe('primitive profile composition', () => {
  it('does not infer matched-only join nullability for report mode', () => {
    const value = joinRecipe(); const op = value.operations[0]
    if (op.op !== 'join') throw new Error('fixture')
    op.onUnmatched = 'report'
    expect(inspect(value)).toMatchObject({ schemaValid: true, declaredDataflowValid: false, columnTypes: [] })
    expect(codes(value)).toContain('primitive_profile_unsupported')
  })
  it('does not relabel an unsupported decimal or file profile as dataflow compatible', () => {
    const value = recipe(); value.decimalPolicy.precision = 38
    expect(inspect(value).declaredDataflowValid).toBe(false)
    value.decimalPolicy.precision = 18; value.inputs[0].format = 'csv'
    expect(inspect(value).declaredDataflowValid).toBe(false)
  })
})

describe('conservative type and identifier boundaries', () => {
  it.each(['null', 'reject'] as const)('retains count nullability under the declared %s policy', (allNull) => {
    const value = recipe()
    operations(value, [
      { op: 'aggregate', input: 'source', output: 'counted', groupBy: [], values: [{ column: 'amount', as: 'n', function: 'count', allNull }] },
      { op: 'cast', input: 'counted', output: 'selected', column: 'n', type: 'decimal', onInvalid: 'reject' },
    ], 'selected', 'n')
    const result = inspect(value)
    expect(result.declaredDataflowValid).toBe(true)
    expect(result.columnTypes).toContainEqual({ operationIndex: 0, columnIndex: 0, type: 'integer', nullable: allNull === 'null' })
    expect(result.columnTypes).toContainEqual({ operationIndex: 1, columnIndex: 0, type: 'decimal', nullable: allNull === 'null' })
  })
  it('keeps the canonical ban on table IDs beginning with underscore', () => {
    const value = recipe(); value.inputs[0].role = '__proto__'
    expect(inspect(value)).toMatchObject({ schemaValid: false, declaredDataflowValid: false })
  })
  it('permits explicit column replacement in a new table while preserving the source', () => {
    const value = recipe()
    operations(value, [
      { op: 'derive', input: 'source', output: 'changed', column: 'amount', expression: { kind: 'literal', value: { kind: 'boolean', value: false } } },
      { op: 'select', input: 'source', output: 'selected', columns: ['amount'] },
    ])
    const result = inspect(value)
    expect(result.declaredDataflowValid).toBe(true)
    expect(result.columnTypes).toContainEqual({ operationIndex: 0, columnIndex: 0, type: 'boolean', nullable: false })
    expect(result.columnTypes).toContainEqual({ operationIndex: 1, columnIndex: 0, type: 'decimal', nullable: true })
  })
  it('rejects a standalone null result rather than inventing a declared column type', () => {
    const value = recipe()
    operations(value, [{ op: 'derive', input: 'source', output: 'selected', column: 'amount', expression: { kind: 'literal', value: { kind: 'null' } } }])
    expect(codes(value)).toContain('unrepresentable_result_type')
  })
  it('propagates a null comparison as nullable boolean', () => {
    const value = recipe()
    operations(value, [{ op: 'derive', input: 'source', output: 'selected', column: 'flag', expression: { kind: 'comparison', operator: 'eq', left: col('amount'), right: { kind: 'literal', value: { kind: 'null' } } } }], 'selected', 'flag')
    const result = inspect(value)
    expect(result.declaredDataflowValid).toBe(true)
    expect(result.columnTypes).toContainEqual({ operationIndex: 0, columnIndex: 1, type: 'boolean', nullable: true })
  })
  it.each(['min', 'max'] as const)('preserves declared string and boolean for %s', (fn) => {
    for (const type of ['string', 'boolean'] as const) {
      const value = recipe(); value.inputs[0].columns[0].type = type
      operations(value, [{ op: 'aggregate', input: 'source', output: 'selected', groupBy: [], values: [{ column: 'amount', as: 'amount', function: fn, allNull: 'reject' }] }])
      expect(inspect(value).columnTypes).toContainEqual({ operationIndex: 0, columnIndex: 0, type, nullable: false })
    }
  })
  it('refuses aliases colliding with grouped keys and repeated sort keys', () => {
    const value = recipe()
    operations(value, [{ op: 'aggregate', input: 'source', output: 'selected', groupBy: ['amount'], values: [{ column: 'amount', as: 'amount', function: 'sum', allNull: 'null' }] }])
    expect(codes(value)).toContain('column_duplicate')
    operations(value, [{ op: 'sort', input: 'source', output: 'selected', keys: [{ column: 'amount', direction: 'asc', nulls: 'first' }, { column: 'amount', direction: 'desc', nulls: 'last' }] }])
    expect(codes(value)).toContain('column_duplicate')
  })
})
