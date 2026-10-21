// Copyright 2026 Memlia. All rights reserved.
import { NextResponse } from 'next/server'
import {
  defineInternalJsonRoute,
  internalErrorResponse,
  internalRateLimits,
  internalSessionAuth,
} from '@/lib/api/server/routes'
import { asOrchestrationError } from '@/lib/core/orchestration/types'
import {
  localCapabilitiesOperation,
  readLocalChatCapabilities,
} from '@/lib/memlia/chat/local-capabilities.server'
import { localCapabilitiesContract } from './contracts'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const GET = defineInternalJsonRoute({
  contract: localCapabilitiesContract,
  operation: localCapabilitiesOperation,
  auth: internalSessionAuth,
  rateLimit: internalRateLimits.user({ bucketName: 'chat.local-capabilities' }),
  staticResponseHeaders: { 'Cache-Control': 'private, no-store' },
  parseOptions: {
    rejectBlankQueryValues: true,
    rejectDuplicateQueryValues: true,
    validationErrorResponse: () =>
      NextResponse.json({ error: 'Invalid profile request.' }, { status: 400 }),
  },
  errorPolicy: {
    project(error) {
      const code = asOrchestrationError(error)?.code
      return internalErrorResponse(code === 'forbidden' || code === 'not_found' ? 403 : 503, {
        error: 'Local Chat profile is unavailable.',
      })
    },
    unhandled: () => internalErrorResponse(503, { error: 'Local Chat profile is unavailable.' }),
  },
  mapInput: ({ query }) => query,
  useCase: readLocalChatCapabilities,
})
