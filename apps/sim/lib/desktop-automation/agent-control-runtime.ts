// Copyright (c) 2026 Memlia. All rights reserved.
import { createHash, createPrivateKey, X509Certificate } from 'node:crypto'
import type { Server } from 'node:https'
import { isIP } from 'node:net'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import { z } from 'zod'
import { createAgentControlServer } from './agent-control-server'
import { readProtectedAgentRuntimeFile as readProtected } from './enrollment-runtime'

const configPath = process.env.MEMLIA_AGENT_CONTROL_CONFIG
const refused = () => new Error('control_runtime_unavailable')
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const location = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (p) =>
      path.posix.isAbsolute(p) && path.posix.normalize(p) === p && p !== '/' && !/[\0\r\n]/.test(p)
  )
const digest = z
  .string()
  .length(64)
  .regex(/^[a-f0-9]+$/)
const origin = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const u = new URL(value)
      return u.protocol === 'https:' && u.origin === value && !u.username && !u.password
    } catch {
      return false
    }
  })
const schema = z.strictObject({
  version: z.literal('memlia.agent-control-runtime/v1'),
  installation: z.strictObject({
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/),
    fqdn: origin,
  }),
  controlOrigin: origin,
  listenHost: z.string().refine((p) => isIP(p) !== 0),
  certificatePath: location,
  certificateSha256: digest,
  encryptedKeyPath: location,
  encryptedKeySha256: digest,
  passphraseFilePath: location,
  clientCaPath: location,
  clientCaSha256: digest,
})
export type AgentControlRuntime = Readonly<{ stop(): Promise<void>; closed: Promise<void> }>
let started: Promise<AgentControlRuntime | null> | undefined
function need(ok: unknown): asserts ok {
  if (!ok) throw refused()
}
function certificate(bytes: Buffer, expected: string) {
  need(sha(bytes) === expected)
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  // One explicitly pinned certificate, no second trust anchor or trailing payload.
  need(
    /^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\r?\n?$/.test(
      text
    )
  )
  const cert = new X509Certificate(bytes)
  need(Number.isFinite(Date.parse(cert.validFrom)) && Number.isFinite(Date.parse(cert.validTo)))
  need(Date.parse(cert.validFrom) <= Date.now() && Date.now() < Date.parse(cert.validTo))
  return cert
}

