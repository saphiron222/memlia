// Copyright (c) 2026 Memlia. All rights reserved.
// Installation authority only. This CLI never creates a workflow, execution or job.
import { createHash, randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize } from 'node:path'
import postgres from 'postgres'

const purposes = ['migrate', 'web', 'realtime', 'worker', 'transport'] as const
type Purpose = (typeof purposes)[number]
type Phase = 'prepare' | 'grants' | 'verify'
type Role = Readonly<{ name: string; password: string; url: string }>
type Config = Readonly<{
  deploymentId: string
  database: string
  stateDirectory: string
  adminUrl: string
  roles: Readonly<Record<Purpose, Role>>
}>
type State = {
  version: 'memlia.database-bootstrap-state/v1'
  deploymentId: string
  configSha256: string
  cluster: string
  phase: 'prepare_pending' | 'prepared' | 'grants_pending' | 'granted'
}
type Row = Record<string, unknown>
type Query = (query: string, values?: string[]) => Promise<Row[]>
const identifier = /^[a-z][a-z0-9_]{0,62}$/
const exact = (pattern: RegExp, value: unknown): value is string =>
  typeof value === 'string' && pattern.test(value) && !/[\r\n\0]/.test(value)
const fail = (code = 'bootstrap_configuration_refused'): never => {
  throw new Error(code)
}
const object = (value: unknown, keys: string[]): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  const result = value as Record<string, unknown>
  if (Object.keys(result).length !== keys.length || keys.some((key) => !Object.hasOwn(result, key)))
    return fail()
  return result
}
const name = (value: unknown): string => {
  if (!exact(identifier, value) || value.startsWith('pg_') || value === 'postgres') return fail()
  return value
}
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

