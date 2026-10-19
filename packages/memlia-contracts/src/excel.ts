// Copyright (c) 2026 Memlia. All rights reserved.
import { z } from 'zod'
import {
  ArtifactRef,
  CalendarDate,
  Digest,
  Id,
  Label,
  RefList,
  Revision,
  Scope,
  Timestamp,
  unicodeText,
} from './common.ts'

export const Decimal = z.string().regex(/^-?(?:0|[1-9][0-9]{0,37})(?:\.[0-9]{1,18})?(?![\s\S])/)
export const CellValue = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('null') }),
  z.strictObject({ kind: z.literal('decimal'), value: Decimal }),
  z.strictObject({ kind: z.literal('string'), value: unicodeText(0, 32767) }),
  z.strictObject({ kind: z.literal('boolean'), value: z.boolean() }),
  z.strictObject({ kind: z.literal('date'), value: CalendarDate }),
])
const ColumnNames = z.array(Label).min(1).max(256)
const DataType = z.enum(['string', 'decimal', 'date', 'boolean'])
const Operand = z.union([
  z.strictObject({ kind: z.literal('col'), name: Label }),
  z.strictObject({ kind: z.literal('literal'), value: CellValue }),
])
const CompareExpression = z.strictObject({
  kind: z.literal('comparison'),
  operator: z.enum(['eq', 'ne', 'lt', 'lte', 'gt', 'gte']),
  left: Operand,
  right: Operand,
})
// One bounded calculation level. Deeper trees require a qualified compiler profile.
export const Expression = z.union([
  Operand,
  CompareExpression,
  z.strictObject({
    kind: z.literal('arithmetic'),
    operator: z.enum(['add', 'subtract', 'multiply', 'divide']),
    left: Operand,
    right: Operand,
  }),
  z.strictObject({
    kind: z.literal('condition'),
    when: CompareExpression,
    then: Operand,
    otherwise: Operand,
  }),
])
const TableIO = { input: Id, output: Id }
export const TableOperation = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('select'), ...TableIO, columns: ColumnNames }),
  z.strictObject({
    op: z.literal('cast'),
    ...TableIO,
    column: Label,
    type: DataType,
    onInvalid: z.enum(['reject', 'null']),
  }),
  z.strictObject({
    op: z.literal('map'),
    ...TableIO,
    column: Label,
    mapping: ArtifactRef,
    onUnmatched: z.enum(['reject', 'preserve', 'null']),
  }),
  z.strictObject({
    op: z.literal('join'),
    ...TableIO,
    rightInput: Id,
    leftKeys: ColumnNames,
    rightKeys: ColumnNames,
    how: z.enum(['inner', 'left', 'full']),
    cardinality: z.enum(['one_to_one', 'many_to_one', 'one_to_many']),
    onUnmatched: z.enum(['reject', 'report']),
  }),
  z.strictObject({
    op: z.literal('aggregate'),
    ...TableIO,
    groupBy: z.array(Label).max(256),
    values: z
      .array(
        z.strictObject({
          column: Label,
          as: Label,
          function: z.enum(['sum', 'min', 'max', 'count', 'mean']),
          allNull: z.enum(['null', 'reject']),
        }),
      )
      .min(1)
      .max(256),
  }),
  z.strictObject({
    op: z.literal('pivot'),
    ...TableIO,
    index: ColumnNames,
    on: Label,
    value: Label,
    function: z.enum(['sum', 'min', 'max', 'count']),
    allNull: z.enum(['null', 'reject']),
  }),
  z.strictObject({
    op: z.literal('melt'),
    ...TableIO,
    index: ColumnNames,
    values: ColumnNames,
    variableName: Label,
    valueName: Label,
  }),
  z.strictObject({
    op: z.literal('sort'),
    ...TableIO,
    keys: z
      .array(
        z.strictObject({
          column: Label,
          direction: z.enum(['asc', 'desc']),
          nulls: z.enum(['first', 'last']),
        }),
      )
      .min(1)
      .max(256),
  }),
  z.strictObject({ op: z.literal('derive'), ...TableIO, column: Label, expression: Expression }),
  z.strictObject({ op: z.literal('filter'), ...TableIO, predicate: CompareExpression }),
])
const Row = z.int().min(1).max(1048576)
const Col = z.int().min(1).max(16384)
export const Range = z.strictObject({
  sheetId: Id,
  startRow: Row,
  endRow: Row,
  startColumn: Col,
  endColumn: Col,
})
const Ranges = z.array(Range).max(256)
const CellRef = z.strictObject({ sheetId: Id, row: Row, column: Col })
const FormulaFunction = z.enum(['SUM', 'ROUND', 'IF', 'MIN', 'MAX', 'COUNT'])
// Formula intent is distinct from imported strings; no arbitrary formula text.
export const Formula = z.strictObject({
  function: FormulaFunction,
  arguments: z
    .array(
      z.union([
        z.strictObject({ kind: z.literal('cell'), reference: CellRef }),
        z.strictObject({ kind: z.literal('range'), reference: Range }),
        z.strictObject({ kind: z.literal('literal'), value: CellValue }),
      ]),
    )
    .min(1)
    .max(256),
})
const Image = z.strictObject({ value: CellValue, formula: Formula.nullable(), styleHash: Digest })
const Capability = z.enum([
  'file.xlsx',
  'file.csv',
  'table.select',
  'table.cast',
  'table.map',
  'table.join',
  'table.aggregate',
  'table.pivot',
  'table.melt',
  'table.sort',
  'table.derive',
  'table.filter',
  'excel.formulas',
  'excel.recalculate',
  'excel.styles',
])
export const ExcelProcedureSchema = z.strictObject({
  schemaVersion: z.literal('memlia.excel-procedure/v1'),
  ...Scope,
  procedureId: Id,
  version: Revision.min(1),
  parentVersion: Revision.min(1).nullable(),
  workflowId: Id,
  deployedVersionId: Id,
  ownerUserId: Id,
  digest: Digest,
  policyVersion: Id,
  inputs: z
    .array(
      z.strictObject({
        role: Id,
        bindingId: Id,
        format: z.enum(['xlsx', 'csv']),
        sheetId: Id,
        columns: z
          .array(z.strictObject({ name: Label, type: DataType, nullable: z.boolean() }))
          .min(1)
          .max(256),
        keyColumns: z.array(Label).max(256),
        cardinality: z.enum(['one', 'many']),
        locale: z.enum(['fr-FR', 'en-US', 'en-GB']),
        nullPolicy: z.enum(['preserve', 'reject']),
      }),
    )
    .min(1)
    .max(32),
  mappings: RefList,
  operations: z.array(TableOperation).min(1).max(200),
  writes: z
    .array(
      z.strictObject({
        input: Id,
        destinationBindingId: Id,
        range: Range,
        columns: z
          .array(z.strictObject({ source: Label, targetColumn: Col }))
          .min(1)
          .max(256),
        mode: z.enum(['update_input', 'regenerate_owned_zone']),
      }),
    )
    .min(1)
    .max(256),
  writeScopes: Ranges.min(1),
  protectedScopes: Ranges,
  decimalPolicy: z.strictObject({
    precision: z.int().min(1).max(38),
    scale: z.int().min(0).max(18),
    rounding: z.enum(['half_even', 'half_up', 'toward_zero']),
    allNullAggregate: z.enum(['null', 'reject']),
  }),
  formulaPolicy: z.strictObject({
    externalLinks: z.literal('reject'),
    dataStrings: z.literal('literal'),
    allowedFunctions: z.array(FormulaFunction).max(6),
  }),
  controls: z
    .array(
      z.discriminatedUnion('kind', [
        z.strictObject({
          kind: z.literal('unique'),
          input: Id,
          columns: ColumnNames,
          severity: z.enum(['blocking', 'informative']),
        }),
        z.strictObject({
          kind: z.literal('balance'),
          input: Id,
          debit: Label,
          credit: Label,
          tolerance: Decimal,
          severity: z.literal('blocking'),
        }),
        z.strictObject({
          kind: z.literal('not_null'),
          input: Id,
          columns: ColumnNames,
          severity: z.enum(['blocking', 'informative']),
        }),
      ]),
    )
    .min(1)
    .max(256),
  requiredCapabilities: z.array(Capability).min(1).max(32),
  limits: z.strictObject({
    maxRows: z.int().min(1).max(1048576),
    maxCells: z.int().min(1).max(2000000),
    timeoutSeconds: z.int().min(1).max(600),
  }),
  idempotence: z.strictObject({
    mode: z.enum(['update_input', 'regenerate_owned_zone']),
    businessKeyColumns: ColumnNames,
  }),
  outputs: z
    .array(
      z.discriminatedUnion('format', [
        z.strictObject({ role: Id, bindingId: Id, format: z.literal('xlsx') }),
        z.strictObject({
          role: Id,
          bindingId: Id,
          format: z.literal('csv'),
          encoding: z.enum(['utf-8', 'utf-8-bom']),
          delimiter: z.enum([',', ';', '\t']),
          formulaInjection: z.literal('escape'),
        }),
      ]),
    )
    .min(1)
    .max(32),
})
export const SnapshotSchema = z.strictObject({
  schemaVersion: z.literal('memlia.snapshot/v1'),
  ...Scope,
  snapshotId: Id,
  workbookId: Id,
  workbookVersion: Id,
  source: ArtifactRef,
  digest: Digest,
  capturedAt: Timestamp,
  accessMode: z.enum(['owned_copy', 'qualified_single_user', 'read_only']),
  readSet: Ranges.min(1),
  writeSet: Ranges,
  cells: z.array(CellRef.extend(Image.shape)).max(2000000),
  objectsDigest: Digest,
})
const MutationPatchSet = z.strictObject({
  schemaVersion: z.literal('memlia.patch-set/v1'),
  ...Scope,
  patchId: Id,
  procedureId: Id,
  procedureVersion: Revision.min(1),
  procedureDigest: Digest,
  snapshotId: Id,
  snapshotDigest: Digest,
  workbookId: Id,
  expectedWorkbookVersion: Id,
  digest: Digest,
  writeScopes: Ranges.min(1),
  mutations: z
    .array(
      CellRef.extend({
        mutationId: Id,
        kind: z.literal('set_cell'),
        before: Image,
        after: Image,
        ruleId: Id,
      }),
    )
    .min(1)
    .max(100000),
  calculation: z.enum(['not_required', 'excel_required']),
  anomalies: z
    .array(
      z.strictObject({
        code: Id,
        severity: z.enum(['blocking', 'informative']),
        resourceIds: z.array(Id).max(256),
      }),
    )
    .max(10000),
  postconditions: z
    .array(z.strictObject({ controlId: Id, expectedDigest: Digest }))
    .min(1)
    .max(256),
})
// An empty observation is explicit, not an accidentally empty mutation plan.
export const PatchSetSchema = z.union([
  MutationPatchSet,
  MutationPatchSet.extend({
    kind: z.literal('no_changes'),
    writeScopes: Ranges.max(0),
    mutations: z.array(z.never()).max(0),
    calculation: z.literal('not_required'),
  }),
])
const Backup = ArtifactRef.extend({
  snapshotDigest: Digest,
  persistedAt: Timestamp,
  verifiedAt: Timestamp,
})
export const CommitReceiptSchema = z.strictObject({
  schemaVersion: z.literal('memlia.commit-receipt/v1'),
  ...Scope,
  runId: Id,
  patchId: Id,
  patchDigest: Digest,
  snapshotDigest: Digest,
  recordedAt: Timestamp,
  outcome: z.discriminatedUnion('status', [
    z.strictObject({
      status: z.literal('no_changes_verified'),
      effect: z.literal('none'),
      procedureId: Id,
      procedureVersion: Revision.min(1),
      procedureDigest: Digest,
      snapshotId: Id,
      workbookId: Id,
      workbookVersion: Id,
      appliedMutationIds: z.array(Id).max(0),
      readback: ArtifactRef,
      postconditionEvidence: RefList.min(1),
    }),
    z.strictObject({
      status: z.literal('succeeded_verified'),
      backup: Backup,
      appliedMutationIds: z.array(Id).min(1).max(100000),
      calculation: z.enum(['not_required', 'verified']),
      saved: ArtifactRef,
      readback: ArtifactRef,
      postconditionEvidence: RefList.min(1),
      publishedManifest: ArtifactRef,
    }),
    z.strictObject({
      status: z.enum(['partial', 'uncertain']),
      backup: Backup,
      appliedMutationIds: z.array(Id).max(100000),
      evidence: RefList,
      reconciliationRequired: z.literal(true),
    }),
    z.strictObject({
      status: z.literal('written_unverified'),
      backup: Backup,
      appliedMutationIds: z.array(Id).min(1).max(100000),
      calculation: z.enum(['not_calculated', 'unverified']),
      saved: ArtifactRef,
      evidence: RefList,
    }),
    z.strictObject({
      status: z.enum([
        'rejected',
        'quarantined',
        'failed_without_effect',
        'cancelled_without_effect',
      ]),
      reasonCode: Id,
      effect: z.literal('none'),
    }),
  ]),
})
export type ExcelProcedure = z.infer<typeof ExcelProcedureSchema>
export type Snapshot = z.infer<typeof SnapshotSchema>
export type PatchSet = z.infer<typeof PatchSetSchema>
export type CommitReceipt = z.infer<typeof CommitReceiptSchema>
