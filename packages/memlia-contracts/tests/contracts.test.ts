// Copyright (c) 2026 Memlia. All rights reserved.
import assert from 'node:assert/strict'
import test from 'node:test'
import { schemas } from '../src/index.ts'
import { cases } from './cases.ts'
for (const example of cases) {
  test(example.label, () => {
    const result = schemas[example.name].safeParse(example.value)
    assert.equal(
      result.success,
      example.valid,
      result.success ? example.label : JSON.stringify(result.error.issues),
    )
    if (result.success)
      assert.deepEqual(
        result.data,
        example.value,
        'transport cannot silently coerce or drop fields',
      )
  })
}
