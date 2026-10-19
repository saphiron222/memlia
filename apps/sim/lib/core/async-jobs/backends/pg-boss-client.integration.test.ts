// Copyright (c) 2026 Memlia. All rights reserved.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import postgres from 'postgres'
import { createPgBossClient } from './pg-boss-client'
import { PgBossTransport } from './pg-boss-transport'

test('disabled client does not attempt a connection or use the web DSN', async () => {
  const client = createPgBossClient({ DATABASE_URL: 'postgresql://127.0.0.1:1/unreachable' })
  await assert.rejects(client.get(), { code: 'pg_boss_disabled' })
  await client.stop()
})

test('enabled client refuses a missing dedicated DSN without exposing configuration', async () => {
  const client = createPgBossClient({
    MEMLIA_PG_BOSS_ENABLED: '1',
    DATABASE_URL: 'private-fixture-value',
  })
  await assert.rejects(client.get(), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.equal(error.message, 'pg_boss_database_url_required')
    assert.equal(JSON.stringify(error).includes('private-fixture-value'), false)
    return true
  })
  await client.stop()
})

test('restricted transport role connects lazily, shares one client and cannot read business tables', async () => {
  const path = process.env.MEMLIA_QUEUE_ADMISSION_TEST_ENV_FILE
  assert.ok(path, 'MEMLIA_QUEUE_ADMISSION_TEST_ENV_FILE required; no integration skip')
  const env = Object.fromEntries(
    readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
  )
  const url = env.MEMLIA_PG_BOSS_DATABASE_URL
  assert.ok(url && new URL(url).pathname.includes('_test_'), 'Dedicated test database required')
  const observer = postgres(url, { max: 1, onnotice: () => {} })
  const client = createPgBossClient({
    MEMLIA_PG_BOSS_ENABLED: '1',
    MEMLIA_PG_BOSS_DATABASE_URL: url,
  })
  try {
    // A missing schema is never created through a grant/fallback on runtime roles.
    for (const createSchema of [undefined, false]) {
      await assert.rejects(
        PgBossTransport.connect({
          connectionString: url,
          schema: 'memlia_unprovisioned_fixture',
          queueName: 'fixture',
          createSchema,
          onError: () => {},
        }),
        { code: 'transport_start_failed' }
      )
    }
    const [a, b] = await Promise.all([client.get(), client.get()])
    assert.equal(a, b)
    const [role] =
      await observer`select rolsuper, rolcreatedb, rolcreaterole from pg_roles where rolname = current_user`
    assert.equal(role.rolsuper, false)
    assert.equal(role.rolcreatedb, false)
    assert.equal(role.rolcreaterole, false)
    await assert.rejects(
      observer`select * from public.async_jobs limit 1`,
      (e: unknown) => (e as { code?: string }).code === '42501'
    )
    const [privileges] =
      await observer`select has_schema_privilege(current_user, 'public', 'CREATE') as public_create, has_database_privilege(current_user, current_database(), 'CREATE') as database_create`
    assert.equal(privileges.public_create, false)
    assert.equal(privileges.database_create, false)
    const appUrl = env.TEST_DATABASE_URL
    assert.ok(appUrl && new URL(appUrl).pathname === new URL(url).pathname)
    const app = postgres(appUrl, { max: 1, onnotice: () => {} })
    let unexpectedTableCreated = false
    try {
      await assert.rejects(
        app`select * from public."user" limit 1`,
        (e: unknown) => (e as { code?: string }).code === '42501'
      )
      await assert.rejects(
        app`create table public.memlia_forbidden_fixture (id text)`.then(() => {
          unexpectedTableCreated = true
        }),
        (e: unknown) => (e as { code?: string }).code === '42501'
      )
    } finally {
      if (unexpectedTableCreated) await app`drop table public.memlia_forbidden_fixture`
      await app.end()
    }
    await client.stop()
    await assert.rejects(client.get(), { code: 'pg_boss_client_closed' })
    await client.stop()
  } finally {
    await client.stop()
    await observer.end()
  }
})
