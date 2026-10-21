// Copyright (c) 2026 Memlia. All rights reserved.
import ts from '@typescript/typescript6'
import { describe, expect, it, vi } from 'vitest'
import { CodeLanguage } from '@/lib/execution/languages'
import { analyzeFunctionCode, FUNCTION_ANALYSIS_LIMITS } from './analyze-function-code'

const clean = { status: 'analyzed', diagnostics: [] }
describe('native Function code analysis without evaluation', () => {
  it('finds the real unbound predecessor global, exposing only its position', () => {
    expect(
      analyzeFunctionCode(
        'const donnees = inputs.Donnees; const total = donnees.montants.reduce((sum,val)=>sum+val,0); return {total};'
      )
    ).toEqual({
      status: 'analyzed',
      diagnostics: [{ code: 'unbound_identifier', line: 1, column: 17 }],
    })
  })
  it.each([
    'const inputs = {Donnees: 2}; return inputs.Donnees',
    'function sum(inputs) { return inputs.Donnees }; return sum({Donnees: 2})',
    'const {inputs} = params; return inputs.Donnees',
    'let inputs; { const inputs = 2; console.log(inputs) } return inputs',
    'const sum = (inputs = {}) => inputs.Donnees; return sum(params)',
    'try { throw 1 } catch (inputs) { return inputs }',
    'return [1,2].map((value,index) => value + index)',
    'return { value: 1, method(inputs) { return inputs } }',
    'class Thing { method(inputs) { return inputs } }; return new Thing()',
    'return JSON.stringify(Array.from(new Uint8Array([1,2])))',
    'return await fetch(params.url);',
    'return <donnees.result> + {{PARAM}}',
    'return "<donnees.result>"',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: authored JavaScript is test data, never evaluated.
    'return `value: ${<donnees.result>}`',
    'const inputs = {}; return {inputs}',
  ])('accepts lexical bindings and native references: %s', (code) => {
    expect(analyzeFunctionCode(code)).toEqual(clean)
  })
  it.each([
    'function f(inputs) { return inputs } return inputs.Donnees',
    '{ const inputs = 2 } return inputs',
    'return {inputs}',
    'return process.env',
    'return setTimeout(() => 1, 0)',
    'return Buffer.from("x")',
    'const x = SECRET_CANARY; return x',
  ])('does not invent bindings: %s', (code) => {
    const result = analyzeFunctionCode(code)
    expect(result).toMatchObject({
      status: 'analyzed',
      diagnostics: [{ code: 'unbound_identifier' }],
    })
    expect(JSON.stringify(result)).not.toMatch(/inputs|process|setTimeout|Buffer|SECRET_CANARY/)
  })
  it('does not alter the conservative native secret analyzer when a binding is shadowed', async () => {
    const { compileCodePlaceholders } = await import('./index')
    // Our lexical diagnostic is separate from the existing security analysis.
    expect(
      analyzeFunctionCode('const environmentVariables = {}; return environmentVariables.SECRET')
    ).toEqual(clean)
    const compiled = await compileCodePlaceholders({
      code: 'const environmentVariables = {}; return environmentVariables.SECRET',
      language: CodeLanguage.JavaScript,
      environmentVariables: { SECRET: 'synthetic-secret' },
    })
    expect(compiled.resolvedSecretNames).toContain('SECRET')
  })
  it.each(['return (', 'const x: number = 1; return x', 'return <x'])(
    'reports ambiguous syntax unavailable',
    (code) => {
      expect(analyzeFunctionCode(code)).toMatchObject({ status: 'unavailable', reason: 'syntax' })
    }
  )
  it.each([
    'import x from "private-path"; return x',
    'return import("private-path")',
    'return eval(params.code)',
    'with(params) { return x }',
  ])('never resolves authored modules or dynamic scopes', (code) => {
    expect(analyzeFunctionCode(code)).toMatchObject({ status: 'unavailable' })
  })
  it('refuses missing standard libraries at the compiler filesystem boundary', () => {
    const read = vi.spyOn(ts.sys, 'readFile').mockReturnValue(undefined)
    try {
      expect(analyzeFunctionCode('return Math.max(1, 2) + Promise.resolve(1)')).toEqual({
        status: 'unavailable',
        reason: 'standard_library',
      })
    } finally {
      read.mockRestore()
    }
  })
  it.each([
    '// @ts-ignore\nreturn inputs.x',
    '// @ts-nocheck\nreturn inputs.x',
    '// @ts-expect-error\nreturn inputs.x',
  ])('does not allow compiler directives to manufacture a clean result', (code) => {
    expect(analyzeFunctionCode(code)).toEqual({ status: 'unavailable', reason: 'context' })
  })
  it('bounds bytes, nodes, diagnostics and deadline without returning a false clean result', () => {
    expect(analyzeFunctionCode(' '.repeat(FUNCTION_ANALYSIS_LIMITS.sourceBytes + 1))).toEqual({
      status: 'unavailable',
      reason: 'source_limit',
    })
    expect(analyzeFunctionCode('0;'.repeat(6100))).toEqual({
      status: 'unavailable',
      reason: 'node_limit',
    })
    expect(
      analyzeFunctionCode(Array.from({ length: 33 }, (_, i) => `missing${i};`).join('\n'))
    ).toEqual({ status: 'unavailable', reason: 'diagnostic_limit' })
    expect(analyzeFunctionCode('return 1', 'javascript', 0)).toEqual({
      status: 'unavailable',
      reason: 'deadline',
    })
    expect(analyzeFunctionCode('return 1', 'python')).toEqual({
      status: 'unavailable',
      reason: 'context',
    })
  })
  it('preserves original line and column after masking native placeholders', () => {
    expect(analyzeFunctionCode('const a = <donnees.result>;\nreturn missing + a')).toEqual({
      status: 'analyzed',
      diagnostics: [{ code: 'unbound_identifier', line: 2, column: 8 }],
    })
  })
})

