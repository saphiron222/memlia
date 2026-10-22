// Copyright (c) 2026 Memlia. All rights reserved.
import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  X509Certificate,
} from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createNativeEnrollmentAuthority } from './enrollment-authority'
import type { EnrollmentIssuanceRequest } from './enrollment'

const binary = realpathSync(
  process.env.MEMLIA_TEST_OPENSSL3_PATH ??
    (process.platform === 'darwin' ? '/opt/homebrew/opt/openssl@3/bin/openssl' : '/usr/bin/openssl')
)
const hash = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')
let root: string
let caPath: string
let keyPath: string
let csr: string
let agentKey: ReturnType<typeof createPrivateKey>
const password = Buffer.from('FICTIVE-ONLY-test-passphrase-8923')
function native(args: string[], input?: string) {
  return execFileSync(binary, args, {
    input,
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 65536,
    env: { PATH: '/usr/bin:/bin', NODE_ENV: 'production', OPENSSL_CONF: '/dev/null' },
  })
}
async function nativeWithPassphrase(args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(binary, args, {
      detached: true,
      env: { PATH: '/usr/bin:/bin', NODE_ENV: 'test', OPENSSL_CONF: '/dev/null' },
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    })
    const output: Buffer[] = []
    const errors: Buffer[] = []
    let total = 0
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000)
    child.stdout!.on('data', (b: Buffer) => {
      total += b.length
      if (total > 65536) child.kill('SIGKILL')
      else output.push(b)
    })
    child.stderr!.on('data', (b: Buffer) => {
      total += b.length
      if (total > 65536) child.kill('SIGKILL')
      else errors.push(b)
    })
    child.on('error', reject)
    const fd3 = child.stdio[3] as import('node:stream').Writable
    fd3.on('error', () => {})
    fd3.end(Buffer.concat([password, Buffer.from('\n')]))
    child.once('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(Buffer.concat(output).toString())
      else {
        process.stderr.write(Buffer.concat(errors))
        reject(Error('fictive_ca_fd3_failed'))
      }
    })
  })
}
function configuration(name: string) {
  const spoolDirectory = join(root, name)
  mkdirSync(spoolDirectory, { mode: 0o700 })
  return {
    installation: {
      id: 'fixture-installation',
      fqdn: 'https://fixture.example:443'.replace(':443', ''),
    },
    openssl: {
      path: binary,
      sha256: hash(readFileSync(binary)),
      administratorGroupIds: process.platform === 'darwin' ? [80] : [],
    },
    caCertificatePath: caPath,
    caCertificateSha256: hash(readFileSync(caPath)),
    encryptedKeyPath: keyPath,
    passphrase: password,
    spoolDirectory,
    certificateDays: 1,
  }
}
async function request(
  authority: NonNullable<Awaited<ReturnType<typeof createNativeEnrollmentAuthority>>>
) {
  const verified = await authority.verifyCsr(csr)
  const binding = {
    domain: 'memlia.desktop.certificate.v1',
    enrollmentId: randomUUID(),
    organizationId: null,
    workspaceId: 'fixture-space',
    ownerUserId: 'fixture-owner',
    installationId: 'fixture-installation',
    fqdn: 'https://fixture.example',
    windowsSid: 'S-1-5-21-123-456-789-1001',
    ...verified,
    challenge: 'a'.repeat(43),
    expiresAt: Date.now() + 300000,
    issuanceId: randomUUID(),
    agentId: randomUUID(),
  }
  const { domain: _, ...fields } = binding
  return {
    ...fields,
    bindingDigest: hash(JSON.stringify(binding)),
    csrPem: csr,
  } as EnrollmentIssuanceRequest
}
beforeAll(async () => {
  root = mkdtempSync(join(realpathSync(process.cwd()), '.fictive-enrollment-ca-'))
  chmodSync(root, 0o700)
  const ca = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  keyPath = join(root, 'ca.encrypted.pem')
  caPath = join(root, 'ca.pem')
  writeFileSync(
    keyPath,
    ca.privateKey.export({
      format: 'pem',
      type: 'pkcs8',
      cipher: 'aes-256-cbc',
      passphrase: password,
    }),
    { mode: 0o600 }
  )
  expect(
    createPrivateKey({ key: readFileSync(keyPath), passphrase: password }).asymmetricKeyType
  ).toBe('ec')
  // Dedicated finite FD3 with LF and EOF; stdin is not the password channel.
  await nativeWithPassphrase([
    'req',
    '-new',
    '-x509',
    '-passin',
    'fd:3',
    '-key',
    keyPath,
    '-subj',
    '/CN=Fictive enrollment tests',
    '-days',
    '3',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-out',
    caPath,
  ])
  chmodSync(caPath, 0o600)
  const agent = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  agentKey = agent.privateKey
  const agentPath = join(root, 'agent.pem')
  writeFileSync(agentPath, agent.privateKey.export({ format: 'pem', type: 'pkcs8' }), {
    mode: 0o600,
  })
  csr = native([
    'req',
    '-new',
    '-key',
    agentPath,
    '-subj',
    '/CN=UNTRUSTED-CSR',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'extendedKeyUsage=serverAuth',
    '-addext',
    'subjectAltName=DNS:foreign.example',
  ])
})
afterAll(() => {
  if (root) rmSync(root, { recursive: true })
  password.fill(0)
})
describe('native configured enrollment authority (fictive CA, no system trust)', () => {
  it('refuses absent configuration without an authority', async () => {
    expect(await createNativeEnrollmentAuthority(null)).toBeNull()
  })
  it('verifies native CSR self-signature and exact Node proof of possession', async () => {
    const a = (await createNativeEnrollmentAuthority(configuration('proof')))!
    try {
      const v = await a.verifyCsr(csr)
      expect(v.csrSha256).toBe(hash(csr))
      const challengePayload = 'exact-challenge-☕'
      const signature = sign('sha256', Buffer.from(challengePayload), agentKey).toString(
        'base64url'
      )
      expect(await a.verifyPossession({ csrPem: csr, ...v, challengePayload, signature })).toBe(
        true
      )
      expect(
        await a.verifyPossession({
          csrPem: csr,
          ...v,
          challengePayload: challengePayload + 'x',
          signature,
        })
      ).toBe(false)
      await expect(a.verifyCsr(csr.replace(/MI/, 'NI'))).rejects.toThrow(
        'enrollment_authority_refused'
      )
    } finally {
      a.close()
    }
  })
  it('issues once durably, strips hostile CSR extensions and survives a new authority instance', async () => {
    const c = configuration('issue')
    const a = (await createNativeEnrollmentAuthority(c))!
    const r = await request(a)
    const results = await Promise.all([a.issue(r), a.issue(r)])
    const issued = results.find((x) => x.status === 'issued')!
    expect(issued.status).toBe('issued')
    if (issued.status !== 'issued') throw Error('test_missing_certificate')
    const cert = new X509Certificate(issued.certificate.certificatePem)
    expect(cert.ca).toBe(false)
    expect(cert.subject).toBe(`CN=${r.agentId}`)
    expect(cert.keyUsage).toEqual(['1.3.6.1.5.5.7.3.2'])
    expect(cert.subjectAltName).not.toContain('foreign.example')
    expect(cert.verify(new X509Certificate(readFileSync(caPath)).publicKey)).toBe(true)
    a.close()
    const b = (await createNativeEnrollmentAuthority(c))!
    try {
      expect(await b.lookupIssuance(r)).toEqual(issued)
      expect(await b.issue(r)).toEqual(issued)
    } finally {
      b.close()
    }
  })
  it('refuses mismatched immutable bindings and cannot revive a local revocation', async () => {
    const a = (await createNativeEnrollmentAuthority(configuration('revoke')))!
    try {
      const r = await request(a)
      expect((await a.issue(r)).status).toBe('issued')
      expect(await a.revokeCertificate(r)).toBe(true)
      expect((await a.lookupIssuance(r)).status).toBe('unknown')
      expect((await a.issue(r)).status).toBe('unknown')
      await expect(a.issue({ ...r, ownerUserId: 'foreign' })).rejects.toThrow(
        'enrollment_authority_refused'
      )
    } finally {
      a.close()
    }
  })
  it('leaves a durable uncertain intent non-reissuable after acknowledgement loss', async () => {
    const c = configuration('unknown')
    const a = (await createNativeEnrollmentAuthority(c))!
    const r = await request(a)
    try {
      expect((await a.issue(r)).status).toBe('issued')
      rmSync(join(c.spoolDirectory, r.issuanceId, 'receipt.json'))
      const certBefore = readFileSync(join(c.spoolDirectory, r.issuanceId, 'certificate.pem'))
      expect((await a.issue(r)).status).toBe('unknown')
      expect((await a.lookupIssuance(r)).status).toBe('unknown')
      expect(readFileSync(join(c.spoolDirectory, r.issuanceId, 'certificate.pem'))).toEqual(
        certBefore
      )
    } finally {
      a.close()
    }
  })
  it('rejects a well-formed CSR with a corrupted native self-signature', async () => {
    const a = (await createNativeEnrollmentAuthority(configuration('bad-signature')))!
    try {
      const der = Buffer.from(csr.replace(/-----[^-]+-----/g, '').replace(/\s/g, ''), 'base64')
      der[der.length - 1] ^= 1
      const changed =
        '-----BEGIN CERTIFICATE REQUEST-----\n' +
        der
          .toString('base64')
          .match(/.{1,64}/g)!
          .join('\n') +
        '\n-----END CERTIFICATE REQUEST-----\n'
      await expect(a.verifyCsr(changed)).rejects.toThrow('enrollment_authority_refused')
    } finally {
      a.close()
    }
  })
  it('admits RSA3072 and P384 but rejects RSA2048 and P521 using native CSRs', async () => {
    const a = (await createNativeEnrollmentAuthority(configuration('key-policy')))!
    try {
      for (const [kind, size, allowed] of [
        ['rsa', 3072, true],
        ['ec', 'secp384r1', true],
        ['rsa', 2048, false],
        ['ec', 'secp521r1', false],
      ] as const) {
        const pair =
          kind === 'rsa'
            ? generateKeyPairSync('rsa', { modulusLength: size as number })
            : generateKeyPairSync('ec', { namedCurve: size as string })
        const path = join(root, `policy-${size}.pem`)
        writeFileSync(path, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), {
          mode: 0o600,
        })
        const pem = native(['req', '-new', '-key', path, '-subj', '/CN=Fictive-policy'])
        if (allowed) expect((await a.verifyCsr(pem)).csrSha256).toBe(hash(pem))
        else await expect(a.verifyCsr(pem)).rejects.toThrow('enrollment_authority_refused')
      }
    } finally {
      a.close()
    }
  })
  it('honors durable revocation before any signing claim and refuses symlink publication', async () => {
    const c = configuration('pre-revoke')
    const a = (await createNativeEnrollmentAuthority(c))!
    try {
      const r = await request(a)
      expect(await a.revokeCertificate(r)).toBe(true)
      expect((await a.issue(r)).status).toBe('unknown')
      expect(existsSync(join(c.spoolDirectory, r.issuanceId))).toBe(false)
      const second = await request(a)
      expect((await a.issue(second)).status).toBe('issued')
      const certPath = join(c.spoolDirectory, second.issuanceId, 'certificate.pem')
      const bytes = readFileSync(certPath)
      const other = join(root, 'foreign-public.pem')
      writeFileSync(other, bytes, { mode: 0o600 })
      rmSync(certPath)
      symlinkSync(other, certPath)
      expect((await a.lookupIssuance(second)).status).toBe('unknown')
      expect((await a.issue(second)).status).toBe('unknown')
      expect(readFileSync(other)).toEqual(bytes)
    } finally {
      a.close()
    }
  })
  it('refuses administrator tool or parent world-write before native commands', async () => {
    const c = configuration('world-write')
    const dir = join(root, 'tool-parent')
    mkdirSync(dir, { mode: 0o700 })
    const tool = join(dir, 'openssl')
    writeFileSync(tool, readFileSync(binary), { mode: 0o755 })
    const copy = { ...c, openssl: { path: tool, sha256: c.openssl.sha256 } }
    chmodSync(tool, 0o757)
    await expect(createNativeEnrollmentAuthority(copy)).rejects.toThrow(
      'enrollment_authority_refused'
    )
    chmodSync(tool, 0o755)
    chmodSync(dir, 0o707)
    try {
      await expect(createNativeEnrollmentAuthority(copy)).rejects.toThrow(
        'enrollment_authority_refused'
      )
    } finally {
      chmodSync(dir, 0o700)
    }
  })
  it.each(['content', 'symlink', 'inode'])(
    'revalidates the pinned executable before each spawn: %s substitution',
    async (substitution) => {
      const c = configuration(`tool-${substitution}`)
      const tool = join(root, `openssl-${substitution}`)
      writeFileSync(tool, readFileSync(binary), { mode: 0o755 })
      const a = (await createNativeEnrollmentAuthority({
        ...c,
        openssl: { path: tool, sha256: c.openssl.sha256 },
      }))!
      try {
        if (substitution === 'inode') {
          renameSync(tool, tool + '.retained')
          writeFileSync(tool, readFileSync(binary), { mode: 0o755 })
        } else if (substitution === 'symlink') {
          rmSync(tool)
          symlinkSync(binary, tool)
        } else {
          writeFileSync(tool, Buffer.from('changed-not-executable'))
        }
        await expect(a.verifyCsr(csr)).rejects.toThrow('enrollment_authority_refused')
      } finally {
        a.close()
      }
    }
  )
  it('refuses group-writable tool ancestors unless their group is explicitly recognized', async () => {
    const c = configuration('group-policy')
    const dir = join(root, 'group-tool-parent')
    mkdirSync(dir, { mode: 0o700 })
    const tool = join(dir, 'openssl')
    writeFileSync(tool, readFileSync(binary), { mode: 0o755 })
    chmodSync(dir, 0o770)
    try {
      await expect(
        createNativeEnrollmentAuthority({
          ...c,
          openssl: { path: tool, sha256: c.openssl.sha256, administratorGroupIds: [] },
        })
      ).rejects.toThrow('enrollment_authority_refused')
    } finally {
      chmodSync(dir, 0o700)
    }
  })
  it('rejects final LF in configured IDs, binding fields and revocation before effects', async () => {
    const c = configuration('exact-end')
    let configured = false
    try {
      const unexpected = await createNativeEnrollmentAuthority({
        ...c,
        installation: { ...c.installation, id: `${c.installation.id}\n` },
      })
      configured = true
      unexpected?.close()
    } catch {
      /* expected fixed refusal */
    }
    const a = (await createNativeEnrollmentAuthority(c))!
    const values = {
      enrollmentId: randomUUID(),
      organizationId: null,
      workspaceId: 'fixture-space',
      ownerUserId: 'fixture-owner',
      installationId: c.installation.id,
      fqdn: c.installation.fqdn,
      windowsSid: 'S-1-5-21-123-456-789-1001',
      csrSha256: hash('never parsed'),
      spkiSha256: 'a'.repeat(64),
      challenge: 'a'.repeat(43),
      expiresAt: 1,
      issuanceId: randomUUID(),
      agentId: randomUUID(),
    }
    const refused: string[] = []
    try {
      // Even a regression in validation cannot reach signing with this expired sentinel.
      for (const field of [
        'enrollmentId',
        'issuanceId',
        'agentId',
        'windowsSid',
        'challenge',
      ] as const) {
        const changed = { ...values, issuanceId: randomUUID(), [field]: `${values[field]}\n` }
        const r = {
          ...changed,
          bindingDigest: hash(
            JSON.stringify({ domain: 'memlia.desktop.certificate.v1', ...changed })
          ),
          csrPem: 'never parsed',
        }
        try {
          await a.issue(r)
        } catch (e) {
          if (e instanceof Error && e.message === 'enrollment_authority_refused')
            refused.push(field)
        }
      }
      const revoked = await a.revokeCertificate({
        issuanceId: randomUUID(),
        agentId: values.agentId,
        bindingDigest: `${'a'.repeat(64)}\n`,
      })
      expect({ configured, refused, revoked }).toEqual({
        configured: false,
        refused: ['enrollmentId', 'issuanceId', 'agentId', 'windowsSid', 'challenge'],
        revoked: false,
      })
      expect(
        readdirSync(c.spoolDirectory).filter(
          (name) => !name.startsWith('operation-') && !name.endsWith('.private.log')
        )
      ).toEqual([])
    } finally {
      a.close()
    }
  })
  it('refuses executable pin mismatch, unsafe key permissions and symlink spool', async () => {
    const c = configuration('invalid')
    await expect(
      createNativeEnrollmentAuthority({ ...c, openssl: { ...c.openssl, sha256: '0'.repeat(64) } })
    ).rejects.toThrow('enrollment_authority_refused')
    chmodSync(keyPath, 0o644)
    try {
      await expect(createNativeEnrollmentAuthority(c)).rejects.toThrow(
        'enrollment_authority_refused'
      )
    } finally {
      chmodSync(keyPath, 0o600)
    }
    const link = join(root, 'spool-link')
    symlinkSync(c.spoolDirectory, link)
    await expect(createNativeEnrollmentAuthority({ ...c, spoolDirectory: link })).rejects.toThrow(
      'enrollment_authority_refused'
    )
    expect(existsSync(join(c.spoolDirectory, 'certificate.pem'))).toBe(false)
  })
})
