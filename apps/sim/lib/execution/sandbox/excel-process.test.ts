// Copyright (c) 2026 Memlia. All rights reserved.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { prepareExcelInProcess } from './excel-process'

const roots: string[] = []
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
const program = `require('node:fs').writeFileSync(require('node:path').join(__dirname,'started'),String(process.pid));let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',s=>text+=s);process.stdin.on('end',()=>{const input=JSON.parse(text);const content=Buffer.from('fictitious transport output');const result={schemaVersion:'memlia.excel-process/v1',requestId:input.requestId,status:'prepared_in_memory',published:false,outputs:[{role:'result',bindingId:'result-binding',sheetId:'result-sheet',contentBase64:content.toString('base64'),sha256:'sha256:'+require('node:crypto').createHash('sha256').update(content).digest('hex')}],controls:[{index:0,kind:'balance',severity:'blocking',satisfied:true}]}; ACTION });`
async function runtime(action = 'process.stdout.write(JSON.stringify(result)+"\\n")') {
  const root = await mkdtemp(join(tmpdir(), 'memlia-excel-process-test-'))
  roots.push(root)
  const pythonExecutable = join(root, 'python-fixture')
  const temporaryRoot = join(root, 'jobs')
  await import('node:fs/promises').then((fs) => fs.mkdir(temporaryRoot, { mode: 0o700 }))
  await writeFile(pythonExecutable, `#!${process.execPath}\n${program.replace('ACTION', action)}`, {
    mode: 0o700,
  })
  return { pythonExecutable, temporaryRoot }
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    try {
      const pid = Number(await readFile(join(root, 'started'), 'utf8'))
      expect(() => process.kill(pid, 0)).toThrow()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await rm(root, { recursive: true, force: true })
  }
})

test('real owned child returns complete checked bytes and removes only its temporary directory', async () => {
  const rt = await runtime()
  const result = await prepareExcelInProcess(input(), rt, { requestId: 'captured-id' })
  expect(result.status).toBe('prepared_in_memory')
  expect(result.published).toBe(false)
  expect(result.outputs[0].content.toString()).toBe('fictitious transport output')
  expect(await readdir(rt.temporaryRoot)).toEqual([])
  expect(await readdir(join(rt.temporaryRoot, '..'))).toContain('python-fixture')
})

test.each([
  ['partial', 'result.outputs=[];'],
  [
    'empty',
    'result.outputs[0].contentBase64="";result.outputs[0].sha256="sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";',
  ],
  ['foreign', 'result.outputs[0].bindingId="foreign";'],
  ['digest', 'result.outputs[0].sha256="sha256:"+"0".repeat(64);'],
  ['unknown', 'result.extra="PRIVATE_CANARY";'],
  ['published', 'result.published=true;'],
  ['control', 'result.controls[0].satisfied=false;'],
  ['request', 'result.requestId="foreign";'],
  ['trailing', ''],
])('refuses %s response without exposing child data', async (name, mutation) => {
  const rt = await runtime(
    `${mutation}process.stdout.write(JSON.stringify(result)${name === 'trailing' ? '+" {}"' : ''}+"\\n");`
  )
  await expect(prepareExcelInProcess(input(), rt)).rejects.toThrow('excel_process_refused')
  expect(await readdir(rt.temporaryRoot)).toEqual([])
})

test.each(['stdout', 'stderr'])(
  'bounded %s overflow kills and waits for the owned process',
  async (stream) => {
    const rt = await runtime(
      `process.${stream}.write('PRIVATE_CANARY'.repeat(${stream === 'stdout' ? 1300000 : 6000}));setInterval(()=>{},1000);`
    )
    await expect(prepareExcelInProcess(input(), rt)).rejects.toThrow('excel_process_refused')
    expect(await readdir(rt.temporaryRoot)).toEqual([])
  }
)

test('timeout and live cancellation refuse without output or retry', async () => {
  const rt = await runtime('setInterval(()=>{},1000)')
  await expect(prepareExcelInProcess(input(), rt)).rejects.toThrow('excel_process_refused')
  const controller = new AbortController()
  const work = prepareExcelInProcess(input(), rt, { signal: controller.signal })
  setTimeout(() => controller.abort(), 50)
  await expect(work).rejects.toThrow('excel_process_refused')
  expect(await readdir(rt.temporaryRoot)).toEqual([])
})

