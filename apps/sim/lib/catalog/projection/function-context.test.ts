// Copyright (c) 2026 Memlia. All rights reserved.
import { expect, it } from 'vitest'
import { v2BlockDetailSchema } from '@/lib/api/contracts/v2/catalog'
import { FunctionBlock } from '@/blocks/blocks/function'
import { projectBlockDetail } from './block-detail'

it('preserves a structured Function context through the public get_block schema', () => {
  const detail = projectBlockDetail(FunctionBlock, { deployment: { hostedKeys: false } })
  const parsed = v2BlockDetailSchema.parse(detail)
  expect(parsed).toHaveProperty('codeExecution', {
    version: 1,
    language: 'javascript',
    scope: 'function_without_imports',
    runtime: 'isolated_vm',
    caller: 'workflow_function',
    excludes: ['imports', 'require_calls', 'selected_sandbox', 'sandbox_filesystem'],
    body: 'async_function_body',
    globals: ['params', 'environmentVariables', 'console', 'fetch', 'sim', 'global'],
    standardGlobals: 'ECMAScript',
    references: '<normalizedBlockName.declaredOutputPath>',
    predecessorBindings: 'explicit_references_only',
    params: 'no_user_parameters',
    analysis: 'best_effort_no_execution',
  })
})
