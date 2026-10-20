// Copyright (c) 2026 Memlia. All rights reserved.
import { spawn } from 'node:child_process'
import { chmod, lstat, mkdtemp, rm, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import type { RunSandboxTaskOptions } from '@/lib/execution/sandbox/run-task'
import { captured, captureExcelProcess, MAX_WIRE, refuse } from './excel-process-protocol'

export interface ExcelProcessRuntime {
  /** Deployment-owned installed interpreter; never obtained from procedure/model data. */
  pythonExecutable: string
  /** Deployment-owned private root. Each call creates/removes only its new child directory. */
  temporaryRoot: string
}
/** A private process transport, NOT a sandbox/permission/job/publication boundary. */
export async function prepareExcelInProcess(
  input: unknown,
  runtime: ExcelProcessRuntime,
  options: Pick<RunSandboxTaskOptions, 'signal' | 'requestId'> = {}
) {
  let directory: string | undefined
  let assertActive = () => {}
  try {
    const capture = captureExcelProcess(input, options)
    const { body, timeout, signal, active } = capture
    const config = z
      .strictObject({
        pythonExecutable: z.string().min(1).max(4096),
        temporaryRoot: z.string().min(1).max(4096),
      })
      .parse(JSON.parse(captured(runtime, 8192)))
    if (!isAbsolute(config.pythonExecutable) || !isAbsolute(config.temporaryRoot)) refuse()
    assertActive = active
    const root = await lstat(config.temporaryRoot)
    active()
    if (!root.isDirectory() || root.uid !== process.getuid?.() || (root.mode & 0o777) !== 0o700)
      refuse()
    const executable = await stat(config.pythonExecutable)
    if (!executable.isFile() || !(executable.mode & 0o111)) refuse()
    active()
    directory = await mkdtemp(join(config.temporaryRoot, 'excel-'))
    await chmod(directory, 0o700)
    active()
    const wire = await new Promise<string>((resolve, reject) => {
      const child = spawn(config.pythonExecutable, ['-I', '-B', '-m', 'memlia_excel.process'], {
        cwd: directory,
        env: {
          NODE_ENV: 'production',
          PATH: '/usr/bin:/bin',
          HOME: directory,
          TMPDIR: directory,
          LANG: 'C.UTF-8',
          POLARS_MAX_THREADS: '1',
          OPENBLAS_NUM_THREADS: '1',
          OMP_NUM_THREADS: '1',
          PYTHONNOUSERSITE: '1',
          PYTHONDONTWRITEBYTECODE: '1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      })
      let failed = false
      let length = 0
      let stderr = 0
      const chunks: Buffer[] = []
      let killTimer: ReturnType<typeof setTimeout> | undefined
      const stop = () => {
        failed = true
        if (child.exitCode === null && child.signalCode === null && child.pid) child.kill('SIGTERM')
        killTimer ??= setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null && child.pid)
            child.kill('SIGKILL')
        }, 1000)
      }
      const timer = setTimeout(stop, timeout)
      signal?.addEventListener('abort', stop, { once: true })
      child.on('spawn', () => {
        if (failed || signal?.aborted) stop()
      })
      child.on('error', stop)
      child.stdin.on('error', stop)
      child.stdout.on('data', (chunk: Buffer) => {
        length += chunk.length
        if (length > MAX_WIRE) stop()
        else chunks.push(chunk)
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.length
        if (stderr > 65536) stop()
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (killTimer) clearTimeout(killTimer)
        signal?.removeEventListener('abort', stop)
        if (failed || signal?.aborted || code !== 0 || stderr !== 0)
          reject(new Error('excel_process_refused'))
        else {
          try {
            resolve(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
          } catch {
            reject(new Error('excel_process_refused'))
          }
        }
      })
      if (signal?.aborted) stop()
      child.stdin.end(body)
    })
    active()
    return capture.accept(wire)
  } catch {
    refuse()
  } finally {
    if (directory) {
      try {
        await rm(directory, { recursive: true, force: false })
      } catch {
        refuse()
      }
    }
    assertActive()
  }
}
