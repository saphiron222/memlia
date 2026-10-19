// Copyright (c) 2026 Memlia. All rights reserved.
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cases } from './cases.ts'
const root = fileURLToPath(new URL('../', import.meta.url))
const python = process.env.PYTHON ?? 'python3'
function consume(input: unknown, directory?: string) {
  return spawnSync(python, ['-m', 'memlia_contracts', ...(directory ? [directory] : [])], {
    cwd: root,
    env: { ...process.env, PYTHONPATH: join(root, 'python') },
    input: JSON.stringify(input),
    encoding: 'utf8',
  })
}
test('Python validates the same positive and negative wire corpus', () => {
  const result = consume(cases)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(
    JSON.parse(result.stdout),
    cases.map((c) => c.valid),
  )
})
test('a divergent Python export is rejected by the generated-artifact gate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memlia-contract-drift-'))
  try {
    cpSync(join(root, 'python/memlia_contracts/schemas'), dir, { recursive: true })
    const file = join(dir, 'Binding.json')
    const schema = JSON.parse(readFileSync(file, 'utf8'))
    schema.properties.connection.oneOf[0].properties.resolution.const = 'workflow_owner'
    writeFileSync(file, JSON.stringify(schema))
    const result = spawnSync(
      process.execPath,
      [
        ...(process.versions.bun ? [] : ['--experimental-strip-types']),
        'scripts/export.ts',
        '--check',
        dir,
      ],
      { cwd: root, encoding: 'utf8' },
    )
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /Contract export drift: Binding/)
    const consumed = consume([cases.find((c) => c.name === 'Binding' && c.valid)], dir)
    assert.equal(consumed.status, 0, consumed.stderr)
    assert.deepEqual(
      JSON.parse(consumed.stdout),
      [false],
      'mutated consumer must actually disagree',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('source qualification rejects an unrelated Git revision without loading code', () => {
  const result = spawnSync(
    process.execPath,
    [
      ...(process.versions.bun ? [] : ['--experimental-strip-types']),
      'scripts/verify-source.ts',
      root,
    ],
    { cwd: root, encoding: 'utf8' },
  )
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Sim source revision mismatch/)
})

test('Python loader rejects remote schema references instead of retrieving them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memlia-contract-ref-'))
  try {
    cpSync(join(root, 'python/memlia_contracts/schemas'), dir, { recursive: true })
    writeFileSync(
      join(dir, 'Binding.json'),
      JSON.stringify({ $ref: 'https://example.invalid/schema' }),
    )
    const result = consume([{ name: 'Binding', value: {} }], dir)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Only document-local schema references/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('checked-in Python exports match the current canonical source', () => {
  const result = spawnSync(
    process.execPath,
    [
      ...(process.versions.bun ? [] : ['--experimental-strip-types']),
      'scripts/export.ts',
      '--check',
    ],
    { cwd: root, encoding: 'utf8' },
  )
  assert.equal(result.status, 0, result.stderr)
})

test('extra Python schema is rejected by both export gate and bundled registry', () => {
  const temp = mkdtempSync(join(tmpdir(), 'memlia-extra-schema-'))
  try {
    const pkg = join(temp, 'memlia_contracts')
    cpSync(join(root, 'python/memlia_contracts'), pkg, { recursive: true })
    const dir = join(pkg, 'schemas')
    writeFileSync(join(dir, 'RemovedContract.json'), '{"type":"object"}\n')
    const gate = spawnSync(
      process.execPath,
      [
        ...(process.versions.bun ? [] : ['--experimental-strip-types']),
        'scripts/export.ts',
        '--check',
        dir,
      ],
      { cwd: root, encoding: 'utf8' },
    )
    assert.equal(gate.status, 1, 'export gate must reject a surplus schema')
    assert.match(gate.stderr, /Unexpected contract export: RemovedContract.json/)
    const consumer = spawnSync(
      python,
      ['-c', 'from memlia_contracts import validate; validate("RemovedContract", {})'],
      { cwd: temp, env: { ...process.env, PYTHONPATH: temp }, encoding: 'utf8' },
    )
    assert.equal(consumer.status, 1, 'file presence must not create a Python contract')
    assert.match(consumer.stderr, /Unknown contract name|Contract export set mismatch/)
    const known = spawnSync(
      python,
      ['-c', 'from memlia_contracts import load_schema; load_schema("Binding")'],
      { cwd: temp, env: { ...process.env, PYTHONPATH: temp }, encoding: 'utf8' },
    )
    assert.equal(known.status, 1, 'a contaminated bundle must also refuse known contracts')
    assert.match(known.stderr, /Contract export set mismatch/)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

test('Python package build rejects a surplus schema', () => {
  const temp = mkdtempSync(join(tmpdir(), 'memlia-build-schema-'))
  try {
    cpSync(join(root, 'python'), join(temp, 'python'), { recursive: true })
    for (const file of ['pyproject.toml', 'LICENSE']) cpSync(join(root, file), join(temp, file))
    // setup.py is the package's build hook, when present. Before the fix setuptools
    // builds from pyproject alone and incorrectly admits the extra file.
    try {
      cpSync(join(root, 'setup.py'), join(temp, 'setup.py'))
    } catch {}
    writeFileSync(
      join(temp, 'python/memlia_contracts/schemas/RemovedContract.json'),
      '{"type":"object"}\n',
    )
    const build = spawnSync(
      python,
      [
        '-m',
        'pip',
        'wheel',
        '--no-deps',
        '--no-build-isolation',
        '--wheel-dir',
        join(temp, 'wheels'),
        temp,
      ],
      { cwd: temp, encoding: 'utf8' },
    )
    assert.notEqual(build.status, 0, 'wheel must not package a stale contract')
    assert.match(build.stderr + build.stdout, /Contract export set mismatch/)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

test('Python contract names do not come from arbitrary JSON filenames', () => {
  const temp = mkdtempSync(join(tmpdir(), 'memlia-registry-'))
  try {
    const pkg = join(temp, 'memlia_contracts')
    cpSync(join(root, 'python/memlia_contracts'), pkg, { recursive: true })
    writeFileSync(join(pkg, 'schemas/RemovedContract.json'), '{"type":"object"}\n')
    const result = spawnSync(
      python,
      ['-c', 'from memlia_contracts import validate; validate("RemovedContract", {})'],
      { cwd: temp, env: { ...process.env, PYTHONPATH: temp }, encoding: 'utf8' },
    )
    assert.equal(result.status, 1, 'a filename cannot grant authority to a new contract')
    assert.match(result.stderr, /Unknown contract name|Contract export set mismatch/)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})
