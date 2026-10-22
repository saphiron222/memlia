// Modified by Memlia: qualify opt-in strict JSON capture while retaining legacy semantics.
import { describe, expect, it, vi } from 'vitest'
import {
  isJsonWithinByteLimit,
  readOwnDataString,
  stringifyBoundedJson,
} from '@/lib/core/utils/bounded-json'

describe('strict bounded JSON capture for workflow previews', () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])(
    'refuses an invalid strict byte bound: %s',
    (bound) => {
      expect(stringifyBoundedJson(null, bound, { strict: true })).toBeUndefined()
    }
  )

  it('enforces strict depth and node boundaries without accepting sparse compensation', () => {
    let admitted: unknown = null
    for (let index = 0; index < 64; index++) admitted = [admitted]
    expect(stringifyBoundedJson(admitted, 1024, { strict: true })).toBeDefined()
    expect(stringifyBoundedJson([admitted], 1024, { strict: true })).toBeUndefined()
    expect(stringifyBoundedJson(Array(99999).fill(null), 1000000, { strict: true })).toBeDefined()
    expect(
      stringifyBoundedJson(Array(100000).fill(null), 1000000, { strict: true })
    ).toBeUndefined()
    const sparse = Object.assign(Array(2), { 1: 1, extra: 'PRIVATE_CANARY' })
    expect(stringifyBoundedJson(sparse, 1024, { strict: true })).toBeUndefined()
    expect(
      stringifyBoundedJson(Object.defineProperty([1], 'extra', { value: 1 }), 1024, {
        strict: true,
      })
    ).toBeUndefined()
  })

  it.each([
    { value: undefined },
    { value: Number.NaN },
    { value: Number.POSITIVE_INFINITY },
    { value: { input: undefined } },
    { value: { input: () => 'value' } },
    { value: { input: Symbol('value') } },
    { value: [undefined] },
    { value: Array(1) },
    { value: Object.assign([], { extra: true }) },
    { value: Object.defineProperty({}, 'hidden', { value: 1 }) },
    { value: { [Symbol('hidden')]: 1 } },
    { value: Object.setPrototypeOf([], Object.create(Array.prototype)) },
  ])('rejects lossy or non-JSON values before serialization: $value', ({ value }) => {
    expect(stringifyBoundedJson(value, 1024, { strict: true })).toBeUndefined()
  })

  it('captures independent ordinary JSON and preserves the exact UTF-8 byte limit', () => {
    const value = { input: ['é', 1, false, null], nested: { enabled: true } }
    const json = '{"input":["é",1,false,null],"nested":{"enabled":true}}'
    expect(stringifyBoundedJson(value, Buffer.byteLength(json), { strict: true })).toBe(json)
    expect(
      stringifyBoundedJson(value, Buffer.byteLength(json) - 1, { strict: true })
    ).toBeUndefined()
  })

  it('never invokes getters or toJSON while refusing strict input', () => {
    const get = vi.fn(() => 'private value')
    const toJSON = vi.fn(() => 'private value')
    for (const value of [
      Object.defineProperty({}, 'input', { enumerable: true, get }),
      Object.defineProperty([1], '0', { enumerable: true, get }),
      { toJSON },
    ])
      expect(stringifyBoundedJson(value, 1024, { strict: true })).toBeUndefined()
    expect(get).not.toHaveBeenCalled()
    expect(toJSON).not.toHaveBeenCalled()
  })
})

