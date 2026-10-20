// Copyright (c) 2026 Memlia. All rights reserved.
// Office is an external SDK double; these tests do not qualify Excel Desktop.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyOfficeCompressedFile } from './compressed-copy'
import { preflightOffice } from './preflight'

type Callback = (result: unknown) => void
const ok = (value?: unknown) => ({ status: 'succeeded', value })
function host(bytes = [1, 2, 3]) {
  const calls: unknown[] = []
  const file = {
    size: bytes.length,
    sliceCount: Math.ceil(bytes.length / 65_536),
    getSliceAsync(index: number, callback: Callback) {
      calls.push(['slice', index])
      const data = bytes.slice(index * 65_536, (index + 1) * 65_536)
      callback(ok({ index, size: data.length, data }))
    },
    closeAsync(callback: Callback) {
      calls.push(['close'])
      callback(ok())
    },
  }
  const document = {
    mode: 'readWrite',
    getFileAsync(type: string, options: unknown, callback: Callback) {
      calls.push(['open', type, options])
      callback(ok(file))
    },
  }
  const sdk = {
    onReady: () => Promise.resolve({ host: 'Excel', platform: 'PC' }),
    context: { requirements: { isSetSupported: () => true }, document },
  }
  return { sdk, document, file, calls }
}

describe('complete Office compressed copy at the SDK boundary', () => {
  afterEach(() => vi.useRealTimers())
  it('copies every slice in order into detached bytes and closes before returning', async () => {
    const bytes = Array.from({ length: 65_539 }, (_, i) => i % 256)
    const h = host(bytes)
    const scope = await preflightOffice(h.sdk)
    const result = await copyOfficeCompressedFile(scope)
    expect(result).toMatchObject({
      version: 1,
      kind: 'unpersisted_compressed_copy',
      scope: 'current_office_document',
      byteLength: 65_539,
      sliceCount: 2,
      closure: 'confirmed',
    })
    expect(result.bytes).toEqual(Uint8Array.from(bytes))
    expect(h.calls).toEqual([
      ['open', 'compressed', { sliceSize: 65_536 }],
      ['slice', 0],
      ['slice', 1],
      ['close'],
    ])
    bytes[0] = 255
    expect(result.bytes[0]).toBe(0)
  })
  it('refuses a serialized or forged preflight observation without calling Office', async () => {
    const h = host()
    const scope = await preflightOffice(h.sdk)
    await expect(copyOfficeCompressedFile({ ...scope })).rejects.toMatchObject({
      code: 'office_scope_changed',
      closure: 'not_opened',
    })
    expect(h.calls).toEqual([])
  })
  it.each([
    { size: 0 },
    { size: 10_000_001 },
    { size: Number.NaN },
    { size: 1.5 },
    { sliceCount: 0 },
    { sliceCount: 2 },
    { sliceCount: 1.5 },
  ])('refuses invalid file bounds %j while closing the acquired handle', async (metadata) => {
    const h = host()
    Object.assign(h.file, metadata)
    await expect(copyOfficeCompressedFile(await preflightOffice(h.sdk))).rejects.toMatchObject({
      code: 'office_file_invalid',
      closure: 'confirmed',
    })
    expect(h.calls).toEqual([['open', 'compressed', { sliceSize: 65_536 }], ['close']])
  })
  it.each([
    { index: 1, size: 3, data: [1, 2, 3] },
    { index: 0, size: 2, data: [1, 2, 3] },
    { index: 0, size: 3, data: [1, 2] },
    { index: 0, size: 3, data: [1, 256, 3] },
    { index: 0, size: 3, data: [1, -1, 3] },
    { index: 0, size: 3, data: [1, 2.5, 3] },
    { index: 0, size: 3, data: [1, '2', 3] },
    { index: 0, size: 3, data: 'abc' },
    { index: 0, size: 3, data: Array(3) },
  ])('refuses inconsistent or non-byte slice %j without returning partial data', async (slice) => {
    const h = host()
    h.file.getSliceAsync = (_index, callback) => callback(ok(slice))
    const error = await copyOfficeCompressedFile(await preflightOffice(h.sdk)).catch(
      (value: unknown) => value
    )
    expect(error).toMatchObject({ code: 'office_slice_invalid', closure: 'confirmed' })
    expect(error).not.toHaveProperty('bytes')
    expect(h.calls.filter((v) => Array.isArray(v) && v[0] === 'close')).toHaveLength(1)
  })
  it('accepts and detaches SDK Uint8Array data', async () => {
    const h = host()
    const data = new Uint8Array([7, 8, 9])
    h.file.getSliceAsync = (_index, callback) => callback(ok({ index: 0, size: 3, data }))
    const result = await copyOfficeCompressedFile(await preflightOffice(h.sdk))
    data[0] = 99
    expect(result.bytes).toEqual(new Uint8Array([7, 8, 9]))
  })
  it('refuses a changed document binding or mode before any file request', async () => {
    const h = host()
    const scope = await preflightOffice(h.sdk)
    h.sdk.context.document = host().document
    await expect(copyOfficeCompressedFile(scope)).rejects.toMatchObject({
      code: 'office_scope_changed',
      closure: 'not_opened',
    })
    expect(h.calls).toEqual([])
    const other = host()
    const otherScope = await preflightOffice(other.sdk)
    other.document.mode = 'readOnly'
    await expect(copyOfficeCompressedFile(otherScope)).rejects.toMatchObject({
      code: 'office_document_mode_unsupported',
      closure: 'not_opened',
    })
  })
  it('refuses document mode changes during acquisition and closes', async () => {
    const h = host()
    const read = h.file.getSliceAsync
    h.file.getSliceAsync = (index, callback) => {
      h.document.mode = 'readOnly'
      read(index, callback)
    }
    await expect(copyOfficeCompressedFile(await preflightOffice(h.sdk))).rejects.toMatchObject({
      code: 'office_document_mode_unsupported',
      closure: 'confirmed',
    })
  })
  it('refuses file metadata changes between slices and completion', async () => {
    const h = host()
    const read = h.file.getSliceAsync
    h.file.getSliceAsync = (index, callback) => {
      read(index, callback)
      h.file.size++
    }
    await expect(copyOfficeCompressedFile(await preflightOffice(h.sdk))).rejects.toMatchObject({
      code: 'office_file_changed',
      closure: 'confirmed',
    })
  })
  it.each(['open', 'slice', 'close'])(
    'normalizes failed SDK %s results without messages',
    async (phase) => {
      const h = host()
      const failed = { status: 'failed', error: { message: 'PRIVATE_SDK_DETAIL' } }
      if (phase === 'open')
        h.document.getFileAsync = (_type, _options, callback) => callback(failed)
      if (phase === 'slice') h.file.getSliceAsync = (_index, callback) => callback(failed)
      if (phase === 'close')
        h.file.closeAsync = (callback) => {
          h.calls.push(['close'])
          callback(failed)
        }
      const error = await copyOfficeCompressedFile(await preflightOffice(h.sdk)).catch(
        (value: unknown) => value
      )
      expect(error).toMatchObject({
        code: `office_${phase === 'slice' ? 'slice' : phase}_failed`,
        closure: phase === 'open' ? 'not_opened' : phase === 'close' ? 'unconfirmed' : 'confirmed',
      })
      expect(String(error)).not.toContain('PRIVATE')
      expect(error).not.toHaveProperty('cause')
    }
  )
  it.each(['open', 'slice', 'close'])(
    'normalizes thrown SDK %s errors and attempts owned closure',
    async (phase) => {
      const h = host()
      const fail = () => {
        throw new Error('PRIVATE_SDK_DETAIL')
      }
      if (phase === 'open') h.document.getFileAsync = fail
      if (phase === 'slice') h.file.getSliceAsync = fail
      if (phase === 'close') h.file.closeAsync = fail
      const error = await copyOfficeCompressedFile(await preflightOffice(h.sdk)).catch(
        (value: unknown) => value
      )
      expect(error).toMatchObject({
        code: `office_${phase}_failed`,
        closure: phase === 'open' ? 'pending' : phase === 'close' ? 'unconfirmed' : 'confirmed',
      })
      expect(String(error)).not.toContain('PRIVATE')
    }
  )
  it('refuses malformed success without claiming that no handle was opened', async () => {
    const h = host()
    h.document.getFileAsync = (_type, _options, callback) => callback(ok('invalid handle'))
    const scope = await preflightOffice(h.sdk)
    await expect(copyOfficeCompressedFile(scope)).rejects.toMatchObject({
      code: 'office_file_invalid',
      closure: 'unconfirmed',
    })
    await expect(copyOfficeCompressedFile(scope)).rejects.toMatchObject({
      code: 'office_copy_busy',
    })
  })
  it('does not call Office when already cancelled', async () => {
    const h = host()
    const scope = await preflightOffice(h.sdk)
    const c = new AbortController()
    c.abort()
    await expect(copyOfficeCompressedFile(scope, c.signal)).rejects.toMatchObject({
      code: 'office_copy_cancelled',
      closure: 'not_opened',
    })
    expect(h.calls).toEqual([])
  })
  it('keeps local exclusion until a late open is closed after cancellation', async () => {
    const h = host()
    let opened!: Callback
    const originalOpen = h.document.getFileAsync
    h.document.getFileAsync = (_type, _options, callback) => {
      opened = callback
    }
    const scope = await preflightOffice(h.sdk)
    const secondScope = await preflightOffice(h.sdk)
    const c = new AbortController()
    const outcome = copyOfficeCompressedFile(scope, c.signal).catch((value: unknown) => value)
    c.abort()
    expect(await outcome).toMatchObject({ code: 'office_copy_cancelled', closure: 'pending' })
    await expect(copyOfficeCompressedFile(secondScope)).rejects.toMatchObject({
      code: 'office_copy_busy',
    })
    opened(ok(h.file))
    expect(h.calls).toEqual([['close']])
    // Keep the original method identity; only change the double's behavior for the next invocation.
    h.document.getFileAsync = originalOpen
    const newScope = await preflightOffice(h.sdk)
    expect((await copyOfficeCompressedFile(newScope)).bytes).toEqual(new Uint8Array([1, 2, 3]))
  })
  it('bounds an open callback that never arrives, and closes its later handle once', async () => {
    vi.useFakeTimers()
    const h = host()
    let opened!: Callback
    h.document.getFileAsync = (_type, _options, callback) => {
      opened = callback
    }
    const scope = await preflightOffice(h.sdk)
    let outcome: unknown = 'pending'
    void copyOfficeCompressedFile(scope).then(
      (v) => {
        outcome = v
      },
      (e) => {
        outcome = e
      }
    )
    await vi.advanceTimersByTimeAsync(30_000)
    expect(outcome).toMatchObject({ code: 'office_copy_timeout', closure: 'pending' })
    await expect(copyOfficeCompressedFile(scope)).rejects.toMatchObject({
      code: 'office_copy_busy',
    })
    opened(ok(h.file))
    opened(ok(h.file))
    await Promise.resolve()
    expect(h.calls).toEqual([['close']])
    expect(vi.getTimerCount()).toBe(0)
  })
  it('closes after slice cancellation and ignores a late slice callback', async () => {
    const h = host()
    let slice!: Callback
    h.file.getSliceAsync = (_index, callback) => {
      slice = callback
    }
    const scope = await preflightOffice(h.sdk)
    const c = new AbortController()
    const outcome = copyOfficeCompressedFile(scope, c.signal).catch((v: unknown) => v)
    await Promise.resolve()
    c.abort()
    expect(await outcome).toMatchObject({ code: 'office_copy_cancelled', closure: 'confirmed' })
    slice(ok({ index: 0, size: 3, data: [9, 9, 9] }))
    expect(h.calls).toEqual([['open', 'compressed', { sliceSize: 65_536 }], ['close']])
  })
  it('bounds close, refuses success and retains exclusion until a late close ACK', async () => {
    vi.useFakeTimers()
    const h = host()
    let ack!: Callback
    h.file.closeAsync = (callback) => {
      h.calls.push(['close'])
      ack = callback
    }
    const scope = await preflightOffice(h.sdk)
    let outcome: unknown = 'pending'
    void copyOfficeCompressedFile(scope).then(
      (v) => {
        outcome = v
      },
      (e) => {
        outcome = e
      }
    )
    await vi.advanceTimersByTimeAsync(2_000)
    expect(outcome).toMatchObject({ code: 'office_close_failed', closure: 'unconfirmed' })
    await expect(copyOfficeCompressedFile(scope)).rejects.toMatchObject({
      code: 'office_copy_busy',
    })
    ack(ok())
    expect(vi.getTimerCount()).toBe(0)
    expect(h.calls.filter((v) => Array.isArray(v) && v[0] === 'close')).toHaveLength(1)
  })
  it('cancellation while closing cannot return successful bytes', async () => {
    const h = host()
    let ack!: Callback
    h.file.closeAsync = (callback) => {
      ack = callback
    }
    const scope = await preflightOffice(h.sdk)
    const c = new AbortController()
    const outcome = copyOfficeCompressedFile(scope, c.signal).catch((v: unknown) => v)
    for (let i = 0; i < 5; i++) await Promise.resolve()
    c.abort()
    ack(ok())
    expect(await outcome).toMatchObject({ code: 'office_copy_cancelled', closure: 'confirmed' })
  })
  it('bounds total slice acquisition rather than resetting the deadline for every slice', async () => {
    vi.useFakeTimers()
    const h = host(Array(65_537).fill(1))
    h.file.getSliceAsync = (index, callback) => {
      setTimeout(
        () =>
          callback(
            ok({
              index,
              size: index === 0 ? 65_536 : 1,
              data: Array(index === 0 ? 65_536 : 1).fill(1),
            })
          ),
        20_000
      )
    }
    const scope = await preflightOffice(h.sdk)
    let outcome: unknown = 'pending'
    void copyOfficeCompressedFile(scope).then(
      (v) => {
        outcome = v
      },
      (e) => {
        outcome = e
      }
    )
    await vi.advanceTimersByTimeAsync(30_000)
    expect(outcome).toMatchObject({ code: 'office_copy_timeout', closure: 'confirmed' })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(outcome).toMatchObject({ code: 'office_copy_timeout' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps unknown or unclosable acquisitions blocked rather than claiming release', async () => {
    const h = host()
    h.document.getFileAsync = (_type, _options, callback) =>
      callback(ok({ size: 3, sliceCount: 1, getSliceAsync: h.file.getSliceAsync }))
    const scope = await preflightOffice(h.sdk)
    await expect(copyOfficeCompressedFile(scope)).rejects.toMatchObject({
      code: 'office_file_invalid',
      closure: 'unconfirmed',
    })
    await expect(copyOfficeCompressedFile(scope)).rejects.toMatchObject({
      code: 'office_copy_busy',
    })
  })
  it('holds a single local acquisition across separate observations of the same document', async () => {
    const h = host()
    let first!: Callback
    h.document.getFileAsync = (_type, _options, callback) => {
      first = callback
    }
    const scope = await preflightOffice(h.sdk)
    const second = await preflightOffice(h.sdk)
    const pending = copyOfficeCompressedFile(scope)
    await expect(copyOfficeCompressedFile(second)).rejects.toMatchObject({
      code: 'office_copy_busy',
    })
    const other = host([4])
    expect((await copyOfficeCompressedFile(await preflightOffice(other.sdk))).bytes).toEqual(
      new Uint8Array([4])
    )
    first(ok(h.file))
    expect((await pending).bytes).toEqual(new Uint8Array([1, 2, 3]))
  })
  it('closes once and keeps exact bytes when the SDK repeats callbacks', async () => {
    const h = host()
    const open = h.document.getFileAsync
    const slice = h.file.getSliceAsync
    h.document.getFileAsync = (type, options, callback) =>
      open(type, options, (result) => {
        callback(result)
        callback({ status: 'failed' })
      })
    h.file.getSliceAsync = (index, callback) =>
      slice(index, (result) => {
        callback(result)
        callback(ok({ index: 99 }))
      })
    expect((await copyOfficeCompressedFile(await preflightOffice(h.sdk))).bytes).toEqual(
      new Uint8Array([1, 2, 3])
    )
    expect(h.calls.filter((v) => Array.isArray(v) && v[0] === 'close')).toHaveLength(1)
  })
  it('does not extend acquisition when the system clock moves backwards', async () => {
    vi.useFakeTimers()
    const h = host(Array(65_537).fill(1))
    h.file.getSliceAsync = (index, callback) => {
      if (index === 0)
        setTimeout(() => {
          vi.setSystemTime(Date.now() - 100_000)
          callback(ok({ index: 0, size: 65_536, data: Array(65_536).fill(1) }))
        }, 20_000)
    }
    const scope = await preflightOffice(h.sdk)
    let outcome: unknown = 'pending'
    void copyOfficeCompressedFile(scope).then(
      (v) => {
        outcome = v
      },
      (e) => {
        outcome = e
      }
    )
    await vi.advanceTimersByTimeAsync(30_000)
    expect(outcome).toMatchObject({ code: 'office_copy_timeout', closure: 'confirmed' })
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each([3, 65_537])(
    'rejects expired acquisition after a synchronous slice callback (size %s)',
    async (size) => {
      vi.useFakeTimers()
      const h = host(Array(size).fill(1))
      const read = h.file.getSliceAsync
      h.file.getSliceAsync = (index, callback) => {
        read(index, callback)
        vi.advanceTimersByTime(30_000)
      }
      await expect(copyOfficeCompressedFile(await preflightOffice(h.sdk))).rejects.toMatchObject({
        code: 'office_copy_timeout',
        closure: 'confirmed',
      })
      expect(h.calls).toEqual([
        ['open', 'compressed', { sliceSize: 65_536 }],
        ['slice', 0],
        ['close'],
      ])
      expect(vi.getTimerCount()).toBe(0)
    }
  )
  it.each(['confirmed', 'late_ack'])(
    'an old %s close ACK cannot release a newer acquisition',
    async (variant) => {
      if (variant === 'late_ack') vi.useFakeTimers()
      const h = host()
      const originalOpen = h.document.getFileAsync
      let holdOpen = false
      const pendingOpens: Callback[] = []
      let oldClose!: Callback
      h.document.getFileAsync = (type, options, callback) => {
        if (holdOpen) pendingOpens.push(callback)
        else originalOpen(type, options, callback)
      }
      h.file.closeAsync = (callback) => {
        oldClose = callback
      }
      const scope = await preflightOffice(h.sdk)
      const first = copyOfficeCompressedFile(scope).catch((error: unknown) => error)
      for (let i = 0; i < 5; i++) await Promise.resolve()
      if (variant === 'late_ack') {
        await vi.advanceTimersByTimeAsync(2_000)
        expect(await first).toMatchObject({ code: 'office_close_failed', closure: 'unconfirmed' })
        oldClose(ok())
      } else {
        oldClose(ok())
        expect(await first).toHaveProperty('kind', 'unpersisted_compressed_copy')
      }
      holdOpen = true
      const secondAbort = new AbortController()
      const thirdAbort = new AbortController()
      const second = copyOfficeCompressedFile(scope, secondAbort.signal).catch(
        (error: unknown) => error
      )
      oldClose(ok())
      let thirdOutcome: unknown = 'pending'
      const third = copyOfficeCompressedFile(scope, thirdAbort.signal).then(
        (value) => {
          thirdOutcome = value
        },
        (error) => {
          thirdOutcome = error
        }
      )
      try {
        for (let i = 0; i < 3; i++) await Promise.resolve()
        expect(thirdOutcome).toMatchObject({ code: 'office_copy_busy', closure: 'not_opened' })
        expect(pendingOpens).toHaveLength(1)
      } finally {
        secondAbort.abort()
        thirdAbort.abort()
        await second
        await third
        for (const callback of pendingOpens) callback({ status: 'failed' })
      }
    }
  )
  it('a close ACK past its monotonic deadline confirms closure but cannot succeed before timer dispatch', async () => {
    vi.useFakeTimers()
    const now = vi.spyOn(performance, 'now').mockReturnValue(0)
    const h = host()
    let ack!: Callback
    h.file.closeAsync = (callback) => {
      ack = callback
    }
    try {
      const scope = await preflightOffice(h.sdk)
      const outcome = copyOfficeCompressedFile(scope).catch((error: unknown) => error)
      for (let i = 0; i < 5; i++) await Promise.resolve()
      now.mockReturnValue(2_000)
      ack(ok())
      expect(await outcome).toMatchObject({ code: 'office_close_failed', closure: 'confirmed' })
      expect(vi.getTimerCount()).toBe(0)
      // The actual ACK frees this acquisition: a fresh copy can finish within its own deadline.
      h.file.closeAsync = (callback) => callback(ok())
      expect(await copyOfficeCompressedFile(scope)).toHaveProperty(
        'kind',
        'unpersisted_compressed_copy'
      )
    } finally {
      now.mockRestore()
    }
  })
})
