// Copyright 2026 Memlia. All rights reserved.

import { startPgBossWorkflowWorker } from '@/lib/core/async-jobs/backends/pg-boss-worker'
import {
  captureExcelToolWorkerRuntime,
  runWithExcelToolWorkerRuntime,
} from '@/lib/memlia/excel/execute-tool.server'

// Explicit owned-process entrypoint. Run with the app tsconfig and server environment;
// import of a web module never starts this worker. Shutdown drains before process exit.
let stopping = false
let worker: Awaited<ReturnType<typeof startPgBossWorkflowWorker>> | undefined
let start: Promise<void>
async function stop() {
  if (stopping) return
  stopping = true
  try {
    await start
    await worker?.stop()
    process.exit(0)
  } catch {
    process.stderr.write('durable_workflow_worker_stop_failed\n')
    process.exit(1)
  }
}
process.once('SIGTERM', () => {
  void stop()
})
process.once('SIGINT', () => {
  void stop()
})
start = (async () => {
  try {
    const excelRuntime = captureExcelToolWorkerRuntime(
      process.env.MEMLIA_EXCEL_HOST_SOCKET,
      process.env.MEMLIA_EXCEL_HOST_OPERATOR_UID
    )
    worker = await runWithExcelToolWorkerRuntime(excelRuntime, () => startPgBossWorkflowWorker())
  } catch {
    process.stderr.write('durable_workflow_worker_start_failed\n')
    process.exitCode = 1
    throw new Error('durable_workflow_worker_start_failed')
  }
})()
void start.catch(() => {
  process.exit(1)
})
