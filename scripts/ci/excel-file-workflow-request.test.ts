// Copyright (c) 2026 Memlia. All rights reserved.
// Native request/route/auth boundary; only the pre-auth bucket storage is doubled.
import { afterAll, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { NextRequest } from 'next/server'
import type { RateLimitStorageAdapter } from '../../apps/sim/lib/core/rate-limiter/storage/adapter'

// No database/cache service or credential is used by these anonymous requests.
process.env.DATABASE_URL = 'postgres://fixture:fixture@127.0.0.1:9/fixture'
process.env.DATABASE_URL_WEB = process.env.DATABASE_URL
delete process.env.DATABASE_REPLICA_URL
delete process.env.DATABASE_REPLICA_URL_WEB
process.env.SIM_DB_ROLE = 'web'
process.env.DISABLE_AUTH = 'false'
process.env.AUTH_TRUSTED_PROXIES = ''
process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000'
process.env.BETTER_AUTH_URL = 'http://localhost:3000'
process.env.BETTER_AUTH_SECRET = Buffer.alloc(32).toString('hex') // Synthetic, never a service credential.
process.env.NEXT_PUBLIC_POSTHOG_ENABLED = 'false'
process.env.NEXT_TELEMETRY_DISABLED = '1'
delete process.env.REDIS_URL

const calls: string[] = []
const unexpectedStorageCall = async (): Promise<never> => { throw Error('unexpected_storage_call') }
const storage: RateLimitStorageAdapter = {
  async consumeTokens(key, tokens, config) {
    calls.push(key)
    expect(tokens).toBe(1)
    expect(config.maxTokens).toBe(600)
    return { allowed: true, tokensRemaining: 599, resetAt: new Date(0) }
  },
  consumeTokensAtomically: unexpectedStorageCall,
  getCooldownUntil: unexpectedStorageCall,
  setCooldownUntil: unexpectedStorageCall,
  getTokenStatus: unexpectedStorageCall,
  resetBucket: unexpectedStorageCall,
}
const { setStorageAdapter } = await import('../../apps/sim/lib/core/rate-limiter/storage/factory')
setStorageAdapter(storage)
const { dispatchInProcessV2Request } = await import('../../apps/sim/lib/api/server/routes/in-process-transport')
const { NextRequest: NativeRequest } = await import('next/server')

// Evaluate the existing fixture function verbatim, rather than a second request builder.
const source = readFileSync(new URL('./excel-file-workflow.ts', import.meta.url), 'utf8')
const match = source.match(/^    async function request\([\s\S]*?^    }$/m)
if (!match) throw Error('fixture_request_not_found')
const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(match[0])
type Dispatch = (request: NextRequest) => Promise<Response | undefined>
type Request = (path: string, method?: string, body?: unknown, credential?: string | null) => Promise<Response>
function fixtureRequest(dispatch: Dispatch): Request {
  return new Function('NextRequest', 'dispatchInProcessV2Request', 'key', 'assertRecipe',
    code + '\nreturn request;')(NativeRequest, dispatch, null, (value: unknown) => {
      if (!value) throw Error('fixture_response_missing')
    })
}

test('the real anonymous fixture request reaches native authentication and remains 401', async () => {
  calls.length = 0
  const response = await fixtureRequest(dispatchInProcessV2Request)('/api/v2/files', 'POST', {}, null)
  expect(response.status).toBe(401)
  expect(calls).toEqual(['v2:preauth:ip:192.0.2.10'])
})

for (const ip of [null, 'not-an-ip']) {
  test(`native pre-auth still rejects ${ip === null ? 'missing' : 'invalid'} IP before storage`, async () => {
    calls.length = 0
    const response = await fixtureRequest(async request => {
      if (ip === null) request.headers.delete('x-forwarded-for')
      else request.headers.set('x-forwarded-for', ip)
      return dispatchInProcessV2Request(request)
    })('/api/v2/files', 'POST', {}, null)
    expect(response.status).toBe(429)
    expect(calls).toEqual([])
  })
}

afterAll(async () => {
  const { db } = await import('../../packages/db/index')
  await db.$client.end({ timeout: 2 })
})
