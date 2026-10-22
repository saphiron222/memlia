// Copyright (c) 2026 Memlia. All rights reserved.
import { spawn } from 'node:child_process'
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  randomUUID,
  verify,
  X509Certificate,
} from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  readSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, parse, resolve } from 'node:path'
import type {
  EnrollmentAuthority,
  EnrollmentAuthorityResult,
  EnrollmentIssuanceRequest,
} from './enrollment'
import type { CertificateRecord } from './enrollment-repository'

export interface NativeEnrollmentAuthorityConfig {
  installation: Readonly<{ id: string; fqdn: string }>
  openssl: Readonly<{ path: string; sha256: string; administratorGroupIds?: readonly number[] }>
  caCertificatePath: string
  caCertificateSha256: string
  encryptedKeyPath: string
  passphrase: Buffer
  spoolDirectory: string
  /** Explicit policy: whole days, 1..30, also bounded by CA validity. */
  certificateDays: number
}
export type NativeEnrollmentAuthority = EnrollmentAuthority & { close(): void }
const UNKNOWN = Object.freeze({ status: 'unknown' as const })
const HEX = /^[a-f0-9]{64}$/
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const refuse = (): never => {
  throw new Error('enrollment_authority_refused')
}
function requireTrue(value: unknown): asserts value {
  if (!value) refuse()
}
const uid = () => {
  requireTrue(typeof process.getuid === 'function')
  return process.getuid()
}
function directories(path: string, administratorGroups: readonly number[] | null = null) {
  requireTrue(isAbsolute(path) && resolve(path) === path && realpathSync(path) === path)
  let current = path
  while (true) {
    const s = lstatSync(current)
    requireTrue(
      s.isDirectory() &&
        !s.isSymbolicLink() &&
        (s.uid === uid() || s.uid === 0) &&
        !(s.mode & (administratorGroups === null ? 0o022 : 0o002)) &&
        (!(s.mode & 0o020) || (administratorGroups !== null && administratorGroups.includes(s.gid)))
    )
    if (current === parse(current).root) break
    current = dirname(current)
  }
}
function openChecked(
  path: string,
  maximum: number,
  privateFile: boolean,
  administratorGroups: readonly number[] = []
) {
  directories(dirname(path), privateFile ? null : administratorGroups)
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const s = fstatSync(fd)
    const named = lstatSync(path)
    requireTrue(
      s.isFile() &&
        s.nlink === 1 &&
        s.ino === named.ino &&
        s.dev === named.dev &&
        !named.isSymbolicLink()
    )
    requireTrue(
      (s.uid === uid() || (!privateFile && s.uid === 0)) &&
        !(s.mode & (privateFile ? 0o077 : 0o022)) &&
        s.size > 0 &&
        s.size <= maximum
    )
    return fd
  } catch {
    closeSync(fd)
    return refuse()
  }
}
function readAtStart(fd: number) {
  const size = fstatSync(fd).size
  const bytes = Buffer.alloc(size)
  let offset = 0
  while (offset < size) {
    const n = readSync(fd, bytes, offset, size - offset, offset)
    requireTrue(n > 0)
    offset += n
  }
  return bytes
}
function readChecked(path: string, maximum = 32768) {
  const fd = openChecked(path, maximum, true)
  try {
    const before = fstatSync(fd)
    const bytes = readFileSync(fd)
    const after = fstatSync(fd)
    requireTrue(
      before.size === bytes.length &&
        before.size === after.size &&
        before.mtimeMs === after.mtimeMs &&
        after.nlink === 1
    )
    return bytes
  } finally {
    closeSync(fd)
  }
}
function syncDirectory(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
function exclusive(path: string, bytes: string | Buffer, mode = 0o400) {
  directories(dirname(path))
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    mode
  )
  try {
    writeFileSync(fd, bytes)
    fsyncSync(fd)
    const s = fstatSync(fd)
    requireTrue(s.nlink === 1 && s.uid === uid() && !(s.mode & 0o077))
  } finally {
    closeSync(fd)
  }
  syncDirectory(dirname(path))
}
function publicKey(pem: string | Buffer) {
  const key = createPublicKey(pem)
  const d = key.asymmetricKeyDetails
  requireTrue(
    (key.asymmetricKeyType === 'rsa' &&
      d?.modulusLength !== undefined &&
      d.modulusLength >= 3072 &&
      d.modulusLength <= 8192) ||
      (key.asymmetricKeyType === 'ec' && ['prime256v1', 'secp384r1'].includes(d?.namedCurve ?? ''))
  )
  return { key, spkiSha256: sha(key.export({ format: 'der', type: 'spki' })) }
}
function binding(
  input: EnrollmentIssuanceRequest,
  installation: NativeEnrollmentAuthorityConfig['installation']
) {
  const r = { ...input }
  for (const name of ['enrollmentId', 'issuanceId', 'agentId'] as const)
    requireTrue(typeof r[name] === 'string' && UUID.test(r[name]))
  for (const name of ['bindingDigest', 'csrSha256', 'spkiSha256'] as const)
    requireTrue(typeof r[name] === 'string' && HEX.test(r[name]))
  for (const value of [r.workspaceId, r.ownerUserId, r.organizationId ?? 'personal'])
    requireTrue(
      typeof value === 'string' &&
        value.length > 0 &&
        value.length <= 256 &&
        !/[\x00-\x1f\x7f]/.test(value)
    )
  requireTrue(
    r.installationId === installation.id &&
      r.fqdn === installation.fqdn &&
      /^S-1-\d+(?:-\d+)+$/.test(r.windowsSid ?? '') &&
      (r.windowsSid?.length ?? 0) <= 184
  )
  requireTrue(
    /^[A-Za-z0-9_-]{43}$/.test(r.challenge) && Number.isSafeInteger(r.expiresAt) && r.expiresAt > 0
  )
  requireTrue(
    typeof r.csrPem === 'string' &&
      Buffer.byteLength(r.csrPem) <= 16384 &&
      sha(r.csrPem) === r.csrSha256
  )
  const digest = sha(
    JSON.stringify({
      domain: 'memlia.desktop.certificate.v1',
      enrollmentId: r.enrollmentId,
      organizationId: r.organizationId,
      workspaceId: r.workspaceId,
      ownerUserId: r.ownerUserId,
      installationId: r.installationId,
      fqdn: r.fqdn,
      windowsSid: r.windowsSid,
      csrSha256: r.csrSha256,
      spkiSha256: r.spkiSha256,
      challenge: r.challenge,
      expiresAt: r.expiresAt,
      issuanceId: r.issuanceId,
      agentId: r.agentId,
    })
  )
  requireTrue(digest === r.bindingDigest)
  return Object.freeze(r)
}
interface Intent {
  issuanceId: string
  agentId: string
  bindingDigest: string
  configurationDigest: string
  serial: string
  createdAt: number
}

