// Copyright (c) 2026 Memlia. All rights reserved.
import { type NextRequest, NextResponse } from 'next/server'
import {
  createPersonalTestContract,
  listProceduresContract,
  saveProcedureContract,
} from '@/lib/api/contracts/desktop-agent-procedures'
import {
  defineInternalJsonRoute,
  internalErrorResponse,
  internalRateLimits,
  internalSessionAuth,
} from '@/lib/api/server/routes'
import type { JsonRouteContext } from '@/lib/api/server/routes/types'
import { defineAuthorizedWorkspaceUseCase } from '@/lib/core/application/authorized-workspace-use-case'
import { defineWorkspaceOperation } from '@/lib/core/application/workspace-operation'
import { OrchestrationError } from '@/lib/core/orchestration/types'
import { isCrossSiteSessionRequest } from '@/lib/core/security/same-origin'
import type { createAgentControlService } from './agent-control-service'
import { enrollmentRepository } from './enrollment-repository'

type Service = Pick<
  ReturnType<typeof createAgentControlService>,
  'saveProcedure' | 'listProcedures' | 'createPersonalTest'
>
const headers = { 'Cache-Control': 'private, no-store' }
const failure = (status: number) =>
  NextResponse.json(
    { error: status === 503 ? 'procedure_unavailable' : 'procedure_refused' },
    { status, headers }
  )
const errorPolicy = {
  project: (error: unknown) =>
    error instanceof OrchestrationError &&
    error.code === 'conflict' &&
    error.message === 'procedure_revision_conflict'
      ? internalErrorResponse(409, { error: 'procedure_revision_conflict' })
      : internalErrorResponse(403, { error: 'procedure_refused' }),
  unhandled: () => internalErrorResponse(503, { error: 'procedure_unavailable' }),
}
/** Native browser session/write funnel. Procedure ownership, version CAS and idempotence are revalidated
 * in the durable repository; this route never accepts a desktop session or consent. */
export function createAgentProcedureHttpHandlers(ports: {
  getService(): Promise<Service>
  getOrigin(): string | null
}) {
  const getService = ports.getService.bind(ports)
  const getOrigin = ports.getOrigin.bind(ports)
  const operation = (id: string) =>
    defineWorkspaceOperation({
      id,
      minimumRole: 'write',
      workspaceApiKey: 'deny',
      principalKinds: ['session'],
      capability: 'none',
    })
  async function context(input: { workspaceId: string }) {
    const resolved = await enrollmentRepository.workspace(input.workspaceId)
    if (!resolved || resolved.workspaceId !== input.workspaceId)
      throw new OrchestrationError('forbidden', 'procedure_refused')
    return resolved
  }
  const create = defineAuthorizedWorkspaceUseCase({
    operation: operation('desktop_agent.procedure.create'),
    authorizationOptions: {},
    resolveContext: ({ input }: { input: Parameters<Service['saveProcedure']>[1] }) =>
      context(input),
    execute: async ({ principal, input }) => (await getService()).saveProcedure(principal, input),
  })
  const list = defineAuthorizedWorkspaceUseCase({
    operation: operation('desktop_agent.procedure.list'),
    authorizationOptions: {},
    resolveContext: ({ input }: { input: Parameters<Service['listProcedures']>[1] }) =>
      context(input),
    execute: async ({ principal, input }) => (await getService()).listProcedures(principal, input),
  })
  const test = defineAuthorizedWorkspaceUseCase({
    operation: operation('desktop_agent.procedure.test'),
    authorizationOptions: {},
    resolveContext: ({ input }: { input: Parameters<Service['createPersonalTest']>[1] }) =>
      context(input),
    execute: async ({ principal, input }) =>
      (await getService()).createPersonalTest(principal, input),
  })
  const shared = {
    auth: internalSessionAuth,
    errorPolicy,
    staticResponseHeaders: headers,
    rateLimit: internalRateLimits.user({
      bucketName: 'desktop-agent-procedure.session',
      config: { maxTokens: 30, refillRate: 30, refillIntervalMs: 60000 },
    }),
    parseOptions: {
      maxBodyBytes: 16384,
      rejectBlankQueryValues: true,
      rejectDuplicateQueryValues: true,
      validationErrorResponse: () => failure(400),
      invalidJsonResponse: () => failure(400),
      payloadTooLargeResponse: () => failure(413),
    },
  }
  const post = defineInternalJsonRoute({
    ...shared,
    contract: saveProcedureContract,
    operation: create.operation,
    useCase: create,
    mapInput: ({ params, body }) => ({ workspaceId: params.id, ...body }),
  })
  const get = defineInternalJsonRoute({
    ...shared,
    contract: listProceduresContract,
    operation: list.operation,
    useCase: list,
    mapInput: ({ params, query }) => ({ workspaceId: params.id, ...query }),
  })
  const personalTest = defineInternalJsonRoute({
    ...shared,
    contract: createPersonalTestContract,
    operation: test.operation,
    useCase: test,
    mapInput: ({ params, body }) => ({ workspaceId: params.id, ...body }),
  })
  function guard(request: NextRequest, method: 'GET' | 'POST') {
    try {
      const origin = getOrigin()
      if (!origin || new URL(origin).origin !== origin || new URL(origin).protocol !== 'https:')
        return failure(503)
      if (
        isCrossSiteSessionRequest(request) ||
        (request.headers.has('origin') && request.headers.get('origin') !== origin) ||
        (method === 'POST' && request.headers.get('origin') !== origin)
      )
        return failure(403)
      if (request.method !== method || (method === 'POST' && request.nextUrl.search !== ''))
        return failure(400)
      return null
    } catch {
      return failure(503)
    }
  }
  return Object.freeze({
    GET: async (request: NextRequest, ctx?: JsonRouteContext) =>
      guard(request, 'GET') ?? get(request, ctx),
    POST: async (request: NextRequest, ctx?: JsonRouteContext) =>
      guard(request, 'POST') ?? post(request, ctx),
    TEST: async (request: NextRequest, ctx?: JsonRouteContext) =>
      guard(request, 'POST') ?? personalTest(request, ctx),
  })
}
