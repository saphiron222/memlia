// Copyright (c) 2026 Memlia. All rights reserved.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TLSSocket } from 'node:tls'
import test from 'node:test'
import { createAgentControlServer } from './agent-control-server.ts'
import type { ActiveAgentCertificate } from './agent-peer.ts'

test('native control listener requires mTLS and current certificate, closed JSON and bounded canonical chunks',
  { skip: !process.env.MEMLIA_PEER_TEST_OPENSSL }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'memlia-control-listener-'))
    const tool = process.env.MEMLIA_PEER_TEST_OPENSSL!
    const passphrase = 'fictitious-control-listener-2026'
    const sockets = new Set<TLSSocket>()
    let server: ReturnType<typeof createAgentControlServer> | undefined
    try {
      writeFileSync(join(root, 'passphrase'), passphrase, { mode: 0o600 })
      const openssl = (...args: string[]) => execFileSync(tool, args, {
        cwd: root, timeout: 10000, maxBuffer: 65536, stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: '/usr/bin:/bin', HOME: root },
      })
      openssl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256',
        '-passout', 'file:passphrase', '-subj', '/CN=Fictitious Control CA', '-days', '1',
        '-keyout', 'ca.key', '-out', 'ca.pem')
      openssl('req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256',
        '-passout', 'file:passphrase', '-subj', '/CN=localhost', '-keyout', 'peer.key', '-out', 'peer.csr')
      writeFileSync(join(root, 'extensions'), 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth,clientAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n', { mode: 0o600 })
      openssl('x509', '-req', '-in', 'peer.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key',
        '-passin', 'file:passphrase', '-set_serial', '1235', '-days', '1', '-extfile', 'extensions', '-out', 'peer.pem')
      const cert = readFileSync(join(root, 'peer.pem'))
      const key = readFileSync(join(root, 'peer.key'))
      const ca = readFileSync(join(root, 'ca.pem'))
      const x509 = new X509Certificate(cert)
      const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
      const installation = { id: 'fixture-installation', fqdn: 'https://localhost' }
      let row: ActiveAgentCertificate | null = {
        installationId: installation.id, fqdn: installation.fqdn, certificateId: 'fixture-certificate',
        certificateSha256: hash(x509.raw), certificateSerial: x509.serialNumber.toLowerCase(),
        spkiSha256: hash(x509.publicKey.export({ type: 'spki', format: 'der' })), certificatePem: cert.toString(),
        notBefore: Date.parse(x509.validFrom), notAfter: Date.parse(x509.validTo),
        agentId: 'fixture-agent', organizationId: null, workspaceId: 'fixture-workspace',
        ownerUserId: 'fixture-owner', windowsSid: 'S-1-5-21-11-22-33-1001',
      }
      let calls = 0
      let reads = 0
      let wrongResponse = false
      server = createAgentControlServer({ installation, tls: { cert, key, ca, passphrase },
        readActive: async () => { reads++; return row },
        handle: async (_peer, body, context) => {
          calls++
          await context.revalidatePeer()
          const base = { schemaVersion: 'memlia.agent-control-response/v1' as const, requestId: body.requestId }
          if (wrongResponse) return { ...base, requestId: 'another-request', op: 'claim', command: null }
          if (body.op === 'artifact.put') return { ...base, op: 'artifact.put', reference: body.reference,
            nextOffset: body.offset + Buffer.from(body.dataBase64, 'base64').length, complete: true }
          return { ...base, op: 'claim', command: null }
        },
      })
      server.on('secureConnection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
      await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, '127.0.0.1', resolve) })
      const address = server.address(); assert.ok(address && typeof address === 'object')
      const call = (body: string, path = '/v1/agent/control', clientCert = true) => new Promise<{ status: number; data: any }>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port: address.port, path, method: 'POST',
          ...(clientCert ? { cert, key, passphrase } : {}), ca, agent: false, timeout: 3000,
          headers: { 'content-type': 'application/json' },
        }, res => {
          let data = ''
          res.on('data', chunk => { data += chunk; if (data.length > 4096) req.destroy(new Error('fixture_limit')) })
          res.once('end', () => { try { resolve({ status: res.statusCode!, data: JSON.parse(data) }) } catch { reject(new Error('fixture_json')) } })
        })
        req.once('error', reject); req.once('timeout', () => req.destroy(new Error('fixture_timeout'))); req.end(body)
      })
      const claim = { schemaVersion: 'memlia.agent-control-request/v1', requestId: 'fixture-request',
        op: 'claim', session: { windowsSid: row.windowsSid, sessionId: 'fixture-session' } }
      assert.equal((await call(JSON.stringify(claim))).data.command, null)
      assert.equal(calls, 1); assert.equal(reads, 2)
      await assert.rejects(call(JSON.stringify(claim), '/v1/agent/control', false))
      assert.equal((await call(JSON.stringify(claim), '/v1/agent/control?scope=forged')).status, 403)
      assert.equal((await call('\ufeff' + JSON.stringify(claim))).status, 403)
      assert.equal((await call(JSON.stringify(claim).replace('"op":"claim"', '"op":"forged","op":"claim"'))).status, 403)
      assert.equal((await call(JSON.stringify({ ...claim, workspaceId: 'forged' }))).status, 403)
      const upload = { schemaVersion: claim.schemaVersion, requestId: claim.requestId, op: 'artifact.put',
        command: { commandId: 'fixture-command', digest: 'sha256:' + 'a'.repeat(64), leaseEpoch: 1 },
        capabilityId: 'fixture-capability', reference: { artifactId: 'fixture-artifact', sha256: 'sha256:' + 'a'.repeat(64) },
        offset: 0, totalBytes: 1, dataBase64: 'YQ==' }
      assert.equal((await call(JSON.stringify({ ...upload, dataBase64: 'AB==' }))).data.op, 'refused')
      assert.equal((await call(JSON.stringify({ ...upload, dataBase64: 'A'.repeat(349528), totalBytes: 262146 }))).data.op, 'refused')
      assert.equal((await call(JSON.stringify({ ...upload, offset: 1 }))).data.op, 'refused')
      assert.equal(calls, 1)
      assert.equal((await call(JSON.stringify(upload))).data.complete, true)
      wrongResponse = true
      assert.equal((await call(JSON.stringify(claim))).data.op, 'refused')
      assert.equal(calls, 3)
      row = null
      assert.equal((await call(JSON.stringify(claim))).status, 403)
      assert.equal(calls, 3)
    } finally {
      for (const socket of sockets) socket.destroy()
      if (server?.listening) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()))
      rmSync(root, { recursive: true })
    }
  })
