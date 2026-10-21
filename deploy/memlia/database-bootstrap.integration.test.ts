// Copyright (c) 2026 Memlia. All rights reserved.
// Explicit owned empty lab installation only. No application data is inserted by this test.

import { createHash, randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import postgres from 'postgres'
import { databaseBootstrap, readBootstrapConfig } from './database-bootstrap'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

const path = process.env.MEMLIA_DB_BOOTSTRAP_TEST_CONFIG
describe.skipIf(!path)('native database installation', () => {
  let loaded: Awaited<ReturnType<typeof readBootstrapConfig>>
  let admin: ReturnType<typeof postgres>
  const clients: ReturnType<typeof postgres>[] = []
  const q = (s: string) => `"${s.replaceAll('"', '""')}"`
  const connect = (url: string) => {
    const sql = postgres(url, {
      max: 1,
      connect_timeout: 3,
      onnotice: () => {},
      connection: { statement_timeout: 3000, lock_timeout: 1000 },
    })
    clients.push(sql)
    return sql
  }
  beforeAll(async () => {
    loaded = await readBootstrapConfig(path!)
    const c = loaded.config
    expect(c.database).toBe(`memlia_ui_${c.deploymentId}`)
    for (const [purpose, role] of Object.entries(c.roles))
      expect(role.name).toBe(`ui_${purpose}_${c.deploymentId}`)
    const url = new URL(c.adminUrl)
    url.pathname = `/${c.database}`
    admin = connect(url.toString())
    const [r] =
      await admin`SELECT shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()`
    expect(r.marker).toBe(`memlia.bootstrap.v1:${c.deploymentId}:database`)
    expect((await databaseBootstrap(c, loaded.configSha256, 'verify')).status).toBe('PASS')
  })
  afterAll(async () => {
    await Promise.all(clients.map((sql) => sql.end({ timeout: 2 })))
  })
  const verify = () => databaseBootstrap(loaded.config, loaded.configSha256, 'verify')
  async function catalog() {
    const rawRows = await admin`SELECT n.nspname,c.relname,c.relowner::text,c.relacl::text
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname IN ('public','drizzle','memlia_jobs')
      AND c.relkind IN ('r','p','v','m','f','S') ORDER BY n.nspname,c.relname`
    const rawSchemas = await admin`SELECT nspname,nspowner::text,nspacl::text FROM pg_namespace
      WHERE nspname IN ('public','drizzle','memlia_jobs') ORDER BY nspname`
    // Retain the bounded native representation privately before projecting its semantic hash.
    const raw = Buffer.from(JSON.stringify({ rows: rawRows, schemas: rawSchemas }))
    if (raw.length > 1024 * 1024) throw new Error('native_catalog_capture_too_large')
    await writeFile(join(loaded.config.stateDirectory, `acl-${randomUUID()}.private`), raw, {
      flag: 'wx',
      mode: 0o600,
    })
    const rows = await admin`SELECT n.nspname,c.relname,c.relowner::text,
      a.grantor::text,a.grantee::text,a.privilege_type,a.is_grantable
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,
        acldefault(CASE WHEN c.relkind='S' THEN 'S'::"char" ELSE 'r'::"char" END,c.relowner))) a
      WHERE n.nspname IN ('public','drizzle','memlia_jobs')
      AND c.relkind IN ('r','p','v','m','f','S')
      ORDER BY n.nspname,c.relname,a.grantor,a.grantee,a.privilege_type,a.is_grantable`
    const schemas = await admin`SELECT n.nspname,n.nspowner::text,
      a.grantor::text,a.grantee::text,a.privilege_type,a.is_grantable
      FROM pg_namespace n CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) a
      WHERE n.nspname IN ('public','drizzle','memlia_jobs')
      ORDER BY n.nspname,a.grantor,a.grantee,a.privilege_type,a.is_grantable`
    return createHash('sha256').update(JSON.stringify({ rows, schemas })).digest('hex')
  }
  test('native ACL representation changes from NULL to explicit after an equivalent revoke', async () => {
    const c = loaded.config
    const schema = `acl_probe_${c.deploymentId}`
    await admin.unsafe(`CREATE SCHEMA ${q(schema)} AUTHORIZATION ${q(c.roles.migrate.name)}`)
    try {
      const snapshot = () =>
        admin.unsafe(
          `SELECT nspacl::text raw,
        (SELECT jsonb_agg(jsonb_build_array(grantor,grantee,privilege_type,is_grantable)
          ORDER BY grantor,grantee,privilege_type,is_grantable)
         FROM aclexplode(COALESCE(nspacl,acldefault('n',nspowner)))) effective
        FROM pg_namespace WHERE nspname=$1`,
          [schema]
        )
      const [before] = await snapshot()
      expect(before.raw).toBeNull()
      await admin.unsafe(`GRANT CREATE ON SCHEMA ${q(schema)} TO ${q(c.roles.worker.name)}`)
      await admin.unsafe(`REVOKE CREATE ON SCHEMA ${q(schema)} FROM ${q(c.roles.worker.name)}`)
      const [after] = await snapshot()
      expect(after.raw).not.toBeNull()
      expect(after.effective).toEqual(before.effective)
    } finally {
      await admin.unsafe(`DROP SCHEMA ${q(schema)}`)
    }
  })
  test('checks effective permissions, without repairing a missing or excessive grant', async () => {
    const c = loaded.config
    const cases = [
      [
        `REVOKE SELECT ON public.workflow FROM ${q(c.roles.web.name)}`,
        `GRANT SELECT ON public.workflow TO ${q(c.roles.web.name)}`,
      ],
      [
        `GRANT TRUNCATE ON public.workflow TO ${q(c.roles.web.name)}`,
        `REVOKE TRUNCATE ON public.workflow FROM ${q(c.roles.web.name)}`,
      ],
      [
        `GRANT SELECT ON public.account TO ${q(c.roles.realtime.name)}`,
        `REVOKE SELECT ON public.account FROM ${q(c.roles.realtime.name)}`,
      ],
      [
        `GRANT SELECT ON public.workflow TO ${q(c.roles.transport.name)}`,
        `REVOKE SELECT ON public.workflow FROM ${q(c.roles.transport.name)}`,
      ],
      ['GRANT SELECT ON public.account TO PUBLIC', 'REVOKE SELECT ON public.account FROM PUBLIC'],
      [
        `GRANT CREATE ON SCHEMA drizzle TO ${q(c.roles.worker.name)}`,
        `REVOKE CREATE ON SCHEMA drizzle FROM ${q(c.roles.worker.name)}`,
      ],
    ]
    const baseline = await catalog()
    for (const [change, restore] of cases) {
      await admin.unsafe(change)
      try {
        const before = await catalog()
        await expect(verify()).rejects.toThrow('bootstrap_failed_or_reconciliation_required')
        expect(await catalog()).toBe(before)
      } finally {
        await admin.unsafe(restore)
      }
      expect((await verify()).grantsVerified).toBe(true)
    }
    expect(await catalog()).toBe(baseline)
  }, 30000)
  test('refuses runtime table ownership even when its visible ACL is only ordinary DML', async () => {
    const c = loaded.config
    const baseline = await catalog()
    await admin.unsafe(`ALTER TABLE public.workflow OWNER TO ${q(c.roles.web.name)}`)
    try {
      await admin.unsafe(`REVOKE ALL ON public.workflow FROM ${q(c.roles.web.name)}`)
      await admin.unsafe(
        `GRANT SELECT,INSERT,UPDATE,DELETE ON public.workflow TO ${q(c.roles.web.name)}`
      )
      const before = await catalog()
      await expect(verify()).rejects.toThrow('bootstrap_failed_or_reconciliation_required')
      expect(await catalog()).toBe(before)
    } finally {
      await admin.unsafe(`ALTER TABLE public.workflow OWNER TO ${q(c.roles.migrate.name)}`)
      await admin.unsafe(`GRANT ALL ON public.workflow TO ${q(c.roles.migrate.name)}`)
      await admin.unsafe(
        `GRANT SELECT,INSERT,UPDATE,DELETE ON public.workflow TO ${q(c.roles.web.name)}`
      )
    }
    expect((await verify()).grantsVerified).toBe(true)
    expect(await catalog()).toBe(baseline)
  }, 15000)
  test('keeps the native script migration ledger exclusive to migration and refuses excess grants without repair', async () => {
    const c = loaded.config
    // The runner creates this real public table in packages/db/script-migrations/index.ts.
    // Do not create a substitute ledger or change its applied migration records here.
    const [ledger] = await admin`SELECT r.oid::text oid,owner.rolname owner
      FROM pg_class r JOIN pg_namespace n ON n.oid=r.relnamespace
      JOIN pg_roles owner ON owner.oid=r.relowner
      WHERE n.nspname='public' AND r.relname='script_migrations' AND r.relkind='r'`
    expect(ledger).toBeDefined()
    expect(ledger.owner).toBe(c.roles.migrate.name)
    // OID lookup avoids requiring schema USAGE just to inspect a table privilege;
    // transport must keep its existing refusal of the public schema.
    const privileges = [
      'SELECT',
      'INSERT',
      'UPDATE',
      'DELETE',
      'TRUNCATE',
      'REFERENCES',
      'TRIGGER',
      'MAINTAIN',
    ]
    const migrate = connect(c.roles.migrate.url)
    const migrationRights = await migrate.unsafe<{ privilege: string; allowed: boolean }[]>(
      `SELECT p.privilege,has_table_privilege(current_user,$2::oid,p.privilege) allowed
      FROM unnest($1::text[]) p(privilege) ORDER BY p.privilege`,
      [`{${privileges.join(',')}}`, ledger.oid]
    )
    expect(migrationRights.length).toBe(8)
    expect(migrationRights.every((row) => row.allowed === true)).toBe(true)
    expect((await migrate`SELECT name FROM public.script_migrations LIMIT 1`).length).toBe(1)
    for (const purpose of ['web', 'worker', 'realtime', 'transport'] as const) {
      const runtime = connect(c.roles[purpose].url)
      const rights = await runtime.unsafe<{ privilege: string; allowed: boolean }[]>(
        `SELECT p.privilege,has_table_privilege(current_user,$2::oid,p.privilege) allowed
        FROM unnest($1::text[]) p(privilege) ORDER BY p.privilege`,
        [`{${privileges.join(',')}}`, ledger.oid]
      )
      expect(rights.length).toBe(8)
      expect(rights.every((row) => row.allowed === false)).toBe(true)
      let code: unknown
      try {
        await runtime`SELECT name FROM public.script_migrations LIMIT 1`
      } catch (error) {
        code = (error as { code?: unknown }).code
      }
      expect(code).toBe('42501')
    }
    const baseline = await catalog()
    await admin.unsafe(`GRANT SELECT ON public.script_migrations TO ${q(c.roles.web.name)}`)
    try {
      const before = await catalog()
      await expect(verify()).rejects.toThrow('bootstrap_failed_or_reconciliation_required')
      expect(await catalog()).toBe(before)
    } finally {
      await admin.unsafe(`REVOKE SELECT ON public.script_migrations FROM ${q(c.roles.web.name)}`)
    }
    expect((await verify()).grantsVerified).toBe(true)
    expect(await catalog()).toBe(baseline)
  }, 15000)
  test('real runtime sessions cannot read business data from transport or create business objects', async () => {
    const c = loaded.config
    const web = connect(c.roles.web.url)
    const realtime = connect(c.roles.realtime.url)
    const transport = connect(c.roles.transport.url)
    expect((await web`SELECT id FROM public.workflow LIMIT 1`).length).toBe(0)
    expect((await realtime`SELECT id FROM public.workflow LIMIT 1`).length).toBe(0)
    async function denied(sql: ReturnType<typeof postgres>, statement: string) {
      let code: unknown
      try {
        await sql.unsafe(statement)
      } catch (error) {
        code = (error as { code?: unknown }).code
      }
      expect(code).toBe('42501')
    }
    const probe = `memlia_probe_${c.deploymentId}`
    try {
      await denied(transport, 'SELECT id FROM public.workflow LIMIT 1')
      await denied(realtime, 'SELECT id FROM public.account LIMIT 1')
      await denied(web, `CREATE TABLE public.${q(probe)}(v integer)`)
      await denied(web, `CREATE TEMP TABLE ${q(probe)}(v integer)`)
      await transport.unsafe(`CREATE TABLE memlia_jobs.${q(probe)}(v integer)`)
      await transport.unsafe(`DROP TABLE memlia_jobs.${q(probe)}`)
    } finally {
      // The fixture is fresh, entirely owned, and these are the only names attempted above.
      await admin.unsafe(`DROP TABLE IF EXISTS public.${q(probe)}`)
      await admin.unsafe(`DROP TABLE IF EXISTS memlia_jobs.${q(probe)}`)
    }
    expect((await verify()).status).toBe('PASS')
  }, 15000)
  test('prepare reconciliation reads an acknowledged installation without replaying its DDL', async () => {
    const before = await catalog()
    const result = await databaseBootstrap(loaded.config, loaded.configSha256, 'prepare')
    expect(result.status).toBe('PASS')
    expect(result.grantsVerified).toBe(false)
    expect(await catalog()).toBe(before)
  })
})
