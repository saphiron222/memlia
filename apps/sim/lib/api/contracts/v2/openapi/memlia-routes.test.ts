import { expect, it } from 'vitest'
import { workflowsOpenApiDocument } from './workflows'
import { resourcesOpenApiDocument } from './resources'
it('retains the declared Apache workflow routes while excluding workspace synchronization', () => {
  expect(workflowsOpenApiDocument.routes.length).toBeGreaterThan(20)
  const paths = workflowsOpenApiDocument.routes.map(route => route.contract.path)
  expect(paths).toContain('/api/v2/workflows')
  expect(paths.some(path => path.includes('/fork'))).toBe(false)
})
it('retains resource routes without access request operations', () => {
  expect(resourcesOpenApiDocument.routes.length).toBeGreaterThan(20)
  expect(resourcesOpenApiDocument.routes.every(route => !route.contract.path.includes('access-requests'))).toBe(true)
})