/** Operator configuration is captured before any asynchronous IO. No URL options or shell input. */
export function parseBootstrapConfig(value: unknown): Config {
  try {
    const c = object(value, [
      'version',
      'deploymentId',
      'database',
      'stateDirectory',
      'adminUrl',
      'urls',
    ])
    if (c.version !== 'memlia.database-bootstrap/v1' || !exact(/^[0-9a-f]{32}$/, c.deploymentId))
      return fail()
    const database = name(c.database)
    if (['template0', 'template1'].includes(database)) return fail()
    const stateDirectory = c.stateDirectory
    if (
      typeof stateDirectory !== 'string' ||
      !isAbsolute(stateDirectory) ||
      normalize(stateDirectory) !== stateDirectory ||
      stateDirectory === '/' ||
      /[\0\r\n]/.test(stateDirectory)
    )
      return fail()
    function url(raw: unknown) {
      if (typeof raw !== 'string' || raw.length > 4096 || /[\s\\?#\0]/.test(raw)) return fail()
      const u = new URL(raw)
      if (
        !['postgres:', 'postgresql:'].includes(u.protocol) ||
        !u.hostname ||
        !u.username ||
        !u.password
      )
        return fail()
      const user = decodeURIComponent(u.username)
      const password = decodeURIComponent(u.password)
      if (!exact(/^[A-Za-z0-9_-]{20,128}$/, password)) return fail()
      return {
        raw,
        user,
        password,
        host: u.hostname.toLowerCase(),
        port: u.port || '5432',
        db: decodeURIComponent(u.pathname.slice(1)),
      }
    }
    const admin = url(c.adminUrl)
    if (!exact(identifier, admin.user) || admin.db !== 'postgres') return fail()
    const urls = object(c.urls, [...purposes])
    const roles = {} as Record<Purpose, Role>
    const roleNames = new Set([admin.user])
    const passwords = new Set([admin.password])
    for (const purpose of purposes) {
      const u = url(urls[purpose])
      const roleName = name(u.user)
      if (
        u.host !== admin.host ||
        u.port !== admin.port ||
        u.db !== database ||
        roleNames.has(roleName) ||
        passwords.has(u.password)
      )
        return fail()
      roleNames.add(roleName)
      passwords.add(u.password)
      roles[purpose] = Object.freeze({ name: roleName, password: u.password, url: u.raw })
    }
    return Object.freeze({
      deploymentId: c.deploymentId,
      database,
      stateDirectory,
      adminUrl: admin.raw,
      roles: Object.freeze(roles),
    })
  } catch {
    return fail()
  }
}

function owned(stat: Stats, directory = false) {
  const uid = process.getuid?.()
  return (
    uid !== undefined &&
    stat.uid === uid &&
    !stat.isSymbolicLink() &&
    (directory
      ? stat.isDirectory() && (stat.mode & 0o077) === 0
      : stat.isFile() && stat.nlink === 1 && [0o400, 0o600].includes(stat.mode & 0o777))
  )
}
async function checkedDirectory(path: string, privateLeaf: boolean) {
  if (!isAbsolute(path) || normalize(path) !== path || (await realpath(path)) !== path)
    return fail()
  let current = path
  let child: Stats | null = null
  while (true) {
    const stat = await lstat(current)
    // A root-owned sticky temporary directory is safe only above a private owned child.
    const stickyParent =
      stat.uid === 0 && Boolean(stat.mode & 0o1000) && child && owned(child, true)
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.uid !== 0 && stat.uid !== process.getuid?.()) ||
      (stat.mode & 0o022 && !stickyParent)
    )
      return fail()
    if (current === path && privateLeaf && !owned(stat, true)) return fail()
    const parent = dirname(current)
    if (parent === current) return
    child = stat
    current = parent
  }
}
async function privateRead(path: string, limit: number) {
  await checkedDirectory(dirname(path), true)
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await fd.stat()
    if (!owned(before) || before.size > limit || before.size < 1) return fail()
    const buffer = Buffer.alloc(before.size + 1)
    let count = 0
    while (count < buffer.length) {
      const read = await fd.read(buffer, count, buffer.length - count, null)
      if (!read.bytesRead) break
      count += read.bytesRead
    }
    const after = await fd.stat()
    const pathStat = await lstat(path)
    if (
      count !== before.size ||
      !owned(after) ||
      !owned(pathStat) ||
      before.ino !== pathStat.ino ||
      before.dev !== pathStat.dev ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      return fail()
    return buffer.subarray(0, count)
  } finally {
    await fd.close()
  }
}
export async function readBootstrapConfig(path: string) {
  try {
    if (!isAbsolute(path) || normalize(path) !== path) return fail()
    const bytes = await privateRead(path, 65536)
    return {
      config: parseBootstrapConfig(JSON.parse(bytes.toString('utf8'))),
      configSha256: sha(bytes),
    }
  } catch {
    return fail()
  }
}
async function syncDirectory(path: string) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    await fd.sync()
  } finally {
    await fd.close()
  }
}
async function saveState(path: string, state: State) {
  const temporary = join(dirname(path), `.state-${randomUUID()}`)
  const fd = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  )
  try {
    await fd.writeFile(JSON.stringify(state))
    await fd.sync()
  } finally {
    await fd.close()
  }
  await rename(temporary, path)
  await syncDirectory(dirname(path))
}
function marker(c: Config, purpose: string) {
  return `memlia.bootstrap.v1:${c.deploymentId}:${purpose}`
}
const realtimeRead = [
  'user',
  'session',
  'workspace',
  'permissions',
  'member',
  'organization',
  'workflow',
  'workflow_blocks',
  'workflow_edges',
  'workflow_subflows',
  'workflow_folder',
  'audit_log',
]
const realtimeWrite = ['workflow', 'workflow_blocks', 'workflow_edges', 'workflow_subflows']
// The native script runner tracks public.script_migrations, without a leading '__'.
const excludedBusiness = ['__drizzle_migrations', '__script_migrations', 'script_migrations']
const tablePrivileges = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'TRUNCATE',
  'REFERENCES',
  'TRIGGER',
  'MAINTAIN',
]
function tableRights(purpose: Purpose, schema: string, table: string): string[] {
  if (schema !== 'public' || excludedBusiness.includes(table)) return []
  if (
    purpose === 'web' ||
    purpose === 'worker' ||
    (realtimeWrite.includes(table) && purpose === 'realtime')
  )
    return ['SELECT', 'INSERT', 'UPDATE', 'DELETE']
  if (purpose !== 'realtime') return []
  if (table === 'audit_log') return ['SELECT', 'INSERT']
  if (table === 'verification') return ['SELECT', 'DELETE']
  return realtimeRead.includes(table) ? ['SELECT'] : []
}

