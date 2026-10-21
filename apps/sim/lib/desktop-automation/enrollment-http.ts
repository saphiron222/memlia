// Copyright (c) 2026 Memlia. All rights reserved.
import { NextRequest, NextResponse } from 'next/server'
import {
  challengeEnrollmentContract,
  completeEnrollmentContract,
  createEnrollmentContract,
  ENROLLMENT_ONESHOT_MAX_BODY_BYTES,
  ENROLLMENT_SESSION_MAX_BODY_BYTES,
  revokeEnrollmentContract,
} from '@/lib/api/contracts/desktop-agent-enrollment'
import { parseRequest } from '@/lib/api/server'
import {
  defineInternalJsonRoute,
  internalErrorResponse,
  internalRateLimits,
  internalSessionAuth,
} from '@/lib/api/server/routes'
import type { JsonRouteContext } from '@/lib/api/server/routes/types'
import { enforceIpRateLimit } from '@/lib/core/rate-limiter/route-helpers'
import { isCrossSiteSessionRequest } from '@/lib/core/security/same-origin'
import type { createEnrollmentService } from './enrollment'

type Service = ReturnType<typeof createEnrollmentService>
const headers = { 'Cache-Control': 'private, no-store' }
const limit = { maxTokens: 10, refillRate: 5, refillIntervalMs: 60_000 }
const parseOptions = {
  rejectBlankQueryValues: true,
  rejectDuplicateQueryValues: true,
  validationErrorResponse: () => failure(400),
  invalidJsonResponse: () => failure(400),
  payloadTooLargeResponse: () => failure(413),
}
function failure(status: number, unavailable = false) {
  return NextResponse.json(
    { error: unavailable ? 'enrollment_unavailable' : 'enrollment_refused' },
    { status, headers }
  )
}
function conceal(response: Response) {
  if (response.ok) return response
  const status = [400, 401, 403, 413, 429, 503].includes(response.status) ? response.status : 503
  const result = failure(status, status === 503)
  if (status === 429) {
    for (const name of ['retry-after', 'x-ratelimit-reset']) {
      const value = response.headers.get(name)
      if (value) result.headers.set(name, value)
    }
  }
  return result
}
const errorPolicy = {
  // Domain, validation and infrastructure messages may contain request material.
  // Do not forward them to the shared unhandled-error logger or to the client.
  project: () => internalErrorResponse(403, { error: 'enrollment_refused' }),
  unhandled: () => internalErrorResponse(503, { error: 'enrollment_unavailable' }),
}

/** Validate the tiny session body before CA setup, then pass its bounded, detached
 * representation through the native builder. Authenticate exactly once using the
 * native session reader; the builder receives that exact principal, never headers. */
async function admitSession(
  contract: typeof createEnrollmentContract | typeof revokeEnrollmentContract,
  request: NextRequest,
  context?: JsonRouteContext
) {
  try {
    const parsed = await parseRequest(contract, request, context ?? {}, {
      ...parseOptions,
      maxBodyBytes: ENROLLMENT_SESSION_MAX_BODY_BYTES,
    })
    if (!parsed.success) return conceal(parsed.response)
    let principal: Awaited<ReturnType<typeof internalSessionAuth.authenticate>>
    try {
      principal = Object.freeze(await internalSessionAuth.authenticate())
    } catch {
      return failure(401)
    }
    const capturedHeaders = new Headers(request.headers)
    capturedHeaders.delete('content-length')
    capturedHeaders.delete('transfer-encoding')
    return {
      principal,
      request: new NextRequest(request.url, {
        method: 'POST',
        headers: capturedHeaders,
        body: JSON.stringify(parsed.data.body),
        signal: request.signal,
      }),
      context: { params: Object.freeze({ ...parsed.data.params }) },
    }
  } catch {
    return failure(400)
  }
}

/** HTTP boundary only. The supplied service owns native authorization, DB fencing,
 * one-shot transitions and cryptography. A one-shot request never becomes a Principal. */
