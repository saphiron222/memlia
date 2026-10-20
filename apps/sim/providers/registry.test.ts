// Copyright (c) 2026 Memlia. All rights reserved.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'vitest'

// Execute the actual registry in native ESM: Vitest's transformed module graph
// does not reliably preserve temporal-dead-zone failures. Provider modules below
// are explicit import-cycle doubles, not SDK/transport/DB qualifications.
const probe = String.raw`
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { SourceTextModule, createContext } from 'node:vm'
const { source, entry } = JSON.parse(readFileSync(0, 'utf8'))
const context = createContext({ errors: [] })
const modules = new Map()
const add = (name, code) => {
  const module = new SourceTextModule(code, { context, identifier: name })
  modules.set(name, module)
  return module
}
add('@sim/logger', 'export function createLogger() { return { error: (...args) => errors.push(args) } }')
const registry = add('@/providers/registry', stripTypeScriptTypes(source))
const expected = [
  ['openai', 'openaiProvider'], ['anthropic', 'anthropicProvider'],
  ['azure-anthropic', 'azureAnthropicProvider'], ['google', 'googleProvider'],
  ['vertex', 'vertexProvider'], ['deepseek', 'deepseekProvider'],
  ['xai', 'xAIProvider'], ['cerebras', 'cerebrasProvider'], ['groq', 'groqProvider'],
  ['sakana', 'sakanaProvider'], ['typesafe', 'typesafeProvider'],
  ['nvidia', 'nvidiaProvider'], ['meta', 'metaProvider'], ['zai', 'zaiProvider'],
  ['kimi', 'kimiProvider'], ['kie', 'kieProvider'], ['vllm', 'vllmProvider'],
  ['litellm', 'litellmProvider'], ['mistral', 'mistralProvider'],
  ['azure-openai', 'azureOpenAIProvider'], ['openrouter', 'openRouterProvider'],
  ['fireworks', 'fireworksProvider'], ['together', 'togetherProvider'],
  ['baseten', 'basetenProvider'], ['nebius', 'nebiusProvider'],
  ['ollama', 'ollamaProvider'], ['ollama-cloud', 'ollamaCloudProvider'],
  ['bedrock', 'bedrockProvider'],
]
// Preserve the dependency shape provider -> core -> providers barrel -> registry.
// No provider calls getProviderExecutor during initialization in this scenario.
add('@/providers', 'export { getProviderExecutor } from "@/providers/registry"; export const MAX_TOOL_ITERATIONS = Infinity')
for (const [id, binding] of expected) {
  const name = '@/providers/' + id
  const cyclic = id === entry
  if (cyclic) add(name + '/core', 'import { MAX_TOOL_ITERATIONS } from "@/providers"; export function execute() { return MAX_TOOL_ITERATIONS }')
  add(name, (cyclic ? 'import { execute } from ' + JSON.stringify(name + '/core') + ';' : '') +
    'export const ' + binding + ' = { id: ' + JSON.stringify(id) + ', executeRequest() { throw new Error("transport_not_allowed") } }')
}
const first = entry === 'registry' ? registry : modules.get('@/providers/' + entry)
await first.link((name) => {
  assert.ok(modules.has(name), 'unexpected import: ' + name)
  return modules.get(name)
})
await first.evaluate({ timeout: 1000 })
const get = registry.namespace.getProviderExecutor
for (const [id, binding] of expected) {
  const result = get(id)
  assert.equal(typeof result.then, 'function', 'API remains async')
  assert.equal(await result, modules.get('@/providers/' + id).namespace[binding], id)
  assert.equal(await get(id), await result, 'same provider object on repeated selection')
}
assert.equal(await get('missing-provider'), undefined)
assert.equal(context.errors.length, 1)
assert.equal(context.errors[0][0], 'Provider not found: missing-provider')
`

describe('provider registry initialization', () => {
  const source = readFileSync(fileURLToPath(new URL('./registry.ts', import.meta.url)), 'utf8')

  for (const entry of ['anthropic', 'openai', 'registry']) {
    it(`selects the same 28 providers after importing ${entry} first`, () => {
      execFileSync(
        process.execPath,
        ['--experimental-vm-modules', '--input-type=module', '-e', probe],
        {
          input: JSON.stringify({ source, entry }),
          env: { NODE_ENV: 'test' },
          timeout: 10_000,
          maxBuffer: 64 * 1024,
          stdio: ['pipe', 'pipe', 'pipe'],
        }
      )
    })
  }
})