/** Fresh installation only. prepare never adopts, alters or deletes an existing role/database.
 * A pending journal means an unknown outcome: inspect/reconcile externally, never rerun effects. */
export async function databaseBootstrap(c: Config, configSha256: string, phase: Phase) {
  if (!exact(/^[0-9a-f]{64}$/, configSha256) || !['prepare', 'grants', 'verify'].includes(phase))
    return fail()
  // Revalidate exported API callers as well as the CLI. Config objects are otherwise immutable.
  if (!Object.isFrozen(c) || !Object.isFrozen(c.roles)) return fail()
  await checkedDirectory(dirname(c.stateDirectory), false)
  if (phase !== 'verify') {
    await mkdir(c.stateDirectory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
    await syncDirectory(dirname(c.stateDirectory))
  }
  await checkedDirectory(c.stateDirectory, true)
  const statePath = join(c.stateDirectory, `${c.deploymentId}.json`)
  const lockPath = join(c.stateDirectory, `${c.deploymentId}.lock`)
  const lock =
    phase === 'verify'
      ? null
      : await open(
          lockPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY,
          0o600
        )
  let state: State | null = null
  let cluster = ''
  let lost = false
  const clients: ReturnType<typeof postgres>[] = []
  const client = (url: string, guardSession = false) => {
    const sql = postgres(url, {
      max: 1,
      max_lifetime: null,
      connect_timeout: 5,
      idle_timeout: 5,
      fetch_types: false,
      onnotice: () => {},
      onclose: () => {
        if (guardSession) lost = true
      },
      connection: {
        application_name: 'memlia-database-bootstrap',
        statement_timeout: 15000,
        lock_timeout: 2000,
      },
    })
    clients.push(sql)
    return sql
  }
  const admin = client(c.adminUrl, true)
  let session: Awaited<ReturnType<typeof admin.reserve>> | null = null
  try {
    // postgres.js 3.4.x cannot reserve an unopened connection with fetch_types:false.
    // Open it with a bounded ordinary query; reserve then pins the advisory-lock session.
    await admin.unsafe('SELECT 1')
    session = await admin.reserve()
    const sql = session
    const [{ pid, superuser, system }] = await sql.unsafe<Row[]>(
      `SELECT pg_backend_pid() pid, (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) superuser,
       (SELECT system_identifier::text FROM pg_control_system()) system`
    )
    if (superuser !== true || typeof system !== 'string') return fail('bootstrap_admin_refused')
    cluster = system
    const q: Query = async (query, values = []) => {
      if (lost) return fail('bootstrap_connection_unknown')
      const [identity] = await sql.unsafe<Row[]>('SELECT pg_backend_pid() pid')
      if (identity.pid !== pid) return fail('bootstrap_connection_unknown')
      return sql.unsafe<Row[]>(query, values)
    }
    const [acquired] = await q('SELECT pg_try_advisory_lock(423010, hashtext($1)) locked', [
      c.database,
    ])
    if (acquired.locked !== true) return fail('bootstrap_busy')
    try {
      state = JSON.parse((await privateRead(statePath, 4096)).toString('utf8')) as State
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (
      state &&
      (Object.keys(state).sort().join(',') !== 'cluster,configSha256,deploymentId,phase,version' ||
        state.version !== 'memlia.database-bootstrap-state/v1' ||
        state.configSha256 !== configSha256 ||
        state.deploymentId !== c.deploymentId ||
        state.cluster !== cluster ||
        !['prepared', 'granted'].includes(state.phase))
    )
      return fail('bootstrap_reconciliation_required')
    if (!state && phase !== 'prepare') return fail('bootstrap_unprepared')

    if (!state) {
      const collisions = await q('SELECT datname FROM pg_database WHERE datname=$1', [c.database])
      const roleCollisions = await q('SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[])', [
        `{${purposes.map((p) => c.roles[p].name).join(',')}}`,
      ])
      if (collisions.length || roleCollisions.length)
        return fail('bootstrap_existing_resource_refused')
      state = {
        version: 'memlia.database-bootstrap-state/v1',
        deploymentId: c.deploymentId,
        configSha256,
        cluster,
        phase: 'prepare_pending',
      }
      await saveState(statePath, state)
      // No existing roles are ever changed. A partial/unknown prepare deliberately stays pending.
      for (const purpose of purposes) {
        const r = c.roles[purpose]
        await q(
          `CREATE ROLE ${quote(r.name)} LOGIN PASSWORD ${literal(r.password)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 40`
        )
        await q(`COMMENT ON ROLE ${quote(r.name)} IS ${literal(marker(c, purpose))}`)
      }
      await q(
        `CREATE DATABASE ${quote(c.database)} OWNER ${quote(c.roles.migrate.name)} TEMPLATE template0 ENCODING 'UTF8'`
      )
      await q(`COMMENT ON DATABASE ${quote(c.database)} IS ${literal(marker(c, 'database'))}`)
      await q(`REVOKE ALL ON DATABASE ${quote(c.database)} FROM PUBLIC`)
      await q(
        `GRANT CONNECT ON DATABASE ${quote(c.database)} TO ${purposes.map((p) => quote(c.roles[p].name)).join(',')}`
      )
      const dbUrl = new URL(c.adminUrl)
      dbUrl.pathname = `/${c.database}`
      const target = client(dbUrl.toString())
      await target.begin(async (tx) => {
        for (const ext of ['vector', 'pg_trgm', 'btree_gin'])
          await tx.unsafe(`CREATE EXTENSION ${quote(ext)} WITH SCHEMA public`)
        await tx.unsafe(`ALTER SCHEMA public OWNER TO ${quote(c.roles.migrate.name)}`)
        await tx.unsafe('REVOKE ALL ON SCHEMA public FROM PUBLIC')
        await tx.unsafe(
          `GRANT USAGE ON SCHEMA public TO ${['migrate', 'web', 'realtime', 'worker'].map((p) => quote(c.roles[p as Purpose].name)).join(',')}`
        )
        await tx.unsafe(`CREATE SCHEMA memlia_jobs AUTHORIZATION ${quote(c.roles.transport.name)}`)
        await tx.unsafe('REVOKE ALL ON SCHEMA memlia_jobs FROM PUBLIC')
        await tx.unsafe(`COMMENT ON SCHEMA memlia_jobs IS ${literal(marker(c, 'transport'))}`)
      })
      state.phase = 'prepared'
      await saveState(statePath, state)
    }

    // All later phases bind the database and roles to the original intent and PostgreSQL cluster.
    const [db] = await q(
      `SELECT d.datdba=(SELECT oid FROM pg_roles WHERE rolname=$2) correct_owner,
      shobj_description(d.oid,'pg_database') marker FROM pg_database d WHERE datname=$1`,
      [c.database, c.roles.migrate.name]
    )
    if (!db?.correct_owner || db.marker !== marker(c, 'database'))
      return fail('bootstrap_provenance_refused')
    for (const purpose of purposes) {
      const [r] = await q(
        `SELECT oid, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolinherit, rolcanlogin,
        shobj_description(oid,'pg_authid') marker FROM pg_roles WHERE rolname=$1`,
        [c.roles[purpose].name]
      )
      if (
        !r ||
        r.marker !== marker(c, purpose) ||
        r.rolsuper ||
        r.rolcreatedb ||
        r.rolcreaterole ||
        r.rolreplication ||
        r.rolbypassrls ||
        r.rolinherit ||
        !r.rolcanlogin
      )
        return fail('bootstrap_role_refused')
      if ((await q('SELECT 1 FROM pg_auth_members WHERE member=$1::oid', [String(r.oid)])).length)
        return fail('bootstrap_role_refused')
    }
    const dbUrl = new URL(c.adminUrl)
    dbUrl.pathname = `/${c.database}`
    const target = client(dbUrl.toString())
    const schemas = await target.unsafe<Row[]>(`SELECT n.nspname name,r.rolname owner,
      obj_description(n.oid,'pg_namespace') marker FROM pg_namespace n
      JOIN pg_roles r ON r.oid=n.nspowner WHERE n.nspname IN ('public','memlia_jobs')`)
    if (
      schemas.length !== 2 ||
      schemas.some((s) =>
        s.name === 'public'
          ? s.owner !== c.roles.migrate.name
          : s.owner !== c.roles.transport.name || s.marker !== marker(c, 'transport')
      )
    )
      return fail('bootstrap_schema_provenance_refused')
    if (phase !== 'prepare') {
      // Ownership confers ALTER/DROP and grant options even after ordinary ACLs are revoked.
      // Recheck it during verify, rather than assuming grants-phase ownership is still valid.
      const [ownership] = await target.unsafe<Row[]>(
        `SELECT
        EXISTS(SELECT 1 FROM pg_class r JOIN pg_namespace n ON n.oid=r.relnamespace
          WHERE n.nspname IN ('public','drizzle') AND r.relkind IN ('r','p','v','m','f','S')
          AND r.relowner<>(SELECT oid FROM pg_roles WHERE rolname=$1)) bad_relation,
        EXISTS(SELECT 1 FROM pg_namespace n JOIN pg_roles r ON r.oid=n.nspowner
          WHERE n.nspname IN ('public','drizzle') AND r.rolname=ANY($2::text[])) runtime_schema,
        EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          JOIN pg_roles r ON r.oid=p.proowner WHERE n.nspname IN ('public','drizzle')
          AND r.rolname=ANY($2::text[])) runtime_function,
        EXISTS(SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
          JOIN pg_roles r ON r.oid=t.typowner WHERE n.nspname IN ('public','drizzle')
          AND r.rolname=ANY($2::text[])) runtime_type`,
        [
          c.roles.migrate.name,
          `{${purposes
            .filter((p) => p !== 'migrate')
            .map((p) => c.roles[p].name)
            .join(',')}}`,
        ]
      )
      if (Object.values(ownership).some(Boolean))
        return fail('bootstrap_business_ownership_refused')
    }
    if (phase === 'grants') {
      if (state.phase !== 'prepared' && state.phase !== 'granted')
        return fail('bootstrap_reconciliation_required')
      const tables = await target.unsafe<Row[]>(
        `SELECT c.relname name, c.relowner=r.oid owned FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN pg_roles r
        WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f') AND r.rolname=$1`,
        [c.roles.migrate.name]
      )
      if (!tables.some((r) => r.name === 'workflow') || tables.some((r) => !r.owned))
        return fail('bootstrap_migration_required')
      state.phase = 'grants_pending'
      await saveState(statePath, state)
      await target.begin(async (tx) => {
        // No runtime DDL, TRUNCATE, ownership, role membership or migration-ledger rights.
        await tx.unsafe('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC')
        await tx.unsafe('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC')
        await tx.unsafe('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC')
        const functions = await tx.unsafe<
          Row[]
        >(`SELECT p.oid::regprocedure::text signature FROM pg_proc p
          JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND NOT p.prosecdef`)
        for (const purpose of ['web', 'worker', 'realtime', 'transport'] as const) {
          const role = quote(c.roles[purpose].name)
          await tx.unsafe(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${role}`)
          await tx.unsafe(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${role}`)
          await tx.unsafe(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM ${role}`)
          await tx.unsafe(`REVOKE ALL ON SCHEMA public FROM ${role}`)
          await tx.unsafe(`REVOKE ALL ON DATABASE ${quote(c.database)} FROM ${role}`)
          await tx.unsafe(`GRANT CONNECT ON DATABASE ${quote(c.database)} TO ${role}`)
          if (purpose !== 'transport') {
            await tx.unsafe(`GRANT USAGE ON SCHEMA public TO ${role}`)
            // These signatures come only from the cluster's immutable application schema,
            // not from request input. regprocedure emits quoted catalog identifiers.
            for (const f of functions)
              await tx.unsafe(`GRANT EXECUTE ON FUNCTION ${f.signature} TO ${role}`)
          }
          for (const r of tables) {
            const rights = tableRights(purpose, 'public', String(r.name))
            if (rights.length)
              await tx.unsafe(
                `GRANT ${rights.join(',')} ON TABLE public.${quote(String(r.name))} TO ${role}`
              )
          }
          if (purpose === 'web' || purpose === 'worker')
            await tx.unsafe(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`)
        }
        // Queue role retains only its own schema. pg-boss itself creates/manages queue tables.
        await tx.unsafe(
          `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${quote(c.roles.transport.name)}`
        )
        await tx.unsafe(
          `REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${quote(c.roles.transport.name)}`
        )
        await tx.unsafe(`REVOKE ALL ON SCHEMA public FROM ${quote(c.roles.transport.name)}`)
      })
    }
    // Authenticate with each actual DSN, rather than trusting a declared role name.
    for (const purpose of purposes) {
      const dbClient = client(c.roles[purpose].url)
      const [r] = await dbClient.unsafe<
        Row[]
      >(`SELECT current_user role, current_database() database,
        has_database_privilege(current_user,current_database(),'CREATE') db_create,
        has_database_privilege(current_user,current_database(),'TEMP') temp,
        has_schema_privilege(current_user,'public','CREATE') business_create,
        has_schema_privilege(current_user,'memlia_jobs','USAGE') queue_usage,
        has_schema_privilege(current_user,'memlia_jobs','CREATE') queue_create`)
      if (!r || r.role !== c.roles[purpose].name || r.database !== c.database)
        return fail('bootstrap_authentication_refused')
      if (purpose !== 'migrate' && (r.db_create || r.temp || r.business_create))
        return fail('bootstrap_runtime_ddl_refused')
      if (
        purpose === 'transport'
          ? !r.queue_usage || !r.queue_create
          : r.queue_usage || r.queue_create
      )
        return fail('bootstrap_queue_isolation_refused')
      if (purpose !== 'migrate') {
        const [extra] = await dbClient.unsafe<Row[]>(
          `SELECT EXISTS(SELECT 1 FROM pg_namespace n
          WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
          AND (n.nspname <> 'memlia_jobs' OR $1::boolean)
          AND has_schema_privilege(current_user,n.oid,'CREATE')) ddl`,
          [purpose === 'transport' ? 'false' : 'true']
        )
        if (extra.ddl) return fail('bootstrap_runtime_ddl_refused')
      }
      if (purpose === 'transport') {
        const [access] = await dbClient.unsafe<
          Row[]
        >(`SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname IN ('public','drizzle') AND c.relkind IN ('r','p','v','m','f')
          AND (has_table_privilege(current_user,c.oid,'SELECT') OR has_table_privilege(current_user,c.oid,'INSERT')
            OR has_table_privilege(current_user,c.oid,'UPDATE') OR has_table_privilege(current_user,c.oid,'DELETE'))) business`)
        if (access.business) return fail('bootstrap_transport_business_refused')
      }
      if (phase !== 'prepare' && purpose !== 'migrate') {
        // Exact *effective* ACLs catch missing grants and excess rights inherited via PUBLIC.
        // verify never repairs them. Each authenticated role queries its own effective rights.
        const rights = await dbClient.unsafe<Row[]>(
          `SELECT n.nspname schema,c.relname name,p.privilege,
          has_table_privilege(current_user,c.oid,p.privilege) allowed
          FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          CROSS JOIN unnest($1::text[]) p(privilege)
          WHERE n.nspname IN ('public','drizzle') AND c.relkind IN ('r','p','v','m','f')`,
          [`{${tablePrivileges.join(',')}}`]
        )
        if (!rights.length) return fail('bootstrap_migration_required')
        for (const right of rights)
          if (
            right.allowed !==
            tableRights(purpose, String(right.schema), String(right.name)).includes(
              String(right.privilege)
            )
          )
            return fail('bootstrap_business_acl_refused')
        const sequences = await dbClient.unsafe<Row[]>(`SELECT n.nspname schema,p.privilege,
          has_sequence_privilege(current_user,c.oid,p.privilege) allowed
          FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          CROSS JOIN unnest(ARRAY['USAGE','SELECT','UPDATE']) p(privilege)
          WHERE n.nspname IN ('public','drizzle') AND c.relkind='S'`)
        for (const right of sequences)
          if (
            right.allowed !==
            (right.schema === 'public' &&
              (purpose === 'web' || purpose === 'worker') &&
              right.privilege !== 'UPDATE')
          )
            return fail('bootstrap_sequence_acl_refused')
        const [unsafe] = await dbClient.unsafe<Row[]>(
          `SELECT EXISTS(SELECT 1 FROM pg_proc p
          JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','drizzle')
          AND (p.prosecdef OR $1::boolean) AND has_function_privilege(current_user,p.oid,'EXECUTE')) callable`,
          [purpose === 'transport' ? 'true' : 'false']
        )
        if (unsafe.callable) return fail('bootstrap_function_acl_refused')
      }
    }
    if (phase === 'grants') {
      state.phase = 'granted'
      await saveState(statePath, state)
    }
    if (phase === 'verify' && state.phase !== 'granted') return fail('bootstrap_grants_required')
    return {
      version: 'memlia.database-bootstrap-receipt/v1',
      phase,
      status: 'PASS',
      deploymentId: c.deploymentId,
      database: c.database,
      queueSchema: 'memlia_jobs',
      prepared: true,
      grantsVerified: phase !== 'prepare' && state.phase === 'granted',
      transportBusinessRead: false,
      runtimeDdl: false,
      runtimeDdlScope: 'business_roles;transport_owns_queue_schema',
    }
  } catch (error) {
    // Bounded raw native message is private, captured before reducing to the public closed code.
    // No statement, DSN or password is printed, even on a native driver error.
    const diagnostic = join(c.stateDirectory, `${c.deploymentId}-failure-${randomUUID()}.private`)
    const fd = await open(
      diagnostic,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600
    )
    try {
      const raw = error instanceof Error ? error.message : 'unknown_native_error'
      await fd.writeFile(Buffer.from(raw).subarray(0, 65536))
      await fd.sync()
    } finally {
      await fd.close()
    }
    throw new Error('bootstrap_failed_or_reconciliation_required')
  } finally {
    session?.release()
    const closed = await Promise.allSettled(clients.map((sql) => sql.end({ timeout: 3 })))
    if (lock) {
      const own = await lock.stat()
      await lock.close()
      const current = await lstat(lockPath)
      if (own.dev !== current.dev || own.ino !== current.ino || !owned(current))
        fail('bootstrap_cleanup_unknown')
      await unlink(lockPath)
      await syncDirectory(c.stateDirectory)
    }
    if (closed.some((r) => r.status === 'rejected')) fail('bootstrap_cleanup_unknown')
  }
}

if (import.meta.main) {
  let phase: Phase = 'verify'
  try {
    const args = process.argv.slice(2)
    if (
      args.length !== 4 ||
      args[0] !== '--config' ||
      args[2] !== '--phase' ||
      !['prepare', 'grants', 'verify'].includes(args[3])
    )
      fail()
    phase = args[3] as Phase
    const { config, configSha256 } = await readBootstrapConfig(args[1])
    process.stdout.write(
      `${JSON.stringify(await databaseBootstrap(config, configSha256, phase))}\n`
    )
  } catch {
    process.stdout.write(
      `${JSON.stringify({
        version: 'memlia.database-bootstrap-receipt/v1',
        phase,
        status: 'HOLD',
        reason: 'bootstrap_refused_or_reconciliation_required',
      })}\n`
    )
    process.exitCode = 1
  }
}
