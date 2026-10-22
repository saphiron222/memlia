// Copyright (c) 2026 Memlia. All rights reserved.
// Build with Bun --target=node; execute with Node24, never Bun's TLS implementation.
import {
  type AgentControlRuntime,
  startAgentControlRuntime,
} from '../lib/desktop-automation/agent-control-runtime'

let runtime: AgentControlRuntime | null = null
let requested = false
const stop = () => {
  requested = true
  void runtime?.stop().catch(() => {})
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
try {
  runtime = await startAgentControlRuntime()
  if (!runtime) throw new Error('control_runtime_unavailable')
  if (requested) await runtime.stop()
  else process.stdout.write('{"status":"control_listening"}\n')
  await runtime.closed
  process.stdout.write('{"status":"control_closed"}\n')
} catch {
  process.exitCode = 1
  process.stderr.write('{"status":"control_unavailable_or_closure_unknown"}\n')
}
// Keep idempotent signal handlers even on closure-unknown: a second signal must
// not restore default process termination while owned cleanup is still pending.
// These handlers do not keep Node alive. Never process.exit before native cleanup.