/** Server-only, explicit administrator configuration. No enrollment or browser principal is created here. */
export async function createNativeEnrollmentAuthority(
  config: NativeEnrollmentAuthorityConfig | null
): Promise<NativeEnrollmentAuthority | null> {
  if (config === null) return null
  let passphrase: Buffer | undefined
  let diagnosticBase: string | undefined
  try {
    directories(config.spoolDirectory)
    const diagnosticStat = lstatSync(config.spoolDirectory)
    requireTrue(diagnosticStat.uid === uid() && (diagnosticStat.mode & 0o777) === 0o700)
    diagnosticBase = config.spoolDirectory
    requireTrue(
      process.platform !== 'win32' && /^[A-Za-z0-9_-]{1,128}$/.test(config.installation.id)
    )
    const installation = Object.freeze({ ...config.installation })
    const origin = new URL(installation.fqdn)
    requireTrue(
      origin.protocol === 'https:' &&
        origin.origin === installation.fqdn &&
        !origin.username &&
        !origin.password
    )
    requireTrue(
      Number.isInteger(config.certificateDays) &&
        config.certificateDays >= 1 &&
        config.certificateDays <= 30
    )
    const days = config.certificateDays
    requireTrue(
      Buffer.isBuffer(config.passphrase) &&
        config.passphrase.length >= 16 &&
        config.passphrase.length <= 1024 &&
        !config.passphrase.some((x) => x === 0 || x === 10 || x === 13)
    )
    passphrase = Buffer.from(config.passphrase)
    const secret = passphrase
    const executable = config.openssl.path
    const executableSha = config.openssl.sha256
    requireTrue(
      HEX.test(executableSha) && isAbsolute(executable) && realpathSync(executable) === executable
    )
    const administratorGroups = Object.freeze([...(config.openssl.administratorGroupIds ?? [])])
    requireTrue(
      administratorGroups.length <= 16 &&
        administratorGroups.every((g) => Number.isSafeInteger(g) && g >= 0)
    )
    let executableIdentity: { dev: number; ino: number } | undefined
    function checkExecutable() {
      const fd = openChecked(executable, 32 * 1024 * 1024, false, administratorGroups)
      try {
        const before = fstatSync(fd)
        requireTrue((before.mode & 0o111) !== 0 && sha(readAtStart(fd)) === executableSha)
        const after = fstatSync(fd)
        requireTrue(
          before.size === after.size && before.mtimeMs === after.mtimeMs && after.nlink === 1
        )
        if (executableIdentity)
          requireTrue(after.dev === executableIdentity.dev && after.ino === executableIdentity.ino)
        else executableIdentity = { dev: after.dev, ino: after.ino }
      } finally {
        closeSync(fd)
      }
    }
    checkExecutable()
    const caPath = config.caCertificatePath
    const keyPath = config.encryptedKeyPath
    const caBytes = readChecked(caPath)
    requireTrue(sha(caBytes) === config.caCertificateSha256)
    const ca = new X509Certificate(caBytes)
    requireTrue(
      ca.ca &&
        Date.parse(ca.validFrom) <= Date.now() &&
        Date.parse(ca.validTo) > Date.now() + days * 86400000
    )
    const encrypted = readChecked(keyPath, 32768)
    const encryptedSha = sha(encrypted)
    try {
      requireTrue(encrypted.toString('ascii').startsWith('-----BEGIN ENCRYPTED PRIVATE KEY-----'))
      const key = createPrivateKey({ key: encrypted, format: 'pem', passphrase: secret })
      requireTrue(
        sha(createPublicKey(key).export({ type: 'spki', format: 'der' })) ===
          sha(ca.publicKey.export({ type: 'spki', format: 'der' }))
      )
    } finally {
      encrypted.fill(0)
    }
    const spool = config.spoolDirectory
    directories(spool)
    const spoolIdentity = lstatSync(spool)
    requireTrue(spoolIdentity.uid === uid() && (spoolIdentity.mode & 0o777) === 0o700)
    const configurationDigest = sha(
      JSON.stringify({ installation, executableSha, caSha: sha(caBytes), encryptedSha, days })
    )
    let closed = false
    let running = 0
    function guard() {
      requireTrue(!closed)
      directories(spool)
      const s = lstatSync(spool)
      requireTrue(
        s.ino === spoolIdentity.ino &&
          s.dev === spoolIdentity.dev &&
          s.uid === uid() &&
          (s.mode & 0o777) === 0o700
      )
    }
    function privateError(error: unknown) {
      guard()
      // Only private bounded cause; no arguments, buffers, locals or public cause chain.
      exclusive(
        join(spool, `error-${randomUUID()}.private.log`),
        Buffer.from(
          error instanceof Error ? (error.stack ?? error.message) : 'native_error'
        ).subarray(0, 8192),
        0o600
      )
    }
    async function command(
      args: string[],
      input: string,
      fds: number[] = [],
      usePassphrase = false
    ) {
      guard()
      checkExecutable()
      requireTrue(running < 4 && Buffer.byteLength(input) <= 16384)
      const dir = join(spool, `operation-${randomUUID()}`)
      mkdirSync(dir, { mode: 0o700 })
      syncDirectory(spool)
      exclusive(join(dir, 'stdin.private.log'), input || '\n', 0o600)
      const outFd = openSync(
        join(dir, 'stdout.private.log'),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      )
      let errFd: number
      try {
        errFd = openSync(
          join(dir, 'stderr.private.log'),
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600
        )
      } catch (e) {
        closeSync(outFd)
        throw e
      }
      running++
      try {
        const result = await new Promise<{
          code: number | null
          timedOut: boolean
          overflow: boolean
          spawnFailed: boolean
          output: Buffer
        }>((resolveResult) => {
          checkExecutable()
          const child = spawn(executable, args, {
            cwd: spool,
            shell: false,
            detached: true,
            env: {
              PATH: '/usr/bin:/bin',
              NODE_ENV: 'production',
              LANG: 'C',
              LC_ALL: 'C',
              OPENSSL_CONF: '/dev/null',
            },
            stdio: [usePassphrase ? 'ignore' : 'pipe', 'pipe', 'pipe', 'pipe', ...fds],
          })
          let timedOut = false
          let overflow = false
          let spawnFailed = false
          let captureFailed = false
          let outSize = 0
          let errSize = 0
          const chunks: Buffer[] = []
          let killTimer: ReturnType<typeof setTimeout> | undefined
          const stop = () => {
            child.kill('SIGTERM')
            killTimer ??= setTimeout(() => child.kill('SIGKILL'), 250)
          }
          const timer = setTimeout(() => {
            timedOut = true
            stop()
          }, 10000)
          const capture = (bytes: Buffer, stdout: boolean) => {
            const maximum = stdout ? 32768 : 8192
            const size = stdout ? outSize : errSize
            const prefix = bytes.subarray(0, Math.max(0, maximum + 1 - size))
            if (prefix.length && !captureFailed) {
              try {
                writeFileSync(stdout ? outFd : errFd, prefix)
                if (stdout) chunks.push(prefix)
              } catch {
                captureFailed = true
                stop()
              }
            }
            if (stdout) outSize += prefix.length
            else errSize += prefix.length
            if (size + bytes.length > maximum) {
              overflow = true
              stop()
            }
          }
          child.stdout!.on('data', (b: Buffer) => capture(b, true))
          child.stderr!.on('data', (b: Buffer) => capture(b, false))
          child.on('error', (error) => {
            spawnFailed = true
            capture(Buffer.from(error.message), false)
          })
          const line = usePassphrase ? Buffer.concat([secret, Buffer.from('\n')]) : Buffer.alloc(0)
          const secretPipe = child.stdio[3] as import('node:stream').Writable
          secretPipe.on('error', () => {
            /* EPIPE is reflected in the native exit and captured stderr. */
          })
          child.stdin?.on('error', () => {
            /* Same finite-input EPIPE contract. */
          })
          secretPipe.end(line, () => line.fill(0))
          child.stdin?.end(input)
          child.once('close', (code) => {
            clearTimeout(timer)
            if (killTimer) clearTimeout(killTimer)
            line.fill(0)
            resolveResult({
              code,
              timedOut,
              overflow,
              spawnFailed: spawnFailed || captureFailed,
              output: Buffer.concat(chunks),
            })
          })
        })
        fsyncSync(outFd)
        fsyncSync(errFd)
        exclusive(
          join(dir, 'result.json'),
          JSON.stringify({
            code: result.code,
            timedOut: result.timedOut,
            overflow: result.overflow,
            spawnFailed: result.spawnFailed,
            stdoutBytes: result.output.length,
            childAndStreamsClosed: true,
          })
        )
        requireTrue(
          result.code === 0 && !result.timedOut && !result.overflow && !result.spawnFailed
        )
        guard()
        return result.output
      } finally {
        running--
        closeSync(outFd)
        closeSync(errFd)
      }
    }
    const version = (await command(['version'], '')).toString('ascii')
    requireTrue(/^OpenSSL 3\./.test(version))
    async function inspectCsr(pem: string) {
      requireTrue(
        typeof pem === 'string' &&
          Buffer.byteLength(pem) <= 16384 &&
          /^-----BEGIN CERTIFICATE REQUEST-----\n[\s\S]+\n-----END CERTIFICATE REQUEST-----\n?$/.test(
            pem
          )
      )
      const output = await command(['req', '-inform', 'PEM', '-verify', '-pubkey', '-noout'], pem)
      return { ...publicKey(output), csrSha256: sha(pem), pem: output }
    }
    function intentMatches(intent: Intent, r: EnrollmentIssuanceRequest) {
      requireTrue(
        intent.issuanceId === r.issuanceId &&
          intent.agentId === r.agentId &&
          intent.bindingDigest === r.bindingDigest &&
          intent.configurationDigest === configurationDigest &&
          /^[0-9a-f]{38}$/.test(intent.serial) &&
          Number.isSafeInteger(intent.createdAt)
      )
    }
    function revoked(id: string) {
      try {
        lstatSync(join(spool, `${id}.revoked.json`))
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
      }
    }
    function verifyCertificate(
      bytes: Buffer,
      r: EnrollmentIssuanceRequest,
      intent: Intent
    ): CertificateRecord {
      const cert = new X509Certificate(bytes)
      requireTrue(bytes.toString('utf8') === cert.toString())
      const notBefore = Date.parse(cert.validFrom)
      const notAfter = Date.parse(cert.validTo)
      requireTrue(
        !cert.ca &&
          cert.checkIssued(ca) &&
          cert.verify(ca.publicKey) &&
          cert.subject === `CN=${r.agentId}`
      )
      requireTrue(
        cert.serialNumber.toLowerCase().replace(/^0+/, '') === intent.serial.replace(/^0+/, '') &&
          sha(cert.publicKey.export({ type: 'spki', format: 'der' })) === r.spkiSha256
      )
      requireTrue(cert.keyUsage?.length === 1 && cert.keyUsage[0] === '1.3.6.1.5.5.7.3.2')
      requireTrue(
        cert.subjectAltName ===
          `URI:${installation.fqdn}, URI:urn:memlia:installation:${installation.id}, URI:urn:memlia:binding:${r.bindingDigest}`
      )
      requireTrue(
        notBefore >= intent.createdAt - 1000 &&
          notBefore <= intent.createdAt + 10000 &&
          notAfter - notBefore === days * 86400000 &&
          notAfter <= Date.parse(ca.validTo) &&
          notAfter > Date.now()
      )
      return Object.freeze({
        certificateSerial: cert.serialNumber.toLowerCase(),
        certificateSha256: sha(cert.raw),
        certificatePem: bytes.toString('utf8'),
        notBefore,
        notAfter,
        spkiSha256: r.spkiSha256,
      })
    }
    async function lookup(r: EnrollmentIssuanceRequest): Promise<EnrollmentAuthorityResult> {
      guard()
      if (revoked(r.issuanceId)) return UNKNOWN
      const dir = join(spool, r.issuanceId)
      directories(dir)
      requireTrue((lstatSync(dir).mode & 0o777) === 0o700)
      const intent: Intent = JSON.parse(readChecked(join(dir, 'intent.json')).toString('utf8'))
      intentMatches(intent, r)
      const receipt = JSON.parse(readChecked(join(dir, 'receipt.json')).toString('utf8'))
      const bytes = readChecked(join(dir, 'certificate.pem'))
      requireTrue(
        receipt.bindingDigest === r.bindingDigest &&
          receipt.issuanceId === r.issuanceId &&
          receipt.pemSha256 === sha(bytes)
      )
      const certificate = verifyCertificate(bytes, r, intent)
      guard()
      if (revoked(r.issuanceId)) return UNKNOWN
      return Object.freeze({
        status: 'issued',
        issuanceId: r.issuanceId,
        bindingDigest: r.bindingDigest,
        certificate,
      })
    }
    async function diagnostic<T>(fn: () => Promise<T>, unknown?: T): Promise<T> {
      try {
        return await fn()
      } catch (e) {
        privateError(e)
        if (unknown !== undefined) return unknown
        return refuse()
      }
    }
    return Object.freeze({
      close() {
        closed = true
        secret.fill(0)
      },
      verifyCsr(pem: string) {
        return diagnostic(async () => {
          const v = await inspectCsr(pem)
          return Object.freeze({ csrSha256: v.csrSha256, spkiSha256: v.spkiSha256 })
        })
      },
      verifyPossession(input: Parameters<EnrollmentAuthority['verifyPossession']>[0]) {
        const r = { ...input }
        return diagnostic(async () => {
          requireTrue(
            typeof r.challengePayload === 'string' &&
              Buffer.byteLength(r.challengePayload) <= 16384 &&
              typeof r.signature === 'string' &&
              /^[A-Za-z0-9_-]{1,1400}$/.test(r.signature)
          )
          const v = await inspectCsr(r.csrPem)
          requireTrue(v.csrSha256 === r.csrSha256 && v.spkiSha256 === r.spkiSha256)
          const sig = Buffer.from(r.signature, 'base64url')
          requireTrue(sig.toString('base64url') === r.signature)
          return verify('sha256', Buffer.from(r.challengePayload), v.key, sig)
        }, false)
      },
      async lookupIssuance(input: EnrollmentIssuanceRequest) {
        const r = binding(input, installation)
        return diagnostic(() => lookup(r), UNKNOWN as EnrollmentAuthorityResult)
      },
      async issue(input: EnrollmentIssuanceRequest) {
        const r = binding(input, installation)
        return diagnostic(async () => {
          guard()
          if (revoked(r.issuanceId)) return UNKNOWN
          const dir = join(spool, r.issuanceId)
          try {
            mkdirSync(dir, { mode: 0o700 })
            syncDirectory(spool)
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'EEXIST') return lookup(r)
            throw e
          }
          const intent: Intent = {
            issuanceId: r.issuanceId,
            agentId: r.agentId,
            bindingDigest: r.bindingDigest,
            configurationDigest,
            serial: `01${randomBytes(18).toString('hex')}`,
            createdAt: Date.now(),
          }
          exclusive(join(dir, 'intent.json'), JSON.stringify(intent)) // durable one-shot claim BEFORE native issuance
          requireTrue(r.expiresAt > Date.now())
          const key = await inspectCsr(r.csrPem)
          requireTrue(key.spkiSha256 === r.spkiSha256)
          exclusive(join(dir, 'public-key.pem'), key.pem)
          exclusive(
            join(dir, 'extensions.cnf'),
            `[agent]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\nsubjectAltName=URI:${installation.fqdn},URI:urn:memlia:installation:${installation.id},URI:urn:memlia:binding:${r.bindingDigest}\n`
          )
          const fds: number[] = []
          try {
            for (const path of [
              caPath,
              keyPath,
              join(dir, 'public-key.pem'),
              join(dir, 'extensions.cnf'),
            ])
              fds.push(openChecked(path, 32768, true))
            requireTrue(sha(readAtStart(fds[0]!)) === sha(caBytes))
            const encryptedNow = readAtStart(fds[1]!)
            try {
              requireTrue(sha(encryptedNow) === encryptedSha)
            } finally {
              encryptedNow.fill(0)
            }
            // OpenSSL opens /dev/fd anew; explicit inherited descriptors are the only key inputs.
            guard()
            requireTrue(!revoked(r.issuanceId) && r.expiresAt > Date.now())
            const bytes = await command(
              [
                'x509',
                '-new',
                '-force_pubkey',
                '/dev/fd/6',
                '-subj',
                `/CN=${r.agentId}`,
                '-CA',
                '/dev/fd/4',
                '-CAkey',
                '/dev/fd/5',
                '-passin',
                'fd:3',
                '-set_serial',
                `0x${intent.serial}`,
                '-days',
                String(days),
                '-extfile',
                '/dev/fd/7',
                '-extensions',
                'agent',
                '-sha256',
              ],
              '',
              fds,
              true
            )
            verifyCertificate(bytes, r, intent)
            guard()
            if (revoked(r.issuanceId)) return UNKNOWN
            exclusive(join(dir, 'certificate.pem'), bytes)
            exclusive(
              join(dir, 'receipt.json'),
              JSON.stringify({
                issuanceId: r.issuanceId,
                bindingDigest: r.bindingDigest,
                pemSha256: sha(bytes),
              })
            )
            return lookup(r)
          } finally {
            for (const fd of fds) closeSync(fd)
          }
        }, UNKNOWN as EnrollmentAuthorityResult)
      },
      revokeCertificate(input: Parameters<EnrollmentAuthority['revokeCertificate']>[0]) {
        const r = {
          issuanceId: input.issuanceId,
          agentId: input.agentId,
          bindingDigest: input.bindingDigest,
        }
        return diagnostic(async () => {
          guard()
          requireTrue(UUID.test(r.issuanceId) && UUID.test(r.agentId) && HEX.test(r.bindingDigest))
          const path = join(spool, `${r.issuanceId}.revoked.json`)
          const content = JSON.stringify(r)
          try {
            exclusive(path, content)
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
          }
          requireTrue(readChecked(path).toString('utf8') === content)
          return true
        }, false)
      },
    })
  } catch (error) {
    passphrase?.fill(0)
    if (diagnosticBase) {
      try {
        exclusive(
          join(diagnosticBase, `configuration-${randomUUID()}.private.log`),
          Buffer.from(
            error instanceof Error ? (error.stack ?? error.message) : 'configuration_error'
          ).subarray(0, 8192),
          0o600
        )
      } catch {
        /* Unwritable diagnostics cannot authorize any operation. */
      }
    }
    return refuse()
  }
}
