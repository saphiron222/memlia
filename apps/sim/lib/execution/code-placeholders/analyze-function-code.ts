// Copyright (c) 2026 Memlia. All rights reserved.

import path from 'node:path'
import { findWorkflowReferenceTokens } from '@sim/utils/workflow-references'
import ts from '@typescript/typescript6'
import { FUNCTION_GLOBALS } from '@/lib/execution/function-context'
import { parseReferencePath } from '@/executor/constants'
import { collectCodePlaceholderOccurrences } from './shared'

export const FUNCTION_ANALYSIS_LIMITS = Object.freeze({
  sourceBytes: 64 * 1024,
  nodes: 12000,
  diagnostics: 32,
  milliseconds: 2000,
})
type UnavailableReason =
  | 'context'
  | 'source_limit'
  | 'node_limit'
  | 'diagnostic_limit'
  | 'syntax'
  | 'deadline'
  | 'analysis'
  | 'standard_library'
export type FunctionCodeAnalysis =
  | {
      status: 'analyzed'
      diagnostics: {
        code: 'unbound_identifier' | 'unprovided_workflow_parameter'
        line: number
        column: number
      }[]
    }
  | { status: 'unavailable'; reason: UnavailableReason }
const unavailable = (reason: UnavailableReason): FunctionCodeAnalysis => ({
  status: 'unavailable',
  reason,
})
const prefix = '(async function () {\n'
const filename = '/memlia-function.js'
const globalsFile = '/memlia-function-globals.d.ts'
const options: ts.CompilerOptions = {
  allowJs: true,
  checkJs: true,
  noEmit: true,
  types: [],
  skipLibCheck: true,
  target: ts.ScriptTarget.ES2023,
  lib: ['lib.es2023.d.ts'],
}
const libraryDirectory = path.dirname(ts.getDefaultLibFilePath(options))

/** Diagnostics only: no execution, module resolution, secret resolution or graph mutation.
 * TypeScript's binder supplies lexical scopes; its ECMAScript libraries supply standard
 * globals (no DOM/Node ambient types). This is not a sandbox or a proof of valid code:
 * dynamic property access, runtime values and native reference validity remain outside it.
 * Source/node bounds also bound synchronous parsing, which cannot be preempted mid-call.
 */
