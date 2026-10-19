// Copyright (c) 2026 Memlia. All rights reserved.
import { type ExcelProcedure, ExcelProcedureSchema } from '@memlia/contracts'
import { stringifyBoundedJson } from '@/lib/core/utils/bounded-json'
import { inspectExcelProcedureCapabilities } from './procedure-capabilities'

type Operation = ExcelProcedure['operations'][number]
type Expression = Extract<Operation, { op: 'derive' }>['expression']
type Column = { type: 'string' | 'decimal' | 'boolean' | 'integer'; nullable: boolean }
type Table = Map<string, Column>
type Code = 'invalid_input' | 'primitive_profile_unsupported' | 'role_duplicate' |
  'column_duplicate' | 'column_missing' | 'table_missing' | 'table_redefinition' |
  'binding_missing' | 'write_column_duplicate' | 'write_type_unsupported' |
  'type_mismatch' | 'unrepresentable_result_type' | 'analysis_budget_exceeded' | 'join_keys'
type Location = { inputIndex?: number; operationIndex?: number; writeIndex?: number; controlIndex?: number }
type Diagnostic = Location & { code: Code }
type Summary = Location & Column & { columnIndex: number }
const MAX_BYTES = 512 * 1024
const MAX_DIAGNOSTICS = 128
const MAX_SUMMARY = 512
const MAX_WORK = 25_000

