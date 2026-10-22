// Copyright (c) 2026 Memlia. All rights reserved.
import { AgentControlRequestSchema, type AgentControlResponse } from '@memlia/contracts'
import { createAgentArtifactStore } from './agent-artifact-store'
import { createAgentCommandRepository } from './agent-command-repository'
import type { AgentControlHandler } from './agent-control-server'

/** Production composition. No caller-supplied storage URL, SQL, identity,
 * capability issuer or model decision can replace the durable repositories.
 */
export function createAgentControlService() {
  const artifacts = createAgentArtifactStore()
  const commands = createAgentCommandRepository({ artifacts })
  const handle: AgentControlHandler = async (_observed, raw, context) => {
    const request = AgentControlRequestSchema.parse(raw)
    const peer = await context.revalidatePeer()
    context.signal.throwIfAborted()
    const base = {
      schemaVersion: 'memlia.agent-control-response/v1' as const,
      requestId: request.requestId,
    }
    const refused = (): AgentControlResponse => ({
      ...base,
      op: 'refused',
      code: 'control_refused',
    })
    switch (request.op) {
      case 'claim':
        return { ...base, op: 'claim', command: await commands.claim(peer, request) }
      case 'checkpoint':
        return (await commands.checkpoint(peer, request))
          ? { ...base, op: 'checkpoint', accepted: true }
          : refused()
      case 'consent': {
        const capability = await commands.consent(peer, request)
        return capability ? { ...base, op: 'consent', capability } : refused()
      }
      case 'artifact.read': {
        const result = await commands.withAuthorizedArtifact(
          peer,
          request.command,
          request.capabilityId,
          'read',
          request.reference,
          (tx, scope) => artifacts.read(tx, scope, request)
        )
        return result ? { ...base, op: 'artifact.read', ...result } : refused()
      }
      case 'artifact.put': {
        const result = await commands.withAuthorizedArtifact(
          peer,
          request.command,
          request.capabilityId,
          'put',
          request.reference,
          (tx, scope) => artifacts.put(tx, scope, request)
        )
        return result ? { ...base, op: 'artifact.put', ...result } : refused()
      }
      case 'publish':
        return (await commands.publish(peer, request))
          ? { ...base, op: 'publish', accepted: true }
          : refused()
    }
  }
  return Object.freeze({
    handle,
    createIntent: commands.createIntent,
    createPersonalTest: commands.createPersonalTest,
    listOwned: commands.listOwned,
    saveProcedure: commands.saveProcedure,
    listProcedures: commands.listProcedures,
  })
}
