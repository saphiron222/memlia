// Copyright 2026 Memlia. All rights reserved.
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { getTableName, is } from 'drizzle-orm'
import { PgTable } from 'drizzle-orm/pg-core'

export function fixtureSourceRoot(value: string | undefined) {
  if (value === undefined) return '/work'
  if (value !== '/app') throw Error('fixture_source_refused')
  return value
}
export function candidateTableNames(schema: Record<string, unknown>) {
  const names = Object.values(schema).filter((value): value is PgTable => is(value, PgTable)).map(getTableName)
  // This ledger is created by the native script-migration runner, outside schema.ts.
  names.push('script_migrations')
  if (names.length < 2 || names.length > 1024 || new Set(names).size !== names.length ||
      names.some(name => !/^[a-z_0-9]+$/.test(name))) throw Error('fixture_catalog_refused')
  return names.sort()
}
export function verifyCandidateCatalog(expected: string[], actual: string[],
  migrations: { hash: string; folderMillis: number }[], rows: { hash: string; created_at: unknown }[]) {
  if (JSON.stringify(expected) !== JSON.stringify(actual) || migrations.length === 0 ||
      migrations.length !== rows.length || migrations.some((migration, index) =>
        !/^[a-f0-9]{64}$/.test(migration.hash) || !Number.isSafeInteger(migration.folderMillis) ||
        migration.folderMillis < 1 || rows[index].hash !== migration.hash ||
        String(rows[index].created_at) !== String(migration.folderMillis))) throw Error('fixture_catalog_refused')
  return true
}

const CLEANUP_STAGES = ['preflight', 'owner_readback', 'scope_readback', 'native_account_deletion',
  'deleted_user_readback', 'residue_capture', 'residue_delete', 'baseline_compare', 'proof_write',
  'application_connections_close', 'database_connection_close', 'unknown'] as const
let cleanupStage = 'preflight'
let cleanupIndex: number | null = null
let cleanupFailure: ReturnType<typeof cleanupFailureReceipt> | undefined
let cleanupTableCount = 183

/** Diagnostics only: never serialize native errors, SQL, credentials or row identities. */
export function cleanupFailureReceipt(stage: unknown, index: unknown, error: unknown, tableCount = 183) {
  const code = error !== null && (typeof error === 'object' || typeof error === 'function')
    ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined
  return { status: 'failed', code: 'fixture_cleanup_refused',
    stage: CLEANUP_STAGES.find(value => value === stage) ?? 'unknown',
    index: stage === 'baseline_compare' && typeof index === 'number' && Number.isInteger(index)
      && Number.isInteger(tableCount) && tableCount >= 1 && tableCount <= 1024
      && index >= 0 && index < tableCount ? index : null,
    sqlstate: typeof code === 'string' && code.length === 5 && /^[A-Z0-9]{5}$/.test(code) ? code : null }
}

export function validateTarget(raw: string, nonce: string, mode: string) {
  if (
    !/^[a-f0-9]{32}$/.test(nonce) ||
    !['bootstrap', 'grants', 'metadata', 'metadata-final', 'baseline', 'readback', 'seed', 'cleanup'].includes(mode)
  )
    throw Error('fixture_target_refused')
  const u = new URL(raw)
  const admin = mode === 'bootstrap' || mode === 'grants'
  const role = admin ? 'postgres' : ['metadata', 'metadata-final'].includes(mode) ? 'ui_migrate_' + nonce : 'ui_web_' + nonce
  if (
    u.protocol !== 'postgres:' ||
    u.hostname !== 'database' ||
    u.port !== '5432' ||
    u.username !== role ||
    u.pathname !== (mode === 'bootstrap' ? '/postgres' : '/memlia_ui_' + nonce) ||
    u.search ||
    u.hash
  )
    throw Error('fixture_target_refused')
  return u
}

