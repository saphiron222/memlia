// Copyright (c) 2026 Memlia. All rights reserved.
import { createServer, type Server, type ServerOptions } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  AGENT_ARTIFACT_CHUNK_BYTES,
  AGENT_CONTROL_BODY_BYTES,
  AgentControlRequestSchema,
  AgentControlResponseSchema,
  type AgentControlRequest,
  type AgentControlResponse,
} from '@memlia/contracts'
import { resolveAgentPeer, type ActiveAgentCertificate, type AgentPeer } from './agent-peer.ts'

export type AgentControlHandler = (
  peer: AgentPeer,
  request: AgentControlRequest,
  context: Readonly<{ signal: AbortSignal; revalidatePeer(): Promise<AgentPeer> }>,
) => Promise<AgentControlResponse>
type Options = Readonly<{
  installation: Readonly<{ id: string; fqdn: string }>
  tls: Pick<ServerOptions, 'key' | 'cert' | 'ca' | 'passphrase'>
  readActive(fingerprint: string): Promise<ActiveAgentCertificate | null>
  handle: AgentControlHandler
}>
const refused = () => new Error('control_refused')
const responseHeaders = {
  'Content-Type': 'application/json', 'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff', 'Connection': 'close',
}

function decodedChunk(data: string): Buffer {
  const bytes = Buffer.from(data, 'base64')
  if (bytes.length > AGENT_ARTIFACT_CHUNK_BYTES || bytes.toString('base64') !== data) throw refused()
  return bytes
}
function checkTransfer(request: AgentControlRequest, response?: AgentControlResponse) {
  if (request.op === 'artifact.put') {
    const end = request.offset + decodedChunk(request.dataBase64).length
    if (end > request.totalBytes || (end === request.offset && request.totalBytes !== 0)) throw refused()
    if (response?.op === 'artifact.put' &&
      (response.nextOffset !== end || response.complete !== (end === request.totalBytes) ||
        response.reference.artifactId !== request.reference.artifactId ||
        response.reference.sha256 !== request.reference.sha256)) throw refused()
  }
  if (request.op === 'artifact.read' && response?.op === 'artifact.read') {
    const bytes = decodedChunk(response.dataBase64)
    if (response.offset !== request.offset || response.reference.artifactId !== request.reference.artifactId ||
      response.reference.sha256 !== request.reference.sha256 || bytes.length > request.limit ||
      response.offset + bytes.length > response.totalBytes ||
      response.done !== (response.offset + bytes.length === response.totalBytes) ||
      (!response.done && bytes.length === 0)) throw refused()
  }
}

async function readBody(request: IncomingMessage, signal: AbortSignal) {
  const parts: Buffer[] = []
  let size = 0
  for await (const part of request) {
    signal.throwIfAborted()
    const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part)
    size += bytes.length
    if (size > AGENT_CONTROL_BODY_BYTES) throw refused()
    parts.push(bytes)
  }
  signal.throwIfAborted()
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(parts, size))
  const value: unknown = JSON.parse(text)
  // Agent requests contain ASCII identifiers, timestamps and base64 only. Compact
  // serialization is shared with Python and rejects duplicate JSON keys, BOMs,
  // alternate number encodings and ambiguous escaped-key representations.
  if (JSON.stringify(value) !== text) throw refused()
  return AgentControlRequestSchema.parse(value)
}
function send(response: ServerResponse, status: number, value: unknown) {
  if (response.destroyed || response.writableEnded) return
  const body = JSON.stringify(value)
  if (Buffer.byteLength(body, 'utf8') > AGENT_CONTROL_BODY_BYTES) throw refused()
  response.writeHead(status, responseHeaders).end(body)
}

/** Dedicated native TLS boundary. No caller can replace requestCert/trust policy,
 * supply proxy identity, or silently use a browser session as an agent principal.
 * The supplied durable service must revalidate scope inside each mutation's own
 * transaction; this listener's peer observation is not a transaction or a lease.
 */
export function createAgentControlServer(options: Options): Server {
  const { installation, readActive, handle } = options
  const identity = Object.freeze({ ...installation })
  if (!identity.id || new URL(identity.fqdn).protocol !== 'https:' ||
    new URL(identity.fqdn).origin !== identity.fqdn || !options.tls.ca ||
    !options.tls.key || !options.tls.cert) throw new Error('control_unavailable')
  let active = 0
  const server = createServer({
    key: options.tls.key, cert: options.tls.cert, ca: options.tls.ca, passphrase: options.tls.passphrase,
    requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.2',
    maxHeaderSize: 8192, handshakeTimeout: 10000,
  }, (request, response) => {
    if (active >= 32) { send(response, 503, { error: 'control_unavailable' }); return }
    active++
    const controller = new AbortController()
    const abort = () => controller.abort()
    const timer = setTimeout(() => { controller.abort(); response.destroy() }, 15000)
    response.once('close', abort)
    void (async () => {
      let admitted: AgentControlRequest | undefined
      try {
        if (request.method !== 'POST' || request.url !== '/v1/agent/control' ||
          request.headers.origin !== undefined || request.headers.cookie !== undefined ||
          !/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '') ||
          (request.headers['content-encoding'] !== undefined && request.headers['content-encoding'] !== 'identity')) throw refused()
        const peer = await resolveAgentPeer(request, identity, readActive)
        controller.signal.throwIfAborted()
        admitted = await readBody(request, controller.signal)
        checkTransfer(admitted)
        const result = AgentControlResponseSchema.parse(await handle(peer, admitted, {
          signal: controller.signal,
          revalidatePeer: async () => {
            controller.signal.throwIfAborted()
            const current = await resolveAgentPeer(request, identity, readActive)
            controller.signal.throwIfAborted()
            return current
          },
        }))
        controller.signal.throwIfAborted()
        if (result.requestId !== admitted.requestId || (result.op !== admitted.op && result.op !== 'refused')) throw refused()
        checkTransfer(admitted, result)
        send(response, 200, result)
      } catch {
        if (admitted) send(response, 200, {
          schemaVersion: 'memlia.agent-control-response/v1', requestId: admitted.requestId,
          op: 'refused', code: 'control_refused',
        })
        else send(response, 403, { error: 'control_refused' })
      } finally {
        clearTimeout(timer)
        response.removeListener('close', abort)
        active--
      }
    })()
  })
  server.maxConnections = 64
  server.maxHeadersCount = 24
  server.maxRequestsPerSocket = 1
  server.requestTimeout = 15000
  server.headersTimeout = 10000
  server.keepAliveTimeout = 1000
  server.on('clientError', (_error, socket) => socket.destroy())
  server.on('tlsClientError', (_error, socket) => socket.destroy())
  return server
}
