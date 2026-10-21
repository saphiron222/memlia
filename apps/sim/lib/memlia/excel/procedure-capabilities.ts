// Copyright (c) 2026 Memlia. All rights reserved.
import { type ExcelProcedure, ExcelProcedureSchema } from '@memlia/contracts'
import { stringifyBoundedJson } from '@/lib/core/utils/bounded-json'

// Internal draft projection only: never a persistable procedure or authority envelope.
export const excelProcedureDraftSchema = ExcelProcedureSchema.omit({
  schemaVersion: true,
  organizationId: true,
  workspaceId: true,
  procedureId: true,
  version: true,
  parentVersion: true,
  workflowId: true,
  deployedVersionId: true,
  ownerUserId: true,
  digest: true,
  policyVersion: true,
})

type Capability = ExcelProcedure['requiredCapabilities'][number]
type Operation = ExcelProcedure['operations'][number]
type Expression = Extract<Operation, { op: 'derive' }>['expression']
type Operand = Extract<Expression, { kind: 'col' | 'literal' }>
type Diagnostic = {
  code:
    | 'decimal_profile_unsupported'
    | 'resource_limit_unsupported'
    | 'file_format_unsupported'
    | 'input_type_unsupported'
    | 'operation_options_unsupported'
    | 'required_capability_undeclared'
    | 'declared_capability_unsupported'
  operationIndex?: number
  inputIndex?: number
  outputIndex?: number
  capability?: Capability
}
const MAX_INPUT_BYTES = 512 * 1024
const MAX_DIAGNOSTICS = 128

// Fresh owned descriptions: no mutable shared profile can influence later observations.
export function describeExcelProcedureProfile() {
  return {
    id: 'memlia.excel-kernel-primitives/p00-v1' as const,
    sources: [
      {
        path: 'runtimes/excel/src/memlia_excel/tables.py',
        sha256: 'f29a26ec670af1ae313f9338af6aac022d1452bd9fdb5a81c4dd69ce2142dc2d',
      },
      {
        path: 'runtimes/excel/src/memlia_excel/xlsx.py',
        sha256: '97d87461deb9ff8a340bc010c1bb18c2abb965ad8b809bda1292c881f249e9c8',
      },
    ],
    libraries: { polars: '2.0.0', openpyxl: '3.1.5', defusedxml: '0.7.1' },
    tables: {
      maxPrecision: 18,
      maxScale: 18,
      scaleMustNotExceedPrecision: true,
      maxCells: 100000,
      floatingPoint: false,
      roundingApplied: false,
      select: 'explicit_columns',
      cast: 'decimal_reject_inexact',
      join: 'left_inner_declared_cardinality_unmatched_left_rejected_no_column_collisions',
      aggregate: 'sum_decimal_only_min_max_count_all_null_null_or_reject',
      sort: 'stable_explicit_direction_and_null_order',
      derive: 'column_literal_comparison_decimal_add_subtract_only',
      filter: 'comparison_null_predicate_excluded',
      dateLiterals: false,
    },
    xlsx: {
      csv: false,
      input: 'simple_owned_bytes_exact_headers_string_decimal_boolean',
      formulas: false,
      recalculation: false,
      stylesPreserved: false,
      output: 'new_workbook_in_memory',
      decimalOutput: 'exact_text',
      maxCellsIncludingHeaders: 100000,
      maxArchiveBytes: 10000000,
      maxArchiveParts: 512,
      objectsAndLinks: 'unqualified_parts_rejected',
    },
  }
}

