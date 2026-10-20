// Copyright (c) 2026 Memlia. All rights reserved.
import {
  type OfficePreflight,
  type OfficePreflightCode,
  OfficePreflightError,
  resolveOfficeDocument,
} from './preflight'

export type CopyClosure = 'not_opened' | 'pending' | 'confirmed' | 'unconfirmed'
export type OfficeCopyCode =
  | OfficePreflightCode
  | 'office_copy_busy'
  | 'office_copy_cancelled'
  | 'office_copy_timeout'
  | 'office_open_failed'
  | 'office_file_invalid'
  | 'office_slice_failed'
  | 'office_slice_invalid'
  | 'office_file_changed'
  | 'office_close_failed'
export class OfficeCompressedCopyError extends Error {
  constructor(
    readonly code: OfficeCopyCode,
    readonly closure: CopyClosure
  ) {
    super(code)
    this.name = 'OfficeCompressedCopyError'
  }
}

const SLICE_BYTES = 65_536
const MAX_BYTES = 10_000_000
const busy = new WeakSet<object>()
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}
function succeeded(value: unknown): value is Record<string, unknown> {
  return record(value) && value.status === 'succeeded'
}

/** Full SDK compressed copy only: neither a persisted backup nor a workbook snapshot/authority. */
export async function copyOfficeCompressedFile(scope: OfficePreflight, signal?: AbortSignal) {
  let document: ReturnType<typeof resolveOfficeDocument>
  try {
    document = resolveOfficeDocument(scope)
  } catch (error) {
    throw new OfficeCompressedCopyError(
      error instanceof OfficePreflightError ? error.code : 'office_sdk_failure',
      'not_opened'
    )
  }
  if (signal?.aborted) throw new OfficeCompressedCopyError('office_copy_cancelled', 'not_opened')
  if (busy.has(document.identity))
    throw new OfficeCompressedCopyError('office_copy_busy', 'not_opened')
  busy.add(document.identity)
  let file: Record<string, unknown> | undefined
  let closure: CopyClosure = 'pending'
  let closing: Promise<CopyClosure> | undefined
  let closedWithinDeadline = false
  const deadline = performance.now() + 30_000
  // This acquisition may release its slot only once, even if Office repeats a close ACK.
  let released = false
  const release = () => {
    if (released) return
    released = true
    busy.delete(document.identity)
  }
  const close = (): Promise<CopyClosure> => {
    if (closing) return closing
    if (!file) return Promise.resolve(closure)
    const owned = file
    const closeDeadline = performance.now() + 2_000
    closing = new Promise<CopyClosure>((resolve) => {
      let settled = false
      const finish = (confirmed: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        closure = confirmed ? 'confirmed' : 'unconfirmed'
        closedWithinDeadline = confirmed && performance.now() < closeDeadline
        if (confirmed) release()
        resolve(closure)
      }
      const timer = setTimeout(() => finish(false), 2_000)
      try {
        if (typeof owned.closeAsync !== 'function') {
          finish(false)
          return
        }
        owned.closeAsync((result: unknown) => {
          try {
            // A late ACK may release local exclusion, but never revive the settled copy.
            if (succeeded(result)) {
              closure = 'confirmed'
              release()
              finish(true)
            } else finish(false)
          } catch {
            finish(false)
          }
        })
      } catch {
        finish(false)
      }
    })
    return closing
  }
  const request = (
    start: (callback: (result: unknown) => void) => void,
    code: OfficeCopyCode,
    opening = false
  ) =>
    new Promise<unknown>((resolve, reject) => {
      let settled = false
      let delivered = false
      const finish = (error?: OfficeCopyCode, value?: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        if (error) reject(new OfficeCompressedCopyError(error, closure))
        else resolve(value)
      }
      const abort = () => finish('office_copy_cancelled')
      const timer = setTimeout(
        () => finish('office_copy_timeout'),
        Math.max(0, deadline - performance.now())
      )
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) {
        if (opening) {
          closure = 'not_opened'
          release()
        }
        abort()
        return
      }
      if (performance.now() >= deadline) {
        if (opening) {
          closure = 'not_opened'
          release()
        }
        finish('office_copy_timeout')
        return
      }
      try {
        start((result: unknown) => {
          if (delivered) return
          delivered = true
          try {
            if (opening) {
              // Even after abort/timeout an Office handle must be observed and closed.
              if (succeeded(result) && record(result.value)) {
                if (file) return
                file = result.value
                if (settled) {
                  void close()
                  return
                }
              } else if (record(result) && result.status === 'failed') {
                closure = 'not_opened'
                release()
              } else {
                closure = 'unconfirmed'
              }
            }
            if (settled) return
            if (!succeeded(result)) {
              finish(code)
              return
            }
            finish(undefined, result.value)
          } catch {
            finish(code)
          }
        })
      } catch {
        finish(code)
      }
    })
  try {
    await request((callback) => document.open(SLICE_BYTES, callback), 'office_open_failed', true)
    if (
      !file ||
      typeof file.getSliceAsync !== 'function' ||
      typeof file.closeAsync !== 'function'
    ) {
      throw new OfficeCompressedCopyError('office_file_invalid', closure)
    }
    const size = file.size
    const count = file.sliceCount
    if (
      typeof size !== 'number' ||
      !Number.isSafeInteger(size) ||
      size < 1 ||
      size > MAX_BYTES ||
      typeof count !== 'number' ||
      !Number.isSafeInteger(count) ||
      count !== Math.ceil(size / SLICE_BYTES)
    ) {
      throw new OfficeCompressedCopyError('office_file_invalid', closure)
    }
    const readSlice = file.getSliceAsync
    const bytes = new Uint8Array(size)
    for (let index = 0; index < count; index++) {
      const value = await request(
        (callback) => Reflect.apply(readSlice, file, [index, callback]),
        'office_slice_failed'
      )
      const expected = Math.min(SLICE_BYTES, size - index * SLICE_BYTES)
      if (
        !record(value) ||
        value.index !== index ||
        value.size !== expected ||
        !(Array.isArray(value.data) || value.data instanceof Uint8Array) ||
        value.data.length !== expected
      ) {
        throw new OfficeCompressedCopyError('office_slice_invalid', closure)
      }
      for (let offset = 0; offset < expected; offset++) {
        const byte: unknown = value.data[offset]
        if (typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255) {
          throw new OfficeCompressedCopyError('office_slice_invalid', closure)
        }
        bytes[index * SLICE_BYTES + offset] = byte
      }
    }
    if (performance.now() >= deadline)
      throw new OfficeCompressedCopyError('office_copy_timeout', closure)
    resolveOfficeDocument(scope)
    if (file.size !== size || file.sliceCount !== count)
      throw new OfficeCompressedCopyError('office_file_changed', closure)
    if ((await close()) !== 'confirmed' || !closedWithinDeadline)
      throw new OfficeCompressedCopyError('office_close_failed', closure)
    if (signal?.aborted) throw new OfficeCompressedCopyError('office_copy_cancelled', closure)
    return Object.freeze({
      version: 1,
      kind: 'unpersisted_compressed_copy',
      scope: 'current_office_document',
      byteLength: size,
      sliceCount: count,
      closure: 'confirmed',
      bytes,
    } as const)
  } catch (error) {
    const finalClosure = await close()
    const code =
      error instanceof OfficeCompressedCopyError || error instanceof OfficePreflightError
        ? error.code
        : 'office_sdk_failure'
    throw new OfficeCompressedCopyError(code, finalClosure)
  }
}