it.each([
  'const fs = require("fs"); return process.version',
  'function require(name) { return name }; return require("fs")',
  'const file = <source.files[0].path>; return process.version',
  'return "<source.files[0].path>"',
])('does not diagnose fast-runtime globals for a remote runtime candidate: %s', (code) => {
  expect(analyzeFunctionCode(code)).toEqual({ status: 'unavailable', reason: 'context' })
})

it('retains inline file content and ordinary explicit params in the fast context', () => {
  expect(analyzeFunctionCode('return <source.files[0].base64> + params.path')).toEqual({
    status: 'analyzed',
    diagnostics: [],
  })
})

it('diagnoses the exact V6 unprovided workflow params read without publishing its property', () => {
  expect(
    analyzeFunctionCode(
      'const values = params.donnees_result; return values.a+values.b+values.c;',
      'javascript',
      undefined,
      'workflow'
    )
  ).toEqual({
    status: 'analyzed',
    diagnostics: [{ code: 'unprovided_workflow_parameter', line: 1, column: 23 }],
  })
})

describe('Workflow params binding provenance', () => {
  const workflow = (code: string) => analyzeFunctionCode(code, 'javascript', undefined, 'workflow')
  it.each([
    'const params = {value: 2}; return params.value',
    'function f(params) { return params.value }; return f({value: 2})',
    'const f = (params) => params.value; return f({value: 2})',
    'try { throw {value: 2} } catch (params) { return params.value }',
    'const values = <donnees.result>; return values.a + values.b + values.c',
    'return params._context',
    'return params.toString',
    'const environmentVariables = {}; return environmentVariables.SECRET',
  ])('preserves local declarations/native references: %s', (code) => {
    expect(workflow(code)).toEqual(clean)
  })
  it.each([
    'params.value = 2; return params.value',
    'params.value++; return params.value',
    '++params.value; return params.value',
    'delete params.value; return params.value',
    'params = {value: 2}; return params.value',
    'const alias = params; alias.value = 2; return params.value',
    'const {value} = params; return value',
    'Object.assign(params, {value: 2}); return params.value',
    'return params["value"]',
    'const name = "value"; return params[name]',
    'params.__defineGetter__("value", () => 2); return params.value',
    '({value: params.value} = {value: 2}); return params.value',
    'for (params.value of [1]) {} return params.value',
    'global.params = {value: 2}; return params.value',
    'globalThis.params.value = 2; return params.value',
    'this.params.value = 2; return params.value',
    'Object.defineProperty(Object.prototype, "value", {value: 2}); return params.value',
    'Object.getPrototypeOf({}).value = 2; return params.value',
    '({}).__proto__.value = 2; return params.value',
    'Reflect.set(Reflect.getPrototypeOf({}), "value", 2); return params.value',

  ])('does not pretend to know a mutated/aliased/computed object: %s', (code) => {
    expect(workflow(code)).toEqual({ status: 'unavailable', reason: 'context' })
  })
  it('retains separate unspecified HTTP semantics and closed diagnostic positions', () => {
    const code = 'const p = <donnees.result>;\nreturn params.SECRET_CANARY + p'
    expect(analyzeFunctionCode(code)).toEqual(clean)
    expect(workflow(code)).toEqual({
      status: 'analyzed',
      diagnostics: [{ code: 'unprovided_workflow_parameter', line: 2, column: 15 }],
    })
    expect(JSON.stringify(workflow(code))).not.toMatch(/SECRET|donnees|params|result/)
  })
  it('retains diagnostic/deadline limits for the new diagnostic category', () => {
    expect(workflow(Array.from({ length: 33 }, (_, i) => `params.field${i};`).join('\n'))).toEqual({
      status: 'unavailable',
      reason: 'diagnostic_limit',
    })
    expect(analyzeFunctionCode('return params.value', 'javascript', 0, 'workflow')).toEqual({
      status: 'unavailable',
      reason: 'deadline',
    })
  })
})
