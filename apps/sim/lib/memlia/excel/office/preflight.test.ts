// Copyright (c) 2026 Memlia. All rights reserved.
// Only the external Office SDK is doubled; this is not an Excel Desktop qualification.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { preflightOffice } from './preflight'

function office(host = 'Excel', platform = 'PC', mode = 'readWrite') {
  return {
    onReady: () => Promise.resolve({ host, platform }),
    context: {
      requirements: {
        isSetSupported: (name: string, version: string) =>
          ['File', 'CompressedFile'].includes(name) && version === '1.1',
      },
      document: {
        mode,
        getFileAsync: () => {
          throw new Error('content must not be read by preflight')
        },
      },
    },
  }
}

describe('Office compressed-copy preflight at the external SDK boundary', () => {
  afterEach(() => vi.useRealTimers())
  it('reports the current document API scope without reading content or granting authority', async () => {
    const result = await preflightOffice(office())
    expect(result).toEqual({
      version: 1,
      scope: 'current_office_document',
      host: 'Excel',
      platform: 'PC',
      mode: 'readWrite',
      qualification: 'not_verified',
    })
  })
  it('refuses absent SDK rather than inventing a document', async () => {
    await expect(preflightOffice(undefined)).rejects.toMatchObject({
      code: 'office_sdk_unavailable',
    })
  })
  it('refuses a different Office host before any document read', async () => {
    await expect(preflightOffice(office('Word'))).rejects.toMatchObject({
      code: 'office_host_unsupported',
    })
  })
  it.each(['Mac', 'OfficeOnline', 'iOS', 'Universal'])(
    'does not pretend %s has the initial qualified profile',
    async (platform) => {
      await expect(preflightOffice(office('Excel', platform))).rejects.toMatchObject({
        code: 'office_platform_unqualified',
      })
    }
  )
  it.each(['readOnly', '', 'unknown'])(
    'refuses document mode %s for the edit-oriented profile',
    async (mode) => {
      await expect(preflightOffice(office('Excel', 'PC', mode))).rejects.toMatchObject({
        code: 'office_document_mode_unsupported',
      })
    }
  )
  it.each(['File', 'CompressedFile'])('requires %s1.1 before opening a file', async (missing) => {
    const sdk = office()
    sdk.context.requirements.isSetSupported = (name) => name !== missing
    await expect(preflightOffice(sdk)).rejects.toMatchObject({ code: 'office_requirement_missing' })
  })
  it('requires a genuine boolean capability result, not truthy metadata', async () => {
    const sdk = {
      ...office(),
      context: { ...office().context, requirements: { isSetSupported: () => 'yes' } },
    }
    await expect(preflightOffice(sdk)).rejects.toMatchObject({ code: 'office_requirement_missing' })
  })
  it('refuses incomplete SDK methods rather than claiming readiness', async () => {
    await expect(preflightOffice({ ...office(), context: {} })).rejects.toMatchObject({
      code: 'office_sdk_invalid',
    })
    await expect(
      preflightOffice({
        ...office(),
        context: { ...office().context, document: { mode: 'readWrite' } },
      })
    ).rejects.toMatchObject({ code: 'office_sdk_invalid' })
  })
  it('does not read document context until Office has finished initializing', async () => {
    let ready = false
    const sdk = {
      onReady: () =>
        Promise.resolve().then(() => {
          ready = true
          return { host: 'Excel', platform: 'PC' }
        }),
      get context() {
        if (!ready) throw new Error('context accessed too early')
        return office().context
      },
    }
    expect(await preflightOffice(sdk)).toMatchObject({
      version: 1,
      scope: 'current_office_document',
    })
  })
  it.each([false, true])('redacts SDK readiness failures (synchronous=%s)', async (synchronous) => {
    const sdk = {
      ...office(),
      onReady() {
        const error = new Error('PRIVATE_SDK_DETAIL')
        if (synchronous) throw error
        return Promise.reject(error)
      },
    }
    const error = await preflightOffice(sdk).catch((value: unknown) => value)
    expect(error).toMatchObject({ code: 'office_sdk_failure', message: 'office_sdk_failure' })
    expect(error).not.toHaveProperty('cause')
  })
  it('bounds readiness when the Office CDN never initializes', async () => {
    vi.useFakeTimers()
    let outcome: unknown = 'pending'
    void preflightOffice({ ...office(), onReady: () => new Promise(() => {}) }).then(
      (value) => {
        outcome = value
      },
      (error) => {
        outcome = error
      }
    )
    await vi.advanceTimersByTimeAsync(10_000)
    expect(outcome).toMatchObject({ code: 'office_ready_timeout' })
    expect(vi.getTimerCount()).toBe(0)
  })
  it('honors cancellation before readiness without calling Office', async () => {
    const controller = new AbortController()
    controller.abort()
    const sdk = {
      ...office(),
      onReady: () => {
        throw new Error('Office should not be called')
      },
    }
    await expect(preflightOffice(sdk, controller.signal)).rejects.toMatchObject({
      code: 'office_preflight_cancelled',
    })
  })
  it('ignores late readiness after cancellation instead of inspecting the document', async () => {
    let resolve!: (value: { host: string; platform: string }) => void
    let reads = 0
    const controller = new AbortController()
    const sdk = {
      onReady: () =>
        new Promise((r) => {
          resolve = r
        }),
      get context() {
        reads++
        return office().context
      },
    }
    let outcome: unknown = 'pending'
    void preflightOffice(sdk, controller.signal).then(
      (value) => {
        outcome = value
      },
      (error) => {
        outcome = error
      }
    )
    controller.abort()
    await Promise.resolve()
    await Promise.resolve()
    expect(outcome).toMatchObject({ code: 'office_preflight_cancelled' })
    resolve({ host: 'Excel', platform: 'PC' })
    await Promise.resolve()
    await Promise.resolve()
    expect(reads).toBe(0)
  })
  it('refuses readiness delivered after the monotonic deadline even before timer dispatch', async () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(0)
    const sdk = {
      ...office(),
      onReady: () => {
        now.mockReturnValue(10_000)
        return Promise.resolve({ host: 'Excel', platform: 'PC' })
      },
    }
    try {
      await expect(preflightOffice(sdk)).rejects.toMatchObject({ code: 'office_ready_timeout' })
    } finally {
      now.mockRestore()
    }
  })
})
