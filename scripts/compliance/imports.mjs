// Copyright 2026 Memlia. All rights reserved.
import { createRequire } from 'node:module'
import path from 'node:path'
import fs from 'node:fs'
import readline from 'node:readline'

const require = createRequire(import.meta.url)
const ts = require('@typescript/typescript6')
if (!['6.0.2', '6.0.3'].includes(ts.version)) throw new Error(`Unreviewed TypeScript parser version: ${ts.version}`)
let root
const configCache = new Map()

// Literal folding is deliberately limited: unknown module expressions block publication.
function literal(node) {
  if (!node) return undefined
  if (ts.isStringLiteralLike(node)) return node.text
  if (ts.isParenthesizedExpression(node)) return literal(node.expression)
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = literal(node.left), right = literal(node.right)
    if (left !== undefined && right !== undefined) return left + right
  }
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text
    for (const span of node.templateSpans) {
      const part = literal(span.expression)
      if (part === undefined) return undefined
      value += part + span.literal.text
    }
    return value
  }
}
// This workspace package is committed with Sim. Resolve its exported JSON from
// the inspected tree (also historical snapshots), never an ambient installation.
function localConfigExtends(value) {
  if (Array.isArray(value)) return value.map(localConfigExtends)
  const prefix = '@sim/tsconfig/'
  if (typeof value !== 'string' || !value.startsWith(prefix)) return value
  const directory = path.join(root, 'packages/tsconfig')
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
  const target = manifest.exports?.['./' + value.slice(prefix.length)]
  if (manifest.name !== '@sim/tsconfig' || typeof target !== 'string' || !target.startsWith('./')) {
    throw new Error('Invalid workspace configuration export')
  }
  const resolved = path.resolve(directory, target)
  if (!resolved.startsWith(directory + path.sep) || !resolved.endsWith('.json') || !fs.statSync(resolved).isFile()) {
    throw new Error('Invalid workspace configuration target')
  }
  return resolved
}
function configFor(file) {
  let dir = path.dirname(path.join(root, file))
  while (dir === root || dir.startsWith(root + path.sep)) {
    const config = path.join(dir, 'tsconfig.json')
    if (fs.existsSync(config)) {
      if (!configCache.has(config)) {
        const result = ts.readConfigFile(config, ts.sys.readFile)
        if (result.error) throw new Error(`Cannot parse ${config}`)
        const configValue = { ...result.config }
        if (configValue.extends !== undefined) configValue.extends = localConfigExtends(configValue.extends)
        const parsed = ts.parseJsonConfigFileContent(configValue, ts.sys, dir)
        // No-input diagnostics are expected for synthetic/historical trees; invalid options are not.
        if (parsed.errors.some(e => ![18002, 18003].includes(e.code))) throw new Error(`Invalid ${config}`)
        configCache.set(config, parsed.options)
      }
      return configCache.get(config)
    }
    if (dir === root) break
    dir = path.dirname(dir)
  }
  return {}
}
function forbidden(specifier, file, options) {
  const clean = specifier.replaceAll('\\', '/').split(/[?#]/)[0]
  const targets = [clean]
  if (clean.startsWith('.')) targets.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), clean)))
  if (clean.startsWith('@/')) targets.push('apps/sim/' + clean.slice(2))
  for (const [alias, replacements] of Object.entries(options.paths || {})) {
    const star = alias.indexOf('*')
    const match = star < 0 ? clean === alias : clean.startsWith(alias.slice(0, star)) && clean.endsWith(alias.slice(star + 1))
    if (!match) continue
    const capture = star < 0 ? '' : clean.slice(star, clean.length - (alias.length - star - 1))
    for (const replacement of replacements) targets.push(path.resolve(options.baseUrl || options.pathsBasePath || root, replacement.replace('*', capture)).replaceAll('\\', '/'))
  }
  const resolved = ts.resolveModuleName(specifier, path.join(root, file), options, ts.sys).resolvedModule
  if (resolved) targets.push(resolved.resolvedFileName.replaceAll('\\', '/'))
  return targets.some(target => /(?:^|\/)ee(?:\/|$)/i.test(target))
}
function inspectEntry(entry) {
  if (!entry || typeof entry.path !== 'string' || typeof entry.content !== 'string') {
    throw new Error('Invalid module frame')
  }
  const issues = []
  const file = ts.createSourceFile(entry.path, entry.content, ts.ScriptTarget.Latest, true)
  const add = (rule, node) => issues.push({ path: entry.path, rule, line: file.getLineAndCharacterOfPosition(node?.getStart(file) || 0).line + 1 })
  if (file.parseDiagnostics.length) { add('parse-error'); return issues }
  const options = configFor(entry.path)
  const check = node => {
    const specifier = literal(node)
    if (specifier === undefined) add('unresolved-module-expression', node)
    else if (forbidden(specifier, entry.path, options)) add('enterprise-import', node)
  }
  const visit = node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) check(node.moduleSpecifier)
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) check(node.moduleReference.expression)
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) check(node.argument.literal)
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require') || (ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText(file) === 'require' && node.expression.name.text === 'resolve'))) check(node.arguments[0])
    ts.forEachChild(node, visit)
  }
  visit(file)
  return issues
}

async function stream() {
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
  const iterator = lines[Symbol.asyncIterator]()
  const read = async () => {
    const next = await iterator.next()
    if (next.done) throw new Error('Incomplete module stream')
    return JSON.parse(next.value)
  }
  const emit = value => new Promise((resolve, reject) => {
    process.stdout.write(JSON.stringify(value) + '\n', error => error ? reject(error) : resolve())
  })
  try {
    const header = await read()
    if (!header || header.protocol !== 'memlia-imports-v1' || typeof header.root !== 'string' ||
        !Number.isSafeInteger(header.count) || header.count < 0) throw new Error('Invalid stream header')
    root = path.resolve(header.root)
    for (let index = 0; index < header.count; index++) {
      const frame = await read()
      if (!frame || frame.index !== index || Object.keys(frame).length !== 2) {
        throw new Error('Invalid module sequence')
      }
      await emit({ index, issues: inspectEntry(frame.entry) })
    }
    const end = await read()
    if (!end || end.end !== header.count || Object.keys(end).length !== 1 ||
        !(await iterator.next()).done) throw new Error('Invalid stream end')
    await emit({ end: header.count })
  } finally {
    lines.close()
  }
}

if (process.argv[2] === '--stream') {
  try { await stream() } catch {
    process.stderr.write('Invalid or incomplete module stream\n')
    process.exitCode = 1
  }
} else {
  // Keep the original JSON interface for callers and equivalence checks.
  const input = JSON.parse(fs.readFileSync(0, 'utf8'))
  root = path.resolve(input.root)
  const issues = []
  for (const entry of input.entries) {
    for (const issue of inspectEntry(entry)) issues.push(issue)
  }
  process.stdout.write(JSON.stringify(issues))
}
