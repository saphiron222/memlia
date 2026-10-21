// Copyright (c) 2026 Memlia. All rights reserved.
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import {
  FUNCTION_GLOBALS,
  functionCodeContextSchema,
  projectFunctionCodeContext,
} from './function-context'

it('projects a fresh structured contract without changing the CJS runtime', () => {
  const first = projectFunctionCodeContext()
  expect(functionCodeContextSchema.parse(first)).toEqual(first)
  first.globals.pop()
  expect(projectFunctionCodeContext().globals).toEqual(FUNCTION_GLOBALS)
  const worker = readFileSync(new URL('./isolated-vm-worker.cjs', import.meta.url), 'utf8').split(
    'async function executeSandboxTask'
  )[0]
  expect(worker).toContain("jail.set('params'")
  expect(worker).toContain("jail.set('environmentVariables'")
  expect(worker).toContain("jail.set('global'")
  expect(worker).toContain('console')
  expect(worker).toContain('fetch')
  expect(worker).toContain('sim')
})

it('identifies the Workflow caller without promising arbitrary HTTP parameters', () => {
  expect(projectFunctionCodeContext()).toMatchObject({
    caller: 'workflow_function',
    params: 'no_user_parameters',
    predecessorBindings: 'explicit_references_only',
  })
})