function supportsCapability(capability: Capability) {
  return (
    capability === 'file.xlsx' ||
    capability === 'table.select' ||
    capability === 'table.cast' ||
    capability === 'table.join' ||
    capability === 'table.aggregate' ||
    capability === 'table.sort' ||
    capability === 'table.derive' ||
    capability === 'table.filter'
  )
}
function supportsOperand(operand: Operand) {
  return operand.kind === 'col' || operand.value.kind !== 'date'
}
function supportsExpression(expression: Expression): boolean {
  switch (expression.kind) {
    case 'col':
    case 'literal':
      return supportsOperand(expression)
    case 'comparison':
      return supportsOperand(expression.left) && supportsOperand(expression.right)
    case 'arithmetic':
      return (
        (expression.operator === 'add' || expression.operator === 'subtract') &&
        (expression.left.kind === 'col' || expression.left.value.kind === 'decimal') &&
        (expression.right.kind === 'col' || expression.right.value.kind === 'decimal')
      )
    case 'condition':
      return false
  }
}
function supportsOperation(operation: Operation): boolean {
  switch (operation.op) {
    case 'select':
    case 'sort':
      return true
    case 'cast':
      return operation.type === 'decimal' && operation.onInvalid === 'reject'
    case 'join':
      return operation.how !== 'full' && operation.onUnmatched === 'reject'
    case 'aggregate':
      return operation.values.every((value) => value.function !== 'mean')
    case 'derive':
      return supportsExpression(operation.expression)
    case 'filter':
      return supportsExpression(operation.predicate)
    case 'map':
    case 'pivot':
    case 'melt':
      return false
  }
}

/** Pure option observation; never admission, dataflow validation or execution permission. */
export function inspectExcelProcedureCapabilities(input: unknown) {
  return inspect(input, false)
}

export function inspectExcelProcedureDraftCapabilities(input: unknown) {
  return inspect(input, true)
}

function inspect(input: unknown, draft: boolean) {
  const common = {
    executionAvailable: false as const,
    analysis: 'primitive_options_only' as const,
    profile: describeExcelProcedureProfile(),
    notVerified: [
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
    ] as const,
  }
  const captured = stringifyBoundedJson(input, MAX_INPUT_BYTES, { strict: true })
  if (captured === undefined)
    return { ...common, schemaValid: false as const, code: 'invalid_input' as const }
  const parsed = (draft ? excelProcedureDraftSchema : ExcelProcedureSchema).safeParse(
    JSON.parse(captured)
  )
  if (!parsed.success)
    return { ...common, schemaValid: false as const, code: 'invalid_input' as const }
  const procedure = parsed.data
  const diagnostics: Diagnostic[] = []
  let diagnosticsTruncated = false
  const add = (diagnostic: Diagnostic) => {
    if (diagnostics.length < MAX_DIAGNOSTICS) diagnostics.push(diagnostic)
    else diagnosticsTruncated = true
  }
  const required = new Set<Capability>()
  if (
    procedure.decimalPolicy.precision > 18 ||
    procedure.decimalPolicy.scale > procedure.decimalPolicy.precision
  )
    add({ code: 'decimal_profile_unsupported' })
  if (procedure.limits.maxCells > 100000 || procedure.limits.maxRows > 100000)
    add({ code: 'resource_limit_unsupported' })
  procedure.inputs.forEach((input, inputIndex) => {
    required.add(`file.${input.format}`)
    if (input.format !== 'xlsx') add({ code: 'file_format_unsupported', inputIndex })
    if (input.columns.some((column) => column.type === 'date'))
      add({ code: 'input_type_unsupported', inputIndex })
  })
  procedure.outputs.forEach((output, outputIndex) => {
    required.add(`file.${output.format}`)
    if (output.format !== 'xlsx') add({ code: 'file_format_unsupported', outputIndex })
  })
  procedure.operations.forEach((operation, operationIndex) => {
    required.add(`table.${operation.op}`)
    if (!supportsOperation(operation))
      add({ code: 'operation_options_unsupported', operationIndex })
  })
  // formulaPolicy.allowedFunctions permits intent; it does not itself request formula execution.
  for (const capability of [...required].sort()) {
    if (!procedure.requiredCapabilities.includes(capability))
      add({ code: 'required_capability_undeclared', capability })
  }
  for (const capability of [...new Set(procedure.requiredCapabilities)].sort()) {
    if (!supportsCapability(capability))
      add({ code: 'declared_capability_unsupported', capability })
  }
  return {
    ...common,
    schemaValid: true as const,
    primitiveOptionsCompatible: diagnostics.length === 0,
    requiredCapabilities: [...required].sort(),
    diagnostics,
    diagnosticsTruncated,
  }
}