async function main() {
  // Dedicated synthetic CI fixture. Never imports credentials or sessions from a host.
  const sourceRoot = fixtureSourceRoot(process.env.MEMLIA_CI_FIXTURE_SOURCE_ROOT)
  const candidate = sourceRoot === '/app'
  const native = createRequire(sourceRoot + '/packages/db/package.json')
  const postgres = (await import(native.resolve('postgres'))).default as typeof import('postgres')
  const expectedNames = candidate ? candidateTableNames(await import(sourceRoot + '/packages/db/schema.ts')) : undefined
  const businessNames = expectedNames?.filter(name => name !== 'script_migrations')
  if (process.argv[2] === 'metadata-final' && !candidate) throw Error('fixture_source_refused')
  cleanupTableCount = expectedNames?.length ?? 183
  const nonce = process.env.RECIPE_NONCE!
  const mode = process.argv[2]
  const dir = '/scratch/ui'
  function assertRecipe(ok: unknown) {
    if (!ok) throw Error('database_recipe_refused')
  }
  assertRecipe(/^[a-f0-9]{32}$/.test(nonce))
  const admin = ['bootstrap', 'grants'].includes(mode)
  const metadata = ['metadata', 'metadata-final'].includes(mode)
  const value = admin
    ? process.env.RECIPE_ADMIN_URL
    : metadata
      ? process.env.MIGRATION_DATABASE_URL
      : process.env.DATABASE_URL
  const url = validateTarget(value!, nonce, mode)
  const user = admin ? 'postgres' : metadata ? 'ui_migrate_' + nonce : 'ui_web_' + nonce
  assertRecipe(
    url.protocol === 'postgres:' &&
      url.hostname === 'database' &&
      url.port === '5432' &&
      url.username === user &&
      !url.search &&
      !url.hash
  )
  assertRecipe(url.pathname === (mode === 'bootstrap' ? '/postgres' : '/memlia_ui_' + nonce))
  if (['seed', 'cleanup'].includes(mode)) {
    await fixturePhase()
    process.exitCode = 0
  } else {
    const sql = postgres(url.href, {
      max: 1,
      connect_timeout: 3,
      idle_timeout: 1,
      onnotice: () => {},
    })
    const roles = ['ui_migrate_', 'ui_web_', 'ui_realtime_'].map((p) => p + nonce)
    const db = 'memlia_ui_' + nonce
    async function snapshot() {
      const names =
        await sql`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`
      assertRecipe(expectedNames ? JSON.stringify(names.map(row => row.tablename)) === JSON.stringify(expectedNames) : names.length === 183)
      const rows = []
      for (const { tablename } of names) {
        if (candidate && tablename === 'script_migrations') continue
        assertRecipe(/^[a-z_0-9]+$/.test(tablename))
        const [r] = await sql.unsafe(
          `SELECT count(*)::int AS count,md5(coalesce(string_agg(md5(row_to_json(t)::text),'' ORDER BY md5(row_to_json(t)::text)),'')) AS digest FROM public."${tablename}" t`
        )
        rows.push({ table: tablename, count: r.count, digest: r.digest })
      }
      return rows
    }
    try {
      await sql`SET statement_timeout='10s'`
      await sql`SET lock_timeout='3s'`
      await sql`SET timezone='UTC'`
      const [identity] =
        await sql`SELECT current_user AS role,current_database() AS database,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user`
      assertRecipe(identity.role === user && identity.database === url.pathname.slice(1))
      if (admin) assertRecipe(identity.rolsuper === true)
      else
        assertRecipe(
          !identity.rolsuper &&
            !identity.rolcreatedb &&
            !identity.rolcreaterole &&
            !identity.rolbypassrls
        )
      if (mode === 'bootstrap') {
        assertRecipe((await sql`SELECT 1 FROM pg_database WHERE datname=${db}`).length === 0)
        assertRecipe(
          (await sql`SELECT 1 FROM pg_roles WHERE rolname=ANY(${roles}::text[])`).length === 0
        )
        const passwords = [
          process.env.RECIPE_MIGRATE_PASSWORD,
          process.env.RECIPE_WEB_PASSWORD,
          process.env.RECIPE_REALTIME_PASSWORD,
        ]
        for (let i = 0; i < roles.length; i++) {
          assertRecipe(/^[a-f0-9]{64}$/.test(passwords[i]!))
          await sql.unsafe(
            `CREATE ROLE "${roles[i]}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${passwords[i]}'`
          )
        }
        await sql.unsafe(`CREATE DATABASE "${db}" OWNER "${roles[0]}"`)
        await sql.unsafe(`REVOKE ALL ON DATABASE "${db}" FROM PUBLIC`)
        for (const role of roles) await sql.unsafe(`GRANT CONNECT ON DATABASE "${db}" TO "${role}"`)
        const databaseURL = new URL(url)
        databaseURL.pathname = '/' + db
        const target = postgres(databaseURL.href, {
          max: 1,
          connect_timeout: 3,
          idle_timeout: 1,
          onnotice: () => {},
        })
        try {
          await target`SET statement_timeout='10s'`
          await target`REVOKE ALL ON SCHEMA public FROM PUBLIC`
          await target.unsafe(`ALTER SCHEMA public OWNER TO "${roles[0]}"`)
          await target`CREATE EXTENSION vector`
          await target`CREATE EXTENSION pg_trgm`
          await target`CREATE EXTENSION btree_gin`
        } finally {
          await target.end({ timeout: 2 })
        }
      } else if (mode === 'grants') {
        // After native migration only; no arbitrary migration or SQL supplied by the caller.
        await sql`REVOKE CREATE ON SCHEMA public FROM PUBLIC`
        for (const role of roles.slice(1)) {
          await sql.unsafe(`GRANT USAGE ON SCHEMA public TO "${role}"`)
          await sql.unsafe(
            `GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO "${role}"`
          )
          await sql.unsafe(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO "${role}"`)
        }
      } else if (metadata) {
        await sql`SET default_transaction_read_only=on`
        const runtimeRoles = candidate ? ['web', 'realtime', 'worker', 'transport'].map(role => 'ui_' + role + '_' + nonce) : roles.slice(1)
        const runtime =
          await sql`SELECT rolname,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,has_schema_privilege(rolname,'public','CREATE') AS ddl,has_database_privilege(rolname,current_database(),'CREATE') AS dbddl FROM pg_roles WHERE rolname=ANY(${runtimeRoles}::text[])`
        assertRecipe(
          runtime.length === runtimeRoles.length &&
            runtime.every(
              (r) =>
                !r.rolsuper &&
                !r.rolcreatedb &&
                !r.rolcreaterole &&
                !r.rolbypassrls &&
                !r.ddl &&
                !r.dbddl
            )
        )
        const migrationSha256 = createHash('sha256')
          .update(
            readFileSync(sourceRoot + '/packages/db/migrations/0440_workflow_excel_test_preparation.sql')
          )
          .digest('hex')
        const rows = await sql<{ hash: string; created_at: string }[]>`SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY created_at`
        let ledgerDigests: { sql: string; scripts: string } | undefined
        if (expectedNames) {
          const { readMigrationFiles } = await import(native.resolve('drizzle-orm/migrator'))
          const migrations = readMigrationFiles({ migrationsFolder: sourceRoot + '/packages/db/migrations' })
          const actual = await sql`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`
          verifyCandidateCatalog(expectedNames, actual.map(row => row.tablename), migrations, rows)
          const { scriptMigrations } = await import(sourceRoot + '/packages/db/script-migrations/index.ts') as typeof import('../../packages/db/script-migrations')
          const scriptNames = [...new Set(scriptMigrations.flatMap(item => [item.name, ...(item.supersedes ?? [])]))].sort()
          const scripts = await sql`SELECT name,applied_at::text AS applied_at FROM script_migrations ORDER BY name`
          assertRecipe(JSON.stringify(scripts.map(row => row.name)) === JSON.stringify(scriptNames))
          const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
          ledgerDigests = { sql: digest(rows), scripts: digest(scripts) }
          if (mode === 'metadata-final') {
            const before = JSON.parse(readFileSync(dir + '/metadata.json', 'utf8'))
            assertRecipe(JSON.stringify(before.ledgerDigests) === JSON.stringify(ledgerDigests))
          }
        } else assertRecipe(rows.length === 440 && rows.at(-1)?.hash === migrationSha256)
        const [catalog] =
          await sql`SELECT (SELECT count(*)::int FROM pg_tables WHERE schemaname='public') AS tables,(SELECT count(*)::int FROM pg_index WHERE NOT indisvalid) AS invalid`
        assertRecipe(catalog.tables === cleanupTableCount && catalog.invalid === 0)
        const columns =
          await sql`SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='workflow_deployment_version' AND column_name='preparation_kind' AND data_type='text'`
        assertRecipe(columns.length === 1)
        const constraints =
          await sql`SELECT 1 FROM pg_constraint WHERE conrelid='public.workflow_deployment_version'::regclass AND conname='workflow_deployment_version_excel_test_preparation_check' AND convalidated`
        assertRecipe(constraints.length === 1)
        writeFileSync(
          dir + '/' + mode + '.json',
          JSON.stringify({
            tables: cleanupTableCount,
            journalLastIndex: candidate ? JSON.parse(readFileSync(sourceRoot + '/packages/db/migrations/meta/_journal.json', 'utf8')).entries.at(-1).idx : 440,
            journalRows: rows.length,
            lastHashExact: true,
            noInvalidIndexes: true,
            preparationKindPresent: true,
            ...(ledgerDigests ? { ledgerDigests } : {}),
          }) + '\n',
          { mode: 0o600 }
        )
      } else if (['baseline', 'readback'].includes(mode)) {
        const [rights] =
          await sql`SELECT has_schema_privilege(current_user,'public','CREATE') AS ddl,has_database_privilege(current_user,current_database(),'CREATE') AS dbddl`
        assertRecipe(!rights.ddl && !rights.dbddl)
        const rows = await snapshot()
        if (mode === 'baseline')
          writeFileSync(dir + '/baseline.json', JSON.stringify(rows) + '\n', {
            flag: 'wx',
            mode: 0o600,
          })
        else assertRecipe(JSON.stringify(rows) === readFileSync(dir + '/baseline.json', 'utf8').trim())
        writeFileSync(
          dir + '/' + mode + '-proof.json',
          JSON.stringify({ tables: cleanupTableCount, ...(candidate ? { comparedTables: businessNames!.length } : {}), noDDL: true, readbackCompared: mode === 'readback' }) +
            '\n',
          { mode: 0o600 }
        )
      } else throw Error('database_mode_refused')
      console.log(JSON.stringify({ mode, passed: true }))
    } catch (error) {
      const code = error !== null && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined
      const state = typeof code === 'string' && /^[A-Z0-9]{5}$/.test(code) ? code : null
      console.error(
        JSON.stringify({
          mode: ['bootstrap', 'grants', 'metadata', 'metadata-final', 'baseline', 'readback'].includes(mode)
            ? mode
            : 'unknown',
          passed: false,
          reason: 'database_phase_refused',
          sqlstate: state,
        })
      )
      process.exitCode = 1
    } finally {
      try {
        await sql.end({ timeout: 2 })
      } catch {
        console.error(JSON.stringify({ passed: false, reason: 'connection_close_refused' }))
        process.exitCode = 1
      }
    }
  }

  async function fixturePhase() {
    const appRequire = createRequire(sourceRoot + '/apps/sim/package.json')
    const { hashPassword } = await import(appRequire.resolve('better-auth/crypto'))
    const dbRequire = createRequire(sourceRoot + '/packages/db/package.json')
    const postgres = (await import(dbRequire.resolve('postgres'))).default as typeof import('postgres')
    const file = '/scratch/ui/credentials.private.json'
    const fixture = JSON.parse(readFileSync(file, 'utf8'))
    const url = new URL(process.env.DATABASE_URL!)
    if (
      !/^[a-f0-9]{32}$/.test(process.env.RECIPE_NONCE ?? '') ||
      url.hostname !== 'database' ||
      url.port !== '5432' ||
      url.pathname !== '/memlia_ui_' + process.env.RECIPE_NONCE ||
      url.username !== 'ui_web_' + process.env.RECIPE_NONCE ||
      url.search ||
      url.hash
    )
      throw new Error('fixture_target_refused')
    const sql = postgres(url.href, {
      max: 1,
      connect_timeout: 3,
      idle_timeout: 1,
      onnotice: () => {},
    })
    const directory = dirname(file)
    const assertRecipe = (ok: unknown) => {
      if (!ok) throw new Error('owned_fixture_cleanup_refused')
    }
    let importedDeletion = false
    async function closeImportedClients() {
      // Same native shutdown APIs as the qualified PG7 fixture; never process.exit().
      const { db } = await import(sourceRoot + '/packages/db/db.ts')
      try {
        const { closeRedisConnection } = await import(sourceRoot + '/apps/sim/lib/core/config/redis.ts')
        try {
          const { chatPubSub } = await import(sourceRoot + '/apps/sim/lib/mothership/chat-status.ts')
          chatPubSub?.dispose()
        } finally {
          await closeRedisConnection()
        }
      } finally {
        await db.$client.end({ timeout: 2 })
      }
    }
    async function closeOwnedConnections() {
      try {
        cleanupStage = 'application_connections_close'
        if (importedDeletion) await closeImportedClients()
      } catch (error) {
        if (process.argv[2] === 'cleanup')
          cleanupFailure ??= cleanupFailureReceipt(cleanupStage, cleanupIndex, error, cleanupTableCount)
        throw error
      } finally {
        cleanupStage = 'database_connection_close'
        await sql.end({ timeout: 2 })
      }
    }
    await sql`SET timezone='UTC'`
    try {
      if (process.argv[2] === 'seed') {
        // These small residual tables are required empty for this dedicated recipe;
        // refuse before inserting a fixture rather than modifying pre-existing rows.
        for (const table of ['audit_log', 'outbox_event', 'rate_limit_bucket', 'verification']) {
          const rows = await sql.unsafe(`SELECT count(*)::int AS n FROM public.${table}`)
          assertRecipe(rows[0].n === 0)
        }
        const clock = await sql`SELECT clock_timestamp()::text AS started`
        writeFileSync(
          join(directory, 'fixture-clock.private.json'),
          JSON.stringify({ started: clock[0].started }) + '\n',
          { mode: 0o600 }
        )
        const password = await hashPassword(fixture.password)
        await sql.begin(async (tx) => {
          await tx`insert into "user" (id,name,email,normalized_email,email_verified,created_at,updated_at) values (${fixture.userId},'Recette Chat locale',${fixture.email},${fixture.email},true,now(),now())`
          await tx`insert into user_stats (id,user_id) values (${fixture.statsId},${fixture.userId})`
          await tx`insert into account (id,account_id,provider_id,user_id,password,created_at,updated_at) values (${fixture.accountId},${fixture.userId},'credential',${fixture.userId},${password},now(),now())`
        })
      } else if (process.argv[2] === 'cleanup') {
        cleanupStage = 'owner_readback'
        const rows = await sql`select id,email from "user" where id=${fixture.userId}`
        if (rows.length !== 1 || rows[0].email !== fixture.email)
          throw new Error('fixture_ownership_refused')
        const start = JSON.parse(
          readFileSync(join(directory, 'fixture-clock.private.json'), 'utf8')
        ).started
        cleanupStage = 'scope_readback'
        const workspaces =
          await sql`SELECT id FROM workspace WHERE owner_id=${fixture.userId} AND organization_id IS NULL LIMIT 9`
        const projects =
          await sql`SELECT id FROM project WHERE owner_id=${fixture.userId} AND organization_id IS NULL LIMIT 9`
        assertRecipe(workspaces.length <= 8 && projects.length <= 8)
        const workspaceIds = workspaces.map((r) => r.id)
        const projectIds = projects.map((r) => r.id)
        // The native one-time-token plugin stores the calling session token as value.
        // Capture row versions only, never token or session values, before native deletion.
        const verification =
          await sql`SELECT v.id,md5(row_to_json(v)::text) AS digest,v.xmin::text AS version
      FROM verification v JOIN session s ON v.value=s.token
      WHERE s.user_id=${fixture.userId} AND v.identifier LIKE 'one-time-token:%'
      AND v.created_at>=${start}::timestamptz AT TIME ZONE 'UTC' LIMIT 33`
        assertRecipe(verification.length <= 32)
        writeFileSync(
          join(directory, 'owned-scopes.private.json'),
          JSON.stringify({ workspaceIds, projectIds, verification }) + '\n',
          { mode: 0o600 }
        )
        importedDeletion = true
        cleanupStage = 'native_account_deletion'
        const { deleteUserAccount } = await import(sourceRoot + '/apps/sim/lib/users/account-deletion.ts')
        await deleteUserAccount(fixture.userId, { recordIdentity: false })
        cleanupStage = 'deleted_user_readback'
        const remaining =
          await sql`select count(*)::int as n from "user" where id=${fixture.userId}`
        if (remaining[0].n !== 0) throw new Error('fixture_cleanup_refused')
        cleanupStage = 'residue_capture'
        // The file trigger outlives its owner. Reconcile only this fixture's
        // already-erased personal scopes, never dispatch or drain another owner.
        const searchQueue = await sql`SELECT t.entity_type AS "entityType",t.entity_id AS "entityId",
      md5(row_to_json(t)::text) AS digest,t.xmin::text AS version,
      t.last_dispatched_at IS NULL AS undispatched,
      (t.enqueued_at>=${start}::timestamptz AT TIME ZONE 'UTC'
        AND t.updated_at>=${start}::timestamptz AT TIME ZONE 'UTC'
        AND t.enqueued_at<=t.updated_at AND t.updated_at<=clock_timestamp() AT TIME ZONE 'UTC') AS fresh,
      (NOT EXISTS (SELECT 1 FROM workspace w WHERE t.entity_type='workspace' AND w.id=t.entity_id)
        AND NOT EXISTS (SELECT 1 FROM project p WHERE t.entity_type='project' AND p.id=t.entity_id)) AS "ownerAbsent"
      FROM file_search_dispatch_queue t
      WHERE ((t.entity_type='workspace' AND t.entity_id=ANY(${workspaceIds}::text[]))
        OR (t.entity_type='project' AND t.entity_id=ANY(${projectIds}::text[])))
      ORDER BY t.entity_type,t.entity_id LIMIT 17`
        assertRecipe(searchQueue.length <= 16 && searchQueue.length <= workspaceIds.length + projectIds.length)
        assertRecipe(searchQueue.every(row => row.undispatched === true && row.fresh === true
          && row.ownerAbsent === true && /^[a-f0-9]{32}$/.test(row.digest) && /^[0-9]+$/.test(row.version)
          && ((row.entityType === 'workspace' && workspaceIds.includes(row.entityId))
            || (row.entityType === 'project' && projectIds.includes(row.entityId)))))
        assertRecipe(new Set(searchQueue.map(row => JSON.stringify([row.entityType, row.entityId]))).size === searchQueue.length)
        const audit =
          await sql`SELECT t.id,md5(row_to_json(t)::text) AS digest,t.xmin::text AS version FROM audit_log t
      WHERE t.actor_email=${fixture.email} AND t.created_at>=${start}::timestamptz AT TIME ZONE 'UTC' LIMIT 33`
        const outbox =
          await sql`SELECT t.id,md5(row_to_json(t)::text) AS digest,t.xmin::text AS version FROM outbox_event t
      WHERE t.status='pending' AND t.attempts=0 AND t.locked_at IS NULL AND t.processed_at IS NULL
      AND t.created_at>=${start}::timestamptz AT TIME ZONE 'UTC'
      AND ((t.event_type='project-file.storage.prefix-cleanup' AND t.payload->>'projectId'=ANY(${projectIds}::text[]))
        OR (t.event_type IN ('account-deletion.storage.workspace-sweep','execution.removal-stop') AND t.payload->>'workspaceId'=ANY(${workspaceIds}::text[]))) LIMIT 33`
        // Fresh dedicated database; only two owned loopback services admitted traffic.
        // Legacy direct HTTP uses the verified Docker gateway; the durable HTTPS
        // recipe forces Chromium to IPv4 loopback and requires the existing proxy
        // to forward that remote address. No broad selection of IP buckets.
        assertRecipe(
          Array.isArray(fixture.socketBucketKeys) &&
            fixture.socketBucketKeys.length <= 2 &&
            fixture.socketBucketKeys.every(
              (x: unknown) =>
                typeof x === 'string' && /^route:socket-token-ip:ip:[0-9a-f:.]+$/.test(x)
            )
        )
        const buckets =
          await sql`SELECT t.key AS id,md5(row_to_json(t)::text) AS digest,t.xmin::text AS version FROM rate_limit_bucket t
      WHERE t.updated_at>=${start}::timestamptz AT TIME ZONE 'UTC'
      AND ((t.key LIKE 'route:%' AND right(t.key,length(${fixture.userId})+6)=':user:'||${fixture.userId})
        OR (t.key LIKE 'route:socket-token-ip:ip:%' AND t.key = ANY(${fixture.socketBucketKeys}::text[]))) LIMIT 33`
        const residue = {
          audit_log: audit,
          outbox_event: outbox,
          rate_limit_bucket: buckets,
          verification,
        }
        assertRecipe(Object.values(residue).every((rows) => rows.length <= 32))
        writeFileSync(
          join(directory, 'residue-proof.private.json'),
          JSON.stringify({ ...residue, file_search_dispatch_queue: searchQueue }) + '\n',
          { mode: 0o600 }
        )
        const baseline = JSON.parse(readFileSync(join(directory, 'baseline.json'), 'utf8'))
        assertRecipe(baseline.length === (businessNames?.length ?? cleanupTableCount) && (!businessNames ||
          JSON.stringify(baseline.map((row: { table: string }) => row.table)) === JSON.stringify(businessNames)))
        let deleted = 0
        await sql.begin(async (tx) => {
          cleanupStage = 'residue_delete'
          for (const [table, rows] of Object.entries(residue)) {
            const key = table === 'rate_limit_bucket' ? 'key' : 'id'
            for (const row of rows) {
              const result = await tx.unsafe(
                `DELETE FROM public.${table} t WHERE t.${key}=$1 AND md5(row_to_json(t)::text)=$2 AND t.xmin::text=$3 RETURNING t.${key}`,
                [row.id, row.digest, row.version]
              )
              // A consumed token can already have been removed by native deletion.
              if (table === 'verification' && result.length === 0) {
                const present = await tx`SELECT id FROM verification WHERE id=${row.id}`
                assertRecipe(present.length === 0)
              } else assertRecipe(result.length === 1)
              deleted += result.length
            }
          }
          for (const row of searchQueue) {
            const result = await tx`DELETE FROM file_search_dispatch_queue t
      WHERE t.entity_type=${row.entityType} AND t.entity_id=${row.entityId}
      AND md5(row_to_json(t)::text)=${row.digest} AND t.xmin::text=${row.version}
      AND t.last_dispatched_at IS NULL
      AND t.enqueued_at>=${start}::timestamptz AT TIME ZONE 'UTC'
      AND t.updated_at>=${start}::timestamptz AT TIME ZONE 'UTC'
      AND NOT EXISTS (SELECT 1 FROM workspace w WHERE t.entity_type='workspace' AND w.id=t.entity_id)
      AND NOT EXISTS (SELECT 1 FROM project p WHERE t.entity_type='project' AND p.id=t.entity_id)
      RETURNING t.entity_id`
            assertRecipe(result.length === 1)
            deleted += result.length
          }
          cleanupStage = 'baseline_compare'
          cleanupIndex = -1
          for (const item of baseline) {
            cleanupIndex += 1
            assertRecipe(
              /^[a-z_0-9]+$/.test(item.table) &&
                Number.isInteger(item.count) &&
                /^[a-f0-9]{32}$/.test(item.digest)
            )
            const rows = await tx.unsafe(
              `SELECT count(*)::int AS n,md5(coalesce(string_agg(md5(row_to_json(t)::text),'' ORDER BY md5(row_to_json(t)::text)),'')) AS digest FROM public."${item.table}" t`
            )
            assertRecipe(rows[0].n === item.count && rows[0].digest === item.digest)
          }
        })
        cleanupStage = 'proof_write'
        cleanupIndex = null
        writeFileSync(
          join(directory, 'residue-cleanup.json'),
          JSON.stringify({
            nativeAccountDeleted: true,
            ...(candidate ? { allCandidateTablesComparedBeforeCommit: true, tables: cleanupTableCount } : { all183ComparedBeforeCommit: true }),
            exactVersionedRowsDeleted: deleted,
            noOutboxDelivery: true,
          }) + '\n',
          { mode: 0o600 }
        )
      } else throw new Error('fixture_mode_refused')
      writeFileSync(
        join(directory, mode + '-proof.json'),
        JSON.stringify({ mode: process.argv[2], passed: true }) + '\n',
        { mode: 0o600 }
      )
    } catch (error) {
      if (process.argv[2] === 'cleanup')
        cleanupFailure = cleanupFailureReceipt(cleanupStage, cleanupIndex, error, cleanupTableCount)
      throw error
    } finally {
      await closeOwnedConnections()
    }
  }
}
if (import.meta.main)
  await main().catch((error) => {
    try {
      writeFileSync('/scratch/ui/native-failure.private.txt',
        Buffer.from(error instanceof Error ? error.stack || error.message : 'unknown_native_failure').subarray(0, 65536),
        { mode: 0o600, flag: 'wx' })
    } catch { /* Preserve unknown/pre-existing evidence; never retry this fixture effect. */ }
    if (process.argv[2] === 'cleanup') {
      try {
        writeFileSync('/scratch/ui/cleanup-failure.private.json',
          JSON.stringify(cleanupFailure ?? cleanupFailureReceipt(cleanupStage, cleanupIndex, error)) + '\n',
          { mode: 0o600, flag: 'wx' })
      } catch { /* Preserve an existing or unknown receipt; the native refusal remains. */ }
    }
    console.error('fixture_refused')
    process.exitCode = 1
  })
