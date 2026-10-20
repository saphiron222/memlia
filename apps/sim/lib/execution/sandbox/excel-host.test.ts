// Copyright (c) 2026 Memlia. All rights reserved.
// Real Unix IPC; Linux/owner filesystem metadata explicitly doubled on Mac.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'

const state = vi.hoisted(() => ({ uid: 0, mode: 0o755, platform: 'linux' }))
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  platform: () => state.platform,
}))
vi.mock('node:fs/promises', async (original) => {
  const native = await original<typeof import('node:fs/promises')>()
  return {
    ...native,
    lstat: async (path: string) => {
      const row = await native.lstat(path)
      return Object.assign(Object.create(Object.getPrototypeOf(row)), row, {
        uid: state.uid,
        mode: (row.mode & ~0o777) | (row.isSocket() ? 0o660 : state.mode),
      })
    },
  }
})

import { prepareExcelThroughHost } from './excel-host'

const area = { sheetId: 'result-sheet', startRow: 1, endRow: 3, startColumn: 1, endColumn: 3 }
function input() {
  const content = Buffer.from('fictitious transport only')
  return {
    procedure: {
      schemaVersion: 'memlia.excel-procedure/v1',
      organizationId: null,
      workspaceId: 'workspace-fixture',
      procedureId: 'procedure-fixture',
      version: 1,
      parentVersion: null,
      workflowId: 'workflow-fixture',
      deployedVersionId: 'deployed-fixture',
      ownerUserId: 'user-fixture',
      digest: `sha256:${'a'.repeat(64)}`,
      policyVersion: 'policy-fixture',
      inputs: [
        {
          role: 'source',
          bindingId: 'source-binding',
          format: 'xlsx',
          sheetId: 'source-sheet',
          columns: [
            { name: 'id', type: 'string', nullable: false },
            { name: 'debit', type: 'decimal', nullable: true },
            { name: 'credit', type: 'decimal', nullable: true },
          ],
          keyColumns: ['id'],
          cardinality: 'one',
          locale: 'en-US',
          nullPolicy: 'preserve',
        },
      ],
      mappings: [],
      operations: [
        { op: 'select', input: 'source', output: 'selected', columns: ['id', 'debit', 'credit'] },
      ],
      writes: [
        {
          input: 'selected',
          destinationBindingId: 'result-binding',
          range: area,
          columns: [
            { source: 'id', targetColumn: 1 },
            { source: 'debit', targetColumn: 2 },
            { source: 'credit', targetColumn: 3 },
          ],
          mode: 'regenerate_owned_zone',
        },
      ],
      writeScopes: [area],
      protectedScopes: [],
      decimalPolicy: { precision: 18, scale: 2, rounding: 'half_even', allNullAggregate: 'null' },
      formulaPolicy: { externalLinks: 'reject', dataStrings: 'literal', allowedFunctions: [] },
      controls: [
        {
          kind: 'balance',
          input: 'selected',
          debit: 'debit',
          credit: 'credit',
          tolerance: '0.00',
          severity: 'blocking',
        },
      ],
      requiredCapabilities: ['file.xlsx', 'table.select'],
      limits: { maxRows: 100, maxCells: 1000, timeoutSeconds: 1 },
      idempotence: { mode: 'regenerate_owned_zone', businessKeyColumns: ['id'] },
      outputs: [{ role: 'result', bindingId: 'result-binding', format: 'xlsx' }],
    },
    sources: {
      source: {
        bindingId: 'source-binding',
        sheetId: 'source-sheet',
        sheetName: 'Input',
        contentBase64: content.toString('base64'),
        sha256: `sha256:${createHash('sha256').update(content).digest('hex')}`,
      },
    },
    targets: {
      result: { bindingId: 'result-binding', sheetId: 'result-sheet', sheetName: 'Result' },
    },
  }
}

