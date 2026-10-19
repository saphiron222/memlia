// Copyright 2026 Memlia. All rights reserved.
import { expect, it } from 'vitest'
import { z } from 'zod'
import { privateCopyContract } from './contracts'

it('publishes a closed, bounded request that requires a personal destination and a name', () => {
  const schema = z.toJSONSchema(privateCopyContract.body)
  expect(schema).toMatchObject({
    type: 'object',
    additionalProperties: false,
    required: ['destinationWorkspaceId', 'name'],
    properties: {
      destinationWorkspaceId: { type: 'string', minLength: 1, maxLength: 128 },
      name: { type: 'string', minLength: 1, maxLength: 100 },
    },
  })
  expect(Object.keys(schema.properties ?? {}).sort()).toEqual(['destinationWorkspaceId', 'name'])
})
it('publishes configurationRequired as true rather than a generic boolean', () => {
  const schema = z.toJSONSchema(privateCopyContract.response.schema)
  expect(schema).toMatchObject({
    properties: {
      data: {
        additionalProperties: false,
        properties: { configurationRequired: { type: 'boolean', const: true } },
      },
    },
  })
})
it('does not accept personal source metadata or credentials in the response', () => {
  const data = { id: 'new', workspaceId: 'personal', name: 'Copy', configurationRequired: true }
  expect(privateCopyContract.response.schema.safeParse({ data }).success).toBe(true)
  for (const field of ['source', 'credentials', 'variables', 'ready']) {
    expect(
      privateCopyContract.response.schema.safeParse({ data: { ...data, [field]: 'private' } })
        .success
    ).toBe(false)
  }
})
