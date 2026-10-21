// Copyright (c) 2026 Memlia. All rights reserved.

export type OfficePreflightCode =
  | 'office_sdk_unavailable'
  | 'office_sdk_invalid'
  | 'office_sdk_failure'
  | 'office_host_unsupported'
  | 'office_platform_unqualified'
  | 'office_document_mode_unsupported'
  | 'office_requirement_missing'
  | 'office_ready_timeout'
  | 'office_preflight_cancelled'
  | 'office_scope_changed'

export class OfficePreflightError extends Error {
  constructor(readonly code: OfficePreflightCode) {
    super(code)
    this.name = 'OfficePreflightError'
  }
}

export type OfficePreflight = Readonly<{
  version: 1
  scope: 'current_office_document'
  host: 'Excel'
  platform: 'PC'
  mode: 'readWrite'
  qualification: 'not_verified'
}>

type Binding = {
  sdk: Record<string, unknown>
  context: Record<string, unknown>
  document: Record<string, unknown>
  open: unknown
}
const bindings = new WeakMap<OfficePreflight, Binding>()
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}
function failure(error: unknown): OfficePreflightError {
  return error instanceof OfficePreflightError
    ? error
    : new OfficePreflightError('office_sdk_failure')
}
function inspect(sdk: Record<string, unknown>): Binding {
  const context = sdk.context
  if (
    !record(context) ||
    !record(context.requirements) ||
    typeof context.requirements.isSetSupported !== 'function' ||
    !record(context.document) ||
    typeof context.document.getFileAsync !== 'function'
  )
    throw new OfficePreflightError('office_sdk_invalid')
  if (context.document.mode !== 'readWrite')
    throw new OfficePreflightError('office_document_mode_unsupported')
  for (const name of ['File', 'CompressedFile']) {
    if (context.requirements.isSetSupported(name, '1.1') !== true)
      throw new OfficePreflightError('office_requirement_missing')
  }
  return { sdk, context, document: context.document, open: context.document.getFileAsync }
}

/** Observation of SDK availability only; this grants no document or server authority. */
export function preflightOffice(office: unknown, signal?: AbortSignal): Promise<OfficePreflight> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new OfficePreflightError('office_preflight_cancelled'))
      return
    }
    const deadline = performance.now() + 10_000
    let settled = false
    const finish = (error?: OfficePreflightError, result?: OfficePreflight) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve(result!)
    }
    const abort = () => finish(new OfficePreflightError('office_preflight_cancelled'))
    const timer = setTimeout(() => finish(new OfficePreflightError('office_ready_timeout')), 10_000)
    signal?.addEventListener('abort', abort, { once: true })
    try {
      if (!record(office) || typeof office.onReady !== 'function')
        throw new OfficePreflightError('office_sdk_unavailable')
      Promise.resolve(office.onReady()).then(
        (info: unknown) => {
          if (settled) return
          if (performance.now() >= deadline) {
            finish(new OfficePreflightError('office_ready_timeout'))
            return
          }
          try {
            if (!record(info) || info.host !== 'Excel')
              throw new OfficePreflightError('office_host_unsupported')
            if (info.platform !== 'PC')
              throw new OfficePreflightError('office_platform_unqualified')
            const binding = inspect(office)
            const result = Object.freeze({
              version: 1,
              scope: 'current_office_document',
              host: 'Excel',
              platform: 'PC',
              mode: 'readWrite',
              qualification: 'not_verified',
            } as const)
            bindings.set(result, binding)
            finish(undefined, result)
          } catch (error) {
            finish(failure(error))
          }
        },
        () => finish(new OfficePreflightError('office_sdk_failure'))
      )
    } catch (error) {
      finish(failure(error))
    }
  })
}

/** Internal seam: exact observation identity, never a serializable authorization token. */
export function resolveOfficeDocument(scope: OfficePreflight) {
  try {
    const binding = bindings.get(scope)
    if (!binding) throw new OfficePreflightError('office_scope_changed')
    const current = inspect(binding.sdk)
    if (
      current.context !== binding.context ||
      current.document !== binding.document ||
      current.open !== binding.open
    ) {
      throw new OfficePreflightError('office_scope_changed')
    }
    const open = binding.open
    if (typeof open !== 'function') throw new OfficePreflightError('office_sdk_invalid')
    return {
      identity: binding.document,
      open(sliceSize: number, callback: (result: unknown) => void): void {
        Reflect.apply(open, binding.document, ['compressed', { sliceSize }, callback])
      },
    }
  } catch (error) {
    throw failure(error)
  }
}