const servers: Server[] = []
const sockets = new Set<Socket>()
const roots: string[] = []
async function endpoint(onWire: (wire: string, socket: Socket) => void) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'excel-host-')))
  roots.push(root)
  const socketPath = join(root, 'host.sock')
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    let data = Buffer.alloc(0)
    socket.on('data', (part) => {
      data = Buffer.concat([data, part])
      if (data.length >= 4 && data.length === data.readUInt32BE(0) + 4)
        onWire(data.subarray(4).toString(), socket)
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  return { socketPath, operatorUid: 0 }
}
function reply(wire: string, socket: Socket) {
  const request = JSON.parse(wire)
  const content = Buffer.from('fixture output')
  const body = Buffer.from(
    JSON.stringify({
      schemaVersion: 'memlia.excel-process/v1',
      requestId: request.requestId,
      status: 'prepared_in_memory',
      published: false,
      outputs: [
        {
          role: 'result',
          bindingId: 'result-binding',
          sheetId: 'result-sheet',
          contentBase64: content.toString('base64'),
          sha256: `sha256:${createHash('sha256').update(content).digest('hex')}`,
        },
      ],
      controls: [{ index: 0, kind: 'balance', severity: 'blocking', satisfied: true }],
    }) + '\n'
  )
  const prefix = Buffer.alloc(5)
  prefix.writeUInt32BE(body.length, 1)
  socket.end(Buffer.concat([prefix, body]))
}
afterEach(async () => {
  for (const socket of sockets) socket.destroy()
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()))
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: false })
  state.uid = 0
  state.mode = 0o755
  state.platform = 'linux'
})
test('revalidates real socket bytes before returning a prepared result', async () => {
  const runtime = await endpoint(reply)
  const result = await prepareExcelThroughHost(input(), runtime)
  expect(result.outputs[0].content.toString()).toBe('fixture output')
  expect(result.published).toBe(false)
})
test('operator refusal cannot fall back to local Python', async () => {
  const runtime = await endpoint((_wire, socket) => socket.end(Buffer.from([1, 0, 0, 0, 0])))
  await expect(prepareExcelThroughHost(input(), runtime)).rejects.toThrow('excel_process_refused')
})

test.each(['darwin', 'win32'])('refuses %s without a Unix attempt', async (platform) => {
  let calls = 0
  const runtime = await endpoint(() => {
    calls++
  })
  state.platform = platform
  await expect(prepareExcelThroughHost(input(), runtime)).rejects.toThrow('excel_process_refused')
  expect(calls).toBe(0)
})
test.each(['owner', 'writable-parent'])(
  'refuses unsafe %s metadata before any request',
  async (kind) => {
    let calls = 0
    const runtime = await endpoint(() => {
      calls++
    })
    if (kind === 'owner') state.uid = 7777
    else state.mode = 0o777
    await expect(prepareExcelThroughHost(input(), runtime)).rejects.toThrow('excel_process_refused')
    expect(calls).toBe(0)
  }
)
test.each([
  ['empty', Buffer.from([0, 0, 0, 0, 0])],
  ['oversize', Buffer.from([0, 1, 0, 0, 0])],
  ['partial', Buffer.from([0, 0, 0, 0, 2, 123])],
  ['trailing', Buffer.from([0, 0, 0, 0, 1, 123, 125])],
  ['invalid-utf8', Buffer.from([0, 0, 0, 0, 1, 255])],
  ['foreign-status', Buffer.from([2, 0, 0, 0, 0])],
])('refuses %s frame without another attempt', async (_kind, frame) => {
  let calls = 0
  const runtime = await endpoint((_wire, socket) => {
    calls++
    socket.end(frame)
  })
  await expect(prepareExcelThroughHost(input(), runtime)).rejects.toThrow('excel_process_refused')
  expect(calls).toBe(1)
})
test('abort before connect sends no request; abort while waiting closes owned socket', async () => {
  const controller = new AbortController()
  let arrived!: () => void
  const started = new Promise<void>((resolve) => {
    arrived = resolve
  })
  let calls = 0
  const runtime = await endpoint(() => {
    calls++
    arrived()
  })
  const prior = new AbortController()
  prior.abort()
  await expect(prepareExcelThroughHost(input(), runtime, { signal: prior.signal })).rejects.toThrow(
    'excel_process_refused'
  )
  expect(calls).toBe(0)
  const pending = prepareExcelThroughHost(input(), runtime, { signal: controller.signal })
  const rejected = expect(pending).rejects.toThrow('excel_process_refused')
  await started
  controller.abort()
  await rejected
  expect(calls).toBe(1)
})
test('response arrival cannot undo cancellation', async () => {
  const controller = new AbortController()
  const runtime = await endpoint((wire, socket) => {
    reply(wire, socket)
    controller.abort()
  })
  await expect(
    prepareExcelThroughHost(input(), runtime, { signal: controller.signal })
  ).rejects.toThrow('excel_process_refused')
})
test('timeout refuses without another physical attempt', async () => {
  let calls = 0
  const runtime = await endpoint(() => {
    calls++
  })
  await expect(prepareExcelThroughHost(input(), runtime)).rejects.toThrow('excel_process_refused')
  expect(calls).toBe(1)
})
test('captures procedure and runtime before the first await', async () => {
  const data = input()
  const runtime = await endpoint((wire, socket) => {
    expect(JSON.parse(wire).procedure.workflowId).toBe('workflow-fixture')
    reply(wire, socket)
  })
  const pending = prepareExcelThroughHost(data, runtime)
  data.procedure.workflowId = 'mutated'
  runtime.socketPath = '/untrusted/changed'
  expect((await pending).outputs).toHaveLength(1)
})
test('runtime accessor is refused without invoking it or opening the socket', async () => {
  let getters = 0
  const runtime = {
    operatorUid: 0,
    get socketPath() {
      getters++
      return '/unused'
    },
  }
  await expect(prepareExcelThroughHost(input(), runtime)).rejects.toThrow('excel_process_refused')
  expect(getters).toBe(0)
})