test('captures data before the first await and never forwards ambient secrets or arbitrary arguments', async () => {
  const rt = await runtime(
    'if(input.targets.result.bindingId!=="result-binding" || process.env.PRIVATE_CANARY || JSON.stringify(process.argv.slice(2))!==JSON.stringify(["-I","-B","-m","memlia_excel.process"]))throw new Error("PRIVATE_CANARY");process.stdout.write(JSON.stringify(result)+"\\n")'
  )
  process.env.PRIVATE_CANARY = 'PRIVATE_CANARY'
  try {
    const data = input()
    const work = prepareExcelInProcess(data, rt)
    data.targets.result.bindingId = 'foreign'
    await expect(work).resolves.toMatchObject({ status: 'prepared_in_memory' })
  } finally {
    Reflect.deleteProperty(process.env, 'PRIVATE_CANARY')
  }
})

test('invalid input, getters, canceled requests and relative runtime never spawn', async () => {
  const rt = await runtime()
  const controller = new AbortController()
  controller.abort()
  await expect(prepareExcelInProcess(input(), rt, { signal: controller.signal })).rejects.toThrow(
    'excel_process_refused'
  )
  let reads = 0
  const data = input()
  Object.defineProperty(data, 'sources', {
    get() {
      reads++
      return {}
    },
  })
  await expect(prepareExcelInProcess(data, rt)).rejects.toThrow('excel_process_refused')
  expect(reads).toBe(0)
  await expect(
    prepareExcelInProcess({ ...input(), command: 'PRIVATE_CANARY' }, rt)
  ).rejects.toThrow('excel_process_refused')
  await expect(
    prepareExcelInProcess(input(), { ...rt, pythonExecutable: 'python' })
  ).rejects.toThrow('excel_process_refused')
  expect(await readdir(rt.temporaryRoot)).toEqual([])
})

test('temporary root must be private and child failure never becomes prepared', async () => {
  const rt = await runtime('process.stderr.write("PRIVATE_CANARY");process.exit(3)')
  await expect(prepareExcelInProcess(input(), rt)).rejects.toThrow('excel_process_refused')
  await chmod(rt.temporaryRoot, 0o755)
  await expect(prepareExcelInProcess(input(), rt)).rejects.toThrow('excel_process_refused')
  expect(await readdir(rt.temporaryRoot)).toEqual([])
})

test('duplicate response keys and malformed UTF-8 are not silently normalized', async () => {
  for (const action of [
    `process.stdout.write(JSON.stringify(result).replace('{','{"published":true,')+"\\n")`,
    'process.stdout.write(Buffer.concat([Buffer.from(JSON.stringify(result).replace("result-binding","badUTF")),Buffer.from([255])]))',
  ]) {
    const rt = await runtime(action)
    await expect(prepareExcelInProcess(input(), rt)).rejects.toThrow('excel_process_refused')
    expect(await readFile(join(rt.temporaryRoot, '..', 'started'), 'utf8')).toMatch(/^\d+$/)
  }
})

test('bounded larger content does not overflow the base64 validator stack', async () => {
  const rt = await runtime()
  const data = input()
  const content = Buffer.alloc(120_000, 97)
  data.sources.source.contentBase64 = content.toString('base64')
  data.sources.source.sha256 = `sha256:${createHash('sha256').update(content).digest('hex')}`
  await expect(prepareExcelInProcess(data, rt)).resolves.toMatchObject({
    status: 'prepared_in_memory',
  })
})

test('installed canonical package prepares and reads back a real XLSX through the Sim caller', async () => {
  const python = process.env.MEMLIA_TEST_EXCEL_RUNTIME
  if (!python)
    throw new Error('MEMLIA_TEST_EXCEL_RUNTIME required: installed runtime, no source fallback')
  const rt = await runtime()
  rt.pythonExecutable = python
  const data = input()
  data.procedure.limits.timeoutSeconds = 10
  const generate = `import base64,io,openpyxl
b=openpyxl.Workbook();b.active.title="Input"
for row in [["id","debit","credit"],["a","0.10","0.10"],["b","0.20","0.20"]]:b.active.append(row)
f=io.BytesIO();b.save(f);b.close();print(base64.b64encode(f.getvalue()).decode())`
  const env = { PATH: '/usr/bin:/bin', TMPDIR: rt.temporaryRoot, POLARS_MAX_THREADS: '1' }
  const encoded = execFileSync(python, ['-I', '-B', '-c', generate], {
    cwd: rt.temporaryRoot,
    env,
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 1024 * 1024,
  }).trim()
  data.sources.source.contentBase64 = encoded
  data.sources.source.sha256 = `sha256:${createHash('sha256').update(Buffer.from(encoded, 'base64')).digest('hex')}`
  const result = await prepareExcelInProcess(data, rt)
  expect(result.status).toBe('prepared_in_memory')
  expect(result.published).toBe(false)
  const inspect = `import sys,io,json,openpyxl
b=openpyxl.load_workbook(io.BytesIO(sys.stdin.buffer.read()),read_only=True);print(json.dumps(list(b["Result"].values)));b.close()`
  const actual = execFileSync(python, ['-I', '-B', '-c', inspect], {
    input: result.outputs[0].content,
    cwd: rt.temporaryRoot,
    env,
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 1024 * 1024,
  })
  expect(JSON.parse(actual)).toEqual([
    ['id', 'debit', 'credit'],
    ['a', '0.10', '0.10'],
    ['b', '0.20', '0.20'],
  ])
  expect(await readdir(rt.temporaryRoot)).toEqual([])
})

