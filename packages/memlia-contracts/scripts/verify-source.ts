// Copyright (c) 2026 Memlia. All rights reserved.
import { execFileSync } from 'node:child_process'

// Qualification only: never import executable code from a CLI-supplied path.
const source = process.argv[2]
if (!source) throw new Error('Usage: bun scripts/verify-source.ts <authorized-sim-checkout>')
const revision = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim()
if (revision !== 'c6cef5f87b6a1d1d01df89e7140bad9e9fd4c2e2') {
  console.error(`Sim source revision mismatch: ${revision}`)
  process.exit(1)
}
console.log(`Verified Sim source revision: ${revision}`)
