// Copyright 2026 Memlia. All rights reserved.
// Disposable CI provisioning only; real product schema and tests are never replaced.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { assertDisposableTestDatabaseUrl } from '../../packages/db/testing/test-infrastructure'

const require = createRequire(new URL('../../packages/db/package.json', import.meta.url))
const postgres = require('postgres').default as typeof import('postgres')
const modes = ['bootstrap', 'grants', 'baseline', 'readback', 'cleanup'] as const
function check(value: unknown): asserts value {
  if (!value) throw new Error('postgres_fixture_refused')
}
check(typeof postgres === 'function')

export function validate(env: NodeJS.ProcessEnv, mode: string) {
  check(modes.includes(mode as (typeof modes)[number]))
  const nonce = env.MEMLIA_PG_NONCE
  check(typeof nonce === 'string' && /^[a-f0-9]{32}$/.test(nonce))
  const migrate = assertDisposableTestDatabaseUrl(env.MEMLIA_PG_MIGRATE_URL!)
  const web = assertDisposableTestDatabaseUrl(env.MEMLIA_PG_WEB_URL!)
  for (const [url, letter] of [[migrate, 'm'], [web, 'w']] as const) {
    check(url.pathname === '/memlia_p06_budget_test' && !url.search && !url.hash)
    check(url.username === `pgwin_${letter}_${nonce}` && /^[a-f0-9]{64}$/.test(url.password))
  }
  check(migrate.host === web.host)
  let admin: URL | undefined
  if (['bootstrap', 'grants', 'cleanup'].includes(mode)) {
    admin = new URL(env.MEMLIA_PG_ADMIN_URL!)
    check(['postgres:', 'postgresql:'].includes(admin.protocol))
    check(['localhost', '127.0.0.1', '[::1]'].includes(admin.hostname))
    check(admin.host === migrate.host && admin.pathname === '/postgres' && !admin.search && !admin.hash)
  }
  return { migrate, web, admin, mode, database: 'memlia_p06_budget_test' }
}

async function main() {
  const config = validate(process.env, process.argv[2])
  const { migrate, web, admin, mode, database } = config
  const adminMode = ['bootstrap', 'grants', 'cleanup'].includes(mode)
  const sql = postgres((adminMode ? admin! : migrate).href, {
    max: 1, connect_timeout: 3, idle_timeout: 1, onnotice: () => {},
    connection: { application_name: 'memlia-ci-budget-window', statement_timeout: 10000, lock_timeout: 2000 },
  })
  const roles = [migrate.username, web.username]
  try {
    const [identity] = await sql`SELECT current_database() AS database,current_user AS role`
    check(identity.database === (adminMode ? 'postgres' : database))
    check(identity.role === (adminMode ? admin! : migrate).username)
    if (mode === 'bootstrap') {
      // Refuse pre-existing names before any create; no fallback or shared namespace.
      check((await sql`SELECT 1 FROM pg_database WHERE datname=${database}`).length === 0)
      check((await sql`SELECT 1 FROM pg_roles WHERE rolname=ANY(${roles}::text[])`).length === 0)
      for (const url of [migrate, web])
        await sql.unsafe(`CREATE ROLE "${url.username}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${url.password}'`)
      await sql.unsafe(`CREATE DATABASE "${database}" OWNER "${migrate.username}"`)
      await sql.unsafe(`REVOKE ALL ON DATABASE "${database}" FROM PUBLIC`)
      await sql.unsafe(`GRANT CONNECT ON DATABASE "${database}" TO "${web.username}"`)
      const url = new URL(admin!); url.pathname = '/' + database
      const target = postgres(url.href, { max: 1, connect_timeout: 3, onnotice: () => {} })
      try {
        await target`REVOKE ALL ON SCHEMA public FROM PUBLIC`
        await target.unsafe(`ALTER SCHEMA public OWNER TO "${migrate.username}"`)
        await target`CREATE EXTENSION vector`
        await target`CREATE EXTENSION pg_trgm`
        await target`CREATE EXTENSION btree_gin`
      } finally { await target.end({ timeout: 2 }) }
    } else {
      const [owned] = await sql`SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=${database}`
      check(owned?.owner === migrate.username)
      const permissions = await sql`SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=ANY(${roles}::text[])`
      check(permissions.length === 2 && permissions.every((r) => !r.rolsuper && !r.rolcreatedb && !r.rolcreaterole && !r.rolbypassrls))
      if (mode === 'grants') {
        const url = new URL(admin!); url.pathname = '/' + database
        const target = postgres(url.href, { max: 1, connect_timeout: 3, onnotice: () => {} })
        try {
          await target.unsafe(`GRANT USAGE ON SCHEMA public TO "${web.username}"`)
          await target.unsafe(`GRANT SELECT ON public.memlia_chat_cost_window,public.memlia_chat_cost_reservation TO "${web.username}"`)
          const [rights] = await target`SELECT has_schema_privilege(${web.username},'public','CREATE') AS ddl,has_database_privilege(${web.username},${database},'CREATE') AS dbddl`
          check(!rights.ddl && !rights.dbddl)
        } finally { await target.end({ timeout: 2 }) }
      } else if (mode === 'cleanup') {
        // No FORCE or pg_terminate_backend. An open connection prevents removal and is a failure.
        await sql.unsafe(`DROP DATABASE "${database}"`)
        for (const role of roles) await sql.unsafe(`DROP ROLE "${role}"`)
        check((await sql`SELECT 1 FROM pg_database WHERE datname=${database}`).length === 0)
        check((await sql`SELECT 1 FROM pg_roles WHERE rolname=ANY(${roles}::text[])`).length === 0)
      } else {
        await sql`SET default_transaction_read_only=on`
        const journal = JSON.parse(readFileSync(new URL('../../packages/db/migrations/meta/_journal.json', import.meta.url), 'utf8'))
        const last = journal.entries.at(-1)
        check(/^[0-9]{4}_[a-z0-9_]+$/.test(last.tag))
        const hash = createHash('sha256').update(readFileSync(new URL(`../../packages/db/migrations/${last.tag}.sql`, import.meta.url))).digest('hex')
        const rows = await sql`SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at`
        check(rows.length === journal.entries.length && rows.at(-1)?.hash === hash)
        check((await sql`SELECT 1 FROM pg_index WHERE NOT indisvalid`).length === 0)
        const tables = await sql`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`
        check(tables.length === 183)
        const baseline = []
        for (const { tablename } of tables) {
          check(/^[a-z_0-9]+$/.test(tablename))
          const [row] = await sql.unsafe(`SELECT count(*)::int AS count,md5(coalesce(string_agg(md5(row_to_json(t)::text),'' ORDER BY md5(row_to_json(t)::text)),'')) AS digest FROM public."${tablename}" t`)
          baseline.push([tablename, row.count, row.digest])
        }
        const digest = createHash('sha256').update(JSON.stringify(baseline)).digest('hex')
        if (mode === 'readback') check(digest === process.env.MEMLIA_PG_BASELINE)
        console.log(JSON.stringify({ phase: mode, passed: true, digest }))
        return
      }
    }
    console.log(JSON.stringify({ phase: mode, passed: true }))
  } finally { await sql.end({ timeout: 2 }) }
}

if (import.meta.main) await main().catch(() => {
  // No SQL, URL, password or raw exception is published even for setup failures.
  console.error(JSON.stringify({ phase: modes.includes(process.argv[2] as never) ? process.argv[2] : 'unknown', passed: false }))
  process.exitCode = 1
})
