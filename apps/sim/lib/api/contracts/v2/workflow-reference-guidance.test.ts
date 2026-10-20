// Copyright (c) 2026 Memlia. All rights reserved.
import { expect, it } from 'vitest'
import { z } from 'zod'
import { v2ApplyWorkflowOperationsDataSchema, v2WorkflowOperationSchema } from './workflows'

it('describes temporary operation IDs separately from references embedded in code', () => {
  const native = z.toJSONSchema(v2WorkflowOperationSchema, { io: 'input' })
  const branches = native.oneOf ?? native.anyOf ?? []
  const description = branches[0].properties?.block_id?.description ?? ''
  expect(description).toContain('non-UUID')
  expect(description).toContain('minted UUID')
  expect(description).toContain('code')
  expect(description).toContain('normalized block name')
})

it('limits automatic ID remapping to structural references, not arbitrary code strings', () => {
  const description = v2ApplyWorkflowOperationsDataSchema.shape.mintedBlockIds.description ?? ''
  expect(description).toContain('connections')
  expect(description).toContain('code strings are not rewritten')
})