export function analyzeFunctionCode(
  code: unknown,
  language: unknown = 'javascript',
  deadline = performance.now() + FUNCTION_ANALYSIS_LIMITS.milliseconds,
  caller: 'unspecified' | 'workflow' = 'unspecified'
): FunctionCodeAnalysis {
  if (language !== 'javascript' || typeof code !== 'string') return unavailable('context')
  if (Buffer.byteLength(code, 'utf8') > FUNCTION_ANALYSIS_LIMITS.sourceBytes)
    return unavailable('source_limit')
  const expired = () => performance.now() >= deadline
  if (expired()) return unavailable('deadline')
  try {
    // Both scanners are native. Preserve offsets/newlines, masking values rather than
    // manufacturing named declarations that could hide an actual unbound identifier.
    const references = findWorkflowReferenceTokens(code)
    // The native resolver may turn a file .path reference into a sandbox mount.
    // Its value is unavailable during preview: do not assume the isolated VM.
    if (
      references.some((reference) => {
        if (reference.kind !== 'workflow') return false
        const parts = parseReferencePath(reference.value)
        return parts.length >= 3 && parts.at(-1) === 'path'
      })
    )
      return unavailable('context')
    const ranges = [...references, ...collectCodePlaceholderOccurrences(code)].sort(
      (a, b) => a.start - b.start
    )
    let cursor = 0
    const parts: string[] = []
    for (const range of ranges) {
      if (range.start < cursor) continue
      if (expired()) return unavailable('deadline')
      parts.push(
        code.slice(cursor, range.start),
        `0${code.slice(range.start + 1, range.end).replace(/[^\r\n]/g, ' ')}`
      )
      cursor = range.end
    }
    parts.push(code.slice(cursor))
    const masked = parts.join('')
    const scanner = ts.createScanner(options.target!, false, ts.LanguageVariant.Standard, masked)
    for (
      let token = scanner.scan();
      token !== ts.SyntaxKind.EndOfFileToken;
      token = scanner.scan()
    ) {
      if (expired()) return unavailable('deadline')
      if (
        (token === ts.SyntaxKind.SingleLineCommentTrivia ||
          token === ts.SyntaxKind.MultiLineCommentTrivia) &&
        /@ts-(?:no)?check|@ts-ignore|@ts-expect-error/.test(scanner.getTokenText())
      )
        return unavailable('context')
    }
    const source = ts.createSourceFile(
      filename,
      `${prefix}${masked}\n});`,
      options.target!,
      true,
      ts.ScriptKind.JS
    )
    let nodes = 0
    let unsupported = false
    const visit = (node: ts.Node): void => {
      if (++nodes > FUNCTION_ANALYSIS_LIMITS.nodes || expired()) return
      if (
        ts.isImportDeclaration(node) ||
        ts.isExportDeclaration(node) ||
        ts.isWithStatement(node) ||
        (ts.isCallExpression(node) &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) &&
              // Match extractJavaScriptImports: require calls select remote even when shadowed.
              ['require', 'eval', 'Function'].includes(node.expression.text)))) ||
        (ts.isNewExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'Function')
      )
        unsupported = true
      ts.forEachChild(node, visit)
    }
    visit(source)
    if (expired()) return unavailable('deadline')
    if (nodes > FUNCTION_ANALYSIS_LIMITS.nodes) return unavailable('node_limit')
    if (unsupported) return unavailable('context')
    const globals = ts.createSourceFile(
      globalsFile,
      FUNCTION_GLOBALS.map(
        (name) =>
          // Workflow Function's native tool body omits params; execute-request adds
          // only _context: undefined. Other HTTP callers are intentionally unspecified.
          `declare const ${name}: ${caller === 'workflow' && name === 'params' ? '{ readonly _context: undefined }' : 'any'};`
      ).join('\n'),
      options.target!,
      true
    )
    let libraryUnavailable = false
    const readSource = (name: string): ts.SourceFile | undefined => {
      if (name === filename) return source
      if (name === globalsFile) return globals
      // Only the compiler's own fixed standard libraries may touch disk. Never resolve
      // authored imports, triple-slash references, node_modules or arbitrary filenames.
      if (
        path.dirname(name) !== libraryDirectory ||
        !/^lib\.(?:es[\w.]*|decorators(?:\.legacy)?)\.d\.ts$/.test(path.basename(name))
      )
        return undefined
      const text = ts.sys.readFile(name)
      if (text === undefined) {
        libraryUnavailable = true
        return undefined
      }
      return ts.createSourceFile(name, text, options.target!, true)
    }
    const host: ts.CompilerHost = {
      getSourceFile: readSource,
      getDefaultLibFileName: () => path.join(libraryDirectory, 'lib.es2023.d.ts'),
      writeFile: () => {},
      getCurrentDirectory: () => '/',
      getDirectories: () => [],
      fileExists: (name) => readSource(name) !== undefined,
      readFile: (name) => readSource(name)?.text,
      getCanonicalFileName: (name) => name,
      useCaseSensitiveFileNames: () => true,
      getNewLine: () => '\n',
      resolveModuleNames: (names) => names.map(() => undefined),
    }
    const program = ts.createProgram([filename, globalsFile], options, host)
    const cancellation: ts.CancellationToken = {
      isCancellationRequested: expired,
      throwIfCancellationRequested: () => {
        if (expired()) throw new ts.OperationCanceledException()
      },
    }
    if (
      libraryUnavailable ||
      program.getGlobalDiagnostics(cancellation).length ||
      !program.getSourceFile(path.join(libraryDirectory, 'lib.es2023.d.ts'))
    )
      return unavailable('standard_library')
    if (program.getSyntacticDiagnostics(source, cancellation).length) return unavailable('syntax')
    const parameterReads = new Set<number>()
    if (caller === 'workflow') {
      const checker = program.getTypeChecker()
      const declaration = globals.statements
        .flatMap((statement) =>
          ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : []
        )
        .find((item) => ts.isIdentifier(item.name) && item.name.text === 'params')
      if (!declaration) return unavailable('analysis')
      const parameter = checker.getSymbolAtLocation(declaration.name)
      if (!parameter) return unavailable('analysis')
      let ambiguous = false
      let indirectContext = false
      const inspect = (node: ts.Node): void => {
        if (expired() || ambiguous) return
        // The global object and prototypes can change/alias params without a
        // lexical reference to its binding (including Object/Reflect APIs). A local
        // homonym is distinct; native global use makes this inference unavailable.
        if (
          node.kind === ts.SyntaxKind.ThisKeyword ||
          (ts.isPropertyAccessExpression(node) && ['prototype', '__proto__'].includes(node.name.text)) ||
          (ts.isElementAccessExpression(node) &&
            ts.isStringLiteral(node.argumentExpression) &&
            ['prototype', '__proto__'].includes(node.argumentExpression.text)) ||
          (ts.isIdentifier(node) &&
            ['global', 'globalThis', 'Object', 'Reflect'].includes(node.text) &&
            !checker
              .getSymbolAtLocation(node)
              ?.declarations?.some((d) => d.getSourceFile() === source))
        )
          indirectContext = true
        if (ts.isIdentifier(node) && checker.getSymbolAtLocation(node) === parameter) {
          const member = node.parent
          // Only a direct static property read has the required binding provenance.
          // Aliases, destructuring, computed access and escaping/mutating the object
          // are not treated as evidence of an absent binding.
          if (!ts.isPropertyAccessExpression(member) || member.expression !== node) {
            ambiguous = true
            return
          }
          // Include destructuring/loop assignment targets, not just `params.x =`.
          for (let target: ts.Node = member; target.parent && !expired(); target = target.parent) {
            const use = target.parent
            if (
              (ts.isBinaryExpression(use) &&
                use.left === target &&
                use.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
                use.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
              ((ts.isForInStatement(use) || ts.isForOfStatement(use)) &&
                use.initializer === target) ||
              ts.isDeleteExpression(use) ||
              ts.isPostfixUnaryExpression(use) ||
              (ts.isPrefixUnaryExpression(use) &&
                [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(
                  use.operator
                )) ||
              ((ts.isCallExpression(use) || ts.isNewExpression(use)) && use.expression === target)
            ) {
              ambiguous = true
              return
            }
            if (ts.isStatement(use)) break
          }
          parameterReads.add(member.name.getStart(source))
        }
        ts.forEachChild(node, inspect)
      }
      inspect(source)
      if (expired()) return unavailable('deadline')
      if (ambiguous || (parameterReads.size > 0 && indirectContext)) return unavailable('context')
    }
    const diagnostics = program
      .getSemanticDiagnostics(source, cancellation)
      .filter(
        (d) =>
          d.start !== undefined &&
          d.start >= prefix.length &&
          d.start < prefix.length + code.length &&
          ([2304, 2552, 2580, 2584, 2591, 2693, 18004].includes(d.code) ||
            (d.code === 2339 && parameterReads.has(d.start)))
      )
    if (expired()) return unavailable('deadline')
    if (diagnostics.length > FUNCTION_ANALYSIS_LIMITS.diagnostics)
      return unavailable('diagnostic_limit')
    return {
      status: 'analyzed',
      diagnostics: diagnostics.map((d) => {
        const location = source.getLineAndCharacterOfPosition(d.start!)
        return {
          code: d.code === 2339 ? 'unprovided_workflow_parameter' : 'unbound_identifier',
          line: location.line,
          column: location.character + 1,
        }
      }),
    }
  } catch {
    return unavailable(expired() ? 'deadline' : 'analysis')
  }
}