describe('bounded JSON', () => {
  it.each([
    { value: { text: 'hello', values: [1, false, null] } },
    { value: { text: 'é😀\ud800\udc00\ud800' } },
    { value: { absent: undefined, values: [undefined, Number.NaN] } },
    { value: { text: '\u0000\n"\\' } },
    { value: Array.from({ length: 5000 }, () => 0) },
  ])('uses the caller byte limit including UTF-8 and escaped JSON bytes', ({ value }) => {
    const json = JSON.stringify(value)
    const bytes = Buffer.byteLength(json, 'utf8')
    expect(stringifyBoundedJson(value, bytes)).toBe(json)
    expect(stringifyBoundedJson(value, bytes - 1)).toBeUndefined()
    expect(isJsonWithinByteLimit(value, bytes)).toBe(true)
    expect(isJsonWithinByteLimit(value, bytes - 1)).toBe(false)
  })

  it('rejects cycles, excessive depth, and excessive nodes', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(isJsonWithinByteLimit(cyclic, 1024)).toBe(false)
    let deep: unknown = 'leaf'
    for (let index = 0; index < 66; index++) deep = { child: deep }
    for (const value of [
      cyclic,
      deep,
      Array(100_001),
      Object.fromEntries(Array.from({ length: 100_001 }, (_, index) => [index, undefined])),
    ]) {
      expect(stringifyBoundedJson(value, 8 * 1024 * 1024)).toBeUndefined()
    }
  })

  it('does not execute accessors or custom serialization', () => {
    const getter = vi.fn(() => 'private value')
    const toJSON = vi.fn(() => 'private value')
    const accessor = Object.defineProperty({}, 'secret', { enumerable: true, get: getter })
    const custom = Object.defineProperty({}, 'toJSON', { value: toJSON })
    for (const value of [accessor, custom, { output: new Uint8Array([1, 2, 3]) }]) {
      expect(stringifyBoundedJson(value, 1024)).toBeUndefined()
      expect(isJsonWithinByteLimit(value, 1024)).toBe(false)
    }
    expect(getter).not.toHaveBeenCalled()
    expect(toJSON).not.toHaveBeenCalled()
  })

  it('stops before serializing an oversized payload', () => {
    const value = { output: 'x'.repeat(1025) }
    const serialize = vi.spyOn(JSON, 'stringify')
    try {
      expect(stringifyBoundedJson(value, 1024)).toBeUndefined()
      expect(isJsonWithinByteLimit(value, 1024)).toBe(false)
      expect(serialize).not.toHaveBeenCalled()
    } finally {
      serialize.mockRestore()
    }
  })

  it.each([
    { value: { text: '\u0000'.repeat(200) } },
    { value: { ['\u0000'.repeat(200)]: 'value' } },
    { value: { text: '\ud800'.repeat(200) } },
  ])('rejects escaped bytes before serializing the captured graph', ({ value }) => {
    const serialize = vi.spyOn(JSON, 'stringify')
    try {
      expect(stringifyBoundedJson(value, 1024)).toBeUndefined()
      expect(isJsonWithinByteLimit(value, 1024)).toBe(false)
      expect(serialize).not.toHaveBeenCalled()
    } finally {
      serialize.mockRestore()
    }
  })

  it('serializes the admitted descriptors without reading proxy values or toJSON', () => {
    const get = vi.fn(() => 'UNADMITTED')
    const value = new Proxy({ text: 'admitted' }, { get })
    expect(stringifyBoundedJson(value, 1024)).toBe('{"text":"admitted"}')
    expect(isJsonWithinByteLimit(value, 19)).toBe(true)
    expect(get).not.toHaveBeenCalled()
  })

  it('does not read inherited numeric accessors in sparse arrays', () => {
    const get = vi.fn(() => 'UNADMITTED')
    const prototype = Object.create(Array.prototype, { 0: { get } })
    const value = Object.setPrototypeOf(Array(1), prototype)
    expect(stringifyBoundedJson(value, 1024)).toBe('[null]')
    expect(isJsonWithinByteLimit(value, 6)).toBe(true)
    expect(get).not.toHaveBeenCalled()
  })

  it('allows repeated references without treating them as a cycle', () => {
    const result = { answer: 42 }
    const value = { rawResponse: result, modelResponse: result }
    expect(stringifyBoundedJson(value, 1024)).toBe(JSON.stringify(value))
    expect(isJsonWithinByteLimit(value, Buffer.byteLength(JSON.stringify(value)))).toBe(true)
  })

  it('counts an ordinary toJSON data field without invoking custom serialization', () => {
    const value = { toJSON: 'ordinary JSON field', nested: [{}, [], { flag: true }] }
    const bytes = Buffer.byteLength(JSON.stringify(value))
    expect(isJsonWithinByteLimit(value, bytes)).toBe(true)
    expect(isJsonWithinByteLimit(value, bytes - 1)).toBe(false)
  })

  it.each(['method', 'accessor'] as const)(
    'rejects an inherited toJSON %s without invoking it or ignoring an own shadow',
    (kind) => {
      const serialize = vi.fn(() => 'x'.repeat(2048))
      const prototype = Object.create(Array.prototype, {
        toJSON: kind === 'method' ? { value: serialize } : { get: serialize },
      })
      const value = Object.setPrototypeOf([], Object.create(prototype))
      expect(isJsonWithinByteLimit(value, 1024)).toBe(false)
      expect(serialize).not.toHaveBeenCalled()
      Object.defineProperty(value, 'toJSON', { value: null })
      expect(isJsonWithinByteLimit(value, 2)).toBe(true)
      expect(serialize).not.toHaveBeenCalled()
    }
  )
})

describe('own data string reads for log correlation', () => {
  it('reads a nested own data string', () => {
    expect(readOwnDataString({ params: { workflowId: 'w' } }, ['params', 'workflowId'])).toBe('w')
  })
  it('never runs an accessor and reads it as absent', () => {
    const get = vi.fn(() => 'w')
    expect(readOwnDataString(Object.defineProperty({}, 'id', { get }), ['id'])).toBeUndefined()
    expect(get).not.toHaveBeenCalled()
  })
  it.each([
    [undefined, ['id']],
    [{ id: 1 }, ['id']],
    [{ params: undefined }, ['params', 'workflowId']],
    [Object.create({ id: 'inherited' }), ['id']],
    [{ id: 'x'.repeat(257) }, ['id']],
  ])('reads %j along %j as absent', (value, path) => {
    expect(readOwnDataString(value, path)).toBeUndefined()
  })
  it('swallows a throwing proxy trap', () => {
    const proxy = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error('trap')
        },
      }
    )
    expect(readOwnDataString(proxy, ['id'])).toBeUndefined()
  })
})