export function createEnrollmentHttpHandlers(ports: {
  getService(): Promise<Service | null>
  getOrigin(): string | null
}) {
  const getService = ports.getService.bind(ports)
  const getOrigin = ports.getOrigin.bind(ports)
  function guard(request: NextRequest, session: boolean): Response | null {
    let configured: string | null
    try {
      configured = getOrigin()
      if (
        !configured ||
        new URL(configured).protocol !== 'https:' ||
        new URL(configured).origin !== configured
      )
        return failure(503, true)
    } catch {
      return failure(503, true)
    }
    const origin = request.headers.get('origin')
    if (
      isCrossSiteSessionRequest(request) ||
      (session ? origin !== configured : origin !== null && origin !== configured)
    )
      return failure(403)
    // Codes and signatures belong exclusively in bounded bodies, never URL parameters.
    if (request.method !== 'POST' || request.nextUrl.search !== '') return failure(400)
    return null
  }
  async function service(): Promise<Service | null> {
    try {
      return await getService()
    } catch {
      return null
    }
  }
  return Object.freeze({
    async create(request: NextRequest, context?: JsonRouteContext) {
      const denied = guard(request, true)
      if (denied) return denied
      const admitted = await admitSession(createEnrollmentContract, request, context)
      if (admitted instanceof Response) return admitted
      const current = await service()
      if (!current) return failure(503, true)
      const route = defineInternalJsonRoute({
        contract: createEnrollmentContract,
        operation: current.create.operation,
        useCase: current.create,
        auth: { authenticate: async () => admitted.principal },
        rateLimit: internalRateLimits.user({
          bucketName: 'desktop-agent-enrollment.session',
          config: limit,
        }),
        errorPolicy,
        staticResponseHeaders: headers,
        parseOptions: { ...parseOptions, maxBodyBytes: ENROLLMENT_SESSION_MAX_BODY_BYTES },
        mapInput: ({ params }) => ({ workspaceId: params.id }),
      })
      return conceal(await route(admitted.request, admitted.context))
    },
    async revoke(request: NextRequest, context?: JsonRouteContext) {
      const denied = guard(request, true)
      if (denied) return denied
      const admitted = await admitSession(revokeEnrollmentContract, request, context)
      if (admitted instanceof Response) return admitted
      const current = await service()
      if (!current) return failure(503, true)
      const route = defineInternalJsonRoute({
        contract: revokeEnrollmentContract,
        operation: current.revoke.operation,
        useCase: current.revoke,
        auth: { authenticate: async () => admitted.principal },
        rateLimit: internalRateLimits.user({
          bucketName: 'desktop-agent-enrollment.session',
          config: limit,
        }),
        errorPolicy,
        staticResponseHeaders: headers,
        parseOptions: { ...parseOptions, maxBodyBytes: ENROLLMENT_SESSION_MAX_BODY_BYTES },
        mapInput: ({ params }) => ({ workspaceId: params.id, enrollmentId: params.enrollmentId }),
      })
      return conceal(await route(admitted.request, admitted.context))
    },
    async challenge(request: NextRequest) {
      const denied = guard(request, false)
      if (denied) return denied
      try {
        const limited = await enforceIpRateLimit('desktop-agent-enrollment.oneshot', request, limit)
        if (limited) return conceal(limited)
        const parsed = await parseRequest(
          challengeEnrollmentContract,
          request,
          {},
          {
            ...parseOptions,
            maxBodyBytes: ENROLLMENT_ONESHOT_MAX_BODY_BYTES,
          }
        )
        if (!parsed.success) return conceal(parsed.response)
        const input = Object.freeze(parsed.data.body)
        const current = await service()
        if (!current) return failure(503, true)
        const result = challengeEnrollmentContract.response.schema.safeParse(
          await current.challenge(input)
        )
        if (!result.success) return failure(403)
        return NextResponse.json(result.data, { headers })
      } catch {
        return failure(403)
      }
    },
    async complete(request: NextRequest) {
      const denied = guard(request, false)
      if (denied) return denied
      try {
        const limited = await enforceIpRateLimit('desktop-agent-enrollment.oneshot', request, limit)
        if (limited) return conceal(limited)
        const parsed = await parseRequest(
          completeEnrollmentContract,
          request,
          {},
          {
            ...parseOptions,
            maxBodyBytes: ENROLLMENT_ONESHOT_MAX_BODY_BYTES,
          }
        )
        if (!parsed.success) return conceal(parsed.response)
        const input = Object.freeze(parsed.data.body)
        const current = await service()
        if (!current) return failure(503, true)
        const result = completeEnrollmentContract.response.schema.safeParse(
          await current.complete(input)
        )
        if (!result.success) return failure(403)
        return NextResponse.json(result.data, {
          status: result.data.status === 'issuance_unknown' ? 202 : 200,
          headers,
        })
      } catch {
        return failure(403)
      }
    },
  })
}
