// Copyright (c) 2026 Memlia. All rights reserved.
// Office and HTTP are external doubles; this is not an Excel Desktop qualification.
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { backupCurrentOfficeWorkbook } from './backup-client'

const BYTES = Uint8Array.of(80, 75, 3, 4)
const DIGEST = `sha256:${createHash('sha256').update(BYTES).digest('hex')}`
const RECEIPT = {
  schemaVersion: 'memlia.office-copy-storage/v1',
  workspaceId: 'workspace-fixture',
  ownerUserId: 'user-fixture',
  fileId: 'backup-fixture',
  contentVersion: 17,
  byteLength: 4,
  sha256: DIGEST,
} as const

function office(bytes = BYTES) {
  const lifecycle: string[] = []
  const sdk = {
    onReady: () => Promise.resolve({ host: 'Excel', platform: 'PC' }),
    context: {
      requirements: { isSetSupported: () => true },
      document: {
        mode: 'readWrite',
        getFileAsync: (
          _type: string,
          options: { sliceSize: number },
          callback: (v: unknown) => void
        ) => {
          lifecycle.push('open')
          callback({
            status: 'succeeded',
            value: {
              size: bytes.length,
              sliceCount: Math.ceil(bytes.length / options.sliceSize),
              getSliceAsync(index: number, done: (v: unknown) => void) {
                const data = bytes.subarray(
                  index * options.sliceSize,
                  (index + 1) * options.sliceSize
                )
                done({ status: 'succeeded', value: { index, size: data.length, data } })
              },
              closeAsync(done: (v: unknown) => void) {
                lifecycle.push('close')
                done({ status: 'succeeded' })
              },
            },
          })
        },
      },
    },
  }
  return { sdk, lifecycle }
}
function input(sdk: unknown, signal?: AbortSignal) {
  return { office: sdk, workspaceId: 'workspace-fixture', expectedUserId: 'user-fixture', signal }
}
function server(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('current Office workbook → native private backup', () => {
  it('closes the SDK copy before one native POST and accepts only its matching receipt', async () => {
    const { sdk, lifecycle } = office()
    const phases: string[] = []
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(lifecycle).toEqual(['open', 'close'])
      expect(url).toBe('/api/workspaces/workspace-fixture/excel/office-backups')
      const body = JSON.parse(String(init.body))
      expect(body).toEqual({ copyVersion: 1, contentBase64: 'UEsDBA==' })
      return server({ status: 'stored', receipt: RECEIPT })
    })
    vi.stubGlobal('fetch', fetch)
    expect(
      await backupCurrentOfficeWorkbook({ ...input(sdk), onPhase: (p) => phases.push(p) })
    ).toEqual({ status: 'stored', receipt: RECEIPT })
    expect(phases).toEqual(['preflight', 'copy', 'storing'])
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('refuses copies larger than the HTTP ceiling before POST, without raising the SDK ceiling', async () => {
    const { sdk, lifecycle } = office(new Uint8Array(7_500_001))
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    expect(await backupCurrentOfficeWorkbook(input(sdk))).toMatchObject({
      status: 'refused',
      code: 'copy_too_large',
    })
    expect(lifecycle).toEqual(['open', 'close'])
    expect(fetch).not.toHaveBeenCalled()
  })
  it('keeps a lost response unknown and never repeats the upload', async () => {
    const { sdk } = office()
    const fetch = vi.fn().mockRejectedValue(new Error('PRIVATE CONTENT'))
    vi.stubGlobal('fetch', fetch)
    const result = await backupCurrentOfficeWorkbook(input(sdk))
    expect(result).toEqual({ status: 'unconfirmed', code: 'response_unknown', fileId: null })
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it.each([
    { workspaceId: 'foreign-workspace' },
    { ownerUserId: 'other-user' },
    { sha256: `sha256:${'0'.repeat(64)}` },
    { byteLength: 3 },
  ])('does not confirm a receipt that differs from the captured request: %j', async (delta) => {
    const { sdk } = office()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(server({ status: 'stored', receipt: { ...RECEIPT, ...delta } }))
    )
    expect(await backupCurrentOfficeWorkbook(input(sdk))).toEqual({
      status: 'unconfirmed',
      code: 'receipt_mismatch',
      fileId: 'backup-fixture',
    })
  })
  it('preserves an explicit server uncertainty and its opaque file identifier', async () => {
    const { sdk } = office()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        server({
          status: 'unconfirmed',
          code: 'office_backup_storage_unknown',
          stage: 'creation_unknown',
          fileId: 'backup-fixture',
        })
      )
    )
    expect(await backupCurrentOfficeWorkbook(input(sdk))).toEqual({
      status: 'unconfirmed',
      code: 'storage_unconfirmed',
      fileId: 'backup-fixture',
    })
  })
  it('accepts an explicit refusal only before creation with no file identity', async () => {
    const { sdk } = office()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        server({
          status: 'refused',
          code: 'office_backup_refused',
          stage: 'before_creation',
          fileId: null,
        })
      )
    )
    expect(await backupCurrentOfficeWorkbook(input(sdk))).toEqual({
      status: 'refused',
      code: 'storage_refused',
      fileId: null,
    })
  })
  it('does not treat a contradictory refusal or invalid response as a safe retry', async () => {
    for (const value of [
      {
        status: 'refused',
        code: 'office_backup_refused',
        stage: 'created_unverified',
        fileId: 'backup-fixture',
      },
      { status: 'stored', receipt: { ...RECEIPT, secret: 'PRIVATE' } },
    ]) {
      const { sdk } = office()
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(server(value)))
      const result = await backupCurrentOfficeWorkbook(input(sdk))
      expect(result.status).toBe('unconfirmed')
      expect(JSON.stringify(result)).not.toContain('PRIVATE')
    }
  })
  it('does not read Office or send when cancelled or missing the authenticated user identity', async () => {
    const cancelled = new AbortController()
    cancelled.abort()
    const { sdk, lifecycle } = office()
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    expect((await backupCurrentOfficeWorkbook(input(sdk, cancelled.signal))).status).toBe('refused')
    expect((await backupCurrentOfficeWorkbook({ ...input(sdk), expectedUserId: '' })).status).toBe(
      'refused'
    )
    expect(lifecycle).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })
  it('does not confuse cancellation after dispatch with a refused creation', async () => {
    const { sdk } = office()
    const controller = new AbortController()
    const fetch = vi.fn(async () => {
      controller.abort()
      throw new DOMException('PRIVATE', 'AbortError')
    })
    vi.stubGlobal('fetch', fetch)
    expect(await backupCurrentOfficeWorkbook(input(sdk, controller.signal))).toEqual({
      status: 'unconfirmed',
      code: 'response_unknown',
      fileId: null,
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('requests native reconnection after an HTTP authentication refusal without echoing its body', async () => {
    const { sdk } = office()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(server({ error: 'PRIVATE' }, 401)))
    expect(await backupCurrentOfficeWorkbook(input(sdk))).toEqual({
      status: 'refused',
      code: 'authentication_required',
      fileId: null,
    })
  })
  it('does not upload if the Office file closure remains unknown', async () => {
    const { sdk } = office()
    sdk.context.document.getFileAsync = (_t, _o, cb) => cb({ status: 'invalid' })
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    expect(await backupCurrentOfficeWorkbook(input(sdk))).toEqual({
      status: 'unconfirmed',
      code: 'copy_unconfirmed',
      fileId: null,
    })
    expect(fetch).not.toHaveBeenCalled()
  })
})

// A stored receipt must remain immutable when retained as an edit-session dependency.
it('freezes the stored result and receipt without changing the historical copy profile', async () => {
  const { sdk } = office()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => server({ status: 'stored', receipt: RECEIPT }))
  )
  const result = await backupCurrentOfficeWorkbook(input(sdk))
  expect(Object.isFrozen(result)).toBe(true)
  if (result.status !== 'stored') throw new Error('expected stored')
  expect(Object.isFrozen(result.receipt)).toBe(true)
})