test.each(['input', 'output'])(
  'accepts exactly 10M decoded bytes at the %s transport boundary',
  async (direction) => {
    const content = Buffer.alloc(10_000_000, 97)
    const sha256 = `sha256:${createHash('sha256').update(content).digest('hex')}`
    const rt = await runtime(
      direction === 'output'
        ? 'const value=Buffer.alloc(10_000_000,97);result.outputs[0].contentBase64=value.toString("base64");result.outputs[0].sha256="sha256:"+require("node:crypto").createHash("sha256").update(value).digest("hex");process.stdout.write(JSON.stringify(result)+"\\n");'
        : undefined
    )
    const data = input()
    data.procedure.limits.timeoutSeconds = 5
    if (direction === 'input') {
      data.sources.source.contentBase64 = content.toString('base64')
      data.sources.source.sha256 = sha256
    }
    const result = await prepareExcelInProcess(data, rt)
    expect(result.status).toBe('prepared_in_memory')
    if (direction === 'output') {
      expect(result.outputs[0].content.equals(content)).toBe(true)
      expect(result.outputs[0].sha256).toBe(sha256)
    } else expect(result.outputs[0].content.toString()).toBe('fictitious transport output')
    expect(await readdir(rt.temporaryRoot)).toEqual([])
    expect(await readFile(join(rt.temporaryRoot, '..', 'started'), 'utf8')).toMatch(/^\d+$/)
  }
)

test.each(['input', 'output'])(
  'refuses 10M plus one decoded byte at the %s boundary despite a valid digest',
  async (direction) => {
    const rt = await runtime(
      direction === 'output'
        ? 'const value=Buffer.alloc(10_000_001,97);result.outputs[0].contentBase64=value.toString("base64");result.outputs[0].sha256="sha256:"+require("node:crypto").createHash("sha256").update(value).digest("hex");process.stdout.write(JSON.stringify(result)+"\\n");'
        : undefined
    )
    const data = input()
    data.procedure.limits.timeoutSeconds = 5
    if (direction === 'input') {
      const content = Buffer.alloc(10_000_001, 97)
      data.sources.source.contentBase64 = content.toString('base64')
      data.sources.source.sha256 = `sha256:${createHash('sha256').update(content).digest('hex')}`
    }
    await expect(prepareExcelInProcess(data, rt)).rejects.toThrow('excel_process_refused')
    if (direction === 'input')
      await expect(readFile(join(rt.temporaryRoot, '..', 'started'))).rejects.toMatchObject({
        code: 'ENOENT',
      })
    expect(await readdir(rt.temporaryRoot)).toEqual([])
  }
)

test.each(['YQ', 'YR==', 'YQ==\n', 'Y=Q=', 'YQ-_', 'YQ==='])(
  'refuses noncanonical base64 %j on both boundaries even with the decoded hash',
  async (encoded) => {
    const decoded = Buffer.from(encoded, 'base64')
    const sha256 = `sha256:${createHash('sha256').update(decoded).digest('hex')}`
    const data = input()
    data.sources.source.contentBase64 = encoded
    data.sources.source.sha256 = sha256
    const rt = await runtime()
    await expect(prepareExcelInProcess(data, rt)).rejects.toThrow('excel_process_refused')
    await expect(readFile(join(rt.temporaryRoot, '..', 'started'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    const malformed = await runtime(
      `result.outputs[0].contentBase64=${JSON.stringify(encoded)};result.outputs[0].sha256=${JSON.stringify(sha256)};process.stdout.write(JSON.stringify(result)+"\\n");`
    )
    await expect(prepareExcelInProcess(input(), malformed)).rejects.toThrow('excel_process_refused')
    expect(await readdir(malformed.temporaryRoot)).toEqual([])
  }
)

test('owned child has a fixed production mode without inheriting the parent mode', async () => {
  const rt = await runtime(
    'if(process.env.NODE_ENV!=="production")throw new Error("fixture_mode_refused");process.stdout.write(JSON.stringify(result)+"\\n");'
  )
  const result = await prepareExcelInProcess(input(), rt)
  expect(result.status).toBe('prepared_in_memory')
  expect(await readdir(rt.temporaryRoot)).toEqual([])
})
