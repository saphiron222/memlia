// Copyright (c) 2026 Memlia. All rights reserved.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { createServer, request } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Socket } from 'node:net'
import type { TLSSocket } from 'node:tls'
import test from 'node:test'
import { resolveAgentPeer, type ActiveAgentCertificate } from './agent-peer.ts'

const installation = { id: 'fixture-installation', fqdn: 'https://localhost' }
test('plain request and forwarded certificate headers cannot authenticate an agent', async () => {
  let reads = 0
  const socket = new Socket()
  try {
    await assert.rejects(resolveAgentPeer({ socket, headers: { 'x-client-verify': 'SUCCESS',
      'x-client-cert': 'fixture' } } as unknown as IncomingMessage, installation,
      async () => { reads++; return null }), /^Error: agent_peer_refused$/)
    assert.equal(reads, 0)
  } finally { socket.destroy() }
})

test('native mTLS binds exact certificate and fresh scope; revocation and changed bindings refuse',
  { skip: !process.env.MEMLIA_PEER_TEST_OPENSSL }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'memlia-agent-peer-'))
    const tool = process.env.MEMLIA_PEER_TEST_OPENSSL!
    const password = join(root, 'passphrase')
    writeFileSync(password, 'fictitious-native-peer-test-2026', { mode: 0o600 })
    const openssl = (...args: string[]) => execFileSync(tool, args, {
      cwd: root, timeout: 10000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', HOME: root },
    })
    const sockets = new Set<TLSSocket>()
    const sha = (raw: Uint8Array) => createHash('sha256').update(raw).digest('hex')
    let row: ActiveAgentCertificate | null = null
    let reads = 0
    const server = createServer({ requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.2' })
    try {
      openssl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256',
        '-passout', 'file:' + password, '-subj', '/CN=Fictitious Memlia Peer CA',
        '-days', '1', '-keyout', 'ca.key', '-out', 'ca.pem')
      openssl('req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256',
        '-passout', 'file:' + password, '-subj', '/CN=localhost', '-keyout', 'peer.key', '-out', 'peer.csr')
      writeFileSync(join(root, 'extensions'), 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth,clientAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n', { mode: 0o600 })
      openssl('x509', '-req', '-in', 'peer.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key',
        '-passin', 'file:' + password, '-set_serial', '1234', '-days', '1', '-extfile', 'extensions', '-out', 'peer.pem')
      const cert = readFileSync(join(root, 'peer.pem')), key = readFileSync(join(root, 'peer.key'))
      const ca = readFileSync(join(root, 'ca.pem')), x509 = new X509Certificate(cert)
      const original: ActiveAgentCertificate = {
        ...installation, installationId: installation.id, certificateId: 'fixture-certificate',
        certificateSha256: sha(x509.raw), certificateSerial: x509.serialNumber.toLowerCase(),
        spkiSha256: sha(x509.publicKey.export({ type: 'spki', format: 'der' })),
        certificatePem: cert.toString('utf8'), notBefore: Date.parse(x509.validFrom), notAfter: Date.parse(x509.validTo),
        agentId: 'fixture-agent', organizationId: null, workspaceId: 'fixture-workspace',
        ownerUserId: 'fixture-owner', windowsSid: 'S-1-5-21-11-22-33-1001',
      }
      row = original
      server.setSecureContext({ cert, key, ca, passphrase: 'fictitious-native-peer-test-2026', minVersion: 'TLSv1.2' })
      server.on('secureConnection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
      server.on('request', async (req, res) => {
        try {
          const peer = await resolveAgentPeer(req, installation, async fingerprint => {
            reads++; assert.equal(fingerprint, original.certificateSha256); return row
          })
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(peer))
        } catch { res.writeHead(403).end('agent_peer_refused') }
      })
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
      const address = server.address()
      assert.ok(address && typeof address === 'object')
      const call = () => new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port: address.port, path: '/', method: 'POST',
          cert, key, ca, passphrase: 'fictitious-native-peer-test-2026', agent: false, timeout: 3000 }, res => {
          let body = ''; res.on('data', chunk => { body += chunk; if (body.length > 4096) req.destroy(new Error('fixture_limit')) })
          res.once('end', () => resolve({ status: res.statusCode!, body }))
        })
        req.once('error', reject); req.once('timeout', () => req.destroy(new Error('fixture_timeout'))); req.end('{}')
      })
      const admitted = await call()
      assert.equal(admitted.status, 200)
      assert.equal(JSON.parse(admitted.body).ownerUserId, original.ownerUserId)
      row = null // Repository observes revoked/offboarded certificate on the next edge.
      assert.equal((await call()).status, 403)
      row = { ...original, installationId: 'foreign-installation' }
      assert.equal((await call()).status, 403)
      row = { ...original, spkiSha256: '0'.repeat(64) }
      assert.equal((await call()).status, 403)
      assert.equal(reads, 4)
    } finally {
      for (const socket of sockets) socket.destroy()
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      rmSync(root, { recursive: true })
    }
  })
