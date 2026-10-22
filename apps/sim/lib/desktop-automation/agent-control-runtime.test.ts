// Copyright (c) 2026 Memlia. All rights reserved.
import { execFileSync, spawn } from 'node:child_process'
import { createHash, createPrivateKey } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { request } from 'node:https'
import { createServer as createProbe } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  files: new Map<string, Buffer>(),
  reads: [] as string[],
  imports: 0,
  end: vi.fn(async () => {}),
  handle: vi.fn(),
  readActive: vi.fn(),
  native: false,
  options: undefined as any,
  server: undefined as any,
  buffers: [] as Buffer[],
}))
vi.mock('./enrollment-runtime', () => ({
  readProtectedAgentRuntimeFile: (p: string, cap: number, secret: boolean) => {
    h.reads.push(p)
    const source = h.files.get(p)
    if (!source || source.length > cap) throw new Error('private-file-refused')
    expect(secret).toBe(['/secret/key', '/secret/pass'].includes(p))
    const b = Buffer.from(source)
    if (secret) h.buffers.push(b)
    return b
  },
}))
vi.mock('@sim/db', () => {
  h.imports++
  const db = { $client: { end: h.end } }
  return { db, dbReplica: db }
})
vi.mock('./agent-control-service', () => ({
  createAgentControlService: () => ({ handle: h.handle }),
}))
vi.mock('./agent-peer-repository', () => ({ readActiveAgentCertificate: h.readActive }))
vi.mock('./agent-control-server', async (original) => {
  const native = await original<typeof import('./agent-control-server')>()
  return {
    createAgentControlServer: (options: any) => {
      h.options = options
      if (h.native) {
        h.server = native.createAgentControlServer(options)
        return h.server
      }
      const server = new EventEmitter() as any
      server.listening = false
      server.listen = vi.fn((_port, _host, cb) => {
        server.listening = true
        queueMicrotask(cb)
        return server
      })
      server.close = vi.fn((cb) => {
        server.listening = false
        queueMicrotask(() => cb())
        return server
      })
      h.server = server
      return server
    },
  }
})
let root: string
let cert: Buffer
let ca: Buffer
let key: Buffer
let otherKey: Buffer
let clientCert: Buffer
const pass = Buffer.from('fictitious-runtime-passphrase-2026')
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const config = () => ({
  version: 'memlia.agent-control-runtime/v1',
  installation: { id: 'fixture-installation', fqdn: 'https://cabinet.example' },
  controlOrigin: 'https://localhost:9443',
  listenHost: '127.0.0.1',
  certificatePath: '/cert',
  certificateSha256: sha(cert),
  encryptedKeyPath: '/secret/key',
  encryptedKeySha256: sha(key),
  passphraseFilePath: '/secret/pass',
  clientCaPath: '/ca',
  clientCaSha256: sha(ca),
})
function put(value: unknown = config()) {
  h.files.set('/config', Buffer.from(JSON.stringify(value)))
}
async function start() {
  return (await import('./agent-control-runtime')).startAgentControlRuntime()
}
beforeAll(() => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'memlia-control-runtime-'))
  fs.chmodSync(root, 0o700)
  fs.writeFileSync(path.join(root, 'pass'), pass, { mode: 0o600 })
  const run = (...args: string[]) =>
    execFileSync('/opt/homebrew/opt/openssl@3/bin/openssl', args, {
      cwd: root,
      timeout: 10000,
      maxBuffer: 32768,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { NODE_ENV: 'test', HOME: process.env.HOME!, PATH: '/usr/bin:/bin' },
    })
  run(
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:P-256',
    '-passout',
    'file:pass',
    '-subj',
    '/CN=Fictitious Runtime CA',
    '-days',
    '1',
    '-keyout',
    'ca.key',
    '-out',
    'ca.pem'
  )
  run(
    'req',
    '-new',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:P-256',
    '-passout',
    'file:pass',
    '-subj',
    '/CN=localhost',
    '-keyout',
    'leaf.key',
    '-out',
    'leaf.csr'
  )
  fs.writeFileSync(
    path.join(root, 'ext'),
    'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost\n',
    { mode: 0o600 }
  )
  run(
    'x509',
    '-req',
    '-in',
    'leaf.csr',
    '-CA',
    'ca.pem',
    '-CAkey',
    'ca.key',
    '-passin',
    'file:pass',
    '-set_serial',
    '322',
    '-days',
    '1',
    '-extfile',
    'ext',
    '-out',
    'leaf.pem'
  )
  fs.writeFileSync(
    path.join(root, 'client-ext'),
    'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n',
    { mode: 0o600 }
  )
  run(
    'x509',
    '-req',
    '-in',
    'leaf.csr',
    '-CA',
    'ca.pem',
    '-CAkey',
    'ca.key',
    '-passin',
    'file:pass',
    '-set_serial',
    '323',
    '-days',
    '1',
    '-extfile',
    'client-ext',
    '-out',
    'client.pem'
  )
  clientCert = fs.readFileSync(path.join(root, 'client.pem'))
  cert = fs.readFileSync(path.join(root, 'leaf.pem'))
  ca = fs.readFileSync(path.join(root, 'ca.pem'))
  key = fs.readFileSync(path.join(root, 'leaf.key'))
  otherKey = fs.readFileSync(path.join(root, 'ca.key'))
})
afterAll(() => fs.rmSync(root, { recursive: true }))
beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  h.files.clear()
  h.reads = []
  h.imports = 0
  h.buffers = []
  h.server = undefined
  h.native = false
  process.env.MEMLIA_AGENT_CONTROL_CONFIG = '/config'
  for (const [p, b] of [
    ['/cert', cert],
    ['/ca', ca],
    ['/secret/key', key],
    ['/secret/pass', pass],
  ] as const)
    h.files.set(p, b)
  put()
  h.handle.mockResolvedValue({})
  h.readActive.mockResolvedValue(null)
  h.end.mockResolvedValue(undefined)
})
describe('dedicated control runtime', () => {
  it('absent configuration closes without reading secret or importing DB', async () => {
    Reflect.deleteProperty(process.env, 'MEMLIA_AGENT_CONTROL_CONFIG')
    expect(await start()).toBeNull()
    expect(h.reads).toEqual([])
    expect(h.imports).toBe(0)
  })
  it.each([
    (c: any) => ({ ...c, unknown: true }),
    (c: any) => ({ ...c, controlOrigin: 'http://localhost:9443' }),
    (c: any) => ({ ...c, controlOrigin: 'https://user@localhost:9443' }),
    (c: any) => ({ ...c, controlOrigin: 'https://localhost:9443/path' }),
    (c: any) => ({ ...c, certificateSha256: 'a'.repeat(64) }),
    (c: any) => ({ ...c, controlOrigin: 'https://foreign.example:9443' }),
    (c: any) => ({ ...c, listenHost: 'foreign.example' }),
  ])('malformed or wrong certificate scope cannot initialize DB', async (change) => {
    put(change(config()))
    expect(await start()).toBeNull()
    expect(h.imports).toBe(0)
  })
  it('rejects CA-as-leaf and mismatched encrypted key before DB', async () => {
    h.files.set('/cert', ca)
    put({ ...config(), certificateSha256: sha(ca) })
    expect(await start()).toBeNull()
    expect(h.imports).toBe(0)
    vi.resetModules()
    h.files.set('/cert', cert)
    h.files.set('/secret/key', otherKey)
    put({ ...config(), encryptedKeySha256: sha(otherKey) })
    expect(await start()).toBeNull()
    expect(h.imports).toBe(0)
  })
  it('never retries a failed initialization, even after file replacement', async () => {
    h.files.set('/secret/pass', Buffer.from('bad'))
    expect(await start()).toBeNull()
    h.files.set('/secret/pass', pass)
    expect(await start()).toBeNull()
    expect(h.imports).toBe(0)
    expect(h.buffers.every((b) => b.every((x) => x === 0))).toBe(true)
  })
  it('one start captures native crypto-validated TLS options then wipes input buffers', async () => {
    const [a, b] = await Promise.all([start(), start()])
    expect(a).not.toBeNull()
    expect(a).toBe(b)
    expect(h.server.listen).toHaveBeenCalledWith(9443, '127.0.0.1', expect.any(Function))
    expect(h.options.installation).toEqual(config().installation)
    expect(h.buffers.every((b) => b.every((x) => x === 0))).toBe(true)
    await a!.stop()
    expect(h.end).toHaveBeenCalledTimes(1)
  })
  it('stops own sockets but waits for handler AND peer observations before DB end', async () => {
    const runtime = await start()
    expect(runtime).not.toBeNull()
    let release!: () => void
    const work = new Promise<void>((r) => {
      release = r
    })
    h.handle.mockImplementation(() => work)
    h.readActive.mockImplementation(() => work)
    const handler = h.options.handle({}, {}, {})
    const peer = h.options.readActive('fingerprint')
    const socket = Object.assign(new EventEmitter(), { destroy: vi.fn() })
    h.server.emit('connection', socket)
    const stopping = runtime!.stop()
    await Promise.resolve()
    await Promise.resolve()
    expect(socket.destroy).toHaveBeenCalledTimes(1)
    expect(h.end).not.toHaveBeenCalled()
    await expect(h.options.handle({}, {}, {})).rejects.toThrow('control_runtime_unavailable')
    release()
    await Promise.all([handler, peer, stopping])
    expect(h.end).toHaveBeenCalledTimes(1)
    await runtime!.stop()
    expect(h.end).toHaveBeenCalledTimes(1)
  })
  it('new runtime composes the real Node mTLS listener and closes before ending doubled DB', async () => {
    const probe = createProbe()
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r))
    const address = probe.address()
    if (!address || typeof address === 'string') throw new Error('fixture_address')
    const port = address.port
    await new Promise<void>((r) => probe.close(() => r()))
    h.native = true
    put({ ...config(), controlOrigin: `https://localhost:${port}` })
    const runtime = await start()
    expect(runtime).not.toBeNull()
    try {
      const call = (certificate: boolean) =>
        new Promise<number>((resolve, reject) => {
          const r = request(
            {
              host: '127.0.0.1',
              servername: 'localhost',
              port,
              path: '/v1/agent/control',
              method: 'POST',
              ca,
              ...(certificate ? { cert: clientCert, key, passphrase: pass.toString() } : {}),
              agent: false,
              timeout: 2000,
              headers: { 'content-type': 'application/json' },
            },
            (response) => {
              response.resume()
              response.once('end', () => resolve(response.statusCode!))
            }
          )
          r.once('error', reject)
          r.once('timeout', () => r.destroy(new Error('fixture_timeout')))
          r.end('{}')
        })
      await expect(call(false)).rejects.toThrow()
      expect(await call(true)).toBe(403) // TLS succeeds; native DB authority remains denied.
      expect(h.readActive).toHaveBeenCalledTimes(1)
      expect(h.handle).not.toHaveBeenCalled()
    } finally {
      await runtime!.stop()
    }
    expect(h.end).toHaveBeenCalledTimes(1)
    expect(h.server.listening).toBe(false)
  })

  it('drain deadline reports unknown without ending the DB underneath active work', async () => {
    vi.useFakeTimers()
    try {
      const runtime = await start()
      expect(runtime).not.toBeNull()
      let release!: () => void
      h.handle.mockImplementation(
        () =>
          new Promise<void>((r) => {
            release = r
          })
      )
      const work = h.options.handle({}, {}, {})
      await Promise.resolve()
      const stopping = runtime!.stop()
      const refused = expect(stopping).rejects.toThrow('control_runtime_unavailable')
      await vi.advanceTimersByTimeAsync(20001)
      await refused
      expect(h.end).not.toHaveBeenCalled()
      release()
      await work
      await vi.advanceTimersByTimeAsync(1)
      expect(h.end).toHaveBeenCalledTimes(1)
      await expect(runtime!.stop()).rejects.toThrow('control_runtime_unavailable')
    } finally {
      vi.useRealTimers()
    }
  })
  it('expired or non-server-purpose leaf and malformed secret cannot import DB', async () => {
    h.files.set('/cert', clientCert)
    put({ ...config(), certificateSha256: sha(clientCert) })
    expect(await start()).toBeNull()
    expect(h.imports).toBe(0)
    vi.resetModules()
    h.files.set('/cert', cert)
    put()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3 * 86400000)
    try {
      expect(await start()).toBeNull()
      expect(h.imports).toBe(0)
    } finally {
      clock.mockRestore()
    }
    vi.resetModules()
    h.files.set('/secret/pass', Buffer.from('fictitious-but-with-newline\n'))
    expect(await start()).toBeNull()
    expect(h.imports).toBe(0)
  })
  it('an unexpected listener error drains resources but never reports normal closure', async () => {
    const runtime = await start()
    expect(runtime).not.toBeNull()
    h.server.emit('error', new Error('private sentinel'))
    await expect(runtime!.closed).rejects.toThrow('control_runtime_unavailable')
    expect(h.end).toHaveBeenCalledTimes(1)
  })
  it('refuses the Bun runtime before reading configuration or initializing DB', async () => {
    const prior = Object.getOwnPropertyDescriptor(process.versions, 'bun')
    Object.defineProperty(process.versions, 'bun', { configurable: true, value: '1.4.2' })
    try {
      expect(await start()).toBeNull()
      expect(h.reads).toEqual([])
      expect(h.imports).toBe(0)
    } finally {
      if (prior) Object.defineProperty(process.versions, 'bun', prior)
      else Reflect.deleteProperty(process.versions, 'bun')
    }
  })
  it('accepts encrypted CRLF PKCS8 but refuses plaintext even with a matching admin pin', async () => {
    const crlf = Buffer.from(key.toString().replaceAll('\n', '\r\n'))
    h.files.set('/secret/key', crlf)
    put({ ...config(), encryptedKeySha256: sha(crlf) })
    const runtime = await start()
    expect(runtime).not.toBeNull()
    await runtime!.stop()
    vi.resetModules()
    h.imports = 0
    const plain = createPrivateKey({ key, passphrase: pass }).export({
      type: 'pkcs8',
      format: 'pem',
    })
    const bytes = Buffer.from(plain)
    h.files.set('/secret/key', bytes)
    put({ ...config(), encryptedKeySha256: sha(bytes) })
    try {
      expect(await start()).toBeNull()
      expect(h.imports).toBe(0)
    } finally {
      bytes.fill(0)
    }
  })
  it(
    'real entry process stays owned after drain deadline and exits only after DB release',
    { timeout: 35000, skip: !process.env.MEMLIA_CONTROL_TEST_BUN },
    async () => {
      const evidence = process.env.MEMLIA_CONTROL_TEST_EVIDENCE!
      const probe = createProbe()
      await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r))
      const address = probe.address()
      if (!address || typeof address === 'string') throw new Error('fixture_address')
      const port = address.port
      await new Promise<void>((r) => probe.close(() => r()))
      const fixtureConfig = { ...config(), controlOrigin: `https://localhost:${port}` }
      fs.writeFileSync(path.join(root, 'control.json'), JSON.stringify(fixtureConfig), {
        mode: 0o600,
      })
      const files = {
        '/config': path.join(root, 'control.json'),
        '/cert': path.join(root, 'leaf.pem'),
        '/ca': path.join(root, 'ca.pem'),
        '/secret/key': path.join(root, 'leaf.key'),
        '/secret/pass': path.join(root, 'pass'),
      }
      const entered = path.join(root, 'entered')
      const release = path.join(root, 'release')
      const ended = path.join(root, 'ended')
      const modules = {
        reader: `import fs from 'node:fs';const files=${JSON.stringify(files)};export function readProtectedAgentRuntimeFile(p,cap){const b=fs.readFileSync(files[p]);if(b.length>cap)throw Error('fixture_cap');return b;}`,
        db: `import fs from 'node:fs';export const db={$client:{end:async()=>fs.writeFileSync(${JSON.stringify(ended)},'closed',{flag:'wx',mode:384})}};export const dbReplica=db;`,
        peer: `import fs from 'node:fs';export function readActiveAgentCertificate(){fs.writeFileSync(${JSON.stringify(entered)},'pending',{flag:'wx',mode:384});return new Promise(resolve=>{const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(t);resolve(null)}},25);t.unref();});}`,
        service: `export function createAgentControlService(){return {handle:async()=>{throw Error('fixture_never_authorized')}}}`,
      }
      const build = path.join(root, 'bundle.ts')
      const bundle = path.join(root, 'control.mjs')
      const entry = path.resolve('scripts/memlia-agent-control.ts')
      const generated = `const modules=${JSON.stringify(modules)};const result=await Bun.build({entrypoints:[${JSON.stringify(entry)}],outfile:${JSON.stringify(bundle)},target:'node',plugins:[{name:'explicit-test-boundaries',setup(b){b.onResolve({filter:/enrollment-runtime$/},()=>({path:'reader',namespace:'fixture'}));b.onResolve({filter:/^@sim\\/db$/},()=>({path:'db',namespace:'fixture'}));b.onResolve({filter:/agent-peer-repository$/},()=>({path:'peer',namespace:'fixture'}));b.onResolve({filter:/agent-control-service$/},()=>({path:'service',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:modules[args.path],loader:'js'}));}}]});if(!result.success || result.outputs.length!==1)throw Error('fixture_build');await Bun.write(${JSON.stringify(bundle)},result.outputs[0]);`
      fs.writeFileSync(build, generated, { mode: 0o600 })
      execFileSync(process.env.MEMLIA_CONTROL_TEST_BUN!, ['--no-env-file', build], {
        timeout: 10000,
        maxBuffer: 32768,
        env: { NODE_ENV: 'test', HOME: process.env.HOME!, PATH: '/usr/bin:/bin' },
      })
      const out = fs.openSync(path.join(evidence, 'child.stdout.private.log'), 'wx', 0o600)
      const err = fs.openSync(path.join(evidence, 'child.stderr.private.log'), 'wx', 0o600)
      let stdout = ''
      let overflow = false
      const child = spawn(process.execPath, [bundle], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          NODE_ENV: 'test',
          HOME: process.env.HOME!,
          PATH: '/usr/bin:/bin',
          MEMLIA_AGENT_CONTROL_CONFIG: '/config',
        },
      })
      let outBytes = 0
      let errBytes = 0
      child.stdout.on('data', (b: Buffer) => {
        fs.writeSync(out, b.subarray(0, Math.max(0, 8192 - outBytes)))
        outBytes += b.length
        overflow ||= outBytes > 8192
        stdout += b.subarray(0, 8192).toString()
      })
      child.stderr.on('data', (b: Buffer) => {
        fs.writeSync(err, b.subarray(0, Math.max(0, 8192 - errBytes)))
        errBytes += b.length
        overflow ||= errBytes > 8192
      })
      const exited = new Promise<number | null>((resolve, reject) => {
        child.once('exit', resolve)
        child.once('error', reject)
      })
      const wait = async (check: () => boolean, limit: number) => {
        const until = Date.now() + limit
        while (!check()) {
          if (Date.now() > until) throw Error('fixture_wait')
          await new Promise((r) => setTimeout(r, 25))
        }
      }
      let req: ReturnType<typeof request> | undefined
      try {
        await wait(() => stdout.includes('control_listening'), 4000)
        req = request({
          host: '127.0.0.1',
          servername: 'localhost',
          port,
          path: '/v1/agent/control',
          method: 'POST',
          ca,
          cert: clientCert,
          key,
          passphrase: pass.toString(),
          agent: false,
          headers: { 'content-type': 'application/json' },
        })
        req.on('error', () => {})
        req.end('{}')
        await wait(() => fs.existsSync(entered), 2000)
        child.kill('SIGTERM')
        await new Promise((r) => setTimeout(r, 20500))
        expect(child.exitCode).toBeNull()
        expect(child.signalCode).toBeNull()
        expect(fs.existsSync(ended)).toBe(false)
        expect(overflow).toBe(false)
        // The release poll is explicitly unref: it cannot keep the child alive itself.
        fs.writeFileSync(release, 'release', { flag: 'wx', mode: 0o600 })
        await wait(() => child.exitCode !== null || child.signalCode !== null, 3000)
        expect(await exited).toBe(1) // Earlier deadline remains unknown, never reclassified PASS.
        expect(fs.readFileSync(ended, 'utf8')).toBe('closed')
      } finally {
        req?.destroy()
        if (!fs.existsSync(release))
          fs.writeFileSync(release, 'release', { flag: 'wx', mode: 0o600 })
        if (child.exitCode === null && child.signalCode === null) {
          await new Promise((r) => setTimeout(r, 250))
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        }
        await exited
        fs.closeSync(out)
        fs.closeSync(err)
      }
    }
  )

  it('rejected DB closure retains a referenced owned keepalive instead of allowing exit', async () => {
    vi.useFakeTimers()
    try {
      const runtime = await start()
      expect(runtime).not.toBeNull()
      h.end.mockRejectedValue(new Error('private closure failure'))
      await expect(runtime!.stop()).rejects.toThrow('control_runtime_unavailable')
      expect(vi.getTimerCount()).toBe(1)
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })
})
