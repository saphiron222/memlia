// Copyright (c) 2026 Memlia. All rights reserved.

import { z } from 'zod'

/** Fast Function JavaScript context: isolated-vm-worker.cjs execute(), not sandbox tasks.
 * Keep this declarative projection outside the CJS worker; it adds no runtime bindings.
 * Workflow predecessors are resolved by the native placeholder resolver, not injected
 * under their block names. The Workflow handler/tool body supplies no user params;
 * the HTTP execution API may have other callers, outside this catalogue contract.
 */
export const FUNCTION_GLOBALS = [
  'params',
  'environmentVariables',
  'console',
  'fetch',
  'sim',
  'global',
] as const

export const functionCodeContextSchema = z
  .object({
    version: z.literal(1),
    language: z.literal('javascript'),
    scope: z.literal('function_without_imports'),
    runtime: z.literal('isolated_vm'),
    caller: z.literal('workflow_function'),
    excludes: z.tuple([
      z.literal('imports'),
      z.literal('require_calls'),
      z.literal('selected_sandbox'),
      z.literal('sandbox_filesystem'),
    ]),
    body: z.literal('async_function_body'),
    globals: z.array(z.enum(FUNCTION_GLOBALS)).length(FUNCTION_GLOBALS.length),
    standardGlobals: z.literal('ECMAScript'),
    references: z.literal('<normalizedBlockName.declaredOutputPath>'),
    predecessorBindings: z.literal('explicit_references_only'),
    params: z.literal('no_user_parameters'),
    analysis: z.literal('best_effort_no_execution'),
  })
  .strict()

export type FunctionCodeContext = z.infer<typeof functionCodeContextSchema>
export function projectFunctionCodeContext(): FunctionCodeContext {
  return {
    version: 1,
    language: 'javascript',
    scope: 'function_without_imports',
    runtime: 'isolated_vm',
    caller: 'workflow_function',
    excludes: ['imports', 'require_calls', 'selected_sandbox', 'sandbox_filesystem'],
    body: 'async_function_body',
    globals: [...FUNCTION_GLOBALS],
    standardGlobals: 'ECMAScript',
    references: '<normalizedBlockName.declaredOutputPath>',
    predecessorBindings: 'explicit_references_only',
    params: 'no_user_parameters',
    analysis: 'best_effort_no_execution',
  }
}