// Actual installed Python kernel, but the host endpoint below is a protocol double,
// not supervisor.execute and not evidence of Linux isolation or admitted image.
test('real installed XLSX bytes compose through Unix framing and native revalidation', async () => {
  const python = process.env.MEMLIA_TEST_EXCEL_RUNTIME
  if (!python) throw new Error('installed_runtime_required')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'excel-host-kernel-')))
  roots.push(root)
  const env = { PATH: '/usr/bin:/bin', TMPDIR: root, POLARS_MAX_THREADS: '1' }
  const content = execFileSync(
    python,
    [
      '-I',
      '-B',
      '-c',
      `import io,sys,openpyxl
b=openpyxl.Workbook();b.active.title="Input"
for row in [["id","debit","credit"],["a","0.10","0.10"],["b","0.20","0.20"]]:b.active.append(row)
f=io.BytesIO();b.save(f);b.close();sys.stdout.buffer.write(f.getvalue())`,
    ],
    { env, cwd: root, timeout: 10000, maxBuffer: 1024 * 1024 }
  )
  const data = input()
  data.procedure.limits.timeoutSeconds = 10
  data.sources.source.contentBase64 = content.toString('base64')
  data.sources.source.sha256 = `sha256:${createHash('sha256').update(content).digest('hex')}`
  let calls = 0
  const runtime = await endpoint((wire, socket) => {
    calls++
    const body = execFileSync(python, ['-I', '-B', '-m', 'memlia_excel.process'], {
      input: wire,
      env,
      cwd: root,
      timeout: 10000,
      maxBuffer: 14 * 1024 * 1024,
    })
    const prefix = Buffer.alloc(5)
    prefix.writeUInt32BE(body.length, 1)
    socket.end(Buffer.concat([prefix, body]))
  })
  const result = await prepareExcelThroughHost(data, runtime)
  const inspected = execFileSync(
    python,
    [
      '-I',
      '-B',
      '-c',
      `import io,sys,json,openpyxl
b=openpyxl.load_workbook(io.BytesIO(sys.stdin.buffer.read()),read_only=True);print(json.dumps(list(b["Result"].values)));b.close()`,
    ],
    {
      input: result.outputs[0].content,
      env,
      cwd: root,
      timeout: 10000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
    }
  )
  expect(JSON.parse(inspected)).toEqual([
    ['id', 'debit', 'credit'],
    ['a', '0.10', '0.10'],
    ['b', '0.20', '0.20'],
  ])
  expect(calls).toBe(1)
  expect(result.published).toBe(false)
})
