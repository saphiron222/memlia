// Copyright (c) 2026 Memlia. All rights reserved.
import { createHash, X509Certificate } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { TLSSocket } from 'node:tls'

export type AgentPeer = Readonly<{
  certificateId: string
  certificateSha256: string
  agentId: string
  installationId: string
  fqdn: string
  organizationId: string | null
  workspaceId: string
  ownerUserId: string
  windowsSid: string
}>
export type ActiveAgentCertificate = AgentPeer & Readonly<{
  certificateSerial: string
  spkiSha256: string
  certificatePem: string
  notBefore: number
  notAfter: number
}>
const refused = () => new Error('agent_peer_refused')
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/** Only the dedicated native HTTPS listener calls this boundary. Next headers,
 * forwarded certificate strings, cookies and request JSON convey no identity.
 * No Better Auth Principal is created from a certificate.
 */
export async function resolveAgentPeer(
  request: IncomingMessage,
  installation: Readonly<{ id: string; fqdn: string }>,
  readActive: (sha256: string) => Promise<ActiveAgentCertificate | null>,
): Promise<AgentPeer> {
  try {
    const socket = request.socket
    if (!(socket instanceof TLSSocket) || !socket.encrypted || !socket.authorized || socket.destroyed) throw refused()
    const raw = socket.getPeerCertificate().raw
    if (!Buffer.isBuffer(raw) || raw.length < 1 || raw.length > 16384) throw refused()
    const certificate = new X509Certificate(raw)
    const fingerprint = sha(raw)
    const row = await readActive(fingerprint)
    if (!row || socket.destroyed || !socket.authorized || sha(socket.getPeerCertificate().raw) !== fingerprint ||
      row.certificateSha256 !== fingerprint || row.installationId !== installation.id || row.fqdn !== installation.fqdn ||
      !new X509Certificate(row.certificatePem).raw.equals(raw) ||
      certificate.serialNumber.toLowerCase().replace(/^0+/, '') !== row.certificateSerial.replace(/^0+/, '') ||
      sha(certificate.publicKey.export({ type: 'spki', format: 'der' })) !== row.spkiSha256 ||
      Date.parse(certificate.validFrom) !== row.notBefore || Date.parse(certificate.validTo) !== row.notAfter ||
      Date.now() < row.notBefore || Date.now() >= row.notAfter) throw refused()
    return Object.freeze({
      certificateId: row.certificateId, certificateSha256: fingerprint,
      agentId: row.agentId, installationId: row.installationId, fqdn: row.fqdn,
      organizationId: row.organizationId, workspaceId: row.workspaceId,
      ownerUserId: row.ownerUserId, windowsSid: row.windowsSid,
    })
  } catch {
    throw refused()
  }
}