/** Declared types only: never reads a workbook or grants execution authority. */
export function validateExcelProcedureDataflow(input: unknown) {
  const result = {
    schemaValid: false, declaredDataflowValid: false, executionAvailable: false as const,
    diagnostics: [] as Diagnostic[], diagnosticsTruncated: false,
    columnTypes: [] as Summary[], columnTypesTruncated: false,
    notVerified: ['input_data_and_runtime_limits', 'procedure_controls', 'bindings_and_authority',
      'artifact_and_procedure_digests', 'workflow_revision_and_deployment',
      'write_scopes_and_protected_cells', 'snapshot_backup_and_approval',
      'patch_application_and_readback', 'publication_and_idempotence',
      'idempotence_business_key_scope', 'isolated_runner_and_timeout'],
  }
  let invalid = false
  const fail = (code: Code, location: Location = {}) => {
    invalid = true
    if (result.diagnostics.length < MAX_DIAGNOSTICS) result.diagnostics.push({ code, ...location })
    else result.diagnosticsTruncated = true
  }
  const captured = stringifyBoundedJson(input, MAX_BYTES, { strict: true })
  if (captured === undefined) { fail('invalid_input'); return result }
  const parsed = ExcelProcedureSchema.safeParse(JSON.parse(captured))
  if (!parsed.success) { fail('invalid_input'); return result }
  result.schemaValid = true
  const procedure = parsed.data
  const capabilities = inspectExcelProcedureCapabilities(procedure)
  if (!capabilities.schemaValid || !capabilities.primitiveOptionsCompatible) {
    fail('primitive_profile_unsupported'); return result
  }
  let work = 0
  let exhausted = false
  const spend = (amount: number, location: Location) => {
    if (exhausted) return false
    work += amount
    if (work <= MAX_WORK) return true
    exhausted = true; fail('analysis_budget_exceeded', location); return false
  }
  const tables = new Map<string, Table>()
  const roles = new Set<string>()
  const bindings = new Set([...procedure.inputs, ...procedure.outputs].map((io) => io.bindingId))
  const summarize = (table: Table, location: Location) => {
    let columnIndex = 0
    for (const column of table.values()) {
      if (result.columnTypes.length < MAX_SUMMARY)
        result.columnTypes.push({ ...location, columnIndex, ...column })
      else result.columnTypesTruncated = true
      columnIndex++
    }
  }
  // Each scope records its own failures even when diagnostics have already reached their cap.
  let failures = 0
  const reject = (code: Code, location: Location) => { failures++; fail(code, location) }
  const requireColumns = (table: Table, names: string[], location: Location) => {
    const seen = new Set<string>()
    for (const name of names) {
      if (seen.has(name)) reject('column_duplicate', location)
      seen.add(name)
      if (!table.has(name)) reject('column_missing', location)
    }
  }
  procedure.inputs.forEach((source, inputIndex) => {
    const location = { inputIndex }; const before = failures
    if (!spend(source.columns.length, location)) return
    if (roles.has(source.role)) reject('role_duplicate', location)
    roles.add(source.role)
    const table: Table = new Map()
    for (const column of source.columns) {
      if (table.has(column.name)) reject('column_duplicate', location)
      if (column.type === 'date') { reject('type_mismatch', location); continue }
      table.set(column.name, { type: column.type, nullable: column.nullable })
    }
    requireColumns(table, source.keyColumns, location)
    if (failures === before) { tables.set(source.role, table); summarize(table, location) }
  })
  procedure.outputs.forEach((output) => {
    if (roles.has(output.role)) reject('role_duplicate', {})
    roles.add(output.role)
  })
  const readTable = (name: string, location: Location) => {
    const table = tables.get(name)
    if (!table) reject('table_missing', location)
    return table
  }
  // Null is an operand with no invented declared column type.
  type OperandType = Column | { type: 'null'; nullable: true }
  const operand = (value: Extract<Expression, { kind: 'col' | 'literal' }>, table: Table,
    location: Location): OperandType | undefined => {
    if (value.kind === 'col') {
      const column = table.get(value.name)
      if (!column) reject('column_missing', location)
      return column
    }
    if (value.value.kind === 'date') { reject('type_mismatch', location); return }
    if (value.value.kind === 'null') return { type: 'null', nullable: true }
    return { type: value.value.kind, nullable: false }
  }
  const expression = (value: Expression, table: Table, location: Location): OperandType | undefined => {
    if (value.kind === 'col' || value.kind === 'literal') return operand(value, table, location)
    if (value.kind === 'condition') { reject('primitive_profile_unsupported', location); return }
    const left = operand(value.left, table, location)
    const right = operand(value.right, table, location)
    if (!left || !right) return
    const nullable = left.nullable || right.nullable
    if (value.kind === 'arithmetic') {
      if (left.type !== 'decimal' || right.type !== 'decimal') { reject('type_mismatch', location); return }
      return { type: 'decimal', nullable }
    }
    if (left.type !== right.type && left.type !== 'null' && right.type !== 'null') {
      reject('type_mismatch', location); return
    }
    return { type: 'boolean', nullable }
  }
  for (const [operationIndex, operation] of procedure.operations.entries()) {
    const location = { operationIndex }; const before = failures
    if (!spend(1, location)) break
    const source = readTable(operation.input, location)
    if (tables.has(operation.output)) reject('table_redefinition', location)
    if (!source || failures !== before) continue
    if (!spend(source.size, location)) break
    let output: Table = new Map(source)
    switch (operation.op) {
      case 'select':
        requireColumns(source, operation.columns, location)
        output = new Map()
        for (const name of operation.columns) {
          const column = source.get(name)
          if (column) output.set(name, column)
        }
        break
      case 'sort':
        requireColumns(source, operation.keys.map((key) => key.column), location)
        break
      case 'cast': {
        requireColumns(source, [operation.column], location)
        const column = source.get(operation.column)
        if (column?.type === 'boolean') reject('type_mismatch', location)
        else if (column) output.set(operation.column, { type: 'decimal', nullable: column.nullable })
        break
      }
      case 'derive': {
        const column = expression(operation.expression, source, location)
        if (column?.type === 'null') reject('unrepresentable_result_type', location)
        else if (column) output.set(operation.column, { ...column })
        break
      }
      case 'filter':
        expression(operation.predicate, source, location)
        break
      case 'aggregate': {
        requireColumns(source, operation.groupBy, location)
        output = new Map()
        for (const key of operation.groupBy) {
          const column = source.get(key)
          if (column) output.set(key, column)
        }
        for (const spec of operation.values) {
          const column = source.get(spec.column)
          if (!column) { reject('column_missing', location); continue }
          if (output.has(spec.as)) reject('column_duplicate', location)
          if (spec.function === 'sum' && column.type !== 'decimal') reject('type_mismatch', location)
          if (spec.function === 'mean') { reject('primitive_profile_unsupported', location); continue }
          output.set(spec.as, { type: spec.function === 'count' ? 'integer' : column.type,
            nullable: spec.allNull === 'null' })
        }
        break
      }
      case 'join': {
        const right = readTable(operation.rightInput, location)
        if (!right) break
        if (!spend(right.size, location)) break
        requireColumns(source, operation.leftKeys, location)
        requireColumns(right, operation.rightKeys, location)
        if (operation.leftKeys.length !== operation.rightKeys.length) reject('join_keys', location)
        const shared = new Set<string>()
        operation.leftKeys.forEach((key, index) => {
          const rightKey = operation.rightKeys[index]
          if (key === rightKey) shared.add(key)
          const l = source.get(key); const r = right.get(rightKey)
          if (l && r && l.type !== r.type) reject('type_mismatch', location)
        })
        const removed = new Set(operation.rightKeys)
        for (const [name, column] of right) {
          if (source.has(name) && !shared.has(name)) reject('column_duplicate', location)
          if (!removed.has(name)) output.set(name, column)
        }
        break
      }
      default:
        reject('primitive_profile_unsupported', location)
    }
    if (exhausted) break
    if (failures === before) { tables.set(operation.output, output); summarize(output, location) }
  }
  if (!exhausted) {
    procedure.writes.forEach((write, writeIndex) => {
      const location = { writeIndex }; const table = readTable(write.input, location)
      if (!bindings.has(write.destinationBindingId)) reject('binding_missing', location)
      if (!spend(write.columns.length, location) || !table) return
      const targets = new Set<number>()
      for (const item of write.columns) {
        if (targets.has(item.targetColumn)) reject('write_column_duplicate', location)
        targets.add(item.targetColumn)
        const column = table.get(item.source)
        if (!column) reject('column_missing', location)
        else if (column.type === 'integer') reject('write_type_unsupported', location)
      }
    })
    procedure.controls.forEach((control, controlIndex) => {
      const location = { controlIndex }; const table = readTable(control.input, location)
      const names = control.kind === 'balance' ? [control.debit, control.credit] : control.columns
      if (!spend(names.length, location) || !table) return
      if (control.kind === 'balance') {
        for (const name of names) {
          const column = table.get(name)
          if (!column) reject('column_missing', location)
          else if (column.type !== 'decimal') reject('type_mismatch', location)
        }
      } else requireColumns(table, names, location)
    })
  }
  result.declaredDataflowValid = !invalid
  return result
}