async function initialize(): Promise<AgentControlRuntime | null> {
  if (!configPath) return null
  let key: Buffer | undefined
  let pass: Buffer | undefined
  let databaseClose: (() => Promise<void>) | undefined
  let server: Server | undefined
  let owned: AgentControlRuntime | undefined
  try {
    need(
      process.release.name === 'node' &&
        !process.versions.bun &&
        process.versions.node.startsWith('24.')
    )
    const config = schema.parse(
      JSON.parse(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
          readProtected(configPath, 8192, false)
        )
      )
    )
    const url = new URL(config.controlOrigin)
    const port = Number(url.port || 443)
    need(port >= 1024 && port <= 65535)
    need(
      new Set([
        config.certificatePath,
        config.encryptedKeyPath,
        config.passphraseFilePath,
        config.clientCaPath,
      ]).size === 4
    )
    const certBytes = readProtected(config.certificatePath, 16384, false)
    const caBytes = readProtected(config.clientCaPath, 16384, false)
    const cert = certificate(certBytes, config.certificateSha256)
    const ca = certificate(caBytes, config.clientCaSha256)
    const hostname = url.hostname.replace(/^\[|\]$/g, '')
    need(!cert.ca && ca.ca && ca.verify(ca.publicKey) && !cert.publicKey.equals(ca.publicKey))
    need(cert.keyUsage?.includes('1.3.6.1.5.5.7.3.1'))
    need(
      isIP(hostname)
        ? cert.checkIP(hostname)
        : cert.checkHost(hostname, {
            subject: 'never',
            wildcards: false,
            partialWildcards: false,
            multiLabelWildcards: false,
          })
    )
    key = readProtected(config.encryptedKeyPath, 32768, true)
    need(sha(key) === config.encryptedKeySha256)
    need(/^-----BEGIN ENCRYPTED PRIVATE KEY-----\r?\n/.test(key.toString('ascii')))
    pass = readProtected(config.passphraseFilePath, 1024, true)
    need(pass.length >= 16 && !pass.some((b) => b === 0 || b === 10 || b === 13))
    const privateKey = createPrivateKey({ key, passphrase: pass })
    need(cert.checkPrivateKey(privateKey))
    // TLS takes a string passphrase. It is never persisted, logged or put in argv/env;
    // unlike the read buffers, this short-lived Node/OpenSSL copy cannot be zeroized.
    const password = new TextDecoder('utf-8', { fatal: true }).decode(pass)
    // Validate TLS before importing DB; createServer is the existing native mTLS boundary.
    const pending = new Set<Promise<unknown>>()
    let stopping = false
    let fatal = false
    const track = async <T>(operation: () => Promise<T>): Promise<T> => {
      if (stopping) throw refused()
      const work = Promise.resolve().then(operation)
      pending.add(work)
      try {
        return await work
      } finally {
        pending.delete(work)
      }
    }
    server = createAgentControlServer({
      installation: Object.freeze({ ...config.installation }),
      tls: { key, cert: certBytes, ca: caBytes, passphrase: password },
      handle: (...args) => track(() => handle(...args)),
      readActive: (fingerprint) => track(() => readActive(fingerprint)),
    })
    key.fill(0)
    pass.fill(0)
    const sockets = new Set<Duplex>()
    server.on('connection', (socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      if (stopping) socket.destroy()
    })
    const { db, dbReplica } = await import('@sim/db')
    const clients = new Set([db.$client, dbReplica.$client])
    databaseClose = async () => {
      const outcomes = await Promise.allSettled(
        [...clients].map((client) => client.end({ timeout: 5 }))
      )
      need(outcomes.every((outcome) => outcome.status === 'fulfilled'))
    }
    const [service, peer] = await Promise.all([
      import('./agent-control-service'),
      import('./agent-peer-repository'),
    ])
    const handle = service.createAgentControlService().handle
    const readActive = peer.readActiveAgentCertificate
    let resolveClosed!: () => void
    let rejectClosed!: (reason: Error) => void
    const closed = new Promise<void>((resolve, reject) => {
      resolveClosed = resolve
      rejectClosed = reject
    })
    void closed.catch(() => {})
    let stopPromise: Promise<void> | undefined
    let expiry: ReturnType<typeof setTimeout> | undefined
    const nativeServer = server
    const endDatabase = databaseClose
    const stop = (): Promise<void> => {
      if (stopPromise) return stopPromise
      stopping = true
      if (expiry) clearTimeout(expiry)
      stopPromise = closed
      // Promises and signal handlers do not keep Node alive after the deadline.
      // This process-owned reference persists even on drain failure/unknown.
      const keepAlive = setInterval(() => {}, 1000)
      const deadline = setTimeout(() => rejectClosed(refused()), 20000)
      const drain = async () => {
        const networkClosed = new Promise<void>((resolve, reject) => {
          if (!nativeServer.listening) {
            resolve()
            return
          }
          nativeServer.close((error) => (error ? reject(error) : resolve()))
        })
        for (const socket of sockets) socket.destroy()
        await networkClosed
        // Closing sockets does not cancel a DB transaction already dispatched.
        // Keep its tracked promise and the process alive; never close the pool first.
        while (pending.size) await Promise.allSettled([...pending])
        await endDatabase()
      }
      void drain().then(
        () => {
          clearInterval(keepAlive) // Only acknowledged network + pending + DB closure.
          clearTimeout(deadline)
          fatal ? rejectClosed(refused()) : resolveClosed()
        },
        () => {
          clearTimeout(deadline)
          rejectClosed(refused())
        }
      )
      return stopPromise
    }
    owned = Object.freeze({ stop, closed })
    nativeServer.on('error', () => {
      fatal = true
      void stop().catch(() => {})
    })
    await new Promise<void>((resolve, reject) => {
      const failed = () => reject(refused())
      nativeServer.once('error', failed)
      nativeServer.listen(port, config.listenHost, () => {
        nativeServer.removeListener('error', failed)
        resolve()
      })
    })
    const expires = Math.min(Date.parse(cert.validTo), Date.parse(ca.validTo))
    // Node timers are limited to signed 32bit milliseconds. Recheck, never extend validity.
    const checkExpiry = () => {
      if (Date.now() >= expires) void stop().catch(() => {})
      else expiry = setTimeout(checkExpiry, Math.min(expires - Date.now(), 2147483647))
    }
    checkExpiry()
    return owned
  } catch {
    if (owned) await owned.stop()
    else {
      if (server?.listening)
        await new Promise<void>((resolve, reject) =>
          server!.close((e) => (e ? reject(refused()) : resolve()))
        )
      await databaseClose?.()
    }
    return null
  } finally {
    key?.fill(0)
    pass?.fill(0)
  }
}
/** Dedicated process only. Failure is cached; reconfiguration requires a restart. */
export function startAgentControlRuntime(): Promise<AgentControlRuntime | null> {
  started ??= initialize()
  return started
}
