// Copyright (c) 2026 Memlia. All rights reserved.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { z } from 'zod'
import { schemas } from '../src/index.ts'
const check = process.argv[2] === '--check'
const directory =
  check && process.argv[3]
    ? process.argv[3]
    : fileURLToPath(new URL('../python/memlia_contracts/schemas/', import.meta.url))
const names = Object.keys(schemas).sort()
const expected = new Set(['_index.json', ...names.map((name) => `${name}.json`)])
if (!check) mkdirSync(directory, { recursive: true })
// Refuse stale exports before writing anything. Never silently delete files.
for (const file of readdirSync(directory)) {
  if (!expected.has(file)) {
    console.error(`Unexpected contract export: ${file}`)
    process.exitCode = 1
  }
}
if (process.exitCode) process.exit(1)
const outputs: Record<string, unknown> = {
  _index: { schemaVersion: 'memlia.contract-index/v1', contracts: names },
}
for (const [name, schema] of Object.entries(schemas)) {
  // Never use unrepresentable:any: that silently erases validation constraints.
  outputs[name] = z.toJSONSchema(schema, { target: 'draft-2020-12', unrepresentable: 'throw' })
}
for (const [name, json] of Object.entries(outputs)) {
  const output = `${JSON.stringify(json, null, 2)}\n`
  const path = join(directory, `${name}.json`)
  if (check) {
    let actual: string | undefined
    try {
      actual = readFileSync(path, 'utf8')
    } catch {
      /* missing means drift */
    }
    if (actual !== output) {
      console.error(`Contract export drift: ${name}`)
      process.exitCode = 1
    }
  } else writeFileSync(path, output)
}
